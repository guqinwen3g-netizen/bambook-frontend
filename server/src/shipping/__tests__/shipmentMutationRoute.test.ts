import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createShippingRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

/**
 * task ERP-P1-shipping-mutation-shared-service-foundation:
 * 覆盖 shipping route → shipmentMutationService 的事务/审计/联动契约。
 * 用 $transaction: (fn) => fn(tx) 透明穿透模式，验证 audit/sync/link reject → 事务回滚 → onDataChange 不触发。
 */

function makeApp(opts: {
  existingShipment?: any;
  auditFail?: boolean;
  syncFail?: boolean;
  linkFail?: boolean;
  order?: any;
  onDataChange?: any;
  shipmentCreateFail?: boolean;
  cleanupFail?: boolean;
  /** 已占用运单号（含软删直写行）——occupied 追平回归用 */
  occupiedShipmentNumbers?: string[];
} = {}) {
  const existing = opts.existingShipment ?? { id: 'SHP-1', shipmentNumber: 'SHP001', status: 'Booked' };
  const order = opts.hasOwnProperty('order') ? opts.order : { id: 'ORDER-1', status: 'Confirmed', deletedAt: null };

  const shipmentCreate = opts.shipmentCreateFail
    ? vi.fn().mockRejectedValue(new Error('DB_BOOM'))
    : vi.fn().mockImplementation(async ({ data }: any) => {
        const { createdAt, updatedAt, ...rest } = data;
        return { ...rest, id: data.id || 'SHP-NEW' };
      });
  const shipmentUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => {
    const { updatedAt, deletedAt, ...rest } = data;
    return { ...existing, ...rest, id: where.id };
  });
  const shipmentFindUnique = vi.fn().mockImplementation(async ({ where }: any) => {
    if (where.id === existing.id) return existing;
    return null;
  });
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });
  const entityRefUpsert = opts.syncFail
    ? vi.fn().mockRejectedValue(new Error('SYNC_BOOM'))
    : vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const entityLinkFindMany = vi.fn().mockResolvedValue([{ id: 'LINK-1' }]);
  const entityRefFindMany = vi.fn().mockResolvedValue([{ id: 'REF-1' }]);
  const entityLinkUpdate = opts.cleanupFail ? vi.fn().mockRejectedValue(new Error('CLEANUP_BOOM')) : vi.fn().mockResolvedValue({});
  const entityRefUpdate = vi.fn().mockResolvedValue({});
  const orderFindUnique = vi.fn().mockResolvedValue(order);
  const orderFindFirst = vi.fn().mockImplementation(async ({ where }: any) =>
    order && where.id === order.id && order.deletedAt == null ? order : null,
  );
  const orderUpdate = opts.linkFail
    ? vi.fn().mockRejectedValue(new Error('ORDER_BOOM'))
    : vi.fn().mockResolvedValue(order);
  const orderStatusTransitionCreate = vi.fn().mockResolvedValue({});
  const shipmentEventCreate = vi.fn().mockResolvedValue({});
  const shipmentEventFindMany = vi.fn().mockResolvedValue([]);

  // REQ2-20 第四例占位回归：occupied 追平回调查 shipment.findFirst（含软删直写行判定）
  const occupiedSet = new Set(opts.occupiedShipmentNumbers ?? []);
  const shipmentFindFirst = vi.fn().mockImplementation(async ({ where }: any) =>
    occupiedSet.has(where.shipmentNumber) ? { id: `OCC-${where.shipmentNumber}` } : null,
  );
  // BusinessSequence mock（stateful 递增，模拟 DB increment 语义；upsert 仅确保行存在）
  let seqCounter = 0;
  const businessSequence = {
    upsert: vi.fn().mockImplementation(async ({ create }: any) => ({ ...create, seq: seqCounter })),
    update: vi.fn().mockImplementation(async () => ({ seq: ++seqCounter })),
    findUnique: vi.fn().mockResolvedValue(null),
    deleteMany: vi.fn().mockResolvedValue({}),
  };

  // Storage-only account fixture for the actual current-account/permission
  // loaders. The JWT helper's u_owner has a canonical technical role and
  // explicit DB grants; neither consumer nor authorization code is mocked.
  // This does not prove real DB permissions, row locks, or transaction rollback.
  const currentUser = {
    id: 'u_owner', displayName: 'Synthetic shipping test account',
    status: 'active', deletedAt: null, primaryDeptId: null, primaryDepartment: null,
    roles: [{ roleId: 'role-super-admin', departmentId: null, role: {
      id: 'role-super-admin', isSystem: true,
      permissions: ['orders:read', 'shipments:read', 'shipments:write'].map(scope => ({ permission: { scope } })),
    } }],
  };
  const userAccount = {
    findFirst: vi.fn().mockImplementation(async ({ where }: any) => where.id === currentUser.id ? currentUser : null),
    // Actual L2 resolver reloads this same stored identity with findUnique.
    // It cannot authorize a different or soft-deleted fixture account.
    findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
      where.id === currentUser.id && where.deletedAt === null && currentUser.deletedAt === null ? currentUser : null),
  };
  const userPermissionOverrides = { findMany: vi.fn().mockResolvedValue([]) }; // No personal grants.

  const tx: any = {
    userAccount, userPermissionOverrides,
    // Original ordinary-shipment scenarios have no physical batches, release
    // scopes, or native S/S evidence. Empty delegates are real absent-source
    // answers, not absent-method fallbacks that select the legacy consumer.
    productionBatch: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    shipmentProductionAllocation: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    releaseScope: { findMany: vi.fn().mockResolvedValue([]) },
    sample: { findMany: vi.fn().mockResolvedValue([]) },
    // Transparent SQL lock storage seam; production still executes the source
    // and Shipment lock calls. These tests do not establish lock concurrency.
    $queryRaw: vi.fn().mockImplementation(async (query: any) => {
      const id = query.values?.[0];
      if (query.text.includes('FROM "Order"')) return order && id === order.id ? [{ id: order.id }] : [];
      if (query.text.includes('FROM "Shipment"')) return id === existing.id ? [{ id: existing.id }] : [];
      return [];
    }),
    // Complete source-detection seam: these original cases are ordinary shipments.
    claimDisposition: { findMany: async () => [] },
    repairWorkOrder: { findMany: async () => [] },
    // ★ 2026-09-29 晚：`findMany` 给短装门禁的"该行还有没有未发运的票"
    shipment: { create: shipmentCreate, update: shipmentUpdate, findUnique: shipmentFindUnique, findFirst: shipmentFindFirst, findMany: vi.fn().mockResolvedValue([]) },
    businessSequence,
    shipmentEvent: { create: shipmentEventCreate, findMany: shipmentEventFindMany },
    /**
     * DR-016 合票分配（本组用例无合票）+ ★ 2026-09-29 晚的**出运数量完整性门禁**：
     * 一张没有明细的票现在不许确认出运（使用方口径）⇒ 本组用例要走到 200，本票必须有
     * 一条**已填实际量**的明细；只填计划量、或压根没有明细，都会被 409 拦住（刻意如此）。
     */
    shipmentOrderAllocation: {
      findMany: vi.fn().mockResolvedValue([{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 1000 }]),
    },
    orderShipmentBatch: { findMany: vi.fn().mockResolvedValue([]) }, // B4 删除守卫查开票锚点（本组用例无批次）
    invoiceOrderAllocation: { count: vi.fn().mockResolvedValue(0) }, // B4：批次→开票分摊计数（无批次即不触达）
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]) }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
    stockMovement: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    order: { findUnique: orderFindUnique, findFirst: orderFindFirst, update: orderUpdate },
    orderLine: {
      // C4：首装自动带出装运行——空订单行跳过
      findMany: vi.fn().mockResolvedValue([]),
      // ★ 2026-09-29 晚：短装/数量门禁按行读合同量与已出运量（本行 1000 米全发）
      findUnique: vi.fn().mockResolvedValue({
        id: 'L1', orderId: 'O1', itemNo: '001', unit: null, quantity: 1000,
        shipmentQuantity: 1000, tolerancePercent: null, toleranceSource: null,
      }),
    },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) }, // ⇒ 落出厂默认
    relation: { findUnique: vi.fn().mockResolvedValue(null) },
    orderStatusTransition: { create: orderStatusTransitionCreate },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityRefUpsert, findMany: entityRefFindMany, update: entityRefUpdate },
    entityLink: { upsert: entityLinkUpsert, findMany: entityLinkFindMany, update: entityLinkUpdate },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const onDataChange = opts.onDataChange || vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: false, apiKeys: new Set<string>(), onDataChange }));
  return { app, prisma, tx, shipmentCreate, shipmentUpdate, shipmentFindUnique, shipmentEventCreate, shipmentEventFindMany, auditCreate, entityRefUpsert, entityLinkUpsert, entityLinkFindMany, entityLinkUpdate, entityRefFindMany, entityRefUpdate, orderFindUnique, orderUpdate, onDataChange };
}

describe('shipping route → service: POST /', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功创建 → 201 + 事务内 sync + audit + order 联动 + onDataChange 事务后', async () => {
    const { app, shipmentCreate, entityRefUpsert, entityLinkUpsert, auditCreate, orderUpdate, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', orderId: 'ORDER-1',
      customerRelationId: 'REL-1', customerName: 'Acme',
    });
    expect(res.status).toBe(201);
    expect(shipmentCreate).toHaveBeenCalledTimes(1);
    expect(entityRefUpsert).toHaveBeenCalled();
    expect(entityLinkUpsert).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(orderUpdate).toHaveBeenCalled(); // Booked → Order Shipping
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('空体/缺 shippingMethod → 400 VALIDATION_ERROR（不再坠事务撞 P2012 变 500），未进 $transaction', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('shippingMethod');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非法 status → 400 INVALID_STATUS，未进 $transaction', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', status: 'BogusStatus',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('sync reject → 500 CREATE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ syncFail: true });
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', orderId: 'ORDER-1',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500 CREATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean',
    });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CREATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('order link 失败 → 500 CREATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ linkFail: true });
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', orderId: 'ORDER-1',
    });
    expect(res.status).toBe(500);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('order 不存在 → 404 ORDER_NOT_FOUND', async () => {
    const { app, onDataChange } = makeApp({ order: null });
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', orderId: 'MISSING',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('REQ2-20 第四例占位：序列落后于业务表（无 SEQ_SH 行 + 已有 SH-YYYY-0001 直写行）→ occupied 自动追平到 0002', async () => {
    const year = new Date().getFullYear();
    const { app, shipmentCreate } = makeApp({ occupiedShipmentNumbers: [`SH-${year}-0001`] });
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      type: 'Export', shippingMethod: 'Sea', customerName: 'Acme',
    });
    expect(res.status).toBe(201);
    expect(res.body.shipmentNumber).toBe(`SH-${year}-0002`);
    expect(shipmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ shipmentNumber: `SH-${year}-0002` }) }),
    );
  });
});

describe('shipping route → service: PATCH /:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功更新 → 200 + sync + audit + onDataChange', async () => {
    const { app, shipmentUpdate, auditCreate, entityRefUpsert, onDataChange } = makeApp({
      existingShipment: { id: 'SHP-1', shipmentNumber: 'SHP001', status: 'Booked' },
    });
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(200);
    expect(shipmentUpdate).toHaveBeenCalled();
    // ★ D5（2026-09-18）：审计从「1 条汇总」变成「汇总 + 逐字段」——
    //   原断言写死 1 次；现按**原意**改：至少写了一条汇总审计，且**字段级审计也在写**
    //   （只断言次数会随 PATCH 的字段数变化，故用「≥2 + 含 fieldPath」这种不脆的判据）。
    expect(auditCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(auditCreate.mock.calls.some((c: any[]) => c[0]?.data?.fieldPath != null)).toBe(true);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('not found → 404 NOT_FOUND', async () => {
    const { app, onDataChange } = makeApp({ existingShipment: { id: 'OTHER', shipmentNumber: 'X', status: 'Booked' } });
    const res = await request(app).patch('/api/v1/shipping/MISSING').set(authHeader()).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500 UPDATE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('非字符串 status → 400 INVALID_STATUS', async () => {
    const { app, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ status: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  // R6：白名单契约——shippingMethod 入列生效；shipmentNumber/type 身份字段静默丢弃防呆
  it('白名单：shippingMethod 可改生效；shipmentNumber/type 被丢弃不进 update', async () => {
    const { app, shipmentUpdate, onDataChange } = makeApp();
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader())
      .send({ shippingMethod: 'Air', shipmentNumber: 'HACK-9', type: 'Import' });
    expect(res.status).toBe(200);
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const updateData = shipmentUpdate.mock.calls[0][0].data;
    expect(updateData.shippingMethod).toBe('Air');
    expect(updateData.shipmentNumber).toBeUndefined();
    expect(updateData.type).toBeUndefined();
  });

  // MVP 不跟踪目的地到港：旧到港字段写入请求必须被明确拒绝。
  it('PATCH 携带 eta → 400 VALIDATION_ERROR，未进 update', async () => {
    const { app, shipmentUpdate, onDataChange } = makeApp({
      existingShipment: { id: 'SHP-1', shipmentNumber: 'SHP001', status: 'Booked', etd: '2026-09-10' },
    });
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ eta: '2026-09-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('不记录目的地预计/实际到港时间');
    expect(shipmentUpdate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('PATCH bookingDate 晚于现存 etd → 400 VALIDATION_ERROR', async () => {
    const { app, shipmentUpdate } = makeApp({
      existingShipment: { id: 'SHP-1', shipmentNumber: 'SHP001', status: 'Booked', etd: '2026-09-10' },
    });
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ bookingDate: '2026-09-15' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('不能晚于预计离港日');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('PATCH 携带历史 ata 字段 → 400 VALIDATION_ERROR', async () => {
    const { app, shipmentUpdate } = makeApp({
      existingShipment: { id: 'SHP-1', shipmentNumber: 'SHP001', status: 'Booked', etd: '2026-09-10' },
    });
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ ata: '2026-10-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('不记录目的地预计/实际到港时间');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });
});

describe('MVP 出运日期交叉校验（validateShipmentScheduleCross + POST/PATCH）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('纯函数：bookingDate>etd / 合法组合 / 半空组合', async () => {
    const { validateShipmentScheduleCross } = await import('../shipmentMutationService');
    expect(validateShipmentScheduleCross({ bookingDate: '2026-09-15', etd: '2026-09-10' })).toContain('不能晚于');
    expect(validateShipmentScheduleCross({ bookingDate: '2026-09-01', etd: '2026-09-10' })).toBeNull();
    // 半空组合放行（单字段缺失不构成交叉矛盾）
    expect(validateShipmentScheduleCross({ etd: '2026-09-10' })).toBeNull();
    expect(validateShipmentScheduleCross({})).toBeNull();
  });

  it('POST 携带 eta → 400 VALIDATION_ERROR，未进 $transaction', async () => {
    const { app, prisma, onDataChange } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'Export', shippingMethod: 'Sea',
      etd: '2026-09-10', eta: '2026-09-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('不记录目的地预计/实际到港时间');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('POST bookingDate>etd → 400 VALIDATION_ERROR', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'Export', shippingMethod: 'Sea',
      bookingDate: '2026-09-15', etd: '2026-09-10',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('不能晚于预计离港日');
  });

  it('POST 合法日期组合 → 201 正常创建', async () => {
    const { app, shipmentCreate } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'Export', shippingMethod: 'Sea',
      bookingDate: '2026-09-01', etd: '2026-09-10',
    });
    expect(res.status).toBe(201);
    expect(shipmentCreate).toHaveBeenCalledTimes(1);
  });
});

describe('shipping route → service: DELETE /:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功软删 → 200 + EntityReference/EntityLink inactive + audit + onDataChange', async () => {
    const { app, shipmentUpdate, auditCreate, entityLinkFindMany, entityLinkUpdate, entityRefFindMany, entityRefUpdate, onDataChange } = makeApp();
    const res = await request(app).delete('/api/v1/shipping/SHP-1').set(authHeader());
    expect(res.status).toBe(200);
    expect(shipmentUpdate).toHaveBeenCalled();
    expect(entityLinkFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ fromType: 'shipment', fromId: 'SHP-1', status: 'active' }) }));
    expect(entityLinkUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'LINK-1' }, data: expect.objectContaining({ status: 'inactive' }) }));
    expect(entityRefFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerType: 'shipment', ownerId: 'SHP-1', status: 'active' }) }));
    expect(entityRefUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'REF-1' }, data: expect.objectContaining({ status: 'inactive' }) }));
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('not found → 404 NOT_FOUND', async () => {
    const { app, onDataChange } = makeApp({ existingShipment: { id: 'OTHER', shipmentNumber: 'X', status: 'Booked' } });
    const res = await request(app).delete('/api/v1/shipping/MISSING').set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('cleanup reject → 500 DELETE_FAILED，audit/onDataChange 不触发', async () => {
    const { app, auditCreate, onDataChange } = makeApp({ cleanupFail: true });
    const res = await request(app).delete('/api/v1/shipping/SHP-1').set(authHeader());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DELETE_FAILED');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('audit reject → 500 DELETE_FAILED，onDataChange 不触发', async () => {
    const { app, onDataChange } = makeApp({ auditFail: true });
    const res = await request(app).delete('/api/v1/shipping/SHP-1').set(authHeader());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DELETE_FAILED');
    expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('shipping route → service: route→service 契约', () => {
  it('POST/PATCH/DELETE 都触发 $transaction（不再有平行事务）', async () => {
    const { app, prisma } = makeApp();
    await request(app).post('/api/v1/shipping').set(authHeader()).send({ shipmentNumber: 'S1', type: 'sea', shippingMethod: 'ocean' });
    await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ vesselOrFlight: 'MV-1' });
    await request(app).delete('/api/v1/shipping/SHP-1').set(authHeader());
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});

// ── F3：ShipmentEvent 物流节点时间轴 ──
describe('F3: ShipmentEvent 节点跟踪', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST 创建 → 事务内落首节点事件（fromNode=null，toNode=初始状态，eventDate 取 bookingDate）', async () => {
    const { app, shipmentEventCreate } = makeApp();
    const res = await request(app).post('/api/v1/shipping').set(authHeader()).send({
      shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', bookingDate: '2026-08-10',
    });
    expect(res.status).toBe(201);
    expect(shipmentEventCreate).toHaveBeenCalledTimes(1);
    expect(shipmentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromNode: null, toNode: 'Booked', eventDate: '2026-08-10' }),
      }),
    );
  });

  it('PATCH 状态变更 → 落节点事件（from/to + Shipped 取 atd）；同状态幂等 patch 不落事件', async () => {
    const { app, shipmentEventCreate } = makeApp();
    const res = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ status: 'Shipped', atd: '2026-08-15' });
    expect(res.status).toBe(200);
    expect(shipmentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shipmentId: 'SHP-1', fromNode: 'Booked', toNode: 'Shipped', eventDate: '2026-08-15' }),
      }),
    );

    shipmentEventCreate.mockClear();
    const res2 = await request(app).patch('/api/v1/shipping/SHP-1').set(authHeader()).send({ vesselOrFlight: 'MV-2' });
    expect(res2.status).toBe(200);
    expect(shipmentEventCreate).not.toHaveBeenCalled();
  });

  it('GET /:id/events → 升序返回节点时间轴；运单不存在 → 404', async () => {
    const { app, shipmentEventFindMany } = makeApp();
    shipmentEventFindMany.mockResolvedValueOnce([
      { id: 'e1', shipmentId: 'SHP-1', fromNode: null, toNode: 'Booked', eventDate: '2026-08-10' },
      { id: 'e2', shipmentId: 'SHP-1', fromNode: 'Booked', toNode: 'Shipped', eventDate: '2026-08-15' },
    ]);
    const res = await request(app).get('/api/v1/shipping/SHP-1/events').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items[1].toNode).toBe('Shipped');
    expect(shipmentEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shipmentId: 'SHP-1' },
        orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
      }),
    );

    const res404 = await request(app).get('/api/v1/shipping/MISSING/events').set(authHeader());
    expect(res404.status).toBe(404);
  });
});
