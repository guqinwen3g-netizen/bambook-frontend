/**
 * exceptionRoute.ts — DR-013 受控例外 API
 *
 * 挂载：createExceptionRouter({ prisma, requireAuth })
 * 建议路径：/api/v1/exceptions（由主代理在 index.ts 收口）
 *
 * 端点：
 *   POST /                  — 创建例外申请（scope exception:dr013:create；DR-007 服务端解析 reviewerId）
 *   GET  /                  — 列表（status / exceptionCategory / requesterId 过滤）
 *   GET  /gate-check        — 门禁查询（targetType+targetId+action 是否有生效例外；供其他域/前端门禁点消费）
 *   GET  /:id               — 详情（惰性对账审批结论）
 *   POST /:id/withdraw      — 申请人撤回（仅 Pending，仅本人）
 *   POST /:id/boss-bypass   — BOSS 最终兜底特批（仅 owner 角色；reason ≥30 字；双模型写入）
 *
 * 鉴权：JWT fail-closed（无 token 401，无 scope 403）
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createExceptionService, EXCEPTION_ERRORS } from './exceptionService';
import { EXCEPTION_CATEGORIES, type ExceptionCategory } from './exceptionGate';
import { logger } from '../lib/logger';
// ★ 未预期异常不再回显原始错误（Prisma 原文/表名列名）；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface ExceptionRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

// BOSS 最终兜底特批：仅 owner（SUPER_ADMIN legacy 映射，与 approvalKernelRoute 同语义）
const BOSS_BYPASS_ROLES = ['owner'];

export function createExceptionRouter(options: ExceptionRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth } = options;

  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  const exceptionService = createExceptionService({ prisma, approvalCreateService });

  // ── 鉴权：JWT fail-closed ──
  const authenticate = (req: Request, res: Response): { userId: string; roles: string[] } | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
      return null;
    }
    (req as any).actor = actor; // 供 hasScopeOnRequest 使用
    return { userId: actor.userId, roles: actor.roles ?? [] };
  };

  const requireScope = (req: Request, res: Response, scope: string): boolean => {
    if (!requireAuth) return true;
    if (!hasScopeOnRequest(req, scope as any)) {
      res.status(403).json({ error: 'FORBIDDEN', message: `INSUFFICIENT_SCOPE: ${scope}` });
      return false;
    }
    return true;
  };

  const sendServiceError = (res: Response, error: { code: string; message: string; statusCode: number }) =>
    res.status(error.statusCode).json({ error: error.code, message: error.message });

  // ══════════════════════════════════════════════════════════════════
  // POST / — 创建例外申请
  // ══════════════════════════════════════════════════════════════════
  router.post('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'exception:dr013:create')) return;

    try {
      const body = req.body || {};
      const category = String(body.exceptionCategory ?? '').trim() as ExceptionCategory;
      if (!EXCEPTION_CATEGORIES.includes(category)) {
        return res.status(400).json({
          error: EXCEPTION_ERRORS.INVALID_EXCEPTION_CATEGORY,
          message: `非法例外类别: ${category}。允许: ${EXCEPTION_CATEGORIES.join(', ')}`,
        });
      }

      const result = await exceptionService.createExceptionRequest({
        exceptionCategory: category,
        subCategory: body.subCategory ? String(body.subCategory).trim() : null,
        bypassedApprovalIds: Array.isArray(body.bypassedApprovalIds) ? body.bypassedApprovalIds.map(String) : [],
        exceptionReason: String(body.exceptionReason ?? '').trim(),
        customerCommitment: body.customerCommitment ? String(body.customerCommitment).trim() : null,
        riskMitigationPlan: String(body.riskMitigationPlan ?? '').trim(),
        targetType: String(body.targetType ?? '').trim(),
        targetId: String(body.targetId ?? '').trim(),
        action: String(body.action ?? '').trim(),
        validUntil: body.validUntil ?? null,
        maxUses: body.maxUses != null ? Number(body.maxUses) : undefined,
        responsibleOwnerId: String(body.responsibleOwnerId ?? '').trim(),
        requesterId: auth.userId,
        notes: body.notes ? String(body.notes) : null,
        attachments: body.attachments,
        // DEV-11-B4：前端越权传入 reviewerId 一律忽略，仅作审计标记（服务端 DR-007 解析为唯一真源）
        clientSuppliedReviewerId: body.reviewerId ? String(body.reviewerId) : null,
      });

      if (!result.ok) return sendServiceError(res, result.error);
      return res.status(201).json(result.data);
    } catch (e: any) {
      logger.error('[ExceptionRoute] POST / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '创建例外申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /gate-check — 门禁查询（须在 /:id 之前注册，避免被参数路由捕获）
  // ══════════════════════════════════════════════════════════════════
  router.get('/gate-check', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const targetType = String(req.query.targetType ?? '').trim();
      const targetId = String(req.query.targetId ?? '').trim();
      const action = String(req.query.action ?? '').trim();
      if (!targetType || !targetId || !action) {
        return res.status(400).json({
          error: 'INVALID_SCOPE',
          message: 'targetType / targetId / action 三个查询参数均必填（精确匹配，拒绝模糊查询）',
        });
      }
      const atRaw = req.query.at ? String(req.query.at) : null;
      const at = atRaw ? new Date(atRaw) : undefined;
      if (at && Number.isNaN(at.getTime())) {
        return res.status(400).json({ error: 'INVALID_AT', message: `at 非合法时间: ${atRaw}` });
      }
      const result = await exceptionService.hasActiveException({ targetType, targetId, action, at });
      return res.json(result);
    } catch (e: any) {
      logger.error('[ExceptionRoute] GET /gate-check failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '门禁例外查询失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET / — 列表（status / exceptionCategory / requesterId 过滤）
  // ══════════════════════════════════════════════════════════════════
  router.get('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const result = await exceptionService.listExceptions({
        status: req.query.status ? String(req.query.status) : undefined,
        exceptionCategory: req.query.exceptionCategory ? String(req.query.exceptionCategory) : undefined,
        requesterId: req.query.requesterId ? String(req.query.requesterId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      if (!result.ok) return sendServiceError(res, result.error);
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[ExceptionRoute] GET / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询例外申请列表失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:id — 详情
  // ══════════════════════════════════════════════════════════════════
  router.get('/:id', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const result = await exceptionService.getExceptionById(req.params.id);
      if (!result.ok) return sendServiceError(res, result.error);
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[ExceptionRoute] GET /:id failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询例外申请详情失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/withdraw — 申请人撤回（仅 Pending，仅本人）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/withdraw', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    // O-1（§10.7）：撤回此前零权限校验。权限点复用 create（能提申请就能申请撤回），
    // 「能撤谁的」由服务层按归属判定：本人或领导/老板（§10.4.1）。
    if (!requireScope(req, res, 'exception:dr013:create')) return;
    try {
      const result = await exceptionService.withdrawException({
        exceptionId: req.params.id,
        actorId: auth.userId,
        actorRoles: auth.roles,
      });
      if (!result.ok) return sendServiceError(res, result.error);
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[ExceptionRoute] POST /:id/withdraw failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '撤回例外申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/boss-bypass — BOSS 最终兜底特批（仅 owner；reason ≥30 字）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/boss-bypass', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    // 与 approvalKernelRoute 同语义：仅 BOSS 容器（owner）；admin 一律 403
    if (!auth.roles.some((r) => BOSS_BYPASS_ROLES.includes(r))) {
      return res.status(403).json({
        error: 'BOSS_BYPASS_REQUIRES_OWNER',
        message: '仅超级管理员（BOSS）可最终兜底特批受控例外',
      });
    }
    try {
      const result = await exceptionService.bossFinalBypassException({
        exceptionId: req.params.id,
        bossId: auth.userId,
        reason: String(req.body?.reason ?? ''),
      });
      if (!result.ok) return sendServiceError(res, result.error);
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[ExceptionRoute] POST /:id/boss-bypass failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'BOSS 兜底特批失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
