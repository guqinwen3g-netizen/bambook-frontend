/**
 * marketingRouteV2.ts — Phase 1-06 营销活动管理 V2 路由
 *
 * 挂载点：/api/v2/marketing
 *
 * 路由表：
 *   GET    /campaigns              — 活动列表
 *   POST   /campaigns              — 创建活动
 *   GET    /campaigns/:id          — 活动详情
 *   PUT    /campaigns/:id          — 更新活动
 *   DELETE /campaigns/:id          — 软删除活动
 *   GET    /campaigns/:id/roi      — 活动 ROI
 *   GET    /campaigns/:id/leads    — 活动线索列表
 *   POST   /campaigns/:id/leads    — 创建线索
 *   PUT    /leads/:id              — 更新线索
 *   DELETE /leads/:id              — 软删除线索
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { createMarketingService } from './marketingService';

export interface MarketingV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createMarketingV2Router(opts: MarketingV2RouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  const svc = createMarketingService(opts.prisma);

  const actorOf = (req: Request) => extractActorFromRequest(req);

  // 序列化（勿再踩）：Prisma.Decimal 经 JSON.stringify 会变成**字符串**，
  // 前端 `sum + actualValue` 就退化成字符串拼接（"0" + "10000" + "20000" = "01000020000"）→ ROI 全错。
  // 这里递归把 Decimal → number、bigint → number，覆盖嵌套的 leads / items 数组。
  const isDecimalLike = (v: any): boolean =>
    v != null && typeof v === 'object' && typeof v.toNumber === 'function' && typeof v.toFixed === 'function';

  function toPlain(value: any): any {
    if (value == null) return value;
    if (typeof value === 'bigint') return Number(value);
    if (isDecimalLike(value)) return value.toNumber();
    if (value instanceof Date) return value; // 交给 JSON.stringify 输出 ISO
    if (Array.isArray(value)) return value.map(toPlain);
    if (typeof value === 'object') {
      const out: any = {};
      for (const k of Object.keys(value)) out[k] = toPlain(value[k]);
      return out;
    }
    return value;
  }

  function serialize(row: any): any {
    return row == null ? null : toPlain(row);
  }

  // ── Campaign ──
  router.get('/campaigns', requirePermission('marketing:read'), async (req, res) => {
    try {
      const result = await svc.listCampaigns(actorOf(req), {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        type: typeof req.query.type === 'string' ? req.query.type : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ ok: true, ...result, items: result.items.map(serialize) });
    } catch (e: any) { res.status(500).json({ error: 'INTERNAL_ERROR', message: e?.message }); }
  });

  router.post('/campaigns', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      const item = await svc.createCampaign(actorOf(req), req.body || {});
      res.json({ ok: true, campaign: serialize(item) });
    } catch (e: any) {
      const code = e?.message === 'UNAUTHORIZED' ? 401 : 500;
      res.status(code).json({ error: e?.message === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'INTERNAL_ERROR', message: e?.message });
    }
  });

  router.get('/campaigns/:id', requirePermission('marketing:read'), async (req, res) => {
    try {
      const item = await svc.getCampaign(actorOf(req), req.params.id);
      if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ ok: true, campaign: serialize(item) });
    } catch (e: any) { res.status(500).json({ error: 'INTERNAL_ERROR', message: e?.message }); }
  });

  router.put('/campaigns/:id', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      const item = await svc.updateCampaign(actorOf(req), req.params.id, req.body || {});
      res.json({ ok: true, campaign: serialize(item) });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : e?.message === 'FORBIDDEN' ? 403 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  router.delete('/campaigns/:id', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      await svc.deleteCampaign(actorOf(req), req.params.id);
      res.json({ ok: true, deleted: true });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  router.get('/campaigns/:id/roi', requirePermission('marketing:read'), async (req, res) => {
    try {
      const data = await svc.getCampaignROI(actorOf(req), req.params.id);
      res.json({ ok: true, ...serialize(data) });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  // ── Lead ──
  router.get('/campaigns/:id/leads', requirePermission('marketing:read'), async (req, res) => {
    try {
      const result = await svc.listLeads(actorOf(req), req.params.id, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ ok: true, ...result, items: result.items.map(serialize) });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  router.post('/campaigns/:id/leads', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      const item = await svc.createLead(actorOf(req), { ...req.body, campaignId: req.params.id });
      res.json({ ok: true, lead: serialize(item) });
    } catch (e: any) {
      const code = e?.message?.includes('NOT_FOUND') ? 404 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  router.put('/leads/:id', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      const item = await svc.updateLead(actorOf(req), req.params.id, req.body || {});
      res.json({ ok: true, lead: serialize(item) });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : e?.message === 'FORBIDDEN' ? 403 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  router.delete('/leads/:id', requireWrite, requirePermission('marketing:write'), async (req, res) => {
    try {
      await svc.deleteLead(actorOf(req), req.params.id);
      res.json({ ok: true, deleted: true });
    } catch (e: any) {
      const code = e?.message === 'NOT_FOUND' ? 404 : e?.message === 'FORBIDDEN' ? 403 : 500;
      res.status(code).json({ error: e?.message, message: e?.message });
    }
  });

  return router;
}
