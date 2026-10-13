import { SYSTEM_AUDIT_ACTOR } from '../audit/routeAudit';
/**
 * Tool Dispatch Registry — 工具分发注册表
 *
 * 将 executeTool 中 77 个 if 分支替换为 Map 注册表模式。
 * 新增工具只需 registerTool()，无需修改 executeTool 函数体。
 *
 * 设计原则:
 *   1. 渐进式迁移——先注册简单工具（直接 return），复合流程暂留原路径
 *   2. 类型安全——ToolHandler 接口约束输入输出
 *   3. 可扩展——支持同步/异步 handler
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import type { ActorContext } from './types';
import { toolActorToken } from './toolActorContext';
import { checkCurrentInvoiceToolActor } from './invoiceMutationFlow';
import { currentCustomerConfirmationActor } from '../customerConfirmations/customerConfirmationService';

export interface ToolExecutionContext {
  actorId?: string;
  sessionId?: string;
  /** Trusted server identity, never read from tool input. */
  actor?: ActorContext;
}

export interface PlannedToolCall {
  toolId: string;
  input: Record<string, unknown>;
  approvalId?: string;
}

export interface ToolHandlerResult {
  ok: boolean;
  [key: string]: unknown;
}

export type ToolHandler = (
  prisma: PrismaClient,
  input: Record<string, unknown>,
  call?: PlannedToolCall,
  context?: ToolExecutionContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

// ─── 注册表核心 ───
const toolHandlers = new Map<string, ToolHandler>();
const receiptGuardedCommitTools = new Set<string>();

export function registerTool(toolId: string, handler: ToolHandler): void {
  // Replacing the actual handler revokes its previous recovery capability.
  receiptGuardedCommitTools.delete(toolId);
  if (toolHandlers.has(toolId)) {
    logger.warn(`[toolDispatchRegistry] Duplicate registration for ${toolId}, overwriting`);
  }
  toolHandlers.set(toolId, handler);
}

export function isReceiptGuardedCommitTool(toolId: string): boolean {
  return toolHandlers.has(toolId) && receiptGuardedCommitTools.has(toolId);
}

export function hasToolHandler(toolId: string): boolean {
  return toolHandlers.has(toolId);
}

export function getToolHandler(toolId: string): ToolHandler | undefined {
  return toolHandlers.get(toolId);
}

export function getRegisteredToolIds(): string[] {
  return Array.from(toolHandlers.keys()).sort();
}

export function getRegisteredToolCount(): number {
  return toolHandlers.size;
}

/**
 * 尝试通过注册表分发工具调用。
 * 返回 true 表示命中注册表（result 已填充），false 表示未注册（需走原 if 链）。
 */
export async function dispatchFromRegistry(
  prisma: PrismaClient,
  call: PlannedToolCall,
  context?: ToolExecutionContext,
): Promise<{ hit: true; result: ToolHandlerResult } | { hit: false }> {
  const handler = toolHandlers.get(call.toolId);
  if (!handler) return { hit: false };
  const result = await handler(prisma, call.input, call, context);
  return { hit: true, result };
}

// ─── 批量注册辅助 ───
export function registerTools(tools: Record<string, ToolHandler>): void {
  for (const [id, handler] of Object.entries(tools)) {
    registerTool(id, handler);
  }
}


// ─── Commit Tool 注册辅助 ───
// 复合流程工具（需要 approval/draft/commit 闭环）的通用注册器。
// 所有 25 个 commit 工具共享相同的 7 步 boilerplate：
//   1. 提取 approvalId
//   2. 校验 approvalId 存在
//   3. 查 approvalRequest
//   4. 校验 status === 'approved'
//   5. 提取 payload
//   6. 调用具体 commit 函数
//   7. 返回结果

export interface CommitContext {
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: Record<string, unknown> | null;
  /**
   * ★ B58：审计身份的唯一来源 = **审批请求人**（`ApprovalRequest.requesterId`，NOT NULL 且有 UserAccount 外键），
   * 查不到才落 `'system'`。此前每个 commit flow 各写一份 `actorId: 'agent'`，
   * 而 `'agent'` 在 `UserAccount` 里没有行 ⇒ 32 处会经 `AuditLog.actorId` 外键的路径整笔 P2003 回滚
   * （表现成"数据库错误"，真相是身份写错）。收口在这里 = 一处注入覆盖全部 flow，
   * 而不是让 26 个 flow 各自再查一遍 approval（那会长出 26 份同一逻辑）。
   */
  actorId: string;
  /** Verified execution actor for commits with current-identity domain guards.
   * Invoice producers audit this actual operator; requester provenance remains
   * in the unchanged ApprovalRequest and its receipt's approvalId. */
  actor?: ActorContext;
  call: PlannedToolCall;
  /** Legacy generic email receipt is a recovery hint, never send authorization. */
  recoveryOnly?: boolean;
}

export type CommitHandler = (ctx: CommitContext) => Promise<ToolHandlerResult>;

/**
 * 注册一个复合 commit 工具。
 * 自动处理 approval 校验 boilerplate，开发者只需提供具体的 commit 逻辑。
 *
 * 幂等去重（Phase 2 · 任务 2.1）：一个 approval 最多 commit 一次。
 * 通过 AgentCommitReceipt（idempotencyKey=`commit:{toolId}:{approvalId}` 唯一键）在收口层统一去重：
 *   - 首次：创建 receipt(committing) → 执行 commitFn → ok 置 committed 并缓存结果 / 失败删 receipt 允许重试
 *   - 重放（P2002）：已有 receipt → committed 返回缓存结果（replayed 标记）；
 *     committing（崩溃窗口，状态不可判定）→ fail-closed 报 COMMIT_REPLAY_BLOCKED，不自动重试
 *
 * @param toolId 工具 ID（如 'order.confirm'）
 * @param commitFn 具体的 commit 函数，接收 CommitContext（含 prisma + approvalId + payload）
 */
export function registerCommitTool(toolId: string, commitFn: CommitHandler): void {
  registerTool(toolId, async (prisma, _input, call, context) => {
    const targetApprovalId = String(call?.approvalId || '');
    if (!targetApprovalId) {
      const message = `COMMIT_FAILED: approvalId not provided for ${toolId} commit`;
      return {
        ok: false,
        committed: false,
        error: message,
        errorFeedback: {
          code: 'APPROVAL_ID_MISSING',
          message,
          retryable: false,
        },
      };
    }

    // These two order-change commands need a real human executor even on a
    // cached receipt replay. A ProcessDraft actorId/requesterId is provenance,
    // never authority; resolve current DB grants before revealing/returning a
    // prior commit result and preserve the runtime's credential ceiling.
    const orderChangeCommit = toolId === 'order_changes.create' || toolId === 'order_changes.withdraw';
    if (orderChangeCommit) {
      const priorActor = context?.actor ? toolActorToken(context.actor) : undefined;
      if (!priorActor?.userId) {
        const message = '订单变更操作需要当前有效的执行账号。';
        return { ok: false, committed: false, error: message,
          errorFeedback: { code: 'UNAUTHORIZED', message, retryable: false } };
      }
      try {
        await currentCustomerConfirmationActor(prisma, priorActor, 'order:change_request:create');
      } catch (error: any) {
        const code = ['UNAUTHORIZED', 'ACCOUNT_DISABLED', 'FORBIDDEN', 'AUTHORIZATION_UNAVAILABLE'].includes(error?.code)
          ? error.code : 'AUTHORIZATION_UNAVAILABLE';
        const message = error?.message || '当前订单变更权限暂时无法核验，请稍后重试。';
        return { ok: false, committed: false, error: message,
          errorFeedback: { code: code === 'ACCOUNT_DISABLED' ? 'UNAUTHORIZED' : code, message, retryable: false } };
      }
    }

    const approval = await (prisma as any).approvalRequest
      .findUnique({ where: { id: targetApprovalId } })
      .catch(() => null);

    if (!approval) {
      const message = `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=null)`;
      return {
        ok: false,
        committed: false,
        error: message,
        errorFeedback: {
          code: 'APPROVAL_NOT_FOUND',
          message,
          retryable: false,
        },
      };
    }

    if (approval.status === 'pending') {
      const message = 'COMMIT_FAILED: approval not yet approved (status=pending)';
      return {
        ok: false,
        committed: false,
        error: message,
        errorFeedback: {
          code: 'APPROVAL_PENDING',
          message,
          retryable: false,
        },
      };
    }

    if (approval.status !== 'approved') {
      const message = approval.status === 'modified'
        ? `COMMIT_FAILED: ${toolId} does not support modified approval (status=modified). Regenerate the draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not approved (status=${approval.status})`;
      return {
        ok: false,
        committed: false,
        error: message,
        errorFeedback: {
          code: 'APPROVAL_MODIFIED_UNSUPPORTED',
          message,
          retryable: false,
        },
      };
    }

    // toolId-actionType 交叉绑定校验：防止 A 工具审批被 B 工具 commit 消费（安全 fail-closed）
    const expectedActionType = `tool:${toolId}`;
    if (approval.actionType !== expectedActionType) {
      const message = `COMMIT_FAILED: approval ${targetApprovalId} actionType=${approval.actionType} does not match toolId=${toolId} (expected ${expectedActionType})`;
      return {
        ok: false,
        committed: false,
        error: message,
        errorFeedback: {
          code: 'CROSS_APPROVAL_BINDING',
          message,
          retryable: false,
        },
      };
    }

    const payload = approval.payload as Record<string, unknown> | null;

    // Invoice grants must be current even when an old successful receipt can
    // satisfy this request. The approved requester is provenance, not authority.
    const invoiceCommit = toolId === 'invoice.create' || toolId === 'invoice.update' || toolId === 'invoice.issue';
    const invoiceAuthorizationFailure = async (): Promise<ToolHandlerResult | null> => {
      const authority = await checkCurrentInvoiceToolActor(prisma, context?.actor ? toolActorToken(context.actor) : undefined);
      return authority.ok ? null : { ok: false, committed: false, error: authority.error.message,
        errorFeedback: { ...authority.error, retryable: false } };
    };
    if (invoiceCommit) {
      const denied = await invoiceAuthorizationFailure(); if (denied) return denied;
    }
    // Only invoice.issue owns its receipt in the same transaction as Invoice,
    // Outbox and mandatory audit. The generic receipt wrapper below remains
    // unchanged for every other operation.
    if (toolId === 'invoice.issue') return commitFn({
      prisma, approvalId: targetApprovalId, approvalPayload: payload, call: call!,
      actorId: (approval as any)?.requesterId || SYSTEM_AUDIT_ACTOR, actor: context?.actor,
    });

    // EmailSendAttempt owns the SMTP uncertainty window and native commit proof.
    // Never create/reset/delete a generic email receipt or return its cached result.
    if (toolId === 'email.send') {
      const receipts = (prisma as any).agentCommitReceipt;
      let legacyReceipt: unknown;
      try {
        if (!receipts) throw Error('Agent receipt delegate unavailable');
        legacyReceipt = await receipts.findUnique({ where: { idempotencyKey: `commit:${toolId}:${targetApprovalId}` } });
      } catch {
        return { ok: false, committed: false, error: '原 Agent 发送记录暂时无法核对，未重新发送',
          errorFeedback: { code: 'SEND_LEDGER_UNAVAILABLE', message: '原 Agent 发送记录暂时无法核对，未重新发送', retryable: false } };
      }
      return commitFn({ prisma, approvalId: targetApprovalId, approvalPayload: payload, call: call!,
        actorId: (approval as any)?.requesterId || SYSTEM_AUDIT_ACTOR, actor: context?.actor,
        recoveryOnly: legacyReceipt != null });
    }

    // ── 幂等去重：先占 receipt 再执行（唯一键兜底并发重放）──
    // receipts 缺失仅可能出现在不完整 mock 的单元测试；生产 PrismaClient 必有该模型。
    const receipts = (prisma as any).agentCommitReceipt;
    const receiptKey = `commit:${toolId}:${targetApprovalId}`;
    if (receipts) {
      try {
        await receipts.create({
          data: {
            id: `acr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            idempotencyKey: receiptKey,
            toolId,
            approvalId: targetApprovalId,
            status: 'committing',
          },
        });
      } catch (createErr: any) {
        if (createErr?.code === 'P2002') {
          const existing = await receipts.findUnique({ where: { idempotencyKey: receiptKey } }).catch(() => null);
          if (existing?.status === 'committed' && existing.result && typeof existing.result === 'object') {
            // Receipt acquisition may itself wait for another transaction.
            // Re-read authority immediately before exposing its cached result.
            if (invoiceCommit) { const denied = await invoiceAuthorizationFailure(); if (denied) return denied; }
            return { ...(existing.result as Record<string, unknown>), replayed: true } as unknown as ToolHandlerResult;
          }
          const message = `COMMIT_FAILED: ${toolId} replay blocked for approval ${targetApprovalId} — receipt exists but not committed (possible crash window, manual check required)`;
          return {
            ok: false,
            committed: false,
            error: message,
            errorFeedback: {
              code: 'COMMIT_REPLAY_BLOCKED',
              message,
              retryable: false,
            },
          };
        }
        throw createErr;
      }
    }

    try {
      // approval 在上面已经查出来（且 requesterId 非空 + 有外键），这里只是把身份往下传，不多打一次库
      const result = await commitFn({
        prisma, approvalId: targetApprovalId, approvalPayload: payload, call: call!,
        actorId: (approval as any)?.requesterId || SYSTEM_AUDIT_ACTOR,
        ...(toolId === 'order.line_update' || toolId === 'qc.sign_report' || toolId === 'internal_trade.create' || toolId === 'internal_trade.confirm' || toolId === 'development.convert_to_order' || toolId === 'development.create' || invoiceCommit || orderChangeCommit ? { actor: context?.actor } : {}),
      });
      if (receipts) {
        if (result?.ok) {
          await receipts
            .update({
              where: { idempotencyKey: receiptKey },
              data: { status: 'committed', result: result as any, completedAt: new Date() },
            })
            .catch(() => undefined);
        } else {
          // commit 失败：删除 receipt 允许修复后重试（不留下永久阻塞）
          await receipts.delete({ where: { idempotencyKey: receiptKey } }).catch(() => undefined);
        }
      }
      return result;
    } catch (commitErr) {
      if (receipts) {
        await receipts.delete({ where: { idempotencyKey: receiptKey } }).catch(() => undefined);
      }
      throw commitErr;
    }
  });
  receiptGuardedCommitTools.add(toolId);
}

/**
 * 批量注册 commit 工具
 */
export function registerCommitTools(tools: Record<string, CommitHandler>): void {
  for (const [id, handler] of Object.entries(tools)) {
    registerCommitTool(id, handler);
  }
}
