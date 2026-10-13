/**
 * Season / Trend Module Route — 季节性与趋势管理（阶段 H H2 / PRD 14）
 *
 * 端点（挂载于 /api/v1/seasons）：
 *
 * 季度 Season：
 *   - GET    /                          — 季度列表（status / search 匹配 code|name，按 startDate 降序）
 *   - POST   /                          — 新建季度（code 归一化大写，SS26|AW26 封闭格式）
 *   - GET    /:id                       — 季度详情（含未删除 trendTags / tradeShows）
 *   - PATCH  /:id                       — 更新季度（白名单；code 为关联真源不可修改）
 *   - DELETE /:id                       — 软删除季度
 *   - GET    /:id/review                — 季度回顾快照（无快照则 review=null）
 *   - POST   /:id/review                — 生成/重生成季度回顾（订单实时聚合 → reviewJson）
 *
 * 趋势标签 TrendTag（字面路由须在 /:id 之前）：
 *   - GET    /trends                    — 趋势列表（?seasonId=&type=，含面料关联 + 来源展会）
 *   - POST   /trends                    — 新建趋势（type ∈ fabric|color|craft|composition）
 *   - PATCH  /trends/:tagId             — 更新趋势（白名单）
 *   - DELETE /trends/:tagId             — 软删除趋势
 *   - POST   /trends/:tagId/fabrics     — 关联面料 {fabricId, note?}（(tag, fabric) 唯一）
 *   - DELETE /trends/:tagId/fabrics/:fabricId — 解除关联（关联表硬删除）
 *   - GET    /trending-fabrics          — 当季趋势面料（?seasonId=，推荐优先展示）
 *
 * 展会 TradeShow + 线索 TradeShowLead：
 *   - GET    /shows                     — 展会列表（?seasonId=&status=）
 *   - POST   /shows                     — 新建展会
 *   - GET    /shows/:showId             — 展会详情（含线索）+ ROI
 *   - PATCH  /shows/:showId             — 更新展会（白名单）
 *   - DELETE /shows/:showId             — 软删除展会
 *   - GET    /shows/:showId/roi         — 展会 ROI（线索转化客户订单 / 展会费用）
 *   - POST   /shows/:showId/leads       — 新增线索 {customerName, ...}
 *   - PATCH  /leads/:leadId             — 更新线索（白名单；convertedRelationId 禁改）
 *   - DELETE /leads/:leadId             — 软删除线索
 *   - POST   /leads/:leadId/convert     — 转化为客户 {relationId}（仅 category=Customer）
 *
 * 守卫口径与 suppliers 模块一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import {
  createSeasonService,
  SeasonInput,
  TrendTagInput,
  TradeShowInput,
  LeadInput,
} from './seasonService';

export interface SeasonRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createSeasonRouter(options: SeasonRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createSeasonService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // S3-γ：写端点在 JWT 之上叠加 seasons:write scope 门（与 /api/v2/seasons 守卫口径对齐；
  // SALES/销售主管持有，SuperAdmin/owner 全通；读端点不动）
  const requireSeasonsWrite = requirePermission('seasons:write');
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'seasons', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[SeasonRoute] ${code}`, { error: msg });
    const isClient =
      msg.includes('必填') || msg.includes('非法') || msg.includes('必须是') ||
      msg.includes('无效') || msg.includes('已存在') || msg.includes('仅 category') ||
      msg.includes('禁止') || msg.includes('不允许') || msg.includes('不可修改') ||
      msg.includes('已转化') || msg.includes('已关联') || msg.includes('早于');
    const isNotFound = msg.includes('不存在');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  // ══════════════════════════════════════════════════════════════
  // 字面路由（须在 /:id 之前）
  // ══════════════════════════════════════════════════════════════

  // GET / — 季度列表
  router.get('/', async (req: Request, res: Response) => {
    try {
      const result = await service.listSeasons({
        status: req.query.status ? String(req.query.status) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'LIST_FAILED');
    }
  });

  // POST / — 新建季度
  router.post('/', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const season = await service.createSeason(req.body as SeasonInput, actorIdFromRequest(req));
      notify('create', [season.id]);
      res.status(201).json(serializeValue({ ok: true, item: season }));
    } catch (e: any) {
      handleError(res, e, 'CREATE_FAILED');
    }
  });

  // ─── 趋势标签 TrendTag ───

  router.get('/trends', async (req: Request, res: Response) => {
    try {
      const items = await service.listTrendTags({
        seasonId: req.query.seasonId ? String(req.query.seasonId) : undefined,
        type: req.query.type ? String(req.query.type) : undefined,
      });
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'TREND_LIST_FAILED');
    }
  });

  router.post('/trends', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const tag = await service.createTrendTag(req.body as TrendTagInput, actorIdFromRequest(req));
      notify('create_trend', [tag.id]);
      res.status(201).json(serializeValue({ ok: true, item: tag }));
    } catch (e: any) {
      handleError(res, e, 'CREATE_TREND_FAILED');
    }
  });

  router.patch('/trends/:tagId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const tag = await service.updateTrendTag(req.params.tagId, req.body, actorIdFromRequest(req));
      notify('update_trend', [tag.id]);
      res.json(serializeValue({ ok: true, item: tag }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_TREND_FAILED');
    }
  });

  router.delete('/trends/:tagId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteTrendTag(req.params.tagId, actorIdFromRequest(req));
      notify('delete_trend', [req.params.tagId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_TREND_FAILED');
    }
  });

  // ─── 趋势 ↔ 面料关联 ───

  router.post('/trends/:tagId/fabrics', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const link = await service.linkFabric(req.params.tagId, String(req.body?.fabricId || ''), req.body?.note ?? null, actorIdFromRequest(req));
      notify('link_fabric', [link.id]);
      res.status(201).json(serializeValue({ ok: true, item: link }));
    } catch (e: any) {
      handleError(res, e, 'LINK_FABRIC_FAILED');
    }
  });

  router.delete('/trends/:tagId/fabrics/:fabricId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      await service.unlinkFabric(req.params.tagId, req.params.fabricId, actorIdFromRequest(req));
      notify('unlink_fabric', [req.params.tagId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'UNLINK_FABRIC_FAILED');
    }
  });

  // GET /trending-fabrics — 当季趋势面料
  router.get('/trending-fabrics', async (req: Request, res: Response) => {
    try {
      const items = await service.listTrendingFabrics({
        seasonId: req.query.seasonId ? String(req.query.seasonId) : undefined,
      });
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'TRENDING_FABRICS_FAILED');
    }
  });

  // ─── 展会 TradeShow ───

  router.get('/shows', async (req: Request, res: Response) => {
    try {
      const items = await service.listTradeShows({
        seasonId: req.query.seasonId ? String(req.query.seasonId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      });
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'SHOW_LIST_FAILED');
    }
  });

  router.post('/shows', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const show = await service.createTradeShow(req.body as TradeShowInput, actorIdFromRequest(req));
      notify('create_show', [show.id]);
      res.status(201).json(serializeValue({ ok: true, item: show }));
    } catch (e: any) {
      handleError(res, e, 'CREATE_SHOW_FAILED');
    }
  });

  router.get('/shows/:showId', async (req: Request, res: Response) => {
    try {
      const show = await service.getTradeShow(req.params.showId);
      if (!show) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '展会不存在' } });
      const roi = await service.getShowROI(req.params.showId);
      res.json(serializeValue({ item: show, roi }));
    } catch (e: any) {
      handleError(res, e, 'GET_SHOW_FAILED');
    }
  });

  router.patch('/shows/:showId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const show = await service.updateTradeShow(req.params.showId, req.body, actorIdFromRequest(req));
      notify('update_show', [show.id]);
      res.json(serializeValue({ ok: true, item: show }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_SHOW_FAILED');
    }
  });

  router.delete('/shows/:showId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteTradeShow(req.params.showId, actorIdFromRequest(req));
      notify('delete_show', [req.params.showId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_SHOW_FAILED');
    }
  });

  router.get('/shows/:showId/roi', async (req: Request, res: Response) => {
    try {
      const roi = await service.getShowROI(req.params.showId);
      res.json(serializeValue({ roi }));
    } catch (e: any) {
      handleError(res, e, 'SHOW_ROI_FAILED');
    }
  });

  router.post('/shows/:showId/leads', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const lead = await service.addLead(req.params.showId, req.body as LeadInput, actorIdFromRequest(req));
      notify('add_lead', [lead.id]);
      res.status(201).json(serializeValue({ ok: true, item: lead }));
    } catch (e: any) {
      handleError(res, e, 'ADD_LEAD_FAILED');
    }
  });

  // ─── 线索 TradeShowLead ───

  router.patch('/leads/:leadId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const lead = await service.updateLead(req.params.leadId, req.body, actorIdFromRequest(req));
      notify('update_lead', [lead.id]);
      res.json(serializeValue({ ok: true, item: lead }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_LEAD_FAILED');
    }
  });

  router.delete('/leads/:leadId', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteLead(req.params.leadId, actorIdFromRequest(req));
      notify('delete_lead', [req.params.leadId]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_LEAD_FAILED');
    }
  });

  router.post('/leads/:leadId/convert', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const lead = await service.convertLead(req.params.leadId, String(req.body?.relationId || ''), actorIdFromRequest(req));
      notify('convert_lead', [lead.id]);
      res.json(serializeValue({ ok: true, item: lead }));
    } catch (e: any) {
      handleError(res, e, 'CONVERT_LEAD_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 季度 /:id
  // ══════════════════════════════════════════════════════════════

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const season = await service.getSeason(req.params.id);
      if (!season) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '季度不存在' } });
      res.json(serializeValue({ item: season }));
    } catch (e: any) {
      handleError(res, e, 'GET_FAILED');
    }
  });

  router.patch('/:id', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const season = await service.updateSeason(req.params.id, req.body, actorIdFromRequest(req));
      notify('update', [season.id]);
      res.json(serializeValue({ ok: true, item: season }));
    } catch (e: any) {
      handleError(res, e, 'UPDATE_FAILED');
    }
  });

  router.delete('/:id', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      await service.deleteSeason(req.params.id, actorIdFromRequest(req));
      notify('delete', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DELETE_FAILED');
    }
  });

  // ─── 季度回顾 ───

  router.get('/:id/review', async (req: Request, res: Response) => {
    try {
      const season = await service.getSeason(req.params.id);
      if (!season) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '季度不存在' } });
      res.json(serializeValue({ review: (season as any).reviewJson ?? null }));
    } catch (e: any) {
      handleError(res, e, 'GET_REVIEW_FAILED');
    }
  });

  router.post('/:id/review', requireWrite, requireSeasonsWrite, async (req: Request, res: Response) => {
    try {
      const review = await service.generateSeasonReview(req.params.id, actorIdFromRequest(req));
      notify('generate_review', [req.params.id]);
      res.json(serializeValue({ ok: true, review }));
    } catch (e: any) {
      handleError(res, e, 'GENERATE_REVIEW_FAILED');
    }
  });

  return router;
}
