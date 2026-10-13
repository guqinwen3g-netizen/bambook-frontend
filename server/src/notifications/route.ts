/**
 * Phase 0 Sprint 1 — 通知 REST API
 *
 * 端点：
 *   GET    /v1/notifications              列出当前用户通知（支持 unreadOnly/type/level/limit/offset）
 *   GET    /v1/notifications/stats         获取未读统计
 *   POST   /v1/notifications/:id/read      标记单条已读
 *   POST   /v1/notifications/read-all      标记全部已读
 *   DELETE /v1/notifications/:id           删除通知
 *   GET    /v1/notifications/preferences   D2：本人通知类型偏好清单
 *   PUT    /v1/notifications/preferences/:type  D2：启用/静音某类型（幂等 upsert）
 *   GET    /v1/notifications/catalog       D2：类型目录（注册表 ∪ 本人见过，合并启用状态）
 *   POST   /v1/notifications/:id/convert-to-followup  D2：通知转 CRM 跟进任务（幂等）
 *
 * 鉴权：从 req.actor.userId 解析当前用户（cookie JWT 或 API key actor）
 */

import { Router, Request, Response } from 'express';
// ★ B42 A1（S0-A2 文案线）：错误出口接真源。logger 是 D51 的前置——
//   本域 10 处 catch 此前**一处日志都没有**，先把原文落进日志，再把对外文案换成固定中文。
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { getNotificationService, getNotificationPrisma } from './eventBindings';
import { convertNotificationToFollowUp } from './notificationFollowUpService';

export function createNotificationsRouter(): Router {
  const router = Router();

  // 鉴权中间件：要求 actor 必须有 userId（非纯 API key）
  const requireUser = (req: Request, res: Response, next: () => void) => {
    const userId = (req as any).actor?.userId;
    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User authentication required for notifications.',
      });
    }
    (req as any).notificationUserId = userId;
    next();
  };

  // GET /v1/notifications — 列出当前用户通知
  router.get('/', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const { items, total } = await service.listNotifications({
        userId,
        unreadOnly: req.query.unreadOnly === 'true',
        type: typeof req.query.type === 'string' ? req.query.type : undefined,
        level: typeof req.query.level === 'string' ? req.query.level : undefined,
        limit: req.query.limit ? Math.min(Number(req.query.limit), 200) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      });
      res.json({ items, total });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] list failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_LIST_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // GET /v1/notifications/stats — 获取未读统计
  router.get('/stats', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const stats = await service.getStats(userId);
      res.json(stats);
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] stats failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_STATS_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // POST /v1/notifications/:id/read — 标记单条已读
  router.post('/:id/read', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const result = await service.markAsRead(userId, req.params.id);
      if (!result.ok) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found or already read.' });
      }
      res.json({ ok: true });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] mark-read failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_MARK_READ_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // POST /v1/notifications/read-all — 标记全部已读
  router.post('/read-all', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const result = await service.markAllAsRead(userId);
      res.json({ ok: true, count: result.count });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] read-all failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_MARK_ALL_READ_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // DELETE /v1/notifications/:id — 删除通知
  router.delete('/:id', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const result = await service.deleteNotification(userId, req.params.id);
      if (!result.ok) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found.' });
      }
      res.json({ ok: true });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] delete failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_DELETE_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // POST /v1/notifications/:id/dismiss — PRD 7.1「忽略需填原因」（用于推送准确率优化）
  router.post('/:id/dismiss', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!reason) {
        return res.status(400).json({ error: 'REASON_REQUIRED', message: '忽略通知必须填写原因（reason）。' });
      }
      if (reason.length > 500) {
        return res.status(400).json({ error: 'REASON_TOO_LONG', message: '忽略原因最长 500 字。' });
      }
      const service = getNotificationService();
      const result = await service.dismissNotification(userId, req.params.id, reason);
      if (!result.ok) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found or already dismissed.' });
      }
      res.json({ ok: true });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] dismiss failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_DISMISS_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ─── D2 主动提醒引擎：偏好控制面 + 转跟进闭环 ───

  // GET /v1/notifications/preferences — 本人通知类型偏好清单
  router.get('/preferences', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const items = await service.getPreferences(userId);
      res.json({ items });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] preferences failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_PREFERENCES_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // PUT /v1/notifications/preferences/:type — 启用/静音某类型（幂等 upsert）
  router.put('/preferences/:type', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const isEnabled = (req.body as any)?.isEnabled;
      if (typeof isEnabled !== 'boolean') {
        return res.status(400).json({ error: 'INVALID_BODY', message: 'isEnabled (boolean) is required.' });
      }
      const service = getNotificationService();
      const item = await service.upsertPreference(userId, req.params.type, isEnabled);
      res.json({ ok: true, item });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] preference-upsert failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_PREFERENCE_UPSERT_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // GET /v1/notifications/catalog — 类型目录（注册表 ∪ 本人见过，合并启用状态）
  router.get('/catalog', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const service = getNotificationService();
      const items = await service.getTypeCatalog(userId);
      res.json({ items });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] catalog failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_CATALOG_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // POST /v1/notifications/:id/convert-to-followup — 通知转 CRM 跟进任务（幂等）
  router.post('/:id/convert-to-followup', requireUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).notificationUserId as string;
      const result = await convertNotificationToFollowUp(getNotificationPrisma(), req.params.id, {
        actorId: userId,
        source: 'api:notifications',
      });
      if (!result.ok) {
        if (result.error === 'NO_RELATION') {
          return res.status(409).json({ error: 'NO_RELATION', message: '通知未关联客户档案，无法创建跟进任务。' });
        }
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found.' });
      }
      res.json({ ok: true, reused: result.reused ?? false, followUpId: result.followUpId, nextFollowUpAt: result.nextFollowUpAt ?? null });
    } catch (e: any) {
      // ★ D51：原文只进日志（本域此前**一处日志都没有** ⇒ 直接换文案会把故障诊断面清零）
      logger.error('[notifications] convert-to-followup failed', { error: e?.message ?? String(e) });
      const r = safeRouteError(e, { fallbackCode: 'NOTIFICATION_CONVERT_FAILED' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
