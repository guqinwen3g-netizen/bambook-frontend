import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createOrderLinesRouter } from '../orderLinesRoute';

// Signed identity; current account/grants below are the actual write authority.
// Signed with the same default secret as auth/service.ts.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

function makeApp(opts: {
  order?: any;
  line?: any;
  existingLine?: any; // for duplicate itemNo check
  txFail?: boolean;
  syncFail?: boolean;
  auditFail?: boolean;
  /** ★ B14：让 deleteOrderLine 的关联计数查询本身失败（entityLink.count 抛错） */
  linkCountFail?: boolean;
  /** deleteOrderLine 看到的 active EntityLink 条数（默认 0 = 无关联） */
  linkCount?: number;
} = {}) {
  const order = opts.order === undefined ? {
    id: 'ORD__1', poNumber: 'PO-1', customer: 'TestCustomer', type: 'fabric', status: 'Pending', deletedAt: null, lines: [],
  } : opts.order;
  const line = opts.line === undefined ? {
    id: 'ORD__1__0010', orderId: 'ORD__1', lineNumber: 1, itemNo: '0010', materialCode: 'PROD-1', quantity: 100, fieldSources: {}, status: 'Pending',
  } : opts.line;
  const liveLines: any[] = line ? [line] : [];

  const lineCreate = vi.fn().mockImplementation(async ({ data }: any) => { const created = { ...data, quantity: Number(data.quantity) }; liveLines.push(created); return created; });
  const lineUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => { const updated = { ...line, ...data, id: where.id }; const index = liveLines.findIndex(row => row.id === where.id); if (index >= 0) liveLines[index] = updated; return updated; });
  const lineFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (where.id?.includes?.('UNKNOWN')) return null;
    if (where.orderId_itemNo) {
      // duplicate check: 只在 existingLine 匹配时返回，否则 null（不存在的 itemNo）
      return opts.existingLine && where.orderId_itemNo.itemNo === opts.existingLine.itemNo ? opts.existingLine : null;
    }
    return line;
  });
  const orderFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (where.id && where.id !== 'ORD__1') return null;
    if (where.poNumber && where.poNumber !== 'PO-1') return null;
    return order;
  });
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({});
  const entityRefUpsert = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});

  const lineFindMany = vi.fn().mockImplementation(async ({ select }: any) => select?.itemNo
    ? (opts.existingLine ? [{ itemNo: opts.existingLine.itemNo }] : [])
    : liveLines.map(row => ({ quantity: row.quantity, unit: row.unit })));
  // ── deleteOrderLine 走到的三张表：关联计数 / 硬删 / deactivateEntityLinks 的读写 ──
  // （`delete` 的返回按 where 惰性构造：本 harness 允许 `line: null`，构造期读 line.id 会炸）
  const lineDelete = vi.fn(async ({ where }: any) => { const index = liveLines.findIndex(row => row.id === where.id); if (index >= 0) liveLines.splice(index, 1); return { id: where.id }; });
  const entityLinkCount = opts.linkCountFail
    ? vi.fn().mockRejectedValue(new Error('Invalid `prisma.entityLink.count()` invocation: Unknown argument `deletedAt`'))
    : vi.fn().mockResolvedValue(opts.linkCount ?? 0);
  const entityLinkFindMany = vi.fn().mockResolvedValue(
    (opts.linkCount ?? 0) > 0 ? [{ id: 'LINK_L1' }] : [],
  );
  const entityLinkUpdate = vi.fn().mockResolvedValue({});
  const entityRefFindMany = vi.fn().mockResolvedValue([]);
  const entityRefUpdate = vi.fn().mockResolvedValue({});

  const account = { id: 'u1', status: 'active', deletedAt: null, roles: [{ roleId: 'role-super-admin', role: { id: 'role-super-admin', permissions: ['orders:write', 'orders:delete'].map(scope => ({ permission: { scope } })) } }], primaryDeptId: 'test-dept' };
  const tx = {
    userAccount: { findFirst: vi.fn().mockResolvedValue(account), findUnique: vi.fn().mockResolvedValue(account) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(async (query: any) => query.sql.includes('"OrderLine"') ? (line ? [{ id: line.id }] : []) : (order ? [{ id: order.id }] : [])),
    order: { findUnique: orderFindUnique, findUniqueOrThrow: vi.fn().mockResolvedValue(order), findFirst: vi.fn(async ({ where }: any) => order && order.deletedAt == null && (!where.id || where.id === order.id) ? order : null), update: vi.fn().mockResolvedValue({}) },
    orderLine: { findUnique: lineFindUnique, findMany: lineFindMany, create: lineCreate, update: lineUpdate, delete: lineDelete },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityRefUpsert, findMany: entityRefFindMany, update: entityRefUpdate },
    entityLink: { upsert: entityLinkUpsert, count: entityLinkCount, findMany: entityLinkFindMany, update: entityLinkUpdate },
    teamMember: { findMany: vi.fn().mockResolvedValue([]) },
    teamDataGrant: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    // PROD-* in the original route fixtures is not an exclusive product asset.
    // Resolve that through the real eligibility service, without mocking its gate.
    fabricCustomerCode: { findMany: vi.fn().mockResolvedValue([]) },
  };

  const prisma = {
    // Current account/grants are real loader inputs; old JWT/default role is not authority.
    userAccount: { findFirst: vi.fn().mockResolvedValue(account), findUnique: vi.fn().mockResolvedValue(account) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    teamMember: { findMany: vi.fn().mockResolvedValue([]) },
    teamDataGrant: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    order: { findUnique: vi.fn().mockResolvedValue(order), findFirst: vi.fn(async ({ where }: any) => order && order.deletedAt == null && (!where.poNumber || where.poNumber === order.poNumber) ? order : null) },
    orderLine: { findUnique: vi.fn().mockResolvedValue(line), findFirst: vi.fn(async ({ where }: any) => line && order && order.deletedAt == null && !where.id?.includes?.('UNKNOWN') ? line : null), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: opts.txFail ? vi.fn().mockRejectedValue(new Error('TX_BOOM')) : vi.fn(async (fn: any) => fn(tx)),
  } as any;

  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return {
    app, tx, prisma, onDataChange, lineCreate, lineUpdate, auditCreate, entityRefUpsert,
    lineDelete, entityLinkCount, entityLinkUpdate,
  };
}

describe('task ERP-P1 order-line-mutation: POST / create', () => {
  it('成功 → 200 + onDataChange + audit + sync + response 含 order/poNumber/customer（hydrate）', async () => {
    const { app, onDataChange, auditCreate, entityRefUpsert } = makeApp();
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', itemNo: '0020', materialCode: 'PROD-2', quantity: 50 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 前端 serializeOrderLine 读 line.order/poNumber/customer
    expect(res.body.line.order).toBeTruthy();
    expect(res.body.line.poNumber).toBe('PO-1');
    expect(res.body.line.customer).toBe('TestCustomer');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(entityRefUpsert).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('默认 itemNo 生成（existingLines=[] 不传 itemNo → 0010）+ audit after.itemNo 一致', async () => {
    const { app, auditCreate } = makeApp();
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', materialCode: 'PROD-3', quantity: 30 });
    expect(res.status).toBe(200);
    expect(res.body.line.itemNo).toBe('0010');
    expect(res.body.line.id).toBe('ORD__1__0010');
    const auditCall = (auditCreate as any).mock.calls[0][0];
    expect(auditCall.data.detail.after.itemNo).toBe('0010');
    expect(auditCall.data.detail.after.id).toBe('ORD__1__0010');
  });

  it('默认 itemNo 生成（existingLines=[0010] 不传 itemNo → 0020）', async () => {
    const { app } = makeApp({ existingLine: { itemNo: '0010' } });
    // existingLine 让 findMany 返回 [{itemNo:'0010'}]，nextItemNo → 0020
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', materialCode: 'PROD-3', quantity: 30 });
    expect(res.status).toBe(200);
    expect(res.body.line.itemNo).toBe('0020');
  });

  it('ORDER_NOT_FOUND（parent order 不存在）→ 404', async () => {
    const { app } = makeApp({ order: null });
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-MISSING', itemNo: '0010', quantity: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('parent order deletedAt → 404', async () => {
    const { app } = makeApp({ order: { id: 'ORD__1', poNumber: 'PO-1', type: 'fabric', deletedAt: 1000, lines: [] } });
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', itemNo: '0010', quantity: 10 });
    expect(res.status).toBe(404);
  });

  it('DUPLICATE_ITEM_NO → 409', async () => {
    const { app } = makeApp({ existingLine: { itemNo: '0010' } });
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', itemNo: '0010', quantity: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_ITEM_NO');
  });

  it('sync reject → CREATE_LINE_FAILED（事务回滚，fail closed）', async () => {
    const { app, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', itemNo: '0020', materialCode: 'PROD-2', quantity: 10 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_LINE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → CREATE_LINE_FAILED（事务回滚）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/order-lines/').set(auth()).send({ poNumber: 'PO-1', itemNo: '0020', quantity: 10 });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('task ERP-P1 order-line-mutation: PUT /:id update', () => {
  it('成功 → 200 + onDataChange + audit + response 含 order/poNumber/customer（hydrate）', async () => {
    const { app, onDataChange, auditCreate } = makeApp();
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ materialCode: 'PROD-NEW', quantity: 200 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.line.order).toBeTruthy();
    expect(res.body.line.poNumber).toBe('PO-1');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('已确认订单的数量变更必须走订单变更审批，直接订单行 PUT 不落库', async () => {
    const { app, tx } = makeApp({ order: { id: 'ORD__1', poNumber: 'PO-1', customer: 'TestCustomer', type: 'fabric', status: 'Confirmed', deletedAt: null, lines: [] }, line: { id: 'ORD__1__0010', orderId: 'ORD__1', lineNumber: 1, itemNo: '0010', materialCode: 'PROD-1', quantity: 100, unit: 'M', fieldSources: {}, status: 'Pending' } });
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ quantity: 90 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(tx.orderLine.update).not.toHaveBeenCalled();
  });

  it.each([
    ['产品编码', { materialCode: 'PROD-NEW' }],
    ['单价', { unitPrice: 13.5 }],
    ['规格', { sizeBreakdown: [{ size: 'M', quantity: 12 }] }],
    ['交期', { deliveryDate: '2026-12-01' }],
    ['履约状态', { status: 'Shipped' }],
  ])('已提交审批订单的%s不能绕过变更/履约流程直接修改', async (_field, patch) => {
    const { app, tx } = makeApp({ order: { id: 'ORD__1', poNumber: 'PO-1', customer: 'TestCustomer', type: 'fabric', status: 'Confirmed', deletedAt: null, lines: [] } });
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send(patch);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(tx.orderLine.update).not.toHaveBeenCalled();
  });

  it('已提交审批订单仍允许直接补充备注并留审计', async () => {
    const { app, tx } = makeApp({ order: { id: 'ORD__1', poNumber: 'PO-1', customer: 'TestCustomer', type: 'fabric', status: 'Confirmed', deletedAt: null, lines: [] } });
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ notes: '补充业务跟进备注' });
    expect(res.status).toBe(200);
    expect(tx.orderLine.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notes: '补充业务跟进备注' }) }));
  });

  it('ORDER_LINE_NOT_FOUND → 404', async () => {
    const { app } = makeApp({ line: null });
    const res = await request(app).put('/api/v1/order-lines/UNKNOWN').set(auth()).send({ quantity: 200 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_LINE_NOT_FOUND');
  });

  it('sync reject → UPDATE_LINE_FAILED（事务回滚）', async () => {
    const { app, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ materialCode: 'PROD-NEW' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_LINE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → UPDATE_LINE_FAILED（事务回滚）', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ quantity: 200 });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('空 patch → 400', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('tolerancePercent 越界（999）→ 400 INVALID_INPUT 中文消息（2026-09-03 审计 P1）', async () => {
    const { app, tx } = makeApp();
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ tolerancePercent: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.message).toContain('0-100');
    // 越界不落库
    expect(tx.orderLine.update).not.toHaveBeenCalled();
  });

  it('tolerancePercent 负值（-20）→ 400 INVALID_INPUT', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ tolerancePercent: -20 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('tolerancePercent 合法边界（0 / 100）→ 200 放行', async () => {
    const { app } = makeApp();
    const zero = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ tolerancePercent: 0 });
    expect(zero.status).toBe(200);
    const hundred = await request(app).put('/api/v1/order-lines/ORD__1__0010').set(auth()).send({ tolerancePercent: 100 });
    expect(hundred.status).toBe(200);
  });
});

// ── ★ B14 同形缺陷（refs G3-LA · Step 4 全库派生扫描命中）：deleteOrderLine ──────────
// `tx.entityLink.count(...).catch(() => 0)` 的 0 在下一行 `if (linkCount > 0)` 是**判定值**：
// 查询一失败就被当成「这行没有关联单据」⇒ 跳过 deactivateEntityLinks，紧接着执行**硬删**
// `orderLine.delete` ⇒ 留下一批指向已删行的 active EntityLink 孤儿。
// 判据：交付文档 §2 G3「算不出来必须不给数」+ L-A（写路径/守卫路径零容忍）；
// 503 由 HTTP 语义（服务端无法完成前置校验、可重试）+ shared/errorCodes 注册表条目共同定，
// 不是抄实现现值。本函数原先**整条 DELETE 路径零测试覆盖** —— 这也是同形缺陷没被发现的原因。
describe('★ B14 同形：DELETE /:id 的关联计数查询失败 ⇒ 拒删（fail-closed）', () => {
  it('★ entityLink.count 抛错 → 503 DEPENDENCY_CHECK_FAILED，且不执行硬删、不写审计', async () => {
    const { app, lineDelete, auditCreate, entityLinkCount } = makeApp({ linkCountFail: true });
    const res = await request(app).delete('/api/v1/order-lines/ORD__1__0010').set(auth());

    expect(res.status, '关联校验没结论却答成功 = fail-open').toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_CHECK_FAILED');
    expect(lineDelete, '查不出来仍把订单行硬删了 ⇒ active EntityLink 变孤儿').not.toHaveBeenCalled();
    expect(auditCreate, '删除被拒却落了删除审计').not.toHaveBeenCalled();
    // 反向自检：错误确实来自那一路计数查询（不是别处先炸）
    expect(entityLinkCount).toHaveBeenCalledTimes(1);
    expect(res.body.error.message).not.toMatch(/invocation|Unknown argument|prisma\./i);
  });

  it('★ 阳性对照 1：无关联（count=0）⇒ 照常删除并留痕（守卫没变成「什么都不许删」）', async () => {
    const { app, lineDelete, auditCreate, entityLinkUpdate, entityLinkCount } = makeApp({ linkCount: 0 });
    const res = await request(app).delete('/api/v1/order-lines/ORD__1__0010').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(lineDelete).toHaveBeenCalledTimes(1);
    expect(entityLinkUpdate, '本无关联却去改 EntityLink').not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);

    /**
     * ★★ Step 0 实测：这条 where 在改前写的是 `sourceType`/`sourceId` —— EntityLink **没有**
     * 这两个字段（schema.prisma:1781-1798 只有 fromType/fromId），于是这一路每次都抛
     * PrismaClientValidationError、被 `.catch(() => 0)` 吞成「没有关联」⇒ 守卫恒 0、恒不生效。
     * 把字段名钉在这里：谁再写回不存在的字段，编译期（tx 已去 any）与这条断言双重咬红。
     */
    const where = entityLinkCount.mock.calls[0][0].where;
    expect(where).toEqual({ fromType: 'orderLine', fromId: 'ORD__1__0010', deletedAt: null });
    expect(where, 'sourceType/sourceId 不是 EntityLink 的字段 ⇒ 查询恒抛错、守卫恒盲').not.toHaveProperty('sourceType');
  });

  it('★ 阳性对照 2：有关联（count=2）⇒ 先 deactivateEntityLinks 再删（同事务顺序没被改坏）', async () => {
    const { app, lineDelete, entityLinkUpdate } = makeApp({ linkCount: 2 });
    const res = await request(app).delete('/api/v1/order-lines/ORD__1__0010').set(auth());

    expect(res.status).toBe(200);
    expect(entityLinkUpdate).toHaveBeenCalled();
    expect(lineDelete).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// GET /?orderId= —— 本单订单行（2026-09-29 晚补）
//   为什么补：QC 查货登记幅宽实测要选"本单的哪一支面料"，而此前 handler 连 `req` 都没用
//   （恒返回全库行）⇒ 前端没有数据源。★ 不过滤时行为必须与修前**逐字一致**。
// ════════════════════════════════════════════════════════════════════

describe('GET /api/v1/order-lines — 按 orderId 过滤（★ 不过滤时行为不变）', () => {
  const rows = [
    { id: 'L1', orderId: 'O1', order: { id: 'O1', poNumber: 'PO-1', deletedAt: null } },
    { id: 'L2', orderId: 'O2', order: { id: 'O2', poNumber: 'PO-2', deletedAt: null } },
  ];
  function appWith(rowsToServe: any[]) {
    const findMany = vi.fn().mockResolvedValue(rowsToServe);
    // Preserve the original all-visible query fixture using an actual loaded
    // admin identity/read grant, rather than anonymous development fallback.
    const account = { id: 'u1', status: 'active', deletedAt: null, roles: [{ roleId: 'role-admin', role: { id: 'role-admin', permissions: [{ permission: { scope: 'orders:read' } }] } }] };
    const prisma: any = { orderLine: { findMany }, userAccount: { findFirst: vi.fn().mockResolvedValue(account), findUnique: vi.fn().mockResolvedValue(account) }, userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) }, teamMember: { findMany: vi.fn().mockResolvedValue([]) }, teamDataGrant: { findMany: vi.fn().mockResolvedValue([]) }, department: { findMany: vi.fn().mockResolvedValue([]) } };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() } as any));
    return { app, findMany };
  }

  it('★★ 带 orderId ⇒ where 里带上它（只取本单的行）', async () => {
    const { app, findMany } = appWith([rows[0]]);
    const res = await request(app).get('/api/v1/order-lines?orderId=O1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ orderId: 'O1' }),
    }));
  });

  it('★ 不带 orderId ⇒ **不加 orderId 条件**（与修前逐字一致，既有调用方零影响）', async () => {
    const { app, findMany } = appWith(rows);
    const res = await request(app).get('/api/v1/order-lines').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    const where = findMany.mock.calls[0][0].where;
    expect(where.orderId, '★ 不许默认过滤成某个空值').toBeUndefined();
    expect(where.order).toEqual({ deletedAt: null });
  });

  it('★ 空白 orderId ⇒ 视同不传（不产生 `orderId: ""` 这种必然查空的条件）', async () => {
    const { app, findMany } = appWith(rows);
    await request(app).get('/api/v1/order-lines?orderId=%20%20').set(auth());
    expect(findMany.mock.calls[0][0].where.orderId).toBeUndefined();
  });

  it('★ 本单没有行 ⇒ 200 + 空数组（"确实没有" 不是错误）', async () => {
    const { app } = appWith([]);
    const res = await request(app).get('/api/v1/order-lines?orderId=O-EMPTY').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
  });
});
