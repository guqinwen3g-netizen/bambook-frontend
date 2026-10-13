import { ImportResponse, Order, ParsedOrder, PersistImportResponse } from '../types';
import { apiService } from './apiService';

/**
 * 从失败响应体里取「给人看的说明」。
 *
 * ★★ 2026-09-26（第 2 批 C 连带）：本文件原先读的是响应体**顶层** `message`，
 *   而本仓服务端（`orders/route.ts` 等）的形状是 `{ ok:false, error:{ code, message } }`
 *   ⇒ 服务端精心写的中文说明**到不了屏面**，用户只看到 `Update failed (HTTP 400)`。
 *   本文件 5 个函数**全是**这个形状 ⇒ 是 `services/apiService.ts`
 *   （读 `data?.error?.message`）的**唯一例外**，现归一到同一口径。
 *
 * 取值次序：`error.message` → `error.code` → 顶层 `message`（旧形状兜底）→ `''`。
 * 与 `apiService.ts` 的 `data?.error?.message || data?.error?.code || HTTP status` 同序。
 * 响应体读不出（非 JSON / 已被消费）时返回 `''`，由调用方退回「只报 HTTP 状态」。
 */
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    return body?.error?.message ?? body?.error?.code ?? body?.message ?? '';
  } catch {
    return '';
  }
}

/**
 * Upload one or more PDF files to the Bambook server for parse-only.
 *
 * Endpoint: POST /api/v1/import/order  (vite dev proxy → http://127.0.0.1:8081)
 * Field name: "files" (repeatable)
 *
 * Optional API key: pass `apiKey` to send X-Bambook-API-Key.
 *   - In open mode (BAMBOOK_REQUIRE_AUTH != 'true' on server) you can omit it.
 *
 * ★★ 2026-09-25 下线（Kevin 拍板）：PDF 导入订单功能不再对外提供 ⇒
 *   本函数**当前无调用方**，且服务端已不再挂载 `/api/v1/import`（该端点现返回 404）。
 *   函数保留未删（恢复见 server/src/index.ts 挂载点原位注释）。
 *   本文件其余四个函数（saveParsedOrders / createManualOrder / updateOrderFields / deleteOrder）
 *   走的是 orders 路由，**未下线**，请勿一并删除。
 */
export async function uploadPdfsForParsing(
  files: File[],
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ImportResponse> {
  if (files.length === 0) {
    throw new Error('No files selected');
  }
  const fd = new FormData();
  for (const f of files) fd.append('files', f);

  // FormData 上传不能设 Content-Type（浏览器自动带 multipart boundary），仅取认证头
  const { 'Content-Type': _ct, ...headers } = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl('/v1/import/order'), {
    method: 'POST',
    body: fd,
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new Error(`Import failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json() as Promise<ImportResponse>;
}

/**
 * Legacy controlled migration helper: persist a batch of already-parsed order
 * rows into the Order table. Server requires the dedicated `data:import` grant.
 * This is not a PO upload or normal order-entry flow; regular business users
 * must enter orders manually in OrderManager and retain PO files as evidence.
 *
 * Endpoint: POST /api/v1/orders/import (migration-only; requires `data:import` + `users:admin` JWT)
 */
export async function saveParsedOrders(
  orders: ParsedOrder[],
  opts: { apiKey?: string; signal?: AbortSignal; overwriteExisting?: boolean } = {},
): Promise<PersistImportResponse> {
  if (orders.length === 0) {
    throw new Error('No orders to save');
  }
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl('/v1/orders/import'), {
    method: 'POST',
    body: JSON.stringify({ orders, overwriteExisting: opts.overwriteExisting ?? true }),
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new Error(`Save failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json() as Promise<PersistImportResponse>;
}

/**
 * Create a manually entered order on the server. PO evidence is uploaded
 * separately and never parsed into these fields.
 *
 * Endpoint: POST /api/v1/orders
 */
export async function createManualOrder(
  order: Partial<Order>,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; order: Order }> {
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl('/v1/orders'), {
    method: 'POST',
    body: JSON.stringify(order),
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new Error(`Create failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

/**
 * Patch an existing order from the detail-card edit flow. Each supplied
 * scalar field is recorded as manually edited for provenance.
 *
 * Endpoint: PUT /api/v1/orders/:id
 */
export async function updateOrderFields(
  id: string,
  patch: Partial<Order> & { expectedUpdatedAt?: string | number },
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; order: Order }> {
  if (!id) throw new Error('updateOrderFields: id required');
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(id)}`), {
    method: 'PUT',
    body: JSON.stringify(patch),
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new Error(`Update failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

export async function deleteOrder(
  id: string,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; order: Order }> {
  if (!id) throw new Error('deleteOrder: id required');
  const headers = apiService.getAuthHeaders();
  if (opts.apiKey) headers['X-Bambook-API-Key'] = opts.apiKey;

  const res = await fetch(apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers,
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new Error(`Delete failed (HTTP ${res.status})${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}
