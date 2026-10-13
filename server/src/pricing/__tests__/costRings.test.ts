/**
 * costRings.test.ts — 成本三环咬合件单测（纯函数，无库依赖）
 *
 * 覆盖：
 *   1. buildCostRings 三环齐全：数值、派生（收入=单价×数量、目标毛利=售价−Σ估算）、差异；
 *   2. 缺环透明披露：缺利润表/缺定价记录 ⇒ 环=null、missing 如实、相关差异=null（缺环不比）；
 *   3. 不猜原则：finalUnitPrice 或 quantity 缺一 ⇒ estimateRevenueCny=null（不拿 contractAmount 冒充）；
 *   4. maskCostRings：无 sensitive:cost 遮全部成本；无 sensitive:profit 遮全部毛利/差异；
 *      缺环（null）原样保留、missing[] 不动 —— 「有没有」不是敏感信息。
 */
import { describe, it, expect } from 'vitest';
import { buildCostRings, createCostRingsService, type CostRingsRawInput } from '../costRingsService';
import { maskCostRings } from '../sensitiveMask';

const FULL: CostRingsRawInput = {
  order: { contractAmount: 132000, totalNet: 132000, currency: 'EUR' },
  quote: { purchaseCostCny: 900000 * 0.13, finalUnitPrice: 22327.41, quantity: 2000, profitAmount: 12000, profitMargin: 9.09 },
  target: { sellingPrice: 132000, currency: 'EUR', estimateCurrencies: ['EUR'], costEstimateTotal: 110000 },
  actual: {
    salesRevenue: 1016000, purchaseCost: 850000, freightCost: 30000, miscCost: 8000,
    bankFeeCost: 2000, allowanceCost: 0, grossProfit: 126000, grossMargin: 12.4, generatedAt: '2026-09-30',
    details: {costEvidence: {version:2, calculatedAt:'2026-09-30',status:'complete',committedAmountCny:890000,acceptedAmountCny:890000,paidPrincipalCny:0,actualCostCny:890000,actualProfitCny:126000,actualRevenueCny:1016000,actualBreakdown:{procurement:850000,companySupply:0,logistics:30000,otherExpenses:8000,bankFees:2000,allowances:0},reviewId:'review-1',reviewRevision:1,sourceFingerprint:'a'.repeat(64),pendingReasons:[]}},
  },
};

describe('buildCostRings 三环齐全', () => {
  const r = buildCostRings(FULL);

  it('报价环：估算收入 = finalUnitPrice（整单口径，★ 不乘数量）；单价 = 整单/数量', () => {
    expect(r.quoteRing).not.toBeNull();
    expect(r.quoteRing!.estimateRevenueUsd).toBe(22327.41);
    expect(r.quoteRing!.estimateUnitPriceUsd).toBeCloseTo(11.16, 1);
    expect(r.quoteRing!.estimateCostCny).toBe(117000);
    expect(r.quoteRing!.estimateProfitUsd).toBe(12000);
    expect(r.quoteRing!.estimateMarginPct).toBe(9.09);
  });

  it('目标环：目标毛利 = 售价 − Σ成本估算；毛利率 = 利润/收入×100', () => {
    expect(r.targetRing!.targetCostCny).toBe(110000);
    expect(r.targetRing!.targetRevenueCny).toBe(132000);
    expect(r.targetRing!.targetProfitCny).toBe(22000);
    expect(r.targetRing!.targetMarginPct).toBeCloseTo(16.67, 1);
  });

  it('实际环：仅采用完整证据中的实际成本', () => {
    expect(r.actualRing!.actualRevenueCny).toBe(1016000);
    expect(r.actualRing!.actualCostCny).toBe(890000);
    expect(r.actualRing!.actualProfitCny).toBe(126000);
    expect(r.actualRing!.breakdown.purchase).toBe(850000);
  });

  it('旧采购投影与核对值不同时，实际分项和收入只取核对范围',()=>{
    const r=buildCostRings({...FULL,actual:{...FULL.actual!,salesRevenue:999999,purchaseCost:1,freightCost:2,miscCost:3,bankFeeCost:4,allowanceCost:5}});
    expect(r.actualRing!.actualRevenueCny).toBe(1016000);expect(r.actualRing!.breakdown).toEqual({purchase:850000,freight:30000,misc:8000,bankFee:2000,allowance:0});
  });

  it('不同币种的目标、报价不能直接比较实际', () => {
    expect(r.deltas.costTargetVsActual).toBeNull();
    expect(r.deltas.profitQuoteVsActual).toBeNull();
    expect(r.deltas.profitTargetVsActual).toBeNull();
  });

  it('跨币种不折算：售价 EUR 与成本估算 CNY 混 ⇒ 目标毛利置 null（不做隐式汇率折算）', () => {
    const r = buildCostRings({
      ...FULL,
      target: { sellingPrice: 132000, currency: 'EUR', estimateCurrencies: ['CNY'], costEstimateTotal: 110000 },
    });
    expect(r.targetRing!.crossCurrency).toBe(true);
    expect(r.targetRing!.targetProfitCny).toBeNull();
    expect(r.targetRing!.targetMarginPct).toBeNull();
    // 收入与成本两个数仍如实给出
    expect(r.targetRing!.targetRevenueCny).toBe(132000);
    expect(r.targetRing!.targetCostCny).toBe(110000);
  });

  it('齐全时 missing 为空', () => {
    expect(r.missing).toEqual([]);
  });
});

describe('buildCostRings 缺环透明披露（不猜）', () => {
  it('缺利润表 ⇒ actualRing=null、missing 含 profit_sheet、涉及实际的差异=null', () => {
    const r = buildCostRings({ ...FULL, actual: null });
    expect(r.actualRing).toBeNull();
    expect(r.missing).toContain('profit_sheet');
    expect(r.deltas.costTargetVsActual).toBeNull();
    expect(r.deltas.profitQuoteVsActual).toBeNull();
    expect(r.deltas.profitTargetVsActual).toBeNull();
    // 其余两环不受影响
    expect(r.quoteRing).not.toBeNull();
    expect(r.targetRing).not.toBeNull();
  });

  it('缺定价记录 ⇒ quoteRing=null、missing 含 pricing_calculation', () => {
    const r = buildCostRings({ ...FULL, quote: null });
    expect(r.quoteRing).toBeNull();
    expect(r.missing).toContain('pricing_calculation');
    expect(r.deltas.profitQuoteVsActual).toBeNull();
  });

  it('缺 BOM ⇒ targetRing=null、missing 含 bom', () => {
    const r = buildCostRings({ ...FULL, target: null });
    expect(r.targetRing).toBeNull();
    expect(r.missing).toContain('bom');
  });

  it('不猜：quantity 缺 ⇒ 单位售价=null（整单收入仍如实给出）', () => {
    const r = buildCostRings({
      ...FULL,
      quote: { purchaseCostCny: 117000, finalUnitPrice: 22327.41, quantity: null, profitAmount: 12000, profitMargin: null },
    });
    expect(r.quoteRing!.estimateUnitPriceUsd).toBeNull();
    // 整单收入、成本与利润额仍如实给出（缺的是"单位"这一层，不是整单）
    expect(r.quoteRing!.estimateRevenueUsd).toBe(22327.41);
    expect(r.quoteRing!.estimateCostCny).toBe(117000);
    expect(r.quoteRing!.estimateProfitUsd).toBe(12000);
  });
});

describe('maskCostRings 遮罩（与 maskProfitSheetRow 同口径）', () => {
  const built = buildCostRings(FULL);
  const row = { orderId: 'SIM-FORD-013', ...built } as any;

  it('无 sensitive:cost ⇒ 三环成本与成本差异全遮；环本身与 missing 保留', () => {
    const m = maskCostRings(row, { cost: false, profit: true, commission: true });
    expect(m.quoteRing.estimateCostCny).toBeNull();
    expect(m.targetRing.targetCostCny).toBeNull();
    expect(m.actualRing.actualCostCny).toBeNull();
    expect(m.actualRing.breakdown.purchase).toBeNull();
    expect(m.deltas.costTargetVsActual).toBeNull();
    expect(m.missing).toEqual([]);
    expect(m.targetRing.targetRevenueCny).toBe(132000);
    expect(m.quoteRing.estimateRevenueUsd).toBe(22327.41);
  });

  it('无 sensitive:profit ⇒ 三环毛利/毛利率/利润差异全遮；收入（售价侧）不遮', () => {
    const m = maskCostRings(row, { cost: true, profit: false, commission: true });
    expect(m.quoteRing.estimateProfitUsd).toBeNull();
    expect(m.targetRing.targetProfitCny).toBeNull();
    expect(m.actualRing.actualProfitCny).toBeNull();
    expect(m.deltas.profitQuoteVsActual).toBeNull();
    expect(m.deltas.profitTargetVsActual).toBeNull();
    expect(m.quoteRing.estimateCostCny).toBe(117000);
    expect(m.actualRing.actualRevenueCny).toBe(1016000);
  });

  it('缺环的 null 原样保留（不给旧行凭空补字段）', () => {
    const partial = { orderId: 'X', ...buildCostRings({ ...FULL, actual: null, quote: null }) } as any;
    const m = maskCostRings(partial, { cost: false, profit: false, commission: false });
    expect(m.quoteRing).toBeNull();
    expect(m.actualRing).toBeNull();
    expect(m.missing).toContain('profit_sheet');
    expect(m.missing).toContain('pricing_calculation');
  });

  it('有全量 scope ⇒ 一字不动', () => {
    const m = maskCostRings(row, { cost: true, profit: true, commission: true });
    expect(m).toEqual(row);
  });
});

 describe('成本证据与币种边界',()=>{
 it('旧表不能由毛利倒推实际成本',()=>{const r=buildCostRings({...FULL,actual:{...FULL.actual!,details:undefined}});expect(r.actualRing!.costEvidence.status).toBe('unknown');expect(r.actualRing!.actualCostCny).toBeNull();expect(r.actualRing!.breakdown.purchase).toBeNull();});
 it('待归集仅展示阶段数额',()=>{const r=buildCostRings({...FULL,actual:{...FULL.actual!,details:{costEvidence:{...(FULL.actual!.details as any).costEvidence,status:'pending',actualCostCny:null,actualProfitCny:null,pendingReasons:['missing_consumption']}}}});expect(r.actualRing!.costEvidence.committedAmountCny).toBe(890000);expect(r.actualRing!.actualProfitCny).toBeNull();});
 it('同币种且证据完整才能比较目标实际',()=>{const r=buildCostRings({...FULL,target:{...FULL.target!,currency:'CNY',estimateCurrencies:['CNY']}});expect(r.deltas.costTargetVsActual).toBe(780000);expect(r.deltas.profitTargetVsActual).toBe(104000);expect(r.deltas.profitQuoteVsActual).toBeNull();});
 it('嵌套成本依据也按权限遮罩且不改原值',()=>{const r=buildCostRings(FULL);const m=maskCostRings(r as any,{cost:false,profit:false,commission:false});expect(m.actualRing.costEvidence.actualCostCny).toBeNull();expect(m.actualRing.costEvidence.actualProfitCny).toBeNull();expect(m.actualRing.costEvidence.committedAmountCny).toBeNull();expect(r.actualRing!.costEvidence.actualCostCny).toBe(890000);});
 });

describe('BOM成本估算缺失',()=>{
 const db=(estimates:any[])=>({order:{findFirst:async()=>({id:'o',currency:'CNY',contractAmount:100,totalNet:100})},pricingCalculation:{findFirst:async()=>null},bOM:{findFirst:async()=>({id:'b',sellingPrice:100,currency:'CNY'})},costEstimate:{findMany:async()=>estimates},orderProfitSheet:{findUnique:async()=>null}});
 it('没有估算行不宣称零成本',async()=>{const r=await createCostRingsService(db([]) as any).getOrderCostRings('o');expect(r.targetRing).toBeNull();expect(r.missing).toContain('targetCostEstimate');});
 it('明确零成本行保留零',async()=>{const r=await createCostRingsService(db([{amount:0,currency:'CNY'}]) as any).getOrderCostRings('o');expect(r.targetRing!.targetCostCny).toBe(0);});
 it.each([null, undefined, '', 'not-a-number', Infinity])('缺失或损坏成本行 %s 不算零，也不推导利润',async value=>{
   const r=await createCostRingsService(db([{amount:value,currency:'CNY'},{amount:10,currency:'CNY'}]) as any).getOrderCostRings('o');
   expect(r.targetRing!.targetCostCny).toBeNull();expect(r.targetRing!.targetProfitCny).toBeNull();
   expect(r.deltas.costTargetVsActual).toBeNull();expect(r.missing).toContain('targetCostEstimate');
 });
 it('直接输入损坏合计也保持未知',()=>{
   const r=buildCostRings({...FULL,target:{...FULL.target!,costEstimateTotal:NaN}});
   expect(r.targetRing!.targetCostCny).toBeNull();expect(r.targetRing!.targetMarginPct).toBeNull();
 });
});
