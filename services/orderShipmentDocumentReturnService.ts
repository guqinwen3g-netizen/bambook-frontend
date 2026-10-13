import { apiService } from './apiService';
import { hasPermission } from './authService';

export type ShipmentBusinessDocumentType = 'CommercialInvoice' | 'PackingList';
export interface OrderShipmentDocumentReturnRow {
  shipment: { id: string; shipmentNumber: string };
  document: { id: string; type: ShipmentBusinessDocumentType; documentNumber: string; status: string };
  latestVersion: { id: string; version: number; issued: boolean; archived: boolean; eligible: boolean };
  currentSent: boolean;
  sendHistory: Array<{ eventId: string; versionId: string; version: number; sentAt: string; recipient: string; actorId: string }>;
}
export interface OrderShipmentDocumentsResponse { ok: true; orderId: string; documents: OrderShipmentDocumentReturnRow[] }
export interface MarkShipmentDocumentSentInput {
  requestKey: string;
  shipmentId: string;
  documentId: string;
  versionId: string;
  version: number;
  recipient: string;
}
export interface ShipmentDocumentSentEvent { eventId: string; versionId: string; version: number; sentAt: string; recipient: string; actorId: string }
export interface MarkShipmentDocumentSentResponse { ok: true; event: ShipmentDocumentSentEvent; replayed: boolean }

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const DOCUMENT_TYPES = new Set<ShipmentBusinessDocumentType>(['CommercialInvoice', 'PackingList']);

function invalid(): never { throw new Error('订单出运单据响应不完整，请重新读取。'); }

function parseDocuments(value: unknown, orderId: string): OrderShipmentDocumentsResponse {
  const data = value as any;
  if (!data || data.ok !== true || data.orderId !== orderId || !Array.isArray(data.documents)) return invalid();
  const keys = new Set<string>();
  for (const row of data.documents) {
    if (!text(row?.shipment?.id) || !text(row.shipment.shipmentNumber)
      || !text(row?.document?.id) || !DOCUMENT_TYPES.has(row.document.type)
      || !text(row.document.documentNumber) || !text(row.document.status)
      || !text(row?.latestVersion?.id) || !positiveInt(row.latestVersion.version)
      || typeof row.latestVersion.issued !== 'boolean' || typeof row.latestVersion.archived !== 'boolean'
      || typeof row.latestVersion.eligible !== 'boolean' || typeof row.currentSent !== 'boolean'
      || !Array.isArray(row.sendHistory)) return invalid();
    const key = `${row.shipment.id}:${row.document.id}`;
    if (keys.has(key)) return invalid();
    keys.add(key);
    const eventIds = new Set<string>();
    for (const event of row.sendHistory) {
      if (!text(event?.eventId) || !text(event.versionId) || !positiveInt(event.version)
        || !text(event.sentAt) || !Number.isFinite(Date.parse(event.sentAt)) || !text(event.recipient) || !text(event.actorId)
        || eventIds.has(event.eventId)) return invalid();
      eventIds.add(event.eventId);
    }
  }
  return data as OrderShipmentDocumentsResponse;
}

async function request<T>(orderId: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal, endpoint?: string): Promise<T> {
  if (!text(orderId)) throw new Error('请重新打开原订单。');
  if (!hasPermission(method === 'GET' ? 'orders:read' : 'orders:write')) throw new Error(method === 'GET' ? '当前账号没有订单出运单据读取权限。' : '当前账号没有订单业务操作权限。');
  const response = await fetch(apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(orderId)}/shipment-documents${method === 'POST' ? '/sent' : ''}`, endpoint), {
    method,
    headers: { ...apiService.getAuthHeaders(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  const data = await response.json().catch(() => null) as any;
  if (!response.ok || data?.ok !== true) throw new Error(data?.error?.message || data?.message || `订单出运单据操作未确认（HTTP ${response.status}）。`);
  return data as T;
}

export function createShipmentDocumentSendRequestKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前环境无法生成安全的操作编号，请刷新后重试。');
  return globalThis.crypto.randomUUID();
}

export async function listOrderShipmentDocuments(orderId: string, signal?: AbortSignal, endpoint?: string): Promise<OrderShipmentDocumentsResponse> {
  return parseDocuments(await request(orderId, 'GET', undefined, signal, endpoint), orderId);
}

export async function markOrderShipmentDocumentSent(orderId: string, input: MarkShipmentDocumentSentInput, endpoint?: string): Promise<MarkShipmentDocumentSentResponse> {
  if (!text(input.requestKey) || !text(input.shipmentId) || !text(input.documentId) || !text(input.versionId)
    || !positiveInt(input.version) || !text(input.recipient) || input.recipient.trim() !== input.recipient)
    throw new Error('请核对出运单据版本和收件人后再登记。');
  const data = await request<MarkShipmentDocumentSentResponse>(orderId, 'POST', input, undefined, endpoint) as any;
  const event = data?.event;
  if (data?.ok !== true || typeof data.replayed !== 'boolean' || !text(event?.eventId) || !text(event.versionId)
    || !positiveInt(event.version) || !text(event.sentAt) || !Number.isFinite(Date.parse(event.sentAt))
    || !text(event.recipient) || !text(event.actorId)) throw new Error('发送登记回执不完整，请重新读取单据历史核对。');
  return data as MarkShipmentDocumentSentResponse;
}

export async function downloadOrderShipmentDocument(row: OrderShipmentDocumentReturnRow, endpoint?: string, isCurrent?: () => boolean): Promise<void> {
  if (!row?.document?.id || !positiveInt(row.latestVersion?.version) || row.latestVersion.archived !== true)
    throw new Error('当前版本尚未归档，暂不能下载。');
  const label = row.document.type === 'CommercialInvoice' ? 'CI' : 'PL';
  const safeNumber = row.document.documentNumber.replace(/[^\w.-]+/g, '_');
  await apiService.downloadTradeDocumentArchive(row.document.id, `${label}_${safeNumber}_v${row.latestVersion.version}.pdf`, endpoint, row.latestVersion.version, isCurrent);
}
