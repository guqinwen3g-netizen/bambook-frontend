/**
 * marginCrossCurrency.test.ts — ★ B2 真库守卫：收美元/付人民币的订单必须算得出毛利
 *
 * 为什么要有这个测试：旧驾驶舱 `margin = 跨币种 ? null : revenue − cost`
 * ⇒ 外贸最常见的「销售 USD、采购 CNY」**永远看不到毛利**，且被排除在合计之外
 * （老板看到的毛利合计系统性偏乐观 —— 被排除的恰恰是汇率风险最大的那批单）。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 阳性对照：同币种订单毛利照旧（不含糊既有口径）
 *   ② 跨币种 + 市场汇率档案 → 折算后算毛利，并计入合计
 *   ③ 跨币种 + 锁汇 → 用锁定汇率（业务员心里那笔账），且 source=lock
 *   ④ 无汇率档案 → 不折算、不猜（margin=null，不进合计）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getBusinessCockpit } from '../dashboardService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_MCC_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function makeOrder(over: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), poNumber: ctx.id(`PO_${n()}`),
      customer: 'MCC 测试客户', product: 'T-Shirt', type: 'Garment', salesPerson: 'Alice',
      dueDate: '2026-08-01', status: 'Production', quantity: 100,
      currency: 'USD', salesCurrency: 'USD', purchaseCurrency: 'USD',
      // ⓘ 订单金额真源 orderAmountOf：① Σ明细行 ② totalNet ③ quoteAmount（**不看 contractAmount**）
      //   ⇒ 这里必须给 totalNet，否则 revenue 会回退到 quoteAmount（1000），断言全错。
      totalNet: 1200, quoteAmount: 1000, contractAmount: 1200, supplierInvoiceAmount: 800,
      updatedAt: BigInt(Date.now()),
      ...over,
    } as any,
  });
}

async function cleanup() {
  // ★ B117 口径：删除面与扫描面同列集合 —— 本表标记同时落在 `id` 与 `orderId`，只认一列会留删不掉的洞
  await prisma.fxRateLock.deleteMany({ where: { OR: [{ orderId: { contains: ctx.mark } }, { id: { contains: ctx.mark } }] } });
  /**
   * ⚠️ 这一条**故意保持族级**（不像其余几条收成 run 唯一）：`MCCTEST` 是本演练自造的独立币种，
   *   全库只有它写这个值 ⇒ §9 **B114** 判定为"登记但不算缺陷"。
   *   不收窄的第二个理由：`ExchangeRate` 无软删，且这里删的是**别人不会写的行**；
   *   收窄要先让币种码本身 run 唯一（会牵动 ②③ 的断言与合计分组），那一步不在接壳范围内。
   */
  await prisma.exchangeRate.deleteMany({ where: { currency: { startsWith: 'MCCTEST' } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'ord', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'rate', model: 'exchangeRate', run: () => prisma.exchangeRate.count({ where: { currency: { startsWith: 'MCCTEST' } } }) },
  { key: 'lock', model: 'fxRateLock', run: () => prisma.fxRateLock.count({ where: { orderId: { startsWith: ctx.mark } } }) },
];

// 用独立测试币种，避免污染真实 USD 档案（ExchangeRate 无软删，误删代价大）
const CCY = 'MCCTESTUSD';

describe('★ B2 真库守卫：双币种毛利', () => {
  beforeAll(async () => { await cleanup(); });
  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ ord: 0, rate: 0, lock: 0 }); // 零残留
    await prisma.$disconnect();
  });

  it('① 阳性对照：同币种订单毛利照旧', async () => {
    const o = await makeOrder();
    const cockpit = await getBusinessCockpit(prisma, { orderScopeWhere: { id: { in: [o.id] } } });
    const row = cockpit.orderMargins.rows.find(r => r.orderId === o.id)!;
    expect(row.crossCurrency).toBe(false);
    expect(row.margin).toBe(400); // 1200 − 800
  });

  it('② 跨币种 + 市场汇率 → 折算后算毛利并计入合计', async () => {
    await prisma.exchangeRate.create({
      data: { id: ctx.id(`FX_${n()}`), currency: CCY, rate: 7.1, effectiveDate: '2026-08-01', source: 'manual', createdAt: BigInt(Date.now()) },
    });
    const o = await makeOrder({ salesCurrency: CCY, purchaseCurrency: 'CNY', supplierInvoiceAmount: 7100 });

    const cockpit = await getBusinessCockpit(prisma, { orderScopeWhere: { id: { in: [o.id] } } });
    const row = cockpit.orderMargins.rows.find(r => r.orderId === o.id)!;
    expect(row.crossCurrency).toBe(true);
    expect(row.fxRateSource).toBe('market');
    expect(row.costInSalesCurrency).toBe(1000); // 7100 CNY ÷ 7.1
    expect(row.margin).toBe(200); // 1200 − 1000
    const total = cockpit.orderMargins.totals.find(t => t.currency === CCY);
    expect(total).toBeTruthy();
    expect(total!.orderCount).toBeGreaterThanOrEqual(1);
  });

  it('③ 跨币种 + 锁汇 → 用锁定汇率（不是市场汇率）', async () => {
    const o = await makeOrder({ salesCurrency: CCY, purchaseCurrency: 'CNY', supplierInvoiceAmount: 7300 });
    await prisma.fxRateLock.create({
      data: {
        id: ctx.id(`FXL_${n()}`), orderId: o.id, currency: CCY, rate: 7.3,
        lockedAt: BigInt(Date.now()), createdAt: BigInt(Date.now()),
      } as any,
    });

    const cockpit = await getBusinessCockpit(prisma, { orderScopeWhere: { id: { in: [o.id] } } });
    const row = cockpit.orderMargins.rows.find(r => r.orderId === o.id)!;
    expect(row.fxRateSource).toBe('lock');
    expect(row.costInSalesCurrency).toBe(1000); // 7300 ÷ 7.3（按市场 7.1 会是 1028.17）
  });

  it('④ 无汇率档案 → 不折算、不猜（margin=null，不进合计）', async () => {
    const o = await makeOrder({ salesCurrency: 'MCCTESTNOFX', purchaseCurrency: 'CNY', supplierInvoiceAmount: 5000 });
    const cockpit = await getBusinessCockpit(prisma, { orderScopeWhere: { id: { in: [o.id] } } });
    const row = cockpit.orderMargins.rows.find(r => r.orderId === o.id)!;
    expect(row.crossCurrency).toBe(true);
    expect(row.costInSalesCurrency).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.fxRateSource).toBeNull();
  });
});
