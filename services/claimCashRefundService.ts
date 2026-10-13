import { settlementAmountUnits as units } from '../lib/settlementMoney';
export type ClaimCashRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type BankReturnInput = { expectedVersion: number; returnedPrincipal: string; receivedNet: string; bankFee: string;
  feeBearer: string | null; actualDate: string; actualMethod: string; bankReference: string; evidenceIds: string[]; receiptVoucherId?: string | null;
  companyAccountId?:string;expectedAccountRevision?:number };
export type BankReturnFact = { id: string; creditNoteId: string; refundId: string; customerRelationId: string; receiptVoucherId: string;
  returnedPrincipal: string; receivedNet: string; bankFee: string; feeBearer: string | null; currency: string; actualDate: string; actualMethod: string;
  bankReference: string; requestId: string; actorId: string; auditId: string; currentVersionId: string; currentVersionFingerprint: string;
  parametersHash: string; parameters: any; createdAt: string };
export type BankReturnHistory = { refund: { id: string; creditNoteId: string; customerRelationId: string; currency: string; amount: string; status: string };
  creditNote: { id: string; currency: string; openAmount: string }; items: BankReturnFact[];
  paidPrincipal: string; returnedPrincipalTotal: string; remainingReturnable: string; reservedAmount: string; availableToSettle: string;
  currentVersion: number; meaning: string };
export type ReturnReceipt = { id: string; voucherNumber: string; type: string; status: string; customerRelationId: string; currency: string;
  amount: string; bankFee: string | null; feeBearer: string | null; paymentDate: string; paymentMethod: string; invoiceId: string | null; appliedAmount: string | null;
  paymentReference: string | null; receivedNet: string | null; evidenceIds: string[] };
export type ReturnReceiptCandidates = { refundId: string; creditNoteId: string; customerRelationId: string; currency: string;
  meaning: 'unallocated_receipts_require_bank_fact_match'; items: ReturnReceipt[] };
const methods = ['TT', 'LC', 'OA', 'DP', 'DA', 'Cash', 'Other'];
export const cashRequestCanonical = (value: unknown) => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export async function cashRequestHash(value: unknown) {
  if (!crypto.subtle) throw Error('浏览器无法核验实际返款请求指纹，请保留原请求核对');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cashRequestCanonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function dateKey(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), date = new Date(0);
  date.setHours(12, 0, 0, 0); date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day;
}
export function validBankReturn(payload: BankReturnInput) {
  const principal = units(payload?.returnedPrincipal), net = units(payload?.receivedNet), fee = units(payload?.bankFee);
  return !!payload && Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion > 0 && principal != null && principal > 0n && net != null && fee != null
    && principal === net + fee && (fee === 0n && payload.feeBearer == null || ['OUR', 'BEN', 'SHA'].includes(payload.feeBearer!))
    && dateKey(payload.actualDate) && methods.includes(payload.actualMethod) && typeof payload.bankReference === 'string' && !!payload.bankReference.trim() && payload.bankReference.length <= 512
    && Array.isArray(payload.evidenceIds) && payload.evidenceIds.length > 0 && payload.evidenceIds.every(id => typeof id === 'string' && !!id.trim())
    && new Set(payload.evidenceIds).size === payload.evidenceIds.length && (payload.receiptVoucherId == null || typeof payload.receiptVoucherId === 'string' && !!payload.receiptVoucherId.trim());
}
const moneyText = (value: unknown) => {
  const amount = units(value); if (amount == null) throw Error('金额尚未确认');
  const fraction = (amount % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return (amount / 10000n).toString() + (fraction ? '.' + fraction : '');
};
export function normalizedBankReturn(payload: BankReturnInput, requestId: string) {
  if (!validBankReturn(payload)) throw Error('返款须有准确本金、净额、扣费、承担方、日期流水与私有证明');
  return { clientRequestId: requestId, expectedVersion: payload.expectedVersion, returnedPrincipal: moneyText(payload.returnedPrincipal), receivedNet: moneyText(payload.receivedNet),
    bankFee: moneyText(payload.bankFee), feeBearer: payload.feeBearer ?? null, actualDate: payload.actualDate, actualMethod: payload.actualMethod,
    bankReference: payload.bankReference.trim(), evidenceIds: [...payload.evidenceIds].sort(), receiptVoucherId: payload.receiptVoucherId ?? null,
    ...(payload.companyAccountId!=null?{companyAccountId:payload.companyAccountId,expectedAccountRevision:payload.expectedAccountRevision}:{}) };
}
function checkedFact(row: BankReturnFact, noteId: string, refundId: string, customerId: string, currency: string) {
  if (!row?.id || row.creditNoteId !== noteId || row.refundId !== refundId || row.customerRelationId !== customerId || row.currency !== currency
      || !row.receiptVoucherId || !row.actorId || !row.requestId || !row.auditId || !row.currentVersionId || !/^[a-f0-9]{64}$/.test(row.currentVersionFingerprint)
      || !/^[a-f0-9]{64}$/.test(row.parametersHash) || !/^\d+$/.test(String(row.createdAt)) || !row.parameters?.command
      || !validBankReturn(row.parameters.command) || units(row.returnedPrincipal) !== units(row.parameters.command.returnedPrincipal)
      || units(row.receivedNet) !== units(row.parameters.command.receivedNet) || units(row.bankFee) !== units(row.parameters.command.bankFee)
      || row.actualDate !== row.parameters.command.actualDate || row.actualMethod !== row.parameters.command.actualMethod || row.bankReference !== row.parameters.command.bankReference
      || row.feeBearer !== row.parameters.command.feeBearer || row.requestId !== row.parameters.command.clientRequestId) throw Error('实际返款记录或原事实尚未确认，请重新加载');
  return row;
}
export function checkedBankReturnHistory(value: BankReturnHistory, noteId: string, refundId: string, currency: string) {
  if (value?.refund?.id !== refundId || value.refund.creditNoteId !== noteId || value.refund.currency !== currency || value.refund.status !== 'Paid'
      || !value.refund.customerRelationId || value.creditNote?.id !== noteId || value.creditNote.currency !== currency || !Array.isArray(value.items)
      || value.meaning !== 'recorded_bank_return_only' || !Number.isSafeInteger(value.currentVersion) || value.currentVersion < 1) throw Error('实际返款来源或当前有效版本尚未确认');
  const paid = units(value.paidPrincipal), returned = units(value.returnedPrincipalTotal), remaining = units(value.remainingReturnable), reserved = units(value.reservedAmount), available = units(value.availableToSettle), open = units(value.creditNote.openAmount);
  if (paid == null || paid <= 0n || paid !== units(value.refund.amount) || returned == null || remaining == null || remaining + returned !== paid
      || reserved == null || available == null || open == null || reserved + available !== open) throw Error('实际返款及贷项余额尚未确认，不可从浏览器恢复余额');
  let sum = 0n;
  for (const row of value.items) { checkedFact(row, noteId, refundId, value.refund.customerRelationId, currency); sum += units(row.returnedPrincipal)!; }
  if (sum !== returned || new Set(value.items.map(row => row.id)).size !== value.items.length) throw Error('实际返款合计与完整历史不一致');
  return value;
}
export function receiptMatchesReturn(row: ReturnReceipt, payload: BankReturnInput, customerId: string, currency: string) {
  return !!row?.id && row.type === 'Receipt' && row.status === 'unreconciled' && row.customerRelationId === customerId && row.currency === currency
    && row.invoiceId === null && row.appliedAmount === null && units(row.amount) === units(payload.returnedPrincipal) && units(row.bankFee) === units(payload.bankFee)
    && row.feeBearer === payload.feeBearer && row.paymentDate === payload.actualDate && row.paymentMethod === payload.actualMethod
    && row.paymentReference === payload.bankReference.trim() && row.receivedNet != null && units(row.receivedNet) === units(payload.receivedNet)
    && Array.isArray(row.evidenceIds) && cashRequestCanonical([...row.evidenceIds].sort()) === cashRequestCanonical([...payload.evidenceIds].sort());
}
export async function validBankReturnAcknowledgement(value: any, requestId: string, payload: BankReturnInput, identity: { actorId: string; noteId: string; refundId: string; customerId: string; currency: string }) {
  const row = checkedFact(value?.cashReturn, identity.noteId, identity.refundId, identity.customerId, identity.currency);
  const command = normalizedBankReturn(payload, requestId), wire = { ...payload, clientRequestId: requestId }, envelope = row.parameters.requestEnvelope;
  return value?.refund?.id === identity.refundId && value.refund.status === 'Paid' && value.refund.creditNoteId === identity.noteId
    && row.actorId === identity.actorId && row.requestId === requestId && value.receiptVoucher?.id === row.receiptVoucherId && value.receiptVoucher.type === 'Receipt'
    && value.receiptVoucher.customerRelationId === identity.customerId && value.receiptVoucher.currency === identity.currency && units(value.receiptVoucher.amount) === units(payload.returnedPrincipal)
    && value.receiptVoucher.status === 'reconciled' && !!value.settlementEventId && row.parametersHash === await cashRequestHash(row.parameters)
    && cashRequestCanonical(row.parameters.command) === cashRequestCanonical(command) && envelope?.schemaVersion === 1 && envelope.action === 'return'
    && envelope.originalClientRequestId === requestId && envelope.originalParameterHash === await cashRequestHash(wire) && cashRequestCanonical(envelope.originalPayload) === cashRequestCanonical(wire);
}
export function createClaimCashRefundClient(request: ClaimCashRequest) {
  return {
    returns: async (id: string, noteId: string, currency: string) => checkedBankReturnHistory(await request<BankReturnHistory>(`/v1/credit-note-refunds/${encodeURIComponent(id)}/returns`), noteId, id, currency),
    receipts: async (id: string, noteId: string, customerId: string, currency: string) => {
      const value = await request<ReturnReceiptCandidates>(`/v1/credit-note-refunds/${encodeURIComponent(id)}/return-receipts`);
      if (value?.refundId !== id || value.creditNoteId !== noteId || value.customerRelationId !== customerId || value.currency !== currency || !Array.isArray(value.items)
          || value.meaning !== 'unallocated_receipts_require_bank_fact_match') throw Error('原收款候选来源尚未确认，请从财务核对，不能浏览器补关联');
      return value;
    },
  };
}
