/**
 * Agent-P1-payment-receive-and-reconcile-flow-contract
 *
 * payment.receive_and_reconcile 最小闭环契约：
 *   draft（收款+核销计划，含 N 笔 allocation 支持 split voucher）
 *   → approval（透传 processDraft，用户审批快照）
 *   → commit（事务内 create voucher + N allocations + 状态重算 + EntityLink + audit）
 *
 * 铁律：commit 阶段复用 allocationService 纯函数（recalcInvoiceStatus/recalcVoucherStatus/syncAllocationVoucherLinks），
 *      禁止绕过 InvoiceAllocation/route contract 复制 reduce 逻辑。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import {
  recalcInvoiceStatus,
  recalcVoucherStatus,
  validateAllocationInput,
  syncAllocationVoucherLinks,
  applyAllocation,
} from '../finance/allocationService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

// ── 稳定 error code（不随实现漂移） ──
export type PaymentReconcileErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'VOUCHER_NOT_FOUND'
  | 'INVOICE_NOT_FOUND'
  | 'ALLOCATION_INVALID'
  | 'OVER_APPLY'              // 核销超额（appliedAmount > invoice.amount 或 voucher.amount）
  | 'ALLOCATION_CONFLICT'     // 并发核销冲突（Serializable 隔离中止，P2034）——可安全重试
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface PaymentReconcileError {
  code: PaymentReconcileErrorCode;
  message: string;
  userAction: string;
  details?: string[];
  /** true = 瞬态冲突（如并发序列化中止），调用方可安全重试 */
  retryable?: boolean;
}

/** commit 成功结构化字段 */
export interface PaymentReconcileCommitted {
  status: 'committed';
  voucherId: string;
  allocations: Array<{ invoiceId: string; appliedAmount: string; invoiceStatus: string | null; voucherStatus: string }>;
  transactionId: string;
  auditId: string;
  idempotencyKey: string;
}

/** 三态 feedback */
export type PaymentReconcileFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | PaymentReconcileCommitted
  | { status: 'failed'; error: PaymentReconcileError; approvalId?: string };

/** 构造稳定 error */
export function buildPaymentReconcileError(
  code: PaymentReconcileErrorCode,
  message: string,
  details?: string[],
): PaymentReconcileError {
  const userActionMap: Record<PaymentReconcileErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起收款核销，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '收款核销 draft 语义校验失败，请检查 allocation 配置',
    VOUCHER_NOT_FOUND: '检查收付款凭证 ID 是否存在',
    INVOICE_NOT_FOUND: '检查发票 ID 是否存在',
    ALLOCATION_INVALID: '检查核销金额是否为正数、必填字段是否完整',
    OVER_APPLY: '核销总额不得超过发票/凭证金额',
    ALLOCATION_CONFLICT: '检测到并发核销冲突，本次操作已安全回滚，请重试',
    COMMIT_TRANSACTION_FAILED: '事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code], details, retryable: code === 'ALLOCATION_CONFLICT' };
}

// ── Draft 构建 ──

export interface ReconcileDraftInput {
  voucherId: string;
  voucherAmount: number;
  currency: string;
  allocations: Array<{ invoiceId: string; appliedAmount: string | number }>;
}

/**
 * 构建 payment.receive_and_reconcile 的 ProcessDraft。
 * composedOf: create_voucher（已存在凭证）+ N allocations
 * impactScope: ['vouchers', 'invoices', 'allocations']
 */
export function buildPaymentReconcileDraft(input: ReconcileDraftInput): ProcessDraft {
  const subOperations: SubOperation[] = input.allocations.map((a) => ({
    toolId: 'finance.apply_voucher_to_invoice',
    entityId: a.invoiceId,
    action: 'apply_voucher',
    before: { voucherId: input.voucherId, invoiceId: a.invoiceId },
    after: { voucherId: input.voucherId, invoiceId: a.invoiceId, appliedAmount: a.appliedAmount },
  }));

  const beforeAfterDiff = input.allocations.map((a) => ({
    entity: 'invoices',
    entityId: a.invoiceId,
    field: 'allocations',
    before: null,
    after: { voucherId: input.voucherId, appliedAmount: a.appliedAmount },
  }));

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['vouchers', 'invoices', 'allocations'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `payment.receive_and_reconcile:${input.voucherId}:${hash}`;

  return {
    ...content,
    idempotencyKey,
  };
}

// ── Draft 语义校验 ──

export function validateReconcileDraftSemantics(draft: ProcessDraft): { ok: boolean; error?: PaymentReconcileError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildPaymentReconcileError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one allocation subOperation') };
  }
  // 每笔 allocation 校验
  for (const sub of draft.subOperations) {
    const after = sub.after as any;
    const v = validateAllocationInput({
      invoiceId: after?.invoiceId,
      voucherId: after?.voucherId,
      appliedAmount: after?.appliedAmount,
    });
    if (!v.ok) {
      return { ok: false, error: buildPaymentReconcileError('ALLOCATION_INVALID', v.message!) };
    }
  }
  return { ok: true };
}

/** hash 校验（防篡改） */
export function verifyReconcileDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

// ── Commit（事务内复用 allocationService 纯函数） ──

export interface ReconcileCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any; // 含 processDraft
}

export async function commitPaymentReceiveAndReconcile(
  params: ReconcileCommitParams,
): Promise<{ ok: true; feedback: PaymentReconcileCommitted } | { ok: false; feedback: { status: 'failed'; error: PaymentReconcileError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  // 1. 恢复 draft
  const draft: ProcessDraft | undefined = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildPaymentReconcileError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  // 2. hash 校验
  const hashCheck = verifyReconcileDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildPaymentReconcileError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  // 3. 语义校验
  const semCheck = validateReconcileDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  // 4. 事务内提交（复用 allocationService 纯函数）
  const transactionId = `prc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let auditId = '';
  let allocationsResult: PaymentReconcileCommitted['allocations'] = [];

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const voucherId = (draft.subOperations[0].after as any).voucherId;
      // 校验 voucher 存在（提前 fail-closed）
      const voucher = await tx.paymentVoucher.findUnique({ where: { id: voucherId }, select: { id: true, deletedAt: true } });
      if (!voucher || voucher.deletedAt) {
        throw Object.assign(new Error(`voucher ${voucherId} not found`), { code: 'VOUCHER_NOT_FOUND' });
      }

      const allocResults: PaymentReconcileCommitted['allocations'] = [];

      // task Agent-P1 review-fix: 复用 applyAllocation 共用 service（route + Agent 同一事务闭环）
      // 不再手写 invoiceAllocation.upsert/recalc/sync——消除 EntityReference/settlesInvoice 漂移
      for (const sub of draft.subOperations) {
        const after = sub.after as any;
        const invId = after.invoiceId as string;
        const appliedAmount = String(after.appliedAmount);

        const r = await applyAllocation(prisma, tx, {
          invoiceId: invId,
          voucherId,
          appliedAmount,
          actorId: auditActorFrom(params),
          source: 'agent:receive_and_reconcile',
          auditOperation: 'create_allocation',
        });
        allocResults.push({ invoiceId: invId, appliedAmount, invoiceStatus: r.newInvoiceStatus, voucherStatus: r.newVoucherStatus });
      }

      // 复合 flow 级 audit（事务内）
      const aId = `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.auditLog.create({
        data: {
          id: aId,
          actorId: auditActorFrom(params),
          action: 'payment_receive_and_reconcile_committed',
          targetType: 'PaymentVoucher',
          targetId: voucherId,
          detail: { transactionId, approvalId, idempotencyKey: draft.idempotencyKey, allocations: allocResults } as any,
        },
      });
      auditId = aId;
      allocationsResult = allocResults;
      return { voucherId };
    }, {
      // Phase 2 · 2.2 并发根因修复：check-then-act（读已核销→校验剩余→upsert）在
      // READ COMMITTED 下存在并发超核销窗口（两审批并发核销同一发票可双双通过校验）。
      // Serializable 让 PostgreSQL SSI 中止其中一个事务（P2034），由下方映射为可重试冲突。
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    return {
      ok: true,
      feedback: {
        status: 'committed',
        voucherId: result.voucherId,
        allocations: allocationsResult,
        transactionId,
        auditId,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    const code = e?.code === 'VOUCHER_NOT_FOUND' ? 'VOUCHER_NOT_FOUND'
      : e?.code === 'INVOICE_NOT_FOUND' ? 'INVOICE_NOT_FOUND'
      : e?.code === 'ALLOCATION_INVALID' ? 'ALLOCATION_INVALID'
      : e?.code === 'P2034' ? 'ALLOCATION_CONFLICT' // Prisma 序列化冲突/死锁中止——SSI 兜底并发超核销
      : 'COMMIT_TRANSACTION_FAILED';
    const copy = {
      VOUCHER_NOT_FOUND: '收付款凭证不存在或已删除，请核对原单据。',
      INVOICE_NOT_FOUND: '发票不存在或已删除，请核对核销来源。',
      ALLOCATION_INVALID: '核销明细不满足要求，请核对金额和关联单据。',
      ALLOCATION_CONFLICT: '核销发生并发冲突，本次已回滚，请使用原请求重试。',
      COMMIT_TRANSACTION_FAILED: '收款核销未能完成，本次已回滚，请核对原请求后重试。',
    };
    return {
      ok: false,
      feedback: { status: 'failed', error: buildPaymentReconcileError(code as PaymentReconcileErrorCode, copy[code]), approvalId },
    };
  }
}
