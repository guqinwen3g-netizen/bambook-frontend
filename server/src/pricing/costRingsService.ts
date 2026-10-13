import { pricingNotFoundError } from './pricingError';
import type { TokenPayload } from '../auth/service';
/**
 * costRingsService.ts — 订单「成本三环」对比（2026-09-30 · 三阶段成本模型咬合件）
 *
 * ── 为什么需要（Kevin 2026-09-30 拍板采纳三阶段成本模型）──
 *   ① 报价成本 = PricingCalculation（采购成本CNY + 退税 + 汇率 + 利润率 → 最终单价）；
 *   ② 目标成本 = BOM（接单后核价单骨架）+ CostEstimate（材料/加工/管理估算）；
 *   ③ 实际成本 = OrderProfitSheet（收入/采购/运费/杂费/银行费/折让，CNY 归一，orderId @unique）。
 *   三环**各自已实现**（pricingService / bomService / profitSheetService），但互相不引用、无对比视图
 *   ⇒ 业务员看不到「报价时以为赚多少 → 接单后目标赚多少 → 实际赚多少」的差异链。
 *
 * ── 口径纪律（防"同数不同判"）──
 *   - 本文件**只做读与展示形状**，不改任何结算判定（E 桶 #8/#9/#10/#13 口径一律不碰）；
 *   - 所有数值推导集中在纯函数 `buildCostRings`（可单测）；服务层只负责取数；
 *   - **不猜**：任一环缺输入（如 finalUnitPrice 或 quantity 缺一）⇒ 对应派生值为 null，
 *     并把缺的东西如实放进 `missing`，绝不拿默认值冒充；
 *   - 实际环**直接引用** OrderProfitSheet 的真源字段（grossProfit/grossMargin 不重算），
 *     差异对比用「实际总成本 = salesRevenue − grossProfit」由真源字段推导（一致性由利润表服务保证）。
 */
import { PrismaClient } from '@prisma/client';
import { readCostEvidence, type CostEvidence } from './costEvidence';
import { withCurrentCostEvidence } from './currentCostEvidence';
export type DisplayCostEvidence = Omit<CostEvidence, 'status'> & {status: 'complete' | 'pending' | 'unknown'};

export interface QuoteRingInput {
  purchaseCostCny: number | null;
  finalUnitPrice: number | null;
  quantity: number | null;
  profitAmount: number | null;
  profitMargin: number | null;
}

export interface TargetRingInput {
  sellingPrice: number | null;
  currency: string | null;
  /** 成本估算行的币种列表（可多种）。跨币种 ⇒ 不做减法、不隐式折算（与 #13 单币种口径一致） */
  estimateCurrencies?: Array<string | null>;
  costEstimateTotal: number | null;
}

export interface ActualRingInput {
  details?: unknown;
  salesRevenue: number | null;
  purchaseCost: number | null;
  freightCost: number | null;
  miscCost: number | null;
  bankFeeCost: number | null;
  allowanceCost: number | null;
  grossProfit: number | null;
  grossMargin: number | null;
}

export interface CostRingsRawInput {
  order: { contractAmount: number | null; totalNet: number | null; currency: string | null } | null;
  quote: QuoteRingInput | null;
  target: TargetRingInput | null;
  actual: ActualRingInput | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const knownNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round2(numeric) : null;
};

/** 毛利率 = 利润 / 收入（收入 > 0 才算，否则 null —— 不造 0 毛利率） */
function margin(profit: number | null, revenue: number | null): number | null {
  if (profit === null || revenue === null || revenue <= 0) return null;
  return round2((profit / revenue) * 100);
}

/**
 * 纯函数：把三环原始输入整理成对比视图。
 * - quoteRing：估算收入 = finalUnitPrice × quantity（两者都有才算，否则 null 不猜）；
 * - targetRing：目标毛利 = sellingPrice − ΣcostEstimate（都非空才算）；
 * - actualRing：实际总成本 = salesRevenue − grossProfit（由利润表真源字段推导）；
 * - deltas：仅在两侧都存在时给出，否则 null（缺环不比）。
 */
export function buildCostRings(input: CostRingsRawInput): {
  quoteRing: {
    estimateCostCny: number | null;
    /** 估算收入（整单，美元）—— 直接取 PricingCalculation.finalUnitPrice（整单口径） */
    estimateRevenueUsd: number | null;
    /** 估算单位售价（美元）= finalUnitPrice / quantity（quantity 有效时） */
    estimateUnitPriceUsd: number | null;
    /** 估算利润（整单，美元） */
    estimateProfitUsd: number | null;
    estimateMarginPct: number | null;
  } | null;
  targetRing: {
    targetCostCny: number | null;
    targetRevenueCny: number | null;
    targetProfitCny: number | null;
    targetMarginPct: number | null;
    crossCurrency: boolean;
  } | null;
  actualRing: {
    costEvidence: DisplayCostEvidence;
    actualRevenueCny: number | null;
    actualCostCny: number | null;
    actualProfitCny: number | null;
    actualMarginPct: number | null;
    breakdown: { purchase: number | null; freight: number | null; misc: number | null; bankFee: number | null; allowance: number | null };
  } | null;
  deltas: {
    costTargetVsActual: number | null;
    profitQuoteVsActual: number | null;
    profitTargetVsActual: number | null;
  };
  missing: string[];
} {
  const missing: string[] = [];
  if (!input.quote) missing.push('pricing_calculation');
  if (!input.target) missing.push('bom');
  if (!input.actual) missing.push('profit_sheet');

  // ── ① 报价环 ──
  let quoteRing: {
    estimateCostCny: number | null;
    estimateRevenueUsd: number | null;
    estimateUnitPriceUsd: number | null;
    estimateProfitUsd: number | null;
    estimateMarginPct: number | null;
  } | null = null;
  if (input.quote) {
    const q = input.quote;
    // ★ 口径修正（2026-09-30 真跑抓出）：`PricingCalculation.finalUnitPrice` 字段名易误读，
    //   实际值是 **整单** 美元价（pricingService 派生：netUsdCost + profitAmount + commissionAmount，
    //   与 purchaseCostCny / profitAmount 同为整单口径）⇒ 估算收入**直接取它**，绝不乘 quantity；
    //   真正的"每单位售价"另给 = finalUnitPrice / quantity（quantity 有效时）。
    const hasTotal = q.finalUnitPrice !== null && q.finalUnitPrice !== undefined;
    const hasQty = q.quantity !== null && q.quantity !== undefined && Number(q.quantity) > 0;
    const totalUsd = hasTotal ? round2(Number(q.finalUnitPrice)) : null;
    quoteRing = {
      estimateCostCny: q.purchaseCostCny === null || q.purchaseCostCny === undefined ? null : round2(Number(q.purchaseCostCny)),
      estimateRevenueUsd: totalUsd,
      estimateUnitPriceUsd: totalUsd !== null && hasQty ? round2(Number(q.finalUnitPrice) / Number(q.quantity)) : null,
      estimateProfitUsd: q.profitAmount === null || q.profitAmount === undefined ? null : round2(Number(q.profitAmount)),
      estimateMarginPct: q.profitMargin === null || q.profitMargin === undefined ? null : round2(Number(q.profitMargin)),
    };
  }

  // ── ② 目标环 ──
  let targetRing: {
    targetCostCny: number | null;
    targetRevenueCny: number | null;
    targetProfitCny: number | null;
    targetMarginPct: number | null;
    /** 收入与成本估算币种不一致（或估算本身多币种）⇒ 毛利不给数，不做隐式折算 */
    crossCurrency: boolean;
  } | null = null;
  if (input.target) {
    const t = input.target;
    const targetCostCny = knownNumber(t.costEstimateTotal);
    const targetRevenueCny = knownNumber(t.sellingPrice);
    if (targetCostCny === null) missing.push('targetCostEstimate');
    // ★ 币种归一纪律（与 #13「混合币种不隐式折算」一致）：
    //   BOM 售价与成本估算各自带 currency，跨币种直接相减会得出毫无意义的毛利率
    //   （真跑见过：售价 24000 USD − 成本 168000 CNY ⇒ 毛利率 −600%）。
    //   跨币种 ⇒ 只给"成本/收入"两个数，毛利置 null 由前端显示"—（币种不一致，未折算）"。
    const estCurrencies = [...new Set((t.estimateCurrencies || []).filter((c): c is string => !!c))];
    const crossCurrency =
      estCurrencies.length > 1 || (estCurrencies.length === 1 && !!t.currency && estCurrencies[0] !== t.currency);
    const targetProfitCny =
      crossCurrency || targetRevenueCny === null || targetCostCny === null ? null : round2(targetRevenueCny - targetCostCny);
    targetRing = {
      targetCostCny,
      targetRevenueCny,
      targetProfitCny,
      targetMarginPct: margin(targetProfitCny, targetRevenueCny),
      crossCurrency,
    };
  }

  // ── ③ 实际环 ──
  let actualRing: {
    costEvidence: DisplayCostEvidence;
    actualRevenueCny: number | null;
    actualCostCny: number | null;
    actualProfitCny: number | null;
    actualMarginPct: number | null;
    breakdown: { purchase: number | null; freight: number | null; misc: number | null; bankFee: number | null; allowance: number | null };
  } | null = null;
  if (input.actual) {
    const a = input.actual;
    const num = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : round2(Number(v)));
    const evidence = readCostEvidence(a.details);
    const revenue = num(evidence?.status === 'complete' ? (evidence as any).actualRevenueCny : a.salesRevenue);
    const complete = evidence?.status === 'complete' && typeof evidence.actualCostCny === 'number' && Number.isFinite(evidence.actualCostCny) && typeof evidence.actualProfitCny === 'number' && Number.isFinite(evidence.actualProfitCny);
    const costEvidence: DisplayCostEvidence = evidence ? {...evidence, status: complete ? 'complete' : 'pending', actualCostCny: complete ? evidence.actualCostCny : null, actualProfitCny: complete ? evidence.actualProfitCny : null, pendingReasons: Array.isArray(evidence.pendingReasons) ? evidence.pendingReasons : ['实际成本依据不完整']} : {version:2,calculatedAt:'',status:'unknown',committedAmountCny:null,acceptedAmountCny:null,paidPrincipalCny:null,actualCostCny:null,actualProfitCny:null,pendingReasons:['历史利润表缺少成本依据，请重新核算']};
    if (!complete) missing.push(evidence ? 'actual_cost_pending' : 'actual_cost_evidence_unknown');
    const grossProfit = complete ? num(evidence!.actualProfitCny) : null;
    const actualCostCny = complete ? num(evidence!.actualCostCny) : null;
    actualRing = {
      costEvidence,
      actualRevenueCny: revenue,
      actualCostCny,
      actualProfitCny: grossProfit,
      actualMarginPct: margin(grossProfit, revenue),
      breakdown: {
        purchase: complete && (evidence as any).actualBreakdown ? num((evidence as any).actualBreakdown.procurement + (evidence as any).actualBreakdown.companySupply) : null,
        freight: complete ? num((evidence as any).actualBreakdown?.logistics) : null,
        misc: complete ? num((evidence as any).actualBreakdown?.otherExpenses) : null,
        bankFee: complete ? num((evidence as any).actualBreakdown?.bankFees) : null,
        allowance: complete ? num((evidence as any).actualBreakdown?.allowances) : null,
      },
    };
  }

  // ── 差异（两侧都有才算；缺环不比）──
  const actualTotalCost = actualRing?.actualCostCny ?? null;
  const deltas = {
    costTargetVsActual:
      targetRing && targetRing.targetCostCny !== null && input.target?.currency === 'CNY' && !targetRing.crossCurrency && actualTotalCost !== null ? round2(actualTotalCost - targetRing.targetCostCny) : null,
    profitQuoteVsActual: null, // USD quote profit and CNY actual profit have no fixed conversion evidence.
    profitTargetVsActual:
      input.target?.currency === 'CNY' && !targetRing?.crossCurrency && targetRing?.targetProfitCny != null && actualRing?.actualProfitCny != null
        ? round2(actualRing.actualProfitCny - targetRing.targetProfitCny)
        : null,
  };

  return { quoteRing, targetRing, actualRing, deltas, missing };
}

export function createCostRingsService(prisma: PrismaClient) {
  async function getOrderCostRings(orderId: string, actor?: TokenPayload) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { id: true, contractAmount: true, totalNet: true, currency: true, customer: true },
    });
    if (!order) {
      throw pricingNotFoundError(`订单 ${orderId} 不存在`);
    }

    // ① 报价成本：该订单关联的最新一条定价计算（转单时已挂 orderId；手工挂单场景同样命中）
    const pricingCalc = await prisma.pricingCalculation.findFirst({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { purchaseCostCny: true, finalUnitPrice: true, quantity: true, profitAmount: true, profitMargin: true },
    });

    // ② 目标成本：该订单最新一张未归档 BOM + 其成本估算行
    const bom = await prisma.bOM.findFirst({
      where: { orderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, sellingPrice: true, currency: true, lines: { select: { id: true } } },
    });
    let costEstimateTotal: number | null = null;
    let costEstimateCount = 0;
    let estimateCurrencies: Array<string | null> = [];
    if (bom) {
      const estimates = await prisma.costEstimate.findMany({
        where: { bomId: bom.id },
        select: { amount: true, currency: true },
      });
      costEstimateCount = estimates.length;
      estimateCurrencies = estimates.map((e) => (e as { currency?: string | null }).currency ?? null);
      const amounts = estimates.map(e => knownNumber(e.amount));
      if (amounts.length && amounts.every((amount): amount is number => amount !== null)) {
        costEstimateTotal = round2(amounts.reduce((sum, amount) => sum + amount, 0));
      }
    }

    // ③ 实际成本：利润表（orderId @unique；未生成为 null —— 不自动生成，保持本端点只读）
    const storedSheet = await prisma.orderProfitSheet.findUnique({
      where: { orderId },
      select: {
        salesRevenue: true, purchaseCost: true, freightCost: true, miscCost: true,
        bankFeeCost: true, allowanceCost: true, grossProfit: true, grossMargin: true, generatedAt: true, details: true,
      },
    });
    const sheet = storedSheet ? await withCurrentCostEvidence(prisma, { ...storedSheet, orderId }, actor) : null;

    const result = buildCostRings({
      order: { contractAmount: order.contractAmount === null ? null : Number(order.contractAmount), totalNet: order.totalNet === null ? null : Number(order.totalNet), currency: order.currency },
      quote: pricingCalc
        ? {
            purchaseCostCny: pricingCalc.purchaseCostCny === null ? null : Number(pricingCalc.purchaseCostCny),
            finalUnitPrice: pricingCalc.finalUnitPrice === null ? null : Number(pricingCalc.finalUnitPrice),
            quantity: pricingCalc.quantity === null || pricingCalc.quantity === undefined ? null : Number(pricingCalc.quantity),
            profitAmount: pricingCalc.profitAmount === null ? null : Number(pricingCalc.profitAmount),
            profitMargin: pricingCalc.profitMargin === null ? null : Number(pricingCalc.profitMargin),
          }
        : null,
      target: bom && costEstimateCount > 0
        ? {
            sellingPrice: bom.sellingPrice === null ? null : Number(bom.sellingPrice),
            currency: bom.currency,
            estimateCurrencies: estimateCurrencies,
            costEstimateTotal,
          }
        : null,
      actual: sheet
        ? {
            details: sheet.details,
            salesRevenue: sheet.salesRevenue === null ? null : Number(sheet.salesRevenue),
            purchaseCost: sheet.purchaseCost === null ? null : Number(sheet.purchaseCost),
            freightCost: sheet.freightCost === null ? null : Number(sheet.freightCost),
            miscCost: sheet.miscCost === null ? null : Number(sheet.miscCost),
            bankFeeCost: sheet.bankFeeCost === null ? null : Number(sheet.bankFeeCost),
            allowanceCost: sheet.allowanceCost === null ? null : Number(sheet.allowanceCost),
            grossProfit: sheet.grossProfit === null ? null : Number(sheet.grossProfit),
            grossMargin: sheet.grossMargin === null ? null : Number(sheet.grossMargin),
          }
        : null,
    });

    if (bom && costEstimateCount === 0) {
      result.missing = result.missing.filter(key => key !== 'bom');
      result.missing.push('targetCostEstimate');
    }
    return {
      orderId,
      currency: order.currency,
      customer: order.customer,
      bom: bom ? { id: bom.id, costEstimateCount } : null,
      ...result,
    };
  }

  return { getOrderCostRings };
}
