import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createFinanceRouter } from '../route';
import { createInvoice } from '../invoiceMutationService';
import { authHeader } from '../../__tests__/authTestHelper';
import { createAuthService } from '../../auth/service';

// Explicit in-memory current DB authority; real permission/source helpers run.
// The original legacy-owner credential now has a corresponding active account,
// stored role grants and scoped reads. This seam is not native PG lock evidence.
function storedOwner(prisma: any, tx: any) {
  const user = { id: 'u_owner', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'owner', departmentId: null, role: { id: 'owner', name: 'Stored synthetic owner',
      permissions: ['invoices:read', 'invoices:write', 'orders:read'].map(scope => ({ permission: { scope } })) } }] };
  const findUser = vi.fn(async ({ where }: any) => where.id === user.id ? user : null);
  for (const client of [prisma, tx]) {
    client.userAccount = { findUnique: findUser, findFirst: findUser };
    client.userPermissionOverrides = { findMany: vi.fn(async () => []) };
  }
  return user;
}

function cloneStored(value: any): any {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneStored);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneStored(item)]));
  return value;
}

function makeApp(opts: { invoice?: any; syncFail?: boolean; auditFail?: boolean; onDataChange?: any } = {}) {
  const invoice = opts.hasOwnProperty('invoice') ? opts.invoice : { id: 'INV__1', invoiceNumber: 'INV-1', type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal('100.0000'), currency: 'USD', issueDate: '2026-07-02', exchangeRate: null, deletedAt: null };
  const persisted = { invoices: invoice ? [cloneStored(invoice)] : [], lines: [] as any[], allocations: [] as any[], audits: [] as any[], references: [] as any[], links: [] as any[] };
  const invoiceCreate = vi.fn().mockImplementation(async ({ data }: any) => { const row = { ...data, id: 'INV__NEW' }; persisted.invoices.push(row); return row; });
  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => { const row = persisted.invoices.find(value => value.id === where.id); Object.assign(row, data); return { ...row }; });
  const invoiceFindUnique = vi.fn(async ({ where }: any) => persisted.invoices.find(value => value.id === where.id) ?? null);
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn(async ({ data }: any) => { persisted.audits.push(data); return data; });
  const entityReferenceUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn(async ({ create }: any) => { persisted.references.push(create); return create; });
  const entityLinkUpsert = vi.fn(async ({ create }: any) => { persisted.links.push(create); return create; });
  const orderFindMany = vi.fn().mockResolvedValue([
      { id: 'O1', code: 'SO-202608-001', poNumber: 'PO-1' },
      { id: 'O2', code: 'SO-202608-002', poNumber: null },
    ]);
  const orderAllocCreate = vi.fn(async ({ data }: any) => { persisted.allocations.push(data); return data; });
  const orderAllocUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  // ★ B140：写行那一支（`tx.invoiceLine.createMany`）在本批之前**零执行覆盖**，两种吞法各占一半：
  //   ① 调用方两份用例（billingItemService / sceneInvoiceService）把 `invoiceMutationService` **整模块 vi.mock**
  //     ⇒ 只断言"调用参数里带了 invoiceLines"，服务里怎么写库一行没执行；
  //   ② 本文件与 invoiceAmountRecalc / invoiceConsolidationCustomerGate 三处夹具虽有 `invoiceLine.createMany` 桩，
  //     但没有任何用例**带 invoiceLines 入参** ⇒ `lines.length` 恒为 0 ⇒ 那支从不进入。
  const invoiceLineCreateMany = vi.fn(async ({ data }: any) => { persisted.lines.push(...data); return { count: data.length }; });
  // CI 级模板数据源 mock：出口商档案（SystemConfig 未配置 → 默认档案）/ 交易对手 / 订单 / 订单行明细 / 出运单
  const systemConfigFindUnique = vi.fn().mockResolvedValue(null);
  const relationFindUnique = vi.fn().mockResolvedValue(null);
  const orderLinesFindMany = vi.fn().mockResolvedValue([
    { orderId: 'O1', lineNumber: 1, itemNo: 'ART-001', description: 'Navy Wool Twill', quantity: new Prisma.Decimal('100'), unit: 'M', unitPrice: new Prisma.Decimal('0.5'), netValue: new Prisma.Decimal('50') },
  ]);
  const ordersFindMany = vi.fn().mockResolvedValue([
    { id: 'O1', code: 'SO-202608-001', poNumber: 'PO-1', deliveryTerms: 'FOB SHANGHAI', paymentTerms: 'T/T 30% DEPOSIT', shipToName: null },
    { id: 'O2', code: 'SO-202608-002', poNumber: null, deliveryTerms: null, paymentTerms: null, shipToName: null },
  ]);
  const shipmentFindFirst = vi.fn().mockResolvedValue(null);
  const tx = {
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary invoice: no MaterialReturn claimInvoiceId back-reference.
    materialReturn: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn().mockResolvedValue([{id:"COST"}]),
    billingItemCostCoverage: {findFirst:vi.fn().mockResolvedValue(null)},
    billingItem: {findFirst:vi.fn().mockResolvedValue(null)},
    invoice: { create: invoiceCreate, update: invoiceUpdate, findUnique: invoiceFindUnique, findFirst: invoiceFindUnique },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    // L2 #8 配套（2026-09-17）：updateInvoice 改 amount 时会读 Σ已核销
    // （sumAppliedAmount → findMany）并在重算成 Paid 时取最后一笔核销日期（findFirst）。
    invoiceAllocation: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityReferenceUpsert },
    entityLink: { upsert: entityLinkUpsert, findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    order: { findMany: orderFindMany, findUnique: vi.fn().mockResolvedValue({ id: 'O1', paymentTerms: null }) }, // T2: dueDate 推导查订单 paymentTerms（null → 不推导，保持旧行为）
    invoiceOrderAllocation: { create: orderAllocCreate, updateMany: orderAllocUpdateMany, findMany: vi.fn(async () => []) },
    invoiceLine: { createMany: invoiceLineCreateMany },
  } as any;
  const prisma = {
    invoice: { findMany: vi.fn(async () => persisted.invoices), findUnique: invoiceFindUnique },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    invoiceAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([{ id: 'IOA__1', orderId: 'O1', orderNumber: 'ORD-1', poNumber: 'PO-1', allocatedAmount: new Prisma.Decimal('50.0000'), note: null }]) },
    systemConfig: { findUnique: systemConfigFindUnique },
    relation: { findUnique: relationFindUnique },
    order: { findMany: ordersFindMany, findUnique: vi.fn().mockResolvedValue(null) },
    orderLine: { findMany: orderLinesFindMany },
    shipment: { findFirst: shipmentFindFirst },
    invoiceLine: { createMany: invoiceLineCreateMany },
    $transaction: vi.fn(async (fn: any) => { const before = cloneStored(persisted); try { return await fn(tx); } catch (error) { Object.assign(persisted, before); throw error; } }),
  } as any;
  const storedUser = storedOwner(prisma, tx);
  tx.order.findFirst = vi.fn(async ({ where }: any) => (await orderFindMany({ where: { id: { in: ['O1', 'O2'] } } })).find((row: any) => row.id === where.id) ?? null);
  tx.orderLine = { findMany: vi.fn(async () => []) };
  tx.sample = { findMany: vi.fn(async () => []) };
  tx.releaseScope = { findMany: vi.fn(async () => []) };
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, prisma, tx, persisted, storedUser, invoiceCreate, invoiceUpdate, invoiceFindUnique, auditCreate, entityReferenceUpsert, entityLinkUpsert, onDataChange, orderAllocCreate, orderAllocUpdateMany, orderFindMany, invoiceLineCreateMany };
}

describe('invoiceMutationService route POST /finance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create success → Decimal-safe + sync + audit + onDataChange', async () => {
    const { app, invoiceCreate, entityReferenceUpsert, entityLinkUpsert, auditCreate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '123.4567', currency: 'USD', issueDate: '2026-07-02', status: 'Issued', orderId: 'O1', customerRelationId: 'R1', exchangeRate: '7.1234' });
    expect(res.status).toBe(201);
    const data = invoiceCreate.mock.calls[0][0].data;
    expect(data.amount).toBeInstanceOf(Prisma.Decimal);
    expect(data.exchangeRate).toBeInstanceOf(Prisma.Decimal);
    expect(entityReferenceUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('create with orderIds → writes invoice↔order allocations with snapshot', async () => {
    const { app, orderAllocCreate, orderFindMany } = makeApp();
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-2', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft', orderIds: ['O1', 'O2'] });
    expect(res.status).toBe(201);
    // orderFindMany 用分配订单做快照（订单号取 Order.code，PO 取 poNumber）
    // customerRelationId / customer 是「同客户」校验的判据（L2 高危 2 号）——本 mock 两者都缺，
    // 属「客户数据不全」→ 校验按设计不误报（见 findAllocationCustomerViolation 注释）
    expect(orderFindMany).toHaveBeenCalledWith({ where: { id: { in: ['O1', 'O2'] }, deletedAt: null }, select: { id: true, code: true, poNumber: true, customerRelationId: true, customer: true } });
    expect(orderAllocCreate).toHaveBeenCalledTimes(2);
    const callData = orderAllocCreate.mock.calls.map((c: any) => c[0].data);
    expect(callData.map((d: any) => d.orderId)).toEqual(expect.arrayContaining(['O1', 'O2']));
    expect(callData.find((d: any) => d.orderId === 'O1')).toMatchObject({ invoiceId: 'INV__NEW', orderId: 'O1', orderNumber: 'SO-202608-001', poNumber: 'PO-1' });
    expect(callData.find((d: any) => d.orderId === 'O2')).toMatchObject({ orderNumber: 'SO-202608-002', poNumber: null });
  });

  it('GET /:id → returns orderAllocations alongside invoice', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).get('/api/v1/finance/INV__1').set(authHeader());
    expect(res.status).toBe(200);
    expect(prisma.invoiceOrderAllocation.findMany).toHaveBeenCalledWith({ where: { invoiceId: 'INV__1', deletedAt: null }, orderBy: { createdAt: 'asc' } });
    expect(Array.isArray(res.body.orderAllocations)).toBe(true);
    expect(res.body.orderAllocations[0]).toMatchObject({ orderId: 'O1', orderNumber: 'ORD-1', poNumber: 'PO-1', allocatedAmount: 50 });
  });

  it('GET /:id/preview.html → text/html CI 级同源渲染（信头/双方/条款组/行明细/金额大写 + A4 画布）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/finance/INV__1/preview.html').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // CI 抬头与公司信头 + 单据标识（内部 Status 字段不出现）
    expect(res.text).toContain('COMMERCIAL INVOICE');
    expect(res.text).toContain('商业发票');
    expect(res.text).toContain('INV-1');
    expect(res.text).toContain('ORIGINAL');
    // doc-* 基座结构标记（2026-08-21 统一裁决：与合同/装箱单同一版式基因，无旧 letterhead 类）
    expect(res.text).toContain('doc-header');
    expect(res.text).toContain('doc-party-grid');
    // 卖方 = 出口商档案默认值（SystemConfig 未配置 → DEFAULT_EXPORTER_PROFILE）
    expect(res.text).toContain('JIANGSU PANDA CLOTHING CO.,LTD.');
    // 运输与条款组（订单 deliveryTerms/paymentTerms + 原产国）
    expect(res.text).toContain('Shipment &amp; Terms');
    expect(res.text).toContain('FOB SHANGHAI');
    expect(res.text).toContain('T/T 30% DEPOSIT');
    expect(res.text).toContain('Country of Origin');
    // 订单分配行 + 订单行明细分组（Order ORD-1 · P/O PO-1 + 货号/品名/数量/金额）
    expect(res.text).toContain('Order ORD-1');
    expect(res.text).toContain('PO-1');
    expect(res.text).toContain('ART-001');
    expect(res.text).toContain('Navy Wool Twill');
    expect(res.text).toContain('50.00');
    // 合计 + 金额大写（invoice.amount = 100 USD）
    expect(res.text).toContain('SAY TOTAL US DOLLARS ONE HUNDRED ONLY');
    // 收款银行块（应收发票展示受益人银行）
    expect(res.text).toContain('Beneficiary Bank');
    expect(res.text).toContain('BKCHCNBJ95L');
    // 签字 + 盖章区 + 页脚（E&OE）——doc-* 基座双签章三段式（sig-label/sig-line/sig-name）
    expect(res.text).toContain('(签章)');
    expect(res.text).toContain('Authorized Signature / Date');
    expect(res.text).toContain('E. &amp; O. E.');
    // screen 预览 = A4 纸张画布（210mm 固定纸宽 + 纸内边距，不随容器自适应）
    expect(res.text).toContain('width: 210mm');
    expect(res.text).toContain('min-height: 297mm');
    expect(res.text).toContain('padding: 40px 48px');
  });

  it('GET /:id/preview.html → 空分配渲染空态占位行（TOTAL 不悬空）', async () => {
    // makeApp 闭包不便覆写——重建 app 用空分配 mock 验证空态分支
    const base = makeApp();
    const prisma = base.prisma;
    prisma.invoiceOrderAllocation.findMany.mockResolvedValueOnce([]);
    const res = await request(base.app).get('/api/v1/finance/INV__1/preview.html').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.text).toContain('No order lines allocated');
    // 空态下不渲染运输与条款组（无订单 → 无条款数据）
    expect(res.text).not.toContain('FOB SHANGHAI');
  });

  it('GET /:id/preview.html → 404 for missing/deleted invoice', async () => {
    const { app } = makeApp({ invoice: null });
    const res = await request(app).get('/api/v1/finance/INV__NONE/preview.html').set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('invalid status → 400 INVALID_STATUS before tx', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('invalid transition Draft→Paid → 400 INVALID_TRANSITION before tx', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Paid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('invalid/missing/null amount → 400 INVALID_AMOUNT before tx', async () => {
    const invalid = makeApp();
    const r1 = await request(invalid.app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: 'abc', currency: 'USD', issueDate: '2026-07-02' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('INVALID_AMOUNT');
    expect(invalid.prisma.$transaction).not.toHaveBeenCalled();

    const missing = makeApp();
    const r2 = await request(missing.app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', currency: 'USD', issueDate: '2026-07-02' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('INVALID_AMOUNT');
    expect(missing.prisma.$transaction).not.toHaveBeenCalled();
    expect(missing.auditCreate).not.toHaveBeenCalled();
    expect(missing.onDataChange).not.toHaveBeenCalled();

    const nullAmount = makeApp();
    const r3 = await request(nullAmount.app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: null, currency: 'USD', issueDate: '2026-07-02' });
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('INVALID_AMOUNT');
    expect(nullAmount.prisma.$transaction).not.toHaveBeenCalled();
    expect(nullAmount.auditCreate).not.toHaveBeenCalled();
    expect(nullAmount.onDataChange).not.toHaveBeenCalled();
  });

  it('sync/audit reject fail closed', async () => {
    const sync = makeApp({ syncFail: true });
    const r1 = await request(sync.app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Issued', orderId: 'O1' });
    expect(r1.status).toBe(500);
    expect(r1.body.error.code).toBe('CREATE_FAILED');
    expect(sync.auditCreate).not.toHaveBeenCalled();
    expect(sync.onDataChange).not.toHaveBeenCalled();
    const audit = makeApp({ auditFail: true });
    const r2 = await request(audit.app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02' });
    expect(r2.status).toBe(500);
    expect(r2.body.error.code).toBe('CREATE_FAILED');
    expect(audit.onDataChange).not.toHaveBeenCalled();
  });
});

describe('invoiceMutationService route PATCH /finance/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update success → status transition + Decimal-safe + sync + audit', async () => {
    const { app, invoiceUpdate, auditCreate, onDataChange } = makeApp({ invoice: { id: 'INV__1', status: 'Draft', amount: new Prisma.Decimal('100'), deletedAt: null } });
    const res = await request(app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ status: 'Issued', amount: '50.5000' });
    expect(res.status).toBe(200);
    expect(invoiceUpdate.mock.calls[0][0].data.amount).toBeInstanceOf(Prisma.Decimal);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('not found/deleted → 404 NOT_FOUND', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ invoice: { id: 'INV__1', deletedAt: BigInt(1) } });
    const res = await request(app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ amount: '10' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('invalid status/transition/amount fail closed before update', async () => {
    const badStatus = makeApp();
    const r1 = await request(badStatus.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ status: null });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('INVALID_STATUS');
    expect(badStatus.prisma.$transaction).not.toHaveBeenCalled();

    // PartiallyPaid/Paid 是 allocation-managed 状态，不可手动 PATCH → STATUS_NOT_MANUAL_SETTABLE
    const allocationManaged = makeApp({ invoice: { id: 'INV__1', status: 'Issued', amount: new Prisma.Decimal('100'), deletedAt: null } });
    const rAlloc = await request(allocationManaged.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ status: 'PartiallyPaid' });
    expect(rAlloc.status).toBe(400);
    expect(rAlloc.body.error.code).toBe('STATUS_NOT_MANUAL_SETTABLE');

    // 终态 → 无效流转（Cancelled 是终态，不可再转移）
    const badTransition = makeApp({ invoice: { id: 'INV__1', status: 'Cancelled', amount: new Prisma.Decimal('100'), deletedAt: null } });
    const r2 = await request(badTransition.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ status: 'Issued' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('INVALID_TRANSITION');

    const badAmount = makeApp();
    const r3 = await request(badAmount.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ amount: 'NaN' });
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('INVALID_AMOUNT');
    expect(badAmount.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sync/audit reject fail closed and no onDataChange', async () => {
    const sync = makeApp({ syncFail: true });
    const r1 = await request(sync.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ orderId: 'O1' });
    expect(r1.status).toBe(500);
    expect(r1.body.error.code).toBe('UPDATE_FAILED');
    expect(sync.auditCreate).not.toHaveBeenCalled();
    expect(sync.onDataChange).not.toHaveBeenCalled();

    const audit = makeApp({ auditFail: true });
    const r2 = await request(audit.app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ amount: '10' });
    expect(r2.status).toBe(500);
    expect(r2.body.error.code).toBe('UPDATE_FAILED');
    expect(audit.onDataChange).not.toHaveBeenCalled();
  });

  it('POST/PATCH route→service 契约：各触发 service 内 transaction 一次', async () => {
    const { app, prisma } = makeApp();
    await request(app).post('/api/v1/finance').set(authHeader()).send({ invoiceNumber: 'INV-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02' });
    await request(app).patch('/api/v1/finance/INV__1').set(authHeader()).send({ amount: '20' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

/**
 * B140 · 行级开票的**行金额**此前一次门禁都没有（表头有：`normalizeCreateInput` 会拒非法 amount，
 * 而行是 `new Prisma.Decimal(l.amount ?? 0)` 直接进库）。
 * ⚠️ 这里刻意**只做"能不能解析"这一半**：
 *  - 负数照旧收下（行金额可为负是本仓既有行为，冲减/折让走这条路，属四项口径 ⇒ 不擅自动）；
 *  - "没填 ⇒ 0"照旧（同一件事在收费事项侧已升 §12.1 第 28 条，这里不重复开条目、也不提前替 Kevin 定）。
 * 所以 ⑤⑥ 两格是"钉住我没顺手收紧"的反面对照，不是断言正确性。
 */
describe('B140 · 行级开票：行的金额要能拒非法（此前只有表头有门禁）', () => {
  beforeEach(() => vi.clearAllMocks());

  const line = (amount: unknown) => ({ sourceType: 'CostRecord', sourceId: 'CR__1', amount });
  const post = (extra: any) => {
    const h = makeApp();
    return { h, res: request(h.app).post('/api/v1/finance').set(authHeader())
      .send({ invoiceNumber: 'INV-L1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft', ...extra }) };
  };

  it('① 行金额是垃圾串 → 400 INVALID_AMOUNT，且票和行都没落库', async () => {
    const { h, res } = post({ invoiceLines: [line('12abc')] });
    const r = await res;
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe('INVALID_AMOUNT');
    expect(h.invoiceCreate).not.toHaveBeenCalled();
    expect(h.invoiceLineCreateMany).not.toHaveBeenCalled();
  });

  /**
   * ② NaN 必须**绕过 HTTP 直接调服务**才测得到：`JSON.stringify` 把 NaN 序列化成 `null`
   * （本批先写成 HTTP 版，结果拿到的 input 是 `amount:null` ⇒ 断言 400 却跑出 201，
   * 那是"测了个到不了的路径"的假覆盖，不是缺陷不存在）。而服务侧的调用方**能**送出 NaN：
   * `billingItemService` 传 `net.toNumber()`、`sceneInvoiceService:186` 传 `Number(x.amount)`（它的表头求和那一行才是带兜底的写法），
   * 上游任一分量是 NaN 就一路传下来。**改动前的行为是用突变复量出来的**（M1：摘掉本批那道早返回 ⇒
   * 这一例红在 `r.ok` 为 true），不是凭 Decimal 语义推的。
   * ★★ v3.21 更正：原话「也就是 NaN 一路通过、**事务照常提交**」已被推翻 —— 那是**替身给的行为结论**。
   *   M1 跑在 `makeApp()` 的桩上（桩对任何金额都返回成功），所以它只证得了"非法金额**到达了写调用**、
   *   且服务自认为成功"，证不了"库里落了一条 NaN 的钱"。真库侧探针实测两种 NaN 都**到不了库**
   *   （裸 `NaN` 报 `PrismaClientValidationError`、`Decimal(NaN)` 报 `PrismaClientUnknownRequestError`，
   *   整条 `$transaction` 回滚）⇒ 真实后果是「用户拿 500 + 整单失败」，见 §9 B140（那里还标了
   *   驱动层那一半**不可离线复跑**）。"到不到写调用"这一半有常驻证人：`moneyArrivalGate.test.ts`。
   */
  it('② 行金额是 NaN → 服务层直接拒 400（JSON 带不了 NaN，故绕开 HTTP 测这条路）', async () => {
    const { prisma, invoiceCreate, invoiceLineCreateMany } = makeApp();
    const r = await createInvoice({
      prisma,
      input: { invoiceNumber: 'INV-L2', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft', invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__nan', amount: Number.NaN }] } as any,
      actorId: 'U1',
    });
    expect(r.ok).toBe(false);
    expect((r as any).error?.code).toBe('INVALID_AMOUNT');
    expect((r as any).error?.message).toContain('invoiceLines[0].amount');
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(invoiceLineCreateMany).not.toHaveBeenCalled();
  });

  it('③ 行金额是布尔/数组 → 400（数组会被 String() 成 "5" 那种静默换算也不许过）', async () => {
    const a = post({ invoiceLines: [line(true)] });
    const ra = await a.res;
    expect(ra.status).toBe(400);
    expect(a.h.invoiceLineCreateMany).not.toHaveBeenCalled();
    const b = post({ invoiceLines: [line([5])] });
    const rb = await b.res;
    expect(rb.status).toBe(400);
    expect(rb.body?.error?.code).toBe('INVALID_AMOUNT');
    expect(b.h.invoiceLineCreateMany).not.toHaveBeenCalled();
  });

  it('④ 一条行坏 ⇒ 整单拒（不许"坏的那行丢掉、好行开票"这种半成功）', async () => {
    const { h, res } = post({ invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__ok', amount: '30' }, line('abc')] });
    const r = await res;
    expect(r.status).toBe(400);
    expect(h.invoiceCreate).not.toHaveBeenCalled();
    expect(h.invoiceLineCreateMany).not.toHaveBeenCalled();
  });

  it('⑤ 反面对照（决定 ①–④ 不是"什么都拒"的假绿）：合法行金额照常写 Decimal', async () => {
    const { h, res } = post({ invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__2', amount: '120.5000', currency: 'USD' }] });
    const r5 = await res;
    expect(r5.status, r5.text).toBe(201);
    expect(h.invoiceLineCreateMany).toHaveBeenCalledTimes(1);
    const rows = h.invoiceLineCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].amount)).toBe('120.5');
  });

  /**
   * ★ 复核 v3.16 IMPORTANT-1：这一格是**本批自己没说出来的收紧**，补在这儿让它可见、可回退。
   *   行门禁复用了表头那份纯十进制谓词 ⇒ `1e3` / `.5` / `1.` / `+5` 这类"Decimal 收、正则不收"的写法
   *   **改前会成功落库并被换算成 1000 / 0.5 / 1 / 5**（实测 `new Prisma.Decimal('1e3').toString()` = '1000'），
   *   改后一律 400。方向与表头一致（表头本来就拒），但**它确实是行为变更**，不是"只补能不能解析"。
   *   要不要放行科学计数法属 §12.1 第 29 条（三份以上"合法金额"定义要不要统一）⇒ 不在此替 Kevin 定。
   */
  it('⑤b 收紧已声明：`1e3` 这类 Decimal 收、纯正则不收的写法，改前静默换算成 1000、改后 400', async () => {
    const { h, res } = post({ invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__sci', amount: '1e3' }] });
    const r = await res;
    expect(r.status, '行门禁放过了纯正则不接受的写法 ⇒ 与表头不是同一份谓词了').toBe(400);
    expect(r.body?.error?.code).toBe('INVALID_AMOUNT');
    expect(h.invoiceLineCreateMany, '改前这一格会写入一行 1000').not.toHaveBeenCalled();
  });

  it('⑥ 刻意没收紧（两条钉子）：负数行金额照旧收、没填照旧记 0', async () => {
    const neg = post({ invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__neg', amount: '-50' }] });
    const rneg = await neg.res;
    expect(rneg.status, rneg.text).toBe(201);
    expect(String(neg.h.invoiceLineCreateMany.mock.calls[0][0].data[0].amount)).toBe('-50');
    const miss = post({ invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'CR__miss' }] });
    const rmiss = await miss.res;
    expect(rmiss.status, rmiss.text).toBe(201);
    expect(String(miss.h.invoiceLineCreateMany.mock.calls[0][0].data[0].amount)).toBe('0');
  });

  it('⑦ 校验侧与写入侧共用同一份谓词（防漂）：不可写的行既不校验也不写，坏金额也不会漏进库', async () => {
    // 没有 sourceId 的行按既有口径**不写**（`isIssuableInvoiceLine`）。这条是**反漂移证人**：
    // 若有人把写入侧的 filter 改宽（比如只认 sourceType），这行就会绕过校验往下走 ⇒ 本批用 M4 实测：这一例当场红。
    const { h, res } = post({ invoiceLines: [{ sourceType: 'CostRecord', amount: '12abc' }] });
    const r7 = await res;
    expect(r7.status, r7.text).toBe(201);
    expect(h.invoiceLineCreateMany).not.toHaveBeenCalled();
  });
});

/**
 * 走查·发票站第二族（§9 B294 的 owner 那一半）：开一张应收票，"谁开的"必须落库。
 * 读侧 financeServiceV2 按 ownerId 过滤；而这份 createInvoice 是**五族调用方共用的唯一写口**
 * （手工开票 / 场景开票 / 样品开票 / 佣金应付 / 收费事项）⇒ 它不写 ownerId，五条路开出的票就全都无主，
 * self/team 档的开票人看不到自己刚开的那张。库内现量证人：`BI-INV-MTRCC815`（sourceType=BillingItem、Draft、ownerId 空）。
 */
describe('B294 · createInvoice 把开票人落成 ownerId（五族共用这一处写口）', () => {
  it('带 actorId 开票 → ownerId 就是那个人', async () => {
    const { prisma, invoiceCreate } = makeApp();
    const r = await createInvoice({
      prisma,
      input: { invoiceNumber: 'INV-OWN-1', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft' } as any,
      actorId: 'usr_demo_finance',
    });
    expect(r.ok).toBe(true);
    expect(invoiceCreate.mock.calls[0][0].data.ownerId).toBe('usr_demo_finance');
  });

  it('拿不到操作者 → 落 null（不许把审计那个 \'api\' 兜底当归属写进钱屏）', async () => {
    const { prisma, invoiceCreate } = makeApp();
    const r = await createInvoice({
      prisma,
      input: { invoiceNumber: 'INV-OWN-2', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft' } as any,
      actorId: undefined,
    });
    expect(r.ok).toBe(true);
    expect(invoiceCreate.mock.calls[0][0].data).toHaveProperty('ownerId', null);
  });

  it('★ 调用方传空串 actorId（billingItemRoute 就是这么写的 `actorIdFromRequest(req) || \'\'`）→ 仍落 null，不许把空串当归属', async () => {
    const { prisma, invoiceCreate } = makeApp();
    const r = await createInvoice({
      prisma,
      input: { invoiceNumber: 'INV-OWN-3', type: 'Receivable', amount: '100', currency: 'USD', issueDate: '2026-07-02', status: 'Draft' } as any,
      actorId: '',
    });
    expect(r.ok).toBe(true);
    expect(invoiceCreate.mock.calls[0][0].data).toHaveProperty('ownerId', null);
  });
});

it('通用发票事务内拒绝整案已覆盖成本，不能绕过候选接口',async()=>{
 const f=makeApp();f.tx.billingItemCostCoverage.findFirst.mockResolvedValue({id:'COVER',billingItemId:'BI'});
 const result=await createInvoice({prisma:f.prisma,input:{invoiceNumber:'INV-COVER',type:'Receivable',amount:10,currency:'CNY',issueDate:'2026-09-30',status:'Draft',invoiceLines:[{sourceType:'CostRecord',sourceId:'COST',amount:10,currency:'CNY'}]},actorId:'u'});
 expect(result).toMatchObject({ok:false,error:{code:'LINE_ALREADY_ALLOCATED'}});expect(f.invoiceCreate).not.toHaveBeenCalled();expect(f.auditCreate).not.toHaveBeenCalled();
});


// Extra authority/atomicity controls, separate from all original business callbacks.
describe('stored authority and in-memory transaction controls (not native PG evidence)', () => {
  it('current stored write withdrawal refuses the old owner JWT and forged body capabilities', async () => {
    const f = makeApp();
    f.storedUser.roles[0].role.permissions = f.storedUser.roles[0].role.permissions.filter(grant => grant.permission.scope !== 'invoices:write');
    const before = cloneStored(f.persisted);
    const res = await request(f.app).post('/api/v1/finance').set(authHeader()).send({
      invoiceNumber: 'INV-REVOKED', type: 'Receivable', amount: '10', currency: 'CNY', issueDate: '2026-10-02',
      actorId: 'other-owner', roles: ['owner'], permissions: ['invoices:write'],
    });
    expect(res.status).toBe(403); expect(res.body.error.code).toBe('FORBIDDEN');
    expect(f.invoiceCreate).not.toHaveBeenCalled(); expect(f.persisted).toEqual(before); expect(f.onDataChange).not.toHaveBeenCalled();
  });

  it('the loaded signed empty ceiling denies a currently granted owner without starting writes', async () => {
    const f = makeApp(), scopes = f.storedUser.roles[0].role.permissions.map(grant => grant.permission.scope);
    const token = createAuthService().signToken({ userId: f.storedUser.id, roles: ['owner'], roleIds: ['owner'],
      permissions: scopes, departmentIds: [], authorizationLoaded: true, permissionCeiling: [] });
    const before = cloneStored(f.persisted);
    const res = await request(f.app).post('/api/v1/finance').set(authHeader(token)).send({
      invoiceNumber: 'INV-CEILING', type: 'Receivable', amount: '10', currency: 'CNY', issueDate: '2026-10-02',
      permissionCeiling: ['invoices:write'],
    });
    expect(res.status).toBe(403); expect(res.body.error).toBe('FORBIDDEN');
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.persisted).toEqual(before);
  });

  it.each(['sync', 'audit'] as const)('%s rejects restore the explicit Invoice/Line/projection storage snapshot', async fault => {
    const f = makeApp({ syncFail: fault === 'sync', auditFail: fault === 'audit' }), before = cloneStored(f.persisted);
    const result = await request(f.app).post('/api/v1/finance').set(authHeader()).send({
      invoiceNumber: 'INV-ATOMIC', type: 'Receivable', status: 'Draft', amount: '10', currency: 'CNY', issueDate: '2026-10-02', orderId: 'O1',
      invoiceLines: [{ sourceType: 'CostRecord', sourceId: 'COST', amount: '10', currency: 'CNY' }],
    });
    expect(result.status).toBe(500); expect(result.body.error.code).toBe('CREATE_FAILED');
    expect(f.invoiceCreate).toHaveBeenCalledTimes(1); expect(f.persisted).toEqual(before); expect(f.onDataChange).not.toHaveBeenCalled();
  });
});
