/**
 * 端到端集成测试：订单履约全链路 (Order → Production → Inspection → Shipment → Customs)
 *
 * 验证服务间协作正确性：
 *   1. orderServiceV2.createOrder → 创建订单
 *   2. orderServiceV2.transitionStatus → 状态机流转 Pending → Confirmed → Production
 *   3. traceabilityService.trace orderFulfillment → 溯源验证生产阶段+检验+发货+报关
 *
 * 核心验证点：
 *   - 订单状态机合法转换
 *   - 状态转换写状态记录
 *   - 溯源链路 nodes/edges 完整性
 *   - scope 行级权限在多服务间一致
 *
 * 使用共享内存模型替身：不证明 PostgreSQL 回滚/锁，也不证明真实岗位权限和下游执行。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../auth/permissionService', () => ({
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })),
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

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...args: any[]) => console.error('LOGGER.ERROR:', ...args), debug: vi.fn() },
}));

import { createOrderServiceV2 } from '../../orders/orderServiceV2';
import { createTraceabilityService } from '../../traceability/traceabilityService';

// ── helpers ──
const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], role: 'admin' } as any;

function createSharedPrisma() {
  const orders = new Map<string, any>();
  const transitions = new Map<string, any>();
  const stages = new Map<string, any>();
  const inspections = new Map<string, any>();
  const shipments = new Map<string, any>();
  const customs = new Map<string, any>();
  const agentJobs = new Map<string, any>();

  const prisma: any = {
    _stores: { orders, transitions, stages, inspections, shipments, customs, agentJobs },

    order: {
      findFirst: vi.fn(async ({ where }: any) => {
        const o = orders.get(where.id);
        if (!o) return null;
        return { ...o, lines: o.lines || [] };
      }),
      // V1 transitionOrderStatus 使用 findUnique（DE-2/DE-4 委托路径）
      findUnique: vi.fn(async ({ where }: any) => {
        const o = orders.get(where.id);
        if (!o) return null;
        return { ...o, lines: o.lines || [] };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(orders.values());
        if (where?.customerRelationId) list = list.filter((o) => o.customerRelationId === where.customerRelationId);
        if (where?.deletedAt === null) list = list.filter((o) => !o.deletedAt);
        if (where?.status) list = list.filter((o) => o.status === where.status);
        return list;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `ORD__${Date.now()}`;
        const row = { ...data, id };
        orders.set(id, row);
        return { ...row, lines: row.lines || [] };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const o = orders.get(where.id);
        if (!o) throw new Error('Order not found');
        const updated = { ...o, ...data };
        orders.set(where.id, updated);
        return { ...updated, lines: updated.lines || [] };
      }),
      count: vi.fn(async () => orders.size),
    },

    orderStatusTransition: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `OST__${Date.now()}`;
        const row = { ...data, id };
        transitions.set(id, row);
        return row;
      }),
    },

    // 状态转换事务内写入事件队列；保留写入事实供断言，不把持久化函数 mock 成空操作。
    agentJob: {
      create: vi.fn(async ({ data }: any) => {
        if (agentJobs.has(data.id)) throw new Error(`AgentJob already exists: ${data.id}`);
        const row = { ...data };
        agentJobs.set(row.id, row);
        return row;
      }),
    },

    productionStage: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(stages.values());
        if (where?.orderId) list = list.filter((s) => s.orderId === where.orderId);
        return list;
      }),
    },

    inspectionReport: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(inspections.values());
        if (where?.orderId) list = list.filter((i) => i.orderId === where.orderId);
        return list;
      }),
    },

    shipment: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(shipments.values());
        if (where?.orderId) list = list.filter((s) => s.orderId === where.orderId);
        return list;
      }),
    },

    customsDeclaration: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(customs.values());
        if (where?.orderId) list = list.filter((c) => c.orderId === where.orderId);
        return list;
      }),
    },

    // $transaction: 将回调以 prisma 自身作为 tx 执行
    $transaction: vi.fn(async (fn: any) => fn(prisma)),

    // 其他模型占位
    quotation: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]) },
    // 信用门禁（createOrder fail-closed 依赖）：无额度档案 = 未启用信用管理 → 不阻断
    creditLimit: { findFirst: vi.fn().mockResolvedValue(null) },
    // 明确表示未配置/未命中；MOQ 判定仍调用真实服务及其现有兜底，不伪造阈值或豁免。
    moqThresholdConfig: { findFirst: vi.fn().mockResolvedValue(null) },
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
    // 状态机事务副作用（DE-2/DE-4 委托 V1 路径）：EntityReference/EntityLink 同步 + 路由审计日志
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ id: `AUDIT_${Date.now()}`, ...data })) },
  };

  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// 端到端：订单履约全链路
// ═══════════════════════════════════════════════════════════════
describe('端到端：订单履约全链路', () => {
  it('完整流程：Create Order → Transition Pending→Confirmed→Production → Trace', async () => {
    const prisma = createSharedPrisma();
    const orderSvc = createOrderServiceV2(prisma);

    // ── 1. 创建订单 ──
    const createResult = await orderSvc.createOrder(ACTOR, {
      customer: 'Test Buyer Co.',
      product: 'Cotton Twill',
      type: 'fabric',
      quantity: 1000,
      quoteAmount: 15000,
      currency: 'USD',
      dueDate: '2026-10-30',
      customerRelationId: 'REL__1',
    });
    expect(createResult.ok).toBe(true);
    let orderId = '';
    if (createResult.ok) {
      expect(createResult.data.status).toBe('Pending');
      orderId = createResult.data.id;
    } else {
      throw new Error('Order creation failed');
    }

    // ── 2. 状态机流转：Pending → Confirmed ──
    const r1 = await orderSvc.transitionStatus(ACTOR, orderId, 'Confirmed', '客户确认');
    expect(r1.ok, `Pending→Confirmed 首阻断：${JSON.stringify(r1.ok ? null : r1.error)}`).toBe(true);
    if (r1.ok) expect(r1.data.status).toBe('Confirmed');

    // ── 3. 状态机流转：Confirmed → Production ──
    const r2 = await orderSvc.transitionStatus(ACTOR, orderId, 'Production', '开始生产');
    expect(r2.ok, `Confirmed→Production 首阻断：${JSON.stringify(r2.ok ? null : r2.error)}`).toBe(true);
    if (r2.ok) expect(r2.data.status).toBe('Production');

    // 两次转换的时间线和事务内事件必须关联同一订单、认证操作人和转换记录。
    const transitionRows = Array.from(prisma._stores.transitions.values()) as any[];
    expect(transitionRows.map((t) => [t.fromStatus, t.toStatus])).toEqual([
      ['Pending', 'Confirmed'], ['Confirmed', 'Production'],
    ]);
    const jobs = Array.from(prisma._stores.agentJobs.values()) as any[];
    expect(jobs.filter((j) => j.jobType === 'bev:OrderStatusChanged')).toHaveLength(2);
    expect(jobs.filter((j) => j.jobType === 'bev:OrderConfirmed')).toHaveLength(1);
    for (const job of jobs) {
      expect(job.status).toBe('queued');
      expect(job.payload).toEqual(expect.objectContaining({
        id: job.id, sourceEntityType: 'Order', sourceEntityId: orderId,
        orderId, actorId: ACTOR.userId,
      }));
      const transition = transitionRows.find((t) => t.id === job.payload.transactionId);
      expect(transition).toBeDefined();
      expect(transition.operator).toBe(ACTOR.userId);
      expect(job.payload.payload.transitionId).toBe(transition.id);
      expect(job.payload.payload.fromStatus).toBe(transition.fromStatus);
    }

    // ── 4. 模拟添加生产阶段、检验、发货、报关 ──
    prisma._stores.stages.set('STG__1', {
      id: 'STG__1', orderId, stageKey: 'weaving', status: 'completed',
      seq: 1, startedAt: '2026-08-01', completedAt: '2026-08-10', signedBy: 'u1',
    });
    prisma._stores.stages.set('STG__2', {
      id: 'STG__2', orderId, stageKey: 'dyeing', status: 'in_progress',
      seq: 2, startedAt: '2026-08-11', completedAt: null, signedBy: 'u2',
    });
    prisma._stores.inspections.set('INS__1', {
      id: 'INS__1', orderId, result: 'PASS', passRate: 98, defectRate: 2,
      inspector: 'u3', inspectedAt: '2026-08-12',
    });
    prisma._stores.shipments.set('SHP__1', {
      id: 'SHP__1', orderId, shipmentNumber: 'SHP-202608-001', status: 'Pending',
      shipDate: null, eta: null, carrier: null, trackingNo: null,
    });
    prisma._stores.customs.set('CD__1', {
      id: 'CD__1', orderId, declarationNumber: 'CD-202608-001', status: 'Draft',
      customsType: 'export', declaredDate: null, releasedDate: null,
    });

    // ── 5. 溯源：订单履约链 ──
    const traceSvc = createTraceabilityService(prisma);
    const traceResult = await traceSvc.trace(ACTOR, 'orderFulfillment', orderId);

    expect(traceResult.scenario).toBe('orderFulfillment');
    expect(traceResult.rootType).toBe('Order');
    expect(traceResult.rootId).toBe(orderId);
    // nodes 包含 Order + 2 stages + 1 inspection + 1 shipment + 1 customs = 6
    expect(traceResult.nodes).toHaveLength(6);
    const types = traceResult.nodes.map((n) => n.type);
    expect(types).toContain('Order');
    expect(types).toContain('ProductionStage');
    expect(types).toContain('Inspection');
    expect(types).toContain('Shipment');
    expect(types).toContain('Customs');
    // edges 5 条
    expect(traceResult.edges).toHaveLength(5);
    // summary
    expect(traceResult.summary.totalStages).toBe(2);
    expect(traceResult.summary.completedStages).toBe(1);
    expect(traceResult.summary.currentStage).toBe('dyeing');
    expect(traceResult.summary.inspectionCount).toBe(1);
    expect(traceResult.summary.lastInspectionResult).toBe('PASS');
  });

  it('非法状态转换被拒绝', async () => {
    const prisma = createSharedPrisma();
    const orderSvc = createOrderServiceV2(prisma);

    // 创建订单（初始状态 Pending）
    const createResult = await orderSvc.createOrder(ACTOR, {
      customer: 'Test Buyer Co.',
      product: 'Test',
      type: 'fabric',
      quantity: 500,
    });
    expect(createResult.ok).toBe(true);
    const orderId = createResult.ok ? createResult.data.id : '';

    // 尝试非法转换：Pending → Delivered（跳过 Confirmed/Production/Shipping）
    const r = await orderSvc.transitionStatus(ACTOR, orderId, 'Delivered', '跳过中间状态');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('未登录 actor 不能创建订单', async () => {
    const prisma = createSharedPrisma();
    const orderSvc = createOrderServiceV2(prisma);
    const r = await orderSvc.createOrder(null, { customer: 'X', product: 'Y', quantity: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('订单看板聚合', async () => {
    const prisma = createSharedPrisma();
    const orderSvc = createOrderServiceV2(prisma);

    // 创建多个不同状态的订单
    await orderSvc.createOrder(ACTOR, { customer: 'A', product: 'Fabric A', type: 'fabric', quantity: 1000 });
    await orderSvc.createOrder(ACTOR, { customer: 'B', product: 'Garment B', type: 'garment', quantity: 500 });

    const kanban = await orderSvc.getKanban(ACTOR);
    expect(kanban.ok).toBe(true);
    if (kanban.ok) {
      expect(kanban.data.total).toBeGreaterThanOrEqual(2);
      // 看板返回 statuses 数组
      expect(Array.isArray(kanban.data.statuses)).toBe(true);
    }
  });
});
