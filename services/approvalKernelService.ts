/**
 * Approval Kernel API service — Phase 1 审批内核（DR-007 路由 / 委派 / BOSS 兜底 / 解析轨迹）
 *
 * 消费后端：
 *   GET  /v1/approvals                              — 业务审批中心列表（既有，含内核审计字段）
 *   POST /v1/approvals/:id/decide                   — 既有决策端点
 *   POST /v1/approvals-kernel/:id/delegate          — 审批人主动转派（reason ≥10 字）
 *   POST /v1/approvals-kernel/:id/boss-bypass       — BOSS 最终兜底特批（仅 owner，reason ≥30 字）
 *   GET  /v1/approvals-kernel/:id/resolution-trace  — DR-007 解析路径审计只读视图
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 */
import { apiService } from './apiService';

// ── DR-007 解析路径（与 server approvalRoutingService ReviewerResolverRoute 一致） ──
export type ReviewerResolverRoute =
  | 'DEPT_HEAD'                        // 正常：部门主管
  | 'FALLBACK_DEPT_HEAD_VACANT'        // 部门无主管 → 本部门 SALES_MANAGER → ADMIN 兜底
  | 'FALLBACK_SELF_APPLY_SUPERVISOR'   // 申请人本人是部门主管 → 上级部门主管 → ADMIN 兜底
  | 'FALLBACK_ADMIN';                  // 无部门/无任何候选 → ADMIN 兜底

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalPersonRef {
  id: string;
  displayName?: string | null;
  email?: string | null;
}

/** 业务审批列表项（/v1/approvals 返回完整 ApprovalRequest 行 + requester/reviewer 摘要） */
export interface ApprovalKernelListItem {
  id: string;
  requesterId: string;
  reviewerId?: string | null;
  actionType: string;
  targetType: string;
  targetId?: string | null;
  status: ApprovalStatus;
  /** Frozen parallel-recipient set for order main approval only. */
  eligibleReviewerIds?: string[];
  risk: string;
  payload: Record<string, any>;
  /** Server-computed fingerprint of the frozen application facts currently shown for review. */
  reviewContentVersion: string;
  decisionNote?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  requester?: ApprovalPersonRef | null;
  reviewer?: ApprovalPersonRef | null;
  // 内核审计字段（DR-007/委派/BOSS 兜底；旧数据可能缺省）
  reviewerResolverRoute?: ReviewerResolverRoute | null;
  departmentSnapshotId?: string | null;
  delegatedBy?: string | null;
  delegatedAt?: string | null;
  delegateReason?: string | null;
  clientReviewerIdSupplied?: boolean | null;
  bossFinalBypassBy?: string | null;
  bossFinalBypassAt?: string | null;
  bossFinalBypassReason?: string | null;
  bypassedApprovalId?: string | null;
  /** Optional server audit projection; absent means the sync outcome is not known. */
  businessSyncStatus?: 'failed' | 'completed' | 'not_applicable' | 'unknown';
  /** Command response only; exact detail readback remains authoritative for current state. */
  decisionSync?: ApprovalBusinessSyncResult;
}

export interface ApprovalReviewField {
  key: string;
  label: string;
  value: string;
}

export interface ApprovalReviewAttachment {
  id: string;
  fileName: string;
  href: string;
  mimeType?: string;
}

export interface ApprovalReviewDetail {
  schemaVersion: 1;
  approvalId: string;
  actionType: string;
  targetType: string;
  targetId: string | null;
  title: string;
  reviewContentVersion: string;
  frozen: {
    label: string;
    fields: ApprovalReviewField[];
    attachments: ApprovalReviewAttachment[];
    attachmentStatus: 'available' | 'unavailable' | 'not_applicable';
    attachmentStatusLabel: string;
    sourceReference: { kind: string; id: string; label: string } | null;
    previewDigest: string;
  };
  currentSource: {
    status: 'available' | 'missing' | 'unavailable' | 'not_applicable';
    label: string;
    fields: ApprovalReviewField[];
  };
  decisionHistory: Array<{
    id: string; action: string; actorId: string; actorName: string | null; occurredAt: string;
    decisionNote?: string; status?: string;
  }>;
  decisionHistoryStatus: 'available' | 'unavailable';
  approvalBlockers: string[];
  canApprove: boolean;
}

export interface ApprovalBusinessSyncResult {
  status: 'completed' | 'failed';
  retryable: boolean;
  code?: string;
}

export interface QuotationAmendmentDraft {
  lineUnitPrices?: Array<{ lineId: string; unitPrice: string | number }>;
  validUntil?: string | null;
  notes?: string | null;
  reason: string;
  previewVersion?: string;
  finalContentVersion?: string;
}
export interface QuotationAmendmentPreview {
  approvalId: string; actionType: string; targetType: string; targetId: string;
  sourceVersion: number; sourceFingerprint: string; finalVersion: number;
  finalContentVersion: string; previewVersion: string;
  diff: Array<{ field: string; before: unknown; after: unknown }>;
  before: Record<string, unknown>; after: Record<string, unknown>;
  priceRuleLevel: string; priceRuleFindings: unknown;
  moq: { ok: boolean; basisHash: string; currentApprovalId: string | null };
}
export interface QuotationAmendmentResult {
  approvalId: string; amended: boolean; decisionStatus?: string;
  amendment?: { sourceVersion: number; finalVersion: number; sourceFingerprint: string; finalContentVersion: string;
    finalFingerprint?: string; reason?: string; diff?: Array<{ field: string; before: unknown; after: unknown }> };
  currentSource?: { version: number; contentFingerprint: string; quotationSnapshot: Record<string, unknown> } | null;
}

export interface DevelopmentFeeFinalInput { amount: string; waivedAmount: string; reason: string }
export interface DevelopmentFeeFinalProposalPreview {
  approvalId: string;
  reviewContentVersion: string;
  sourceBillingItemVersion: number;
  finalInput: DevelopmentFeeFinalInput;
  diff: Array<{ field: 'amount' | 'waivedAmount'; before: string; after: string }>;
  previewDigest: string;
}

/** GET /v1/approvals-kernel/:id/resolution-trace 返回的解析轨迹视图 */
export interface ApprovalResolutionTrace {
  id: string;
  status: ApprovalStatus;
  actionType: string;
  requesterId: string;
  reviewerId: string | null;
  reviewerResolverRoute: ReviewerResolverRoute | null;
  departmentSnapshotId: string | null;
  delegatedBy: string | null;
  delegatedAt: string | null;
  delegateReason: string | null;
  clientReviewerIdSupplied: boolean | null;
  bossFinalBypassBy: string | null;
  bossFinalBypassAt: string | null;
  bossFinalBypassReason: string | null;
  bypassedApprovalId: string | null;
}

/** 解析路径 → 人类可读轨迹链标签（请求人部门 → 解析命中节点） */
export const RESOLVER_ROUTE_LABEL: Record<ReviewerResolverRoute, string> = {
  DEPT_HEAD: '部门主管',
  FALLBACK_DEPT_HEAD_VACANT: '部门主管空缺兜底（本部门销售主管 / ADMIN）',
  FALLBACK_SELF_APPLY_SUPERVISOR: '自申请阻断兜底（上级部门主管 / ADMIN）',
  FALLBACK_ADMIN: 'ADMIN 兜底（无部门 / 无候选）',
};

/** 路由是否触发了兜底链（非直命中部门主管） */
export function isFallbackRoute(route: ReviewerResolverRoute | null | undefined): boolean {
  return Boolean(route && route !== 'DEPT_HEAD');
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

function kernelUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/approvals-kernel${path}`, base);
}
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const approvalKernelService = {
  /** 业务审批列表（pending 待办 / done 已办） */
  async listBusinessApprovals(view: 'pending' | 'done' = 'pending', endpoint?: string): Promise<ApprovalKernelListItem[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals?status=${view}`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'listBusinessApprovals failed');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  /** Exact permission-scoped native read. The server decides whether this actor can see this ID. */
  async getBusinessApproval(id: string, endpoint?: string): Promise<ApprovalKernelListItem> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'getBusinessApproval failed');
    const data = await res.json();
    if (data?.item?.id !== id || !['pending', 'approved', 'rejected', 'cancelled'].includes(data.item.status))
      throw new Error('审批详情响应与请求编号不一致，无法安全打开。');
    return data.item;
  },

  /** Read frozen facts, permission-scoped current source, legal attachments, and server decision history. */
  async getApprovalReviewDetail(id: string, endpoint?: string): Promise<ApprovalReviewDetail> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/detail`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'getApprovalReviewDetail failed');
    const data = await res.json();
    const detail = data?.detail;
    const validFields = (fields: unknown) => Array.isArray(fields) && fields.every((field: any) =>
      typeof field?.key === 'string' && typeof field?.label === 'string' && typeof field?.value === 'string');
    const validDigest = isSha256(detail?.frozen?.previewDigest);
    const sourceRef = detail?.frozen?.sourceReference;
    const validSourceRef = sourceRef === null || (typeof sourceRef?.kind === 'string'
      && typeof sourceRef?.id === 'string' && typeof sourceRef?.label === 'string');
    const validAttachments = Array.isArray(detail?.frozen?.attachments) && detail.frozen.attachments.every((file: any) =>
      typeof file?.id === 'string' && typeof file?.fileName === 'string' && typeof file?.href === 'string'
      && file.href.startsWith('/api/v1/'));
    if (detail?.schemaVersion !== 1 || detail.approvalId !== id || typeof detail.actionType !== 'string'
      || typeof detail.targetType !== 'string' || !(detail.targetId === null || typeof detail.targetId === 'string')
      || typeof detail.title !== 'string' || !isSha256(detail.reviewContentVersion)
      || typeof detail.frozen?.label !== 'string' || !validFields(detail.frozen.fields) || !validAttachments
      || !['available', 'unavailable', 'not_applicable'].includes(detail.frozen.attachmentStatus)
      || typeof detail.frozen.attachmentStatusLabel !== 'string'
      || !validSourceRef || !validDigest
      || !['available', 'missing', 'unavailable', 'not_applicable'].includes(detail.currentSource?.status)
      || typeof detail.currentSource?.label !== 'string' || !validFields(detail.currentSource?.fields)
      || !Array.isArray(detail.decisionHistory) || !['available', 'unavailable'].includes(detail.decisionHistoryStatus)
      || !Array.isArray(detail.approvalBlockers) || detail.approvalBlockers.some((value: unknown) => typeof value !== 'string')
      || typeof detail.canApprove !== 'boolean')
      throw new Error('审批详情依据响应不完整或与申请编号不一致，无法安全审阅。');
    return detail as ApprovalReviewDetail;
  },

  /** 既有决策端点（通过 / 驳回；驳回必填 decisionNote） */
  async decideApproval(
    id: string,
    status: 'approved' | 'rejected',
    input: { reviewContentVersion: string; reviewPreviewDigest?: string; confirmedReviewedContent?: boolean; decisionNote?: string;
      rejectionReason?: string; requestedChanges?: string; modifiedInput?: Record<string, unknown> },
    endpoint?: string,
  ): Promise<ApprovalKernelListItem> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/decide`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ status, ...input }),
    });
    if (!res.ok) await readError(res, 'decideApproval failed');
    const data = await res.json();
    const sync = data?.sync;
    const decisionSync: ApprovalBusinessSyncResult | undefined = sync
      && ['completed', 'failed'].includes(sync.status)
      && typeof sync.retryable === 'boolean'
      ? { status: sync.status, retryable: sync.retryable, ...(typeof sync.code === 'string' ? { code: sync.code } : {}) }
      : undefined;
    if (data?.item?.id !== id || !['approved', 'rejected'].includes(data.item.status))
      throw new Error('决议响应无法核验；请重新读取审批详情后再判断。');
    return { ...data.item, ...(decisionSync ? { decisionSync } : {}) };
  },

  /** Read-only exact proposal preview; the final amount is only written inside the decision transaction. */
  async previewDevelopmentFeeFinalProposal(id: string, input: { reviewContentVersion: string; finalInput: DevelopmentFeeFinalInput }, endpoint?: string): Promise<DevelopmentFeeFinalProposalPreview> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/development-fee-preview`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) await readError(res, 'previewDevelopmentFeeFinalProposal failed');
    const data = await res.json(); const preview = data?.preview;
    const validInput = preview?.finalInput && typeof preview.finalInput.amount === 'string'
      && typeof preview.finalInput.waivedAmount === 'string' && typeof preview.finalInput.reason === 'string';
    const validDiff = Array.isArray(preview?.diff) && preview.diff.length > 0 && preview.diff.every((row: any) =>
      ['amount', 'waivedAmount'].includes(row?.field) && typeof row.before === 'string' && typeof row.after === 'string');
    if (preview?.approvalId !== id || preview.reviewContentVersion !== input.reviewContentVersion
      || !Number.isSafeInteger(preview.sourceBillingItemVersion) || preview.sourceBillingItemVersion < 0
      || !validInput || !validDiff || !isSha256(preview.previewDigest))
      throw new Error('开发收费预览与审批编号、内容版本或最终金额不一致，无法安全确认。');
    return preview as DevelopmentFeeFinalProposalPreview;
  },

  /** Read-only preview; server rejects non-native quote approvals and writes nothing. */
  async previewQuotationAmendment(id: string, input: { reviewContentVersion: string; amendment: QuotationAmendmentDraft }, endpoint?: string): Promise<QuotationAmendmentPreview> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/quotation-amendment/preview`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) await readError(res, 'previewQuotationAmendment failed');
    const data = await res.json(); const preview = data?.preview;
    const targetMatches = preview?.actionType === 'quotation:line_approve'
      ? preview.targetType === 'QuotationLine' : preview?.actionType === 'quotation:total_approve'
        ? preview.targetType === 'Quotation' : false;
    if (preview?.approvalId !== id || !targetMatches || typeof preview.targetId !== 'string' || !preview.targetId
      || !Number.isSafeInteger(preview.sourceVersion) || !Number.isSafeInteger(preview.finalVersion) || preview.finalVersion !== preview.sourceVersion + 1
      || !isSha256(preview.sourceFingerprint) || !isSha256(preview.finalContentVersion)
      || !isSha256(preview.previewVersion) || !Array.isArray(preview.diff) || preview.diff.length === 0)
      throw new Error('报价修订预览的审批编号不一致，或最终版本不完整，无法安全确认。');
    return preview;
  },

  /** Confirm only the exact preview after an explicit final-version checkbox. */
  async confirmQuotationAmendment(id: string, input: { reviewContentVersion: string; reviewPreviewDigest?: string; confirmedReviewedContent: true; amendment: QuotationAmendmentDraft }, endpoint?: string): Promise<{ item: ApprovalKernelListItem; amendment: Record<string, unknown> }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    if (input.confirmedReviewedContent !== true || !input.amendment.previewVersion || !input.amendment.finalContentVersion)
      throw new Error('必须先核对并明确确认最终报价版本。');
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/quotation-amendment/confirm`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input) });
    if (!res.ok) await readError(res, 'confirmQuotationAmendment failed');
    const data = await res.json();
    if (data?.item?.id !== id || data?.item?.status !== 'approved' || data?.amendment?.approvalId !== id
      || data?.amendment?.finalContentVersion !== input.amendment.finalContentVersion
      || !isSha256(data?.amendment?.finalContentVersion) || !isSha256(data?.amendment?.finalFingerprint)
      || !isSha256(data?.amendment?.sourceFingerprint) || !Number.isSafeInteger(data?.amendment?.sourceVersion)
      || !Number.isSafeInteger(data?.amendment?.finalVersion) || data.amendment.finalVersion !== data.amendment.sourceVersion + 1)
      throw new Error('报价修订决议无法核验；请重新读取审批与原报价状态。');
    return { item: data.item, amendment: data.amendment };
  },

  /** Read the exact committed amendment audit and compare it to the current quotation source. */
  async getQuotationAmendmentResult(id: string, endpoint?: string): Promise<QuotationAmendmentResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/quotation-amendment/result`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'getQuotationAmendmentResult failed');
    const data = await res.json(); const result = data?.result;
    if (result?.approvalId !== id || typeof result.amended !== 'boolean'
      || (result.amended && (result.decisionStatus !== 'approved' || !result.currentSource
        || !Number.isSafeInteger(result.amendment?.sourceVersion) || !Number.isSafeInteger(result.amendment?.finalVersion)
        || result.amendment!.finalVersion !== result.amendment!.sourceVersion + 1
        || !isSha256(result.amendment?.sourceFingerprint) || !isSha256(result.amendment?.finalContentVersion)
        || !isSha256(result.amendment?.finalFingerprint) || result.amendment!.finalFingerprint !== result.amendment!.finalContentVersion
        || result.currentSource.version !== result.amendment?.finalVersion
        || result.currentSource.contentFingerprint !== result.amendment?.finalContentVersion))
      || (!result.amended && result.currentSource !== null))
      throw new Error('报价修订回执的审批编号不一致，或与当前报价版本不一致。');
    return result;
  },

  /** Resume only the already-committed business projection; the server owns idempotency and authorization. */
  async retryBusinessSync(id: string, endpoint?: string): Promise<{ item: ApprovalKernelListItem; sync: ApprovalBusinessSyncResult }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/approvals/${encodeURIComponent(id)}/retry-sync`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) await readError(res, 'retryBusinessSync failed');
    const data = await res.json();
    const sync = data?.sync;
    if (data?.item?.id !== id || !['approved', 'rejected'].includes(data.item.status)
      || !sync || !['completed', 'failed'].includes(sync.status) || typeof sync.retryable !== 'boolean')
      throw new Error('续办结果无法核验；请重新读取审批与原业务状态后再判断。');
    return { item: data.item, sync };
  },

  /** DR-007 解析轨迹只读视图（owner/admin/manager 可读） */
  async getResolutionTrace(id: string, endpoint?: string): Promise<ApprovalResolutionTrace> {
    const res = await fetch(kernelUrl(`/${encodeURIComponent(id)}/resolution-trace`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getResolutionTrace failed');
    const data = await res.json();
    return data.item;
  },

  /** 委派（仅当前 reviewerId 本人；reason ≥10 字；禁止委派给申请人） */
  async delegateApproval(
    id: string,
    input: { toUserId: string; reason: string },
    endpoint?: string,
  ): Promise<ApprovalKernelListItem> {
    const res = await fetch(kernelUrl(`/${encodeURIComponent(id)}/delegate`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ toUserId: input.toUserId, reason: input.reason }),
    });
    if (!res.ok) await readError(res, 'delegateApproval failed');
    const data = await res.json();
    return data.item;
  },

  /** BOSS 最终兜底特批（仅 owner；reason ≥30 字） */
  async bossBypassApproval(id: string, input: { reason: string; reviewContentVersion: string; confirmedReviewedContent: true }, endpoint?: string): Promise<ApprovalKernelListItem> {
    const res = await fetch(kernelUrl(`/${encodeURIComponent(id)}/boss-bypass`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'bossBypassApproval failed');
    const data = await res.json();
    return data.item;
  },
};
