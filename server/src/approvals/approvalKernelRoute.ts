/**
 * approvalKernelRoute.ts — Phase 1 共享内核：DR-007 审批内核操作 API
 *
 * 与 approvalRoute.ts（业务审批中心列表/decide）的关系：
 *   delegate / boss-bypass 共用 approvalDecisionService 的行锁、决议与审计事务。
 *
 * 端点：
 *   POST /:id/delegate         — 审批人主动转派（BASE-39-B2 / DR7-B2）
 *   POST /:id/boss-bypass      — BOSS 最终兜底特批（BASE-39-B3 / DR-041 绝密级）
 *   GET  /:id/resolution-trace — DR-007 解析路径审计字段只读视图
 *
 * 权限（服务端强制执行，fail-closed）：
 *   - 全部端点仅 JWT（extractActorFromRequest），无 token 401
 *   - delegate：仅当前 reviewerId 本人可调用；禁止委派给申请人（防自审）；reason ≥10 字
 *   - boss-bypass：仅 actor.roles 含 'owner'（SUPER_ADMIN legacy 映射）；reason ≥30 字
 *   - resolution-trace：owner / admin / manager 角色可读
 *   - delegate / boss-bypass 仅 status='pending' 可操作（409 otherwise）
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { logger } from '../lib/logger';
import { createApprovalDecisionService, type OnApprovalDecided, type DecideActor } from './approvalDecisionService';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

// 内核读操作可见角色（与业务审批中心一致）
const KERNEL_READ_ROLES = ['owner', 'admin', 'manager'];
// BOSS 最终兜底特批：仅 owner（SUPER_ADMIN legacy 映射，BASE-39-B3：系统管理员 Z 也不得写）
const BOSS_BYPASS_ROLES = ['owner'];

const DELEGATE_REASON_MIN = 10;   // 委托理由最少 10 字（BASE-39-B2 建议值，服务端强制）
const BOSS_REASON_MIN = 30;       // BOSS 兜底理由最少 30 字（BASE-39-B3 fail-closed 强制）

export interface ApprovalKernelRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  onDecided?: OnApprovalDecided;
}

export function createApprovalKernelRouter(options: ApprovalKernelRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth } = options;
  const decisions = createApprovalDecisionService(prisma, { onDecided: options.onDecided });

  // ── 鉴权：仅 JWT；返回 actor（含 roles 供各端点做角色检查） ──
  const authenticate = (req: Request, res: Response): DecideActor | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'authentication required（审批内核仅接受 JWT 登录）' });
      return null;
    }
    return { ...actor, roles: actor.roles ?? [] };
  };

  const hasAnyRole = (roles: string[], allowed: string[]) => roles.some((r) => allowed.includes(r));

  // ── POST /:id/delegate — 审批人主动转派 ──
  router.post('/:id/delegate', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const { toUserId, reason } = req.body || {};
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < DELEGATE_REASON_MIN) {
        return res.status(400).json({ error: `delegateReason 至少 ${DELEGATE_REASON_MIN} 字（审计强制）` });
      }
      const targetUserId = typeof toUserId === 'string' ? toUserId.trim() : '';
      if (!targetUserId) {
        return res.status(400).json({ error: 'toUserId 必填' });
      }

      const updated = await decisions.delegate({ id: req.params.id, actor: auth,
        toUserId: targetUserId, reason: trimmedReason, ip: req.ip });
      logger.info('[ApprovalKernel] approval delegated', { id: updated.id, from: auth.userId, to: targetUserId });
      res.json({ item: updated });
    } catch (e: any) {
      logger.error('[ApprovalKernel] POST delegate failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to delegate approval' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // ── POST /:id/boss-bypass — BOSS 最终兜底特批 ──
  router.post('/:id/boss-bypass', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    // BASE-39-B3：仅 BOSS 容器（owner）；系统管理员 admin 一律 403 BOSS_BYPASS_REQUIRES_OWNER
    if (!hasAnyRole(auth.roles, BOSS_BYPASS_ROLES)) {
      return res.status(403).json({ error: 'BOSS_BYPASS_REQUIRES_OWNER：仅超级管理员（BOSS）可最终兜底特批' });
    }
    try {
      const { reason, reviewContentVersion, confirmedReviewedContent } = req.body || {};
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < BOSS_REASON_MIN) {
        return res.status(400).json({ error: `bossFinalBypassReason 至少 ${BOSS_REASON_MIN} 字（绝密级审计强制，fail-closed）` });
      }
      if (typeof reviewContentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(reviewContentVersion) || confirmedReviewedContent !== true) {
        return res.status(400).json({ error: 'BOSS 批准前必须核对并确认当前审批内容版本。' });
      }

      const { updated, sync, eventDelivery } = await decisions.decide({ id: req.params.id, actor: auth,
        mode: 'boss', decision: 'approved', bossReason: trimmedReason,
        source: 'api:approvals-kernel', ip: req.ip, reviewContentVersion, confirmedReviewedContent: true });
      logger.warn('[ApprovalKernel] boss final bypass approved', { id: updated.id, bossId: auth.userId, actionType: updated.actionType });
      res.json({ item: updated, ...(sync ? { sync } : {}), ...(eventDelivery ? { eventDelivery } : {}) });
    } catch (e: any) {
      logger.error('[ApprovalKernel] POST boss-bypass failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to boss-bypass approval' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // ── GET /:id/resolution-trace — DR-007 解析路径审计字段只读视图 ──
  router.get('/:id/resolution-trace', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (requireAuth && !hasAnyRole(auth.roles, KERNEL_READ_ROLES)) {
      return res.status(403).json({ error: 'forbidden：仅管理层 / 部门主管可查看解析轨迹' });
    }
    try {
      const existing = await prisma.approvalRequest.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          status: true,
          actionType: true,
          requesterId: true,
          reviewerId: true,
          reviewerResolverRoute: true,
          departmentSnapshotId: true,
          delegatedBy: true,
          delegatedAt: true,
          delegateReason: true,
          clientReviewerIdSupplied: true,
          bossFinalBypassBy: true,
          bossFinalBypassAt: true,
          bossFinalBypassReason: true,
          bypassedApprovalId: true,
        },
      });
      if (!existing) return res.status(404).json({ error: `审批单 ${req.params.id} 不存在` });
      res.json({ item: existing });
    } catch (e: any) {
      logger.error('[ApprovalKernel] GET resolution-trace failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to load resolution trace' });
      res.status(r.status).json({ error: r.message });
    }
  });

  return router;
}
