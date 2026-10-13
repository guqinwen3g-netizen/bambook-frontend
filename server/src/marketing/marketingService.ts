/**
 * marketingService.ts — Phase 1-06 营销活动管理服务
 *
 * 职责：
 *   1. Campaign（营销活动）：CRUD + 预算/实际花费追踪 + ROI 计算
 *   2. Lead（营销线索）：CRUD + 状态流转 + 转化追踪
 *
 * 接入平台域：Sequence 编号 + 行级权限 scope + 字典校验
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createSequenceService } from '../sequence/sequenceService';
import { getDataDictionaryService } from '../dictionaries/dataDictionaryService';
import { logger } from '../lib/logger';

import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
export interface CampaignInput {
  name: string;
  description?: string;
  type?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  actualCost?: number;
  targetSegment?: any;
  seasonId?: string;
  tradeShowId?: string;
  ownerId?: string;
  departmentId?: string;
}

export interface LeadInput {
  campaignId: string;
  relationId?: string;
  source?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  status?: string;
  estimatedValue?: number;
  notes?: string;
}

export function createMarketingService(prisma: PrismaClient) {
  const permSvc = createPermissionService({ prisma });
  const seqSvc = createSequenceService(prisma);
  const dictSvc = getDataDictionaryService(prisma);

  async function buildScopeWhere(actor: TokenPayload | null | undefined): Promise<Record<string, unknown>> {
    if (!actor) return { ownerId: '__NOBODY__' };
    const resolver = await permSvc.getDataScopeResolver(actor, 'marketing');
    // §10.4.1：team 档同样按「解析后的用户集」拼装，不再按 rule.kind 硬分支
    return buildScopeWhereFromResolver(resolver, actor.userId);
  }

  function serialize(row: any): any {
    if (!row) return null;
    const out: any = { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
      if (out[k] && typeof out[k] === 'object' && out[k].toString && out[k]._isBigNumber) {
        out[k] = Number(out[k].toString());
      }
    }
    return out;
  }

  // ── Campaign CRUD ──
  async function listCampaigns(actor: any, filter: { status?: string; type?: string; search?: string; limit?: number; offset?: number } = {}) {
    const scopeWhere = await buildScopeWhere(actor);
    const searchParts: any[] = [];
    if (filter.search) {
      const s = filter.search.trim();
      searchParts.push(
        { name: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
        { description: { contains: s, mode: 'insensitive' } },
      );
    }
    const where: any = { deletedAt: null };
    if (Object.keys(scopeWhere).length > 0 && searchParts.length > 0) {
      // QA-SEC-1: 禁止顶层 OR 直接赋值覆盖 scopeWhere.OR；改用 AND 组合
      where.AND = [scopeWhere, { OR: searchParts }];
    } else if (Object.keys(scopeWhere).length > 0) {
      Object.assign(where, scopeWhere);
    } else if (searchParts.length > 0) {
      where.OR = searchParts;
    }
    if (filter.status) where.status = filter.status;
    if (filter.type) where.type = filter.type;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      (prisma as any).marketingCampaign.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset, include: { leads: { where: { deletedAt: null }, select: { id: true, status: true, estimatedValue: true, actualValue: true } } } }),
      (prisma as any).marketingCampaign.count({ where }),
    ]);
    return { items: items.map(serialize), total, limit, offset };
  }

  async function getCampaign(actor: any, id: string) {
    const scopeWhere = await buildScopeWhere(actor);
    return await (prisma as any).marketingCampaign.findFirst({ where: { id, deletedAt: null, ...scopeWhere }, include: { leads: { where: { deletedAt: null } } } });
  }

  async function createCampaign(actor: TokenPayload | null | undefined, input: CampaignInput) {
    if (!actor) throw new Error('UNAUTHORIZED');
    // QA-SEC-3: 编号生成失败必须 throw（禁止 code=null 静默落库）
    const code = await seqSvc.nextNumber(prisma as any, 'marketing');
    const ownerId = input.ownerId || actor.userId;
    const departmentId = input.departmentId || actor.departmentIds?.[0] || null;
    const now = BigInt(Date.now());
    const item = await (prisma as any).marketingCampaign.create({
      data: { ...input, code, ownerId, departmentId, status: input.status || 'Draft', createdAt: now, updatedAt: now },
    });
    logger.info('[Marketing] campaign created', { id: item.id, code });
    return item;
  }

  async function updateCampaign(actor: any, id: string, patch: Record<string, unknown>) {
    const scopeWhere = await buildScopeWhere(actor);
    const existing = await (prisma as any).marketingCampaign.findFirst({ where: { id, deletedAt: null, ...scopeWhere } });
    if (!existing) throw new Error('NOT_FOUND');
    delete patch.id; delete patch.code;
    patch.updatedAt = BigInt(Date.now());
    return await (prisma as any).marketingCampaign.update({ where: { id }, data: patch });
  }

  async function deleteCampaign(actor: any, id: string) {
    const scopeWhere = await buildScopeWhere(actor);
    const existing = await (prisma as any).marketingCampaign.findFirst({ where: { id, deletedAt: null, ...scopeWhere } });
    if (!existing) throw new Error('NOT_FOUND');
    return await (prisma as any).marketingCampaign.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
  }

  // ── Campaign ROI ──
  async function getCampaignROI(actor: any, id: string) {
    const campaign = await getCampaign(actor, id);
    if (!campaign) throw new Error('NOT_FOUND');
    const leads = campaign.leads || [];
    const totalLeads = leads.length;
    const convertedLeads = leads.filter((l: any) => l.status === 'Converted');
    const conversionRate = totalLeads > 0 ? convertedLeads.length / totalLeads : 0;
    const totalEstimatedValue = leads.reduce((sum: number, l: any) => sum + Number(l.estimatedValue?.toString?.() || l.estimatedValue || 0), 0);
    const budget = Number(campaign.budget?.toString?.() || campaign.budget || 0);
    const actualCost = Number(campaign.actualCost?.toString?.() || campaign.actualCost || 0);
    // A Converted lead with no recorded revenue makes the total unknown. Known
    // revenue from other leads cannot establish the missing part of that sum.
    // Empty collections and explicitly recorded zero remain legitimate zero.
    if (convertedLeads.some((l: any) => l.actualValue == null)) {
      return { campaign: serialize(campaign), totalLeads, convertedCount: convertedLeads.length, conversionRate,
        totalEstimatedValue, totalActualValue: null, budget, actualCost, roi: null };
    }
    const totalActualValue = convertedLeads.reduce((sum: number, l: any) => sum + Number(l.actualValue?.toString?.() || l.actualValue || 0), 0);
    // ★ 零成本时 ROI **无意义** → `null`（不是 0）。
    //   数学上 `(0 − 0) / 0` 未定义；返回 0 会被读成「投入无回报」，
    //   而真实语义是「**无法计算**」（空值红线：无值显示「—」）。
    //   ★ 口径与前端一致：`components/MarketingManager.tsx` 的 `campaignRoiOf` 早已返回 `null`，
    //   其契约测试 `components/marketingCampaignsLeadsContract.test.ts:66` 把 `: null` 钉成了断言
    //   （注释：「actualCost<=0 无意义返回 null」）。旧实现返回 0 = **跨层口径漂移**。
    const roi = actualCost > 0 ? (totalActualValue - actualCost) / actualCost : null;
    return { campaign: serialize(campaign), totalLeads, convertedCount: convertedLeads.length, conversionRate, totalEstimatedValue, totalActualValue, budget, actualCost, roi };
  }

  // ── Lead CRUD ──
  async function listLeads(actor: any, campaignId: string, filter: { status?: string; limit?: number; offset?: number } = {}) {
    const scopeWhere = await buildScopeWhere(actor);
    // 先校验 campaign 在 scope 内
    const campaign = await (prisma as any).marketingCampaign.findFirst({ where: { id: campaignId, deletedAt: null, ...scopeWhere }, select: { id: true } });
    if (!campaign) throw new Error('NOT_FOUND');
    const where: Record<string, unknown> = { campaignId, deletedAt: null };
    if (filter.status) where.status = filter.status;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      (prisma as any).marketingLead.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      (prisma as any).marketingLead.count({ where }),
    ]);
    return { items: items.map(serialize), total, limit, offset };
  }

  async function createLead(actor: any, input: LeadInput) {
    const scopeWhere = await buildScopeWhere(actor);
    const campaign = await (prisma as any).marketingCampaign.findFirst({ where: { id: input.campaignId, deletedAt: null, ...scopeWhere }, select: { id: true } });
    if (!campaign) throw new Error('NOT_FOUND: campaign not found or no permission');
    const now = BigInt(Date.now());
    return await (prisma as any).marketingLead.create({
      data: { ...input, status: input.status || 'New', createdAt: now, updatedAt: now },
    });
  }

  async function updateLead(actor: any, id: string, patch: Record<string, unknown>) {
    // QA-SEC-2：与 createLead 一致的 scope 校验 — 先查 lead，再用 scopeWhere 校验 campaign 可见性；
    // scope 未命中与不存在统一 NOT_FOUND（模块惯例：不泄露越权数据存在性）
    const lead = await (prisma as any).marketingLead.findFirst({ where: { id, deletedAt: null }, include: { campaign: { select: { id: true } } } });
    if (!lead) throw new Error('NOT_FOUND');
    const scopeWhere = await buildScopeWhere(actor);
    const campaignCheck = await (prisma as any).marketingCampaign.findFirst({ where: { id: lead.campaign.id, deletedAt: null, ...scopeWhere }, select: { id: true } });
    if (!campaignCheck) throw new Error('NOT_FOUND');
    delete patch.id; delete patch.campaignId;
    patch.updatedAt = BigInt(Date.now());
    // 如果状态变为 Converted，记录转化时间
    if (patch.status === 'Converted' && !patch.convertedAt) {
      patch.convertedAt = BigInt(Date.now());
    }
    return await (prisma as any).marketingLead.update({ where: { id }, data: patch });
  }

  async function deleteLead(actor: any, id: string) {
    // QA-SEC-2：同 updateLead 的 scope 校验模式
    const lead = await (prisma as any).marketingLead.findFirst({ where: { id, deletedAt: null }, include: { campaign: { select: { id: true } } } });
    if (!lead) throw new Error('NOT_FOUND');
    const scopeWhere = await buildScopeWhere(actor);
    const campaignCheck = await (prisma as any).marketingCampaign.findFirst({ where: { id: lead.campaign.id, deletedAt: null, ...scopeWhere }, select: { id: true } });
    if (!campaignCheck) throw new Error('NOT_FOUND');
    return await (prisma as any).marketingLead.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
  }

  return {
    listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign, getCampaignROI,
    listLeads, createLead, updateLead, deleteLead,
  };
}
