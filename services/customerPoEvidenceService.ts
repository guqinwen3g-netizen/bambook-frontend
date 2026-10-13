import { apiService } from './apiService';
import { hasPermission } from './authService';

export interface CustomerPoEvidence {
  id: string; orderId: string; version: number; fileName: string; mimeType: string;
  byteSize: number; sha256: string; uploadedBy: string; uploadedAt: number;
}
export interface CustomerPoEvidenceList { ok: true; orderId: string; items: CustomerPoEvidence[] }
export interface CustomerPoEvidenceUploadAck { ok: true; item: CustomerPoEvidence & { replayed: boolean } }
export const CUSTOMER_PO_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';
export const CUSTOMER_PO_MAX_BYTES = 20 * 1024 * 1024;

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const segment = encodeURIComponent;
const base = (orderId: string) => `/v1/orders/${segment(orderId)}/customer-po-evidence`;

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => null) as any;
  throw new Error(body?.error?.message || body?.message || `客户 PO 文件操作失败（HTTP ${response.status}）。`);
}

function parseItem(row: any, orderId: string): row is CustomerPoEvidence {
  return row?.orderId === orderId && text(row.id) && positive(row.version) && text(row.fileName)
    && text(row.mimeType) && positive(row.byteSize) && /^[a-f0-9]{64}$/.test(row.sha256)
    && text(row.uploadedBy) && Number.isSafeInteger(row.uploadedAt) && Number(row.uploadedAt) > 0;
}

export function createCustomerPoEvidenceRequestKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前环境无法生成安全的上传编号，请刷新后重试。');
  return globalThis.crypto.randomUUID();
}

export async function listCustomerPoEvidence(orderId: string, signal?: AbortSignal, endpoint?: string): Promise<CustomerPoEvidenceList> {
  if (!text(orderId)) throw new Error('请重新打开订单后读取客户 PO 原件。');
  if (!hasPermission('orders:read')) throw new Error('当前账号没有订单查看权限。');
  const response = await checked(await fetch(apiService.buildApiUrl(base(orderId), endpoint), { headers: apiService.getAuthHeaders(), signal }));
  const value = await response.json() as any;
  if (value?.ok !== true || value.orderId !== orderId || !Array.isArray(value.items) || value.items.some((row: any) => !parseItem(row, orderId)))
    throw new Error('客户 PO 原件回执不完整，请重新读取。');
  return value as CustomerPoEvidenceList;
}

export async function uploadCustomerPoEvidence(orderId: string, file: File, requestKey: string, endpoint?: string): Promise<CustomerPoEvidenceUploadAck> {
  if (!hasPermission('orders:write')) throw new Error('当前账号没有订单业务操作权限，无法归档客户 PO。');
  if (!text(orderId) || !file || file.size < 1 || file.size > CUSTOMER_PO_MAX_BYTES) throw new Error('请选择不超过 20 MiB 的有效客户 PO 原件。');
  if (!text(requestKey)) throw new Error('上传编号无效，请重新选择文件。');
  const form = new FormData(); form.append('file', file, file.name); form.append('requestKey', requestKey);
  const headers = new Headers(apiService.getAuthHeaders()); headers.delete('Content-Type');
  const response = await checked(await fetch(apiService.buildApiUrl(base(orderId), endpoint), { method: 'POST', headers, body: form }));
  const value = await response.json() as any;
  if (value?.ok !== true || !parseItem(value.item, orderId) || typeof value.item.replayed !== 'boolean') throw new Error('上传结果尚未确认，请保留当前文件并重新读取订单证据。');
  return value as CustomerPoEvidenceUploadAck;
}

export async function downloadCustomerPoEvidence(orderId: string, item: CustomerPoEvidence, endpoint?: string): Promise<void> {
  if (!parseItem(item, orderId)) throw new Error('客户 PO 版本信息不完整，请重新读取。');
  if (!hasPermission('orders:read')) throw new Error('当前账号没有订单查看权限。');
  const response = await checked(await fetch(apiService.buildApiUrl(`${base(orderId)}/${segment(item.id)}/download`, endpoint), { headers: apiService.getAuthHeaders() }));
  const blob = await response.blob();
  if (!blob.size) throw new Error('客户 PO 原件为空，请重新读取版本列表。');
  const href = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = href; link.download = item.fileName; link.style.display = 'none'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
