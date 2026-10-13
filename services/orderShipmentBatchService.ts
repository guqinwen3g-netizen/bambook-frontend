/**
 * orderShipmentBatchService — P0-1 订单分批出运与尾款结算（前端 API 封装）
 *
 * 后端契约：server/src/shipping/route.ts（/api/v1/shipping/order-batches*）
 * 服务真源：server/src/shipping/orderShipmentBatchService.ts
 *
 * 端点：
 *   GET  /order-batches?orderId=…            — 订单批次全景（批次列表 + 计划/出运/结算汇总）
 *   GET  /order-batches/overdue-final        — 尾款到期未结清末批清单
 *   POST /order-batches                      — 批次登记（batchNo 自动递增；单批自动末批）
 *   PUT  /order-batches/:id                  — 批次更新（计划期可改计划；status 仅 planned→cancelled）
 *   POST /order-batches/:id/mark-shipped     — 发运确认（排船回填 + 尾款到期日 + 末批收款门禁）
 *   POST /order-batches/:id/recalc           — 结算进度重算
 */
import { apiService } from './apiService';
import { getAuthState, hasPermission } from './authService';
import { beginBusinessRequest, readBusinessRequest, listBusinessRequests, clearAcknowledgedBusinessRequest } from './businessRequestRecovery';

export type ExactBatchValue = string | number;

export type BatchStatus = 'planned' | 'shipped' | 'cancelled';
export type BatchSettleStatus = 'unsettled' | 'partially_settled' | 'settled';

export interface OrderShipmentBatchView {
  id: string;
  orderId: string;
  shipmentId?: string | null;
  batchNo: number;
  plannedRatio?: number | null;
  plannedQty?: ExactBatchValue | null;
  unit?: string | null;
  amount?: ExactBatchValue | null;
  currency: string;
  customerRelationId?: string | null;
  customerName?: string | null;
  status: BatchStatus | string;
  shippedAt?: ExactBatchValue | null;
  settleStatus: BatchSettleStatus | string;
  invoicedAmount?: ExactBatchValue | null;
  paidAmount?: ExactBatchValue | null;
  settledAt?: ExactBatchValue | null;
  isFinalBatch?: boolean;
  finalPaymentDueDays?: number | null;
  finalPaymentDueDate?: string | null;
  notes?: string | null;
  createdAt: ExactBatchValue;
  updatedAt: ExactBatchValue;
  // 派生（后端 serialize）
  settleProgress?: number | null;
  outstandingAmount?: ExactBatchValue | null;
  finalPaymentOverdue?: boolean;
  orderPoNumber?: string | null;
  orderCustomer?: string | null;
}

export interface OrderBatchSummary {
  totalBatches: number;
  shippedBatches: number;
  allShipped: boolean;
  totalPlannedAmount: ExactBatchValue;
  totalInvoiced: ExactBatchValue;
  totalPaid: ExactBatchValue;
}

export interface OrderBatchOverview {
  order: { id: string; poNumber?: string | null; customer?: string | null; currency?: string | null };
  orderAmount: ExactBatchValue;
  batches: OrderShipmentBatchView[];
  summary: OrderBatchSummary;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined);
  const rawMessage = data?.error?.message || data?.message || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function batchUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/shipping/order-batches${path}`, base);
}

export interface BatchCreateInput {
  orderId: string;
  shipmentId?: string;
  plannedRatio?: number;
  plannedQty?: ExactBatchValue;
  unit?: string;
  amount?: ExactBatchValue;
  currency?: string;
  isFinalBatch?: boolean;
  finalPaymentDueDays?: number;
  notes?: string;
}

export interface BatchUpdateInput {
  shipmentId?: string | null;
  plannedRatio?: number | null;
  plannedQty?: ExactBatchValue | null;
  unit?: string | null;
  amount?: ExactBatchValue | null;
  isFinalBatch?: boolean;
  finalPaymentDueDays?: number | null;
  notes?: string | null;
  status?: string; // 'cancelled'
}

export interface BatchMarkShippedInput {
  shipmentId?: string;
  shippedAt?: ExactBatchValue;
  gateCoverRatio?: number;
  skipGate?: boolean;
}
export interface BatchPhysicalContext {
  kind: 'physical' | 'legacy'; batchId: string; orderId: string; shipmentId: string | null;
  expectedBatchUpdatedAt: string; expectedShipmentUpdatedAt: string | null;
  expectedPhysicalAllocationFingerprint: string | null;
}
export interface PendingBatchMark {
  batchId: string; requestId: string; input: BatchMarkShippedInput; context: BatchPhysicalContext;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(canonical(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** Includes the signed credential ceiling, headers and endpoint. Never a server authorization fact. */
export function getOrderBatchClientIdentity(endpoint?: string): string {
  const state = getAuthState(), base = endpoint ?? apiService.getStoredConfig().cloudEndpoint;
  return canonical([state.isAuthenticated, state.user?.id, base, apiService.getStoredConfig().cloudEndpoint,
    apiService.getAuthHeaders(), state.user?.roles, state.user?.permissions, state.user?.permissionCeiling]);
}
function session(endpoint?: string, write = false) {
  const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, state = getAuthState();
  if (!state.isAuthenticated || !state.user?.id) throw new Error('请重新登录后继续');
  if (write && (!hasPermission('shipments:write') || !hasPermission('orders:read'))) throw new Error('当前账号无出运写入权限，请核对原请求后由有权限的账号办理。');
  return { base, actorId: state.user.id, identity: getOrderBatchClientIdentity(base), headers: apiService.getAuthHeaders() };
}
function assertSession(current: ReturnType<typeof session>) {
  if (current.identity !== getOrderBatchClientIdentity(current.base)) throw new Error('账号、权限或服务地址已变化，本次结果待核对，请重新读取。');
}
const operation = (id: string) => `order-batch:mark-shipped:${id}`;
function validPending(id: string, payload: any): asserts payload is { input: BatchMarkShippedInput; context: BatchPhysicalContext } {
  const context = payload?.context;
  if (!payload?.input || typeof payload.input !== 'object' || Array.isArray(payload.input)
    || context?.kind !== 'physical' || context.batchId !== id || typeof context.orderId !== 'string' || !context.orderId
    || typeof context.shipmentId !== 'string' || !context.shipmentId
    || typeof context.expectedBatchUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(context.expectedBatchUpdatedAt)
    || typeof context.expectedShipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(context.expectedShipmentUpdatedAt)
    || typeof context.expectedPhysicalAllocationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(context.expectedPhysicalAllocationFingerprint))
    throw new Error('原发运请求记录不完整，请核对服务端原结果，不能创建替代请求。');
}

function confirmedBatch(data: any, id?: string, status?: string): OrderShipmentBatchView {
  if (data?.ok !== true || !data.batch || typeof data.batch.id !== 'string' || (id && data.batch.id !== id)
    || typeof data.batch.status !== 'string' || (status && data.batch.status !== status))
    throw new Error('未取得可核对的批次回执，请保留原请求重试。');
  return data.batch;
}
async function responseJson(res: Response) {
  return res.json().catch(() => { throw new Error(`未取得可核对的响应：HTTP ${res.status}`); });
}
async function contextRead(id: string, shipmentId: string | undefined, current: ReturnType<typeof session>): Promise<BatchPhysicalContext> {
  const res = await fetch(batchUrl(`/${encodeURIComponent(id)}/physical-context${shipmentId === undefined ? '' : `?shipmentId=${encodeURIComponent(shipmentId)}`}`, current.base), { headers: current.headers });
  const data = await responseJson(res); assertSession(current);
  if (!res.ok) await readError({ status: res.status, json: async () => data } as Response, '读取批次实际来源失败');
  if (data?.ok !== true || !['physical', 'legacy'].includes(data.kind) || data.batchId !== id || (typeof data.orderId !== 'string' || !data.orderId)
    || !(data.shipmentId === null || typeof data.shipmentId === 'string')
    || data.shipmentId !== (shipmentId ?? data.shipmentId) || !/^(?:0|[1-9]\d*)$/.test(data.expectedBatchUpdatedAt)
    || typeof data.expectedBatchUpdatedAt !== 'string' || (data.kind === 'physical' &&
      (typeof data.shipmentId !== 'string' || typeof data.expectedShipmentUpdatedAt !== 'string'
       || !/^(?:0|[1-9]\d*)$/.test(data.expectedShipmentUpdatedAt) || !/^[a-f0-9]{64}$/.test(data.expectedPhysicalAllocationFingerprint))))
    throw new Error('批次实际来源响应不完整，未提交发运确认。');
  return data;
}

export const orderShipmentBatchService = {
  /** 订单批次全景（列表 + 汇总） */
  async listByOrder(orderId: string, endpoint?: string): Promise<OrderBatchOverview> {
    const current = session(endpoint);
    const res = await fetch(`${batchUrl('', current.base)}?orderId=${encodeURIComponent(orderId)}`, { headers: current.headers });
    const data = await responseJson(res); assertSession(current);
    if (!res.ok) await readError({ status: res.status, json: async () => data } as Response, 'order batches listByOrder failed');
    if (data?.ok !== true || data.order?.id !== orderId || !Array.isArray(data.batches) || !data.summary
      || data.batches.some((batch: any) => batch.orderId !== orderId || typeof batch.id !== 'string')) throw new Error('批次列表响应不完整，请重新读取。');
    return data;
  },

  /** 尾款到期未结清末批清单（看板/watchdog 扫描源） */
  async listOverdueFinal(limit = 100, endpoint?: string): Promise<OrderShipmentBatchView[]> {
    const res = await fetch(`${batchUrl('/overdue-final', endpoint)}?limit=${limit}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'order batches listOverdueFinal failed');
    const data = await res.json();
    return Array.isArray(data.batches) ? data.batches : [];
  },

  /** 批次登记（batchNo 自动递增；单批自动末批） */
  async createBatch(input: BatchCreateInput, endpoint?: string): Promise<OrderShipmentBatchView> {
    const current = session(endpoint, true);
    const res = await fetch(batchUrl('', current.base), {
      method: 'POST',
      headers: current.headers,
      body: JSON.stringify(input),
    });
    const data = await responseJson(res); assertSession(current);
    if (!res.ok) await readError({ status: res.status, json: async () => data } as Response, 'order batches createBatch failed');
    const batch = confirmedBatch(data);
    if (batch.orderId !== input.orderId) throw new Error('登记回执的订单来源不一致，请核对服务端状态。');
    return batch;
  },

  /** 批次更新（计划期可改；status 仅 planned→cancelled） */
  async updateBatch(batchId: string, input: BatchUpdateInput, endpoint?: string): Promise<OrderShipmentBatchView> {
    const current = session(endpoint, true);
    const res = await fetch(batchUrl(`/${encodeURIComponent(batchId)}`, current.base), {
      method: 'PUT',
      headers: current.headers,
      body: JSON.stringify(input),
    });
    const data = await responseJson(res); assertSession(current);
    if (!res.ok) await readError({ status: res.status, json: async () => data } as Response, 'order batches updateBatch failed');
    return confirmedBatch(data, batchId);
  },

  /** 批次取消（planned→cancelled；已发运 409） */
  async cancelBatch(batchId: string, endpoint?: string): Promise<OrderShipmentBatchView> {
    return this.updateBatch(batchId, { status: 'cancelled' }, endpoint);
  },

  async getPhysicalContext(batchId: string, shipmentId?: string, endpoint?: string): Promise<BatchPhysicalContext> {
    return contextRead(batchId, shipmentId, session(endpoint, true));
  },

  listPendingMarkShipped(orderId: string, endpoint?: string): PendingBatchMark[] {
    const current = session(endpoint);
    const records = listBusinessRequests<{ input: BatchMarkShippedInput; context: BatchPhysicalContext }>('order-batch:mark-shipped:', current.base);
    for (const item of records) validPending(item.operation.slice('order-batch:mark-shipped:'.length), item.record.payload);
    return records
      .filter(({ record }) => record.payload.context?.orderId === orderId)
      .map(({ operation: name, record }) => ({ batchId: name.slice('order-batch:mark-shipped:'.length), requestId: record.requestId, ...record.payload }));
  },

  async retryPendingMarkShipped(pending: PendingBatchMark, endpoint?: string): Promise<OrderShipmentBatchView> {
    const current = session(endpoint, true);
    const record = readBusinessRequest(operation(pending.batchId), current.base);
    if (!record || record.requestId !== pending.requestId || canonical(record.payload) !== canonical({ input: pending.input, context: pending.context }))
      throw new Error('原请求已变化，请重新核对待确认记录。');
    return this.markShipped(pending.batchId, pending.input, current.base);
  },

  /** Full original input + exact context + requestId are persisted together before POST. */
  async markShipped(batchId: string, input: BatchMarkShippedInput = {}, endpoint?: string): Promise<OrderShipmentBatchView> {
    const current = session(endpoint, true), original = clone(input), name = operation(batchId);
    const prior = readBusinessRequest<{ input: BatchMarkShippedInput; context: BatchPhysicalContext }>(name, current.base);
    if (prior) validPending(batchId, prior.payload);
    if (prior && canonical(prior.payload.input) !== canonical(original)) throw new Error('上次发运结果尚未确认，请按原请求重试。');
    let pending = prior;
    if (!pending) {
      const context = await contextRead(batchId, original.shipmentId, current);
      assertSession(current);
      if (context.kind === 'physical') pending = beginBusinessRequest(name, { input: original, context }, current.base);
    }
    const body = pending ? { ...pending.payload.input, requestKey: pending.requestId,
      expectedBatchUpdatedAt: pending.payload.context.expectedBatchUpdatedAt,
      expectedShipmentUpdatedAt: pending.payload.context.expectedShipmentUpdatedAt,
      expectedPhysicalAllocationFingerprint: pending.payload.context.expectedPhysicalAllocationFingerprint } : original;
    assertSession(current);
    const res = await fetch(batchUrl(`/${encodeURIComponent(batchId)}/mark-shipped`, current.base), {
      method: 'POST', headers: current.headers, body: JSON.stringify(body),
    });
    const data = await responseJson(res); assertSession(current);
    if (!res.ok) {
      // A new, structured refusal can finish this attempt. A replay refusal never
      // proves that an earlier unknown POST did not commit.
      if (pending && !prior && res.status >= 400 && res.status < 500 && typeof data?.error?.code === 'string')
        clearAcknowledgedBusinessRequest(name, pending.requestId, current.base);
      await readError({ status: res.status, json: async () => data } as Response, '发运确认失败');
    }
    const batch = confirmedBatch(data, batchId, 'shipped');
    if (pending) {
      const { acknowledgement, ...row } = batch as any;
      const command = { schemaVersion: 1, actorId: current.actorId, batchId, shipmentId: pending.payload.context.shipmentId, input: body };
      if (row.orderId !== pending.payload.context.orderId || row.shipmentId !== pending.payload.context.shipmentId
        || acknowledgement?.schemaVersion !== 1 || canonical(acknowledgement.command) !== canonical(command)
        || acknowledgement.commandHash !== await digest(command) || acknowledgement.batchHash !== await digest(row))
        throw new Error('发运回执与原请求不一致，请保留原请求核对。');
      assertSession(current);
      clearAcknowledgedBusinessRequest(name, pending.requestId, current.base);
    }
    return batch;
  },

  /** 结算进度重算（发票分配/核销变动后触发） */
  async recalc(batchId: string, endpoint?: string): Promise<OrderShipmentBatchView> {
    const current = session(endpoint, true);
    const res = await fetch(batchUrl(`/${encodeURIComponent(batchId)}/recalc`, current.base), {
      method: 'POST',
      headers: current.headers,
      body: JSON.stringify({}),
    });
    const data = await responseJson(res); assertSession(current);
    if (!res.ok) await readError({ status: res.status, json: async () => data } as Response, 'order batches recalc failed');
    return confirmedBatch(data, batchId);
  },
};
