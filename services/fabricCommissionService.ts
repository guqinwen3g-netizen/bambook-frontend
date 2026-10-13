import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { beginBusinessRequest, readBusinessRequest, listBusinessRequests, clearAcknowledgedBusinessRequest } from './businessRequestRecovery';
import { isValidLocalDateKey } from '../lib/businessClock';
import { financeContextIdentity } from './financeContextIdentity';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';

export type FabricCommissionLine = { orderLineId: string; description: string | null; actualQuantity: string; unit: string;
  unitPrice: string; actualGoodsAmount: string; rate: string; commissionAmount: string; shipmentLineIds: string[] };
export type FabricCommissionGroup = { supplierId: string; party: { id: string; name: string; address: string | null; taxId: string | null };
  goodsAmount: string; commissionAmount: string; lines: FabricCommissionLine[] };
export type FabricCommissionSource = { schemaVersion: 1; sourceType: 'FabricCommissionCI'; orderId: string; orderNumber: string;
  poNumber: string | null; customerId: string; currency: string; approvalId: string; approvalAuditId: string; approvalFingerprint: string;
  sourceFingerprint: string; groups: FabricCommissionGroup[]; branches: Array<{ id: string; orderLineId: string; revision: number; unit: string; actualQuantity: string; shippedQuantity: string }>;
  shipments: Array<{ shipmentId: string; shipmentLineId: string; orderLineId: string; quantity: string; unit: string; atd: string; state: 'shipped' }> };
export type FabricCommissionReceipt = { settlementId: string; orderId: string; sourceFingerprint: string; auditId: string; requestKey: string;
  documents: Array<{ supplierId: string; documentId: string; versionId: string; documentNumber: string; amount: string; currency: string }> };
export type FabricCommissionDocument = { document: { id: string; documentNumber: string; orderId: string; currency: string; totalAmount: string; issueDate: string };
  version: { id: string; documentId: string; version: 1 }; snapshot: { source: FabricCommissionSource; supplierId: string; settlementId: string; dueDate: string | null; issuedAt: string; issuedBy: string };
  group: FabricCommissionGroup; receipt: FabricCommissionReceipt };
export type FabricCommissionInvoice = { id: string; invoiceNumber: string; type: 'Receivable'; status: string; amount: string; currency: string;
  customerRelationId: string; customerName: string; sourceType: 'FabricCommissionCI'; sourceId: string; orderId: string };
export type FabricCommissionPendingCi = { documentId: string; documentNumber: string; versionId: string; orderId: string; orderNumber: string;
  poNumber: string | null; supplierId: string; supplierName: string; amount: string; currency: string; issueDate: string; sourceFingerprint: string };
export type FabricCommissionSettlement = { settled: false; source: FabricCommissionSource } | { settled: true; receipt: FabricCommissionReceipt; documents: FabricCommissionDocument[] };
export type FabricCommissionSettlementFields = { expectedSourceFingerprint: string; dueDate?: string | null; note?: string | null };
export type FabricCommissionReceiptParty = { invoiceId: string; versionId: string; orderId: string; supplierId: string; supplierName: string; currency: string };
/** A list row is only a display/receipt anchor; the server revalidates its original source on consumption. */
export function isFabricCommissionInvoice(value: unknown): boolean {
  return record(value) && value.sourceType === 'FabricCommissionCI';
}
export function fabricCommissionReceiptParty(value: unknown): FabricCommissionReceiptParty | null {
  if (!record(value) || value.sourceType !== 'FabricCommissionCI' || value.type !== 'Receivable'
    || !text(value.id) || !text(value.sourceId) || !text(value.orderId) || !text(value.customerRelationId)
    || !text(value.customerName) || !text(value.currency) || !['Issued', 'PartiallyPaid', 'Paid'].includes(String(value.status))) return null;
  return { invoiceId: value.id, versionId: value.sourceId, orderId: value.orderId, supplierId: value.customerRelationId,
    supplierName: value.customerName, currency: value.currency };
}
export function fabricSupplyTermsError(line: { fabricSupplyMode?: string | null; fabricCommissionRate?: string | null; fabricCommissionSupplierId?: string | null }): string | null {
  if (line.fabricSupplyMode !== 'commission') return null;
  const rate = line.fabricCommissionRate?.trim() ?? '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 100)
    return '佣金模式请填写大于 0 且不超过 100% 的实际佣金率，最多四位小数。';
  if (!line.fabricCommissionSupplierId?.trim()) return '佣金模式请明确真实付款供应商。';
  return null;
}
type SettlementIntent = { orderId: string; input: { expectedSourceFingerprint: string; dueDate: string | null; note: string | null } };
type RegistrationIntent = { documentId: string; expectedVersionId: string; expectedSourceFingerprint: string; orderId: string; supplierId: string; amount: string; currency: string };
export class FabricCommissionError extends Error { constructor(message: string, readonly status = 0) { super(message); } }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const fingerprint = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const invalid = (message = '佣金来源或原票回执不完整，请重新读取核对。'): never => { throw new FabricCommissionError(message); };
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
const digest = async (v: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(v)))))].map(b => b.toString(16).padStart(2, '0')).join('');
function money(v: unknown): string {
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(String(v))) return invalid();
  const [whole, fraction = ''] = String(v).split('.'); return `${whole}.${fraction.padEnd(4, '0')}`;
}
function strings(v: unknown): string[] { if (!Array.isArray(v) || !v.length || v.some(s => !text(s)) || new Set(v).size !== v.length) return invalid(); return v as string[]; }
export function fabricCommissionIdentity() {
  return financeContextIdentity();
}
function watchCommissionContext(listener: () => void) {
  financeContextIdentity(); const stop = subscribe(listener);
  if (typeof window !== 'undefined') { window.addEventListener('storage', listener); window.addEventListener('focus', listener); window.addEventListener(EMAIL_CONTEXT_EVENT, listener); }
  return () => { stop(); if (typeof window !== 'undefined') { window.removeEventListener('storage', listener); window.removeEventListener('focus', listener); window.removeEventListener(EMAIL_CONTEXT_EVENT, listener); } };
}
function context(permission: string) {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !auth.user?.id) throw new FabricCommissionError('请重新登录后核对佣金原票。', 401);
  if (!hasPermission(permission)) throw new FabricCommissionError('当前账号没有本操作权限。', 403);
  return { identity: fabricCommissionIdentity(), actorId: auth.user.id, base: apiService.getStoredConfig().cloudEndpoint, headers: apiService.getAuthHeaders(), permission };
}
function current(c: ReturnType<typeof context>) {
  if (fabricCommissionIdentity() !== c.identity || !hasPermission(c.permission)) throw new FabricCommissionError('账号、权限或服务地址已变化，请保留原请求并重新读取。', 403);
}
async function call(path: string, permission: string, body?: unknown) {
  const c = context(permission), response = await fetch(apiService.buildApiUrl(path, c.base), { method: body === undefined ? 'GET' : 'POST',
    headers: { ...c.headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  current(c); const data: unknown = await response.json().catch(() => null); current(c);
  if (!response.ok) throw new FabricCommissionError(record(data) && record(data.error) && text(data.error.message) ? data.error.message : `佣金操作未完成（HTTP ${response.status}）。`, response.status);
  if (!record(data) || data.ok !== true || data.error) return invalid('佣金回执尚未确认，请保留原请求核对。');
  return { c, data };
}
async function source(value: unknown, orderId?: string): Promise<FabricCommissionSource> {
  if (!record(value) || value.schemaVersion !== 1 || value.sourceType !== 'FabricCommissionCI' || !text(value.orderId) || orderId !== undefined && value.orderId !== orderId
    || !text(value.orderNumber) || !(value.poNumber === null || typeof value.poNumber === 'string') || !text(value.customerId) || !text(value.currency)
    || !text(value.approvalId) || !text(value.approvalAuditId) || !fingerprint(value.approvalFingerprint) || !fingerprint(value.sourceFingerprint)
    || !Array.isArray(value.groups) || !value.groups.length || !Array.isArray(value.branches) || !value.branches.length
    || !Array.isArray(value.shipments) || !value.shipments.length || !Array.isArray(value.financialLines) || !value.financialLines.length
    || value.financialLines.some(v => !record(v) || !text(v.id) || v.orderId !== value.orderId)
    || !Array.isArray(value.departureEvents) || !value.departureEvents.length) return invalid();
  const { sourceFingerprint, ...facts } = value;
  if (await digest(facts) !== sourceFingerprint) return invalid('佣金来源指纹不一致，请重新读取。');
  const groups: FabricCommissionGroup[] = value.groups.map(v => {
    if (!record(v) || !text(v.supplierId) || !record(v.party) || v.party.id !== v.supplierId || !text(v.party.name)
      || !(v.party.address === null || typeof v.party.address === 'string') || !(v.party.taxId === null || typeof v.party.taxId === 'string')
      || !Array.isArray(v.lines) || !v.lines.length) return invalid();
    const lines: FabricCommissionLine[] = v.lines.map(line => {
      if (!record(line) || !text(line.orderLineId) || !text(line.unit) || !(line.description === null || typeof line.description === 'string')
        || !text(line.rate)) return invalid();
      return { orderLineId: line.orderLineId, description: line.description, actualQuantity: money(line.actualQuantity), unit: line.unit,
        unitPrice: money(line.unitPrice), actualGoodsAmount: money(line.actualGoodsAmount), rate: line.rate, commissionAmount: money(line.commissionAmount), shipmentLineIds: strings(line.shipmentLineIds) };
    });
    return { supplierId: v.supplierId, party: { id: v.supplierId, name: v.party.name, address: v.party.address, taxId: v.party.taxId },
      goodsAmount: money(v.goodsAmount), commissionAmount: money(v.commissionAmount), lines };
  });
  if (new Set(groups.map(g => g.supplierId)).size !== groups.length) return invalid();
  const branches = value.branches.map(v => {
    if (!record(v) || !text(v.id) || !text(v.orderLineId) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || !text(v.unit)) return invalid();
    return { id: v.id, orderLineId: v.orderLineId, revision: Number(v.revision), unit: v.unit, actualQuantity: money(v.actualQuantity), shippedQuantity: money(v.shippedQuantity) };
  });
  const shipments = value.shipments.map(v => {
    if (!record(v) || !text(v.shipmentId) || !text(v.shipmentLineId) || !text(v.orderLineId) || !text(v.unit) || v.state !== 'shipped' || !isValidLocalDateKey(v.atd)) return invalid();
    return { shipmentId: v.shipmentId, shipmentLineId: v.shipmentLineId, orderLineId: v.orderLineId, quantity: money(v.quantity), unit: v.unit, atd: String(v.atd), state: 'shipped' as const };
  });
  return { schemaVersion: 1, sourceType: 'FabricCommissionCI', orderId: value.orderId, orderNumber: value.orderNumber, poNumber: value.poNumber,
    customerId: value.customerId, currency: value.currency, approvalId: value.approvalId, approvalAuditId: value.approvalAuditId,
    approvalFingerprint: value.approvalFingerprint, sourceFingerprint, groups, branches, shipments };
}
function receipt(value: unknown): FabricCommissionReceipt {
  if (!record(value) || !text(value.settlementId) || !text(value.orderId) || !fingerprint(value.sourceFingerprint) || value.auditId !== value.settlementId
    || !text(value.requestKey) || !Array.isArray(value.documents) || !value.documents.length) return invalid();
  const documents = value.documents.map(v => {
    if (!record(v) || !text(v.supplierId) || !text(v.documentId) || !text(v.versionId) || !text(v.documentNumber) || !text(v.currency)) return invalid();
    return { supplierId: v.supplierId, documentId: v.documentId, versionId: v.versionId, documentNumber: v.documentNumber, amount: money(v.amount), currency: v.currency };
  });
  if (['supplierId', 'documentId', 'versionId'].some(key => new Set(documents.map(v => v[key as keyof typeof v])).size !== documents.length)) return invalid();
  return { settlementId: value.settlementId, orderId: value.orderId, sourceFingerprint: value.sourceFingerprint, auditId: value.settlementId, requestKey: value.requestKey, documents };
}
async function original(value: unknown, expectedId?: string, fallbackReceipt?: FabricCommissionReceipt): Promise<FabricCommissionDocument> {
  if (!record(value) || !record(value.document) || !record(value.version) || !record(value.snapshot)) return invalid();
  const d = value.document, v = value.version, s = value.snapshot;
  const facts = await source(s.source), r = value.receipt ? receipt(value.receipt) : fallbackReceipt;
  const group = facts.groups.find(g => g.supplierId === s.supplierId), ref = r?.documents.find(row => row.documentId === d.id);
  if (!text(d.id) || expectedId !== undefined && d.id !== expectedId || !text(d.documentNumber) || d.domain !== 'finance' || d.type !== 'CommercialInvoice'
    || d.status !== 'Issued' || d.orderId !== facts.orderId || d.currency !== facts.currency || d.relationId !== s.supplierId
    || d.sourceRef !== `fabric-commission:v1:${facts.orderId}:${String(s.supplierId)}` || !isValidLocalDateKey(d.issueDate)
    || !text(v.id) || v.documentId !== d.id || v.version !== 1 || s.schemaVersion !== 1 || s.sourceType !== 'FabricCommissionCI'
    || !text(s.issuedAt) || !text(s.issuedBy) || !r || r.orderId !== facts.orderId || r.sourceFingerprint !== facts.sourceFingerprint || r.settlementId !== s.settlementId
    || !(s.dueDate === null || isValidLocalDateKey(s.dueDate)) || !group || !ref || ref.versionId !== v.id || ref.documentNumber !== d.documentNumber
    || ref.supplierId !== group.supplierId || ref.currency !== facts.currency || money(d.totalAmount) !== group.commissionAmount || ref.amount !== group.commissionAmount) return invalid('佣金原票的准确版本、金额或付款方尚未核对。');
  return { document: { id: d.id, documentNumber: d.documentNumber, orderId: facts.orderId, currency: facts.currency, totalAmount: money(d.totalAmount), issueDate: String(d.issueDate) },
    version: { id: v.id, documentId: d.id, version: 1 }, snapshot: { source: facts, supplierId: group.supplierId, settlementId: r.settlementId, dueDate: s.dueDate as string | null, issuedAt: s.issuedAt, issuedBy: s.issuedBy }, group, receipt: r };
}
function invoice(value: unknown, doc: FabricCommissionDocument): FabricCommissionInvoice {
  if (!record(value) || !text(value.id) || value.invoiceNumber !== doc.document.documentNumber || value.type !== 'Receivable'
    || !['Issued', 'PartiallyPaid', 'Paid'].includes(String(value.status)) || value.sourceType !== 'FabricCommissionCI' || value.sourceId !== doc.version.id
    || value.orderId !== doc.snapshot.source.orderId || value.customerRelationId !== doc.group.supplierId || value.customerName !== doc.group.party.name
    || value.currency !== doc.document.currency || money(value.amount) !== doc.group.commissionAmount) return invalid('佣金应收与准确原票、金额或供应商付款方不一致。');
  return { id: value.id, invoiceNumber: doc.document.documentNumber, type: 'Receivable', status: String(value.status), amount: money(value.amount), currency: doc.document.currency,
    customerRelationId: doc.group.supplierId, customerName: doc.group.party.name, sourceType: 'FabricCommissionCI', sourceId: doc.version.id, orderId: doc.snapshot.source.orderId };
}
async function acknowledged(data: Record<string, unknown>, c: ReturnType<typeof context>, kind: string, input: Record<string, unknown>, targetId: string | null) {
  const m = data.financeCommand;
  if (!record(m) || m.protocolVersion !== 1 || m.actorId !== c.actorId || m.kind !== kind || m.requestKey !== input.requestKey
    || !text(data.auditId) || m.auditId !== data.auditId || m.targetId !== targetId || !record(m.resultSnapshot)
    || m.commandHash !== await digest({ kind, input }) || m.resultHash !== await digest(m.resultSnapshot)) return invalid('佣金原请求回执尚未确认，请保留原内容重试。');
  const { financeCommand: _metadata, ok: _ok, replayed: _replay, ...body } = data;
  const { replayed: _storedReplay, ...stored } = m.resultSnapshot;
  if (await digest(body) !== await digest(stored) || typeof data.replayed !== 'boolean') return invalid('佣金原请求回执内容不一致，请保留原内容核对。');
  current(c);
}
const settleOperation = (id: string) => `fabric-commission-settle:${id}`;
const registerOperation = (id: string) => `fabric-commission-register:${id}`;
function settlementIntent(value: unknown, orderId: string): SettlementIntent {
  if (!record(value) || value.orderId !== orderId || !record(value.input) || !fingerprint(value.input.expectedSourceFingerprint)
    || !(value.input.dueDate === null || isValidLocalDateKey(value.input.dueDate)) || !(value.input.note === null || typeof value.input.note === 'string')) return invalid('原佣金请求记录不完整，请先核对原结果。');
  return { orderId, input: { expectedSourceFingerprint: value.input.expectedSourceFingerprint, dueDate: value.input.dueDate as string | null, note: value.input.note as string | null } };
}
function registrationIntent(value: unknown): RegistrationIntent {
  if (!record(value) || !text(value.documentId) || !text(value.expectedVersionId) || !fingerprint(value.expectedSourceFingerprint)
    || !text(value.orderId) || !text(value.supplierId) || !text(value.currency)) return invalid('原佣金登记请求记录不完整，请先核对原结果。');
  return { documentId: value.documentId, expectedVersionId: value.expectedVersionId, expectedSourceFingerprint: value.expectedSourceFingerprint,
    orderId: value.orderId, supplierId: value.supplierId, amount: money(value.amount), currency: value.currency };
}
async function submitSettlement(pending: ReturnType<typeof beginBusinessRequest<SettlementIntent>>) {
  const intent = settlementIntent(pending.payload, pending.payload.orderId), input = { ...intent.input, requestKey: pending.requestId };
  const { c, data } = await call(`/v1/orders/${encodeURIComponent(intent.orderId)}/fabric-commission/settle`, 'orders:read', input);
  const r = receipt(data.receipt);
  if (r.orderId !== intent.orderId || r.sourceFingerprint !== intent.input.expectedSourceFingerprint || r.requestKey !== pending.requestId || !Array.isArray(data.documents)) return invalid('佣金原请求回执与准确来源不一致。');
  const documents = await Promise.all(data.documents.map(v => original(v, undefined, r)));
  if (documents.length !== r.documents.length || new Set(documents.map(d => d.document.id)).size !== documents.length) return invalid();
  await acknowledged(data, c, 'fabric_commission.settle', { orderId: intent.orderId, ...input }, null);
  clearAcknowledgedBusinessRequest(settleOperation(intent.orderId), pending.requestId);
  return { receipt: r, documents, replayed: data.replayed === true };
}
async function submitRegistration(pending: ReturnType<typeof beginBusinessRequest<RegistrationIntent>>) {
  const intent = registrationIntent(pending.payload), input = { expectedVersionId: intent.expectedVersionId, expectedSourceFingerprint: intent.expectedSourceFingerprint, requestKey: pending.requestId };
  const { c, data } = await call(`/v1/finance/fabric-commission-cis/${encodeURIComponent(intent.documentId)}/register`, 'invoices:read', input);
  const doc = await original(data, intent.documentId), inv = invoice(data.invoice, doc);
  if (doc.version.id !== intent.expectedVersionId || doc.snapshot.source.sourceFingerprint !== intent.expectedSourceFingerprint || doc.snapshot.source.orderId !== intent.orderId
    || inv.customerRelationId !== intent.supplierId || inv.amount !== intent.amount || inv.currency !== intent.currency) return invalid('佣金登记回执与已核对原票不一致。');
  await acknowledged(data, c, 'fabric_commission.register', { documentId: intent.documentId, ...input }, inv.id);
  clearAcknowledgedBusinessRequest(registerOperation(intent.documentId), pending.requestId);
  return { ...doc, invoice: inv, replayed: data.replayed === true };
}
export const fabricCommissionService = {
  watch: watchCommissionContext,
  identity: fabricCommissionIdentity,
  async read(orderId: string): Promise<FabricCommissionSettlement> {
    const { c, data } = await call(`/v1/orders/${encodeURIComponent(orderId)}/fabric-commission`, 'orders:read');
    if (data.settled === false) { const facts = await source(data.source, orderId); if (data.sourceFingerprint !== facts.sourceFingerprint) return invalid(); current(c); return { settled: false, source: facts }; }
    if (data.settled !== true || !Array.isArray(data.documents)) return invalid();
    const r = receipt(data.receipt), documents = await Promise.all(data.documents.map(v => original(v)));
    if (r.orderId !== orderId || documents.length !== r.documents.length || new Set(documents.map(d => d.document.id)).size !== documents.length
      || documents.some(d => d.snapshot.source.orderId !== orderId || JSON.stringify(canonical(d.receipt)) !== JSON.stringify(canonical(r)))) return invalid();
    current(c); return { settled: true, receipt: r, documents };
  },
  pendingSettlement(orderId: string) { const pending = readBusinessRequest<SettlementIntent>(settleOperation(orderId)); if (pending) settlementIntent(pending.payload, orderId); return pending; },
  async settle(orderId: string, fields: FabricCommissionSettlementFields) {
    context('orders:write');
    const payload = settlementIntent({ orderId, input: { expectedSourceFingerprint: fields.expectedSourceFingerprint, dueDate: fields.dueDate || null, note: fields.note || null } }, orderId);
    return submitSettlement(beginBusinessRequest(settleOperation(orderId), payload));
  },
  async retrySettlement(orderId: string) { const pending = this.pendingSettlement(orderId); if (!pending) return invalid('没有待核对的原佣金请求。'); return submitSettlement(pending); },
  async document(documentId: string) {
    const { c, data } = await call(`/v1/finance/fabric-commission-cis/${encodeURIComponent(documentId)}`, 'invoices:read');
    const doc = await original(data, documentId), inv = data.invoice == null ? null : invoice(data.invoice, doc); current(c); return { ...doc, invoice: inv };
  },
  async pending(): Promise<FabricCommissionPendingCi[]> {
    const { c, data } = await call('/v1/finance/fabric-commission-cis', 'invoices:read');
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total !== data.items.length) return invalid();
    const items = data.items.map(v => {
      if (!record(v) || !text(v.documentId) || !text(v.documentNumber) || !text(v.versionId) || !text(v.orderId) || !text(v.orderNumber)
        || !(v.poNumber === null || typeof v.poNumber === 'string') || !text(v.supplierId) || !text(v.supplierName) || !text(v.currency) || !isValidLocalDateKey(v.issueDate) || !fingerprint(v.sourceFingerprint)) return invalid();
      return { documentId: v.documentId, documentNumber: v.documentNumber, versionId: v.versionId, orderId: v.orderId, orderNumber: v.orderNumber,
        poNumber: v.poNumber, supplierId: v.supplierId, supplierName: v.supplierName, amount: money(v.amount), currency: v.currency, issueDate: String(v.issueDate), sourceFingerprint: v.sourceFingerprint };
    });
    if (new Set(items.map(item => item.documentId)).size !== items.length) return invalid(); current(c); return items;
  },
  pendingRegistrations() { return listBusinessRequests<RegistrationIntent>('fabric-commission-register:').map(v => ({ ...v, record: { ...v.record, payload: registrationIntent(v.record.payload) } })); },
  async register(doc: FabricCommissionDocument) {
    context('invoices:write');
    const payload: RegistrationIntent = { documentId: doc.document.id, expectedVersionId: doc.version.id, expectedSourceFingerprint: doc.snapshot.source.sourceFingerprint,
      orderId: doc.snapshot.source.orderId, supplierId: doc.group.supplierId, amount: doc.group.commissionAmount, currency: doc.document.currency };
    return submitRegistration(beginBusinessRequest(registerOperation(doc.document.id), payload));
  },
  async retryRegistration(documentId: string) { const pending = readBusinessRequest<RegistrationIntent>(registerOperation(documentId)); if (!pending) return invalid('没有待核对的原佣金登记。'); return submitRegistration(pending); },
  async preview(orderId: string, documentId: string) {
    const c = context('orders:read'), response = await fetch(apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(orderId)}/fabric-commission/documents/${encodeURIComponent(documentId)}/html`, c.base), { headers: c.headers });
    current(c); if (!response.ok) throw new FabricCommissionError('原佣金票暂不可读取，请核对订单权限。', response.status);
    const html = await response.text(); current(c);
    if (!response.headers.get('content-type')?.includes('text/html') || !html.includes('FABRIC COMMISSION')) return invalid('原佣金票预览尚未核对。');
    return html;
  },
};
