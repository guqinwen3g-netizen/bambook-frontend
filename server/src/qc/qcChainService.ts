/**
 * qcChainService.ts — DR-029 服装/面料样品 QC 双链责任闭环 + DR-008 样品内部门禁
 *
 * 设计真源：
 *   - DR-029（服装链：工厂→QC→业务员→客户，每轮新样必须重新入 QC 评审后才可再寄；
 *            QC 对明显无法通过的批次可「直接打回工厂重做」（DIRECT_REJECT）——该批不得寄客户，
 *            系统通知业务员并生成工厂重做要求；面料链：业务员登记为主，客户不通过 →
 *            业务员转 QC → QC 向工厂提技术调整 → 工厂新样 → 业务员再寄客户）
 *   - DR-008（服装样品每轮先过 QC 内部评审才允许寄客户，fail-closed 内部门禁）
 *   - DR-027（面料订单前开发样/服装 FIT 开发样不进入 QC 门禁，业务员自行登记确认）
 *   - 订单与生产模型组.md §14.1/§14.2（样品类型 × InspectionReport 1:1 独立，
 *     每轮独立报告，不可跨轮复用/覆盖）
 *   - QcWorkbench 模块概述 §16（QC-29-A1~A5 / B1~B3 / QC-008-C1 验收场景）
 *
 * 模型约束（schema 冻结，本服务不改 schema）：
 *   - InspectionReport @@unique([orderId, inspectionType])：多轮样品报告通过
 *     inspectionType 携带轮次后缀隔离（sample_pp__r1 / fabric_ss__r2 …），
 *     报告主键确定性生成，同轮重复提交 → 409 拒绝覆盖（REL-14-A1 审计链保护）。
 *   - 链元数据（链别/轮次/disposition/打回原因/工厂调整要求）存 signatures JSONB
 *     chain 命名空间下，与 §9.3-② 双签字段（qcSignedAt 等平级键）共存互不覆盖。
 *   - 面料链报告回写样品记录 qcInspectionReportId（FabricShipmentSample /
 *     EarlyProductionSample 既有字段，DR-029 面料链设计关联位）。
 *
 * 与大货 QC 的边界（REL-14-A4）：终期/中期验货报告（inspectionType=final/midline）
 *   仍由 stageService.saveInspectionReport 承担；样品链报告与大货 Final QC 是两条
 *   独立记录，PP QC Pass 不可替代 Final QC。
 *
 * 权限边界（QC-29-B3）：路由层以 qc:garment_chain:write / qc:fabric_chain:write
 *   双 scope 隔离；服务层再做订单业务线链别校验（跨链订单 → INVALID_CHAIN_SCOPE）。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { assertGenericSampleMutationAllowed } from '../samples/orderSampleManagedGuard';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { safeRouteError } from '../shared/routeError';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createNotificationService } from '../notifications/notificationService';
import { logger } from '../lib/logger';
import type { TokenPayload } from '../auth/service';
import { currentQcAssignmentActor, QcAssignmentError } from './qcAssignmentAccess';
import { freshOrderLineScope, OrderLineWriteError } from '../orders/orderLineWriteAccess';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';

// ────────────────────────────────────────────────────────────────
// 常量与类型
// ────────────────────────────────────────────────────────────────

/** 服装链需 QC 内部门禁的样品级别（confirmation/FIT 开发样按 DR-027 排除） */
export const GARMENT_QC_SAMPLE_LEVELS = ['pp', 'top'] as const;
export type GarmentQcSampleLevel = (typeof GARMENT_QC_SAMPLE_LEVELS)[number];

/** 面料链可转 QC 的样品类型（S/S 船样 / RC 匹头样 / 投产后早期生产样） */
export const FABRIC_QC_SAMPLE_KINDS = ['SS', 'RC', 'EARLY_PRODUCTION'] as const;
export type FabricQcSampleKind = (typeof FABRIC_QC_SAMPLE_KINDS)[number];

/** 链评审结论处置 */
export const CHAIN_DISPOSITIONS = ['STANDARD', 'DIRECT_REJECT', 'REQUIRES_FACTORY_TECH_ADJUST'] as const;
export type ChainDisposition = (typeof CHAIN_DISPOSITIONS)[number];

/** DR-027 开发样类型（不进入 QC 门禁；大小写与连字符变体归一） */
export const DEVELOPMENT_SAMPLE_TYPES = [
  'handloom', 'pioneer', 'lab-dip', 'labdip', 'strike-off', 'strikeoff',
  'fit', 'fit-sample', 'confirmation', 'development', 'dev',
] as const;

const SAMPLE_CONCLUSIONS = ['pass', 'conditional', 'fail'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ChainResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

function ok<T>(data: T): ChainResult<T> {
  return { ok: true, data };
}
function fail<T>(code: string, message: string, status = 400): ChainResult<T> {
  return { ok: false, error: { code, message, status } };
}

// ────────────────────────────────────────────────────────────────
// 纯函数辅助（导出供 qcService / 样品域复用，避免跨轨重复实现）
// ────────────────────────────────────────────────────────────────

/** DR-027：开发样类型判定（归一化大小写/下划线/空格后比对） */
export function isDevelopmentSampleType(sampleType?: string | null): boolean {
  if (!sampleType) return false;
  const norm = String(sampleType).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const compact = norm.replace(/-/g, '');
  return (DEVELOPMENT_SAMPLE_TYPES as readonly string[]).some(
    (t) => t === norm || t.replace(/-/g, '') === compact,
  );
}

/** 面料订单判定：businessLine='fabric' 或 type='Fabric'（与样品域口径一致） */
export function isFabricChainOrder(order: any): boolean {
  return qcOrderInspectionScope(order) === 'qc:fabric_chain:write';
}

/**
 * 服装订单判定：businessLine ∈ {garment, capsule}（capsule 为 Garment 子类型），
 * 或 type ∈ {garment, apparel}（apparel 为 order_type 字典合法值——此前仅认 garment，
 * type-only 服装订单会被出运门禁误分派到 other 链绕过 Final QC，属门禁旁路，已收敛口径）
 */
export function isGarmentChainOrder(order: any): boolean {
  return qcOrderInspectionScope(order) === 'qc:garment_chain:write';
}

/** 样品链 inspectionType 判定与解析（final/midline 大货报告不属于样品链） */
export function parseChainInspectionType(
  inspectionType: string | null | undefined,
): { chain: 'garment' | 'fabric'; sampleKind: string; round: number } | null {
  if (!inspectionType) return null;
  const m = /^(sample|fabric)_([a-z]+(?:_[a-z]+)*)__r(\d+)$/.exec(inspectionType);
  if (!m) return null;
  return {
    chain: m[1] === 'sample' ? 'garment' : 'fabric',
    sampleKind: m[2],
    round: Number(m[3]),
  };
}

function garmentReportId(orderId: string, level: string, round: number): string {
  return `INR__${orderId}__smp__${level}__r${round}`;
}
function garmentInspectionType(level: string, round: number): string {
  return `sample_${level}__r${round}`;
}
function fabricReportIdPrefix(orderId: string, sampleId: string): string {
  return `INR__${orderId}__fqc__${sampleId}__`;
}
function fabricInspectionType(kind: FabricQcSampleKind, seq: number): string {
  return `fabric_${kind.toLowerCase()}__r${seq}`;
}

function normalizeDefectCount(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  void field;
  return n;
}

// ────────────────────────────────────────────────────────────────
// 输入类型
// ────────────────────────────────────────────────────────────────

export interface GarmentSampleReviewInput {
  sampleLevel?: string;           // pp | top（默认 pp）
  round?: number;                 // 样品轮次（>=1；客户不通过工厂重做后 round+1）
  conclusion?: string;            // pass | conditional | fail（QC 内部评审结论）
  opinion?: string;               // QC 文本评审意见（DR-029：不得压缩为机械二值）
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  evidence?: unknown[];           // 照片/文件证据引用
  inspectionDate?: string;        // YYYY-MM-DD
  directReject?: boolean;         // QC-29-A4：直接打回工厂重做（明确评审结论，非隐藏状态修改）
  rejectReason?: string;          // directReject=true 时必填
}

export interface FabricSampleReviewInput {
  sampleKind?: string;            // SS | RC | EARLY_PRODUCTION
  sampleId?: string;              // FabricShipmentSample.id / EarlyProductionSample.id
  conclusion?: string;            // pass | conditional | fail
  opinion?: string;               // QC 专业意见（对工厂的技术调整说明）
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string;
  evidence?: unknown[];
  inspectionDate?: string;
  /** QC 向工厂提出的技术调整要求（DR-029 面料链；conclusion≠pass 时 requirement 必填） */
  factoryAdjustment?: {
    requirement?: string;         // 调整要求（染整/后整理/修布等）
    parameters?: unknown;         // 调整参数快照
    factoryName?: string;         // 责任工厂
    followUpBy?: string;          // 跟进人
    evidence?: unknown[];         // 证据
  };
}

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

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createQcChainService(prisma: PrismaClient) {
  const nowMs = () => Date.now();

  async function authorizeProfessionalReview(tx: any, params: { orderId: string; actorId: string; trustedActor?: TokenPayload },
    chainScope: 'qc:fabric_chain:write' | 'qc:garment_chain:write') {
    if (!params.trustedActor?.userId || params.trustedActor.userId !== params.actorId) {
      throw new QcAssignmentError('UNAUTHORIZED', '样品专业评审需要有效的当前用户主体。');
    }
    await currentQcAssignmentActor(tx, params.trustedActor, 'qc:inspect');
    const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${params.orderId} FOR UPDATE`);
    if (!locked.length) throw new QcAssignmentError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
    const actor = await currentQcAssignmentActor(tx, params.trustedActor, 'qc:inspect');
    if (!hasActualQcScope(actor, chainScope)) throw new QcAssignmentError('FORBIDDEN', '当前账号没有该业务线的专业 QC 评审权限。');
    const scope = await freshOrderLineScope(tx, actor);
    const source = await tx.order.findFirst({ where: { id: params.orderId, deletedAt: null, AND: [scope] } });
    if (!source) throw new QcAssignmentError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
    if (qcOrderInspectionScope(source) !== chainScope) throw new QcAssignmentError('CONFLICT', '订单业务线已变化，请重新读取实际来源。');
    return actor;
  }

  async function loadOrder(orderId: string): Promise<any | null> {
    if (!orderId) return null;
    const order = await (prisma as any).order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt !== null) return null;
    return order;
  }

  // ══════════════════════════════════════════════════════════════
  // 1. 服装链 QC 评审（DR-029 服装链 + DR-008 内部门禁 + QC-29-A4 直接打回）
  // ══════════════════════════════════════════════════════════════

  async function reviewGarmentSample(params: {
    orderId: string;
    input: GarmentSampleReviewInput;
    actorId: string;
    trustedActor?: TokenPayload;
    ip?: string | null;
  }): Promise<ChainResult<{ report: any; gate: GarmentSampleGate | null }>> {
    const { orderId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!orderId) return fail('INVALID_INPUT', 'orderId 必填');

    const order = await loadOrder(orderId);
    if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);
    if (!isGarmentChainOrder(order)) {
      return fail('INVALID_CHAIN_SCOPE', `订单 ${orderId} 不属于服装链，服装样品 QC 评审仅适用于服装订单（DR-029 强制边界）`);
    }

    const sampleLevel = String(input.sampleLevel ?? 'pp').trim().toLowerCase();
    // DR-027 / 模型组 §14.1：开发样（FIT/confirmation 等）不进入 QC 门禁
    if (isDevelopmentSampleType(sampleLevel)) {
      return fail('DEV_SAMPLE_EXCLUDED', '开发样不进入 QC 门禁（DR-027）：由业务员自行登记寄送与客户确认');
    }
    if (!(GARMENT_QC_SAMPLE_LEVELS as readonly string[]).includes(sampleLevel)) {
      return fail('INVALID_INPUT', `sampleLevel 仅允许 ${GARMENT_QC_SAMPLE_LEVELS.join(' | ')}（服装链 QC 样品级别）`);
    }

    const round = Number(input.round);
    if (!Number.isInteger(round) || round < 1) return fail('INVALID_INPUT', 'round 必须是 >=1 的整数（样品轮次）');

    const conclusion = String(input.conclusion ?? '').trim().toLowerCase();
    if (!(SAMPLE_CONCLUSIONS as readonly string[]).includes(conclusion)) {
      return fail('INVALID_INPUT', `conclusion 必须是 ${SAMPLE_CONCLUSIONS.join(' | ')}（QC 内部评审结论）`);
    }

    const opinion = String(input.opinion ?? '').trim();
    if (!opinion) return fail('INVALID_INPUT', 'opinion（QC 文本评审意见）必填：评审结论不得压缩为机械二值（DR-029）');

    const critical = normalizeDefectCount(input.criticalDefects, 'criticalDefects');
    const major = normalizeDefectCount(input.majorDefects, 'majorDefects');
    const minor = normalizeDefectCount(input.minorDefects, 'minorDefects');
    if (critical === null || major === null || minor === null) {
      return fail('INVALID_INPUT', 'criticalDefects/majorDefects/minorDefects 必须是 >=0 的整数');
    }
    if (input.inspectionDate !== undefined && input.inspectionDate !== '' && !DATE_RE.test(input.inspectionDate)) {
      return fail('INVALID_INPUT', 'inspectionDate 格式须为 YYYY-MM-DD');
    }

    const directReject = input.directReject === true;
    const rejectReason = String(input.rejectReason ?? '').trim();
    if (directReject && !rejectReason) {
      return fail('REJECT_REASON_REQUIRED', '直接打回工厂重做必须填写 rejectReason（打回原因须对业务员与工厂可追溯，QC-29-A4）');
    }

    const reportId = garmentReportId(orderId, sampleLevel, round);
    const inspectionType = garmentInspectionType(sampleLevel, round);
    // REL-14-A1：每轮样品 = 1 条独立报告；同轮重复提交拒绝覆盖（保护审计链）
    const existing = await (prisma as any).inspectionReport.findUnique({ where: { id: reportId } });
    if (existing) {
      return fail(
        'ROUND_ALREADY_REVIEWED',
        `订单 ${orderId} 第 ${round} 轮 ${sampleLevel} 样品已有 QC 评审报告（${reportId}）；每轮报告独立不可覆盖（REL-14-A1），如需复验请提交新一轮`,
        409,
      );
    }

    const disposition: ChainDisposition = directReject ? 'DIRECT_REJECT' : 'STANDARD';
    const ts = nowMs();
    const chainMeta: Record<string, unknown> = {
      chain: 'garment',
      sampleLevel,
      round,
      disposition,
      qcReviewerId: actorId,
      qcReviewedAt: ts,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      ...(directReject
        ? {
            rejectReason,
            factoryRework: {
              required: true,
              reason: rejectReason,
              issuedBy: actorId,
              issuedAt: ts,
              status: 'pending', // 工厂重做中 → 新一轮报告创建后由 round 链体现进度
            },
          }
        : {}),
    };

    try {
      const report = await (prisma as any).$transaction(async (tx: any) => {
        await authorizeProfessionalReview(tx, params, 'qc:garment_chain:write');
        const created = await tx.inspectionReport.create({
          data: {
            id: reportId,
            orderId,
            inspectionType,
            totalUnits: 0,
            passedUnits: 0,
            inspectionDate: input.inspectionDate || null,
            inspectorOrg: '自有 QC',
            criticalDefects: critical,
            majorDefects: major,
            minorDefects: minor,
            defectSummary: input.defectSummary || null,
            result: conclusion,
            inspectedBy: actorId,
            notes: opinion,
            signatures: { chain: chainMeta },
            createdAt: BigInt(ts),
            updatedAt: BigInt(ts),
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:qc:chain:garment',
          operation: directReject ? 'garment_sample_direct_reject' : 'garment_sample_review',
          targetType: 'InspectionReport',
          targetId: created.id,
          after: {
            id: created.id,
            orderId,
            inspectionType,
            round,
            sampleLevel,
            conclusion,
            disposition,
            criticalDefects: critical,
            majorDefects: major,
            minorDefects: minor,
            ...(directReject ? { rejectReason } : {}),
          },
          ip: ip ?? null,
        });
        return created;
      });

      // QC-29-A4：直接打回必须通知业务员（通知失败不阻断业务，报告与审计已落库）
      if (directReject && order.ownerId) {
        try {
          const notificationService = createNotificationService(prisma);
          const label = order.poNumber || orderId;
          await notificationService.sendToUser({
            userId: order.ownerId,
            type: 'qc_sample_direct_reject',
            title: `订单 ${label} 第 ${round} 轮${sampleLevel === 'pp' ? '产前样' : '大货样'}被 QC 直接打回`,
            body: `QC 评审结论为直接打回工厂重做（DIRECT_REJECT）：${rejectReason}。该批样品不得寄客户；工厂重做后的新批样品必须重新进入 QC 评审（DR-029）。`,
            level: 'warning',
            link: `/qc-workbench?orderId=${orderId}`,
            metadata: {
              entityType: 'InspectionReport',
              entityId: report.id,
              orderId,
              sampleLevel,
              round,
              disposition: 'DIRECT_REJECT',
              rejectReason,
            },
          });
        } catch (e: any) {
          logger.warn('[QcChainService] direct-reject notification failed (non-blocking)', { error: e?.message, reportId });
        }
      }

      logger.info('[QcChainService] garment sample reviewed', { reportId, orderId, sampleLevel, round, conclusion, disposition, actorId });
      const gate = await getGarmentSampleGate({ orderId, sampleLevel, round });
      return ok({ report, gate: gate.ok ? gate.data.gate : null });
    } catch (e: any) {
      // B39（D51）：本文件原先只有 logger.info/warn、**没有 logger.error** ⇒ 先补日志，再换文案。
      // ★ 本处**不敢承诺写入状态**：这个 catch 覆盖到事务**之后**的 `getGarmentSampleGate` 读
      //   （`:377`）⇒ 报告可能已落库而只是门禁结论没取到。只给"未能完成 + 下一步"，不给假结论。
      logger.error('[QcChainService] 服装样品 QC 评审失败', { reportId, orderId, sampleLevel, round, error: e?.message });
      if (e instanceof QcAssignmentError) return fail(e.code, e.message, e.statusCode);
      if (e instanceof OrderLineWriteError) return fail(e.code, e.message, e.statusCode);
      if (e?.code === 'P2002') return fail('ROUND_ALREADY_REVIEWED', '该轮样品 QC 报告已存在，不可覆盖（REL-14-A1）', 409);
      return fail('CREATE_FAILED', '服装样品 QC 评审未能完成，请稍后重试；持续失败请联系管理员核对该订单该轮次的 QC 报告与门禁结论。', 500);
    }
  }

  /**
   * QC-29-A4 便捷入口：直接打回工厂重做（强制 directReject，语义等同于
   * reviewGarmentSample({ directReject: true })，单独端点便于权限与审计辨识）
   */
  async function directlyRejectGarmentSample(params: {
    orderId: string;
    input: GarmentSampleReviewInput;
    actorId: string;
    trustedActor?: TokenPayload;
    ip?: string | null;
  }): Promise<ChainResult<{ report: any; gate: GarmentSampleGate | null }>> {
    return reviewGarmentSample({
      ...params,
      input: { ...params.input, directReject: true, conclusion: 'fail' },
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 面料链 QC 评审（DR-029 面料链：客户不通过 → 业务转 QC → QC 向工厂提技术调整）
  // ══════════════════════════════════════════════════════════════

  async function reviewFabricSample(params: {
    orderId: string;
    input: FabricSampleReviewInput;
    actorId: string;
    trustedActor?: TokenPayload;
    ip?: string | null;
  }): Promise<ChainResult<{ report: any }>> {
    const { orderId, input, actorId, ip } = params;
    if (!input || typeof input !== 'object') return fail('INVALID_INPUT', '请求体必填');
    if (!orderId) return fail('INVALID_INPUT', 'orderId 必填');

    const order = await loadOrder(orderId);
    if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);
    if (!isFabricChainOrder(order)) {
      return fail('INVALID_CHAIN_SCOPE', `订单 ${orderId} 不属于面料链，面料样品 QC 评审仅适用于面料订单（DR-029 强制边界）`);
    }

    const sampleKind = String(input.sampleKind ?? '').trim().toUpperCase();
    if (!(FABRIC_QC_SAMPLE_KINDS as readonly string[]).includes(sampleKind)) {
      return fail('INVALID_INPUT', `sampleKind 必须是 ${FABRIC_QC_SAMPLE_KINDS.join(' | ')}`);
    }
    const sampleId = String(input.sampleId ?? '').trim();
    if (!sampleId) return fail('INVALID_INPUT', 'sampleId 必填（面料链 QC 评审必须关联具体样品记录）');

    const conclusion = String(input.conclusion ?? '').trim().toLowerCase();
    if (!(SAMPLE_CONCLUSIONS as readonly string[]).includes(conclusion)) {
      return fail('INVALID_INPUT', `conclusion 必须是 ${SAMPLE_CONCLUSIONS.join(' | ')}`);
    }
    const opinion = String(input.opinion ?? '').trim();
    if (!opinion) return fail('INVALID_INPUT', 'opinion（QC 专业意见/对工厂的技术调整说明）必填（DR-029）');

    const critical = normalizeDefectCount(input.criticalDefects, 'criticalDefects');
    const major = normalizeDefectCount(input.majorDefects, 'majorDefects');
    const minor = normalizeDefectCount(input.minorDefects, 'minorDefects');
    if (critical === null || major === null || minor === null) {
      return fail('INVALID_INPUT', 'criticalDefects/majorDefects/minorDefects 必须是 >=0 的整数');
    }
    if (input.inspectionDate !== undefined && input.inspectionDate !== '' && !DATE_RE.test(input.inspectionDate)) {
      return fail('INVALID_INPUT', 'inspectionDate 格式须为 YYYY-MM-DD');
    }

    const disposition: ChainDisposition = conclusion === 'pass' ? 'STANDARD' : 'REQUIRES_FACTORY_TECH_ADJUST';
    const adjustment = input.factoryAdjustment;
    if (disposition === 'REQUIRES_FACTORY_TECH_ADJUST') {
      if (!adjustment || !String(adjustment.requirement ?? '').trim()) {
        return fail(
          'FACTORY_ADJUSTMENT_REQUIRED',
          '评审结论非 pass 时 factoryAdjustment.requirement（对工厂的技术调整要求）必填：QC 须向工厂提出可追溯的调整要求（DR-029 面料链）',
        );
      }
    }

    // DR-054 阶段 G：大货生产样统一为 Sample（SS→ship / RC→head / EARLY_PRODUCTION→pioneer）挂 sourceOrderId
    const SAMPLE_KIND_TO_TYPE: Record<string, string> = { SS: 'ship', RC: 'head', EARLY_PRODUCTION: 'pioneer' };
    const sampleType = SAMPLE_KIND_TO_TYPE[sampleKind] ?? 'ship';
    const sample = await (prisma as any).sample.findFirst({ where: { id: sampleId, deletedAt: null } });
    if (!sample) return fail('SAMPLE_NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
    if (sample.type !== sampleType || sample.sourceOrderId !== orderId) {
      return fail('SAMPLE_ORDER_MISMATCH', `样品 ${sampleId} 不属于订单 ${orderId}（或类型不符）`, 400);
    }

    // 每样品每次评审独立报告（REL-14-A1/A5：不可跨轮复用/覆盖）
    const prefix = fabricReportIdPrefix(orderId, sampleId);
    const siblings = await (prisma as any).inspectionReport.findMany({ where: { orderId } });
    const seq = siblings.filter((r: any) => typeof r.id === 'string' && r.id.startsWith(prefix)).length + 1;
    const reportId = `${prefix}${seq}`;
    const inspectionType = fabricInspectionType(sampleKind as FabricQcSampleKind, seq);

    const ts = nowMs();
    const chainMeta: Record<string, unknown> = {
      chain: 'fabric',
      sampleKind,
      sampleId,
      seq,
      disposition,
      qcReviewerId: actorId,
      qcReviewedAt: ts,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      ...(disposition === 'REQUIRES_FACTORY_TECH_ADJUST'
        ? {
            factoryAdjustment: {
              requirement: String(adjustment!.requirement).trim(),
              parameters: adjustment!.parameters ?? null,
              factoryName: adjustment!.factoryName ?? null,
              followUpBy: adjustment!.followUpBy ?? null,
              evidence: Array.isArray(adjustment!.evidence) ? adjustment!.evidence : [],
              issuedBy: actorId,
              issuedAt: ts,
            },
          }
        : {}),
    };

    try {
      const report = await (prisma as any).$transaction(async (tx: any) => {
        await authorizeProfessionalReview(tx, params, 'qc:fabric_chain:write');
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${sampleId} FOR UPDATE`);
        const lockedSample = await tx.sample.findFirst({ where: { id: sampleId, sourceOrderId: orderId, type: sampleType, deletedAt: null } });
        if (!lockedSample) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '样品来源已变化，请重新读取实际样品。');
        await assertGenericSampleMutationAllowed(tx, lockedSample, '检验');
        const created = await tx.inspectionReport.create({
          data: {
            id: reportId,
            orderId,
            inspectionType,
            totalUnits: 0,
            passedUnits: 0,
            inspectionDate: input.inspectionDate || null,
            inspectorOrg: '自有 QC',
            criticalDefects: critical,
            majorDefects: major,
            minorDefects: minor,
            defectSummary: input.defectSummary || null,
            result: conclusion,
            inspectedBy: actorId,
            notes: opinion,
            signatures: { chain: chainMeta },
            createdAt: BigInt(ts),
            updatedAt: BigInt(ts),
          },
        });
        // DR-029 面料链关联位：回写样品记录 qcInspectionReportId（DR-054 阶段 G：统一写 Sample）
        await tx.sample.update({
          where: { id: sampleId },
          data: { qcInspectionReportId: created.id },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorId || 'api',
          source: 'route:qc:chain:fabric',
          operation: 'fabric_sample_review',
          targetType: 'InspectionReport',
          targetId: created.id,
          after: {
            id: created.id,
            orderId,
            inspectionType,
            sampleKind,
            sampleId,
            conclusion,
            disposition,
            criticalDefects: critical,
            majorDefects: major,
            minorDefects: minor,
            linkedSampleField: 'sample.qcInspectionReportId',
          },
          ip: ip ?? null,
        });
        return created;
      });
      logger.info('[QcChainService] fabric sample reviewed', { reportId, orderId, sampleKind, sampleId, seq, conclusion, disposition, actorId });
      return ok({ report });
    } catch (e: any) {
      // B39（D51）：原文只进日志。写路径唯一 = 上面那个 $transaction（`:498`，抛错即回滚），
      // 事务之后只有 logger.info 与 return ⇒ 可以承诺"本次未确认任何改动"。
      logger.error('[QcChainService] 面料样品 QC 评审失败', { reportId, orderId, sampleKind, sampleId, seq, error: e?.message });
      if (e instanceof QcAssignmentError) return fail(e.code, e.message, e.statusCode);
      if (e instanceof OrderLineWriteError) return fail(e.code, e.message, e.statusCode);
      if (e instanceof DevelopmentDomainError) { const safe = safeRouteError(e, { fallbackCode: 'CREATE_FAILED', fallbackMessage: '面料样品检验未能完成。' }); return fail(safe.code, safe.message, safe.status); }
      if (e?.code === 'P2002') return fail('DUPLICATE_REPORT', '样品 QC 报告冲突，请重试', 409);
      return fail('CREATE_FAILED', '面料样品 QC 评审未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该订单该轮次的面料 QC 报告。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 3. DR-008 / QC-29-A3 服装样品寄送门禁查询（样品域 Track C 消费）
  // ══════════════════════════════════════════════════════════════

  /**
   * 服装样品「寄客户」门禁：该轮样品必须先过 QC 内部评审（DR-008 fail-closed）。
   *   - 无报告 → RE_INSPECTION_REQUIRED（新一轮样品必须先交 QC 评审，QC-29-A3）
   *   - DIRECT_REJECT → SAMPLE_DIRECTLY_REJECTED（该批不得寄客户，QC-29-A4）
   *   - conclusion=fail → SAMPLE_QC_GATE_NOT_PASSED（QC-008-C1）
   */
  async function getGarmentSampleGate(params: {
    orderId: string;
    sampleLevel?: string;
    round: number;
  }): Promise<ChainResult<{ gate: GarmentSampleGate }>> {
    const { orderId } = params;
    const sampleLevel = String(params.sampleLevel ?? 'pp').trim().toLowerCase();
    const round = Number(params.round);
    if (!orderId) return fail('INVALID_INPUT', 'orderId 必填');
    if (!Number.isInteger(round) || round < 1) return fail('INVALID_INPUT', 'round 必须是 >=1 的整数');

    const report = await (prisma as any).inspectionReport.findUnique({
      where: { id: garmentReportId(orderId, sampleLevel, round) },
    });
    const chainMeta = (report?.signatures as any)?.chain ?? null;
    const disposition: ChainDisposition | null = chainMeta?.disposition ?? null;
    const conclusion: string | null = report?.result ?? null;

    let blockedCode: GarmentSampleGate['blockedCode'] = null;
    let blockedMessage: string | null = null;
    if (!report) {
      blockedCode = 'RE_INSPECTION_REQUIRED';
      blockedMessage = `第 ${round} 轮样品必须先交 QC 评审（DR-029：每轮新样重新入 QC 后才可寄客户）`;
    } else if (disposition === 'DIRECT_REJECT') {
      blockedCode = 'SAMPLE_DIRECTLY_REJECTED';
      blockedMessage = '该批样品已被 QC 直接打回工厂重做，不得寄客户（QC-29-A4 fail-closed）';
    } else if (conclusion === 'fail') {
      blockedCode = 'SAMPLE_QC_GATE_NOT_PASSED';
      blockedMessage = '该轮 QC 评审未通过，请先让 QC 调整/复评后再寄（DR-008 内部门禁）';
    }

    return ok({
      gate: {
        orderId,
        sampleLevel,
        round,
        reviewed: !!report,
        passed: blockedCode === null,
        conclusion,
        disposition,
        reportId: report?.id ?? null,
        blockedCode,
        blockedMessage,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 链报告查询（样品链报告与大货 final/midline 报告天然隔离）
  // ══════════════════════════════════════════════════════════════

  async function listChainReports(params: {
    orderId: string;
    chain?: 'garment' | 'fabric';
  }): Promise<ChainResult<{ items: any[] }>> {
    const { orderId, chain } = params;
    if (!orderId) return fail('INVALID_INPUT', 'orderId 必填');
    const order = await loadOrder(orderId);
    if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);

    const rows = await (prisma as any).inspectionReport.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    const items = rows
      .map((r: any) => {
        const parsed = parseChainInspectionType(r.inspectionType);
        if (!parsed) return null;
        if (chain && parsed.chain !== chain) return null;
        return { ...r, chain: parsed.chain, sampleKind: parsed.sampleKind, round: parsed.round };
      })
      .filter(Boolean);
    return ok({ items });
  }

  return {
    reviewGarmentSample,
    directlyRejectGarmentSample,
    reviewFabricSample,
    getGarmentSampleGate,
    listChainReports,
  };
}

export type QcChainService = ReturnType<typeof createQcChainService>;
