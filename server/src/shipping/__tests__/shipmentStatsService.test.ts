/**
 * Phase B3 — 出运统计服务（准交率）单元测试
 *
 * 覆盖口径：
 *   1. 运单准点率：ata ≤ eta 为准点（含相等边界），ata > eta 为晚点
 *   2. 订单准交率：多票 partial shipment 取最大 ata 与 dueDate 比较
 *   3. 无实际出运记录的订单计入 pending，不参与 rate 分母
 *   4. 全部 pending 时 rate 为 null（无可判定样本）
 *   5. from/to 统计区间透传到 prisma 查询条件
 */

import { describe, expect, it, vi } from 'vitest';
import { getOnTimeStats } from '../shipmentStatsService';

function makePrisma({
  shipments = [] as any[],
  orders = [] as any[],
  orderShipments = [] as any[],
  allocations = [] as any[],
}) {
  const shipmentFindMany = vi.fn(async ({ where }: any) => {
    // 订单准交率分支：按 orderId.in 查询运单
    if (where?.OR) {
      const orderIds = where.OR[0].orderId.in;
      const ticketIds = where.OR[1].id.in;
      return orderShipments.filter(s => s.status !== 'Cancelled' && (orderIds.includes(s.orderId) || ticketIds.includes(s.id)));
    }
    return shipments;
  });
  const orderFindMany = vi.fn(async () => orders);
  return {
    prisma: { shipment: { findMany: shipmentFindMany }, order: { findMany: orderFindMany }, shipmentOrderAllocation: { findMany: vi.fn(async () => allocations) } } as any,
    shipmentFindMany,
    orderFindMany,
  };
}

describe('shipmentStatsService · 运单准点率', () => {
  it('ata ≤ eta 计准点（含相等边界），ata > eta 计晚点', async () => {
    const { prisma } = makePrisma({
      shipments: [
        { id: 'S1', eta: '2026-08-10', ata: '2026-08-09' }, // 提前 → 准点
        { id: 'S2', eta: '2026-08-10', ata: '2026-08-10' }, // 同日 → 准点
        { id: 'S3', eta: '2026-08-10', ata: '2026-08-12' }, // 晚点
      ],
    });
    const stats = await getOnTimeStats(prisma);
    // rate 服务端按 4 位小数取舍（Math.round(x*10000)/10000）
    expect(stats.shipment).toEqual({ total: 3, onTime: 2, late: 1, pending: 0, rate: 0.6667 });
  });

  it('无运单样本时 rate 为 null', async () => {
    const { prisma } = makePrisma({});
    const stats = await getOnTimeStats(prisma);
    expect(stats.shipment.rate).toBeNull();
    expect(stats.shipment.total).toBe(0);
  });
});

describe('shipmentStatsService · 订单准交率', () => {
  it('多票运单取最大 ata 判定；无 ata 计 pending 不入分母', async () => {
    const { prisma } = makePrisma({
      orders: [
        { id: 'O1', dueDate: '2026-08-06' },
        { id: 'O2', dueDate: '2026-08-08' },
        { id: 'O3', dueDate: '2026-08-09' },
      ],
      orderShipments: [
        // O1 分两票：最后一票 08-05 ≤ 08-06 → 准交
        { id: 'S1', orderId: 'O1', ata: '2026-08-01' },
        { id: 'S2', orderId: 'O1', ata: '2026-08-05' },
        // O2：08-10 > 08-08 → 迟交
        { id: 'S3', orderId: 'O2', ata: '2026-08-10' },
        // O3：无出运记录 → pending
      ],
    });
    const stats = await getOnTimeStats(prisma);
    expect(stats.order.total).toBe(3);
    expect(stats.order.onTime).toBe(1);
    expect(stats.order.late).toBe(1);
    expect(stats.order.pending).toBe(1);
    expect(stats.order.rate).toBe(0.5); // 1 / (3 - 1)
  });

  it('合票非主订单按 SOA 关联；多行同票只计算一票，未知到港仍待定', async () => {
    const allocations = [
      { id: 'A1', shipmentId: 'S1', orderId: 'O2', orderLineId: 'L1', status: 'Fulfilled' },
      { id: 'A2', shipmentId: 'S1', orderId: 'O2', orderLineId: 'L2', status: 'Fulfilled' },
      { id: 'A3', shipmentId: 'S2', orderId: 'O2', orderLineId: 'L2', status: 'Planned' },
    ];
    const { prisma } = makePrisma({
      orders: [{ id: 'O2', dueDate: '2026-08-06' }], allocations,
      orderShipments: [
        { id: 'S1', orderId: 'O1', status: 'Delivered', ata: '2026-08-05' },
        { id: 'S2', orderId: 'O1', status: 'Booked', ata: null },
      ],
    });
    expect((await getOnTimeStats(prisma)).order).toEqual({ total: 1, onTime: 0, late: 0, pending: 1, rate: null });
    allocations.pop();
    expect((await getOnTimeStats(prisma)).order).toEqual({ total: 1, onTime: 1, late: 0, pending: 0, rate: 1 });
  });

  it('订单全部待出运时 rate 为 null', async () => {
    const { prisma } = makePrisma({
      orders: [{ id: 'O1', dueDate: '2026-08-06' }],
      orderShipments: [],
    });
    const stats = await getOnTimeStats(prisma);
    expect(stats.order).toEqual({ total: 1, onTime: 0, late: 0, pending: 1, rate: null });
  });

  it('ata 为 null 的运单不参与订单判定', async () => {
    const { prisma } = makePrisma({
      orders: [{ id: 'O1', dueDate: '2026-08-06' }],
      orderShipments: [{ id: 'S1', orderId: 'O1', ata: null }],
    });
    const stats = await getOnTimeStats(prisma);
    expect(stats.order.pending).toBe(1);
    expect(stats.order.rate).toBeNull();
  });
});

describe('shipmentStatsService · 统计区间', () => {
  it('from/to 透传到运单 ata 与订单 dueDate 查询条件', async () => {
    const { prisma, shipmentFindMany, orderFindMany } = makePrisma({});
    await getOnTimeStats(prisma, { from: '2026-08-01', to: '2026-08-31' });

    const shipWhere = shipmentFindMany.mock.calls[0][0].where;
    expect(shipWhere.ata).toMatchObject({ gte: '2026-08-01', lte: '2026-08-31' });
    const orderWhere = orderFindMany.mock.calls[0][0].where;
    expect(orderWhere.dueDate).toEqual({ gte: '2026-08-01', lte: '2026-08-31' });
  });

  it('返回区间回显（缺省为 null）', async () => {
    const { prisma } = makePrisma({});
    const stats = await getOnTimeStats(prisma);
    expect(stats.from).toBeNull();
    expect(stats.to).toBeNull();
  });
});
