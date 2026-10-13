/**
 * orderConfirmGates.test.ts — W-A 走查 P0 死胡同回归
 *
 * P0-1（DE-1）信用门禁接线：
 *   - orderServiceV2.createOrder 对 Frozen/Revoked/Net61+ 逾期客户 fail-closed（403 码族）
 *   - transitionOrderStatus 进入 Confirmed 同样门禁（V1/V2/Agent 全路径单引擎）
 * P0-2（DE-2/DE-4）确认路径统一：
 *   - V1 status-transition 发布 OrderStatusChanged + OrderConfirmed（L1 生产管线 / L6 BOM 联动触发源）
 *   - V2 PATCH 委托同一引擎后同样发事件；V1 补齐 MOQ Confirmed 门禁
 * P0-3（DE-6）MOQ HTTP 契约：
 *   - V2 PATCH 小单确认 → 409 + body.approvalRequestId 可读（不再 500）
 *   - V1 status-transition 小单确认 → 409 + error.approvalRequestId
 * B14·F3（文末新增）：V2 `DELETE /api/v2/orders/:id` 的 DEPENDENCY_CHECK_FAILED → 503 + 码原名
 *   钉子（`orderServiceV2.ts` codeMap / `routeV2.ts` statusMap 两处此前零覆盖）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ── mock 平台依赖（与 orderServiceV2.test.ts 同口径） ──
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../events/businessEventBus', async (importOriginal) => ({
  ...await importOriginal<any>(),
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../auth/permissionService', async original => ({
  // Only storage-dependent scope resolution is replaced. The HTTP middleware
  // must keep its actual hasScope implementation and original status probes.
  ...await original<typeof import('../../auth/permissionService')>(),
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })),
  ROLE_ID_TO_LEGACY_AGENT_ROLE: {},
}));

vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({
    nextNumber: vi.fn().mockResolvedValue('SO-202608-001'),
  })),
}));

vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({
    getEntries: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: vi.fn(() => ({
    getString: vi.fn().mockResolvedValue('USD'),
  })),
}));

vi.mock('../../teams/teamShareService', () => ({
  createTeamShareService: vi.fn(() => ({
    hasRelationWriteAccess: vi.fn().mockResolvedValue(true),
    resolveVisibleRelationIds: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../approvals/approvalRoutingService', () => ({
  createApprovalRoutingService: vi.fn(() => ({})),
}));

// MOQ 豁免审批单统一经 approvalCreateService（DR-007）；mock 固定回单号验证透传
const MOCK_APPROVAL_ID = 'APR__MOCK__1';
vi.mock('../../approvals/approvalCreateService', () => ({
  createApprovalCreateService: vi.fn(() => ({
    createBusinessApproval: vi.fn().mockResolvedValue({ id: MOCK_APPROVAL_ID }),
  })),
}));

import { transitionOrderStatus } from '../orderLifecycleService';
import { createOrderServiceV2 } from '../orderServiceV2';
import { createOrdersV2Router } from '../routeV2';
import { createOrdersRouter } from '../route';
import { publishBusinessEvent } from '../../events/businessEventBus';

// ── helpers ──
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], roles: ['admin'] } as any;

function makeOrder(overrides: any = {}) {
  return {
    id: 'ORD__1',
    code: 'SO-202608-001',
    customer: 'Peerless',
    product: 'Cotton Twill',
    type: 'Fabric',
    businessLine: 'fabric',
    quantity: 1000,
    status: 'Pending',
    dueDate: '2026-09-01',
    quoteAmount: 10000,
    currency: 'USD',
    capsuleExemption: false,
    moqSnapshot: null,
    customerRelationId: null,
    ownerId: 'user_1',
    deletedAt: null,
    createdAt: BigInt(0),
    updatedAt: BigInt(0),
    lines: [],
    ...overrides,
  };
}

function makeCreditLimit(overrides: any = {}) {
  return {
    id: 'CL__1',
    relationId: 'REL__1',
    status: 'Active',
    totalLimit: 100000,
    usedAmount: 0,
    currency: 'USD',
    frozenAt: null,
    frozenBy: null,
    thawedReason: null,
    lastAutoScanDate: null,
    ...overrides,
  };
}

function makePrisma(opts: {
  order?: any;
  creditLimit?: any;
  invoices?: any[];
  approvedMoqExemption?: any;
  exceptions?: any[];
} = {}) {
  const order = 'order' in opts ? opts.order : makeOrder();
  // DE-5：信用例外流程读写 Dr013ExceptionRequest（hasActiveException 查询 / 自动发起落库）
  const dr013ExceptionRequest = {
    findMany: vi.fn().mockResolvedValue(opts.exceptions ?? []),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
  };
  const tx = {
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...order, ...data, id: where.id })),
    },
    orderStatusTransition: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    dr013ExceptionRequest,
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      findFirst: vi.fn().mockResolvedValue(order),
      findMany: vi.fn().mockResolvedValue(order ? [order] : []),
      count: vi.fn().mockResolvedValue(order ? 1 : 0),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id ?? 'ORD__NEW', lines: [] })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    orderStatusTransition: { create: tx.orderStatusTransition.create },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    creditLimit: { findFirst: vi.fn().mockResolvedValue(opts.creditLimit ?? null), findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue(opts.invoices ?? []), count: vi.fn().mockResolvedValue(0) },
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue(opts.approvedMoqExemption ?? null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    dr013ExceptionRequest,
    // G-4：L/C 门禁要查信用证表。默认给空表（本文件其余用例都是非信用证订单，不会走到这里）。
    //   ⚠️ 不是"缺 delegate"：缺了会被 lcGate 内部的 catch 兜成 LC_QUERY_FAILED，测试会**为错误的原因变绿**。
    letterOfCredit: { findMany: vi.fn().mockResolvedValue([]) },
    entityLink: tx.entityLink,
    entityReference: tx.entityReference,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  return { prisma, tx, order, dr013ExceptionRequest };
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// P0-1（DE-1）信用门禁：transitionOrderStatus 进入 Confirmed
// ═══════════════════════════════════════════════════════════════
describe('P0-1 信用门禁：Confirmed 流转 fail-closed', () => {
  it('Frozen 客户确认被阻断（CREDIT_FROZEN_60_DAYS），无状态写入、无事件', async () => {
    const { prisma, tx } = makePrisma({
      order: makeOrder({ customerRelationId: 'REL__F' }),
      creditLimit: makeCreditLimit({ relationId: 'REL__F', status: 'Frozen', frozenBy: 'system_credit_scan', frozenAt: new Date() }),
    });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderStatusTransition.create).not.toHaveBeenCalled();
    expect(publishBusinessEvent).not.toHaveBeenCalled();
  });

  it('Revoked（吊销）客户确认被阻断（CREDIT_REVOKED）', async () => {
    const { prisma } = makePrisma({
      order: makeOrder({ customerRelationId: 'REL__R' }),
      creditLimit: makeCreditLimit({ relationId: 'REL__R', status: 'Revoked' }),
    });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_REVOKED');
  });

  it('Active 额度但 Net61+ 逾期未结清 → OVERDUE_60_DAYS（调度遗漏兜底）', async () => {
    const overdueDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { prisma } = makePrisma({
      order: makeOrder({ customerRelationId: 'REL__O' }),
      creditLimit: makeCreditLimit({ relationId: 'REL__O', status: 'Active' }),
      // ★ 必须有 amount：「未结清应收」判据含 `amount > 0` 守卫（shared/openReceivable）
      //   → 缺这个字段会让该票被当成「不欠钱」跳过，本用例就永远拿不到 OVERDUE_60_DAYS。
      invoices: [{ id: 'INV__1', amount: '1000', dueDate: overdueDate, issueDate: overdueDate, status: 'Issued', type: 'Receivable', customerRelationId: 'REL__O' }],
    });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('OVERDUE_60_DAYS');
  });

  it('Active 客户确认放行：状态写入 + OrderStatusChanged/OrderConfirmed 事件发布（P0-2 联动源）', async () => {
    const { prisma, tx } = makePrisma({
      order: makeOrder({ customerRelationId: 'REL__A' }),
      creditLimit: makeCreditLimit({ relationId: 'REL__A', status: 'Active' }),
    });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(true);
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    const eventTypes = (publishBusinessEvent as any).mock.calls.map((c: any[]) => c[0]?.type);
    expect(eventTypes).toContain('OrderStatusChanged');
    expect(eventTypes).toContain('OrderConfirmed');
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-1（DE-1）信用门禁：orderServiceV2.createOrder 建单 fail-closed
// ═══════════════════════════════════════════════════════════════
describe('P0-1 信用门禁：V2 建单 fail-closed', () => {
  it('Frozen 客户建单被拒（CREDIT_FROZEN_60_DAYS），order.create 未调用', async () => {
    const { prisma } = makePrisma({
      creditLimit: makeCreditLimit({ relationId: 'REL__F', status: 'Frozen' }),
    });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, {
      customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
      quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
      customerRelationId: 'REL__F',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('Active 客户建单正常放行', async () => {
    const { prisma } = makePrisma({
      creditLimit: makeCreditLimit({ relationId: 'REL__A', status: 'Active' }),
    });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, {
      customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
      quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
      customerRelationId: 'REL__A',
    });
    expect(r.ok).toBe(true);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-2（DE-2/DE-4）确认路径统一：V1 补 MOQ 门禁，V2 委托单引擎发事件
// ═══════════════════════════════════════════════════════════════
describe('P0-2 确认路径统一（V1/V2 单引擎）', () => {
  it('V1 确认 MOQ 不足被阻断：MOQ_VIOLATION + approvalRequestId（豁免审批单自动发起）', async () => {
    const { prisma, tx } = makePrisma({ order: makeOrder({ quantity: 100 }) });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('MOQ_VIOLATION');
    expect(r.error!.approvalRequestId).toBe(MOCK_APPROVAL_ID);
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('V1 确认 MOQ 不足但已有 approved 豁免单 → 放行', async () => {
    const { prisma } = makePrisma({
      order: makeOrder({ quantity: 100 }),
      approvedMoqExemption: { id: 'APR__APPROVED' },
    });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(true);
  });

  it('V2 transitionStatus 委托单引擎：小单确认 → MOQ_VIOLATION + approvalRequestId 透传', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ quantity: 100 }) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Confirmed');
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('MOQ_VIOLATION');
    expect(r.error!.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('V2 transitionStatus 委托单引擎：合规确认 → 成功且发布 OrderConfirmed（L1/L6 联动恢复）', async () => {
    const { prisma } = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Confirmed');
    expect(r.ok).toBe(true);
    const eventTypes = (publishBusinessEvent as any).mock.calls.map((c: any[]) => c[0]?.type);
    expect(eventTypes).toContain('OrderStatusChanged');
    expect(eventTypes).toContain('OrderConfirmed');
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-3（DE-6）MOQ HTTP 契约：409 + approvalRequestId 可读
// ═══════════════════════════════════════════════════════════════
describe('P0-3 MOQ/信用门禁 HTTP 契约', () => {
  it('V2 PATCH /api/v2/orders/:id/status 小单确认 → 409 + body.error=MOQ_VIOLATION + body.approvalRequestId', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ quantity: 100 }) });
    const app = express();
    app.use(express.json());
    app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .patch('/api/v2/orders/ORD__1/status')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'Confirmed' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('MOQ_VIOLATION');
    expect(res.body.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  // ★ G-4：同一族坑在 V2 的第二次落地 —— `orderServiceV2` 的 codeMap 是 `Record<string, OrderV2Error>`
  //   （**不是**穷尽表），漏登记的新码会被 `?? 'INTERNAL_ERROR'` 把机器可读码销毁，
  //   再叠上 routeV2 的 statusMap 缺项 ⇒ 一条 HTTP 500。所以这里两半都要钉：码没被改写、档是对的 403。
  it('★ G-4 V2 服务层：L/C 订单无证确认 → code 仍是 LC_GATE_BLOCKED（不许塌成 INTERNAL_ERROR）', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ paymentInstrument: 'L/C' }) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Confirmed');
    expect(r.ok).toBe(false);
    expect(r.error!.code, 'V2 的 codeMap 漏码 = 把业务拒绝伪装成内部错误').toBe('LC_GATE_BLOCKED');
    expect(r.error!.message).toContain('LC_NOT_REGISTERED');
  });

  it('★ G-4 V2 HTTP：PATCH /api/v2/orders/:id/status → 403 + body.error=LC_GATE_BLOCKED（不是 500）', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ paymentInstrument: 'L/C' }) });
    const app = express();
    app.use(express.json());
    app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .patch('/api/v2/orders/ORD__1/status')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'Confirmed' });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe('LC_GATE_BLOCKED');
  });

  it('★ 正向对照：同样无证但订单是 T/T ⇒ V2 确认照常放行（门禁不许把非信用证订单一起锁死）', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ paymentInstrument: 'T/T' }) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Confirmed');
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  });

  it('V2 POST /api/v2/orders Frozen 客户建单 → 403 + body.error=CREDIT_FROZEN_60_DAYS', async () => {
    const { prisma } = makePrisma({
      creditLimit: makeCreditLimit({ relationId: 'REL__F', status: 'Frozen' }),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .post('/api/v2/orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
        quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
        customerRelationId: 'REL__F',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CREDIT_FROZEN_60_DAYS');
  });

  it('V1 POST /api/v1/orders/:id/status-transition 小单确认 → 409 + error.code=MOQ_VIOLATION + error.approvalRequestId', async () => {
    const { prisma } = makePrisma({ order: makeOrder({ quantity: 100 }) });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .post('/api/v1/orders/ORD__1/status-transition')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOQ_VIOLATION');
    expect(res.body.error.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('V1 POST /api/v1/orders/:id/status-transition Frozen 客户确认 → 403 + error.code=CREDIT_FROZEN_60_DAYS', async () => {
    const { prisma } = makePrisma({
      order: makeOrder({ customerRelationId: 'REL__F' }),
      creditLimit: makeCreditLimit({ relationId: 'REL__F', status: 'Frozen' }),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .post('/api/v1/orders/ORD__1/status-transition')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CREDIT_FROZEN_60_DAYS');
  });
});

// ═══════════════════════════════════════════════════════════════
// B14 · 复审 F3：V2 DELETE 端点的 DEPENDENCY_CHECK_FAILED 钉子
//
// 为什么在**这个文件**补：`orderServiceV2.ts` 的 codeMap 与 `routeV2.ts` 的 statusMap
// 各自新增了一条 `DEPENDENCY_CHECK_FAILED`，但 V2 的删除路径此前只有服务层用例
// （`orderServiceV2.test.ts` 断的是 HAS_DEPENDENTS/NOT_FOUND），路由级 503 从没被钉过 ⇒
// 任何人删掉这两行之一都不会红 —— 正是 B14 本体注释点名的「`|| 500` 第 4 次同一坑」。
//
// 判据出处（不是抄现值）：
//  · **503** = HTTP 语义「服务端暂时无法完成处理请求所需的前置校验，客户端可重试」
//    （RFC 9110 §15.6.4）。这里**没有**"依赖存在"的结论（那不是 409），用户也没写错东西
//    （那不是 400），删除**并没有真的失败过一次**（那不是 500 —— 500 意味着不可重试的
//    内部错误，前端会把"该重试"显示成"找管理员"）。
//  · **码原名透出** = 交付文档 §2 G4.4 缺口③ + G7.5：「校验没结论」与「删除真失败」
//    必须是两个码，否则用户/前端无从判断该重试还是该报障。
// 两条都是**删掉即红**的钉子：删 codeMap 行 ⇒ 码变 INTERNAL_ERROR；删 statusMap 行 ⇒ 503 变 500。
// ═══════════════════════════════════════════════════════════════
describe('B14 V2 DELETE /api/v2/orders/:id：依赖校验失败 ⇒ 503 + 码原名（F3 钉子）', () => {
  /**
   * 本文件的 harness 原本只覆盖建单/确认路径，`tx` 里没有 deleteOrder 依赖的六把键。
   * 就地补齐（**不改动** makePrisma，避免影响上面 20 条既有用例的期望值）：
   * 五个依赖计数 + 删单联动的 quotation.updateMany。
   */
  function attachDeleteTxMocks(tx: any) {
    tx.invoice = { count: vi.fn().mockResolvedValue(0) };
    tx.invoiceOrderAllocation = { count: vi.fn().mockResolvedValue(0) };
    tx.shipment = { count: vi.fn().mockResolvedValue(0) };
    tx.shipmentOrderAllocation = { count: vi.fn().mockResolvedValue(0) };
    tx.paymentVoucher = { count: vi.fn().mockResolvedValue(0) };
    //  ★ v2.49（G4.4 缺口②）：删单守卫多了第六路 = 批次计划；替身必须跟着补，否则 fail-closed 会把「替身不全」报成「校验失败」
    tx.orderShipmentBatch = { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
    tx.quotation = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
    return tx;
  }
  function mountV2(prisma: any) {
    const app = express();
    app.use(express.json());
    app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set() }));
    return app;
  }

  it('★ 依赖计数抛错 → 503 + error=DEPENDENCY_CHECK_FAILED（不退化成 500 / INTERNAL_ERROR），且不写软删', async () => {
    const { prisma, tx } = makePrisma();
    const del = attachDeleteTxMocks(tx);
    // 真形状：Prisma **客户端侧**校验错误（引擎级错误会连带回滚 ⇒ 无害；客户端级才是 B14 的有害分支）
    del.invoice.count.mockRejectedValueOnce(
      new Error('Invalid `prisma.invoice.count()` invocation: Unknown argument `deletedAt`'),
    );
    const res = await request(mountV2(prisma)).delete('/api/v2/orders/ORD__1').set('Authorization', `Bearer ${ownerToken}`);

    // 先断码、后断状态：两处映射各有一行，顺序决定"红信指名哪一行被删"
    // （删 codeMap 行 ⇒ 码先塌成 INTERNAL_ERROR；删 statusMap 行 ⇒ 码仍对、状态塌成 500）
    expect(res.body.error, "塌成 INTERNAL_ERROR ⇒ 少了 orderServiceV2 codeMap 那一行").toBe('DEPENDENCY_CHECK_FAILED');
    expect(res.status, '校验没结论却答 500 ⇒ 少了 routeV2 statusMap 那一行（`|| 500` 兜底）').toBe(503);
    // 红必须是「计数抛错」造成的，不能是 mock 缺键导致的 TypeError（否则这条钉子是恒真的）
    expect(del.invoice.count).toHaveBeenCalledTimes(1);
    expect(tx.order.update, '依赖校验失败后仍写了软删（fail-open 复活）').not.toHaveBeenCalled();
    expect(tx.auditLog.create, '依赖校验失败后仍落了删除审计').not.toHaveBeenCalled();
    // G7.5：内部文本不外发
    expect(res.body.message).not.toMatch(/invocation|Unknown argument|prisma\./i);
  });

  it('★ 阳性对照：五路计数都正常返回 0 ⇒ V2 删除照常 200 且真写了软删（钉子没把守卫变成"什么都不许删"）', async () => {
    const { prisma, tx } = makePrisma();
    const del = attachDeleteTxMocks(tx);
    const res = await request(mountV2(prisma)).delete('/api/v2/orders/ORD__1').set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(del.invoice.count).toHaveBeenCalledTimes(1);
    expect(del.paymentVoucher.count).toHaveBeenCalledTimes(1);
    expect(tx.order.update, '合法删除被本钉子误伤').toHaveBeenCalledTimes(1);
  });
});
