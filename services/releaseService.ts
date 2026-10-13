/**
 * 放行（PP 样门禁 / 开裁放行）前端 API 服务。
 *
 * 后端：`/api/v1/releases`（`server/src/production/releaseRoute.ts`，DR-053）。
 * 说明：该族端点此前**前端零消费**（feature-inventory P-3），即 §10.3-4
 * 「PP 样硬拦截 + 老板特批」这条定案长期只有后端能力、没有业务入口。
 * 本模块为「订单详情 · 放行面板」提供调用层。
 *
 * 口径提醒（勿在前端放宽）：
 *   - 放行 = 领导**单签**即批准（§10.7 P-3：工厂不在公司体系内，无双签）；
 *   - 签谁就是谁：actorName 由服务端取当前登录主体，前端**不能代填**（P-7）；
 *   - 范围置 invalidated 后**可重新发起**（P2-1），但拆批退出的（superseded）不可。
 */
import { apiService } from './apiService';

export type ReleaseScopeState = 'no_release' | 'ready' | 'paused' | 'revoked' | 'invalidated';

export interface ReleaseScopeRow {
  id: string;
  orderId: string;
  orderLineId: string | null;
  productionBatchId?: string | null;
  productionBatchRevision?: number | null;
  classification?: 'current' | 'historical';
  historyReason?: string;
  quantity?: number | string | null;
  unit?: string | null;
  state: ReleaseScopeState;
  currentReleaseId?: string | null;
  scopeRevision?: number;
  confirmedSourceType?: string | null;
  confirmedSourceId?: string | null;
  createdAt?: number | bigint | string | null;
  updatedAt?: number | bigint | string | null;
}

export interface PendingReleaseRequest {
  id: string;
  scopeId: string;
  state: string;
  createdBy: string | null;
}

export interface OrderReleaseSummary {
  total: number;
  ready: number;
  blocked: number;
  summary: 'ready' | 'partial' | 'blocked';
  scopes: ReleaseScopeRow[];
  pendingRequests: PendingReleaseRequest[];
  historyTotal?: number;
  hasScopeHistory?: boolean;
}

/** Minimal current-user signing context; it grants no order/production summary access. */
export interface ReleaseRequestActionContext {
  request: { id: string; scopeId: string; scopeRevision: number; requestRevision: number; state: string; createdAt: string; updatedAt: string };
  scope: { id: string; orderId: string; orderLineId: string; scopeRevision: number; state: ReleaseScopeState;
    classification: 'current' | 'historical'; quantity: string; unit: string; productionBatchId: string | null; productionBatchRevision: number | null };
  line: { id: string; orderId: string; label: string | null; quantity: string; unit: string };
  signer: { userId: string; displayName: string; department: string | null; positions: string[] };
  reviewContentFingerprint: string;
  reviewBasis: {
    orderReference: string;
    item: { itemNo: string | null; description: string | null; materialCode: string | null; quantity: string; unit: string | null;
      deliveryDate: string | null; exMillDate: string | null; styleNo: string | null; colorName: string | null };
    productionScope: { quantity: string; unit: string; batchCode: string | null; batchRevision: number | null };
    finalSpecification: unknown;
    sampleEvidence: { code: string | null; type: string | null; round: number | null; status: string | null;
      qcStatus: string | null; customerStatus: string | null; supplierName: string | null } | null;
  };
  allowedRoles: Array<'production' | 'business'>;
  canSign: boolean;
  blockedReasons: string[];
}

export interface ReleaseEligibility {
  eligible: boolean;
  reasons?: string[];
  [k: string]: unknown;
}

const API = '/v1/releases';

function resolveUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`${API}${path}`, base);
}

/** Unknown success is not proof that the mutation committed. Read back the original record. */
const UNKNOWN_RESPONSE = '放行响应无法核验，结果待核对；请重读原范围或原申请。';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function requireResponse(valid: boolean): asserts valid { if (!valid) throw new Error(UNKNOWN_RESPONSE); }
function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}
function validScope(value: unknown, classified = false): value is ReleaseScopeRow {
  return record(value) && text(value.id) && text(value.orderId) && (value.orderLineId === null || text(value.orderLineId))
    && ['no_release', 'ready', 'paused', 'revoked', 'invalidated'].includes(value.state)
    && (value.productionBatchId == null || text(value.productionBatchId))
    && (value.currentReleaseId == null || text(value.currentReleaseId))
    && (value.unit == null || text(value.unit)) && (value.quantity == null || decimal(value.quantity) !== null)
    && (!classified || ['current', 'historical'].includes(value.classification))
    && (!classified || value.classification === 'historical' || (decimal(value.quantity) !== null && decimal(value.quantity)! > 0n
      && (value.productionBatchId == null || revision(value.productionBatchRevision))))
    && ((classified && value.classification === 'historical') || revision(value.scopeRevision));
}
async function unwrap(res: Response): Promise<Record<string, any>> {
  let data: unknown;
  try { data = await res.json(); } catch { throw new Error(res.ok ? UNKNOWN_RESPONSE : `HTTP ${res.status}`); }
  if (!res.ok || (record(data) && data.ok === false)) {
    const message = record(data) && (data.error?.message || data.error?.code || data.message);
    throw new Error(typeof message === 'string' && message ? message : `HTTP ${res.status}`);
  }
  requireResponse(record(data) && data.ok === true);
  return data;
}

function validActionContext(item: any, requestId: string): item is ReleaseRequestActionContext {
  const exact = (value: any, keys: string[]) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  const id = (value: any) => text(value) && value.trim() === value;
  const jsonValue = (value: any): boolean => value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(jsonValue)
    || record(value) && Object.values(value).every(jsonValue);
  if (!exact(item, ['request', 'scope', 'line', 'signer', 'reviewContentFingerprint', 'reviewBasis', 'allowedRoles', 'canSign', 'blockedReasons'])
    || !exact(item.request, ['id', 'scopeId', 'scopeRevision', 'requestRevision', 'state', 'createdAt', 'updatedAt'])
    || !exact(item.scope, ['id', 'orderId', 'orderLineId', 'scopeRevision', 'state', 'classification', 'quantity', 'unit', 'productionBatchId', 'productionBatchRevision'])
    || !exact(item.line, ['id', 'orderId', 'label', 'quantity', 'unit'])
    || !exact(item.signer, ['userId', 'displayName', 'department', 'positions'])
    || !exact(item.reviewBasis, ['orderReference', 'item', 'productionScope', 'finalSpecification', 'sampleEvidence'])
    || !exact(item.reviewBasis.item, ['itemNo', 'description', 'materialCode', 'quantity', 'unit', 'deliveryDate', 'exMillDate', 'styleNo', 'colorName'])
    || !exact(item.reviewBasis.productionScope, ['quantity', 'unit', 'batchCode', 'batchRevision'])
    || item.reviewBasis.sampleEvidence !== null && !exact(item.reviewBasis.sampleEvidence, ['code', 'type', 'round', 'status', 'qcStatus', 'customerStatus', 'supplierName'])) return false;
  const { request, scope, line } = item;
  return request.id === requestId && id(request.id) && id(scope.id) && request.scopeId === scope.id
    && id(scope.orderId) && id(scope.orderLineId) && line.id === scope.orderLineId && line.orderId === scope.orderId
    && revision(request.scopeRevision) && revision(request.requestRevision) && revision(scope.scopeRevision)
    && ['pending', 'granted', 'voided'].includes(request.state) && id(request.createdAt) && id(request.updatedAt)
    && ['no_release', 'ready', 'paused', 'revoked', 'invalidated'].includes(scope.state)
    && ['current', 'historical'].includes(scope.classification) && decimal(scope.quantity) !== null && decimal(scope.quantity)! > 0n
    && decimal(line.quantity) !== null && decimal(line.quantity)! > 0n && typeof scope.unit === 'string' && scope.unit.trim() === scope.unit && typeof line.unit === 'string' && line.unit.trim() === line.unit
    && (line.label === null || typeof line.label === 'string')
    && id(item.signer.userId) && id(item.signer.displayName) && (item.signer.department === null || typeof item.signer.department === 'string')
    && Array.isArray(item.signer.positions) && item.signer.positions.every((position: unknown) => typeof position === 'string' && position.trim() === position)
    && /^[a-f0-9]{64}$/.test(item.reviewContentFingerprint)
    && id(item.reviewBasis.orderReference) && text(item.reviewBasis.item.quantity) && text(item.reviewBasis.productionScope.quantity)
    && (item.reviewBasis.sampleEvidence === null || jsonValue(item.reviewBasis.sampleEvidence))
    && jsonValue(item.reviewBasis.finalSpecification)
    && (scope.productionBatchId === null && scope.productionBatchRevision === null || id(scope.productionBatchId) && (revision(scope.productionBatchRevision) || scope.classification === 'historical' && scope.productionBatchRevision === null))
    && Array.isArray(item.allowedRoles) && new Set(item.allowedRoles).size === item.allowedRoles.length
    && item.allowedRoles.every((role: unknown) => role === 'business' || role === 'production')
    && typeof item.canSign === 'boolean' && Array.isArray(item.blockedReasons) && item.blockedReasons.every((reason: unknown) => typeof reason === 'string')
    && (!item.canSign || request.state === 'pending' && scope.classification === 'current' && request.scopeRevision === scope.scopeRevision
      && item.allowedRoles.length > 0 && item.blockedReasons.length === 0);
}

function validSignReview(requestId: string, review: any): boolean {
  return record(review) && record(review.request) && review.request.id === requestId
    && text(review.request.id) && text(review.request.scopeId)
    && revision(review.request.requestRevision) && revision(review.request.scopeRevision)
    && review.request.state === 'pending'
    && /^[a-f0-9]{64}$/.test(review.reviewContentFingerprint);
}

export const releaseService = {
  /** Exact original request only; no summary, preflight, creation or inferred latest request. */
  async getRequestActionContext(requestId: string, endpoint?: string): Promise<ReleaseRequestActionContext> {
    requireResponse(text(requestId) && requestId.trim() === requestId);
    const res = await fetch(resolveUrl(`/release-requests/${encodeURIComponent(requestId)}/action-context`, endpoint), {
      method: 'GET', headers: apiService.getAuthHeaders(),
    });
    const data = await unwrap(res);
    requireResponse(validActionContext(data.item, requestId));
    return data.item;
  },
  /** 订单放行全景：汇总 + 范围列表 + 待签请求（面板主数据源） */
  async listOrderReleases(orderId: string, endpoint?: string): Promise<OrderReleaseSummary> {
    const res = await fetch(resolveUrl(`/orders/${encodeURIComponent(orderId)}/releases`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    const data = await unwrap(res);
    requireResponse(count(data.total) && count(data.ready) && count(data.blocked) && count(data.historyTotal)
      && typeof data.hasScopeHistory === 'boolean' && Array.isArray(data.scopes) && Array.isArray(data.pendingRequests));
    const scopes = data.scopes as unknown[], pending = data.pendingRequests as unknown[];
    requireResponse(scopes.every(scope => validScope(scope, true) && scope.orderId === orderId));
    const rows = scopes as ReleaseScopeRow[], ids = new Set(rows.map(scope => scope.id));
    const currentTotal = rows.filter(scope => scope.classification === 'current').length;
    requireResponse(ids.size === rows.length && data.total === currentTotal && data.ready <= data.total
      && data.blocked === data.total - data.ready && data.historyTotal === rows.length - data.total
      && data.hasScopeHistory === (rows.length > 0)
      && data.summary === (data.total === 0 ? 'blocked' : data.ready === data.total ? 'ready' : data.ready > 0 ? 'partial' : 'blocked'));
    const pendingIds = new Set<string>(), pendingScopes = new Set<string>();
    for (const request of pending) {
      requireResponse(record(request) && text(request.id) && text(request.scopeId) && ids.has(request.scopeId)
        && request.state === 'pending' && (request.createdBy === null || text(request.createdBy))
        && !pendingIds.has(request.id) && !pendingScopes.has(request.scopeId));
      pendingIds.add(request.id); pendingScopes.add(request.scopeId);
    }
    return { total: data.total, ready: data.ready, blocked: data.blocked, summary: data.summary,
      scopes: rows, pendingRequests: pending as PendingReleaseRequest[],
      historyTotal: data.historyTotal, hasScopeHistory: data.hasScopeHistory };
  },

  /** 建放行范围（整行或生产批次） */
  async createScope(
    orderId: string,
    lineId: string,
    input: { quantity: number | string; unit?: string; productionBatchId?: string; expectedBatchRevision?: number; confirmedSourceType?: string; confirmedSourceId?: string },
    endpoint?: string,
  ): Promise<{ scope: ReleaseScopeRow }> {
    const res = await fetch(resolveUrl(`/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}/release-scopes`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input ?? {}),
    });
    const data = await unwrap(res), scope = data.scope;
    const expectedQuantity = decimal(typeof input.quantity === 'number' ? String(input.quantity) : input.quantity);
    requireResponse(validScope(scope) && scope.orderId === orderId && scope.orderLineId === lineId
      && scope.state === 'no_release' && (scope.classification === undefined || scope.classification === 'current') && decimal(scope.quantity) === expectedQuantity && expectedQuantity !== null && expectedQuantity > 0n
      && (input.unit === undefined || scope.unit === input.unit)
      && (scope.productionBatchId ?? null) === (input.productionBatchId ?? null)
      && (scope.productionBatchRevision ?? null) === (input.expectedBatchRevision ?? null)
      && (input.productionBatchId === undefined || revision(scope.productionBatchRevision)));
    return { scope };
  },

  /** Explicit continuation of the same historical batch scope; never transfers approval. */
  async rebindScope(
    original: ReleaseScopeRow,
    input: { productionBatchId: string; expectedScopeRevision: number; expectedBatchRevision: number; quantity: string; unit: string },
    endpoint?: string,
  ): Promise<{ scope: ReleaseScopeRow }> {
    const quantity = decimal(input.quantity);
    requireResponse(validScope(original) && text(original.orderLineId) && text(original.productionBatchId)
      && original.classification === 'historical' && input.productionBatchId === original.productionBatchId
      && revision(input.expectedScopeRevision) && original.scopeRevision === input.expectedScopeRevision
      && revision(input.expectedBatchRevision) && quantity !== null && quantity > 0n && text(input.unit));
    const body = { productionBatchId: input.productionBatchId, expectedScopeRevision: input.expectedScopeRevision,
      expectedBatchRevision: input.expectedBatchRevision, quantity: input.quantity, unit: input.unit };
    const res = await fetch(resolveUrl(`/release-scopes/${encodeURIComponent(original.id)}/rebind`, endpoint), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(body),
    });
    const data = await unwrap(res), scope = data.scope;
    requireResponse(validScope(scope) && scope.id === original.id && scope.orderId === original.orderId && scope.orderLineId === original.orderLineId
      && scope.productionBatchId === original.productionBatchId && scope.productionBatchRevision === input.expectedBatchRevision
      && scope.scopeRevision === input.expectedScopeRevision + 1 && scope.state === 'no_release' && scope.currentReleaseId === null
      && (scope.classification === undefined || scope.classification === 'current') && decimal(scope.quantity) === quantity && scope.unit === input.unit);
    return { scope };
  },

  /** 发起放行请求（会把 invalidated 范围复位为 no_release，P2-1） */
  async createRequest(
    scopeId: string,
    input: { sampleId?: string; expectedScopeRevision?: number; clientRequestId?: string } = {},
    endpoint?: string,
  ): Promise<{ request: { id: string; state: string } }> {
    const res = await fetch(resolveUrl(`/release-scopes/${encodeURIComponent(scopeId)}/requests`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input ?? {}),
    });
    const data = await unwrap(res), request = data.request;
    requireResponse(record(request) && text(request.id) && request.scopeId === scopeId && request.state === 'pending'
      && revision(request.scopeRevision) && (input.expectedScopeRevision === undefined || request.scopeRevision === input.expectedScopeRevision));
    return { request: { ...request, id: request.id, state: request.state } };
  },

  /**
   * 领导签字（单签口径）。role: 'production' | 'business'。
   * 注意：服务端按 role 分流权限，前端只传 role，不传签署人（防代签）。
   */
  async signRequest(requestId: string, role: 'production' | 'business', review?: Pick<ReleaseRequestActionContext, 'request' | 'reviewContentFingerprint'>, endpoint?: string): Promise<any> {
    requireResponse(validSignReview(requestId, review));
    const verifiedReview = review!;
    const res = await fetch(resolveUrl(`/release-requests/${encodeURIComponent(requestId)}/signatures`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ role, confirmedReviewedContent: true, expectedRequestRevision: verifiedReview.request.requestRevision,
        expectedScopeRevision: verifiedReview.request.scopeRevision, reviewContentFingerprint: verifiedReview.reviewContentFingerprint }),
    });
    const data = await unwrap(res), request = data.request, release = data.release;
    requireResponse(data.signed === true && record(request) && request.id === requestId && request.state === 'granted'
      && text(request.scopeId) && revision(request.scopeRevision) && record(release) && text(release.id)
      && release.requestId === requestId && release.scopeId === request.scopeId && release.scopeRevision === request.scopeRevision);
    return data;
  },

  /** 资格预检：为什么能/不能开裁（只读，实际提交时服务端再校验一次） */
  async getEligibility(scopeId: string, endpoint?: string): Promise<ReleaseEligibility> {
    const res = await fetch(resolveUrl(`/release-scopes/${encodeURIComponent(scopeId)}/eligibility`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    const data = await unwrap(res);
    requireResponse(data.scopeId === scopeId && typeof data.eligible === 'boolean' && revision(data.scopeRevision)
      && ['no_release', 'ready', 'paused', 'revoked', 'invalidated'].includes(data.state)
      && (data.releaseId === null || text(data.releaseId)) && Array.isArray(data.reasons) && data.reasons.every((reason: unknown) => typeof reason === 'string'));
    return data as ReleaseEligibility;
  },

  /** SM 级动作：pause / resume / revoke */
  async scopeAction(scopeId: string, action: 'pause' | 'resume' | 'revoke', endpoint?: string): Promise<any> {
    const res = await fetch(resolveUrl(`/release-scopes/${encodeURIComponent(scopeId)}/${action}`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    const data = await unwrap(res);
    requireResponse(validScope(data.scope) && data.scope.id === scopeId
      && data.scope.state === ({ pause: 'paused', resume: 'ready', revoke: 'revoked' } as const)[action]
      && decimal(data.scope.quantity) !== null
      && (action !== 'resume' || (decimal(data.scope.quantity)! > 0n && text(data.scope.currentReleaseId)
        && (data.scope.productionBatchId == null || revision(data.scope.productionBatchRevision)))));
    return data;
  },
};
