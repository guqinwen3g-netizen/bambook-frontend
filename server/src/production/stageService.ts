/**
 * Production Pipeline Stage Service — 大货十阶段生产管线门禁引擎
 *
 * 业务规定门禁:
 *   ⑥ pre_cut_checked 需 PreCutChecklist 四项全 true
 *   ⑦ pp_sample_approved 需双签（生产部+业务部确认）
 *   ⑩ qc_shipped 需验货 passRate>=90% + defectRate<=3% + 业务部批准
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { summarizeOrderQuantity, type OrderQuantitySummary } from '../shared/orderQuantitySummary';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';
import { createNotificationService } from '../notifications/notificationService';
import { logger } from '../lib/logger';
import { lookupErrorCode } from '../shared/errorCodes';
import { summarizeOrderReleases, lockOrderReleaseSources, invalidateCurrentReleaseSourcesInTx } from './releaseService';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { latestCurrentWholeFinal, lockQcCoverage } from '../qc/qcPhysicalCoverage';
import { qcReportOrderAccess, QcReportError } from '../qc/qcReportAuthority';
import { todayLocalKey } from '../shared/localDate';


export const PRODUCTION_STAGES = [
  { key: 'order_placed', seq: 1, label: '业务下单' },
  { key: 'materials_confirmed', seq: 2, label: '面辅料确认' },
  { key: 'production_planned', seq: 3, label: '生产计划' },
  { key: 'in_production', seq: 4, label: '货期管理' },
  { key: 'materials_arrived', seq: 5, label: '面辅料到厂' },
  { key: 'pre_cut_checked', seq: 6, label: '裁剪前检查' },
  { key: 'pp_sample_approved', seq: 7, label: '产前样确认' },
  { key: 'manufacturing', seq: 8, label: '生产过程' },
  { key: 'final_review', seq: 9, label: '成品确认' },
  { key: 'qc_shipped', seq: 10, label: '验货发货' },
] as const;

export type StageKey = typeof PRODUCTION_STAGES[number]['key'];

const STAGE_KEYS: string[] = PRODUCTION_STAGES.map(s => s.key);
const STAGE_MAP = new Map<StageKey, typeof PRODUCTION_STAGES[number]>(PRODUCTION_STAGES.map(s => [s.key, s]));

/**
 * 边界处解析 stageKey：将外部 string 输入转换为 StageKey 联合类型。
 * 返回 null 时调用方应直接响应 INVALID_STAGE。
 */
export function parseStageKey(input: string): StageKey | null {
  return STAGE_KEYS.includes(input) ? (input as StageKey) : null;
}

const MIN_PASS_RATE = 0.90;
const MAX_DEFECT_RATE = 0.03;

export type StageGateErrorCode =
  | 'CONFLICT'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_STAGE'
  | 'STAGE_NOT_SEQUENTIAL'
  | 'STAGE_BLOCKED'
  | 'PRECUT_CHECKLIST_INCOMPLETE'
  | 'PP_SAMPLE_NOT_SIGNED'
  | 'PP_RELEASE_BLOCKED'
  | 'INSPECTION_NOT_QUALIFIED'
  | 'BUSINESS_APPROVAL_REQUIRED'
  | 'STAGE_UPDATE_FAILED';

function passRate(total: number, passed: number): number {
  if (total <= 0) return 0;
  return passed / total;
}

/**
 * 业务门禁拒绝（可预期结果：少签字 / 清单未完 / 放行未 ready / 验货不合格 …）。
 *
 * 识别方式用类型而不是「错误码字符串白名单」：此前 advanceStage 的 catch 靠一份手写
 * 名单判断要不要透传，P-3 批次新增的 `PP_RELEASE_BLOCKED` 忘了登记，被吞成
 * `STAGE_UPDATE_FAILED`(500)，route 层给它对齐的 422 因此成了死代码。
 * 今后凡属业务拒绝一律 `throw new StageGateError(code, msg)`，catch 侧 instanceof
 * 判定即可透传，新增门禁码不需要再改任何名单。
 *
 * S0-A Task 4 核定：补 `statusCode`，让**逃出本服务 try/catch** 的拒绝（`saveInspectionReport` 的
 * `INVALID_RESULT`/`ORDER_NOT_FOUND`、`signStage` 的 `INVALID_STAGE`，走 production 两个路由的
 * `safeRouteError`）不再被兜成 500 + 通用文案。
 * `code` 仍是逐抛出点给的语义码（ORDER_NOT_FOUND / INVALID_RESULT / PP_RELEASE_BLOCKED …），
 * 不能收敛成一个常量 —— advanceStage 的 catch 与 route 的状态映射都读它。
 * 第三个参数带默认值 ⇒ 既有 `new StageGateError(code, msg)` 调用点不用改。
 *
 * ★ 终评 Important #1 更正（默认值从「一律 409」改为「**查注册表**，表内没有才用 409 地板值」）：
 * 补了 `statusCode` 之后本类就满足 `isBusinessError` ⇒ 逃出的拒绝走「原样透传」分支。
 * 一律 409 的净效果因此不只是状态，还包括**把抛出点的 message 直接送上屏幕** ——
 * `signStage` 当时的 `"Stage pp not found"` 于是出现在业务员眼前，而同一个 `INVALID_STAGE`
 * 在 block 端点被答成 400。这正是本批要杀的两件事（内部文本上屏 + 同码不同状态），
 * 被本批自己又造出来一次。⇒ ① 状态改查表（表是码→状态的唯一真源，本类只是**读**它，没有再写第三本）；
 * ② 全部业务拒绝的抛出点文案改成中文（见 `stageSignExitContract.test.ts` 的守卫）。
 *
 * ⚠️ 仍未解决（有意不在本批拍板）：`route.ts:294` 与 `routeV2.ts:84` **两本既有映射互相打架**
 * （实测 `STAGE_NOT_SEQUENTIAL` 一处 400、一处 409）⇒ 该码**不进注册表**，继续吃 409 地板值，
 * 冲突已登记为 §9 阻塞项等拍板。
 */
export class StageGateError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = lookupErrorCode(code)?.status ?? 409) {
    super(message);
    this.name = 'StageGateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function defectRate(total: number, passed: number): number {
  if (total <= 0) return 0;
  return (total - passed) / total;
}

// ────────────────────────────────────────────────────────────────
// D8 验货放行统一口径（qc_shipped 生产门禁 = QC 出运资格判定唯一真源）
// ────────────────────────────────────────────────────────────────

/** 放行判定消费的最小报告视图（与 InspectionReport 行结构兼容；数量缺省按 schema @default(0) 归一） */
export interface InspectionReleaseSubject {
  result?: string | null;
  totalUnits?: number | null;
  passedUnits?: number | null;
  criticalDefects?: number | null;
  approvedByBusiness?: boolean | null;
}

export interface InspectionReleaseFailure {
  code: 'INSPECTION_NOT_QUALIFIED' | 'BUSINESS_APPROVAL_REQUIRED';
  message: string;
}

export interface InspectionReleaseAssessment {
  qualified: boolean;
  failures: InspectionReleaseFailure[];
}

/**
 * D8：验货放行口径唯一真源——合格率 ≥90% + 不合格率 ≤3% + 致命疵点 = 0
 * （AQL 0 零容忍）+ 结论非 fail + 业务部批准。
 * 消费方（禁止各自重造口径）：
 *   - stageService.advanceStage「qc_shipped」门禁（failures[0] 即原逐条抛错语义，顺序一致）；
 *   - qcService.checkShipmentEligibility / checkGarmentShipmentEligibility 出运资格 bulkQc 判定。
 * null/undefined 报告 → qualified=false（fail-closed，「报告未建立」）。
 */
export function assessInspectionRelease(inspection: InspectionReleaseSubject | null | undefined): InspectionReleaseAssessment {
  const failures: InspectionReleaseFailure[] = [];
  if (!inspection) {
    failures.push({ code: 'INSPECTION_NOT_QUALIFIED', message: '终期验货报告（final）未建立' });
    return { qualified: false, failures };
  }
  if (inspection.result === 'fail') {
    failures.push({ code: 'INSPECTION_NOT_QUALIFIED', message: '终期验货结论为不合格（fail），需整改复验' });
  }
  const critical = inspection.criticalDefects ?? 0;
  if (critical > 0) {
    failures.push({ code: 'INSPECTION_NOT_QUALIFIED', message: `存在 ${critical} 个致命疵点（AQL 0 零容忍）` });
  }
  // 缺省按 schema @default(0) 归一：无数量数据 → 合格率 0，fail-closed
  const pr = passRate(inspection.totalUnits ?? 0, inspection.passedUnits ?? 0);
  const dr = defectRate(inspection.totalUnits ?? 0, inspection.passedUnits ?? 0);
  if (pr < MIN_PASS_RATE) {
    failures.push({ code: 'INSPECTION_NOT_QUALIFIED', message: `合格率 ${(pr * 100).toFixed(1)}% 低于阈值 90%` });
  }
  if (dr > MAX_DEFECT_RATE) {
    failures.push({ code: 'INSPECTION_NOT_QUALIFIED', message: `不合格率 ${(dr * 100).toFixed(1)}% 超过上限 3%` });
  }
  if (!inspection.approvedByBusiness) {
    failures.push({ code: 'BUSINESS_APPROVAL_REQUIRED', message: '需业务部批准发货' });
  }
  return { qualified: failures.length === 0, failures };
}

export async function initProductionStages(prisma: Pick<PrismaClient, 'productionStage'>, orderId: string): Promise<void> {
  const now = BigInt(Date.now());
  for (const stage of PRODUCTION_STAGES) {
    await prisma.productionStage.upsert({
      where: { orderId_stageKey: { orderId, stageKey: stage.key } },
      create: {
        id: `PST__${orderId}__${stage.key}`,
        orderId,
        stageKey: stage.key,
        stageSeq: stage.seq,
        status: stage.seq === 1 ? 'done' : 'pending',
        doneAt: stage.seq === 1 ? now : null,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
  }
}

export interface ProductionBoardItem {
  order: {
    id: string;
    poNumber: string | null;
    customer: string;
    quantity: string | null;
    unit: string | null;
    quantitySummary: OrderQuantitySummary;
    status: string;
    dueDate: string;
    businessLine: string | null;
    merchandiser: string | null;
    millName: string | null;
  };
  stages: Array<{ stageKey: string; stageSeq: number; status: string }>;
  /** 第一个非 done 阶段（全部完成时为 null） */
  currentStageKey: string | null;
  blockedCount: number;
}

/**
 * 生产跟单看板聚合（PRD 19.8）：全部在手订单 × 10 阶段泳道。
 * 在手口径：未软删且未交付/未取消（含 Alert 异常单——跟单员最需看见）。
 * 只读聚合，直接查表（与 D3 getOrderContext 同一双轨制原则）。
 */
export async function getProductionBoard(prisma: PrismaClient, visibleOrderIds: readonly string[] | null): Promise<{ items: ProductionBoardItem[] }> {
  if (visibleOrderIds !== null && !Array.isArray(visibleOrderIds)) throw new StageGateError('UNAUTHORIZED', '读取生产跟单需要核实当前订单范围', 401);
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, status: { notIn: ['Delivered', 'Cancelled'] }, ...(visibleOrderIds === null ? {} : { id: { in: [...visibleOrderIds] } }) },
    select: {
      id: true, poNumber: true, customer: true, quantity: true, unit: true,
      lines: { select: { quantity: true, unit: true } }, status: true,
      dueDate: true, businessLine: true, merchandiser: true, millName: true,
    },
    orderBy: { dueDate: 'asc' },
    take: 500,
  });
  const orderIds = orders.map(o => o.id);
  const stages = await prisma.productionStage.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, stageKey: true, stageSeq: true, status: true },
    orderBy: { stageSeq: 'asc' },
  });
  // A read cannot manufacture completed business steps. Missing historical
  // stages stay unknown; new fulfillment consumes exact lines and branches.
  const stagesByOrder = new Map<string, Array<{ stageKey: string; stageSeq: number; status: string }>>();
  for (const s of stages) {
    const arr = stagesByOrder.get(s.orderId) ?? [];
    arr.push({ stageKey: s.stageKey, stageSeq: s.stageSeq, status: s.status });
    stagesByOrder.set(s.orderId, arr);
  }
  const items: ProductionBoardItem[] = orders.map(o => {
    const orderStages = stagesByOrder.get(o.id) ?? [];
    const current = orderStages.find(s => s.status !== 'done') ?? null;
    const { lines, ...order } = o;
    const quantitySummary = summarizeOrderQuantity({
      activeOrderLines: lines.map(line => ({ quantity: line.quantity.toString(), unit: line.unit })),
      legacyQuantity: o.quantity?.toString() ?? null,
      legacyUnit: o.unit,
    });
    return {
      order: { ...order, quantity: quantitySummary.quantity, unit: quantitySummary.unit, quantitySummary },
      stages: orderStages,
      currentStageKey: current?.stageKey ?? null,
      blockedCount: orderStages.filter(s => s.status === 'blocked').length,
    };
  });
  return { items };
}

export async function getProductionPipeline(prisma: PrismaClient, orderId: string) {
  const stages = await prisma.productionStage.findMany({
    where: { orderId },
    orderBy: { stageSeq: 'asc' },
  });
  const checklist = await prisma.preCutChecklist.findUnique({ where: { orderId } });
  // Phase B4：终期验货报告是 qc_shipped 门禁判据；inspections 返回全部类型报告
  const inspections = await prisma.inspectionReport.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
  const inspection = await latestCurrentWholeFinal(prisma, orderId);

  // 阶段 D / D5：外协只读区块 — 直接查表（production 不反向依赖 mes 服务）。
  // 跟单员在生产跟进视图可见外协进度：加工厂/工序/数量/验收/交期。
  const outsourcingRows = await prisma.outsourcingOrder.findMany({
    where: { orderId, deletedAt: null },
    select: {
      id: true, orderNumber: true, supplierId: true, processType: true, status: true,
      quantity: true, unit: true, plannedDeliveryDate: true, actualDeliveryDate: true,
      qualityAcceptedQty: true, qualityRejectedQty: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const supplierIds = [...new Set(outsourcingRows.map(o => o.supplierId).filter(Boolean))] as string[];
  const supplierRows = supplierIds.length
    ? await prisma.relation.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
    : [];
  const supplierNameById = new Map(supplierRows.map(r => [r.id, r.name]));
  const outsourcing = outsourcingRows.map(o => ({
    ...o,
    supplierName: o.supplierId ? supplierNameById.get(o.supplierId) ?? null : null,
    quantity: Number(o.quantity),
    qualityAcceptedQty: Number(o.qualityAcceptedQty),
    qualityRejectedQty: Number(o.qualityRejectedQty),
  }));

  const serializeInspection = (r: any) => ({
    ...r,
    passRate: passRate(r.totalUnits, r.passedUnits),
    defectRate: defectRate(r.totalUnits, r.passedUnits),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    approvedAt: r.approvedAt ? Number(r.approvedAt) : null,
  });

  return {
    stages: stages.map(s => ({
      ...s,
      createdAt: Number(s.createdAt),
      updatedAt: Number(s.updatedAt),
      startedAt: s.startedAt ? Number(s.startedAt) : null,
      doneAt: s.doneAt ? Number(s.doneAt) : null,
    })),
    checklist: checklist ? {
      ...checklist,
      createdAt: Number(checklist.createdAt),
      updatedAt: Number(checklist.updatedAt),
      confirmedAt: checklist.confirmedAt ? Number(checklist.confirmedAt) : null,
    } : null,
    inspection: inspection ? serializeInspection(inspection) : null,
    inspections: inspections.map(serializeInspection),
    outsourcing,
  };
}

export interface AdvanceStageParams {
  prisma: PrismaClient;
  orderId: string;
  stageKey: StageKey;
  operator?: string;
  note?: string;
  /** §10.3/§10.7：老板特批（PP 门禁拦截时 owner 强制推进；route 层校验角色并写审计） */
  ownerOverride?: { reason: string };
}

export async function advanceStage(params: AdvanceStageParams): Promise<
  { ok: true; data: { stage: any; auditId: string } } | { ok: false; error: { code: StageGateErrorCode; message: string } }
> {
  const { prisma, orderId, stageKey, operator, note } = params;

  if (!STAGE_MAP.has(stageKey)) {
    return { ok: false, error: { code: 'INVALID_STAGE', message: `工序「${stageKey}」不合法，请从工序列表里选择后再操作。` } };
  }
  const requestedStageLabel = STAGE_MAP.get(stageKey)!.label;

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const controlledRelease = stageKey === 'pp_sample_approved' || stageKey === 'manufacturing';
      const sourceLocks = controlledRelease ? await lockOrderReleaseSources(tx, orderId) : null;
      const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) {
        throw new StageGateError('ORDER_NOT_FOUND', '订单不存在或已被删除，请刷新订单列表后重试。');
      }

      const stage = await tx.productionStage.findUnique({
        where: { orderId_stageKey: { orderId, stageKey } },
      });
      if (!stage) {
        throw new StageGateError('INVALID_STAGE', `工序「${requestedStageLabel}」尚未初始化，请先在订单生产面板初始化工序后再推进。`);
      }
      if (stage.status === 'done') {
        throw new StageGateError('STAGE_NOT_SEQUENTIAL', `工序「${requestedStageLabel}」已经完成，无需重复推进。`);
      }
      // P2：blocked 阶段不可直接推进——否则绕过 setStageBlocked 的留痕语义
      // （阻塞是跟单员显式登记的异常态，解除必须走 unblock 留痕路径）
      if (stage.status === 'blocked') {
        throw new StageGateError('STAGE_BLOCKED', `工序「${requestedStageLabel}」已被标记阻塞，请先在看板解除阻塞后再推进，系统会记录解除操作。`);
      }

      const prevStages = await tx.productionStage.findMany({
        where: { orderId, stageSeq: { lt: stage.stageSeq } },
        orderBy: { stageSeq: 'asc' },
      });
      const incompletePrev = prevStages.find((s: any) => s.status !== 'done');
      if (incompletePrev) {
        const previousLabel = PRODUCTION_STAGES.find(item => item.key === incompletePrev.stageKey)?.label ?? '前序工序';
        throw new StageGateError('STAGE_NOT_SEQUENTIAL', `上一道工序「${previousLabel}」还没完成，按生产顺序不能先推进本道工序。`);
      }

      if (stageKey === 'pre_cut_checked') {
        const checklist = await tx.preCutChecklist.findUnique({ where: { orderId } });
        if (!checklist) {
          throw new StageGateError('PRECUT_CHECKLIST_INCOMPLETE', '还没有填写裁剪前检查单，请先完成检查单再推进工序。');
        }
        if (!checklist.gradingConfirmed || !checklist.consumptionConfirmed || !checklist.patternConfirmed || !checklist.preProductionMeeting) {
          const missing: string[] = [];
          if (!checklist.gradingConfirmed) missing.push('推码确认');
          if (!checklist.consumptionConfirmed) missing.push('耗料确认');
          if (!checklist.patternConfirmed) missing.push('样板确认');
          if (!checklist.preProductionMeeting) missing.push('产前会议');
          throw new StageGateError('PRECUT_CHECKLIST_INCOMPLETE', `裁剪前检查未完成: ${missing.join('、')}`);
        }
      }

      if (controlledRelease) {
        const invalidation = await invalidateCurrentReleaseSourcesInTx(tx, orderId, operator || 'api', sourceLocks?.failedSources);
        const summary = await summarizeOrderReleases({ prisma: tx, orderId });
        if (!summary.ok) throw new StageGateError('PP_RELEASE_BLOCKED', '当前放行范围无法核验，请核对原批准来源');
        if (summary.data.hasScopeHistory && summary.data.total === 0) {
          return { blockedReason: '原放行范围已退出当前适用集合，请按真实当前批次重新送审；历史双签不能恢复旧范围' };
        }
        // This explicit blocked outcome commits only append-only invalidation
        // facts. Throwing here would roll those facts back. No stage/event write.
        if ((sourceLocks?.failedSources.length && summary.data.ready === 0) || (invalidation.lineReasons.length && summary.data.total === 0)
          || (summary.data.total > 0 && summary.data.ready === 0 && invalidation.invalidated.length > 0)) {
          return { blockedReason: sourceLocks?.failedSources[0]?.reason || invalidation.lineReasons[0] || '原放行来源已失效，请按本轮有效成果重新送审；老板特批不能恢复已失效批色' };
        }
        if (summary.data.total > 0 && summary.data.ready === 0) {
          // Administrative override remains compatible for no_release scopes,
          // but cannot revive invalidated/revoked/paused or stale ready evidence.
          const scopes = await tx.releaseScope.findMany({ where: { orderId, deletedAt: null } });
          if (scopes.some((scope: any) => ['invalidated', 'revoked', 'paused', 'ready'].includes(scope.state))) {
            return { blockedReason: '当前没有有效放行依据，请重新核对失效或暂停范围；老板特批不能恢复原批准' };
          }
        }
      }

      if (stageKey === 'pp_sample_approved') {
        // DR-053 阶段 2（§14.1.3）：订单级阶段=汇总视图（ready/partial/blocked）。
        // 有放行范围时不再强制订单级双签——至少一个 scope ready 即可推进（partial 允许已放行
        // 行继续，不阻塞无关行）；blocked（无任何 ready）阻断。历史订单级双签仅保留兼容路径。
        const summary = await summarizeOrderReleases({ prisma: tx, orderId });
        if (summary?.ok && summary.data.total > 0) {
          if (summary.data.summary === 'blocked' && !params.ownerOverride) {
            throw new StageGateError('PP_RELEASE_BLOCKED', `无任何放行范围 ready（${summary.data.ready}/${summary.data.total}），请按订单行/批次完成放行（急单可由老板特批）`);
          }
        } else if (!stage.signedByBusiness && !stage.signedByProduction && !params.ownerOverride) {
          // §10.7 P-3 单签口径（2026-09-12）：领导单签即放行；历史双签数据仍通过；
          // 无签时须领导签字，或老板特批越过（ownerOverride，route 层校验角色并审计）
          throw new StageGateError('PP_SAMPLE_NOT_SIGNED', '产前样放行未完成：缺少领导签字（可在订单生产面板发起放行并由领导签署，或由老板特批）');
        }
      }

      // DR-053 阶段 2（§14.1.4 执行前重验）：推进到「生产过程」（开裁/投产受控动作）时，
      // 重新评估本订单全部放行范围的资格——无任何 ready 范围则阻断整单投产（不可仅凭历史
      // 双签跳过）；至少一个 ready 允许推进（已放行行先产，未放行行由 scope 级继续控制）。
      if (stageKey === 'manufacturing') {
        const summary = await summarizeOrderReleases({ prisma: tx, orderId });
        if (summary?.ok && summary.data.total > 0 && summary.data.ready === 0 && !params.ownerOverride) {
          throw new StageGateError('PP_RELEASE_BLOCKED', `无任何放行范围可投产（ready ${0}/${summary.data.total}），请先完成放行（急单可由老板特批）`);
        }
      }

      if (stageKey === 'qc_shipped') {
        // Phase B4：门禁仅认终期验货（final）报告
        // D8：放行判定走 assessInspectionRelease 统一口径（与 QC 出运资格同一真源）；
        // failures 顺序与原逐条检查一致，failures[0] 保持原抛错语义与消息
        const inspection = await latestCurrentWholeFinal(tx, orderId);
        const release = assessInspectionRelease(inspection);
        if (!release.qualified) {
          const first = release.failures[0];
          throw new StageGateError(first.code, first.message);
        }
      }

      const now = BigInt(Date.now());
      // P2 in_progress 口径统一：完成阶段时回填 startedAt（直推阶段此前 startedAt 恒空，
      // done 无起点与状态机矛盾），并把下一阶段 pending → in_progress——
      // 运行时状态机真实产生 in_progress（与 seed 直写口径一致，消除三方不一致）；
      // blocked 阶段不覆盖（阻塞态优先，解除时按 startedAt 恢复）
      const updated = await tx.productionStage.update({
        where: { id: stage.id },
        data: { status: 'done', doneAt: now, startedAt: stage.startedAt ?? now, operator: operator || null, note: note || stage.note, updatedAt: now },
      });

      const nextStage = await tx.productionStage.findFirst({
        where: { orderId, stageSeq: stage.stageSeq + 1 },
      });
      if (nextStage && nextStage.status === 'pending') {
        await tx.productionStage.update({
          where: { id: nextStage.id },
          data: { status: 'in_progress', startedAt: nextStage.startedAt ?? now, updatedAt: now },
        });
      }

      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: operator || 'api',
        source: 'route:production:advance',
        operation: 'advance_production_stage',
        targetType: 'ProductionStage',
        targetId: stage.id,
        before: { status: stage.status },
        after: { status: 'done', stageKey },
      });

      return {
        stage: {
          ...updated,
          createdAt: Number(updated.createdAt),
          updatedAt: Number(updated.updatedAt),
          doneAt: updated.doneAt ? Number(updated.doneAt) : null,
        },
        auditId,
      };
    });

    if (result.blockedReason !== undefined) return { ok: false, error: { code: 'PP_RELEASE_BLOCKED', message: result.blockedReason } };

    // Phase 0 Sprint 1: 生产阶段推进事件（事务提交后发布，fire-and-forget）
    // - ProductionStageAdvanced：每次阶段完成都发布
    // - ProductionCompleted：qc_shipped 阶段（第 10 阶段，最终验货发货）完成时发布
    //   用于 Phase 1 Sprint 3 触发自动创建发货单联动
    const stageLabel = STAGE_MAP.get(stageKey)?.label || stageKey;
    publishBusinessEvent({
      type: 'ProductionStageAdvanced',
      sourceEntityType: 'ProductionStage',
      sourceEntityId: result.stage.id,
      orderId,
      payload: { stageKey, stageLabel, operator: operator || 'api', auditId: result.auditId },
      actorId: operator || 'api',
      transactionId: result.auditId,
    }).catch(() => { /* event publish failure must not fail business */ });

    if (stageKey === 'qc_shipped') {
      publishBusinessEvent({
        type: 'ProductionCompleted',
        sourceEntityType: 'ProductionStage',
        sourceEntityId: result.stage.id,
        orderId,
        payload: { stageKey, stageLabel, completedAt: Number(result.stage.doneAt), auditId: result.auditId },
        actorId: operator || 'api',
        transactionId: result.auditId,
      }).catch(() => { /* event publish failure must not fail business */ });
    }
    return { ok: true, data: result };
  } catch (e: any) {
    // 业务门禁拒绝一律原样透传（错误码决定 HTTP 状态：如 PP_RELEASE_BLOCKED → 422），
    // 其余（事务/DB/意外）统一收敛为 STAGE_UPDATE_FAILED(500)。
    if (e instanceof StageGateError) {
      return { ok: false, error: { code: e.code as StageGateErrorCode, message: e.message } };
    }
    if (e instanceof DevelopmentDomainError && e.code === 'CONFLICT') {
      return { ok: false, error: { code: 'CONFLICT', message: '订单或确认来源并发变化，请保留原请求并刷新重试' } };
    }
    logger.error('[StageService] stage mutation failed', { error: e?.message ?? String(e), code: e?.code });
    return { ok: false, error: { code: 'STAGE_UPDATE_FAILED', message: '推进失败：系统内部错误，请稍后重试或联系管理员' } };
  }
}

export type StageBlockErrorCode =
  | 'ORDER_NOT_FOUND'
  | 'INVALID_STAGE'
  | 'STAGE_NOT_BLOCKABLE'
  | 'STAGE_UPDATE_FAILED';

export interface SetStageBlockedParams {
  prisma: PrismaClient;
  orderId: string;
  stageKey: StageKey;
  blocked: boolean;
  operator?: string;
  note?: string;
}

/**
 * C18 看板阻塞标记：阶段 ⇄ blocked 状态写入路径。
 * schema ProductionStage.status 注释口径 pending | in_progress | done | blocked，
 * 此前仅看板聚合（getProductionBoard blockedCount）消费 blocked，无写入入口。
 * 规则：
 *   - done 阶段不可标记阻塞（已完成即事实，阻塞语义不成立）；
 *   - 目标状态与当前一致 → 幂等放行（看板双击/重试不产生审计噪音）；
 *   - 解除阻塞按 startedAt 恢复：已启动过的阶段回 in_progress（advanceStage 推进时
 *     自动置入，P2 口径统一后 in_progress 有真实写入方），未启动的回 pending。
 */
export async function setStageBlocked(params: SetStageBlockedParams): Promise<
  { ok: true; data: { stage: any } } | { ok: false; error: { code: StageBlockErrorCode; message: string } }
> {
  const { prisma, orderId, stageKey, blocked, operator, note } = params;
  if (!STAGE_MAP.has(stageKey)) {
    return { ok: false, error: { code: 'INVALID_STAGE', message: `工序「${stageKey}」不合法，请从工序列表里选择后再操作。` } };
  }
  const stageLabel = STAGE_MAP.get(stageKey)!.label;
  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) {
        throw new StageGateError('ORDER_NOT_FOUND', '订单不存在或已被删除，请刷新订单列表后重试。');
      }
      const stage = await tx.productionStage.findUnique({
        where: { orderId_stageKey: { orderId, stageKey } },
      });
      if (!stage) {
        throw new StageGateError('INVALID_STAGE', `工序「${stageLabel}」尚未初始化，请先在订单生产面板初始化工序后再推进。`);
      }
      if (stage.status === 'done') {
        throw new StageGateError('STAGE_NOT_BLOCKABLE', `工序「${stageLabel}」已完成，不可标记或解除阻塞。`);
      }
      // 幂等：目标状态与当前一致 → 直接返回，不写库不记审计
      if ((blocked && stage.status === 'blocked') || (!blocked && stage.status !== 'blocked')) {
        return stage;
      }
      const now = BigInt(Date.now());
      // 解除阻塞的恢复态：已启动（startedAt 非空）→ in_progress；未启动 → pending
      const restoreStatus = blocked ? 'blocked' : (stage.startedAt != null ? 'in_progress' : 'pending');
      const updated = await tx.productionStage.update({
        where: { id: stage.id },
        data: {
          status: restoreStatus,
          operator: operator || null,
          note: note || stage.note,
          updatedAt: now,
        },
      });
      await writeRouteAuditLog({
        prisma: tx,
        actorId: operator || 'api',
        source: 'route:production:block',
        operation: blocked ? 'block_production_stage' : 'unblock_production_stage',
        targetType: 'ProductionStage',
        targetId: stage.id,
        before: { status: stage.status },
        after: { status: restoreStatus, stageKey },
      });
      return updated;
    });
    return {
      ok: true,
      data: {
        stage: {
          ...result,
          createdAt: Number(result.createdAt),
          updatedAt: Number(result.updatedAt),
          startedAt: result.startedAt ? Number(result.startedAt) : null,
          doneAt: result.doneAt ? Number(result.doneAt) : null,
        },
      },
    };
  } catch (e: any) {
    if (e instanceof StageGateError) {
      return { ok: false, error: { code: e.code as StageBlockErrorCode, message: e.message } };
    }
    logger.error('[StageService] stage mutation failed', { error: e?.message ?? String(e), code: e?.code });
    return { ok: false, error: { code: 'STAGE_UPDATE_FAILED', message: '推进失败：系统内部错误，请稍后重试或联系管理员' } };
  }
}

export async function savePreCutChecklist(prisma: PrismaClient, orderId: string, data: {
  gradingConfirmed?: boolean;
  consumptionConfirmed?: boolean;
  patternConfirmed?: boolean;
  preProductionMeeting?: boolean;
  meetingNote?: string;
  confirmedBy?: string;
}): Promise<any> {
  const now = BigInt(Date.now());
  const result = await prisma.preCutChecklist.upsert({
    where: { orderId },
    create: {
      id: `PCL__${orderId}`,
      orderId,
      gradingConfirmed: data.gradingConfirmed ?? false,
      consumptionConfirmed: data.consumptionConfirmed ?? false,
      patternConfirmed: data.patternConfirmed ?? false,
      preProductionMeeting: data.preProductionMeeting ?? false,
      meetingNote: data.meetingNote || null,
      confirmedBy: data.confirmedBy || null,
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...(data.gradingConfirmed !== undefined ? { gradingConfirmed: data.gradingConfirmed } : {}),
      ...(data.consumptionConfirmed !== undefined ? { consumptionConfirmed: data.consumptionConfirmed } : {}),
      ...(data.patternConfirmed !== undefined ? { patternConfirmed: data.patternConfirmed } : {}),
      ...(data.preProductionMeeting !== undefined ? { preProductionMeeting: data.preProductionMeeting } : {}),
      ...(data.meetingNote !== undefined ? { meetingNote: data.meetingNote } : {}),
      ...(data.confirmedBy !== undefined ? { confirmedBy: data.confirmedBy, confirmedAt: now } : {}),
      updatedAt: now,
    },
  });
  return { ...result, createdAt: Number(result.createdAt), updatedAt: Number(result.updatedAt), confirmedAt: result.confirmedAt ? Number(result.confirmedAt) : null };
}

export const INSPECTION_TYPES = ['midline', 'final'] as const;
export type InspectionType = typeof INSPECTION_TYPES[number];

export async function saveInspectionReport(prisma: PrismaClient, orderId: string, data: {
  inspectionType?: string;
  totalUnits?: number;
  passedUnits?: number;
  inspectionDate?: string;
  inspectorOrg?: string;
  aqlLevel?: string;
  lotSize?: number;
  sampleSize?: number;
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  result?: string;
  shipmentId?: string;
  reportFile?: string;
  inspectedBy?: string;
  approvedByBusiness?: boolean;
  businessApprover?: string;
  notes?: string;
}, trustedActor?: TokenPayload | null): Promise<any> {
  const inspectionType: InspectionType = data.inspectionType === 'midline' ? 'midline' : 'final';
  if (data.result !== undefined && data.result !== null && !['pass', 'conditional', 'fail'].includes(data.result)) {
    throw new StageGateError('INVALID_RESULT', `非法验货结论: ${data.result}`);
  }
  const auditSnapshot = (value: any) => JSON.parse(JSON.stringify(value,
    (_key, item) => typeof item === 'bigint' ? item.toString() : item));
  const { order, previous, result, actualActor } = await prisma.$transaction(async tx => {
    // Preflight protects parent IDs. Final authorization is reloaded after all
    // source/parent/report locks, under ReadCommitted, never the JWT/body alone.
    const authorize = async () => {
      try { return await qcReportOrderAccess(tx, trustedActor, orderId, 'qc:write'); }
      catch (error) {
        if (error instanceof QcReportError && error.code === 'NOT_FOUND')
          throw new StageGateError('ORDER_NOT_FOUND', '订单不存在、已删除或不在当前可操作范围。');
        throw error;
      }
    };
    await authorize();
    await lockQcCoverage(tx, orderId);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InspectionReport"
      WHERE "orderId" = ${orderId} AND "inspectionType" = ${inspectionType} AND "scopeKey" = 'whole_order'
      ORDER BY "id" FOR UPDATE`);
    const { actor, order } = await authorize();
    const submitted = data as typeof data & { approvedAt?: unknown; signatures?: unknown };
    if (data.inspectedBy != null && data.inspectedBy !== actor.userId)
      throw new StageGateError('VALIDATION_FAILED', '检查人固定为当前真实登录主体，不允许代填其他人。');
    if (data.approvedByBusiness === true || data.businessApprover != null || submitted.approvedAt != null || submitted.signatures != null)
      throw new StageGateError('VALIDATION_FAILED', '业务批准和签字须通过实际报告决定入口，不允许在验货录入中代填。');
    const history = await tx.inspectionReport.findMany({
      where: { orderId, inspectionType, scopeKey: 'whole_order' }, orderBy: { revision: 'asc' },
    });
    // A legacy PUT cannot mutate any immutable modern/signed/decided revision,
    // including the native first revision sharing the historical unique key.
    if (history.some(row => row.scopeFingerprint != null || row.contentFingerprint != null || row.commandHash != null
      || row.requestKey != null || row.supersedesId != null || row.revision !== 1
      || row.approvedByBusiness || row.businessApprover != null || row.approvedAt != null || row.signatures != null))
      throw new StageGateError('CONFLICT', '该验货报告已有当前范围、签字或业务决定，请通过原生复验建立新修订，原报告保留。');
    const previous = history.find(row => row.revision === 1) ?? null;
    const now = BigInt(Date.now());
    const id = inspectionType === 'final' ? `INR__${orderId}` : `INR__${orderId}__${inspectionType}`;
    const result = await tx.inspectionReport.upsert({
      where: { orderId_inspectionType_scopeKey_revision: { orderId, inspectionType, scopeKey: 'whole_order', revision: 1 } },
      create: {
        id,
        orderId,
        inspectionType,
        totalUnits: data.totalUnits ?? 0,
        passedUnits: data.passedUnits ?? 0,
        inspectionDate: data.inspectionDate || null,
        inspectorOrg: data.inspectorOrg || null,
        aqlLevel: data.aqlLevel || null,
        lotSize: data.lotSize ?? null,
        sampleSize: data.sampleSize ?? null,
        criticalDefects: data.criticalDefects ?? 0,
        majorDefects: data.majorDefects ?? 0,
        minorDefects: data.minorDefects ?? 0,
        defectSummary: data.defectSummary || null,
        result: data.result || null,
        shipmentId: data.shipmentId || null,
        reportFile: data.reportFile || null,
        inspectedBy: actor.userId,
        approvedByBusiness: false,
        businessApprover: null,
        approvedAt: null,
        notes: data.notes || null,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        ...(data.totalUnits !== undefined ? { totalUnits: data.totalUnits } : {}),
        ...(data.passedUnits !== undefined ? { passedUnits: data.passedUnits } : {}),
        ...(data.inspectionDate !== undefined ? { inspectionDate: data.inspectionDate || null } : {}),
        ...(data.inspectorOrg !== undefined ? { inspectorOrg: data.inspectorOrg || null } : {}),
        ...(data.aqlLevel !== undefined ? { aqlLevel: data.aqlLevel || null } : {}),
        ...(data.lotSize !== undefined ? { lotSize: data.lotSize } : {}),
        ...(data.sampleSize !== undefined ? { sampleSize: data.sampleSize } : {}),
        ...(data.criticalDefects !== undefined ? { criticalDefects: data.criticalDefects } : {}),
        ...(data.majorDefects !== undefined ? { majorDefects: data.majorDefects } : {}),
        ...(data.minorDefects !== undefined ? { minorDefects: data.minorDefects } : {}),
        ...(data.defectSummary !== undefined ? { defectSummary: data.defectSummary || null } : {}),
        ...(data.result !== undefined ? { result: data.result || null } : {}),
        ...(data.shipmentId !== undefined ? { shipmentId: data.shipmentId || null } : {}),
        ...(data.reportFile !== undefined ? { reportFile: data.reportFile } : {}),
        inspectedBy: actor.userId,
        ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
        updatedAt: now,
      },
    });
    await writeRouteAuditLog({ prisma: tx, actorId: actor.userId,
      source: 'route:production:inspection', operation: 'save_legacy_inspection_report',
      targetType: 'InspectionReport', targetId: result.id,
      before: previous == null ? null : auditSnapshot(previous),
      after: { report: auditSnapshot(result), actualActorId: actor.userId },
      operationType: previous == null ? 'create' : 'update' });
    return { order, previous, result, actualActor: actor };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  // H1c：验货结论 → 自动追加质量评分（幂等：同报告只评一次；无档案供应商静默跳过）
  // 评挂钩对象：订单的 millRelationId（面料厂/供应商身份真源在 Relation → FactoryProfile 1:1）
  if (result.result) {
    try {
      if (order.millRelationId) {
        const { createFactoryService, inspectionScoreForResult } = await import('../suppliers/factoryService');
        const factoryService = createFactoryService(prisma);
        const critical = result.criticalDefects ?? 0;
        const score = inspectionScoreForResult(result.result, critical);
        await factoryService.recordAutoEvaluation({
          relationId: order.millRelationId,
          kind: 'inspection',
          score,
          sourceType: 'inspectionReport',
          sourceId: result.id,
          evaluatedAt: result.inspectionDate || todayLocalKey(),
          note: `验货报告 ${result.id}（订单 ${order.poNumber || orderId}）结论 ${result.result}${critical > 0 ? `，致命疵点 ${critical}` : ''}`,
          actorId: actualActor.userId,
        });
      }
    } catch (e: any) {
      logger.warn('[StageService] inspection auto-evaluation failed (non-blocking)', { error: e?.message });
    }
  }

  // PRD 7.1「终期验货 fail」：结论迁移为非 fail → fail 瞬间广播 critical（QC + 业务员 + 管理层）
  // 状态迁移触发天然幂等：重复保存相同 fail 结论不再通知；整改后再次 fail 属新事件，重新通知
  if (inspectionType === 'final' && result.result === 'fail' && previous?.result !== 'fail') {
    try {
      const notificationService = createNotificationService(prisma);
      const label = order.poNumber || orderId;
      const critical = result.criticalDefects ?? 0;
      const major = result.majorDefects ?? 0;
      const minor = result.minorDefects ?? 0;
      await notificationService.broadcastNotification({
        type: 'inspection_fail',
        title: `订单 ${label} 终期验货不通过（critical=${critical}, major=${major}）`,
        body: `订单 ${label}（客户 ${order.customer ?? '未指定'}，产品 ${order.product ?? '未指定'}）终期验货结论为不合格：致命疵点 ${critical}、主要疵点 ${major}、次要疵点 ${minor}${result.defectSummary ? `，疵点摘要：${result.defectSummary}` : ''}。该订单出运门禁已锁定，需整改复验合格后方可放行。`,
        level: 'critical',
        link: `/production?orderId=${orderId}`,
        metadata: { entityType: 'InspectionReport', entityId: result.id, orderId, criticalDefects: critical, majorDefects: major, minorDefects: minor },
      });
    } catch (e: any) {
      logger.warn('[StageService] inspection fail notification failed (non-blocking)', { error: e?.message });
    }
  }

  return {
    ...result,
    passRate: passRate(result.totalUnits, result.passedUnits),
    defectRate: defectRate(result.totalUnits, result.passedUnits),
    createdAt: Number(result.createdAt),
    updatedAt: Number(result.updatedAt),
    approvedAt: result.approvedAt ? Number(result.approvedAt) : null,
  };
}

/**
 * 产前样双签（生产部 / 业务部各签一次）
 */
export async function signStage(params: {
  prisma: PrismaClient;
  orderId: string;
  stageKey: string;
  signType: 'production' | 'business';
  signerId: string;
}): Promise<any> {
  const { prisma, orderId, stageKey, signType, signerId } = params;
  const now = BigInt(Date.now());
  const stage = await prisma.productionStage.findUnique({
    where: { orderId_stageKey: { orderId, stageKey } },
  });
  if (!stage) {
    throw new StageGateError('INVALID_STAGE', `工序「${stageKey}」不存在，请刷新工序列表后重试；仍不行请联系生产主管核对工序配置。`);
  }

  const data: any = { updatedAt: now };
  if (signType === 'production') {
    data.signedByProduction = signerId;
    data.signedAtProduction = now;
  } else {
    data.signedByBusiness = signerId;
    data.signedAtBusiness = now;
  }

  const updated = await prisma.productionStage.update({
    where: { id: stage.id },
    data,
  });

  return {
    ...updated,
    signedAtProduction: updated.signedAtProduction ? Number(updated.signedAtProduction) : null,
    signedAtBusiness: updated.signedAtBusiness ? Number(updated.signedAtBusiness) : null,
    createdAt: Number(updated.createdAt),
    updatedAt: Number(updated.updatedAt),
    doneAt: updated.doneAt ? Number(updated.doneAt) : null,
  };
}
