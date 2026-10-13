import { describe, expect, it, vi } from 'vitest';
import { validateStatusTransition, VALID_INVOICE_STATUS, VALID_SHIPMENT_STATUS } from '../statusTransition';
import { authHeader } from './authTestHelper';

describe('task_mqy459c6: statusTransition 纯函数', () => {
  describe('Invoice 状态枚举', () => {
    it('VALID_INVOICE_STATUS 含 5 值', () => {
      expect(VALID_INVOICE_STATUS).toEqual(['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Cancelled']);
    });
  });

  describe('Invoice 合法转移', () => {
    it('Draft → Issued 合法', () => expect(validateStatusTransition('Invoice', 'Draft', 'Issued').ok).toBe(true));
    it('Issued → PartiallyPaid 合法', () => expect(validateStatusTransition('Invoice', 'Issued', 'PartiallyPaid').ok).toBe(true));
    it('Issued → Paid 合法', () => expect(validateStatusTransition('Invoice', 'Issued', 'Paid').ok).toBe(true));
    it('PartiallyPaid → Paid 合法', () => expect(validateStatusTransition('Invoice', 'PartiallyPaid', 'Paid').ok).toBe(true));
    it('Draft → Cancelled 合法', () => expect(validateStatusTransition('Invoice', 'Draft', 'Cancelled').ok).toBe(true));
    it('Paid → Cancelled 合法', () => expect(validateStatusTransition('Invoice', 'Paid', 'Cancelled').ok).toBe(true));
    it('相同状态幂等（合法）', () => expect(validateStatusTransition('Invoice', 'Issued', 'Issued').ok).toBe(true));
  });

  describe('Invoice 非法转移', () => {
    it('Draft → Paid 非法（跨态）', () => {
      const r = validateStatusTransition('Invoice', 'Draft', 'Paid');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('Paid → Issued 非法（终态不可回退）', () => {
      const r = validateStatusTransition('Invoice', 'Paid', 'Issued');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('Cancelled → Draft 非法（终态）', () => {
      const r = validateStatusTransition('Invoice', 'Cancelled', 'Draft');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('Paid → PartiallyPaid 非法（不可回退）', () => {
      const r = validateStatusTransition('Invoice', 'Paid', 'PartiallyPaid');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('Shipment 状态枚举', () => {
    it('VALID_SHIPMENT_STATUS 含 8 值', () => {
      expect(VALID_SHIPMENT_STATUS).toEqual(['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled']);
    });
  });

  describe('Shipment 合法转移', () => {
    it('Draft → Booked 合法', () => expect(validateStatusTransition('Shipment', 'Draft', 'Booked').ok).toBe(true));
    it('Booked → Shipped 合法（跨 Loading）', () => expect(validateStatusTransition('Shipment', 'Booked', 'Shipped').ok).toBe(true));
    it('Shipped 是当前 MVP 终点，历史状态重复保存仍幂等', () => {
      expect(validateStatusTransition('Shipment', 'Shipped', 'Shipped').ok).toBe(true);
      expect(validateStatusTransition('Shipment', 'Arrived', 'Arrived').ok).toBe(true);
    });
    it('任意非终态 → Cancelled 合法', () => {
      expect(validateStatusTransition('Shipment', 'Booked', 'Cancelled').ok).toBe(true);
      expect(validateStatusTransition('Shipment', 'Shipped', 'Cancelled').ok).toBe(true);
    });
    it('相同状态幂等（合法）', () => expect(validateStatusTransition('Shipment', 'Booked', 'Booked').ok).toBe(true));
  });

  describe('Shipment 非法转移', () => {
    it('当前 MVP 不允许从已出运继续写到港/清关/交付', () => {
      for (const next of ['Arrived', 'Cleared', 'Delivered']) {
        const result = validateStatusTransition('Shipment', 'Shipped', next);
        expect(result.ok, next).toBe(false);
        expect(result.error, next).toBe('INVALID_TRANSITION');
      }
    });
    it('Draft → Delivered 非法（跨太多）', () => {
      const r = validateStatusTransition('Shipment', 'Draft', 'Delivered');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('Delivered → Shipped 非法（终态）', () => {
      const r = validateStatusTransition('Shipment', 'Delivered', 'Shipped');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('Cancelled → Booked 非法（终态）', () => {
      const r = validateStatusTransition('Shipment', 'Cancelled', 'Booked');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
    it('回退（Shipped → Booked）非法', () => {
      const r = validateStatusTransition('Shipment', 'Shipped', 'Booked');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('非法枚举值（to）', () => {
    it('Invoice 非法 to → INVALID_STATUS', () => {
      const r = validateStatusTransition('Invoice', 'Draft', 'Bogus');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_STATUS');
    });
    it('Shipment 非法 to → INVALID_STATUS', () => {
      const r = validateStatusTransition('Shipment', 'Draft', 'Flying');
      expect(r.ok).toBe(false); expect(r.error).toBe('INVALID_STATUS');
    });
  });

  describe('from 不在枚举（脏数据/旧枚举）→ INVALID_CURRENT_STATUS fail closed', () => {
    it('Invoice from=Unknown → INVALID_CURRENT_STATUS（不静默放过）', () => {
      const r = validateStatusTransition('Invoice', 'Unknown', 'Issued');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('INVALID_CURRENT_STATUS');
      expect(r.message).toContain('Unknown');
    });
    it('Shipment from=Pending → INVALID_CURRENT_STATUS', () => {
      const r = validateStatusTransition('Shipment', 'Pending', 'Booked');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('INVALID_CURRENT_STATUS');
    });
  });
});

// ============================================================================
// 集成测试：invoice route PATCH 状态转移
// ============================================================================
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createFinanceRouter } from '../finance/route';

// Explicit current-account storage for the real authorization loaders. Scopes
// below belong only to synthetic fixture accounts, not a company role policy.
function currentAccountStorage(id: string, roleId: string, scopes: string[]) {
  const user = { id, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId, departmentId: null, role: { id: roleId,
      permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const read = vi.fn(async ({ where }: any) => where.id === user.id ? user : null);
  return { userAccount: { findFirst: read, findUnique: read },
    userPermissionOverrides: { findMany: vi.fn(async () => []) } };
}

function makeInvoiceApp(existingStatus: string, txFail = false) {
  const invoiceFind = vi.fn().mockResolvedValue({ id: 'I1', status: existingStatus, amount: new Prisma.Decimal(100) });
  const invoiceUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: data.status, amount: data.amount ? Number(data.amount) : undefined, invoiceNumber: 'INV001' }));
  const tx = {
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary invoice: no MaterialReturn claimInvoiceId back-reference.
    invoice: { findUnique: invoiceFind, findFirst: invoiceFind, update: invoiceUpdate },
    invoiceOrderAllocation: { findMany: vi.fn(async () => []) },
    ...currentAccountStorage('u_owner', 'owner', ['invoices:read', 'invoices:write']),
    // L2 #8 配套（2026-09-17）：updateInvoice 改 amount 时会读 Σ已核销
    // （allocationService.sumAppliedAmount → invoiceAllocation.findMany）
    // 并在重算成 Paid 时取最后一笔核销日期（findFirst）。mock 必须补齐，
    // 否则 PATCH 直接 TypeError → 500（本文件曾因此红）。
    invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  };
  const $transaction = vi.fn(async (fn: any) => {
    if (txFail) throw new Error('TX_FAIL');
    return fn(tx);
  });
  const prisma = { $transaction } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
  return { app, invoiceUpdate };
}

describe('task_mqy459c6: invoice route PATCH 状态转移集成', () => {
  it('PartiallyPaid 不可手动 PATCH → 400 STATUS_NOT_MANUAL_SETTABLE（仅 allocation 可设）', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Issued');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'PartiallyPaid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STATUS_NOT_MANUAL_SETTABLE');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('Paid 不可手动 PATCH → 400 STATUS_NOT_MANUAL_SETTABLE（仅 allocation 可设），不写 DB', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Draft');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'Paid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STATUS_NOT_MANUAL_SETTABLE');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('非法枚举 → 400 INVALID_STATUS', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Draft');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'Bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('脏数据 from=Unknown → 400 INVALID_CURRENT_STATUS', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Unknown');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'Issued' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_STATUS');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('Cancelled 终态 → 400', async () => {
    const { app } = makeInvoiceApp('Cancelled');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'Issued' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('invoice not found → 404', async () => {
    const app = express();
    app.use(express.json());
    const tx = { ...currentAccountStorage('u_owner', 'owner', ['invoices:read', 'invoices:write']), invoiceOrderAllocation: { findMany: vi.fn(async () => []) }, $queryRawUnsafe: vi.fn(async () => []), invoice: { findUnique: vi.fn().mockResolvedValue(null) } }; // Missing Invoice still has no supplier-claim back-reference.
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
    const res = await request(app).patch('/api/v1/finance/NOPE').set(authHeader()).send({ status: 'Issued' });
    expect(res.status).toBe(404);
  });

  it('事务失败（sync/audit rollback）→ 500 不伪成功', async () => {
    const { app } = makeInvoiceApp('Issued', true);
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 'PartiallyPaid' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
  });


  it('显式 status:null → 400 INVALID_STATUS，不写 DB', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Issued');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('显式 status:数字 → 400 INVALID_STATUS', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Issued');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ status: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('不传 status → 不触发转移校验，正常更新', async () => {
    const { app, invoiceUpdate } = makeInvoiceApp('Issued');
    const res = await request(app).patch('/api/v1/finance/I1').set(authHeader()).send({ amount: 200 });
    expect(res.status).toBe(200);
    expect(invoiceUpdate).toHaveBeenCalled();
  });
});

// ============================================================================
// 集成测试：shipment route PATCH 状态转移
// ============================================================================
import { createShippingRouter } from '../shipping/route';
import { createAuthService } from '../auth/service';

// This route fixture exercises the actual JWT/scope middleware. Its synthetic
// scopes are explicit; it does not prove DB grant loading or company-role UAT.
const shipmentToken = (permissions: string[]) => createAuthService().signToken({
  userId: 'u_shipping_status', roles: ['sales'], permissions,
  departmentIds: [], authorizationLoaded: true,
});
const shipmentWriteToken = shipmentToken(['shipments:write']);

function makeShipmentApp(existingStatus: string, txFail = false) {
  const shipmentFind = vi.fn().mockResolvedValue({ id: 'S1', status: existingStatus, shipmentNumber: 'SHP001' });
  const shipmentUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: data.status, shipmentNumber: 'SHP001' }));
  const tx = {
    ...currentAccountStorage('u_shipping_status', 'sales', ['orders:read', 'shipments:write']),
    $queryRaw: vi.fn(async () => []),
    teamMember: { findMany: vi.fn(async () => []) },
    productionBatch: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    releaseScope: { findMany: vi.fn(async () => []) },
    sample: { findMany: vi.fn(async () => []) },
    // Ordinary shipment fixture: both persisted claim-source queries really run.
    claimDisposition: { findMany: vi.fn().mockResolvedValue([]) },
    repairWorkOrder: { findMany: vi.fn().mockResolvedValue([]) },
    // ★ 2026-09-29 晚：`findMany` 给「该行还有没有未发运的票」用（短装门禁的收尾判据）
    shipment: { findUnique: shipmentFind, update: shipmentUpdate, findMany: vi.fn().mockResolvedValue([]) },
    shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
    /**
     * DR-016 合票分配 + ★ 2026-09-29 晚的**出运数量完整性门禁**。
     * ★★ 语义变了（使用方拍板）：**一张没有任何出运明细的票不能确认出运**
     *   （"不知道数量就能出运 = 巨大的缺口"）⇒ 本组用例要走到 200，本票就**必须**有明细，
     *   且明细的 `actualQty` 已填（本行 1000 米全发 ⇒ 既不缺数据、也不短装）。
     *   ⓘ 一条明细都不给的写法现在会被 409 `SHIPMENT_NO_ALLOCATION_DETAIL` 拦住 —— 那是**对的**，
     *     该行为另有专门用例覆盖（`shipping/__tests__/shortShipmentGate.test.ts`）。
     */
    shipmentOrderAllocation: {
      // ⓘ 刻意**不给** `orderId`：本组用例的运单桩没有 `orderId`，DR-016 合票那条路
      //   在"无合票"口径下本就该拿到空集（给了它反而会去查一张桩里不存在的订单 ⇒ 404，
      //   那是**另一个门禁**的行为，与本组断言的状态机无关）。
      findMany: vi.fn().mockResolvedValue([
        { orderLineId: 'L1', shipmentId: 'S1', actualQty: 1000 },
      ]),
    },
    // 短装/数量门禁要读的三个模型（本行 1000 米落出厂默认 1000–3000 档 ⇒ ±3%）
    orderLine: {
      // ⓘ 既有方法**必须保留**：C4 首装自动带出装运行走的就是 `orderLine.findMany`
      //   （我第一版只加了 findUnique ⇒ 当场 500 `tx.orderLine.findMany is not a function`）
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'L1', orderId: 'O1', itemNo: '001', unit: null, quantity: 1000,
        shipmentQuantity: 1000, tolerancePercent: null, toleranceSource: null,
      }),
    },
    order: { findUnique: vi.fn().mockResolvedValue({ customerRelationId: null }) },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) }, // ⇒ 落出厂默认
    relation: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
    // ── T3（H9 出运扣库存）新增依赖 ─────────────────────────────────────
    // 流转至 Shipped 时 shipmentMutationService 会**在同一事务内**先过出运门禁、
    // 再走 deductShipmentStockInTx。这两个模型不在 mock 里的话 PATCH 直接
    // 500 UPDATE_FAILED（"Cannot read properties of undefined"），与状态机无关。
    // 本组用例的口径 = 运单无装运行、无历史流水 → 扣减走"无账可扣"空路径
    //（不落任何 StockMovement），状态转移照常完成。
    stockMovement: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() }, // 幂等查重：该运单无已有 Outbound 流水
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]) },     // 装运行：空 → 无账可扣
    inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },  // 无库存项；不伪造实际扣账
  };
  const $transaction = vi.fn(async (fn: any) => {
    if (txFail) throw new Error('TX_FAIL');
    return fn(tx);
  });
  const prisma = { $transaction, orderShipmentBatch: { findMany: vi.fn().mockResolvedValue([]) } } as any;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, shipmentUpdate, tx, prisma };
}

describe('task_mqy459c6: shipment route PATCH 状态转移集成', () => {
  it('合法转移 Booked → Shipped → 200', async () => {
    const { app, shipmentUpdate, tx } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Shipped' });
    expect(res.status).toBe(200);
    expect(shipmentUpdate).toHaveBeenCalled();
    expect(tx.claimDisposition.findMany).toHaveBeenCalledWith({ where: { replacementShipmentId: 'S1' }, select: { id: true } });
    expect(tx.repairWorkOrder.findMany).toHaveBeenCalledWith({ where: { reshipmentId: 'S1' }, select: { id: true } });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('非法转移 Draft → Delivered → 400 INVALID_TRANSITION', async () => {
    const { app, shipmentUpdate } = makeShipmentApp('Draft');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Delivered' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('非法回退 Shipped → Booked → 400', async () => {
    const { app } = makeShipmentApp('Shipped');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Booked' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('非法枚举 → 400 INVALID_STATUS', async () => {
    const { app } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Flying' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  it('脏数据 from=Pending → 400 INVALID_CURRENT_STATUS', async () => {
    const { app, shipmentUpdate } = makeShipmentApp('Pending');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Booked' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_STATUS');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('Delivered 终态 → 400', async () => {
    const { app } = makeShipmentApp('Delivered');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Shipped' });
    expect(res.status).toBe(400);
  });

  it('shipment not found → 404', async () => {
    const app = express();
    app.use(express.json());
    const tx = { ...currentAccountStorage('u_shipping_status', 'sales', ['orders:read', 'shipments:write']), shipment: { findUnique: vi.fn().mockResolvedValue(null) } };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).patch('/api/v1/shipping/NOPE').set(authHeader(shipmentWriteToken)).send({ status: 'Shipped' });
    expect(res.status).toBe(404);
  });

  it('事务失败 → 500 不伪成功', async () => {
    const { app } = makeShipmentApp('Booked', true);
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 'Shipped' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('UPDATE_FAILED');
  });


  it('显式 status:null → 400 INVALID_STATUS，不写 DB', async () => {
    const { app, shipmentUpdate } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('显式 status:数字 → 400 INVALID_STATUS', async () => {
    const { app, shipmentUpdate } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ status: 456 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('不传 status → 正常更新', async () => {
    const { app, shipmentUpdate } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1').set(authHeader(shipmentWriteToken)).send({ containerNumber: 'CN001' });
    expect(res.status).toBe(200);
    expect(shipmentUpdate).toHaveBeenCalled();
  });

  it.each([{ permissions: ['shipments:read'] }, { permissions: [] as string[] }])('可信权限 $permissions 不恢复销售默认写权，状态与存储均不变', async ({ permissions }) => {
    const { app, shipmentUpdate, tx, prisma } = makeShipmentApp('Booked');
    const res = await request(app).patch('/api/v1/shipping/S1')
      .set(authHeader(shipmentToken(permissions))).send({ status: 'Shipped' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(shipmentUpdate).not.toHaveBeenCalled();
    expect(tx.claimDisposition.findMany).not.toHaveBeenCalled();
    expect(tx.repairWorkOrder.findMany).not.toHaveBeenCalled();
    expect(tx.shipmentEvent.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
});
