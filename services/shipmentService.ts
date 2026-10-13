/**
 * Shipment API service.
 * Communicates with /api/v1/shipping endpoints.
 */
import { apiService } from './apiService';
import { GATE_BLOCKED_CODE } from './exceptionService';
import { getAuthState, subscribe as subscribeAuth } from './authService';
import { beginBusinessRequest, readBusinessRequest, listBusinessRequests, clearAcknowledgedBusinessRequest } from './businessRequestRecovery';
import type { Shipment, ShipmentStatus, ShipmentEvent, ShipmentLine, ShipmentCarton, ShipmentCartonItem, ShipmentLandTransport } from '../types';

// ════════════════════════════════════════════════════════════════
// T4 · 出运放行门禁阻断明细（被 409 拦了要能就地申请 DR-013 例外放行）
//
// 服务端链路：shipmentEligibilityGate.ts:59 ShipmentReleaseGateBlockedError
//   → shipmentMutationService.ts:121-133 toMutationError 挂到 error.gateDetails
//   → shipping/route.ts:552/583 原样 json({ error })，HTTP 409 + code='GATE_BLOCKED'。
// 前端此前只捞 error.message，明细在到达 UI 之前就被丢掉了。
// ════════════════════════════════════════════════════════════════

/** DR-013 例外 scope 动作标识 —— 必须与后端 shipmentEligibilityGate.ts:41 精确一致，否则批了也匹配不上 */
export const SHIPMENT_RELEASE_ACTION = 'shipment:release' as const;

export interface ShipmentGateBlockedOrder {
  orderId: string;
  /** 链分派结果；not_found = 订单不存在/已删除（fail-closed 视同不具备资格） */
  chain: 'fabric' | 'garment' | 'other' | 'not_found';
  /** 原始门禁是否具备资格（不感知例外） */
  eligible: boolean;
  /** 原始阻断原因码（面料三条件 / 服装 Final QC / ORDER_NOT_FOUND） */
  blockingReasons: string[];
  /** 最终放行通道；exception = 已由 DR-013 例外放行 */
  via?: 'gate' | 'exception';
}

export interface ShipmentGateDetails {
  /** 聚合阻断原因，`{orderId}:{reason}` 维度（合票场景可区分订单） */
  blockingReasons: string[];
  /** 逐订单判定明细 —— UI 按这个逐行渲染「哪个订单缺哪条」 */
  orders: ShipmentGateBlockedOrder[];
  /** 首个无例外订单的例外查询结论（无申请/未批准/已过期/已核销） */
  exceptionReason?: string;
  exceptionEntryHint?: string;
}

/** 门禁原因码 → 大白话；未知码原样显示，避免把服务端的新码吞掉 */
export const SHIPMENT_GATE_REASON_LABEL: Record<string, string> = {
  BULK_QC_NOT_PASSED: '大货终检未通过',
  SS_NOT_CONFIRMED: '客户还没确认船样（S/S）',
  RC_NOT_CONFIRMED: '客户还没确认匹头样（RC）',
  GARMENT_FINAL_QC_NOT_PASSED: '大货终期 Final QC 未通过',
  ORDER_NOT_FOUND: '关联订单不存在或已删除',
};

export function describeGateReason(reason: string): string {
  return SHIPMENT_GATE_REASON_LABEL[reason] ?? reason;
}

/**
 * 从错误里取出「出运放行门禁阻断明细」；非门禁错误、或明细缺失 → null。
 * 单独抽成纯函数是为了能单测 —— 光靠肉眼看代码，接线断了是发现不了的
 * （历史上正是「只捞 message」导致明细在到达 UI 前被丢掉）。
 */
export function extractGateBlock(error: unknown): ShipmentGateDetails | null {
  const e = error as any;
  if (e?.code !== GATE_BLOCKED_CODE) return null;
  return e?.gateDetails && Array.isArray(e.gateDetails.orders) ? (e.gateDetails as ShipmentGateDetails) : null;
}

/**
 * 把服务端错误信封里的结构化信息原样挂到 Error 上（范式同 services/exceptionService.ts readError）。
 * 只有 message 的话，UI 拿不到 code 就分不出「门禁拦截」和「表单填错」，
 * 拿不到 gateDetails 就列不出「哪个订单缺哪条」。
 */
function throwShipmentError(res: Response, data: any, fallback: string): never {
  const message = String(data?.error?.message ?? data?.error ?? `${fallback}: HTTP ${res.status}`);
  const err: any = new Error(message);
  err.status = res.status;
  err.code = typeof data?.error?.code === 'string' ? data.error.code : undefined;
  if (data?.error?.gateDetails) err.gateDetails = data.error.gateDetails;
  throw err;
}

type ShipmentListParams = {
  status?: ShipmentStatus;
  orderId?: string;
  carrier?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

/** Phase B3 — 准交率统计（与 server/src/shipping/shipmentStatsService.ts 契约一致） */
export interface OnTimeBucket {
  total: number;
  onTime: number;
  late: number;
  pending: number;
  rate: number | null; // onTime / (total - pending)；无可判定样本时为 null
}

export interface OnTimeStats {
  from: string | null;
  to: string | null;
  shipment: OnTimeBucket; // 运单准点率（ata ≤ eta）
  order: OnTimeBucket; // 订单准交率（最后一票 ata ≤ dueDate）
}

/** C4 — 运输方式维度统计（与 server/src/shipping/shipmentStatsService.ts getMethodStats 契约一致） */
export interface MethodBucket {
  method: string;
  total: number;
  inTransit: number;
  delivered: number;
  cancelled: number;
  judged: number;
  onTime: number;
  late: number;
  onTimeRate: number | null;
}

export interface MethodStats {
  from: string | null;
  to: string | null;
  methods: MethodBucket[];
}

/**
 * ★ C1 — 拼柜（一柜多票）聚合（与 server/src/shipping/containerConsolidationService.ts 契约一致）
 *
 * 为什么要有：柜号字段本来就有（`Shipment.containerNumber`），但**没有按柜聚合的能力** ——
 * 一柜装了几票/几个客户/多少件多少吨、对应几张报关单退了多少税、
 * ★「同柜但 ETD/目的港/船名不一致」都只能人工翻运单。
 */
export interface ContainerConflict {
  code: 'ETD_MISMATCH' | 'DISCHARGE_PORT_MISMATCH' | 'VESSEL_MISMATCH' | 'VOYAGE_MISMATCH';
  message: string;
  values: string[];
  shipmentNumbers: string[];
}

export interface ContainerShipmentRow {
  id: string;
  shipmentNumber: string;
  status: string;
  customerName: string | null;
  businessLine: string | null;
  orderId: string | null;
  etd: string | null;
  eta: string | null;
  atd: string | null;
  ata: string | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  vesselOrFlight: string | null;
  voyageNumber: string | null;
  sealNumber: string | null;
  totalPackages: number | null;
  grossWeight: number | null;
  volume: number | null;
}

export interface ContainerGroup {
  containerNumber: string;
  shipmentCount: number;
  customerCount: number;
  shipments: ContainerShipmentRow[];
  customsDeclarations: Array<{
    id: string; declarationNumber: string; shipmentId: string | null; status: string;
    totalValue: number | null; currency: string | null; declarationDate: string | null;
  }>;
  taxRefunds: Array<{
    id: string; declarationId: string | null; status: string;
    refundAmount: number | null; exportAmountFob: number | null; currency: string | null;
  }>;
  totals: { totalPackages: number; grossWeight: number; volume: number };
  conflicts: ContainerConflict[];
}

export interface ContainerConsolidation {
  from: string | null;
  to: string | null;
  containers: ContainerGroup[];
  unassigned: { shipmentCount: number; shipments: ContainerShipmentRow[] };
  summary: {
    containerCount: number;
    consolidatedCount: number;
    ticketCount: number;
    unassignedCount: number;
    conflictCount: number;
  };
}

/** C4 — 装运行写入载荷（镜像 server shipmentPackingService.ShipmentLineInput；null 清空字段） */
export interface ShipmentLineInput {
  orderLineId?: string | null;
  productCode?: string | null;
  productName?: string | null;
  colorCode?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  cartons?: number | null;
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  volume?: number | string | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
}

/** C4 — 逐箱写入载荷（镜像 server shipmentPackingService.ShipmentCartonInput） */
export interface ShipmentCartonInput {
  cartonNo: string;
  description?: string | null;
  length?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  grossWeight?: number | string | null;
  netWeight?: number | string | null;
  volume?: number | string | null;
  items?: Array<{ shipmentLineId: string; quantity: number | string }>;
}

/** DR-016 合票建模 — 票内订单分配记录（镜像 server/src/shipping/allocationService.ts 返回行） */
export interface ShipmentAllocation {
  id: string;
  shipmentId: string;
  orderId: string;
  orderLineId?: string | null;
  plannedQty?: number | string | null;
  actualQty?: number | string | null;
  unit?: string | null;
  status?: string; // Planned | PartiallyShipped | Fulfilled | ShortShipped | Cancelled
  batchOrCartonNote?: string | null;
  exception?: string | null;
  createdAt?: number | string;
  updatedAt?: number | string;
  productionBatchAllocations?: ShipmentPhysicalAllocationProjection[];
}

export interface ShipmentPhysicalAllocationRow {
  productionBatchId: string; expectedRevision: number; expectedScopeFingerprint: string;
  stockReceiptId: string | null; factoryLoadingReceiptId?: string; plannedQty: string | null; actualQty: string | null; unit: string;
}
export interface ShipmentPhysicalAllocationProjection {
  id: string; productionBatchId: string; productionBatchRevision: number; state: string;
  plannedQty: string | null; actualQty: string | null; unit: string;
  scopeSnapshot: { scopeFingerprint: string; receiptAllocations: Array<{
    stockReceiptId: string | null; factoryLoadingReceiptId?: string; sourceKind?: 'factory_direct'; plannedQty: string | null; actualQty: string | null;
    factoryRelationId?: string; loadedQuantity?: string; loadingScopeFingerprint?: string; loadingCommandHash?: string;
    warehouseId?: string; inventoryItemId?: string; receivedQuantity?: string;
  }> };
}
/** DR-016 — 修正票内分配载荷（全字段可选，未传字段保持原值） */
export interface ShipmentAllocationPatch {
  requestKey?: string;
  expectedAllocationUpdatedAt?: string;
  productionBatchAllocations?: ShipmentPhysicalAllocationRow[];
  plannedQty?: number | string | null;
  actualQty?: number | string | null;
  unit?: string | null;
  status?: string;
  batchOrCartonNote?: string | null;
  exception?: string | null;
}

/** DR-016 — 新增票内分配载荷（合票/拆票；同客户同业务线由后端校验） */
export interface ShipmentAllocationInput {
  requestKey?: string;
  expectedAllocationUpdatedAt?: string;
  productionBatchAllocations?: ShipmentPhysicalAllocationRow[];
  orderId: string;
  orderLineId?: string | null;
  plannedQty?: number | string | null;
  actualQty?: number | string | null;
  unit?: string | null;
  status?: string;
  batchOrCartonNote?: string | null;
  exception?: string | null;
}

export type ShipmentPhysicalReadContext = { kind: 'physical' | 'legacy' | 'claim'; updatedAt: string; allocationFingerprint: string };
export type PackingLineCommand = Omit<ShipmentLineInput, 'quantity' | 'grossWeight' | 'netWeight' | 'volume'> & { clientLineKey: string; quantity: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null };
export type PackingCartonCommand = Omit<ShipmentCartonInput, 'items' | 'length' | 'width' | 'height' | 'grossWeight' | 'netWeight' | 'volume'> & { length: string | null; width: string | null; height: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null; items: Array<{ lineKey: string; quantity: string }> };
export type ShipmentPackingPayload = { lines: PackingLineCommand[]; cartons: PackingCartonCommand[] };
export type ShipmentPackingLine = Omit<ShipmentLine, 'quantity' | 'grossWeight' | 'netWeight' | 'volume'> & { quantity: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null };
export type ShipmentPackingCarton = Omit<ShipmentCarton, 'length' | 'width' | 'height' | 'grossWeight' | 'netWeight' | 'volume' | 'items'> & { length: string | null; width: string | null; height: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null; items: Array<Omit<ShipmentCartonItem, 'quantity'> & { quantity: string }> };
export type ShipmentPackingSnapshot = { shipment: Shipment; context: ShipmentPhysicalReadContext; lines: ShipmentPackingLine[]; cartons: ShipmentPackingCarton[];
  sources: Array<{ orderLineId: string; orderId: string; productCode: string | null; productName: string | null; unit: string; actualQty: string }> };
export type PendingPackingIntent = { requestId: string; payload: { input: ShipmentPackingPayload; context: ShipmentPhysicalReadContext } };
export type ShipmentPackingResult = { shipment: Shipment; lines: ShipmentPackingLine[]; cartons: ShipmentPackingCarton[]; replayed: boolean;
  acknowledgement: { schemaVersion: number; command: unknown; commandHash: string; resultHash: string } };
type PendingShipmentIntent = { input: Partial<Shipment>; context: ShipmentPhysicalReadContext };
export type PendingPhysicalAllocation = { requestId: string; allocationId?: string;
  input: ShipmentAllocationInput | ShipmentAllocationPatch };
export const canonicalShipmentCommand = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const commandHash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(canonicalShipmentCommand(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
function shipmentSession(base: string) {
  const auth = getAuthState(), actorId = auth.isAuthenticated ? auth.user?.id : null;
  if (!actorId) throw new Error('请重新登录后继续办理运单。');
  const headers = apiService.getAuthHeaders();
  return { actorId, headers, identity: canonicalShipmentCommand([actorId, base, apiService.getStoredConfig().cloudEndpoint, headers,
    auth.user?.roles ?? [], auth.user?.permissions ?? [], auth.user?.permissionCeiling ?? null]) };
}
function assertShipmentSession(original: ReturnType<typeof shipmentSession>, base: string) {
  if (shipmentSession(base).identity !== original.identity) throw new Error('账号、权限或服务地址已变化，请重新核对当前运单。');
}
/** Match the native contract before persisting: valid Decimal text normalizes,
 * while unknown/null remains unknown and numbers never become physical facts. */
function normalizePhysicalAllocationIntent(input: ShipmentAllocationInput | ShipmentAllocationPatch) {
  const payload = JSON.parse(JSON.stringify(input)); delete payload.requestKey;
  const amount = (value: unknown): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
      throw new Error('实际批次分配数量须为精确十进制字符串，最多四位小数。');
    const [whole, fraction = ''] = value.split('.'), tail = fraction.replace(/0+$/, '');
    return whole + (tail ? '.' + tail : '');
  };
  const normalize = (row: any) => {
    for (const key of ['plannedQty', 'actualQty']) if (Object.prototype.hasOwnProperty.call(row, key)) row[key] = amount(row[key]);
    for (const key of ['orderId', 'orderLineId', 'productionBatchId', 'unit', 'stockReceiptId', 'factoryLoadingReceiptId', 'batchOrCartonNote', 'exception'])
      if (typeof row[key] === 'string') row[key] = row[key].trim();
    return row;
  };
  normalize(payload);
  if (Array.isArray(payload.productionBatchAllocations)) payload.productionBatchAllocations = payload.productionBatchAllocations.map(normalize);
  return payload;
}
const unconfirmedShipment = () => { throw new Error('运单回执与原请求不一致，结果尚未确认；请保留原内容重试。'); };

// Receipt hashes bind an exact command, but facts must also match that command.
// This independent client projection never uses Number for a business quantity.
function packingDecimal(value: unknown, places = 4): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, tail = ''] = value.split('.');
  if (tail.length > places) return null;
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(tail.padEnd(places, '0'));
}
const packingLineScales: Record<string, [number, number]> = { quantity: [14, 4], grossWeight: [9, 3], netWeight: [9, 3], volume: [9, 3] };
const packingCartonScales: Record<string, [number, number]> = { length: [8, 2], width: [8, 2], height: [8, 2], grossWeight: [9, 3], netWeight: [9, 3], volume: [8, 4] };
function packingScalarsMatch(row: any, scales: Record<string, [number, number]>): boolean {
  return Object.entries(scales).every(([key, [integers, places]]) => row?.[key] === null
    || (packingDecimal(row?.[key], places) !== null && packingDecimal(row[key], places)! < 10n ** BigInt(integers + places)));
}
function packingFlight(session: ReturnType<typeof shipmentSession>, base: string, sessionReader = shipmentSession) {
  let invalidated = false;
  const invalidate = () => { try { if (sessionReader(base).identity !== session.identity) invalidated = true; } catch { invalidated = true; } };
  const unsubscribe = subscribeAuth(invalidate);
  if (typeof window !== 'undefined') { window.addEventListener('storage', invalidate); window.addEventListener('focus', invalidate); }
  return {
    check: () => { invalidate(); if (invalidated) throw new Error('账号、权限或服务地址已变化，请保留原装箱请求并重新核对。'); },
    stop: () => { unsubscribe(); if (typeof window !== 'undefined') { window.removeEventListener('storage', invalidate); window.removeEventListener('focus', invalidate); } },
  };
}
export type ShipmentCartonMetadataSnapshot = ShipmentPackingSnapshot & { metadata: { sourceFingerprint: string; dispatchHash: string } };
export type ShipmentCartonMetadataPayload = { reason: string; cartons: Array<Omit<ShipmentCartonInput, 'items' | 'length' | 'width' | 'height' | 'grossWeight' | 'netWeight' | 'volume'> & {
  length: string | null; width: string | null; height: string | null; grossWeight: string | null; netWeight: string | null; volume: string | null;
  items: Array<{ shipmentLineId: string; quantity: string }> }> };
export type PendingCartonMetadataIntent = { requestId: string; payload: { input: ShipmentCartonMetadataPayload; snapshot: ShipmentCartonMetadataSnapshot; identity: string } };
function cartonSession(base: string) {
  const session = shipmentSession(base), auth = getAuthState();
  if (auth.isLoading) throw new Error('当前账号仍在核验，请保留原包装资料请求。');
  return { ...session, identity: canonicalShipmentCommand([session.identity, auth.isLoading, auth.user?.roleIds ?? [], auth.user?.departmentIds ?? [], auth.user?.department ?? null]) };
}
function cartonSnapshotMatches(id: string, data: any): data is ShipmentCartonMetadataSnapshot {
  return data?.shipment?.id === id && data.shipment.status === 'Shipped' && data.context?.kind === 'physical'
    && typeof data.context.updatedAt === 'string' && /^(?:0|[1-9]\d*)$/.test(data.context.updatedAt)
    && typeof data.context.allocationFingerprint === 'string' && /^[a-f0-9]{64}$/.test(data.context.allocationFingerprint)
    && ['sourceFingerprint', 'dispatchHash'].every(key => typeof data.metadata?.[key] === 'string' && /^[a-f0-9]{64}$/.test(data.metadata[key]))
    && Array.isArray(data.lines) && data.lines.length > 0 && Array.isArray(data.cartons) && Array.isArray(data.sources)
    && data.lines.every((row: any) => row?.id && row.shipmentId === id) && data.cartons.every((row: any) => row?.id && row.shipmentId === id && Array.isArray(row.items))
    && packingSnapshotMatches(id, data);
}
function cartonInputMatches(id: string, input: any, snapshot: any): input is ShipmentCartonMetadataPayload {
  if (!cartonSnapshotMatches(id, snapshot) || !input || Object.keys(input).some(key => !['reason', 'cartons'].includes(key))
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000 || !Array.isArray(input.cartons) || !input.cartons.length || input.cartons.length > 1000) return false;
  const numbers = new Set<string>(), totals = new Map<string, bigint>();
  for (const carton of input.cartons) {
    if (!carton || Object.keys(carton).some(key => !['cartonNo', 'description', 'length', 'width', 'height', 'grossWeight', 'netWeight', 'volume', 'items'].includes(key))
      || typeof carton.cartonNo !== 'string' || !carton.cartonNo.trim() || carton.cartonNo.length > 200
      || /^\d+\s*(?:-|~|～|—|–|至)\s*\d+$/.test(carton.cartonNo.trim()) || numbers.has(carton.cartonNo.trim())
      || !packingScalarsMatch(carton, packingCartonScales) || !Array.isArray(carton.items) || !carton.items.length || carton.items.length > 500
      || carton.description != null && (typeof carton.description !== 'string' || carton.description.length > 2000)) return false;
    numbers.add(carton.cartonNo.trim()); const used = new Set<string>();
    for (const item of carton.items) {
      if (!item || Object.keys(item).some(key => !['shipmentLineId', 'quantity'].includes(key)) || !snapshot.lines.some((row: any) => row.id === item.shipmentLineId)
        || used.has(item.shipmentLineId) || packingDecimal(item.quantity) === null || packingDecimal(item.quantity)! <= 0n || packingDecimal(item.quantity)! >= 10n ** 18n) return false;
      used.add(item.shipmentLineId); totals.set(item.shipmentLineId, (totals.get(item.shipmentLineId) ?? 0n) + packingDecimal(item.quantity)!);
    }
  }
  return snapshot.lines.every((line: any) => packingDecimal(line.quantity) !== null && packingDecimal(line.quantity) === (totals.get(line.id) ?? 0n));
}
function cartonVolume(carton: ShipmentCartonMetadataPayload['cartons'][number]): bigint | null {
  if (carton.volume !== null) return packingDecimal(carton.volume, 4);
  const values = [carton.length, carton.width, carton.height].map(value => packingDecimal(value, 2));
  return values.some(value => value === null) ? null : (values[0]! * values[1]! * values[2]! + 50000000n) / 100000000n;
}
function cartonFactsMatch(id: string, pending: PendingCartonMetadataIntent['payload'], data: any): boolean {
  const input = pending.input, original = pending.snapshot;
  if (!cartonInputMatches(id, input, original) || data?.shipment?.id !== id || data.shipment.status !== 'Shipped'
    || canonicalShipmentCommand(data.lines) !== canonicalShipmentCommand(original.lines) || !Array.isArray(data.cartons) || data.cartons.length !== input.cartons.length
    || new Set(data.cartons.map((row: any) => row?.id)).size !== input.cartons.length || data.shipment.totalPackages !== input.cartons.length || data.headerSources?.totalPackages !== 'cartons') return false;
  for (const [index, carton] of input.cartons.entries()) {
    const actual = data.cartons[index];
    if (!actual?.id || actual.shipmentId !== id || actual.cartonNo !== carton.cartonNo.trim() || (actual.description ?? null) !== (carton.description ?? null)
      || !packingScalarsMatch(actual, packingCartonScales) || !Array.isArray(actual.items) || actual.items.length !== carton.items.length
      || new Set(actual.items.map((row: any) => row?.id)).size !== carton.items.length) return false;
    for (const key of ['length', 'width', 'height', 'grossWeight', 'netWeight', 'volume'] as const) {
      const expected = key === 'volume' ? cartonVolume(carton) : packingDecimal(carton[key], packingCartonScales[key][1]);
      if (expected !== packingDecimal(actual[key], packingCartonScales[key][1]) || expected === null && actual[key] !== null) return false;
    }
    for (const item of carton.items) {
      const stored = actual.items.find((row: any) => row.shipmentLineId === item.shipmentLineId);
      if (!stored?.id || stored.cartonId !== actual.id || packingDecimal(stored.quantity) !== packingDecimal(item.quantity)) return false;
    }
  }
  for (const key of ['grossWeight', 'netWeight', 'volume'] as const) {
    const places = key === 'volume' ? 4 : 3;
    const measurements = input.cartons.map(carton => key === 'volume' ? cartonVolume(carton) : packingDecimal(carton[key], places));
    const known = measurements.every(value => value !== null), sum = known ? measurements.reduce<bigint>((total, value) => total + value!, 0n) : null;
    if (data.headerSources?.[key] !== (known ? 'cartons' : 'existing_shipment')) return false;
    const expected = known ? sum : packingDecimal(String(original.shipment[key]), places);
    if (expected !== packingDecimal(data.shipment[key], places) || expected === null && data.shipment[key] !== null) return false;
  }
  return true;
}

function packingSnapshotMatches(id: string, data: any): boolean {
  return data?.shipment?.updatedAt === data?.context?.updatedAt
    && data.lines.every((row: any) => packingScalarsMatch(row, packingLineScales))
    && data.cartons.every((row: any) => packingScalarsMatch(row, packingCartonScales)
      && row.items.every((item: any) => item?.id && item.cartonId === row.id && item.shipmentLineId && packingDecimal(item.quantity) !== null && packingDecimal(item.quantity)! > 0n))
    && new Set(data.lines.map((row: any) => row.id)).size === data.lines.length && new Set(data.cartons.map((row: any) => row.id)).size === data.cartons.length
    && new Set(data.sources.map((row: any) => row?.orderLineId)).size === data.sources.length
    && data.sources.every((row: any) => row?.orderLineId && row.orderId && typeof row.unit === 'string' && row.unit.trim() && packingDecimal(row.actualQty) !== null && packingDecimal(row.actualQty)! > 0n);
}
function packingFactsMatch(id: string, input: ShipmentPackingPayload, data: any): boolean {
  if (!Array.isArray(data.lines) || !Array.isArray(data.cartons) || data.lines.length !== input.lines.length || data.cartons.length !== input.cartons.length
    || data.lines.some((row: any) => !packingScalarsMatch(row, packingLineScales)) || data.cartons.some((row: any) => !packingScalarsMatch(row, packingCartonScales))
    || new Set(data.lines.map((row: any) => row?.id)).size !== input.lines.length || new Set(data.cartons.map((row: any) => row?.id)).size !== input.cartons.length) return false;
  const equal = (wanted: any, actual: any, numeric: boolean, places = 4) => wanted == null ? actual == null
    : numeric ? packingDecimal(String(wanted), places) !== null && packingDecimal(String(wanted), places) === packingDecimal(actual, places) : wanted === actual;
  const ids = new Map<string, string>();
  for (const [index, line] of input.lines.entries()) {
    const actual = data.lines[index];
    if (!actual?.id || actual.shipmentId !== id || actual.lineNumber !== index + 1) return false;
    ids.set(line.clientLineKey, actual.id);
    for (const key of ['orderLineId', 'productCode', 'productName', 'colorCode', 'quantity', 'unit', 'cartons', 'grossWeight', 'netWeight', 'volume', 'hsCode', 'countryOfOrigin'])
      if (!equal((line as any)[key] ?? null, actual[key] ?? null, ['quantity', 'grossWeight', 'netWeight', 'volume'].includes(key), packingLineScales[key]?.[1] ?? 4)) return false;
  }
  for (const [index, carton] of input.cartons.entries()) {
    const actual = data.cartons[index];
    if (!actual?.id || actual.shipmentId !== id || actual.cartonNo !== carton.cartonNo.trim() || !Array.isArray(actual.items)
      || actual.items.length !== carton.items.length || new Set(actual.items.map((row: any) => row?.id)).size !== carton.items.length) return false;
    for (const key of ['description', 'length', 'width', 'height', 'grossWeight', 'netWeight', 'volume']) {
      let wanted = (carton as any)[key] ?? null;
      if (key === 'volume' && wanted === null && carton.length != null && carton.width != null && carton.height != null) {
        const dimensions = [carton.length, carton.width, carton.height].map(value => packingDecimal(String(value), 2));
        if (dimensions.some(value => value === null)) return false;
        const scaled = (dimensions[0]! * dimensions[1]! * dimensions[2]! + 50000000n) / 100000000n;
        wanted = String(scaled / 10000n) + '.' + String(scaled % 10000n).padStart(4, '0');
      }
      if (!equal(wanted, actual[key] ?? null, key !== 'description', packingCartonScales[key]?.[1] ?? 4)) return false;
    }
    for (const item of carton.items) {
      const row = actual.items.find((row: any) => row.shipmentLineId === ids.get(item.lineKey));
      if (!row?.id || row.cartonId !== actual.id || !equal(item.quantity, row.quantity, true)) return false;
    }
  }
  return true;
}

function validShipmentScheduleHistory(data: any, shipmentId: string): boolean {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  const safeJson = (value: unknown): boolean => {
    const pending: unknown[] = [value], seen = new Set<object>();
    while (pending.length) {
      const item = pending.pop();
      if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
      if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
      if (!item || typeof item !== 'object' || seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) { pending.push(...item); continue; }
      if (!record(item) || Object.keys(item).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return false;
      pending.push(...Object.values(item));
    }
    return true;
  };
  if (!record(data) || !exact(data, ['shipmentId', 'count', 'changes']) || data.shipmentId !== shipmentId
    || !Number.isSafeInteger(data.count) || (data.count as number) < 0 || !Array.isArray(data.changes)
    || data.count !== data.changes.length) return false;
  const ids = new Set<string>();
  return data.changes.every(change => {
    if (!record(change) || !exact(change, ['auditId', 'field', 'fieldLabel', 'fromValue', 'toValue', 'description', 'actorId', 'at', 'transactionId'])
      || typeof change.auditId !== 'string' || !change.auditId || ids.has(change.auditId)
      || typeof change.field !== 'string' || !change.field || typeof change.fieldLabel !== 'string'
      || typeof change.description !== 'string' || !safeJson(change.fromValue) || !safeJson(change.toValue)
      || !(change.actorId === null || typeof change.actorId === 'string')
      || !(change.transactionId === null || typeof change.transactionId === 'string')
      || !(change.at === null || typeof change.at === 'string' && Number.isFinite(Date.parse(change.at)) && new Date(change.at).toISOString() === change.at)) return false;
    ids.add(change.auditId); return true;
  });
}

async function executeShipmentPatch(id: string, submitted: Partial<Shipment>, endpoint?: string,
  transport?: { operation: string; suffix: string; body: Record<string, unknown> }): Promise<Shipment> {
  const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = shipmentSession(base);
  const input = JSON.parse(JSON.stringify(submitted));
  const operation = `shipment:${transport?.operation ?? 'update'}:${id}`, prior = readBusinessRequest<PendingShipmentIntent>(operation, base);
  if (prior && canonicalShipmentCommand(prior.payload.input) !== canonicalShipmentCommand(input))
    throw new Error('上次运单请求结果尚未确认，请恢复原内容后重试。');
  let pending = prior;
  if (!pending) {
    const context = await shipmentService.getPhysicalContext(id, base);
    assertShipmentSession(session, base);
    if (context.kind === 'physical') pending = beginBusinessRequest(operation, { input, context }, base);
  }
  const command = pending ? { requestKey: pending.requestId, expectedShipmentUpdatedAt: pending.payload.context.updatedAt,
    expectedPhysicalAllocationFingerprint: pending.payload.context.allocationFingerprint } : undefined;
  assertShipmentSession(session, base);
  const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}${transport?.suffix ?? ''}`, base), {
    method: transport ? 'POST' : 'PATCH', headers: session.headers, body: JSON.stringify({ ...(transport?.body ?? input), ...command }),
  });
  let data: any;
  try { data = await res.json(); } catch { throw new Error(`运单请求返回未能读取：HTTP ${res.status}`); }
  assertShipmentSession(session, base);
  if (!res.ok) {
    if (pending && !prior && res.status < 500 && typeof data?.error?.code === 'string')
      clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
    throwShipmentError(res, data, 'shipmentCommand');
  }
  const shipment = data.shipment ?? data;
  if (pending && command) {
    const { acknowledgement, ...result } = shipment;
    const expected = { ...command, patch: input, actorId: session.actorId, shipmentId: id };
    if (!acknowledgement || acknowledgement.schemaVersion !== 1 || result.id !== id
      || canonicalShipmentCommand(acknowledgement.command) !== canonicalShipmentCommand(expected)
      || acknowledgement.commandHash !== await commandHash({ schemaVersion: 1, command: expected })
      || acknowledgement.shipmentHash !== await commandHash(result)) unconfirmedShipment();
    assertShipmentSession(session, base);
    clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
    return result;
  }
  return shipment;
}

export const shipmentService = {
  async listShipments(endpoint?: string, params?: ShipmentListParams): Promise<Shipment[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping', base);
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.carrier) query.set('carrierName', params.carrier);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listShipments failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  async getShipment(id: string, endpoint?: string): Promise<Shipment> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`getShipment failed: HTTP ${res.status}`);
    let data: any;
    try { data = await res.json(); } catch { throw new Error(`getShipment failed: HTTP ${res.status} (non-JSON response)`); }
    return data.shipment || data;
  },

  async createShipment(input: Partial<Shipment>, endpoint?: string): Promise<Shipment> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    let data: any;
    try { data = await res.json(); } catch { throw new Error(`createShipment failed: HTTP ${res.status} (non-JSON response)`); }
    if (!res.ok) throwShipmentError(res, data, 'createShipment');
    return data.shipment || data;
  },

  async updateShipment(id: string, input: Partial<Shipment>, endpoint?: string): Promise<Shipment> {
    return executeShipmentPatch(id,input,endpoint);
  },

  async completeExportDeclaration(id: string, input: { completedAt: string; evidenceDocumentId: string; reference?: string }, endpoint?: string): Promise<Shipment> {
    const instant = new Date(input.completedAt);
    if (!Number.isFinite(instant.getTime()) || !input.evidenceDocumentId?.trim()) throw new Error('请填写真实的申报完成时间和凭证。');
    const normalized = { completedAt:instant.toISOString(), evidenceDocumentId:input.evidenceDocumentId.trim(), reference:input.reference?.trim() ?? '' };
    return executeShipmentPatch(id, { exportDeclarationCompletedAt:normalized.completedAt,
      exportDeclarationEvidenceDocumentId:normalized.evidenceDocumentId, exportDeclarationReference:normalized.reference || null }, endpoint,
      {operation:'export-declaration',suffix:'/export-declaration-completion',body:normalized});
  },

  async getPhysicalContext(id: string, endpoint?: string, orderId?: string): Promise<ShipmentPhysicalReadContext> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const contextUrl = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/physical-context`, base);
    const res = await fetch(orderId ? `${contextUrl}?orderId=${encodeURIComponent(orderId)}` : contextUrl, { headers: apiService.getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throwShipmentError(res, data, 'getShipmentContext');
    if (!['physical', 'legacy', 'claim'].includes(data.kind) || typeof data.updatedAt !== 'string'
      || !/^[a-f0-9]{64}$/.test(data.allocationFingerprint)) throw new Error('运单当前范围不完整，请刷新后重试。');
    return data;
  },

  async deleteShipment(id: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `deleteShipment failed: HTTP ${res.status}`);
    }
  },

  /** F3 — 物流节点时间轴（GET /v1/shipping/:id/events，升序全量） */
  async listShipmentEvents(id: string, endpoint?: string): Promise<ShipmentEvent[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/events`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listShipmentEvents failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  /** Phase B3 — 准交率统计（GET /v1/shipping/stats/on-time） */
  async getOnTimeStats(params?: { from?: string; to?: string }, endpoint?: string): Promise<OnTimeStats> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping/stats/on-time', base);
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`getOnTimeStats failed: HTTP ${res.status}`);
    return res.json();
  },

  /** REQ2-20（DR-061）— 旺季舱位预警清单（GET /v1/shipping/booking-reminders，只读） */
  async getBookingReminders(endpoint?: string): Promise<{
    rule: { peakMonths: number[]; peakDays: number; normalDays: number };
    items: Array<{ orderId: string; poNumber: string | null; customer: string; dueDate: string; leadDays: number; isPeak: boolean; requiredByDate: string; remainingDays: number; level: 'overdue' | 'urgent' | 'warning'; suggestion: string }>;
  }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping/booking-reminders', base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`getBookingReminders failed: HTTP ${res.status}`);
    return res.json();
  },

  // ────────────────────────────────────────────────────────────
  // C4 发货深化：装运行 / 逐箱 / 方式统计
  // ────────────────────────────────────────────────────────────

  /** C4 — 装运行列表（GET /v1/shipping/:id/lines） */
  async listShipmentLines(id: string, endpoint?: string): Promise<ShipmentLine[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/lines`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listShipmentLines failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  async readShipmentCartonMetadata(id: string, endpoint?: string): Promise<ShipmentCartonMetadataSnapshot> {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = cartonSession(base), flight = packingFlight(session, base, cartonSession);
    try {
      const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/carton-metadata`, base), { headers: session.headers });
      const data = await res.json(); flight.check(); if (!res.ok) throwShipmentError(res, data, 'readShipmentCartonMetadata');
      if (!cartonSnapshotMatches(id, data)) throw new Error('原出库与包装来源暂不能完整核验，请重新读取。');
      return data;
    } finally { flight.stop(); }
  },
  readPendingCartonMetadata(id: string, endpoint?: string): PendingCartonMetadataIntent | null {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = cartonSession(base);
    const pending = readBusinessRequest<PendingCartonMetadataIntent['payload']>(`shipment:carton-metadata:${id}`, base);
    if (pending && pending.payload.identity !== session.identity) throw new Error('账号、部门或权限已变化，请保留原包装资料请求并重新核对。');
    return pending;
  },
  async submitShipmentCartonMetadata(id: string, input: ShipmentCartonMetadataPayload, snapshot: ShipmentCartonMetadataSnapshot, endpoint?: string) {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = cartonSession(base), operation = `shipment:carton-metadata:${id}`;
    input = JSON.parse(JSON.stringify(input)); snapshot = JSON.parse(JSON.stringify(snapshot));
    const flight = packingFlight(session, base, cartonSession);
    try {
      const prior = shipmentService.readPendingCartonMetadata(id, base);
      if (prior && canonicalShipmentCommand(prior.payload.input) !== canonicalShipmentCommand(input)) throw new Error('原包装资料请求待确认，请恢复原内容后重试。');
      if (!prior && !cartonInputMatches(id, input, snapshot)) throw new Error('须逐箱完整对应原装运行数量，填写单箱箱号和补录说明；未知测量值请留空。');
      const pending = prior ?? beginBusinessRequest(operation, { input, snapshot, identity: session.identity }, base);
      if (!cartonInputMatches(id, pending.payload.input, pending.payload.snapshot)) throw new Error('原包装资料请求暂不能核验，请保留原请求。');
      const original = pending.payload.snapshot;
      const body = { ...pending.payload.input, requestKey: pending.requestId, expectedShipmentUpdatedAt: original.context.updatedAt,
        expectedPhysicalAllocationFingerprint: original.context.allocationFingerprint, expectedSourceFingerprint: original.metadata.sourceFingerprint, expectedDispatchHash: original.metadata.dispatchHash };
      flight.check();
      const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/carton-metadata`, base), { method: 'PUT', headers: session.headers, body: JSON.stringify(body) });
      let data: any; try { data = await res.json(); } catch { throw new Error('包装资料响应未确认，请保留原请求重试。'); }
      flight.check();
      if (!res.ok) {
        const rejection = data?.rejection, expected = { ...body, actorId: session.actorId, shipmentId: id };
        if (rejection?.schemaVersion === 1 && rejection.outcome === 'not_committed' && !data.acknowledgement
          && rejection.commandHash === await commandHash({ schemaVersion: 1, command: expected }) && canonicalShipmentCommand(rejection.command) === canonicalShipmentCommand(expected)
          && ['CONFLICT', 'INVALID_INPUT'].includes(rejection.code) && rejection.code === data?.error?.code
          && typeof rejection.shipmentVersion === 'string' && /^(?:0|[1-9]\d*)$/.test(rejection.shipmentVersion) && /^[a-f0-9]{64}$/.test(rejection.sourceFingerprint)) {
          flight.check(); clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
          throw Object.assign(new Error(data.error.message || '原包装资料请求已确认未保存，请重新核对。'), { notCommitted: true, code: rejection.code });
        }
        throwShipmentError(res, data, 'submitShipmentCartonMetadata');
      }
      const expected = { ...body, actorId: session.actorId, shipmentId: id }, ack = data?.acknowledgement;
      const result = { shipment: data?.shipment, lines: data?.lines, cartons: data?.cartons, headerSources: data?.headerSources };
      if (typeof data?.shipment?.updatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(data.shipment.updatedAt) || BigInt(data.shipment.updatedAt) <= BigInt(body.expectedShipmentUpdatedAt)
        || typeof data.replayed !== 'boolean' || ack?.schemaVersion !== 1 || canonicalShipmentCommand(ack.command) !== canonicalShipmentCommand(expected)
        || ack.commandHash !== await commandHash({ schemaVersion: 1, command: expected }) || ack.resultHash !== await commandHash(result)
        || !cartonFactsMatch(id, pending.payload, data)) throw new Error('包装资料持久回执与原请求不一致，请保留原请求重试。');
      flight.check(); clearAcknowledgedBusinessRequest(operation, pending.requestId, base); return data;
    } finally { flight.stop(); }
  },
  async retryPendingCartonMetadata(id: string, pending: PendingCartonMetadataIntent, endpoint?: string) {
    const current = shipmentService.readPendingCartonMetadata(id, endpoint);
    if (!current || current.requestId !== pending.requestId || canonicalShipmentCommand(current.payload) !== canonicalShipmentCommand(pending.payload)) throw new Error('原包装资料请求已变化，请重新核对。');
    return shipmentService.submitShipmentCartonMetadata(id, current.payload.input, current.payload.snapshot, endpoint);
  },

  async readShipmentPacking(id: string, endpoint?: string): Promise<ShipmentPackingSnapshot> {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = shipmentSession(base);
    const flight = packingFlight(session, base);
    try {
      const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/packing`, base), { headers: session.headers });
      const data = await res.json(); flight.check();
      if (!res.ok) throwShipmentError(res, data, 'readShipmentPacking');
      if (data?.shipment?.id !== id || !['legacy', 'physical', 'claim'].includes(data.context?.kind)
        || typeof data.context.updatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(data.context.updatedAt)
        || !/^[a-f0-9]{64}$/.test(data.context.allocationFingerprint) || !Array.isArray(data.lines) || !Array.isArray(data.cartons) || !Array.isArray(data.sources)
        || data.lines.some((row: any) => !row?.id || row.shipmentId !== id) || data.cartons.some((row: any) => !row?.id || row.shipmentId !== id || !Array.isArray(row.items)) || !packingSnapshotMatches(id, data))
        throw new Error('原装箱快照暂不能完整核验，请重新读取。');
      return data;
    } finally { flight.stop(); }
  },

  readPendingPacking(id: string, endpoint?: string): PendingPackingIntent | null {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint;
    shipmentSession(base);
    return readBusinessRequest<PendingPackingIntent['payload']>(`shipment:packing:${id}`, base);
  },

  async submitShipmentPacking(id: string, input: ShipmentPackingPayload, context: ShipmentPhysicalReadContext, endpoint?: string): Promise<ShipmentPackingResult> {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = shipmentSession(base), operation = `shipment:packing:${id}`;
    input = JSON.parse(JSON.stringify(input));
    if (!input.lines.every(line => packingScalarsMatch(line, packingLineScales))) throw new Error('行数量/毛净重/行体积须符合原数据库精度；行体积最多3位小数。');
    if (!input.cartons.every(carton => packingScalarsMatch(carton, packingCartonScales))) throw new Error('箱尺寸、重量或体积须符合原数据库精度。');
    const flight = packingFlight(session, base);
    try {
      const prior = readBusinessRequest<PendingPackingIntent['payload']>(operation, base);
      if (prior && canonicalShipmentCommand(prior.payload.input) !== canonicalShipmentCommand(input)) throw new Error('原装箱请求待确认，请恢复原内容后重试。');
      const pending = prior ?? beginBusinessRequest(operation, { input, context }, base);
      const body = { ...pending.payload.input, requestKey: pending.requestId, expectedShipmentUpdatedAt: pending.payload.context.updatedAt,
        expectedPhysicalAllocationFingerprint: pending.payload.context.allocationFingerprint };
      flight.check();
      const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/packing`, base), {
        method: 'PUT', headers: session.headers, body: JSON.stringify(body),
      });
      let data: any; try { data = await res.json(); } catch { throw new Error('装箱响应未确认，请保留原请求重试。'); }
      flight.check();
      const expected = { ...body, actorId: session.actorId, shipmentId: id }, rejection = data?.rejection;
      if (!res.ok) {
        if (rejection?.schemaVersion === 1 && rejection.outcome === 'not_committed' && !data.acknowledgement
          && rejection.commandHash === await commandHash({ schemaVersion: 1, command: expected })
          && canonicalShipmentCommand(rejection.command) === canonicalShipmentCommand(expected)
          && rejection.code === data?.error?.code && ['CONFLICT', 'INVALID_INPUT', 'INVALID_CURRENT_STATUS', 'VALIDATION_FAILED'].includes(rejection.code)
          && typeof rejection.shipmentVersion === 'string' && /^(?:0|[1-9]\d*)$/.test(rejection.shipmentVersion) && /^[a-f0-9]{64}$/.test(rejection.sourceFingerprint)) {
          flight.check(); clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
          throw Object.assign(new Error(data.error.message || '原装箱请求已确认未保存，请重新核对当前范围。'), { code: rejection.code, notCommitted: true });
        }
        throwShipmentError(res, data, 'submitShipmentPacking');
      }
      const ack = data?.acknowledgement;
      const result = { shipment: data?.shipment, lines: data?.lines, cartons: data?.cartons };
      if (data?.shipment?.id !== id || typeof data.shipment.updatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(data.shipment.updatedAt) || BigInt(data.shipment.updatedAt) <= BigInt(body.expectedShipmentUpdatedAt) || !Array.isArray(data.lines) || !Array.isArray(data.cartons) || typeof data.replayed !== 'boolean'
        || ack?.schemaVersion !== 1 || canonicalShipmentCommand(ack.command) !== canonicalShipmentCommand(expected)
        || ack.commandHash !== await commandHash({ schemaVersion: 1, command: expected }) || ack.resultHash !== await commandHash(result)
        || !packingFactsMatch(id, pending.payload.input, data))
        throw new Error('装箱持久回执与原请求不一致，请保留原请求重试。');
      flight.check();
      clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
      return data;
    } finally { flight.stop(); }
  },

  async retryPendingPacking(id: string, pending: PendingPackingIntent, endpoint?: string): Promise<ShipmentPackingResult> {
    const current = shipmentService.readPendingPacking(id, endpoint);
    if (!current || current.requestId !== pending.requestId || canonicalShipmentCommand(current.payload) !== canonicalShipmentCommand(pending.payload))
      throw new Error('原装箱请求已变化，请重新核对当前账号的待确认请求。');
    return shipmentService.submitShipmentPacking(id, current.payload.input, current.payload.context, endpoint);
  },

  /** C4 — 装运行整组替换（PUT /v1/shipping/:id/lines，幂等） */
  async replaceShipmentLines(id: string, lines: ShipmentLineInput[], endpoint?: string): Promise<ShipmentLine[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/lines`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ lines }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `replaceShipmentLines failed: HTTP ${res.status}`);
    return data.lines || [];
  },

  /** C4 — 从订单重新带出装运行（POST /v1/shipping/:id/lines/pull-from-order） */
  async pullLinesFromOrder(id: string, endpoint?: string): Promise<ShipmentLine[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/lines/pull-from-order`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `pullLinesFromOrder failed: HTTP ${res.status}`);
    return data.lines || [];
  },

  /** C4 — 逐箱装箱列表（GET /v1/shipping/:id/cartons，含箱内分配） */
  async listShipmentCartons(id: string, endpoint?: string): Promise<ShipmentCarton[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/cartons`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listShipmentCartons failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  /** C4 — 逐箱整组替换（PUT /v1/shipping/:id/cartons，幂等） */
  async replaceShipmentCartons(id: string, cartons: ShipmentCartonInput[], endpoint?: string): Promise<ShipmentCarton[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/cartons`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ cartons }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `replaceShipmentCartons failed: HTTP ${res.status}`);
    return data.cartons || [];
  },

  /** DR-016 — 票内分配列表（GET /v1/shipping/:id/allocations，合票视角） */
  async listShipmentAllocations(id: string, endpoint?: string): Promise<ShipmentAllocation[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/allocations`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listShipmentAllocations failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  listPendingPhysicalAllocations(id: string, endpoint?: string): PendingPhysicalAllocation[] {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint;
    shipmentSession(base);
    const prefix = `shipment:allocation:${id}:`;
    return listBusinessRequests<ShipmentAllocationInput | ShipmentAllocationPatch>(prefix, base).map(({ operation, record }) => ({
      requestId: record.requestId, input: record.payload,
      ...(operation.slice(prefix.length).startsWith('new:') ? {} : { allocationId: operation.slice(prefix.length) }),
    }));
  },
  async retryPendingPhysicalAllocation(id: string, pending: PendingPhysicalAllocation, endpoint?: string): Promise<ShipmentAllocation> {
    const original = shipmentService.listPendingPhysicalAllocations(id, endpoint).find(row => row.requestId === pending.requestId);
    if (!original || canonicalShipmentCommand(original) !== canonicalShipmentCommand(pending))
      throw new Error('原未确认请求已变化，请重新读取本票的待确认操作。');
    return shipmentService.submitPhysicalShipmentAllocation(id, original.input, original.allocationId, endpoint);
  },

  /** The complete original physical intent survives reload and account changes.
   * Current list projections never acknowledge a possibly committed request. */
  async submitPhysicalShipmentAllocation(id: string, input: ShipmentAllocationInput | ShipmentAllocationPatch,
    allocationId?: string, endpoint?: string): Promise<ShipmentAllocation> {
    const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, session = shipmentSession(base);
    const payload = normalizePhysicalAllocationIntent(input);
    const operation = `shipment:allocation:${id}:${allocationId ?? `new:${payload.orderId}:${payload.orderLineId}`}`;
    const prior = readBusinessRequest<ShipmentAllocationInput | ShipmentAllocationPatch>(operation, base);
    const pending = beginBusinessRequest(operation, payload, base), command = { ...pending.payload, requestKey: pending.requestId };
    assertShipmentSession(session, base);
    const res = await fetch(apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/allocations${allocationId ? `/${encodeURIComponent(allocationId)}` : ''}`, base), {
      method: allocationId ? 'PATCH' : 'POST', headers: session.headers, body: JSON.stringify(command),
    });
    let data: any;
    try { data = await res.json(); } catch { throw new Error('分配结果尚未确认，请保留原内容重试。'); }
    assertShipmentSession(session, base);
    if (!res.ok) {
      if (!prior && res.status < 500 && typeof data?.error?.code === 'string') clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
      throwShipmentError(res, data, 'saveShipmentAllocation');
    }
    const { acknowledgement, ...allocation } = data;
    const action = allocationId ? 'update_physical_shipment_allocation' : 'create_physical_shipment_allocation';
    if (!allocation.id || allocation.shipmentId !== id || allocationId && allocation.id !== allocationId
      || allocation.actorId !== session.actorId || allocation.operation !== action || allocation.requestKey !== pending.requestId
      || !Array.isArray(allocation.productionBatchAllocations) || !allocation.productionBatchAllocations.length
      || canonicalShipmentCommand(allocation.commandSnapshot) !== canonicalShipmentCommand(command)
      || allocation.commandHash !== await commandHash({ operation: action, shipmentId: id, allocationId: allocationId ?? null,
        actorId: session.actorId, command })
      || acknowledgement?.schemaVersion !== 1 || acknowledgement.allocationHash !== await commandHash({ ...allocation, replayed: false })) unconfirmedShipment();
    assertShipmentSession(session, base);
    clearAcknowledgedBusinessRequest(operation, pending.requestId, base);
    return allocation;
  },

  /** DR-016 — 新增票内分配（POST /v1/shipping/:id/allocations，合票/拆票；同客户同业务线后端校验） */
  async createShipmentAllocation(id: string, input: ShipmentAllocationInput, endpoint?: string): Promise<ShipmentAllocation> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/allocations`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `createShipmentAllocation failed: HTTP ${res.status}`);
    return data;
  },

  /**
   * DR-016 — 修正票内分配（PATCH /v1/shipping/:id/allocations/:allocId）
   * 合票分配建错时改数量/单位/状态/备注；跨票累计上限与单位归一由后端校验，失败原样透出。
   */
  async updateShipmentAllocation(
    id: string,
    allocId: string,
    patch: ShipmentAllocationPatch,
    endpoint?: string,
  ): Promise<ShipmentAllocation> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/allocations/${encodeURIComponent(allocId)}`, base);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `updateShipmentAllocation failed: HTTP ${res.status}`);
    return data;
  },

  /**
   * DR-016 — 移除票内分配（DELETE /v1/shipping/:id/allocations/:allocId）
   * 后端 requireRole(HIGH_RISK_ROLES)：仅有高风险角色的账号可撤；撤后 Shipment.orderId 投影自动重算。
   */
  async deleteShipmentAllocation(id: string, allocId: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/allocations/${encodeURIComponent(allocId)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `deleteShipmentAllocation failed: HTTP ${res.status}`);
  },

  /** C4 — 运输方式维度统计（GET /v1/shipping/stats/by-method） */
  async getMethodStats(params?: { from?: string; to?: string }, endpoint?: string): Promise<MethodStats> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping/stats/by-method', base);
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`getMethodStats failed: HTTP ${res.status}`);
    return res.json();
  },

  /**
   * ★ D5 — 运单改期/物流变更历史（GET /v1/shipping/:id/schedule-history）
   *
   * 为什么要有：甩柜/改船期是面料外贸最高频的异常，而改期此前**没有任何留痕**
   * （`update_shipment` 审计只记 status+shipmentNumber）⇒「这票改过几次期、谁改的」查不到。
   *
   * @param datesOnly true = 只返回日期类字段（ETD/ETA/ATD/ATA/订舱日）—— 回答「被甩了几次柜」
   */
  async getShipmentScheduleHistory(
    id: string,
    params?: { datesOnly?: boolean; limit?: number },
    endpoint?: string,
  ): Promise<{
    shipmentId: string;
    count: number;
    changes: Array<{
      auditId: string; field: string; fieldLabel: string;
      fromValue: unknown; toValue: unknown; description: string;
      actorId: string | null; at: string | null; transactionId: string | null;
    }>;
  }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/schedule-history`, base);
    const query = new URLSearchParams();
    if (params?.datesOnly) query.set('datesOnly', '1');
    if (params?.limit) query.set('limit', String(params.limit));
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`getShipmentScheduleHistory failed: HTTP ${res.status}`);
    let data: any;
    try { data = await res.json(); } catch { throw new Error('船期历史响应无法核验，请刷新后重试。'); }
    if (!validShipmentScheduleHistory(data, id)) throw new Error('船期历史与当前运单不匹配或内容无法核验，请刷新后重试。');
    return data;
  },

  /**
   * ★ C1 — 按柜号聚合（GET /v1/shipping/stats/containers）
   * 只读；返回每柜的票/客户/件重体 + 报关单 + 退税 + **柜内矛盾** + 未填柜号的票。
   */
  async getContainerConsolidation(params?: { from?: string; to?: string }, endpoint?: string): Promise<ContainerConsolidation> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/shipping/stats/containers', base);
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`getContainerConsolidation failed: HTTP ${res.status}`);
    return res.json();
  },

  // ════════════════════════════════════════════════════════════════
  // T6-b 陆运段（H12）：工厂 → 货代仓一程，一票一段
  //   GET /v1/shipping/:id/land-transport   （shipments:read）
  //   PUT /v1/shipping/:id/land-transport   （shipments:write，upsert 语义）
  // 费用（陆运费/进仓费）本批只采集、不进毛利 —— 进毛利与 CIF Incoterms 分支是同一刀，
  // 未拍板前任何毛利数字都不应变化（契约钉见 shipmentLandTransport.test.ts）。
  // ════════════════════════════════════════════════════════════════

  async getShipmentLandTransport(id: string, endpoint?: string): Promise<ShipmentLandTransport | null> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/land-transport`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getShipmentLandTransport failed: HTTP ${res.status}`);
    return data?.landTransport ?? null;
  },

  async upsertShipmentLandTransport(
    id: string,
    input: Partial<ShipmentLandTransport>,
    endpoint?: string,
  ): Promise<ShipmentLandTransport> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/shipping/${encodeURIComponent(id)}/land-transport`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `upsertShipmentLandTransport failed: HTTP ${res.status}`);
    return data?.landTransport;
  },
};
