import type { OrderLineItem, OrderLineLite, OrderToleranceStatus } from '../types';
import { apiService } from './apiService';

export type ConfirmedOrderLineSource = {
  confirmedSourceType: 'SealSample' | 'Sample' | 'Asset';
  confirmedSourceId: string;
  millRelationId?: string;
};

/** Explicit source selection uses the existing audited version command. */
export async function setOrderLineConfirmedSource(id: string, source: ConfirmedOrderLineSource): Promise<OrderLineLite> {
  if (!id || !source.confirmedSourceId) throw new Error('请选择真实的订单行和确认来源。');
  const response = await fetch(apiService.buildApiUrl(`/v1/order-lines/${encodeURIComponent(id)}/version`), {
    method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(source),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
    const message = response.status === 403 && data?.error === 'FORBIDDEN' && data?.message === 'Insufficient role.'
      ? '当前账号不能确认来源，请交由主管确认。'
      : data?.error?.message || data?.message || `确认来源保存失败（HTTP ${response.status}），请核对后重试。`;
    throw Object.assign(new Error(message), { status: response.status, ...(typeof code === 'string' ? { code } : {}) });
  }
  if (data?.ok !== true || data?.line?.id !== id
    || data.line.confirmedSourceType !== source.confirmedSourceType
    || data.line.confirmedSourceId !== source.confirmedSourceId) {
    throw new Error('确认来源的保存结果暂时无法核对，请刷新原订单后再操作。');
  }
  return data.line;
}

export async function createOrderLine(
  line: Partial<OrderLineLite> & { orderId?: string; orderCode?: string; poNumber?: string; customer?: string; salesCurrency?: string; purchaseCurrency?: string },
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; line: OrderLineItem }> {
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl('/v1/order-lines'), {
    method: 'POST',
    body: JSON.stringify(line),
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Create line failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  if (data?.ok !== true || typeof data?.line?.id !== 'string' || !data.line.id
    || line.orderId && data.line.orderId !== line.orderId) {
    throw new Error('条目保存结果暂时无法核对，请刷新原订单确认后再操作。');
  }
  return data;
}

export async function updateOrderLineFields(
  id: string,
  patch: Partial<OrderLineLite>,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; line: OrderLineItem }> {
  if (!id) throw new Error('updateOrderLineFields: id required');
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl(`/v1/order-lines/${encodeURIComponent(id)}`), {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Update line failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

/**
 * ★ 2026-09-29 晚：**本单的订单行**（`GET /v1/order-lines?orderId=`）。
 *
 * 为什么需要：QC 查货登记幅宽实测时必须选到"本单的哪一支面料"，而此前该接口**不支持按单过滤**
 * （恒返回全库行）⇒ 前端没有可用的数据源。服务端已补 `?orderId=`（不过滤时行为与修前一致）。
 * ★ 传了 orderId 却拿到空数组 = 该单确实没有行（**不是**读取失败；失败会抛）。
 */
export async function listOrderLines(
  orderId: string,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<OrderLineItem[]> {
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;
  const q = orderId ? `?orderId=${encodeURIComponent(orderId)}` : '';
  const res = await fetch(apiService.buildApiUrl(`/v1/order-lines${q}`), { headers, signal: opts.signal });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Fetch order lines failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  return Array.isArray(data?.lines) ? data.lines : [];
}

/**
 * REQ2-03 溢短装状态：全部行已发量 vs 合同量（±N% 条款校验，只读）。
 * GET /v1/orders/:id/tolerance-status
 */
export async function fetchOrderToleranceStatus(
  orderId: string,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<OrderToleranceStatus> {
  if (!orderId) throw new Error('fetchOrderToleranceStatus: orderId required');
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(orderId)}/tolerance-status`), {
    headers,
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Fetch tolerance status failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  return data as OrderToleranceStatus;
}
