/**
 * orderServiceV2 单测
 * 覆盖：listOrders/getOrder/createOrder/updateOrder/transitionStatus/deleteOrder/getKanban
 *       + 行级权限 scope + 状态机校验 + 字典校验 + 配置默认值
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 依赖 ──
// 行级 scope 规则可变控（安全修复回归：受限角色 + search 不越权需要 non-'all' 规则）
const scopeMock = vi.hoisted(() => ({
  rule: { kind: 'all' as string },
  allowedDepartmentIds: [] as string[],
  allowedUserIds: [] as string[],
}));
vi.mock('../../auth/permissionService', async importOriginal => ({
  ...await importOriginal<typeof import('../../auth/permissionService')>(),
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue(scopeMock),
  })),
}));

// teamShareService mock（buildScopeWhere 在 non-'all' 规则下解析可见客户集合）
vi.mock('../../teams/teamShareService', () => ({
  createTeamShareService: vi.fn(() => ({
    resolveVisibleRelationIds: vi.fn().mockResolvedValue(['REL_VISIBLE_1']),
    hasRelationWriteAccess: vi.fn().mockResolvedValue(true),
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// 不 mock orderLifecycleService — 使用真实的状态机常量
import { createOrderServiceV2 } from '../orderServiceV2';

// ── helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], role: 'admin' } as any;

function makeOrder(overrides: any = {}) {
  return {
    id: 'ORD__1',
    code: 'SO-202608-001',
    customer: 'Peerless',
    product: 'Cotton Twill',
    type: 'Fabric',
    quantity: 1000,
    status: 'Pending',
    dueDate: '2026-09-01',
    quoteAmount: dec(10000),
    currency: 'USD',
    ownerId: 'user_1',
    departmentId: 'dept_1',
    deletedAt: null,
    createdAt: BigInt(0),
    updatedAt: BigInt(0),
    lines: [],
    ...overrides,
  };
}

function makePrisma(overrides: {
  findMany?: any;
  count?: any;
  findFirst?: any;
  create?: any;
  update?: any;
  txUpdate?: any;
  txCreate?: any;
} = {}) {
  const txUpdate = overrides.txUpdate ?? vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  const txCreate = overrides.txCreate ?? vi.fn().mockResolvedValue({});
  // transitionStatus 已委托 V1 transitionOrderStatus 单引擎（DE-2/DE-4 修复）：
  // 门禁预查 + 事务内 findUnique/sync/audit 均在下方 mock 覆盖
  const defaultOrder = makeOrder();
  const tx = {
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    order: {
      findUnique: vi.fn().mockResolvedValue(defaultOrder),
      findFirst: vi.fn().mockResolvedValue(defaultOrder),
      update: txUpdate,
    },
    orderStatusTransition: { create: txCreate },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    // V1 deleteOrder 单引擎（V2 委托）依赖守卫 + 报价解链所需表
    invoice: { count: vi.fn().mockResolvedValue(0) },
    invoiceOrderAllocation: { count: vi.fn().mockResolvedValue(0) },
    shipment: { count: vi.fn().mockResolvedValue(0) },
    shipmentOrderAllocation: { count: vi.fn().mockResolvedValue(0) },
    paymentVoucher: { count: vi.fn().mockResolvedValue(0) },
    //  ★ v2.49（G4.4 缺口②）：删单守卫多了第六路 = 批次计划；替身必须跟着补，否则 fail-closed 会把「替身不全」报成「校验失败」
    orderShipmentBatch: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    quotation: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    order: {
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([makeOrder()]),
      count: overrides.count ?? vi.fn().mockResolvedValue(1),
      findFirst: overrides.findFirst ?? vi.fn().mockResolvedValue(defaultOrder),
      findUnique: vi.fn().mockResolvedValue(defaultOrder),
      create: overrides.create ?? vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'ORD__NEW', lines: [] })),
      update: overrides.update ?? vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    orderStatusTransition: {
      create: txCreate,
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    creditLimit: { findFirst: vi.fn().mockResolvedValue(null) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    entityLink: tx.entityLink,
    entityReference: tx.entityReference,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  const currentAuthority = {
    userAccount:{findFirst:vi.fn().mockResolvedValue({id:ACTOR.userId,status:'active',deletedAt:null,roles:[{roleId:'role-admin',role:{permissions:[{permission:{scope:'orders:write'}}]}}]})},
    userPermissionOverrides:{findMany:vi.fn().mockResolvedValue([])},
  };
  Object.assign(prisma,currentAuthority); Object.assign(tx,currentAuthority,{
    $queryRaw:vi.fn().mockResolvedValue([{id:defaultOrder.id}]),
    approvalRequest:{findFirst:vi.fn().mockResolvedValue(null)},
    orderLine:{findMany:vi.fn().mockResolvedValue([])},
  });
  // 暴露 tx：deleteOrder 已委托 V1 单引擎（事务内软删），断言需直查 tx
  (prisma as any).__tx = tx;
  return prisma;
}

beforeEach(() => { vi.clearAllMocks(); scopeMock.rule = { kind: 'all' }; });

// ═══════════════════════════════════════════════════════════════
// listOrders
// ═══════════════════════════════════════════════════════════════

describe('listOrders 订单列表', () => {
  it('成功返回分页列表', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.listOrders(ACTOR, { limit: 10, offset: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items).toHaveLength(1);
      expect(r.data.total).toBe(1);
    }
  });

  it('搜索条件透传', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    await svc.listOrders(ACTOR, { status: 'Pending', type: 'Fabric', search: 'Peerless' });
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('Pending');
    expect(where.type).toBe('Fabric');
    // 安全修复：搜索条件 AND 嵌套（where.AND[].OR），不与行级 scope 平级合并
    expect(where.AND).toBeDefined();
    expect((where.AND as any[])[0].OR).toBeDefined();
  });

  it('E4：搜索扩展供应商/发票号/合同号字段（模糊匹配 insensitive）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    await svc.listOrders(ACTOR, { search: 'INV-2026' });
    const where = prisma.order.findMany.mock.calls[0][0].where;
    const searchOr = (where.AND as any[])[0].OR as any[];
    const orFields = searchOr.map((clause) => Object.keys(clause)[0]);
    // 原四字段保留
    expect(orFields).toEqual(expect.arrayContaining(['customer', 'product', 'code', 'poNumber']));
    // E4 新增：供应商（工厂）/ 我方发票号 / 供应商发票号 / 销售合同号 / 最终合同号
    expect(orFields).toEqual(expect.arrayContaining([
      'millName', 'invoiceNumber', 'supplierInvoiceNumber', 'salesContractNumber', 'finalContractNumber',
    ]));
    for (const clause of searchOr) {
      const field = Object.keys(clause)[0];
      expect(clause[field]).toEqual({ contains: 'INV-2026', mode: 'insensitive' });
    }
  });

  it('安全回归：受限角色（non-all scope）+ search → 搜索只嵌套在 scope 之内，不越权', async () => {
    scopeMock.rule = { kind: 'team' };
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    await svc.listOrders(ACTOR, { search: 'INV-2026' });
    const where = prisma.order.findMany.mock.calls[0][0].where;
    // scope.OR 保持顶层且只含行级范围条件（不含任何搜索字段）
    expect(where.OR).toBeDefined();
    const scopeFields = (where.OR as any[]).flatMap((clause) =>
      Object.keys(clause).includes('AND') ? (clause.AND as any[]).map((c: any) => Object.keys(c)[0]) : [Object.keys(clause)[0]],
    );
    expect(scopeFields).toEqual(expect.arrayContaining(['customerRelationId', 'ownerId']));
    expect(scopeFields).not.toContain('customer');
    expect(scopeFields).not.toContain('millName');
    // 搜索条件独立嵌套在 where.AND 内（与 scope AND 关系，命中搜索不能绕过 scope）
    expect(where.AND).toHaveLength(1);
    const searchFields = ((where.AND as any[])[0].OR as any[]).map((c: any) => Object.keys(c)[0]);
    expect(searchFields).toContain('invoiceNumber');
  });
});

// ═══════════════════════════════════════════════════════════════
// getOrder
// ═══════════════════════════════════════════════════════════════

describe('getOrder 订单详情', () => {
  it('存在 → 返回数据', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.getOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe('ORD__1');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.getOrder(ACTOR, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════
// createOrder
// ═══════════════════════════════════════════════════════════════

describe('createOrder 创建订单', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(null, { customer: 'Test', product: 'P', type: 'Fabric', quantity: 100, dueDate: '2026-09-01', quoteAmount: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('customer 为空 → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, { customer: '', product: 'P', type: 'Fabric', quantity: 100, dueDate: '2026-09-01', quoteAmount: 1000 } as any);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('quantity ≤ 0 → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, { customer: 'Test', product: 'P', type: 'Fabric', quantity: 0, dueDate: '2026-09-01', quoteAmount: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('非法 status → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, { customer: 'Test', product: 'P', type: 'Fabric', quantity: 100, dueDate: '2026-09-01', quoteAmount: 1000, status: 'InvalidStatus' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('成功创建（自动编号 + ownerId + 配置默认值）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, {
      customer: 'Peerless',
      product: 'Cotton Twill',
      type: 'Fabric',
      quantity: 1000,
      dueDate: '2026-09-01',
      quoteAmount: 10000,
    });
    expect(r.ok).toBe(true);
    const createCall = prisma.order.create.mock.calls[0][0];
    expect(createCall.data.code).toBe('SO-202608-001');
    expect(createCall.data.ownerId).toBe('user_1');
    expect(createCall.data.currency).toBe('USD');
    expect(createCall.data.status).toBe('Pending');
  });

  // ══════════════════════════════════════════════════════════════════
  // ★ A19（拍板件 §2.2 硬条件「B51 三条路径要一起收口」）
  //   V2 的 `ORDER_OPTIONAL_FIELDS` 此前**没有** `paymentInstrument`
  //   ⇒ 客户端传了被静默丢弃 ⇒ 该列恒 null ⇒ L/C 门禁永远判 `not-applicable` 放行。
  //   ★ 本组改前必须红（payload 里根本没有这个键）。
  // ══════════════════════════════════════════════════════════════════
  it('★ A19：建单传 paymentInstrument 不许被白名单静默丢弃', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.createOrder(ACTOR, {
      customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
      quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
      paymentInstrument: 'L/C',
    } as any);
    expect(r.ok).toBe(true);
    const createCall = prisma.order.create.mock.calls[0][0];
    expect(createCall.data.paymentInstrument, '传了 L/C 却落不进库 ⇒ L/C 门禁形同虚设').toBe('L/C');
  });

  it('★ A19：建单**不传** paymentInstrument ⇒ payload 里不许有该键（不许兜默认值）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    await svc.createOrder(ACTOR, {
      customer: 'Peerless', product: 'Cotton Twill', type: 'Fabric',
      quantity: 1000, dueDate: '2026-09-01', quoteAmount: 10000,
    });
    const createCall = prisma.order.create.mock.calls[0][0];
    // ★ 反向对照：上面三条配置默认值（currency/paymentTerms/deliveryTerms）都有兜底，
    //   唯独 paymentInstrument **不许**有 —— 空 = 「不知道」，补默认值就是伪造一个结算方式。
    expect(createCall.data.currency).toBe('USD');                 // 对照：确有兜底机制
    expect(Object.prototype.hasOwnProperty.call(createCall.data, 'paymentInstrument')).toBe(false);
  });

  it('★ A19：改单同样收口（create/update 共用同一白名单）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.updateOrder(ACTOR, 'ORD__1', { paymentInstrument: 'L/C' } as any);
    expect(r.ok).toBe(true);
    // B285 之后改单走 `prisma.$transaction(tx)` ⇒ 调用记在**事务内那个句柄**上（同文件 :445 早就是这个读法）。
    //   断言强度不变：仍核"update 的 payload 只带白名单字段、值原样落"。
    const updateCall = (prisma as any).__tx.order.update.mock.calls[0][0];
    expect(updateCall.data.paymentInstrument).toBe('L/C');
  });
});

// ═══════════════════════════════════════════════════════════════
// updateOrder
// ═══════════════════════════════════════════════════════════════

describe('updateOrder 更新订单', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.updateOrder(null, 'ORD__1', { customer: 'New' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.updateOrder(ACTOR, 'NOPE', { customer: 'New' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功更新（只更新 updatableFields）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.updateOrder(ACTOR, 'ORD__1', { customer: 'New Name', poNumber: 'PO-123' });
    expect(r.ok).toBe(true);
    // B285 之后改单走 `prisma.$transaction(tx)` ⇒ 调用记在**事务内那个句柄**上（同文件 :445 早就是这个读法）。
    //   断言强度不变：仍核"update 的 payload 只带白名单字段、值原样落"。
    const updateCall = (prisma as any).__tx.order.update.mock.calls[0][0];
    expect(updateCall.data.customer).toBe('New Name');
    expect(updateCall.data.poNumber).toBe('PO-123');
  });
});

// ═══════════════════════════════════════════════════════════════
// transitionStatus
// ═══════════════════════════════════════════════════════════════

describe('transitionStatus 状态机流转', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(null, 'ORD__1', 'Confirmed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('非法目标状态 → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'InvalidStatus');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('订单不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'NOPE', 'Confirmed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('相同状态 → INVALID_TRANSITION', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(makeOrder({ status: 'Pending' })) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Pending');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('非法转换 Pending → Delivered → INVALID_TRANSITION', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(makeOrder({ status: 'Pending' })) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Delivered');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('Pending → Confirmed requires the controlled main approval instead of a status shortcut', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(makeOrder({ status: 'Pending' })) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.transitionStatus(ACTOR, 'ORD__1', 'Confirmed', '客户确认');
    expect(r).toMatchObject({ok:false,error:{code:'ORDER_MAIN_APPROVAL_REQUIRED'}});
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteOrder
// ═══════════════════════════════════════════════════════════════

describe('deleteOrder 软删除订单（V1 单引擎委托）', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(null, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功 → deletedAt 落库（V1 事务内软删）', async () => {
    const prisma = makePrisma();
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(true);
    const tx = (prisma as any).__tx;
    const updateCall = tx.order.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'ORD__1' });
    expect(updateCall.data.deletedAt).toBeDefined();
  });

  it('依赖守卫：存在发票 → HAS_DEPENDENTS（不软删）', async () => {
    const prisma = makePrisma();
    (prisma as any).__tx.invoice.count.mockResolvedValueOnce(1);
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('HAS_DEPENDENTS');
      expect(r.error.message).toContain('不可删除');
    }
    expect((prisma as any).__tx.order.update).not.toHaveBeenCalled();
  });

  it('依赖守卫：存在发票分摊 InvoiceOrderAllocation（DR-016 多对多链）→ HAS_DEPENDENTS', async () => {
    const prisma = makePrisma();
    (prisma as any).__tx.invoiceOrderAllocation.count.mockResolvedValueOnce(2);
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HAS_DEPENDENTS');
    expect((prisma as any).__tx.order.update).not.toHaveBeenCalled();
  });

  it('依赖守卫：存在出运分摊 ShipmentOrderAllocation → HAS_DEPENDENTS', async () => {
    const prisma = makePrisma();
    (prisma as any).__tx.shipmentOrderAllocation.count.mockResolvedValueOnce(1);
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HAS_DEPENDENTS');
  });

  it('删单联动：清除指向本单的 Quotation.convertedOrderId（防报价永久卡死）', async () => {
    const prisma = makePrisma();
    (prisma as any).__tx.quotation.updateMany.mockResolvedValueOnce({ count: 1 });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.deleteOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(true);
    const unlinkCall = (prisma as any).__tx.quotation.updateMany.mock.calls[0][0];
    expect(unlinkCall.where).toEqual({ convertedOrderId: 'ORD__1' });
    expect(unlinkCall.data.convertedOrderId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// getKanban
// ═══════════════════════════════════════════════════════════════

describe('getKanban 看板聚合', () => {
  it('按 status 分组 count', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([
        { status: 'Pending' }, { status: 'Pending' }, { status: 'Confirmed' },
      ]),
    });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.getKanban(ACTOR, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.total).toBe(3);
      const pending = r.data.statuses.find((s: any) => s.status === 'Pending');
      expect(pending.count).toBe(2);
    }
  });

  it('type 筛选透传', async () => {
    const prisma = makePrisma({ findMany: vi.fn().mockResolvedValue([]) });
    const svc = createOrderServiceV2(prisma);
    await svc.getKanban(ACTOR, { type: 'Fabric' });
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.type).toBe('Fabric');
  });
});

describe('settleOrder 订单结案（G3-4）', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const svc = createOrderServiceV2(makePrisma());
    const r = await svc.settleOrder(null, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('成功结清 → 写 settledAt/settledBy 留痕', async () => {
    const prisma = makePrisma() as any;
    const svc = createOrderServiceV2(prisma);
    const r = await svc.settleOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(true);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ORD__1' },
        data: expect.objectContaining({ settledAt: expect.any(BigInt), settledBy: ACTOR.userId }),
      }),
    );
  });

  it('已结清 → ALREADY_SETTLED，不重复确认', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue({ id: 'ORD__1', settledAt: BigInt(1) }) });
    const svc = createOrderServiceV2(prisma);
    const r = await svc.settleOrder(ACTOR, 'ORD__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_SETTLED');
    expect((prisma as any).order.update).not.toHaveBeenCalled();
  });
});
