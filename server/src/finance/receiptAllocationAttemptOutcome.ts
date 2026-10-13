import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import type { CreateAllocationData } from './allocationMutationService';

type Result = CreateAllocationData & { replayed: boolean };
type Identity = Readonly<{ actorId: string; receiptId: string; requestId: string; fingerprint: string; invoiceId: string; voucherId: string }>;
type Refusal = Readonly<{ code: 'CONFLICT'; statusCode: 409; message: string }>;
const refusals = new WeakMap<object, Refusal>();
export const readReceiptAllocationAttemptRefusal = (error: unknown): Refusal | undefined =>
  typeof error === 'object' && error !== null ? refusals.get(error) : undefined;
const unknownFailure = () => Object.freeze({});
function abortedFailure(): object {
  const error = Object.freeze({});
  refusals.set(error, Object.freeze({ code: 'CONFLICT', statusCode: 409, message: '本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。' }));
  return error;
}

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
function decimal(value: unknown): Prisma.Decimal {
  if (typeof value !== 'string' || !value.length) throw unknownFailure();
  const parsed = new Prisma.Decimal(value);
  if (!parsed.isFinite()) throw unknownFailure();
  return parsed;
}
function matchingResult(result: any): boolean {
  const allocation = result?.allocation;
  if (!allocation || !nonempty(allocation.id) || !nonempty(allocation.invoiceId) || !nonempty(allocation.voucherId)
      || typeof allocation.appliedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(allocation.appliedDate)
      || !nonempty(result.auditId) || !['Issued', 'PartiallyPaid', 'Paid'].includes(result.newInvoiceStatus)
      || !['unreconciled', 'partially_reconciled', 'reconciled'].includes(result.newVoucherStatus)
      || decimal(allocation.appliedAmount).lte(0) || decimal(result.voucherAppliedAmount).lt(0)) return false;
  const thirdParty = result.thirdPartyPayment;
  return thirdParty === null || (thirdParty?.isThirdParty === true && ['relationId', 'name'].includes(thirdParty.basis)
    && ['payerRelationId', 'payerName', 'invoiceCustomerRelationId', 'invoiceCustomerName'].every(key => thirdParty[key] === null || typeof thirdParty[key] === 'string')
    && nonempty(thirdParty.message));
}
function matchingCore(row: any, result: any, identity: Identity): boolean {
  const after = row?.detail?.after;
  const allocation = result.allocation;
  return row?.id === result.auditId && row.actorId === identity.actorId && row.action === 'append_receipt_allocation'
    && row.targetType === 'InvoiceAllocation' && row.targetId === allocation.id && row.detail?.source === 'route:receipt:append'
    && after?.id === allocation.id && after.invoiceId === allocation.invoiceId && after.voucherId === allocation.voucherId
    && decimal(after.appliedAmount).eq(decimal(allocation.appliedAmount)) && after.invoiceStatus === result.newInvoiceStatus
    && after.voucherStatus === result.newVoucherStatus && decimal(after.voucherAppliedAmount).eq(decimal(result.voucherAppliedAmount));
}
function matchingReceipt(row: any, identity: Identity): boolean {
  const detail = row?.detail;
  const result = detail?.result;
  if (row?.id !== identity.receiptId || row.actorId !== identity.actorId || row.action !== 'finance.receipt.claim.request'
      || row.targetType !== 'InvoiceAllocation' || detail?.requestId !== identity.requestId || !matchingResult(result)
      || row.targetId !== result.allocation.id || decimal(detail.delta).lte(0) || decimal(detail.before).lt(0)
      || !decimal(detail.before).plus(decimal(detail.delta)).eq(decimal(detail.after))
      || !decimal(detail.after).eq(decimal(result.allocation.appliedAmount))) return false;
  const storedFingerprint = JSON.stringify({ invoiceId: result.allocation.invoiceId, voucherId: result.allocation.voucherId, amount: decimal(detail.delta).toString() });
  return detail.fingerprint === storedFingerprint;
}
async function readProof(db: any, identity: Identity) {
  const receipt = snapshot(await db.auditLog.findUnique({ where: { id: identity.receiptId } }));
  if (receipt === null) return null;
  if (!matchingReceipt(receipt, identity)) throw unknownFailure();
  const result = snapshot(receipt.detail.result);
  const core = snapshot(await db.auditLog.findUnique({ where: { id: result.auditId } }));
  if (!matchingCore(core, result, identity)) throw unknownFailure();
  if (receipt.detail.fingerprint !== identity.fingerprint) throw businessError('CONFLICT', '此请求编号已用于不同核销内容，请先核对原请求结果');
  if (result.allocation.invoiceId !== identity.invoiceId || result.allocation.voucherId !== identity.voucherId) throw unknownFailure();
  return { receipt, core, result };
}
/** Historical ACK is read from the original two audits, never current ledger state. */
export async function readReceiptAllocationReplay(db: any, identity: Identity): Promise<Result | null> {
  const proof = await readProof(db, identity);
  return proof ? snapshot({ ...proof.result, replayed: true }) as Result : null;
}

/** Private same-invocation outcome evidence. Public error fields do not prove
 * rollback; this is not a cross-process exactly-once guarantee. */
export async function runReceiptAllocationAttempt(
  prisma: any, callback: (tx: any) => Promise<Result>, options: any, identity: Identity,
  isCallbackRefusal: (error: unknown) => boolean,
): Promise<Result> {
  let xid: string | undefined;
  let transactionEntered = false;
  let callbackError: unknown;
  let callbackFailed = false;
  let callbackReturned = false;
  let auditWriteFailed = false;
  let original: Result | undefined;
  let originalProof: Awaited<ReturnType<typeof readProof>> | undefined;
  let proofHash: string | undefined;
  try {
    const returned = await prisma.$transaction(async (tx: any) => {
      transactionEntered = true;
      try {
        const rows = await tx.$queryRawUnsafe('SELECT pg_current_xact_id()::text AS xid');
        const value = rows?.[0]?.xid;
        if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < BigInt('18446744073709551616')) xid = value;
      } catch { /* Missing own xid cannot certify an uncertain transaction. */ }
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
      let result: Result;
      try { result = await callback(observedTx); }
      catch (error) { callbackFailed = true; callbackError = error; throw error; }
      callbackReturned = true;
      // Mandatory evidence reads fail inside this transaction, so an ordinary
      // ACK cannot silently escape without its exact original audit contract.
      const captured: Result = snapshot(result);
      original = captured;
      originalProof = await readProof(tx, identity);
      // Receipt result intentionally excludes the live replay flag.
      const { replayed: _replayed, ...saved } = captured;
      if (!originalProof || canonical(originalProof.result) !== canonical(saved)) throw unknownFailure();
      proofHash = digest({ receipt: originalProof.receipt, core: originalProof.core });
      return result;
    }, options);
    if (!original || canonical(snapshot(returned)) !== canonical(original)) throw unknownFailure();
    return returned;
  } catch (error) {
    if (auditWriteFailed) throw unknownFailure();
    if (!transactionEntered) {
      // This attempt never ran its transaction callback. Only a complete
      // same-identity historical receipt can recover a previous committed ACK.
      try {
        const replay = await readReceiptAllocationReplay(prisma, identity);
        if (replay) return replay;
      } catch { /* Missing, invalid or unavailable proof stays unknown. */ }
      throw unknownFailure();
    }
    let state: string | undefined;
    if (xid) {
      try {
        const rows = await prisma.$queryRawUnsafe('SELECT $1::text AS xid, pg_xact_status($1::xid8)::text AS state', xid);
        if (Array.isArray(rows) && rows.length === 1 && rows[0]?.xid === xid) state = rows[0].state;
      } catch { /* A proof-read exception cannot borrow a genuine refusal. */ }
    }
    if (state === 'committed' && original && originalProof && proofHash) {
      try {
        const current = await readProof(prisma, identity);
        if (current && digest({ receipt: current.receipt, core: current.core }) === proofHash
            && canonical(current.receipt) === canonical(originalProof.receipt) && canonical(current.core) === canonical(originalProof.core)) return original;
      } catch { /* Bad or unavailable audit means an unknown outcome. */ }
      throw unknownFailure();
    }
    if (state === 'aborted') {
      if (callbackFailed && callbackError === error && isCallbackRefusal(error)) throw error;
      // A competing identical request can have committed the exact historical
      // result; its two original audits are positive proof, not absence proof.
      try {
        const replay = await readReceiptAllocationReplay(prisma, identity);
        if (replay) return replay;
      } catch { throw unknownFailure(); }
      if (!callbackReturned || (original && originalProof && proofHash)) throw abortedFailure();
    }
    throw unknownFailure();
  }
}
