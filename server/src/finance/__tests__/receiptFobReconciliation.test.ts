/**
 * receiptFobReconciliation.test.ts — T7-③ 收汇 ↔ 报关 FOB 勾稽
 *
 * 口径 D（2026-09-16 拍板）钉住的不变量：
 *   1. 容差 = **max(5% × FOB, 500)**（取大者）—— 小单走 500、大单走 5%
 *   2. 超差 severity **恒为 warning**（不得 critical —— 只预警不阻断）
 *   3. CIF/CIP **先剥运费保费**再比；CFR/CPT 只剥运费；FOB/FCA/EXW 不剥
 *   4. 运单运保费**币种与报关不一致 → 不换算**，该票不参与比对（口径 A：不引入新汇率）
 *   5. D 组（DDP/DAP/DPU）不猜 → 标记后不参与比对
 *   6. 作废报关单不计
 *   7. **未到应收到期日 → 不报差异**（否则预警刷成噪音，预警一旦被无视就失效）；
 *      到期日取该订单**应收发票**最早 dueDate（⚠️ 不是 Order.dueDate —— 那是交期）
 */
import { describe, expect, it } from 'vitest';
import { reconcileReceiptFob } from '../receiptFobReconciliationService';

function makePrisma(seed: {
  order?: any;
  vouchers?: any[];
  declarations?: any[];
  shipments?: Record<string, any>;
  /** 应收发票（只用到 dueDate）；不传 → 模拟「无 invoice 模型」的旧库/mock */
  invoices?: any[];
} = {}) {
  const order = seed.order === undefined
    ? { id: 'ORD1', code: 'SO-2026-001', customer: 'ACME', deletedAt: null }
    : seed.order;
  const vouchers = seed.vouchers ?? [];
  const declarations = seed.declarations ?? [];
  const shipments = seed.shipments ?? {};
  const prisma: any = {
    order: { findFirst: async () => order },
    paymentVoucher: { findMany: async () => vouchers },
    customsDeclaration: { findMany: async () => declarations },
    shipment: { findUnique: async ({ where }: any) => shipments[where.id] ?? null },
  };
  // 显式传 invoices 才挂 invoice 模型：不传 → 服务端走 try/catch 兜底分支
  if (seed.invoices !== undefined) {
    prisma.invoice = { findMany: async () => seed.invoices };
  }
  return prisma as any;
}

const decl = (over: any = {}) => ({
  id: 'CD1', declarationNumber: 'CD-001', status: 'Released',
  totalValue: '10000', currency: 'USD', tradeTerms: 'FOB', shipmentId: 'SHP1', ...over,
});

describe('reconcileReceiptFob — T7-③ 收汇 ↔ 报关 FOB（只预警不阻断）', () => {
  it('FOB 成交 + 全额收汇 → 零差异', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl()],
    }), 'ORD1');
    expect(r).not.toBeNull();
    expect(r!.discrepancies).toEqual([]);
    const row = r!.byCurrency[0];
    expect(row.receiptAmount).toBe(10000);
    expect(row.declaredFob).toBe(10000);
    expect(row.withinTolerance).toBe(true);
  });

  it('收汇低于 FOB 超容差 → warning（绝不 critical）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '8000', currency: 'USD' }],
      declarations: [decl()],
    }), 'ORD1');
    const d = r!.discrepancies[0];
    expect(d).toBeDefined();
    expect(d.severity).toBe('warning');
    expect(d.currency).toBe('USD');
    expect(d.expected).toBe('8000');
    expect(d.actual).toBe('10000');
    expect(d.message).toContain('收汇少于报关 FOB');
    expect(r!.discrepancies.every(x => x.severity === 'warning')).toBe(true);
  });

  it('容差取大者①：小金额单走固定阈值 500（差 400 不报）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '9600', currency: 'USD' }], // 差 −400
      declarations: [decl()],
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.tolerance).toBe(500); // 5% × 10000 = 500，与固定阈值相等 → 取固定
    expect(row.withinTolerance).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('容差取大者②：大金额单走 5%（差 4000 不报，若用固定 500 就会误报）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '96000', currency: 'USD' }], // 差 −4000
      declarations: [decl({ totalValue: '100000' })],
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.tolerance).toBe(5000); // 5% × 100000
    expect(row.toleranceBasis).toContain('5%');
    expect(row.withinTolerance).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('CIF 成交 → 先剥运费+保费再比（剥离生效）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      // 报关 CIF 12000 = 货值 10000 + 运费 1500 + 保费 500
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: 'CIF', totalValue: '12000' })],
      shipments: { SHP1: { freightAmount: '1500', freightCurrency: 'USD', insuranceAmount: '500', insuranceCurrency: 'USD' } },
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.declaredGross).toBe(12000);
    expect(row.strippedFreight).toBe(1500);
    expect(row.strippedInsurance).toBe(500);
    expect(row.declaredFob).toBe(10000); // 12000 − 1500 − 500
    expect(row.withinTolerance).toBe(true);
    expect(r!.discrepancies).toEqual([]); // 剥完刚好等于收汇
  });

  it('CFR 成交 → 只剥运费（保费不动）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: 'CFR', totalValue: '11500' })],
      shipments: { SHP1: { freightAmount: '1500', freightCurrency: 'USD', insuranceAmount: '500', insuranceCurrency: 'USD' } },
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.strippedFreight).toBe(1500);
    expect(row.strippedInsurance).toBe(0); // CFR 不剥保费
    expect(row.declaredFob).toBe(10000);
  });

  it('CIF 但运单缺运费 → 该票不参与比对（标记 unStrippable，不猜）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: 'CIF', totalValue: '12000' })],
      shipments: { SHP1: { freightAmount: null, freightCurrency: null, insuranceAmount: '500', insuranceCurrency: 'USD' } },
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.declaredFob).toBe(0);          // 该票未参与
    expect(row.unStrippable).toHaveLength(1);
    expect(row.unStrippable[0].reason).toContain('未登记运费');
    expect(r!.discrepancies).toHaveLength(1); // FOB=0 而收汇 10000 → 超差预警
  });

  it('运单运费币种 ≠ 报关币种 → 不换算、该票不参与比对（口径 A）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: 'CIF', totalValue: '12000' })],
      shipments: { SHP1: { freightAmount: '10500', freightCurrency: 'CNY', insuranceAmount: '500', insuranceCurrency: 'USD' } },
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.unStrippable[0].reason).toContain('不做汇率换算');
    expect(row.declaredFob).toBe(0);
  });

  it('DDP 成交 → 标记后不参与比对（不猜关税）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: 'DDP', totalValue: '15000' })],
      shipments: { SHP1: { freightAmount: '1500', freightCurrency: 'USD', insuranceAmount: '500', insuranceCurrency: 'USD' } },
    }), 'ORD1');
    const row = r!.byCurrency[0];
    expect(row.declaredFob).toBe(0);
    expect(row.unStrippable[0].reason).toContain('DDP');
  });

  it('未填成交方式 → 按不剥处理（保守方向：宁可报「收汇不足」）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl({ tradeTerms: null, totalValue: '10000' })],
    }), 'ORD1');
    expect(r!.byCurrency[0].declaredFob).toBe(10000);
    expect(r!.discrepancies).toEqual([]);
  });

  it('作废报关单不计入', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '10000', currency: 'USD' }],
      declarations: [decl(), decl({ id: 'CD2', declarationNumber: 'CD-002', status: 'Cancelled', totalValue: '99999' })],
    }), 'ORD1');
    expect(r!.byCurrency[0].declaredGross).toBe(10000);
    expect(r!.declarationCount).toBe(1);
  });

  it('多币种 → 逐币种独立比对（不相加）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [
        { id: 'V1', amount: '10000', currency: 'USD' },
        { id: 'V2', amount: '50000', currency: 'CNY' },
      ],
      declarations: [
        decl(),
        decl({ id: 'CD2', declarationNumber: 'CD-002', totalValue: '50000', currency: 'CNY' }),
      ],
    }), 'ORD1');
    expect(r!.byCurrency.map(x => x.currency)).toEqual(['CNY', 'USD']);
    expect(r!.discrepancies).toEqual([]);
  });

  it('完全未收汇（收汇=0）→ 单独表述「尚无收汇记录」，与「少收汇」区分', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '11325' })],
    }), 'ORD1');
    const d = r!.discrepancies[0];
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('尚无收汇记录');
    expect(d.message).toContain('未收汇即退税');
    expect(d.message).not.toContain('收汇少于报关 FOB');
  });

  it('订单不存在 → null（路由层转 404）', async () => {
    expect(await reconcileReceiptFob(makePrisma({ order: null }), 'NOPE')).toBeNull();
  });
});

describe('reconcileReceiptFob — 应收到期日门槛（未到期不报，避免预警噪音）', () => {
  it('未到应收到期日 + 收汇不足 → 不报差异（还没到该付款的时候）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],                                   // 完全没收到钱
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2026-12-31' }],           // 未来到期
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBe('2026-12-31');
    expect(r!.notYetDue).toBe(true);
    expect(r!.discrepancies).toEqual([]);              // ← 门槛生效
    expect(r!.byCurrency[0].withinTolerance).toBe(false); // 数据照旧算出来，只是不「报」
    expect(r!.byCurrency[0].difference).toBe(-10000);
  });

  it('已过应收到期日 + 收汇不足 → 照报差异（该收的钱没到）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2026-06-30' }],
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBe('2026-06-30');
    expect(r!.notYetDue).toBe(false);
    expect(r!.discrepancies).toHaveLength(1);
    expect(r!.discrepancies[0].severity).toBe('warning');
    expect(r!.discrepancies[0].message).toContain('尚无收汇记录');
    expect(r!.discrepancies[0].message).toContain('应收到期日 2026-06-30（已逾期）');
  });

  it('到期日 = 今天 → 视为未到期（判据是 >= today）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2026-09-16' }],
    }), 'ORD1', '2026-09-16');
    expect(r!.notYetDue).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('多张应收发票 → 取**最早** dueDate 作门槛（分批付款不因某张晚到期而漏报）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2026-12-31' }, { dueDate: '2026-03-01' }, { dueDate: '2026-07-15' }],
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBe('2026-03-01');
    expect(r!.notYetDue).toBe(false);
    expect(r!.discrepancies).toHaveLength(1);
  });

  it('无应收发票（dueDate 缺失）→ 不享受门槛，照报（保守：宁可报也不漏）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [],
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBeNull();
    expect(r!.notYetDue).toBe(false);
    expect(r!.discrepancies).toHaveLength(1);
  });

  it('发票 dueDate 脏数据（非 YYYY-MM-DD / null）→ 忽略该行，不误判', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: 'not-a-date' }, { dueDate: null }, { dueDate: '2026-12-31' }],
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBe('2026-12-31');
    expect(r!.notYetDue).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('门槛是**方向性**的：未到期 + 收汇**多于** FOB → 仍报（多收与到期日无关）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '13000', currency: 'USD' }], // 多收 3000
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2027-01-01' }],                      // 远未到期
    }), 'ORD1', '2026-09-16');
    expect(r!.notYetDue).toBe(true);
    expect(r!.discrepancies).toHaveLength(1);            // ← 不被门槛压掉
    expect(r!.discrepancies[0].message).toContain('收汇多于报关 FOB');
    expect(r!.discrepancies[0].message).toContain('多收/错汇/混入非本单款项');
    expect(r!.discrepancies[0].message).toContain('应收到期日 2027-01-01（未到期）');
  });

  it('未到期不改变 byCurrency 的任何数值（只影响是否「报」）', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [{ id: 'V1', amount: '8000', currency: 'USD' }],
      declarations: [decl({ totalValue: '10000' })],
      invoices: [{ dueDate: '2027-01-01' }],
    }), 'ORD1', '2026-09-16');
    const row = r!.byCurrency[0];
    expect(row.receiptAmount).toBe(8000);
    expect(row.declaredFob).toBe(10000);
    expect(row.difference).toBe(-2000);
    expect(row.withinTolerance).toBe(false);
    expect(row.tolerance).toBe(500);
    expect(r!.discrepancies).toEqual([]);
  });

  it('缺 invoice 模型（旧库/mock）→ 走兜底不抛错，按「无到期日」照报', async () => {
    const r = await reconcileReceiptFob(makePrisma({
      vouchers: [],
      declarations: [decl({ totalValue: '10000' })],
      // 不传 invoices → 不挂 invoice 模型
    }), 'ORD1', '2026-09-16');
    expect(r!.paymentDueDate).toBeNull();
    expect(r!.notYetDue).toBe(false);
    expect(r!.discrepancies).toHaveLength(1);
    expect(r!.discrepancies[0].message).toContain('无应收发票到期日');
  });
});
