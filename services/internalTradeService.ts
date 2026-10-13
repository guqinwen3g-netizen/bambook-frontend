/**
 * DR-005/DR-033 内部面料交易 API service — /v1/internal-trade + /v1/finance/reports/consolidated-profit
 *
 * 后端契约（server/src/internalTrade/internalTradeRoute.ts + server/src/finance/reportService.ts，冻结）：
 *   GET  /v1/internal-trade                 — 内部供料单列表（departmentId / status / garmentOrderId / fabricOrderId 过滤）
 *   GET  /v1/internal-trade/:id             — 详情（master + mirror + 解码载荷）
 *   POST /v1/internal-trade                 — 服装部发起内部供料申请（创建即 PendingConfirm + 结算价审批单）
 *   POST /v1/internal-trade/:id/confirm     — 面料部确认数量/交期 + 已批准结算价 → 生效
 *   POST /v1/internal-trade/:id/delivery    — 交付登记（关联面料订单既有出运，分批出运/到货/差异）
 *   POST /v1/internal-trade/:id/cancel      — 取消（仅 Draft/PendingConfirm）
 *   GET  /v1/finance/reports/consolidated-profit?from&to — 公司合并利润视图（DR-005 抵销，只读聚合；
 *     from/to 可选 YYYY-MM-DD 日期范围，省略=全量；响应附 range: { from, to } 回显口径）
 *
 * 契约要点：
 *   - 双向记录拓扑：master=incoming（服装订单侧，权威载荷）/ mirror=outgoing（面料订单侧，镜像）；
 *     列表端点仅返回 incoming 主单，合并抵销仅取单边，禁止双边重复计入
 *   - DR-033 扩展单据内容以类型化 JSON 存于 memo 列（docType='DR033_INTERNAL_FABRIC_SUPPLY'），
 *     decodeInternalTransferPayload 为前端唯一解码入口（fail-safe，非法载荷返回 null）
 *   - 生效状态（Effective/Delivering/Closed）才计入核算；Draft/PendingConfirm/Cancelled 不计
 *   - transferAmount 为 Prisma Decimal，JSON 序列化可能是 string，统一 toAmount 归一
 *   - 合并报表为服务端聚合投影（from/to 仅做范围过滤，部门双视角 DR-043 由响应内
 *     departments 字段承载），前端不做任何口径再计算
 */
import { apiService } from './apiService';
import { getAuthState } from './authService';

// ────────────────────────────────────────────────────────────────
// 状态机（与 server INTERNAL_TRANSFER_STATUSES 一致）
// ────────────────────────────────────────────────────────────────
export const INTERNAL_TRANSFER_STATUSES = [
  'Draft',
  'PendingConfirm',
  'Effective',
  'Delivering',
  'Closed',
  'Cancelled',
] as const;
export type InternalTransferStatus = (typeof INTERNAL_TRANSFER_STATUSES)[number];

export const INTERNAL_TRANSFER_STATUS_LABEL: Record<InternalTransferStatus, string> = {
  Draft: '草稿',
  PendingConfirm: '待面料部确认',
  Effective: '已生效',
  Delivering: '交付中',
  Closed: '已关闭',
  Cancelled: '已取消',
};

/** 计入核算（服装部成本 / 面料部收入 / 合并抵销）的生效状态集合 */
export const INTERNAL_TRANSFER_ACCOUNTING_STATUSES: readonly InternalTransferStatus[] = [
  'Effective',
  'Delivering',
  'Closed',
];

// ────────────────────────────────────────────────────────────────
// DR-033 载荷（memo JSON，schema 冻结期载体；与 server payload 契约一致）
// ────────────────────────────────────────────────────────────────
export interface InternalTransferPackingLine {
  cartonNo: string;
  quantity: number;
  grossWeight?: number;
  netWeight?: number;
}

export interface InternalTransferDelivery {
  id: string;
  shipmentId: string;
  shipmentNumber: string | null;
  quantity: number;
  deliveryDate: string;
  receivedQuantity: number | null;
  receivedDate: string | null;
  /** 差异 = 到货 − 出运（null = 尚未登记到货） */
  variance: number | null;
  packingLines: InternalTransferPackingLine[];
  registeredBy: string;
  registeredAt: string;
  allocationId?: string; unit?: string; auditId?: string; requestKey?: string; requestFingerprint?: string;
}
export interface InternalTransferReceipt { id: string; deliveryId: string; quantity: number; receivedDate: string; actorId: string; auditId: string; requestKey: string; requestFingerprint: string }
export interface InternalTransferPriceRevision { revision: number; approvalRequestId: string; contentFingerprint: string; previousApprovalId: string; previousContentFingerprint: string; previousContent: Record<string, unknown>; previousApproval: Record<string, unknown>; previousApprovalAuditIds?: string[]; actorId: string; at: string; auditId: string; requestId: string; requestKey: string; requestFingerprint: string; command: Omit<ReviseInternalTransferPriceInput, 'requestId'> }
export interface ReviseInternalTransferPriceInput { requestId: string; expectedContentFingerprint: string; quantity: number; settlementPrice: number; dueDate: string; reason: string }
export interface InternalTransferPriceRevisionAck { revision: number; approvalRequestId: string; contentFingerprint: string; previousApprovalId: string; previousContentFingerprint: string; requestId: string; requestKey: string; requestFingerprint: string; auditId: string; replayed: boolean }
export interface RegisterReceiptInput { deliveryId: string; quantity: number; receivedDate: string; requestId: string }
export interface RegisterReceiptResult { transfer: InternalTransferRecord; receipt: InternalTransferReceipt; payload: InternalTransferPayload }

export interface InternalTransferHistoryEntry {
  from: InternalTransferStatus | null;
  to: InternalTransferStatus;
  actorId: string;
  at: string;
  note?: string;
}

export interface InternalTransferPayload {
  docType: 'DR033_INTERNAL_FABRIC_SUPPLY';
  role: 'master' | 'mirror';
  masterId: string;
  mirrorId: string | null;
  requestDepartmentId: string;
  supplyDepartmentId: string;
  garmentOrderId: string;
  fabricOrderId: string;
  materialCode: string;
  quantity: number;
  unit: string;
  settlementPrice: number;
  settlementApprovalId: string;
  dueDate: string;
  status: InternalTransferStatus;
  confirmedQuantity: number | null;
  confirmedDueDate: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  deliveries: InternalTransferDelivery[];
  history: InternalTransferHistoryEntry[];
  memo?: string;
  schemaVersion?: 2; garmentOrderLineId?: string; fabricOrderLineId?: string;
  priceContent?: Record<string, unknown>; contentFingerprint?: string; confirmationAuditId?: string;
  receipts?: InternalTransferReceipt[]; priceRevision?: number; priceRevisions?: InternalTransferPriceRevision[];
}

/** 解码 memo 载荷；非 DR-033 载荷/非法 JSON 返回 null（fail-safe，不抛错） */
export function decodeInternalTransferPayload(memo: string | null | undefined): InternalTransferPayload | null {
  if (!memo) return null;
  try {
    const parsed = JSON.parse(memo);
    if (parsed && parsed.docType === 'DR033_INTERNAL_FABRIC_SUPPLY') {
      return parsed as InternalTransferPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 列表/详情记录（Prisma 行序列化；Decimal 可能为 string）
// ────────────────────────────────────────────────────────────────
export interface InternalTransferRecord {
  id: string;
  orderId: string;
  transferDirection: 'incoming' | 'outgoing';
  counterpartyId: string | null;
  ourDepartmentId: string | null;
  transferAmount: number | string;
  transferCurrency: string;
  transferDate: string;
  memo: string | null;
  recognizedBy: string | null;
  recognizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET / 列表项：record 为 DB 行，payload 为服务端已解码的 DR-033 载荷（可能为 null） */
export interface InternalTransferListItem {
  record: InternalTransferRecord;
  payload: InternalTransferPayload | null;
}

export interface InternalTransferListResult {
  items: InternalTransferListItem[];
  total: number;
}

export interface InternalTransferDetail {
  item: InternalTransferRecord;
  mirror: InternalTransferRecord | null;
  payload: InternalTransferPayload | null;
}

// ────────────────────────────────────────────────────────────────
// 写操作输入/结果（与 server internalTradeRoute POST 体契约一致；reviewerId/requesterId 服务端解析，前端禁传）
// ────────────────────────────────────────────────────────────────
export interface CreateInternalTransferInput {
  requestDepartmentId: string;
  supplyDepartmentId: string;
  garmentOrderId: string;
  /** 关联面料订单（服务端 fail-closed 校验 isInternalFabricTrade=true，DR-005 标记纪律） */
  fabricOrderId: string;
  garmentOrderLineId?: string; fabricOrderLineId?: string;
  materialCode: string;
  quantity: number;
  unit?: string;
  settlementPrice: number;
  /** 交期 YYYY-MM-DD */
  dueDate: string;
  memo?: string;
}

export interface CreateInternalTransferResult {
  transfer: InternalTransferRecord;
  mirror: InternalTransferRecord;
  /** DR-006 结算价审批单 ID（生效前置：审批通过后方可 confirm） */
  approvalRequestId: string;
  payload: InternalTransferPayload;
}

export interface ConfirmInternalTransferInput {
  /** 缺省取申请数量 */
  confirmedQuantity?: number;
  /** 缺省取申请交期（YYYY-MM-DD） */
  confirmedDueDate?: string;
}

export interface RegisterDeliveryInput {
  /** 关联面料订单名下非 Cancelled 运单（不另造平行出库流程） */
  shipmentId: string;
  quantity: number;
  /** 缺省今天（YYYY-MM-DD） */
  deliveryDate?: string;
  receivedQuantity?: number;
  receivedDate?: string;
  packingLines?: InternalTransferPackingLine[];
  allocationId?: string; requestId?: string;
}

export interface RegisterDeliveryResult {
  transfer: InternalTransferRecord;
  delivery: InternalTransferDelivery;
  cumulativeDelivered: number;
  status: InternalTransferStatus;
  payload: InternalTransferPayload;
}

// ────────────────────────────────────────────────────────────────
// 公司合并利润视图（DR-005；与 server reportService.ConsolidatedProfitReport 一致）
// ────────────────────────────────────────────────────────────────
export interface ConsolidatedProfitDepartment {
  revenue: number;
  cost: number | null;
  profit: number | null;
}

export interface ConsolidatedProfitReport {
  coverage?: { status: 'complete' | 'incomplete'; coveredCount: number; pendingCount: number; unknownCount: number; totalCount: number };
  /** 口径回显：**必须**与后端真源同用顶层 `from`/`to`（B262：曾经这里自造过可选的 `range`，屏上恒说"未设界"） */
  from: string | null;
  to: string | null;
  baseCurrency: string;
  consolidatedRevenue: number;
  consolidatedCost: number | null;
  consolidatedProfit: number | null;
  costBreakdown: {
    /** 外部订单采购成本（已剔除内部采购加价） */
    externalPurchaseNetOfInternal: number | null;
    /** 真实面料成本（内部面料订单自身采购成本） */
    realFabricCost: number | null;
    freightCost: number | null;
    miscCost: number | null;
    /** ★ M1·D7-① 银行手续费（收款侧）——与服务端 costBreakdown 同构，缺字段会导致类型与接口漂移 */
    bankFeeCost: number | null;
    /** ★ M1·D7-② 折让/索赔 */
    allowanceCost: number | null;
  };
  elimination: {
    /** 服装部内部面料采购成本合计（生效 incoming） */
    internalPurchase: number;
    /** 面料部内部面料销售收入合计（生效 outgoing） */
    internalSales: number;
    /** 抵销额 = internalPurchase（单边口径） */
    amount: number;
    /** internalSales − internalPurchase（应≈0；非 0 透明披露双边口径不一致） */
    discrepancy: number;
  };
  departments: {
    garment: ConsolidatedProfitDepartment;
    fabric: ConsolidatedProfitDepartment;
  };
  orders: { externalCount: number; internalCount: number };
  /** 非 CNY 生效内部交易：不折算不假设汇率，透明披露并排除在抵额外 */
  unconverted: Array<{ transferId: string; orderId: string; direction: string; amount: number; currency: string; reason: string }>;
}

// ────────────────────────────────────────────────────────────────
// 请求基础（与 exceptionService 相同的错误透传语义：CODE：message）
// ────────────────────────────────────────────────────────────────
async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = typeof data?.error === 'string' ? data.error : undefined;
  const rawMessage = data?.message || data?.error || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && data?.message && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function apiUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(path, base);
}

/** Decimal 序列化归一（string | number → number） */
export function toAmount(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function captureInternalTradeSession(endpoint?: string) {
  const state = getAuthState(), headers = apiService.getAuthHeaders(), baseUrl = apiUrl('/v1/internal-trade', endpoint);
  const userId = state.isAuthenticated ? state.user?.id ?? '' : '';
  return { userId, headers, baseUrl, endpoint, identity: JSON.stringify([userId, baseUrl, headers, state.user?.permissions ?? [], (state.user as any)?.permissionCeiling ?? null]) };
}
export const internalTradeSessionCurrent = (session: ReturnType<typeof captureInternalTradeSession>) => session.identity === captureInternalTradeSession(session.endpoint).identity;
export function internalTradeWriteAllowed() {
  const state = getAuthState(), scopes = state.user?.permissions ?? [], cap = (state.user as any)?.permissionCeiling as string[] | undefined;
  return state.isAuthenticated && !!state.user?.id && (scopes.includes('order:internal_trade:write') || scopes.includes('*')) && (!cap || cap.includes('*') || cap.includes('order:internal_trade:write'));
}
const originalCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
async function originalHash(value: unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(originalCanonical(value))))).map(byte => byte.toString(16).padStart(2, '0')).join(''); }
const nonemptyId = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
function requireCurrent(session: ReturnType<typeof captureInternalTradeSession>) { if (!internalTradeSessionCurrent(session)) throw Error('账号、权限或服务地址已变化，请重新读取'); }
export async function validatePriceRevisionAck(row: InternalTransferPriceRevisionAck, id: string, command: ReviseInternalTransferPriceInput, prior: { approvalId: string; revision: number }, session: ReturnType<typeof captureInternalTradeSession>) {
  const { requestId, ...payload } = command;
  const [key, fingerprint] = await Promise.all([originalHash({ actorId: session.userId, masterId: id, action: 'price-revision', requestId }), originalHash(payload)]);
  requireCurrent(session);
  if (row?.requestId !== requestId || row.requestKey !== key || row.requestFingerprint !== fingerprint || !nonemptyId(row.auditId) || !nonemptyId(row.approvalRequestId) || row.approvalRequestId === prior.approvalId
      || row.previousApprovalId !== prior.approvalId || row.previousContentFingerprint !== command.expectedContentFingerprint || row.revision !== prior.revision + 1 || !/^[a-f0-9]{64}$/.test(row.contentFingerprint)) throw Error('重送审回执与原命令不一致，请保留原请求重试');
}
export async function validateReceiptAck(row: RegisterReceiptResult, id: string, command: RegisterReceiptInput, session: ReturnType<typeof captureInternalTradeSession>) {
  const { requestId, ...payload } = command;
  const [key, fingerprint] = await Promise.all([originalHash({ actorId: session.userId, masterId: id, action: 'receipt', requestId }), originalHash(payload)]);
  requireCurrent(session); const receipt = row?.receipt;
  if (row?.transfer?.id !== id || row.payload?.masterId !== id || !nonemptyId(receipt?.id) || !nonemptyId(receipt?.auditId) || receipt.actorId !== session.userId || receipt.deliveryId !== command.deliveryId || receipt.quantity !== command.quantity || receipt.receivedDate !== command.receivedDate || receipt.requestKey !== key || receipt.requestFingerprint !== fingerprint) throw Error('收货回执与原命令不一致，请保留原请求重试');
}
export async function validateDeliveryAck(row: RegisterDeliveryResult, id: string, command: RegisterDeliveryInput, session: ReturnType<typeof captureInternalTradeSession>) {
  const payload = { shipmentId: command.shipmentId, allocationId: command.allocationId ?? null, quantity: command.quantity, deliveryDate: command.deliveryDate ?? null, receivedQuantity: command.receivedQuantity ?? null, receivedDate: command.receivedDate ?? null, packingLines: command.packingLines ?? [] };
  const [key, fingerprint] = await Promise.all([originalHash({ actorId: session.userId, masterId: id, action: 'delivery', requestId: command.requestId }), originalHash(payload)]);
  requireCurrent(session); const delivery = row?.delivery;
  if (row?.transfer?.id !== id || row.payload?.masterId !== id || !nonemptyId(delivery?.id) || !nonemptyId(delivery?.auditId) || delivery.registeredBy !== session.userId || delivery.shipmentId !== command.shipmentId || delivery.allocationId !== command.allocationId || delivery.quantity !== command.quantity || delivery.deliveryDate !== command.deliveryDate || delivery.requestKey !== key || delivery.requestFingerprint !== fingerprint) throw Error('交付回执与原命令不一致，请保留原请求重试');
}

/** Timeout leaves the saved original command unresolved; it is never an execution receipt. */
async function postNativeCommand(path: string, input: unknown, endpoint: string | undefined, fallback: string) {
  const abort = new AbortController(), timer = globalThis.setTimeout(() => abort.abort(), 20_000);
  try { const res = await fetch(apiUrl(path, endpoint), { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input), signal: abort.signal });
    if (!res.ok) await readError(res, fallback); return await res.json();
  } catch (error) { if (abort.signal.aborted) throw Error('操作回执超时，请保留原请求重试'); throw error; }
  finally { globalThis.clearTimeout(timer); }
}

export const internalTradeService = {
  /** 内部供料单列表（仅 incoming 主单；状态过滤由服务端在载荷层执行） */
  async listInternalTransfers(
    filter: {
      departmentId?: string;
      status?: InternalTransferStatus;
      garmentOrderId?: string;
      fabricOrderId?: string;
      limit?: number;
      offset?: number;
    } = {},
    endpoint?: string,
  ): Promise<InternalTransferListResult> {
    const query = new URLSearchParams();
    if (filter.departmentId) query.set('departmentId', filter.departmentId);
    if (filter.status) query.set('status', filter.status);
    if (filter.garmentOrderId) query.set('garmentOrderId', filter.garmentOrderId);
    if (filter.fabricOrderId) query.set('fabricOrderId', filter.fabricOrderId);
    if (filter.limit) query.set('limit', String(filter.limit));
    if (filter.offset) query.set('offset', String(filter.offset));
    const suffix = query.toString() ? `/?${query.toString()}` : '/';
    const res = await fetch(apiUrl(`/v1/internal-trade${suffix}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'listInternalTransfers failed');
    const data = await res.json();
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total) || 0,
    };
  },

  /** 内部供料单详情（master + mirror + 解码载荷） */
  async getInternalTransfer(id: string, endpoint?: string): Promise<InternalTransferDetail> {
    const res = await fetch(apiUrl(`/v1/internal-trade/${encodeURIComponent(id)}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getInternalTransfer failed');
    return res.json();
  },

  /**
   * 公司合并利润视图（DR-005 抵销，只读聚合）。
   * 合并收入仅计外部客户收入；合并成本 = 外部采购（剔除内部采购加价）+ 真实面料成本 + 运费 + 杂费；
   * 抵销取单边生效内部交易额，恒等式 Σ 部门利润 = 合并利润。
   * filter.from/to（YYYY-MM-DD）可选，省略=全量；响应 range 字段回显实际口径。
   */
  async getConsolidatedProfitReport(
    filter: { from?: string; to?: string } = {},
    endpoint?: string,
  ): Promise<ConsolidatedProfitReport> {
    const query = new URLSearchParams();
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(apiUrl(`/v1/finance/reports/consolidated-profit${suffix}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getConsolidatedProfitReport failed');
    return res.json();
  },

  /** 服装部发起内部供料申请（201；创建即 PendingConfirm 并生成结算价审批单） */
  async createInternalTransfer(
    input: CreateInternalTransferInput,
    endpoint?: string,
  ): Promise<CreateInternalTransferResult> {
    const res = await fetch(apiUrl('/v1/internal-trade/', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'createInternalTransfer failed');
    return res.json();
  },

  /** 面料部确认数量/交期 + 已批准结算价 → 生效（仅 PendingConfirm） */
  async confirmInternalTransfer(
    id: string,
    input: ConfirmInternalTransferInput = {},
    endpoint?: string,
  ): Promise<{ transfer: InternalTransferRecord; payload: InternalTransferPayload }> {
    const res = await fetch(apiUrl(`/v1/internal-trade/${encodeURIComponent(id)}/confirm`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'confirmInternalTransfer failed');
    return res.json();
  },

  /** 交付登记（仅 Effective/Delivering；累计交付不得超真实出运/批准数量；足额收货后才Closed） */
  async registerDelivery(
    id: string,
    input: RegisterDeliveryInput,
    endpoint?: string,
  ): Promise<RegisterDeliveryResult> {
    return postNativeCommand(`/v1/internal-trade/${encodeURIComponent(id)}/delivery`, input, endpoint, '交付登记失败');
  },

  async reviseInternalTransferPrice(id: string, input: ReviseInternalTransferPriceInput, endpoint?: string): Promise<InternalTransferPriceRevisionAck> {
    return postNativeCommand(`/v1/internal-trade/${encodeURIComponent(id)}/price-revisions`, input, endpoint, '价格重送审失败');
  },
  async registerReceipt(id: string, input: RegisterReceiptInput, endpoint?: string): Promise<RegisterReceiptResult> {
    return postNativeCommand(`/v1/internal-trade/${encodeURIComponent(id)}/receipt`, input, endpoint, '收货登记失败');
  },

  /** 取消（仅 Draft/PendingConfirm；生效后须走订单变更/DR-013 例外链） */
  async cancelInternalTransfer(
    id: string,
    reason?: string,
    endpoint?: string,
  ): Promise<{ transfer: InternalTransferRecord; payload: InternalTransferPayload }> {
    const res = await fetch(apiUrl(`/v1/internal-trade/${encodeURIComponent(id)}/cancel`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
    });
    if (!res.ok) await readError(res, 'cancelInternalTransfer failed');
    return res.json();
  },
};
