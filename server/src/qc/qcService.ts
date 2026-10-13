import { businessNowMs } from '../shared/businessClock';
import { assessNativeFabricShipmentSamples } from '../samples/fabricShipmentSampleService';
import { attachReportCoverageContext } from './qcReportReadProjection';
/**
 * 阶段 P0 回补 — QC 驻地与验货任务服务（PRD 6.2 / 4.2 QC 工作台）
 *
 * 职责：
 *   1. QC 驻地（QCLocation）：code 为 @unique 注册真源，软删除；
 *      有未删除任务引用时禁止删除。
 *   2. 验货任务（QCAssignment）：状态机 Assigned → InProgress → Completed，
 *      Assigned | InProgress → Cancelled；同订单同验货类型仅允许一个进行中任务。
 *      factoryRelationId 冗余自 Order.millRelationId（snapshot，随订单当时值落库）。
 *   3. QC 工作台 getWorkbench：按状态分组，completed 仅近 30 天（按 completedAt
 *      降序限 20 条）；每条任务附 Order 快照（批量联查，N+1 防护）。
 *
 * 设计原则（与 seasons/risk 模块一致）：
 *   - 服务工厂模式 createQcService(prisma)
 *   - 软删除（deletedAt BigInt）；已完结任务不可修改
 *   - 任务服务以有限业务错误和当前授权核验保护原子写入
 */

import { assertQcAssignmentUser, attachQcAssignmentUsers } from './qcAssignmentUsers';
import { Prisma, PrismaClient, QCLocation, QCAssignment } from '@prisma/client';
import { logger } from '../lib/logger';
import { clampLimit, clampOffset } from '../lib/paging';
import crypto from 'crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { isFabricChainOrder, isGarmentChainOrder, isDevelopmentSampleType } from './qcChainService';
// D8：验货放行口径唯一真源（合格率≥90% + 不合格率≤3% + 致命疵点=0 + 业务批准），
// 与 production/stageService「qc_shipped」生产门禁同一判定函数，禁止 QC 侧重造宽松口径
import { assessInspectionRelease } from '../production/stageService';
import type { TokenPayload } from '../auth/service';
import { QcAssignmentError, qcAssignmentAccess, qcAssignmentReadWhere } from './qcAssignmentAccess';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { QcReportError, qcReportAccess, qcReportReadWhere, qcReportFailure } from './qcReportAuthority';
import { latestCurrentScopedFinal, latestCurrentWholeFinal } from './qcPhysicalCoverage';
import { readProductionQcSizeCoverage, type ProductionSizeChecks } from './productionQcSizeCoverage';
import { readProductionQcIssueProjection } from './productionQcIssueService';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface QCLocationInput {
  code: string; // 归一化为小写
  name: string;
  region?: string | null;
  focus?: string | null; // 驻地主攻业务线：garment | fabric
  address?: string | null;
  notes?: string | null;
}

export type QCLocationPatch = Partial<Omit<QCLocationInput, 'code'>>;

export interface QCAssignmentInput {
  orderId: string;
  inspectionType: string; // midline | final
  qcUserId: string | null;
  locationId?: string | null;
  dueDate?: string | null; // YYYY-MM-DD
  notes?: string | null;
}

export type QCAssignmentPatch = Partial<Pick<QCAssignmentInput, 'notes' | 'dueDate' | 'locationId' | 'qcUserId'>>;

/**
 * 大货验货报告录入（缺口修复：此前 InspectionReport 只能直插 DB，无 API 写入路径）。
 * completeAssignment 携带 report 数据时自动创建大货报告：
 *   - final → id 锚定 `INR__{orderId}`（出运门禁消费锚点，每单唯一）
 *   - midline → id `INR__{orderId}__mid`（中期报告，与 final/样品链锚点不冲突）
 */
/**
 * 一次查货里某一订单行的**幅宽实测**（使用方 2026-09-29 口径：
 * 「幅宽是我们自己的 QC 出去查货验货时记录的」；索赔基数是**该订单行的货款金额**）。
 *
 * ★ 两个数**都必填**：缺实测谈不上"量过"；缺基准**算不出偏差**（不许拿别处的默认幅宽替它猜）。
 * ★ 允许同一份报告里给多个行（一张订单常有多支面料）。
 */
export interface WidthMeasurementInput {
  orderLineId: string;
  /** QC 实测幅宽（cm） */
  measuredWidthCm: number;
  /** 基准幅宽（合同/PO 上的可用幅宽，cm） */
  basisWidthCm: number;
  note?: string | null;
}

/**
 * 归一 + 校验幅宽实测入参（★ 纯函数，可单测）。
 * 判据（任一不满足即抛，中文消息供路由映射 400）：
 *   · `orderLineId` 非空；同一行**不许重复**（重复 = 两种口径，宁可不猜）
 *   · `measuredWidthCm` / `basisWidthCm` 均为有限数且 **> 0**
 * 返回归一后的数组（数字已转 Number，`note` 已 trim）。
 */
export function normalizeWidthInputs(
  inputs: WidthMeasurementInput[] | undefined,
): Array<{ orderLineId: string; measuredWidthCm: number; basisWidthCm: number; note: string | null }> {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) throw new QcAssignmentError('VALIDATION_FAILED', '幅宽实测必须是数组');
  if (!inputs.length) return [];
  const seen = new Set<string>();
  const out: Array<{ orderLineId: string; measuredWidthCm: number; basisWidthCm: number; note: string | null }> = [];
  for (const [i, w] of inputs.entries()) {
    const lineId = typeof w?.orderLineId === 'string' ? w.orderLineId.trim() : '';
    if (!lineId) throw new QcAssignmentError('VALIDATION_FAILED', `幅宽实测第 ${i + 1} 条缺 orderLineId`);
    if (seen.has(lineId)) throw new QcAssignmentError('VALIDATION_FAILED', `幅宽实测里订单行 ${lineId} 重复（同一行一次查货只留一条）`);
    seen.add(lineId);
    const measured = Number(w?.measuredWidthCm);
    const basis = Number(w?.basisWidthCm);
    if (!Number.isFinite(measured) || measured <= 0) {
      throw new QcAssignmentError('VALIDATION_FAILED', `幅宽实测第 ${i + 1} 条的实测幅宽必须是大于 0 的数字（cm）`);
    }
    if (!Number.isFinite(basis) || basis <= 0) {
      throw new QcAssignmentError('VALIDATION_FAILED', `幅宽实测第 ${i + 1} 条的基准幅宽必须是大于 0 的数字（cm）—— 没有基准就算不出偏差，不许留空`);
    }
    out.push({
      orderLineId: lineId,
      measuredWidthCm: measured,
      basisWidthCm: basis,
      note: typeof w?.note === 'string' && w.note.trim() ? w.note.trim() : null,
    });
  }
  return out;
}

export interface BulkReportInput {
  result: 'pass' | 'fail';
  inspectionDate?: string; // YYYY-MM-DD
  totalUnits?: number;
  passedUnits?: number;
  lotSize?: number;
  sampleSize?: number;
  aqlLevel?: string;
  criticalDefects?: number; // D7：致命疵点（AQL 0 零容忍，D8 放行口径消费）
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  notes?: string;
  attachmentIds?: string[];
  /** ★ 幅宽实测（可选；窄幅索赔的输入事实） */
  widthMeasurements?: WidthMeasurementInput[];
  /** Exact open production-QC issues that this current batch pass reinspection resolves. */
  resolvesProductionQcIssueIds?: string[];
  /** Actual garment production observations; a plan is never a QC result. */
  productionSizeChecks?: ProductionSizeChecks;
}

/** 验货报告台账查询（质量复盘全局入口；分页 + 类型/结论筛选） */
export interface ReportListQuery {
  orderId?: string;
  inspectionType?: string; // final | midline（链报告类型不单列，走全部口径）
  result?: string;         // pass | conditional | fail
  limit?: number;
  offset?: number;
}

export interface AssignmentListQuery {
  qcUserId?: string;
  status?: string;
  orderId?: string;
  locationId?: string;
  dueBefore?: string; // YYYY-MM-DD，dueDate <= dueBefore
  limit?: number;
  offset?: number;
  /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
  exportAll?: boolean;
}

const INSPECTION_TYPES = ['midline', 'final'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 工作台已完成任务回看窗口：近 30 天 */
const WORKBENCH_COMPLETED_WINDOW_DAYS = 30;
const WORKBENCH_COMPLETED_LIMIT = 20;

// ────────────────────────────────────────────────────────────────
// DR-014 出运资格视图类型（面料链三条件并行）
// ────────────────────────────────────────────────────────────────

export type ShipmentGateCode = 'BULK_QC_NOT_PASSED' | 'SS_NOT_CONFIRMED' | 'RC_NOT_CONFIRMED' | 'NATIVE_SAMPLE_SCOPE_UNRESOLVED';

export interface ShipmentGateState {
  satisfied: boolean;
  [key: string]: unknown;
}

/** Current Final evidence selected for one explicit physical batch. A missing
 * or stale report remains null; an older/whole report is not invented here. */
export interface ShipmentBatchFinalOutcome {
  productionBatchId: string;
  reportId: string | null;
  revision: number | null;
  scopeFingerprint: string | null;
  satisfied: boolean;
  failureReasons: string[];
}

export interface ShipmentEligibility {
  orderId: string;
  /** DR-014 三条件仅适用于面料订单；服装订单出运门禁=大货 Final QC（REL-14-A4，由 checkGarmentShipmentEligibility 承担） */
  applicable: boolean;
  eligible: boolean;
  /** 三条件并行状态（完成顺序无关；缺任一条即 eligible=false） */
  conditions: {
    bulkQc: ShipmentGateState;
    ss: ShipmentGateState;
    rc: ShipmentGateState & { enabled: boolean };
  };
  missingGates: ShipmentGateCode[];
  physicalBatches?: ShipmentBatchFinalOutcome[];
  /** Actual native source identity/coverage faults cannot be waived by an Order exception. */
  nativeSampleProofBlocked?: boolean;
  nativeSampleFailureReasons?: string[];
  /** applicable=false 时的原因说明（链边界） */
  reason?: string;
}

/**
 * REL-14-A4 服装链出运资格视图：仅大货终期 Final QC 单条件（与样品 QC 严格独立）。
 * 与面料链 ShipmentEligibility 分离定义——服装链无 S/S、RC 概念，复用同一结构会产生误导性空槽。
 */
export interface GarmentShipmentEligibility {
  orderId: string;
  /** 仅服装链订单适用（isGarmentChainOrder）；非服装订单 applicable=false */
  applicable: boolean;
  eligible: boolean;
  /** 大货终期 Final QC 状态（InspectionReport id=INR__{orderId}, inspectionType='final'；D8 起按生产门禁统一口径判定） */
  bulkQc: ShipmentGateState;
  missingGates: ShipmentGateCode[];
  physicalBatches?: ShipmentBatchFinalOutcome[];
  /** applicable=false 时的原因说明（链边界） */
  reason?: string;
}

export type ReportSignRole = 'qc' | 'business';

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createQcService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  // ══════════════════════════════════════════════════════════════
  // 1. QC 驻地 QCLocation
  // ══════════════════════════════════════════════════════════════

  async function getLocationOrThrow(id: string): Promise<QCLocation> {
    const loc = await db.qCLocation.findUnique({ where: { id } });
    if (!loc || loc.deletedAt !== null) throw new QcReportError('NOT_FOUND', '驻地不存在');
    return loc;
  }

  async function createLocation(input: QCLocationInput, actorId: string): Promise<QCLocation> {
    if (!input.code?.trim()) throw new QcReportError('VALIDATION_FAILED', '驻地代码必填');
    const code = input.code.trim().toLowerCase();
    if (!input.name?.trim()) throw new QcReportError('VALIDATION_FAILED', '驻地名称必填');

    const dup = await db.qCLocation.findUnique({ where: { code } });
    if (dup) throw new QcReportError('VALIDATION_FAILED', '驻地代码已存在');

    const ts = now();
    const loc = await db.qCLocation.create({
      data: {
        id: generateId('QCL'),
        code,
        name: input.name.trim(),
        region: input.region ?? null,
        focus: input.focus ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[QcService] location created', { id: loc.id, code, actorId });
    return loc;
  }

  async function listLocations() {
    return db.qCLocation.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  const LOCATION_PATCH_FIELDS = ['name', 'region', 'focus', 'address', 'notes'] as const;

  async function updateLocation(id: string, patch: QCLocationPatch, actorId: string): Promise<QCLocation> {
    const loc = await getLocationOrThrow(id);
    // code 是注册真源，禁止修改
    if ((patch as any).code !== undefined) throw new QcReportError('VALIDATION_FAILED', '驻地代码不可修改');
    if (patch.name !== undefined && !patch.name?.trim()) throw new QcReportError('VALIDATION_FAILED', '驻地名称必填');

    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of LOCATION_PATCH_FIELDS) {
      if ((patch as any)[f] !== undefined) {
        data[f] = f === 'name' ? patch.name!.trim() : (patch as any)[f];
      }
    }
    const updated = await db.qCLocation.update({ where: { id: loc.id }, data });
    logger.info('[QcService] location updated', { id: loc.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteLocation(id: string, actorId: string): Promise<void> {
    const loc = await getLocationOrThrow(id);
    const refs = await db.qCAssignment.count({ where: { deletedAt: null, locationId: loc.id } });
    if (refs > 0) throw new QcReportError('VALIDATION_FAILED', '仍有验货任务引用此驻地，不可删除');
    await db.qCLocation.update({
      where: { id: loc.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[QcService] location soft-deleted', { id: loc.id, code: loc.code, actorId });
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 验货任务 QCAssignment
  // ══════════════════════════════════════════════════════════════

  async function getAssignmentOrThrow(tx: any, id: string): Promise<QCAssignment> {
    const assignment = await tx.qCAssignment.findUnique({ where: { id } });
    if (!assignment || assignment.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在');
    return assignment;
  }

  async function assertQcUser(tx: any, qcUserId: string, order: { businessLine?: unknown; type?: unknown }): Promise<void> {
    await assertQcAssignmentUser(tx, qcUserId, qcOrderInspectionScope(order));
  }

  async function assignmentLocation(tx: any, locationId: string | null | undefined) {
    if (!locationId) return;
    const location = await tx.qCLocation.findUnique({ where: { id: locationId } });
    if (!location || location.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', '驻地不存在');
  }

  function assertDueDate(dueDate: string | null | undefined): void {
    if (dueDate != null && !isValidLocalDateKey(dueDate)) throw new QcAssignmentError('VALIDATION_FAILED', 'dueDate 必须是有效的 YYYY-MM-DD 日期');
  }

  function auditSnapshot(value: any) {
    return value == null ? null : JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
  }

  async function assignmentAudit(tx: any, actor: TokenPayload, operation: string,
    before: any, after: any, delegated = false) {
    await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:qc:assignments', operation,
      targetType: 'QCAssignment', targetId: after.id, before: auditSnapshot(before),
      after: { ...auditSnapshot(after), actualActorId: actor.userId, assignedQcUserId: after.qcUserId, delegated },
      operationType: operation === 'create_assignment' ? 'create' : operation === 'delete_assignment' ? 'delete' : 'update' });
  }

  async function createAssignment(input: QCAssignmentInput, trustedActor: TokenPayload): Promise<QCAssignment> {
    if (typeof input.orderId !== 'string' || !input.orderId.trim()) throw new QcAssignmentError('VALIDATION_FAILED', 'orderId 必填');
    if (!(INSPECTION_TYPES as readonly string[]).includes(input.inspectionType)) {
      throw new QcAssignmentError('VALIDATION_FAILED', `非法验货类型：${input.inspectionType}（允许 midline | final）`);
    }
    if (typeof input.qcUserId !== 'string' || !input.qcUserId.trim()) throw new QcAssignmentError('VALIDATION_FAILED', 'qcUserId 必填');
    const qcUserId = input.qcUserId;
    assertDueDate(input.dueDate);
    return db.$transaction(async (tx: any) => {
      const { actor, order } = await qcAssignmentAccess(tx, trustedActor, { orderId: input.orderId, mode: 'manage', lock: true });
      await assertQcUser(tx, qcUserId, order);
      await assignmentLocation(tx, input.locationId);
      const duplicate = await tx.qCAssignment.findFirst({ where: { orderId: input.orderId,
        inspectionType: input.inspectionType, deletedAt: null, status: { not: 'Cancelled' } } });
      if (duplicate) throw new QcAssignmentError('VALIDATION_FAILED', '该订单此验货类型已有进行中任务');
      const ts = BigInt(now());
      const assignment = await tx.qCAssignment.create({ data: { id: generateId('QCA'), orderId: input.orderId,
        inspectionType: input.inspectionType, qcUserId: input.qcUserId, locationId: input.locationId ?? null,
        factoryRelationId: order.millRelationId ?? null, status: 'Assigned', dueDate: input.dueDate ?? null,
        assignedAt: ts, assignedById: actor.userId, completedAt: null, reportId: null, notes: input.notes ?? null,
        createdAt: ts, updatedAt: ts, deletedAt: null } });
      await assertQcUser(tx, qcUserId, order);
      await qcAssignmentAccess(tx, trustedActor, { orderId: input.orderId, mode: 'manage', lock: true });
      await assignmentAudit(tx, actor, 'create_assignment', null, assignment);
      return assignment;
    });
  }

  async function assignmentMutation<T>(id: string, trustedActor: TokenPayload, mode: 'manage' | 'inspect',
    work: (tx: any, context: Awaited<ReturnType<typeof qcAssignmentAccess>>) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx: any) => {
      const candidate = await getAssignmentOrThrow(tx, id);
      const context = await qcAssignmentAccess(tx, trustedActor,
        { orderId: candidate.orderId, assignmentId: id, mode, lock: true });
      if (String(context.assignment.updatedAt) !== String(candidate.updatedAt)
        || context.assignment.status !== candidate.status || context.assignment.qcUserId !== candidate.qcUserId) {
        throw new QcAssignmentError('CONFLICT', '任务正在被修改，请刷新后重试。');
      }
      return work(tx, context);
    });
  }

  const ASSIGNMENT_PATCH_FIELDS = ['notes', 'dueDate', 'locationId', 'qcUserId'] as const;
  async function updateAssignment(id: string, patch: QCAssignmentPatch, trustedActor: TokenPayload): Promise<QCAssignment> {
    assertDueDate(patch.dueDate);
    return assignmentMutation(id, trustedActor, 'manage', async (tx, { assignment, actor, order }) => {
      if (patch.qcUserId !== undefined && patch.qcUserId !== assignment.qcUserId && (assignment.status === 'InProgress' || assignment.reportId != null))
        throw new QcAssignmentError('CONFLICT', '已经开始检验的任务须由当前 QC 正式转交，不能直接改写执行人。');
      if (assignment.status === 'Completed' || assignment.status === 'Cancelled') throw new QcAssignmentError('VALIDATION_FAILED', '已完结任务不可修改');
      if (patch.qcUserId != null) await assertQcUser(tx, patch.qcUserId, order);
      await assignmentLocation(tx, patch.locationId);
      const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
      for (const field of ASSIGNMENT_PATCH_FIELDS) if (patch[field] !== undefined) data[field] = patch[field];
      const updated = await tx.qCAssignment.update({ where: { id }, data });
      if (patch.qcUserId != null) await assertQcUser(tx, patch.qcUserId, order);
      await qcAssignmentAccess(tx, trustedActor, { orderId: assignment.orderId, assignmentId: id, mode: 'manage', lock: true });
      await assignmentAudit(tx, actor, 'update_assignment', assignment, updated);
      return updated;
    });
  }

  async function startAssignment(id: string, trustedActor: TokenPayload): Promise<QCAssignment> {
    return assignmentMutation(id, trustedActor, 'inspect', async (tx, { assignment, actor, delegated }) => {
      if (assignment.status !== 'Assigned') throw new QcAssignmentError('VALIDATION_FAILED', `非法状态流转：当前状态 ${assignment.status} 不可开始`);
      const updated = await tx.qCAssignment.update({ where: { id }, data: { status: 'InProgress', updatedAt: BigInt(now()) } });
      await assignmentAudit(tx, actor, 'start_assignment', assignment, updated, delegated);
      return updated;
    });
  }

  function validateReport(report: BulkReportInput) {
    if (report.result !== 'pass' && report.result !== 'fail') throw new QcAssignmentError('VALIDATION_FAILED', 'report.result 必须是 pass 或 fail');
    if (report.inspectionDate !== undefined && !isValidLocalDateKey(report.inspectionDate)) throw new QcAssignmentError('VALIDATION_FAILED', 'inspectionDate 必须是有效的 YYYY-MM-DD 日期');
    const fields = ['totalUnits', 'passedUnits', 'lotSize', 'sampleSize', 'criticalDefects', 'majorDefects', 'minorDefects'] as const;
    for (const field of fields) {
      const value = report[field];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new QcAssignmentError('VALIDATION_FAILED', `${field} 必须是非负整数`);
    }
    if ((report.passedUnits ?? 0) > (report.totalUnits ?? 0)) throw new QcAssignmentError('VALIDATION_FAILED', 'passedUnits 不可大于 totalUnits');
    if (report.sampleSize != null && report.lotSize != null && report.sampleSize > report.lotSize) throw new QcAssignmentError('VALIDATION_FAILED', 'sampleSize 不可大于 lotSize');
  }

  async function completeAssignment(id: string, input: { reportId?: string | null; report?: BulkReportInput },
    trustedActor: TokenPayload): Promise<QCAssignment> {
    if (input.report && input.reportId) throw new QcAssignmentError('VALIDATION_FAILED', 'report 与 reportId 不可同时填写');
    if (input.report) validateReport(input.report);
    const widthRows = input.report ? normalizeWidthInputs(input.report.widthMeasurements) : [];
    return assignmentMutation(id, trustedActor, 'inspect', async (tx, { assignment, actor, delegated }) => {
      if (!hasActualQcScope(actor, 'qc:inspect')) throw new QcAssignmentError('FORBIDDEN', '当前账号没有专业 QC 检验权限。');
      if (input.report?.productionSizeChecks != null || input.report?.resolvesProductionQcIssueIds?.length) throw new QcAssignmentError('VALIDATION_FAILED', '逐尺码生产检验与问题复验须使用准确工厂分支的原生检验任务。');
      if (assignment.status !== 'Assigned' && assignment.status !== 'InProgress') throw new QcAssignmentError('VALIDATION_FAILED', `非法状态流转：当前状态 ${assignment.status} 不可完成`);
      let reportId = input.reportId ?? null;
      if (reportId) {
        const report = await tx.inspectionReport.findUnique({ where: { id: reportId } });
        if (!report) throw new QcAssignmentError('NOT_FOUND', '验货报告不存在');
        if (report.orderId !== assignment.orderId) throw new QcAssignmentError('VALIDATION_FAILED', '报告与任务订单不匹配');
        if (report.inspectionType !== assignment.inspectionType) throw new QcAssignmentError('VALIDATION_FAILED', '报告检验类型与任务不匹配，请关联本任务对应的中期或终期报告。');
      }
      const ts = BigInt(now());
      if (input.report) {
        const r = input.report;
        if (!(INSPECTION_TYPES as readonly string[]).includes(assignment.inspectionType)) throw new QcAssignmentError('VALIDATION_FAILED', '任务验货类型必须是 midline 或 final');
        reportId = assignment.inspectionType === 'final' ? `INR__${assignment.orderId}` : `INR__${assignment.orderId}__mid`;
        if (await tx.inspectionReport.findUnique({ where: { id: reportId } })) throw new QcAssignmentError('VALIDATION_FAILED', `大货验货报告已存在（${reportId}），如需修正请先处理既有报告`);
        if (widthRows.length) {
          const ids = widthRows.map(row => row.orderLineId);
          const lines = await tx.orderLine.findMany({ where: { id: { in: ids }, orderId: assignment.orderId }, select: { id: true } });
          const owned = new Set(lines.map((line: any) => line.id));
          const foreign = ids.filter(lineId => !owned.has(lineId));
          if (foreign.length) throw new QcAssignmentError('VALIDATION_FAILED', `幅宽实测里的订单行不属于本订单（${foreign.join('、')}）`);
        }
        await tx.inspectionReport.create({ data: { id: reportId, orderId: assignment.orderId,
          inspectionType: assignment.inspectionType, result: r.result, inspectionDate: r.inspectionDate ?? todayLocalKey(),
          inspectedBy: actor.userId, totalUnits: r.totalUnits ?? 0, passedUnits: r.passedUnits ?? 0,
          lotSize: r.lotSize ?? null, sampleSize: r.sampleSize ?? null, aqlLevel: r.aqlLevel ?? null,
          criticalDefects: r.criticalDefects ?? 0, majorDefects: r.majorDefects ?? 0, minorDefects: r.minorDefects ?? 0,
          defectSummary: r.defectSummary ?? null, notes: r.notes ?? null, createdAt: ts, updatedAt: ts } });
        if (widthRows.length) await tx.inspectionWidthMeasurement.createMany({ data: widthRows.map(row => ({
          id: `IWM__${crypto.randomBytes(8).toString('hex')}`, reportId, orderId: assignment.orderId,
          ...row, createdAt: ts, updatedAt: ts })) });
      }
      const updated = await tx.qCAssignment.update({ where: { id }, data: { status: 'Completed', completedAt: ts, reportId, updatedAt: ts } });
      await assignmentAudit(tx, actor, 'complete_assignment', assignment, updated, delegated);
      return updated;
    });
  }

  async function cancelAssignment(id: string, trustedActor: TokenPayload): Promise<QCAssignment> {
    return assignmentMutation(id, trustedActor, 'manage', async (tx, { assignment, actor }) => {
      if (assignment.status === 'Completed') throw new QcAssignmentError('VALIDATION_FAILED', '已完成任务不可取消');
      if (assignment.status === 'Cancelled') throw new QcAssignmentError('VALIDATION_FAILED', '非法状态流转：任务已取消');
      const updated = await tx.qCAssignment.update({ where: { id }, data: { status: 'Cancelled', updatedAt: BigInt(now()) } });
      await assignmentAudit(tx, actor, 'cancel_assignment', assignment, updated);
      return updated;
    });
  }

  async function deleteAssignment(id: string, trustedActor: TokenPayload): Promise<void> {
    await assignmentMutation(id, trustedActor, 'manage', async (tx, { assignment, actor }) => {
      const ts = BigInt(now());
      const updated = await tx.qCAssignment.update({ where: { id }, data: { deletedAt: ts, updatedAt: ts } });
      await assignmentAudit(tx, actor, 'delete_assignment', assignment, updated);
    });
  }

  async function attachOrderSnapshots(rows: any[], tx: any = db, includeLegacyType = false): Promise<any[]> {
    if (!rows.length) return [];
    const orders = await tx.order.findMany({ where: { id: { in: [...new Set(rows.map(row => row.orderId))] }, deletedAt: null },
      select: { id: true, poNumber: true, customer: true, product: true, dueDate: true, clientDate: true, businessLine: true,
        ...(includeLegacyType ? { type: true } : {}) } });
    const parents = new Map<string, any>(orders.map((order: any) => [order.id, order]));
    return rows.map(row => ({ ...row, order: parents.has(row.orderId) ? (({ id, ...snapshot }) => snapshot)(parents.get(row.orderId)) : null }));
  }

  async function listAssignments(query: AssignmentListQuery, trustedActor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const access = await qcAssignmentReadWhere(tx, trustedActor);
      const where: any = { AND: [access.where] };
      for (const field of ['qcUserId', 'status', 'orderId', 'locationId'] as const) if (query[field]) where[field] = query[field];
      if (query.dueBefore) where.dueDate = { lte: query.dueBefore };
      const take = query.exportAll ? undefined : clampLimit(query.limit, 50, 200);
      const [rows, total] = await Promise.all([tx.qCAssignment.findMany({ where, include: { location: true }, orderBy: { assignedAt: 'desc' },
        ...(take != null ? { take, skip: clampOffset(query.offset) } : {}) }), tx.qCAssignment.count({ where })]);
      return { items: await attachQcAssignmentUsers(tx, await attachOrderSnapshots(rows, tx)), total };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async function getWorkbench(query: { qcUserId?: string }, trustedActor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const access = await qcAssignmentReadWhere(tx, trustedActor);
      const where: any = { AND: [access.where] };
      if (query.qcUserId) where.qcUserId = query.qcUserId;
      const rows = await tx.qCAssignment.findMany({ where, include: { location: true }, orderBy: { assignedAt: 'desc' }, take: 1000 });
      const items = await attachQcAssignmentUsers(tx, await attachOrderSnapshots(rows, tx, true)), since = businessNowMs() - WORKBENCH_COMPLETED_WINDOW_DAYS * DAY_MS;
      return { assigned: items.filter(row => row.status === 'Assigned'), inProgress: items.filter(row => row.status === 'InProgress'),
        completed: items.filter(row => row.status === 'Completed' && row.completedAt != null && Number(row.completedAt) >= since)
          .sort((a, b) => Number(b.completedAt) - Number(a.completedAt)).slice(0, WORKBENCH_COMPLETED_LIMIT) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async function getInspectionContext(id: string, trustedActor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const candidate = await getAssignmentOrThrow(tx, id);
      const { assignment, order, actor } = await qcAssignmentAccess(tx, trustedActor,
        { orderId: candidate.orderId, assignmentId: id, mode: 'read' });
      const coverage = assignment.scopeFingerprint ? { scopeType: assignment.scopeType, scopeKey: assignment.scopeKey,
        productionBatchId: assignment.productionBatchId, productionBatchRevision: assignment.productionBatchRevision,
        scopeFingerprint: assignment.scopeFingerprint, scopeSnapshot: assignment.scopeSnapshot } : {};
      const coveredIds = assignment.scopeFingerprint && assignment.scopeType === 'production_batch'
        ? (assignment.scopeSnapshot as any)?.lines?.map((line: any) => line.orderLineId) ?? [] : undefined;
      const lines = await tx.orderLine.findMany({ where: { orderId: order.id,
        ...(coveredIds ? { id: { in: coveredIds } } : {}) }, orderBy: { lineNumber: 'asc' },
        select: { id: true, lineNumber: true, itemNo: true, materialCode: true, description: true, quantity: true, unit: true, width: true } });
      const location = assignment.locationId ? await tx.qCLocation.findFirst({
        where: { id: assignment.locationId, deletedAt: null }, select: { id: true, code: true, name: true },
      }) : null;
      const factory = assignment.factoryRelationId ? await tx.relation.findFirst({ where: { id: assignment.factoryRelationId, deletedAt: null },
        select: { id: true, code: true, name: true, contactInfo: true, factoryAddresses: true } }) : null;
      const handoffHistory = await tx.auditLog.findMany({ where: { targetType: 'QCAssignment', targetId: assignment.id, action: 'qc_assignment_handoff' }, orderBy: { createdAt: 'asc' } });
      const chain = qcOrderInspectionScope(order);
      const professional = !!chain && hasActualQcScope(actor, 'qc:inspect') && hasActualQcScope(actor, chain);
      const production = assignment.scopeType === 'production_batch' && assignment.productionBatchId
        ? { productionSizeCoverage: await readProductionQcSizeCoverage(tx, { orderId: order.id, productionBatchId: assignment.productionBatchId,
            expectedBatchRevision: assignment.productionBatchRevision ?? undefined }),
          productionQcIssues: await readProductionQcIssueProjection(tx, { orderId: order.id,
            orderLineId: (assignment.scopeSnapshot as any)?.lines?.[0]?.orderLineId,
            productionBatchId: assignment.productionBatchId, productionBatchRevision: assignment.productionBatchRevision }) } : {};
      return { ok: true, assignment: { id: assignment.id, orderId: assignment.orderId, qcUserId: assignment.qcUserId,
        status: assignment.status, inspectionType: assignment.inspectionType, updatedAt: assignment.updatedAt,
        assignedAt: assignment.assignedAt, dueDate: assignment.dueDate, notes: assignment.notes,
        completedAt: assignment.completedAt, reportId: assignment.reportId, locationId: assignment.locationId,
        location, factory, canClaim: professional && assignment.qcUserId == null && assignment.status === 'Assigned',
        canTransfer: professional && assignment.qcUserId === actor.userId && ['Assigned', 'InProgress'].includes(assignment.status),
        handoffHistory: handoffHistory.map((row: any) => ({ id: row.id, actorId: row.actorId, ...row.detail?.after?.receipt })), ...coverage },
        order: { id: order.id, poNumber: order.poNumber, type: order.type, product: order.product,
          customer: order.customer, businessLine: order.businessLine }, lines, ...production };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  // ══════════════════════════════════════════════════════════════
  // 3. DR-014 面料出运资格判定（大货 QC ∥ S/S 客户确认 ∥ RC 客户确认 三条件并行）
  // ══════════════════════════════════════════════════════════════

  /**
   * DR-014：面料大货 QC 通过、S/S 客户确认完成、已启用 RC 的客户确认完成，
   * 三者是具备申请出运资格的独立并行条件（完成顺序无关，互不前置）。
   * 本函数只做原始门禁状态报告（fail-closed 视图），DR-013 受控例外由出运域另行绑定，
   * 例外不改变此处返回的门禁状态（DR-013「例外不改变原规则」）。
   *
   * 数据来源（链路边界：各自独立记录，禁止合并为单一「已确认」字段）：
   *   - bulkQc：InspectionReport(orderId, inspectionType='final')，D8 起放行判定统一为
   *     生产门禁口径（assessInspectionRelease：结论非 fail + 致命疵点=0 + 合格率≥90%
   *     + 不合格率≤3% + 业务部批准），不满足时 conditions.bulkQc.failureReasons 给出缺口
   *   - ss：FabricShipmentSample(orderId, deletedAt=null) customerStatus='approved'（取最新一条）
   *   - rc：Order.fabricSampleSentDate 非空=已启用；启用则要求 fabricSampleConfirmedDate 非空
   * 服装订单不适用（出运门禁=大货 Final QC 独立检查，REL-14-A4）→ applicable=false。
   */
  async function assessShipmentBatchFinals(orderId: string, batchIds: string[]): Promise<ShipmentBatchFinalOutcome[]> {
    if (!Array.isArray(batchIds) || !batchIds.length || batchIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new QcReportError('VALIDATION_FAILED', '须明确本次出运的实际生产批次，不能以整单验货替代缺失的物理范围。');
    }
    const outcomes: ShipmentBatchFinalOutcome[] = [];
    for (const productionBatchId of [...new Set(batchIds)].sort()) {
      // The caller owns current physical-source locks. The selector also checks
      // current coverage and refuses a stale exact revision before Whole fallback.
      const report = await latestCurrentScopedFinal(db, orderId, productionBatchId);
      const release = assessInspectionRelease(report?.inspectionType === 'final' ? report : null);
      outcomes.push({ productionBatchId, reportId: report?.id ?? null, revision: report?.revision ?? null,
        scopeFingerprint: report?.scopeFingerprint ?? null, satisfied: release.qualified,
        failureReasons: release.failures.map(failure => failure.message) });
    }
    return outcomes;
  }

  async function checkShipmentEligibility(orderId: string, productionBatchIds?: string[]): Promise<ShipmentEligibility> {
    if (!orderId?.trim()) throw new QcReportError('VALIDATION_FAILED', 'orderId 必填');
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt !== null) throw new QcReportError('NOT_FOUND', '订单不存在');

    if (!isFabricChainOrder(order)) {
      return {
        orderId,
        applicable: false,
        eligible: false,
        conditions: {
          bulkQc: { satisfied: false },
          ss: { satisfied: false },
          rc: { enabled: false, satisfied: false },
        },
        missingGates: [],
        reason: 'DR-014 出运三条件仅适用于面料订单；服装订单出运门禁为大货终期 Final QC（与样品 QC 独立，REL-14-A4）',
      };
    }

    const nativeSamples = await assessNativeFabricShipmentSamples(db, order, productionBatchIds);
    const physicalBatches = productionBatchIds === undefined ? undefined : await assessShipmentBatchFinals(orderId, productionBatchIds);
    const finalReport = physicalBatches ? null : await latestCurrentWholeFinal(db, orderId);
    // D8：bulkQc 放行 = 生产门禁统一口径（result 非 fail + 致命疵点=0 + 合格率≥90%
    // + 不合格率≤3% + 业务部批准），不再只看 result='pass' 宽松判定
    const bulkRelease = finalReport && finalReport.inspectionType === 'final'
      ? assessInspectionRelease(finalReport)
      : assessInspectionRelease(null);
    const bulkQcPassed = physicalBatches ? physicalBatches.every(batch => batch.satisfied) : bulkRelease.qualified;

    // DR-054 阶段 G：船样（S/S）统一为 Sample(type='ship') 挂 sourceOrderId（FSS 旧表退役只读）
    const ssSamples = nativeSamples ? [] : await db.sample.findMany({
      where: { sourceOrderId: orderId, type: 'ship', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const latestSs = nativeSamples ? null : ssSamples[0] ?? null;
    const ssApproved = nativeSamples ? nativeSamples.ssSatisfied : !!latestSs && latestSs.customerStatus === 'approved';

    const rcEnabled = nativeSamples ? nativeSamples.rcEnabled : !!order.fabricSampleSentDate;
    const rcConfirmed = nativeSamples ? nativeSamples.rcSatisfied : rcEnabled && !!order.fabricSampleConfirmedDate;

    const missingGates: ShipmentGateCode[] = [];
    if (nativeSamples?.proofBlocked) missingGates.push('NATIVE_SAMPLE_SCOPE_UNRESOLVED');
    if (!bulkQcPassed) missingGates.push('BULK_QC_NOT_PASSED');
    if (!ssApproved) missingGates.push('SS_NOT_CONFIRMED');
    if (rcEnabled && !rcConfirmed) missingGates.push('RC_NOT_CONFIRMED');

    return {
      orderId,
      applicable: true,
      eligible: missingGates.length === 0,
      ...(physicalBatches ? { physicalBatches } : {}),
      ...(nativeSamples ? { nativeSampleProofBlocked: nativeSamples.proofBlocked, nativeSampleFailureReasons: nativeSamples.blockingReasons } : {}),
      conditions: {
        bulkQc: physicalBatches ? {
          satisfied: bulkQcPassed,
          ...(bulkQcPassed ? {} : { failureReasons: physicalBatches.flatMap(batch => batch.failureReasons) }),
        } : {
          satisfied: bulkQcPassed,
          reportId: finalReport?.id ?? null,
          result: finalReport?.result ?? null,
          inspectedBy: finalReport?.inspectedBy ?? null,
          inspectionDate: finalReport?.inspectionDate ?? null,
          // D8 透明化：不满足时的具体口径缺口（消息与生产门禁逐条口径一致）
          ...(bulkRelease.qualified ? {} : { failureReasons: bulkRelease.failures.map(f => f.message) }),
        },
        ss: {
          satisfied: ssApproved,
          sampleId: latestSs?.id ?? null,
          sampleCode: latestSs?.sampleCode ?? null,
          customerStatus: latestSs?.customerStatus ?? null,
          customerFeedbackDate: latestSs?.customerFeedbackDate ?? null,
        },
        rc: {
          enabled: rcEnabled,
          satisfied: rcEnabled ? rcConfirmed : true,
          sentDate: order.fabricSampleSentDate ?? null,
          confirmedDate: order.fabricSampleConfirmedDate ?? null,
        },
      },
      missingGates,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 3B. REL-14-A4 服装出运资格判定（大货终期 Final QC 单条件，与样品 QC 独立）
  // ══════════════════════════════════════════════════════════════

  /**
   * REL-14-A4：服装订单出运门禁 = 大货终期 Final QC 放行（InspectionReport id=INR__{orderId},
   * inspectionType='final'；D8 起判定统一为生产门禁口径 assessInspectionRelease：结论非 fail
   * + 致命疵点=0 + 合格率≥90% + 不合格率≤3% + 业务部批准），与样品链 QC 严格独立（样品打回不阻断大货出运判定，
   * 大货 Final QC 缺/未过即不具备出运资格）。
   * 本函数只做原始门禁状态报告（fail-closed 视图），DR-013 受控例外由出运域另行绑定，
   * 例外不改变此处返回的门禁状态（DR-013「例外不改变原规则」）。
   * 面料订单不适用（走 checkShipmentEligibility 三条件并行）→ applicable=false。
   */
  async function checkGarmentShipmentEligibility(orderId: string, productionBatchIds?: string[]): Promise<GarmentShipmentEligibility> {
    if (!orderId?.trim()) throw new Error('orderId 必填');
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt !== null) throw new Error('订单不存在');

    if (!isGarmentChainOrder(order)) {
      return {
        orderId,
        applicable: false,
        eligible: false,
        bulkQc: { satisfied: false },
        missingGates: [],
        reason: 'REL-14-A4 服装出运门禁仅适用于服装链订单（含 capsule）；面料订单走 DR-014 三条件并行判定',
      };
    }

    const physicalBatches = productionBatchIds === undefined ? undefined : await assessShipmentBatchFinals(orderId, productionBatchIds);
    const finalReport = physicalBatches ? null : await latestCurrentWholeFinal(db, orderId);
    // D8：与面料链同一放行口径（生产门禁统一判定），不再只看 result='pass'
    const bulkRelease = finalReport && finalReport.inspectionType === 'final'
      ? assessInspectionRelease(finalReport)
      : assessInspectionRelease(null);
    const bulkQcPassed = physicalBatches ? physicalBatches.every(batch => batch.satisfied) : bulkRelease.qualified;

    return {
      orderId,
      applicable: true,
      eligible: bulkQcPassed,
      ...(physicalBatches ? { physicalBatches } : {}),
      bulkQc: physicalBatches ? {
        satisfied: bulkQcPassed,
        ...(bulkQcPassed ? {} : { failureReasons: physicalBatches.flatMap(batch => batch.failureReasons) }),
      } : {
        satisfied: bulkQcPassed,
        reportId: finalReport?.id ?? null,
        result: finalReport?.result ?? null,
        inspectedBy: finalReport?.inspectedBy ?? null,
        inspectionDate: finalReport?.inspectionDate ?? null,
        // D8 透明化：不满足时的具体口径缺口
        ...(bulkRelease.qualified ? {} : { failureReasons: bulkRelease.failures.map(f => f.message) }),
      },
      missingGates: bulkQcPassed ? [] : ['BULK_QC_NOT_PASSED'],
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 4. DR-027 开发样排除（订单前开发样不进入 QC 门禁，业务员自行登记）
  // ══════════════════════════════════════════════════════════════

  /**
   * DR-027：手织样/先锋样/Lab-dip/Strike-off/FIT/confirmation 等开发样类型
   * 不进入 QC 门禁（QC-29-B1：QC 工作台默认不出现开发样任务；评审端点 fail-closed 拒绝）。
   * 判定真源为 qcChainService.isDevelopmentSampleType（归一化大小写/连字符变体），
   * 此处为 QC 域内统一出口，供工作台与样品域消费，避免跨轨重复实现。
   */
  function shouldExcludeFromQc(sampleType?: string | null): boolean {
    return isDevelopmentSampleType(sampleType);
  }

  // ══════════════════════════════════════════════════════════════
  // 5. InspectionReport 读取 + signatures 双签（质量门禁 §9.3-②）
  // ══════════════════════════════════════════════════════════════

  async function getReport(reportId: string, actor?: TokenPayload | null): Promise<any> {
    return db.$transaction(async (tx: any) => {
      const access = await qcReportAccess(tx, actor, reportId);
      const report = (await attachReportCoverageContext(tx, [access.report], access.actor))[0];
      return { ...report, order: { id: access.order.id, poNumber: access.order.poNumber,
        customer: access.order.customer, product: access.order.product } };
    },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async function listReportsByOrder(orderId: string, actor?: TokenPayload | null): Promise<{ items: any[]; total: number }> {
    if (!orderId?.trim()) throw new QcReportError('VALIDATION_FAILED', 'orderId 必填');
    return db.$transaction(async (tx: any) => {
      const authorized = await qcReportReadWhere(tx, actor);
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.deletedAt != null) throw new QcReportError('NOT_FOUND', '订单不存在');
      const items = await tx.inspectionReport.findMany({ where: { orderId, AND: [authorized.where] }, orderBy: { createdAt: 'asc' } });
      return { items: await attachReportCoverageContext(tx, items, authorized.actor), total: items.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** All filters, count and pagination use one current server-generated scope. */
  async function listReports(query: ReportListQuery, actor?: TokenPayload | null): Promise<{ items: any[]; total: number }> {
    return db.$transaction(async (tx: any) => {
      const authorized = await qcReportReadWhere(tx, actor);
      const where: any = { AND: [authorized.where] };
      if (query.orderId) where.orderId = query.orderId;
      if (query.inspectionType) where.inspectionType = query.inspectionType;
      if (query.result) where.result = query.result;
      const [rows, total] = await Promise.all([
        tx.inspectionReport.findMany({ where, orderBy: { createdAt: 'desc' }, take: clampLimit(query.limit, 50, 200), skip: clampOffset(query.offset) }),
        tx.inspectionReport.count({ where }),
      ]);
      return { items: await attachOrderSnapshots(await attachReportCoverageContext(tx, rows, authorized.actor), tx), total };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /**
   * 双签写入（§9.3-② 产前样双签：QC 签字 + 业务签字均非空才放行开裁）。
   *   - role=qc → signatures.qcSignedAt / qcSignerId
   *   - role=business → signatures.businessSignedAt / businessSignerId
   * 浅合并写入：保留 signatures 上既有键（含 DR-029 chain 命名空间），互不覆盖；
   * 同一角色重复签署 fail-closed 拒绝（签署留痕不可改写， REL-14-A2 审计链保护）。
   *
   * 业务签字身份约束（质量门禁规则 §2.2.1 / QCG-EXC-2 场景①）：
   *   business 侧仅限订单负责人（Order.ownerId）或订单归属部门主管（Department.headId）；
   *   QC 容器代签业务侧 → 403 PP_SIGN_BUSINESS_ROLE_REQUIRED（双签职责分离，fail-closed）。
   */
  async function signReport(reportId: string, role: ReportSignRole, actorId: string, ip?: string | null,
    trustedActor?: TokenPayload | null, options: { delegationReason?: string } = {}): Promise<any> {
    if (!reportId?.trim()) throw new QcReportError('VALIDATION_FAILED', 'reportId 必填', 'report_id_required');
    if (role !== 'qc' && role !== 'business') throw new QcReportError('VALIDATION_FAILED', '非法签署角色（允许 qc | business）', 'invalid_role');
    if (!trustedActor?.userId || trustedActor.userId !== actorId) {
      throw new QcReportError('UNAUTHORIZED', '签核需要与当前可信身份一致的签署人。', 'actor_mismatch');
    }
    try {
      return await db.$transaction(async (tx: any) => {
        const access = await qcReportAccess(tx, trustedActor, reportId, { scope: role === 'qc' ? 'qc:inspect' : 'qc:write', lock: true,
          signRole: role, delegationReason: options.delegationReason });
        const report = access.report;
        const existing = (report.signatures && typeof report.signatures === 'object' && !Array.isArray(report.signatures) ? report.signatures : {}) as Record<string, unknown>;
        const atField = role === 'qc' ? 'qcSignedAt' : 'businessSignedAt';
        const byField = role === 'qc' ? 'qcSignerId' : 'businessSignerId';
        if (existing[atField] != null) throw new QcReportError('VALIDATION_FAILED',
          `该报告 ${role === 'qc' ? 'QC' : '业务'}侧已签署，不可重复签署（签署留痕不可改写）`, 'already_signed');
        const ts = now();
        const updated = await tx.inspectionReport.update({ where: { id: reportId },
          data: { signatures: { ...existing, [atField]: ts, [byField]: access.actor.userId }, updatedAt: BigInt(ts) } });
        await writeRouteAuditLog({ prisma: tx, actorId: access.actor.userId, source: 'route:qc:reports:sign',
          operation: `inspection_report_sign_${role}`, targetType: 'InspectionReport', targetId: reportId,
          after: { id: reportId, orderId: report.orderId, role, [atField]: ts, [byField]: access.actor.userId,
            inspectedBy: report.inspectedBy, delegated: access.delegated,
            ...(access.delegated ? { delegationReason: options.delegationReason!.trim() } : {}) },
          ip: ip ?? null, operationType: 'update', fieldPath: `signatures.${atField}`, beforeValue: null, afterValue: ts });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) { throw qcReportFailure(error); }
  }

  return {
    // 驻地
    createLocation,
    listLocations,
    updateLocation,
    deleteLocation,
    // 任务
    createAssignment,
    updateAssignment,
    startAssignment,
    completeAssignment,
    cancelAssignment,
    deleteAssignment,
    listAssignments,
    getWorkbench,
    getInspectionContext,
    // DR-014 出运资格 / REL-14-A4 服装 Final QC / DR-027 开发样排除
    checkShipmentEligibility,
    checkGarmentShipmentEligibility,
    shouldExcludeFromQc,
    // 报告读取 + 双签
    getReport,
    listReportsByOrder,
    listReports,
    signReport,
  };
}

export type QcService = ReturnType<typeof createQcService>;
