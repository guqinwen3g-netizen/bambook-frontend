/**
 * priceDeviationRuleService.test.ts — §9.2 价格审批规则 ①②④ 评估回归测试
 *
 * 设计真源：docs/design/03-业务规则/价格审批规则.md §2/§6
 *   ① 折扣>10%（目录价缺失跳过 / 跨币种不判 / 客户专属价优先）
 *   ② 新客首单（stage ∈ {Lead,Opportunity,Quotation,TrialOrder} 且历史 Order=0；未绑定视为新客+标记）
 *   ④ 低于成本价（折 CNY 比较；成本缺失/不可折算不命中并标记）
 *   决策点 3-A：多条件合并 hitConditions 数组，④ 命中 → level=block
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createPriceDeviationRuleService,
  PRICE_RULE_CONDITION,
  PRICE_APPROVAL_POLICY_KEY,
} from '../priceDeviationRuleService';

function makePrisma(opts: {
  relation?: any;
  orderCount?: number;
  prices?: any[];
  assets?: any[];
} = {}) {
  return {
    relation: { findUnique: vi.fn().mockResolvedValue(opts.relation ?? null) },
    order: { count: vi.fn().mockResolvedValue(opts.orderCount ?? 0) },
    fabricPriceHistory: { findMany: vi.fn().mockResolvedValue(opts.prices ?? []) },
    productAsset: { findMany: vi.fn().mockResolvedValue(opts.assets ?? []) },
  } as any;
}

const baseLines = [{ fabricCode: 'FAB-A', unitPrice: 10, unit: 'M' }];

describe('① 折扣>10%', () => {
  it('目录价 10 USD / 报价 8.9 USD → 折扣 11% 命中（warn）', async () => {
    const prisma = makePrisma({
      relation: { stage: 'Customer' },
      prices: [{ amount: 10, currency: 'USD', customerOrganizationId: null, effectiveDate: '2026-01-01', productAsset: { sku: 'FAB-A' } }],
    });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: [{ fabricCode: 'FAB-A', unitPrice: 8.9, unit: 'M' }] });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
    expect(r.level).toBe('warn');
    expect(r.findings.discount.hit).toBe(true);
    expect(r.findings.discount.maxDiscountPercent).toBeCloseTo(0.11, 4);
    expect(r.findings.discount.lines[0]).toMatchObject({ fabricCode: 'FAB-A', catalogPrice: 10 });
  });

  it('折扣恰好 10% → 不命中（阈值 >0.10 严格大于）', async () => {
    const prisma = makePrisma({
      relation: { stage: 'Customer' },
      prices: [{ amount: 10, currency: 'USD', customerOrganizationId: null, effectiveDate: '2026-01-01', productAsset: { sku: 'FAB-A' } }],
    });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: [{ fabricCode: 'FAB-A', unitPrice: 9.0, unit: 'M' }] });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
    expect(r.findings.discount.hit).toBe(false);
  });

  it('目录价缺失 → 跳过条件 ① + catalogMissing 标记（§6 #2 异常分支）', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' } });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
    expect(r.findings.discount.catalogMissing).toBe(true);
  });

  it('目录价币种与报价币种不一致 → 不判折扣（防跨币种误判）', async () => {
    const prisma = makePrisma({
      relation: { stage: 'Customer' },
      prices: [{ amount: 100, currency: 'CNY', customerOrganizationId: null, effectiveDate: '2026-01-01', productAsset: { sku: 'FAB-A' } }],
    });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
  });

  it('客户专属目录价优先于通用价（专属价 12 → 8.9/12=25.8% 命中）', async () => {
    const prisma = makePrisma({
      relation: { stage: 'Customer' },
      prices: [
        { amount: 9, currency: 'USD', customerOrganizationId: null, effectiveDate: '2026-06-01', productAsset: { sku: 'FAB-A' } },
        { amount: 12, currency: 'USD', customerOrganizationId: 'rel_1', effectiveDate: '2026-01-01', productAsset: { sku: 'FAB-A' } },
      ],
    });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: [{ fabricCode: 'FAB-A', unitPrice: 8.9, unit: 'M' }] });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.DISCOUNT_GT10PCT);
    expect(r.findings.discount.lines[0].catalogPrice).toBe(12);
  });
});

describe('② 新客首单', () => {
  it('stage=Lead 且历史 Order=0 → 命中（warn）', async () => {
    const prisma = makePrisma({ relation: { stage: 'Lead' }, orderCount: 0 });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
    expect(r.findings.newCustomer).toMatchObject({ hit: true, stage: 'Lead', historyOrderCount: 0, relationUnbound: false });
  });

  it.each(['Lead', 'Opportunity', 'Quotation', 'TrialOrder'])('stage=%s 均属新客 stage', async (stage) => {
    const prisma = makePrisma({ relation: { stage }, orderCount: 0 });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
  });

  it.each(['Customer', 'Key', 'Churned'])('stage=%s → 不命中', async (stage) => {
    const prisma = makePrisma({ relation: { stage }, orderCount: 0 });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
  });

  it('stage=Lead 但历史 Order>0 → 不命中（非首单）', async () => {
    const prisma = makePrisma({ relation: { stage: 'Lead' }, orderCount: 3 });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
  });

  it('customerRelationId=null → 视为新客 + relationUnbound 标记（§6 #3 异常分支）', async () => {
    const prisma = makePrisma();
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: null, currency: 'USD', lines: baseLines });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER);
    expect(r.findings.newCustomer.relationUnbound).toBe(true);
  });
});

describe('④ 低于成本价', () => {
  it('missing actual cost and missing FX are independent gaps, never an implicit zero', async () => {
    const svc = createPriceDeviationRuleService(makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: null }] }));
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.findings.belowCost.costMissing).toBe(true);
    expect(r.findings.belowCost.compareUnavailable).toBe(true);
    expect(r.findings.belowCost.lines).toEqual([]);
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
  });
  it.each([null, undefined, 0, '0'])('unknown/unconfirmed cost %j is flagged missing, without a fabricated cost floor', async cost => {
    const svc = createPriceDeviationRuleService(makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost }] }));
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: [{ fabricCode: 'FAB-A', unitPrice: 90, unit: 'M' }] });
    expect(r.findings.belowCost.costMissing).toBe(true);
    expect(r.findings.belowCost.lines).toEqual([]);
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
  });

  it.each([null, undefined, 0])('mixed known+missing %j costs retain the known-cost block and expose incomplete coverage', async cost => {
    const svc = createPriceDeviationRuleService(makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: 100 }, { sku: 'FAB-B', cost }] }));
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: [
      { fabricCode: 'FAB-A', unitPrice: 90, unit: 'M' }, { fabricCode: 'FAB-B', unitPrice: 500, unit: 'M' },
    ] });
    expect(r.findings.belowCost.costMissing).toBe(true);
    expect(r.findings.belowCost.lines).toEqual([{ fabricCode: 'FAB-A', unitPriceCny: 90, costCny: 100 }]);
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    expect(r.level).toBe('block');
  });
  it('CNY 报价 90 < 成本 100 → 命中（block 红标）', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: 100 }] });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: [{ fabricCode: 'FAB-A', unitPrice: 90, unit: 'M' }] });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    expect(r.level).toBe('block');
    expect(r.findings.belowCost.lines[0]).toMatchObject({ fabricCode: 'FAB-A', unitPriceCny: 90, costCny: 100 });
  });

  it('USD 报价 13 × 汇率 7.0 = 91 CNY < 成本 100 → 命中', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: 100 }] });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', exchangeRate: 7.0, lines: [{ fabricCode: 'FAB-A', unitPrice: 13, unit: 'M' }] });
    expect(r.hitConditions).toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    expect(r.findings.belowCost.lines[0].unitPriceCny).toBeCloseTo(91, 4);
  });

  it('USD 报价无汇率 → 不可折算不命中 + compareUnavailable 标记', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: 100 }] });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: [{ fabricCode: 'FAB-A', unitPrice: 1, unit: 'M' }] });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    expect(r.findings.belowCost.compareUnavailable).toBe(true);
  });

  it('成本档案缺失 → 不命中 + costMissing 标记（§6 #6 异常分支：走 ⑤ 兜底）', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' } });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: baseLines });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    expect(r.findings.belowCost.costMissing).toBe(true);
  });

  it('报价 ≥ 成本 → 不命中', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' }, assets: [{ sku: 'FAB-A', cost: 100 }] });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: [{ fabricCode: 'FAB-A', unitPrice: 100, unit: 'M' }] });
    expect(r.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
  });
});

describe('决策点 3-A 多条件合并', () => {
  it('①+②+④ 同时命中 → hitConditions 三项合并 + level=block（④ 最严）', async () => {
    const prisma = makePrisma({
      relation: { stage: 'Lead' },
      orderCount: 0,
      prices: [{ amount: 20, currency: 'CNY', customerOrganizationId: null, effectiveDate: '2026-01-01', productAsset: { sku: 'FAB-A' } }],
      assets: [{ sku: 'FAB-A', cost: 100 }],
    });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'CNY', lines: [{ fabricCode: 'FAB-A', unitPrice: 9, unit: 'M' }] });
    expect(r.hitConditions).toEqual([
      PRICE_RULE_CONDITION.DISCOUNT_GT10PCT,
      PRICE_RULE_CONDITION.NEW_CUSTOMER_FIRST_ORDER,
      PRICE_RULE_CONDITION.BELOW_COST_PRICE,
    ]);
    expect(r.level).toBe('block');
  });

  it('无任何命中 → hitConditions 空 + level=ok', async () => {
    const prisma = makePrisma({ relation: { stage: 'Customer' } });
    const svc = createPriceDeviationRuleService(prisma);
    const r = await svc.evaluateQuotationRules({ customerRelationId: 'rel_1', currency: 'USD', lines: baseLines });
    expect(r.hitConditions).toEqual([]);
    expect(r.level).toBe('ok');
  });

  it('policyKey 常量 = price_approval（业务规则总览 §9.2 审批策略配置）', () => {
    expect(PRICE_APPROVAL_POLICY_KEY).toBe('price_approval');
  });
});
