/**
 * §10.4.2 契约测试：成本类单据随关联订单可见。
 *
 * 业务方 2026-09-12 定案：BOM / 采购单「能看到某张订单，就看得到它的 BOM 与采购单」。
 * 两类单据都没有归属人字段（PO 只有自由文本 buyer，BOM 只挂产品/订单/报价），
 * 因此可见性只能由「关联订单是否可见」推导 —— 本测试锁这条链路：
 *   1) 列表：白名单注入到查询条件（AND 叠加，不覆盖 search OR）
 *   2) 详情/预览/来料：命中外单 → 404（防猜 id 直读）
 *   3) 白名单为 null（全权角色）→ 不加过滤
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const visibilityMock = vi.hoisted(() => ({
  resolveVisibleOrderIds: vi.fn(),
}));
vi.mock('../../auth/orderVisibility', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveVisibleOrderIds: visibilityMock.resolveVisibleOrderIds };
});

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createProcurementRouter } from '../procurementRoute';
import { createBOMRouter } from '../../bom/bomRoute';
import { authHeader } from '../../__tests__/authTestHelper';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const salesToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, JWT_SECRET);

function makeApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

beforeEach(() => {
  visibilityMock.resolveVisibleOrderIds.mockReset();
});

describe('§10.4.2 采购单随订单可见', () => {
  function prismaStub(po: any) {
    const listPurchaseOrders = vi.fn().mockResolvedValue({ items: [po], total: 1 });
    const prisma: any = {
      purchaseOrder: {
        findMany: vi.fn().mockResolvedValue([po]),
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(po),
      },
      // 路由构造期会建服务；用真实 service 时它会吃 prisma.purchaseOrder
    };
    return { prisma, listPurchaseOrders };
  }

  it('列表：白名单以 AND 叠加（不覆盖顶层 search OR）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const po = { id: 'PO1', poNumber: 'PO-1', orderId: 'O1', status: 'Draft', currency: 'CNY', totalAmount: 1, orderDate: '2026-01-01', createdAt: 0, updatedAt: 0 };
    const { prisma } = prismaStub(po);
    const app = makeApp(createProcurementRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).get('/?search=abc').set(authHeader(salesToken));
    expect(res.status).not.toBe(500);
    const where = prisma.purchaseOrder.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined(); // search OR 仍在
    expect(JSON.stringify(where.AND)).toContain('O1'); // 白名单进了 AND
  });

  it('详情：关联订单不在白名单 → 404（不泄露存在性）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const po = { id: 'PO2', poNumber: 'PO-2', orderId: 'O2', status: 'Draft', currency: 'CNY', totalAmount: 1, orderDate: '2026-01-01', createdAt: 0, updatedAt: 0, lines: [] };
    const { prisma } = prismaStub(po);
    const app = makeApp(createProcurementRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).get('/PO2').set(authHeader(salesToken));
    expect([403, 404]).toContain(res.status);
  });

  it('详情：关联订单在白名单 → 放行', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const po = { id: 'PO1', poNumber: 'PO-1', orderId: 'O1', status: 'Draft', currency: 'CNY', totalAmount: 1, orderDate: '2026-01-01', createdAt: 0, updatedAt: 0, lines: [] };
    const { prisma } = prismaStub(po);
    const app = makeApp(createProcurementRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    const res = await request(app).get('/PO1').set(authHeader(salesToken));
    expect(res.status).toBe(200);
  });
});

describe('§10.4.2 BOM 随订单可见（无订单走图书馆口径）', () => {
  function bomPrisma(orderId: string | null) {
    const bom = { id: 'BOM1', bomNumber: 'B-1', description: 'd', status: 'Draft', version: 1, orderId, totalCost: 1, currency: 'CNY', createdAt: 0, updatedAt: 0, lines: [], costEstimates: [] };
    return {
      bOM: {
        findMany: vi.fn().mockResolvedValue([bom]),
        count: vi.fn().mockResolvedValue(1),
        findUnique: vi.fn().mockResolvedValue(bom),
      },
    } as any;
  }

  it('列表：白名单叠加后仍保留「无关联订单」的 BOM（图书馆口径）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const prisma = bomPrisma(null);
    const app = makeApp(createBOMRouter({ prisma, requireAuth: false, apiKeys: new Set() }));

    await request(app).get('/').set(authHeader(salesToken));
    const where = prisma.bOM.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where.AND)).toContain('O1');
    expect(JSON.stringify(where.AND)).toContain('null'); // orderId: null 分支
  });

  it('详情：关联他单的 BOM → 不可见', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const app = makeApp(createBOMRouter({ prisma: bomPrisma('O_OTHER'), requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).get('/BOM1').set(authHeader(salesToken));
    expect([403, 404]).toContain(res.status);
  });

  it('详情：无关联订单的 BOM → 放行（与列表同口径）', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue([]);
    const app = makeApp(createBOMRouter({ prisma: bomPrisma(null), requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).get('/BOM1').set(authHeader(salesToken));
    expect(res.status).toBe(200);
  });
});

vi.mock('../../templates/docTemplates/purchaseOrder', () => ({ loadPurchaseOrderDocData: vi.fn(async () => ({ po: { id: 'PO1' }, lines: [] })) }));
vi.mock('../../templates/docTemplates/registry', () => ({ renderServerDocument: vi.fn(async () => '<html>PO</html>') }));

describe('PO / 询价 / 退换货写入对象范围', () => {
  const document = { id: 'PO2', poNumber: 'PO-2', orderId: 'O2', status: 'Draft', currency: 'CNY', totalAmount: 1, orderDate: '2026-01-01', createdAt: 0, updatedAt: 0, lines: [], receipts: [], deletedAt: null };
  function setup(orderId: string | null = 'O2') {
    const po = { ...document, orderId };
    const prisma: any = {
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(po), findMany: vi.fn().mockResolvedValue([]) },
      supplierInquiry: { findUnique: vi.fn().mockResolvedValue({ ...po, quotes: [] }), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      materialReturn: { findUnique: vi.fn().mockResolvedValue({ id:'R',purchaseOrderId:'PO2', deletedAt:null }), findMany: vi.fn().mockResolvedValue([]) },
      materialReceipt: { findUnique: vi.fn().mockResolvedValue({ id:'RC',purchaseOrderId:'PO2' }) },
      bOM: { findUnique: vi.fn().mockResolvedValue({orderId:'O2',deletedAt:null}) },
      $transaction: vi.fn(),
    };
    const app = makeApp(createProcurementRouter({prisma,requireAuth:false,apiKeys:new Set()}));
    return {app,prisma};
  }
  it.each(['send','confirm','cancel','close','generate-document','receipts'])('隐藏PO %s 返回404，未产生写入', async action => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const {app,prisma}=setup();
    const res=await request(app).post(`/PO2/${action}`).set(authHeader(salesToken)).send({});
    expect(res.status).toBe(404); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['put','delete'] as const)('隐藏PO %s 不可绕过详情权限写入', async method => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app)[method]('/PO2').set(authHeader(salesToken)).send({})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('创建/修改检查目标订单与BOM来源，不只检查原PO', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup('O1');
    expect((await request(app).post('/').set(authHeader(salesToken)).send({orderId:'O2'})).status).toBe(404);
    expect((await request(app).put('/PO2').set(authHeader(salesToken)).send({orderId:'O2'})).status).toBe(404);
    expect((await request(app).put('/PO2').set(authHeader(salesToken)).send({bomId:'BOM2'})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('自己的PO预览按真实PO授权，不要求打印视图暴露orderId', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app}=setup('O1');
    const response=await request(app).get('/PO2/preview.html').set(authHeader(salesToken));
    expect(response.status).toBe(200); expect(response.text).toContain('PO');
  });
  it.each([{visible:[]},{visible:['O1']}])('受限主体不可操作无订单关联PO，范围=$visible', async ({visible}) => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(visible); const {app}=setup(null);
    expect((await request(app).post('/PO2/send').set(authHeader(salesToken)).send({})).status).toBe(404);
  });
  it.each(['quotes','select','close'])('隐藏询价%s不可操作', async action => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).post(`/inquiries/I2/${action}`).set(authHeader(salesToken)).send({})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('隐藏询价详情、编辑、删除和报价编辑均拒绝', async () => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).get('/inquiries/I2').set(authHeader(salesToken))).status).toBe(404);
    expect((await request(app).put('/inquiries/I2').set(authHeader(salesToken)).send({orderId:'O1'})).status).toBe(404);
    expect((await request(app).delete('/inquiries/I2').set(authHeader(salesToken))).status).toBe(404);
    expect((await request(app).put('/inquiries/I2/quotes/Q2').set(authHeader(salesToken)).send({})).status).toBe(404);
    expect((await request(app).delete('/inquiries/I2/quotes/Q2').set(authHeader(salesToken))).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('询价创建和改来源校验目标订单及BOM',async()=>{
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup('O1');
    expect((await request(app).post('/inquiries').set(authHeader(salesToken)).send({orderId:'O2'})).status).toBe(404);
    expect((await request(app).put('/inquiries/I1').set(authHeader(salesToken)).send({orderId:'O2'})).status).toBe(404);
    expect((await request(app).put('/inquiries/I1').set(authHeader(salesToken)).send({bomId:'B2'})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('询价列表findMany/count分页前保留可见订单过滤',async()=>{
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).get('/inquiries?search=test').set(authHeader(salesToken))).status).toBe(200);
    const where=prisma.supplierInquiry.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined(); expect(JSON.stringify(where.AND)).toContain('O1');
    expect(prisma.supplierInquiry.count.mock.calls[0][0].where).toEqual(where);
  });
  it.each(['mark-shipped','confirm','settle','cancel'])('隐藏退换货%s不可操作库存/应付', async action => {
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).post(`/material-returns/R/${action}`).set(authHeader(salesToken)).send({})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('不能从隐藏来料单新建退换货',async()=>{
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).post('/material-returns').set(authHeader(salesToken)).send({receiptId:'RC'})).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('退换货列表在分页前按可见采购单过滤',async()=>{
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']); const {app,prisma}=setup();
    expect((await request(app).get('/material-returns?purchaseOrderId=PO2').set(authHeader(salesToken))).status).toBe(200);
    expect(prisma.purchaseOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{deletedAt:null,orderId:{in:['O1']}}}));
    expect(prisma.materialReturn.findMany.mock.calls[0][0].where).toMatchObject({purchaseOrderId:'PO2',AND:[{purchaseOrderId:{in:[]}}]});
  });
});

describe('procurement demand release endpoint authorization', () => {
  it('requires procurement write permission before touching demand data', async()=>{
    const read=vi.fn();const prisma:any={procurementDemand:{findUnique:read}};
    const app=makeApp(createProcurementRouter({prisma,requireAuth:false,apiKeys:new Set()}));
    const token=jwt.sign({userId:'u_without_write',roles:[]},JWT_SECRET);
    const res=await request(app).post('/demands/D1/release').set(authHeader(token)).send({revision:1,reason:'误领'});
    expect(res.status).toBe(403);expect(read).not.toHaveBeenCalled();
  });
  it('rechecks visible source and hides inaccessible demand even from another valid buyer',async()=>{
    visibilityMock.resolveVisibleOrderIds.mockResolvedValue(['O1']);
    const tx:any={procurementDemand:{findUnique:vi.fn(async()=>({id:'D1',orderId:'O2',assigneeId:'u_sales',revision:1,status:'Ready'})),update:vi.fn()}};
    const prisma:any={...tx,$transaction:vi.fn(async(fn:any)=>fn(tx))};
    const app=makeApp(createProcurementRouter({prisma,requireAuth:false,apiKeys:new Set()}));
    const res=await request(app).post('/demands/D1/release').set(authHeader(salesToken)).send({revision:1,reason:'误领'});
    expect(res.status).toBe(404);expect(tx.procurementDemand.update).not.toHaveBeenCalled();
  });
});
