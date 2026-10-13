import { businessNowDate } from '../lib/businessClock';
/**
 * OrderChange (DR-010) + MOQ dry-run API service.
 *
 * 端点契约（真源 server/src/orderChanges/orderChangeRoute.ts、server/src/moq/moqRoute.ts）：
 *   POST /api/v1/order-changes            — 创建变更申请（201 { changeRequest, approvalRequestId }）
 *   GET  /api/v1/order-changes            — 列表（?orderId&status&requesterId&limit → { items }）
 *   GET  /api/v1/order-changes/:id        — 详情（{ item: { ...cr, order, approvalRequest } }）
 *   POST /api/v1/order-changes/:id/apply  — 审批通过后生效（幂等；{ changeRequest, applied }）
 *   POST /api/v1/order-changes/:id/withdraw — 申请人撤回（仅 Pending；{ changeRequest }）
 *   POST /api/v1/moq/validate             — MOQ dry-run 预检（不写库、不建审批单）
 *
 * 错误契约：非 2xx 时 body 为 { error: <code>, message: <msg> }，本 service 抛出
 * 带 message 的 Error 并挂 `code` 属性，UI 层可直接展示 message。
 *
 * 类型定义收口于本文件（订单域扩展字段 moqSnapshot/capsuleExemption 未进根 types.ts，
 * 经 readOrderMoqSnapshot / readOrderCapsuleExemption 做运行时收窄读取）。
 */
import { apiService } from './apiService';
import { buildQuantityPlan, prepareQuantityPlanDraft, type QuantityPlanDraft } from './orderQuantityPlanUiService';
// ★ S4 任务3：改价变更单的「变更前快照」—— 原写法 `quoteAmount ?? contractAmount` 是
//   顺序写反的旧口径 ⇒ 收敛到真源
import { orderAmountOf } from '../server/src/shared/orderAmount';

// ───────────────────────────────────────────────────────────────────
// 变更类型 / 状态机（与 server orderChangeRequestService 对齐）
// ───────────────────────────────────────────────────────────────────

export const ORDER_CHANGE_TYPES = ['price', 'quantity', 'delivery', 'customer', 'product', 'cancel', 'pause'] as const;
export type OrderChangeType = (typeof ORDER_CHANGE_TYPES)[number];

export const ORDER_CHANGE_TYPE_LABELS: Record<OrderChangeType, string> = {
  price: '金额变更',
  quantity: '数量变更',
  delivery: '交期变更',
  customer: '客户变更',
  product: '产品变更',
  cancel: '取消订单',
  pause: '暂停订单',
};

/** schema changeTypes[0] → 业务变更类型（镜像服务端 CHANGE_TYPE_TO_SCHEMA 反推：other 由 attachments.pause 区分 pause/cancel） */
const SCHEMA_TO_CHANGE_TYPE: Record<string, OrderChangeType> = {
  unitPrice: 'price',
  quantity: 'quantity',
  deliveryDate: 'delivery',
  customer: 'customer',
  product_spec: 'product',
};

export type OrderChangeRequestStatus = 'Pending' | 'Approved' | 'Rejected' | 'Applied' | 'Cancelled';

export const ORDER_CHANGE_STATUS_LABELS: Record<string, string> = {
  Pending: '待审批',
  Approved: '已批准',
  Rejected: '已拒绝',
  Applied: '已应用',
  Cancelled: '已撤回',
};

/** 仅已批准（正式承诺）订单可发起变更申请（服务端 fail-closed，前端仅作可行动性提示） */
export const APPROVED_ORDER_STATUSES = ['Confirmed', 'Production', 'Shipping', 'Delivered'] as const;

/** DR-010 守卫态：存在进行中的变更/取消/暂停申请，禁止并发发起 */
export const GUARDED_ORDER_STATUSES = ['CancelRequested', 'PauseRequested', 'Closing', 'Paused'] as const;

export function isApprovedOrderStatus(status: string | null | undefined): boolean {
  return !!status && (APPROVED_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isGuardedOrderStatus(status: string | null | undefined): boolean {
  return !!status && (GUARDED_ORDER_STATUSES as readonly string[]).includes(status);
}

// 服务端校验下限（前端镜像做即时反馈，服务端仍为权威）
export const ORDER_CHANGE_REASON_MIN = 15;
export const ORDER_CHANGE_IMPACT_MIN = 10;

// ───────────────────────────────────────────────────────────────────
// API 记录类型
// ───────────────────────────────────────────────────────────────────

export interface OrderChangeRequest {
  id: string;
  orderId: string;
  requestNumber: string;
  /** schema 枚举值数组（unitPrice/quantity/deliveryDate/customer/product_spec/other） */
  changeTypes: string[];
  status: OrderChangeRequestStatus;
  impactLevel?: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  afterDelta: Record<string, unknown> | null;
  changeReason: string;
  /** 影响说明落 notes 列 */
  notes?: string | null;
  requesterId: string;
  reviewerId?: string | null;
  approvalRequestId?: string | null;
  finalContentFingerprint?: string | null;
  revisionOfId?: string | null;
  revisionSuccessor?: { id: string; requestNumber: string; status: string; createdAt?: string } | null;
  attachments?: Record<string, unknown> | null;
  appliedAt?: string | null;
  appliedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrderChangeApprovalInfo {
  id: string;
  status: string;
  reviewerId?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  reviewContentVersion?: string | null;
}

export interface OrderChangeCustomerConfirmationTarget {
  targetType: 'OrderChangeRequest';
  targetId: string;
  eligible: boolean;
  finalContentFingerprint: string;
  internalApprovalId: string | null;
  scopeFingerprint: string;
  scope: unknown;
  nativeStatus: any;
  recommendation?: { orderId?: string; relationId?: string; subject?: string };
}

export interface OrderChangeRequestDetail extends OrderChangeRequest {
  order?: { id: string; status: string; poNumber?: string | null; customer?: string | null; customerRelationId?: string | null } | null;
  approvalRequest?: OrderChangeApprovalInfo | null;
  customerConfirmationTarget?: OrderChangeCustomerConfirmationTarget | null;
}

export interface OrderChangeAmendmentPreview {
  finalProposalFingerprint: string;
  proposal: { changeType: 'price' | 'quantity' | 'delivery'; beforeSnapshot: Record<string, unknown>;
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string;
    displayDiff: Array<{ label: string; before: unknown; after: unknown; unit: string | null; beforeAmount?: unknown; afterAmount?: unknown }> };
}

export interface CreateOrderChangeInput {
  orderId: string;
  changeType: OrderChangeType;
  beforeSnapshot: Record<string, unknown>;
  afterDelta: Record<string, unknown>;
  changeReason: string;
  impactSummary: string;
  pauseReason?: string;
  pauseOwnerId?: string;
  expectedResumeDate?: string;
  attachments?: unknown;
}

// ───────────────────────────────────────────────────────────────────
// MOQ 类型（快照契约真源 server/src/moq/moqConfigService.ts MoqSnapshot）
// ───────────────────────────────────────────────────────────────────

export interface OrderMoqSnapshot {
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  snapshotAt: string;
  configId: string | null;
  source: 'moq_config' | 'fallback_constant';
}

export interface MoqValidateLineInput {
  quantity: string | number;
  unit?: string;
  moqOverride?: number | null;
  productAssetId?: string | null;
  styleNo?: string | null;
  materialCode?: string | null;
}

export interface MoqLineVerdict {
  lineIndex: number;
  lineId?: string;
  quantity: number;
  quantityExact?: string;
  unit: string;
  thresholdUnit?: string | null;
  unresolvedReason?: string;
  effectiveMoq: number;
  source: string;
  capsuleActive: boolean;
  compliant: boolean;
  gapPct: number;
  severity: 'none' | 'low' | 'medium' | 'high';
  badge: 'none' | 'yellow' | 'red';
  requiresApproval: boolean;
}

export interface MoqValidateInput {
  type?: string | null;
  businessLine?: string | null;
  capsuleExemption?: boolean;
  customerRelationId?: string | null;
  snapshot?: Partial<OrderMoqSnapshot> | null;
  lines: MoqValidateLineInput[];
}

export interface MoqValidateResult {
  ok: boolean;
  capsuleActive: boolean;
  capsuleExemptionBy?: string;
  capsuleExemptionAt?: string;
  lines: MoqLineVerdict[];
  blockedLineIndexes: number[];
  snapshot: OrderMoqSnapshot;
  approvalRequestId?: string;
  approvalError?: string;
}

// ───────────────────────────────────────────────────────────────────
// 订单扩展字段运行时读取（moqSnapshot / capsuleExemption 未进根 types.ts）
// ───────────────────────────────────────────────────────────────────

export function readOrderMoqSnapshot(order: unknown): OrderMoqSnapshot | null {
  const raw = (order as { moqSnapshot?: unknown } | null | undefined)?.moqSnapshot;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const fabric = Number(s.fabricDefaultMoq);
  const garment = Number(s.garmentDefaultMoq);
  const capsule = Number(s.capsuleMoq);
  if (!Number.isFinite(fabric) || !Number.isFinite(garment) || !Number.isFinite(capsule)) return null;
  if (typeof s.snapshotAt !== 'string' || !s.snapshotAt) return null;
  return {
    fabricDefaultMoq: fabric,
    garmentDefaultMoq: garment,
    capsuleMoq: capsule,
    snapshotAt: s.snapshotAt,
    configId: typeof s.configId === 'string' ? s.configId : null,
    source: s.source === 'fallback_constant' ? 'fallback_constant' : 'moq_config',
  };
}

export function readOrderCapsuleExemption(order: unknown): boolean {
  return (order as { capsuleExemption?: unknown } | null | undefined)?.capsuleExemption === true;
}

// ───────────────────────────────────────────────────────────────────
// 变更类型反推（列表/详情展示用；镜像服务端 apply 的反推逻辑）
// ───────────────────────────────────────────────────────────────────

export function resolveOrderChangeType(cr: Pick<OrderChangeRequest, 'changeTypes' | 'attachments'>): OrderChangeType {
  const schemaType = cr.changeTypes?.[0] ?? 'other';
  if (schemaType !== 'other') return SCHEMA_TO_CHANGE_TYPE[schemaType] ?? 'cancel';
  return (cr.attachments as { pause?: unknown } | null | undefined)?.pause ? 'pause' : 'cancel';
}

// ───────────────────────────────────────────────────────────────────
// DR-010 受控字段侦测（编辑门禁引导：已批准订单直改受控字段 → 走变更申请）
// ───────────────────────────────────────────────────────────────────

export interface ControlledFieldEdit {
  changeType: OrderChangeType;
  field: string;
  fieldLabel: string;
  before: unknown;
  after: unknown;
}

/** 受控字段清单：DR-010 任何数量/金额/交期/客户/产品变更均需审批（无阈值分级） */
const CONTROLLED_FIELDS: ReadonlyArray<{ changeType: OrderChangeType; field: string; fieldLabel: string }> = [
  { changeType: 'quantity', field: 'quantity', fieldLabel: '数量' },
  { changeType: 'price', field: 'salesPrice', fieldLabel: '销售单价' },
  { changeType: 'price', field: 'contractAmount', fieldLabel: '合同金额' },
  { changeType: 'price', field: 'quoteAmount', fieldLabel: '订单金额' },
  { changeType: 'delivery', field: 'dueDate', fieldLabel: '交期' },
  { changeType: 'delivery', field: 'clientDate', fieldLabel: '客户交期' },
  { changeType: 'delivery', field: 'productionDate', fieldLabel: '生产交期' },
  { changeType: 'customer', field: 'customer', fieldLabel: '客户' },
  { changeType: 'product', field: 'product', fieldLabel: '产品' },
];

const normalizeControlledValue = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim();
};

/** 对比 before/after 两个订单形态，返回受控字段的实际改动（空值与 undefined 视为相等；数字按数值比较） */
export function collectControlledFieldEdits(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ControlledFieldEdit[] {
  const edits: ControlledFieldEdit[] = [];
  for (const def of CONTROLLED_FIELDS) {
    const b = before[def.field];
    const a = after[def.field];
    const bn = normalizeControlledValue(b);
    const an = normalizeControlledValue(a);
    if (bn === an) continue;
    // 数字字段按数值比较（避免 "180" vs 180 误判）
    if (typeof b === 'number' || typeof a === 'number') {
      const bNum = Number(bn), aNum = Number(an);
      if (Number.isFinite(bNum) && Number.isFinite(aNum) && bNum === aNum) continue;
    }
    edits.push({ changeType: def.changeType, field: def.field, fieldLabel: def.fieldLabel, before: b, after: a });
  }
  return edits;
}

// ───────────────────────────────────────────────────────────────────
// 变更申请草稿构建（表单 → POST body；客户端校验镜像服务端 fail-closed 下限）
// ───────────────────────────────────────────────────────────────────

export interface ChangeFormValues {
  changeType: OrderChangeType;
  afterQuantity?: string;
  quantityPlanDraft?: QuantityPlanDraft;
  afterAmount?: string;
  afterDeliveryDate?: string;
  afterCustomer?: string;
  afterCustomerRelationId?: string;
  afterProduct?: string;
  pauseReason?: string;
  pauseOwnerId?: string;
  expectedResumeDate?: string;
  changeReason: string;
  impactSummary: string;
}

/** 参与 before/after 构建的订单字段子集（结构化类型，避免依赖根 types.ts 扩展字段） */
export interface ChangeRequestOrderContext {
  id: string;
  status?: string | null;
  quantity?: string | number | null;
  quoteAmount?: number | null;
  contractAmount?: number | null;
  salesPrice?: number | null;
  dueDate?: string | null;
  clientDate?: string | null;
  customer?: string | null;
  customerRelationId?: string | null;
  product?: string | null;
}

export type BuildChangeRequestResult =
  | { ok: true; payload: CreateOrderChangeInput }
  | { ok: false; error: string };

export function buildChangeRequestDraft(
  order: ChangeRequestOrderContext,
  values: ChangeFormValues,
  opts: { today?: string } = {},
): BuildChangeRequestResult {
  const changeReason = (values.changeReason ?? '').trim();
  if (changeReason.length < ORDER_CHANGE_REASON_MIN) {
    return { ok: false, error: `变更理由至少 ${ORDER_CHANGE_REASON_MIN} 字（当前 ${changeReason.length} 字）` };
  }
  const impactSummary = (values.impactSummary ?? '').trim();
  if (impactSummary.length < ORDER_CHANGE_IMPACT_MIN) {
    return { ok: false, error: `影响说明至少 ${ORDER_CHANGE_IMPACT_MIN} 字（当前 ${impactSummary.length} 字）` };
  }

  let beforeSnapshot: Record<string, unknown> = {};
  let afterDelta: Record<string, unknown> = {};
  const extra: Partial<CreateOrderChangeInput> = {};

  switch (values.changeType) {
    case 'quantity': {
      if (!values.quantityPlanDraft || values.quantityPlanDraft.orderId !== order.id) {
        return { ok: false, error: '请刷新实际订单并逐行核对数量及净额，不能用总量猜分配' };
      }
      try {
        afterDelta = { lineQuantityPlan: buildQuantityPlan(values.quantityPlanDraft) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '逐行数量计划无效' };
      }
      beforeSnapshot = { quantity: order.quantity ?? null };
      break;
    }
    case 'price': {
      const afterAmount = Number(values.afterAmount);
      if (!Number.isFinite(afterAmount) || afterAmount < 0) {
        return { ok: false, error: '变更后金额必须为非负数字' };
      }
      // 服务端 ORDER_FIELD_MAP：unitPrice → quoteAmount
      beforeSnapshot = { unitPrice: orderAmountOf(order) };
      afterDelta = { unitPrice: afterAmount };
      break;
    }
    case 'delivery': {
      const afterDate = (values.afterDeliveryDate ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(afterDate)) {
        return { ok: false, error: '变更后交期必须为 YYYY-MM-DD' };
      }
      beforeSnapshot = { deliveryDate: order.dueDate ?? order.clientDate ?? '' };
      afterDelta = { deliveryDate: afterDate };
      break;
    }
    case 'customer': {
      const afterCustomer = (values.afterCustomer ?? '').trim();
      if (!afterCustomer) return { ok: false, error: '变更后客户不能为空' };
      beforeSnapshot = { customer: order.customer ?? '', customerRelationId: order.customerRelationId ?? null };
      afterDelta = {
        customer: afterCustomer,
        customerRelationId: (values.afterCustomerRelationId ?? '').trim() || afterCustomer,
      };
      break;
    }
    case 'product': {
      const afterProduct = (values.afterProduct ?? '').trim();
      if (!afterProduct) return { ok: false, error: '变更后产品不能为空' };
      beforeSnapshot = { product: order.product ?? '' };
      afterDelta = { product: afterProduct };
      break;
    }
    case 'cancel': {
      beforeSnapshot = { status: order.status ?? '' };
      afterDelta = { status: 'Cancelled' };
      break;
    }
    case 'pause': {
      const pauseReason = (values.pauseReason ?? '').trim() || changeReason;
      const pauseOwnerId = (values.pauseOwnerId ?? '').trim();
      const expectedResumeDate = (values.expectedResumeDate ?? '').trim();
      if (!pauseReason || !pauseOwnerId || !expectedResumeDate) {
        return { ok: false, error: '暂停申请必须填写原因、责任人和预计恢复日期' };
      }
      const today = opts.today ?? businessNowDate().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedResumeDate) || expectedResumeDate < today) {
        return { ok: false, error: '预计恢复日期必须为 YYYY-MM-DD 且不早于今天' };
      }
      beforeSnapshot = { status: order.status ?? '' };
      afterDelta = { status: 'Paused' };
      extra.pauseReason = pauseReason;
      extra.pauseOwnerId = pauseOwnerId;
      extra.expectedResumeDate = expectedResumeDate;
      break;
    }
    default:
      return { ok: false, error: `非法变更类型: ${String(values.changeType)}` };
  }

  return {
    ok: true,
    payload: {
      orderId: order.id,
      changeType: values.changeType,
      beforeSnapshot,
      afterDelta,
      changeReason,
      impactSummary,
      ...extra,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// fetch 封装
// ───────────────────────────────────────────────────────────────────

async function readApiError(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  const code = typeof data?.error === 'string' ? data.error : undefined;
  const rawMessage = typeof data?.message === 'string' && data.message ? data.message : `${fallback} (HTTP ${res.status})`;
  const err = new Error(code && data?.message && !rawMessage.includes(code) ? `${code}：${rawMessage}` : rawMessage) as Error & { code?: string; status?: number; approvalRequestId?: string };
  err.status = res.status;
  if (code) err.code = code;
  if (typeof data?.approvalRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.approvalRequestId)) err.approvalRequestId = data.approvalRequestId;
  return err;
}

export const orderChangeService = {
  /** Read all authoritative order lines; list previews intentionally contain only a subset. */
  async loadQuantityPlanDraft(orderId: string): Promise<QuantityPlanDraft> {
    const response = await fetch(apiService.buildApiUrl(`/v2/orders/${encodeURIComponent(orderId)}`), {
      headers: apiService.getAuthHeaders(),
    });
    if (!response.ok) throw await readApiError(response, '读取订单行失败');
    const body = await response.json();
    if (body?.ok !== true || body?.order?.id !== orderId || !Array.isArray(body.order.lines)) {
      throw new Error('未能完整读取当前订单的真实行目，请刷新后重试');
    }
    return prepareQuantityPlanDraft(body.order);
  },

  /** Read-only server check against the current complete order lines and MOQ basis. */
  async previewQuantityPlan(draft: QuantityPlanDraft): Promise<MoqValidateResult> {
    const lineQuantityPlan = buildQuantityPlan(draft);
    const response = await fetch(apiService.buildApiUrl('/v1/order-changes/quantity-preview'), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ lineQuantityPlan }),
    });
    if (!response.ok) throw await readApiError(response, 'quantity preview failed');
    const body = await response.json();
    const result = body?.result;
    if (!body?.ok || result?.orderId !== draft.orderId
      || result?.expectedUpdatedAt !== draft.expectedUpdatedAt || result?.advisory !== true
      || JSON.stringify(result?.lineQuantityPlan) !== JSON.stringify(lineQuantityPlan)
      || !Array.isArray(result?.moq?.lines)) {
      throw new Error('数量计划预检回读原件不完整');
    }
    const proposedById = new Map(lineQuantityPlan.lines.map(line => [line.lineId, line]));
    const verdictIds = new Set<string>();
    for (const line of result.moq.lines) {
      const expected = typeof line?.lineId === 'string' ? proposedById.get(line.lineId) : undefined;
      if (!expected || verdictIds.has(line.lineId) || line.quantityExact !== expected.afterQuantity
        || line.unit !== expected.unit || typeof line.compliant !== 'boolean') {
        throw new Error('MOQ 预检未能逐行对应本次数量计划');
      }
      verdictIds.add(line.lineId);
    }
    if (verdictIds.size !== proposedById.size) throw new Error('MOQ 预检缺少订单行结果');
    return result.moq as MoqValidateResult;
  },
  /** 列表（按 orderId / status / requesterId 过滤） */
  async listChangeRequests(params: { orderId: string; status?: string; requesterId?: string; limit?: number }): Promise<OrderChangeRequest[]> {
    const url = apiService.buildApiUrl('/v1/order-changes');
    const query = new URLSearchParams();
    query.set('orderId', params.orderId);
    if (params.status) query.set('status', params.status);
    if (params.requesterId) query.set('requesterId', params.requesterId);
    if (params.limit) query.set('limit', String(params.limit));
    const res = await fetch(`${url}?${query.toString()}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw await readApiError(res, 'listChangeRequests failed');
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  },

  /** 详情（含关联订单摘要 + 审批进度 approvalRequest） */
  async getChangeRequest(id: string): Promise<OrderChangeRequestDetail> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}`);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw await readApiError(res, 'getChangeRequest failed');
    const data = await res.json();
    return data?.item as OrderChangeRequestDetail;
  },

  /** 创建变更申请（201 → { changeRequest, approvalRequestId }） */
  async createChangeRequest(input: CreateOrderChangeInput): Promise<{ changeRequest: OrderChangeRequest; approvalRequestId: string }> {
    const url = apiService.buildApiUrl('/v1/order-changes');
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw await readApiError(res, 'createChangeRequest failed');
    return res.json();
  },

  /** Original requester creates a fresh, DR-007-routed successor from an immutable rejected request. */
  async reviseRejectedChangeRequest(id: string, input: {
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string;
  }): Promise<{ changeRequest: OrderChangeRequest; approvalRequestId: string; revisionOfId: string }> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}/revise`);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) throw await readApiError(res, 'reviseRejectedChangeRequest failed');
    return res.json();
  },

  /** Current assigned reviewer amends only whitelisted proposed fields and signs the successor's final version. */
  async previewChangeRequestAmendment(id: string, input: {
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string; reviewContentVersion: string;
  }): Promise<OrderChangeAmendmentPreview> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}/amend-preview`);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) throw await readApiError(res, 'previewChangeRequestAmendment failed');
    return res.json();
  },

  async amendAndApproveChangeRequest(id: string, input: {
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string;
    decisionNote?: string; reviewContentVersion: string; expectedFinalProposalFingerprint: string; confirmedReviewedContent: true;
  }): Promise<{ changeRequest: OrderChangeRequest; approvalRequestId: string; revisionOfId: string; sync?: unknown }> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}/amend-and-approve`);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) throw await readApiError(res, 'amendAndApproveChangeRequest failed');
    return res.json();
  },

  /** 申请人撤回（仅 Pending，仅本人；服务端 fail-closed） */
  async withdrawChangeRequest(id: string): Promise<{ changeRequest: OrderChangeRequest }> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}/withdraw`);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) throw await readApiError(res, 'withdrawChangeRequest failed');
    return res.json();
  },

  /** 审批通过后生效（幂等；重复 apply 返回 ALREADY_APPLIED 409） */
  async applyChangeRequest(id: string): Promise<{ changeRequest: OrderChangeRequest; applied: string }> {
    const url = apiService.buildApiUrl(`/v1/order-changes/${encodeURIComponent(id)}/apply`);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) throw await readApiError(res, 'applyChangeRequest failed');
    return res.json();
  },

  /** MOQ dry-run 预检（不写库、不建审批单；Capsule 越权 403） */
  async validateMoq(input: MoqValidateInput): Promise<MoqValidateResult> {
    const url = apiService.buildApiUrl('/v1/moq/validate');
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw await readApiError(res, 'validateMoq failed');
    return res.json();
  },
};
