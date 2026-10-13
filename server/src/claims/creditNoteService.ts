/**
 * creditNoteService.ts — 退款单（贷项通知单 Credit Note，CN）服务
 *
 * ════════════════════════════════════════════════════════════════════
 * 口径依据（业务方 2026-09-17 拍板）
 *   见 `docs/业务口径决策单-2026-09-17.md` **A2 · A3 · A5**
 *
 * ★ A2 —— **一张凭证 + 一次结算**（不是二选一）
 *   外贸实务的标准凭证就是 CN；ERP 行业（SAP Credit Memo · Odoo Credit Note ·
 *   NetSuite Credit Memo）做法一致：**CN 是独立单据 + 挂「未核销余额」**，
 *   余额可**抵扣下张发票**或**现金退款**，扣到 0 即结清。
 *   大白话：**CN 是"欠条"，抵扣/退款是"还钱"**。
 *
 * ★ A3 —— **独立状态**，**不复用发票的 `Paid`**
 *   现状卡死点：`recalcInvoiceStatus` 的 Paid 判据是 `amount.gt(0) && Σapplied ≥ amount`
 *   ⇒ `amount ≤ 0` 的票**永远到不了 Paid** ⇒ 永久挂在应收里污染账龄/逾期/信用额度。
 *   ⇒ 本服务用**自己的状态机**：Open → PartiallyApplied → Closed。
 *
 * ★ A5 —— **能撤销**（作废 + 留痕）
 *   ⚠️ 只允许作废**未核销（Open）**的单 —— 已核销的必须先反核销，
 *      否则「作废了但钱已经抵扣出去」会造成账实不符。反核销属二期（见实施方案）。
 * ════════════════════════════════════════════════════════════════════
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { todayLocalKey } from '../shared/localDate';
import { logger } from '../lib/logger';
import { recalcInvoiceStatus } from '../finance/allocationService';
import { syncOrderAutoSettlementByInvoice } from '../finance/orderAutoSettlement';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { ClaimTransactionError } from './claimApprovalFact';
import { assertClaimCreditNoteAccount, assertCreditNoteSettlementEvent, creditNoteBalanceStatus, creditNoteDigest, creditNoteEffectiveAmount, lockCreditNoteForSettlement } from './claimCreditNoteVersionService';
import { claimPage, ClaimVisibilityError } from './claimVisibility';

export type CreditNoteCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'OVER_APPLIED'
  | 'CURRENCY_MISMATCH';

export interface CreditNoteError { code: CreditNoteCode; message: string }
export interface CreditNoteResult<T = unknown> { ok: boolean; data?: T; error?: CreditNoteError }

const fail = <T>(code: CreditNoteCode, message: string): CreditNoteResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): CreditNoteResult<T> => ({ ok: true, data });

/** 未结清状态（可继续核销 / 可作废） */
export const CREDIT_NOTE_OPEN_STATUSES = ['Open', 'PartiallyApplied'] as const;

/**
 * ★ 余额 → 状态推进（**纯函数**，可单测、无 IO）。
 *
 * 这是 A3 的判据本体：**结清 = 余额为 0**，与发票的 `Paid` 完全解耦。
 * - 余额 ≤ 0 → `Closed`（已结清）
 * - 余额 > 0 且 < 原额 → `PartiallyApplied`（部分核销）
 * - 余额 = 原额 → `Open`（未核销）
 *
 * ⚠️ 用 Decimal 比较，**不用浮点**（金额用 IEEE 754 会漂移）。
 */
export function advanceCreditNoteStatus(amount: Prisma.Decimal | number | string, openAmount: Prisma.Decimal | number | string): string {
  return creditNoteBalanceStatus(amount, openAmount);
}

export interface CreateCreditNoteInput {
  /** 应退客户金额（**正数**） */
  amount: number | string;
  currency: string;
  customerRelationId?: string | null;
  customerName?: string | null;
  claimCaseId?: string | null;
  sourceInvoiceId?: string | null;
  issueDate?: string;
  reason?: string | null;
  notes?: string | null;
}

/**
 * 开一张退款单（CN）。
 *
 * 取号走 `nextBusinessNumber`（前缀 `CLM`，**已在册** —— 见实施方案 §六.1 的真库核查：
 * `Invoice` 内 `CLM-%` 为 0 行、`SEQ_CLM_2026` 已到 8 ⇒ 序列领先，新单从 0009 起不撞号）。
 */
export async function createCreditNote(
  prisma: PrismaClient,
  input: CreateCreditNoteInput,
  actorId: string,
  /**
   * ★ C7（2026-09-18）：可选外部事务。
   * 为什么需要：尾差销账要「开 CN + 立即抵扣」**同一事务**（半途失败不能留一张孤儿 CN）。
   * 默认行为完全不变（不传 = 自己开事务）。
   */
  opts: { tx?: any } = {},
): Promise<CreditNoteResult<{ creditNote: any }>> {
  // ★ v3.14（L-A）：不再 `?? 0` 后靠 `lte(0)` 兜 ⇒ "没填"与"填 0"分开报，且解析只在这里做一次
  const parsedAmount = parsePositiveDecimal(input.amount, '退款金额');
  // ★ 口径 A6：拒绝 0 元（0 元退款单本身无意义）
  if (!parsedAmount.ok) return fail('VALIDATION_FAILED', parsedAmount.message);
  const amount = new Prisma.Decimal(parsedAmount.value);
  if (amount.decimalPlaces() > 4 || amount.gte('100000000000000')) return fail('VALIDATION_FAILED', '退款金额须能按数据库金额精度完整保存（最多 4 位小数、14 位整数），不可隐式舍入');
  if (!input.currency) return fail('VALIDATION_FAILED', 'currency 必填');

  try {
    const runInTx = opts.tx ? async (fn: any) => fn(opts.tx) : (fn: any) => prisma.$transaction(fn);
    const creditNote = await runInTx(async (tx: any) => {
      const creditNoteNumber = await nextBusinessNumber(tx, 'CLM', undefined, {
        occupied: async (num) => {
          // ⚠️ **必须含软删行**：唯一约束在 DB 层不排除软删行，
          //   若这里加 deletedAt: null，软删的 CN 会被判「未占用」→ 生成同号 → P2002 → 整单失败。
          const dup = await tx.creditNote.findFirst({ where: { creditNoteNumber: num }, select: { id: true } });
          return dup != null;
        },
      });

      return tx.creditNote.create({
        data: {
          id: `CN_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          creditNoteNumber,
          customerRelationId: input.customerRelationId ?? null,
          customerName: input.customerName ?? null,
          claimCaseId: input.claimCaseId ?? null,
          sourceInvoiceId: input.sourceInvoiceId ?? null,
          currency: input.currency,
          amount,
          openAmount: amount, // ★ 开单即「未核销余额 = 原额」
          status: 'Open',
          issueDate: input.issueDate ?? todayLocalKey(),
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          createdAt: BigInt(Date.now()),
          updatedAt: BigInt(Date.now()),
        },
      });
    });

    return ok({ creditNote });
  } catch (e: any) {
    logger.error('[CreditNoteService] createCreditNote failed', { error: e?.message });
    // Shared claim/finance tx must roll back, including non-SQL faults after earlier writes.
    if (opts.tx) throw e;
    return fail('VALIDATION_FAILED', e?.message ?? '开单失败');
  }
}

export interface ApplyCreditNoteInput {
  /**
   * 核销金额（**正数**，不得超过未核销余额）。
   * ★ v3.14：类型放开到 `null | undefined` —— 因为"没填"要能被**区分**出来并拒掉，
   *   而原先调用方写 `req.body?.appliedAmount ?? 0`，一到手就把"没填"抹成"填了 0"（L-A 的形状）。
   */
  appliedAmount: number | string | null | undefined;
  /** 出口一：抵扣到某张发票 */
  toInvoiceId?: string | null;
  /** 出口二：现金退款（一期**暂不实现**，传了直接拒绝 —— 见实施方案 §六.2） */
  refund?: boolean;
  /** Stable intent identity; legacy callers without this field are not idempotent. */
  clientRequestId?: string;
}

/**
 * 核销退款单：扣减未核销余额 + 推进状态（口径 A2/A3）。
 *
 * ★ CN 自身状态机**不依赖**发票的 `Paid` —— 结清判据 = CN 余额为 0。
 *
 * ★★ 2026-09-18（A3 少收销账闭环）：出口一（抵扣发票 toInvoiceId）**必须同时落发票侧** ——
 *   此前只减 CN 余额 ⇒ 发票永久 `PartiallyPaid` + 永久逾期（账龄/催办/授信全被污染）。
 *   现在同一事务内：
 *     ① 写 `CreditNoteAllocation`（CN→发票 核销明细，同对 upsert 覆盖）；
 *     ② 经真源 `recalcInvoiceStatus`（其 sumAppliedAmount = 收款 + 折让）重算发票状态，
 *        全额抵平 → `Paid` + settlementDate，从「未结清应收」（openReceivable）退出；
 *     ③ 重算客户授信 usedAmount + 订单自动结案（与收款核销 applyAllocation 同闭环）。
 *   ⚠️ 折让**不写 InvoiceAllocation**：该表 voucherId 必填、语义=收款凭证（15+ 消费方按
 *      真金流水读它），伪造 voucherId 会把折让当成收进来的钱（静默错账）。
 *   出口二（现金退款）一期未实现，仍显式拒绝。
 */
export async function applyCreditNote(
  prisma: PrismaClient,
  noteId: string,
  input: ApplyCreditNoteInput,
  actorId: string,
  /** ★ C7：可选外部事务（同 createCreditNote；不传 = 自己开事务，行为不变） */
  opts: { tx?: any } = {},
): Promise<CreditNoteResult<{ creditNote: any; applied: string; settlementEvent?: any; replayed?: boolean }>> {
  const parsedApplied = parsePositiveDecimal(input.appliedAmount, '核销金额');
  if (!parsedApplied.ok) return fail('VALIDATION_FAILED', parsedApplied.message);
  const applied = new Prisma.Decimal(parsedApplied.value);
  if (applied.decimalPlaces() > 4 || applied.gte('100000000000000')) return fail('VALIDATION_FAILED', '核销金额须能按数据库金额精度完整保存（最多 4 位小数、14 位整数），不可隐式舍入');
  if (input.refund) {
    return fail('VALIDATION_FAILED', '现金退款出口一期暂未实现（见实施方案 §六.2）—— 请使用「抵扣发票」');
  }
  if (input.toInvoiceId && !String(input.toInvoiceId).trim()) {
    return fail('VALIDATION_FAILED', 'toInvoiceId 不能为空串');
  }

  if (input.clientRequestId != null && (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 200)) {
    return fail('VALIDATION_FAILED', 'clientRequestId 须为 1–200 字符的稳定请求标识');
  }
  const parameters = { appliedAmount: applied.toString(), toInvoiceId: input.toInvoiceId ?? null, refund: false };
  const parametersHash = creditNoteDigest(parameters);
  const reject = (code: CreditNoteCode, message: string): never => { throw new CreditNoteTransactionError({ code, message }); };
  const runInTx = opts.tx ? async (fn: any) => fn(opts.tx) : (fn: any) => prisma.$transaction(fn);
  try {
    return await runInTx(async (tx: any) => {
      const note = await lockCreditNoteForSettlement(tx, noteId);
      const account = await assertClaimCreditNoteAccount(tx, note);
      // The lock precedes the idempotency lookup: even a Closed account can
      // replay its own committed intent, but a changed actor/target/amount cannot.
      if (input.clientRequestId) {
        const event = await tx.creditNoteSettlementEvent.findUnique({ where: { creditNoteId_requestId: { creditNoteId: noteId, requestId: input.clientRequestId } } });
        if (event) {
          await assertCreditNoteSettlementEvent(tx, note, event);
          if (event.actorId !== actorId || event.parametersHash !== parametersHash) reject('INVALID_STATE', '同核销请求的主体、金额或目标发票不同，不可重放');
          return ok({ creditNote: note, applied: String(event.amount), settlementEvent: event, replayed: true });
        }
      }
      if (note.status === 'Cancelled') reject('INVALID_STATE', '该退款单已作废，不可核销');
      if (note.status === 'Closed') reject('INVALID_STATE', '该退款单已结清，无需再核销');
      const openAmount = new Prisma.Decimal(note.openAmount);
      if (applied.gt(openAmount)) reject('OVER_APPLIED', `核销金额 ${applied} 超过未核销余额 ${openAmount}`);
      if (account && applied.gt(account.availableToSettle)) reject('OVER_APPLIED', `抵扣金额 ${applied} 超过扣除现金退款预留后的可用余额 ${account.availableToSettle}`);
      // A balance reduction must have a real settlement destination. Cash is
      // still unsupported; no invoice must never silently burn customer credit.
      if (!input.toInvoiceId) reject('VALIDATION_FAILED', '抵扣须指定真实应收发票（toInvoiceId）');
      await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', input.toInvoiceId);
      const invoice = await tx.invoice.findUnique({ where: { id: input.toInvoiceId } });
      if (!invoice || invoice.deletedAt) reject('NOT_FOUND', `目标发票 ${input.toInvoiceId} 不存在`);
      if (invoice.type !== 'Receivable') reject('VALIDATION_FAILED', `贷项票只能抵扣应收票（目标发票 type=${invoice.type}）`);
      if (invoice.status === 'Draft' || invoice.status === 'Cancelled') reject('INVALID_STATE', `目标发票状态为 ${invoice.status}，不可抵扣`);
      if (invoice.currency !== note.currency) reject('CURRENCY_MISMATCH', `币种不一致：退款单 ${note.currency} vs 发票 ${invoice.currency}`);
      if (account && (!note.customerRelationId || invoice.customerRelationId !== note.customerRelationId)) reject('INVALID_STATE', '共案退款只能抵扣同一真实客户的应收发票，请核对客户关联');
      const [receiptAllocs, cnAllocs] = await Promise.all([
        tx.invoiceAllocation.findMany({ where: { invoiceId: invoice.id }, select: { appliedAmount: true } }),
        // Include this CN's own earlier offsets: they also consume invoice capacity.
        tx.creditNoteAllocation.findMany({ where: { invoiceId: invoice.id }, select: { appliedAmount: true } }),
      ]);
      const used = [...receiptAllocs, ...cnAllocs].reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.appliedAmount), new Prisma.Decimal(0));
      const remaining = new Prisma.Decimal(invoice.amount).minus(used);
      if (applied.gt(remaining)) reject('OVER_APPLIED', `抵扣金额 ${applied} 超过发票剩余可抵额 ${remaining}`);
      const now = BigInt(Date.now()), appliedDate = todayLocalKey();
      const nextOpen = openAmount.minus(applied);
      const nextStatus = advanceCreditNoteStatus(creditNoteEffectiveAmount(note), nextOpen);
      const event = await tx.creditNoteSettlementEvent.create({ data: {
        id: `CNSE_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        creditNoteId: noteId, kind: 'InvoiceOffset', amount: applied, currency: note.currency,
        invoiceId: invoice.id, actorId, requestId: input.clientRequestId ?? null,
        parameters, parametersHash, createdAt: now,
      } });
      const creditNote = await tx.creditNote.update({ where: { id: noteId }, data: {
        openAmount: nextOpen, status: nextStatus, appliedToInvoiceId: invoice.id, updatedAt: now,
      } });
      const allocId = `CNA__${noteId}__${invoice.id}`;
      const existingAlloc = await tx.creditNoteAllocation.findUnique({
        where: { creditNoteId_invoiceId: { creditNoteId: noteId, invoiceId: invoice.id } }, select: { appliedAmount: true },
      });
      const cumulative = existingAlloc ? new Prisma.Decimal(existingAlloc.appliedAmount).plus(applied) : applied;
      await tx.creditNoteAllocation.upsert({ where: { creditNoteId_invoiceId: { creditNoteId: noteId, invoiceId: invoice.id } },
        update: { appliedAmount: cumulative, appliedDate, updatedAt: now },
        create: { id: allocId, creditNoteId: noteId, invoiceId: invoice.id, appliedAmount: cumulative, appliedDate, createdAt: now, updatedAt: now },
      });
      const newInvoiceStatus = await recalcInvoiceStatus(tx, invoice.id);
      const updatedInvoice = await tx.invoice.update({ where: { id: invoice.id }, data: {
        status: newInvoiceStatus, updatedAt: now, ...(newInvoiceStatus === 'Paid' ? { settlementDate: appliedDate } : {}),
      } });
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'credit_note_apply', operation: 'apply_credit_note_to_invoice',
        targetType: 'CreditNoteAllocation', targetId: allocId, after: { creditNoteId: noteId, creditNoteNumber: note.creditNoteNumber,
          invoiceId: invoice.id, appliedAmount: applied.toString(), invoiceStatusAfter: newInvoiceStatus,
          creditNoteStatusAfter: nextStatus, creditNoteOpenAfter: nextOpen.toString(), settlementEventId: event.id },
      });
      // Required immutable financial intent audit, in the same transaction as
      // the event, net allocation, invoice and account balance.
      await tx.auditLog.create({ data: { id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, actorId,
        action: 'CREDIT_NOTE_SETTLED', targetType: 'CreditNote', targetId: noteId, operationType: 'transition',
        detail: { source: 'credit_note_apply', creditNoteSettlement: { schemaVersion: 1, eventId: event.id, actorId,
          requestId: input.clientRequestId ?? null, parameters, parametersHash,
          versionId: account?.version.id ?? null, contentFingerprint: account?.version.contentFingerprint ?? null,
          createdAt: String(now), amountAtExecution: creditNoteEffectiveAmount(note).toString(), openBefore: openAmount.toString(),
          openAfter: nextOpen.toString(), statusAfter: nextStatus, invoiceStatusAfter: newInvoiceStatus } },
      } });
      if (updatedInvoice.customerRelationId) await notifyCustomerCreditRecalc(tx, {
        relationId: updatedInvoice.customerRelationId, source: 'credit_note_apply', triggerId: allocId, triggerBy: actorId,
      });
      await syncOrderAutoSettlementByInvoice(tx, invoice.id, { source: 'credit_note_apply' });
      return ok({ creditNote, applied: applied.toString(), settlementEvent: event, replayed: false });
    });
  } catch (error) {
    // An external caller must not normally return and commit after a rejected
    // financial mutation. Preserve the original throwing external-tx contract.
    if (opts.tx) throw error;
    if (error instanceof CreditNoteTransactionError) return fail(error.creditNoteError.code, error.creditNoteError.message);
    if (error instanceof ClaimTransactionError) return fail(error.claimError.code as CreditNoteCode, error.claimError.message);
    throw error;
  }
}

class CreditNoteTransactionError extends Error {
  constructor(readonly creditNoteError: CreditNoteError) { super(creditNoteError.message); }
}

/**
 * 作废退款单（口径 A5：**能撤销** + 留痕）。
 *
 * ⚠️ **只允许作废未核销（Open）的单** —— 已核销的必须先反核销，
 *   否则会出现「单子作废了、但钱已经抵扣出去」的账实不符。
 */
export async function cancelCreditNote(
  prisma: PrismaClient,
  noteId: string,
  reason: string,
  actorId: string,
): Promise<CreditNoteResult<{ creditNote: any }>> {
  if (!reason?.trim()) return fail<{ creditNote: any }>('VALIDATION_FAILED', '作废必须填写理由');

  try {
    return await prisma.$transaction(async (tx: any) => {
      const note = await lockCreditNoteForSettlement(tx, noteId);
      if (note.logicalClaimCaseId) return fail<{ creditNote: any }>('INVALID_STATE', '该退款单属于已执行售后处置，不能单独作废。请从原售后案件查看原处置及退款进度，保留批准记录和原单据。');
      if (note.status === 'Cancelled') return fail<{ creditNote: any }>('INVALID_STATE', '该退款单已作废');
      if (note.status !== 'Open') return fail<{ creditNote: any }>('INVALID_STATE', `退款单状态为 ${note.status}，已发生核销 —— 必须先反核销才能作废（反核销属二期）`);
      const updated = await tx.creditNote.update({ where: { id: noteId }, data: {
        status: 'Cancelled', cancelledAt: todayLocalKey(), cancelledBy: actorId,
        cancelReason: reason.trim(), updatedAt: BigInt(Date.now()),
      } });
      return ok({ creditNote: updated });
    });
  } catch (error) {
    if (error instanceof ClaimTransactionError) return fail<{ creditNote: any }>(error.claimError.code as CreditNoteCode, error.claimError.message);
    throw error;
  }
}

/** 未结清退款单列表（供「还欠客户多少」类查询；与 openReceivable 同思路） */
export async function listOpenCreditNotes(
  prisma: PrismaClient,
  filter: { customerRelationId?: string | null; claimCaseId?: string | null; limit?: number; offset?: number;
    includeClosed?: boolean; status?: string; scopeWhere?: Record<string, unknown> } = {},
): Promise<CreditNoteResult<{ items: any[]; totalOpen: string; total: number; offset: number; limit: number }>> {
  const page = claimPage(filter);
  const statuses = ['Open', 'PartiallyApplied', 'Closed', 'Cancelled'];
  if (filter.status && !statuses.includes(filter.status)) throw new ClaimVisibilityError('VALIDATION_FAILED', '退款单状态无效');
  const where: any = { deletedAt: null, status: filter.status ?? { in: filter.includeClosed ? statuses : [...CREDIT_NOTE_OPEN_STATUSES] } };
  if (filter.customerRelationId) where.customerRelationId = filter.customerRelationId;
  if (filter.claimCaseId) where.claimCaseId = filter.claimCaseId;
  if (filter.scopeWhere && Object.keys(filter.scopeWhere).length) where.AND = [filter.scopeWhere];

  const [items, total, aggregate] = await Promise.all([
    prisma.creditNote.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: page.limit, skip: page.offset }),
    prisma.creditNote.count({ where }),
    // Closed/cancelled history may be readable, but never adds open liability.
    prisma.creditNote.aggregate({ where: { AND: [where, { status: { in: [...CREDIT_NOTE_OPEN_STATUSES] } }] }, _sum: { openAmount: true } }),
  ]);
  return ok({ items, totalOpen: new Prisma.Decimal(aggregate._sum.openAmount ?? 0).toString(), total, ...page });
}
