import { pricingInputError, pricingNotFoundError } from './pricingError';
/**
 * 阶段 P2 — 中间人佣金规则服务（PRD 8.5 P2，E5/E10）
 *
 * 职责：
 *   CommissionRule 是佣金率的配置真源。匹配口径：
 *     1. intermediaryRelationId 精确命中（且 isActive）优先
 *     2. intermediaryRelationId 为空的记录为默认规则兜底
 *     3. 均无命中返回 null（调用方按无佣金处理）
 *
 * 设计原则（与 pricing/businessLines 模块一致）：
 *   - 服务工厂模式 createCommissionService(prisma)
 *   - 软删除（deletedAt BigInt）
 *   - 佣金率仅允许 5（E5）/ 10（E10），与 calculateTrackB 的 0/5/10 口径一致
 *   - 同一中间人仅允许一条启用中规则（幂等占位），默认规则同理
 *   - 显式业务错误类型保留中文校验文案和 400/404，未知异常不按文案猜档
 */

import { PrismaClient, CommissionRule } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';

export interface CommissionRuleInput {
  name: string;
  rate: number; // 5 = E5 | 10 = E10
  intermediaryRelationId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export type CommissionRulePatch = Partial<CommissionRuleInput>;

/** 佣金规则费率合法区间（J2：任意百分比；0% 无佣金由"无规则"表达，不落规则） */
const RATE_MIN_EXCLUSIVE = 0;
const RATE_MAX = 100;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

export function createCommissionService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  async function getRuleOrThrow(id: string): Promise<CommissionRule> {
    const row = await db.commissionRule.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw pricingNotFoundError('佣金规则不存在');
    return row;
  }

  function assertRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= RATE_MIN_EXCLUSIVE || rate > RATE_MAX) {
      throw pricingInputError(`佣金率必须大于 ${RATE_MIN_EXCLUSIVE} 且不超过 ${RATE_MAX}%`);
    }
  }

  /** 中间人快照校验（Relation 真源存在性 + 名称快照） */
  async function resolveIntermediary(relationId: string | null | undefined): Promise<{ id: string | null; name: string | null }> {
    const id = relationId?.trim() || null;
    if (!id) return { id: null, name: null };
    const rel = await db.relation.findUnique({ where: { id } });
    if (!rel || rel.deletedAt !== null) throw pricingNotFoundError('中间人不存在');
    return { id, name: rel.name ?? null };
  }

  /** 占位唯一：同中间人（或默认）启用中规则唯一 */
  async function assertNoActiveDuplicate(intermediaryRelationId: string | null, excludeId?: string): Promise<void> {
    const dup = await db.commissionRule.findFirst({
      where: {
        intermediaryRelationId: intermediaryRelationId ?? null,
        isActive: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (dup) {
      throw pricingInputError(intermediaryRelationId ? '该中间人已存在启用中的佣金规则' : '已存在启用中的默认佣金规则');
    }
  }

  async function createCommissionRule(input: CommissionRuleInput, actorId: string): Promise<CommissionRule> {
    const name = input.name?.trim();
    if (!name) throw pricingInputError('规则名称必填');
    assertRate(input.rate);
    const intermediary = await resolveIntermediary(input.intermediaryRelationId);
    const isActive = input.isActive ?? true;
    if (isActive) await assertNoActiveDuplicate(intermediary.id);

    const ts = now();
    const row = await db.commissionRule.create({
      data: {
        id: generateId('CR'),
        name,
        rate: input.rate,
        intermediaryRelationId: intermediary.id,
        intermediaryName: intermediary.name,
        isActive,
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[CommissionService] rule created', { id: row.id, name, rate: input.rate, actorId });
    return row;
  }

  async function listCommissionRules(query: { includeInactive?: boolean }) {
    const where: any = { deletedAt: null };
    if (!query.includeInactive) where.isActive = true;
    const [items, total] = await Promise.all([
      db.commissionRule.findMany({ where, orderBy: { createdAt: 'desc' } }),
      db.commissionRule.count({ where }),
    ]);
    return { items, total };
  }

  async function updateCommissionRule(id: string, patch: CommissionRulePatch, actorId: string): Promise<CommissionRule> {
    const row = await getRuleOrThrow(id);
    if (patch.rate !== undefined) assertRate(patch.rate);
    if (patch.name !== undefined && !patch.name.trim()) throw pricingInputError('规则名称必填');

    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    if (patch.intermediaryRelationId !== undefined) {
      const intermediary = await resolveIntermediary(patch.intermediaryRelationId);
      data.intermediaryRelationId = intermediary.id;
      data.intermediaryName = intermediary.name;
    }
    for (const f of ['name', 'rate', 'notes', 'isActive'] as const) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    // 变更后若处于启用态，需重新校验占位唯一
    const nextActive = data.isActive !== undefined ? Boolean(data.isActive) : row.isActive;
    const nextIntermediary = data.intermediaryRelationId !== undefined ? (data.intermediaryRelationId as string | null) : row.intermediaryRelationId;
    if (nextActive) await assertNoActiveDuplicate(nextIntermediary, row.id);

    const updated = await db.commissionRule.update({ where: { id: row.id }, data });
    logger.info('[CommissionService] rule updated', { id: row.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteCommissionRule(id: string, actorId: string): Promise<void> {
    const row = await getRuleOrThrow(id);
    await db.commissionRule.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[CommissionService] rule soft-deleted', { id: row.id, actorId });
  }

  /**
   * 佣金规则命中：中间人精确命中优先，默认规则（intermediaryRelationId 为空）兜底。
   * 无命中返回 null（= 无佣金，commissionRate 0）。
   */
  async function lookupCommissionRate(intermediaryRelationId?: string | null): Promise<{ ruleId: string; rate: number } | null> {
    const id = intermediaryRelationId?.trim() || null;
    if (id) {
      const exact = await db.commissionRule.findFirst({
        where: { intermediaryRelationId: id, isActive: true, deletedAt: null },
      });
      if (exact) return { ruleId: exact.id, rate: Number(exact.rate) };
    }
    const fallback = await db.commissionRule.findFirst({
      where: { intermediaryRelationId: null, isActive: true, deletedAt: null },
    });
    return fallback ? { ruleId: fallback.id, rate: Number(fallback.rate) } : null;
  }

  return {
    createCommissionRule,
    listCommissionRules,
    updateCommissionRule,
    deleteCommissionRule,
    lookupCommissionRate,
  };
}

export type CommissionService = ReturnType<typeof createCommissionService>;
