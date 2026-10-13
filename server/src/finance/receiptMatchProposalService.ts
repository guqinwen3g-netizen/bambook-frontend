import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { resolveVisibleOrderIds } from '../auth/orderVisibility';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { RECEIVABLE_OPEN_STATUSES, hasOpenAmount } from '../shared/openReceivable';
import { applyAllocation, isValidAllocationDecimal } from './allocationService';
import { publishAllocationEvents } from './allocationMutationService';
import { resolveInvoiceOrderIds } from './receiptClaimService';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';
import { assertNotCashRefundVoucher } from '../claims/claimCashRefundFact';

export const RECEIPT_MATCH_SUGGEST_SCOPE = 'invoices:suggest_match' as const;
type ReceiptMatchActor = Pick<TokenPayload, 'userId'> & Partial<Pick<TokenPayload, 'permissionCeiling'>>;
export type ProposalDecision = 'Confirmed' | 'Rejected' | 'Withdrawn';
export class ReceiptMatchProposalError extends Error {
  constructor(public code: string, message: string, public statusCode: number) { super(message); }
}
const reject = (code: string, message: string, status = 409): never => { throw new ReceiptMatchProposalError(code, message, status); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;
/** Raw SELECT FOR UPDATE reports PostgreSQL serialization failures as P2010.
 * Other raw SQL errors (including malformed SQL/FK failures) are not conflicts. */
export function isReceiptProposalConcurrencyConflict(error: { code?: unknown; meta?: { code?: unknown } } | null | undefined) {
  return error?.code === 'P2002' || error?.code === 'P2034' || (error?.code === 'P2010' && error.meta?.code === '40001');
}

/** Amount/note/source identity are immutable. A changed request must use a new ID. */
export function normalizeReceiptMatchInput(input: { voucherId?: unknown; invoiceId?: unknown; amount?: unknown; currency?: unknown; note?: unknown; requestId?: unknown }) {
  const voucherId = typeof input.voucherId === 'string' ? input.voucherId.trim() : '';
  const invoiceId = typeof input.invoiceId === 'string' ? input.invoiceId.trim() : '';
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  const currency = typeof input.currency === 'string' ? input.currency.trim() : '';
  if (!voucherId || !invoiceId || !requestId || requestId.length > 128 || !currency || currency.length > 12) reject('MISSING_INPUT', '收款、发票、币种和有效请求编号必填', 400);
  if (!isValidAllocationDecimal(input.amount)) reject('INVALID_AMOUNT', '建议金额必须是有效正数', 400);
  const amount = new Prisma.Decimal(input.amount as string | number);
  if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 4 || amount.gte('100000000000000')) reject('INVALID_AMOUNT', '建议金额必须为正数，最多四位小数', 400);
  if (input.note != null && typeof input.note !== 'string') reject('INVALID_INPUT', '建议说明必须是文字', 400);
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 2000) reject('INVALID_INPUT', '建议说明最多 2000 字', 400);
  return { voucherId, invoiceId, amount: amount.toString(), currency, note: note || null, requestId };
}

/** A successful current DB load, including an empty grant set, is authoritative. */
async function currentActor(tx: any, supplied: ReceiptMatchActor, scope: PermissionScope): Promise<TokenPayload> {
  const context = await createPermissionService({ prisma: tx }).getUserPermissionContext(supplied.userId);
  if (!context) reject('UNAUTHORIZED', '当前账号不可用，请重新登录', 401);
  const actor: TokenPayload = { userId: context!.userId, roles: context!.legacyRoleCodes, roleIds: context!.roleIds,
    departmentIds: context!.departmentIds, permissions: context!.scopes, authorizationLoaded: true,
    ...(supplied.permissionCeiling !== undefined ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
  if (!hasScope(actor, scope)) reject('FORBIDDEN', '当前账号没有这项操作权限', 403);
  return actor;
}

async function visibleSources(tx: any, actor: TokenPayload, voucherId: string, invoiceId: string) {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
  const voucher = await tx.paymentVoucher.findFirst({ where: { id: voucherId, deletedAt: null } });
  if (!invoice || !voucher) reject('NOT_FOUND', '收款或发票不存在或不在当前可见范围', 404);
  const visible = await resolveVisibleOrderIds(tx, actor);
  if (visible !== null) {
    const linked = await resolveInvoiceOrderIds(tx, invoiceId, invoice.orderId);
    if (!linked.some(id => visible.includes(id))) reject('NOT_FOUND', '收款或发票不存在或不在当前可见范围', 404);
    const customers = await tx.order.findMany({ where: { id: { in: visible } }, select: { customerRelationId: true } });
    if (!voucher.customerRelationId || !customers.some((order: any) => order.customerRelationId === voucher.customerRelationId)) reject('NOT_FOUND', '收款或发票不存在或不在当前可见范围', 404);
  }
  return { invoice, voucher };
}

async function validateMatch(tx: any, actor: TokenPayload, proposal: { voucherId: string; invoiceId: string; currency: string; requestedAmount: unknown }) {
  const { invoice } = await visibleSources(tx, actor, proposal.voucherId, proposal.invoiceId);
  await assertNotCashRefundVoucher(tx, proposal.voucherId);
  const voucher = await tx.paymentVoucher.findUnique({ where: { id: proposal.voucherId } });
  if (!voucher || voucher.deletedAt) reject('NOT_FOUND', '收款不存在或已删除', 404);
  if (voucher.type !== 'Receipt' || !['unreconciled', 'partially_reconciled'].includes(voucher.status)) reject('VOUCHER_NOT_CLAIMABLE', '该收款当前不可匹配');
  if (invoice.type !== 'Receivable' || !(RECEIVABLE_OPEN_STATUSES as readonly string[]).includes(invoice.status) || !hasOpenAmount(invoice.amount)) reject('INVOICE_NOT_CLAIMABLE', '该发票当前没有可匹配的应收余额');
  if (invoice.currency !== voucher.currency || proposal.currency !== invoice.currency) reject('CURRENCY_MISMATCH', '收款与发票币种必须一致，不做自动换算', 400);
  const amount = new Prisma.Decimal(proposal.requestedAmount as any);
  const invoiceAllocations = await tx.invoiceAllocation.findMany({ where: { invoiceId: invoice.id }, select: { appliedAmount: true } });
  const credits = await tx.creditNoteAllocation.findMany({ where: { invoiceId: invoice.id }, select: { appliedAmount: true } });
  const voucherAllocations = await tx.invoiceAllocation.findMany({ where: { voucherId: voucher.id }, select: { appliedAmount: true } });
  const sum = (rows: any[]) => rows.reduce((total, row) => total.plus(row.appliedAmount), new Prisma.Decimal(0));
  const remainingInvoice = new Prisma.Decimal(invoice.amount).minus(sum([...invoiceAllocations, ...credits]));
  const remainingVoucher = new Prisma.Decimal(voucher.amount).minus(sum(voucherAllocations));
  if (amount.gt(remainingInvoice) || amount.gt(remainingVoucher)) reject('AMOUNT_EXCEEDED', '建议金额超出当前应收或收款余额，请撤回后重新提出', 400);
  return { invoice, voucher };
}

export function receiptMatchProposalView(row: any) {
  return { id: row.id, requesterId: row.requesterId, voucherId: row.voucherId, invoiceId: row.invoiceId,
    requestedAmount: String(row.requestedAmount), currency: row.currency, note: row.note, requestId: row.requestId,
    status: row.status, revision: row.revision, decisionActorId: row.decisionActorId, decidedAt: row.decidedAt == null ? null : Number(row.decidedAt),
    decisionNote: row.decisionNote, allocationId: row.allocationId, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
}

export function createReceiptMatchProposalService(prisma: PrismaClient) {
  const database = prisma as any;
  async function submit(supplied: ReceiptMatchActor, input: Parameters<typeof normalizeReceiptMatchInput>[0], ip?: string) {
    const normalized = normalizeReceiptMatchInput(input);
    const fingerprint = digest({ voucherId: normalized.voucherId, invoiceId: normalized.invoiceId, amount: normalized.amount,
      currency: normalized.currency, note: normalized.note });
    const id = `receipt_proposal_${digest([supplied.userId, normalized.requestId])}`;
    const replay = async (tx: any, actor: TokenPayload, row: any) => {
      await visibleSources(tx, actor, row.voucherId, row.invoiceId);
      if (row.payloadFingerprint !== fingerprint) reject('REQUEST_CONFLICT', '此请求编号已用于不同建议内容，请核对原建议');
      return { item: receiptMatchProposalView(row), replayed: true };
    };
    try {
      return await database.$transaction(async (tx: any) => {
        const actor = await currentActor(tx, supplied, RECEIPT_MATCH_SUGGEST_SCOPE);
        const prior = await tx.receiptMatchProposal.findUnique({ where: { id } });
        if (prior) return replay(tx, actor, prior);
        await validateMatch(tx, actor, { ...normalized, requestedAmount: normalized.amount });
        const now = BigInt(Date.now());
        const row = await tx.receiptMatchProposal.create({ data: { id, requesterId: actor.userId, voucherId: normalized.voucherId,
          invoiceId: normalized.invoiceId, requestedAmount: new Prisma.Decimal(normalized.amount), currency: normalized.currency,
          note: normalized.note, requestId: normalized.requestId, payloadFingerprint: fingerprint,
          status: 'Pending', revision: 1, createdAt: now, updatedAt: now } });
        await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:receipt-match-proposal:submit',
          operation: 'receipt_match_proposed', targetType: 'ReceiptMatchProposal', targetId: id,
          after: receiptMatchProposalView(row), ip: ip ?? null });
        return { item: receiptMatchProposalView(row), replayed: false };
      }, TX);
    } catch (error: any) {
      if (isReceiptProposalConcurrencyConflict(error)) {
        // A concurrent identical request may have committed. Recheck CURRENT
        // authorization and source visibility before returning its result.
        const actor = await currentActor(database, supplied, RECEIPT_MATCH_SUGGEST_SCOPE);
        const row = await database.receiptMatchProposal.findUnique({ where: { id } });
        if (row) return replay(database, actor, row);
        reject('CONFLICT', '建议提交发生并发冲突，本次未保存，请使用原请求重试');
      }
      throw error;
    }
  }

  async function list(supplied: ReceiptMatchActor, limit = 100) {
    const actor = await currentActor(database, supplied, 'invoices:read');
    const canConfirm = hasScope(actor, 'invoices:reconcile');
    const rows = await database.receiptMatchProposal.findMany({ where: canConfirm ? {} : { requesterId: actor.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: Math.min(Math.max(limit, 1), 200) });
    const items = [];
    for (const row of rows) {
      try {
        const { invoice, voucher } = await visibleSources(database, actor, row.voucherId, row.invoiceId);
        items.push({ ...receiptMatchProposalView(row), invoiceNumber: invoice.invoiceNumber, voucherNumber: voucher.voucherNumber,
          payerName: voucher.customerName ?? null, customerName: invoice.customerName ?? null });
      }
      catch (error) { if (!(error instanceof ReceiptMatchProposalError && error.statusCode === 404)) throw error; }
    }
    return { items, total: items.length };
  }

  async function decide(supplied: ReceiptMatchActor, id: string, status: ProposalDecision,
    input: { revision?: unknown; requestId?: unknown; note?: unknown }, ip?: string) {
    if (!Number.isInteger(input.revision) || Number(input.revision) < 1 || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128) reject('MISSING_INPUT', '有效版本号和请求编号必填', 400);
    if (input.note != null && typeof input.note !== 'string') reject('INVALID_INPUT', '处理说明必须是文字', 400);
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > 2000 || (status === 'Rejected' && !note)) reject('INVALID_INPUT', '拒绝须填写原因，说明最多 2000 字', 400);
    const fingerprint = digest({ id, status, revision: input.revision, note: note || null });
    const requestId = String(input.requestId).trim();
    const decisionAuditId = `receipt_proposal_decision_${digest(id)}`;
    let result: any;
    try {
      result = await database.$transaction(async (tx: any) => {
        const actor = await currentActor(tx, supplied, status === 'Withdrawn' ? RECEIPT_MATCH_SUGGEST_SCOPE : 'invoices:reconcile');
        await tx.$queryRaw`SELECT id FROM "ReceiptMatchProposal" WHERE id = ${id} FOR UPDATE`;
        const row = await tx.receiptMatchProposal.findUnique({ where: { id } });
        if (!row) reject('NOT_FOUND', '建议不存在或不在当前可见范围', 404);
        if (status === 'Withdrawn' && row.requesterId !== actor.userId) reject('FORBIDDEN', '只能撤回自己提出的建议', 403);
        await visibleSources(tx, actor, row.voucherId, row.invoiceId);
        if (row.status !== 'Pending') {
          const prior = await tx.auditLog.findUnique({ where: { id: decisionAuditId } });
          if (row.status === status && prior?.actorId === actor.userId && prior.detail?.requestId === requestId && prior.detail?.fingerprint === fingerprint) return { item: receiptMatchProposalView(row), replayed: true };
          reject('ALREADY_DECIDED', '该建议已处理，不能覆写原决定');
        }
        if (row.revision !== input.revision) reject('STALE_REVISION', '建议版本已变化，请刷新后重新确认');
        let allocation: any;
        if (status === 'Confirmed') {
          // Same transaction: current source visibility/currency/balances, ledger
          // write, projection, proposal transition and required audits.
          await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${row.invoiceId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "PaymentVoucher" WHERE id = ${row.voucherId} FOR UPDATE`;
          await validateMatch(tx, actor, row);
          const previous = await tx.invoiceAllocation.findUnique({ where: { invoiceId_voucherId: { invoiceId: row.invoiceId, voucherId: row.voucherId } } });
          const total = new Prisma.Decimal(previous ? previous.appliedAmount : 0).plus(row.requestedAmount);
          allocation = await applyAllocation(prisma, tx, { invoiceId: row.invoiceId, voucherId: row.voucherId,
            appliedAmount: total.toString(), appliedDate: todayLocalKey(), actorId: actor.userId,
            source: 'route:receipt-match-proposal:confirm', auditOperation: 'confirm_receipt_match_allocation' });
        }
        const now = BigInt(Date.now());
        const update = await tx.receiptMatchProposal.updateMany({ where: { id, status: 'Pending', revision: input.revision,
          payloadFingerprint: row.payloadFingerprint }, data: { status, revision: { increment: 1 }, decisionActorId: actor.userId,
          decidedAt: now, decisionNote: note || null, allocationId: allocation?.allocationId ?? null, updatedAt: now } });
        if (update.count !== 1) reject('CONFLICT', '建议已被其他人处理，本次未提交');
        const updated = await tx.receiptMatchProposal.findUniqueOrThrow({ where: { id } });
        await tx.auditLog.create({ data: { id: decisionAuditId, actorId: actor.userId, action: `receipt_match_${status.toLowerCase()}`,
          targetType: 'ReceiptMatchProposal', targetId: id, ip: ip ?? null,
          detail: { source: 'route:receipt-match-proposal:decide', requestId, fingerprint,
            before: receiptMatchProposalView(row), after: receiptMatchProposalView(updated) } } });
        return { item: receiptMatchProposalView(updated), replayed: false, allocation: allocation ? {
          invoiceId: row.invoiceId, voucherId: row.voucherId, actorId: actor.userId, appliedAmount: String(row.requestedAmount),
          newInvoiceStatus: allocation.newInvoiceStatus, newVoucherStatus: allocation.newVoucherStatus,
          voucherAppliedAmount: allocation.voucherAppliedAmount.toString(), auditId: allocation.auditId,
          thirdPartyPayment: allocation.thirdPartyPayment,
        } : undefined };
      }, TX);
    } catch (error: any) {
      if (isReceiptProposalConcurrencyConflict(error)) reject('CONFLICT', '处理发生并发冲突，本次未提交，请使用原请求重试');
      throw error;
    }
    if (result.allocation) {
      try { await publishAllocationEvents({ prisma, ...result.allocation }); }
      catch (error) { logger.warn('[receipt-match-proposal] committed allocation event delivery failed', { proposalId: id, error: (error as Error).message }); }
    }
    return { item: result.item, replayed: result.replayed };
  }
  return { submit, list, decide };
}
