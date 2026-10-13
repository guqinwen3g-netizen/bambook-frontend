/**
 * Phase B3 — 出运统计服务（准交率）
 *
 * 口径定义：
 *   - 运单准点率：已发运运单（ata 已回填）中 ata ≤ eta 的占比
 *   - 订单准交率：交期（dueDate）在统计区间内的订单中，
 *     全部未取消关联运单到港后，最大 ata ≤ dueDate 的占比；未知到港计入 pending
 *
 * 设计决策：
 *   - 只读统计，不写库；日期为 String YYYY-MM-DD 字典序比较（与全项目口径一致）
 *   - 多票 partial shipment 场景：完整到港后以所有真实关联运单最大 ata 判定
 */

import { PrismaClient } from '@prisma/client';
import { normalizeShippingMethod } from '../shared/shippingMethod';
import { isValidLocalDateKey } from '../shared/localDate';


export interface ShipmentStatsProjection {
  orders: Array<{ id: string; dueDate: string }>;
  shipments: Array<{ id: string; orderId: string | null; status: string; eta: string | null; ata: string | null; etd: string | null; shippingMethod: string }>;
  allocations: Array<{ id: string; shipmentId: string; orderId: string; status: string }>;
}

function validDate(value: unknown): value is string {
  return isValidLocalDateKey(value);
}
function inInterval(value: string, from?: string, to?: string) {
  return (!from || value >= from) && (!to || value <= to);
}

export interface OnTimeBucket {
  total: number;
  onTime: number;
  late: number;
  pending: number;
  rate: number | null; // onTime / (total - pending)；无可判定样本时为 null
}

export interface OnTimeStats {
  from: string | null;
  to: string | null;
  shipment: OnTimeBucket;
  order: OnTimeBucket;
}

function buildBucket(total: number, onTime: number, late: number, pending: number): OnTimeBucket {
  const judged = total - pending;
  return {
    total,
    onTime,
    late,
    pending,
    rate: judged > 0 ? Math.round((onTime / judged) * 10000) / 10000 : null,
  };
}

export async function getOnTimeStats(
  prisma: PrismaClient,
  params: { from?: string; to?: string } = {},
  projection?: ShipmentStatsProjection,
): Promise<OnTimeStats> {
  const { from, to } = params;

  // ── 运单准点率（按 ata 落在区间内过滤） ──
  const shipments = projection ? projection.shipments.filter(s =>
    ['Shipped', 'Arrived', 'Cleared', 'Delivered'].includes(s.status) && validDate(s.eta) && validDate(s.ata) && inInterval(s.ata, from, to)) : await prisma.shipment.findMany({
    where: {
      deletedAt: null,
      status: { in: ['Shipped', 'Arrived', 'Cleared', 'Delivered'] },
      eta: { not: null },
      // 注意：对象展开同名键后者覆盖前者，ata 条件必须单次合并构造
      ata: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
    },
    select: { id: true, eta: true, ata: true },
  });
  let shipOnTime = 0;
  for (const s of shipments) {
    if (validDate(s.ata) && validDate(s.eta) && s.ata <= s.eta) shipOnTime++;
  }
  const validShipments = shipments.filter(s => validDate(s.ata) && validDate(s.eta));
  const shipBucket = buildBucket(validShipments.length, shipOnTime, validShipments.length - shipOnTime, 0);

  // ── 订单准交率（dueDate 在区间内的订单） ──
  const orders = projection ? projection.orders.filter(o => inInterval(o.dueDate, from, to)) : await prisma.order.findMany({
    where: {
      deletedAt: null,
      dueDate: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    },
    select: { id: true, dueDate: true },
  });
  const orderIds = orders.map(o => o.id);
  // SOA is the canonical merged-ticket source; a missing delegate is not an
  // authorized direct-order-only fallback.
  const allocations = projection ? projection.allocations : orderIds.length > 0
    ? await prisma.shipmentOrderAllocation.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, shipmentId: true, orderId: true, status: true } }) : [];
  const allocatedIds = [...new Set(allocations.map(row => row.shipmentId))];
  const orderShipments = projection ? projection.shipments.filter(s => s.status !== 'Cancelled') : orderIds.length > 0
    ? await prisma.shipment.findMany({
        where: { OR: [{ orderId: { in: orderIds } }, { id: { in: allocatedIds } }], deletedAt: null, status: { not: 'Cancelled' } },
        select: { id: true, orderId: true, ata: true },
      }) : [];
  const ticketsByOrder = new Map<string, Map<string, string | null>>();
  const add = (orderId: string, ticketId: string, ata: string | null) => {
    const tickets = ticketsByOrder.get(orderId) ?? new Map<string, string | null>();
    tickets.set(ticketId, ata); ticketsByOrder.set(orderId, tickets);
  };
  const allocatedOrders = new Map<string, Set<string>>();
  for (const row of allocations) {
    const parents = allocatedOrders.get(row.shipmentId) ?? new Set<string>();
    parents.add(row.orderId); allocatedOrders.set(row.shipmentId, parents);
  }
  for (const s of orderShipments) {
    if (s.orderId) add(s.orderId, s.id, s.ata);
    for (const orderId of allocatedOrders.get(s.id) ?? []) add(orderId, s.id, s.ata);
  }

  let orderOnTime = 0;
  let orderLate = 0;
  let orderPending = 0;
  for (const o of orders) {
    const atas = [...(ticketsByOrder.get(o.id)?.values() ?? [])];
    if (!validDate(o.dueDate) || atas.length === 0 || atas.some(ata => !validDate(ata))) {
      orderPending++; // 未知到港或交期不能提前判定整单准交
      continue;
    }
    const lastAta = (atas as string[]).reduce((max, d) => (d > max ? d : max));
    if (lastAta <= o.dueDate) orderOnTime++;
    else orderLate++;
  }
  const orderBucket = buildBucket(orders.length, orderOnTime, orderLate, orderPending);

  return { from: from ?? null, to: to ?? null, shipment: shipBucket, order: orderBucket };
}

// ────────────────────────────────────────────────────────────────
// C4：运输方式维度统计
//   按 shippingMethod 分组：总量 / 在途 / 已交付 / 准点率（ata≤eta 口径与 on-time 一致）
// ────────────────────────────────────────────────────────────────

export interface MethodBucket {
  method: string;
  total: number;
  inTransit: number;   // Booked/Loading/Shipped/Arrived
  delivered: number;
  cancelled: number;
  judged: number;      // 有 eta+ata 可判定准点的样本数
  onTime: number;
  late: number;
  onTimeRate: number | null;
}

export interface MethodStats {
  from: string | null;
  to: string | null;
  methods: MethodBucket[];
}

const IN_TRANSIT_STATUSES = new Set(['Booked', 'Loading', 'Shipped', 'Arrived']);

export async function getMethodStats(
  prisma: PrismaClient,
  params: { from?: string; to?: string } = {},
  projection?: ShipmentStatsProjection,
): Promise<MethodStats> {
  const { from, to } = params;
  // createdAt 为 BigInt 时间戳，区间过滤统一走 etd/ata 字符串口径（内存过滤）
  const shipments = projection ? projection.shipments : await prisma.shipment.findMany({
    where: { deletedAt: null },
    select: { shippingMethod: true, status: true, eta: true, ata: true, etd: true },
  });

  // etd 区间过滤（YYYY-MM-DD 字典序；无 etd 的运单在带区间时排除）
  const filtered = shipments.filter((s: any) => {
    if (!from && !to) return true;
    const d = s.etd ?? s.ata;
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  const byMethod = new Map<string, MethodBucket>();
  for (const s of filtered as any[]) {
    // ★ C2：按**归一后的枚举**分组 —— 否则历史脏值（真库实测有 1 条 `Sea Freight`）
    //   会在报表里单独立一个「运输方式」桶，看起来像多了一种运输方式。
    //   认不出来的值仍原样保留（不硬塞一个错的枚举），此时与 'Unknown' 同档处理。
    const method = normalizeShippingMethod(s.shippingMethod) ?? (s.shippingMethod || 'Unknown');
    let b = byMethod.get(method);
    if (!b) {
      b = { method, total: 0, inTransit: 0, delivered: 0, cancelled: 0, judged: 0, onTime: 0, late: 0, onTimeRate: null };
      byMethod.set(method, b);
    }
    b.total++;
    if (IN_TRANSIT_STATUSES.has(s.status)) b.inTransit++;
    else if (s.status === 'Delivered') b.delivered++;
    else if (s.status === 'Cancelled') b.cancelled++;
    if (validDate(s.eta) && validDate(s.ata)) {
      b.judged++;
      if (s.ata <= s.eta) b.onTime++;
      else b.late++;
    }
  }
  const methods = [...byMethod.values()].sort((a, b) => b.total - a.total);
  for (const m of methods) {
    m.onTimeRate = m.judged > 0 ? Math.round((m.onTime / m.judged) * 10000) / 10000 : null;
  }
  return { from: from ?? null, to: to ?? null, methods };
}
