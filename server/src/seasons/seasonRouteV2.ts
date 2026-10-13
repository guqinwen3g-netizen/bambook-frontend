/**
 * seasonRouteV2.ts — Phase 1 季节管理 V2 路由（权限守卫）
 *
 * 挂载点：/api/v2/seasons
 * 业务逻辑复用现有 seasonService，叠加 requirePermission 守卫
 *
 * ⚠️ DEPRECATED（2026-09-15 B4 冗余收敛）：本族 22 个端点**前端零消费**，
 * Agent 工具清单亦未引用；季节域实际走 V1 路径。
 * 暂保留（待业务方确认无人调用后整体删除）——**新代码不要再依赖本路由**。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { createSeasonService } from './seasonService';
import { safeRouteError } from '../shared/routeError';
/**
 * 本路由族已标 DEPRECATED（2026-09-15 B4）：前端零消费（2026-09-20 独立复核：`/api/v2/seasons` 在
 * `components/`、`services/`、`customer-portal/`、`server/ops-panel/`、Agent 工具清单里均无引用，
 * 季节域走 V1 `/v1/seasons`），但**仍然挂载并可被任何持凭据的调用方打到** ⇒ 原文外泄这条不能因为它"没人用"就留着。
 * 文案只用这一条共享常量、不给 22 个端点各写一句：给一个待删除的表面精修 22 句文案是本末倒置
 * （真正的处置是业务确认后整族删除，见 §12.05 D36）。`INTERNAL_ERROR` 至今不在注册表里（B29 的头号条目），
 * 所以这里必须自带 fallbackMessage，否则用户拿到的是全局万能文案。
 */
const SEASON_V2_FAIL = '该请求未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对季节数据。';



export interface SeasonsV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createSeasonsV2Router(opts: SeasonsV2RouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  const svc = createSeasonService(opts.prisma);

  const actorId = (req: Request) => extractActorFromRequest(req)?.userId || '';

  function serialize(row: any): any {
    if (!row) return null;
    const out: any = Array.isArray(row) ? [...row] : { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    }
    return out;
  }

  // ── 单段静态 GET 必须先于 GET /:id 注册，否则被参数路由遮蔽（trade-shows 实测恒 404）──

  // ── Trending Fabrics ──
  router.get('/trending/fabrics', requirePermission('seasons:read'), async (req, res) => {
    try {
      const items = await svc.listTrendingFabrics({ seasonId: typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined });
      res.json({ ok: true, fabrics: items.map(serialize) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Trade Shows ──
  router.get('/trade-shows', requirePermission('seasons:read'), async (req, res) => {
    try {
      const items = await svc.listTradeShows({
        seasonId: typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      });
      res.json({ ok: true, tradeShows: items.map(serialize) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.post('/trade-shows', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.createTradeShow(req.body, actorId(req));
      res.json({ ok: true, tradeShow: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Season CRUD ──
  router.get('/', requirePermission('seasons:read'), async (req, res) => {
    try {
      const query: any = {};
      if (typeof req.query.status === 'string') query.status = req.query.status;
      if (typeof req.query.search === 'string') query.search = req.query.search;
      query.limit = req.query.limit ? Number(req.query.limit) : 50;
      query.offset = req.query.offset ? Number(req.query.offset) : 0;
      const result = await svc.listSeasons(query);
      res.json({ ok: true, ...result, items: result.items.map(serialize) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.post('/', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.createSeason(req.body, actorId(req));
      res.json({ ok: true, season: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.get('/:id', requirePermission('seasons:read'), async (req, res) => {
    try {
      const item = await svc.getSeason(req.params.id);
      if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ ok: true, season: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.put('/:id', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.updateSeason(req.params.id, req.body, actorId(req));
      res.json({ ok: true, season: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.delete('/:id', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      await svc.deleteSeason(req.params.id, actorId(req));
      res.json({ ok: true, deleted: true });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Season Review ──
  router.get('/:id/review', requirePermission('seasons:read'), async (req, res) => {
    try {
      const data = await svc.computeSeasonReview(req.params.id);
      res.json({ ok: true, review: serialize(data) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.post('/:id/review/generate', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const data = await svc.generateSeasonReview(req.params.id, actorId(req));
      res.json({ ok: true, review: serialize(data) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Trend Tags ──
  router.get('/:id/trend-tags', requirePermission('seasons:read'), async (req, res) => {
    try {
      const items = await svc.listTrendTags({ seasonId: req.params.id, type: typeof req.query.type === 'string' ? req.query.type : undefined });
      res.json({ ok: true, trendTags: items.map(serialize) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.post('/:id/trend-tags', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.createTrendTag({ ...req.body, seasonId: req.params.id }, actorId(req));
      res.json({ ok: true, trendTag: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.put('/trend-tags/:tagId', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.updateTrendTag(req.params.tagId, req.body, actorId(req));
      res.json({ ok: true, trendTag: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.delete('/trend-tags/:tagId', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      await svc.deleteTrendTag(req.params.tagId, actorId(req));
      res.json({ ok: true, deleted: true });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Trending Fabrics（注册见文件头部静态 GET 区块，此处不再重复）──

  router.get('/trade-shows/:id', requirePermission('seasons:read'), async (req, res) => {
    try {
      const item = await svc.getTradeShow(req.params.id);
      if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
      res.json({ ok: true, tradeShow: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.put('/trade-shows/:id', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.updateTradeShow(req.params.id, req.body, actorId(req));
      res.json({ ok: true, tradeShow: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.delete('/trade-shows/:id', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      await svc.deleteTradeShow(req.params.id, actorId(req));
      res.json({ ok: true, deleted: true });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Trade Show Leads ──
  router.post('/trade-shows/:id/leads', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.addLead(req.params.id, req.body, actorId(req));
      res.json({ ok: true, lead: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.put('/leads/:leadId', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const item = await svc.updateLead(req.params.leadId, req.body, actorId(req));
      res.json({ ok: true, lead: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.delete('/leads/:leadId', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      await svc.deleteLead(req.params.leadId, actorId(req));
      res.json({ ok: true, deleted: true });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  router.post('/leads/:leadId/convert', requireWrite, requirePermission('seasons:write'), async (req, res) => {
    try {
      const relationId = typeof req.body?.relationId === 'string' ? req.body.relationId : '';
      if (!relationId) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'relationId 必填' });
      const item = await svc.convertLead(req.params.leadId, relationId, actorId(req));
      res.json({ ok: true, lead: serialize(item) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  // ── Trade Show ROI ──
  router.get('/trade-shows/:id/roi', requirePermission('seasons:read'), async (req, res) => {
    try {
      const data = await svc.getShowROI(req.params.id);
      res.json({ ok: true, roi: serialize(data) });
    } catch (e: any) { const se = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: SEASON_V2_FAIL }); res.status(se.status).json({ error: se.code, message: se.message }); }
  });

  return router;
}
