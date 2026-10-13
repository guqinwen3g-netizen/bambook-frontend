import { resolveQuotationBusinessLeader } from './quotationBusinessLeader';
/**
 * approvalCreateService.ts — DR-007 业务审批单创建服务（reviewerId 服务端解析唯一入口）
 *
 * 设计真源：
 *   - docs/design/04-模块设计/07-AI助手/审批与human-in-the-loop.md §14（DR7-A1/A2）
 *   - docs/design/02-数据模型/底座域模型组.md §39（BASE-39-A2/B1/B4）
 *
 * 铁律（fail-closed）：
 *   1. reviewerId / reviewerResolverRoute / departmentSnapshotId 三个 createOnce 字段
 *      必须且只能由 routingService 解析结果写入
 *   2. 前端传入 reviewerId（clientSuppliedReviewerId）一律忽略并置 clientReviewerIdSupplied=true
 *      + 写越权注入审计日志（DR7-A2：APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT）
 *   3. 路由解析抛 NO_REVIEWER_RESOLVED 时原样上抛（绝不允许 reviewerId=null 落库，BASE-39-B4）
 *   4. 其他创建失败统一包装 APPROVAL_CREATE_FAILED
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { NO_REVIEWER_RESOLVED, type ApprovalRoutingService } from './approvalRoutingService';
import { canonicalClaimJson, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET } from '../claims/claimApprovalFact';

export const APPROVAL_CREATE_FAILED = 'APPROVAL_CREATE_FAILED';

/**
 * 审批单创建所需的最小 DB 面（结构化类型，避免把 PrismaClient 的具体类型钉死）。
 * 传事务客户端（`tx`）时，审批单与其审计**与调用方同事务**提交/回滚。
 */
export type ApprovalDbClient = {
  approvalRequest: {
    findFirst: (args: unknown) => Promise<any>;
    create: (args: unknown) => Promise<any>;
  };
  auditLog: { create: (args: unknown) => Promise<any> };
};

export interface CreateBusinessApprovalInput {
  requesterId: string;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  payload: Record<string, unknown>;
  risk?: string;
  /** 前端越权传入的 reviewerId（将被忽略，仅作审计标记） */
  clientSuppliedReviewerId?: string | null;
  /**
   * ★ 可选：调用方的事务客户端。
   *
   * 为什么需要（2026-09-19 修 PAYR 取号并发时加）：有些业务把「取号 → 建审批单 → 主单落库」
   * 当成一个原子动作。若审批单走**服务自身的 prisma**（事务外），主单落库回滚后
   * 审批单已经提交 ⇒ 留下**孤儿审批单**（审批台有单、业务单不存在）。
   * 传入 `tx` 后三者同生共死。
   *
   * ⚠️ 不传时行为与以前**逐字节一致**（走 `opts.prisma`），因此对既有 6 处调用方零影响。
   */
  client?: ApprovalDbClient | null;
}

export interface ApprovalCreateServiceOptions {
  prisma: PrismaClient;
  routingService: ApprovalRoutingService;
}

export function createApprovalCreateService(opts: ApprovalCreateServiceOptions) {
  const { prisma, routingService } = opts;

  // ── 内部：包装创建失败错误（保留 NO_REVIEWER_RESOLVED 原样上抛语义） ──
  function wrapCreateError(cause: unknown): Error & { code: string } {
    const message = cause instanceof Error ? cause.message : String(cause);
    const err = new Error(`${APPROVAL_CREATE_FAILED}: ${message}`) as Error & { code: string; cause?: unknown };
    err.code = APPROVAL_CREATE_FAILED;
    err.cause = cause;
    return err;
  }

  async function createBusinessApproval(input: CreateBusinessApprovalInput) {
    const {
      requesterId,
      actionType,
      targetType,
      targetId = null,
      payload,
      risk = 'high',
      clientSuppliedReviewerId = null,
      client = null,
    } = input;
    // ★ 有事务客户端就走事务客户端 —— 审批单 + 其审计与调用方同生共死（见 input.client 注释）
    const db: ApprovalDbClient = (client ?? prisma) as unknown as ApprovalDbClient;

    // 1. DR-007 组织归属解析（fail-closed：NO_REVIEWER_RESOLVED 原样上抛）
    let resolution;
    try {
      const claimAction = actionType === CLAIM_APPROVAL_ACTION;
      const claimTarget = targetType === CLAIM_APPROVAL_TARGET;
      if (claimAction !== claimTarget) throw new Error('索赔审批 actionType/targetType 必须准确匹配');
      const resolve = claimAction ? routingService.resolveClaimLeader : routingService.resolveReviewerByDepartment;
      resolution = actionType === 'quotation:total_approve' && targetType === 'Quotation' && targetId
        ? await resolveQuotationBusinessLeader(db, targetId)
        : client ? await resolve(requesterId, client) : await resolve(requesterId);
    } catch (e: any) {
      if (e?.code === NO_REVIEWER_RESOLVED) throw e;
      throw wrapCreateError(e);
    }

    // 1.5 DR-007 单人单次防重：同 requester + actionType + targetId 已有 pending 单 → 幂等返回
    //     （修复前每次门禁重试都会建新单，导致同一豁免诉求出现多张挂起单）
    const existing = await db.approvalRequest.findFirst({
      where: { requesterId, actionType, targetType, targetId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      if (canonicalClaimJson(existing.payload) === canonicalClaimJson(payload)) return existing;
      throw Object.assign(new Error('未决审批内容已变化，请处理原审批后重新提交；不能复用旧内容'), { code: 'APPROVAL_PENDING_CONTENT_CHANGED', statusCode: 409 });
    }

    // 2. 创建审批单：三个 createOnce 字段来自解析结果，绝不使用前端传入值
    const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clientSupplied = Boolean(clientSuppliedReviewerId && String(clientSuppliedReviewerId).trim());
    try {
      const created = await db.approvalRequest.create({
        data: {
          id,
          requesterId,
          actionType,
          targetType,
          targetId,
          status: 'pending',
          risk,
          payload: payload as any,
          reviewerId: resolution.reviewerId,
          reviewerResolverRoute: resolution.route,
          departmentSnapshotId: resolution.departmentSnapshotId,
          clientReviewerIdSupplied: clientSupplied,
        },
      });

      // 3. 前端越权传入 reviewerId → 写审计（DR7-A2 忽略路径，值本身永不落库到 reviewerId）
      if (clientSupplied) {
        await db.auditLog.create({
          data: {
            id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            actorId: requesterId,
            action: 'APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT',
            targetType: 'ApprovalRequest',
            targetId: id,
            detail: {
              source: 'approvalCreateService',
              suppliedReviewerId: String(clientSuppliedReviewerId),
              resolvedReviewerId: resolution.reviewerId,
              route: resolution.route,
            } as any,
            operationType: 'create',
            fieldPath: 'reviewerId',
            afterValue: resolution.reviewerId,
            transactionId: null,
          },
        });
        logger.warn('[ApprovalCreate] 前端传入 reviewerId 已忽略并审计', {
          approvalId: id,
          requesterId,
          suppliedReviewerId: clientSuppliedReviewerId,
          resolvedReviewerId: resolution.reviewerId,
        });
      }

      logger.info('[ApprovalCreate] 审批单已创建', {
        approvalId: id,
        actionType,
        requesterId,
        reviewerId: resolution.reviewerId,
        route: resolution.route,
        departmentSnapshotId: resolution.departmentSnapshotId,
      });
      return created;
    } catch (e) {
      throw wrapCreateError(e);
    }
  }

  return { createBusinessApproval };
}

export type ApprovalCreateService = ReturnType<typeof createApprovalCreateService>;
