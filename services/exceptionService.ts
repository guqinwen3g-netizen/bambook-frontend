/**
 * DR-013 受控例外 API service — /v1/exceptions
 *
 * 后端契约（server/src/exceptions/exceptionRoute.ts，冻结）：
 *   POST /                  — 创建例外申请（DR-007 服务端解析 reviewerId；exceptionReason ≥30 字）
 *   GET  /                  — 列表（status / exceptionCategory / requesterId / limit 过滤）
 *   GET  /gate-check        — 门禁查询（targetType+targetId+action 精确匹配）
 *   GET  /:id               — 详情（惰性对账审批结论）
 *   POST /:id/withdraw      — 申请人撤回（仅 Pending，仅本人）
 *   POST /:id/boss-bypass   — BOSS 最终兜底特批（仅 owner，reason ≥30 字）
 *
 * 入口联动：其他域门禁阻断（GateBlockedError，code=GATE_BLOCKED，携带 exceptionEntryHint）
 *   时，调用 openExceptionEntry() 派发 EXCEPTION_ENTRY_EVENT 自定义事件，审批中心
 *   （WorkflowPanel 例外 Tab）监听后打开预填的发起表单。禁止 mock，禁止特例补丁。
 */
import { apiService } from './apiService';

// ── 例外类别（与 server exceptionGate EXCEPTION_CATEGORIES 一致） ──
export const EXCEPTION_CATEGORIES = [
  'moq_exemption',
  'price_deviation',
  'order_change',
  'shipment_release',
  'qc_fault',
  'payment_term',
  'sample_skip',
  'other',
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

export const EXCEPTION_CATEGORY_LABEL: Record<ExceptionCategory, string> = {
  moq_exemption: 'MOQ 豁免',
  price_deviation: '价格偏差',
  order_change: '订单变更',
  shipment_release: '出运放行',
  qc_fault: 'QC 瑕疵',
  payment_term: '付款条件例外',
  sample_skip: '样品环节跳过',
  other: '其他',
};

// ── 状态机（schema 注释真源 + 服务端扩展终态） ──
export type ExceptionStatus =
  | 'Pending'
  | 'ReviewerApproved'
  | 'ReviewerRejected'
  | 'BossFinalBypass'
  | 'Consumed'
  | 'Expired'
  | 'Cancelled';

export const EXCEPTION_STATUS_LABEL: Record<ExceptionStatus, string> = {
  Pending: '待审批',
  ReviewerApproved: '已批准',
  ReviewerRejected: '已拒绝',
  BossFinalBypass: 'BOSS 最终兜底特批',
  Consumed: '已核销',
  Expired: '已过期',
  Cancelled: '已撤回',
};

/** 生效集合（ReviewerApproved / BossFinalBypass 且未过期未核销完） */
export const EXCEPTION_EFFECTIVE_STATUSES: ReadonlySet<ExceptionStatus> = new Set([
  'ReviewerApproved',
  'BossFinalBypass',
]);

export interface ExceptionConsumption {
  consumedBy: string;
  consumedAt: string;
  note?: string | null;
}

export interface ExceptionScope {
  targetType: string;
  targetId: string;
  action: string;
  validUntil: string | null;
  maxUses: number;
  usedCount: number;
  consumptions: ExceptionConsumption[];
  responsibleOwnerId: string;
}

/** GET /v1/exceptions/:id 与列表返回的详情视图（DB 行 + 解析后 scope/files） */
export interface Dr013ExceptionView {
  id: string;
  exceptionNumber: string;
  exceptionCategory: ExceptionCategory;
  subCategory: string | null;
  bypassedApprovalIds: string[];
  exceptionReason: string;
  customerCommitment: string | null;
  riskMitigationPlan: string;
  requesterId: string;
  reviewerId: string | null;
  approvalRequestId: string | null;
  status: ExceptionStatus;
  notes: string | null;
  bossFinalBypassBy: string | null;
  bossFinalBypassAt: string | null;
  bossFinalBypassReason: string | null;
  createdAt: string;
  updatedAt: string;
  scope: ExceptionScope | null;
  files: unknown[];
}

export interface CreateExceptionInput {
  exceptionCategory: ExceptionCategory;
  subCategory?: string | null;
  bypassedApprovalIds?: string[];
  exceptionReason: string;
  customerCommitment?: string | null;
  riskMitigationPlan: string;
  targetType: string;
  targetId: string;
  action: string;
  validUntil?: string | null;
  maxUses?: number;
  responsibleOwnerId: string;
  notes?: string | null;
}

export interface GateCheckResult {
  active: boolean;
  exception?: {
    id: string;
    exceptionNumber: string;
    exceptionCategory: string;
    subCategory: string | null;
    status: string;
    bossFinalBypass: boolean;
    validUntil: string | null;
  };
  reason?: 'NO_ACTIVE_EXCEPTION' | 'EXCEPTION_NOT_APPROVED' | 'EXCEPTION_EXPIRED' | 'EXCEPTION_ALREADY_CONSUMED';
}

export const EXCEPTION_ENTRY_HINT =
  '可按 DR-013 发起受控例外申请：POST /api/v1/exceptions（scope exception:dr013:create）';

/** 服务端门禁阻断错误码（GateBlockedError.code，fail-closed 409；UI 据此展示例外申请入口） */
export const GATE_BLOCKED_CODE = 'GATE_BLOCKED';

// ── 门禁阻断 → 例外申请入口事件（通用机制，非特例） ──
export const EXCEPTION_ENTRY_EVENT = 'bambook:dr013-exception-entry';

export interface ExceptionEntryDetail {
  targetType?: string;
  targetId?: string;
  action?: string;
  exceptionCategory?: ExceptionCategory;
  gate?: string;
  blockingReasons?: string[];
}

/** 门禁阻断处调用：通知审批中心打开预填的 DR-013 发起表单 */
export function openExceptionEntry(detail: ExceptionEntryDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ExceptionEntryDetail>(EXCEPTION_ENTRY_EVENT, { detail }));
}

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

function exceptionsUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/exceptions${path}`, base);
}

export const exceptionService = {
  async listExceptions(
    filter: { status?: ExceptionStatus; exceptionCategory?: ExceptionCategory; requesterId?: string; limit?: number } = {},
    endpoint?: string,
  ): Promise<Dr013ExceptionView[]> {
    const query = new URLSearchParams();
    if (filter.status) query.set('status', filter.status);
    if (filter.exceptionCategory) query.set('exceptionCategory', filter.exceptionCategory);
    if (filter.requesterId) query.set('requesterId', filter.requesterId);
    if (filter.limit) query.set('limit', String(filter.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(exceptionsUrl(`/${suffix}`, endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'listExceptions failed');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  async getException(id: string, endpoint?: string): Promise<Dr013ExceptionView> {
    const res = await fetch(exceptionsUrl(`/${encodeURIComponent(id)}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getException failed');
    const data = await res.json();
    return data.exception;
  },

  /** 门禁查询（精确匹配三元组；供前端门禁点消费） */
  async gateCheck(
    scope: { targetType: string; targetId: string; action: string; at?: string },
    endpoint?: string,
  ): Promise<GateCheckResult> {
    const query = new URLSearchParams({
      targetType: scope.targetType,
      targetId: scope.targetId,
      action: scope.action,
    });
    if (scope.at) query.set('at', scope.at);
    const res = await fetch(exceptionsUrl(`/gate-check?${query.toString()}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'gateCheck failed');
    return res.json();
  },

  async createException(
    input: CreateExceptionInput,
    endpoint?: string,
  ): Promise<{ exception: Dr013ExceptionView; approvalRequestId: string }> {
    const res = await fetch(exceptionsUrl('/', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'createException failed');
    return res.json();
  },

  async withdrawException(id: string, endpoint?: string): Promise<Dr013ExceptionView> {
    const res = await fetch(exceptionsUrl(`/${encodeURIComponent(id)}/withdraw`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'withdrawException failed');
    const data = await res.json();
    return data.exception;
  },

  /** BOSS 最终兜底特批（仅 owner；reason ≥30 字） */
  async bossBypassException(id: string, reason: string, endpoint?: string): Promise<Dr013ExceptionView> {
    const res = await fetch(exceptionsUrl(`/${encodeURIComponent(id)}/boss-bypass`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) await readError(res, 'bossBypassException failed');
    const data = await res.json();
    return data.exception;
  },
};
