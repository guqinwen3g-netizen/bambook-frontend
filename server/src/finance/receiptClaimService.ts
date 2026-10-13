/**
 * 收款匹配与财务确认：读取可见的未核销收款、选择发票和金额。
 * claim 立即写核销，HTTP 入口必须持有 invoices:reconcile；销售只能查看匹配。
 * 第三方代付、币种、余额及可见范围校验仍由原核销服务执行。
 */

import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { appendReceiptAllocation } from './allocationMutationService';
import { createNotificationService } from '../notifications/notificationService';
import { logger } from '../lib/logger';
import { detectThirdPartyPayment, type ThirdPartyPaymentDetection } from './thirdPartyPaymentGuard';
// ★ 口径 E3：未结清应收判据的**唯一真源**（状态集合 + 金额守卫），不手写
import { RECEIVABLE_OPEN_STATUSES, hasOpenAmount } from '../shared/openReceivable';

export type ReceiptClaimCode =
  | 'VOUCHER_NOT_FOUND' | 'INVOICE_NOT_FOUND' | 'NOT_A_RECEIPT' | 'NOT_RECEIVABLE'
  | 'VOUCHER_RECONCILED' | 'INVOICE_NOT_CLAIMABLE' | 'INVOICE_NOT_VISIBLE'
  | 'CURRENCY_MISMATCH' | 'AMOUNT_EXCEEDED' | 'INVALID_AMOUNT'
  | 'CONFLICT' | 'CLAIM_FAILED' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'ACCOUNT_DISABLED' | 'AUTHORIZATION_UNAVAILABLE';

export interface ReceiptClaimError { code: ReceiptClaimCode; message: string }
export interface ReceiptClaimResult<T = unknown> { ok: boolean; data?: T; error?: ReceiptClaimError }

const fail = <T>(code: ReceiptClaimCode, message: string): ReceiptClaimResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ReceiptClaimResult<T> => ({ ok: true, data });

type ReceiptClaimRefusal = Readonly<{ code: ReceiptClaimCode; statusCode: number; message: string }>;
const receiptClaimRefusals = new WeakMap<object, ReceiptClaimRefusal>();
export const readReceiptClaimRefusal = (error: unknown): ReceiptClaimRefusal | undefined =>
  typeof error === 'object' && error !== null ? receiptClaimRefusals.get(error) : undefined;
function receiptClaimRefusal(code: ReceiptClaimCode, message: string, statusCode: number): Error {
  const error = Object.assign(new Error(message), { claimCode: code, code, statusCode });
  receiptClaimRefusals.set(error, Object.freeze({ code, message, statusCode }));
  return error;
}


/**
 * 可做认领目标的发票状态 —— ★ 收口到**唯一真源**（口径 E3，2026-09-17）。
 *
 * 原先本地手写 `new Set(['Issued','PartiallyPaid'])`，与真源 `RECEIVABLE_OPEN_STATUSES` 同值但**各写一份**
 * ⇒ 真源演化时会漂移。真源文件头明确要求：「新增按未结清应收筛选发票的代码**必须**用本模块」。
 */
const CLAIMABLE_INVOICE_STATUSES: ReadonlySet<string> = new Set(RECEIVABLE_OPEN_STATUSES);

const n = (v: any): number => (v == null ? 0 : Number(v));

/**
 * 待认领收款列表：未核销完的收款凭证，且挂在**业务员可见客户**名下。
 *
 * 未挂客户（customerRelationId 为空）的收款**不下发**给业务员——否则会把别家的收款
 * 金额暴露给全体业务员；这类由财务补挂客户后再开放认领（已登记为设计选择）。
 */
export async function listClaimableReceipts(
  prisma: PrismaClient,
  params: { visibleOrderIds: string[] | null; limit?: number },
): Promise<ReceiptClaimResult<Array<{
  voucherId: string; voucherNumber: string; paymentDate: string; currency: string;
  amount: number; unapplied: number; customerRelationId: string | null; customerName: string | null;
}>>> {
  const visibleOrderIds = params.visibleOrderIds;
  const limit = params.limit ?? 50;
  const db = prisma as any;

  // 可见客户集：由可见订单反推（与发票/收款的客户维度对齐）
  let visibleRelationIds: string[] | null = null;
  if (visibleOrderIds) {
    if (visibleOrderIds.length === 0) return ok([]);
    const orders = await db.order.findMany({
      where: { id: { in: visibleOrderIds } },
      select: { customerRelationId: true },
    });
    visibleRelationIds = Array.from(new Set(orders.map((o: any) => o.customerRelationId).filter(Boolean)));
    if (visibleRelationIds.length === 0) return ok([]);
  }

  const vouchers = await db.paymentVoucher.findMany({
    where: {
      type: 'Receipt',
      // A real bank return is already consumed by its CN recovery event.
      cashRefundReturnReceipt: { is: null },
      deletedAt: null,
      status: { in: ['unreconciled', 'partially_reconciled'] },
      ...(visibleRelationIds ? { customerRelationId: { in: visibleRelationIds } } : {}),
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(limit, 1), 200),
  });

  const allocations = await db.invoiceAllocation.findMany({
    where: { voucherId: { in: vouchers.map((v: any) => v.id) } },
    select: { voucherId: true, appliedAmount: true },
  });
  const appliedBy = new Map<string, number>();
  for (const a of allocations as any[]) {
    appliedBy.set(a.voucherId, (appliedBy.get(a.voucherId) ?? 0) + n(a.appliedAmount));
  }

  const items = (vouchers as any[])
    .map(v => ({
      voucherId: v.id,
      voucherNumber: v.voucherNumber,
      paymentDate: v.paymentDate,
      currency: v.currency,
      amount: n(v.amount),
      unapplied: Math.max(0, n(v.amount) - (appliedBy.get(v.id) ?? 0)),
      customerRelationId: v.customerRelationId ?? null,
      customerName: v.customerName ?? null,
    }))
    .filter(v => v.unapplied > 0);

  return ok(items);
}

/**
 * 认领：把一笔收款核销到指定应收发票（业务员通道）。
 * 落库复用 `createAllocation`（Serializable 事务 + 审计 + 状态重算 + 事件）。
 */
export async function claimReceipt(
  prisma: PrismaClient,
  params: {
    voucherId: string;
    invoiceId: string;
    amount: number;
    actorId: string;
    actor?: TokenPayload | null;
    requestId: string;
    ip?: string | null;
    /** null = 数据范围不受限（领导/老板/财务）；数组 = 可见订单白名单 */
    visibleOrderIds: string[] | null;
  },
): Promise<ReceiptClaimResult<{ allocationId: string; newInvoiceStatus: string; newVoucherStatus: string }>> {
  const { voucherId, invoiceId, amount, actorId, ip, visibleOrderIds } = params;
  const db = prisma as any;

  if (!Number.isFinite(amount) || amount <= 0) return fail('INVALID_AMOUNT', '认领金额必须为正数');

  // Recheck current scope even on idempotent replay; permission changes must not expose old results.
  if (params.actor === undefined && visibleOrderIds !== null) {
    const scopedInvoice = await db.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
    const ids = await resolveInvoiceOrderIds(db, invoiceId, scopedInvoice?.orderId ?? null);
    if (!ids.some(id => visibleOrderIds.includes(id))) return fail('INVOICE_NOT_VISIBLE', '该发票不在你的可见范围内');
    const scopedVoucher = await db.paymentVoucher.findFirst({ where: { id: voucherId, deletedAt: null } });
    const orders = await db.order.findMany({ where: { id: { in: visibleOrderIds } }, select: { customerRelationId: true } });
    if (!scopedVoucher?.customerRelationId || !orders.some((o: any) => o.customerRelationId === scopedVoucher.customerRelationId)) return fail('VOUCHER_NOT_FOUND', '该收款不在你的可见范围内');
  }

  let voucher: any; let invoice: any; let thirdPartyPayment: ThirdPartyPaymentDetection | null = null;
  const reject = (claimCode: ReceiptClaimCode, message: string, statusCode = 409): never => { throw receiptClaimRefusal(claimCode, message, statusCode); };
  const res = await appendReceiptAllocation({
    prisma, voucherId, invoiceId, amount, actorId, actor: params.actor, requestId: params.requestId, ip,
    validate: async (db: any) => {
      voucher = await db.paymentVoucher.findFirst({ where: { id: voucherId, deletedAt: null } });
      if (!voucher) reject('VOUCHER_NOT_FOUND', `收款凭证 ${voucherId} 不存在`);
      if (voucher.type !== 'Receipt') reject('NOT_A_RECEIPT', '仅收款凭证（Receipt）可认领');
      if (voucher.status === 'reconciled') reject('VOUCHER_RECONCILED', '该收款已全额核销，无需认领');
      if (!['unreconciled', 'partially_reconciled'].includes(voucher.status)) reject('INVOICE_NOT_CLAIMABLE', '已作废或不可用收款不能核销');

      invoice = await db.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
      if (!invoice) reject('INVOICE_NOT_FOUND', `发票 ${invoiceId} 不存在`);
      if (invoice.type !== 'Receivable') reject('NOT_RECEIVABLE', '仅应收发票（Receivable）可认领');
      if (!CLAIMABLE_INVOICE_STATUSES.has(invoice.status)) {
        reject('INVOICE_NOT_CLAIMABLE', `发票状态为 ${invoice.status}，不可认领（仅 已开票/部分销账 可认领）`);
      }
      // ★ 口径 E3（2026-09-17 业务方拍板）：**0 元票不可认领**。
      //   理由：认领一个"没有金额可认领"的票语义上无意义（认领后剩余 = 0）。
      //   判据复用唯一真源 `hasOpenAmount`（**不手写**）—— 它同时覆盖两种情形：
      //     · `amount === 0`：0 元票（无金额可认领）
      //     · `amount < 0` ：负向贷项票（不是"可收的钱"，更不该被收款认领）
      //   见 docs/业务口径决策单-2026-09-17.md E3。
      if (!hasOpenAmount(invoice.amount)) {
        reject('INVOICE_NOT_CLAIMABLE', `发票金额为 ${n(invoice.amount)}，没有可认领的金额`);
      }

      // 业务员可见性：发票关联订单须在白名单内（与 §10.4.2 同口径，fail-closed）
      if (visibleOrderIds) {
        const linkedOrderIds = await resolveInvoiceOrderIds(db, invoiceId, invoice.orderId);
        const visible = linkedOrderIds.some(id => visibleOrderIds.includes(id));
        if (!visible) reject('INVOICE_NOT_VISIBLE', '该发票不在你的可见范围内');
      }

      // 第三方代付：**不阻断**，只判定 + 留痕（口径见文件头 ③）。
      // 判定结果同时用于：① 通知财务时点名；② 落库留痕由 createAllocation → applyAllocation
      // 在同一事务写审计行（`third_party_payment_detected`），此处不重复写。
      thirdPartyPayment = detectThirdPartyPayment(voucher, invoice);

      if (voucher.currency !== invoice.currency) {
        reject('CURRENCY_MISMATCH', `币种不一致（收款 ${voucher.currency} / 发票 ${invoice.currency}），不做自动换算`);
      }

      // 上限预校验（终判仍由 createAllocation 在 Serializable 事务内做——预校验只为早失败、友好报错）
      const allocs = await db.invoiceAllocation.findMany({
        where: { voucherId },
        select: { appliedAmount: true },
      });
      const voucherUnapplied = n(voucher.amount) - allocs.reduce((s: number, a: any) => s + n(a.appliedAmount), 0);
      const invAllocs = await db.invoiceAllocation.findMany({
        where: { invoiceId },
        select: { appliedAmount: true },
      });
      const credits = db.creditNoteAllocation?.findMany ? await db.creditNoteAllocation.findMany({ where: { invoiceId }, select: { appliedAmount: true } }) : [];
      const invoiceUnpaid = n(invoice.amount) - [...invAllocs, ...credits].reduce((s: number, a: any) => s + n(a.appliedAmount), 0);
      const cap = Math.min(voucherUnapplied, invoiceUnpaid);
      if (amount > cap + 1e-6) {
        reject('AMOUNT_EXCEEDED', `认领金额超出可认领上限 ${cap.toFixed(2)} ${invoice.currency}`);
      }

    },
  });
  if (!res.ok) {
    const code = (res.error?.code as ReceiptClaimCode) ?? 'CLAIM_FAILED';
    return fail(code, res.error?.message || '认领失败');
  }

  const data = res.data!;
  // 通知财务（§10.3-11）：认领需财务知悉以便复核；失败仅 warn，不阻断已落库的核销
  try {
    if (!data.replayed) await notifyFinanceOfClaim(prisma, {
      actorId,
      voucherNumber: voucher.voucherNumber,
      invoiceNumber: invoice.invoiceNumber,
      amount,
      currency: invoice.currency,
      thirdPartyPayment,
    });
  } catch {
    try { logger.warn('[ReceiptClaim] notify finance failed (claim already committed)'); } catch { /* Diagnostics cannot replace the committed claim ACK. */ }
  }

  return ok({
    allocationId: data.allocation.id,
    newInvoiceStatus: data.newInvoiceStatus,
    newVoucherStatus: data.newVoucherStatus,
  });
}

/** 发票关联订单（直挂 orderId ∪ InvoiceOrderAllocation 分摊）；无关联返回空数组 → 调用方 fail-closed */
export async function resolveInvoiceOrderIds(db: any, invoiceId: string, directOrderId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  if (directOrderId) ids.add(directOrderId);
  try {
    const ioas = await db.invoiceOrderAllocation.findMany({
      where: { invoiceId, deletedAt: null },
      select: { orderId: true },
    });
    for (const ioa of ioas as any[]) if (ioa.orderId) ids.add(ioa.orderId);
  } catch {
    /* 分摊表不可读 → 只用直挂 orderId（仍 fail-closed） */
  }
  return Array.from(ids);
}

/** 通知财务：认领事件（财务角色 + 老板；单播，不广播避免全员噪声） */
async function notifyFinanceOfClaim(
  prisma: PrismaClient,
  params: {
    actorId: string; voucherNumber: string; invoiceNumber: string; amount: number; currency: string;
    /** L2 高危 3 号：第三方代付时在文案里点名，让财务**重点复核**（放行不等于免检） */
    thirdPartyPayment?: ThirdPartyPaymentDetection | null;
  },
): Promise<void> {
  const db = prisma as any;
  const finance = await db.userRole.findMany({
    where: { roleId: { in: ['role-finance', 'role-admin', 'role-super-admin'] } },
    select: { userId: true },
  });
  const recipients = Array.from(new Set((finance as any[]).map(r => r.userId).filter(Boolean)));
  if (recipients.length === 0) return;

  const notifier = createNotificationService(prisma);
  const title = params.thirdPartyPayment ? '收款核销已确认（第三方代付）' : '收款核销已确认';
  const body = `财务已将收款 ${params.voucherNumber} 核销至发票 ${params.invoiceNumber}（${params.amount.toFixed(2)} ${params.currency}）。`
    + (params.thirdPartyPayment ? `【第三方代付】${params.thirdPartyPayment.message}` : '');
  for (const userId of recipients) {
    if (userId === params.actorId) continue; // 自己不扰
    await notifier.sendToUser({ userId, type: 'receipt_claimed', title, body } as any).catch(() => null);
  }
}
