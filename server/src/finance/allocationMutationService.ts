import { lockSupplierClaimInvoice, invalidateSupplierClaimSettlement, readSupplierClaimRefusal } from './supplierClaimSettlementGuard';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { syncInvoiceReferences, syncPaymentVoucherReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { recalcInvoiceStatus, recalcVoucherStatus, validateAllocationInput, syncAllocationVoucherLinks, applyAllocation, assertAllocationFacts, isValidAllocationDecimal, readAllocationRefusal } from './allocationService';
import { notifyShipmentBatchSettlementRecalc } from './shipmentBatchSettlementHook';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { publishBusinessEvent } from '../events/businessEventBus';
import { syncOrderAutoSettlementByInvoice } from './orderAutoSettlement';
import type { ThirdPartyPaymentDetection } from './thirdPartyPaymentGuard';
import { todayLocalKey } from '../shared/localDate';
import { businessError, readBusinessErrorMint } from '../shared/errorCodes';
import { runAllocationAttempt, readAllocationAttemptRefusal } from './allocationAttemptOutcome';
import { runReceiptAllocationAttempt, readReceiptAllocationReplay, readReceiptAllocationAttemptRefusal } from './receiptAllocationAttemptOutcome';
import { readReceiptClaimRefusal } from './receiptClaimService';
import { assertNotCashRefundVoucher, readCashRefundRefusal } from '../claims/claimCashRefundFact';
import type { TokenPayload } from '../auth/service';
import { requireFinanceAllocationAccess } from './financeSourceAccess';

export type AllocationMutationErrorCode =
  | 'MISSING_INVOICE' | 'MISSING_VOUCHER' | 'MISSING_AMOUNT' | 'INVALID_AMOUNT'
  | 'INVOICE_NOT_FOUND' | 'VOUCHER_NOT_FOUND' | 'NOT_FOUND'
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'ACCOUNT_DISABLED' | 'AUTHORIZATION_UNAVAILABLE'
  | 'INVALID_STATE' | 'SOURCE_CLAIM_CONFLICT' | 'CONFLICT' | 'ALLOCATION_DIRECTION_MISMATCH' // 并发核销冲突（Serializable 隔离中止，P2034）——route 映射 409，可安全重试
  // ── applyAllocation 内核抛出的业务校验码（route 映射 400）──
  // 2026-09-17 真库演练 T5 抓到：这些码此前**不在白名单里**，被 toAllocationError 兜成
  // CREATE_FAILED → route 映射 500。财务看到「服务器错误」，实际只是「币种不一致/超额」，
  // 完全不知道改什么（报缺码不指向真问题 = 用户卡住）。
  | 'INVALID_INVOICE_STATUS' | 'INVALID_VOUCHER_STATUS' | 'CURRENCY_MISMATCH'
  | 'PAYABLE_SUPPLIER_IDENTITY_REQUIRED' | 'PAYABLE_SUPPLIER_MISMATCH'
  | 'AMOUNT_EXCEEDS_INVOICE' | 'AMOUNT_EXCEEDS_VOUCHER'
  | 'AMOUNT_EXCEEDS_INVOICE_REMAINING' | 'AMOUNT_EXCEEDS_VOUCHER_REMAINING'
  | 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED';
export interface AllocationMutationError { code: AllocationMutationErrorCode; message: string; }
export interface AllocationMutationResult<T = any> { ok: boolean; data?: T; error?: AllocationMutationError; }

/** applyAllocation 内核会抛的业务校验码（原样透传，别兜成 CREATE_FAILED/500） */
const PASSTHROUGH_ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'ACCOUNT_DISABLED', 'AUTHORIZATION_UNAVAILABLE',
  'ALLOCATION_DIRECTION_MISMATCH', 'SOURCE_CLAIM_CONFLICT',
  'INVALID_STATE', 'CONFLICT',
  'MISSING_INVOICE', 'MISSING_VOUCHER', 'MISSING_AMOUNT', 'INVALID_AMOUNT',
  'INVOICE_NOT_FOUND', 'VOUCHER_NOT_FOUND', 'NOT_FOUND',
  'INVALID_INVOICE_STATUS', 'INVALID_VOUCHER_STATUS', 'CURRENCY_MISMATCH',
  'PAYABLE_SUPPLIER_IDENTITY_REQUIRED', 'PAYABLE_SUPPLIER_MISMATCH',
  'AMOUNT_EXCEEDS_INVOICE', 'AMOUNT_EXCEEDS_VOUCHER',
  'AMOUNT_EXCEEDS_INVOICE_REMAINING', 'AMOUNT_EXCEEDS_VOUCHER_REMAINING',
];

function readActualDomainRefusal(error: unknown) {
  const refusal = readAllocationRefusal(error) ?? readSupplierClaimRefusal(error) ?? readCashRefundRefusal(error) ?? readBusinessErrorMint(error);
  return refusal && PASSTHROUGH_ERROR_CODES.includes(refusal.code) ? refusal : undefined;
}

function toAllocationError(error: unknown, fallback: AllocationMutationErrorCode): AllocationMutationError {
  const refusal = readActualDomainRefusal(error) ?? readAllocationAttemptRefusal(error);
  try { logger.error('[finance/allocation] mutation failed', { code: refusal?.code ?? null }); } catch { /* Diagnostics cannot replace the mutation result. */ }
  if (refusal) return { code: refusal.code as AllocationMutationErrorCode, message: refusal.message };
  return { code: fallback, message: '核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。' };
}

// Phase 2 · 2.2 并发根因修复：allocation check-then-act 必须 Serializable，
// 否则 READ COMMITTED 下两事务并发核销同一发票可双双通过剩余校验 → 超核销。
// SSI 中止其中一方（P2034 → CONFLICT/409），调用方重试即可。
const SERIALIZABLE_TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

export interface CreateAllocationData {
  allocation: { id: string; invoiceId: string; voucherId: string; appliedAmount: string; appliedDate: string };
  newInvoiceStatus: string; newVoucherStatus: string; voucherAppliedAmount: string; auditId: string;
  /** L2 高危 3 号：第三方代付判定结果（不阻断；仅用于提交后发事件 / 前端提示） */
  thirdPartyPayment: ThirdPartyPaymentDetection | null;
}

export async function createAllocation(params: {
  prisma: PrismaClient; input: { invoiceId?: string; voucherId?: string; appliedAmount?: any; appliedDate?: string };
  actorId?: string; actor?: TokenPayload | null; ip?: string | null;
}): Promise<AllocationMutationResult<CreateAllocationData>> {
  const { prisma, input, actorId, ip } = params;
  const v = validateAllocationInput(input);
  if (!v.ok) return { ok: false, error: { code: v.error! as AllocationMutationErrorCode, message: v.message! } };
  const invId = input.invoiceId as string; const vocId = input.voucherId as string;
  const appliedDate = input.appliedDate || todayLocalKey();
  try {
    const data = await runAllocationAttempt(prisma, async (tx: any) => {
      {
        if (params.actor?.userId !== actorId) throw businessError('UNAUTHORIZED', '核销操作需要当前可信账号。');
        await requireFinanceAllocationAccess(tx, params.actor, invId, vocId);
      }
      const r = await applyAllocation(prisma, tx, {
        invoiceId: invId, voucherId: vocId, appliedAmount: String(input.appliedAmount), appliedDate,
        actorId: actorId || 'api', source: 'route:allocation:create', auditOperation: 'create_allocation',
      });
      await requireFinanceAllocationAccess(tx, params.actor, invId, vocId);
      return {
        allocation: { id: r.allocationId, invoiceId: invId, voucherId: vocId, appliedAmount: String(input.appliedAmount), appliedDate },
        newInvoiceStatus: r.newInvoiceStatus, newVoucherStatus: r.newVoucherStatus,
        voucherAppliedAmount: r.voucherAppliedAmount.toString(), auditId: r.auditId,
        thirdPartyPayment: r.thirdPartyPayment,
      };
    }, SERIALIZABLE_TX, { actorId: actorId || 'api', source: 'route:allocation:create', operation: 'create_allocation' }, error => Boolean(readActualDomainRefusal(error)));
    // Publish domain events after commit (best-effort, never fails business)
    publishAllocationEvents({
      prisma,
      invoiceId: data.allocation.invoiceId,
      voucherId: data.allocation.voucherId,
      newInvoiceStatus: data.newInvoiceStatus,
      newVoucherStatus: data.newVoucherStatus,
      appliedAmount: data.allocation.appliedAmount,
      voucherAppliedAmount: data.voucherAppliedAmount,
      auditId: data.auditId,
      actorId: actorId || 'api',
      thirdPartyPayment: data.thirdPartyPayment,
    }).catch(() => { /* event publish failure must not fail business */ });
    // §10.3-1：订单自动结案同步已收口进 applyAllocation 内核（step 8），
    // 与批次结算重算 / 信用重算同事务——此处不再重复调用，避免三条通道口径漂移。
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: toAllocationError(e, 'CREATE_FAILED') };
  }
}

/** Receipt confirmation adds a delta; existing createAllocation callers retain replace semantics. */
export async function appendReceiptAllocation(params: {
  prisma: PrismaClient; invoiceId: string; voucherId: string; amount: number;
  actorId: string; actor?: TokenPayload | null; requestId: string; ip?: string | null;
  validate: (tx: any) => Promise<void>;
}): Promise<AllocationMutationResult<CreateAllocationData & { replayed: boolean }>> {
  const { prisma, invoiceId, voucherId, actorId, requestId } = params;
  if (!Number.isFinite(params.amount) || params.amount <= 0) return { ok: false, error: { code: 'INVALID_AMOUNT', message: '本次核销金额必须为正数' } };
  if (!requestId || requestId.length > 128) return { ok: false, error: { code: 'INVALID_AMOUNT', message: '需要有效的核销请求编号' } };
  const fingerprint = JSON.stringify({ invoiceId, voucherId, amount: new Prisma.Decimal(params.amount).toString() });
  const receiptId = 'finance_claim_' + createHash('sha256').update(JSON.stringify([actorId, requestId])).digest('hex');
  const identity = { actorId, receiptId, requestId, fingerprint, invoiceId, voucherId };
  try {
    const data = await runReceiptAllocationAttempt(prisma, async (tx: any) => {
      {
        if (params.actor?.userId !== actorId) throw businessError('UNAUTHORIZED', '核销操作需要当前可信账号。');
        await requireFinanceAllocationAccess(tx, params.actor, invoiceId, voucherId);
      }
      const prior = await readReceiptAllocationReplay(tx, identity);
      if (prior) return prior;
      await params.validate(tx);
      await lockSupplierClaimInvoice(tx, invoiceId);
      await assertNotCashRefundVoucher(tx, voucherId);
      const previous = await tx.invoiceAllocation.findUnique({ where: { invoiceId_voucherId: { invoiceId, voucherId } } });
      const total = new Prisma.Decimal(previous?.appliedAmount ?? 0).plus(params.amount);
      const appliedDate = todayLocalKey();
      const r = await applyAllocation(prisma, tx, {
        invoiceId, voucherId, appliedAmount: total.toString(), appliedDate,
        actorId, source: 'route:receipt:append', auditOperation: 'append_receipt_allocation',
      });
      await requireFinanceAllocationAccess(tx, params.actor, invoiceId, voucherId);
      const result = {
        allocation: { id: r.allocationId, invoiceId, voucherId, appliedAmount: total.toString(), appliedDate },
        newInvoiceStatus: r.newInvoiceStatus, newVoucherStatus: r.newVoucherStatus,
        voucherAppliedAmount: r.voucherAppliedAmount.toString(), auditId: r.auditId, thirdPartyPayment: r.thirdPartyPayment,
      };
      await tx.auditLog.create({ data: {
        id: receiptId, actorId, action: 'finance.receipt.claim.request', targetType: 'InvoiceAllocation', targetId: r.allocationId,
        ip: params.ip ?? null, detail: { fingerprint, requestId, delta: String(params.amount), before: String(previous?.appliedAmount ?? 0), after: total.toString(), result },
      } });
      return { ...result, replayed: false };
    }, SERIALIZABLE_TX, identity, error => Boolean(readReceiptClaimRefusal(error) ?? readActualDomainRefusal(error)));
    if (!data.replayed) publishAllocationEvents({ prisma, invoiceId, voucherId, newInvoiceStatus: data.newInvoiceStatus, newVoucherStatus: data.newVoucherStatus, appliedAmount: data.allocation.appliedAmount, voucherAppliedAmount: data.voucherAppliedAmount, auditId: data.auditId, actorId, thirdPartyPayment: data.thirdPartyPayment }).catch(() => {});
    return { ok: true, data };
  } catch (error) {
    const refusal = readReceiptClaimRefusal(error) ?? readReceiptAllocationAttemptRefusal(error);
    if (refusal) return { ok: false, error: { code: refusal.code as AllocationMutationErrorCode, message: refusal.message } };
    return { ok: false, error: toAllocationError(error, 'CREATE_FAILED') };
  }
}

export interface UpdateAllocationData {
  allocation: { id: string; appliedAmount: string; appliedDate: string };
  invoiceId: string; voucherId: string;
  newInvoiceStatus: string; newVoucherStatus: string; voucherAppliedAmount: string; auditId: string;
}

export async function updateAllocation(params: {
  prisma: PrismaClient; allocationId: string; input: { appliedAmount?: any; appliedDate?: string };
  actorId?: string; actor?: TokenPayload | null; ip?: string | null;
}): Promise<AllocationMutationResult<UpdateAllocationData>> {
  const { prisma, allocationId, input, actorId, ip } = params;
  if (input.appliedAmount != null) {
    if (!isValidAllocationDecimal(input.appliedAmount)) return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'appliedAmount must be a valid decimal' } };
    try { if (new Prisma.Decimal(input.appliedAmount).lte(0)) return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'appliedAmount must be positive' } }; } catch { return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'appliedAmount must be a valid decimal' } }; }
  }
  try {
    const data = await runAllocationAttempt(prisma, async (tx: any) => {
      const now = BigInt(Date.now());
      const existing = await tx.invoiceAllocation.findUnique({ where: { id: allocationId } });
      if (!existing) throw businessError('NOT_FOUND', 'allocation not found');
      {
        if (params.actor?.userId !== actorId) throw businessError('UNAUTHORIZED', '核销操作需要当前可信账号。');
        await requireFinanceAllocationAccess(tx, params.actor, existing.invoiceId, existing.voucherId);
      }
      const supplierClaim = await lockSupplierClaimInvoice(tx, existing.invoiceId);
      await assertNotCashRefundVoucher(tx, existing.voucherId);
      await tx.$queryRawUnsafe('SELECT id FROM "InvoiceAllocation" WHERE id = $1 FOR UPDATE', allocationId);
      const freshAllocation = await tx.invoiceAllocation.findUnique({ where: { id: allocationId } });
      if (!freshAllocation || freshAllocation.invoiceId !== existing.invoiceId || freshAllocation.voucherId !== existing.voucherId) throw businessError('CONFLICT', '核销记录已变化，请刷新后重试。');
      await assertAllocationFacts(tx, existing.invoiceId, existing.voucherId, String(input.appliedAmount ?? freshAllocation.appliedAmount));
      const updateData: any = { updatedAt: now };
      if (input.appliedAmount != null) updateData.appliedAmount = new Prisma.Decimal(input.appliedAmount);
      if (input.appliedDate != null) updateData.appliedDate = input.appliedDate;
      const updated = await tx.invoiceAllocation.update({ where: { id: allocationId }, data: updateData });
      const newInvoiceStatus = await recalcInvoiceStatus(tx, existing.invoiceId);
      const updatedInvoice = await tx.invoice.update({ where: { id: existing.invoiceId }, data: { status: newInvoiceStatus, settlementDate: newInvoiceStatus === 'Paid' ? todayLocalKey() : null, updatedAt: now } });
      const voucherRecalc = await recalcVoucherStatus(tx, existing.voucherId);
      const updatedVoucher = await tx.paymentVoucher.update({ where: { id: existing.voucherId }, data: { status: voucherRecalc.status, appliedAmount: voucherRecalc.totalAllocated, updatedAt: now } });
      await syncInvoiceReferences(prisma, updatedInvoice, { source: 'allocation.update' }, tx);
      await syncPaymentVoucherReferences(prisma, updatedVoucher, { source: 'allocation.update' }, tx);
      await syncAllocationVoucherLinks(tx, existing.voucherId, { source: 'allocation.update' });
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:allocation:update',
        operation: 'update_allocation', targetType: 'InvoiceAllocation', targetId: allocationId,
        before: { appliedAmount: new Prisma.Decimal(existing.appliedAmount).toString() },
        after: { appliedAmount: new Prisma.Decimal(updated.appliedAmount).toString(), invoiceStatus: newInvoiceStatus, voucherStatus: voucherRecalc.status, voucherAppliedAmount: voucherRecalc.totalAllocated.toString() },
        ip: ip || null,
      });
      await invalidateSupplierClaimSettlement(tx, supplierClaim, { invoiceId: existing.invoiceId, triggerId: allocationId, actorId: actorId || 'api', operation: 'allocation.update', ip });
      // W-A P0-1：核销金额调整后触发受影响订单的出运批次结算重算（同事务、失败不阻断，幂等）
      await notifyShipmentBatchSettlementRecalc(tx, { invoiceId: existing.invoiceId, source: 'route:allocation:update' });
      // 修复1：核销金额调整改变应收净额 → 同事务重算客户 usedAmount（幂等收敛）
      if (updatedInvoice.type === 'Receivable' && updatedInvoice.customerRelationId) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: updatedInvoice.customerRelationId,
          source: 'route:allocation:update',
          triggerId: allocationId,
          triggerBy: actorId || 'api',
        });
      }
      await requireFinanceAllocationAccess(tx, params.actor, existing.invoiceId, existing.voucherId);
      return { allocation: { id: allocationId, appliedAmount: new Prisma.Decimal(updated.appliedAmount).toString(), appliedDate: updated.appliedDate }, invoiceId: existing.invoiceId, voucherId: existing.voucherId, newInvoiceStatus, newVoucherStatus: voucherRecalc.status, voucherAppliedAmount: voucherRecalc.totalAllocated.toString(), auditId };
    }, SERIALIZABLE_TX, { actorId: actorId || 'api', source: 'route:allocation:update', operation: 'update_allocation' }, error => Boolean(readActualDomainRefusal(error)));
    // Publish domain events after commit (best-effort, never fails business)
    publishAllocationEvents({
      prisma,
      invoiceId: data.invoiceId,
      voucherId: data.voucherId,
      newInvoiceStatus: data.newInvoiceStatus,
      newVoucherStatus: data.newVoucherStatus,
      appliedAmount: data.allocation.appliedAmount,
      voucherAppliedAmount: data.voucherAppliedAmount,
      auditId: data.auditId,
      actorId: actorId || 'api',
      // 金额调整不改付款方/客户，代付判定不会变化 → 无需重发事件（首次创建时已留痕）
      thirdPartyPayment: null,
    }).catch(() => { /* event publish failure must not fail business */ });
    // §10.3-1：核销金额调整后同步订单结案状态
    void syncOrderAutoSettlementByInvoice(prisma, data.invoiceId, { source: 'route:allocation:update', actorId });
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: toAllocationError(e, 'UPDATE_FAILED') };
  }
}

export interface DeleteAllocationData {
  deleted: boolean; id: string; invoiceId: string; voucherId: string;
  newInvoiceStatus: string; newVoucherStatus: string; voucherAppliedAmount: string; auditId: string;
}

/**
 * 核销操作后发布业务事件（best-effort，永不阻断业务主流程）。
 *
 * 触发规则（仅正向推进才发事件，回退不发布）：
 *   - newInvoiceStatus === 'Paid'           → PaymentReceived（发票全额收款）
 *   - newVoucherStatus === 'reconciled'      → AllocationReconciled（付款凭证全额核销）
 *   - thirdPartyPayment != null              → ThirdPartyPaymentDetected（第三方代付，L2 高危 3 号）
 *
 * 事件 payload 通过事后查询 invoice/voucher 详情进行富化（事务已提交，读取快照即可）。
 *
 * ⚠️ 已知局限（**记录在案，不是漏写**）：本函数只在 route 通道
 * （allocationMutationService.createAllocation / updateAllocation）的事务提交后被调用；
 * Agent 的 reconcileFlow / toolRuntime 直调 applyAllocation，不走这里，因此**不发**这三类
 * 事件（PaymentReceived / AllocationReconciled 早就是这个局限）。
 * 第三方代付的**承重留痕在 applyAllocation 的同事务审计行**（三条通道全覆盖），
 * 业务事件只是「可供订阅者消费」的加法，故此处沿用既有落点、不另开一条通道去补。
 */
export async function publishAllocationEvents(params: {
  prisma: PrismaClient;
  invoiceId: string;
  voucherId: string;
  newInvoiceStatus: string;
  newVoucherStatus: string;
  appliedAmount: string;
  voucherAppliedAmount: string;
  auditId: string;
  actorId: string;
  /** L2 高危 3 号：由 applyAllocation 判定并回传（避免此处重复检测 → 口径漂移） */
  thirdPartyPayment?: ThirdPartyPaymentDetection | null;
}): Promise<void> {
  const { prisma, invoiceId, voucherId, newInvoiceStatus, newVoucherStatus, appliedAmount, voucherAppliedAmount, auditId, actorId, thirdPartyPayment } = params;

  // 仅在正向推进时查询并发布（避免无谓 DB 读）
  const needPaymentReceived = newInvoiceStatus === 'Paid';
  const needAllocationReconciled = newVoucherStatus === 'reconciled';
  if (!needPaymentReceived && !needAllocationReconciled && !thirdPartyPayment) return;

  const [invoice, voucher] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { orderId: true, invoiceNumber: true, customerName: true, amount: true, currency: true, customerRelationId: true },
    }),
    prisma.paymentVoucher.findUnique({
      where: { id: voucherId },
      select: { voucherNumber: true, type: true, amount: true, currency: true, paymentMethod: true, paymentDate: true },
    }),
  ]);

  const orderId = invoice?.orderId || undefined;

  if (needPaymentReceived) {
    publishBusinessEvent({
      type: 'PaymentReceived',
      sourceEntityType: 'Invoice',
      sourceEntityId: invoiceId,
      orderId,
      payload: {
        invoiceId,
        invoiceNumber: invoice?.invoiceNumber,
        amount: invoice?.amount?.toString(),
        currency: invoice?.currency,
        customerName: invoice?.customerName,
        customerRelationId: invoice?.customerRelationId,
        voucherId,
        voucherNumber: voucher?.voucherNumber,
        appliedAmount,
      },
      actorId,
      transactionId: auditId,
    }).catch(() => { /* event publish failure must not fail business */ });
  }

  if (needAllocationReconciled) {
    publishBusinessEvent({
      type: 'AllocationReconciled',
      sourceEntityType: 'PaymentVoucher',
      sourceEntityId: voucherId,
      orderId,
      payload: {
        voucherId,
        voucherNumber: voucher?.voucherNumber,
        voucherType: voucher?.type,
        voucherAmount: voucher?.amount?.toString(),
        voucherCurrency: voucher?.currency,
        paymentMethod: voucher?.paymentMethod,
        paymentDate: voucher?.paymentDate,
        invoiceId,
        invoiceNumber: invoice?.invoiceNumber,
        appliedAmount,
        voucherAppliedAmount,
      },
      actorId,
      transactionId: auditId,
    }).catch(() => { /* event publish failure must not fail business */ });
  }

  // L2 高危 3 号：第三方代付 —— 允许但必须可见（口径：Kevin 2026-09-17 拍板）。
  // 承重留痕是 applyAllocation 内的同事务审计行；本事件供通知/联动订阅者消费。
  if (thirdPartyPayment) {
    publishBusinessEvent({
      type: 'ThirdPartyPaymentDetected',
      sourceEntityType: 'InvoiceAllocation',
      sourceEntityId: `${invoiceId}__${voucherId}`,
      orderId,
      payload: {
        allocationId: `${invoiceId}__${voucherId}`,
        invoiceId,
        invoiceNumber: invoice?.invoiceNumber,
        voucherId,
        voucherNumber: voucher?.voucherNumber,
        appliedAmount,
        basis: thirdPartyPayment.basis,
        payerRelationId: thirdPartyPayment.payerRelationId,
        payerName: thirdPartyPayment.payerName,
        invoiceCustomerRelationId: thirdPartyPayment.invoiceCustomerRelationId,
        invoiceCustomerName: thirdPartyPayment.invoiceCustomerName,
        note: thirdPartyPayment.message,
      },
      actorId,
      transactionId: auditId,
    }).catch(() => { /* event publish failure must not fail business */ });
  }
}

export async function deleteAllocation(params: {
  prisma: PrismaClient; allocationId: string; actorId?: string; actor?: TokenPayload | null; ip?: string | null;
}): Promise<AllocationMutationResult<DeleteAllocationData>> {
  const { prisma, allocationId, actorId, ip } = params;
  try {
    const data = await runAllocationAttempt(prisma, async (tx: any) => {
      const now = BigInt(Date.now());
      const existing = await tx.invoiceAllocation.findUnique({ where: { id: allocationId } });
      if (!existing) throw businessError('NOT_FOUND', 'allocation not found');
      {
        if (params.actor?.userId !== actorId) throw businessError('UNAUTHORIZED', '核销操作需要当前可信账号。');
        await requireFinanceAllocationAccess(tx, params.actor, existing.invoiceId, existing.voucherId);
      }
      const supplierClaim = await lockSupplierClaimInvoice(tx, existing.invoiceId);
      await assertNotCashRefundVoucher(tx, existing.voucherId);
      await tx.$queryRawUnsafe('SELECT id FROM "InvoiceAllocation" WHERE id = $1 FOR UPDATE', allocationId);
      const freshAllocation = await tx.invoiceAllocation.findUnique({ where: { id: allocationId } });
      if (!freshAllocation || freshAllocation.invoiceId !== existing.invoiceId || freshAllocation.voucherId !== existing.voucherId) throw businessError('CONFLICT', '核销记录已变化，请刷新后重试。');
      await tx.invoiceAllocation.delete({ where: { id: allocationId } });
      const newInvoiceStatus = await recalcInvoiceStatus(tx, existing.invoiceId);
      const updatedInvoice = await tx.invoice.update({ where: { id: existing.invoiceId }, data: { status: newInvoiceStatus, settlementDate: newInvoiceStatus === 'Paid' ? todayLocalKey() : null, updatedAt: now } });
      const voucherRecalc = await recalcVoucherStatus(tx, existing.voucherId);
      const updatedVoucher = await tx.paymentVoucher.update({ where: { id: existing.voucherId }, data: { status: voucherRecalc.status, appliedAmount: voucherRecalc.totalAllocated, updatedAt: now } });
      await syncInvoiceReferences(prisma, updatedInvoice, { source: 'allocation.delete' }, tx);
      await syncPaymentVoucherReferences(prisma, updatedVoucher, { source: 'allocation.delete' }, tx);
      await syncAllocationVoucherLinks(tx, existing.voucherId, { source: 'allocation.delete' });
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:allocation:delete',
        operation: 'delete_allocation', targetType: 'InvoiceAllocation', targetId: allocationId,
        before: { id: allocationId, invoiceId: existing.invoiceId, voucherId: existing.voucherId, appliedAmount: new Prisma.Decimal(existing.appliedAmount).toString() },
        after: { invoiceStatus: newInvoiceStatus, voucherStatus: voucherRecalc.status, voucherAppliedAmount: voucherRecalc.totalAllocated.toString() },
        ip: ip || null,
      });
      await invalidateSupplierClaimSettlement(tx, supplierClaim, { invoiceId: existing.invoiceId, triggerId: allocationId, actorId: actorId || 'api', operation: 'allocation.delete', ip });
      // W-A P0-1：核销删除后触发受影响订单的出运批次结算重算（同事务、失败不阻断，幂等）
      await notifyShipmentBatchSettlementRecalc(tx, { invoiceId: existing.invoiceId, source: 'route:allocation:delete' });
      // 修复1：核销删除（应收净额回升）→ 同事务重算客户 usedAmount（幂等收敛）
      if (updatedInvoice.type === 'Receivable' && updatedInvoice.customerRelationId) {
        await notifyCustomerCreditRecalc(tx, {
          relationId: updatedInvoice.customerRelationId,
          source: 'route:allocation:delete',
          triggerId: allocationId,
          triggerBy: actorId || 'api',
        });
      }
      await requireFinanceAllocationAccess(tx, params.actor, existing.invoiceId, existing.voucherId);
      return { deleted: true as const, id: allocationId, invoiceId: existing.invoiceId, voucherId: existing.voucherId, newInvoiceStatus, newVoucherStatus: voucherRecalc.status, voucherAppliedAmount: voucherRecalc.totalAllocated.toString(), auditId };
    }, SERIALIZABLE_TX, { actorId: actorId || 'api', source: 'route:allocation:delete', operation: 'delete_allocation' }, error => Boolean(readActualDomainRefusal(error)));
    // §10.3-1：撤销核销后同步订单结案状态（出现未结清应收 → 撤回自动结案）
    void syncOrderAutoSettlementByInvoice(prisma, data.invoiceId, { source: 'route:allocation:delete', actorId });
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: toAllocationError(e, 'DELETE_FAILED') };
  }
}
