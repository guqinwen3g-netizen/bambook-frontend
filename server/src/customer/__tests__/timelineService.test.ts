/**
 * §10.3-8 客户门户全时间线：契约测试。
 *
 * 锁两件事：
 *  1) **可见性**：订单状态、打样轮次与判样、生产里程碑（白名单）、验货结论、出运节点、
 *     发票都出现在时间线里；
 *  2) **不泄漏**：内部数据边界 —— 成本/利润、工厂与供应商名、内部备注与审批人、
 *     QC 疵点明细（疵点数/描述/AQL）、运费金额、**内部生产阶段**（不在里程碑白名单内）
 *     一律不得出现在返回结构中。
 *
 * 口径来源：2026-09-12 业务方弹窗定案（对外节点 + 隐藏内部细节）。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCustomerTimeline } from '../timelineService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORDER = 'O1';

function makePrisma(overrides: Record<string, any> = {}) {
  const model = (rows: any[]) => ({ findMany: vi.fn().mockResolvedValue(rows) });
  return {
    orderStatusTransition: model([
      { id: 'T1', orderId: ORDER, fromStatus: 'Pending', toStatus: 'Confirmed', note: '内部备注：客户砍价', operator: 'u_sales', createdAt: BigInt(Date.UTC(2026, 0, 2)) },
    ]),
    developmentCase: model([{ id: 'DC1' }]),
    sampleBatch: model([
      {
        id: 'SB1', developmentCaseId: 'DC1', sampleType: 'lab-dip', round: 1, status: 'approved',
        sentDate: '2026-01-05', trackingNumber: 'SF123', approvedAt: BigInt(Date.UTC(2026, 0, 8)),
        feedbackDate: '2026-01-08', supplierName: '某工厂(内部)', shippingFee: 88,
      },
      { id: 'SB2', developmentCaseId: 'DC1', sampleType: 'garment-round', round: 2, status: 'making', supplierName: '某工厂(内部)' },
    ]),
    productionStage: model([
      { id: 'PS1', stageKey: 'order_placed', stageSeq: 1, status: 'done', doneAt: BigInt(Date.UTC(2026, 0, 2)), note: '内部排程备注' },
      { id: 'PS2', stageKey: 'materials_arrived', stageSeq: 5, status: 'done', doneAt: BigInt(Date.UTC(2026, 0, 6)), note: '面料到厂' },
      { id: 'PS3', stageKey: 'pre_cut_checked', stageSeq: 6, status: 'done', doneAt: BigInt(Date.UTC(2026, 0, 10)) },
      { id: 'PS4', stageKey: 'manufacturing', stageSeq: 8, status: 'in_progress', doneAt: null },
    ]),
    inspectionReport: model([
      {
        id: 'INR1', orderId: ORDER, inspectionType: 'final', result: 'pass', inspectionDate: '2026-02-01',
        majorDefects: 3, minorDefects: 7, defectSummary: '跳线x3 污渍x2', aqlLevel: '2.5/4.0 II', sampleSize: 80,
        inspectedBy: 'u_qc', inspectorOrg: '自有 QC',
      },
    ]),
    shipmentOrderAllocation: model([{ shipmentId: 'SHP1' }]),
    shipment: model([
      {
        id: 'SHP1', shipmentNumber: 'SHP-20260201-001', orderId: ORDER, status: 'Shipped',
        bookingDate: '2026-01-28', atd: '2026-02-05', eta: '2026-03-01',
        freightAmount: 1234.56, freightCurrency: 'USD', carrierName: '某货代(内部)',
      },
    ]),
    invoice: model([
      { id: 'INV1', invoiceNumber: 'INV-1', orderId: ORDER, type: 'Receivable', status: 'Issued', amount: 50000, currency: 'USD', issueDate: '2026-02-02', dueDate: '2026-03-02' },
    ]),
    ...overrides,
  } as any;
}

describe('客户时间线 · 对外节点可见', () => {
  it('六类事件都在，且按时间倒序', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    const types = new Set(items.map((i) => i.type));
    expect(types).toEqual(new Set(['order', 'sample', 'production', 'inspection', 'shipment', 'invoice']));

    const dated = items.filter((i) => i.at);
    const sorted = [...dated].sort((a, b) => (a.at! < b.at! ? 1 : -1));
    expect(dated.map((i) => i.at)).toEqual(sorted.map((i) => i.at));
  });

  it('订单状态用客户向文案（内部含混状态不给内部语义）', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    const orderEvent = items.find((i) => i.key === 'order:T1:status')!;
    expect(orderEvent.title).toBe('Order Confirmed');
  });

  it('打样轮次：寄样与批准是两条事件，未寄样的只给粗粒度状态（无日期排末尾）', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    expect(items.find((i) => i.key === 'sample:SB1:sent')!.title).toBe('Lab Dip Round 1 Sent');
    expect(items.find((i) => i.key === 'sample:SB1:approved')!.title).toBe('Lab Dip Round 1 Approved');
    const pending = items.find((i) => i.key === 'sample:SB2:status')!;
    expect(pending.title).toContain('Garment Sample Round 2');
    expect(pending.at).toBeNull();
  });

  it('生产里程碑只给白名单阶段；出运给订舱/离港，且无实际离港时才给预计', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    const prodKeys = items.filter((i) => i.type === 'production').map((i) => i.key);
    expect(prodKeys).toContain('production:PS3:done'); // pre_cut_checked → Cutting Started
    expect(prodKeys).not.toContain('production:PS2:done'); // materials_arrived 内部阶段
    expect(prodKeys).not.toContain('production:PS1:done'); // order_placed 内部阶段

    const shipKeys = items.filter((i) => i.type === 'shipment').map((i) => i.key);
    expect(shipKeys).toContain('shipment:SHP1:bookingDate');
    expect(shipKeys).toContain('shipment:SHP1:atd');
    expect(shipKeys).toContain('shipment:SHP1:eta'); // 无 ata → 给预计到达
    expect(shipKeys).not.toContain('shipment:SHP1:etd'); // 有 atd → 不再给预计离港
  });
});

describe('客户时间线 · 内部数据边界（不泄漏）', () => {
  it('返回结构中不得出现成本/利润/工厂供应商/内部备注/审批人/疵点明细/运费', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    const flat = JSON.stringify(items);

    for (const forbidden of [
      '内部备注',       // OrderStatusTransition.note
      '某工厂',         // SampleBatch.supplierName
      'supplierName',
      'shippingFee',
      'freightAmount',  // 运费
      '1234.56',
      'carrierName',    // 货代
      'internalNote',
      'operator',
      'u_sales',        // 内部操作人
      'u_qc',
      'defectSummary',  // 疵点描述
      '跳线', '污渍',
      'majorDefects', 'minorDefects', 'sampleSize', 'aqlLevel',
      'inspectedBy',
    ]) {
      expect(flat, `时间线不得包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('验货只给结论与日期（合格/有条件/不合格）', async () => {
    const { items } = await buildCustomerTimeline(makePrisma(), ORDER);
    const insp = items.find((i) => i.type === 'inspection')!;
    expect(insp.title).toBe('Inspection Passed');
    expect(Object.keys(insp.detail ?? {}).sort()).toEqual(['inspectionDate']);
  });

  it('未出结论的验货（result 为空）不出现在时间线', async () => {
    const prisma = makePrisma({
      inspectionReport: { findMany: vi.fn().mockResolvedValue([{ id: 'INR2', orderId: ORDER, inspectionType: 'midline', result: null, inspectionDate: null }]) },
    });
    const { items } = await buildCustomerTimeline(prisma, ORDER);
    expect(items.filter((i) => i.type === 'inspection')).toHaveLength(0);
  });
});
