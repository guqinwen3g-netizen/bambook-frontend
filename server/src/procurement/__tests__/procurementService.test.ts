import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createProcurementService, CreatePurchaseOrderInput, MaterialReceiptInput } from '../procurementService';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * task ERP-P2-procurement-service-foundation:
 * 覆盖 procurementService 的 CRUD + 状态转换 + 来料检验 + 审计 + 事件发布 + fail-closed 契约。
 *
 * 设计：
 *   - 用 $transaction: (fn) => fn(tx) 透明穿透模式，验证 audit reject → 事务回滚
 *   - 所有 mutation 都在事务内写 auditLog，audit reject 必须回滚业务操作
 *   - sendPurchaseOrder / confirmPurchaseOrder / createMaterialReceipt 在事务提交后 publish 业务事件
 *   - 状态转换严格校验：非法转换抛错（fail-closed）
 *   - 来料检验：自动判定 PartiallyReceived / Received 状态
 */

// ── Mock businessEventBus.publish（fire-and-forget，但需验证调用契约） ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(opts: {
  existing?: any;
  auditFail?: boolean;
  createFail?: boolean;
  updateFail?: boolean;
  poFindUniqueImpl?: any;
} = {}) {
  const existing = opts.existing ?? null;
  if (existing?.lines) existing.lines = existing.lines.map((l:any,i:number)=>({id:`pl_${i+1}`,lineNumber:i+1,...l}));

  const purchaseOrderCreate = opts.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_BOOM'))
    : vi.fn().mockImplementation(async ({ data }: any) => {
        const { createdAt, updatedAt, lines, ...rest } = data;
        return {
          ...rest,
          createdAt,
          updatedAt,
          lines: lines?.create?.map((l: any, i: number) => ({
            ...l,
            lineNumber: i + 1,
            amount: Math.round(l.quantity * l.unitPrice * 10000) / 10000,
            receivedQuantity: 0,
            rejectedQuantity: 0,
          })) ?? [],
          receipts: [],
        };
      });

  const purchaseOrderUpdate = opts.updateFail
    ? vi.fn().mockRejectedValue(new Error('UPDATE_BOOM'))
    : vi.fn().mockImplementation(async ({ where, data, include }: any) => {
        const { updatedAt, deletedAt, status, ...rest } = data;
        return {
          ...existing,
          ...rest,
          ...(status ? { status } : {}),
          id: where.id,
          updatedAt,
          lines: existing?.lines ?? [],
          receipts: existing?.receipts ?? [],
        };
      });

  const purchaseOrderFindUnique = opts.poFindUniqueImpl
    ? opts.poFindUniqueImpl
    : vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === existing?.id || where.poNumber === existing?.poNumber) return existing;
        return null;
      });

  const purchaseLineDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const purchaseLineCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  // 行级回写（L8 断层修复）：receivedQuantity 增量 update
  const purchaseLineUpdate = vi.fn().mockResolvedValue({});
  const materialReceiptCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  // 幂等防重：默认无历史收料单
  const materialReceiptFindFirst = vi.fn().mockResolvedValue(null);
  const auditCreate = opts.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_REJECT'))
    : vi.fn().mockResolvedValue({ id: 'AL-1' });

  const tx: any = {
    warehouse: { findFirst: vi.fn(async()=>({id:'WH_SH', name:'上海仓', type:'Main', isActive:true, deletedAt:null})) },
    $queryRaw: vi.fn(async(sql:any)=>sql.sql.includes('"Warehouse"') ? [{id:'WH_SH'}] : [{status:existing?.status,updatedAt:existing?.updatedAt,orderId:existing?.orderId??null,deletedAt:existing?.deletedAt??null}]),
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    purchaseOrder: { create: purchaseOrderCreate, update: purchaseOrderUpdate },
    purchaseLine: { deleteMany: purchaseLineDeleteMany, createMany: purchaseLineCreateMany, update: purchaseLineUpdate },
    materialReceipt: { create: materialReceiptCreate, findFirst: materialReceiptFindFirst },
    auditLog: { create: auditCreate, findFirst: vi.fn(async()=>{ const data=auditCreate.mock.calls.at(-1)?.[0]?.data; return data || null; }) },
    // EntityLink 图谱（D1.1a）：sync/deactivate 走 tx 内 upsert/findMany/update
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma: any = {
    purchaseOrder: {
      findUnique: purchaseOrderFindUnique,
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: purchaseOrderUpdate,
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return {
    prisma, tx,
    purchaseOrderCreate, purchaseOrderUpdate, purchaseOrderFindUnique,
    purchaseLineDeleteMany, purchaseLineCreateMany, purchaseLineUpdate,
    materialReceiptCreate, materialReceiptFindFirst, auditCreate,
  };
}

const baseInput: CreatePurchaseOrderInput = {
  poNumber: 'PO-20260806-001',
  currency: 'USD',
  orderDate: '2026-08-06',
  supplierName: 'ACME Supplier',
  buyer: 'John',
  lines: [
    { description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5 },
    { description: 'Trimmings B', quantity: 50, unit: 'PC', unitPrice: 12 },
  ],
};

// ═══════════════════════════════════════════════════════════════
// createPurchaseOrder
// ═══════════════════════════════════════════════════════════════
describe('procurementService: createPurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('成功创建 → 事务内 purchaseOrder + lines + audit，totalAmount = 行金额合计', async () => {
    const { prisma, tx, purchaseOrderCreate, auditCreate } = makePrisma();
    const service = createProcurementService(prisma);

    const result = await service.createPurchaseOrder(baseInput, 'u_test');

    expect(tx.purchaseOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(purchaseOrderCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        poNumber: 'PO-20260806-001',
        status: 'Draft',
        currency: 'USD',
        totalAmount: 100 * 5.5 + 50 * 12, // 550 + 600 = 1150
      }),
    }));
    // 行明细 lineNumber 自动递增
    const createCall = purchaseOrderCreate.mock.calls[0][0];
    expect(createCall.data.lines.create).toHaveLength(2);
    expect(createCall.data.lines.create[0].lineNumber).toBe(1);
    expect(createCall.data.lines.create[1].lineNumber).toBe(2);
    // 行金额自动计算
    expect(createCall.data.lines.create[0].amount).toBe(550);
    expect(createCall.data.lines.create[1].amount).toBe(600);

    // audit 动作标记
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create_purchase_order',
        targetType: 'PurchaseOrder',
        actorId: 'u_test',
        operationType: 'create',
      }),
    }));

    // createPurchaseOrder 不发布业务事件（仅状态转换才发布）
    expect(publishSpy).not.toHaveBeenCalled();

    expect(result.poNumber).toBe('PO-20260806-001');
    expect(result.status).toBe('Draft');
  });

  it('audit reject → 事务回滚（fail-closed，不伪成功）', async () => {
    const { prisma, purchaseOrderCreate } = makePrisma({ auditFail: true });
    const service = createProcurementService(prisma);

    await expect(service.createPurchaseOrder(baseInput, 'u_test')).rejects.toThrow('AUDIT_REJECT');

    // purchaseOrder.create 被调用（在 tx 内），但事务整体回滚
    expect(purchaseOrderCreate).toHaveBeenCalledTimes(1);
    // 不发布事件
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('sync reject（purchaseOrder.create 抛错）→ 事务回滚，不 audit 不 publish', async () => {
    const { prisma, tx, auditCreate } = makePrisma({ createFail: true });
    const service = createProcurementService(prisma);

    await expect(service.createPurchaseOrder(baseInput, 'u_test')).rejects.toThrow('DB_BOOM');

    expect(tx.purchaseOrder.create).toHaveBeenCalledTimes(1);
    // audit 不应被调用（tx.purchaseOrder.create 已抛错，事务中止）
    expect(auditCreate).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('actorId 为空时使用 system 作为 actor', async () => {
    const { prisma, auditCreate } = makePrisma();
    const service = createProcurementService(prisma);

    await service.createPurchaseOrder(baseInput, '');

    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'system' }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// updatePurchaseOrder
// ═══════════════════════════════════════════════════════════════
describe('procurementService: updatePurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Draft 状态 → 成功更新（含行明细替换）', async () => {
    const existing = { id: 'PO_1', poNumber: 'PO-001', status: 'Draft', deletedAt: null, totalAmount: 100, lines: [] };
    const { prisma, tx, purchaseLineDeleteMany, purchaseLineCreateMany } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const result = await service.updatePurchaseOrder('PO_1', {
      poNumber: 'PO-001-UPDATED',
      lines: [{ description: 'New Fabric', quantity: 10, unit: 'YD', unitPrice: 20 }],
    }, 'u_test');

    expect(tx.purchaseLine.deleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: 'PO_1' } });
    expect(tx.purchaseLine.createMany).toHaveBeenCalledTimes(1);
    expect(tx.purchaseOrder.update).toHaveBeenCalledTimes(1);
    expect(result.poNumber).toBe('PO-001-UPDATED');
  });

  it('非 Draft 状态 → 抛错（仅 Draft 可编辑）', async () => {
    const existing = { id: 'PO_1', status: 'Sent', deletedAt: null, lines: [] };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.updatePurchaseOrder('PO_1', { notes: 'new' }, 'u_test')).rejects.toThrow('仅 Draft 状态可编辑');

    expect(tx.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('采购单不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createProcurementService(prisma);
    await expect(service.updatePurchaseOrder('NOT_EXIST', { notes: 'x' }, 'u_test')).rejects.toThrow('不存在');
  });

  it('★ B220（v3.111）：改条款 ⇒ 汇总行之外还有一条**字段级**痕（此前两次不同改动出来的行一模一样）', async () => {
    // 真库复现过的形状：update_purchase_order 的 detail.before/after 只有 poNumber ⇒ fieldPath 全 null
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Draft', deletedAt: null, totalAmount: 100,
      currency: 'USD', deliveryTerms: 'CIF Shenzhen', notes: '旧备注',
      exchangeRate: { toString: () => '7.15' }, // 模拟 Prisma Decimal（Json 列吃不下对象原值）
      lines: [],
    };
    const { prisma, auditCreate } = makePrisma({ existing });
    const service = createProcurementService(prisma);

    await service.updatePurchaseOrder('PO_1', { deliveryTerms: 'FOB Shanghai', notes: '旧备注', exchangeRate: 7.2 }, 'u_test');

    const rows = auditCreate.mock.calls.map((c: any[]) => c[0].data);
    const summary = rows.filter((r: any) => r.action === 'update_purchase_order');
    const field = rows.filter((r: any) => r.action === 'update_purchase_order_field');
    expect(summary).toHaveLength(1); // 原有那条汇总行不许消失（它承载 poNumber 改名）

    expect(field.map((r: any) => r.fieldPath)).toContain('deliveryTerms');
    const dt: any = field.find((r: any) => r.fieldPath === 'deliveryTerms');
    expect(dt).toMatchObject({
      targetType: 'PurchaseOrder', targetId: 'PO_1', operationType: 'update',
      beforeValue: 'CIF Shenzhen', afterValue: 'FOB Shanghai',
      transactionId: summary[0].id, // 字段级痕挂到同一次操作的汇总行上
    });

    // 三条反面对照（缺一条这条测试就是半瞎的）：
    expect(field.map((r: any) => r.fieldPath), 'notes 原值传回 ⇒ 不许记成"改过"').not.toContain('notes');
    expect(field.map((r: any) => r.fieldPath), 'lines 不是标量字段 ⇒ 刻意不追踪（见 PURCHASE_ORDER_AUDIT_FIELDS）').not.toContain('lines');
    const fx: any = field.find((r: any) => r.fieldPath === 'exchangeRate');
    expect(fx?.beforeValue, 'Decimal 原值不许直接进 Json 列 ⇒ 必须先折成字符串').toBe('7.15');
    expect(fx?.afterValue).toBe(7.2);
  });
});

// ═══════════════════════════════════════════════════════════════
// deletePurchaseOrder
// ═══════════════════════════════════════════════════════════════
describe('procurementService: deletePurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Draft 状态 → 成功软删除', async () => {
    const existing = { id: 'PO_1', poNumber: 'PO-001', status: 'Draft', deletedAt: null };
    const { prisma, tx, auditCreate } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await service.deletePurchaseOrder('PO_1', 'u_test');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'PO_1' },
      data: expect.objectContaining({ deletedAt: expect.any(Number) }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'delete_purchase_order' }),
    }));
  });

  it('非 Draft 状态 → 抛错', async () => {
    const existing = { id: 'PO_1', status: 'Sent', deletedAt: null };
    const { prisma } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.deletePurchaseOrder('PO_1', 'u_test')).rejects.toThrow('仅 Draft 状态可删除');
  });
});

// ═══════════════════════════════════════════════════════════════
// sendPurchaseOrder (Draft → Sent)
// ═══════════════════════════════════════════════════════════════
describe('procurementService: sendPurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Draft → Sent：事务更新 + audit + 发布 PurchaseOrderSent 事件', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Draft', deletedAt: null,
      supplierName: 'Supplier A', currency: 'USD', totalAmount: 1000,
      lines: [{ quantity: 100 }],
    };
    const { prisma, tx, auditCreate } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const result = await service.sendPurchaseOrder('PO_1', 'u_test');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Sent' }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'send_purchase_order',
        operationType: 'transition',
        fieldPath: 'status',
        beforeValue: 'Draft',
        afterValue: 'Sent',
      }),
    }));
    // 事务提交后发布事件
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('PurchaseOrderSent');
    expect(event.sourceEntityType).toBe('PurchaseOrder');
    expect(event.sourceEntityId).toBe('PO_1');
    expect(event.payload.poNumber).toBe('PO-001');
    expect(event.payload.supplierName).toBe('Supplier A');
    expect(event.payload.lineCount).toBe(1);
    expect(event.actorId).toBe('u_test');

    expect(result.status).toBe('Sent');
  });

  it('非 Draft 状态 → 抛错（非法状态转换）', async () => {
    const existing = { id: 'PO_1', status: 'Confirmed', deletedAt: null, lines: [] };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.sendPurchaseOrder('PO_1', 'u_test')).rejects.toThrow('非法状态转换');

    expect(tx.purchaseOrder.update).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('事件发布失败不阻断业务（fire-and-forget）', async () => {
    const existing = { id: 'PO_1', status: 'Draft', deletedAt: null, poNumber: 'PO-001', lines: [] };
    const { prisma } = makePrisma({ existing });
    publishSpy.mockRejectedValueOnce(new Error('EVENT_BUS_DOWN'));

    const service = createProcurementService(prisma);
    // 不抛错 — 事件发布是 fire-and-forget
    const result = await service.sendPurchaseOrder('PO_1', 'u_test');
    expect(result.status).toBe('Sent');
  });
});

// ═══════════════════════════════════════════════════════════════
// confirmPurchaseOrder (Sent → Confirmed)
// ═══════════════════════════════════════════════════════════════
describe('procurementService: confirmPurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Sent → Confirmed：事务更新 + audit + 发布 PurchaseOrderConfirmed 事件', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Sent', deletedAt: null,
      supplierName: 'Supplier A', currency: 'USD', totalAmount: 1000,
      lines: [{ materialCode: 'FAB-001', description: 'Fabric A', quantity: 100, unit: 'YD', unitPrice: 5.5 }],
    };
    const { prisma, tx, auditCreate } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const result = await service.confirmPurchaseOrder('PO_1', 'u_test');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Confirmed' }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'confirm_purchase_order',
        beforeValue: 'Sent',
        afterValue: 'Confirmed',
      }),
    }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('PurchaseOrderConfirmed');
    expect(event.payload.lines).toHaveLength(1);
    expect(event.payload.lines[0].materialCode).toBe('FAB-001');

    expect(result.status).toBe('Confirmed');
  });

  it('非 Sent 状态 → 抛错', async () => {
    const existing = { id: 'PO_1', status: 'Draft', deletedAt: null, lines: [] };
    const { prisma } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.confirmPurchaseOrder('PO_1', 'u_test')).rejects.toThrow('非法状态转换');
  });
});

// ═══════════════════════════════════════════════════════════════
// cancelPurchaseOrder
// ═══════════════════════════════════════════════════════════════
describe('procurementService: cancelPurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Draft → Cancelled：成功取消（含原因写入 notes）', async () => {
    const existing = { id: 'PO_1', poNumber: 'PO-001', status: 'Draft', deletedAt: null, notes: '' };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const result = await service.cancelPurchaseOrder('PO_1', 'u_test', '价格变动');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Cancelled',
        notes: expect.stringContaining('价格变动'),
      }),
    }));
    expect(result.status).toBe('Cancelled');
  });

  it('终态 Closed → 抛错（不可取消）', async () => {
    const existing = { id: 'PO_1', status: 'Closed', deletedAt: null };
    const { prisma } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.cancelPurchaseOrder('PO_1', 'u_test')).rejects.toThrow('非法状态转换');
  });
});

// ═══════════════════════════════════════════════════════════════
// closePurchaseOrder
// ═══════════════════════════════════════════════════════════════
describe('procurementService: closePurchaseOrder', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('Received → Closed：成功关闭', async () => {
    const existing = { id: 'PO_1', poNumber: 'PO-001', status: 'Received', deletedAt: null, actualDeliveryDate: null };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const result = await service.closePurchaseOrder('PO_1', 'u_test');

    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Closed',
        actualDeliveryDate: expect.any(String),
      }),
    }));
    expect(result.status).toBe('Closed');
  });

  it('非 Received/PartiallyReceived 状态 → 抛错', async () => {
    const existing = { id: 'PO_1', status: 'Draft', deletedAt: null };
    const { prisma } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.closePurchaseOrder('PO_1', 'u_test')).rejects.toThrow('非法状态转换');
  });
});

// ═══════════════════════════════════════════════════════════════
// createMaterialReceipt（来料检验）
// ═══════════════════════════════════════════════════════════════
describe('procurementService: createMaterialReceipt', () => {
  beforeEach(() => { publishSpy.mockClear(); });

  it('全部收齐 → 状态变更为 Received + 发布 MaterialReceived 事件', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Confirmed', deletedAt: null,
      supplierName: 'Supplier A',
      lines: [
        { quantity: 100, receivedQuantity: 0 },
        { quantity: 50, receivedQuantity: 0 },
      ],
    };
    const { prisma, tx, materialReceiptCreate, auditCreate } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const receiptInput: MaterialReceiptInput = {
      receiptNumber: 'MR-001',
      receivedDate: '2026-08-06',
      totalReceived: 150,
      totalAccepted: 150,
      totalRejected: 0,
      warehouseName: '上海仓',
      lineReceipts: [{lineId:'pl_1',accepted:100},{lineId:'pl_2',accepted:50}],
    };
    const result = await service.createMaterialReceipt('PO_1', receiptInput, 'u_test');

    // 创建收料记录
    expect(tx.materialReceipt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        receiptNumber: 'MR-001',
        status: 'Accepted', // totalRejected === 0
        totalReceived: 150,
        totalAccepted: 150,
        totalRejected: 0,
        warehouseName: '上海仓',
        inspectedBy: 'u_test',
      }),
    }));
    // 采购单状态变更为 Received（150 >= 150）
    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Received' }),
    }));
    // audit
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'create_material_receipt',
        targetType: 'PurchaseOrder',
      }),
    }));
    // 事件发布
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0];
    expect(event.type).toBe('MaterialReceived');
    expect(event.payload.totalAccepted).toBe(150);
    expect(event.payload.purchaseOrderStatus).toBe('Received');
    expect(event.payload.warehouseName).toBe('上海仓');

    expect(result.receiptNumber).toBe('MR-001');
  });

  it('部分收齐 → 状态变更为 PartiallyReceived', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Confirmed', deletedAt: null,
      supplierName: 'Supplier A',
      lines: [{ quantity: 100, receivedQuantity: 0 }],
    };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const receiptInput: MaterialReceiptInput = {
      receiptNumber: 'MR-002',
      receivedDate: '2026-08-06',
      totalReceived: 60,
      totalAccepted: 50,
      totalRejected: 10,
    };
    await service.createMaterialReceipt('PO_1', receiptInput, 'u_test');

    // 采购单状态变更为 PartiallyReceived（50 < 100）
    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PartiallyReceived' }),
    }));
    // 收料记录状态为 PartiallyAccepted（totalRejected > 0 且 totalAccepted > 0）
    expect(tx.materialReceipt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PartiallyAccepted' }),
    }));
  });

  it('全部不合格 → 收料记录状态为 Rejected', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'PartiallyReceived', deletedAt: null,
      lines: [{ quantity: 100, receivedQuantity: 50 }],
    };
    const { prisma, tx } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    const receiptInput: MaterialReceiptInput = {
      receiptNumber: 'MR-003',
      receivedDate: '2026-08-06',
      totalReceived: 30,
      totalAccepted: 0,
      totalRejected: 30,
    };
    await service.createMaterialReceipt('PO_1', receiptInput, 'u_test');

    // 状态为 PartiallyReceived（50 + 0 = 50 < 100）
    expect(tx.purchaseOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PartiallyReceived' }),
    }));
    // 收料记录状态为 Rejected（totalAccepted === 0）
    expect(tx.materialReceipt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Rejected' }),
    }));
  });

  it('非 Confirmed/PartiallyReceived/Received 状态 → 抛错（不可收料）', async () => {
    const existing = { id: 'PO_1', status: 'Draft', deletedAt: null, lines: [{quantity:100,receivedQuantity:0}] };
    const { prisma } = makePrisma({ existing });

    const service = createProcurementService(prisma);
    await expect(service.createMaterialReceipt('PO_1', {
      receiptNumber: 'MR-004', receivedDate: '2026-08-06',
      totalReceived: 10, totalAccepted: 10, totalRejected: 0,
    }, 'u_test')).rejects.toThrow('仅 Confirmed/PartiallyReceived/Received 状态可收料');
  });

  it('采购单不存在 → 抛错', async () => {
    const { prisma } = makePrisma({ existing: null });
    const service = createProcurementService(prisma);
    await expect(service.createMaterialReceipt('NOT_EXIST', {
      receiptNumber: 'MR-005', receivedDate: '2026-08-06',
      totalReceived: 10, totalAccepted: 10, totalRejected: 0,
    }, 'u_test')).rejects.toThrow('不存在');
  });

  it('事件发布失败不阻断业务', async () => {
    const existing = {
      id: 'PO_1', poNumber: 'PO-001', status: 'Confirmed', deletedAt: null,
      lines: [{ quantity: 100, receivedQuantity: 0 }],
    };
    const { prisma } = makePrisma({ existing });
    publishSpy.mockRejectedValueOnce(new Error('EVENT_BUS_DOWN'));

    const service = createProcurementService(prisma);
    const result = await service.createMaterialReceipt('PO_1', {
      receiptNumber: 'MR-006', receivedDate: '2026-08-06',
      totalReceived: 100, totalAccepted: 100, totalRejected: 0,
    }, 'u_test');
    expect(result.receiptNumber).toBe('MR-006');
  });
});

describe('source demand allocation protects PO lifecycle', () => {
  function allocated(received = 0) {
    const f = makePrisma({ existing: {id:'PO_1',poNumber:'PO-1',status:'Draft',deletedAt:null,totalAmount:10,lines:[]} });
    f.tx.purchaseDemandAllocation = { count:vi.fn(async()=>1), findMany:vi.fn(async()=>[{id:'A1',demandId:'D1'}]), updateMany:vi.fn(async()=>({count:1})) };
    f.tx.purchaseLine.findMany=vi.fn(async()=>[{receivedQuantity:received,rejectedQuantity:0}]);
    f.tx.procurementDemand={update:vi.fn(async()=>({}))};
    return f;
  }
  it('rejects ordinary edit before deleting lines or losing source references', async()=>{
    const f=allocated();await expect(createProcurementService(f.prisma).updatePurchaseOrder('PO_1',{lines:baseInput.lines},'buyer')).rejects.toThrow('不可通用编辑');
    expect(f.purchaseLineDeleteMany).not.toHaveBeenCalled();
  });
  it('allows delivery/payment terms with identical line payload and preserves source line IDs', async()=>{
    const line={...baseInput.lines[0],id:'PL1',lineNumber:1,receivedQuantity:0,rejectedQuantity:0};
    const f=makePrisma({existing:{id:'PO_1',status:'Draft',deletedAt:null,totalAmount:550,lines:[line]}});
    f.tx.purchaseDemandAllocation={count:vi.fn(async()=>1)};
    await createProcurementService(f.prisma).updatePurchaseOrder('PO_1',{paymentTerms:'30 days',lines:[baseInput.lines[0]]},'buyer');
    expect(f.purchaseLineDeleteMany).not.toHaveBeenCalled();expect(f.purchaseOrderUpdate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({paymentTerms:'30 days'})}));
  });
  it.each(['cancel','delete'])('%s releases only unreceived allocations and advances demand revision', async action=>{
    const f=allocated();const service=createProcurementService(f.prisma);
    if(action==='cancel') await service.cancelPurchaseOrder('PO_1','buyer');else await service.deletePurchaseOrder('PO_1','buyer');
    expect(f.tx.purchaseDemandAllocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'Released'})}));
    expect(f.tx.procurementDemand.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({revision:{increment:1}})}));
  });
  it('never releases already received source quantity', async()=>{
    const f=allocated(1);await expect(createProcurementService(f.prisma).cancelPurchaseOrder('PO_1','buyer')).rejects.toThrow('已发生收货');
    expect(f.tx.purchaseDemandAllocation.updateMany).not.toHaveBeenCalled();expect(f.purchaseOrderUpdate).not.toHaveBeenCalled();
  });
});

describe('PO row lock rejects stale status snapshots', () => {
  it.each([
    ['send', 'Draft'], ['confirm', 'Sent'], ['cancel', 'Confirmed'], ['update', 'Draft'], ['delete', 'Draft'], ['close', 'Received'],
  ])('%s cannot mutate a PO cancelled after the initial read', async (action, status) => {
    const f=makePrisma({existing:{id:'PO_1',poNumber:'PO-1',status,deletedAt:null,updatedAt:1n,totalAmount:10,lines:[]}});
    f.tx.$queryRaw=vi.fn(async()=>[{status:'Cancelled',deletedAt:null,updatedAt:2n}]);
    const svc=createProcurementService(f.prisma);
    const call=action==='send'?()=>svc.sendPurchaseOrder('PO_1','buyer'):action==='confirm'?()=>svc.confirmPurchaseOrder('PO_1','buyer'):action==='cancel'?()=>svc.cancelPurchaseOrder('PO_1','buyer'):action==='update'?()=>svc.updatePurchaseOrder('PO_1',{paymentTerms:'30 days'},'buyer'):action==='delete'?()=>svc.deletePurchaseOrder('PO_1','buyer'):()=>svc.closePurchaseOrder('PO_1','buyer');
    await expect(call()).rejects.toThrow('状态或内容已变化');
    expect(f.purchaseOrderUpdate).not.toHaveBeenCalled();expect(f.purchaseLineDeleteMany).not.toHaveBeenCalled();
  });
  it('rejects stale content even if status still Draft', async()=>{
    const f=makePrisma({existing:{id:'PO_1',status:'Draft',updatedAt:1n,deletedAt:null,totalAmount:10,lines:[]}});
    f.tx.$queryRaw=vi.fn(async()=>[{status:'Draft',deletedAt:null,updatedAt:2n}]);
    await expect(createProcurementService(f.prisma).updatePurchaseOrder('PO_1',{paymentTerms:'30 days'},'buyer')).rejects.toThrow('状态或内容已变化');
    expect(f.purchaseOrderUpdate).not.toHaveBeenCalled();
  });
});

describe('procurement authorized order binding', () => {
  it.each(['send','confirm','cancel','update','delete','close','receive'])('%s rejects a source changed after authorization', async action=>{
    const status=action==='confirm'?'Sent':action==='close'?'Received':action==='receive'?'Confirmed':'Draft';
    const f=makePrisma({existing:{id:'PO_1',status,updatedAt:1n,deletedAt:null,totalAmount:10,lines:[{quantity:1,receivedQuantity:0}],orderId:'O2'}});
    f.tx.$queryRaw=vi.fn(async()=>[{status,deletedAt:null,updatedAt:1n,orderId:'O2'}]);
    const svc=createProcurementService(f.prisma), options={expectedOrderId:'O1'};
    const call=action==='send'?()=>svc.sendPurchaseOrder('PO_1','buyer',options):action==='confirm'?()=>svc.confirmPurchaseOrder('PO_1','buyer',options):action==='cancel'?()=>svc.cancelPurchaseOrder('PO_1','buyer',undefined,options):action==='update'?()=>svc.updatePurchaseOrder('PO_1',{paymentTerms:'30 days'},'buyer',options):action==='delete'?()=>svc.deletePurchaseOrder('PO_1','buyer',options):action==='close'?()=>svc.closePurchaseOrder('PO_1','buyer',options):()=>svc.createMaterialReceipt('PO_1',{receiptNumber:'R1',receivedDate:'2026-09-30',totalReceived:1,totalAccepted:0,totalRejected:1} as any,'buyer',options);
    await expect(call()).rejects.toMatchObject({status:409});expect(f.purchaseOrderUpdate).not.toHaveBeenCalled();
  });
  it('creation rejects BOM belonging to another order before creating PO',async()=>{
    const f=makePrisma();f.tx.order={findUnique:vi.fn(async()=>({id:'O1'}))};f.tx.bOM={findUnique:vi.fn(async()=>({orderId:'O2',deletedAt:null}))};
    await expect(createProcurementService(f.prisma).createPurchaseOrder({...baseInput,orderId:'O1',bomId:'B1'},'buyer')).rejects.toThrow('不一致');
    expect(f.purchaseOrderCreate).not.toHaveBeenCalled();
  });
  it.each([null,undefined,[],['O1']])('inquiry query applies scope before pagination: %s',async visibleOrderIds=>{
    const db:any={supplierInquiry:{findMany:vi.fn(async()=>[]),count:vi.fn(async()=>0)}};
    await createProcurementService(db).listSupplierInquiries({visibleOrderIds,limit:5,offset:5,search:'fabric'});
    const where=db.supplierInquiry.findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(4);
    if(visibleOrderIds==null)expect(where.AND).toBeUndefined();else expect(where.AND).toEqual([{orderId:{in:visibleOrderIds}}]);
    expect(db.supplierInquiry.count.mock.calls[0][0].where).toEqual(where);
  });
});

describe('加工服务采购类型',()=>{
 it('创建固化类型和来源订单行',async()=>{const f=makePrisma();(f.tx as any).orderLine={findUnique:vi.fn(async()=>({orderId:'O1'}))};(f.tx as any).order={findUnique:vi.fn(async()=>({id:'O1'}))};const r=await createProcurementService(f.prisma).createPurchaseOrder({...baseInput,orderId:'O1',lines:[{description:'加工',unit:'PC',quantity:10,unitPrice:2,kind:'ProcessingService',orderLineId:'OL1'}]},'u');expect(r.lines[0]).toMatchObject({kind:'ProcessingService',orderLineId:'OL1'});});
 it.each([{kind:'ProcessingService',unitPrice:0,orderLineId:'OL1'},{kind:'ProcessingService',unitPrice:2},{kind:'Other',unitPrice:2}])('非法服务类型/价格/来源不建单 %j',async patch=>{const f=makePrisma();await expect(createProcurementService(f.prisma).createPurchaseOrder({...baseInput,lines:[{description:'加工',unit:'PC',quantity:10,...patch} as any]},'u')).rejects.toThrow();expect(f.purchaseOrderCreate).not.toHaveBeenCalled();});
 it('不同订单的行不能挂入加工采购',async()=>{const f=makePrisma();(f.tx as any).orderLine={findUnique:vi.fn(async()=>({orderId:'OTHER'}))};await expect(createProcurementService(f.prisma).createPurchaseOrder({...baseInput,orderId:'O1',lines:[{description:'加工',unit:'PC',quantity:10,unitPrice:2,kind:'ProcessingService',orderLineId:'OL1'}]},'u')).rejects.toThrow('不属于');});
 it('服务行不能走物料收料',async()=>{const f=makePrisma({existing:{id:'PO_1',status:'Confirmed',lines:[{id:'S',kind:'ProcessingService',unit:'PC',quantity:10,receivedQuantity:0}]}});await expect(createProcurementService(f.prisma).createMaterialReceipt('PO_1',{receiptNumber:'r',receivedDate:'2026-09-30',totalReceived:1,totalAccepted:1,totalRejected:0},'u')).rejects.toThrow('服务交付');expect(f.materialReceiptCreate).not.toHaveBeenCalled();});
});
