import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { exactJsonValue } from '../lib/exactJsonValue';
import { businessError } from '../shared/errorCodes';
import { bulkInvoiceSourcesInTx } from './bulkInvoiceReadProjection';
import { currentProformaActor } from './proformaInvoiceAccess';
import type { TokenPayload } from '../auth/service';

const OP = 'bulk_first_invoice_receipt';
const SOURCE = 'finance:bulk-first-command';
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
function sorted(x: any): any { return Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x; }
export function bulkFirstDigest(x: unknown): string { return createHash('sha256').update(JSON.stringify(sorted(exactJsonValue(x)))).digest('hex'); }
export interface BulkFirstIntent { schemaVersion: 1; requestKey: string; orderId: string; batchId: string; expectedSourceFingerprint: string; mode: 'submit' | 'reconcile'; }
export type BulkFirstLease = { id: string; actor: TokenPayload; command: any; hash: string; intent: BulkFirstIntent; replay?: any };

export type BulkFirstRefusal = { site: 'normalize' | 'line-amounts' | 'allocations' | 'source-review'; code: string; message: string };
/** Pure binding validation, not a rejection receipt or authority decision. */
export function bulkFirstSourceIdentity(input: Record<string, any>, actor: TokenPayload | null | undefined): BulkFirstIntent {
  const i = input.bulkFirstIntent;
  if (!actor?.userId || !i || i.schemaVersion !== 1 || !['submit','reconcile'].includes(i.mode)
    || typeof i.requestKey !== 'string' || !i.requestKey.trim() || i.requestKey.length > 128
    || typeof i.orderId !== 'string' || !i.orderId || typeof i.batchId !== 'string' || !i.batchId
    || !/^[a-f0-9]{64}$/.test(i.expectedSourceFingerprint) || input.type !== 'Receivable' || input.orderId !== i.orderId
    || !Array.isArray(input.orderAllocations) || input.orderAllocations.length !== 1
    || input.orderAllocations[0]?.orderId !== i.orderId || input.orderAllocations[0]?.batchId !== i.batchId) conflict('原请求来源身份无法核验，请保留原请求。');
  return i;
}
const REJECT = 'bulk_first_invoice_rejected';
async function rejectBeforeWrite(tx: any, lease: BulkFirstLease, refusal: BulkFirstRefusal, sourceFingerprint: string) {
  // Only called from named pre-write validators after source/key locks and history checks.
  const rejectionAuditId = randomUUID();
  await tx.auditLog.create({ data: { id: rejectionAuditId, actorId: lease.actor.userId, action: 'reject_bulk_first_invoice', targetType: 'BulkFirstInvoiceCommand', targetId: lease.id, transactionId: lease.id,
    detail: { source: SOURCE, bulkFirstCommand: { receiptId: lease.id, command: lease.command, commandHash: lease.hash }, site: refusal.site, reasonCode: refusal.code, message: refusal.message, sourceFingerprint } } });
  const audit = await tx.auditLog.findUnique({ where: { id: rejectionAuditId } });
  const core = { schemaVersion: 1, outcome: 'rejected', receiptId: lease.id, command: lease.command, commandHash: lease.hash, site: refusal.site, reasonCode: refusal.code, message: refusal.message, rejectionAuditId, rejectionAuditHash: bulkFirstDigest(audit) };
  const ack = { ...core, rejectionHash: bulkFirstDigest(core) };
  await tx.auditLog.create({ data: { id: lease.id, actorId: lease.actor.userId, action: REJECT, targetType: 'BulkFirstInvoiceCommand', targetId: lease.id, transactionId: lease.id, detail: { source: SOURCE, after: ack } } });
  await currentProformaActor(tx, lease.actor.userId, lease.actor);
  return { bulkFirstRejection: ack, replayed: true };
}
async function readRejection(tx: any, lease: BulkFirstLease, row: any, traces: any[]) {
  const a = row.detail?.after;
  const { rejectionHash, ...core } = a ?? {};
  if (row.actorId !== lease.actor.userId || row.targetType !== 'BulkFirstInvoiceCommand' || row.targetId !== lease.id || row.transactionId !== lease.id
    || a?.schemaVersion !== 1 || a?.outcome !== 'rejected' || a.receiptId !== lease.id || a.commandHash !== lease.hash || bulkFirstDigest(a.command) !== lease.hash
    || !['normalize','line-amounts','allocations','source-review'].includes(a.site) || typeof a.reasonCode !== 'string' || typeof a.message !== 'string'
    || typeof a.rejectionAuditId !== 'string' || rejectionHash !== bulkFirstDigest(core) || bulkFirstDigest(row.detail) !== bulkFirstDigest({ source: SOURCE, after: a })) conflict('原拒绝回执无法核验，请保留原请求。');
  const audit = await tx.auditLog.findUnique({ where: { id: a.rejectionAuditId } });
  if (!audit || audit.actorId !== lease.actor.userId || audit.action !== 'reject_bulk_first_invoice' || audit.targetType !== 'BulkFirstInvoiceCommand' || audit.targetId !== lease.id || audit.transactionId !== lease.id
    || audit.detail?.source !== SOURCE || audit.detail?.bulkFirstCommand?.receiptId !== lease.id || audit.detail?.bulkFirstCommand?.commandHash !== lease.hash || bulkFirstDigest(audit.detail?.bulkFirstCommand?.command) !== lease.hash
    || audit.detail?.site !== a.site || audit.detail?.reasonCode !== a.reasonCode || audit.detail?.message !== a.message || bulkFirstDigest(audit) !== a.rejectionAuditHash
    || traces.some(t => t.id !== lease.id && t.id !== audit.id)) conflict('原拒绝审计不完整，请保留原请求。');
  await currentProformaActor(tx, lease.actor.userId, lease.actor);
  return { bulkFirstRejection: a, replayed: true };
}

/** Caller has already taken the canonical source/OSB locks. No separate transaction. */
export async function beginBulkFirst(tx: any, input: Record<string, any>, actor: TokenPayload | null | undefined, refusal?: BulkFirstRefusal): Promise<BulkFirstLease | null> {
  if (input.bulkFirstIntent === undefined) return null;
  const i = input.bulkFirstIntent;
  if (!actor?.userId) throw businessError('UNAUTHORIZED', '原批次开票主体无法核验。');
  if (!i || typeof i !== 'object' || Array.isArray(i) || Object.keys(i).some(k => !['schemaVersion','requestKey','orderId','batchId','expectedSourceFingerprint','mode'].includes(k))
    || i.schemaVersion !== 1 || !['submit','reconcile'].includes(i.mode) || typeof i.requestKey !== 'string' || !i.requestKey.trim() || i.requestKey.length > 128
    || typeof i.orderId !== 'string' || !i.orderId || typeof i.batchId !== 'string' || !i.batchId || !/^[a-f0-9]{64}$/.test(i.expectedSourceFingerprint)) conflict('原批次开票请求不完整，请保留原输入核对。');
  if (input.type !== 'Receivable' || input.orderId !== i.orderId || input.sourceType || input.sourceId || input.invoiceLines?.length
    || !Array.isArray(input.orderAllocations) || input.orderAllocations.length !== 1 || input.orderAllocations[0].orderId !== i.orderId || input.orderAllocations[0].batchId !== i.batchId
    || input.orderIds && (!Array.isArray(input.orderIds) || input.orderIds.length !== 1 || input.orderIds[0] !== i.orderId)) conflict('首次按批开票必须保持原订单和单一批次。');
  await currentProformaActor(tx, actor.userId, actor);
  const { bulkFirstIntent: _intent, ...payload } = input;
  const command = exactJsonValue({ schemaVersion: 1, operation: OP, actorId: actor.userId, requestKey: i.requestKey, orderId: i.orderId, batchId: i.batchId, expectedSourceFingerprint: i.expectedSourceFingerprint, payload });
  const id = 'bulk-first:' + bulkFirstDigest({ actorId: actor.userId, requestKey: i.requestKey });
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`);
  const lease: BulkFirstLease = { id, actor, command, hash: bulkFirstDigest(command), intent: i };
  const row = await tx.auditLog.findUnique({ where: { id } });
  const traces = await tx.auditLog.findMany({ where: { OR: [{ transactionId: id }, { detail: { path: ['bulkFirstCommand','receiptId'], equals: id } }] } });
  const sources = await bulkInvoiceSourcesInTx(tx, actor, { orderId: i.orderId, batchId: i.batchId });
  const source = sources[0];
  if (!source) conflict('原批次不存在或不可读取。');
  if (row?.action === REJECT) { lease.replay = await readRejection(tx, lease, row, traces); return lease; }
  if (row) {
    const a = row.detail?.after;
    if (row.actorId !== actor.userId || row.action !== OP || row.targetType !== 'Invoice' || row.transactionId !== id || row.detail?.source !== SOURCE
      || a?.commandHash !== lease.hash || bulkFirstDigest(a?.command) !== lease.hash || a?.receiptId !== id || !a?.invoice?.id || row.targetId !== a.invoice.id
      || a.invoiceHash !== bulkFirstDigest(a.invoice) || typeof a.originalAuditId !== 'string') conflict('原开票回执与请求不一致，结果待核对。');
    const original = await tx.auditLog.findUnique({ where: { id: a.originalAuditId } });
    if (!original || original.actorId !== actor.userId || original.action !== 'create_invoice' || original.targetId !== row.targetId || original.targetType !== 'Invoice'
      || original.transactionId !== id || original.detail?.source !== 'route:invoice:create' || original.detail?.bulkFirstCommand?.receiptId !== id || bulkFirstDigest(original.detail?.bulkFirstCommand?.command) !== lease.hash || original.detail?.bulkFirstCommand?.commandHash !== lease.hash
      || bulkFirstDigest(original) !== a.originalAuditHash || traces.some((t: any) => t.id !== id && t.id !== original.id)) conflict('原开票审计不完整，结果待核对。');
    const invoice = await tx.invoice.findUnique({ where: { id: row.targetId } });
    // A damaged/deleted business result is not a never-committed command.
    if (!invoice || invoice.deletedAt != null || !source.invoices.some(x => x.invoiceId === invoice.id)) conflict('原开票结果已变化，保留原请求核对。');
    await currentProformaActor(tx, actor.userId, actor);
    lease.replay = { invoice, auditId: original.id, bulkFirstAcknowledgement: a, replayed: true };
    return lease;
  }
  if (traces.length || i.mode === 'reconcile') conflict('原请求结果尚未确认，请保留原请求核对；未重新开票。');
  if (refusal) { lease.replay = await rejectBeforeWrite(tx, lease, refusal, source.sourceFingerprint); return lease; }
  if (source.disposition !== 'first-invoice-review' || !source.canStartInvoice || source.sourceFingerprint !== i.expectedSourceFingerprint
    || input.customerRelationId !== source.order.customerRelationId || input.currency !== source.batch.currency) {
    lease.replay = await rejectBeforeWrite(tx, lease, { site: 'source-review', code: 'SOURCE_REVIEW', message: '原批次已有发票或来源已变化，请核对原发票。' }, source.sourceFingerprint);
  }
  return lease;
}
export async function finishBulkFirst(tx: any, lease: BulkFirstLease | null, invoice: any, auditId: string) {
  if (!lease) return undefined;
  const audit = await tx.auditLog.findUnique({ where: { id: auditId } });
  if (!audit || audit.action !== 'create_invoice' || audit.actorId !== lease.actor.userId || audit.targetId !== invoice.id) conflict('开票必需审计未确认。');
  // Only enrich the new audit in this same uncommitted producer transaction.
  await tx.auditLog.update({ where: { id: auditId }, data: { transactionId: lease.id, detail: { ...audit.detail, bulkFirstCommand: { receiptId: lease.id, commandHash: lease.hash, command: lease.command } } } });
  const original = await tx.auditLog.findUnique({ where: { id: auditId } });
  const saved = exactJsonValue(invoice);
  const ack = { schemaVersion: 1, receiptId: lease.id, command: lease.command, commandHash: lease.hash, invoice: saved, invoiceHash: bulkFirstDigest(saved), originalAuditId: auditId, originalAuditHash: bulkFirstDigest(original) };
  await tx.auditLog.create({ data: { id: lease.id, actorId: lease.actor.userId, action: OP, targetType: 'Invoice', targetId: invoice.id, transactionId: lease.id, detail: { source: SOURCE, after: ack } } });
  await currentProformaActor(tx, lease.actor.userId, lease.actor);
  return ack;
}
