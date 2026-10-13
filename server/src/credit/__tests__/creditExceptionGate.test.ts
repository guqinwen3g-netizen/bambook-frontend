/**
 * creditExceptionGate.test.ts — W-A 走查 P1-2（DE-5）/ P1-3（DE-6）回归
 *
 * DE-5 信用阻断系统内例外入口：
 *   - exceptionCategory 枚举补 credit_exemption（EXCEPTION_CATEGORIES）
 *   - 信用门禁阻断 → 自动发起 credit_exemption 例外申请（DR-007 审批人解析，审批单 id 透传）
 *   - 生效例外（ReviewerApproved + 未过期 + 未核销）→ 门禁放行，动作成功后核销
 *   - 过期例外不放行（重新自动发起新申请）；审批中例外不重复发起
 * DE-6 审批单透传：
 *   - V1 status-transition / V2 PATCH status / V2 POST create / V1 batch-status
 *     信用门禁错误响应 body 均含 approvalRequestId
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../events/businessEventBus', async (importOriginal) => ({
  ...await importOriginal<any>(),
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../auth/permissionService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../auth/permissionService')>();
  return {
    // Keep the actual pure hasScope / loaded-identity exports used by middleware.
    // This fixture substitutes row visibility only; it does not replace scope
    // authorization or claim per-request PG-backed identity hydration.
    ...actual,
    createPermissionService: vi.fn((options: Parameters<typeof actual.createPermissionService>[0]) => ({
      ...actual.createPermissionService(options),
      getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
    })),
  };
});

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

// DR-007 审批创建统一走 approvalCreateService；mock 固定回单号验证透传（DE-6）
const MOCK_APPROVAL_ID = 'APR__CREDIT_EXC__1';
vi.mock('../../approvals/approvalCreateService', () => ({
  createApprovalCreateService: vi.fn(() => ({
    createBusinessApproval: vi.fn().mockResolvedValue({ id: MOCK_APPROVAL_ID, reviewerId: 'u_head' }),
  })),
}));

import { transitionOrderStatus } from '../../orders/orderLifecycleService';
import { createOrderServiceV2 } from '../../orders/orderServiceV2';
import { createOrdersV2Router } from '../../orders/routeV2';
import { createOrdersRouter } from '../../orders/route';
import { EXCEPTION_CATEGORIES } from '../../exceptions/exceptionGate';
import { consumeCreditException, CreditExceptionConsumptionError } from '../creditExceptionGate';

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
    customerRelationId: 'REL__F',
    ownerId: 'user_1',
    deletedAt: null,
    createdAt: BigInt(0),
    updatedAt: BigInt(0),
    lines: [],
    ...overrides,
  };
}

const FROZEN_CREDIT_LIMIT = {
  id: 'CL__1',
  relationId: 'REL__F',
  status: 'Frozen',
  totalLimit: 100000,
  usedAmount: 0,
  currency: 'USD',
  frozenAt: new Date(),
  frozenBy: 'system_credit_scan',
  thawedReason: null,
  lastAutoScanDate: null,
};

/** DR-013 例外 fixture（scope 存 attachments JSON 扩展字段，schema 冻结期设计许可） */
function makeException(overrides: any = {}) {
  const scope = {
    targetType: 'Order',
    targetId: 'ORD__1',
    action: 'order:confirm',
    validUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    maxUses: 1,
    usedCount: 0,
    consumptions: [],
    responsibleOwnerId: 'user_1',
    ...(overrides.scope ?? {}),
  };
  const { scope: _omit, ...rest } = overrides;
  return {
    id: 'EXC__1',
    exceptionNumber: 'EXC-20260827-001',
    exceptionCategory: 'credit_exemption',
    subCategory: null,
    status: 'ReviewerApproved',
    approvalRequestId: 'ar_exc_1',
    bypassedApprovalIds: [],
    bossFinalBypassBy: null,
    deletedAt: null,
    attachments: { files: [], scope },
    ...rest,
  };
}

function makePrisma(opts: {
  order?: any;
  creditLimit?: any;
  exceptions?: any[];
} = {}) {
  const order = 'order' in opts ? opts.order : makeOrder();
  const exceptions = opts.exceptions ?? [];
  const copyException = (row: any) => row ? { ...row, attachments: structuredClone(row.attachments) } : null;
  const dr013ExceptionRequest: Record<string, ReturnType<typeof vi.fn>> = {
    findMany: vi.fn().mockImplementation(async () => exceptions.map(copyException)),
    findUnique: vi.fn().mockImplementation(async ({ where }: any) => copyException(exceptions.find((e: any) => e.id === where.id))),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    update: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const row = exceptions.find((item: any) => item.id === where.id);
      if (row) Object.assign(row, data);
      return copyException(row ?? { id: where.id, ...data });
    }),
    updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
      const row = exceptions.find((item: any) => item.id === where.id);
      if (!row || row.status !== where.status || row.deletedAt) return { count: 0 };
      if (where.approvalRequestId !== undefined && row.approvalRequestId !== where.approvalRequestId) return { count: 0 };
      if (where.attachments && JSON.stringify(row.attachments) !== JSON.stringify(where.attachments.equals)) return { count: 0 };
      // Adapter delegates the matched CAS mutation to the original update spy,
      // preserving the pre-existing state-effect assertions without weakening it.
      await dr013ExceptionRequest.update({ where: { id: where.id }, data });
      return { count: 1 };
    }),
  };
  const lockException = vi.fn(async (_query: TemplateStringsArray, id: string) => exceptions.some(row => row.id === id) ? [{ id }] : []);
  const createOrder = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id ?? 'ORD__NEW', lines: [] }));
  const tx = {
    $queryRaw: lockException,
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    order: {
      create: createOrder,
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
    $queryRaw: lockException,
    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      findFirst: vi.fn().mockResolvedValue(order),
      findMany: vi.fn().mockResolvedValue(order ? [order] : []),
      count: vi.fn().mockResolvedValue(order ? 1 : 0),
      create: createOrder,
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    orderStatusTransition: { create: tx.orderStatusTransition.create },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    creditLimit: { findFirst: vi.fn().mockResolvedValue(opts.creditLimit ?? null), findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    approvalRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    dr013ExceptionRequest,
    entityLink: tx.entityLink,
    entityReference: tx.entityReference,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  return { prisma, tx, order, dr013ExceptionRequest };
}

beforeEach(() => { vi.clearAllMocks(); });

// Real service behavior with persistence adapters. Rollback/concurrent SQL
// evidence belongs to creditOrderAtomicityRealDb, not these transaction spies.
describe('credit order mandatory consumption transaction contract', () => {
  it('forwards the exact business transaction and rejects a failed quota result', async () => {
    const tx = {} as any;
    const consumeException = vi.fn().mockResolvedValue({ ok: false, error: { code: 'EXCEPTION_ALREADY_CONSUMED', message: 'Quota exhausted', statusCode: 409 } });
    await expect(consumeCreditException({ exceptionService: { consumeException } as any, exceptionId: 'EXC',
      scope: { targetType: 'Order', targetId: 'ORD', action: 'order:confirm' }, actorId: 'user_1', tx })).rejects.toMatchObject({ code: 'EXCEPTION_ALREADY_CONSUMED', statusCode: 409 });
    expect(consumeException).toHaveBeenCalledWith(expect.objectContaining({ tx, consumedBy: 'user_1', targetType: 'Order', targetId: 'ORD', action: 'order:confirm' }));
  });
  it('a missing business transaction never falls back to a standalone consumption', async () => {
    const consumeException = vi.fn();
    await expect(consumeCreditException({ exceptionService: { consumeException } as any, exceptionId: 'EXC',
      scope: { targetType: 'Order', targetId: 'ORD', action: 'order:confirm' }, actorId: 'user_1', tx: undefined as any })).rejects.toBeInstanceOf(CreditExceptionConsumptionError);
    expect(consumeException).not.toHaveBeenCalled();
  });
  it('valid Relation/order:create consumption uses the order insert transaction once', async () => {
    const exc = makeException({ scope: { targetType: 'Relation', targetId: 'REL__F', action: 'order:create' } });
    const { prisma, tx } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [exc] });
    const result = await createOrderServiceV2(prisma).createOrder(ACTOR, { customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric', quantity: 1000, customerRelationId: 'REL__F', dueDate: '2099-01-01', quoteAmount: 1000 });
    expect(result.ok).toBe(true); expect(prisma.$transaction).toHaveBeenCalledTimes(1); expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledWith(expect.anything(), exc.id);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: ACTOR.userId, action: 'dr013_exception_consumed' }) }));
    expect(exc.status).toBe('Consumed'); expect(exc.attachments.scope.usedCount).toBe(1);
  });
  it('creation surfaces a mandatory consumption audit failure and emits no advisory success', async () => {
    const exc = makeException({ scope: { targetType: 'Relation', targetId: 'REL__F', action: 'order:create' } });
    const { prisma, tx } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [exc] });
    tx.auditLog.create.mockRejectedValue(new Error('Injected adapter audit failure'));
    const result = await createOrderServiceV2(prisma).createOrder(ACTOR, { customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric', quantity: 1000, customerRelationId: 'REL__F', dueDate: '2099-01-01', quoteAmount: 1000 });
    expect(result.ok).toBe(false); expect(result.error!.code).toBe('EXCEPTION_CONSUME_FAILED'); expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.create).toHaveBeenCalledTimes(1); expect(tx.agentJob.create).not.toHaveBeenCalled();
  });
  it('a confirmation quota CAS conflict fails before persisting or publishing success events', async () => {
    const exc = makeException(); const { prisma, tx, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [exc] });
    dr013ExceptionRequest.updateMany.mockResolvedValue({ count: 0 });
    const result = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(result.ok).toBe(false); expect(result.error!.code).toBe('EXCEPTION_CONSUME_CONFLICT'); expect(tx.agentJob.create).not.toHaveBeenCalled();
    const { publishBusinessEvent } = await import('../../events/businessEventBus'); expect(publishBusinessEvent).not.toHaveBeenCalled();
  });
  it('normal creation never consumes an available exception which the credit gate did not use', async () => {
    const exc = makeException({ scope: { targetType: 'Relation', targetId: 'REL__F', action: 'order:create' } });
    const { prisma, tx, dr013ExceptionRequest } = makePrisma({ exceptions: [exc] });
    expect((await createOrderServiceV2(prisma).createOrder(ACTOR, { customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric', quantity: 1000, customerRelationId: 'REL__F', dueDate: '2099-01-01', quoteAmount: 1000 })).ok).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled(); expect(tx.$queryRaw).not.toHaveBeenCalled(); expect(dr013ExceptionRequest.updateMany).not.toHaveBeenCalled();
    expect(exc.attachments.scope.usedCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// P1-2（DE-5）信用例外入口
// ═══════════════════════════════════════════════════════════════
describe('P1-2（DE-5）credit_exemption 例外类别', () => {
  it('EXCEPTION_CATEGORIES 含 credit_exemption（例外申请入口不再 400 非法类别）', () => {
    expect(EXCEPTION_CATEGORIES).toContain('credit_exemption');
  });
});

describe('P1-2（DE-5）信用阻断自动发起例外申请', () => {
  it('Frozen 客户确认被阻断：自动发起 credit_exemption 例外申请 + 审批单 id 透传（DE-6）', async () => {
    const { prisma, tx, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(r.error!.approvalRequestId).toBe(MOCK_APPROVAL_ID);
    expect(r.error!.message).toContain('信用例外');
    // 例外申请落库：类别 credit_exemption + scope 精确匹配 Order/ORD__1/order:confirm
    expect(dr013ExceptionRequest.create).toHaveBeenCalledTimes(1);
    const created = dr013ExceptionRequest.create.mock.calls[0][0].data;
    expect(created.exceptionCategory).toBe('credit_exemption');
    expect(created.approvalRequestId).toBe(MOCK_APPROVAL_ID);
    expect(created.attachments.scope.targetType).toBe('Order');
    expect(created.attachments.scope.targetId).toBe('ORD__1');
    expect(created.attachments.scope.action).toBe('order:confirm');
    expect(created.attachments.scope.maxUses).toBe(1);
    expect(created.exceptionReason.length).toBeGreaterThanOrEqual(30);
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('生效例外（ReviewerApproved + 未过期）→ 信用门禁放行，确认成功后核销一次性例外', async () => {
    const exc = makeException();
    const { prisma, tx, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [exc] });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(true);
    expect(tx.order.update).toHaveBeenCalledTimes(1);
    // 不重复发起申请；核销走 dr013ExceptionRequest.update（usedCount 递增 + Consumed）
    expect(dr013ExceptionRequest.create).not.toHaveBeenCalled();
    expect(dr013ExceptionRequest.update).toHaveBeenCalled();
    const consumeUpdate = dr013ExceptionRequest.update.mock.calls.find(
      (c: any) => c[0]?.data?.attachments?.scope?.usedCount === 1,
    );
    expect(consumeUpdate).toBeTruthy();
    expect(consumeUpdate![0].data.status).toBe('Consumed');
  });

  it('过期例外（validUntil 已过）→ 不放行：惰性过期落库 + 重新自动发起新申请', async () => {
    const expired = makeException({
      id: 'EXC__OLD',
      scope: { validUntil: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
    });
    const { prisma, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [expired] });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    // 过期例外惰性落库 Expired
    const expireUpdate = dr013ExceptionRequest.update.mock.calls.find(
      (c: any) => c[0]?.data?.status === 'Expired',
    );
    expect(expireUpdate).toBeTruthy();
    // 重新自动发起新例外申请（审批单 id 透传）
    expect(dr013ExceptionRequest.create).toHaveBeenCalledTimes(1);
    expect(r.error!.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('审批中例外（Pending 未获批）→ 阻断且不重复发起，提示审批中', async () => {
    const pending = makeException({ status: 'Pending', approvalRequestId: 'ar_pend' });
    const { prisma, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT, exceptions: [pending] });
    const r = await transitionOrderStatus({ prisma, orderId: 'ORD__1', toStatus: 'Confirmed', actorId: 'user_1' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(r.error!.message).toContain('审批中');
    expect(dr013ExceptionRequest.create).not.toHaveBeenCalled();
  });

  it('V2 建单信用阻断 → 自动发起 credit_exemption（scope=Relation/order:create）+ 审批单 id 透传', async () => {
    const { prisma, dr013ExceptionRequest } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, {
      customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
      quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
      customerRelationId: 'REL__F',
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(r.error!.approvalRequestId).toBe(MOCK_APPROVAL_ID);
    expect(prisma.order.create).not.toHaveBeenCalled();
    const created = dr013ExceptionRequest.create.mock.calls[0][0].data;
    expect(created.exceptionCategory).toBe('credit_exemption');
    expect(created.attachments.scope.targetType).toBe('Relation');
    expect(created.attachments.scope.targetId).toBe('REL__F');
    expect(created.attachments.scope.action).toBe('order:create');
  });
});

// ═══════════════════════════════════════════════════════════════
// P1-3（DE-6）审批单 id HTTP 透传契约
// ═══════════════════════════════════════════════════════════════
describe('P1-3（DE-6）信用门禁 approvalRequestId HTTP 透传', () => {
  it('V1 POST /api/v1/orders/:id/status-transition → 403 + error.approvalRequestId', async () => {
    const { prisma } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .post('/api/v1/orders/ORD__1/status-transition')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ toStatus: 'Confirmed' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CREDIT_FROZEN_60_DAYS');
    expect(res.body.error.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('V2 PATCH /api/v2/orders/:id/status → 403 + body.approvalRequestId', async () => {
    const { prisma } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
    const app = express();
    app.use(express.json());
    app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .patch('/api/v2/orders/ORD__1/status')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'Confirmed' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CREDIT_FROZEN_60_DAYS');
    expect(res.body.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('V2 POST /api/v2/orders Frozen 建单 → 403 + body.approvalRequestId', async () => {
    const { prisma } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
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
    expect(res.body.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });

  it('V1 PATCH /api/v1/orders/batch-status → skipped 项携带 approvalRequestId', async () => {
    const { prisma } = makePrisma({ creditLimit: FROZEN_CREDIT_LIMIT });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app)
      .patch('/api/v1/orders/batch-status')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ids: ['ORD__1'], toStatus: 'Confirmed' });
    expect(res.status).toBe(200);
    const row = res.body.updated?.[0];
    expect(row.skipped).toBe('CREDIT_FROZEN_60_DAYS');
    expect(row.approvalRequestId).toBe(MOCK_APPROVAL_ID);
  });
});
