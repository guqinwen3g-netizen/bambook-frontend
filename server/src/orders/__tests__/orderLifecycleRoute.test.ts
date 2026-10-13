import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createOrdersRouter } from '../route';

// JWT mock for write-op auth guard (requireRole + requireJwtForWrite).
// Signed with the same default secret as auth/service.ts.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

function makeLifecycleApp(opts: {
  order?: any;
  txFail?: boolean;
  syncFail?: boolean;
  syncOrderFail?: boolean;
  auditFail?: boolean;
  outboxFail?: boolean;
} = {}) {
  const order = opts.order === undefined ? {
    id: 'ORD__1', status: 'Pending', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0),
    // Confirmed 门禁（信用+MOQ）已接入 transitionOrderStatus：默认单需可过门禁
    // （quantity 1000 ≥ 面料兜底 MOQ 800；无 customerRelationId → 信用门禁跳过）
    type: 'Fabric', businessLine: 'fabric', quantity: 1000, capsuleExemption: false, moqSnapshot: null,
  } : opts.order;

  const orderUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...order, ...data, id: where.id }));
  const statusTransitionCreate = vi.fn().mockResolvedValue({});
  const auditCreate = opts.auditFail ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT')) : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([{ id: 'L1', fromType: 'order', fromId: 'ORD__1', status: 'active' }]);
  const entityLinkUpdate = opts.syncFail ? vi.fn().mockRejectedValue(new Error('SYNC_REJECT')) : vi.fn().mockResolvedValue({});
  const entityRefFindMany = vi.fn().mockResolvedValue([]);
  const entityRefUpdate = vi.fn().mockResolvedValue({});
  const entityRefUpsert = opts.syncOrderFail ? vi.fn().mockRejectedValue(new Error('SYNC_ORDER_REJECT')) : vi.fn().mockResolvedValue({});

  const tx = {
    agentJob: { create: opts.outboxFail ? vi.fn().mockRejectedValue(new Error('OUTBOX_FAILED')) : vi.fn().mockResolvedValue({}) },
    order: { findUnique: vi.fn().mockResolvedValue(order), update: orderUpdate },
    orderStatusTransition: { create: statusTransitionCreate },
    auditLog: { create: auditCreate },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
    entityReference: { upsert: entityRefUpsert, findMany: entityRefFindMany, update: entityRefUpdate },
    // deleteOrder checks for dependent invoices/shipments/vouchers/allocations before soft-deleting
    invoice: { count: vi.fn().mockResolvedValue(0) },
    invoiceOrderAllocation: { count: vi.fn().mockResolvedValue(0) },
    shipment: { count: vi.fn().mockResolvedValue(0) },
    shipmentOrderAllocation: { count: vi.fn().mockResolvedValue(0) },
    paymentVoucher: { count: vi.fn().mockResolvedValue(0) },
    //  ★ v2.49（G4.4 缺口②）：删单守卫多了第六路 = 批次计划；替身必须跟着补，否则 fail-closed 会把「替身不全」报成「校验失败」
    orderShipmentBatch: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // 删单联动：解除报价单转换引用（Quotation.convertedOrderId → null）
    quotation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    order: { findUnique: vi.fn().mockResolvedValue(order), findMany: vi.fn().mockResolvedValue(order ? [order] : []) },
    // Confirmed 门禁前置查询（信用门禁 + MOQ approved 豁免单检查）
    creditLimit: { findFirst: vi.fn().mockResolvedValue(null) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: opts.txFail ? vi.fn().mockRejectedValue(new Error('TX_BOOM')) : vi.fn(async (fn: any) => fn(tx)),
  } as any;

  const onDataChange = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange }));
  return { app, tx, prisma, onDataChange, orderUpdate, statusTransitionCreate, auditCreate, entityLinkUpdate };
}

describe('task ERP-P1 order-lifecycle: DELETE /:id 软删', () => {
  it('成功 → 200 + onDataChange 触发 + response 含 serializeOrder', async () => {
    const { app, onDataChange, auditCreate } = makeLifecycleApp();
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order).toBeTruthy();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('ORDER_NOT_FOUND → 404', async () => {
    const { app } = makeLifecycleApp({ order: null });
    const res = await request(app).delete('/api/v1/orders/NOPE').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('ORDER_ALREADY_DELETED（重复删除）→ 409', async () => {
    const { app } = makeLifecycleApp({ order: { id: 'ORD__1', status: 'Pending', deletedAt: BigInt(Date.now()) } });
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ALREADY_DELETED');
  });

  it('sync reject → DELETE_FAILED（事务回滚）', async () => {
    const { app } = makeLifecycleApp({ syncFail: true });
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DELETE_FAILED');
  });

  it('失败路径 onDataChange 不调用（DELETE ORDER_NOT_FOUND）', async () => {
    const { app, onDataChange } = makeLifecycleApp({ order: null });
    await request(app).delete('/api/v1/orders/NOPE').set(auth());
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → DELETE_FAILED（事务回滚）', async () => {
    const { app } = makeLifecycleApp({ auditFail: true });
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DELETE_FAILED');
  });

  it('EntityLink inactive：delete → entityLink.update 被调用', async () => {
    const { app, entityLinkUpdate } = makeLifecycleApp();
    await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(entityLinkUpdate).toHaveBeenCalled();
  });

  it('HAS_DEPENDENTS（存在发票）→ 409 不软删', async () => {
    const { app, tx, orderUpdate } = makeLifecycleApp();
    tx.invoice.count.mockResolvedValueOnce(2);
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_DEPENDENTS');
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('HAS_DEPENDENTS（存在发票分摊 InvoiceOrderAllocation，DR-016 多对多链）→ 409', async () => {
    const { app, tx } = makeLifecycleApp();
    tx.invoiceOrderAllocation.count.mockResolvedValueOnce(1);
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_DEPENDENTS');
    // 原来钉的是英文字面 `invoice allocation`。断言要的是**这一路真的被点名了**（六路互不混淆），
    // 不是"这句话永远这么写" ⇒ 改钉类目标签；文案已中文化（G7.5 异常可行动，且英文原文外发是 B42 那族）。
    expect(res.body.error.message).toContain('发票分摊×1');
  });

  it('HAS_DEPENDENTS（存在出运分摊 ShipmentOrderAllocation）→ 409', async () => {
    const { app, tx } = makeLifecycleApp();
    tx.shipmentOrderAllocation.count.mockResolvedValueOnce(3);
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_DEPENDENTS');
    expect(res.body.error.message).toContain('出运分摊×3');
  });

  // ── ★ B14（refs G3-LA · G4.4 缺口③ · T2 负面用例）──────────────────────────
  // 依赖计数**查询本身失败**时，守卫必须拒绝而不是当成「没有依赖」放行。
  // 判据出处：交付文档 §2 G3「算不出来必须不给数，绝不给错数」+ L-A（写/守卫路径零容忍）；
  // 503 取自 HTTP 语义（服务端无法完成前置校验、可重试），不是照抄实现现值。
  // 构造验证（docs/B14-…-2026-09-20.md §3b，真库 + 真 deleteOrder）修复前的行为是
  // `ok = true` 且事务提交 —— 下面 `orderUpdate` / `auditCreate` 两条就是那次的写入点。
  it('★ 依赖计数抛错 → 503 DEPENDENCY_CHECK_FAILED，且不写软删、不写审计（B14 fail-closed）', async () => {
    const { app, tx, orderUpdate, auditCreate } = makeLifecycleApp();
    tx.invoice.count.mockRejectedValueOnce(
      new Error('Invalid `prisma.invoice.count()` invocation: Unknown argument `deletedAt`'),
    );
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());

    expect(res.status, '校验没结论却答 200 = 有依赖的单被删了').toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('DEPENDENCY_CHECK_FAILED');
    expect(orderUpdate, '依赖检查失败后仍执行了软删写入').not.toHaveBeenCalled();
    expect(auditCreate, '依赖检查失败后仍落了审计（说明删除走到了最后一步）').not.toHaveBeenCalled();
    // G7.5：文案说清「为什么 + 结果 + 下一步」；原始 Prisma 文本一个字都不许外发
    expect(res.body.error.message).toContain('校验未能完成');
    expect(res.body.error.message, '不许让用户以为已经删掉了').toContain('删除已阻止');
    expect(res.body.error.message).toMatch(/稍后重试|联系管理员/);
    expect(res.body.error.message).not.toMatch(/invocation|Unknown argument|prisma\./i);
  });

  it('★ 阳性对照：五路计数都正常返回 0 时删除照常 200（fail-closed 没把守卫变成「什么都不许删」）', async () => {
    const { app, orderUpdate } = makeLifecycleApp();
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(orderUpdate).toHaveBeenCalledTimes(1);
  });

  it('删单联动：清除指向本单的 Quotation.convertedOrderId（防报价永久卡死）', async () => {
    const { app, tx } = makeLifecycleApp();
    tx.quotation.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    expect(res.status).toBe(200);
    const unlinkCall = tx.quotation.updateMany.mock.calls[0][0];
    expect(unlinkCall.where).toEqual({ convertedOrderId: 'ORD__1' });
    expect(unlinkCall.data.convertedOrderId).toBeNull();
    expect(unlinkCall.data.updatedAt).toBeDefined();
  });

  it('删单联动：解链发生时补审计留痕（unlink_quotation_conversion）', async () => {
    const { app, tx, auditCreate } = makeLifecycleApp();
    tx.quotation.updateMany.mockResolvedValueOnce({ count: 1 });
    await request(app).delete('/api/v1/orders/ORD__1').set(auth());
    const unlinkAudit = auditCreate.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.action === 'unlink_quotation_conversion');
    expect(unlinkAudit).toBeTruthy();
    expect(unlinkAudit.targetType).toBe('Quotation');
    expect(unlinkAudit.fieldPath).toBe('convertedOrderId');
  });
});

describe('task ERP-P1 order-lifecycle: POST /:id/status-transition', () => {
  it('确认订单同时持久化状态事件和下游交接事件', async () => {
    const { app, tx } = makeLifecycleApp();
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(200);
    const jobs = tx.agentJob.create.mock.calls.map(([arg]: any[]) => arg.data);
    expect(jobs.map((job: any) => job.jobType)).toEqual(['bev:OrderStatusChanged', 'bev:OrderConfirmed']);
    expect(jobs.every((job: any) => job.status === 'queued' && job.payload.sourceEntityId === 'ORD__1')).toBe(true);
    expect(jobs[0].payload.transactionId).toBe(jobs[1].payload.transactionId);
  });

  it('交接事件不能持久化时确认失败，不通知前端成功', async () => {
    const { app, onDataChange, tx } = makeLifecycleApp({ outboxFail: true });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(500);
    expect(tx.agentJob.create).toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('成功 → 200 + transition + onDataChange', async () => {
    const { app, statusTransitionCreate, onDataChange } = makeLifecycleApp();
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed', note: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(statusTransitionCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('INVALID_STATUS（非法状态）→ 400', async () => {
    const { app } = makeLifecycleApp();
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Cancelled' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  it('INVALID_STATUS（空 toStatus）→ 400', async () => {
    const { app } = makeLifecycleApp();
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  it('NO_CHANGE（相同状态）→ 400', async () => {
    const { app } = makeLifecycleApp({ order: { id: 'ORD__1', status: 'Confirmed', deletedAt: null } });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_CHANGE');
  });

  it('ORDER_NOT_FOUND → 404', async () => {
    const { app } = makeLifecycleApp({ order: null });
    const res = await request(app).post('/api/v1/orders/NOPE/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('deleted order → 404（status-transition 拒绝）', async () => {
    const { app } = makeLifecycleApp({ order: { id: 'ORD__1', status: 'Pending', deletedAt: BigInt(Date.now()) } });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('audit reject → TRANSITION_FAILED（事务回滚）', async () => {
    const { app } = makeLifecycleApp({ auditFail: true });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('TRANSITION_FAILED');
  });

  it('syncOrderEntityReferences reject → TRANSITION_FAILED（事务回滚）', async () => {
    // order 含 customerRelationId 让 syncOrderEntityReferences 产生 entityReference.upsert 调用
    //（quantity/type 使 Confirmed 门禁可通过，信用门禁经 creditLimit=null/invoice=[] 放行）
    const { app } = makeLifecycleApp({ syncOrderFail: true, order: { id: 'ORD__1', status: 'Pending', deletedAt: null, type: 'Fabric', quantity: 1000, capsuleExemption: false, moqSnapshot: null, customerRelationId: 'R1', millRelationId: 'R2' } });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('TRANSITION_FAILED');
  });

  it('失败路径 onDataChange 不调用（status-transition INVALID_STATUS）', async () => {
    const { app, onDataChange } = makeLifecycleApp();
    await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Bogus' });
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('status-transition 成功 → response 含完整 transition + serializeOrder', async () => {
    const { app } = makeLifecycleApp();
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Confirmed', note: 'test note' });
    expect(res.status).toBe(200);
    expect(res.body.transition.fromStatus).toBe('Pending');
    expect(res.body.transition.toStatus).toBe('Confirmed');
    expect(res.body.transition.note).toBe('test note');
    expect(res.body.transition.lineId).toBeNull();
    expect(res.body.order).toBeTruthy();
  });

  it('status-transition lineId 透传 → response transition.lineId 非空', async () => {
    // Pending → Production 不是合法转移；用 Confirmed → Production 测试 lineId 透传
    const { app } = makeLifecycleApp({ order: { id: 'ORD__1', status: 'Confirmed', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) } });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Production', lineId: 'OL__1' });
    expect(res.status).toBe(200);
    expect(res.body.transition.lineId).toBe('OL__1');
  });

  // R678 操作人失真修复：留痕 operator 以认证 actorId 为唯一真源，客户端字面量 operator 不得覆盖
  it('客户端传字面量 operator（如 desktop-user）时，留痕仍以认证 actorId 为准', async () => {
    const { app, statusTransitionCreate } = makeLifecycleApp();
    const res = await request(app)
      .post('/api/v1/orders/ORD__1/status-transition')
      .set(auth())
      .send({ toStatus: 'Confirmed', operator: 'desktop-user' });
    expect(res.status).toBe(200);
    // JWT ownerToken 的 userId = 'u1'（见文件头 auth()）
    expect(statusTransitionCreate).toHaveBeenCalledTimes(1);
    expect(statusTransitionCreate.mock.calls[0][0].data.operator).toBe('u1');
    expect(res.body.transition.operator).toBe('u1');
  });

  it('未传 operator 时，留痕 operator = 认证 actorId', async () => {
    const { app, statusTransitionCreate } = makeLifecycleApp();
    const res = await request(app)
      .post('/api/v1/orders/ORD__1/status-transition')
      .set(auth())
      .send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(200);
    expect(statusTransitionCreate.mock.calls[0][0].data.operator).toBe('u1');
  });

  // ── DR-010 守卫态 / 已关闭终态：**409 而不是 500** ──────────────────────────
  // 2026-09-17 真库演练（scripts/acceptance-pending-cancel-path.mjs S11）实测：
  // 订单处于「取消申请中」时推进状态，前端看到的是 **HTTP 500「服务器错误」**——
  // 因为 V1 路由的 statusCodeMap 漏了这两个由 `throw` 抛出、刻意不在
  // OrderLifecycleErrorCode 联合类型里的码（`|| 500` 兜底）。
  // 现在映射真源 = orderLifecycleService.ORDER_LIFECYCLE_ERROR_HTTP_STATUS（编译期强制完整）。
  it('ORDER_LIFECYCLE_GUARDED（取消申请中）→ 409 而非 500', async () => {
    const { app, orderUpdate } = makeLifecycleApp({
      order: { id: 'ORD__1', status: 'CancelRequested', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) },
    });
    // toStatus 用 Production 以绕开 Confirmed 门禁，直达事务内的 DR-010 守卫
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Production' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_LIFECYCLE_GUARDED');
    expect(res.body.error.message).toContain('CancelRequested');
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('ORDER_ALREADY_CLOSED（Cancelled 终态）→ 409 而非 500', async () => {
    const { app, orderUpdate } = makeLifecycleApp({
      order: { id: 'ORD__1', status: 'Cancelled', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) },
    });
    const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Production' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ALREADY_CLOSED');
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('PauseRequested / Closing 守卫态同样 409（不只是 CancelRequested 一个态）', async () => {
    for (const guarded of ['PauseRequested', 'Closing', 'Paused']) {
      const { app } = makeLifecycleApp({
        order: { id: 'ORD__1', status: guarded, deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) },
      });
      const res = await request(app).post('/api/v1/orders/ORD__1/status-transition').set(auth()).send({ toStatus: 'Production' });
      expect(res.status, `${guarded} 应为 409`).toBe(409);
      expect(res.body.error.code, `${guarded} 错误码`).toBe('ORDER_LIFECYCLE_GUARDED');
    }
  });
});
