import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createProcurementService } from '../procurementService';
import { businessEventBus } from '../../events/businessEventBus';

/**
 * L8 断层修复回归测试：收料确认 → PurchaseLine.receivedQuantity 行级回写 → L8 判定数据就绪。
 *
 * 覆盖场景（任务验收清单）：
 *   1. 部分收料累计：多张部分收料时行级增量持续累加，事件 stockInLines 仅含"本次"数量
 *   2. 足额达标后 L8 条件为真：receivedQuantity>0 的行存在，事件携带 purchaseOrderId/receiptId/stockInLines
 *   3. 重复确认幂等：同收料单号二次确认不二次累计、不重复发布事件
 *   4. 超采按裁决处理：允许超过 orderedQuantity（文档 §2.2「Received 可超收补收」/ §5「累计>订单数→Received」）
 *
 * 设计：内存态 prisma（purchaseLine.update 真实累加、materialReceipt 内存表支持查重），
 *       与既有 procurementService.test.ts 的透明穿透 $transaction 模式一致。
 */

const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

function makeDb(opts: {
  id?: string;
  poNumber?: string;
  status?: string;
  lines: Array<{ id: string; quantity: number; receivedQuantity?: number; materialCode?: string | null }>;
}) {
  const poRecord: any = {
    id: opts.id ?? 'PO_WB',
    poNumber: opts.poNumber ?? 'PO-20260827-001',
    status: opts.status ?? 'Confirmed',
    deletedAt: null,
    supplierName: 'Supplier A',
    // 不设 supplierRelationId → H1c 动态评分路径静默跳过，保持本套件聚焦回写与事件契约
    supplierRelationId: null,
    lines: opts.lines.map((l, i) => ({
      id: l.id,
      lineNumber: i + 1,
      materialCode: l.materialCode ?? `MAT-${i + 1}`,
      description: `物料 ${i + 1}`,
      category: null,
      specification: null,
      unit: 'YD',
      unitPrice: 10,
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity ?? 0, rejectedQuantity:0,
    })),
  };

  // 已创建收料单内存表（幂等查重真源）
  const receipts: any[] = [];

  const purchaseOrderFindUnique = vi.fn(async ({ where }: any) =>
    where.id === poRecord.id || where.poNumber === poRecord.poNumber ? poRecord : null,
  );

  const purchaseLineUpdate = vi.fn(async ({ where, data }: any) => {
    const line = poRecord.lines.find((l: any) => l.id === where.id);
    if (!line) throw new Error(`purchase line ${where.id} not found`);
    if (data?.receivedQuantity && data.receivedQuantity.increment !== undefined) {
      line.receivedQuantity += data.receivedQuantity.increment;
    }
    if(data?.rejectedQuantity) line.rejectedQuantity += data.rejectedQuantity.increment;
    return line;
  });

  const materialReceiptCreate = vi.fn(async ({ data }: any) => {
    receipts.push({ ...data });
    return { ...data };
  });

  const materialReceiptFindFirst = vi.fn(async ({ where }: any) =>
    receipts.find((r) => r.purchaseOrderId === where.purchaseOrderId && r.receiptNumber === where.receiptNumber) ?? null,
  );

  const auditCreate = vi.fn().mockResolvedValue({ id: 'AL_WB' });

  const tx: any = {
    warehouse: { findFirst: vi.fn(async()=>({ id:'WH_WB', name:'主仓', type:'Main', isActive:true, deletedAt:null })) },
    $queryRaw: vi.fn(async(sql:any)=>sql.sql.includes('"Warehouse"') ? [{id:'WH_WB'}] : [{status:poRecord.status,updatedAt:poRecord.updatedAt,orderId:poRecord.orderId??null,deletedAt:poRecord.deletedAt}]),
    agentJob: { create: vi.fn().mockResolvedValue({}) },
    purchaseOrder: { update: vi.fn(async ({ data }: any) => { Object.assign(poRecord, data); return poRecord; }) },
    purchaseLine: { update: purchaseLineUpdate },
    materialReceipt: { create: materialReceiptCreate, findFirst: materialReceiptFindFirst },
    auditLog: { create: auditCreate, findFirst: vi.fn(async()=>{ const data=auditCreate.mock.calls.at(-1)?.[0]?.data; return data || null; }) },
    // EntityLink 图谱（W-C A1）：syncMaterialReceiptReferences 走 tx 内 upsert
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    purchaseOrder: { findUnique: purchaseOrderFindUnique },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return { prisma, tx, poRecord, receipts, purchaseLineUpdate, auditCreate };
}

/** 复刻 L8AutoStockIn 的可入库判定条件（fallback 口径）：有 receivedQuantity>0 的行 */
function l8ConditionMet(poRecord: any): boolean {
  return poRecord.lines.filter((l: any) => Number(l.receivedQuantity) > 0).length > 0;
}

function publishedMaterialReceivedEvents(): any[] {
  return publishSpy.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'MaterialReceived');
}

beforeEach(() => {
  publishSpy.mockClear();
});

describe('receiptWriteback（L8 断层修复）：收料确认 → PurchaseLine.receivedQuantity 回写', () => {
  it('部分收料累计：两次收料 40+60 → 行累计 0→40→100，事件增量分别为 40/60（非全量累计）', async () => {
    const { prisma, poRecord } = makeDb({
      lines: [{ id: 'pl_1', quantity: 100 }],
    });
    const service = createProcurementService(prisma);

    // 第一次部分收料：合格 40
    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-WB-001',
      receivedDate: '2026-08-27',
      totalReceived: 40,
      totalAccepted: 40,
      totalRejected: 0,
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(40);
    expect(poRecord.status).toBe('PartiallyReceived');
    expect(l8ConditionMet(poRecord)).toBe(true); // L8 条件首次即就绪

    // 第二次收料：合格 60 → 达标
    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-WB-002',
      receivedDate: '2026-08-28',
      totalReceived: 60,
      totalAccepted: 60,
      totalRejected: 0,
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(100);
    expect(poRecord.status).toBe('Received');

    // 事件的行级增量为"本次"数量，第二次不是全量累计 100
    const [ev1, ev2] = publishedMaterialReceivedEvents();
    expect(ev1.payload.stockInLines).toEqual([expect.objectContaining({ lineId: 'pl_1', quantity: 40 })]);
    expect(ev2.payload.stockInLines).toEqual([expect.objectContaining({ lineId: 'pl_1', quantity: 60 })]);
  });

  it('足额达标后 L8 条件为真：一次多行收齐，事件携带 purchaseOrderId/receiptId 且增量总和 = 本次合格数', async () => {
    const { prisma, poRecord } = makeDb({
      lines: [
        { id: 'pl_a', quantity: 60 },
        { id: 'pl_b', quantity: 40 },
      ],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-WB-003',
      lineReceipts: [{lineId:'pl_a',accepted:60},{lineId:'pl_b',accepted:40}],
      receivedDate: '2026-08-27',
      totalReceived: 100,
      totalAccepted: 100,
      totalRejected: 0,
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(60);
    expect(poRecord.lines[1].receivedQuantity).toBe(40);
    expect(poRecord.status).toBe('Received');
    // L8 消费端判定：PO 存在 receivedQuantity>0 的行
    expect(l8ConditionMet(poRecord)).toBe(true);

    const ev = publishedMaterialReceivedEvents()[0];
    // L8 前置守卫字段齐备
    expect(ev.payload.purchaseOrderId).toBe('PO_WB');
    expect(typeof ev.payload.receiptId).toBe('string');
    expect(ev.payload.receiptId.length).toBeGreaterThan(0);
    // 行级增量总和 = 本次合格数；每行增量为合格口径（非 totalReceived）
    const stockInLines = ev.payload.stockInLines as Array<{ lineId: string; quantity: number }>;
    expect(stockInLines.reduce((s, l) => s + l.quantity, 0)).toBe(100);
    expect(stockInLines.map((l) => l.lineId).sort()).toEqual(['pl_a', 'pl_b']);
  });

  it('多行收料按显式明细30/20回写，不自动推断物料', async () => {
    const { prisma, poRecord } = makeDb({
      lines: [
        { id: 'pl_l1', quantity: 30 },
        { id: 'pl_l2', quantity: 30 },
      ],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-WB-004',
      lineReceipts: [{lineId:'pl_l1',accepted:30},{lineId:'pl_l2',accepted:20}],
      receivedDate: '2026-08-27',
      totalReceived: 50,
      totalAccepted: 50,
      totalRejected: 0,
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(30);
    expect(poRecord.lines[1].receivedQuantity).toBe(20);
    expect(poRecord.status).toBe('PartiallyReceived');

    const stockInLines = publishedMaterialReceivedEvents()[0].payload.stockInLines as Array<{ quantity: number }>;
    expect(stockInLines.map((l) => l.quantity).sort((a, b) => b - a)).toEqual([30, 20]);
  });

  it('重复确认幂等：同收料单号二次确认 → 返回原单、不新建记录、不回写、不发布事件', async () => {
    const { prisma, poRecord, receipts, purchaseLineUpdate } = makeDb({
      lines: [{ id: 'pl_idem', quantity: 80 }],
    });
    const service = createProcurementService(prisma);

    const input = {
      receiptNumber: 'MR-IDEM-001',
      receivedDate: '2026-08-27',
      totalReceived: 50,
      totalAccepted: 50,
      totalRejected: 0,
    };
    const first = await service.createMaterialReceipt('PO_WB', input, 'u_test');
    const replay = await service.createMaterialReceipt('PO_WB', input, 'u_test');

    // 返回原收料单（业务键一致）
    expect(replay.receiptNumber).toBe(first.receiptNumber);
    // 只建一张收料单、只回写一次、只发布一次事件
    expect(receipts).toHaveLength(1);
    expect(purchaseLineUpdate).toHaveBeenCalledTimes(1);
    expect(publishedMaterialReceivedEvents()).toHaveLength(1);
    // 数量仍为首次回写后的值（无二次累计）
    expect(poRecord.lines[0].receivedQuantity).toBe(50);
  });

  it('超采按裁决处理：Received 状态补收 20 → 行累计 120 > orderedQuantity 100，状态保持 Received', async () => {
    // 裁决依据：文档 §2.2「Received | ✅ | 超收（已全部到货后补收）」
    //           与 §5「超收 | 累计 > 订单数 | Received」→ 允许超过 orderedQuantity，不做封顶
    const { prisma, poRecord } = makeDb({
      status: 'Received',
      lines: [{ id: 'pl_over', quantity: 100, receivedQuantity: 100 }],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-OVER-001',
      receivedDate: '2026-08-27',
      totalReceived: 20,
      totalAccepted: 20,
      totalRejected: 0,
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(120);
    expect(poRecord.lines[0].receivedQuantity).toBeGreaterThan(poRecord.lines[0].quantity);
    expect(poRecord.status).toBe('Received');
  });

  it('全部拒收（totalAccepted=0）→ 精确回写拒收量，事件 stockInLines 为空数组（L8 将跳过）', async () => {
    const { prisma, poRecord, auditCreate } = makeDb({
      lines: [{ id: 'pl_rej', quantity: 50 }],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-REJ-001',
      receivedDate: '2026-08-27',
      totalReceived: 30,
      totalAccepted: 0,
      totalRejected: 30,
      rejectionReason: '色差超标',
    }, 'u_test');

    expect(poRecord.lines[0].receivedQuantity).toBe(0);
    expect(auditCreate.mock.calls.every((c: any[]) => c[0]?.data?.action === 'create_material_receipt')).toBe(true);
    const detailAfter = auditCreate.mock.calls[0][0].data.detail.after;
    expect(detailAfter.lineWriteback).toEqual([{lineId:'pl_rej',quantity:0,rejected:30}]);
    expect(poRecord.lines[0].rejectedQuantity).toBe(30);

    const ev = publishedMaterialReceivedEvents()[0];
    expect(ev.payload.stockInLines).toEqual([]);
  });

  it('审计追溯：auditLog detail.after.lineWriteback 记录行级回写流水', async () => {
    const { prisma, auditCreate } = makeDb({
      lines: [
        { id: 'pl_aud1', quantity: 25 },
        { id: 'pl_aud2', quantity: 35 },
      ],
    });
    const service = createProcurementService(prisma);

    await service.createMaterialReceipt('PO_WB', {
      receiptNumber: 'MR-AUD-001',
      lineReceipts: [{lineId:'pl_aud1',accepted:25},{lineId:'pl_aud2',accepted:15}],
      receivedDate: '2026-08-27',
      totalReceived: 40,
      totalAccepted: 40,
      totalRejected: 0,
    }, 'u_test');

    const detail = auditCreate.mock.calls[0][0].data.detail as {
      after: { lineWriteback: Array<{ lineId: string; quantity: number }> };
    };
    expect(detail.after.lineWriteback).toEqual([
      { lineId: 'pl_aud1', quantity: 25, rejected:0 },
      { lineId: 'pl_aud2', quantity: 15, rejected:0 },
    ]);
  });
});


describe('receipt operational integrity',()=>{
  beforeEach(()=>publishSpy.mockClear());
  it('one line over-receipt never closes another line shortfall even with different units',async()=>{
    const f=makeDb({lines:[{id:'cloth',quantity:100},{id:'buttons',quantity:10}]});f.poRecord.lines[1].unit='PC';
    await createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-ISOLATION',receivedDate:'2026-09-30',totalReceived:120,totalAccepted:120,totalRejected:0,lineReceipts:[{lineId:'cloth',accepted:120}]},'buyer');
    expect(f.poRecord.status).toBe('PartiallyReceived');expect(f.poRecord.lines[1].receivedQuantity).toBe(0);
  });
  it('exact rejected line and receipt evidence are persisted, without stocking rejected quantities',async()=>{
    const f=makeDb({lines:[{id:'cloth',quantity:100},{id:'buttons',quantity:10}]});
    await createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-REJECT-LINES',receivedDate:'2026-09-30',totalReceived:15,totalAccepted:10,totalRejected:5,lineReceipts:[{lineId:'buttons',accepted:0,rejected:5},{lineId:'cloth',accepted:10,rejected:0}]},'buyer');
    expect(f.poRecord.lines[1].rejectedQuantity).toBe(5);
    expect(f.auditCreate.mock.calls.at(-1)?.[0].data.detail.after.lineReceipts).toEqual(expect.arrayContaining([expect.objectContaining({lineId:'buttons',accepted:0,rejected:5,materialCode:'MAT-2',unit:'YD'})]));
    const saved=f.tx.agentJob.create.mock.calls[0][0].data;
    expect(saved.status).toBe('queued');expect(saved.payload.payload.stockInLines).toEqual([expect.objectContaining({lineId:'cloth',quantity:10})]);
    expect(publishedMaterialReceivedEvents()[0].id).toBe(saved.id);
  });
  it.each([-1,NaN,Infinity,'', '1.12345'])('rejects invalid receipt quantities %s before creating facts',async value=>{
    const f=makeDb({lines:[{id:'one',quantity:100}]});
    await expect(createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-BAD',receivedDate:'2026-09-30',totalReceived:value as any,totalAccepted:0,totalRejected:0},'buyer')).rejects.toThrow();
    expect(f.receipts).toHaveLength(0);expect(f.tx.agentJob.create).not.toHaveBeenCalled();
  });
  it('head quantities must balance and numeric strings cannot concatenate into received total',async()=>{
    const f=makeDb({lines:[{id:'one',quantity:100,receivedQuantity:50}]});
    await expect(createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-BAD',receivedDate:'2026-09-30',totalReceived:10,totalAccepted:9,totalRejected:0},'buyer')).rejects.toThrow('等于');
    await createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-STR',receivedDate:'2026-09-30',totalReceived:'10',totalAccepted:'10',totalRejected:0} as any,'buyer');
    expect(f.poRecord.status).toBe('PartiallyReceived');expect(f.poRecord.lines[0].receivedQuantity).toBe(60);
  });
  it('same content replays after status closes, but changed content for the same receipt number is rejected',async()=>{
    const f=makeDb({lines:[{id:'one',quantity:10}]});const svc=createProcurementService(f.prisma);
    const input={receiptNumber:'MR-RETRY',receivedDate:'2026-09-30',totalReceived:10,totalAccepted:10,totalRejected:0};
    const first=await svc.createMaterialReceipt('PO_WB',input,'buyer');f.poRecord.status='Closed';
    const replay=await svc.createMaterialReceipt('PO_WB',input,'buyer');expect(replay.id).toBe(first.id);
    await expect(svc.createMaterialReceipt('PO_WB',{...input,totalReceived:11,totalAccepted:11},'buyer')).rejects.toMatchObject({status:409});
    expect(f.receipts).toHaveLength(1);expect(f.tx.agentJob.create).toHaveBeenCalledTimes(1);
  });
  it('outbox failure rejects receipt transaction and never publishes a success event',async()=>{
    const f=makeDb({lines:[{id:'one',quantity:10}]});f.tx.agentJob.create.mockRejectedValue(new Error('OUTBOX_FAILED'));
    await expect(createProcurementService(f.prisma).createMaterialReceipt('PO_WB',{receiptNumber:'MR-OUTBOX',receivedDate:'2026-09-30',totalReceived:10,totalAccepted:10,totalRejected:0},'buyer')).rejects.toThrow('OUTBOX_FAILED');
    expect(publishedMaterialReceivedEvents()).toHaveLength(0);
  });
});
