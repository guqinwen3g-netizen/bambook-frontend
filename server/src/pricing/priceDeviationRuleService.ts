/**
 * priceDeviationRuleService.ts — §9.2 价格审批规则 ①②④ 评估服务（W4 接入）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/价格审批规则.md §2（五条件说明，DR-007 去阈值化）
 *   - docs/design/03-业务规则/价格审批规则.md §6（触发矩阵 #2/#3/#6/#7）
 *   - docs/design/03-业务规则/业务规则总览.md §9.2（policyKey='price_approval'，hitConditions 合并）
 *
 * 规则口径：
 *   ① 折扣>10%：discountPercent = 1 - finalUnitPrice/catalogPrice > 0.10 → 命中（warn）
 *      目录价真源：FabricPriceHistory（priceType='customer'），优先客户专属价，其次通用价；
 *      目录价缺失 → 跳过条件 ①（§6 #2 异常分支），findings.discount.catalogMissing=true
 *   ② 新客首单：Relation.stage ∈ {Lead,Opportunity,Quotation,TrialOrder} 且该 Relation 历史 Order=0 → 命中（warn）
 *      customerRelationId 未绑定 → 视为新客 + relationUnbound 标记（§6 #3 异常分支，等绑定后复核）
 *   ④ 低于成本价：finalUnitPrice（折 CNY）< ProductAsset.cost → 命中（block，红标最严）
 *      成本缺失 → 不命中 + costMissing=true（§6 #6 异常分支：走 ⑤ 兜底，payload 标记供审批人参考）
 *      报价币种非 CNY 且无汇率 → 不可折算，不命中 + compareUnavailable=true
 *
 * 合并规则（决策点 3-A）：多条件命中 → 调用方生成单条 ApprovalRequest，
 *   payload.policyKey='price_approval' + payload.hitConditions 数组标注全部命中条件编号。
 *   本服务只产出评估结果，不写库、不建审批单（写库由 quotationService 同事务完成，同 ⑤ 双轨范式）。
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────
// 常量：条件编号 + 审批策略 key（业务规则总览 §9.2 真源，禁止散落硬编码）
// ────────────────────────────────────────────────────────────────

export const PRICE_APPROVAL_POLICY_KEY = 'price_approval' as const;

export const PRICE_RULE_CONDITION = {
  /** ① 折扣>10%（黄标 warn） */
  DISCOUNT_GT10PCT: 'discount_gt10pct',
  /** ② 新客首单（黄标 warn） */
  NEW_CUSTOMER_FIRST_ORDER: 'new_customer_first_order',
  /** ④ 低于成本价（红标 block，无豁免自批） */
  BELOW_COST_PRICE: 'below_cost_price',
  /** ⑤ 双轨偏差 >15%/>30%（已在轨，quotationService 计算后并入 hitConditions） */
  DUAL_TRACK_DEVIATION: 'dual_track_deviation',
} as const;
export type PriceRuleCondition = (typeof PRICE_RULE_CONDITION)[keyof typeof PRICE_RULE_CONDITION];

/** ① 命中阈值：折扣 > 10% */
const DISCOUNT_HIT_THRESHOLD = 0.1;

/** ② 新客 stage 集合（§2 ②：非 Customer/Key/Churned 即新客） */
const NEW_CUSTOMER_STAGES = new Set(['Lead', 'Opportunity', 'Quotation', 'TrialOrder']);

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface PriceRuleLineInput {
  fabricCode?: string | null;
  unitPrice: number;
  unit?: string | null;
}

export interface EvaluateQuotationPriceRulesInput {
  customerRelationId: string | null;
  currency: string;
  /** currency → CNY 汇率（非 CNY 报价折算成本比较用；缺失时 ④ 不可折算） */
  exchangeRate?: number | null;
  lines: PriceRuleLineInput[];
}

export interface DiscountFindingLine {
  fabricCode: string;
  unitPrice: number;
  catalogPrice: number;
  discountPercent: number; // 0-1 小数（如 0.125 = 12.5%）
}

export interface BelowCostFindingLine {
  fabricCode: string;
  unitPriceCny: number;
  costCny: number;
}

export interface PriceRuleEvaluation {
  /** 命中条件编号数组（决策点 3-A：挂 ApprovalRequest.payload.hitConditions） */
  hitConditions: PriceRuleCondition[];
  /** 合并分级：④ 命中 → block；①/② 命中 → warn；无命中 → ok */
  level: 'ok' | 'warn' | 'block';
  findings: {
    discount: {
      hit: boolean;
      /** 存在有 fabricCode 的行但无任何目录价记录 → true（条件 ① 整体跳过） */
      catalogMissing: boolean;
      maxDiscountPercent: number | null;
      lines: DiscountFindingLine[];
    };
    newCustomer: {
      hit: boolean;
      /** customerRelationId=null → 视为新客并标记，等绑定后复核 */
      relationUnbound: boolean;
      stage: string | null;
      historyOrderCount: number | null;
    };
    belowCost: {
      hit: boolean;
      /** 任一有 fabricCode 的比较行缺实际成本档案（ProductAsset.cost 缺失或 ≤0） */
      costMissing: boolean;
      /** 非 CNY 报价且缺汇率 → 成本不可折算，条件 ④ 不判 */
      compareUnavailable: boolean;
      lines: BelowCostFindingLine[];
    };
  };
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createPriceDeviationRuleService(prisma: PrismaClient) {
  const db = prisma as any;

  // ── 内部：批量取目录价（priceType='customer'），按行挑选最优匹配 ──
  // 挑选优先级：客户专属价 > 通用价；报价币种匹配 > 其他币种；effectiveDate 最新优先
  async function loadCatalogPrices(fabricCodes: string[], customerRelationId: string | null, currency: string) {
    if (fabricCodes.length === 0) return new Map<string, any>();
    const rows: any[] = await db.fabricPriceHistory.findMany({
      where: {
        deletedAt: null,
        priceType: 'customer',
        productAsset: { sku: { in: fabricCodes }, deletedAt: null },
      },
      include: { productAsset: { select: { sku: true } } },
    });
    const bySku = new Map<string, any[]>();
    for (const r of rows) {
      const sku = r.productAsset?.sku;
      if (!sku) continue;
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku)!.push(r);
    }
    const picked = new Map<string, any>();
    for (const [sku, list] of bySku) {
      const score = (r: any) => {
        let s = 0;
        if (customerRelationId && r.customerOrganizationId === customerRelationId) s += 4;
        else if (!r.customerOrganizationId) s += 2;
        if (r.currency === currency) s += 1;
        return s;
      };
      list.sort((a, b) => score(b) - score(a) || String(b.effectiveDate ?? '').localeCompare(String(a.effectiveDate ?? '')));
      picked.set(sku, list[0]);
    }
    return picked;
  }

  // ── 内部：批量取成本档案（ProductAsset.cost，CNY 口径） ──
  async function loadCosts(fabricCodes: string[]) {
    const map = new Map<string, number | null>();
    if (fabricCodes.length === 0) return map;
    const assets: any[] = await db.productAsset.findMany({
      where: { sku: { in: fabricCodes }, deletedAt: null },
      select: { sku: true, cost: true },
    });
    for (const a of assets) map.set(a.sku, a.cost == null ? null : Number(a.cost));
    return map;
  }

  // ── 内部：② 新客首单判定 ──
  async function evalNewCustomer(customerRelationId: string | null): Promise<PriceRuleEvaluation['findings']['newCustomer']> {
    if (!customerRelationId) {
      return { hit: true, relationUnbound: true, stage: null, historyOrderCount: null };
    }
    const relation = await db.relation.findUnique({
      where: { id: customerRelationId },
      select: { stage: true },
    });
    const stage: string | null = relation?.stage ?? null;
    if (!stage || !NEW_CUSTOMER_STAGES.has(stage)) {
      return { hit: false, relationUnbound: false, stage, historyOrderCount: null };
    }
    const historyOrderCount: number = await db.order.count({
      where: { customerRelationId, deletedAt: null },
    });
    return { hit: historyOrderCount === 0, relationUnbound: false, stage, historyOrderCount };
  }

  async function evaluateQuotationRules(input: EvaluateQuotationPriceRulesInput): Promise<PriceRuleEvaluation> {
    const currency = (input.currency ?? '').trim().toUpperCase();
    const codedLines = input.lines.filter((l) => l.fabricCode && Number.isFinite(l.unitPrice));
    const fabricCodes = [...new Set(codedLines.map((l) => l.fabricCode as string))];

    // ── ② 新客首单（单据级） ──
    const newCustomer = await evalNewCustomer(input.customerRelationId);

    // ── ① 折扣>10%（行级） ──
    const discountLines: DiscountFindingLine[] = [];
    let catalogMissing = false;
    if (fabricCodes.length > 0) {
      const catalog = await loadCatalogPrices(fabricCodes, input.customerRelationId, input.currency);
      catalogMissing = catalog.size === 0;
      for (const l of codedLines) {
        const rec = catalog.get(l.fabricCode as string);
        if (!rec) continue;
        const catalogPrice = Number(rec.amount);
        if (!Number.isFinite(catalogPrice) || catalogPrice <= 0) continue;
        // 目录价币种与报价币种不一致时不判折扣（避免跨币种误判；① 以同币种目录价为准）
        if ((rec.currency ?? '').toUpperCase() !== currency) continue;
        const discountPercent = 1 - l.unitPrice / catalogPrice;
        if (discountPercent > DISCOUNT_HIT_THRESHOLD) {
          discountLines.push({ fabricCode: l.fabricCode as string, unitPrice: l.unitPrice, catalogPrice, discountPercent });
        }
      }
    }

    // ── ④ 低于成本价（行级，统一折 CNY 比较） ──
    const belowCostLines: BelowCostFindingLine[] = [];
    let costMissing = false;
    const compareUnavailable = currency !== 'CNY' && !(Number.isFinite(input.exchangeRate) && (input.exchangeRate as number) > 0);
    if (fabricCodes.length > 0) {
      const costs = await loadCosts(fabricCodes);
      costMissing = fabricCodes.some((code) => {
        const cost = costs.get(code);
        return cost == null || !Number.isFinite(cost) || cost <= 0;
      });
      for (const l of codedLines) {
        if (compareUnavailable) continue;
        const costCny = costs.get(l.fabricCode as string);
        if (!costCny || !Number.isFinite(costCny) || costCny <= 0) continue;
        const unitPriceCny = currency === 'CNY' ? l.unitPrice : l.unitPrice * (input.exchangeRate as number);
        if (unitPriceCny < costCny) {
          belowCostLines.push({ fabricCode: l.fabricCode as string, unitPriceCny, costCny });
        }
      }
    }

    // ── 合并命中条件（决策点 3-A：单条 ApprovalRequest，hitConditions 数组） ──
    const hitConditions: PriceRuleCondition[] = [];
    if (discountLines.length > 0) hitConditions.push(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
    if (newCustomer.hit) hitConditions.push(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
    if (belowCostLines.length > 0) hitConditions.push(PRICE_RULE_CONDITION.BELOW_COST_PRICE);

    const level: PriceRuleEvaluation['level'] =
      belowCostLines.length > 0 ? 'block' : hitConditions.length > 0 ? 'warn' : 'ok';

    if (hitConditions.length > 0) {
      logger.info('[PriceRules] 报价价格规则命中', {
        hitConditions,
        level,
        discountLines: discountLines.length,
        newCustomer: newCustomer.hit,
        belowCostLines: belowCostLines.length,
      });
    }

    return {
      hitConditions,
      level,
      findings: {
        discount: {
          hit: discountLines.length > 0,
          catalogMissing,
          maxDiscountPercent: discountLines.length > 0 ? Math.max(...discountLines.map((l) => l.discountPercent)) : null,
          lines: discountLines,
        },
        newCustomer,
        belowCost: {
          hit: belowCostLines.length > 0,
          costMissing,
          compareUnavailable,
          lines: belowCostLines,
        },
      },
    };
  }

  return { evaluateQuotationRules };
}

export type PriceDeviationRuleService = ReturnType<typeof createPriceDeviationRuleService>;
