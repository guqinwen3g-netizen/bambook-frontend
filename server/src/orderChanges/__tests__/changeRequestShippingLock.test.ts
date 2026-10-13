/**
 * changeRequestShippingLock.test.ts — ★ B3 守卫：已出运后不得再改价/改量/交期
 *
 * 为什么要有这个测试：
 *   原实现只有 `changeType === 'delivery'` 才查出运锁定 ⇒ **货都发走了还能提交/生效改价、改量申请**：
 *     · 改价：已出运批次已按旧价结算、发票已开 ⇒ 改一个数字，账静默地变了
 *     · 改量：与 A1 同型 —— 库存已扣、已开票额不动，数量却变了
 *   两者都联动不到「已出运量 / 已开票额」，属 A 类静默错账，只是入口在改单链。
 *
 * 判据（含**阳性对照**，否则「守卫没跑」和「守卫跑对了」都是绿）：
 *   ① 阳性对照：未出运订单改价/改量 → 放行（不误伤正常业务）
 *   ② 已出运（Shipping / 已有离厂运单）改价 → ORDER_SHIPPING_LOCKED
 *   ③ 已出运改量到 **≥ 已出运量** → 放行（剩下的不发了是合法减量，不能卡死）
 *   ④ 已出运改量到 **< 已出运量** → ORDER_QTY_BELOW_SHIPPED（已发的货比订单还多）
 *   ⑤ 合票订单：订单状态还是 Production，但票已 Shipped → 同样锁住（不看状态也挡得住）
 *   ⑥ 边界：customer / product 不在硬锁范围（它们是主体描述，实务上出运后仍有合法更正）
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));
import { createOrderChangeRequestService, ORDER_CHANGE_ERRORS } from '../orderChangeRequestService';

const VALID_REASON = '客户延迟确认产前样，需要调整订单内容';
const VALID_IMPACT = 'BOM 成本变化，回款延迟风险需评估';

function makePrisma(opts: {
  orderStatus?: string;
  /** 该订单名下的运单（含合票/主订单两种关联） */
  shipments?: Array<{ id: string; status: string; orderId?: string | null }>;
  allocations?: Array<{ shipmentId: string; actualQty: number; unit?: string | null; orderId?: string }>;
  /** 订单当前 quantity（改量判定用） */
  quantity?: number;
}) {
  const order = {
    id: 'ORD__1',
    status: opts.orderStatus ?? 'Confirmed',
    deletedAt: null,
    quantity: opts.quantity ?? 1000,
    quoteAmount: 10000, totalNet: 10000, dueDate: '2026-10-05',
    customer: 'ABC 贸易', customerRelationId: 'REL_A', customerCode: 'ABC',
    product: 'Garment-X', poNumber: 'PO-2026-001',
    type: 'Garment', businessLine: 'garment', unit: 'pcs', capsuleExemption: false,
    moqSnapshot: { fabricDefaultMoq: 100, garmentDefaultMoq: 100, capsuleMoq: 10,
      snapshotAt: '2026-01-01T00:00:00.000Z', configId: null, source: 'moq_config' },
    salesContractNumber: null, finalContractNumber: null,
    createdAt: BigInt(0), updatedAt: BigInt(0),
  };
  const shipments = opts.shipments ?? [];
  const allocations = opts.allocations ?? [];

  const prisma: any = {
    // The real service locks the order and its lines before re-reading the
    // source facts. Model the SQL lock seam instead of failing before B3 runs.
    $queryRawUnsafe: vi.fn(async () => []),
    $queryRaw: vi.fn(async () => []),
    order: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === order.id ? order : null)),
      findFirst: vi.fn(async ({ where }: any) => (where?.id === order.id || where?.AND?.some((part: any) => part?.id === order.id) ? order : null)),
      update: vi.fn(async ({ where, data }: any) => ({ ...order, ...data, id: where.id })),
      findMany: vi.fn(async () => []),
    },
    orderLine: {
      findMany: vi.fn(async () => [{ id: 'OL__1', orderId: 'ORD__1', lineNumber: 1, quantity: String(order.quantity), unit: 'pcs',
        unitPrice: null, netValue: null, moqOverride: null, confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null }]),
      update: vi.fn(async () => ({})),
    },
    userAccount: {
      findUnique: vi.fn(async ({ where }: any) => where.id === 'U1'
        ? { id: 'U1', status: 'active', deletedAt: null, primaryDeptId: 'dept_1', roles: [] } : null),
      findFirst: vi.fn(async ({ where }: any) => where.id === 'U1'
        ? { id: 'U1', status: 'active', deletedAt: null, primaryDeptId: 'dept_1', roles: [] } : null),
    },
    userPermissionOverrides: { findMany: vi.fn(async () => [
      { scope: 'order:change_request:create' }, { scope: 'order:change_request:apply' }, { scope: 'orders:read' },
    ]) },
    department: { findMany: vi.fn(async () => []) },
    shipmentLine: { findMany: vi.fn(async () => []) },
    // ★ B3 新增读取的两张表（守卫要能看见「已离厂的运单」）
    shipment: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let rows = shipments;
        if (where?.id?.in) rows = rows.filter(s => where.id.in.includes(s.id));
        if (where?.orderId) rows = rows.filter(s => s.orderId === where.orderId);
        return rows;
      }),
    },
    shipmentOrderAllocation: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let rows = allocations;
        if (where?.orderId) rows = rows.filter(a => a.orderId !== undefined ? a.orderId === where.orderId : true);
        return rows;
      }),
    },
    orderChangeRequest: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => ({ ...data, id: 'OCR__1' })),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => ({ ...data, id: where.id })),
      findMany: vi.fn(async () => []),
    },
    orderStatusTransition: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    creditLimit: { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    creditLimitHistory: { create: vi.fn(async ({ data }: any) => data) },
    purchaseOrder: { count: vi.fn(async () => 0) },
    productionStage: { count: vi.fn(async () => 0) },
    invoice: { count: vi.fn(async () => 0) },
    paymentVoucher: { count: vi.fn(async () => 0) },
    developmentCase: { findMany: vi.fn(async () => []) },
    sampleBatch: { count: vi.fn(async () => 0) },
    preCutChecklist: { updateMany: vi.fn(async () => ({ count: 1 })) },
    approvalRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return prisma;
}

const createBusinessApproval = vi.fn(async (input: any) => ({ id: 'AP__1', reviewerId: 'U_REVIEWER', status: 'pending',
  requesterId: input.requesterId, actionType: input.actionType, targetType: input.targetType, targetId: input.targetId,
  payload: input.payload }));

function makeService(prisma: any) {
  return createOrderChangeRequestService({ prisma, approvalCreateService: { createBusinessApproval } as any });
}

const submit = (svc: any, changeType: string, afterDelta: Record<string, unknown>) =>
  svc.createChangeRequest({
    orderId: 'ORD__1',
    changeType: changeType as any,
    beforeSnapshot: changeType === 'price' ? { unitPrice: 10000 }
      : changeType === 'delivery' ? { deliveryDate: '2026-10-05' } : { quantity: 1000 },
    afterDelta: changeType === 'quantity'
      ? { quantity: String(afterDelta.quantity), lineQuantityPlan: { version: 1, orderId: 'ORD__1', expectedUpdatedAt: '0',
          lines: [{ lineId: 'OL__1', beforeQuantity: '1000', unit: 'pcs', afterQuantity: String(afterDelta.quantity) }] } }
      : afterDelta,
    changeReason: VALID_REASON,
    impactSummary: VALID_IMPACT,
    requesterId: 'U1',
    trustedActor: { userId: 'U1', roles: ['sales'], permissions: ['order:change_request:create', 'order:change_request:apply'], authorizationLoaded: true },
  });

describe('★ B3 守卫：已出运后改价/改量/交期硬锁', () => {
  it('① 阳性对照：未出运（Confirmed）改价 → 放行', async () => {
    const prisma = makePrisma({ orderStatus: 'Confirmed' });
    const r = await submit(makeService(prisma), 'price', { unitPrice: 12 });
    if (!r.ok) throw new Error(`应当放行却失败：${r.error!.code} ${r.error!.message}`);
    expect(r.ok).toBe(true);
    expect(prisma.$queryRawUnsafe.mock.calls.slice(0, 2).map((call: any[]) => call[0])).toEqual([
      'SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE',
      'SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE',
    ]);
  });

  it('①b 阳性对照：未出运（Confirmed）改量 → 放行', async () => {
    const prisma = makePrisma({ orderStatus: 'Confirmed' });
    const r = await submit(makeService(prisma), 'quantity', { quantity: 800 });
    if (!r.ok) throw new Error(`未出运改量应放行：${r.error!.code} ${r.error!.message}`);
    expect(r.ok).toBe(true);
  });

  it('② 已出运（Shipping）改价 → ORDER_SHIPPING_LOCKED', async () => {
    const prisma = makePrisma({ orderStatus: 'Shipping' });
    const r = await submit(makeService(prisma), 'price', { unitPrice: 12 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
    expect(r.error!.message).toContain('价格');
    expect(r.error!.statusCode).toBe(409);
  });

  it('②b 已出运（Delivered）改交期 → 锁（与改造前同行为）', async () => {
    const prisma = makePrisma({ orderStatus: 'Delivered' });
    const r = await submit(makeService(prisma), 'delivery', { deliveryDate: '2026-12-01' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
  });

  it('③ 已出运改量到 **≥ 已出运量** → 放行（合法减量，不能卡死业务）', async () => {
    const prisma = makePrisma({
      orderStatus: 'Shipping',
      shipments: [{ id: 'SHP__1', status: 'Shipped', orderId: 'ORD__1' }],
      allocations: [{ shipmentId: 'SHP__1', actualQty: 600, unit: 'PCS', orderId: 'ORD__1' }],
    });
    const r = await submit(makeService(prisma), 'quantity', { quantity: 600 }); // 正好等于已出运量
    if (!r.ok) throw new Error(`改量不低于已出运量应放行：${r.error!.code} ${r.error!.message}`);
    expect(r.ok).toBe(true);
  });

  it('④ 已出运改量到 **< 已出运量** → ORDER_QTY_BELOW_SHIPPED', async () => {
    const prisma = makePrisma({
      orderStatus: 'Shipping',
      shipments: [{ id: 'SHP__1', status: 'Shipped', orderId: 'ORD__1' }],
      allocations: [{ shipmentId: 'SHP__1', actualQty: 600, unit: 'PCS', orderId: 'ORD__1' }],
    });
    const r = await submit(makeService(prisma), 'quantity', { quantity: 500 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe(ORDER_CHANGE_ERRORS.ORDER_QTY_BELOW_SHIPPED);
    expect(r.error!.message).toContain('600');
  });

  it('⑤ 合票订单：订单状态还是 Production，但票已 Shipped → 照样锁住', async () => {
    const prisma = makePrisma({
      orderStatus: 'Production', // 合票非主订单不会被正向联动到 Shipping
      shipments: [{ id: 'SHP__1', status: 'Shipped', orderId: null }],
      allocations: [{ shipmentId: 'SHP__1', actualQty: 300, unit: 'PCS', orderId: 'ORD__1' }],
    });
    const r = await submit(makeService(prisma), 'price', { unitPrice: 12 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
  });

  it('⑤b 只有 Draft/Booked 票（还没离厂）→ 不锁（Booked 只是订舱，不等于已发运）', async () => {
    const prisma = makePrisma({
      orderStatus: 'Production',
      shipments: [{ id: 'SHP__1', status: 'Booked', orderId: 'ORD__1' }],
      allocations: [{ shipmentId: 'SHP__1', actualQty: 300, unit: 'PCS', orderId: 'ORD__1' }],
    });
    // 原订单尚未进入 Shipping；Booked 仅表示订舱，不是已离厂出运事实。
    const q = await submit(makeService(prisma), 'quantity', { quantity: 100 });
    if (!q.ok) throw new Error(`Booked 单改量应放行：${q.error!.code} ${q.error!.message}`);
    expect(q.ok).toBe(true);
  });

  it('⑥ 边界：customer / product 不在硬锁范围（主体描述，出运后仍有合法更正）', async () => {
    const prisma = makePrisma({ orderStatus: 'Shipping' });
    const svc = makeService(prisma);
    const c = await submit(svc, 'customer', { customer: '新客户名' });
    const p = await submit(svc, 'product', { product: 'Garment-Y' });
    expect(c.ok).toBe(true);
    expect(p.ok).toBe(true);
  });
});
