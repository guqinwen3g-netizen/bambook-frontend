import { apiService } from './apiService';
import type { DocumentVersionRecord, TradeDocument } from '../types';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d+(\.\d{1,4})?$/.test(value);
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const BUSINESS_CI_PREFIX = 'business-ci:v1:shipment:';

export interface BusinessShipmentCiLineSnapshot {
  shipmentLineId: string;
  itemNo: string | null;
  orderId: string;
  orderLineId: string;
  productionBatchIds: string[];
  description: string | null;
  materialCode: string | null;
  specification: unknown;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
}

/** The values displayed and written for CI come from the native source route. */
export interface BusinessShipmentCiSnapshot {
  protocolVersion: 1;
  sourceKind: 'shipment';
  shipmentId: string;
  packageKey: string;
  sourceFingerprint: string;
  orderIds: string[];
  lines: BusinessShipmentCiLineSnapshot[];
  totalAmount: string;
  currency: string;
  customerRelationId: string;
  contractNumber: string;
  letterOfCredit: Record<string, unknown> | null;
  parties: Record<string, unknown>;
  paymentInstrument: string;
  paymentTerms: string;
  deliveryTerms: string;
  confirmedOrderSnapshot: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface BusinessShipmentCiWriteCommand {
  lineIds: string[];
  requestKey: string;
  expectedSourceFingerprint: string;
}

export interface BusinessShipmentCiWriteResult {
  item: TradeDocument;
  versionId: string;
  replayed: boolean;
}

export interface BusinessShipmentCiVersion {
  documentId: string;
  versionId: string;
  version: number;
  snapshot: BusinessShipmentCiSnapshot;
}

function invalidSource(): never {
  throw new Error('业务 CI 原始出运快照响应不完整，请重新读取。');
}

function parseSnapshot(value: unknown, shipmentId: string): BusinessShipmentCiSnapshot {
  const data = value as any;
  if (!data || data.protocolVersion !== 1 || data.sourceKind !== 'shipment' || data.shipmentId !== shipmentId
    || !fingerprint(data.packageKey) || !fingerprint(data.sourceFingerprint) || !Array.isArray(data.orderIds)
    || data.orderIds.some((id: unknown) => !text(id)) || !Array.isArray(data.lines) || !data.lines.length
    || data.lines.some((line: any) => !line || !text(line.shipmentLineId) || !text(line.orderId) || !text(line.orderLineId)
      || !Array.isArray(line.productionBatchIds) || line.productionBatchIds.some((id: unknown) => !text(id))
      || !(line.itemNo === null || text(line.itemNo)) || !(line.description === null || typeof line.description === 'string')
      || !(line.materialCode === null || typeof line.materialCode === 'string') || !decimal(line.quantity)
      || !text(line.unit) || !decimal(line.unitPrice) || !decimal(line.amount))
    || new Set(data.lines.map((line: any) => line.shipmentLineId)).size !== data.lines.length
    || !decimal(data.totalAmount) || !text(data.currency) || !text(data.customerRelationId) || !text(data.contractNumber)
    || !(data.letterOfCredit === null || data.letterOfCredit && typeof data.letterOfCredit === 'object' && !Array.isArray(data.letterOfCredit))
    || !data.parties || typeof data.parties !== 'object' || Array.isArray(data.parties)
    || !text(data.paymentInstrument) || !text(data.paymentTerms) || !text(data.deliveryTerms)
    || !Array.isArray(data.confirmedOrderSnapshot)) return invalidSource();
  return data as BusinessShipmentCiSnapshot;
}

function parseWriteResult(value: unknown, shipmentId: string, expectedStatus: 'Draft' | 'Issued'): BusinessShipmentCiWriteResult {
  const data = value as any, item = data?.item;
  if (!item || !text(item.id) || item.shipmentId !== shipmentId || item.type !== 'CommercialInvoice'
    || item.domain !== 'customs' || item.sourceInvoiceId !== null || item.status !== expectedStatus
    || !text(item.sourceRef) || !item.sourceRef.startsWith(`${BUSINESS_CI_PREFIX}${shipmentId}:`)
    || !text(data.versionId) || typeof data.replayed !== 'boolean') {
    throw new Error('业务 CI 写入回执不完整，请刷新业务单据后核对。');
  }
  return { item: item as TradeDocument, versionId: data.versionId, replayed: data.replayed };
}

function validateLineIds(lineIds: string[]) {
  if (!Array.isArray(lineIds) || lineIds.length === 0 || lineIds.some(id => !text(id) || id !== id.trim())
    || new Set(lineIds).size !== lineIds.length) throw new Error('请选择准确的实际装运行。');
  return [...lineIds].sort();
}

function validateCommand(command: BusinessShipmentCiWriteCommand): BusinessShipmentCiWriteCommand {
  const lineIds = validateLineIds(command.lineIds);
  if (!/^[a-f0-9]{64}$/.test(command.requestKey) || !fingerprint(command.expectedSourceFingerprint))
    throw new Error('业务 CI 请求编号或来源指纹无效，请重新核对。');
  return { lineIds, requestKey: command.requestKey, expectedSourceFingerprint: command.expectedSourceFingerprint };
}

function endpointPath(shipmentId: string, suffix: string) {
  if (!text(shipmentId)) throw new Error('运单标识无效。');
  return `/v1/shipping/${encodeURIComponent(shipmentId)}/business-ci/${suffix}`;
}

async function postBusinessCi<T>(path: string, body: unknown, endpoint?: string): Promise<T> {
  const response = await fetch(apiService.buildApiUrl(path, endpoint), {
    method: 'POST',
    headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload.data as T;
}

export function createBusinessShipmentCiRequestKey(): string {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境无法生成安全的业务 CI 请求编号。');
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readBusinessShipmentCiSource(shipmentId: string, lineIds: string[], endpoint?: string) {
  const data = await postBusinessCi<unknown>(endpointPath(shipmentId, 'source'), { lineIds: validateLineIds(lineIds) }, endpoint);
  return parseSnapshot(data, shipmentId);
}

export async function createBusinessShipmentCiDraft(shipmentId: string, command: BusinessShipmentCiWriteCommand, endpoint?: string) {
  return parseWriteResult(await postBusinessCi(endpointPath(shipmentId, 'draft'), validateCommand(command), endpoint), shipmentId, 'Draft');
}

export async function reviseBusinessShipmentCiDraft(shipmentId: string, documentId: string, command: BusinessShipmentCiWriteCommand, endpoint?: string) {
  if (!text(documentId)) throw new Error('业务 CI 标识无效。');
  const path = endpointPath(shipmentId, `${encodeURIComponent(documentId)}/revise`);
  return parseWriteResult(await postBusinessCi(path, validateCommand(command), endpoint), shipmentId, 'Draft');
}

export async function issueBusinessShipmentCi(shipmentId: string, documentId: string, command: BusinessShipmentCiWriteCommand, endpoint?: string) {
  if (!text(documentId)) throw new Error('业务 CI 标识无效。');
  const path = endpointPath(shipmentId, `${encodeURIComponent(documentId)}/issue`);
  return parseWriteResult(await postBusinessCi(path, validateCommand(command), endpoint), shipmentId, 'Issued');
}

/** Finds existing logistics-owned CIs without consulting financial invoices. */
export async function listBusinessShipmentCiDocuments(shipmentId: string, endpoint?: string): Promise<TradeDocument[]> {
  const found: TradeDocument[] = [];
  let offset = 0, total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const page = await apiService.listTradeDocuments({ type: 'CommercialInvoice', domain: 'customs', shipmentId, limit: 200, offset }, endpoint);
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.items.length > 200)
      throw new Error('业务 CI 单据列表响应不完整，请重新读取。');
    total = page.total;
    found.push(...page.items);
    offset += page.items.length;
    if (offset < total && page.items.length === 0) throw new Error('业务 CI 单据列表分页不完整，请重新读取。');
  }
  return found.filter(item => item.shipmentId === shipmentId && item.type === 'CommercialInvoice' && item.domain === 'customs'
    && item.sourceInvoiceId === null && item.sourceRef?.startsWith(`${BUSINESS_CI_PREFIX}${shipmentId}:`));
}

export function businessShipmentCiSourceRef(shipmentId: string, packageKey: string) {
  if (!text(shipmentId) || !fingerprint(packageKey)) throw new Error('业务 CI 包标识无效。');
  return `${BUSINESS_CI_PREFIX}${shipmentId}:${packageKey}`;
}

export async function readLatestBusinessShipmentCiVersion(document: TradeDocument, endpoint?: string): Promise<BusinessShipmentCiVersion> {
  if (!text(document.id) || document.type !== 'CommercialInvoice' || document.domain !== 'customs'
    || document.sourceInvoiceId !== null || !document.shipmentId || !document.sourceRef?.startsWith(`${BUSINESS_CI_PREFIX}${document.shipmentId}:`))
    throw new Error('所选单据不是本票的业务 CI。');
  const result = await apiService.listTradeDocumentVersions(document.id, endpoint);
  const versions = Array.isArray(result?.items) ? result.items : [];
  const latest = versions.filter(row => row.documentId === document.id && positiveInt(row.version))
    .reduce<DocumentVersionRecord | null>((current, row) => !current || row.version > current.version ? row : current, null);
  const snapshot = latest?.content?.commercialInvoiceSnapshot as any;
  if (!latest || !text(latest.id) || !snapshot || snapshot.protocolVersion !== 1 || snapshot.sourceKind !== 'shipment'
    || snapshot.shipmentId !== document.shipmentId || !fingerprint(snapshot.packageKey) || !fingerprint(snapshot.sourceFingerprint)
    || document.sourceRef !== businessShipmentCiSourceRef(document.shipmentId, snapshot.packageKey))
    throw new Error('业务 CI 最新版本快照无法核验，请刷新单据后再操作。');
  return { documentId: document.id, versionId: latest.id, version: latest.version, snapshot: snapshot as BusinessShipmentCiSnapshot };
}

export async function archiveBusinessShipmentCiVersion(document: TradeDocument, versionId: string, endpoint?: string) {
  if (document.status !== 'Issued') throw new Error('只有已签发的业务 CI 可以归档。');
  const latest = await readLatestBusinessShipmentCiVersion(document, endpoint);
  if (latest.versionId !== versionId || !text((latest.snapshot as any).issuedAt))
    throw new Error('已签发 CI 版本已变化，请刷新后按当前版本重新归档。');
  const result = await apiService.generateTradeDocumentFile(document.id, { version: latest.version }, endpoint);
  if (!text(result?.filePath) || !text(result?.fileName) || !positiveInt(result?.fileSize))
    throw new Error('业务 CI PDF 归档回执不完整，请核对单据中心。');
  return { ...result, version: latest.version };
}

