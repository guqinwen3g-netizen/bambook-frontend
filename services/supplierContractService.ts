import { apiService } from './apiService';
import { getAuthState } from './authService';
import { beginBusinessRequest, clearAcknowledgedBusinessRequest, listBusinessRequests, readBusinessRequest } from './businessRequestRecovery';

export type SupplierContractKind = 'purchase' | 'processing';
export type SupplierLocation = { kind: 'supplier' | 'warehouse' | 'external'; relationId?: string; warehouseId?: string; name?: string; address: string };
export type SupplierLine = { id?: string; orderLineId: string; kind?: 'Material' | 'FinishedGoods'; category?: string; processType?: string;
  materialCode?: string; description: string; specification?: string; quantity: string; unit: string; unitPrice: string; amount?: string;
  requestedDeliveryDate: string | null; notes?: string; demandId?: string; demandRevision?: number;
  costItemName?: string; includedInCmtPrice?: boolean; cmtIncludedItemsReviewed?: string[];
  inputSource?: { kind: 'purchase_contract'; contractId: string; lineId: string } | { kind: 'warehouse'; inventoryItemId: string } | { kind: 'customer_supplied'; relationId: string } };
export type SupplierDraft = { contractKind?: SupplierContractKind; supplierRelationId: string; currency: string; paymentTerms: string | null; mainDeliveryLocation: SupplierLocation | null;
  orderDate: string; deliveryTerms?: string; notes?: string; totalAmount?: string; lines: SupplierLine[];
  sourceProofs?: Array<{ orderId: string; orderLineId: string; businessLine: string; commercial: { order?: { code?: string; poNumber?: string | null; customerRelationId?: string | null } } }> };
export type SupplierRevision = { id: string; revision: number; status: string; contentFingerprint: string; snapshot: SupplierDraft; approvalRequestId?: string | null; createdAt?: string; decidedAt?: string | null };
export type SupplierFact = { id: string; kind: 'purchase_delivery' | 'processing_input' | 'processing_return'; orderLineId: string; purchaseLineId?: string | null;
  outsourcingLineId?: string | null; commitmentRevisionId: string; quantity: string; unit: string; occurredAt: string; recordedBy: string; recordedAt: string;
  sourceFactId?: string | null; sourceStockMovementId?: string | null; materialReceiptId?: string | null; fromKind: string; toKind: string;
  toRelationId?: string | null; toWarehouseId?: string | null; evidence?: string[]; notes?: string | null };
export type SupplierContract = { id: string; contractKind: SupplierContractKind; number: string; status: string; approvalState: string; latestRevisionId: string | null;
  latestRevision: number; draft: SupplierDraft | null; approvedRevision: SupplierRevision | null; fulfillments: SupplierFact[]; businessOwnerId?: string | null; legacyBasisUnknown: boolean;
  offlineHistory: Array<{ id: string; operation: string; recordedBy: string; recordedAt: string; data: Record<string, unknown> }> };
export type SupplierSource = { id: string; orderId: string; lineNumber: number; description: string; materialCode?: string | null; quantity: string; unit: string;
  fulfillmentMode?: string | null; cmtIncludedItems?: string[] | null; order: { id: string; code: string; poNumber: string | null; customer: string; businessLine?: string | null; type: string; status: string } };
export type SupplierFulfillment = { contractId: string; contractKind: SupplierContractKind; approvedRevisionId: string | null; facts: SupplierFact[];
  lines: Array<{ lineId: string; orderLineId: string; plannedQuantity: string; unit: string; deliveredQuantity?: string; returnedQuantity?: string;
    inputQuantities?: Array<{ quantity: string; unit: string }>; differenceFromPlan: string; varianceStatus: string; facts: SupplierFact[] }> };
export type SupplierCommandAck = { schemaVersion: 1; requestKey: string; operation: string; contractKind: SupplierContractKind; contractId: string; receiptId: string;
  revisionId?: string; approvalId?: string; factIds?: string[]; documentId?: string };
export type SupplierCommandResponse = { ok: true; item: Record<string, unknown>; commandAck: SupplierCommandAck };
export type SupplierSession = { actorId: string; endpoint: string; headers: Record<string, string>; identity: string };
export type SupplierIntent = { kind: SupplierContractKind; id: string | null; action: SupplierAction; body: Record<string, unknown> };
export type SupplierAction = 'create' | 'draft' | 'amendments' | 'merge-demands' | 'submit' | 'record-offline-send' | 'supplier-feedback' | 'fulfillments' | 'generate-document';
const operations: Record<SupplierAction, string> = { create: 'create_draft', draft: 'save_draft', amendments: 'amend_draft', 'merge-demands': 'merge_draft', submit: 'submit_commitment',
  'record-offline-send': 'record_offline_send', 'supplier-feedback': 'record_supplier_feedback', fulfillments: 'record_fulfillment', 'generate-document': 'generate_document' };
const object = (value: unknown): Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const path = (kind: SupplierContractKind, id?: string | null) => `/v1/procurement/contracts/${kind}${id ? '/' + encodeURIComponent(id) : ''}`;
export function supplierSession(): SupplierSession {
  const auth = getAuthState(), endpoint = apiService.getStoredConfig().cloudEndpoint, headers = apiService.getAuthHeaders();
  const actorId = auth.isAuthenticated ? auth.user?.id ?? '' : '';
  return { actorId, endpoint, headers, identity: JSON.stringify([actorId, apiService.buildApiUrl('/v1', endpoint), headers, auth.user?.roles ?? [], auth.user?.permissions ?? [], auth.user?.permissionCeiling ?? null]) };
}
export const supplierSessionCurrent = (original: SupplierSession) => !!original.actorId && original.identity === supplierSession().identity;
const check = (original: SupplierSession) => { if (!supplierSessionCurrent(original)) throw new Error('账号、权限或数据中心已变化，请重新读取当前合同。'); };
export function supplierCapability(scope = 'procurement:write'): boolean {
  const auth = getAuthState(), user = auth.user;
  return auth.isAuthenticated && !!user && (user.permissions.includes(scope) || user.permissions.includes('*'))
    && (user.permissionCeiling === undefined || user.permissionCeiling.includes(scope) || user.permissionCeiling.includes('*'));
}
export class SupplierHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'SupplierHttpError'; }
}
async function request(url: string, method = 'GET', body?: unknown, original = supplierSession()): Promise<Record<string, unknown>> {
  check(original);
  const response = await fetch(apiService.buildApiUrl(url, original.endpoint), { method, headers: original.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  check(original); const data = object(await response.json().catch(() => null)); check(original);
  if (!response.ok) { const error = object(data.error); throw new SupplierHttpError(typeof error.message === 'string' ? error.message : typeof data.error === 'string' ? data.error : '合同操作未完成，请保留原请求核对。', response.status,
    typeof data.code === 'string' ? data.code : typeof error.code === 'string' ? error.code : undefined); }
  if (data.ok !== true) throw new Error('服务回执不完整，结果尚未确认，请保留原请求重试。');
  return data;
}
export function readSupplierContract(value: unknown, kind: SupplierContractKind, id?: string): SupplierContract {
  const row = object(value), draft = object(row.draft);
  if (!validId(row.id) || id && row.id !== id || row.contractKind !== kind || !validId(row.number)
    || !Number.isSafeInteger(row.latestRevision) || !Array.isArray(draft.lines) || !Array.isArray(row.fulfillments) || !Array.isArray(row.offlineHistory))
    throw new Error('准确合同与条目读回不完整，请刷新。');
  return row as SupplierContract;
}
export function verifySupplierCommand(value: unknown, intent: SupplierIntent, requestKey: string): SupplierCommandResponse {
  const data = object(value), ack = object(data.commandAck), item = object(data.item);
  if (data.ok !== true || ack.schemaVersion !== 1 || ack.requestKey !== requestKey || ack.operation !== operations[intent.action]
    || ack.contractKind !== intent.kind || !validId(ack.contractId) || intent.id && ack.contractId !== intent.id || !validId(ack.receiptId)
    || !validId(ack.revisionId)) throw new Error('回执与原准确合同/版本/请求不一致，结果尚未确认，请保留原请求。');
  if (intent.action === 'create' || intent.action === 'draft' || intent.action === 'amendments' || intent.action === 'merge-demands') {
    const contract = readSupplierContract(item, intent.kind, String(ack.contractId));
    if (contract.latestRevisionId !== ack.revisionId || intent.action === 'create' && contract.latestRevision !== 1
      || intent.action !== 'create' && contract.latestRevision !== Number(intent.body.expectedRevision) + 1) throw new Error('回执的草稿版本不一致，请保留原请求核对。');
  }
  if (intent.action === 'submit') {
    const payload = object(item.payload);
    if (!validId(ack.approvalId) || item.id !== ack.approvalId || item.targetId !== ack.revisionId || payload.contractKind !== intent.kind
      || payload.contractId !== intent.id || payload.revisionId !== ack.revisionId || payload.revision !== intent.body.expectedRevision)
      throw new Error('审批回执未绑定准确申请与提案版本，请保留原请求。');
  }
  if (['fulfillments', 'generate-document', 'record-offline-send'].includes(intent.action) && ack.revisionId !== intent.body.approvedRevisionId)
    throw new Error('回执不是原请求的准确批准版，请保留原请求核对。');
  if (intent.action === 'supplier-feedback' && (item.approvedRevisionId !== intent.body.approvedRevisionId
    || ack.revisionId !== (item.proposedRevisionId ?? intent.body.approvedRevisionId))) throw new Error('供应商反馈回执没有绑定原批准版与变更提案，请保留原请求。');
  if (intent.action === 'record-offline-send' && item.approvedRevisionId !== intent.body.approvedRevisionId) throw new Error('线下发出回执与准确批准版不一致，请保留原请求。');
  if (intent.action === 'fulfillments') {
    const facts = item.facts;
    if (item.contractId !== intent.id || item.contractKind !== intent.kind || item.approvedRevisionId !== ack.revisionId
      || !Array.isArray(ack.factIds) || !ack.factIds.length || !Array.isArray(facts) || facts.length !== ack.factIds.length
      || new Set(ack.factIds).size !== ack.factIds.length || facts.some(fact => {
        const row = object(fact); return !validId(row.id) || typeof row.quantity !== 'string' || !/^\d+(\.\d+)?$/.test(row.quantity) || !validId(row.unit);
      }) || ack.factIds.some(id => !validId(id) || !facts.some(fact => object(fact).id === id))) throw new Error('实际交接回执缺少准确事实，请保留原请求。');
  }
  if (intent.action === 'generate-document' && (!validId(ack.documentId) || item.documentId !== ack.documentId || item.revisionId !== ack.revisionId
    || item.version !== 1 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('正式文件回执缺少准确批准版与归档摘要，请保留原请求。');
  return data as SupplierCommandResponse;
}
export const supplierContractService = {
  async list(kind: SupplierContractKind, cursor?: string, original = supplierSession()) {
    const data = await request(`${path(kind)}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`, 'GET', undefined, original);
    if (!Array.isArray(data.items)) throw new Error('合同列表未完整返回，请刷新。');
    return { items: data.items.map(item => readSupplierContract(item, kind)), hasMore: data.hasMore === true, nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null };
  },
  async get(kind: SupplierContractKind, id: string, original = supplierSession()) { return readSupplierContract((await request(path(kind, id), 'GET', undefined, original)).item, kind, id); },
  async sources(search = '', original = supplierSession()) {
    const data = await request('/v1/procurement/contracts/sources?search=' + encodeURIComponent(search), 'GET', undefined, original);
    if (!Array.isArray(data.items) || data.items.some(value => { const item = object(value); return !validId(item.id) || !validId(item.orderId) || object(item.order).id !== item.orderId; })) throw new Error('准确来源列表未能核验。');
    return data.items as SupplierSource[];
  },
  async fulfillments(kind: SupplierContractKind, id: string, original = supplierSession()) {
    const item = object((await request(path(kind, id) + '/fulfillments', 'GET', undefined, original)).item);
    if (item.contractId !== id || item.contractKind !== kind || !Array.isArray(item.lines) || !Array.isArray(item.facts)) throw new Error('实际交接历史与当前合同不一致。');
    return item as SupplierFulfillment;
  },
  async revisions(kind: SupplierContractKind, id: string, original = supplierSession()) {
    const data = await request(path(kind, id) + '/revisions', 'GET', undefined, original);
    if (!Array.isArray(data.items)) throw new Error('承诺历史未完整返回。'); return data.items as SupplierRevision[];
  },
  pending(original = supplierSession()) { check(original); return listBusinessRequests<SupplierIntent>('supplier-contract:', original.endpoint); },
  async command(intent: SupplierIntent, original = supplierSession()): Promise<SupplierCommandResponse> {
    check(original); if (!supplierCapability()) throw new Error('当前账号没有供应商业务写权限。');
    const operation = `supplier-contract:${intent.kind}:${intent.id ?? 'new'}:${intent.action}`;
    const recovering = readBusinessRequest(operation, original.endpoint) !== null;
    const saved = beginBusinessRequest(operation, intent, original.endpoint);
    try {
      const data = await request(path(intent.kind, intent.id) + (intent.action === 'create' ? '' : '/' + intent.action), intent.action === 'draft' ? 'PUT' : 'POST',
        { ...intent.body, requestKey: saved.requestId }, original);
      const result = verifySupplierCommand(data, intent, saved.requestId); check(original);
      clearAcknowledgedBusinessRequest(operation, saved.requestId, original.endpoint); return result;
    } catch (error) {
      // A later authorization/source refusal says nothing about an earlier
      // committed command whose acknowledgement was lost.
      if (!recovering && supplierSessionCurrent(original) && error instanceof SupplierHttpError && error.status >= 400 && error.status < 500 && error.code !== 'REQUEST_KEY_CONFLICT')
        clearAcknowledgedBusinessRequest(operation, saved.requestId, original.endpoint);
      throw error;
    }
  },
  async authority(kind: SupplierContractKind, family: 'fabric' | 'garment', original = supplierSession()) {
    const data = await request(`/v1/procurement/contracts/approval-authority/${kind}/${family}`, 'GET', undefined, original), item = object(data.item);
    if (!Number.isSafeInteger(item.version) || !Array.isArray(item.userIds)) throw new Error('审批名单配置未完整返回。');
    return item as { key: string; version: number; userIds: string[] };
  },
  async configure(kind: SupplierContractKind, family: 'fabric' | 'garment', input: { requestKey: string; userIds: string[]; expectedConfigVersion: number; reason: string }, original = supplierSession()) {
    if (!supplierCapability('dictionary:write')) throw new Error('当前账号没有审批配置权限。');
    return request(`/v1/procurement/contracts/approval-authority/${kind}/${family}`, 'PUT', input, original);
  },
};
