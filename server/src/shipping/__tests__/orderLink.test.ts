import { describe, expect, it, vi } from 'vitest';
import { deriveOrderStatusFromShipment, linkOrderStatusFromShipment, VALID_ORDER_STATUSES } from '../orderLinkService';
import { authHeader } from '../../__tests__/authTestHelper';

// ============================================================================
// task ERP-P1-order-shipment-status-link-foundation: 纯函数 + 集成测试
// ============================================================================

describe('task order-shipment-link: deriveOrderStatusFromShipment 映射规则', () => {
  it('Shipment Shipped → Order Shipping', () => {
    expect(deriveOrderStatusFromShipment('Shipped')).toBe('Shipping');
  });
  it('Shipment Delivered → Order Delivered', () => {
    expect(deriveOrderStatusFromShipment('Delivered')).toBe('Delivered');
  });
  it('Shipment Booked/Loading/Shipped/Arrived/Cleared → Order Shipping', () => {
    expect(deriveOrderStatusFromShipment('Booked')).toBe('Shipping');
    expect(deriveOrderStatusFromShipment('Loading')).toBe('Shipping');
    expect(deriveOrderStatusFromShipment('Shipped')).toBe('Shipping');
    expect(deriveOrderStatusFromShipment('Arrived')).toBe('Shipping');
    expect(deriveOrderStatusFromShipment('Cleared')).toBe('Shipping');
  });
  it('Shipment Draft/Cancelled → null（不联动）', () => {
    expect(deriveOrderStatusFromShipment('Draft')).toBeNull();
    expect(deriveOrderStatusFromShipment('Cancelled')).toBeNull();
  });
});

describe('task order-shipment-link: VALID_ORDER_STATUSES', () => {
  it('含 6 值', () => {
    expect(VALID_ORDER_STATUSES).toEqual(['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert']);
  });
});

describe('task order-shipment-link: linkOrderStatusFromShipment 事务内联动', () => {
  function makeTx(order: any) {
    return {
      order: { findUnique: vi.fn().mockResolvedValue(order), update: vi.fn().mockResolvedValue({}) },
      // ★ C3：出运事实 → 订单行已出运量快照（溢短装面板数据源）需读 orderLine
      orderLine: {
        findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}),
        // 短装/数量门禁：本行 1000 米落出厂默认 1000–3000 档 ⇒ ±3%
        findUnique: vi.fn().mockResolvedValue({
          id: 'L1', orderId: 'O1', itemNo: '001', unit: null, quantity: 1000,
          shipmentQuantity: 1000, tolerancePercent: null, toleranceSource: null,
        }),
      },
      systemConfig: { findUnique: vi.fn().mockResolvedValue(null) }, // ⇒ 落出厂默认
      relation: { findUnique: vi.fn().mockResolvedValue(null) },
      orderStatusTransition: { create: vi.fn().mockResolvedValue({}) },
    } as any;
  }

  it('Shipment Shipped → Order Pending → Shipping（写 transition + update）', async () => {
    const tx = makeTx({ id: 'O1', status: 'Pending', deletedAt: null });
    const r = await linkOrderStatusFromShipment(tx, 'O1', 'Shipped');
    expect(r.ok).toBe(true);
    expect(r.fromStatus).toBe('Pending');
    expect(r.toStatus).toBe('Shipping');
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'O1' },
      data: expect.objectContaining({ status: 'Shipping' }),
    }));
  });

  it('Shipment Delivered → Order Shipping → Delivered', async () => {
    const tx = makeTx({ id: 'O1', status: 'Shipping', deletedAt: null });
    const r = await linkOrderStatusFromShipment(tx, 'O1', 'Delivered');
    expect(r.ok).toBe(true);
    expect(r.toStatus).toBe('Delivered');
  });

  it('Shipment Booked → Order Confirmed → Shipping（create default Booked 联动）', async () => {
    const tx = makeTx({ id: 'O1', status: 'Confirmed', deletedAt: null });
    const r = await linkOrderStatusFromShipment(tx, 'O1', 'Booked');
    expect(r.ok).toBe(true);
    expect(r.toStatus).toBe('Shipping');
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
  });

  it('order 已在目标 status → 幂等 skipped', async () => {
    const tx = makeTx({ id: 'O1', status: 'Shipping', deletedAt: null });
    const r = await linkOrderStatusFromShipment(tx, 'O1', 'Shipped');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('order 不存在 → throw ORDER_NOT_FOUND', async () => {
    const tx = makeTx(null);
    await expect(linkOrderStatusFromShipment(tx, 'OX', 'Shipped')).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('order 已删 → throw ORDER_NOT_FOUND', async () => {
    const tx = makeTx({ id: 'O1', status: 'Pending', deletedAt: 123 });
    await expect(linkOrderStatusFromShipment(tx, 'O1', 'Shipped')).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('order 终态 Delivered → 联动 Shipped → throw ORDER_TERMINAL', async () => {
    const tx = makeTx({ id: 'O1', status: 'Delivered', deletedAt: null });
    await expect(linkOrderStatusFromShipment(tx, 'O1', 'Shipped')).rejects.toMatchObject({ code: 'ORDER_TERMINAL' });
  });

  it('order 终态 Alert → throw ORDER_TERMINAL', async () => {
    const tx = makeTx({ id: 'O1', status: 'Alert', deletedAt: null });
    await expect(linkOrderStatusFromShipment(tx, 'O1', 'Shipped')).rejects.toMatchObject({ code: 'ORDER_TERMINAL' });
  });

  it('order 非法当前 status → throw INVALID_CURRENT_ORDER_STATUS', async () => {
    const tx = makeTx({ id: 'O1', status: 'Bogus', deletedAt: null });
    await expect(linkOrderStatusFromShipment(tx, 'O1', 'Shipped')).rejects.toMatchObject({ code: 'INVALID_CURRENT_ORDER_STATUS' });
  });

  it('order 已 Shipping + Shipment Shipped → 幂等 skipped', async () => {
    const tx = makeTx({ id: 'O1', status: 'Shipping', deletedAt: null });
    const r = await linkOrderStatusFromShipment(tx, 'O1', 'Shipped');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('缺失 orderId → MISSING_ORDER', async () => {
    const tx = makeTx(null);
    const r = await linkOrderStatusFromShipment(tx, '', 'Shipped');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('MISSING_ORDER');
  });
});

// ============================================================================
// 集成测试：shipping route POST 创建 shipment → order 联动
// ============================================================================
import express from 'express';
import request from 'supertest';
import { createShippingRouter } from '../route';

function makeShippingTx(opts: { order?: any; shipmentFind?: any; txFail?: boolean }) {
  let shipmentFind = opts.shipmentFind ?? null;
  const shipmentCreate = vi.fn().mockImplementation(async ({ data }: any) => {
    // A created row is visible to the real stock/source consumer in this TX.
    shipmentFind = { id: data.id || 'S1', shipmentNumber: data.shipmentNumber, type: data.type,
      status: data.status, orderId: data.orderId, createdAt: data.createdAt, updatedAt: data.updatedAt };
    return shipmentFind;
  });
  const orderFind = vi.fn().mockResolvedValue(opts.order === undefined ? { id: 'O1', status: 'Pending', deletedAt: null } : opts.order);
  const orderUpdate = vi.fn().mockResolvedValue({});
  const orderStatusTransitionCreate = vi.fn().mockResolvedValue({});
  const tx = {
    ...ordinaryClaimSource(),
    shipment: { create: shipmentCreate, findUnique: vi.fn().mockImplementation(async ({ where }: any) => shipmentFind?.id === where.id ? shipmentFind : null), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, shipmentNumber: 'SHP001' })) },
    shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
    order: { findUnique: orderFind, update: orderUpdate },
    orderLine: { findMany: vi.fn().mockResolvedValue([]) }, // C4：首装自动带出装运行——空订单行跳过
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]) }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
    shipmentOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    stockMovement: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    orderStatusTransition: { create: orderStatusTransitionCreate },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const $transaction = vi.fn(async (fn: any) => {
    if (opts.txFail) throw new Error('TX_FAIL');
    return fn(completeOrdinaryShippingTx(tx));
  });
  return { tx, $transaction };
}

// Storage seams only: real consumer/source-lock and current-permission loaders
// run against an ordinary shipment with no claim, PB, SPA, release, or S/S rows.
// These substitutes do not prove PostgreSQL locks, grants, or rollback.
function ordinaryClaimSource() {
  const currentUser = { id: 'u_owner', status: 'active', deletedAt: null,
    primaryDeptId: null, primaryDepartment: null,
    roles: [{ roleId: 'role-super-admin', departmentId: null, role: {
      id: 'role-super-admin', isSystem: true,
      permissions: ['orders:read', 'shipments:read', 'shipments:write'].map(scope => ({ permission: { scope } })),
    } }],
  };
  const currentAccount = vi.fn(async ({ where }: any) => where.id === currentUser.id ? currentUser : null);
  return {
    userAccount: { findFirst: currentAccount, findUnique: currentAccount },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    productionBatch: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    shipmentProductionAllocation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    shipmentOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    releaseScope: { findMany: vi.fn().mockResolvedValue([]) },
    sample: { findMany: vi.fn().mockResolvedValue([]) },
    claimDisposition: { findMany: vi.fn().mockResolvedValue([]) },
    repairWorkOrder: { findMany: vi.fn().mockResolvedValue([]) },
    // Storage seam only: the real transaction outbox helper persists the event.
    // Reject an incomplete fake Shipment row rather than accept an invalid date.
    agentJob: { create: vi.fn(async ({ data }: any) => {
      if (!(data.scheduledAt instanceof Date) || !Number.isFinite(data.scheduledAt.getTime())) {
        throw new Error('AgentJob fixture requires the persisted Shipment updatedAt');
      }
      return { ...data };
    }) },
  };
}

function completeOrdinaryShippingTx(tx: any) {
  // Fresh scoped reads and lock results refer to each test's actual parent,
  // including its original missing/deleted/terminal cases.
  tx.order.findFirst = vi.fn(async ({ where }: any) => {
    const row = await tx.order.findUnique({ where: { id: where.id } });
    return row && row.id === where.id && row.deletedAt == null ? row : null;
  });
  tx.$queryRaw = vi.fn(async (query: any) => {
    const id = query.values?.[0];
    const delegate = query.text.includes('FROM "Order"') ? tx.order
      : query.text.includes('FROM "Shipment"') ? tx.shipment : null;
    const row = delegate ? await delegate.findUnique({ where: { id } }) : null;
    return row?.id === id ? [{ id }] : [];
  });
  return tx;
}

describe('task order-shipment-link: shipping route POST 创建 → order 联动', () => {
  it('创建 Shipped shipment + orderId → order Pending→Shipping（同事务）', async () => {
    const { tx, $transaction } = makeShippingTx({ order: { id: 'O1', status: 'Pending', deletedAt: null } });
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', orderId: 'O1', status: 'Shipped', atd: '2026-10-08' });
    expect(res.status).toBe(201);
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'O1' }, data: expect.objectContaining({ status: 'Shipping' }) }));
  });

  it('创建 Booked shipment（default）+ orderId → order Confirmed→Shipping（联动）', async () => {
    const { tx, $transaction } = makeShippingTx({ order: { id: 'O1', status: 'Confirmed', deletedAt: null } });
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S2', type: 'Air', shippingMethod: 'Air', orderId: 'O1', status: 'Booked' });
    expect(res.status).toBe(201);
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalled();
  });

  it('创建 shipment 无 orderId → 不触发联动（正常）', async () => {
    const { tx, $transaction } = makeShippingTx({});
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S3', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked' });
    expect(res.status).toBe(201);
    expect(tx.order.findUnique).not.toHaveBeenCalled();
  });

  it('创建 shipment orderId 指向终态 order → 400 ORDER_TERMINAL', async () => {
    const { $transaction } = makeShippingTx({ order: { id: 'O1', status: 'Delivered', deletedAt: null } });
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S4', type: 'Ocean', shippingMethod: 'FCL', orderId: 'O1', status: 'Shipped', atd: '2026-10-08' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ORDER_TERMINAL');
  });

  it('创建 shipment orderId 指向不存在 order → 404 ORDER_NOT_FOUND', async () => {
    const { $transaction } = makeShippingTx({ order: null });
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S5', type: 'Ocean', shippingMethod: 'FCL', orderId: 'OX', status: 'Shipped', atd: '2026-10-08' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('事务失败（联动 rollback）→ 500 不伪成功', async () => {
    const { $transaction } = makeShippingTx({ order: { id: 'O1', status: 'Pending', deletedAt: null }, txFail: true });
    const prisma = { $transaction } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S6', type: 'Ocean', shippingMethod: 'FCL', orderId: 'O1', status: 'Shipped', atd: '2026-10-08' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
  });
});

describe('task order-shipment-link: shipping route PATCH 状态变更 → order 联动', () => {
  it('PATCH shipment Booked→Shipped + orderId → order 联动', async () => {
    const tx = {
      ...ordinaryClaimSource(),
      // ★ 2026-09-29 晚：`findMany` 给短装门禁的"该行还有没有未发运的票"用
      shipment: { findUnique: vi.fn().mockResolvedValue({ id: 'S1', status: 'Booked', shipmentNumber: 'SHP001', orderId: 'O1' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: data.status, shipmentNumber: 'SHP001', orderId: 'O1' })), findMany: vi.fn().mockResolvedValue([]) },
      shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
      /**
       * DR-016 合票分配（本用例无合票）+ ★ 2026-09-29 晚的**出运数量完整性门禁**：
       * 一张没有任何明细的票现在不许确认出运（使用方口径）⇒ 本用例要走到 200，就必须给一条
       * 已填实际量的明细（本行 1000 米全发 ⇒ 既不缺数据、也不短装）。
       */
      shipmentOrderAllocation: {
        findMany: vi.fn().mockResolvedValue([{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 1000 }]),
      },
      shipmentLine: { findMany: vi.fn().mockResolvedValue([]) }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
      stockMovement: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'O1', status: 'Confirmed', deletedAt: null }), update: vi.fn().mockResolvedValue({}) },
      // ★ C3：出运事实 → 订单行已出运量快照（溢短装面板数据源）需读 orderLine
      orderLine: {
        findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}),
        // ★ 2026-09-29 晚：短装/数量完整性门禁要按行读合同量与已出运量（本行 1000 米全发）
        findUnique: vi.fn().mockResolvedValue({
          id: 'L1', orderId: 'O1', itemNo: '001', unit: null, quantity: 1000,
          shipmentQuantity: 1000, tolerancePercent: null, toleranceSource: null,
        }),
      },
      systemConfig: { findUnique: vi.fn().mockResolvedValue(null) }, // ⇒ 落出厂默认
      relation: { findUnique: vi.fn().mockResolvedValue(null) },
      orderStatusTransition: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(completeOrdinaryShippingTx(tx))) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader()).send({ status: 'Shipped', atd: '2026-10-08' });
    expect(res.status).toBe(200);
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalled();
  });

  it('PATCH legacy shipment Cleared→Delivered is rejected; it does not complete the order', async () => {
    const tx = {
      ...ordinaryClaimSource(),
      shipment: { findUnique: vi.fn().mockResolvedValue({ id: 'S1', status: 'Cleared', shipmentNumber: 'SHP001', orderId: 'O1' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: data.status, shipmentNumber: 'SHP001', orderId: 'O1', updatedAt: data.updatedAt })) },
      shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'O1', status: 'Shipping', deletedAt: null }), update: vi.fn().mockResolvedValue({}) },
      // ★ C3：出运事实 → 订单行已出运量快照（溢短装面板数据源）需读 orderLine
      orderLine: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
      orderStatusTransition: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn().mockResolvedValue({}) },
      entityLink: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(completeOrdinaryShippingTx(tx))) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader()).send({ status: 'Delivered' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('PATCH legacy shipment Arrived→Cleared is rejected before touching a terminal order', async () => {
    // 到港后的历史状态不再属于 MVP 可写流程；不应借它推进订单状态。
    const tx = {
      ...ordinaryClaimSource(),
      shipment: { findUnique: vi.fn().mockResolvedValue({ id: 'S1', status: 'Arrived', shipmentNumber: 'SHP001', orderId: 'O1' }), update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: data.status, shipmentNumber: 'SHP001', orderId: 'O1' })) },
      shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'O1', status: 'Delivered', deletedAt: null }), update: vi.fn() },
      // ★ C3：出运事实 → 订单行已出运量快照（溢短装面板数据源）需读 orderLine
      orderLine: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
      orderStatusTransition: { create: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      entityReference: { upsert: vi.fn() },
      entityLink: { upsert: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(completeOrdinaryShippingTx(tx))) } as any;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader()).send({ status: 'Cleared' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

/** Actual service adapter; SQL rollback is deliberately reserved for real PG probes. */
describe('shipping rollback consumes an exact Confirmed credit pass using its supplied transaction', () => {
  function transaction() {
    const exception = { id: 'EXC_LINK', exceptionNumber: 'EXC_LINK', exceptionCategory: 'credit_exemption',
      status: 'ReviewerApproved', deletedAt: null, approvalRequestId: 'AR_LINK', attachments: { files: [], scope: {
        targetType: 'Order', targetId: 'O_LINK', action: 'order:confirm', responsibleOwnerId: 'u_logistics',
        validUntil: new Date(Date.now() + 60_000).toISOString(), maxUses: 1, usedCount: 0, consumptions: [],
      } } };
    return { userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u_logistics', status: 'active', deletedAt: null, roles: [] }) },
      userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'O_LINK', status: 'Shipping', deletedAt: null,
      customerRelationId: 'REL_LINK', type: 'Fabric', businessLine: 'fabric', quantity: 10_000, quoteAmount: 1000,
      paymentInstrument: 'T/T', moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
        snapshotAt: '2026-01-01T00:00:00.000Z', configId: null, source: 'fallback_constant' } }), update: vi.fn().mockResolvedValue({}) },
      relation: { findUnique: vi.fn().mockResolvedValue(null) },
      customerTier: { findFirst: vi.fn().mockResolvedValue(null) },
      orderLine: { findMany: vi.fn().mockResolvedValue([{ id: 'L_LINK', orderId: 'O_LINK', lineNumber: 1, quantity: 10000, unit: 'M' }]) },
      orderStatusTransition: { findMany: vi.fn().mockResolvedValue([{ fromStatus: 'Confirmed' }]), create: vi.fn().mockResolvedValue({}) },
      shipment: { findMany: vi.fn().mockResolvedValue([]) }, shipmentOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      creditLimit: { findFirst: vi.fn().mockResolvedValue({ relationId: 'REL_LINK', status: 'Frozen', totalLimit: 100_000, usedAmount: 0, currency: 'USD' }) },
      invoice: { findMany: vi.fn().mockResolvedValue([]) },
      dr013ExceptionRequest: { findMany: vi.fn().mockResolvedValue([exception]), findUnique: vi.fn().mockResolvedValue(exception),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'AUDIT_LINK' }) }, $queryRaw: vi.fn().mockResolvedValue([{ id: 'EXC_LINK' }]),
    } as any;
  }
  it('legitimate cancellation rollback locks and consumes once, preserving the actual logistics actor', async () => {
    const tx = transaction();
    const result = await linkOrderStatusFromShipment(tx, 'O_LINK', 'Cancelled', { operator: 'u_logistics', shipmentId: 'S_LINK' });
    expect(result).toMatchObject({ ok: true, toStatus: 'Confirmed', rollbackBasis: 'history' });
    // MOQ separately locks the customer basis; assert the credit pass lock itself.
    const creditLocks = tx.$queryRaw.mock.calls.filter(([query]: any[]) => (Array.isArray(query) ? query.join('') : query.text).includes('Dr013ExceptionRequest'));
    expect(creditLocks).toHaveLength(1);
    expect(creditLocks[0][1]).toBe('EXC_LINK');
    expect(tx.dr013ExceptionRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      actorId: 'u_logistics', action: 'dr013_exception_consumed', targetId: 'EXC_LINK',
    }) }));
  });
  it('failed mandatory consumption audit throws to the caller instead of reporting a successful rollback', async () => {
    const tx = transaction(); tx.auditLog.create.mockRejectedValue(Error('adapter audit fault'));
    await expect(linkOrderStatusFromShipment(tx, 'O_LINK', 'Cancelled', { operator: 'u_logistics', shipmentId: 'S_LINK' }))
      .rejects.toMatchObject({ name: 'CreditExceptionConsumptionError', code: 'EXCEPTION_CONSUME_FAILED', statusCode: 500 });
    expect(tx.dr013ExceptionRequest.updateMany).toHaveBeenCalledTimes(1);
  });
});
