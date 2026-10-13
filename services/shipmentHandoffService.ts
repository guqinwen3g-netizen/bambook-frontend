import { apiService } from './apiService';
import { getAuthState, hasPermission } from './authService';

export type ShipmentHandoffStatus = 'PendingLogistics' | 'Processing' | 'NeedsBusinessDecision' | 'ReturnedToBusiness' | 'Cancelled';
export type ShipmentHandoffAction = 'start' | 'return-to-business' | 'return-to-logistics' | 'complete' | 'cancel';
export type ShipmentHandoffBusinessDecision = 'accept_actual' | 'revise_plan' | 'cancel';

export interface ShipmentHandoffReceiptAllocation {
  stockReceiptId: string | null;
  factoryLoadingReceiptId?: string;
  plannedQty: string | null;
  actualQty: string | null;
  unit: string;
}

export interface ShipmentHandoffPhysicalAllocation {
  id: string;
  productionBatchId: string;
  productionBatchRevision: number;
  factoryRelationId: string | null;
  plannedQty: string | null;
  actualQty: string | null;
  unit: string;
  state: string;
  expectedUpdatedAt: string;
  scopeFingerprint: string | null;
  stockReceiptAllocations: ShipmentHandoffReceiptAllocation[];
}

export interface ShipmentHandoffAllocation {
  id: string;
  shipmentId: string;
  orderId: string;
  orderLineId?: string;
  plannedQty: string;
  actualQty?: string | null;
  unit: string;
  expectedUpdatedAt?: string;
  productionBatchAllocations?: ShipmentHandoffPhysicalAllocation[];
  [key: string]: unknown;
}

export interface ShipmentHandoffAllocationRevision {
  allocationId: string;
  expectedAllocationUpdatedAt: string;
  requestKey: string;
  plannedQty: string;
  productionBatchAllocations: Array<{
    productionBatchId: string;
    productionBatchRevision: number;
    factoryRelationId: string;
    stockReceiptId: string | null;
    factoryLoadingReceiptId?: string;
    plannedQty: string | null;
  }>;
}

export interface ShipmentHandoffSourceAllocation {
  orderId: string;
  orderLineId: string;
  productionBatchId: string;
  productionBatchRevision: number;
  factoryRelationId: string;
  plannedQty: string;
  unit: string;
}

export interface ShipmentHandoffCreateInput {
  shippingMethod: 'Sea' | 'Air';
  allocations: ShipmentHandoffSourceAllocation[];
  note?: string;
  requestKey: string;
}

export interface ShipmentHandoffLine {
  id: string;
  handoffId: string;
  allocationId: string;
  orderId: string;
  orderLineId: string;
  productionBatchId: string;
  productionBatchRevision: number;
  factoryRelationId: string;
  factoryName: string | null;
  scopeFingerprint: string;
  plannedQty: string;
  unit: string;
  createdAt: string;
  productionCompletion: { status: string; actualQty: string | null; unit: string };
}

export interface ShipmentHandoffRecord {
  id: string;
  shipmentId: string;
  status: ShipmentHandoffStatus;
  businessActorId: string;
  logisticsActorId: string | null;
  requestKey: string | null;
  note: string | null;
  discrepancyReason: string | null;
  businessResponse: string | null;
  returnedToBusinessAt: string | null;
  businessRespondedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  expectedUpdatedAt: string;
}

export interface ShipmentHandoffEvent {
  id: string;
  handoffId: string;
  fromStatus: ShipmentHandoffStatus | null;
  toStatus: ShipmentHandoffStatus;
  actorId: string;
  note: string | null;
  createdAt: string;
  decision?: ShipmentHandoffBusinessDecision | null;
  payload?: unknown;
}

export interface ShipmentHandoffBundle {
  handoff: ShipmentHandoffRecord;
  shipment: Record<string, unknown> & { id: string; status: string; shipmentNumber: string };
  allocations: ShipmentHandoffAllocation[];
  lines: ShipmentHandoffLine[];
  events: ShipmentHandoffEvent[];
}

export interface ShipmentHandoffActualLoadingCommand {
  expectedUpdatedAt: string;
  requestKey: string;
  reason?: string | null;
  allocations: Array<{ allocationId: string; expectedAllocationUpdatedAt: string; orderId: string; orderLineId: string; unit: string;
    productionBatchAllocations: Array<{ physicalAllocationId: string; expectedPhysicalUpdatedAt: string; productionBatchId: string;
      productionBatchRevision: number; factoryRelationId: string; unit: string;
      factoryLoading?: { actualQty: string; loadingDate: string; reference: string };
      receiptActuals: Array<{ stockReceiptId: string | null; actualQty: string }> }> }>;
}
export interface ShipmentHandoffActualLoadingSource {
  allocationId: string; orderId: string; orderLineId: string; physicalAllocationId: string; productionBatchId: string;
  productionBatchRevision: number; factoryRelationId: string; unit: string;
  candidates: Array<{ stockReceiptId: string; reference: string; warehouseId: string; receivedQty: string; availableQty: string; unit: string }>;
  unavailableReceiptIds: string[];
  factoryLoadings?: Array<{ factoryLoadingReceiptId: string; actualQty: string; loadingDate: string; reference: string; unit: string }>;
}
export interface ShipmentHandoffActualLoadingContext { bundle: ShipmentHandoffBundle; sources: ShipmentHandoffActualLoadingSource[] }
export interface ShipmentHandoffActualLoadingResult extends ShipmentHandoffBundle {
  actualLoadingReceipt: { requestKey: string; commandHash: string; command: ShipmentHandoffActualLoadingCommand;
    replayed: boolean; requiresBusinessDecision: boolean };
}

export interface ShipmentHandoffFilters {
  status?: ShipmentHandoffStatus;
  orderId?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  endpoint?: string;
}

export interface ShipmentHandoffBlocker {
  code: string;
  message: string;
}

export interface ShipmentHandoffEligibilityBranch extends ShipmentHandoffSourceAllocation {
  blockers: ShipmentHandoffBlocker[];
}

export interface ShipmentHandoffEligibility {
  eligible: boolean;
  branches: ShipmentHandoffEligibilityBranch[];
}

function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function decimalText(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value); }
function canonicalDecimal(value: string): string { const [whole, fraction = ''] = value.split('.'); const tail = fraction.replace(/0+$/, ''); return whole + (tail ? `.${tail}` : ''); }
function validStatus(value: unknown): value is ShipmentHandoffStatus {
  return value === 'PendingLogistics' || value === 'Processing' || value === 'NeedsBusinessDecision'
    || value === 'ReturnedToBusiness' || value === 'Cancelled';
}
function timeText(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : null;
}
function invalid(): never { throw new Error('出运交接响应与原业务范围不一致，请重新读取核对。'); }

function readIdentity() {
  const auth = getAuthState(), endpoint = apiService.getStoredConfig().cloudEndpoint;
  if (!auth.isAuthenticated || !auth.user?.id) throw new Error('请重新登录后继续办理出运交接。');
  const headers = apiService.getAuthHeaders();
  const identity = JSON.stringify([auth.user.id, auth.user.roles, auth.user.roleIds, auth.user.permissions,
    auth.user.permissionCeiling, endpoint, headers]);
  return { endpoint, identity };
}
function assertIdentity(identity: string) {
  if (readIdentity().identity !== identity) throw new Error('账号、权限或服务地址已变化；请保留当前内容并重新读取原出运交接。');
}

function parseBundle(value: unknown): ShipmentHandoffBundle {
  const data: any = value;
  const handoff = data?.handoff, shipment = data?.shipment;
  if (!handoff || !validText(handoff.id) || !validText(handoff.shipmentId) || !validStatus(handoff.status)
    || !validText(handoff.businessActorId) || !(handoff.logisticsActorId === null || validText(handoff.logisticsActorId))
    || !(handoff.requestKey === null || validText(handoff.requestKey))
    || !(handoff.note === null || typeof handoff.note === 'string')
    || !(handoff.discrepancyReason === null || typeof handoff.discrepancyReason === 'string')
    || !(handoff.businessResponse === null || typeof handoff.businessResponse === 'string')
    || !(handoff.returnedToBusinessAt === null || timeText(handoff.returnedToBusinessAt) !== null)
    || !(handoff.businessRespondedAt === null || timeText(handoff.businessRespondedAt) !== null)
    || !(handoff.completedAt === null || timeText(handoff.completedAt) !== null)
    || timeText(handoff.createdAt) === null || timeText(handoff.expectedUpdatedAt) === null
    || !shipment || shipment.id !== handoff.shipmentId || !validText(shipment.status) || !validText(shipment.shipmentNumber)
    || !Array.isArray(data.allocations) || !Array.isArray(data.lines) || !Array.isArray(data.events)) return invalid();

  const allocationIds = new Set<string>();
  const allocations: ShipmentHandoffAllocation[] = [];
  for (const row of data.allocations) {
    if (!validText(row?.id) || row.shipmentId !== shipment.id || !validText(row.orderId)
      || !decimalText(row.plannedQty) || !validText(row.unit) || allocationIds.has(row.id)
      || (row.expectedUpdatedAt !== undefined && timeText(row.expectedUpdatedAt) === null)
      || (row.actualQty !== undefined && !(row.actualQty === null || decimalText(row.actualQty)))) return invalid();
    allocationIds.add(row.id);
    const physical = row.productionBatchAllocations;
    if (physical !== undefined && !Array.isArray(physical)) return invalid();
    const normalizedPhysical: ShipmentHandoffPhysicalAllocation[] | undefined = physical?.map((item: any) => {
      if (!validText(item?.id) || !validText(item.productionBatchId) || !Number.isSafeInteger(item.productionBatchRevision)
        || item.productionBatchRevision < 1 || !(item.factoryRelationId === null || validText(item.factoryRelationId))
        || !(item.plannedQty === null || decimalText(item.plannedQty)) || !(item.actualQty === null || decimalText(item.actualQty))
        || !validText(item.unit) || !validText(item.state) || timeText(item.expectedUpdatedAt) === null
        || !(item.scopeFingerprint === null || validText(item.scopeFingerprint)) || !Array.isArray(item.stockReceiptAllocations)) return invalid();
      const receipts = item.stockReceiptAllocations.map((receipt: any) => {
        if (!(receipt?.stockReceiptId === null || validText(receipt?.stockReceiptId))
          || receipt.factoryLoadingReceiptId !== undefined && (!validText(receipt.factoryLoadingReceiptId) || receipt.stockReceiptId !== null)
          || !(receipt.plannedQty === null || decimalText(receipt.plannedQty))
          || !(receipt.actualQty === null || decimalText(receipt.actualQty)) || !validText(receipt.unit)) return invalid();
        return { stockReceiptId: receipt.stockReceiptId, ...(receipt.factoryLoadingReceiptId ? { factoryLoadingReceiptId: receipt.factoryLoadingReceiptId } : {}),
          plannedQty: receipt.plannedQty, actualQty: receipt.actualQty, unit: receipt.unit };
      });
      return { id: item.id, productionBatchId: item.productionBatchId, productionBatchRevision: item.productionBatchRevision,
        factoryRelationId: item.factoryRelationId, plannedQty: item.plannedQty, actualQty: item.actualQty, unit: item.unit,
        state: item.state, expectedUpdatedAt: timeText(item.expectedUpdatedAt)!, scopeFingerprint: item.scopeFingerprint,
        stockReceiptAllocations: receipts };
    });
    allocations.push({ ...row, expectedUpdatedAt: row.expectedUpdatedAt === undefined ? undefined : timeText(row.expectedUpdatedAt)!,
      productionBatchAllocations: normalizedPhysical });
  }
  const lineIds = new Set<string>();
  for (const row of data.lines) {
    const completion = row?.productionCompletion;
    if (!validText(row?.id) || row.handoffId !== handoff.id || !validText(row.allocationId) || !allocationIds.has(row.allocationId)
      || !validText(row.orderId) || !validText(row.orderLineId) || !validText(row.productionBatchId)
      || !Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 1
      || !validText(row.factoryRelationId) || !(row.factoryName === null || typeof row.factoryName === 'string')
      || !validText(row.scopeFingerprint) || !decimalText(row.plannedQty) || !validText(row.unit) || timeText(row.createdAt) === null
      || !completion || !validText(completion.status) || !(completion.actualQty === null || decimalText(completion.actualQty))
      || !validText(completion.unit) || completion.unit !== row.unit || lineIds.has(row.id)) return invalid();
    lineIds.add(row.id);
  }
  if (data.lines.length < 1) return invalid();
  const eventIds = new Set<string>();
  for (const event of data.events) {
    if (!validText(event?.id) || event.handoffId !== handoff.id || !(event.fromStatus === null || validStatus(event.fromStatus))
      || !validStatus(event.toStatus) || !validText(event.actorId) || !(event.note === null || typeof event.note === 'string')
      || timeText(event.createdAt) === null || eventIds.has(event.id)
      || (event.decision != null && !['accept_actual', 'revise_plan', 'cancel'].includes(event.decision))) return invalid();
    eventIds.add(event.id);
  }
  const normalized = {
    ...data,
    handoff: { ...handoff, createdAt: timeText(handoff.createdAt)!, expectedUpdatedAt: timeText(handoff.expectedUpdatedAt)!,
      returnedToBusinessAt: handoff.returnedToBusinessAt == null ? null : timeText(handoff.returnedToBusinessAt),
      businessRespondedAt: handoff.businessRespondedAt == null ? null : timeText(handoff.businessRespondedAt),
      completedAt: handoff.completedAt == null ? null : timeText(handoff.completedAt) },
    lines: data.lines.map((row: any) => ({ ...row, createdAt: timeText(row.createdAt)! })),
    allocations,
    events: data.events.map((event: any) => ({ ...event, createdAt: timeText(event.createdAt)! })),
  };
  return normalized as ShipmentHandoffBundle;
}

function unwrap(payload: any): unknown {
  if (!payload || payload.ok !== true) throw new Error(String(payload?.error?.message || payload?.message || '出运交接请求未确认。'));
  return payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

async function request(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; endpoint?: string; identity?: string } = {}) {
  const method = options.method ?? 'GET';
  if (!hasPermission(method === 'GET' ? 'shipments:read' : 'shipments:write')) throw new Error('当前账号没有出运交接操作权限。');
  const response = await fetch(apiService.buildApiUrl(`/v1/shipping${path}`, options.endpoint ?? readIdentity().endpoint), {
    method,
    headers: { ...apiService.getAuthHeaders(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (options.identity) assertIdentity(options.identity);
  if (!response.ok) throw Object.assign(new Error(String(payload?.error?.message || payload?.message || `HTTP ${response.status}`)),
    { status: response.status, code: payload?.error?.code });
  return unwrap(payload);
}

function requireOrdersPermission(write: boolean) {
  if (!hasPermission(write ? 'orders:write' : 'orders:read')) throw new Error(write
    ? '当前账号没有来源订单业务操作权限。' : '当前账号没有来源订单读取权限。');
}
export function canProcessShipmentHandoff() {
  const user = getAuthState().user;
  return !!((user?.roles as string[] | undefined)?.some(role => ['logistics', 'admin', 'owner'].includes(role))
    || user?.roleIds?.some(roleId => ['role-logistics', 'logistics', 'role-admin', 'role-super-admin'].includes(roleId.toLowerCase())));
}
function requireLogisticsWrite() {
  if (!canProcessShipmentHandoff() || !hasPermission('shipments:write')) throw new Error('当前账号没有后勤出运专业操作权限。');
}

function canonicalActualCommand(command: ShipmentHandoffActualLoadingCommand) {
  const allocations = command.allocations.map(row => ({ ...row, productionBatchAllocations: row.productionBatchAllocations.map(branch => ({
    ...branch, receiptActuals: branch.receiptActuals.map(receipt => ({ ...receipt, actualQty: canonicalDecimal(receipt.actualQty) }))
      .sort((a, b) => (a.stockReceiptId ?? '').localeCompare(b.stockReceiptId ?? '')),
    ...(branch.factoryLoading ? { factoryLoading: { ...branch.factoryLoading, actualQty: canonicalDecimal(branch.factoryLoading.actualQty), reference: branch.factoryLoading.reference.trim() } } : {}),
  })).sort((a, b) => a.physicalAllocationId.localeCompare(b.physicalAllocationId)) })).sort((a, b) => a.allocationId.localeCompare(b.allocationId));
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered({ ...command, reason: command.reason?.trim() || null, allocations }));
}
function statusFilterPath(filters: ShipmentHandoffFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.orderId) params.set('orderId', filters.orderId);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));
  const query = params.toString();
  return `/handoffs${query ? `?${query}` : ''}`;
}

export function createShipmentHandoffRequestKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前环境无法生成安全的出运交接请求编号。');
  return globalThis.crypto.randomUUID();
}

export const shipmentHandoffService = {
  async actualLoading(handoffId: string, endpoint?: string): Promise<ShipmentHandoffActualLoadingContext> {
    if (!validText(handoffId) || !canProcessShipmentHandoff()) throw new Error('当前账号不能读取后勤实装核量来源。');
    requireOrdersPermission(false);
    const session = readIdentity();
    const data: any = await request(`/handoffs/${encodeURIComponent(handoffId)}/actual-loading`, { endpoint: endpoint ?? session.endpoint, identity: session.identity });
    const bundle = parseBundle(data.bundle);
    if (bundle.handoff.id !== handoffId || !Array.isArray(data.sources) || data.sources.length !== bundle.lines.length) return invalid();
    const ids = new Set<string>();
    for (const source of data.sources) {
      const line = bundle.lines.find(row => row.allocationId === source?.allocationId && row.productionBatchId === source.productionBatchId);
      const physical = bundle.allocations.find(row => row.id === source?.allocationId)?.productionBatchAllocations?.find(row => row.id === source.physicalAllocationId);
      if (!line || !physical || ids.has(physical.id) || line.orderId !== source.orderId || line.orderLineId !== source.orderLineId
        || line.productionBatchRevision !== source.productionBatchRevision || line.factoryRelationId !== source.factoryRelationId || line.unit !== source.unit
        || !Array.isArray(source.candidates) || !Array.isArray(source.unavailableReceiptIds)
        || source.unavailableReceiptIds.some((id: any) => !validText(id))) return invalid();
      ids.add(physical.id);
      const receipts = new Set<string>();
      for (const receipt of source.candidates) {
        if (!validText(receipt?.stockReceiptId) || receipts.has(receipt.stockReceiptId) || !validText(receipt.reference) || !validText(receipt.warehouseId)
          || !decimalText(receipt.receivedQty) || !decimalText(receipt.availableQty) || receipt.unit !== line.unit) return invalid();
        receipts.add(receipt.stockReceiptId);
      }
      if (source.factoryLoadings !== undefined && !Array.isArray(source.factoryLoadings)) return invalid();
      const directIds = physical.stockReceiptAllocations.filter(receipt => receipt.factoryLoadingReceiptId).map(receipt => receipt.factoryLoadingReceiptId).sort();
      const direct = source.factoryLoadings ?? [];
      if (JSON.stringify(directIds) !== JSON.stringify(direct.map((row: any) => row.factoryLoadingReceiptId).sort())
        || direct.some((row: any) => !validText(row.factoryLoadingReceiptId) || !decimalText(row.actualQty)
          || !/^\d{4}-\d{2}-\d{2}$/.test(row.loadingDate) || !validText(row.reference) || row.unit !== source.unit)) return invalid();
    }
    return { bundle, sources: data.sources };
  },

  async recordActualLoading(handoffId: string, command: ShipmentHandoffActualLoadingCommand, endpoint?: string): Promise<ShipmentHandoffActualLoadingResult> {
    requireLogisticsWrite(); requireOrdersPermission(false);
    if (!validText(handoffId) || timeText(command.expectedUpdatedAt) === null || !validText(command.requestKey)
      || !Array.isArray(command.allocations) || !command.allocations.length || command.allocations.some(row =>
        !validText(row.allocationId) || !validText(row.orderId) || !validText(row.orderLineId) || !validText(row.unit) || timeText(row.expectedAllocationUpdatedAt) === null
        || !Array.isArray(row.productionBatchAllocations) || !row.productionBatchAllocations.length || row.productionBatchAllocations.some(branch =>
          !validText(branch.physicalAllocationId) || timeText(branch.expectedPhysicalUpdatedAt) === null || !validText(branch.productionBatchId)
          || !Number.isSafeInteger(branch.productionBatchRevision) || branch.productionBatchRevision < 1 || !validText(branch.factoryRelationId) || branch.unit !== row.unit
          || branch.factoryLoading !== undefined && (!decimalText(branch.factoryLoading.actualQty) || !/^\d{4}-\d{2}-\d{2}$/.test(branch.factoryLoading.loadingDate) || !validText(branch.factoryLoading.reference))
          || !Array.isArray(branch.receiptActuals) || !branch.receiptActuals.length && !branch.factoryLoading || branch.receiptActuals.some(receipt =>
            !(receipt.stockReceiptId === null || validText(receipt.stockReceiptId)) || !decimalText(receipt.actualQty))))) throw new Error('请完整核实每项原订单行、工厂分支、实际量和实物来源。未录不是零。');
    const session = readIdentity();
    const data: any = await request(`/handoffs/${encodeURIComponent(handoffId)}/actual-loading`, { method: 'POST', body: command,
      endpoint: endpoint ?? session.endpoint, identity: session.identity });
    const bundle = parseBundle(data), receipt = data.actualLoadingReceipt;
    if (bundle.handoff.id !== handoffId || !receipt || receipt.requestKey !== command.requestKey
      || !/^[a-f0-9]{64}$/.test(receipt.commandHash) || typeof receipt.replayed !== 'boolean' || typeof receipt.requiresBusinessDecision !== 'boolean'
      || !receipt.command || canonicalActualCommand(receipt.command) !== canonicalActualCommand(command)
      || !bundle.events.some(event => (event as any).requestKey === command.requestKey && (event as any).commandHash === receipt.commandHash))
      throw new Error('实装核量已提交，但原请求回执尚未核对成功。请保留原请求键重试。');
    return { ...bundle, actualLoadingReceipt: receipt };
  },

  async list(filters: ShipmentHandoffFilters = {}): Promise<{ items: ShipmentHandoffBundle[]; nextCursor: string | null }> {
    requireOrdersPermission(false);
    const session = readIdentity();
    const data: any = await request(statusFilterPath(filters), { signal: filters.signal, endpoint: filters.endpoint ?? session.endpoint, identity: session.identity });
    const items = Array.isArray(data) ? data : data.items ?? data.handoffs;
    const nextCursor = Array.isArray(data) ? null : data.page?.nextCursor ?? data.nextCursor ?? null;
    if (!Array.isArray(items) || !(nextCursor === null || validText(nextCursor))) return invalid();
    const parsed = items.map(parseBundle);
    if (filters.status && parsed.some(item => item.handoff.status !== filters.status)) return invalid();
    return { items: parsed, nextCursor };
  },

  async checkEligibility(input: ShipmentHandoffCreateInput, endpoint?: string): Promise<ShipmentHandoffEligibility> {
    requireOrdersPermission(true);
    const session = readIdentity();
    if (!['Sea', 'Air'].includes(input.shippingMethod) || !Array.isArray(input.allocations) || !input.allocations.length
      || input.allocations.some(row => !validText(row.orderId) || !validText(row.orderLineId) || !validText(row.productionBatchId)
        || !Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 1 || !validText(row.factoryRelationId)
        || !decimalText(row.plannedQty) || !validText(row.unit))) throw new Error('请逐项核对订单行、工厂分支、计划出运数量和运输方式。');
    const eligibilityInput = { shippingMethod: input.shippingMethod, allocations: input.allocations, ...(input.note ? { note: input.note } : {}) };
    const data: any = await request('/handoffs/eligibility', { method: 'POST', body: eligibilityInput, endpoint: endpoint ?? session.endpoint,
      identity: session.identity });
    if (typeof data.eligible !== 'boolean' || !Array.isArray(data.branches)) return invalid();
    const branches = data.branches.map((row: any): ShipmentHandoffEligibilityBranch => {
      if (!validText(row?.orderId) || !validText(row?.orderLineId) || !validText(row?.productionBatchId)
        || !Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 1 || !validText(row.factoryRelationId)
        || !decimalText(row.plannedQty) || !validText(row.unit) || !Array.isArray(row.blockers)
        || row.blockers.some((blocker: any) => !validText(blocker?.code) || !validText(blocker?.message))) return invalid();
      return { orderId: row.orderId, orderLineId: row.orderLineId, productionBatchId: row.productionBatchId,
        productionBatchRevision: row.productionBatchRevision, factoryRelationId: row.factoryRelationId,
        plannedQty: row.plannedQty, unit: row.unit, blockers: row.blockers.map((blocker: any) => ({ code: blocker.code, message: blocker.message })) };
    });
    const matches = (row: ShipmentHandoffSourceAllocation) => branches.some(branch => branch.orderId === row.orderId
      && branch.orderLineId === row.orderLineId && branch.productionBatchId === row.productionBatchId
      && branch.productionBatchRevision === row.productionBatchRevision && branch.factoryRelationId === row.factoryRelationId
      && canonicalDecimal(branch.plannedQty) === canonicalDecimal(row.plannedQty) && branch.unit === row.unit);
    if (branches.length !== input.allocations.length || input.allocations.some(row => !matches(row))) return invalid();
    if (data.eligible && branches.some(branch => branch.blockers.length > 0)) return invalid();
    return { eligible: data.eligible, branches };
  },

  async get(handoffId: string, endpoint?: string): Promise<ShipmentHandoffBundle> {
    if (!validText(handoffId)) throw new Error('出运交接编号无效。');
    requireOrdersPermission(false);
    if (!hasPermission('shipments:read')) throw new Error('当前账号没有出运交接读取权限。');
    const session = readIdentity();
    const value = await request(`/handoffs/${encodeURIComponent(handoffId)}`, { endpoint: endpoint ?? session.endpoint, identity: session.identity });
    return parseBundle(value);
  },

  async create(input: ShipmentHandoffCreateInput, endpoint?: string): Promise<ShipmentHandoffBundle> {
    requireOrdersPermission(true);
    const session = readIdentity();
    if (!['Sea', 'Air'].includes(input.shippingMethod) || !Array.isArray(input.allocations) || !input.allocations.length
      || !validText(input.requestKey) || input.allocations.some(row => !validText(row.orderId) || !validText(row.orderLineId)
        || !validText(row.productionBatchId) || !Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 1
        || !validText(row.factoryRelationId) || !decimalText(row.plannedQty) || !validText(row.unit))) throw new Error('请逐项核对订单行、工厂分支、计划出运数量和运输方式。');
    const value = await request('/handoffs', { method: 'POST', body: input, endpoint: endpoint ?? session.endpoint, identity: session.identity });
    const bundle = parseBundle(value);
    if (bundle.handoff.status !== 'PendingLogistics' || bundle.shipment.status !== 'Draft'
      || bundle.lines.length !== input.allocations.length
      || input.allocations.some(source => !bundle.lines.some(line => line.orderId === source.orderId && line.orderLineId === source.orderLineId
        && line.productionBatchId === source.productionBatchId && line.productionBatchRevision === source.productionBatchRevision
        && line.factoryRelationId === source.factoryRelationId && canonicalDecimal(line.plannedQty) === canonicalDecimal(source.plannedQty) && line.unit === source.unit))) {
      throw new Error('出运交接已提交，但读取回执未确认原订单行、工厂分支和计划数量；请重新读取该订单，不要重复发起。');
    }
    return bundle;
  },

  async transition(handoff: ShipmentHandoffRecord, action: ShipmentHandoffAction, input: {
    reason?: string; response?: string; note?: string; requestKey?: string; decision?: ShipmentHandoffBusinessDecision;
    allocationRevisions?: ShipmentHandoffAllocationRevision[];
  } = {}, endpoint?: string): Promise<ShipmentHandoffBundle> {
    if (!handoff || !validText(handoff.id) || timeText(handoff.expectedUpdatedAt) === null) throw new Error('请重新读取原出运交接再操作。');
    if (action === 'start' || action === 'return-to-business' || action === 'complete') requireLogisticsWrite();
    else requireOrdersPermission(true);
    const session = readIdentity();
    const body = { expectedUpdatedAt: handoff.expectedUpdatedAt, ...(action === 'return-to-business' ? { reason: input.reason }
      : action === 'return-to-logistics' ? { decision: input.decision, response: input.response,
        ...(input.decision === 'revise_plan' ? { allocationRevisions: input.allocationRevisions } : {}) }
      : action === 'cancel' ? { requestKey: input.requestKey ?? createShipmentHandoffRequestKey(), response: input.response }
          : input.note ? { note: input.note } : {}) };
    if (action === 'return-to-business' && !validText(input.reason)) throw new Error('请说明工厂实际情况与当前计划的差异。');
    if (action === 'return-to-logistics' && (!validText(input.response) || !input.decision)) throw new Error('请选择差异处理方式并填写业务说明。');
    if (action === 'return-to-logistics' && input.decision === 'revise_plan'
      && (!Array.isArray(input.allocationRevisions) || input.allocationRevisions.length < 1)) throw new Error('请完整填写修订后的本批出运计划。');
    if (action === 'cancel' && (!validText(input.response) || !validText(input.requestKey ?? 'request-key'))) throw new Error('请填写撤销本次出运交接的原因。');
    const value = await request(`/handoffs/${encodeURIComponent(handoff.id)}/${action}`, { method: 'POST', body,
      endpoint: endpoint ?? session.endpoint, identity: session.identity });
    const bundle = parseBundle(value);
    const expected: Record<ShipmentHandoffAction, ShipmentHandoffStatus> = {
      start: 'Processing', 'return-to-business': 'NeedsBusinessDecision', 'return-to-logistics': input.decision === 'cancel' ? 'Cancelled' : 'Processing',
      complete: 'ReturnedToBusiness', cancel: 'Cancelled',
    };
    if (bundle.handoff.id !== handoff.id || bundle.handoff.status !== expected[action] || bundle.handoff.shipmentId !== handoff.shipmentId)
      throw new Error('交接操作已提交，但回读状态与原请求不一致；请重新读取，不要重复操作。');
    return bundle;
  },
};
