import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

type Identity = Readonly<{ actorId: string; source: string; operation: 'create_allocation' | 'update_allocation' | 'delete_allocation' }>;
type Refusal = Readonly<{ code: 'CONFLICT'; statusCode: 409; message: string }>;
const refusals = new WeakMap<object, Refusal>();
export const readAllocationAttemptRefusal = (error: unknown): Refusal | undefined =>
  typeof error === 'object' && error !== null ? refusals.get(error) : undefined;

const unknownFailure = () => Object.freeze({});
function abortedFailure(): object {
  const error = Object.freeze({});
  refusals.set(error, Object.freeze({ code: 'CONFLICT', statusCode: 409, message: '本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。' }));
  return error;
}

// These snapshots are private to one live invocation; no process-loss or
// durable request replay is inferred from them.
function snapshot(value: any, seen = new Set<object>()): any {
  if (value === null || ['string', 'boolean', 'bigint'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw unknownFailure();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw unknownFailure();
    return new Date(value.getTime());
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw unknownFailure();
  seen.add(value);
  const out: any = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor)) throw unknownFailure();
    Object.defineProperty(out, key, { value: snapshot(descriptor.value, seen), enumerable: descriptor.enumerable, writable: false, configurable: false });
  }
  seen.delete(value);
  return Object.freeze(out);
}

function canonical(value: any): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'date:' + value.toISOString();
  if (Array.isArray(value)) return 'array:[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') return 'object:{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return typeof value + ':' + (typeof value === 'bigint' ? value.toString() : JSON.stringify(value));
}
const digest = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const amount = (value: unknown) => {
  if (typeof value !== 'string') throw unknownFailure();
  const parsed = new Prisma.Decimal(value);
  if (!parsed.isFinite()) throw unknownFailure();
  return parsed.toString();
};

function matchingAudit(row: any, result: any, identity: Identity): boolean {
  if (!row || !nonempty(result?.auditId) || row.id !== result.auditId || row.actorId !== identity.actorId
      || row.action !== identity.operation || row.targetType !== 'InvoiceAllocation' || row.detail?.source !== identity.source) return false;
  const after = row.detail?.after;
  if (!after || after.invoiceStatus !== result.newInvoiceStatus || after.voucherStatus !== result.newVoucherStatus
      || amount(after.voucherAppliedAmount) !== amount(result.voucherAppliedAmount)) return false;
  if (identity.operation === 'delete_allocation') {
    const before = row.detail?.before;
    return result.deleted === true && nonempty(result.id) && row.targetId === result.id && before?.id === result.id
      && before.invoiceId === result.invoiceId && before.voucherId === result.voucherId && nonempty(before.appliedAmount);
  }
  const allocation = result.allocation;
  if (!allocation || !nonempty(allocation.id) || row.targetId !== allocation.id
      || amount(after.appliedAmount) !== amount(allocation.appliedAmount) || !nonempty(allocation.appliedDate)) return false;
  return identity.operation !== 'create_allocation' || (after.id === allocation.id && after.invoiceId === allocation.invoiceId && after.voucherId === allocation.voucherId);
}

/** Preserve the original business callback and its ACK. Error shape is never
 * transaction proof. Only this invocation's actual xid plus its original
 * audited result can resolve an uncertain return. */
export async function runAllocationAttempt<T>(
  prisma: any,
  callback: (tx: any) => Promise<T>,
  options: any,
  identity: Identity,
  isCallbackRefusal: (error: unknown) => boolean,
): Promise<T> {
  let xid: string | undefined;
  let callbackError: unknown;
  let callbackFailed = false;
  let callbackReturned = false;
  let auditWriteFailed = false;
  let original: any;
  let originalAudit: any;
  let originalAuditHash: string | undefined;
  try {
    return await prisma.$transaction(async (tx: any) => {
      try {
        const rows = await tx.$queryRawUnsafe('SELECT pg_current_xact_id()::text AS xid');
        const value = rows?.[0]?.xid;
        if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < BigInt('18446744073709551616')) xid = value;
      } catch { /* No xid means an uncertain error cannot be certified. */ }
      // Observe only this invocation's real audit delegate; business writes,
      // arguments and exceptions continue through the original callback.
      const observedTx = new Proxy(tx, { get(target, property) {
        if (property !== 'auditLog') return Reflect.get(target, property);
        return new Proxy(tx.auditLog, { get(delegate, method) {
          if (method !== 'create') return Reflect.get(delegate, method);
          return async (args: any) => {
            try { return await tx.auditLog.create(args); }
            catch (error) { auditWriteFailed = true; throw error; }
          };
        } });
      } });
      let result: T;
      try { result = await callback(observedTx); }
      catch (error) { callbackFailed = true; callbackError = error; throw error; }
      callbackReturned = true;
      try {
        original = snapshot(result);
        const row = snapshot(await tx.auditLog.findUnique({ where: { id: original.auditId } }));
        if (matchingAudit(row, original, identity)) { originalAudit = row; originalAuditHash = digest(row); }
      } catch { original = undefined; originalAudit = undefined; originalAuditHash = undefined; }
      return result;
    }, options);
  } catch (error) {
    if (callbackFailed && auditWriteFailed) throw unknownFailure();
    if (callbackFailed && callbackError === error && isCallbackRefusal(error)) throw error;
    if (!xid) throw unknownFailure();
    let abortedProof = false;
    try {
      const rows = await prisma.$queryRawUnsafe('SELECT $1::text AS xid, pg_xact_status($1::xid8)::text AS state', xid);
      const state = Array.isArray(rows) && rows.length === 1 && rows[0]?.xid === xid ? rows[0].state : undefined;
      if (state === 'aborted' && (!callbackReturned || (original && originalAudit && originalAuditHash))) abortedProof = true;
      if (state === 'committed' && original && originalAudit && originalAuditHash) {
        const currentAudit = snapshot(await prisma.auditLog.findUnique({ where: { id: original.auditId } }));
        if (matchingAudit(currentAudit, original, identity) && digest(currentAudit) === originalAuditHash
            && canonical(currentAudit) === canonical(originalAudit)) return original as T;
      }
    } catch { /* A proof read cannot mint or borrow another attempt's refusal. */ }
    if (abortedProof) throw abortedFailure();
    throw unknownFailure();
  }
}
