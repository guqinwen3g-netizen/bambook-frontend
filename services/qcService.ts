import { normalizeDevelopmentQcMeasurements, type DevelopmentQcMeasurement } from '../server/src/development/developmentQcMeasurements';
export type { DevelopmentQcMeasurement } from '../server/src/development/developmentQcMeasurements';
import { businessNowDate } from '../lib/businessClock';
/**
 * QC API service — QC 双链域（DR-029）+ 验货报告双签（质量门禁 §9.3-②）。
 * Communicates with /api/v1/qc endpoints.
 *
 * 双链严格隔离（镜像后端 server/src/qc/qcChainService.ts 契约，root types.ts 冻结区
 * 禁止编辑，类型全部内聚在本文件）：
 *   - 服装链（工厂→QC→业务员→客户）：每轮新样必须重新 QC 评审后才可寄客户（DR-008
 *     内部门禁，fail-closed）；QC 可直接打回工厂重做（DIRECT_REJECT，QC-29-A4）
 *   - 面料链（业务员→QC→工厂→业务员）：客户不通过 → 业务员转 QC → QC 向工厂提技术
 *     调整 → 工厂新样 → 业务员再寄客户
 *   - 验货报告双签：signatures JSONB（qcSignedAt/qcSignerId/businessSignedAt/businessSignerId）
 */

import { apiService } from './apiService';
import type { QCAssignment } from '../types';
import type { QcEvidenceFile } from './qcProfessionalService';
import { getAuthState, hasPermission, subscribe } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
import { beginBusinessRequest, clearAcknowledgedBusinessRequest, listBusinessRequests } from './businessRequestRecovery';

// ══════════════════════════════════════════════════════════════
// 常量与类型
// ══════════════════════════════════════════════════════════════

/** 服装链需 QC 内部门禁的样品级别（confirmation/FIT 开发样按 DR-027 排除） */
export const GARMENT_QC_SAMPLE_LEVELS = ['pp', 'top'] as const;
export type GarmentQcSampleLevel = (typeof GARMENT_QC_SAMPLE_LEVELS)[number];

/** 面料链可转 QC 的样品类型（S/S 船样 / RC 匹头样 / 投产后早期生产样） */
export const FABRIC_QC_SAMPLE_KINDS = ['SS', 'RC', 'EARLY_PRODUCTION'] as const;
export type FabricQcSampleKind = (typeof FABRIC_QC_SAMPLE_KINDS)[number];

/** 链评审结论处置 */
export const CHAIN_DISPOSITIONS = ['STANDARD', 'DIRECT_REJECT', 'REQUIRES_FACTORY_TECH_ADJUST'] as const;
export type ChainDisposition = (typeof CHAIN_DISPOSITIONS)[number];

export const CHAIN_CONCLUSION_LABELS: Record<string, string> = {
  pass: '通过',
  conditional: '有条件通过',
  fail: '不通过',
};

export const CHAIN_DISPOSITION_LABELS: Record<ChainDisposition, string> = {
  STANDARD: '标准流转',
  DIRECT_REJECT: '直接打回工厂重做',
  REQUIRES_FACTORY_TECH_ADJUST: '需工厂技术调整',
};

/** 服装链评审输入（DR-029：QC 文本评审意见不得压缩为机械二值） */
export interface GarmentSampleReviewInput {
  sampleLevel?: GarmentQcSampleLevel;   // pp | top（默认 pp）
  round?: number;                       // 样品轮次（>=1；客户不通过工厂重做后 round+1）
  conclusion?: 'pass' | 'conditional' | 'fail';
  opinion?: string;                     // QC 文本评审意见
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  evidence?: unknown[];
  inspectionDate?: string;              // YYYY-MM-DD
  directReject?: boolean;               // QC-29-A4：直接打回工厂重做
  rejectReason?: string;                // directReject=true 时必填
}

/** 面料链评审输入（conclusion≠pass 时 factoryAdjustment.requirement 必填） */
export interface FabricSampleReviewInput {
  sampleKind?: FabricQcSampleKind;
  sampleId?: string;                    // FabricShipmentSample.id / EarlyProductionSample.id
  conclusion?: 'pass' | 'conditional' | 'fail';
  opinion?: string;                     // QC 专业意见（对工厂的技术调整说明）
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  evidence?: unknown[];
  inspectionDate?: string;
  factoryAdjustment?: {
    requirement?: string;               // 调整要求（染整/后整理/修布等）
    parameters?: unknown;
    factoryName?: string;
    followUpBy?: string;
    evidence?: unknown[];
  };
}

/** DR-008 / QC-29-A3 服装样品寄送门禁查询结果 */
export interface GarmentSampleGate {
  orderId: string;
  sampleLevel: string;
  round: number;
  reviewed: boolean;
  passed: boolean;
  conclusion: string | null;
  disposition: ChainDisposition | null;
  reportId: string | null;
  blockedCode: 'RE_INSPECTION_REQUIRED' | 'SAMPLE_QC_GATE_NOT_PASSED' | 'SAMPLE_DIRECTLY_REJECTED' | null;
  blockedMessage: string | null;
}

/** InspectionReport 双签（signatures JSONB；chain 命名空间与双签字段平级共存） */
export interface InspectionReportSignatures {
  qcSignedAt?: number | null;
  qcSignerId?: string | null;
  businessSignedAt?: number | null;
  businessSignerId?: string | null;
  chain?: {
    disposition?: ChainDisposition;
    rejectReason?: string;
    factoryAdjustment?: { requirement?: string; factoryName?: string; followUpBy?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 验货报告行（链报告列表附加 chain/sampleKind/round 解析字段） */
export interface QcInspectionReport {
  id: string;
  orderId: string;
  inspectionType: string;               // final | midline | sample_pp__r1 | fabric_ss__r2 ...
  inspectionDate: string | null;
  inspectorOrg: string | null;
  result: string | null;                // pass | conditional | fail
  criticalDefects: number;
  majorDefects: number;
  minorDefects: number;
  defectSummary: string | null;
  inspectedBy: string | null;
  approvedByBusiness: boolean;
  businessApprover: string | null;
  notes: string | null;
  signatures: InspectionReportSignatures | null;
  createdAt: number;
  updatedAt: number;
  scopeType?: 'whole_order' | 'production_batch';
  scopeKey?: string;
  scopeFingerprint?: string | null;
  scopeSnapshot?: QcPhysicalCoverage['scopeSnapshot'] | null;
  productionBatchId?: string | null;
  productionBatchRevision?: number | null;
  revision?: number;
  supersedesId?: string | null;
  contentFingerprint?: string | null;
  productionSizeChecks?: ProductionSizeChecks | null;
  evidenceFiles?: QcEvidenceFile[] | null;
  productionSizeCoverage?: ProductionQcSizeCoverage;
  resolvesProductionQcIssueIds?: string[];
  approvedAt?: number | null;
  coverageCurrent?: boolean;
  /** Scoped report content fingerprint and native width rows match the current report. */
  contentCurrent?: boolean;
  isCurrentRevision?: boolean;
  canBusinessDecide?: boolean;
  // listChainReports 附加（parseChainInspectionType 解析）
  chain?: 'garment' | 'fabric';
  sampleKind?: string;
  round?: number;
  // listReports 台账附加（订单快照；软删订单视同无快照）
  order?: {
    poNumber: string | null;
    customer: string | null;
    product: string | null;
    dueDate?: string | null;
    clientDate?: string | null;
    businessLine?: string | null;
  } | null;
}

/** Exact report detail carries only its already-authorized native parent. */
export interface QcInspectionReportDetail extends QcInspectionReport {
  order: { id: string; poNumber: string | null; customer: string; product: string };
}

/** DR-014 面料出运三条件并行视图（QC ∥ S/S ∥ RC） */
export interface QcShipmentEligibility {
  nativeSampleProofBlocked?: boolean;
  nativeSampleFailureReasons?: string[];
  orderId: string;
  applicable: boolean;
  eligible: boolean;
  conditions: {
    bulkQc: {
      satisfied: boolean;
      reportId?: string | null;
      result?: string | null;
      inspectedBy?: string | null;
      inspectionDate?: string | null;
      /**
       * D8 生产门禁口径缺口明细：服务端 assessInspectionRelease.failures 的 message 投影，
       * 仅在 satisfied=false 时出现。前端**只展示**、不得据此自行判定资格。
       */
      failureReasons?: string[];
    };
    ss: { satisfied: boolean; sampleId?: string | null; sampleCode?: string | null; customerStatus?: string | null; customerFeedbackDate?: string | null };
    rc: { enabled: boolean; satisfied: boolean; sentDate?: string | null; confirmedDate?: string | null };
  };
  missingGates: Array<'BULK_QC_NOT_PASSED' | 'SS_NOT_CONFIRMED' | 'RC_NOT_CONFIRMED'>;
  reason?: string;
}

export type ReportSignRole = 'qc' | 'business';

/** Fabric development sample review routed from a returned physical sample. */
export type DevelopmentSampleQcStatus = 'queued' | 'in_progress' | 'reviewed' | 'acknowledged';
export type DevelopmentSampleQcResult = 'pass' | 'conditional_pass' | 'needs_adjustment' | 'reject';
export interface DevelopmentSampleQcReview {
  measurements?: DevelopmentQcMeasurement[] | null;
  routingTeamId?: string | null;
  responsibleHeadId?: string | null;
  requestedBy?: string | null;
  id: string;
  status: DevelopmentSampleQcStatus;
  developmentCaseId: string;
  sampleBatchId?: string;
  sampleVersionId?: string | null;
  sourceFingerprint?: string;
  startedBy?: string | null;
  startedAt?: number | string | null;
  updatedAt?: number | string | null;
  reviewedBy?: string | null;
  completionRequestKey?: string | null;
  evidence?: unknown[] | null;
  /** Authoritative DevelopmentCase.type supplied by the read-only review-list projection. */
  developmentType?: string | null;
  caseCode: string;
  caseName: string;
  customerName: string | null;
  round: number;
  versionLabel: string;
  supplierName: string;
  sampleType: string;
  batchCode: string;
  specNote: string | null;
  caseRequirements?: Record<string, unknown> | null;
  returnedAt: number | string | null;
  results: {
    dyeLotNo: string | null;
    colorRating: string | number | null;
    sideDiff: number | null;
    endDiff: number | null;
    defectCauses: string[];
    notes: string | null;
    actualQuantity: number | string | null;
    actualUnit: string | null;
    photos?: string[] | null;
  };
  result?: DevelopmentSampleQcResult | null;
  opinion?: string | null;
  criticalDefects?: number | null;
  majorDefects?: number | null;
  minorDefects?: number | null;
  reviewedAt?: number | string | null;
  /** Identifier of this development-sample review record, never an order InspectionReport. */
  reportId?: string | null;
}
export interface DevelopmentSampleQcCompletionInput {
  measurements?: DevelopmentQcMeasurement[];
  requestKey: string;
  result: DevelopmentSampleQcResult;
  opinion: string;
  inspectionDate?: string;
  criticalDefects: number;
  majorDefects: number;
  minorDefects: number;
  evidence?: unknown[];
  evidenceFileIds?: string[];
}

// ══════════════════════════════════════════════════════════════
// 内部辅助
// ══════════════════════════════════════════════════════════════

async function parseError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}));
  // server 信封：{ error: { code, message } }（qcRoute 风格），兼容平铺 { error: 'CODE' }
  const code = typeof err?.error?.code === 'string' ? err.error.code
    : typeof err?.error === 'string' ? err.error
      : undefined;
  const message = err?.error?.message || (typeof err?.error === 'string' ? err.error : null) || `${fallback}: HTTP ${res.status}`;
  const error: any = new Error(code && message !== code && !String(message).includes(code) ? `${code}：${message}` : message);
  error.status = res.status;
  error.code = code;
  throw error;
}

function qcUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/qc${path}`, base);
}

async function postJson<T>(path: string, body: unknown, endpoint?: string, fallback = 'request failed', method: 'POST' | 'PATCH' | 'DELETE' = 'POST'): Promise<T> {
  const res = await fetch(qcUrl(path, endpoint), {
    method,
    headers: apiService.getAuthHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await parseError(res, fallback);
  return res.json();
}

async function getJson<T>(path: string, endpoint?: string, fallback = 'request failed'): Promise<T> {
  const res = await fetch(qcUrl(path, endpoint), {
    headers: apiService.getAuthHeaders(),
  });
  if (!res.ok) await parseError(res, fallback);
  return res.json();
}

// ══════════════════════════════════════════════════════════════
// REQ2-04 第三方测试管理（TestRequest — 订单级实验室检测委托）
// ══════════════════════════════════════════════════════════════

/** 测试项目枚举（镜像后端 testRequestService.TEST_ITEMS） */
export const TEST_ITEMS = [
  'color_fastness', 'shrinkage', 'tensile', 'ph', 'formaldehyde', 'azo', 'gsm', 'width', 'other',
] as const;
export const TEST_ITEM_LABELS: Record<string, string> = {
  color_fastness: '色牢度', shrinkage: '缩水率', tensile: '强力', ph: 'pH 值',
  formaldehyde: '甲醛', azo: '偶氮', gsm: '克重', width: '幅宽', other: '其他',
};

export const TEST_AGENCIES = ['sgs', 'its', 'bv', 'other'] as const;
export const TEST_AGENCY_LABELS: Record<string, string> = { sgs: 'SGS', its: 'ITS', bv: 'BV', other: '其他机构' };
export const TEST_RESULT_LABELS: Record<string, string> = { pending: '待报告', pass: '通过', fail: '不合格' };

export interface TestReportFileRow {
  id: string;
  testRequestId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: number;
}

export interface TestCorrectiveActionRow {
  id: string;
  testRequestId: string;
  failItem: string;
  action: string;
  owner: string | null;
  dueDate: string | null;
  status: 'open' | 'closed';
  closedAt: number | null;
  closeNote: string | null;
}

export interface TestRequestRow {
  id: string;
  trNo: string;
  orderId: string;
  testItems: string[];
  agency: string;
  sentDate: string | null;
  expectedDate: string | null;
  notes: string | null;
  result: 'pending' | 'pass' | 'fail';
  reportNo: string | null;
  reportDate: string | null;
  failItems: string[];
  createdAt: number;
  files: TestReportFileRow[];
  correctiveActions: TestCorrectiveActionRow[];
}

export interface TestRequestSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  openCorrectiveActions: number;
}

/** 当前验货任务授权下的检验资料，不包含订单财务或其他任务的数据。 */
export interface AssignmentInspectionContext {
  ok: true;
  assignment: { id: string; orderId: string; qcUserId: string | null; status: string; inspectionType: string; updatedAt: number;
    assignedAt: number; dueDate: string | null; notes: string | null; completedAt: number | null; reportId: string | null;
    locationId: string | null; location: { id: string; code: string; name: string } | null;
    factory?: { id: string; code: string; name: string; contactInfo: string; factoryAddresses: string[] } | null;
    canClaim?: boolean; canTransfer?: boolean;
    handoffHistory?: Array<{ id: string; operation: 'claim' | 'transfer'; actorId: string; fromQcUserId: string | null; toQcUserId: string; reason: string; occurredAt: string }> }
    & Partial<QcPhysicalCoverage>;
  order: { id: string; poNumber: string | null; type: string; businessLine?: string | null; product: string; customer: string };
  lines: Array<{ id: string; lineNumber: number; itemNo: string | null; materialCode: string | null; description: string | null; quantity: number | null; unit: string | null; width: string | null }>;
  productionSizeCoverage?: ProductionQcSizeCoverage;
  productionQcIssues?: ProductionQcIssueProjection;
}

export interface ProductionSizeCheck { size: string; inspectedUnits: number; result: 'pass' | 'fail'; evidence: string[]; note?: string }
export interface ProductionSizeChecks { schemaVersion: 1; actualSizes: string[]; scopeComplete: boolean; basis: string; checks: ProductionSizeCheck[] }
export interface ProductionQcSizeCoverage { applicable: boolean; available: boolean; satisfied: boolean; scopeComplete: boolean;
  actualSizes: string[]; missingSizes: string[]; failedSizes: string[]; checks: Array<ProductionSizeCheck & { reportId: string }>; reason: string | null }
export interface ProductionQcIssueProjection { available: boolean; error?: string;
  issues: Array<{ issueId: string; productionBatchRevision: number; failedReportId: string; failedSizes?: string[]; reason: string | null;
    createdBy: string; createdAt: string; status: 'open' | 'waiting_business_resume' | 'resumed' | 'unknown';
    latestReportId: string | null; latestReportResult: string | null; latestEventAt: string | null }> }

export interface QcPhysicalCoverage {
  scopeType: 'whole_order' | 'production_batch';
  scopeKey: string;
  productionBatchId: string | null;
  productionBatchRevision: number | null;
  scopeFingerprint: string;
  batchCode?: string;
  scopeSnapshot: { lines: Array<{ orderLineId: string; lineNumber?: number; itemNo?: string | null;
    quantity: string; unit: string | null }>; batch?: { id: string; batchCode: string; revision: number;
    rangeStart: string; quantity: string; unit: string; factoryRelationId: string } };
}

export function qcCoverageLabel(coverage: Partial<Omit<QcPhysicalCoverage, 'scopeFingerprint' | 'scopeSnapshot'>> & {
  scopeFingerprint?: string | null; scopeSnapshot?: QcPhysicalCoverage['scopeSnapshot'] | null;
}) {
  const batch = coverage.scopeSnapshot?.batch;
  return coverage.scopeType === 'production_batch'
    ? `${batch?.batchCode || coverage.batchCode || '实际批次'} · ${batch ? `${batch.quantity} ${batch.unit}` : '范围待核'} · 批次修订 ${coverage.productionBatchRevision ?? '—'}`
    : coverage.scopeFingerprint ? '整单 · 已冻结实际行与批次范围' : '整单历史记录 · 覆盖范围待核';
}

export interface QcRequestContext { poNumber: string | null; coverageLabel: string | null; reportRevision?: number | null;
  scopeType?: 'whole_order' | 'production_batch' }
export type QcPendingCommand = ({
  kind: 'create'; input: { orderId: string; inspectionType: string; qcUserId: string | null; locationId: string | null;
    dueDate: string | null; notes: string | null; scopeType: QcPhysicalCoverage['scopeType'];
    productionBatchId: string | null; expectedBatchRevision?: number; expectedScopeFingerprint: string };
} | { kind: 'complete'; assignmentId: string; input: { report: Record<string, unknown>; expectedScopeFingerprint: string } }
  | { kind: 'decision'; reportId: string; input: { expectedRevision: number; expectedScopeFingerprint: string;
    expectedContentFingerprint: string; decision: 'approved' | 'rejected'; reason: string } }) & { context?: QcRequestContext };

/** Modern durable command facts preserve the exact persisted ACK. Legacy GET
 * DTOs remain numeric and are reread by the existing UI after confirmation. */
export type QcCommandTimestamp = number | string;
export type QcCommandAssignmentSnapshot = Omit<QCAssignment, 'assignedAt' | 'completedAt'> & Partial<QcPhysicalCoverage> & {
  assignedAt: QcCommandTimestamp; completedAt?: QcCommandTimestamp | null;
  createdAt: QcCommandTimestamp; updatedAt: QcCommandTimestamp; deletedAt?: QcCommandTimestamp | null;
  requestKey?: string | null;
};
export type QcCommandReportSnapshot = Omit<QcInspectionReport, 'createdAt' | 'updatedAt' | 'approvedAt'> & {
  createdAt: QcCommandTimestamp; updatedAt: QcCommandTimestamp; approvedAt?: QcCommandTimestamp | null;
};
export interface QcCommandAck {
  ok: true; item: QcCommandAssignmentSnapshot | QcCommandReportSnapshot; report?: QcCommandReportSnapshot;
  receipt: { operation: QcPendingCommand['kind']; actorId: string; targetId: string; requestKey: string;
    commandHash: string; commandSnapshot: Record<string, unknown> };
  replayed: boolean;
}

export function pendingQcCommands() { return listBusinessRequests<QcPendingCommand>('qc:scoped:'); }

function commandOperation(command: QcPendingCommand) {
  return command.kind === 'create'
    ? `qc:scoped:create:${command.input.orderId}:${command.input.inspectionType}:${command.input.productionBatchId ?? 'whole_order'}`
    : `qc:scoped:${command.kind}:${command.kind === 'complete' ? command.assignmentId : command.reportId}`;
}

/** Browser storage holds only unresolved intent. An immutable native response
 * for the same original key/target closes it; list/latest state never does. */
export async function submitQcCommand(command: QcPendingCommand): Promise<QcCommandAck> {
  const actorId = getAuthState().user?.id;
  if (!actorId) throw new Error('请重新登录后继续');
  const identity = dashboardReadIdentity();
  let invalidated = false;
  const watch = () => { if (dashboardReadIdentity() !== identity) invalidated = true; };
  const stop = subscribe(watch);
  window.addEventListener('storage', watch); window.addEventListener('focus', watch);
  try {
  const endpoint = apiService.getStoredConfig().cloudEndpoint, requestEndpoint = qcUrl('', endpoint);
  const operation = commandOperation(command), record = beginBusinessRequest(operation, command);
  const path = command.kind === 'create' ? '/assignments' : command.kind === 'complete'
    ? `/assignments/${encodeURIComponent(command.assignmentId)}/complete`
    : `/reports/${encodeURIComponent(command.reportId)}/business-decision`;
  const data = await postJson<any>(path, { ...record.payload.input, requestKey: record.requestId }, endpoint,
    '请求结果暂不可确认，请保留原内容并按原请求重试');
  const item = data?.item;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
  const ack = data?.receipt;
  const targetId = command.kind === 'create' ? item?.id : command.kind === 'complete' ? command.assignmentId : command.reportId;
  watch();
  let acknowledged = !invalidated && data?.ok === true && !!item?.id && getAuthState().user?.id === actorId
    && qcUrl('') === requestEndpoint && ack?.operation === command.kind && ack.actorId === actorId
    && ack.targetId === targetId && ack.requestKey === record.requestId && /^[a-f0-9]{64}$/.test(ack.commandHash ?? '')
    && canonical(ack.commandSnapshot) === canonical(record.payload.input);
  if (command.kind === 'create') acknowledged = acknowledged && item.orderId === command.input.orderId
    && item.inspectionType === command.input.inspectionType && item.qcUserId === command.input.qcUserId
    && item.scopeFingerprint === command.input.expectedScopeFingerprint && item.requestKey === record.requestId
    && item.assignedById === actorId && item.scopeType === command.input.scopeType
    && (item.productionBatchId ?? null) === command.input.productionBatchId
    && (item.productionBatchRevision ?? null) === (command.input.expectedBatchRevision ?? null)
    && (item.locationId ?? null) === command.input.locationId && (item.dueDate ?? null) === command.input.dueDate
    && (item.notes ?? null) === command.input.notes && item.status === 'Assigned';
  else if (command.kind === 'complete') {
    const persistentProductionInspection = command.context?.scopeType === 'production_batch' || item.scopeType === 'production_batch';
    acknowledged = acknowledged && item.id === command.assignmentId
    && item.status === (persistentProductionInspection ? 'InProgress' : 'Completed')
    && (!persistentProductionInspection || item.scopeType === 'production_batch') && item.reportId === data.report?.id
    && data.report?.requestKey === record.requestId && data.report?.inspectedBy === actorId
    && data.report?.scopeFingerprint === command.input.expectedScopeFingerprint
    && (!persistentProductionInspection || data.report?.scopeType === 'production_batch'
      && !!item.productionBatchId && data.report.productionBatchId === item.productionBatchId
      && data.report.productionBatchRevision === item.productionBatchRevision)
    && Object.entries(command.input.report).every(([field, value]) => field === 'widthMeasurements'
      || (field === 'attachmentIds'
        ? canonical((data.report?.evidenceFiles ?? []).map((file: { id: string }) => file.id).sort()) === canonical(Array.isArray(value) ? [...value].sort() : value)
        : field === 'productionSizeChecks' || field === 'resolvesProductionQcIssueIds'
          ? canonical(data.report?.[field]) === canonical(value) : data.report?.[field] === value));
  } else acknowledged = acknowledged && item.id === command.reportId && item.revision === command.input.expectedRevision
    && item.scopeFingerprint === command.input.expectedScopeFingerprint
    && item.contentFingerprint === command.input.expectedContentFingerprint && item.businessApprover === actorId
    && item.approvedAt != null && item.approvedByBusiness === (command.input.decision === 'approved');
  if (!acknowledged) throw new Error('原请求回执不完整，请保留原请求并核对结果');
  clearAcknowledgedBusinessRequest(operation, record.requestId);
  return data;
  } finally { stop(); window.removeEventListener('storage', watch); window.removeEventListener('focus', watch); }
}

// ══════════════════════════════════════════════════════════════
// service
// ══════════════════════════════════════════════════════════════

export interface QcAssignmentUserOption { id: string; displayName: string; departmentName: string | null }

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableTimestamp(value: unknown): value is number | string | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string';
}

export function parseDevelopmentSampleQcReview(value: unknown): DevelopmentSampleQcReview | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, any>;
  const results = row.results;
  if (typeof row.id !== 'string' || !row.id.trim()
    || !['queued', 'in_progress', 'reviewed', 'acknowledged'].includes(row.status)
    || typeof row.developmentCaseId !== 'string' || !row.developmentCaseId.trim()
    || !(row.developmentType === undefined || row.developmentType === null || typeof row.developmentType === 'string')
    || typeof row.caseCode !== 'string' || typeof row.caseName !== 'string'
    || !isNullableText(row.customerName)
    || !Number.isSafeInteger(row.round) || row.round < 1
    || typeof row.versionLabel !== 'string' || typeof row.supplierName !== 'string'
    || typeof row.sampleType !== 'string' || typeof row.batchCode !== 'string'
    || !isNullableText(row.specNote) || !isNullableTimestamp(row.returnedAt)
    || !(row.caseRequirements === undefined || row.caseRequirements === null
      || typeof row.caseRequirements === 'object' && !Array.isArray(row.caseRequirements))
    || !results || typeof results !== 'object' || Array.isArray(results)
    || !isNullableText(results.dyeLotNo)
    || !(results.colorRating === null || typeof results.colorRating === 'string' || typeof results.colorRating === 'number')
    || !(results.sideDiff === null || typeof results.sideDiff === 'number' && Number.isFinite(results.sideDiff))
    || !(results.endDiff === null || typeof results.endDiff === 'number' && Number.isFinite(results.endDiff))
    || !Array.isArray(results.defectCauses) || results.defectCauses.some((item: unknown) => typeof item !== 'string')
    || !isNullableText(results.notes)
    || !(results.photos === undefined || results.photos === null || Array.isArray(results.photos) && results.photos.every((item: unknown) => typeof item === 'string'))
    || !(results.actualQuantity === null || typeof results.actualQuantity === 'number' && Number.isFinite(results.actualQuantity)
      || typeof results.actualQuantity === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(results.actualQuantity))
    || !isNullableText(results.actualUnit)) return null;

  const optionalResult = row.result === undefined || row.result === null
    || ['pass', 'conditional_pass', 'needs_adjustment', 'reject'].includes(row.result);
  const optionalCount = (count: unknown) => count === undefined || count === null
    || Number.isSafeInteger(count) && (count as number) >= 0;
  if (!optionalResult || !optionalCount(row.criticalDefects) || !optionalCount(row.majorDefects)
    || !optionalCount(row.minorDefects) || !(row.opinion === undefined || isNullableText(row.opinion))
    || !(row.reviewedAt === undefined || isNullableTimestamp(row.reviewedAt))
    || !(row.sampleBatchId === undefined || typeof row.sampleBatchId === 'string' && row.sampleBatchId.trim())
    || !(row.sampleVersionId === undefined || isNullableText(row.sampleVersionId))
    || !(row.sourceFingerprint === undefined || typeof row.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.sourceFingerprint))
    || !(row.startedBy === undefined || isNullableText(row.startedBy))
    || !(row.reviewedBy === undefined || isNullableText(row.reviewedBy))
    || !(row.completionRequestKey === undefined || isNullableText(row.completionRequestKey))
    || !(row.startedAt === undefined || isNullableTimestamp(row.startedAt))
    || !(row.updatedAt === undefined || isNullableTimestamp(row.updatedAt))
    || !(row.evidence === undefined || row.evidence === null || Array.isArray(row.evidence))
    || !(row.reportId === undefined || isNullableText(row.reportId))) return null;

  if (![row.routingTeamId, row.responsibleHeadId, row.requestedBy].every(value => value == null || typeof value === 'string' && !!value.trim())) return null;
  if (row.measurements != null) { try { normalizeDevelopmentQcMeasurements(row.measurements); } catch { return null; } }
  return row as DevelopmentSampleQcReview;
}

function validateDevelopmentSampleQcCompletion(input: DevelopmentSampleQcCompletionInput): void {
  if (typeof input?.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestKey)) {
    throw new Error('评审请求编号无效，请重新打开评审表单。');
  }
  if (!input || !['pass', 'conditional_pass', 'needs_adjustment', 'reject'].includes(input.result)) {
    throw new Error('请选择 QC 评审结论。');
  }
  if (input.measurements !== undefined) normalizeDevelopmentQcMeasurements(input.measurements);
  if (typeof input.opinion !== 'string' || !input.opinion.trim()) {
    throw new Error('请填写 QC 评审意见。');
  }
  for (const [label, value] of [['严重缺陷', input.criticalDefects], ['主要缺陷', input.majorDefects], ['轻微缺陷', input.minorDefects]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}数量必须是非负整数。`);
  }
  if (input.inspectionDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.inspectionDate)) {
    throw new Error('评审日期格式无效。');
  }
  if (input.evidenceFileIds !== undefined && (!Array.isArray(input.evidenceFileIds) || input.evidenceFileIds.length > 30
    || input.evidenceFileIds.some(id => typeof id !== 'string' || !/^qef_[a-f0-9-]{36}$/.test(id))
    || new Set(input.evidenceFileIds).size !== input.evidenceFileIds.length)) throw new Error('请选择本次准确开发 QC 已上传的附件。');
}

export const qcService = {
  /** Returned development samples awaiting QC review or business readback. */
  async listDevelopmentSampleReviews(status?: DevelopmentSampleQcStatus, endpoint?: string): Promise<DevelopmentSampleQcReview[]> {
    if (!hasPermission('qc:read')) throw new Error('当前账号没有读取开发样品 QC 评审的权限。');
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const identity = dashboardReadIdentity();
    const data = await getJson<{ items: unknown[] }>(`/development-sample-reviews${query}`, endpoint, '开发样品 QC 评审加载失败');
    if (dashboardReadIdentity() !== identity || !hasPermission('qc:read')) {
      throw new Error('账号或权限已变化，请重新读取开发样品 QC 评审。');
    }
    if (!Array.isArray(data?.items)) throw new Error('开发样品 QC 评审列表返回不完整，请重新读取。');
    const items = data.items.map(parseDevelopmentSampleQcReview);
    if (items.some(item => item === null) || new Set(items.map(item => item!.id)).size !== items.length) {
      throw new Error('开发样品 QC 评审列表返回不完整或包含重复记录，请重新读取。');
    }
    return items as DevelopmentSampleQcReview[];
  },

  async startDevelopmentSampleReview(reviewId: string, endpoint?: string): Promise<void> {
    if (!hasPermission('qc:inspect')) throw new Error('当前账号没有执行正式 QC 评审的权限。');
    const identity = dashboardReadIdentity(), actorId = getAuthState().user?.id;
    const data = await postJson<any>(`/development-sample-reviews/${encodeURIComponent(reviewId)}/start`, {}, endpoint,
      '开始开发样品 QC 评审失败');
    if (dashboardReadIdentity() !== identity || !hasPermission('qc:inspect') || data?.ok !== true || data?.item?.id !== reviewId
      || data?.item?.status !== 'in_progress' || data?.item?.startedBy !== actorId) {
      throw new Error('开始评审返回的记录与当前开发样品不一致，请刷新核对状态。');
    }
  },

  async completeDevelopmentSampleReview(reviewId: string, input: DevelopmentSampleQcCompletionInput, endpoint?: string): Promise<DevelopmentSampleQcReview> {
    if (!hasPermission('qc:inspect')) throw new Error('当前账号没有执行正式 QC 评审的权限。');
    const identity = dashboardReadIdentity(), actorId = getAuthState().user?.id;
    validateDevelopmentSampleQcCompletion(input);
    const data = await postJson<any>(`/development-sample-reviews/${encodeURIComponent(reviewId)}/complete`, {
      ...input,
      opinion: input.opinion.trim(),
    }, endpoint, '提交开发样品 QC 评审失败');
    const item = parseDevelopmentSampleQcReview(data?.item);
    if (dashboardReadIdentity() !== identity || !hasPermission('qc:inspect') || data?.ok !== true || !item || item.id !== reviewId
      || !['reviewed', 'acknowledged'].includes(item.status) || item.result !== input.result || item.opinion !== input.opinion.trim()
      || item.reviewedBy !== actorId || item.completionRequestKey !== input.requestKey) {
      throw new Error('评审结果回执不完整或与提交内容不一致，请刷新记录后核对。');
    }
    if (input.measurements !== undefined && JSON.stringify(normalizeDevelopmentQcMeasurements(item.measurements)) !== JSON.stringify(normalizeDevelopmentQcMeasurements(input.measurements))) throw new Error('逐件实测回执与原报告内容不一致，请保留原请求核对。');
    if (input.evidenceFileIds !== undefined) {
      const files = item.evidence;
      if (!Array.isArray(files) || files.length !== input.evidenceFileIds.length || files.some(file => !file || typeof file !== 'object'
        || !input.evidenceFileIds!.includes((file as { id: string }).id) || (file as { sourceKind?: string }).sourceKind !== 'development_review'
        || (file as { sourceId?: string }).sourceId !== reviewId || (file as { sourceFingerprint?: string }).sourceFingerprint !== item.sourceFingerprint))
        throw new Error('报告附件回执与本次提交不一致，请保留原请求核对。');
    }
    return item;
  },

  async listAssignmentUsers(options: { signal?: AbortSignal } = {}, endpoint?: string): Promise<QcAssignmentUserOption[]> {
    if (!hasPermission('qc:write')) throw new Error('当前账号没有选择执行人员的权限。');
    const identity = dashboardReadIdentity(), controller = new AbortController();
    let invalid = false;
    const check = () => {
      if (dashboardReadIdentity() !== identity) { invalid = true; controller.abort(); }
      if (invalid || controller.signal.aborted) throw new Error('账号、权限或服务地址已变化，请重新读取执行人员。');
    };
    const watch = () => { if (dashboardReadIdentity() !== identity) { invalid = true; controller.abort(); } };
    const stop = subscribe(watch), abort = () => controller.abort();
    window.addEventListener('storage', watch); window.addEventListener('focus', watch);
    options.signal?.addEventListener('abort', abort); if (options.signal?.aborted) abort();
    try {
      check();
      const response = await fetch(qcUrl('/assignment-users', endpoint), { method: 'GET', headers: apiService.getAuthHeaders(), signal: controller.signal });
      check(); if (!response.ok) await parseError(response, '执行人员名单读取失败');
      const result = await response.json(); check();
      if (result?.ok !== true || !Array.isArray(result.users) || result.users.some((user: any) =>
        !user || typeof user.id !== 'string' || !user.id.trim() || typeof user.displayName !== 'string' || !user.displayName.trim()
        || !(user.departmentName === null || typeof user.departmentName === 'string')
        || Object.keys(user).some(key => !['id', 'displayName', 'departmentName'].includes(key)))
        || new Set(result.users.map((user: any) => user.id)).size !== result.users.length) {
        throw new Error('执行人员名单返回不完整，请重新读取。');
      }
      return result.users;
    } finally {
      stop(); window.removeEventListener('storage', watch); window.removeEventListener('focus', watch);
      options.signal?.removeEventListener('abort', abort);
    }
  },
  async getInspectionScopes(orderId: string, endpoint?: string): Promise<QcPhysicalCoverage[]> {
    const result = await getJson<{ ok: boolean; scopes: QcPhysicalCoverage[] }>(
      `/orders/${encodeURIComponent(orderId)}/inspection-scopes`, endpoint, '验货范围加载失败');
    if (!result.ok || !Array.isArray(result.scopes) || result.scopes.some(scope =>
      !scope.scopeKey || !/^[a-f0-9]{64}$/.test(scope.scopeFingerprint))) throw new Error('验货范围返回不完整，请刷新后重试');
    return result.scopes;
  },
  async decideReport(report: QcInspectionReport, decision: 'approved' | 'rejected', reason: string, requestKey: string, endpoint?: string) {
    const data = await postJson<{ ok: boolean; item: QcInspectionReport; replayed: boolean }>(
      `/reports/${encodeURIComponent(report.id)}/business-decision`, { decision, reason, requestKey,
        expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
        expectedContentFingerprint: report.contentFingerprint }, endpoint, '业务决定结果暂不可确认，请核对原报告');
    if (!data.ok || data.item?.id !== report.id) throw new Error('业务决定返回不完整，请保留原请求并核对报告');
    return data;
  },
  async getAssignmentInspectionContext(assignmentId: string, endpoint?: string): Promise<AssignmentInspectionContext> {
    const data = await getJson<AssignmentInspectionContext>(
      `/assignments/${encodeURIComponent(assignmentId)}/inspection-context`, endpoint, '验货资料加载失败');
    const task = data?.assignment, order = data?.order;
    const text = (value: unknown) => typeof value === 'string' && !!value.trim();
    const nullableText = (value: unknown) => value === null || typeof value === 'string';
    const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (data?.ok !== true || task?.id !== assignmentId || !text(task.orderId) || !(task.qcUserId === null || text(task.qcUserId))
      || !['Assigned', 'InProgress', 'Completed', 'Cancelled'].includes(task.status)
      || !['midline', 'final'].includes(task.inspectionType) || !timestamp(task.updatedAt) || !timestamp(task.assignedAt)
      || !nullableText(task.dueDate) || !nullableText(task.notes)
      || !(task.completedAt === null || timestamp(task.completedAt))
      || !(task.reportId === null || text(task.reportId)) || !(task.locationId === null || text(task.locationId))
      || !(task.location === null || (task.location && task.locationId !== null && text(task.location.id) && task.location.id === task.locationId
        && text(task.location.code) && text(task.location.name)))
      || order?.id !== task.orderId || !nullableText(order.poNumber) || typeof order.type !== 'string'
      || typeof order.product !== 'string' || typeof order.customer !== 'string' || !Array.isArray(data.lines)
      || data.lines.some(line => !line || typeof line.id !== 'string' || !line.id.trim())
      || new Set(data.lines.map(line => line.id)).size !== data.lines.length) {
      throw new Error('验货资料返回不完整，请刷新后重试');
    }
    const sizes = data.productionSizeCoverage, issues = data.productionQcIssues;
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
    if (sizes && (![sizes.applicable, sizes.available, sizes.satisfied, sizes.scopeComplete].every(value => typeof value === 'boolean')
      || !strings(sizes.actualSizes) || !strings(sizes.missingSizes) || !strings(sizes.failedSizes) || !Array.isArray(sizes.checks)
      || !nullableText(sizes.reason) || sizes.checks.some(row => !text(row.size) || !text(row.reportId) || !Number.isSafeInteger(row.inspectedUnits)
        || row.inspectedUnits < 1 || !['pass', 'fail'].includes(row.result) || !strings(row.evidence) || !row.evidence.length))) {
      throw new Error('生产尺码检验资料返回不完整，请刷新后重试');
    }
    if (issues && (typeof issues.available !== 'boolean' || !Array.isArray(issues.issues)
      || issues.issues.some(issue => !text(issue.issueId) || !text(issue.failedReportId)
        || issue.productionBatchRevision !== task.productionBatchRevision || !['open', 'waiting_business_resume', 'resumed', 'unknown'].includes(issue.status)
        || issue.failedSizes != null && !strings(issue.failedSizes))
      || new Set(issues.issues.map(issue => issue.issueId)).size !== issues.issues.length)) {
      throw new Error('生产 QC 问题资料返回不完整，请刷新后重试');
    }
    return data;
  },
  // ── DR-029 双链样品 QC 评审（服装链 / 面料链 强制边界） ──

  /** 服装链评审（qc:garment_chain:write；每轮新样必须重新评审后才可寄客户） */
  async reviewGarmentSample(orderId: string, input: GarmentSampleReviewInput, endpoint?: string): Promise<{ report: QcInspectionReport; gate: GarmentSampleGate }> {
    return postJson(`/chain/garment/${encodeURIComponent(orderId)}/review`, input, endpoint, 'reviewGarmentSample failed');
  },

  /** QC-29-A4：直接打回工厂重做（该批不得寄客户，系统通知业务员） */
  async directRejectGarmentSample(orderId: string, input: GarmentSampleReviewInput, endpoint?: string): Promise<{ report: QcInspectionReport; gate: GarmentSampleGate }> {
    return postJson(`/chain/garment/${encodeURIComponent(orderId)}/direct-reject`, input, endpoint, 'directRejectGarmentSample failed');
  },

  /** 面料链评审（qc:fabric_chain:write；QC 向工厂提技术调整要求） */
  async reviewFabricSample(orderId: string, input: FabricSampleReviewInput, endpoint?: string): Promise<{ report: QcInspectionReport }> {
    return postJson(`/chain/fabric/${encodeURIComponent(orderId)}/review`, input, endpoint, 'reviewFabricSample failed');
  },

  /** DR-008 内部门禁查询（样品域提交客户前消费；fail-closed） */
  async getGarmentSampleGate(orderId: string, params: { sampleLevel?: GarmentQcSampleLevel; round: number }, endpoint?: string): Promise<GarmentSampleGate> {
    const query = new URLSearchParams();
    if (params.sampleLevel) query.set('sampleLevel', params.sampleLevel);
    query.set('round', String(params.round));
    const data = await getJson<{ gate: GarmentSampleGate }>(
      `/chain/garment/${encodeURIComponent(orderId)}/gate?${query.toString()}`, endpoint, 'getGarmentSampleGate failed');
    return data.gate;
  },

  /** 链报告列表（样品链与大货 final/midline 天然隔离；chain 缺省返回全部链报告） */
  async listChainReports(orderId: string, chain?: 'garment' | 'fabric', endpoint?: string): Promise<QcInspectionReport[]> {
    const query = chain ? `?chain=${chain}` : '';
    const data = await getJson<{ items: QcInspectionReport[] }>(
      `/chain/${encodeURIComponent(orderId)}/reports${query}`, endpoint, 'listChainReports failed');
    return data.items || [];
  },

  // ── DR-014 出运资格 + 报告读取 ──

  /** DR-014 面料出运三条件并行视图（QC ∥ S/S ∥ RC） */
  async getOrderShipmentEligibility(orderId: string, endpoint?: string): Promise<QcShipmentEligibility> {
    return getJson(`/orders/${encodeURIComponent(orderId)}/shipment-eligibility`, endpoint, 'getOrderShipmentEligibility failed');
  },

  /** 订单全部验货报告（含大货 final/midline 与样品链报告） */
  async listOrderReports(orderId: string, endpoint?: string): Promise<QcInspectionReport[]> {
    const data = await getJson<{ items: QcInspectionReport[]; total: number }>(
      `/orders/${encodeURIComponent(orderId)}/reports`, endpoint, 'listOrderReports failed');
    return data.items || [];
  },

  /** 单条验货报告 */
  async getReport(reportId: string, endpoint?: string): Promise<QcInspectionReportDetail> {
    const data = await getJson<{ item: QcInspectionReportDetail }>(
      `/reports/${encodeURIComponent(reportId)}`, endpoint, 'getReport failed');
    const item = data?.item, parent = item?.order;
    if (!item || Array.isArray(item) || item.id !== reportId || typeof item.orderId !== 'string' || !item.orderId
      || !parent || Array.isArray(parent) || parent.id !== item.orderId
      || !(parent.poNumber === null || typeof parent.poNumber === 'string')
      || typeof parent.customer !== 'string' || typeof parent.product !== 'string') {
      throw new Error('验货报告返回不完整，请重新读取原报告。');
    }
    return item;
  },

  /** 验货报告台账（全局分页列表，附订单快照；质量复盘入口） */
  async listReports(params?: { orderId?: string; inspectionType?: string; result?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: QcInspectionReport[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.inspectionType) query.set('inspectionType', params.inspectionType);
    if (params?.result) query.set('result', params.result);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    return getJson<{ items: QcInspectionReport[]; total: number }>(
      `/reports${qs ? `?${qs}` : ''}`, endpoint, 'listReports failed');
  },

  /** 报告双签（role=qc|business；已签署侧不可重复签署，fail-closed） */
  async signReport(reportId: string, role: ReportSignRole, endpoint?: string): Promise<QcInspectionReport> {
    const data = await postJson<{ item: QcInspectionReport }>(
      `/reports/${encodeURIComponent(reportId)}/sign`, { role }, endpoint, 'signReport failed');
    return data.item;
  },

  // ── B2 运营域单据：验货报告文档（服务端模板真源，单据中心统一归档） ──

  /** 验货报告预览 HTML——GET /reports/:id/preview.html（服务端模板实时装配渲染，与生成 PDF 同源排版） */
  async getReportPreviewHtml(reportId: string, endpoint?: string): Promise<string> {
    const res = await fetch(qcUrl(`/reports/${encodeURIComponent(reportId)}/preview.html`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await parseError(res, 'getReportPreviewHtml failed');
    return res.text();
  },

  /** 验货报告生成文档——POST /reports/:id/generate-document（登记域单据 domain=qc + 服务端渲染
   *  PDF 落盘归档，文档号 IR-YYYY-NNNN），生成后浏览器下载归档文件（经鉴权下载端点） */
  async generateReportDocument(reportId: string, endpoint?: string): Promise<{ documentNumber: string; fileName: string; fileSize: number }> {
    const data = await postJson<{ ok: boolean; document: { documentId: string; documentNumber: string }; file: { filePath: string; fileName: string; fileSize: number } }>(
      `/reports/${encodeURIComponent(reportId)}/generate-document`, {}, endpoint, 'generateReportDocument failed');
    await apiService.downloadTradeDocumentArchive(data.document.documentId, data.file.fileName, endpoint);
    return { documentNumber: data.document.documentNumber, fileName: data.file.fileName, fileSize: data.file.fileSize };
  },

  /** QC 任务台账 Excel 导出——GET /assignments?format=xlsx（当前筛选条件全量导出） */
  async exportAssignmentsXlsx(params?: { qcUserId?: string; status?: string; orderId?: string; locationId?: string; dueBefore?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.qcUserId) query.set('qcUserId', params.qcUserId);
    if (params?.status) query.set('status', params.status);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.locationId) query.set('locationId', params.locationId);
    if (params?.dueBefore) query.set('dueBefore', params.dueBefore);
    const res = await fetch(qcUrl(`/assignments?${query.toString()}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`QC 任务台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `QC任务台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  // ── REQ2-04 第三方测试管理 ──

  /** 登记测试委托 {orderId, testItems[], agency, sentDate?, expectedDate?, notes?} */
  async createTestRequest(input: {
    orderId: string;
    testItems: string[];
    agency: string;
    sentDate?: string;
    expectedDate?: string;
    notes?: string;
  }, endpoint?: string): Promise<{ request: TestRequestRow }> {
    const data = await postJson<{ request: TestRequestRow }>(
      '/test-requests', input, endpoint, 'createTestRequest failed');
    return { request: data.request };
  },

  /** 订单维度全景（附件+整改+summary，3 击数据源） */
  async listTestRequests(orderId: string, endpoint?: string): Promise<{ items: TestRequestRow[]; summary: TestRequestSummary }> {
    const data = await getJson<{ items: TestRequestRow[]; summary: TestRequestSummary }>(
      `/test-requests?orderId=${encodeURIComponent(orderId)}`, endpoint, 'listTestRequests failed');
    return { items: data.items || [], summary: data.summary };
  },

  /** 结论登记（fail 门禁：failItems + correctiveAction 必传或已有 open 整改） */
  async updateTestRequest(id: string, patch: {
    result?: 'pass' | 'fail';
    reportNo?: string;
    reportDate?: string;
    failItems?: string[];
    notes?: string;
    sentDate?: string;
    expectedDate?: string;
    correctiveAction?: { failItem: string; action: string; owner?: string; dueDate?: string };
  }, endpoint?: string): Promise<{ request: TestRequestRow }> {
    const data = await postJson<{ request: TestRequestRow }>(
      `/test-requests/${encodeURIComponent(id)}`, patch, endpoint, 'updateTestRequest failed', 'PATCH');
    return { request: data.request };
  },

  /** 软删委托（仅 pending） */
  async deleteTestRequest(id: string, endpoint?: string): Promise<void> {
    await postJson(`/test-requests/${encodeURIComponent(id)}`, {}, endpoint, 'deleteTestRequest failed', 'DELETE');
  },

  /** 上传报告 PDF（multipart；PDF only ≤10MB） */
  async uploadTestReport(id: string, files: File[], endpoint?: string): Promise<{ files: TestReportFileRow[] }> {
    const url = qcUrl(`/test-requests/${encodeURIComponent(id)}/files`, endpoint);
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await fetch(url, { method: 'POST', body: form, headers: apiService.getAuthHeaders() });
    if (!res.ok) await parseError(res, 'uploadTestReport failed');
    const data = await res.json();
    return { files: data.files || [] };
  },

  /** 报告下载 URL（新窗口打开/预览） */
  testReportDownloadUrl(id: string, fileId: string, endpoint?: string): string {
    return qcUrl(`/test-requests/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, endpoint);
  },

  /** 追加整改记录（仅 fail 单；failItem ∈ failItems） */
  async addCorrectiveAction(id: string, input: {
    failItem: string; action: string; owner?: string; dueDate?: string;
  }, endpoint?: string): Promise<{ correctiveAction: TestCorrectiveActionRow }> {
    const data = await postJson<{ correctiveAction: TestCorrectiveActionRow }>(
      `/test-requests/${encodeURIComponent(id)}/corrective-actions`, input, endpoint, 'addCorrectiveAction failed');
    return { correctiveAction: data.correctiveAction };
  },

  /** 整改闭环（open→closed） */
  async closeCorrectiveAction(caId: string, closeNote?: string, endpoint?: string): Promise<{ correctiveAction: TestCorrectiveActionRow }> {
    const data = await postJson<{ correctiveAction: TestCorrectiveActionRow }>(
      `/test-requests/corrective-actions/${encodeURIComponent(caId)}/close`, { closeNote }, endpoint, 'closeCorrectiveAction failed');
    return { correctiveAction: data.correctiveAction };
  },
};
