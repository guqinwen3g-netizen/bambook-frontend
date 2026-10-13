/**
 * colorBatchService.ts — REQ2-01 色差管理体系：打色批次（缸号级色差证据链）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/色差管理体系.md
 *
 * 两态挂载：
 *   - lab_dip（开发打色）：挂 DevelopmentCase（roundNo 快照 currentRound）
 *   - bulk（大货缸差）：挂 Order
 *
 * 核心闭环：
 *   登记（缸号/评级/疵点原因/照片）→ 客户判定（approved/rejected/needs_recast）
 *   → 批色通过即封样基准（同 scope 唯一，自动切换）
 *   → 判定时疵点原因自动追加供应商 FactoryEvaluation(inspection)（recordAutoEvaluation 幂等）
 *
 * 边界：
 *   - 质量分联动为事务外 best-effort（append-only 真源 + 幂等去重，失败不阻断判定）
 *   - 色差记录是登记事实，非验货流程（InspectionReport 既有域不渗透）
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createFactoryService } from '../suppliers/factoryService';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

export const COLOR_BATCH_STAGES = ['lab_dip', 'bulk'] as const;
export const DEFECT_CAUSES = ['red_cast', 'blue_cast', 'lighter', 'darker'] as const;
export const COLOR_BATCH_CUSTOMER_STATUSES = ['pending', 'approved', 'rejected', 'needs_recast'] as const;

/** 色差评级 → 供应商 inspection 评分映射（设计文档 §5.1） */
export const RATING_TO_SCORE: Record<number, number> = { 5: 95, 4: 85, 3: 70, 2: 50, 1: 30 };
const RATING_LABEL: Record<number, string> = { 5: '与标样一致', 4: '轻微差异', 3: '明显差异', 2: '严重偏离', 1: '完全不符' };
const DEFECT_LABEL: Record<string, string> = { red_cast: '偏红', blue_cast: '偏蓝', lighter: '色浅', darker: '色深' };
const STATUS_LABEL: Record<string, string> = { approved: '客户通过', rejected: '客户拒绝', needs_recast: '要求重打' };

/** 客户判定状态机：pending → 三态；needs_recast → approved/rejected（客户回心转意）；approved/rejected 终态 */
const CUSTOMER_TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'rejected', 'needs_recast'],
  needs_recast: ['approved', 'rejected'],
};

/** 判别联合（与 samples 域 sendResult 范式对齐：ok 字面量收窄；status 必填，fail 默认 400） */
export type ColorBatchResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): ColorBatchResult<never> => ({ ok: false, error: { code, message, status } });

function todayYmd(): string {
  return todayLocalKey();
}

function assertRating(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw Object.assign(new Error(`${field} 必须是 1-5 整数（4-5 级制评级）`), { code: 'INVALID_RATING' });
  return n;
}

function sanitizeDefectCauses(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error('defectCauses 必须是数组'), { code: 'INVALID_DEFECT_CAUSES' });
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).trim();
    if (!s) continue;
    if (!(DEFECT_CAUSES as readonly string[]).includes(s)) {
      throw Object.assign(new Error(`非法疵点原因：${s}（允许 ${DEFECT_CAUSES.join(' | ')}）`), { code: 'INVALID_DEFECT_CAUSES' });
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createColorBatchService(prisma: PrismaClient) {
  const db = prisma as any;
  const factorySvc = createFactoryService(prisma);

  async function nextBatchCode(): Promise<string> {
    const prefix = `SCB-${todayYmd().replace(/-/g, '')}`;
    const count = await db.sampleColorBatch.count({ where: { batchCode: { startsWith: prefix } } });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** 两态挂载校验 + 宿主存在性（fail-closed） */
  async function resolveScope(stage: string, developmentCaseId?: string, orderId?: string): Promise<{ roundNo?: number }> {
    if (stage === 'lab_dip') {
      if (!developmentCaseId) throw Object.assign(new Error('打色阶段（lab_dip）必须挂开发案 developmentCaseId'), { code: 'SCOPE_REQUIRED' });
      if (orderId) throw Object.assign(new Error('打色阶段（lab_dip）不可挂订单'), { code: 'SCOPE_CONFLICT' });
      const devCase = await db.developmentCase.findFirst({ where: { id: developmentCaseId, deletedAt: null } });
      if (!devCase) throw Object.assign(new Error(`开发案 ${developmentCaseId} 不存在`), { code: 'CASE_NOT_FOUND' });
      return { roundNo: devCase.currentRound ?? 1 };
    }
    if (stage === 'bulk') {
      if (!orderId) throw Object.assign(new Error('大货阶段（bulk）必须挂订单 orderId'), { code: 'SCOPE_REQUIRED' });
      if (developmentCaseId) throw Object.assign(new Error('大货阶段（bulk）不可挂开发案'), { code: 'SCOPE_CONFLICT' });
      const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) throw Object.assign(new Error(`订单 ${orderId} 不存在`), { code: 'ORDER_NOT_FOUND' });
      return {};
    }
    throw Object.assign(new Error(`非法阶段：${stage}（允许 lab_dip | bulk）`), { code: 'INVALID_STAGE' });
  }

  // ── 登记（A5 ≤2min：必填缸号/评级；疵点原因选填；色号可选 REQ2-09） ──
  async function createColorBatch(input: {
    stage: string;
    developmentCaseId?: string;
    orderId?: string;
    colorCardId?: string;
    dyeLotNo?: string;
    batchNo?: string;
    rollNos?: string[];
    colorRating?: number;
    sideDiff?: number;
    endDiff?: number;
    defectCauses?: string[];
    supplierRelationId?: string;
    supplierName?: string;
    photos?: unknown;
    notes?: string;
  }, actorId: string): Promise<ColorBatchResult<any>> {
    try {
      const stage = String(input.stage ?? '');
      const dyeLotNo = String(input.dyeLotNo ?? '').trim();
      if (!dyeLotNo) return fail('DYE_LOT_REQUIRED', '缸号必填（染厂染色缸次）');
      const colorRating = assertRating(input.colorRating, 'colorRating');
      const sideDiff = input.sideDiff != null ? assertRating(input.sideDiff, 'sideDiff') : null;
      const endDiff = input.endDiff != null ? assertRating(input.endDiff, 'endDiff') : null;
      const defectCauses = sanitizeDefectCauses(input.defectCauses);
      const scope = await resolveScope(stage, input.developmentCaseId, input.orderId);

      // 供应商快照校验（联动质量分的目标；不存在即 400 而非静默——登记时数据入口要 fail-closed）
      let supplierRelationId: string | null = null;
      let supplierName: string | null = input.supplierName?.trim() || null;
      if (input.supplierRelationId) {
        const rel = await db.relation.findFirst({ where: { id: input.supplierRelationId, deletedAt: null } });
        if (!rel) return fail('SUPPLIER_NOT_FOUND', `供应商 ${input.supplierRelationId} 不存在`);
        supplierRelationId = rel.id;
        supplierName = supplierName || rel.name;
      }

      // 色号关联（REQ2-09 DR-051-③：可选 FK + code 快照；不存在即 400 fail-closed）
      let colorCardId: string | null = null;
      let colorCode: string | null = null;
      if (input.colorCardId) {
        const card = await db.colorCard.findFirst({ where: { id: input.colorCardId, deletedAt: null } });
        if (!card) return fail('COLOR_CARD_NOT_FOUND', `色卡 ${input.colorCardId} 不存在`);
        colorCardId = card.id;
        colorCode = card.code;
      }

      const ts = Date.now();
      const created = await db.sampleColorBatch.create({
        data: {
          id: `SCB__${dyeLotNo.replace(/[^\w-]/g, '').slice(0, 12).toUpperCase() || 'X'}${ts.toString(36).toUpperCase()}`,
          batchCode: await nextBatchCode(),
          stage,
          developmentCaseId: stage === 'lab_dip' ? input.developmentCaseId! : null,
          roundNo: scope.roundNo ?? null,
          orderId: stage === 'bulk' ? input.orderId! : null,
          colorCardId,
          colorCode,
          dyeLotNo,
          batchNo: input.batchNo?.trim() || null,
          rollNos: Array.isArray(input.rollNos) ? input.rollNos.map(String).filter(Boolean) : [],
          colorRating,
          sideDiff,
          endDiff,
          defectCauses,
          customerStatus: 'pending',
          approvedAsSealed: false,
          supplierRelationId,
          supplierName,
          photos: (input.photos ?? null) as any,
          notes: input.notes?.trim() || null,
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[ColorBatch] created', { id: created.id, batchCode: created.batchCode, stage, dyeLotNo, actorId });
      return { ok: true, data: { batch: created } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[ColorBatch] create failed', { error: e?.message });
      return fail('CREATE_FAILED', '批色记录登记失败，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对色号与客户要求。');
    }
  }

  // ── 列表（二选一挂载键必填） ──
  async function listColorBatches(params: { developmentCaseId?: string; orderId?: string }): Promise<ColorBatchResult<{ items: any[] }>> {
    if (!params.developmentCaseId && !params.orderId) return fail('SCOPE_REQUIRED', 'developmentCaseId 与 orderId 必传其一');
    if (params.developmentCaseId && params.orderId) return fail('SCOPE_CONFLICT', 'developmentCaseId 与 orderId 只能传其一', 409);
    const where: any = { deletedAt: null };
    if (params.developmentCaseId) where.developmentCaseId = params.developmentCaseId;
    if (params.orderId) where.orderId = params.orderId;
    const items = await db.sampleColorBatch.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { ok: true, data: { items } };
  }

  // ── 更新（白名单：登记事实可修正；判定/基准走专用端点） ──
  async function updateColorBatch(id: string, patch: Record<string, unknown>): Promise<ColorBatchResult<any>> {
    try {
      const existing = await db.sampleColorBatch.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `打色批次 ${id} 不存在`, 404);
      const data: any = { updatedAt: BigInt(Date.now()) };
      if (patch.dyeLotNo !== undefined) {
        const v = String(patch.dyeLotNo).trim();
        if (!v) return fail('DYE_LOT_REQUIRED', '缸号不可为空');
        data.dyeLotNo = v;
      }
      if (patch.batchNo !== undefined) data.batchNo = String(patch.batchNo ?? '').trim() || null;
      if (patch.rollNos !== undefined) data.rollNos = Array.isArray(patch.rollNos) ? (patch.rollNos as unknown[]).map(String).filter(Boolean) : [];
      if (patch.colorRating !== undefined) data.colorRating = assertRating(patch.colorRating, 'colorRating');
      if (patch.sideDiff !== undefined) data.sideDiff = patch.sideDiff == null ? null : assertRating(patch.sideDiff, 'sideDiff');
      if (patch.endDiff !== undefined) data.endDiff = patch.endDiff == null ? null : assertRating(patch.endDiff, 'endDiff');
      if (patch.defectCauses !== undefined) data.defectCauses = sanitizeDefectCauses(patch.defectCauses);
      if (patch.photos !== undefined) data.photos = (patch.photos ?? null) as any;
      if (patch.notes !== undefined) data.notes = String(patch.notes ?? '').trim() || null;
      // 禁改字段守卫（stage/挂载/customerStatus/approvedAsSealed 不在白名单，静默忽略）
      const updated = await db.sampleColorBatch.update({ where: { id }, data });
      return { ok: true, data: { batch: updated } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      // 原文只进日志：对外文案不再回显 e.message（§9 B33）
      logger.error('[ColorBatch] update failed', { id, error: e?.message });
      return fail('UPDATE_FAILED', '批色记录未能保存，本次改动未生效，请稍后重试；持续失败请联系管理员核对批色编号。');
    }
  }

  // ── 客户判定（批色即封样 + 质量分联动） ──
  async function recordCustomerFeedback(id: string, input: {
    status?: string;
    note?: string;
    asSealed?: boolean;
  }, actorId: string): Promise<ColorBatchResult<any>> {
    try {
      const status = String(input.status ?? '');
      if (!(COLOR_BATCH_CUSTOMER_STATUSES as readonly string[]).includes(status) || status === 'pending') {
        return fail('INVALID_STATUS', 'status 必须是 approved | rejected | needs_recast');
      }
      const existing = await db.sampleColorBatch.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `打色批次 ${id} 不存在`, 404);

      const allowed = CUSTOMER_TRANSITIONS[existing.customerStatus] ?? [];
      if (!allowed.includes(status)) {
        return fail('INVALID_TRANSITION', `当前状态 ${existing.customerStatus} 不可变更为 ${status}（终态或非法跳转）`, 409);
      }
      const asSealed = input.asSealed === true;
      if (asSealed && status !== 'approved') {
        return fail('SEALED_REQUIRES_APPROVED', '仅客户通过（approved）可设为封样基准', 409);
      }

      const ts = Date.now();
      const updated = await db.$transaction(async (tx: any) => {
        // 封样基准唯一性：同 scope 其他基准自动让位（重打循环换基准）
        if (asSealed) {
          const scopeWhere = existing.stage === 'lab_dip'
            ? { developmentCaseId: existing.developmentCaseId }
            : { orderId: existing.orderId };
          await tx.sampleColorBatch.updateMany({
            where: { ...scopeWhere, approvedAsSealed: true, deletedAt: null, id: { not: id } },
            data: { approvedAsSealed: false, updatedAt: BigInt(ts) },
          });
        }
        return tx.sampleColorBatch.update({
          where: { id },
          data: {
            customerStatus: status,
            approvedAsSealed: asSealed ? true : (status !== 'approved' ? false : existing.approvedAsSealed),
            customerFeedbackNote: input.note?.trim() || null,
            customerFeedbackDate: todayYmd(),
            updatedAt: BigInt(ts),
          },
        });
      });

      // 质量分联动（事务外 best-effort；recordAutoEvaluation 幂等：同批次只记一次）
      let qualityScoreLinked = false;
      if (existing.supplierRelationId) {
        try {
          const causes = (existing.defectCauses as string[]).map(c => DEFECT_LABEL[c] ?? c).join('/') || '无';
          const r = await factorySvc.recordAutoEvaluation({
            relationId: existing.supplierRelationId,
            kind: 'inspection',
            score: RATING_TO_SCORE[existing.colorRating] ?? 70,
            sourceType: 'color_batch',
            sourceId: id,
            evaluatedAt: todayYmd(),
            note: `色差评级${existing.colorRating}级(${RATING_LABEL[existing.colorRating] ?? ''}) 疵点:${causes} 判定:${STATUS_LABEL[status] ?? status} 缸号:${existing.dyeLotNo}`,
            actorId,
          });
          qualityScoreLinked = r.recorded;
        } catch (e: any) {
          logger.error('[ColorBatch] quality-score link failed（判定已生效，评分未追加）', { id, error: e?.message });
        }
      }

      logger.info('[ColorBatch] customer feedback', { id, status, asSealed, qualityScoreLinked, actorId });
      return { ok: true, data: { batch: updated, qualityScoreLinked } } as any;
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[ColorBatch] customer feedback failed', { id, status, error: e?.message });
      return fail('FEEDBACK_FAILED', '批色判定结论未能登记，本次改动未生效，请稍后重试；持续失败请联系管理员核对判定单与日期。');
    }
  }

  // ── 软删（append-only 质量分不回滚） ──
  async function deleteColorBatch(id: string, actorId: string): Promise<ColorBatchResult<{ deleted: true }>> {
    const existing = await db.sampleColorBatch.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `打色批次 ${id} 不存在`, 404);
    await db.sampleColorBatch.update({ where: { id }, data: { deletedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    logger.info('[ColorBatch] soft-deleted', { id, actorId });
    return { ok: true, data: { deleted: true as const } };
  }

  // ── 取证聚合（3 分钟 SLA：缸号×批次×批色×封样基准一次成型） ──
  async function getColorBatchEvidence(params: { developmentCaseId?: string; orderId?: string }): Promise<ColorBatchResult<{ evidence: any }>> {
    if (!params.developmentCaseId && !params.orderId) return fail('SCOPE_REQUIRED', 'developmentCaseId 与 orderId 必传其一');
    if (params.developmentCaseId && params.orderId) return fail('SCOPE_CONFLICT', 'developmentCaseId 与 orderId 只能传其一', 409);

    const listR = await listColorBatches(params);
    if (!listR.ok) return listR as any;
    const batches = listR.data!.items;

    let scope: any;
    if (params.developmentCaseId) {
      const devCase = await db.developmentCase.findFirst({ where: { id: params.developmentCaseId, deletedAt: null } });
      if (!devCase) return fail('CASE_NOT_FOUND', `开发案 ${params.developmentCaseId} 不存在`);
      scope = { developmentCaseId: devCase.id, caseCode: devCase.code, caseName: devCase.name, customerName: devCase.customerName ?? null };
    } else {
      const order = await db.order.findFirst({ where: { id: params.orderId, deletedAt: null } });
      if (!order) return fail('ORDER_NOT_FOUND', `订单 ${params.orderId} 不存在`);
      scope = { orderId: order.id, poNumber: order.poNumber ?? order.id, customerName: order.customer ?? null };
    }

    const sealedBasis = batches.find((b: any) => b.approvedAsSealed) ?? null;
    const defectCauseCount: Record<string, number> = {};
    for (const b of batches) for (const c of (b.defectCauses as string[]) ?? []) defectCauseCount[c] = (defectCauseCount[c] ?? 0) + 1;

    return {
      ok: true,
      data: {
        evidence: {
          scope,
          sealedBasis,
          batches,
          summary: {
            total: batches.length,
            approved: batches.filter((b: any) => b.customerStatus === 'approved').length,
            rejected: batches.filter((b: any) => b.customerStatus === 'rejected').length,
            needsRecast: batches.filter((b: any) => b.customerStatus === 'needs_recast').length,
            pending: batches.filter((b: any) => b.customerStatus === 'pending').length,
            defectCauseCount,
          },
        },
      },
    };
  }

  return { createColorBatch, listColorBatches, updateColorBatch, recordCustomerFeedback, deleteColorBatch, getColorBatchEvidence };
}
