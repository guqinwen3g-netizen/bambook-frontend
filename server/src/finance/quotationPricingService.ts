/**
 * quotationPricingService.ts — Phase 1-04 报价单双轨定价桥接服务
 *
 * 设计动机（系统思维）：
 *   Quotation schema 已有双轨快照字段（trackAMedianUsd/trackAUnit/trackBFinalUsd/
 *   priceDeviationPercent/priceDeviationLevel/priceApprovalId），PricingService 已有
 *   Track A 估算 + Track B 计算 + TaxRefundRate 命中能力，但两者没有打通。
 *   本服务作为桥接层，把 PricingService 的计算结果写入 Quotation 快照字段，
 *   并执行偏差分级校验（PRD 8.6 双轨联动校验）。
 *
 * 偏差分级规则（PRD 8.6）：
 *   - |deviation| < 15%  → ok    （正常发送）
 *   - 15% ≤ |deviation| ≤ 30% → warn （需审批，标记待审批）
 *   - |deviation| > 30%  → block  （未审批通过禁止发送）
 *
 * 与现有服务的关系：
 *   - 复用 PricingService.estimateTrackA（轨道 A 估算预览，不落库）
 *   - 复用 PricingService.calculateTrackB（轨道 B 纯函数）
 *   - 复用 PricingService.lookupRefundRate / latestUsdRate（默认值命中）
 *   - 写入 Quotation 快照字段，不创建 PricingCalculation 记录（报价单本身就是定价载体）
 */
import type { PrismaClient } from '@prisma/client';
import { createPricingService, type TrackBResult } from '../pricing/pricingService';
import type { TrackAResult, TrackACategory } from '../pricing/trackAEstimator';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────────

export type DeviationLevel = 'ok' | 'warn' | 'block';

export interface QuotationPricingInput {
  // ── Track A 输入（传递给 PricingService.estimateTrackA）──
  category: TrackACategory;
  fabricCode?: string;
  yarnCode?: string;
  fabricPriceCny?: number;
  fabricConsumptionM?: number;
  fabricLossRate?: number;
  trimmingCostCny?: number;
  cmtCostCny?: number;
  complexity?: 'simple' | 'standard' | 'complex';
  packagingCostCny?: number;
  yarnPriceCnyPerKg?: number;
  weightGsm?: number;
  widthM?: number;
  weavingCostCny?: number;
  weaveType?: 'plain' | 'twill' | 'jacquard';
  dyeingCostCny?: number;
  profitBenchmark?: number;
  quantity?: number;
  lines?: Array<{ key: string; label: string; amountCny: number; source?: string; adjusted?: boolean }>;

  // ── Track B 输入（传递给 PricingService.calculateTrackB 的 resolveCalculationData）──
  purchaseCostCny: number;
  refundRate?: number; // 缺省按 hsCode 最长前缀命中
  hsCode?: string;
  exchangeRate?: number; // 缺省取最新 USD 汇率
  profitMargin: number;
  commissionRate?: number;
  commissionRuleId?: string;
}

export interface QuotationPricingResult {
  quotationId: string;
  trackA: TrackAResult;
  trackB: TrackBResult;
  trackAMedianUsd: number;
  trackBFinalUsd: number;
  deviationPercent: number;
  deviationLevel: DeviationLevel;
  canSend: boolean;
}

export type QuotationPricingError =
  | 'NOT_FOUND'
  | 'PRICING_FAILED'
  | 'EXCHANGE_RATE_MISSING'
  | 'INTERNAL_ERROR';

export interface QuotationPricingResponse {
  ok: boolean;
  data?: QuotationPricingResult;
  error?: { code: QuotationPricingError; message: string };
}

// ────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────

/** 偏差阈值（PRD 8.6） */
const DEVIATION_WARN_THRESHOLD = 15; // %
const DEVIATION_BLOCK_THRESHOLD = 30; // %

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────

export function createQuotationPricingService(prisma: PrismaClient) {
  const pricingSvc = createPricingService(prisma);
  const db = prisma as any;

  /**
   * 对报价单应用双轨定价：调用 Track A 估算 + Track B 终价计算，
   * 将结果写入 Quotation 快照字段，返回偏差分级。
   */
  async function applyTrackPricing(
    quotationId: string,
    input: QuotationPricingInput,
  ): Promise<QuotationPricingResponse> {
    try {
      // ── 1. 校验报价单存在 ──
      const quotation = await db.quotation.findFirst({
        where: { id: quotationId, deletedAt: null },
        select: { id: true, quotationNumber: true, currency: true, exchangeRate: true },
      });
      if (!quotation) {
        return { ok: false, error: { code: 'NOT_FOUND', message: '报价单不存在或已删除' } };
      }

      // ── 2. 解析汇率（Track A 和 Track B 都需要）──
      let exchangeRate = input.exchangeRate;
      if (exchangeRate === undefined || exchangeRate === null) {
        const latest = await pricingSvc.latestUsdRate();
        if (latest === null) {
          return { ok: false, error: { code: 'EXCHANGE_RATE_MISSING', message: '汇率缺失且无最新 USD 汇率记录' } };
        }
        exchangeRate = latest;
      }

      // ── 3. Track A 估算（轨道 A 内部口径，不落库）──
      const trackA = await pricingSvc.estimateTrackA({
        category: input.category,
        fabricCode: input.fabricCode,
        yarnCode: input.yarnCode,
        fabricPriceCny: input.fabricPriceCny,
        fabricConsumptionM: input.fabricConsumptionM,
        fabricLossRate: input.fabricLossRate,
        trimmingCostCny: input.trimmingCostCny,
        cmtCostCny: input.cmtCostCny,
        complexity: input.complexity,
        packagingCostCny: input.packagingCostCny,
        yarnPriceCnyPerKg: input.yarnPriceCnyPerKg,
        weightGsm: input.weightGsm,
        widthM: input.widthM,
        weavingCostCny: input.weavingCostCny,
        weaveType: input.weaveType,
        dyeingCostCny: input.dyeingCostCny,
        profitBenchmark: input.profitBenchmark,
        exchangeRate,
        quantity: input.quantity,
        lines: input.lines as any,
      });

      if (trackA.priceMedianUsd === null) {
        // 理论上 exchangeRate 已解析，priceMedianUsd 不应为 null
        return { ok: false, error: { code: 'PRICING_FAILED', message: '轨道 A 估算未能生成美元中位价（汇率异常）' } };
      }

      // ── 4. Track B 终价计算 ──
      // 解析退税率
      let refundRate = input.refundRate;
      let hsCode = input.hsCode?.trim() || null;
      if (refundRate === undefined || refundRate === null) {
        if (!hsCode) {
          return { ok: false, error: { code: 'PRICING_FAILED', message: '退税率缺失且未提供 HS Code' } };
        }
        const hit = await pricingSvc.lookupRefundRate(hsCode);
        if (!hit) {
          return { ok: false, error: { code: 'PRICING_FAILED', message: `HS Code ${hsCode} 无退税率映射` } };
        }
        refundRate = hit.rate;
      }

      // 解析佣金率
      let commissionRate = input.commissionRate ?? 0;
      let commissionRuleId = input.commissionRuleId ?? null;
      if (commissionRuleId) {
        const rule = await db.commissionRule.findUnique({ where: { id: commissionRuleId } });
        if (!rule || rule.deletedAt !== null || !rule.isActive) {
          return { ok: false, error: { code: 'PRICING_FAILED', message: '佣金规则非法或已停用' } };
        }
        commissionRate = Number(rule.rate);
      }

      const trackB = pricingSvc.calculateTrackB({
        purchaseCostCny: input.purchaseCostCny,
        refundRate,
        exchangeRate,
        profitMargin: input.profitMargin,
        commissionRate,
      });

      // ── 5. 偏差分级 ──
      const trackAMedianUsd = trackA.priceMedianUsd;
      const trackBFinalUsd = trackB.finalUnitPrice;
      const deviationPercent = round4(((trackBFinalUsd - trackAMedianUsd) / trackAMedianUsd) * 100);

      let deviationLevel: DeviationLevel;
      const absDeviation = Math.abs(deviationPercent);
      if (absDeviation < DEVIATION_WARN_THRESHOLD) {
        deviationLevel = 'ok';
      } else if (absDeviation <= DEVIATION_BLOCK_THRESHOLD) {
        deviationLevel = 'warn';
      } else {
        deviationLevel = 'block';
      }

      const canSend = deviationLevel !== 'block';

      // ── 6. 写入 Quotation 快照字段 ──
      await db.quotation.update({
        where: { id: quotationId },
        data: {
          trackAMedianUsd: round4(trackAMedianUsd),
          trackAUnit: trackA.unit,
          trackBFinalUsd: round4(trackBFinalUsd),
          priceDeviationPercent: deviationPercent,
          priceDeviationLevel: deviationLevel,
          exchangeRate,
          updatedAt: BigInt(Date.now()),
        },
      });

      logger.info('[QuotationPricing] applied', {
        quotationId,
        quotationNumber: quotation.quotationNumber,
        trackAMedianUsd,
        trackBFinalUsd,
        deviationPercent,
        deviationLevel,
      });

      return {
        ok: true,
        data: {
          quotationId,
          trackA,
          trackB,
          trackAMedianUsd,
          trackBFinalUsd,
          deviationPercent,
          deviationLevel,
          canSend,
        },
      };
    } catch (e: any) {
      logger.error('[QuotationPricing] apply failed', { quotationId, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } };
    }
  }

  /**
   * 读取报价单的双轨定价快照，返回偏差分级和是否可发送。
   * 用于报价单发送前的门禁校验。
   */
  async function getPricingCheck(
    quotationId: string,
  ): Promise<QuotationPricingResponse> {
    try {
      const quotation = await db.quotation.findFirst({
        where: { id: quotationId, deletedAt: null },
        select: {
          id: true,
          quotationNumber: true,
          trackAMedianUsd: true,
          trackAUnit: true,
          trackBFinalUsd: true,
          priceDeviationPercent: true,
          priceDeviationLevel: true,
        },
      });
      if (!quotation) {
        return { ok: false, error: { code: 'NOT_FOUND', message: '报价单不存在或已删除' } };
      }

      const deviationLevel = (quotation.priceDeviationLevel as DeviationLevel) || null;
      const deviationPercent = quotation.priceDeviationPercent != null
        ? Number(quotation.priceDeviationPercent)
        : null;
      const trackAMedianUsd = quotation.trackAMedianUsd != null
        ? Number(quotation.trackAMedianUsd.toString())
        : null;
      const trackBFinalUsd = quotation.trackBFinalUsd != null
        ? Number(quotation.trackBFinalUsd.toString())
        : null;

      // 未应用双轨定价的报价单默认可发送（兼容老数据）
      const canSend = deviationLevel !== 'block';

      return {
        ok: true,
        data: {
          quotationId,
          trackA: null as any, // 快照模式不返回完整 TrackA
          trackB: null as any,
          trackAMedianUsd: trackAMedianUsd ?? 0,
          trackBFinalUsd: trackBFinalUsd ?? 0,
          deviationPercent: deviationPercent ?? 0,
          deviationLevel: deviationLevel || 'ok',
          canSend,
        },
      };
    } catch (e: any) {
      logger.error('[QuotationPricing] check failed', { quotationId, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } };
    }
  }

  return { applyTrackPricing, getPricingCheck };
}

// ────────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ────────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────────

let _defaultService: ReturnType<typeof createQuotationPricingService> | null = null;
export function getQuotationPricingService(prisma: PrismaClient): ReturnType<typeof createQuotationPricingService> {
  if (!_defaultService) _defaultService = createQuotationPricingService(prisma);
  return _defaultService;
}
