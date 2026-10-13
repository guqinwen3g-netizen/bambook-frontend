import { describe, expect, it, beforeEach } from 'vitest';
import { createProfitSheetService, ProfitSheetDetails } from '../profitSheetService';

/**
 * Mock Prisma：内存存储 Order + Invoice + PurchaseOrder + Shipment +
 * PaymentVoucher + ExchangeRate + OrderProfitSheet。
 */
function makeMockPrisma() {
  let seq = 0;
  const orders: any[] = [];
  const invoices: any[] = [];
  const purchaseOrders: any[] = [];
  const shipments: any[] = [];
  const paymentVouchers: any[] = [];
  const exchangeRates: any[] = [];
  const profitSheets: any[] = [];
  const shipmentOrderAllocations: any[] = [];
  const creditNotes: any[] = [];
  const creditNoteAllocations: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders_ = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders_) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (typeof xv === 'bigint' && typeof yv === 'bigint') {
          return xv < yv ? (dir === 'desc' ? 1 : -1) : (dir === 'desc' ? -1 : 1);
        }
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const findManyOf = (rows: any[]) => async ({ where, orderBy, take, skip }: any = {}) => {
    const matched = applyOrderBy(rows.filter(r => matchWhere(r, where)), orderBy);
    return matched.slice(skip || 0, (skip || 0) + (take ?? matched.length));
  };

  const orderProfitSheet = {
    findUnique: async ({ where }: any) => profitSheets.find(s => s.orderId === where.orderId) || null,
    findMany: findManyOf(profitSheets),
    count: async ({ where }: any = {}) => profitSheets.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { ...data, id: data.id || `OPS__T${++seq}` };
      profitSheets.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = profitSheets.find(s => s.orderId === where.orderId);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: any) => {
      const idx = profitSheets.findIndex(s => s.orderId === where.orderId);
      if (idx < 0) throw new Error('not found');
      return profitSheets.splice(idx, 1)[0];
    },
  };

  return {
    order: { findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null },
    invoice: { findMany: findManyOf(invoices) },
    purchaseOrder: { findMany: findManyOf(purchaseOrders) },
    shipment: { findMany: findManyOf(shipments) },
    paymentVoucher: { findMany: findManyOf(paymentVouchers) },
    exchangeRate: { findMany: findManyOf(exchangeRates) },
    shipmentOrderAllocation: { findMany: findManyOf(shipmentOrderAllocations) },
    creditNote: { findMany: findManyOf(creditNotes) },
    creditNoteAllocation: { findMany: findManyOf(creditNoteAllocations) },
    orderProfitSheet,
    _stores: { orders, invoices, purchaseOrders, shipments, paymentVouchers, exchangeRates, profitSheets, shipmentOrderAllocations, creditNotes, creditNoteAllocations },
  };
}

function seedOrder(prisma: any, id = 'ORD-1') {
  prisma._stores.orders.push({ id, customer: 'Acme', product: 'Suit', deletedAt: null });
  return id;
}

describe('P1 · OrderProfitSheet 生成聚合', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma);
  });

  it('费用阶段聚合：汇率快照优先，付款本金不计成本，缺耗用证据不出毛利', async () => {
    prisma._stores.invoices.push(
      { id: 'INV-1', invoiceNumber: 'INV-2026-001', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 10000, currency: 'USD', exchangeRate: 7.2, deletedAt: null },
      { id: 'INV-2', invoiceNumber: 'INV-2026-002', orderId: 'ORD-1', type: 'Receivable', status: 'Paid', amount: 7200, currency: 'CNY', exchangeRate: null, deletedAt: null },
      // Cancelled 不计入
      { id: 'INV-3', invoiceNumber: 'INV-2026-003', orderId: 'ORD-1', type: 'Receivable', status: 'Cancelled', amount: 99999, currency: 'CNY', exchangeRate: null, deletedAt: null },
      // Payable 不计入销售收入
      { id: 'INV-4', invoiceNumber: 'INV-2026-004', orderId: 'ORD-1', type: 'Payable', status: 'Issued', amount: 5000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    prisma._stores.purchaseOrders.push(
      { id: 'PO-1', poNumber: 'PO-2026-001', orderId: 'ORD-1', status: 'Confirmed', totalAmount: 40000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    prisma._stores.shipments.push(
      { id: 'SH-1', shipmentNumber: 'SH-2026-001', orderId: 'ORD-1', status: 'Shipped', deletedAt: null, freightAmount: 500, freightCurrency: 'USD', insuranceAmount: null, insuranceCurrency: null, customsAmount: 200, customsCurrency: 'CNY', otherCharges: null, otherChargesCurrency: null },
    );
    prisma._stores.paymentVouchers.push(
      { id: 'PV-1', voucherNumber: 'PAY-2026-001', orderId: 'ORD-1', type: 'Disbursement', invoiceId: null, amount: 1000, bankFee: 50, currency: 'CNY', exchangeRate: null, deletedAt: null },
      // 已核销发票的付款不算杂费
      { id: 'PV-2', voucherNumber: 'PAY-2026-002', orderId: 'ORD-1', type: 'Disbursement', invoiceId: 'INV-X', amount: 8888, bankFee: 0, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    prisma._stores.exchangeRates.push(
      { id: 'FXR-1', currency: 'USD', rate: 7.1, effectiveDate: '2026-08-08', createdAt: 1n },
    );

    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    // sales: 10000×7.2(snapshot) + 7200×1 = 79200
    expect(sheet.salesRevenue).toBe(79200);
    // purchase: 40000
    expect(sheet.purchaseCost).toBe(40000);
    // freight: 500×7.1(latest) + 200 = 3750
    expect(sheet.freightCost).toBe(3750);
    // 付款本金不是成本；手续费单列，实际利润等待耗用证据。
    expect(sheet.miscCost).toBe(0);
    expect((sheet.details as ProfitSheetDetails).bankFeeCost).toBe(50);
    // Existing aggregate columns do not prove actual consumption.
    expect(sheet.grossProfit).toBeNull();
    expect(sheet.grossMargin).toBeNull();

    const details = sheet.details as unknown as ProfitSheetDetails;
    expect(details.sales[0].rateSource).toBe('snapshot');
    expect(details.sales[1].rateSource).toBe('base');
    expect(details.freight[0].rateSource).toBe('latest-rate');
    expect(details.unconverted).toHaveLength(0);
  });

  it('无可用汇率的外币行计入 unconverted 且不影响合计', async () => {
    prisma._stores.invoices.push(
      { id: 'INV-1', invoiceNumber: 'INV-2026-001', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 5000, currency: 'EUR', exchangeRate: null, deletedAt: null },
      { id: 'INV-2', invoiceNumber: 'INV-2026-002', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 7200, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect(sheet.salesRevenue).toBe(7200); // EUR 行被排除
    const details = sheet.details as unknown as ProfitSheetDetails;
    expect(details.unconverted).toHaveLength(1);
    expect(details.unconverted[0]).toMatchObject({ kind: 'sales', currency: 'EUR', amount: 5000 });
  });

  it('幂等重生成：orderId 唯一覆盖更新，version 递增；sales=0 时 grossMargin 为 null', async () => {
    const first = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect(first.version).toBe(1);
    expect(first.salesRevenue).toBe(0);
    expect(first.grossMargin).toBeNull();

    prisma._stores.invoices.push(
      { id: 'INV-1', invoiceNumber: 'INV-2026-001', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 1000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const second = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect(second.id).toBe(first.id); // 同一行覆盖更新
    expect(second.version).toBe(2);
    expect(second.salesRevenue).toBe(1000);
    expect(prisma._stores.profitSheets).toHaveLength(1);
  });

  it('订单不存在 → 抛错；删除后 getByOrder 返回 null', async () => {
    await expect(service.generateOrderProfitSheet('ORD-X', 'u1')).rejects.toThrow('订单不存在');
    await service.generateOrderProfitSheet('ORD-1', 'u1');
    await service.deleteProfitSheet('ORD-1', 'u1');
    expect(await service.getProfitSheetByOrder('ORD-1')).toBeNull();
  });
});

describe('P1 · 合票运费按 ShipmentOrderAllocation 分摊', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma, 'ORD-A');
    seedOrder(prisma, 'ORD-B');
  });

  it('一票两单：运费按 actualQty 比例分摊，各单分摊之和 = 票面全额', async () => {
    // 合票 SH-C：ORD-A 分 100 件、ORD-B 分 300 件；Shipment.orderId 投影 = 首单 ORD-A
    prisma._stores.shipments.push({
      id: 'SH-C', shipmentNumber: 'SH-2026-C', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 8000, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-A', shipmentId: 'SH-C', orderId: 'ORD-A', orderLineId: null, plannedQty: 100, actualQty: 100, unit: 'pcs', status: 'Fulfilled' },
      { id: 'SHPA-B', shipmentId: 'SH-C', orderId: 'ORD-B', orderLineId: null, plannedQty: 300, actualQty: 300, unit: 'pcs', status: 'Fulfilled' },
    );

    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    const sheetB = await service.generateOrderProfitSheet('ORD-B', 'u1');
    // A: 8000 × 100/400 = 2000；B: 8000 × 300/400 = 6000；合计恰为票面全额
    expect(sheetA.freightCost).toBe(2000);
    expect(sheetB.freightCost).toBe(6000);
    expect(Number(sheetA.freightCost) + Number(sheetB.freightCost)).toBe(8000);

    // 明细行透明披露合票分摊比例
    const detailsA = sheetA.details as unknown as ProfitSheetDetails;
    expect(detailsA.freight[0].label).toContain('合票分摊 25.0%');
    expect(detailsA.freight[0].amount).toBe(2000);
  });

  it('单订单票（有分配）：share=1 全额归集，行为不变', async () => {
    prisma._stores.shipments.push({
      id: 'SH-S', shipmentNumber: 'SH-2026-S', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 500, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-S', shipmentId: 'SH-S', orderId: 'ORD-A', orderLineId: null, plannedQty: 50, actualQty: 50, unit: 'pcs', status: 'Fulfilled' },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-A', 'u1');
    expect(sheet.freightCost).toBe(500);
    const details = sheet.details as unknown as ProfitSheetDetails;
    expect(details.freight[0].label).not.toContain('合票分摊');
  });

  it('存量无分配票：回退 Shipment.orderId 直归（share=1）', async () => {
    // 分配机制上线前的旧数据：票直挂 orderId，无任何分配记录
    prisma._stores.shipments.push({
      id: 'SH-L', shipmentNumber: 'SH-2026-L', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 1200, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    const sheet = await service.generateOrderProfitSheet('ORD-A', 'u1');
    expect(sheet.freightCost).toBe(1200);
  });

  it('订单在票内的分配已取消：不承担运费（防合票投影错挂）', async () => {
    // SH-X 的 orderId 投影仍指 ORD-A（旧投影），但 ORD-A 的分配已取消，仅 ORD-B 活跃
    prisma._stores.shipments.push({
      id: 'SH-X', shipmentNumber: 'SH-2026-X', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 900, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-XA', shipmentId: 'SH-X', orderId: 'ORD-A', orderLineId: null, plannedQty: 10, actualQty: 10, unit: 'pcs', status: 'Cancelled' },
      { id: 'SHPA-XB', shipmentId: 'SH-X', orderId: 'ORD-B', orderLineId: null, plannedQty: 90, actualQty: 90, unit: 'pcs', status: 'Fulfilled' },
    );
    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    const sheetB = await service.generateOrderProfitSheet('ORD-B', 'u1');
    expect(sheetA.freightCost).toBe(0);
    expect(sheetB.freightCost).toBe(900);
  });

  it('数量全缺省的合票：按票内订单数均摊', async () => {
    prisma._stores.shipments.push({
      id: 'SH-N', shipmentNumber: 'SH-2026-N', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 600, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-NA', shipmentId: 'SH-N', orderId: 'ORD-A', orderLineId: null, plannedQty: null, actualQty: null, unit: null, status: 'Planned' },
      { id: 'SHPA-NB', shipmentId: 'SH-N', orderId: 'ORD-B', orderLineId: null, plannedQty: null, actualQty: null, unit: null, status: 'Planned' },
    );
    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    const sheetB = await service.generateOrderProfitSheet('ORD-B', 'u1');
    expect(sheetA.freightCost).toBe(300);
    expect(sheetB.freightCost).toBe(300);
  });
});

// ═══ 合票分摊：计量单位不可互算（2026-09-19 上线验收修） ═══
// 系统假设：share = 本单数量 / 票内总数量。
// 业务变异：一票里既有「米」又有「公斤」（面料合票常见）—— `Σ数量` 是没有意义的分母。
// 旧行为会把 100m / 300kg 算成 25% / 75%（比例全错、运费归集到错的订单 ⇒ 订单利润错，且不报错）。
// 修法：单位不一致 ⇒ 不按数量，退为票内订单均摊，并在明细行**透明标注**原因。
describe('P1 · 合票分摊：计量单位不可互算', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma, 'ORD-A');
    seedOrder(prisma, 'ORD-B');
  });

  const seedMixedShipment = () => {
    prisma._stores.shipments.push({
      id: 'SH-M', shipmentNumber: 'SH-2026-M', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 8000, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-MA', shipmentId: 'SH-M', orderId: 'ORD-A', orderLineId: null, plannedQty: 100, actualQty: 100, unit: 'm', status: 'Fulfilled' },
      { id: 'SHPA-MB', shipmentId: 'SH-M', orderId: 'ORD-B', orderLineId: null, plannedQty: 300, actualQty: 300, unit: 'kg', status: 'Fulfilled' },
    );
  };

  it('★ 米 + 公斤 混合 ⇒ 不按数量分摊，改为票内订单均摊 50/50（不得算出 25/75）', async () => {
    seedMixedShipment();
    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    const sheetB = await service.generateOrderProfitSheet('ORD-B', 'u1');
    expect(sheetA.freightCost).toBe(4000);
    expect(sheetB.freightCost).toBe(4000);
    // 分摊仍守恒（不得凭空多出或少掉运费）
    expect(Number(sheetA.freightCost) + Number(sheetB.freightCost)).toBe(8000);

    const detailsA = sheetA.details as unknown as ProfitSheetDetails;
    expect(detailsA.freight[0].label).toContain('合票分摊 50.0%');
    // 透明披露：必须说明是「单位不一 ⇒ 均摊」，别让用户以为这是按量算出的比例
    expect(detailsA.freight[0].label).toContain('计量单位不一');
  });

  it('阴性对照：同单位（pcs）仍按数量分摊 —— 不得因本修复把正常比例也改成均摊', async () => {
    prisma._stores.shipments.push({
      id: 'SH-S2', shipmentNumber: 'SH-2026-S2', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 8000, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-S2A', shipmentId: 'SH-S2', orderId: 'ORD-A', orderLineId: null, plannedQty: 100, actualQty: 100, unit: 'pcs', status: 'Fulfilled' },
      { id: 'SHPA-S2B', shipmentId: 'SH-S2', orderId: 'ORD-B', orderLineId: null, plannedQty: 300, actualQty: 300, unit: 'pcs', status: 'Fulfilled' },
    );
    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    expect(sheetA.freightCost).toBe(2000);
    const detailsA = sheetA.details as unknown as ProfitSheetDetails;
    expect(detailsA.freight[0].label).not.toContain('计量单位不一');
  });

  it('阴性对照：单位缺省不算「不同」（无法证伪就不改既有行为）⇒ 仍按数量', async () => {
    prisma._stores.shipments.push({
      id: 'SH-N', shipmentNumber: 'SH-2026-N', orderId: 'ORD-A', status: 'Shipped', deletedAt: null,
      freightAmount: 8000, freightCurrency: 'CNY',
      insuranceAmount: null, insuranceCurrency: null,
      customsAmount: null, customsCurrency: null,
      otherCharges: null, otherChargesCurrency: null,
    });
    prisma._stores.shipmentOrderAllocations.push(
      { id: 'SHPA-NA', shipmentId: 'SH-N', orderId: 'ORD-A', orderLineId: null, plannedQty: 100, actualQty: 100, unit: null, status: 'Fulfilled' },
      { id: 'SHPA-NB', shipmentId: 'SH-N', orderId: 'ORD-B', orderLineId: null, plannedQty: 300, actualQty: 300, unit: null, status: 'Fulfilled' },
    );
    const sheetA = await service.generateOrderProfitSheet('ORD-A', 'u1');
    expect(sheetA.freightCost).toBe(2000);
  });
});

// ════════════════════════════════════════════════════════════════
// M1·D7 之一：银行手续费在**收款侧**单列成本项
//
// 为什么这是缺口而不是既有行为的改名：`profitSheetService` 今天只读 `type:'Disbursement'`
// 的付款凭证（杂费），**Receipt（收款）凭证压根没被利润表读过** ⇒ 收款水单上的银行手续费
// 既不在收入里、也不在任何成本里 —— 一笔真实发生的成本在整个订单 P&L 上是隐形的。
// 拍板口径（§12 D7）：销售收入**不改**（仍按应收发票），手续费作为**单独一条成本项**入账。
// ════════════════════════════════════════════════════════════════
describe('M1·D7 收款侧 bankFee 单列成本项', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma);
    prisma._stores.invoices.push(
      { id: 'INV-R', invoiceNumber: 'INV-2026-R', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 10000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
  });

  it('收款凭证的手续费进独立成本项，且销售收入一分不变', async () => {
    prisma._stores.paymentVouchers.push(
      { id: 'PV-R1', voucherNumber: 'RCV-2026-001', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-R', amount: 10000, bankFee: 78, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.bankFees).toHaveLength(1);
    expect(d.bankFees[0].amount).toBe(78);
    expect(d.bankFees[0].label).toContain('RCV-2026-001');
    expect(d.bankFeeCost).toBe(78);
    // 收入口径不动（这是 D7 的硬约束）
    expect(sheet.salesRevenue).toBe(10000);
    // 毛利因这笔手续费下降 78
    expect(sheet.grossProfit).toBeNull();
  });

  it('手续费只能通过发票挂上订单的收款凭证也要算进来（orderId 冗余为空时）', async () => {
    prisma._stores.paymentVouchers.push(
      { id: 'PV-R2', voucherNumber: 'RCV-2026-002', orderId: null, type: 'Receipt', invoiceId: 'INV-R', amount: 9000, bankFee: 40, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.bankFeeCost, 'orderId 冗余没填、只挂发票的收款水单不得被漏掉').toBe(40);
  });

  it('★ 同一张凭证只计一次：orderId 与 invoiceId 同时命中也不重复入账', async () => {
    prisma._stores.paymentVouchers.push(
      { id: 'PV-R3', voucherNumber: 'RCV-2026-003', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-R', amount: 8000, bankFee: 25, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.bankFees.filter((l) => l.id === 'PV-R3')).toHaveLength(1);
    expect(d.bankFeeCost).toBe(25);
  });

  it('bankFee=0 或未填 ⇒ 不产生噪音行、不影响毛利', async () => {
    prisma._stores.paymentVouchers.push(
      { id: 'PV-R4', voucherNumber: 'RCV-2026-004', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-R', amount: 5000, bankFee: 0, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.bankFees).toEqual([]);
    expect(d.bankFeeCost).toBe(0);
    expect(sheet.grossProfit).toBeNull();
  });

  it('★ 外币手续费算不出汇率 ⇒ 落 unconverted 披露，不得静默按 0 计入（G3 判据）', async () => {
    prisma._stores.paymentVouchers.push(
      { id: 'PV-R5', voucherNumber: 'RCV-2026-005', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-R', amount: 1000, bankFee: 12, currency: 'XYZ', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.bankFees).toHaveLength(0);
    expect(d.bankFeeCost).toBe(0);
    expect(d.unconverted.some((u) => String(u.label).includes('RCV-2026-005'))).toBe(true);
    // 没被算进去 ⇒ 毛利不得因此下降（宁可少算成本并披露，不可编一个数）
    expect(sheet.grossProfit).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// M1·D7 之二：索赔/折让进 P&L，作为**单独一条成本项**（不改收入口径）
//
// 今天的不正确在哪：`profitSheetService` 的销售收入 = Σ应收发票**票面额**，
// 而贷项票（折让）只体现在"发票已核销额"里，**利润表一个字都没读它**
// （本文件实测：改前 `grep -c "reditNote" profitSheetService.ts` = 0）
// ⇒ 客户拿走的每一块折让，都仍然全额记在我们的毛利里 ⇒ **毛利被系统性高估**。
// 口径（§12 D7）：收入不动，折让单列成本。
// ════════════════════════════════════════════════════════════════
describe('M1·D7 折让单列成本项', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  const seedInvoice = (over: any = {}) => {
    prisma._stores.invoices.push(
      { id: 'INV-A', invoiceNumber: 'INV-2026-A', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 10000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
  };
  const cn = (o: any = {}) => ({
    id: 'CN_1', creditNoteNumber: 'CLM-2026-0001', claimCaseId: null, sourceInvoiceId: 'INV-A',
    currency: 'CNY', amount: 1000, openAmount: 200, status: 'PartiallyApplied', issueDate: '2026-06-01',
    appliedToInvoiceId: null, reason: '色差折让', deletedAt: null, ...o,
  });
  const alloc = (o: any = {}) => ({ id: 'CNA__CN_1__INV-A', creditNoteId: 'CN_1', invoiceId: 'INV-A', appliedAmount: 800, appliedDate: '2026-06-02', ...o });

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma);
    seedInvoice();
  });

  it('抵扣到本订单发票的折让 ⇒ 单列成本，且销售收入一分不变', async () => {
    prisma._stores.creditNotes.push(cn());
    prisma._stores.creditNoteAllocations.push(alloc());
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.allowances).toHaveLength(1);
    expect(d.allowances[0].amount).toBe(800);
    expect(d.allowances[0].label).toContain('CLM-2026-0001');
    expect(d.allowanceCost).toBe(800);
    expect(sheet.salesRevenue).toBe(10000);          // 收入口径不动（D7 硬约束）
    expect(sheet.grossProfit).toBeNull();     // 毛利因折让下降
  });

  it('★ 作废（Cancelled）的贷项票不得当成本 —— 与"Cancelled 发票不计收入"同一取向', async () => {
    prisma._stores.creditNotes.push(cn({ status: 'Cancelled' }));
    prisma._stores.creditNoteAllocations.push(alloc());
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.allowances).toEqual([]);
    expect(d.allowanceCost).toBe(0);
    expect(sheet.grossProfit).toBeNull();
  });

  it('★ 只计**已抵扣额**：票面 1000、实际抵了 800 ⇒ 计 800，余 200 挂账不算', async () => {
    prisma._stores.creditNotes.push(cn({ amount: 1000, openAmount: 200 }));
    prisma._stores.creditNoteAllocations.push(alloc({ appliedAmount: 800 }));
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect((sheet.details as ProfitSheetDetails).allowanceCost).toBe(800);
  });

  it('★ 抵在别人订单发票上的折让，不得进本订单成本', async () => {
    prisma._stores.creditNoteAllocations.push(alloc({ invoiceId: 'INV-OTHER' }));
    prisma._stores.creditNotes.push(cn());
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect((sheet.details as ProfitSheetDetails).allowanceCost).toBe(0);
  });

  it('★ 外币折让算不出汇率 ⇒ 落 unconverted 披露，不得静默按 0 计入（G3）', async () => {
    prisma._stores.creditNotes.push(cn({ currency: 'XYZ', openAmount: 0, status: 'Closed' }));
    prisma._stores.creditNoteAllocations.push(alloc({ appliedAmount: 120 }));
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.allowances).toHaveLength(0);
    expect(d.allowanceCost).toBe(0);
    expect(d.unconverted.some((u) => u.kind === 'allowance' && String(u.label).includes('CLM-2026-0001'))).toBe(true);
    expect(sheet.grossProfit).toBeNull();
  });

  it('折让与银行手续费各自单列，互不吞（两栏同时存在时各算各的）', async () => {
    prisma._stores.creditNotes.push(cn());
    prisma._stores.creditNoteAllocations.push(alloc({ appliedAmount: 800 }));
    prisma._stores.paymentVouchers.push(
      { id: 'PV-M', voucherNumber: 'RCV-M', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-A', amount: 9200, bankFee: 78, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(d.allowanceCost).toBe(800);
    expect(d.bankFeeCost).toBe(78);
    expect(sheet.grossProfit).toBeNull();
  });
});
// ════════════════════════════════════════════════════════════════
// M1·D7-1c（收口）：OrderProfitSheet.bankFeeCost / allowanceCost 是
// NOT NULL DEFAULT 0 的**落库列**。此前零写入方 ⇒ 每次生成后恒为 0，
// 真值只躺在 details JSON 里 —— 下游一旦 select 这两列，会读到「0」并
// 理解成「已计算且手续费为 0」，正是 Kevin 明令禁止的「0 ≠ 没取到」。
// 本组用例钉死：两列必须随利润表一起写，且与 details 同值。
// ════════════════════════════════════════════════════════════════
describe('M1·D7-1c 落库列不得恒 0', () => {
  let prisma: any;
  let service: ReturnType<typeof createProfitSheetService>;

  beforeEach(() => {
    prisma = makeMockPrisma();
    service = createProfitSheetService(prisma as any);
    seedOrder(prisma);
    prisma._stores.invoices.push(
      { id: 'INV-P', invoiceNumber: 'INV-2026-P', orderId: 'ORD-1', type: 'Receivable', status: 'Issued', amount: 10000, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    prisma._stores.paymentVouchers.push(
      { id: 'PV-P', voucherNumber: 'RCV-2026-P', orderId: 'ORD-1', type: 'Receipt', invoiceId: 'INV-P', amount: 10000, bankFee: 78, currency: 'CNY', exchangeRate: null, deletedAt: null },
    );
    prisma._stores.creditNotes.push({
      id: 'CN_P', creditNoteNumber: 'CLM-2026-P', claimCaseId: null, sourceInvoiceId: 'INV-P',
      currency: 'CNY', amount: 1000, openAmount: 200, status: 'PartiallyApplied', issueDate: '2026-06-01',
      appliedToInvoiceId: null, reason: '色差折让', deletedAt: null,
    });
    prisma._stores.creditNoteAllocations.push(
      { id: 'CNA__CN_P__INV-P', creditNoteId: 'CN_P', invoiceId: 'INV-P', appliedAmount: 800, appliedDate: '2026-06-02' },
    );
  });

  it('★ 新建利润表：两列落库且与 details 同值（不得留默认值 0）', async () => {
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(Number(sheet.bankFeeCost), 'bankFeeCost 列此前零写入方，恒为 0 = 静默伪装').toBe(78);
    expect(Number(sheet.allowanceCost), 'allowanceCost 列此前零写入方，恒为 0 = 静默伪装').toBe(800);
    // 与 details 同值（同一函数内取，无漂移可能）
    expect(Number(sheet.bankFeeCost)).toBe(d.bankFeeCost);
    expect(Number(sheet.allowanceCost)).toBe(d.allowanceCost);
  });

  it('★ 重生成（走 update 分支）：两列必须跟着变，不得停在首次数值', async () => {
    await service.generateOrderProfitSheet('ORD-1', 'u1');
    // 手续费由 78 → 150；折让抵扣额由 800 → 1000
    prisma._stores.paymentVouchers[0].bankFee = 150;
    prisma._stores.creditNoteAllocations[0].appliedAmount = 1000;
    const again = await service.generateOrderProfitSheet('ORD-1', 'u1');
    expect(Number(again.bankFeeCost), 'update 分支漏写 ⇒ 列停在旧值').toBe(150);
    expect(Number(again.allowanceCost), 'update 分支漏写 ⇒ 列停在旧值').toBe(1000);
  });

  it('无任何手续费/折让时，两列落 0 是**真值**（不是缺数）—— 明细为空佐证', async () => {
    prisma._stores.paymentVouchers.length = 0;
    prisma._stores.creditNotes.length = 0;
    prisma._stores.creditNoteAllocations.length = 0;
    const sheet = await service.generateOrderProfitSheet('ORD-1', 'u1');
    const d = sheet.details as ProfitSheetDetails;
    expect(Number(sheet.bankFeeCost)).toBe(0);
    expect(Number(sheet.allowanceCost)).toBe(0);
    expect(d.bankFees).toEqual([]);
    expect(d.allowances).toEqual([]);
  });
});


describe('成本阶段证据v2',()=>{
 it('采购承诺10000、验收6000、付款3000分开，草稿及发出未确认不计承诺，重复生成无重复成本',async()=>{
  const db:any=makeMockPrisma();seedOrder(db);
  const line={id:'L1',materialCode:'FAB',unit:'m',unitPrice:10};
  db._stores.purchaseOrders.push(...['Confirmed','Draft','Sent'].map((status,i)=>({id:'PO'+i,orderId:'ORD-1',poNumber:'P'+i,status,totalAmount:10000,currency:'CNY',exchangeRate:null,deletedAt:null,lines:[line],receipts:i===0?[{id:'R1',receiptNumber:'R',totalAccepted:600}]:[]})));
  db.auditLog={findFirst:async()=>({detail:{after:{lineReceipts:[{lineId:'L1',materialCode:'FAB',unit:'m',accepted:600,rejected:0}]}}})};
  db._stores.paymentVouchers.push({id:'PV',orderId:'ORD-1',type:'Disbursement',invoiceId:null,amount:3000,bankFee:20,currency:'CNY',exchangeRate:null,deletedAt:null});
  const service=createProfitSheetService(db);
  for(let i=0;i<2;i++) {
   const sheet=await service.generateOrderProfitSheet('ORD-1','u');
   expect(sheet.miscCost).toBe(0);expect(sheet.purchaseCost).toBe(10000);expect(sheet.bankFeeCost).toBe(20);
   expect((sheet.details as any).costEvidence).toMatchObject({version:2,status:'pending',committedAmountCny:10000,acceptedAmountCny:6000,paidPrincipalCny:3000,actualCostCny:null,actualProfitCny:null});
   expect(sheet.grossProfit).toBeNull();
  }
  db._stores.paymentVouchers[0].invoiceId='PAYABLE';
  expect((await service.generateOrderProfitSheet('ORD-1','u')).bankFeeCost).toBe(20);
  db.auditLog.findFirst=async()=>({detail:{after:{lineReceipts:[{lineId:'L1',materialCode:'FAB',unit:'m',accepted:601}]}}});
  expect(((await service.generateOrderProfitSheet('ORD-1','u')).details as any).costEvidence.acceptedAmountCny).toBeNull();
  db.auditLog.findFirst=async()=>null;
  expect(((await service.generateOrderProfitSheet('ORD-1','u')).details as any).costEvidence.acceptedAmountCny).toBeNull();
 });
 it('旧持久化利润数字从详情和列表均不可冒充实际',async()=>{
  const db:any=makeMockPrisma();db._stores.profitSheets.push({orderId:'ORD-1',grossProfit:123,grossMargin:20,details:{}});
  const service=createProfitSheetService(db);
  expect((await service.getProfitSheetByOrder('ORD-1'))?.grossProfit).toBeNull();
  expect((await service.listProfitSheets({})).items[0].grossMargin).toBeNull();
 });
});
