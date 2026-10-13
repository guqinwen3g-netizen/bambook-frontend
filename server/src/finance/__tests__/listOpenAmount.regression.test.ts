import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

/**
 * P1-005 回归：发票/凭证列表端点必须附 DR-044 净额派生字段
 *   appliedAmount = Σ InvoiceAllocation.appliedAmount（真源汇总，非快照）
 *   openAmount = 单据金额 − appliedAmount
 * 验收锚点：Peerless $84,000 PartiallyPaid 已核销 $50,000 →
 *   账龄/对账单/KPI 交叉一致（openAmount = $34,000）。
 */
function makeApp(allocations: any[], invoices: any[], vouchers: any[], cnAllocations: any[] = []) {
  const prisma = {
    invoice: {
      findUnique: vi.fn().mockImplementation(async ({where}: any) => invoices.find(i => i.id === where.id)),
      findMany: vi.fn().mockResolvedValue(invoices),
      count: vi.fn().mockResolvedValue(invoices.length),
    },
    paymentVoucher: {
      findUnique: vi.fn().mockImplementation(async ({where}: any) => vouchers.find(i => i.id === where.id)),
      findMany: vi.fn().mockResolvedValue(vouchers),
      count: vi.fn().mockResolvedValue(vouchers.length),
    },
    invoiceAllocation: {
      groupBy: vi.fn().mockResolvedValue(
        allocations.map((a) => ({
          invoiceId: a.invoiceId,
          voucherId: a.voucherId,
          _sum: { appliedAmount: a.appliedAmount },
        })),
      ),
      // 发票侧已核销自 2026-09-19 起走 findMany 真源（含贷项票抵扣），见 shared/invoiceAppliedSum
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        if (where?.voucherId?.in) return allocations.filter((a) => where.voucherId.in.includes(a.voucherId));
        return allocations.map((a) => ({ invoiceId: a.invoiceId, appliedAmount: a.appliedAmount }));
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    // 贷项票抵扣（客户索赔/折让）：发票侧「已核销」真源之一，见 shared/invoiceAppliedSum
    creditNoteAllocation: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) =>
        cnAllocations.filter((a) => !where?.invoiceId?.in || where.invoiceId.in.includes(a.invoiceId))),
    },
    // T2/D8-Q3 品类派生 + 批次锚点（读侧）：列表 attach 需要 IOA/批次/订单三模型
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    orderShipmentBatch: { findMany: vi.fn().mockResolvedValue([]) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
  } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
  return { app, prisma };
}

describe('P1-005 列表端点 DR-044 净额派生字段', () => {
  it('发票列表：PartiallyPaid $84,000 已核销 $50,000 → openAmount $34,000（对账单口径一致）', async () => {
    const { app } = makeApp(
      [{ invoiceId: 'INV-PRL', voucherId: 'PAY-1', appliedAmount: new Prisma.Decimal('50000.0000') }],
      [{ id: 'INV-PRL', invoiceNumber: 'INV-2026-PRL-0320', type: 'Receivable', status: 'PartiallyPaid', amount: new Prisma.Decimal('84000.0000'), currency: 'USD', deletedAt: null }],
      [],
    );
    const res = await request(app).get('/api/v1/finance').set(authHeader());
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.appliedAmount).toBe(50000);
    expect(item.openAmount).toBe(34000);
    expect(typeof item.amount).toBe('number'); // Decimal 序列化为 number
  });

  it('发票列表：无核销记录 → appliedAmount 0 / openAmount = 全额', async () => {
    const { app } = makeApp(
      [],
      [{ id: 'INV-ATL', invoiceNumber: 'INV-2026-ATL-0318', type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('38850.0000'), currency: 'USD', deletedAt: null }],
      [],
    );
    const res = await request(app).get('/api/v1/finance').set(authHeader());
    expect(res.body.items[0].appliedAmount).toBe(0);
    expect(res.body.items[0].openAmount).toBe(38850);
  });

  it('凭证列表：附 voucher 维度 openAmount（DR-044 凭证侧镜像）', async () => {
    const { app } = makeApp(
      [{ invoiceId: 'INV-1', voucherId: 'PAY-1', appliedAmount: new Prisma.Decimal('21600.0000') }],
      [],
      [{ id: 'PAY-1', voucherNumber: 'PAY-2026-NRD-0228', type: 'Receipt', status: 'reconciled', amount: new Prisma.Decimal('21600.0000'), currency: 'USD', deletedAt: null }],
    );
    const res = await request(app).get('/api/v1/finance/vouchers').set(authHeader());
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.appliedAmount).toBe(21600);
    expect(item.openAmount).toBe(0);
  });

  it('★ 贷项票抵扣后：状态与列表同口径 —— $84,000 收 $50,000 + 折让 $34,000 ⇒ openAmount 0（修前会显示仍欠 34,000）', async () => {
    const { app } = makeApp(
      [{ invoiceId: 'INV-CN', voucherId: 'PAY-CN', appliedAmount: new Prisma.Decimal('50000.0000') }],
      [{ id: 'INV-CN', invoiceNumber: 'INV-2026-CN-0901', type: 'Receivable', status: 'Paid', amount: new Prisma.Decimal('84000.0000'), currency: 'USD', deletedAt: null }],
      [],
      [{ invoiceId: 'INV-CN', creditNoteId: 'CN-1', appliedAmount: new Prisma.Decimal('34000.0000') }],
    );
    const res = await request(app).get('/api/v1/finance').set(authHeader());
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    // 状态是 Paid（状态判定真源 sumAppliedAmount 含折让）⇒ 列表必须同为「已收齐」
    expect(item.appliedAmount).toBe(84000);
    expect(item.openAmount).toBe(0);
  });

  it('★ 对照组：只有收款、无折让 ⇒ 仍欠 34,000（本修复不得把没收到的钱算成收到）', async () => {
    const { app } = makeApp(
      [{ invoiceId: 'INV-CN2', voucherId: 'PAY-CN2', appliedAmount: new Prisma.Decimal('50000.0000') }],
      [{ id: 'INV-CN2', invoiceNumber: 'INV-2026-CN-0902', type: 'Receivable', status: 'PartiallyPaid', amount: new Prisma.Decimal('84000.0000'), currency: 'USD', deletedAt: null }],
      [],
      [],
    );
    const res = await request(app).get('/api/v1/finance').set(authHeader());
    const item = res.body.items[0];
    expect(item.appliedAmount).toBe(50000);
    expect(item.openAmount).toBe(34000);
  });

  it('凭证列表：空结果不触发 groupBy（items 为空短路）', async () => {
    const { app, prisma } = makeApp([], [], []);
    const res = await request(app).get('/api/v1/finance/vouchers').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(prisma.invoiceAllocation.groupBy).not.toHaveBeenCalled();
  });
});

it('详情回读与列表余额一致，包含贷项抵扣且不消费旧快照', async () => {
  const {app} = makeApp([{invoiceId:'I', voucherId:'V', appliedAmount: 30}],
    [{id:'I', type:'Receivable', amount:100, currency:'USD', status:'PartiallyPaid'}],
    [{id:'V', type:'Receipt', amount:50, appliedAmount:0, currency:'USD', status:'partial'}],
    [{invoiceId:'I', creditNoteId:'C', appliedAmount:10}]);
  const inv = await request(app).get('/api/v1/finance/I').set(authHeader());
  const voucher = await request(app).get('/api/v1/finance/vouchers/V').set(authHeader());
  expect(inv.status).toBe(200);
  expect(inv.body).toMatchObject({appliedAmount:40, openAmount:60});
  expect(voucher.status).toBe(200);
  expect(voucher.body).toMatchObject({appliedAmount:30, openAmount:20});
});
