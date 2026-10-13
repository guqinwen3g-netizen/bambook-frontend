import { assertDevelopmentOperationalWrite } from '../development/developmentOperationalGuard';
/**
 * garmentSampleGateService.ts — 服装样品多轮双门禁服务（DR-008 / DR-029）
 *
 * 设计真源：
 *   - DR-008：样品开发是可循环链，不限轮数。每轮必须记录目的、版本、材料/工艺配置、
 *     QC 结论、客户意见、修改项与证据。内部门禁：每轮样品须先经内部 QC 通过，才允许
 *     提交客户。客户确认：客户不登录系统，业务员登记确认结果/日期/渠道/证据；QC 通过后
 *     可直接登记确认并封存产前样（不加主管审批）。封样不可变：封存产前样为生产基准，
 *     任何后续改动须产生新样品版本，并重新 QC、客户确认、封存。
 *   - DR-029 服装链：工厂每轮产前样先交服装 QC 评审；客户不通过→业务员反馈工厂→
 *     新样必须重新 QC 评审后才可再寄客户。
 *   - DR-039：每次寄送独立记录（快递商/单号/日期/收件方 + 随附单据）。
 *
 * 存储约束（轮次自 DR-054 阶段 G-Ⅱ 起全量落 SampleBatch；旧 JSON 载体与 SampleNode 投影
 *   已随消双轨 L-2 末件/L-4 退役）：
 *   - 多轮样品记录存于 SampleBatch(sampleType='garment-round')，本服务是该载体成衣轮次的写入口；
 *   - QC 结论引用 InspectionReport（qcInspectionReportId）——QC 域记录只读引用，本服务不写；
 *   - 封存收口：seal 写 SampleBatch sealed + 统一 Sample(type=pp, approved) 实物台账。
 *     口径（差距清单 §10.3）：封样 = 物理留存登记（留标样，大货同样封样），不承载放行语义；
 *     放行/开裁由 production 域 DR-053 放行范围 + 双签独立驱动。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
// ★ C5：寄样历史（追加式，与早产样 attachments.rounds[] 同模式；零 migration）
import { createHash } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { shipPhysicalSampleInTransaction, PhysicalShipmentError, type PhysicalShipmentInput } from './samplePhysicalShipment';
import { assertGarmentCustomerShipmentQuality, assertGarmentShipmentQualityReplayIntegrity } from './garmentCustomerShipmentQuality';
import { authorizeSampleCustody, assertSampleCustodyGuardStable } from './sampleCustodyAuthorization';
import { readBatchReceiptSnapshot } from './sampleBatchReceipt';
import { sampleOriginFingerprint, snapshotSampleOrigin } from './sampleOriginService';
import { appendShipmentHistory } from './sampleShipmentHistory';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { ensureDevelopmentSampleMajorVersion, ensureDevelopmentSampleRound, createDevelopmentSampleMinorVersionCommand, recordDevelopmentVersionConfirmation } from '../development/developmentSampleVersionService';
import { authorizeDevelopmentSource } from '../development/developmentConversionAuthority';
import { assertDevelopmentVersionReadyForConsumption, readDevelopmentVersionDecisions } from '../development/developmentVersionGate';
import { logger } from '../lib/logger';
import { upsertPpSampleFromSealedRound } from './sampleManageService';
import { garmentRoundContent, garmentCaseContent } from '../development/garmentSourceBindingService';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { isYmd, todayYmd } from './fabricShipmentSampleService';

// ────────────────────────────────────────────────────────────────────
// 常量与类型
// ────────────────────────────────────────────────────────────────────

/** 轮次状态机：in_progress →(QC通过)→ qc_passed →(提交客户)→ submitted →(客户approved)→ confirmed →(封存)→ sealed
 *                                        ↑                                  ↘(客户不通过)→ rejected（该轮终止，改动须开新轮）
 *   sealed 轮次在新轮封存时转为 superseded（内容不可变，仅标记不再是当前生产基准）。
 */
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

export const GARMENT_QC_RESULTS = ['passed', 'failed'] as const;
export const GARMENT_CONFIRM_RESULTS = ['approved', 'rejected', 'needs_revision'] as const;

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
type Failure = { ok: false; error: { code: string; message: string; status: number } };
function fail(code: string, message: string, status = 400): Failure {
  return { ok: false, error: { code, message, status } };
}

// ────────────────────────────────────────────────────────────────────
// 存储辅助（DR-054 阶段 G-Ⅱ：轮次统一落 SampleBatch(sampleType='garment-round')；
// 历史 DevelopmentCase.attachments.garmentSampleGate JSON 仅作只读回退兼容）
// ────────────────────────────────────────────────────────────────────

interface GarmentGateState {
  rounds: any[];
  sealedRoundId: string | null;
}

/** SampleBatch 行 → 成衣轮次视图（API 兼容 GarmentRound 结构） */
function serializeGarmentRound(b: any): any {
  const att = b.attachments && typeof b.attachments === 'object' ? b.attachments : {};
  // Older writers persisted the actual confirmation in attachments but omitted
  // the scalar projection. Preserve that recorded verdict, never infer approval
  // from sealing or from a status label alone.
  const recordedCustomerStatus = GARMENT_CONFIRM_RESULTS.includes(att.confirmation?.result)
    ? att.confirmation.result : 'pending';
  const roundStatusMap: Record<string, string> = {
    pending: 'in_progress', making: 'in_progress', sent: 'submitted', approved: 'confirmed', revising: 'rejected',
  };
  let status = roundStatusMap[b.status] ?? 'in_progress';
  if (b.status === 'making' && b.qcStatus === 'passed') status = 'qc_passed';
  if (att.sealedRoundStatus) status = att.sealedRoundStatus; // sealed | superseded
    return {
    id: b.id,
    developmentCaseId: b.developmentCaseId,
    round: b.round,
    sampleVersionId: b.sampleVersionId ?? null,
    trialTask: b._trialTask ?? null,
    ...(b._versionDecisions ?? { versionIdentityStatus: 'unknown', developmentQcReview: null, latestFormalQcReview: null, developmentQcHistory: [], versionConfirmation: null, versionConfirmationHistory: [] }),
    plannedQuantity: b.planQuantity == null ? null : Number(b.planQuantity),
    plannedUnit: b.planUnit ?? null,
    versionLabel: b.versionLabel ?? null,
    linkedAsset: b._linkedAsset ?? null,
    purpose: att.purpose ?? null,
    version: att.version ?? null,
    materialConfig: att.materialConfig ?? null,
    supplierRelationId: b.supplierRelationId || null,
    supplierName: b.supplierName ?? null,
    qcStatus: b.qcStatus ?? 'none',
    qcInspectionReportId: b.qcInspectionReportId ?? null,
    qcReviewedBy: b.qcReviewedBy ?? null,
    qcReviewedAt: b.qcReviewedAt ? Number(b.qcReviewedAt) : null,
    qcNote: att.qcNote ?? null,
    developmentQualityReviewId: att.developmentQualityReviewId ?? null,
    submittedAt: att.submittedAt ?? null,
    submittedBy: att.submittedBy ?? null,
    shipment: att.shipment ?? null,
    // ★ C5：寄样历史（读侧白名单，必须与写侧 `att.shipmentHistory` 对齐）
    shipmentHistory: Array.isArray(att.shipmentHistory) ? att.shipmentHistory : [],
    customerStatus: b.customerStatus ?? recordedCustomerStatus,
    confirmation: att.confirmation ?? null,
    modifications: Array.isArray(att.modifications) ? att.modifications : [],
    microVersions: Array.isArray(b._microVersions) ? b._microVersions : (Array.isArray(att.microVersions) ? att.microVersions : []),
    evidence: Array.isArray(att.evidence) ? att.evidence : [],
    notes: b.notes ?? null,
    status,
    sealedAt: att.sealedAt ?? null,
    sealedVersionId: att.sealedVersionId ?? null,
    sealedDevelopmentVersionProof: att.sealedDevelopmentVersionProof ?? null,
    sealedBy: att.sealedBy ?? null,
    retainLocation: att.retainLocation ?? null,
    createdBy: att.createdBy ?? null,
    createdAt: b.createdAt ? Number(b.createdAt) : null,
    updatedAt: b.updatedAt ? Number(b.updatedAt) : null,
  };
}

/** 异步读轮次：SampleBatch 优先（新载体）；无数据回退历史 JSON */
async function loadRounds(prisma: PrismaClient, devCase: any): Promise<GarmentGateState> {
  const batches = await (prisma as any).sampleBatch.findMany({
    where: { developmentCaseId: devCase.id, sampleType: 'garment-round', deletedAt: null },
    orderBy: { round: 'asc' },
  });
  const versionIds = batches.map((batch: any) => batch.sampleVersionId).filter(Boolean);
  const microByParent = new Map<string, any[]>();
  const versionModel = (prisma as any).developmentSampleVersion;
  let minorRows: any[] = [];
  let versionRows: any[] = [];
  if (versionIds.length && versionModel?.findMany) versionRows = await versionModel.findMany({ where: { id: { in: versionIds } } });
  const roundIds = [...new Set(versionRows.map(version => version.roundId).filter(Boolean))];
  const roundRows = roundIds.length ? await (prisma as any).developmentSampleRound.findMany({ where: { id: { in: roundIds }, deletedAt: null } }) : [];
  const roundById = new Map(roundRows.map((row: any) => [row.id, row]));
  if (versionIds.length && versionModel?.findMany) {
    minorRows = await versionModel.findMany({ where: { parentVersionId: { in: versionIds }, versionKind: 'minor', deletedAt: null }, orderBy: { minorVersion: 'asc' } });
  }
  const allVersionIds = [...versionIds, ...minorRows.map(version => version.id)];
  const decisions = await readDevelopmentVersionDecisions(prisma, devCase.id, allVersionIds);
  const batchIds = batches.map((batch: any) => batch.id);
  const assetModel = (prisma as any).productAsset;
  const assets = (allVersionIds.length || batchIds.length) && assetModel?.findMany
    ? await assetModel.findMany({ where: { sourceDevelopmentCaseId: devCase.id, deletedAt: null, OR: [
      ...(allVersionIds.length ? [{ sourceSampleVersionId: { in: allVersionIds } }] : []),
      ...(batchIds.length ? [{ sourceSampleBatchId: { in: batchIds } }] : []),
    ] }, select: { id: true, sku: true, name: true, sourceSampleVersionId: true, sourceSampleBatchId: true } })
    : [];
  const assetByVersion = new Map<string, any>(assets.map((asset: any) => [asset.sourceSampleVersionId, { id: asset.id, sku: asset.sku, name: asset.name }]));
  const assetByBatch = new Map<string, any>(assets.map((asset: any) => [asset.sourceSampleBatchId, { id: asset.id, sku: asset.sku, name: asset.name }]));
  for (const version of minorRows) {
    const list = microByParent.get(version.parentVersionId) ?? [];
    list.push({ id: version.id, versionId: version.id, versionLabel: version.versionLabel, factoryCode: version.factoryCode ?? null, physicalSequence: version.physicalSequence ?? null, sourceVersionId: version.sourceVersionId ?? null, note: version.minorChangeNote, createdBy: version.createdBy, createdAt: Number(version.createdAt), linkedAsset: assetByVersion.get(version.id) ?? null,
      ...(decisions.get(version.id) ?? {}) });
    microByParent.set(version.parentVersionId, list);
  }
  const taskByVersion = new Map(versionRows.map(version => { const round:any = roundById.get(version.roundId); return [version.id, { id: version.id, roundId: version.roundId, factoryCode: version.factoryCode ?? null, physicalSequence: version.physicalSequence ?? null, sourceVersionId: version.sourceVersionId ?? null,
    roundRequirementsSnapshot: version.roundRequirementsSnapshot ?? null, currentRoundRequirements: round?.notes ?? null, roundUpdatedAt: String(round?.updatedAt ?? 0),
    factoryRequirements: version.factoryRequirements ?? null, targetCompletionDate: version.targetCompletionDate ?? null,
    referenceAttachments: Array.isArray(version.referenceAttachments) ? version.referenceAttachments : [], updatedAt: String(version.updatedAt) }]; }));
  const rounds = batches.map((batch: any) => serializeGarmentRound({ ...batch, _trialTask: taskByVersion.get(batch.sampleVersionId), _microVersions: microByParent.get(batch.sampleVersionId),
    _versionDecisions: decisions.get(batch.sampleVersionId), _linkedAsset: batch.sampleVersionId ? assetByVersion.get(batch.sampleVersionId) ?? null : assetByBatch.get(batch.id) ?? null }));
  const sealed = rounds.find((r: any) => r.status === 'sealed');
  return { rounds, sealedRoundId: sealed?.id ?? null };
}

/** 持久化轮次 → SampleBatch（全量 upsert；被移除的轮次软删） */
async function persistRounds(tx: any, devCase: any, gate: GarmentGateState): Promise<void> {
  const now = BigInt(Date.now());
  const keptIds = new Set<string>();
  for (const r of gate.rounds) {
    keptIds.add(r.id);
    const att: any = {
      purpose: r.purpose ?? null,
      version: r.version ?? null,
      materialConfig: r.materialConfig ?? null,
      microVersions: Array.isArray(r.microVersions) ? r.microVersions : [],
      qcNote: r.qcNote ?? null,
      developmentQualityReviewId: r.developmentQualityReviewId ?? null,
      submittedAt: r.submittedAt ?? null,
      submittedBy: r.submittedBy ?? null,
      shipment: r.shipment ?? null,
      // ★ C5：寄样**历史**（追加式）。⚠️ 这里是**白名单** —— 漏加字段 = 历史被静默丢弃
      //   （我先只改了 `target.shipmentHistory`，查持久化时才发现会丢；读侧 serialize 也要同步）
      shipmentHistory: Array.isArray((r as any).shipmentHistory) ? (r as any).shipmentHistory : [],
      confirmation: r.confirmation ?? null,
      modifications: r.modifications ?? [],
      evidence: r.evidence ?? [],
      createdBy: r.createdBy ?? null,
      sealedAt: r.sealedAt ?? null,
      sealedVersionId: r.sealedVersionId ?? null,
      sealedDevelopmentVersionProof: r.sealedDevelopmentVersionProof ?? null,
      sealedBy: r.sealedBy ?? null,
      retainLocation: (r as any).retainLocation ?? null,
      sealedRoundStatus: r.status === 'sealed' || r.status === 'superseded' ? r.status : null,
    };
    const statusMap: Record<string, string> = {
      in_progress: 'pending', qc_passed: 'making', submitted: 'sent', confirmed: 'approved', rejected: 'revising',
    };
    const existing = await tx.sampleBatch.findUnique({ where: { id: r.id } });
    if (existing) {
      await tx.sampleBatch.update({
        where: { id: r.id },
        data: {
          status: statusMap[r.status] ?? existing.status,
          customerStatus: r.customerStatus,
          qcStatus: r.qcStatus === 'none' ? null : (r.qcStatus ?? existing.qcStatus),
          qcReviewedBy: r.qcReviewedBy ?? existing.qcReviewedBy,
          qcReviewedAt: r.qcReviewedAt != null ? BigInt(r.qcReviewedAt) : existing.qcReviewedAt,
          qcInspectionReportId: r.qcInspectionReportId ?? existing.qcInspectionReportId,
          ...(r.plannedQuantity !== undefined ? { planQuantity: r.plannedQuantity == null ? null : new Prisma.Decimal(String(r.plannedQuantity)) } : {}),
          ...(r.plannedUnit !== undefined ? { planUnit: r.plannedUnit || null } : {}),
          attachments: att,
          updatedAt: now,
        },
      });
    } else {
      await tx.sampleBatch.create({
        data: {
          id: r.id,
          batchCode: await nextBusinessNumber(tx, 'SB', undefined, {
            occupied: async batchCode => !!(await tx.sampleBatch.findFirst({ where: { batchCode }, select: { id: true } })),
          }),
          developmentCaseId: devCase.id,
          supplierRelationId: r.supplierRelationId ?? '',
          supplierName: r.supplierName ?? null,
          sampleType: 'garment-round',
          round: r.round ?? 1,
          sampleVersionId: r.sampleVersionId ?? null,
          versionLabel: r.versionLabel ?? null,
          status: statusMap[r.status] ?? 'pending',
          customerStatus: r.customerStatus,
          qcStatus: r.qcStatus === 'none' ? null : r.qcStatus,
          qcReviewedBy: r.qcReviewedBy ?? null,
          qcReviewedAt: r.qcReviewedAt != null ? BigInt(r.qcReviewedAt) : null,
          qcInspectionReportId: r.qcInspectionReportId ?? null,
          planQuantity: r.plannedQuantity == null ? null : new Prisma.Decimal(String(r.plannedQuantity)),
          planUnit: r.plannedUnit ?? null,
          attachments: att,
          notes: r.notes ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }
  // 软删不再存在的轮次行（如历史 JSON 轮次未迁移）
  const rows = await tx.sampleBatch.findMany({ where: { developmentCaseId: devCase.id, sampleType: 'garment-round', deletedAt: null } });
  for (const row of rows) {
    if (!keptIds.has(row.id)) {
      await tx.sampleBatch.update({ where: { id: row.id }, data: { deletedAt: now, updatedAt: now } });
    }
  }
}

async function findGarmentCase(prisma: PrismaClient, caseId: string): Promise<Result<{ devCase: any }>> {
  const devCase = await prisma.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!devCase) return fail('NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  if (String(devCase.type) !== 'garment') {
    return fail('NOT_GARMENT_CASE', `开发单 ${caseId} 类型为 ${devCase.type}，多轮双门禁仅适用于服装（garment）样品链（DR-008/DR-029 强制边界）`, 400);
  }
  return ok({ devCase });
}

/** 按轮次 id 反查开发单 + 轮次：SampleBatch 优先（新载体）；回退历史 JSON */
async function findCaseByRoundId(prisma: PrismaClient, roundId: string): Promise<Result<{ devCase: any; round: any }>> {
  const batch = await (prisma as any).sampleBatch?.findFirst?.({ where: { id: roundId, sampleType: 'garment-round', deletedAt: null } }).catch(() => null) ?? null;
  if (batch) {
    const devCase = await prisma.developmentCase.findFirst({ where: { id: batch.developmentCaseId, deletedAt: null } });
    if (!devCase) return fail('NOT_FOUND', `样品轮次 ${roundId} 的开发单不存在`, 404);
    return ok({ devCase, round: serializeGarmentRound(batch) });
  }
  return fail('NOT_FOUND', `样品轮次 ${roundId} 不存在`, 404);
}

/** 封样不可变守卫：sealed/superseded 轮次内容不可再改（只会返回失败分支） */
function assertRoundMutable(round: any): Failure | null {
  if (round.status === 'sealed' || round.status === 'superseded') {
    return fail(
      'SEALED_IMMUTABLE',
      '封存产前样为不可变生产基准：任何改动必须产生新样品版本，并重新走 QC→客户确认→封存链（DR-008）',
      409,
    );
  }
  return null;
}

function throwFailure(error: {code:string;message:string;status:number}): never { throw Object.assign(new Error(error.message),{...error,statusCode:error.status}); }
async function lockedGate(tx:any, caseId:string, action:'create'|'qc'|'submit'|'confirm'|'seal', roundId?:string) {
  await assertDevelopmentOperationalWrite(tx,caseId,'sample');
  const caseResult=await findGarmentCase(tx,caseId);
  if(!caseResult.ok)throwFailure(caseResult.error);
  const devCase=caseResult.data.devCase;
  const gate=await loadRounds(tx,devCase);
  if(roundId){
    const round=gate.rounds.find(r=>r.id===roundId);
    if(!round)throwFailure({code:'NOT_FOUND',message:'样品轮次不存在或已删除',status:404});
    const immutable=assertRoundMutable(round);if(immutable)throwFailure(immutable.error);
    if(action==='qc'&&!['in_progress','qc_passed'].includes(round.status))throwFailure({code:'INVALID_TRANSITION',message:'当前轮次状态不允许登记QC结论',status:409});
    if(action==='submit'&&(round.qcStatus!=='passed'||round.status!=='qc_passed'))throwFailure({code:'QC_GATE_NOT_PASSED',message:'内部QC未通过，禁止提交客户',status:409});
    if(action==='confirm'&&round.status!=='submitted')throwFailure({code:'INVALID_TRANSITION',message:'须先提交客户再登记确认',status:409});
    if(action==='seal'&&!round.sampleVersionId&&round.status!=='confirmed')throwFailure({code:'SEAL_REQUIRES_CONFIRMED',message:'封存产前样须先完成双门禁',status:409});
  }
  return {devCase,gate};
}

async function persistGate(tx: any, devCase: any, gate: GarmentGateState): Promise<void> {
  await persistRounds(tx, devCase, gate);
}

// ────────────────────────────────────────────────────────────────────
// 输入类型
// ────────────────────────────────────────────────────────────────────

export interface CreateGarmentRoundInput {
  purpose: string;          // 必填：本轮目的
  version: string;          // 必填：客户侧版本号（V1/V2/...）
  materialConfig: string;   // 必填：材料/工艺配置
  // DR-051 样品归属打样工厂（方案 A）：本轮由哪家打样工厂出品（多工厂并行，各轮分别归属）
  /** Explicit round number; gaps are valid. */
  round?: number;
  supplierRelationId?: string;
  supplierName?: string;
  factories?: Array<{ supplierRelationId: string; supplierName?: string; sourceVersionId?: string }>;
  sourceVersionId?: string;
  notes?: string;
  evidence?: any[];         // 证据（图片/文件引用）
  factoryRequirements?: string;
  targetCompletionDate?: string;
  referenceAttachments?: string[];
  plannedQuantity: number;
  plannedUnit: string;
}

export interface SubmitQcConclusionInput {
  result: 'passed' | 'failed';      // 必填：QC 评审结论
  qcInspectionReportId?: string;    // QC 结论引用（InspectionReport，QC 域只读）
  qcNote?: string;                  // QC 内部评审意见（不做机械二值压缩）
}

export interface SubmitToCustomerInput {
  requestKey?: string;
  physicalShipment?: PhysicalShipmentInput;
  sentDate?: string;          // 默认今天
  courier: string;            // 必填（DR-039）
  trackingNumber: string;     // 必填
  recipientName: string;      // 必填：收件方
  recipientContact?: string;
  shippingFee?: number;       // 邮寄费（DR-057 v2.1：非负，币种随客户合同）
  documents?: any[];          // 随附单据
}

export interface RegisterGarmentConfirmationInput {
  result: 'approved' | 'rejected' | 'needs_revision';
  confirmationDate: string;   // 必填
  channel: string;            // 必填：确认渠道
  note?: string;              // 客户意见
  modifications?: string[];   // 修改项
  evidence?: any[];           // 证据
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────

export function createGarmentSampleGateService(opts: { prisma: PrismaClient }) {
  const { prisma } = opts;

  /** 创建新一轮样品（目的/版本/材料工艺配置必填；不限轮数） */
  async function createRound(params: {
    caseId: string;
    input: CreateGarmentRoundInput;
    actorId: string;
    ip?: string | null;
  }): Promise<Result<{ round: any; rounds?: any[] }>> {
    const { caseId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!input.purpose || !String(input.purpose).trim()) return fail('INVALID_INPUT', 'purpose（本轮目的）必填（DR-008 每轮记录）');
    if (!input.version || !String(input.version).trim()) return fail('INVALID_INPUT', 'version（客户侧版本号）必填（DR-008 每轮记录）');
    if (!input.materialConfig || !String(input.materialConfig).trim()) return fail('INVALID_INPUT', 'materialConfig（材料/工艺配置）必填（DR-008 每轮记录）');
    if (input.factoryRequirements != null && String(input.factoryRequirements).trim().length > 8000) return fail('INVALID_INPUT', '工厂打样要求不能超过 8000 字');
    if (input.targetCompletionDate != null && input.targetCompletionDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.targetCompletionDate)) return fail('INVALID_INPUT', '要求完成日期格式须为 YYYY-MM-DD');
    if (input.referenceAttachments != null && (!Array.isArray(input.referenceAttachments) || input.referenceAttachments.length > 20
      || input.referenceAttachments.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048))) return fail('INVALID_INPUT', '参考附件最多 20 项，每项须为有效链接');
    if (!Number.isFinite(input.plannedQuantity) || input.plannedQuantity <= 0) return fail('INVALID_INPUT', '计划样品数量须大于 0');
    if (typeof input.plannedUnit !== 'string' || !input.plannedUnit.trim() || input.plannedUnit.trim().length > 30) return fail('INVALID_INPUT', '样品数量单位必填且不超过 30 字');

    const caseR = await findGarmentCase(prisma, caseId);
    if (!caseR.ok) return caseR;
    const { devCase } = caseR.data;

    const now = Date.now();
    try {
      const round = await (prisma as any).$transaction(async (tx: any) => {
        const {devCase,gate}=await lockedGate(tx,caseId,'create');
        const existingRoundNos = gate.rounds.map((r: any) => Number(r.round) || 0);
        const seq = input.round == null ? Math.max(0, ...existingRoundNos) + 1 : Number(input.round);
        if (!Number.isInteger(seq) || seq < 1) throw Object.assign(new Error('轮次必须是大于 0 的整数'), { code: 'INVALID_INPUT', statusCode: 400 });
        const factories = (Array.isArray(input.factories) && input.factories.length ? input.factories : [
          { supplierRelationId: input.supplierRelationId, supplierName: input.supplierName, sourceVersionId: input.sourceVersionId },
        ]).filter(f => String(f?.supplierRelationId || '').trim());
        if (factories.length === 0) throw Object.assign(new Error('请选择至少一家打样工厂'), { code: 'INVALID_INPUT', statusCode: 400 });
        const uniqueFactories = [...new Map(factories.map(f => [String(f.supplierRelationId).trim(), f])).values()];
        const alreadyAtRound = gate.rounds.filter((r: any) => Number(r.round) === seq);
        if (alreadyAtRound.length) {
          const inconsistent = alreadyAtRound.find((r: any) => r.purpose !== String(input.purpose).trim() || r.version !== String(input.version).trim() || r.materialConfig !== String(input.materialConfig).trim());
          if (inconsistent) throw Object.assign(new Error(`第 ${seq} 轮已经有工厂版本，目的、客户版本和材料工艺必须与本轮保持一致`), { code: 'ROUND_METADATA_MISMATCH', statusCode: 409 });
        }
        const roundRecord = await ensureDevelopmentSampleRound(tx, {
          developmentCaseId: caseId, round: seq, purpose: String(input.purpose).trim(),
          clientVersion: String(input.version).trim(), materialConfig: String(input.materialConfig).trim(),
          notes: input.notes ?? null, actorId, now: BigInt(now),
        });
        const records = [];
        for (const factory of uniqueFactories) {
          const supplierRelationId = String(factory.supplierRelationId).trim();
          const supplierName = factory.supplierName ? String(factory.supplierName) : supplierRelationId;
          const version = await ensureDevelopmentSampleMajorVersion(tx, {
            round: roundRecord, supplierRelationId, supplierName, sourceVersionId: factory.sourceVersionId ?? input.sourceVersionId,
            factoryRequirements: input.factoryRequirements?.trim() || roundRecord.notes || null,
            targetCompletionDate: input.targetCompletionDate || null,
            referenceAttachments: input.referenceAttachments ?? [], actorId, now: BigInt(now),
          });
          records.push({
          id: `GSR__${caseId}__${seq}_${Math.random().toString(36).slice(2, 7)}`,
          developmentCaseId: caseId,
          round: seq,
          versionLabel: version.versionLabel,
          sampleVersionId: version.id,
          purpose: String(input.purpose),
          version: String(input.version),
          materialConfig: String(input.materialConfig),
          // DR-051 样品归属打样工厂（方案 A）：本轮出品工厂（多工厂并行）
          supplierRelationId,
          supplierName,
          // QC 门禁
          qcStatus: 'none',
          qcInspectionReportId: null,
          qcReviewedBy: null,
          qcReviewedAt: null,
          qcNote: null,
          // 提交客户
          submittedAt: null,
          submittedBy: null,
          shipment: null,
          // 客户确认
          customerStatus: 'pending',
          confirmation: null,
          modifications: [],
          microVersions: [],
          evidence: Array.isArray(input.evidence) ? input.evidence : [],
          plannedQuantity: input.plannedQuantity,
          plannedUnit: input.plannedUnit.trim(),
          notes: input.notes ?? null,
          // 状态机
          status: 'in_progress',
          sealedAt: null,
          sealedBy: null,
          createdBy: actorId,
          createdAt: now,
          updatedAt: now,
        });
        }
        gate.rounds.push(...records);
        await persistGate(tx, devCase, gate);
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:garment-gate',
          operation: 'create_garment_sample_round',
          targetType: 'DevelopmentCase',
          targetId: caseId,
          after: { roundIds: records.map((r: any) => r.id), round: seq, versions: records.map((r: any) => r.versionLabel), purpose: input.purpose },
          ip: ip ?? null,
        });
        return records;
      });
      logger.info('[GarmentGate] 样品轮次已创建', { caseId, roundIds: round.map((r: any) => r.id), actorId });
      return ok({ round: round[0], rounds: round });
    } catch (e: any) {
      if (e?.status >= 400 && e?.status < 500 && typeof e?.code === 'string') return fail(e.code,e.message,e.status);
      // B39（D51）：本文件原先一处 `logger.error` 都没有（只有 info/warn）⇒ 先补日志，再换文案。
      // D52 覆盖面：try 内**唯一写**就是上面那个 $transaction（:304，写全用 tx），之后只有 logger.info + return
      // ⇒ 可以承诺"本次未确认任何改动"。
      logger.error('[GarmentGate] 轮次创建失败', { caseId, error: e?.message });
      return fail('CREATE_FAILED', '样品轮次创建未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该开发案例的轮次记录。', 500);
    }
  }

  /** QC 评审结论登记（DR-029：QC 直接在系统填写内部评审意见；引用 InspectionReport 只读校验） */
  async function submitQcConclusion(params: {
    roundId: string;
    input: SubmitQcConclusionInput;
    actorId: string;
    ip?: string | null;
  }): Promise<Result<{ round: any }>> {
    const { roundId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!(GARMENT_QC_RESULTS as readonly string[]).includes(String(input.result))) {
      return fail('INVALID_INPUT', 'result 必须是 passed | failed');
    }

    if (input.qcInspectionReportId) {
      const report = await prisma.inspectionReport.findUnique({ where: { id: input.qcInspectionReportId } });
      if (!report) return fail('QC_REPORT_NOT_FOUND', `QC 结论引用 ${input.qcInspectionReportId} 不存在（InspectionReport 由 QC 域维护，仅可引用）`, 400);
    }

    const found = await findCaseByRoundId(prisma, roundId);
    if (!found.ok) return found;
    const { devCase, round } = found.data;

    const immutable = assertRoundMutable(round);
    if (immutable) return immutable;
    if (!['in_progress', 'qc_passed'].includes(round.status)) {
      return fail('INVALID_TRANSITION', `当前轮次状态 ${round.status} 不允许登记 QC 结论（已提交客户后须由客户确认链推进）`, 409);
    }

    const now = Date.now();
    try {
      const updated = await (prisma as any).$transaction(async (tx: any) => {
        const {devCase,gate}=await lockedGate(tx,found.data.devCase.id,'qc',roundId);
        const target = gate.rounds.find((r: any) => r.id === roundId);
        const sourceBatch = await tx.sampleBatch.findFirst({ where: { id: roundId, developmentCaseId: devCase.id, sampleType: 'garment-round', deletedAt: null }, select: { sampleVersionId: true, returnedAt: true } });
        if (sourceBatch && (sourceBatch.sampleVersionId != null || sourceBatch.returnedAt != null))
          throwFailure({ code: 'DEVELOPMENT_SAMPLE_QC_WORKFLOW_REQUIRED', message: '该成衣样品须由业务员发起 QC 工作台评审，再由业务员确认结果；此旧入口不能直接登记结论。', status: 409 });
        target.qcStatus = input.result;
        target.qcInspectionReportId = input.qcInspectionReportId ?? target.qcInspectionReportId ?? null;
        target.qcReviewedBy = actorId;
        target.qcReviewedAt = now;
        target.qcNote = input.qcNote ?? null;
        target.status = input.result === 'passed' ? 'qc_passed' : 'in_progress'; // failed → 工厂重做后重新送 QC
        target.updatedAt = now;
        await persistGate(tx, devCase, gate);
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:garment-gate',
          operation: 'submit_garment_sample_qc',
          targetType: 'DevelopmentCase',
          targetId: devCase.id,
          before: { roundId, qcStatus: round.qcStatus, status: round.status },
          after: { roundId, qcStatus: input.result, status: target.status, qcInspectionReportId: target.qcInspectionReportId,
            qcReviewedAt: now, roundContent: garmentRoundContent(target), caseContent: garmentCaseContent(devCase) },
          ip: ip ?? null,
        });
        return target;
      });
      return ok({ round: updated });
    } catch (e: any) {
      if (e?.status >= 400 && e?.status < 500 && typeof e?.code === 'string') return fail(e.code,e.message,e.status);
      // B39 / D52：try 内唯一写 = $transaction（:392）⇒ 可承诺零改动。
      logger.error('[GarmentGate] QC 结论登记失败', { caseId: devCase.id, roundId, error: e?.message });
      return fail('UPDATE_FAILED', 'QC 结论登记未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该轮次的检验项与结论。', 500);
    }
  }

  /** 提交客户（内部门禁 fail-closed：QC 未通过 → 409）+ DR-039 寄送记录 */
  async function submitToCustomer(params: {
    roundId: string;
    input: SubmitToCustomerInput;
    actorId: string;
    trustedActor?: TokenPayload;
    ip?: string | null;
  }): Promise<Result<{ round: any }>> {
    const { roundId, input, actorId, ip, trustedActor } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!input.courier || !String(input.courier).trim()) return fail('INVALID_INPUT', 'courier（快递服务商）必填（DR-039）');
    if (!input.trackingNumber || !String(input.trackingNumber).trim()) return fail('INVALID_INPUT', 'trackingNumber（快递单号）必填（DR-039）');
    if (!input.recipientName || !String(input.recipientName).trim()) return fail('INVALID_INPUT', 'recipientName（收件方）必填（DR-039）');
    if (input.shippingFee !== undefined && input.shippingFee !== null && (!Number.isFinite(input.shippingFee) || input.shippingFee < 0)) {
      return fail('INVALID_INPUT', 'shippingFee（邮寄费）须为非负数值');
    }
    if (input.sentDate !== undefined && input.sentDate !== '' && !isYmd(input.sentDate)) {
      return fail('INVALID_INPUT', 'sentDate 格式须为 YYYY-MM-DD');
    }

    const found = await findCaseByRoundId(prisma, roundId);
    if (!found.ok) return found;
    const { devCase, round } = found.data;

    const immutable = assertRoundMutable(round);
    if (immutable && !input.requestKey) return immutable;

    const now = Date.now();
    const sentDate = input.sentDate || todayYmd();
    try {
      const updated = await (prisma as any).$transaction(async (tx: any) => {
        let custody: Awaited<ReturnType<typeof authorizeSampleCustody>> | undefined;
        if (input.physicalShipment) {
          if (!trustedActor || trustedActor.userId !== actorId) throw new PhysicalShipmentError('UNAUTHORIZED', '请使用当前登录账号寄样。', 401);
          custody = await authorizeSampleCustody({ db: tx, actor: trustedActor, subject: { kind: 'card', id: input.physicalShipment.itemId }, mode: 'write' });
          const siblings = await tx.sampleBatch.findMany({ where: { developmentCaseId: found.data.devCase.id, sampleType: 'garment-round', deletedAt: null }, select: { id: true } });
          const tables = { case: 'DevelopmentCase', relation: 'Relation', batch: 'SampleBatch', order: 'Order', asset: 'ProductAsset', warehouse: 'Warehouse', sample: 'Sample', card: 'SampleCardItem' };
          const refs = [...custody.lockRefs, ...siblings.map((row: any) => ({ kind: 'batch' as const, id: row.id }))];
          const order = Object.keys(tables), seen = new Set<string>();
          for (const ref of refs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id))) {
            const key = `${ref.kind}:${ref.id}`; if (seen.has(key)) continue; seen.add(key);
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${tables[ref.kind as keyof typeof tables]}"`)} WHERE "id" = ${ref.id} FOR UPDATE`);
          }
        }
        const {devCase,gate}=await lockedGate(tx,found.data.devCase.id,'submit');
        const target = gate.rounds.find((r: any) => r.id === roundId);
        if (!target) throw new PhysicalShipmentError('NOT_FOUND', '样品轮次不存在。', 404);
        const canonical = (value: any): any => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
        const requestFingerprint = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
        const prior = (target.shipmentHistory ?? []).find((entry: any) => input.requestKey && entry.requestKey === input.requestKey && entry.shippedBy === actorId);
        if (prior) {
          if (prior.requestFingerprint !== requestFingerprint) throw new PhysicalShipmentError('REQUEST_CONFLICT', '原寄样编号已经用于其他内容。');
          if (custody) assertSampleCustodyGuardStable(custody.guard, (await authorizeSampleCustody({ db: tx, actor: trustedActor!, subject: { kind: 'card', id: input.physicalShipment!.itemId }, mode: 'write' })).guard);
          await assertGarmentShipmentQualityReplayIntegrity(tx, { caseId: devCase.id, batchId: roundId, actorId,
            requestKey: input.requestKey!, requestFingerprint, shipment: prior });
          return { ...target, shipment: prior, shipmentReplay: true };
        }
        const blocked = assertRoundMutable(target); if (blocked) throwFailure(blocked.error);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id" = ${roundId} AND "developmentCaseId" = ${devCase.id} AND "sampleType" = 'garment-round' AND "deletedAt" IS NULL FOR UPDATE`);
        const batch = await tx.sampleBatch.findFirst({ where: { id: roundId, developmentCaseId: devCase.id, sampleType: 'garment-round', deletedAt: null } });
        if (!batch) throw new PhysicalShipmentError('NOT_FOUND', '准确样品轮次不存在。', 404);
        // A nonce identifies the command; it never supplies QC authority. Exact
        // versions use their latest current report, while legacy rows retain
        // their recorded scalar gate without inventing a version identity.
        const qualityProof = batch.sampleVersionId
          ? await assertGarmentCustomerShipmentQuality(tx, devCase.id, batch) : null;
        if (!batch.sampleVersionId && (batch.qcStatus !== 'passed' || serializeGarmentRound(batch).status !== 'qc_passed')) {
          throw new PhysicalShipmentError('QC_GATE_NOT_PASSED', '内部 QC 未通过，禁止提交客户（DR-008 内部门禁，fail-closed）');
        }
        const requiresPhysicalSample = !!batch.sampleVersionId || batch.returnedAt != null;
        if (requiresPhysicalSample && !input.physicalShipment) throw new PhysicalShipmentError('PHYSICAL_SHIPMENT_REQUIRED', '请选择开发模块登记的准确实物样品及数量。');

        const cards = await tx.sampleCardItem.findMany({ where: { batchId: roundId, deletedAt: null } });
        if (cards.some((card: any) => !readBatchReceiptSnapshot(card.receiptSnapshot)))
          throw new PhysicalShipmentError('PHYSICAL_RECEIPT_UNVERIFIED', '该轮存在来源不完整的实物，请先核对原收样记录。');
        if (cards.some((card: any) => readBatchReceiptSnapshot(card.receiptSnapshot)?.sourceRound === batch.round) && !input.physicalShipment)
          throw new PhysicalShipmentError('PHYSICAL_SHIPMENT_REQUIRED', '请选择本轮实际寄出的实物及数量。');
        let physicalShipment: any = null;
        if (input.physicalShipment) {
          if (!input.requestKey || typeof input.requestKey !== 'string' || input.requestKey.length > 200) throw new PhysicalShipmentError('INVALID_INPUT', '实物寄样须保留原操作编号。', 400);
          if (input.physicalShipment.recipientName.trim() !== input.recipientName.trim() || input.physicalShipment.relationId && input.physicalShipment.relationId !== devCase.customerRelationId)
            throw new PhysicalShipmentError('PHYSICAL_SOURCE_MISMATCH', '实物收件人与业务寄样信息不一致。');
          physicalShipment = await shipPhysicalSampleInTransaction(tx, trustedActor!, input.physicalShipment, { source: { batchId: roundId, devCaseId: devCase.id },
            eventId: `garment-round:${roundId}:${actorId}:${input.requestKey}`, occurredAt: now, expectedGuard: custody?.guard,
            assertSource: card => {
              const receipt = readBatchReceiptSnapshot(card.receiptSnapshot);
              if (!receipt || receipt.nativeFamily !== 'garment-round' || receipt.sourceRound !== batch.round
                || receipt.batchId !== batch.id || receipt.developmentCaseId !== devCase.id || receipt.factoryId !== batch.supplierRelationId
                || receipt.cardType !== card.cardType || receipt.physicalUnit !== card.unit
                || receipt.sourceFingerprint !== sampleOriginFingerprint(snapshotSampleOrigin(batch, devCase)))
                throw new PhysicalShipmentError('PHYSICAL_SOURCE_MISMATCH', '实物缺少本轮准确收样证明。');
            } });
        }
        target.status = 'submitted';
        target.submittedAt = now;
        target.submittedBy = actorId;
        /**
         * ★ C5（2026-09-18）：成衣轮次寄样改为**追加历史**（原来直接覆盖 `target.shipment`
         * ⇒ 同一轮次分两次寄样时前一次被抹掉）。
         * ⓘ 与早产样 `attachments.rounds[]` 同模式，**零 migration**；
         *   `target.shipment` 保留不删（既有消费方零改动）。
         */
        const shipmentEntry = {
          sentDate,
          requestKey: input.requestKey ?? null, requestFingerprint, physicalShipment, qualityProof,
          courier: String(input.courier),
          trackingNumber: String(input.trackingNumber),
          recipientName: String(input.recipientName),
          recipientContact: input.recipientContact ?? null,
          shippingFee: input.shippingFee ?? null,
          documents: Array.isArray(input.documents) ? input.documents : [],
          shippedBy: actorId,
          shippedAt: now,
        };
        const appended = appendShipmentHistory(target.shipmentHistory, shipmentEntry);
        target.shipmentHistory = appended.history;
        target.shipment = shipmentEntry;
        target.updatedAt = now;
        await persistGate(tx, devCase, gate);
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:garment-gate',
          operation: 'submit_garment_sample_to_customer',
          targetType: 'DevelopmentCase',
          targetId: devCase.id,
          before: { roundId, status: round.status },
          after: { roundId, status: 'submitted', sentDate, courier: input.courier, trackingNumber: input.trackingNumber,
            requestKey: input.requestKey ?? null, requestFingerprint, shippingFee: input.shippingFee ?? null, physicalShipment, qualityProof, shipmentEntry },
          ip: ip ?? null,
        });
        return target;
      });
      return ok({ round: updated });
    } catch (e: any) {
      if (e?.status >= 400 && e?.status < 500 && typeof e?.code === 'string') return fail(e.code,e.message,e.status);
      // B39 / D52：try 内唯一写 = $transaction（:455）⇒ 可承诺零改动。
      logger.error('[GarmentGate] 提交客户失败', { caseId: devCase.id, roundId, error: e?.message });
      return fail('UPDATE_FAILED', '该轮样品提交客户未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该轮次的寄送与收件信息。', 500);
    }
  }

  /** Record the actual requester for an explicitly selected version. Legacy
   * attachment confirmations stay readable but cannot invent actual people. */
  async function registerCustomerConfirmation(params: {
    roundId: string; input: any; actorId: string; trustedActor?: TokenPayload; ip?: string | null;
  }): Promise<Result<{ round: any }>> {
    const { roundId, input, actorId, trustedActor, ip } = params;
    if (!input || typeof input.sampleVersionId !== 'string' || !input.sampleVersionId.trim()
      || !input.confirmerType || !input.confirmerName || input.confirmedAt == null || !input.basis)
      return fail('INVALID_INPUT', '请明确选择准确开发版本，并填写实际确认方、确认人、实际时间和确认依据；旧记录的录入人不能代作实际确认人');
    const found = await findCaseByRoundId(prisma, roundId);
    if (!found.ok) return found;
    const recorded = await recordDevelopmentVersionConfirmation({ prisma, caseId: found.data.devCase.id, versionId: input.sampleVersionId,
      actorId, trustedActor, input: { ...input, sampleBatchId: roundId, result: input.result === 'needs_revision' ? 'needs_adjustment' : input.result }, ip });
    if (!recorded.ok) return recorded;
    const gate = await loadRounds(prisma, found.data.devCase);
    const round = gate.rounds.find((item: any) => item.id === roundId);
    if (!round) return fail('NOT_FOUND', '已记录需求方确认，但原实物轮次已不可见，请核对原回执', 404);
    return ok({ round });
  }

  /**
   * 封存产前样（封样不可变；QC 通过 + 客户确认后业务员直接封存，不加主管审批——DR-008）。
   * 新轮封存时旧封存轮次转 superseded（内容不可变，仅不再是当前生产基准）。
   * 收口投影：pp 样衣节点推进 approved（生产放行/开裁前置的既有消费点）。
   */
  async function sealRound(params: {
    roundId: string;
    actorId: string;
    trustedActor?: TokenPayload;
    sampleVersionId?: string;
    ip?: string | null;
    /** §10.3 封样口径：封存时登记留存位置（写入轮次 attachments，随实物台账可查） */
    retainLocation?: string | null;
  }): Promise<Result<{ round: any }>> {
    const { roundId, actorId, ip, retainLocation } = params;

    const found = await findCaseByRoundId(prisma, roundId);
    if (!found.ok) return found;
    const { devCase, round } = found.data;

    const immutable = assertRoundMutable(round);
    if (immutable) return immutable;
    if (!round.sampleVersionId || typeof params.sampleVersionId !== 'string' || !params.sampleVersionId.trim())
      return fail('DEVELOPMENT_SOURCE_CHANGED', '封存须明确选择原实物对应的准确开发版本；历史未知来源只保留原记录', 409);
    if (!round.sampleVersionId && round.status !== 'confirmed') {
      return fail(
        'SEAL_REQUIRES_CONFIRMED',
        `封存产前样须先完成双门禁：内部 QC 通过 + 客户确认已登记（当前状态 ${round.status}，QC ${round.qcStatus}）`,
        409,
      );
    }

    const now = Date.now();
    try {
      const updated = await (prisma as any).$transaction(async (tx: any) => {
        const {devCase,gate}=await lockedGate(tx,found.data.devCase.id,'seal',roundId);
        await authorizeDevelopmentSource(tx, actorId, params.trustedActor, devCase.id);
        const accurate = await assertDevelopmentVersionReadyForConsumption(tx, devCase.id, params.sampleVersionId!);
        if (accurate.batch.id !== roundId || accurate.physicalVersion.id !== round.sampleVersionId)
          throwFailure({ code: 'DEVELOPMENT_SOURCE_CHANGED', message: '所选准确版本不属于该返样实物', status: 409 });
        // 旧封存轮次 → superseded（内容不可变，历史基准保留）
        if (gate.sealedRoundId) {
          const prev = gate.rounds.find((r: any) => r.id === gate.sealedRoundId);
          if (prev && prev.status === 'sealed') {
            prev.status = 'superseded';
            prev.updatedAt = now;
          }
        }
        const target = gate.rounds.find((r: any) => r.id === roundId);
        target.status = 'sealed';
        target.sealedAt = now;
        target.sealedVersionId = accurate.version.id;
        target.sealedDevelopmentVersionProof = accurate.exactDevelopmentVersionProof;
        target.sealedBy = actorId;
        target.updatedAt = now;
        if (retainLocation) target.retainLocation = retainLocation;
        gate.sealedRoundId = roundId;
        await persistGate(tx, devCase, gate);

        // The exact seal basis exists before the derived PP projection reads
        // it. Both facts remain in this same transaction and roll back together.
        await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:samples:garment-gate',
          operation: 'seal_garment_preproduction_sample', targetType: 'DevelopmentCase', targetId: devCase.id,
          before: { roundId, status: round.status }, after: { roundId, sourceRoundId: roundId, status: 'sealed',
            sealedVersionId: accurate.version.id, exactDevelopmentVersionProof: accurate.exactDevelopmentVersionProof,
            roundContent: garmentRoundContent(target) }, ip: ip ?? null });

        // DR-052 §10 #1 写通：封存产前样 → Sample(type=pp, approved)（样品域实物台账。
        // 封样=物理留存登记，不承载放行语义；放行/开裁由 production DR-053 放行范围+双签独立驱动）
        const { sample } = await upsertPpSampleFromSealedRound({
          prisma: tx,
          devCase,
          round: target,
          sealedAt: now,
          sealedBy: actorId,
          actorId,
        });

        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:samples:garment-gate',
          operation: 'seal_garment_preproduction_sample',
          targetType: 'DevelopmentCase',
          targetId: devCase.id,
          before: { roundId, status: round.status, sealedRoundId: round.id },
          after: { roundId, sourceRoundId: roundId, sampleId: sample.id, status: 'sealed', sealedRoundId: roundId, ppSampleProjected: true,
            sealedVersionId: accurate.version.id, exactDevelopmentVersionProof: accurate.exactDevelopmentVersionProof,
            roundContent: garmentRoundContent(target) },
          ip: ip ?? null,
        });
        return target;
      });
      logger.info('[GarmentGate] 产前样已封存', { caseId: devCase.id, roundId, actorId });
      return ok({ round: updated });
    } catch (e: any) {
      if (e?.status >= 400 && e?.status < 500 && typeof e?.code === 'string') return fail(e.code,e.message,e.status);
      // B39 / D52：try 内唯一写 = $transaction（:597，含 upsertPpSampleFromSealedRound 都传 tx）⇒ 可承诺零改动。
      logger.error('[GarmentGate] 封样失败', { caseId: devCase.id, roundId, error: e?.message });
      if (e?.code === 'NOT_FOUND') return fail('NOT_FOUND', e.message, 404);
      return fail('SEAL_FAILED', '该轮样品封样未能完成，本次未确认任何改动，请稍后重试；封样后款式不再接受改动，请确认无误再操作。', 500);
    }
  }

  /** Written minor versions share the original physical sample and retain their
   * own QC/requester decisions. No new SampleBatch or warehouse stock is created. */
  async function addMicroVersion(params: {
    roundId: string; note: string; requestKey?: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null;
  }): Promise<Result<{ round: any }>> {
    const found = await findCaseByRoundId(prisma, params.roundId);
    if (!found.ok) return found;
    const parentVersionId = found.data.round.sampleVersionId;
    if (!parentVersionId) return fail('VERSION_NODE_MISSING', '该历史样品缺少明确的大版本节点，不能按标签推算微调来源', 409);
    const created = await createDevelopmentSampleMinorVersionCommand({ prisma, caseId: found.data.devCase.id, parentVersionId,
      actorId: params.actorId, trustedActor: params.trustedActor, input: { requestKey: params.requestKey as string, note: params.note }, ip: params.ip });
    if (!created.ok) return created;
    const gate = await loadRounds(prisma, found.data.devCase);
    return ok({ round: gate.rounds.find((item: any) => item.id === params.roundId) });
  }

  /** 开发单样品轮次列表（含当前封存基准标记） */
  async function listRounds(params: { caseId: string; trustedActor?: TokenPayload }): Promise<Result<{ items: any[]; sealedRoundId: string | null }>> {
    try { await authorizeDevelopmentSource(prisma, params.trustedActor?.userId, params.trustedActor, params.caseId, { write: false }); }
    catch (error: any) { return fail(error.code || 'ROUND_LIST_FAILED', error.message || '开发样品来源权限未能完整核对', error.statusCode || 500); }
    const devCase = await prisma.developmentCase.findFirst({ where: { id: params.caseId, deletedAt: null } });
    if (!devCase) return fail('NOT_FOUND', `开发单 ${params.caseId} 不存在`, 404);
    const gate = await loadRounds(prisma, devCase);
    return ok({ items: gate.rounds, sealedRoundId: gate.sealedRoundId });
  }

  return { createRound, addMicroVersion, submitQcConclusion, submitToCustomer, registerCustomerConfirmation, sealRound, listRounds };
}

export type GarmentSampleGateService = ReturnType<typeof createGarmentSampleGateService>;
