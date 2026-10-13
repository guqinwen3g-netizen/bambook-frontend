/**
 * delayImpactService.ts — REQ2-10 工厂延迟链路影响计算（DR-052）
 *
 * 设计真源：docs/design/04-模块设计/06-资源与支撑/Suppliers-供应商/工厂延迟链路影响计算.md
 *
 * DR-052 三决策：
 *   ① 延迟登记是事实记录，改期走既有 OrderChangeRequest 审批（两域分离）
 *   ② 影响计算以"缓冲侵蚀"为轴：新生产完成日 = productionPlanDeadline + delayDays vs dueDate
 *      → critical（突破交期且剩余缓冲 ≤7 天）/ warning（突破但缓冲 >7 天）/ info（未突破）
 *   ③ 登记即联动工厂交期分下调：recordAutoEvaluation(kind='delivery') 幂等追加（REQ2-01 同机制）
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createFactoryService } from './factoryService';
import { localDateKey, todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

export const DELAY_REASONS = ['capacity', 'material', 'quality_rework', 'weather', 'other'] as const;

export const DELAY_REASON_LABELS: Record<string, string> = {
  capacity: '产能不足', material: '原料短缺', quality_rework: '质量返工', weather: '天气/不可抗力', other: '其他',
};

/** 缓冲侵蚀分级 */
export type ImpactLevel = 'critical' | 'warning' | 'info';
export const IMPACT_LEVEL_LABELS: Record<string, string> = { critical: '突破交期（急）', warning: '突破交期（有缓冲）', info: '未突破交期' };

/** critical 阈值：剩余缓冲 ≤7 天 */
export const CRITICAL_BUFFER_DAYS = 7;

/** 延迟天数 → 工厂交期分扣分映射（DR-052-③） */
export function delayDaysToScore(delayDays: number): number {
  if (delayDays <= 7) return 60;
  if (delayDays <= 15) return 40;
  if (delayDays <= 30) return 25;
  return 10;
}

/** 逐级沟通建议文案（DR-052-②） */
export const IMPACT_ADVICE: Record<ImpactLevel, string> = {
  critical: '剩余缓冲不足 7 天：建议立即通知客户协商改期或分批出货，关键订单评估空运补货；同时发起交期变更审批。',
  warning: '生产计划已突破客户交期但仍有缓冲：建议评估加急工序/部分提前出货，暂不惊动客户；确认后再决定是否发起交期变更。',
  info: '生产缓冲足以消化延迟：内部调整生产排程即可，无需客户沟通。',
};

/** 活跃订单状态（受影响范围：非终态） */
const ACTIVE_ORDER_EXCLUDE = ['Cancelled', 'Delivered', 'Completed'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DelayImpactResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): DelayImpactResult<never> => ({ ok: false, error: { code, message, status } });

function parseYmd(s: string): number {
  return new Date(s + 'T00:00:00Z').getTime();
}

function addDays(ymd: string, days: number): string {
  return localDateKey(new Date(parseYmd(ymd) + days * MS_PER_DAY));
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createDelayImpactService(prisma: PrismaClient) {
  const db = prisma as any;
  const factorySvc = createFactoryService(prisma);

  async function nextRecordNumber(): Promise<string> {
    const prefix = `FDR-${todayLocalKey().replace(/-/g, '')}`;
    const count = await db.factoryDelayRecord.count({ where: { recordNumber: { startsWith: prefix } } });
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  /** 受影响订单聚合（DR-052-② 缓冲侵蚀分级）——preview 与登记共用同一真源 */
  async function computeImpact(supplierRelationId: string, delayDays: number): Promise<DelayImpactResult<any>> {
    try {
      if (!supplierRelationId?.trim()) return fail('SUPPLIER_REQUIRED', 'supplierRelationId 必填（延迟工厂）');
      if (!Number.isInteger(delayDays) || delayDays < 1) return fail('INVALID_DELAY_DAYS', 'delayDays 必须为正整数');

      const supplier = await db.relation.findFirst({ where: { id: supplierRelationId, deletedAt: null } });
      if (!supplier) return fail('SUPPLIER_NOT_FOUND', `工厂 ${supplierRelationId} 不存在`, 404);

      const orders = await db.order.findMany({
        where: {
          millRelationId: supplierRelationId,
          deletedAt: null,
          status: { notIn: ACTIVE_ORDER_EXCLUDE },
        },
        select: { id: true, poNumber: true, customer: true, product: true, quantity: true, dueDate: true, productionPlanDeadline: true, status: true },
        orderBy: { dueDate: 'asc' },
      });

      const items = orders.map((o: any) => {
        const dueDate = o.dueDate ? String(o.dueDate).slice(0, 10) : null;
        const planDate = o.productionPlanDeadline ? String(o.productionPlanDeadline).slice(0, 10) : null;
        const planDateMissing = planDate == null;
        const baseDate = planDate ?? dueDate; // 缺失回退 dueDate（保守：直接判突破）
        const newCompletion = baseDate ? addDays(baseDate, delayDays) : null;
        let level: ImpactLevel = 'info';
        let bufferDays: number | null = null;
        if (dueDate && newCompletion) {
          bufferDays = Math.round((parseYmd(dueDate) - parseYmd(newCompletion)) / MS_PER_DAY);
          if (bufferDays < 0) {
            level = (-bufferDays) <= CRITICAL_BUFFER_DAYS ? 'critical' : 'warning';
          } else {
            level = 'info';
          }
        }
        return {
          orderId: o.id, poNumber: o.poNumber, customer: o.customer, product: o.product,
          quantity: o.quantity != null ? Number(o.quantity) : null,
          status: o.status, dueDate, productionPlanDeadline: planDate, planDateMissing,
          newCompletionDate: newCompletion, bufferDays, level,
        };
      });

      const summary = {
        total: items.length,
        critical: items.filter((x: any) => x.level === 'critical').length,
        warning: items.filter((x: any) => x.level === 'warning').length,
        info: items.filter((x: any) => x.level === 'info').length,
        criticalOrderIds: items.filter((x: any) => x.level === 'critical').map((x: any) => x.orderId),
      };
      const advice: Record<string, string> = {
        critical: summary.critical > 0 ? IMPACT_ADVICE.critical : '',
        warning: summary.warning > 0 ? IMPACT_ADVICE.warning : '',
        info: summary.info > 0 ? IMPACT_ADVICE.info : '',
      };
      return { ok: true, data: { supplierName: supplier.name, delayDays, items, summary, advice } };
    } catch (e: any) {
      logger.error('[DelayImpact] compute failed', { error: e?.message });
      return fail('IMPACT_FAILED', e?.message || '影响计算失败', 500);
    }
  }

  // ── 登记前预检（不落库） ──
  async function previewImpact(supplierRelationId: string, delayDays: number): Promise<DelayImpactResult<any>> {
    return computeImpact(supplierRelationId, delayDays);
  }

  // ── 登记（落库 + 影响快照 + 交期分联动 DR-052-③） ──
  async function registerDelay(input: {
    supplierRelationId?: string;
    supplierName?: string;
    delayDays?: number;
    reason?: string;
    reasonNote?: string;
    registeredBy?: string;
  }, actorId?: string): Promise<DelayImpactResult<any>> {
    try {
      const impact = await computeImpact(String(input.supplierRelationId ?? ''), Number(input.delayDays));
      if (!impact.ok) return impact;
      const { items, summary, supplierName } = impact.data;

      const reason = input.reason != null && String(input.reason).trim() !== '' ? String(input.reason).trim() : null;
      if (reason && !(DELAY_REASONS as readonly string[]).includes(reason)) {
        return fail('INVALID_REASON', `reason 须为 ${DELAY_REASONS.join(' | ')}`);
      }

      const ts = Date.now();
      const record = await db.factoryDelayRecord.create({
        data: {
          id: `FDR__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          recordNumber: await nextRecordNumber(),
          supplierRelationId: input.supplierRelationId!.trim(),
          supplierName: supplierName || input.supplierName?.trim() || '',
          delayDays: Number(input.delayDays),
          reason, reasonNote: input.reasonNote?.trim() || null,
          affectedOrderIds: items.map((x: any) => x.orderId),
          impactSummary: { ...summary, delayDays: Number(input.delayDays) },
          registeredBy: input.registeredBy?.trim() || actorId || null,
          createdAt: BigInt(ts),
        },
      });

      // 交期分联动（事务外 best-effort，幂等去重；无 FactoryProfile 静默跳过）
      let qualityScoreLinked = false;
      try {
        const evalResult = await factorySvc.recordAutoEvaluation({
          relationId: input.supplierRelationId!.trim(),
          kind: 'delivery',
          score: delayDaysToScore(Number(input.delayDays)),
          sourceType: 'factory_delay',
          sourceId: record.id,
          evaluatedAt: localDateKey(new Date(ts)),
          note: `工厂延迟 ${input.delayDays} 天（${DELAY_REASON_LABELS[reason ?? ''] ?? '原因未分类'}），受影响订单 ${summary.total} 单`,
          actorId: actorId ?? 'api',
        });
        qualityScoreLinked = evalResult.recorded;
      } catch (e: any) {
        logger.warn('[DelayImpact] delivery score link failed', { error: e?.message });
      }

      logger.info('[DelayImpact] registered', { id: record.id, recordNumber: record.recordNumber, supplier: supplierName, delayDays: input.delayDays, critical: summary.critical });
      return { ok: true, data: { record, impact: { items, summary, advice: impact.data.advice }, qualityScoreLinked } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[DelayImpact] register failed', { error: e?.message });
      return fail('REGISTER_FAILED', e?.message || '登记失败', 500);
    }
  }

  // ── 列表（工厂维度或全量倒序） ──
  async function listDelays(params: { supplierRelationId?: string; limit?: number }): Promise<DelayImpactResult<{ items: any[] }>> {
    const where: any = { deletedAt: null };
    if (params.supplierRelationId) where.supplierRelationId = params.supplierRelationId;
    const items = await db.factoryDelayRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
    return { ok: true, data: { items } };
  }

  // ── 详情 ──
  async function getDelay(id: string): Promise<DelayImpactResult<any>> {
    const record = await db.factoryDelayRecord.findFirst({ where: { id, deletedAt: null } });
    if (!record) return fail('DELAY_NOT_FOUND', `延迟记录 ${id} 不存在`, 404);
    return { ok: true, data: { record } };
  }

  return { previewImpact, registerDelay, listDelays, getDelay };
}
