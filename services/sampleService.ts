/**
 * Sample API service — 样品域（DR-008/011/012/026/028/039）。
 * Communicates with /api/v1/samples endpoints.
 *
 * 覆盖三条链路（镜像后端 server/src/samples/ 契约，root types.ts 冻结区禁止编辑，
 * 类型全部内聚在本文件）：
 *   1. 面料 S/S 船样 + RC 匹头样（DR-011/012/039）：登记 → 寄送 → 客户确认 → 发货资格判定
 *   2. 投产后早期生产样（DR-028）：不限轮次闭环链（previousSampleId 链入上一轮）
 *   3. 服装多轮样品双门禁（DR-008/029）：内部门禁（QC 通过才允许提交客户）+ 客户确认 → 封存
 */

import { apiService } from './apiService';
import type { DevelopmentVersionDecisions } from './developmentService';

// ══════════════════════════════════════════════════════════════
// 共享：寄送 / 确认 / 倒计时
// ══════════════════════════════════════════════════════════════

/** DR-039 寄送登记（快递商/单号/日期/收件方 + 随附单据） */
export interface SampleShipmentInput {
  requestKey?: string;
  sentDate?: string;          // YYYY-MM-DD，默认今天
  courier: string;            // 必填：快递服务商
  trackingNumber: string;     // 必填：快递单号
  recipientName: string;      // 必填：收件方
  recipientContact?: string;
  shippingFee?: number;       // 邮寄费（DR-057 v2.1：非负，币种随客户合同）
  physicalShipment?: { itemId: string; quantity: number; recipientName: string; relationId?: string };
  documents?: unknown[];      // 随附单据（样品发票/快递运费凭证等）
}

/** 客户确认登记（客户不登录系统，业务员登记结果/日期/渠道/意见/证据） */
export interface SampleConfirmationInput {
  result: 'approved' | 'rejected' | 'needs_revision';
  confirmationDate: string;   // 必填 YYYY-MM-DD
  channel: string;            // 必填：确认渠道（email/phone/wechat/...）
  note?: string;
  evidence?: unknown[];
}

/** DR-011 Exmill 倒计时（后端 computeSampleCountdown 投影） */
export interface SampleCountdown {
  kind: 'SS' | 'RC';
  exmillDate: string | null;
  deadlineDays: number;
  deadlineOverridden: boolean;
  confirmDeadline: string | null;
  daysToDeadline: number | null;   // 负值 = 已逾期
  overdue: boolean;
  sent: boolean;
  confirmed: boolean;
  customerStatus: string;
}

// ══════════════════════════════════════════════════════════════
// 面料 S/S 船样 + RC 匹头样（DR-011/012）
// ══════════════════════════════════════════════════════════════

export const FABRIC_SAMPLE_CUSTOMER_STATUSES = ['pending', 'approved', 'rejected', 'needs_revision'] as const;
export type FabricSampleCustomerStatus = (typeof FABRIC_SAMPLE_CUSTOMER_STATUSES)[number];

export const FABRIC_SAMPLE_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  approved: '已确认',
  rejected: '已拒绝',
  needs_revision: '需修改',
};

/** FabricShipmentSample 行（后端 listOrderSamples 输出：行 + sampleKind + countdown） */
export interface FabricShipmentSampleRow {
  id: string;
  sampleCode: string;                    // FSS-YYYYMMDD-001 / FRC-YYYYMMDD-001
  orderId: string;
  shipmentId: string;
  fabricProfileId: string | null;
  sampleQuantity: number;
  sampleUnit: string;
  batchNo: string | null;
  rollNos: string[];
  cuttingDate: string;
  sentToCustomer: boolean;
  sentDate: string | null;
  courier: string | null;
  trackingNumber: string | null;
  recipientName: string | null;
  recipientContact: string | null;
  shippingFee: number | null;         // DR-057 v2.1：邮寄费留痕
  customerStatus: FabricSampleCustomerStatus;
  customerFeedbackDate: string | null;
  customerFeedbackNote: string | null;
  qcInspectionReportId: string | null;
  notes: string | null;
  attachments?: {
    sampleKind?: 'SS' | 'RC';
    rc?: { enabledReason?: string; deadlineOverrideDays?: number; deadlineOverrideReason?: string };
    lastShipment?: { courier?: string; trackingNumber?: string; recipientName?: string; sentDate?: string; shippingFee?: number | null };
    /**
     * ★ C5（2026-09-18）寄样**历史**（追加式，最旧在前）。
     * 后端 `registerSampleShipment` 已改为追加（原来只留 `lastShipment` 一次 ⇒ 分批寄样会覆盖）。
     * `lastShipment` 保留为"最新一次"（既有消费方零改动）。
     */
    shipments?: Array<{
      sentDate: string;
      courier?: string | null;
      trackingNumber?: string | null;
      recipientName?: string | null;
      recipientContact?: string | null;
      shippingFee?: number | null;
      documents?: unknown[];
      shippedBy?: string | null;
      shippedAt?: number | null;
    }>;
    shipmentDocuments?: unknown[];
    confirmations?: Array<{ result: string; date: string; channel: string; note?: string | null }>;
    [key: string]: unknown;
  } | null;
  sampleKind: 'SS' | 'RC';
  countdown: SampleCountdown;
}

export interface RegisterShipmentSampleInput {
  fabricProfileId?: string;
  shipmentId?: string;
  sampleQuantity: number;   // 必填：取样长度（米）
  sampleUnit?: string;
  batchNo?: string;
  rollNos?: string[];
  cuttingDate: string;      // 必填 YYYY-MM-DD
  notes?: string;
}

export interface EnableHeadSampleInput {
  enabledReason: string;          // 必填：启用原因留痕
  deadlineOverrideDays?: number;  // 客户/合同明确时限覆盖（带 override 时 reason 必填）
  deadlineOverrideReason?: string;
  fabricProfileId?: string;
  sampleQuantity?: number;
  cuttingDate?: string;
  notes?: string;
}

/** DR-012 样品链发货资格判定（出运域消费） */
export interface ShipmentEligibility {
  orderId: string;
  exmillDate: string | null;
  evaluatedAt: string;
  eligibleForNormalShipment: boolean;
  blockingReasons: Array<'SS_NOT_REGISTERED' | 'SS_NOT_SENT' | 'SS_NOT_CONFIRMED' | 'SS_REJECTED' | 'RC_NOT_SENT' | 'RC_NOT_CONFIRMED'>;
  gates: {
    ss: { required: boolean; total: number; satisfied: boolean; anySent: boolean; latestSampleId: string | null; countdown: SampleCountdown | null };
    rc: { enabled: boolean; satisfied: boolean; anySent: boolean; latestSampleId: string | null; countdown: SampleCountdown | null };
  };
}

// ══════════════════════════════════════════════════════════════
// 投产后早期生产样（DR-028）
// ══════════════════════════════════════════════════════════════

export const EARLY_PRODUCTION_CUSTOMER_STATUSES = ['pending', 'approved', 'rejected', 'adjust_and_resend'] as const;
export type EarlyProductionCustomerStatus = (typeof EARLY_PRODUCTION_CUSTOMER_STATUSES)[number];

export const EARLY_PRODUCTION_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  approved: '已通过',
  rejected: '已拒绝',
  adjust_and_resend: '调整重发',
};

export interface EarlyProductionSampleRow {
  id: string;
  sampleCode: string;   // EPS-YYYYMMDD-001
  orderId: string;
  fabricProfileId: string | null;
  millName: string | null;
  sampleQuantity: number;
  sampleUnit: string;
  productionStage: string | null;   // greige_out_of_loom | after_dyeing | after_finishing
  producedMeterage: number | null;
  cuttingDate: string;
  previousSampleId: string | null;  // 调整重发链：指向上一轮
  sentToCustomer: boolean;
  sentDate: string | null;
  courier: string | null;
  trackingNumber: string | null;
  recipientName: string | null;
  customerStatus: EarlyProductionCustomerStatus;
  customerFeedbackDate: string | null;
  customerFeedbackNote: string | null;
  qcInspectionReportId: string | null;
  notes: string | null;
  attachments?: Record<string, unknown> | null;
}

export interface CreateEarlyProductionSampleInput {
  fabricProfileId?: string;
  millName?: string;
  sampleQuantity: number;   // 必填
  sampleUnit?: string;
  productionStage?: string;
  producedMeterage?: number;
  cuttingDate: string;      // 必填 YYYY-MM-DD
  notes?: string;
  previousSampleId?: string;
}

export interface ConfirmEarlyProductionSampleInput {
  result: 'approved' | 'rejected' | 'adjust_and_resend';
  confirmationDate: string;
  channel: string;
  note?: string;
  evidence?: unknown[];
  qcInspectionReportId?: string;
  qcAdjustmentNote?: string;
}

// ══════════════════════════════════════════════════════════════
// 服装多轮样品双门禁（DR-008/029）
// ══════════════════════════════════════════════════════════════

/** 轮次状态机：in_progress → qc_passed → submitted → confirmed → sealed（旧轮次 superseded；客户不通过 rejected） */
export const GARMENT_ROUND_STATUSES = [
  'in_progress',
  'qc_passed',
  'submitted',
  'confirmed',
  'sealed',
  'superseded',
  'rejected',
] as const;
export type GarmentRoundStatus = (typeof GARMENT_ROUND_STATUSES)[number];

export const GARMENT_ROUND_STATUS_LABELS: Record<GarmentRoundStatus, string> = {
  in_progress: '进行中',
  qc_passed: 'QC 已通过',
  submitted: '已提交客户',
  confirmed: '客户已确认',
  sealed: '已封存',
  superseded: '已被新轮取代',
  rejected: '已终止',
};

export interface GarmentSampleRound extends DevelopmentVersionDecisions {
  id: string;
  developmentCaseId: string;
  round: number;
  versionLabel?: string | null;
  sampleVersionId?: string | null;
  trialTask?: { factoryCode?: string | null; physicalSequence?: number | null; sourceVersionId?: string | null; id: string; roundId: string; roundRequirementsSnapshot: string | null; currentRoundRequirements: string | null; roundUpdatedAt: string; factoryRequirements: string | null; targetCompletionDate: string | null; referenceAttachments: string[]; updatedAt: string } | null;
  plannedQuantity?: number | null;
  plannedUnit?: string | null;
  linkedAsset?: { id: string; sku?: string; name?: string } | null;
  microVersions?: Array<DevelopmentVersionDecisions & { id?: string; versionId?: string; versionLabel: string; note: string; createdBy?: string; createdAt?: number; linkedAsset?: { id: string; sku?: string; name?: string } | null }>;
  purpose: string;          // 本轮目的
  version: string;          // 客户侧版本号（V1/V2/...）
  materialConfig: string;   // 材料/工艺配置
  // DR-051 样品归属打样工厂（方案 A）：本轮出品工厂
  supplierRelationId?: string | null;
  supplierName?: string | null;
  // ── 内部门禁（DR-008）──
  qcStatus: 'none' | 'passed' | 'failed';
  qcInspectionReportId: string | null;
  qcReviewedBy: string | null;
  qcReviewedAt: number | null;
  qcNote: string | null;
  // ── 提交客户（DR-039 寄送记录）──
  submittedAt: number | null;
  submittedBy: string | null;
  shipment: {
    sentDate: string;
    courier: string;
    trackingNumber: string;
    recipientName: string;
    recipientContact?: string | null;
    shippingFee?: number | null;   // DR-057 v2.1：邮寄费留痕
    documents?: unknown[];
  } | null;
  /**
   * ★ C5（2026-09-18）寄样**历史**（追加式，最旧在前）。
   *
   * 为什么需要：成衣轮次原来**只留最后一次寄样**（`shipment` 被覆盖）⇒ 同一轮次分两次寄
   * （先寄 2 件试样、后补 5 件）时前一次被抹掉，客户问「上次那批什么时候寄的」查不到。
   * 后端已改为追加（与早产样 `attachments.rounds[]` 同模式，**零 migration**）；
   * `shipment` 保留为"最新一次"（既有消费方零改动）。
   * ⚠️ 后端 `persistRounds` 的 attachments 是**白名单** —— 该字段已同时加进写侧与读侧（有结构守卫钉着）。
   */
  shipmentHistory?: Array<{
    sentDate: string;
    courier?: string | null;
    trackingNumber?: string | null;
    recipientName?: string | null;
    recipientContact?: string | null;
    shippingFee?: number | null;
    documents?: unknown[];
    shippedBy?: string | null;
    shippedAt?: number | null;
  }>;
  // ── 客户确认 ──
  customerStatus: 'pending' | 'approved' | 'rejected' | 'needs_revision';
  confirmation: {
    result: string;
    date: string;
    channel: string;
    note?: string | null;
    evidence?: unknown[];
    registeredBy?: string;
    registeredAt?: number;
  } | null;
  modifications: string[];
  evidence: unknown[];
  notes: string | null;
  status: GarmentRoundStatus;
  sealedAt: number | null;
  sealedBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateGarmentRoundInput {
  purpose: string;          // 必填
  version: string;          // 必填
  materialConfig: string;   // 必填
  round?: number;
  // DR-051 样品归属打样工厂（方案 A）：本轮由哪家打样工厂出品
  supplierRelationId?: string;
  supplierName?: string;
  factories?: Array<{ supplierRelationId: string; supplierName?: string; sourceVersionId?: string }>;
  sourceVersionId?: string;
  notes?: string;
  evidence?: unknown[];
  factoryRequirements?: string;
  targetCompletionDate?: string;
  referenceAttachments?: string[];
  plannedQuantity?: number;
  plannedUnit?: string;
}

export interface SubmitGarmentQcInput {
  result: 'passed' | 'failed';
  qcInspectionReportId?: string;
  qcNote?: string;
}

export interface RegisterGarmentConfirmationInput {
  result: 'approved' | 'rejected' | 'needs_revision';
  confirmationDate: string;   // 必填 YYYY-MM-DD
  channel: string;            // 必填
  note?: string;
  modifications?: string[];
  evidence?: unknown[];
}

// ══════════════════════════════════════════════════════════════
// 内部辅助
// ══════════════════════════════════════════════════════════════

async function parseError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}));
  // server 信封：{ error: { code, message } }（sampleRoute/qcRoute 风格），兼容平铺 { error: 'CODE' }
  const code = typeof err?.error?.code === 'string' ? err.error.code
    : typeof err?.error === 'string' ? err.error
      : undefined;
  const message = err?.error?.message || (typeof err?.error === 'string' ? err.error : null) || `${fallback}: HTTP ${res.status}`;
  const error: any = new Error(code && message !== code && !String(message).includes(code) ? `${code}：${message}` : message);
  error.status = res.status;
  error.code = code;
  throw error;
}

function samplesUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/samples${path}`, base);
}

async function postJson<T>(path: string, body: unknown, endpoint?: string, fallback = 'request failed'): Promise<T> {
  const res = await fetch(samplesUrl(path, endpoint), {
    method: 'POST',
    headers: apiService.getAuthHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await parseError(res, fallback);
  return res.json();
}

async function getJson<T>(path: string, endpoint?: string, fallback = 'request failed'): Promise<T> {
  const res = await fetch(samplesUrl(path, endpoint), {
    headers: apiService.getAuthHeaders(),
  });
  if (!res.ok) await parseError(res, fallback);
  return res.json();
}

/** POST/PATCH/DELETE 通用发送（色差批次判定/软删） */
async function sendJson<T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown, endpoint?: string, fallback = 'request failed'): Promise<T> {
  const res = await fetch(samplesUrl(path, endpoint), {
    method,
    headers: apiService.getAuthHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) await parseError(res, fallback);
  return res.json();
}

// ══════════════════════════════════════════════════════════════
// 4. REQ2-01 打色批次（色差管理体系：缸号级色差证据链）
// ══════════════════════════════════════════════════════════════

export const COLOR_BATCH_DEFECT_CAUSES = ['red_cast', 'blue_cast', 'lighter', 'darker'] as const;
export type ColorBatchDefectCause = (typeof COLOR_BATCH_DEFECT_CAUSES)[number];

export const COLOR_BATCH_DEFECT_LABELS: Record<ColorBatchDefectCause, string> = {
  red_cast: '偏红', blue_cast: '偏蓝', lighter: '色浅', darker: '色深',
};

export const COLOR_BATCH_CUSTOMER_STATUSES = ['pending', 'approved', 'rejected', 'needs_recast'] as const;
export type ColorBatchCustomerStatus = (typeof COLOR_BATCH_CUSTOMER_STATUSES)[number];

export const COLOR_BATCH_STATUS_LABELS: Record<ColorBatchCustomerStatus, string> = {
  pending: '待客户判定', approved: '客户通过', rejected: '客户拒绝', needs_recast: '要求重打',
};

/** 4-5 级制评级语义（色差灰卡口径） */
export const COLOR_RATING_LABELS: Record<number, string> = {
  5: '与标样一致', 4: '轻微差异', 3: '明显差异', 2: '严重偏离', 1: '完全不符',
};

/** SampleColorBatch 行（镜像后端 schema；两态：lab_dip 挂开发案 / bulk 挂订单） */
export interface SampleColorBatchRow {
  id: string;
  batchCode: string;                    // SCB-YYYYMMDD-001
  stage: 'lab_dip' | 'bulk';
  developmentCaseId: string | null;
  roundNo: number | null;
  orderId: string | null;
  colorCardId: string | null;           // REQ2-09：关联色卡
  colorCode: string | null;             // REQ2-09：色号快照（如 "19-4052 TCX"）
  dyeLotNo: string;                     // 缸号
  batchNo: string | null;
  rollNos: string[];
  colorRating: number;                  // 主评级 1-5
  sideDiff: number | null;              // 左右色差 1-5
  endDiff: number | null;               // 前后色差 1-5
  defectCauses: ColorBatchDefectCause[];
  customerStatus: ColorBatchCustomerStatus;
  approvedAsSealed: boolean;            // 封样基准（同 scope 唯一）
  customerFeedbackNote: string | null;
  customerFeedbackDate: string | null;
  supplierRelationId: string | null;
  supplierName: string | null;
  photos: Array<{ name: string; url: string; uploadedAt?: string }> | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateColorBatchInput {
  stage: 'lab_dip' | 'bulk';
  developmentCaseId?: string;           // lab_dip 必填
  orderId?: string;                     // bulk 必填
  colorCardId?: string;                 // REQ2-09：色号关联（可选，服务端落 colorCode 快照）
  dyeLotNo: string;
  batchNo?: string;
  rollNos?: string[];
  colorRating: number;
  sideDiff?: number;
  endDiff?: number;
  defectCauses?: ColorBatchDefectCause[];
  supplierRelationId?: string;
  photos?: Array<{ name: string; url: string }>;
  notes?: string;
}

/** REQ2-09 色卡（Pantone TCX seed + 客户自定义） */
export interface ColorCardRow {
  id: string;
  code: string;
  name: string | null;
  family: string | null;
  r: number;
  g: number;
  b: number;
  source: string;
}

/** 色卡详情 + 相近色（Lab ΔE 升序） */
export interface ColorCardNearestItem extends ColorCardRow {
  deltaE: number;
}

/** 该色号（含相近色）历史打色记录（"这个色以前哪些缸过了"经验参考） */
export interface ColorCardBatchHistoryItem {
  id: string;
  batchCode: string;
  stage: 'lab_dip' | 'bulk';
  colorCode: string | null;
  dyeLotNo: string;
  batchNo: string | null;
  colorRating: number;
  defectCauses: string[];
  customerStatus: string;
  supplierName: string | null;
  developmentCaseId: string | null;
  orderId: string | null;
  createdAt: number;
}

/** 取证聚合（3 分钟 SLA：缸号×批次×批色记录×封样基准一次成型） */
export interface ColorBatchEvidence {
  scope: { developmentCaseId?: string; caseCode?: string; caseName?: string; orderId?: string; poNumber?: string; customerName: string | null };
  sealedBasis: SampleColorBatchRow | null;
  batches: SampleColorBatchRow[];
  summary: {
    total: number; approved: number; rejected: number; needsRecast: number; pending: number;
    defectCauseCount: Partial<Record<ColorBatchDefectCause, number>>;
  };
}

// ══════════════════════════════════════════════════════════════
// service
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// 样品管理域（DR-052）：统一样品对象 Sample
// ══════════════════════════════════════════════════════════════

/** 样品类型：dev 开发样 / seal 确认样(封样) / pp 产前样 / top 大货样 / ship 船样 / head 匹头样 / pioneer 先锋样 */
export type SampleManageType = 'dev' | 'seal' | 'pp' | 'top' | 'ship' | 'head' | 'pioneer';
/** 状态：设计确认 draft/making/sent/confirmed/sealed；生产确认 .../qc/submitted/confirmed/approved；rejected/revising */
export type SampleManageStatus = 'draft' | 'making' | 'sent' | 'confirmed' | 'sealed' | 'qc' | 'submitted' | 'approved' | 'rejected' | 'revising';
export type SampleManageAction = 'start' | 'send' | 'confirm' | 'seal' | 'qc' | 'submit' | 'approve' | 'revise';

export type SampleWorkspaceScope = 'fabric' | 'garment' | 'review';
export interface SampleBusinessContext {
  status: 'resolved' | 'unresolved' | 'conflict';
  businessLine: 'fabric' | 'garment' | null;
  reasons: string[];
}
export interface SampleOriginSnapshot {
  schemaVersion: 1;
  batch: { id: string; code: string; caseId: string; factoryId: string; sampleType: string; sourceRound: number; sampleVersionId?: string | null; versionLabel?: string | null; formIndex?: number };
  content: Record<string, unknown>;
  version: { updatedAt: string; historyRevision: number | null; eventId: string | null };
}
export interface SampleOriginBinding {
  id: string; sampleId: string; sampleBatchId: string; sourceRound: number; sourceSealId: string | null;
  sourceSnapshot: SampleOriginSnapshot; sourceFingerprint: string; sourceUpdatedAt: string;
  sourceHistoryRevision: number | null; sourceEventId: string | null; evidenceAuditId: string;
  boundAt: string; boundBy: string; provenance: string;
}
export interface SampleOriginContext {
  status: 'resolved' | 'unresolved' | 'conflict'; currentUsable: boolean; reasons: string[];
  projectionKey: string | null; originKind: 'canonical' | 'inherited' | 'physical' | 'unknown'; origins: SampleOriginBinding[];
  nativeApprovals?: Array<{ sampleBatchId: string; sourceRound: number; eventId: string | null; auditIds: string[] }>;
  nativeSealApprovals?: Array<{ sealId: string; events: Array<{ sampleBatchId: string; eventId: string; auditId: string }> }>;
}

export interface SampleManageRow {
  id: string;
  code: string;
  type: SampleManageType;
  subType?: string | null;
  businessContext?: SampleBusinessContext | null;
  sourceContext?: SampleOriginContext | null;
  projectionKey?: string | null;
  sourceCaseId?: string | null;
  sourceOrderId?: string | null;
  productAssetId?: string | null;
  supplierRelationId?: string | null;
  supplierName?: string | null;
  customerRelationId?: string | null;
  status: SampleManageStatus;
  round: number;
  sentDate?: string | null;
  courier?: string | null;
  trackingNumber?: string | null;
  shippingFee?: number | null;
  recipientName?: string | null;
  recipientCompany?: string | null;
  recipientAddress?: string | null;
  recipientPhone?: string | null;
  feedback?: string | null;
  feedbackDate?: string | null;
  approvedAt?: number | null;
  approvedBy?: string | null;
  qcStatus?: string | null;
  qcInspectionReportId?: string | null;
  customerStatus?: string | null;
  forkedFromSampleId?: string | null;
  invoiceId?: string | null;
  // D6-Q1 米样长度口径（米/码；null = 非长度口径样品）
  lengthQty?: string | number | null;
  lengthUnit?: string | null;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface SampleInventoryGroup {
  cardType: string; unit: string | null; inventoryState: 'active' | 'shipped' | 'retired' | 'other';
  cardRows: string; quantity: string; availableQty: string; borrowedQty: string;
}
export interface SampleInventorySummary {
  complete: true; snapshotAt: string; sampleIds: string[];
  summaries: Array<{ sampleId: string; groups: SampleInventoryGroup[] }>;
}

export interface CreateSampleInput {
  type: SampleManageType;
  subType?: string;
  sourceCaseId?: string;
  sourceOrderId?: string;
  productAssetId?: string;
  supplierRelationId?: string;
  supplierName?: string;
  customerRelationId?: string;
  status?: SampleManageStatus;
  notes?: string;
  /**
   * DR-054 阶段 G：大货生产样明细（ship/head/pioneer）——
   * sampleQuantity / sampleUnit / batchNo / rollNos / cuttingDate / productionStage / producedMeterage / millName。
   * 后端 sampleManageService.createSample 已接受该字段，此处补齐前端类型，避免被 TS 挡在门外。
   */
  attachments?: Record<string, unknown>;
}

export const sampleService = {
  async getInventorySummary(sampleIds: string[], endpoint?: string): Promise<SampleInventorySummary> {
    if (!Array.isArray(sampleIds) || !sampleIds.length || sampleIds.length > 200
      || sampleIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(sampleIds).size !== sampleIds.length) throw new Error('样品编号须为 1 至 200 个唯一有效编号');
    const data = await getJson<SampleInventorySummary>(`/room/summary?${new URLSearchParams({ sampleIds: sampleIds.join(',') })}`, endpoint, '完整库存汇总暂不可用');
    const invalid = () => { throw new Error('库存汇总响应不完整，请刷新或打开实物明细核对'); };
    if (!data || data.complete !== true || typeof data.snapshotAt !== 'string' || !Number.isFinite(Date.parse(data.snapshotAt))
      || !Array.isArray(data.sampleIds) || data.sampleIds.length !== sampleIds.length || data.sampleIds.some((id, index) => id !== sampleIds[index])
      || !Array.isArray(data.summaries) || data.summaries.length !== sampleIds.length) return invalid();
    const seen = new Set<string>();
    for (const summary of data.summaries) {
      if (!summary || !sampleIds.includes(summary.sampleId) || seen.has(summary.sampleId) || !Array.isArray(summary.groups)) return invalid();
      seen.add(summary.sampleId);
      const groups = new Set<string>();
      for (const group of summary.groups) {
        if (!group || typeof group.cardType !== 'string' || !(group.unit === null || typeof group.unit === 'string')
          || !['active', 'shipped', 'retired', 'other'].includes(group.inventoryState) || group.cardRows === '0'
          || ![group.cardRows, group.quantity, group.availableQty, group.borrowedQty].every(value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return invalid();
        const key = JSON.stringify([group.cardType, group.unit, group.inventoryState]);
        if (groups.has(key)) return invalid(); groups.add(key);
      }
    }
    return data;
  },
  // ── 面料 S/S 船样 + RC 匹头样 ──

  /** S/S 船样登记（DR-011：面料订单必须管理） */
  async registerShipmentSample(orderId: string, input: RegisterShipmentSampleInput, endpoint?: string): Promise<FabricShipmentSampleRow> {
    const data = await postJson<{ sample: FabricShipmentSampleRow }>(
      `/fabric/${encodeURIComponent(orderId)}/shipment-sample`, input, endpoint, 'registerShipmentSample failed');
    return data.sample;
  },

  /** RC 匹头样启用（DR-011：业务员决定并留痕，同订单不可重复启用） */
  async enableHeadSample(orderId: string, input: EnableHeadSampleInput, endpoint?: string): Promise<FabricShipmentSampleRow> {
    const data = await postJson<{ sample: FabricShipmentSampleRow }>(
      `/fabric/${encodeURIComponent(orderId)}/head-sample`, input, endpoint, 'enableHeadSample failed');
    return data.sample;
  },

  /** 样品寄送登记（DR-039；S/S 与 RC 共用通用 /:id/ship） */
  async registerSampleShipment(sampleId: string, input: SampleShipmentInput, endpoint?: string): Promise<FabricShipmentSampleRow> {
    const data = await postJson<{ sample: FabricShipmentSampleRow }>(
      `/${encodeURIComponent(sampleId)}/ship`, input, endpoint, 'registerSampleShipment failed');
    return data.sample;
  },

  /** 客户确认登记（DR-012：标准发货门禁） */
  async registerCustomerConfirmation(sampleId: string, input: SampleConfirmationInput, endpoint?: string): Promise<FabricShipmentSampleRow> {
    const data = await postJson<{ sample: FabricShipmentSampleRow }>(
      `/${encodeURIComponent(sampleId)}/confirm`, input, endpoint, 'registerCustomerConfirmation failed');
    return data.sample;
  },

  /** 订单样品列表（含 Exmill 倒计时/逾期标记） */
  async listOrderSamples(orderId: string, endpoint?: string): Promise<FabricShipmentSampleRow[]> {
    const data = await getJson<{ items: FabricShipmentSampleRow[] }>(
      `/fabric/${encodeURIComponent(orderId)}/samples`, endpoint, 'listOrderSamples failed');
    return data.items || [];
  },

  /** DR-012 样品链发货资格判定 */
  async computeShipmentEligibility(orderId: string, endpoint?: string): Promise<ShipmentEligibility> {
    const data = await getJson<{ eligibility: ShipmentEligibility }>(
      `/fabric/${encodeURIComponent(orderId)}/shipment-eligibility`, endpoint, 'computeShipmentEligibility failed');
    return data.eligibility;
  },

  // ── 投产后早期生产样（DR-028） ──

  /** 登记新一轮（previousSampleId 链入上一轮，adjust_and_resend 闭环） */
  async createEarlyProductionSample(orderId: string, input: CreateEarlyProductionSampleInput, endpoint?: string): Promise<EarlyProductionSampleRow> {
    const data = await postJson<{ sample: EarlyProductionSampleRow }>(
      `/early-production/${encodeURIComponent(orderId)}/rounds`, input, endpoint, 'createEarlyProductionSample failed');
    return data.sample;
  },

  /** 早期生产样寄送登记 */
  async sendEarlyProductionSample(sampleId: string, input: Partial<SampleShipmentInput>, endpoint?: string): Promise<EarlyProductionSampleRow> {
    const data = await postJson<{ sample: EarlyProductionSampleRow }>(
      `/early-production/rounds/${encodeURIComponent(sampleId)}/ship`, input, endpoint, 'sendEarlyProductionSample failed');
    return data.sample;
  },

  /** 客户反馈登记（approved 闭环；其余转 QC 迭代） */
  async confirmEarlyProductionSample(sampleId: string, input: ConfirmEarlyProductionSampleInput, endpoint?: string): Promise<EarlyProductionSampleRow> {
    const data = await postJson<{ sample: EarlyProductionSampleRow }>(
      `/early-production/rounds/${encodeURIComponent(sampleId)}/feedback`, input, endpoint, 'confirmEarlyProductionSample failed');
    return data.sample;
  },

  /** 早期生产样链式列表 */
  async listEarlyProductionRounds(orderId: string, endpoint?: string): Promise<EarlyProductionSampleRow[]> {
    const data = await getJson<{ items: EarlyProductionSampleRow[] }>(
      `/early-production/${encodeURIComponent(orderId)}/rounds`, endpoint, 'listEarlyProductionRounds failed');
    return data.items || [];
  },

  // ── 服装多轮样品双门禁（DR-008） ──

  /** 创建轮次（目的/版本/材料工艺配置必填；不限轮数） */
  async createGarmentRound(caseId: string, input: CreateGarmentRoundInput, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/${encodeURIComponent(caseId)}/rounds`, input, endpoint, 'createGarmentRound failed');
    return data.round;
  },

  async addGarmentMicroVersion(roundId: string, note: string, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/rounds/${encodeURIComponent(roundId)}/micro-versions`, { note }, endpoint, 'addGarmentMicroVersion failed');
    return data.round;
  },

  /** QC 评审结论登记（内部门禁第一步；引用 InspectionReport 只读） */
  async submitGarmentQcConclusion(roundId: string, input: SubmitGarmentQcInput, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/${encodeURIComponent(roundId)}/submit-qc`, input, endpoint, 'submitGarmentQcConclusion failed');
    return data.round;
  },

  /** 提交客户（内部门禁 fail-closed：QC 未通过 → 409 QC_GATE_NOT_PASSED） */
  async submitGarmentToCustomer(roundId: string, input: SampleShipmentInput, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/${encodeURIComponent(roundId)}/submit-customer`, input, endpoint, 'submitGarmentToCustomer failed');
    return data.round;
  },

  /** 登记客户确认（业务员登记，不加主管审批） */
  async registerGarmentCustomerConfirmation(roundId: string, input: RegisterGarmentConfirmationInput, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/${encodeURIComponent(roundId)}/register-customer-confirmation`, input, endpoint, 'registerGarmentCustomerConfirmation failed');
    return data.round;
  },

  /** 封存产前样（不可变生产基准；pp 节点投影 approved） */
  async sealGarmentRound(roundId: string, input?: { retainLocation?: string }, endpoint?: string): Promise<GarmentSampleRound> {
    const data = await postJson<{ round: GarmentSampleRound }>(
      `/garment/${encodeURIComponent(roundId)}/seal`, input ?? {}, endpoint, 'sealGarmentRound failed');
    return data.round;
  },

  /** 轮次列表（含当前封存基准） */
  async listGarmentRounds(caseId: string, endpoint?: string): Promise<{ items: GarmentSampleRound[]; sealedRoundId: string | null }> {
    const data = await getJson<{ items: GarmentSampleRound[]; sealedRoundId: string | null }>(
      `/garment/${encodeURIComponent(caseId)}/rounds`, endpoint, 'listGarmentRounds failed');
    return { items: data.items || [], sealedRoundId: data.sealedRoundId ?? null };
  },

  // ── REQ2-01 打色批次（色差管理体系） ──

  /** 打色批次登记（A5 ≤2min：缸号/评级必填；疵点原因选填） */
  async createColorBatch(input: CreateColorBatchInput, endpoint?: string): Promise<{ batch: SampleColorBatchRow; qualityScoreLinked?: boolean }> {
    const data = await postJson<{ batch: SampleColorBatchRow }>(
      '/color-batches', input, endpoint, 'createColorBatch failed');
    return data.batch as any;
  },

  /** 批次列表（developmentCaseId 与 orderId 二选一） */
  async listColorBatches(params: { developmentCaseId?: string; orderId?: string }, endpoint?: string): Promise<SampleColorBatchRow[]> {
    const qs = params.developmentCaseId
      ? `developmentCaseId=${encodeURIComponent(params.developmentCaseId)}`
      : `orderId=${encodeURIComponent(params.orderId!)}`;
    const data = await getJson<{ items: SampleColorBatchRow[] }>(
      `/color-batches?${qs}`, endpoint, 'listColorBatches failed');
    return data.items || [];
  },

  /** 客户判定（批色即封样 + 疵点自动入供应商质量分） */
  async recordColorBatchFeedback(batchId: string, input: { status: 'approved' | 'rejected' | 'needs_recast'; note?: string; asSealed?: boolean }, endpoint?: string): Promise<{ batch: SampleColorBatchRow; qualityScoreLinked: boolean }> {
    return sendJson(`/color-batches/${encodeURIComponent(batchId)}/customer-feedback`, 'POST', input, endpoint, 'recordColorBatchFeedback failed');
  },

  /** 批次软删 */
  async deleteColorBatch(batchId: string, endpoint?: string): Promise<void> {
    await sendJson(`/color-batches/${encodeURIComponent(batchId)}`, 'DELETE', {}, endpoint, 'deleteColorBatch failed');
  },

  /** 色差取证聚合（缸号×批次×批色记录×封样基准，导出打印数据源） */
  async getColorBatchEvidence(params: { developmentCaseId?: string; orderId?: string }, endpoint?: string): Promise<ColorBatchEvidence> {
    const qs = params.developmentCaseId
      ? `developmentCaseId=${encodeURIComponent(params.developmentCaseId)}`
      : `orderId=${encodeURIComponent(params.orderId!)}`;
    return getJson<ColorBatchEvidence>(`/color-batches/evidence?${qs}`, endpoint, 'getColorBatchEvidence failed');
  },

  // ── REQ2-09 Pantone 色号库（DR-051：选色号即带 RGB 参考与相近历史打色） ──

  /** 色号库搜索（code/name 模糊；limit=200 供面板全量色块映射） */
  async searchColorCards(params: { search?: string; family?: string; limit?: number } = {}, endpoint?: string): Promise<{ items: ColorCardRow[]; total: number }> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.family) qs.set('family', params.family);
    if (params.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    const data = await getJson<{ items: ColorCardRow[]; total: number }>(
      `/colors${q ? '?' + q : ''}`, endpoint, 'searchColorCards failed');
    return { items: data.items || [], total: data.total ?? 0 };
  },

  /** 色卡详情 + nearest 相近色（Lab ΔE 升序 top 8） */
  async getColorCard(code: string, endpoint?: string): Promise<{ color: ColorCardRow; nearest: ColorCardNearestItem[] }> {
    const data = await getJson<{ color: ColorCardRow; nearest: ColorCardNearestItem[] }>(
      `/colors/${encodeURIComponent(code)}`, endpoint, 'getColorCard failed');
    return { color: data.color, nearest: data.nearest || [] };
  },

  /** 该色号历史打色（includeNearby=true 并集 ΔE≤15 相近色的打色） */
  async getColorCardBatches(code: string, includeNearby = true, endpoint?: string): Promise<{ color: ColorCardRow; matchedCodes: string[]; batches: ColorCardBatchHistoryItem[] }> {
    const data = await getJson<{ color: ColorCardRow; matchedCodes: string[]; batches: ColorCardBatchHistoryItem[] }>(
      `/colors/${encodeURIComponent(code)}/color-batches?includeNearby=${includeNearby ? 'true' : 'false'}`,
      endpoint, 'getColorCardBatches failed');
    return { color: data.color, matchedCodes: data.matchedCodes || [], batches: data.batches || [] };
  },

  // ── 样品管理域（DR-052）：统一样品对象 Sample ──

  /** 样品列表（type/status/source/search 过滤） */
  /**
   * ★ C5（2026-09-18）寄样历史（GET /v1/samples/shipment-history/:subject/:id）
   *
   * 为什么需要：三个寄样入口里只有早产样支持分批寄样（其余两个原来只留最后一次）⇒
   * 客户问「上次那批什么时候寄的」查不到。后端已统一成追加式历史（零 migration），
   * 本方法把三者的历史**收敛成同一返回形状**，前端不必各写一套解析。
   *
   * @param subject fabric（面料出运取样）| garment（成衣轮次）| early（早产样）
   * ⓘ **UI 挂载点（接手时按此接）**：
   *   · fabric → 面料取样列表（目前**无专属组件**，取样只在订单上有 `fabricSampleSentDate` 快照字段）
   *   · garment → `DevelopmentManager` 的成衣轮次卡（`shipmentHistory` 已随轮次返回）
   *   · early  → 早产样轮次列表（后端 `rounds[]` 本就支持分批）
   */
  async getSampleShipmentHistory(subject: 'fabric' | 'garment' | 'early', id: string, endpoint?: string): Promise<{
    subject: string;
    subjectId: string;
    history: Array<{
      sentDate: string; courier?: string | null; trackingNumber?: string | null;
      recipientName?: string | null; recipientContact?: string | null;
      shippingFee?: number | null; note?: string | null; shippedBy?: string | null; shippedAt?: number | null;
    }>;
    count: number;
    isMulti: boolean;
    latest: { sentDate: string; courier?: string | null; trackingNumber?: string | null } | null;
    totalShippingFee: number;
  }> {
    if (!id) throw new Error('getSampleShipmentHistory: id required');
    return getJson(
      `/shipment-history/${encodeURIComponent(subject)}/${encodeURIComponent(id)}`,
      endpoint,
      'getSampleShipmentHistory failed',
    );
  },

  async listSamples(params: { scope?: SampleWorkspaceScope; type?: string; status?: string; sourceCaseId?: string; sourceOrderId?: string; search?: string; limit?: number; offset?: number } = {}, endpoint?: string): Promise<{ samples: SampleManageRow[]; total: number }> {
    const qs = new URLSearchParams();
    for (const k of ['scope', 'type', 'status', 'sourceCaseId', 'sourceOrderId', 'search'] as const) {
      if (params[k]) qs.set(k, String(params[k]));
    }
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    const data = await getJson<{ samples: SampleManageRow[]; total: number; scope?: SampleWorkspaceScope; sourceCaseId?: string }>(
      `/?${q}`, endpoint, 'listSamples failed');
    if (params.sourceCaseId) {
      // The echo is emitted only after the backend applies this anchor before
      // classification, count and pagination; old backends cannot masquerade.
      if (data.sourceCaseId == null) throw new Error('当前后台尚未支持按开发案筛选样品，请更新测试环境');
      if (data.sourceCaseId !== params.sourceCaseId || !Array.isArray(data.samples) || !Number.isSafeInteger(data.total)
        || data.total < 0 || !data.samples.every(record => record.sourceCaseId === params.sourceCaseId)) {
        throw new Error('开发案筛选响应不一致，请更新测试环境后重试');
      }
    }
    if (params.scope) {
      // A new front end must not label an old, unclassified mixed response as a lane.
      if (data.scope == null) throw new Error('当前后台尚未支持样品分线，请更新测试环境');
      const matches = (record: SampleManageRow) => {
        const context = record?.businessContext;
        if (!context || !Array.isArray(context.reasons) || !context.reasons.every(reason => typeof reason === 'string')) return false;
        if (params.scope === 'review') return (context.status === 'unresolved' || context.status === 'conflict') && context.businessLine === null;
        return context.status === 'resolved' && context.businessLine === params.scope;
      };
      if (data.scope !== params.scope || !Array.isArray(data.samples) || !Number.isInteger(data.total)
        || data.total < 0 || !data.samples.every(matches)) throw new Error('分线响应不一致，请更新测试环境后重试');
    }
    return { samples: data.samples || [], total: data.total ?? 0 };
  },
  /** 登记样品 */
  async createSample(input: CreateSampleInput, endpoint?: string): Promise<SampleManageRow> {
    const data = await postJson<{ sample: SampleManageRow }>('/', input, endpoint, 'createSample failed');
    return data.sample;
  },
  /** 样品详情 */
  async getSample(id: string, endpoint?: string): Promise<SampleManageRow> {
    const data = await getJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}`, endpoint, 'getSample failed');
    return data.sample;
  },
  /** 更新样品（渐进披露字段） */
  async updateSample(id: string, input: Partial<CreateSampleInput> & Record<string, unknown>, endpoint?: string): Promise<SampleManageRow> {
    const data = await sendJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}`, 'PATCH', input, endpoint, 'updateSample failed');
    return data.sample;
  },
  /** 软删样品 */
  async deleteSample(id: string, endpoint?: string): Promise<void> {
    await sendJson<unknown>(`/${encodeURIComponent(id)}`, 'DELETE', {}, endpoint, 'deleteSample failed');
  },
  /** 推进状态机（设计确认 / 生产确认 双语境） */
  async advanceSampleStage(id: string, action: SampleManageAction, input: Record<string, unknown> = {}, endpoint?: string): Promise<SampleManageRow> {
    const data = await sendJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}/stage`, 'PATCH', { action, ...input }, endpoint, 'advanceSampleStage failed');
    return data.sample;
  },
  /** 复刻（设计确认 → 生产确认） */
  async forkSample(id: string, input: { toType: SampleManageType; sourceOrderId?: string; productAssetId?: string; notes?: string }, endpoint?: string): Promise<SampleManageRow> {
    const data = await postJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}/fork`, input, endpoint, 'forkSample failed');
    return data.sample;
  },

  // ── D6-Q1 米样长度口径（2026-09-16 拍板：米样 Decimal 长度 + append-only 台账） ──
  /** 长度建账（仅未建账样品；单位 M/YD） */
  async setSampleLength(id: string, input: { quantity: number | string; unit: 'M' | 'YD'; note?: string }, endpoint?: string): Promise<SampleManageRow> {
    const data = await postJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}/length`, input, endpoint, 'setSampleLength failed');
    return data.sample;
  },
  /** 裁剪分割（父样减、建子样、双向流水） */
  async cutSampleLength(id: string, input: { quantity: number | string; note?: string }, endpoint?: string): Promise<{ parent: SampleManageRow; child: SampleManageRow }> {
    return postJson<{ parent: SampleManageRow; child: SampleManageRow }>(`/${encodeURIComponent(id)}/length/cut`, input, endpoint, 'cutSampleLength failed');
  },
  /** 长度变动：give(剪给客户)/return(余量退回)/loss(损耗)/borrow_in(借入)/borrow_return(归还) */
  async moveSampleLength(id: string, input: { type: 'give' | 'return' | 'loss' | 'borrow_in' | 'borrow_return'; quantity: number | string; note?: string }, endpoint?: string): Promise<SampleManageRow> {
    const data = await postJson<{ sample: SampleManageRow }>(`/${encodeURIComponent(id)}/length/move`, input, endpoint, 'moveSampleLength failed');
    return data.sample;
  },
  /** 长度台账（append-only 流水） */
  async listSampleLengthMovements(id: string, endpoint?: string): Promise<Array<{ id: string; type: string; quantity: string | number; unit: string; counterpartSampleId?: string | null; balanceAfter?: string | number | null; note?: string | null; operator?: string | null; createdAt: number }>> {
    const data = await getJson<{ movements: Array<{ id: string; type: string; quantity: string | number; unit: string; counterpartSampleId?: string | null; balanceAfter?: string | number | null; note?: string | null; operator?: string | null; createdAt: number }> }>(`/${encodeURIComponent(id)}/length/movements`, endpoint, 'listSampleLengthMovements failed');
    return data.movements;
  },
};
