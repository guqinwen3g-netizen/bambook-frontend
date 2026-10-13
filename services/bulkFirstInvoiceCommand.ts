import { getAuthState, subscribe } from './authService';
import { apiService } from './apiService';
export interface BulkFirstIntent { schemaVersion: 1; requestKey: string; orderId: string; batchId: string; expectedSourceFingerprint: string; mode: 'submit' | 'reconcile'; }
export interface BulkFirstAcknowledgement { schemaVersion: 1; receiptId: string; command: { schemaVersion: 1; operation: 'bulk_first_invoice_receipt'; actorId: string; requestKey: string; orderId: string; batchId: string; expectedSourceFingerprint: string; payload: Record<string, unknown> }; commandHash: string; invoice: Record<string, unknown>; invoiceHash: string; originalAuditId: string; originalAuditHash: string; }
export interface PendingBulkFirst { intent: BulkFirstIntent; payload: Record<string, unknown>; }
function ownerKey(): string {
  const actor = getAuthState().user?.id;
  if (!actor) throw Error('请登录后核对原开票请求。');
  return 'bambook:bulk-first-pending:v1:' + JSON.stringify([apiService.getStoredConfig().cloudEndpoint, actor]);
}
export function pendingBulkFirst(): PendingBulkFirst[] {
  const raw = localStorage.getItem(ownerKey());
  if (!raw) return [];
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.some(r => !r?.intent?.requestKey || !r?.intent?.orderId || !r?.intent?.batchId || !r?.payload)) throw Error('本地原开票请求缓存无法读取，请先核对，不要重新开票。');
  return rows;
}
/** Cache is a frozen submitted command, never a financial truth or receipt. */
export function stageBulkFirst(payload: Record<string, unknown>, intent: BulkFirstIntent): PendingBulkFirst {
  const rows = pendingBulkFirst();
  if (rows.some(r => r.intent.requestKey === intent.requestKey || r.intent.orderId === intent.orderId && r.intent.batchId === intent.batchId)) throw Error('该批次已有待核对开票请求，请先核对上次结果。');
  const record = JSON.parse(JSON.stringify({ payload, intent }));
  localStorage.setItem(ownerKey(), JSON.stringify([...rows, record]));
  return record;
}
function stable(x: any): any { return Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x; }
async function digest(x: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(x)))))).map(n => n.toString(16).padStart(2,'0')).join(''); }
export async function confirmBulkFirst(record: PendingBulkFirst, response: any, assertCurrent: () => void): Promise<void> {
  const storageKey = ownerKey();
  const ack = response?.bulkFirstAcknowledgement as Partial<BulkFirstAcknowledgement> | undefined, i = record.intent;
  const command = { schemaVersion: 1, operation: 'bulk_first_invoice_receipt', actorId: getAuthState().user?.id, requestKey: i.requestKey, orderId: i.orderId, batchId: i.batchId, expectedSourceFingerprint: i.expectedSourceFingerprint, payload: record.payload };
  if (!ack || ack.schemaVersion !== 1 || ack.commandHash !== await digest(command) || await digest(ack.command) !== ack.commandHash || ack.receiptId !== 'bulk-first:' + await digest({actorId: command.actorId,requestKey:i.requestKey}) || typeof ack.originalAuditId !== 'string' || !ack.originalAuditId || typeof ack.originalAuditHash !== 'string' || !/^[a-f0-9]{64}$/.test(ack.originalAuditHash) || ack.invoice?.id !== response.id || ack.invoiceHash !== await digest(ack.invoice)) throw Error('原开票回执尚未确认，请保留请求核对。');
  assertCurrent();
  if (ownerKey() !== storageKey) throw Error('账号或服务地址已变化，请保留原请求核对。');
  localStorage.setItem(storageKey + ':rejected-drafts', JSON.stringify(rejectedBulkDrafts().filter(d => d.record.intent.orderId !== i.orderId || d.record.intent.batchId !== i.batchId)));
  localStorage.setItem(storageKey, JSON.stringify(pendingBulkFirst().filter(r => r.intent.requestKey !== i.requestKey)));
}

export class BulkFirstRejected extends Error {
  constructor(readonly record: PendingBulkFirst, readonly acknowledgement: any) { super('开票请求已拒绝：' + acknowledgement.message + ' 可调整输入后重提。'); this.name = 'BulkFirstRejected'; }
}
/** Only a complete, actor-bound terminal ACK can remove pending; HTTP status is irrelevant. */
export async function confirmBulkRejection(record: PendingBulkFirst, response: any, assertCurrent: () => void): Promise<never> {
  const storageKey = ownerKey(), a = response?.bulkFirstRejection, i = record.intent;
  const command = { schemaVersion: 1, operation: 'bulk_first_invoice_receipt', actorId: getAuthState().user?.id, requestKey: i.requestKey, orderId: i.orderId, batchId: i.batchId, expectedSourceFingerprint: i.expectedSourceFingerprint, payload: record.payload };
  const { rejectionHash, ...core } = a ?? {};
  if (!a || a.schemaVersion !== 1 || a.outcome !== 'rejected' || a.commandHash !== await digest(command) || await digest(a.command) !== a.commandHash
    || a.receiptId !== 'bulk-first:' + await digest({ actorId: command.actorId, requestKey: i.requestKey }) || rejectionHash !== await digest(core)
    || !['normalize','line-amounts','allocations','source-review'].includes(a.site) || typeof a.reasonCode !== 'string' || !a.reasonCode || typeof a.message !== 'string' || !a.message
    || typeof a.rejectionAuditId !== 'string' || !a.rejectionAuditId || !/^[a-f0-9]{64}$/.test(a.rejectionAuditHash)) throw Error('原拒绝回执尚未确认，请保留原请求核对。');
  assertCurrent();
  if (ownerKey() !== storageKey) throw Error('账号或服务地址已变化，请保留原请求核对。');
  localStorage.setItem(storageKey + ':rejected-drafts', JSON.stringify([...rejectedBulkDrafts().filter(d => d.record.intent.requestKey !== i.requestKey), { record, message: '开票请求已拒绝：' + a.message + ' 可调整输入后重提。' }]));
  localStorage.setItem(storageKey, JSON.stringify(pendingBulkFirst().filter(r => r.intent.requestKey !== i.requestKey)));
  throw new BulkFirstRejected(record, a);
}

/** Sticky invalidation: observed A→B→A cannot release the old command cache. */
export function watchBulkFirstContext(assertCurrent: () => void) {
  let invalid = false;
  const observe = () => { try { assertCurrent(); } catch { invalid = true; } };
  const stop = subscribe(observe);
  window.addEventListener('storage', observe);
  return { assertCurrent: () => { observe(); if (invalid) throw Error('账号、权限或服务地址曾变化，请保留原请求核对。'); }, stop: () => { stop(); window.removeEventListener('storage', observe); } };
}

/** Input recovery only: cached terminal drafts never authorize a financial write. */
export function rejectedBulkDrafts(): Array<{record:PendingBulkFirst;message:string}> {
  const raw=localStorage.getItem(ownerKey()+':rejected-drafts');
  if(!raw)return [];
  const rows=JSON.parse(raw);
  if(!Array.isArray(rows)||rows.some(d=>!d?.record?.intent?.requestKey||!d.record.intent.orderId||!d.record.intent.batchId||!d.record.payload||typeof d.message!=='string'))throw Error('已拒绝请求的原输入缓存无法读取。');
  return rows;
}
export function forgetRejectedBulkDraft(record:PendingBulkFirst) {
  localStorage.setItem(ownerKey()+':rejected-drafts',JSON.stringify(rejectedBulkDrafts().filter(d=>d.record.intent.requestKey!==record.intent.requestKey)));
}
