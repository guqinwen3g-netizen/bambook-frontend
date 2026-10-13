import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';
import { buildQuotationApprovalSnapshot, ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE } from '../quotationApprovalSnapshot';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createQuotationRouter } from '../quotationRoute';
import { businessEventBus } from '../../events/businessEventBus';
import { ownerToken } from '../../__tests__/authTestHelper';
import { logger } from '../../lib/logger';

// JWT mock for auth-guard 契约测试（与 auth/service.ts 默认 secret 对齐）
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const userToken = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, JWT_SECRET);

/**
 * task ERP-P2-quotation-route-contract:
 * 覆盖 /api/v1/quotations 路由的 HTTP 契约：
 *   - 输入校验（400）
 *   - 唯一性校验（409）
 *   - 状态转换错误码映射（404 不存在 / 409 非法转换）
 *   - onDataChange 在事务后触发
 *   - 事件发布（QuotationIssued / QuotationAccepted）
 */

const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── Mock 信用域（convert-to-order 信用门禁契约：409 + actual CREDIT blockCode）──
const creditMocks = vi.hoisted(() => ({
  checkCreditAvailable: vi.fn(),
  resolveCreditException: vi.fn(),
}));
vi.mock('../../credit/creditService', () => ({
  createCreditService: vi.fn(() => ({ checkCreditAvailable: creditMocks.checkCreditAvailable })),
}));
vi.mock('../../credit/creditExceptionGate', () => ({
  createCreditExceptionService: vi.fn(() => ({})),
  resolveCreditException: creditMocks.resolveCreditException,
  consumeCreditException: vi.fn(),
}));

// Synthetic storage supplies actual schema-required fields; original amounts/statuses are kept.
function persistedQuotation(row:any) {
  if (!row) return null;
  return {version:1,currency:'USD',totalAmount:0,issueDate:'2026-10-01',notes:null,...row,
    lines:(row.lines??[]).map((line:any,index:number)=>({id:'fixture-line-'+(index+1),lineNumber:index+1,...line}))};
}
function makeApp(opts: {
  existing?: any;
  existingByNumber?: any;
  auditFail?: boolean;
  createFail?: boolean;
  updateFail?: boolean;
  onDataChange?: any;
  requireAuth?: boolean;
  apiKeys?: Set<string>;
  uploadDir?: string;
} = {}) {
  const existing = persistedQuotation(opts.existing);
  const existingByNumber = opts.existingByNumber ?? null;

  const quotationCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_BOOM'))
    : vi.fn().mockImplementation(async ({ data }: any) => {
        const { createdAt, updatedAt, lines, ...rest } = data;
        const createdLines = lines?.create?.map((l: any, i: number) => ({
          ...l,
          lineNumber: i + 1,
          amount: Math.round(l.quantity * l.unitPrice * 10000) / 10000,
        })) ?? [];
        return { ...rest, createdAt, updatedAt, lines: createdLines };
      });

  const quotationUpdate = opts.updateFail
    ? vi.fn().mockRejectedValue(new Error('UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data, include }: any) => {
        const { updatedAt, deletedAt, status, ...rest } = data;
        return {
          ...existing,
          ...rest,
          status: status ?? existing?.status ?? 'Draft',
          id: where.id,
          updatedAt: updatedAt ?? Date.now(),
          lines: existing?.lines ?? [],
        };
      });

  // route 层用 prisma.quotation.findUnique 检查报价号唯一性
  // service 层用 prisma.quotation.findUnique 检查报价单存在性
  const quotationFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (where.id !== undefined) {
      if (where.id === existing?.id) return existing;
      return null;
    }
    if (where.quotationNumber !== undefined) {
      if (where.quotationNumber === existingByNumber?.quotationNumber) return existingByNumber;
      return null;
    }
    return null;
  });

  const quotationLineDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const quotationLineCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });

  const tx: any = {
    productionStage:{upsert:vi.fn(async({create}:any)=>create)},
    // REQ2-12 占用追平：nextBusinessNumber occupied 回调查 quotation.findFirst（含软删）——默认无占用
    $queryRaw:vi.fn().mockResolvedValue([]),
    moqThresholdConfig:{findFirst:vi.fn(async()=>({id:'actual-moq-fixture',fabricDefaultMoq:800,garmentDefaultMoq:200,capsuleMoq:20}))},
    quotation: { create: quotationCreate, findUnique:quotationFindUnique, update: quotationUpdate, findFirst: vi.fn().mockResolvedValue(null) },
    quotationLine: { deleteMany: quotationLineDeleteMany, createMany: quotationLineCreateMany },
    auditLog: { create: auditCreate },
    // EntityLink 图谱（D1.1a）：sync/deactivate 走 tx 内 upsert/findMany/update
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    // BusinessSequence mock（统一编号服务依赖）
    businessSequence: {
      upsert: vi.fn().mockImplementation(async ({ where, create }: any) => ({ ...create, seq: 0 })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ seq: 1 })),
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma: any = {
    quotation: {
      findUnique: quotationFindUnique,
      // Object authorization now reads the persisted source before invoking
      // lifecycle services. These business probes use the recorded owner role;
      // cross-customer authorization is exercised by quotationObjectAccessHttp.
      findFirst: vi.fn(async ({ where }: any) => {
        const parts = where?.AND ?? [where];
        const id = parts.find((part: any) => part?.id)?.id;
        return id && id === existing?.id && existing.deletedAt == null ? existing : null;
      }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: quotationUpdate, // expireQuotation 不用事务
    },
    // §9.2 价格规则 ①②④ 评估依赖（默认空 → 仅 ② relationUnbound 命中路径，requester 不可解析则不建审批单）
    // P2 行级：buildQuotationListScopeWhere 消费 relation.findMany（跟进人）+ teamMember（组共享）——空结果=零授权
    relation: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Conversion's live MOQ resolver reads the customer tier from the root client.
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
    teamMember: { findMany: vi.fn().mockResolvedValue([]) },
    order: { count: vi.fn().mockResolvedValue(0) },
    fabricPriceHistory: { findMany: vi.fn().mockResolvedValue([]) },
    productAsset: { findMany: vi.fn().mockResolvedValue([]) },
    userAccount: { findFirst: vi.fn().mockResolvedValue(null) },
    // 报价审批层级门禁 + 价格门禁依赖（2026-09）：默认无 pending / 无审批，发送用例放行
    approvalRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  const auth = fabricAuthorizationFixture(opts.requireAuth ? 'u_sales' : 'u_owner');
  const storedAuthUser = async ({ where }: any) => {
    const user = await fabricAuthorizationFixture(where.id).userAccount.findFirst();
    if (where.id !== 'u_owner') user.roles[0].role.id = 'role-sales';
    user.roles[0].role.permissions.push({ permission: { scope: 'quotations:read' } }, { permission: { scope: 'quotations:write' } });
    return user;
  };
  Object.assign(prisma,{userAccount:opts.requireAuth?{findFirst:vi.fn(storedAuthUser),findUnique:vi.fn(storedAuthUser)}:auth.userAccount,userPermissionOverrides:auth.userPermissionOverrides});
  Object.assign(tx,{userAccount:auth.userAccount,userPermissionOverrides:auth.userPermissionOverrides,relation:auth.relation,agentJob:{create:vi.fn().mockResolvedValue({})}});
  if(!opts.requireAuth) prisma.relation.findFirst=auth.relation.findFirst;
  tx.approvalRequest=prisma.approvalRequest;
  tx.auditLog.findMany=vi.fn().mockResolvedValue([]);
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  // W-C 批三-E：写端点已挂 quotations:write scope 门（requirePermission 需 JWT actor）。
  // 业务契约用例（requireAuth=false）统一注入 owner JWT（SuperAdmin 全放行），保持
  // 「测业务、不测门禁」语义；门禁契约用例（requireAuth=true）不注入，自行控制凭证。
  if (!opts.requireAuth) {
    app.use((req, _res, next) => {
      if (!req.headers.authorization && !req.headers.cookie) {
        req.headers.authorization = `Bearer ${ownerToken}`;
      }
      next();
    });
  }
  app.use('/api/v1/quotations', createQuotationRouter({
    prisma,
    requireAuth: opts.requireAuth ?? false,
    apiKeys: opts.apiKeys ?? new Set<string>(),
    onDataChange,
    uploadDir: opts.uploadDir,
  }));

  return { app, prisma, tx, quotationCreate, quotationUpdate, quotationFindUnique, auditCreate, onDataChange };
}

const validInput = {
  quotationNumber: 'QT-20260806-001',
  currency: 'USD',
  issueDate: '2026-08-06',
  customerName: 'ACME Corp',
  lines: [
    { description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5 },
  ],
};

// MOQ 门禁适配：合法 writeOnce 快照（阈值 50，现有成功用例数量 100 ≥ 50 → 合规放行）
const VALID_MOQ_SNAPSHOT = {
  fabricDefaultMoq: 50,
  garmentDefaultMoq: 50,
  capsuleMoq: 10,
  snapshotAt: '2026-08-01T00:00:00.000Z',
  configId: 'MOQCFG__test',
  source: 'moq_config',
};

describe('quotationRoute: POST / (create)', () => {
  beforeEach(() => publishSpy.mockClear());

  it('成功创建 → 201 + onDataChange 触发', async () => {
    const { app, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send(validInput);

    expect(res.status).toBe(201);
    expect(res.body.quotation.quotationNumber).toBe('QT-20260806-001');
    expect(res.body.quotation.status).toBe('Draft');
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'Quotation',
      action: 'create',
    }));
  });

  it('缺少 quotationNumber → 自动生成（服务端编号服务）', async () => {
    const { app, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({ ...validInput, quotationNumber: '' });
    // quotationNumber 为空时服务端自动生成，不再返回 400
    expect(res.status).toBe(201);
    expect(res.body.quotation.quotationNumber).toMatch(/^QT-\d{4}-\d{4}$/);
    expect(onDataChange).toHaveBeenCalled();
  });

  it('缺少 currency → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({ ...validInput, currency: '' });
    expect(res.status).toBe(400);
  });

  it('缺少 issueDate → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({ ...validInput, issueDate: '' });
    expect(res.status).toBe(400);
  });

  it('空 lines → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({ ...validInput, lines: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/至少需要一行/);
  });

  it('行缺少 description → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({
      ...validInput,
      lines: [{ quantity: 10, unit: 'YD', unitPrice: 5 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/);
  });

  it('行缺少 unit → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/quotations').send({
      ...validInput,
      lines: [{ description: 'x', quantity: 10, unitPrice: 5 }],
    });
    expect(res.status).toBe(400);
  });

  it('报价号已存在 → 409', async () => {
    const { app, onDataChange } = makeApp({
      existingByNumber: { quotationNumber: 'QT-20260806-001', id: 'QT_EXISTING' },
    });
    const res = await request(app).post('/api/v1/quotations').send(validInput);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/已存在/);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500（事务回滚，不伪成功），onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/quotations').send(validInput);
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('create reject（DB 错误）→ 500，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ createFail: true });
    const res = await request(app).post('/api/v1/quotations').send(validInput);
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('quotationRoute: auth-guard 契约（requireAuth=true）', () => {
  it('无 JWT / API-Key → POST / 401', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app).post('/api/v1/quotations').send(validInput);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('API-Key 读操作 → 通过', async () => {
    const { app } = makeApp({ requireAuth: true, apiKeys: new Set(['ak-test']) });
    const res = await request(app)
      .get('/api/v1/quotations')
      .set('X-Bambook-API-Key', 'ak-test');
    expect(res.status).toBe(200);
  });
  it('API-Key 写操作 → 401（API key insufficient）', async () => {
    const { app } = makeApp({ requireAuth: true, apiKeys: new Set(['ak-test']) });
    const res = await request(app)
      .post('/api/v1/quotations')
      .set('X-Bambook-API-Key', 'ak-test')
      .send(validInput);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toMatch(/API key insufficient/);
  });

  it('Bearer JWT 写操作 → 通过', async () => {
    const { app, onDataChange } = makeApp({ requireAuth: true });
    const res = await request(app)
      .post('/api/v1/quotations')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validInput);
    expect(res.status).toBe(201);
    expect(onDataChange).toHaveBeenCalled();
  });
});

// R678：读端点 quotations:read scope 门（S3-γ CRM 同惯例——JWT 用户必须持 scope；
// viewer legacy 角色映射空角色集 → 无 quotations:read → 403；API-Key 通道不受影响）
describe('quotationRoute: 读端点 quotations:read scope 门（requireAuth=true）', () => {
  const viewerToken = jwt.sign({ userId: 'u_viewer', roles: ['viewer'] }, JWT_SECRET);

  it('JWT 无 quotations:read → GET / 403 INSUFFICIENT_SCOPE', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app)
      .get('/api/v1/quotations')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toMatch(/quotations:read/);
  });

  it('JWT 持 quotations:read（sales）→ GET / 200', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app)
      .get('/api/v1/quotations')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
  });

  it('JWT 无 quotations:read → GET /:id 403', async () => {
    const { app } = makeApp({
      requireAuth: true,
      existing: { id: 'QT_1', quotationNumber: 'QT-001', status: 'Draft', deletedAt: null, lines: [] },
    });
    const res = await request(app)
      .get('/api/v1/quotations/QT_1')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('JWT 无 quotations:read → GET /price-profile 403', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app)
      .get('/api/v1/quotations/price-profile?relationId=REL_1')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('JWT 无 quotations:read → GET /:id/versions 403', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app)
      .get('/api/v1/quotations/QT_1/versions')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('JWT 无 quotations:read → GET /:id/preview.html 403', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app)
      .get('/api/v1/quotations/QT_1/preview.html')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});

// P0-3 报价行图片下载端点 scope 门（GET /line-image/:filename）：
// /api/uploads/quotations 静态子树已 fail-closed 404，图片读取收敛到本端点（quotations:read 门
// + basename/isInsideDir 防穿越）。覆盖：未登录 401 / 无 scope 403 / 持 scope 200 / 目录穿越 404 / 不存在 404。
describe('quotationRoute: 行图下载端点 quotations:read scope 门（requireAuth=true）', () => {
  const viewerToken = jwt.sign({ userId: 'u_viewer', roles: ['viewer'] }, JWT_SECRET);
  let tmpUploadRoot: string;

  beforeEach(() => {
    tmpUploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-qt-img-'));
    fs.mkdirSync(path.join(tmpUploadRoot, 'quotations'), { recursive: true });
    fs.writeFileSync(path.join(tmpUploadRoot, 'quotations', 'qt-fake.jpg'), 'FAKE-JPEG');
  });

  afterEach(() => {
    fs.rmSync(tmpUploadRoot, { recursive: true, force: true });
  });

  function imgApp() {
    return makeApp({ requireAuth: true, uploadDir: tmpUploadRoot }).app;
  }

  it('未登录 → 401（静态直读已 fail-closed，统一走 scoped 端点）', async () => {
    const res = await request(imgApp()).get('/api/v1/quotations/line-image/qt-fake.jpg');
    expect(res.status).toBe(401);
  });

  it('JWT 无 quotations:read（viewer）→ 403 INSUFFICIENT_SCOPE', async () => {
    const res = await request(imgApp())
      .get('/api/v1/quotations/line-image/qt-fake.jpg')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/quotations:read/);
  });

  it('JWT 持 quotations:read（sales）→ 200 图片内容', async () => {
    const res = await request(imgApp())
      .get('/api/v1/quotations/line-image/qt-fake.jpg')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe('FAKE-JPEG');
  });

  it('目录穿越 filename → 404（不读子树外文件）', async () => {
    fs.writeFileSync(path.join(tmpUploadRoot, 'sibling-secret.txt'), 'SECRET');
    const res = await request(imgApp())
      .get('/api/v1/quotations/line-image/..%2Fsibling-secret.txt')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it('文件不存在 → 404', async () => {
    const res = await request(imgApp())
      .get('/api/v1/quotations/line-image/nope.jpg')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: GET / (list)', () => {
  it('返回 { items, total }', async () => {
    const { app, prisma } = makeApp();
    prisma.quotation.findMany.mockResolvedValue([{ id: 'QT_1' }, { id: 'QT_2' }]);
    prisma.quotation.count.mockResolvedValue(2);

    const res = await request(app).get('/api/v1/quotations');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('status 过滤透传给 service', async () => {
    const { app, prisma } = makeApp();
    prisma.quotation.findMany.mockResolvedValue([]);
    prisma.quotation.count.mockResolvedValue(0);

    await request(app).get('/api/v1/quotations?status=Sent');

    expect(prisma.quotation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'Sent' }),
    }));
  });
});

// P2 审计补缺（2026-09-03）：quotations 列表行级数据范围。
// 口径与 orders 列表完全一致（buildQuotationListScopeWhere → getDataScopeResolver('quotations')
// + resolveVisibleRelationIds）：owner/admin/财务等 rule=all → 不过滤；sales → 跟进客户 ∪ 组共享。
describe('P2 · quotations 列表行级数据范围（requireAuth=true）', () => {
  const salesTokenP2 = jwt.sign({ userId: 'u_sales', roles: ['sales'] }, JWT_SECRET);

  it('owner（SuperAdmin all）GET / → findMany 不携带行级 scopeWhere（全量）', async () => {
    const { app, prisma } = makeApp({ requireAuth: true });
    await request(app).get('/api/v1/quotations').set('Authorization', `Bearer ${ownerToken}`);
    const call = (prisma.quotation.findMany as any).mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });

  it('sales GET / → findMany 携带行级 scopeWhere（customerRelationId ∈ 可见客户）', async () => {
    const { app, prisma } = makeApp({ requireAuth: true });
    (prisma.relation.findMany as any).mockResolvedValue([{ id: 'REL_MINE' }]);
    await request(app).get('/api/v1/quotations').set('Authorization', `Bearer ${salesTokenP2}`);
    const call = (prisma.quotation.findMany as any).mock.calls[0][0];
    expect(call.where.AND).toEqual([
      { OR: [
        { customerRelationId: { in: ['REL_MINE'] } },
        { AND: [{ customerRelationId: null }, { ownerId: 'u_sales' }] },
      ] },
    ]);
  });

  it('sales GET / 不注入 JWT → 401（requireQuotationRead 认证前置）', async () => {
    const { app } = makeApp({ requireAuth: true });
    const res = await request(app).get('/api/v1/quotations');
    expect(res.status).toBe(401);
  });
});

describe('quotationRoute: GET /:id (detail)', () => {
  it('存在 → 200 + quotation', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', quotationNumber: 'QT-001', status: 'Draft', deletedAt: null, lines: [] },
    });
    const res = await request(app).get('/api/v1/quotations/QT_1');
    expect(res.status).toBe(200);
    expect(res.body.quotation.id).toBe('QT_1');
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).get('/api/v1/quotations/NOPE');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: PUT /:id (update)', () => {
  it('Draft → 成功更新', async () => {
    const { app, onDataChange } = makeApp({
      existing: { id: 'QT_1', status: 'Draft', deletedAt: null, lines: [], quotationNumber: 'QT-001' },
    });
    const res = await request(app).put('/api/v1/quotations/QT_1').send({ notes: 'updated' });
    expect(res.status).toBe(200);
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
  });

  it('非 Draft → 409', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', status: 'Sent', deletedAt: null, lines: [] },
    });
    const res = await request(app).put('/api/v1/quotations/QT_1').send({ notes: 'x' });
    expect(res.status).toBe(409);
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).put('/api/v1/quotations/NOPE').send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: DELETE /:id (soft delete)', () => {
  it('Draft → 200 + ok', async () => {
    const { app, onDataChange } = makeApp({
      existing: { id: 'QT_1', status: 'Draft', deletedAt: null, quotationNumber: 'QT-001' },
    });
    const res = await request(app).delete('/api/v1/quotations/QT_1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }));
  });

  it('非 Draft → 409', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', status: 'Sent', deletedAt: null },
    });
    const res = await request(app).delete('/api/v1/quotations/QT_1');
    expect(res.status).toBe(409);
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).delete('/api/v1/quotations/NOPE');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: POST /:id/send (Draft → Sent)', () => {
  beforeEach(() => publishSpy.mockClear());

  it('Draft → Sent 成功 → 200 + onDataChange + QuotationIssued 事件', async () => {
    const { app, onDataChange } = makeApp({
      existing: {
        id: 'QT_1',
        status: 'Draft',
        deletedAt: null,
        quotationNumber: 'QT-001',
        customerName: 'ACME',
        totalAmount: 550,
        currency: 'USD',
        moqSnapshot: VALID_MOQ_SNAPSHOT, // MOQ 门禁：100 ≥ 50 → 合规放行
        lines: [{ id: 'L1', description: 'x', quantity: 100, unit: 'YD', unitPrice: 5.5, amount:550 }],
      },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/send');

    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('Sent');
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'send' }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0].type).toBe('QuotationIssued');
  });

  it('Sent → 非法转换 → 409', async () => {
    const { app, onDataChange } = makeApp({
      existing: { id: 'QT_1', status: 'Sent', deletedAt: null, lines: [] },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/send');
    expect(res.status).toBe(409);
    expect(onDataChange).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).post('/api/v1/quotations/NOPE/send');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: POST /:id/accept (Sent → Accepted)', () => {
  beforeEach(() => publishSpy.mockClear());

  it('Sent → Accepted 成功 → 200 + QuotationAccepted 事件', async () => {
    const { app, onDataChange } = makeApp({
      existing: {
        id: 'QT_1',
        status: 'Sent',
        deletedAt: null,
        quotationNumber: 'QT-001',
        customerName: 'ACME',
        totalAmount: 550,
        currency: 'USD',
        lines: [{ id: 'L1', description: 'x', quantity: 100, unit: 'YD', unitPrice: 5.5, amount:550 }],
      },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/accept').send({ note: '客户确认' });

    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('Accepted');
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept' }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0][0].type).toBe('QuotationAccepted');
  });

  it('Draft → 非法转换 → 409', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', status: 'Draft', deletedAt: null, lines: [] },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/accept');
    expect(res.status).toBe(409);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).post('/api/v1/quotations/NOPE/accept');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: POST /:id/reject (Sent → Rejected)', () => {
  beforeEach(() => publishSpy.mockClear());

  it('Sent → Rejected 成功 → 200', async () => {
    const { app, onDataChange } = makeApp({
      existing: { id: 'QT_1', status: 'Sent', deletedAt: null, quotationNumber: 'QT-001' },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/reject').send({ note: '价格过高' });

    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('Rejected');
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'reject' }));
    // reject 不发布业务事件
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('Draft → 非法转换 → 409', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', status: 'Draft', deletedAt: null },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/reject');
    expect(res.status).toBe(409);
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).post('/api/v1/quotations/NOPE/reject');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: POST /:id/expire', () => {
  it('Draft → Expired 成功 → 200', async () => {
    const { app, onDataChange } = makeApp({
      existing: { id: 'QT_1', status: 'Draft', deletedAt: null },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/expire');
    expect(res.status).toBe(200);
    expect(res.body.quotation.status).toBe('Expired');
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'expire' }));
  });

  it('Accepted 终态 → 400（不可标记过期）', async () => {
    const { app } = makeApp({
      existing: { id: 'QT_1', status: 'Accepted', deletedAt: null },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/expire');
    expect(res.status).toBe(400);
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ existing: null });
    const res = await request(app).post('/api/v1/quotations/NOPE/expire');
    expect(res.status).toBe(404);
  });
});

describe('quotationRoute: POST /:id/convert-to-order', () => {
  beforeEach(() => {
    publishSpy.mockClear();
    // 信用门禁默认放行；阻断契约用例各自覆写
    creditMocks.checkCreditAvailable.mockReset();
    creditMocks.checkCreditAvailable.mockResolvedValue({ ok: true, data: { blocked: false, blockCode: null, blockReason: null } });
    creditMocks.resolveCreditException.mockReset();
    creditMocks.resolveCreditException.mockResolvedValue({ passed: false, hint: '审批中' });
  });

  it('Accepted → 201 + orderId + quotation.convertedOrderId + 双 onDataChange', async () => {
    const { app, tx, onDataChange } = makeAppWithConvert({
      existing: {
        id: 'QT_1',
        quotationNumber: 'QT-001',
        status: 'Accepted',
        deletedAt: null,
        convertedOrderId: null,
        customerName: 'ACME',
        currency: 'USD',
        baseCurrency: 'CNY',
        totalAmount: 550,
        validUntil: '2026-09-30',
        moqSnapshot: VALID_MOQ_SNAPSHOT, // MOQ 转换门禁：100 ≥ 50 → 合规放行
        lines: [{ id: 'L1', fabricCode: 'FAB-A', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5, amount: 550 }],
      },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});

    expect(res.status).toBe(201);
    expect(res.body.orderId).toMatch(/^ORD-QT-/);
    expect(res.body.quotation.convertedOrderId).toBe(res.body.orderId);
    // 旧报价无定价记录（Mock count=0）也可转单；限定源报价和未挂单的有效记录。
    expect(tx.pricingCalculation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.pricingCalculation.updateMany).toHaveBeenCalledWith({
      where: { quotationId: 'QT_1', deletedAt: null, orderId: null },
      data: { orderId: res.body.orderId },
    });

    // 双 onDataChange：Quotation + orders
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ entity: 'Quotation', action: 'convert' }));
    expect(onDataChange).toHaveBeenCalledWith(expect.objectContaining({ entity: 'orders', action: 'create' }));
  });

  it('支持 overrides（poNumber / millName）', async () => {
    const { app, tx } = makeAppWithConvert({
      existing: {
        id: 'QT_1',
        quotationNumber: 'QT-001',
        status: 'Accepted',
        deletedAt: null,
        convertedOrderId: null,
        customerName: 'ACME',
        currency: 'USD',
        baseCurrency: 'CNY',
        totalAmount: 100,
        moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 }, // MOQ 门禁：10 ≥ 10 → 合规放行
        // Same-unit comparison is intentional here: the writeOnce MOQ is 10 M.
        lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
      },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({
      poNumber: 'PO-CUSTOM',
      millName: 'Mill A',
    });

    expect(res.status).toBe(201);
    const orderData = tx.order.create.mock.calls[0][0].data;
    expect(orderData.poNumber).toBe('PO-CUSTOM');
    expect(orderData.millName).toBe('Mill A');
  });

  it('非 Accepted → 409', async () => {
    const { app, onDataChange } = makeAppWithConvert({
      existing: { id: 'QT_1', status: 'Sent', deletedAt: null, convertedOrderId: null, lines: [] },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order');
    expect(res.status).toBe(409);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('已转换 → 409', async () => {
    const { app } = makeAppWithConvert({
      existing: { id: 'QT_1', status: 'Accepted', deletedAt: null, convertedOrderId: 'ORD-QT-EXISTING', lines: [] },
    });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/已转为/);
  });

  it('不存在 → 404', async () => {
    const { app } = makeAppWithConvert({ existing: null });
    const res = await request(app).post('/api/v1/quotations/NOPE/convert-to-order');
    expect(res.status).toBe(404);
  });

  it('信用门禁阻断 → 409 + code=CREDIT_FROZEN_60_DAYS 并保留实际 blockCode', async () => {
    const { app, tx } = makeAppWithConvert({
      existing: {
        id: 'QT_1',
        quotationNumber: 'QT-001',
        status: 'Accepted',
        deletedAt: null,
        convertedOrderId: null,
        customerName: 'ACME',
        customerRelationId: 'REL_FROZEN',
        currency: 'USD',
        totalAmount: 100,
        moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
        lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
      },
    });
    creditMocks.checkCreditAvailable.mockResolvedValue({
      ok: true,
      data: { blocked: true, blockCode: 'CREDIT_FROZEN_60_DAYS', blockReason: '该客户信用额度已冻结（存在 ≥60 天逾期或人工冻结），请财务解冻后再下单' },
    });
    creditMocks.resolveCreditException.mockResolvedValue({ passed: false, hint: '信用例外申请已发起、审批中' });

    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(res.body.blockCode).toBe('CREDIT_FROZEN_60_DAYS');
    expect(res.body.error).toContain('冻结');
    expect(res.body.error).toContain('信用额度已冻结');
    // 阻断即不建单
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it.each<[string, Error]>([
    ['TypeError containing old business keywords', new TypeError('INTERNAL_ONLY: private/pricing 不存在，已转为')],
    ['unknown Error', new Error('INTERNAL_ONLY: private/table/path/column')],
    ['Prisma error', Object.assign(new Error('INTERNAL_ONLY: private audit actor'), { code: 'P2003' })],
  ])('%s → safe 500; original details stay in server logs and no conversion occurs', async (_label, failure) => {
    const { app, prisma, tx, onDataChange } = makeAppWithConvert();
    prisma.quotation.findUnique.mockRejectedValueOnce(failure);
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('AUTHORIZATION_UNAVAILABLE');
      expect(typeof res.body.error).toBe('string');
      expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ONLY');
      expect(log).toHaveBeenCalledWith('[ConversionAuthority] storage read failed', { error: failure.message });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(onDataChange).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('订单事务中的未知写入异常 → safe 500且不发成功通知（存储替身不证明PG回滚）', async () => {
    const { app, tx, onDataChange } = makeAppWithConvert({ existing: {
      id: 'QT_1', quotationNumber: 'QT-001', status: 'Accepted', deletedAt: null,
      convertedOrderId: null, currency: 'USD', totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    } });
    tx.pricingCalculation.updateMany.mockRejectedValueOnce(new Error('INTERNAL_ONLY: private pricing write'));
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL_ONLY');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('已知MOQ业务拒绝仍400；不把无豁免当内部异常', async () => {
    const { app, tx } = makeAppWithConvert({ existing: {
      id: 'QT_1', quotationNumber: 'QT-001', status: 'Accepted', deletedAt: null,
      convertedOrderId: null, currency: 'USD', totalAmount: 100,
      moqSnapshot: VALID_MOQ_SNAPSHOT,
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'YD', unitPrice: 10, amount: 100 }],
    } });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('且无有效 MOQ 豁免审批');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('已知待审批业务拒绝仍400；审批读取内部错误另返回safe 500', async () => {
    const accepted = {
      id: 'QT_1', quotationNumber: 'QT-001', status: 'Accepted', deletedAt: null,
      convertedOrderId: null, currency: 'USD', totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    };
    const pending = makeAppWithConvert({ existing: accepted });
    pending.prisma.approvalRequest.findMany.mockResolvedValueOnce([{id:'APP-pending',actionType:ACTION_TOTAL_APPROVE,targetType:'Quotation',targetId:'QT_1',status:'pending',
      payload:{quotationId:'QT_1',...buildQuotationApprovalSnapshot(persistedQuotation(accepted),ACTION_TOTAL_APPROVE,'QT_1')}}]);
    const denied = await request(pending.app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain('需审批通过后方可转换订单');
    expect(pending.tx.order.create).not.toHaveBeenCalled();

    const broken = makeAppWithConvert({ existing: accepted });
    broken.prisma.approvalRequest.findMany.mockRejectedValueOnce(new Error('INTERNAL_ONLY: private approvals table'));
    const failed = await request(broken.app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('INTERNAL_ONLY');
    expect(broken.tx.order.create).not.toHaveBeenCalled();
  });

  it('当前报价负责人不存在时给真实来源409并且不认领/建单',async()=>{
    const {app,tx,quotationClaim}=makeAppWithConvert({existing:{id:'QT_1',quotationNumber:'QT-001',status:'Accepted',deletedAt:null,convertedOrderId:null,ownerId:'missing-source-owner',currency:'USD',totalAmount:100,moqSnapshot:{...VALID_MOQ_SNAPSHOT,fabricDefaultMoq:10},lines:[{id:'L1',description:'x',quantity:10,unit:'M',unitPrice:10,amount:100}]}});
    tx.userAccount.findFirst.mockImplementation(async({where}:any)=>where.id==='missing-source-owner'?null:await fabricAuthorizationFixture(where.id).userAccount.findFirst());
    const res=await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(res.status).toBe(409);expect(res.body.code).toBe('SOURCE_CHANGED');expect(res.body.error).toContain('报价负责人不存在或已停用');
    expect(quotationClaim).not.toHaveBeenCalled();expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('事务认领失败的既有重复转换仍409', async () => {
    const { app, tx, quotationClaim } = makeAppWithConvert({ existing: {
      id: 'QT_1', quotationNumber: 'QT-001', status: 'Accepted', deletedAt: null,
      convertedOrderId: null, currency: 'USD', totalAmount: 100,
      moqSnapshot: { ...VALID_MOQ_SNAPSHOT, fabricDefaultMoq: 10 },
      lines: [{ id: 'L1', description: 'x', quantity: 10, unit: 'M', unitPrice: 10, amount: 100 }],
    } });
    quotationClaim.mockResolvedValueOnce({ count: 0 });
    const res = await request(app).post('/api/v1/quotations/QT_1/convert-to-order').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('已转为订单');
    expect(tx.order.create).not.toHaveBeenCalled();
  });
});

// ── convert-to-order 需要额外的 order.create mock ──
function makeAppWithConvert(opts: { existing?: any; onDataChange?: any } = {}) {
  const base = makeApp(opts);
  // Current authorization remains the real helper's storage fixture.
  base.tx.userAccount.findFirst.mockImplementation(async({where}:any)=>({...await fabricAuthorizationFixture(where.id).userAccount.findFirst(),id:where.id}));
  base.tx.developmentCase={findFirst:vi.fn().mockImplementation(async({where}:any)=>({id:where.id,customerRelationId:opts.existing?.customerRelationId??null}))};
  const orderCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: data.id,
    ...data,
    lines: data.lines?.create ?? [],
  }));
  const quotationUpdate = vi.fn().mockImplementation(async ({ where, data, include }: any) => ({
    ...opts.existing,
    ...data,
    id: where.id,
    lines: persistedQuotation(opts.existing)?.lines ?? [],
  }));
  base.tx.order = { create: orderCreate };
  // 成本估算环在转单事务内延伸归属；现有 fixture 无 PricingCalculation，匹配 0 条。
  base.tx.pricingCalculation = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
  base.tx.quotation.update = quotationUpdate;
  // 原子认领 convertedOrderId（防 L9/手动并发双建单）：默认 count=1；tx.findUnique 读回认领结果
  const quotationClaim = vi.fn().mockResolvedValue({ count: 1 });
  const quotationTxFindUnique = vi.fn().mockImplementation(async ({ where }: any) => ({
    ...persistedQuotation(opts.existing),
    id: where.id,
    ...(quotationClaim.mock.calls.length
      ? { convertedOrderId: (quotationClaim.mock.calls[0][0] as any).data.convertedOrderId }
      : {}),
    lines: persistedQuotation(opts.existing)?.lines ?? [],
  }));
  base.tx.quotation.updateMany = quotationClaim;
  base.tx.quotation.findUnique = quotationTxFindUnique;
  base.prisma.$transaction = vi.fn(async (fn: any) => fn(base.tx));
  return { ...base, orderCreate, quotationUpdate, quotationClaim };
}
