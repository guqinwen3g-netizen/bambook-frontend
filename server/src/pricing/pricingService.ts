import { pricingInputError, pricingNotFoundError } from './pricingError';
/**
 * 阶段 P1 — 退税美元定价（轨道 B）与出口退税率表服务（PRD 8.2/8.5/8.6）
 *
 * 职责：
 *   1. TaxRefundRate：HS Code → 退税率映射注册表。hsCode @unique 为注册真源，
 *      查询按最长前缀命中（10 位编码可命中 8/6/4/2 位注册项）。
 *   2. 轨道 B 纯函数 calculateTrackB：
 *      终价 = ¥成本 × (1 - 退税率%) ÷ 汇率 × (1 + 利润率%) + ¥成本 × (1 - 退税率%) ÷ 汇率 × 佣金率%
 *      即 netUsdCost = cny × (1 - refund%) ÷ fx；final = net × (1 + margin%) + net × comm%。
 *   3. PricingCalculation：派生值（netUsdCost/profitAmount/commissionAmount/finalUnitPrice）
 *      一律服务端重算，不接受客户端传入；汇率/退税率缺省分别取 ExchangeRate 最新 USD
 *      与 TaxRefundRate 最长前缀命中。
 *
 * 设计原则（与 seasons/risk/businessLines 模块一致）：
 *   - 服务工厂模式 createPricingService(prisma)
 *   - 软删除（deletedAt BigInt）；hsCode 创建后不可修改（注册真源）
 *   - 显式业务错误类型保留中文校验文案和 400/404，未知异常不按文案猜档
 */

import { PrismaClient, TaxRefundRate, PricingCalculation } from '@prisma/client';
import { logger } from '../lib/logger';
import { clampLimit, clampOffset } from '../lib/paging';
import crypto from 'crypto';
import { calculateTrackA, TrackAInput, TrackAResult } from './trackAEstimator';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface TaxRefundRateInput {
  hsCode: string; // 2/4/6/8/10 位数字
  rate: number; // 退税率百分比（0-16）
  description?: string | null;
  isActive?: boolean;
}

export type TaxRefundRatePatch = Partial<Omit<TaxRefundRateInput, 'hsCode'>>;

export interface TrackBInput {
  purchaseCostCny: number;
  refundRate: number; // %
  exchangeRate: number; // CNY per USD
  profitMargin: number; // %
  commissionRate?: number; // %（0-100 任意百分比，0=无佣金）
}

export interface TrackBResult {
  netUsdCost: number;
  profitAmount: number;
  commissionAmount: number;
  finalUnitPrice: number;
}

export interface PricingCalculationInput {
  purchaseCostCny: number;
  refundRate?: number; // 缺省按 hsCode 最长前缀命中
  exchangeRate?: number; // 缺省取最新 USD 汇率
  profitMargin: number;
  commissionRate?: number;
  orderId?: string | null;
  quotationId?: string | null;
  productAssetId?: string | null;
  hsCode?: string | null;
  fxLockId?: string | null;
  commissionRuleId?: string | null; // 佣金率来源规则（P2）；提供时 commissionRate 取规则值快照
  quantity?: number | null;
  status?: string;
  notes?: string | null;
}

export type PricingCalculationPatch = Partial<PricingCalculationInput>;

export interface CalculationListQuery {
  orderId?: string;
  quotationId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** 轨道 A 预览输入（服务层）：在纯函数输入上扩展价格历史命中键 */
export interface TrackAPreviewInput extends TrackAInput {
  fabricCode?: string; // garment：面料编号 → MaterialPriceHistory(fabric) 最新价命中
  yarnCode?: string; // fabric：纱线编号 → MaterialPriceHistory(yarn) 最新价命中
}

const HS_CODE_RE = /^(\d{2}|\d{4}|\d{6}|\d{8}|\d{10})$/;
const CALC_STATUSES = ['Draft', 'Confirmed', 'Archived'] as const;
/** 佣金率合法区间（J2：任意百分比，0=无佣金） */
const COMMISSION_RATE_MIN = 0;
const COMMISSION_RATE_MAX = 100;
/** 退税率合法区间（PRD 8.6：0-16%） */
const REFUND_RATE_MIN = 0;
const REFUND_RATE_MAX = 16;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ────────────────────────────────────────────────────────────────
// 轨道 B 纯函数（导出供测试与路由 preview 复用）
// ────────────────────────────────────────────────────────────────

export function calculateTrackB(input: TrackBInput): TrackBResult {
  const { purchaseCostCny, refundRate, exchangeRate, profitMargin } = input;
  const commissionRate = input.commissionRate ?? 0;

  if (!Number.isFinite(purchaseCostCny) || purchaseCostCny <= 0) throw pricingInputError('采购价必须大于 0');
  if (!Number.isFinite(refundRate) || refundRate < REFUND_RATE_MIN || refundRate > REFUND_RATE_MAX) {
    throw pricingInputError(`退税率必须在 ${REFUND_RATE_MIN}-${REFUND_RATE_MAX}% 之间`);
  }
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw pricingInputError('汇率必须大于 0');
  if (!Number.isFinite(profitMargin) || profitMargin < 0) throw pricingInputError('利润率非法');
  if (!Number.isFinite(commissionRate) || commissionRate < COMMISSION_RATE_MIN || commissionRate > COMMISSION_RATE_MAX) {
    throw pricingInputError(`佣金率必须在 ${COMMISSION_RATE_MIN}-${COMMISSION_RATE_MAX}% 之间`);
  }

  const netUsdCost = round4((purchaseCostCny * (1 - refundRate / 100)) / exchangeRate);
  const profitAmount = round4((netUsdCost * profitMargin) / 100);
  const commissionAmount = round4((netUsdCost * commissionRate) / 100);
  const finalUnitPrice = round4(netUsdCost + profitAmount + commissionAmount);
  return { netUsdCost, profitAmount, commissionAmount, finalUnitPrice };
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createPricingService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  // ══════════════════════════════════════════════════════════════
  // 1. TaxRefundRate
  // ══════════════════════════════════════════════════════════════

  async function getRateOrThrow(id: string): Promise<TaxRefundRate> {
    const row = await db.taxRefundRate.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw pricingNotFoundError('退税率记录不存在');
    return row;
  }

  function assertRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < REFUND_RATE_MIN || rate > REFUND_RATE_MAX) {
      throw pricingInputError(`退税率必须在 ${REFUND_RATE_MIN}-${REFUND_RATE_MAX}% 之间`);
    }
  }

  async function createTaxRefundRate(input: TaxRefundRateInput, actorId: string): Promise<TaxRefundRate> {
    const hsCode = input.hsCode?.trim();
    if (!hsCode || !HS_CODE_RE.test(hsCode)) {
      throw pricingInputError('非法 HS Code（须为 2/4/6/8/10 位数字）');
    }
    assertRate(input.rate);
    const dup = await db.taxRefundRate.findUnique({ where: { hsCode } });
    if (dup) throw pricingInputError('该 HS Code 退税率已存在');

    const ts = now();
    const row = await db.taxRefundRate.create({
      data: {
        id: generateId('TRR'),
        hsCode,
        rate: input.rate,
        description: input.description ?? null,
        isActive: input.isActive ?? true,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[PricingService] tax refund rate created', { id: row.id, hsCode, actorId });
    return row;
  }

  async function listTaxRefundRates(query: { includeInactive?: boolean }) {
    const where: any = { deletedAt: null };
    if (!query.includeInactive) where.isActive = true;
    const [items, total] = await Promise.all([
      db.taxRefundRate.findMany({ where, orderBy: { hsCode: 'asc' } }),
      db.taxRefundRate.count({ where }),
    ]);
    return { items, total };
  }

  async function updateTaxRefundRate(id: string, patch: TaxRefundRatePatch, actorId: string): Promise<TaxRefundRate> {
    const row = await getRateOrThrow(id);
    // hsCode 是注册真源（最长前缀命中依赖其稳定性），禁止修改
    if ((patch as any).hsCode !== undefined) throw pricingInputError('HS Code 不可修改');
    if (patch.rate !== undefined) assertRate(patch.rate);

    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of ['rate', 'description', 'isActive'] as const) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.taxRefundRate.update({ where: { id: row.id }, data });
    logger.info('[PricingService] tax refund rate updated', { id: row.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteTaxRefundRate(id: string, actorId: string): Promise<void> {
    const row = await getRateOrThrow(id);
    await db.taxRefundRate.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[PricingService] tax refund rate soft-deleted', { id: row.id, hsCode: row.hsCode, actorId });
  }

  /**
   * 最长前缀命中：10 位 hsCode 依次尝试 10/8/6/4/2 位前缀，命中首个 isActive 注册项。
   * 无命中返回 null（调用方决定报错或人工输入）。
   */
  async function lookupRefundRate(hsCode: string): Promise<{ hsCode: string; rate: number } | null> {
    const code = hsCode?.trim();
    if (!code || !/^\d+$/.test(code)) return null;
    const prefixes = [10, 8, 6, 4, 2].filter(n => code.length >= n).map(n => code.slice(0, n));
    if (prefixes.length === 0) return null;
    const rows = await db.taxRefundRate.findMany({
      where: { hsCode: { in: prefixes }, isActive: true, deletedAt: null },
    });
    if (rows.length === 0) return null;
    // 最长前缀优先
    rows.sort((a: TaxRefundRate, b: TaxRefundRate) => b.hsCode.length - a.hsCode.length);
    return { hsCode: rows[0].hsCode, rate: Number(rows[0].rate) };
  }

  // ══════════════════════════════════════════════════════════════
  // 2. PricingCalculation（轨道 B）
  // ══════════════════════════════════════════════════════════════

  async function getCalculationOrThrow(id: string): Promise<PricingCalculation> {
    const row = await db.pricingCalculation.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw pricingNotFoundError('定价计算不存在');
    return row;
  }

  /** 最新 USD 汇率（CNY per USD）；无记录返回 null */
  async function latestUsdRate(): Promise<number | null> {
    const row = await db.exchangeRate.findFirst({
      where: { currency: 'USD' },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? Number(row.rate) : null;
  }

  /** 归一化输入 + 默认值填充 + 服务端重算（不信任客户端派生值） */
  async function resolveCalculationData(input: PricingCalculationInput) {
    if (!Number.isFinite(input.purchaseCostCny) || input.purchaseCostCny <= 0) {
      throw pricingInputError('采购价必须大于 0');
    }
    if (!Number.isFinite(input.profitMargin) || input.profitMargin < 0) {
      throw pricingInputError('利润率非法');
    }

    let hsCode = input.hsCode?.trim() || null;
    let refundRate = input.refundRate;
    if (refundRate === undefined || refundRate === null) {
      if (!hsCode) throw pricingInputError('退税率缺失且未提供 HS Code');
      const hit = await lookupRefundRate(hsCode);
      if (!hit) throw pricingInputError(`HS Code ${hsCode} 无退税率映射，请人工指定退税率`);
      refundRate = hit.rate;
    }

    let exchangeRate = input.exchangeRate;
    if (exchangeRate === undefined || exchangeRate === null) {
      const latest = await latestUsdRate();
      if (latest === null) throw pricingInputError('汇率缺失且无最新 USD 汇率记录');
      exchangeRate = latest;
    }

    // 佣金率：commissionRuleId 提供时以规则值为快照（规则是佣金配置真源），
    // 否则取显式 commissionRate（默认 0）
    let commissionRuleId = input.commissionRuleId ?? null;
    let commissionRate = input.commissionRate ?? 0;
    if (commissionRuleId) {
      const rule = await db.commissionRule.findUnique({ where: { id: commissionRuleId } });
      if (!rule || rule.deletedAt !== null || !rule.isActive) throw pricingInputError('佣金规则非法或已停用');
      commissionRate = Number(rule.rate);
    }

    const derived = calculateTrackB({
      purchaseCostCny: input.purchaseCostCny,
      refundRate,
      exchangeRate,
      profitMargin: input.profitMargin,
      commissionRate,
    });

    if (input.status !== undefined && !(CALC_STATUSES as readonly string[]).includes(input.status)) {
      throw pricingInputError(`非法状态：${input.status}`);
    }

    return { hsCode, refundRate, exchangeRate, commissionRate, commissionRuleId, derived };
  }

  async function createCalculation(input: PricingCalculationInput, actorId: string): Promise<PricingCalculation> {
    const { hsCode, refundRate, exchangeRate, commissionRate, commissionRuleId, derived } = await resolveCalculationData(input);
    const ts = now();
    const row = await db.pricingCalculation.create({
      data: {
        id: generateId('PRC'),
        purchaseCostCny: input.purchaseCostCny,
        refundRate,
        exchangeRate,
        profitMargin: input.profitMargin,
        commissionRate,
        netUsdCost: derived.netUsdCost,
        profitAmount: derived.profitAmount,
        commissionAmount: derived.commissionAmount,
        finalUnitPrice: derived.finalUnitPrice,
        orderId: input.orderId ?? null,
        quotationId: input.quotationId ?? null,
        productAssetId: input.productAssetId ?? null,
        hsCode,
        fxLockId: input.fxLockId ?? null,
        commissionRuleId,
        quantity: input.quantity ?? null,
        status: input.status ?? 'Draft',
        notes: input.notes ?? null,
        createdBy: actorId,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[PricingService] calculation created', {
      id: row.id, finalUnitPrice: derived.finalUnitPrice, actorId,
    });
    return row;
  }

  async function listCalculations(query: CalculationListQuery) {
    const where: any = { deletedAt: null };
    if (query.orderId) where.orderId = query.orderId;
    if (query.quotationId) where.quotationId = query.quotationId;
    if (query.status) where.status = query.status;
    const take = clampLimit(query.limit, 50, 200);
    const skip = clampOffset(query.offset);
    const [items, total] = await Promise.all([
      db.pricingCalculation.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      db.pricingCalculation.count({ where }),
    ]);
    return { items, total };
  }

  const CALC_PATCH_INPUT_FIELDS = [
    'purchaseCostCny', 'refundRate', 'exchangeRate', 'profitMargin', 'commissionRate',
    'orderId', 'quotationId', 'productAssetId', 'hsCode', 'fxLockId', 'quantity', 'status', 'notes',
  ] as const;

  async function updateCalculation(id: string, patch: PricingCalculationPatch, actorId: string): Promise<PricingCalculation> {
    const row = await getCalculationOrThrow(id);
    if (row.status === 'Archived') throw pricingInputError('已归档计算不可修改');

    // 合并现有值 + patch，重算派生项（任何输入变化都会传导到终价）
    const merged: PricingCalculationInput = {
      purchaseCostCny: patch.purchaseCostCny ?? Number(row.purchaseCostCny),
      refundRate: patch.refundRate ?? Number(row.refundRate),
      exchangeRate: patch.exchangeRate ?? Number(row.exchangeRate),
      profitMargin: patch.profitMargin ?? Number(row.profitMargin),
      commissionRate: patch.commissionRate ?? Number(row.commissionRate),
      commissionRuleId: patch.commissionRuleId !== undefined ? patch.commissionRuleId : row.commissionRuleId,
      hsCode: patch.hsCode !== undefined ? patch.hsCode : row.hsCode,
      status: patch.status,
    };
    const { hsCode, refundRate, exchangeRate, commissionRate, commissionRuleId, derived } = await resolveCalculationData(merged);

    const data: Record<string, unknown> = {
      updatedAt: BigInt(now()),
      purchaseCostCny: merged.purchaseCostCny,
      refundRate,
      exchangeRate,
      profitMargin: merged.profitMargin,
      commissionRate,
      commissionRuleId,
      hsCode,
      netUsdCost: derived.netUsdCost,
      profitAmount: derived.profitAmount,
      commissionAmount: derived.commissionAmount,
      finalUnitPrice: derived.finalUnitPrice,
    };
    for (const f of ['orderId', 'quotationId', 'productAssetId', 'fxLockId', 'quantity', 'status', 'notes'] as const) {
      if ((patch as any)[f] !== undefined) data[f] = (patch as any)[f];
    }
    const updated = await db.pricingCalculation.update({ where: { id: row.id }, data });
    logger.info('[PricingService] calculation updated', { id: row.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteCalculation(id: string, actorId: string): Promise<void> {
    const row = await getCalculationOrThrow(id);
    await db.pricingCalculation.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[PricingService] calculation soft-deleted', { id: row.id, actorId });
  }

  // ══════════════════════════════════════════════════════════════
  // 2.5 轨道 A 估算（PRD 8.1/8.6）：价格历史命中解析 + 纯函数汇总
  // ══════════════════════════════════════════════════════════════

  /**
   * 轨道 A 估算预览：显式价格优先（manual）；未提供时按 fabricCode/yarnCode
   * 命中 MaterialPriceHistory 最新价（price_history）；均未命中走行业基准。
   * 不落库（PRD 8.4 轨道 A 仅内部使用，试算口径与 track-b-preview 一致）。
   */
  async function estimateTrackA(input: TrackAPreviewInput): Promise<TrackAResult> {
    const sources: TrackAInput['sources'] = { ...(input.sources ?? {}) };
    const resolved: TrackAInput = { ...input, sources };

    if (input.category === 'garment' && input.fabricPriceCny === undefined && input.fabricCode?.trim()) {
      const hit = await db.materialPriceHistory.findFirst({
        where: { deletedAt: null, materialType: 'fabric', materialCode: input.fabricCode.trim() },
        orderBy: [{ priceDate: 'desc' }, { createdAt: 'desc' }],
      });
      if (hit) {
        resolved.fabricPriceCny = Number(hit.price);
        sources.fabric = 'price_history';
      }
    }
    if (input.category === 'fabric' && input.yarnPriceCnyPerKg === undefined && input.yarnCode?.trim()) {
      const hit = await db.materialPriceHistory.findFirst({
        where: { deletedAt: null, materialType: 'yarn', materialCode: input.yarnCode.trim() },
        orderBy: [{ priceDate: 'desc' }, { createdAt: 'desc' }],
      });
      if (hit) {
        resolved.yarnPriceCnyPerKg = Number(hit.price);
        sources.yarn = 'price_history';
      }
    }
    return calculateTrackA(resolved);
  }

  return {
    // 退税率表
    createTaxRefundRate,
    listTaxRefundRates,
    updateTaxRefundRate,
    deleteTaxRefundRate,
    lookupRefundRate,
    // 轨道 A
    estimateTrackA,
    // 轨道 B
    calculateTrackB: (input: TrackBInput) => calculateTrackB(input),
    createCalculation,
    listCalculations,
    updateCalculation,
    deleteCalculation,
    latestUsdRate,
  };
}

export type PricingService = ReturnType<typeof createPricingService>;
