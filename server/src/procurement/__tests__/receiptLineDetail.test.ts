import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createProcurementService } from '../procurementService';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * 批次 C/D 供应商+采购车道回归测试：
 *   C6 采购单首次全部收齐 → 供应商 totalOrders/totalAmount 同事务累加（幂等：超收补收不重复计）
 *   D5 收货表单仓库落库 + MaterialReceived 事件透传 warehouseId（不再永远进主仓的契约前提）
 *   D6 行级收货明细：按行精确回写（不再按行号贪心分摊）+ 行级合计与单头总数一致性校验
 *
 * 设计：内存态 prisma（purchaseLine.update 真实累加、factoryProfile.updateMany 真实累加、
 *       materialReceipt 内存表支持查重），与 receiptWriteback.test.ts 同款透明穿透 $transaction。
 */

const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

function makeDb(opts: {
  id?: string;
  status?: string;
  supplierRelationId?: string | null;
  totalAmount?: number;
  lines: Array<{ id: string; quantity: number; receivedQuantity?: number; unit?: string }>;
  factory?: { relationId: string; totalOrders?: number; totalAmount?: number } | null;
}) {
  const poRecord: any = {
    id: opts.id ?? 'PO_LD',
    poNumber: 'PO-20260828-001',
    status: opts.status ?? 'Confirmed',
    deletedAt: null,
    supplierName: 'Supplier A',
    supplierRelationId: opts.supplierRelationId ?? null,
    totalAmount: opts.totalAmount ?? 5000,
    currency: 'USD',
    expectedDeliveryDate: '2026-09-01',
    lines: opts.lines.map((l, i) => ({
      id: l.id,
      lineNumber: i + 1,
      materialCode: `MAT-${i + 1}`,
      description: `物料 ${i + 1}`,
      category: null,
      specification: null,
      unit: l.unit ?? 'YD',
      unitPrice: 10,
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity ?? 0,
    })),
  };

  const factoryRecord: any = opts.factory
    ? {
        id: 'FACP_1',
        relationId: opts.factory.relationId,
        totalOrders: opts.factory.totalOrders ?? 0,
        totalAmount: opts.factory.totalAmount ?? 0,
        deletedAt: null,
      }
    : null;

  const receipts: any[] = [];

  const purchaseOrderFindUnique = vi.fn(async ({ where }: any) =>
    where.id === poRecord.id || where.poNumber === poRecord.poNumber ? poRecord : null,
  );

  const purchaseLineUpdate = vi.fn(async ({ where, data }: any) => {
    const line = poRecord.lines.find((l: any) => l.id === where.id);
    if (!line) throw new Error(`purchase line ${where.id} not found`);
    if (data?.receivedQuantity?.increment !== undefined) {
      line.receivedQuantity += data.receivedQuantity.increment;
    }
    return line;
  });

  const materialReceiptCreate = vi.fn(async ({ data }: any) => {
    receipts.push({ ...data });
    return { ...data };
  });
  const materialReceiptFindFirst = vi.fn(async ({ where }: any) =>
    receipts.find((r) => r.purchaseOrderId === where.purchaseOrderId && r.receiptNumber === where.receiptNumber) ?? null,
  );

  // C6：FactoryProfile.updateMany 内存实现（relationId + deletedAt=null 过滤，increment 真实累加）
  const factoryProfileUpdateMany = vi.fn(async ({ where, data }: any) => {
    if (
      factoryRecord &&
      factoryRecord.relationId === where.relationId &&
      factoryRecord.deletedAt === null
    ) {
      if (data.totalOrders?.increment) factoryRecord.totalOrders += data.totalOrders.increment;
      if (data.totalAmount?.increment) factoryRecord.totalAmount += data.totalAmount.increment;
      if (data.updatedAt) factoryRecord.updatedAt = data.updatedAt;
      return { count: 1 };
    }
    return { count: 0 };
  });

  const tx: any = {
    warehouse: { findFirst: vi.fn(async({where}:any)=>({ id:where.id??'WH_LD', name:where.id==='wh_aux'?'辅料仓':'主仓', type:where.id==='wh_aux'?'Auxiliary':'Main', isActive:true, deletedAt:null })) },
    $queryRaw: vi.fn(async(sql:any)=>sql.sql.includes('"Warehouse"') ? [{id:sql.values[0]}] : [{status:poRecord.status,updatedAt:poRecord.updatedAt,orderId:poRecord.orderId??null,deletedAt:poRecord.deletedAt}]),
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    purchaseOrder: { update: vi.fn(async ({ data }: any) => { Object.assign(poRecord, data); return poRecord; }) },
    purchaseLine: { update: purchaseLineUpdate },
    materialReceipt: { create: materialReceiptCreate, findFirst: materialReceiptFindFirst },
    factoryProfile: { updateMany: factoryProfileUpdateMany },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'AL_LD' }), findFirst: vi.fn(async()=>null) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    purchaseOrder: { findUnique: purchaseOrderFindUnique },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return { prisma, poRecord, factoryRecord, receipts, purchaseLineUpdate, factoryProfileUpdateMany };
}

function publishedMaterialReceivedEvents(): any[] {
  return publishSpy.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'MaterialReceived');
}

beforeEach(() => {
  publishSpy.mockClear();
});

// ═══ C6：供应商累计单数/金额累加 ═══
describe('C6：采购单收货全部完成 → 供应商 totalOrders/totalAmount 累加', () => {
  it('首次全部收齐（→Received）→ totalOrders +1、totalAmount += 采购金额（同事务）', async () => {
    const { prisma, factoryRecord, factoryProfileUpdateMany } = makeDb({
      supplierRelationId: 'REL_SUP1',
      totalAmount: 5000,
      lines: [{ id: 'pl_1', quantity: 100 }],
      factory: { relationId: 'REL_SUP1', totalOrders: 3, totalAmount: 12000 },
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-C6-001',
      receivedDate: '2026-08-28',
      totalReceived: 100,
      totalAccepted: 100,
      totalRejected: 0,
    }, 'u_test');

    expect(factoryProfileUpdateMany).toHaveBeenCalledTimes(1);
    expect(factoryRecord.totalOrders).toBe(4);
    expect(factoryRecord.totalAmount).toBe(17000); // 12000 + 5000
  });

  it('幂等：超收补收（Received → Received）不重复累加；部分到货（→PartiallyReceived）不累加', async () => {
    // 已在 Received 态的采购单再补收（超收场景）→ 不得二次计数
    const over = makeDb({
      status: 'Received',
      supplierRelationId: 'REL_SUP1',
      totalAmount: 5000,
      lines: [{ id: 'pl_1', quantity: 100, receivedQuantity: 100 }],
      factory: { relationId: 'REL_SUP1', totalOrders: 4, totalAmount: 17000 },
    });
    await createProcurementService(over.prisma).createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-C6-002',
      receivedDate: '2026-08-29',
      totalReceived: 10,
      totalAccepted: 10,
      totalRejected: 0,
    }, 'u_test');
    expect(over.factoryProfileUpdateMany).not.toHaveBeenCalled();
    expect(over.factoryRecord.totalOrders).toBe(4);

    // 部分到货 → 未进 Received → 不累加
    const partial = makeDb({
      supplierRelationId: 'REL_SUP1',
      lines: [{ id: 'pl_1', quantity: 100 }],
      factory: { relationId: 'REL_SUP1' },
    });
    await createProcurementService(partial.prisma).createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-C6-003',
      receivedDate: '2026-08-28',
      totalReceived: 40,
      totalAccepted: 40,
      totalRejected: 0,
    }, 'u_test');
    expect(partial.factoryProfileUpdateMany).not.toHaveBeenCalled();
    expect(partial.factoryRecord.totalOrders).toBe(0);
  });

  it('无工厂档案的供应商（updateMany count=0）静默跳过，收货主流程不阻断', async () => {
    const { prisma, poRecord } = makeDb({
      supplierRelationId: 'REL_GHOST',
      lines: [{ id: 'pl_1', quantity: 100 }],
      factory: null,
    });
    const service = createProcurementService(prisma);
    await service.createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-C6-004',
      receivedDate: '2026-08-28',
      totalReceived: 100,
      totalAccepted: 100,
      totalRejected: 0,
    }, 'u_test');
    expect(poRecord.status).toBe('Received'); // 主流程正常完成
  });
});

// ═══ D5：收货仓库手填生效 ═══
describe('D5：收货仓库手填生效', () => {
  it('表单选定仓库 → 收料单落库 warehouseId/warehouseName，事件透传 warehouseId', async () => {
    const { prisma, receipts } = makeDb({
      lines: [{ id: 'pl_1', quantity: 100 }],
    });
    const service = createProcurementService(prisma);
    await service.createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-D5-001',
      receivedDate: '2026-08-28',
      warehouseId: 'wh_aux',
      warehouseName: '辅料仓',
      totalReceived: 50,
      totalAccepted: 50,
      totalRejected: 0,
    }, 'u_test');

    expect(receipts[0].warehouseId).toBe('wh_aux');
    expect(receipts[0].warehouseName).toBe('辅料仓');
    const ev = publishedMaterialReceivedEvents()[0];
    expect(ev.payload.warehouseId).toBe('wh_aux');
    expect(ev.payload.warehouseName).toBe('辅料仓');
  });
});

// ═══ D6：采购收货行级明细 ═══
describe('D6：行级收货明细', () => {
  it('按行精确回写：第二行全到、第一行未到 → 各行 receivedQuantity 按明细累加（不再按行号分摊）', async () => {
    const { prisma, poRecord } = makeDb({
      lines: [
        { id: 'pl_1', quantity: 100 },
        { id: 'pl_2', quantity: 50 },
      ],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_LD', {
      receiptNumber: 'MR-D6-001',
      receivedDate: '2026-08-28',
      totalReceived: 50,
      totalAccepted: 50,
      totalRejected: 0,
      lineReceipts: [{ lineId: 'pl_2', accepted: 50, rejected: 0 }],
    }, 'u_test');

    // 旧贪心分摊会把 50 全记到 pl_1；行级明细下必须精确落在 pl_2
    expect(poRecord.lines[0].receivedQuantity).toBe(0);
    expect(poRecord.lines[1].receivedQuantity).toBe(50);
    expect(poRecord.status).toBe('PartiallyReceived');

    // 事件 stockInLines 仅含明细行（L8 按行入库）
    const ev = publishedMaterialReceivedEvents()[0];
    expect(ev.payload.stockInLines).toHaveLength(1);
    expect(ev.payload.stockInLines[0].lineId).toBe('pl_2');
    expect(ev.payload.stockInLines[0].quantity).toBe(50);
  });

  it('行级合计与单头总数不一致 → 拒绝（数字正确，防双口径漂移）', async () => {
    const { prisma, poRecord } = makeDb({
      lines: [{ id: 'pl_1', quantity: 100 }],
    });
    const service = createProcurementService(prisma);
    await expect(
      service.createMaterialReceipt('PO_LD', {
        receiptNumber: 'MR-D6-002',
        receivedDate: '2026-08-28',
        totalReceived: 60,
        totalAccepted: 60,
        totalRejected: 0,
        lineReceipts: [{ lineId: 'pl_1', accepted: 50 }], // Σ=50 ≠ 60
      }, 'u_test'),
    ).rejects.toThrow(/不一致/);
    expect(poRecord.lines[0].receivedQuantity).toBe(0); // 未污染
  });

  it('引用不属于本采购单的行 / 重复行 → 拒绝', async () => {
    const { prisma } = makeDb({
      lines: [{ id: 'pl_1', quantity: 100 }],
    });
    const service = createProcurementService(prisma);
    await expect(
      service.createMaterialReceipt('PO_LD', {
        receiptNumber: 'MR-D6-003',
        receivedDate: '2026-08-28',
        totalReceived: 10,
        totalAccepted: 10,
        totalRejected: 0,
        lineReceipts: [{ lineId: 'pl_GHOST', accepted: 10 }],
      }, 'u_test'),
    ).rejects.toThrow(/不属于采购单/);

    await expect(
      service.createMaterialReceipt('PO_LD', {
        receiptNumber: 'MR-D6-004',
        receivedDate: '2026-08-28',
        totalReceived: 20,
        totalAccepted: 20,
        totalRejected: 0,
        lineReceipts: [
          { lineId: 'pl_1', accepted: 10 },
          { lineId: 'pl_1', accepted: 10 },
        ],
      }, 'u_test'),
    ).rejects.toThrow(/重复/);
  });

  it('多行采购缺少lineReceipts必须拒绝，不贪心推断物料', async () => {
    const {prisma,poRecord}=makeDb({lines:[{id:'pl_1',quantity:100},{id:'pl_2',quantity:50}]});
    await expect(createProcurementService(prisma).createMaterialReceipt('PO_LD',{receiptNumber:'MR-D6-005',receivedDate:'2026-08-28',totalReceived:120,totalAccepted:120,totalRejected:0},'u_test')).rejects.toThrow('必须逐行');
    expect(poRecord.lines.map((l:any)=>l.receivedQuantity)).toEqual([0,0]);
  });
});
