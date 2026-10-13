import { lockSupplierClaimInvoice, invalidateSupplierClaimSettlement } from './supplierClaimSettlementGuard';
import { todayLocalKey } from '../shared/localDate';
import { Prisma } from '@prisma/client';
import { syncInvoiceReferences, syncPaymentVoucherReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { notifyShipmentBatchSettlementRecalc } from './shipmentBatchSettlementHook';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { syncOrderAutoSettlementByInvoice } from './orderAutoSettlement';
import {
  detectThirdPartyPayment,
  toThirdPartyPaymentAuditFields,
  type ThirdPartyPaymentDetection,
} from './thirdPartyPaymentGuard';
import { isSettledByApplied, settlementBasisOf } from '../shared/invoiceSettlementBasis';
import { assertNotCashRefundVoucher } from '../claims/claimCashRefundFact';
import { assertPaymentRequestPayableAllocation } from '../paymentRequests/paymentRequestPayableSource';

/**
 * task ERP-P1-payment-allocation-route-foundation: allocation 状态重算纯函数。
 *
 * Decimal-safe：用 Prisma.Decimal（非 Number()）累加，避免 IEEE 754 漂移。
 * 重算公式：
 *   - Invoice: totalApplied = Σ allocation.appliedAmount WHERE invoiceId
 *     totalApplied >= invoice.amount → 'Paid'
 *     totalApplied > 0              → 'PartiallyPaid'
 *     totalApplied == 0:
 *       当前 status 是 Paid/PartiallyPaid → 回退 'Issued'（核销全撤销）
 *       否则                              → 保持当前 status
 *   - Voucher: totalAllocated = Σ allocation.appliedAmount WHERE voucherId
 *     voucherAmount <= 0           → 'unreconciled'
 *     totalAllocated >= voucherAmount → 'reconciled'
 *     totalAllocated > 0              → 'partially_reconciled'
 *     else                            → 'unreconciled'
 */

export type TxLike = any;

// Only errors minted by the allocation checks below carry a public refusal.
type AllocationRefusal = Readonly<{ code: string; statusCode: number; message: string }>;
const allocationRefusals = new WeakMap<object, AllocationRefusal>();
const allocationRefusal = (message: string, fields: { code: string; statusCode: number }) => {
  const error = Object.assign(new Error(message), fields);
  allocationRefusals.set(error, Object.freeze({ code: fields.code, statusCode: fields.statusCode, message }));
  return error;
};
export const readAllocationRefusal = (error: unknown): AllocationRefusal | undefined =>
  typeof error === 'object' && error !== null ? allocationRefusals.get(error) : undefined;


/**
 * Σ 已核销额（Decimal-safe）—— 「一张票被核销了多少」的**单一真源**。
 *
 * 抽出来的原因：`recalcInvoiceStatus`（状态真源）与 `updateInvoice`（改金额守卫）
 * 必须用**同一份**汇总定义，否则两处口径一漂移就会出现
 * 「状态说已结清、守卫说还没收够」这类僵尸票。改口径只改这里。
 *
 * ★ 2026-09-18（A3 少收销账）：汇总 = **收款核销（InvoiceAllocation）+ 贷项票抵扣（CreditNoteAllocation）**。
 *   此前只算收款 ⇒ 贷项票把票抵平时发票仍挂在 PartiallyPaid → 永久逾期 → 账龄/催办/授信全被污染。
 *   ⚠️ 兼容性守卫：历史测试替身的 mock prisma 未必有 creditNoteAllocation 模型
 *   （真库经迁移后恒存在）—— 缺模型时退化读为空，不影响真库口径。
 */
export async function sumAppliedAmount(tx: TxLike, invoiceId: string): Promise<Prisma.Decimal> {
  const allocs = await tx.invoiceAllocation.findMany({
    where: { invoiceId },
    select: { appliedAmount: true },
  });
  let total = new Prisma.Decimal(0);
  for (const a of allocs) {
    total = total.plus(a.appliedAmount);
  }
  if (tx.creditNoteAllocation?.findMany) {
    const cnAllocs = await tx.creditNoteAllocation.findMany({
      where: { invoiceId },
      select: { appliedAmount: true },
    });
    for (const a of cnAllocs) {
      total = total.plus(a.appliedAmount);
    }
  }
  return total;
}

/**
 * 重算单个 invoice 的 status（基于其所有 InvoiceAllocation 汇总）。
 * 返回新 status（totalApplied==0 时若当前 Paid/PartiallyPaid 回退 Issued，否则保持）。
 */
export async function recalcInvoiceStatus(tx: TxLike, invoiceId: string): Promise<string> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, amount: true, status: true },
  });
  if (!invoice) return 'Draft'; // 不存在默认 Draft

  const total = await sumAppliedAmount(tx, invoiceId);
  const invoiceAmount = new Prisma.Decimal(invoice.amount);

  // ★ 结清判据走真源 `shared/invoiceSettlementBasis`（面额 = |amount|）：
  //   原先内联的 `invoiceAmount.gt(0)` 对负额票（供应商索赔贷项 Payable）**恒假**
  //   ⇒ 核销到满也永远判不出 Paid，而发票状态是纯派生的 ⇒ 负额票永远挂在未结清应付（CLM S2）。
  if (isSettledByApplied(invoiceAmount, total)) return 'Paid';
  if (total.gt(0)) return 'PartiallyPaid';
  // totalApplied == 0: 若当前是 Paid/PartiallyPaid → 回退 Issued（核销全撤销）
  if (invoice.status === 'Paid' || invoice.status === 'PartiallyPaid') return 'Issued';
  return invoice.status; // Draft/Issued/Cancelled 保持
}

/**
 * 重算单个 voucher 的 status + 汇总 appliedAmount（基于其所有 InvoiceAllocation）。
 * 返回 { status, totalAllocated }——totalAllocated 用汇总值（非单笔）写 PaymentVoucher.appliedAmount。
 */
export async function recalcVoucherStatus(tx: TxLike, voucherId: string): Promise<{ status: string; totalAllocated: Prisma.Decimal }> {
  const voucher = await tx.paymentVoucher.findUnique({
    where: { id: voucherId },
    select: { id: true, amount: true },
  });
  if (!voucher) return { status: 'unreconciled', totalAllocated: new Prisma.Decimal(0) };

  const allocs = await tx.invoiceAllocation.findMany({
    where: { voucherId },
    select: { appliedAmount: true },
  });

  let total = new Prisma.Decimal(0);
  for (const a of allocs) {
    total = total.plus(a.appliedAmount);
  }
  const voucherAmount = new Prisma.Decimal(voucher.amount);

  if (voucherAmount.lte(0)) return { status: 'unreconciled', totalAllocated: total };
  if (total.gte(voucherAmount)) return { status: 'reconciled', totalAllocated: total };
  if (total.gt(0)) return { status: 'partially_reconciled', totalAllocated: total };
  return { status: 'unreconciled', totalAllocated: total };
}

/**
 * 验证 allocation 输入合法性（fail closed 稳定错误码）。
 */
export interface AllocationValidation {
  ok: boolean;
  error?: string;
  message?: string;
}

export function isValidAllocationDecimal(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
    try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
  }
  return false;
}

export function validateAllocationInput(input: {
  invoiceId?: string;
  voucherId?: string;
  appliedAmount?: any;
}): AllocationValidation {
  const { invoiceId, voucherId, appliedAmount } = input;
  if (!invoiceId) return { ok: false, error: 'MISSING_INVOICE', message: 'invoiceId is required' };
  if (!voucherId) return { ok: false, error: 'MISSING_VOUCHER', message: 'voucherId is required' };
  if (appliedAmount == null) return { ok: false, error: 'MISSING_AMOUNT', message: 'appliedAmount is required' };

  if (!isValidAllocationDecimal(appliedAmount)) return { ok: false, error: 'INVALID_AMOUNT', message: 'appliedAmount must be a valid decimal' };
  try { if (new Prisma.Decimal(appliedAmount).lte(0)) return { ok: false, error: 'INVALID_AMOUNT', message: 'appliedAmount must be positive' }; } catch { return { ok: false, error: 'INVALID_AMOUNT', message: 'appliedAmount must be a valid decimal' }; }

  return { ok: true };
}

/**
 * W4 Agent 工具收尾：核销明细列表只读查询（finance.query_allocations 的 service 真源）。
 *
 * 与 finance/route.ts GET /allocations 同一查询口径（invoiceId/voucherId 过滤 +
 * createdAt desc + take 上限 500）；路由同批改调本函数，保持单一真源不漂移。
 * 只读：不写库、不触发状态重算。
 */
export async function listInvoiceAllocations(
  prisma: { invoiceAllocation: { findMany: (args: any) => Promise<any[]> } },
  params: { invoiceId?: string; voucherId?: string; limit?: number } = {},
): Promise<{ items: any[]; total: number }> {
  const where: any = {};
  if (params.invoiceId) where.invoiceId = params.invoiceId;
  if (params.voucherId) where.voucherId = params.voucherId;
  const items = await prisma.invoiceAllocation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(params.limit ?? 200, 500),
  });
  return { items, total: items.length };
}

/**
 * task 阻断3 fix: allocation-aware EntityLink sync。
 *
 * 基于 InvoiceAllocation 当前 rows 维护 paymentVoucher → invoice 的 settlesInvoice links：
 *   - 当前 allocation 对应的 (voucherId, invoiceId) 对 → upsert active link
 *   - 不在当前 allocation 中但曾存在的 settlesInvoice link → 置 inactive（deletedAt）
 *
 * 这样 split voucher（多张 invoice）/delete allocation 时 EntityLink 与事实源一致。
 */
export async function syncAllocationVoucherLinks(
  tx: TxLike,
  voucherId: string,
  options: { source: string; now?: () => number } = { source: 'manual' },
): Promise<void> {
  if (!voucherId) return;
  const now = options.now?.() ?? Date.now();

  // 当前 allocation rows → 目标 invoice 集合
  const allocs = await tx.invoiceAllocation.findMany({
    where: { voucherId },
    select: { invoiceId: true, appliedAmount: true },
  });
  const activeInvoiceIds = new Set(allocs.map((a: any) => a.invoiceId));

  // upsert active link for each current allocation
  for (const a of allocs) {
    const referenceId = `REF__paymentVoucher__${voucherId}__invoiceId__invoice__${a.invoiceId}`;
    const linkId = `LINK__paymentVoucher__${voucherId}__settlesInvoice__invoice__${a.invoiceId}`;
    const snapshot = { invoiceId: a.invoiceId, fieldKey: 'invoiceId', appliedAmount: new Prisma.Decimal(a.appliedAmount).toString() };

    await tx.entityReference.upsert({
      where: { id: referenceId },
      update: { snapshot, confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: referenceId, ownerType: 'paymentVoucher', ownerId: voucherId, fieldKey: 'invoiceId',
        targetType: 'invoice', targetId: a.invoiceId,
        snapshot, confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    });
    await tx.entityLink.upsert({
      where: { id: linkId },
      update: { confidence: 1, source: options.source, status: 'active', updatedAt: BigInt(now), deletedAt: null },
      create: {
        id: linkId, fromType: 'paymentVoucher', fromId: voucherId,
        toType: 'invoice', toId: a.invoiceId, linkKind: 'settlesInvoice',
        confidence: 1, source: options.source, status: 'active',
        createdAt: BigInt(now), updatedAt: BigInt(now),
      },
    });
  }

  // 停用不再属于当前 allocation 的 settlesInvoice link
  // 查找该 voucher 所有 settlesInvoice link（可能含已 inactive）
  const existingLinks = await tx.entityLink.findMany({
    where: { fromType: 'paymentVoucher', fromId: voucherId, linkKind: 'settlesInvoice' },
    select: { id: true, toId: true, status: true },
  });
  for (const link of existingLinks) {
    if (!activeInvoiceIds.has(link.toId) && link.status === 'active') {
      await tx.entityLink.update({
        where: { id: link.id },
        data: { status: 'inactive', updatedAt: BigInt(now), deletedAt: BigInt(now) },
      });
    }
  }
}

/**
 * task Agent-P1: route + Agent 共用的 allocation mutation service。
 *
 * 封装完整事务闭环：validate + upsert allocation + recalc invoice/voucher status +
 * syncInvoiceReferences + syncPaymentVoucherReferences + syncAllocationVoucherLinks +
 * writeRouteAuditLog。route POST 和 Agent commitPaymentReceiveAndReconcile 都调本函数，
 * 确保 EntityReference/settlesInvoice link/audit 与 route path 一致，不漂移。
 *
 * @param prisma PrismaClient（用于 syncInvoiceReferences/syncPaymentVoucherReferences 读快照）
 * @param tx 已开的事务 client
 * @param params { invoiceId, voucherId, appliedAmount, appliedDate?, actorId, source, auditOperation }
 */
/** The same current balance/direction contract applies to create AND PATCH. */
export async function assertAllocationFacts(tx: any, invoiceId: string, voucherId: string, appliedAmount: string) {
  const appliedAmountDecimal = new Prisma.Decimal(appliedAmount);
  const appliedAmountStr = appliedAmountDecimal.toString();
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, deletedAt: true, status: true, type: true, currency: true, amount: true, customerRelationId: true, customerName: true } });
  if (!invoice || invoice.deletedAt) throw allocationRefusal('发票不存在或已删除，请重新选择来源单据。', { code: 'INVOICE_NOT_FOUND', statusCode: 404 });
  if (invoice.status === 'Cancelled' || invoice.status === 'Draft') {
    throw allocationRefusal(`invoice ${invoiceId} status ${invoice.status} does not allow allocation`, { code: 'INVALID_INVOICE_STATUS', statusCode: 400 });
  }
  const voucher = await tx.paymentVoucher.findUnique({ where: { id: voucherId }, select: { id: true, deletedAt: true, status: true, type: true, currency: true, amount: true, customerRelationId: true, customerName: true, attachments: true } });
  if (!voucher || voucher.deletedAt) throw allocationRefusal('收付款凭证不存在或已删除，请重新选择来源凭证。', { code: 'VOUCHER_NOT_FOUND', statusCode: 404 });
  if (voucher.status === 'cancelled' || voucher.status === 'void') {
    throw allocationRefusal(`voucher ${voucherId} status ${voucher.status} does not allow allocation`, { code: 'INVALID_VOUCHER_STATUS', statusCode: 400 });
  }
  // Payable invoices and disbursement vouchers settle the same supplier's
  // account. Relation IDs are the identity source; names are display data and
  // must never be used to bridge missing or different supplier relations.
  // Receivable allocations intentionally keep their existing third-party
  // payer behavior (e.g. a parent company paying for a customer).
  if (invoice.type === 'Payable') {
    if (!invoice.customerRelationId || !voucher.customerRelationId) {
      throw allocationRefusal('应付发票或付款凭证缺少供应商档案关联，无法核销；请先补齐供应商档案后重试。', {
        code: 'PAYABLE_SUPPLIER_IDENTITY_REQUIRED', statusCode: 409,
      });
    }
    if (invoice.customerRelationId !== voucher.customerRelationId) {
      throw allocationRefusal('应付发票与付款凭证关联的供应商不同，不能相互核销；请核对供应商档案。', {
        code: 'PAYABLE_SUPPLIER_MISMATCH', statusCode: 409,
      });
    }
  }
  // 币种一致性校验
  if (invoice.currency !== voucher.currency) {
    throw allocationRefusal(`currency mismatch: invoice ${invoice.currency} vs voucher ${voucher.currency}`, { code: 'CURRENCY_MISMATCH', statusCode: 400 });
  }
  // 金额不超限校验：核销金额不能超过发票金额、不能超过凭证金额
  const invoiceAmount = new Prisma.Decimal(invoice.amount);
  const expectedVoucherType = invoice.type === 'Receivable'
    ? (invoiceAmount.isNegative() ? 'Disbursement' : 'Receipt')
    : invoice.type === 'Payable' ? (invoiceAmount.isNegative() ? 'Receipt' : 'Disbursement') : null;
  if (!expectedVoucherType || voucher.type !== expectedVoucherType) {
    throw allocationRefusal('发票应收应付方向与实际收付款凭证不一致，请核对原单据。', {
      code: 'ALLOCATION_DIRECTION_MISMATCH', statusCode: 409,
    });
  }
  // ★ 面额 = |amount|（真源 `shared/invoiceSettlementBasis`）：负额票若拿负数当面额，
  //   任何正数核销都会撞「超出票面」⇒ 负额票根本核销不进去（CLM S6 无结清路径）。
  const invoiceBasis = settlementBasisOf(invoiceAmount);
  if (appliedAmountDecimal.gt(invoiceBasis)) {
    throw allocationRefusal(`appliedAmount ${appliedAmountStr} exceeds invoice amount ${invoiceBasis.toString()}`, { code: 'AMOUNT_EXCEEDS_INVOICE', statusCode: 400 });
  }
  const voucherAmount = new Prisma.Decimal(voucher.amount);
  if (appliedAmountDecimal.gt(voucherAmount)) {
    throw allocationRefusal(`appliedAmount ${appliedAmountStr} exceeds voucher amount ${voucherAmount.toString()}`, { code: 'AMOUNT_EXCEEDS_VOUCHER', statusCode: 400 });
  }
  // 检查发票剩余可核销金额（已有 allocation 汇总）
  // ★ 2026-09-18（A3）：贷项票抵扣（CreditNoteAllocation）同样占用发票剩余额 ——
  //   否则 CN 抵了一半后再来一笔收款，收款核销可把「票面 − 已收」全部核掉 ⇒ 发票被超额结清。
  //   mock 兼容守卫同 sumAppliedAmount（历史测试替身未必有该模型）。
  const existingAllocs = await tx.invoiceAllocation.findMany({ where: { invoiceId }, select: { appliedAmount: true, voucherId: true } });
  try {
    await assertPaymentRequestPayableAllocation(tx, { voucher, invoiceId, appliedAmount: appliedAmountStr, invoiceAllocations: existingAllocs });
  } catch (error: any) {
    if (error?.code === 'PAYMENT_REQUEST_AP_CHANGED' && error?.statusCode === 409)
      throw allocationRefusal(error.message, { code: 'CONFLICT', statusCode: 409 });
    throw error;
  }
  let alreadyAllocated = existingAllocs.filter((a: any) => a.voucherId !== voucherId).reduce((sum: any, a: any) => sum.plus(new Prisma.Decimal(a.appliedAmount)), new Prisma.Decimal(0));
  if (tx.creditNoteAllocation?.findMany) {
    const cnAllocs = await tx.creditNoteAllocation.findMany({ where: { invoiceId }, select: { appliedAmount: true } });
    for (const a of cnAllocs) alreadyAllocated = alreadyAllocated.plus(new Prisma.Decimal(a.appliedAmount));
  }
  // ★ 剩余可核销同样基于 basis（|amount|），否则负额票的剩余额恒为负 ⇒ 任何核销都判超额。
  const remainingInvoice = invoiceBasis.minus(alreadyAllocated);
  if (appliedAmountDecimal.gt(remainingInvoice)) {
    throw allocationRefusal(`appliedAmount ${appliedAmountStr} exceeds invoice remaining ${remainingInvoice.toString()}`, { code: 'AMOUNT_EXCEEDS_INVOICE_REMAINING', statusCode: 400 });
  }
  // 检查凭证剩余可分配金额
  const existingVoucherAllocs = await tx.invoiceAllocation.findMany({ where: { voucherId }, select: { appliedAmount: true, invoiceId: true } });
  const alreadyVoucherAllocated = existingVoucherAllocs.filter((a: any) => a.invoiceId !== invoiceId).reduce((sum: any, a: any) => sum.plus(new Prisma.Decimal(a.appliedAmount)), new Prisma.Decimal(0));
  const remainingVoucher = voucherAmount.minus(alreadyVoucherAllocated);
  if (appliedAmountDecimal.gt(remainingVoucher)) {
    throw allocationRefusal(`appliedAmount ${appliedAmountStr} exceeds voucher remaining ${remainingVoucher.toString()}`, { code: 'AMOUNT_EXCEEDS_VOUCHER_REMAINING', statusCode: 400 });
  }

  return { invoice, voucher };
}

export async function applyAllocation(
  prisma: any,
  tx: any,
  params: {
    invoiceId: string;
    voucherId: string;
    appliedAmount: string | number;
    appliedDate?: string;
    actorId: string;
    source: string;
    auditOperation?: string;
  },
): Promise<{
  allocationId: string;
  newInvoiceStatus: string;
  newVoucherStatus: string;
  voucherAppliedAmount: Prisma.Decimal;
  auditId: string;
  /**
   * L2 高危 3 号：本次核销是否判定为「第三方代付」（实际付款方 ≠ 合同客户）。
   * 仅作**留痕/提示**用，**不阻断**；调用方可在事务提交后据此发业务事件。
   * 判定真源：./thirdPartyPaymentGuard（零依赖纯函数，前后端共用）。
   */
  thirdPartyPayment: ThirdPartyPaymentDetection | null;
}> {
  const { invoiceId, voucherId, actorId, source } = params;
  // The same FK gate protects HTTP wrappers, Agent and proposal producers.
  // Customer cash settlement is already recorded in its immutable CN event;
  // applying the payout voucher again would manufacture a second money outlet.
  // Every caller, including Agent callers using READ COMMITTED, serializes on
  // the invoice before reading its remaining balance. Voucher locking follows
  // this same order; two receipts cannot both consume the same invoice balance.
  const supplierClaim = await lockSupplierClaimInvoice(tx, invoiceId);
  await assertNotCashRefundVoucher(tx, voucherId);
  const appliedAmountDecimal = new Prisma.Decimal(params.appliedAmount);
  const appliedAmountStr = appliedAmountDecimal.toString();
  const appliedDate = params.appliedDate || todayLocalKey();
  const now = BigInt(Date.now());
  const createAllocationId = `ALLOC__${invoiceId}__${voucherId}`;

  // 1. 校验 invoice/voucher 存在（未删）+ 状态 + 币种 + 金额
  // ⚠️ select 必须带 `customerName`：第三方代付判定（step 5b）在**双方都无客户档案**时
  //    退化为比名称，少了这个字段 → invoiceCustomerName 恒为空 → 判定恒 null →
  //    「名称兜底」分支在生产里**永不触发**，而单测因为 mock 不看 select 而全绿。
  //    （2026-09-17 真库演练 T7 抓到；修法之外还给 ledger 测试的 mock 加了「尊重 select」投影。）
  const { invoice, voucher } = await assertAllocationFacts(tx, invoiceId, voucherId, appliedAmountStr);

  // 2. upsert allocation（Decimal-safe 写入）
  const savedAllocation = await tx.invoiceAllocation.upsert({
    where: { invoiceId_voucherId: { invoiceId, voucherId } },
    update: { appliedAmount: appliedAmountDecimal, appliedDate, updatedAt: now },
    create: { id: createAllocationId, invoiceId, voucherId, appliedAmount: appliedAmountDecimal, appliedDate, createdAt: now, updatedAt: now },
  });
  // A migrated row may have a different primary key. Audit and return the
  // persisted identity, which upsert preserves, rather than inventing a new ID.
  const allocId = savedAllocation.id;

  // 3. recalc invoice/voucher status（Decimal-safe 纯函数）
  const newInvoiceStatus = await recalcInvoiceStatus(tx, invoiceId);
  // 发票全额结清时自动写入 settlementDate（实际结算日期）
  const invoiceUpdateData: any = { status: newInvoiceStatus, updatedAt: now, settlementDate: newInvoiceStatus === 'Paid' ? todayLocalKey() : null };
  const updatedInvoice = await tx.invoice.update({ where: { id: invoiceId }, data: invoiceUpdateData });
  const voucherRecalc = await recalcVoucherStatus(tx, voucherId);
  const updatedVoucher = await tx.paymentVoucher.update({
    where: { id: voucherId },
    data: { status: voucherRecalc.status, appliedAmount: voucherRecalc.totalAllocated, invoiceId, updatedAt: now },
  });

  // 4. 完整 sync 集（与 route POST 一致）——EntityReference + settlesInvoice link
  await syncInvoiceReferences(prisma, updatedInvoice, { source }, tx);
  await syncPaymentVoucherReferences(prisma, updatedVoucher, { source }, tx);
  await syncAllocationVoucherLinks(tx, voucherId, { source });

  // 5. audit（事务内闭环）——audit 展示金额用 toString，避免 IEEE 754 截断
  const auditId = await writeRouteAuditLog({
    prisma: tx, actorId, source,
    operation: params.auditOperation || 'create_allocation',
    targetType: 'InvoiceAllocation', targetId: allocId,
    after: { id: allocId, invoiceId, voucherId, appliedAmount: appliedAmountStr, invoiceStatus: newInvoiceStatus, voucherStatus: voucherRecalc.status, voucherAppliedAmount: voucherRecalc.totalAllocated.toString() },
  });

  // 5b. L2 高危 3 号：第三方代付「允许 + 留痕」（Kevin 2026-09-17 口径）。
  //     实际付款方（voucher.customerRelationId，DR-016 = 实际打款人）≠ 合同客户
  //     （invoice.customerRelationId）时**不阻断**（母公司代付/货代代付/境外关联方付汇
  //     都是真实业务，硬拦会卡死业务员认领），但必须**留痕** —— 否则「A 替 B 付」
  //     在账上完全看不见，对账/审计时无从追查。
  //     落点选在本内核（而非各调用方）：本函数是 route POST /allocations、
  //     Agent reconcileFlow、Agent toolRuntime 三条通道的共用内核；挂外层会重演
  //     「收口点错位」（副作用只挂在其中一条通道 → 另两条静默少做一步）。
  //     留痕写在同一事务内 → 与核销同生共死，且三通道全覆盖。
  const thirdPartyPayment = detectThirdPartyPayment(voucher, invoice);
  if (thirdPartyPayment) {
    await writeRouteAuditLog({
      prisma: tx, actorId, source,
      operation: 'third_party_payment_detected',
      operationType: 'link',
      targetType: 'InvoiceAllocation', targetId: allocId,
      after: {
        allocationId: allocId,
        invoiceId, voucherId,
        appliedAmount: appliedAmountStr,
        ...toThirdPartyPaymentAuditFields(thirdPartyPayment),
      },
    });
  }

  await invalidateSupplierClaimSettlement(tx, supplierClaim, { invoiceId, triggerId: allocId, actorId, operation: source });

  // 6. W-A P0-1：核销创建/替换后触发受影响订单的出运批次结算重算（同事务、失败不阻断，幂等）
  await notifyShipmentBatchSettlementRecalc(tx, { invoiceId, source });

  // 7. 修复1：核销改变应收净额 → 同事务重算客户 usedAmount + append CreditLimitHistory
  //    （route POST /allocations、Agent reconcileFlow、toolRuntime 均经本函数收口）
  if (invoice.type === 'Receivable' && invoice.customerRelationId) {
    await notifyCustomerCreditRecalc(tx, {
      relationId: invoice.customerRelationId,
      source,
      triggerId: allocId,
      triggerBy: actorId,
    });
  }

  // 8. §10.3-1：核销可能让订单应收全部结清 → 同事务同步「订单自动结案 / 撤回」。
  //    收口在本函数（而非各调用方）：本函数是 route POST /allocations、
  //    Agent reconcileFlow、toolRuntime 三条通道的共用内核；此前只有 route 的
  //    createAllocation 在事务外补调过一次，Agent 通道核销后订单永不结案（静默不一致）。
  //    失败不阻断（内部全量 catch + 幂等收敛）。
  await syncOrderAutoSettlementByInvoice(tx as any, invoiceId, { source, actorId });

  return {
    allocationId: allocId,
    newInvoiceStatus,
    newVoucherStatus: voucherRecalc.status,
    voucherAppliedAmount: voucherRecalc.totalAllocated,
    auditId,
    thirdPartyPayment,
  };
}
