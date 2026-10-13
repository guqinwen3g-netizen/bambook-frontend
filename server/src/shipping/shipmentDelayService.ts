/**
 * 出运延误扫描服务（只读）— B3 延误预警口径的单一权威源
 *
 * 口径（与 scheduler/tasks/shipmentDelayDetector 完全一致）：
 *   - 离港延误：ETD 已过 + 无 ATD + status ∈ Booked/Loading（船该开未开）
 *   - 到港延误：ETA 已过 + 无 ATA + status = Shipped（货在途中超期）
 *   - 分级：逾期 1-3 天 warning；>3 天 critical
 *
 * 消费方：
 *   - shipmentDelayDetector（调度任务，通知写入）
 *   - Agent 工具 shipping.scan_delays（C3 跟单提醒，只读实时扫描）
 */

import { PrismaClient } from '@prisma/client';
// ★ 「业务日」唯一真源（本地时区 = 中国日）。旧写法 `toISOString().slice(0,10)` 取 UTC 日，
//   本地 00:00–08:00 会把 asOf 记成**昨天** → 延误天数少算一天。
import { todayLocalKey } from '../shared/localDate';

const DAY_MS = 24 * 60 * 60 * 1000;
const CRITICAL_OVERDUE_DAYS = 3;
const DEFAULT_LIMIT = 50;

export type DelayKind = 'dep' | 'arr';
export type DelayTier = 'warning' | 'critical';

export interface DelayedShipmentRow {
  id: string;
  shipmentNumber: string;
  orderId: string | null;
  customerName: string | null;
  kind: DelayKind;
  plannedDate: string;
  daysOverdue: number;
  tier: DelayTier;
}

export interface DelayScanResult {
  asOf: string;
  departures: DelayedShipmentRow[];
  arrivals: DelayedShipmentRow[];
  total: number;
}

export function tierForOverdueDays(daysOverdue: number): DelayTier {
  return daysOverdue > CRITICAL_OVERDUE_DAYS ? 'critical' : 'warning';
}

export async function scanDelayedShipments(
  prisma: PrismaClient,
  opts: { asOf?: string; limit?: number } = {},
): Promise<DelayScanResult> {
  const asOf = opts.asOf ?? todayLocalKey();
  const asOfMs = new Date(asOf + 'T00:00:00Z').getTime();
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 200);

  const [overdueDep, overdueArr] = await Promise.all([
    prisma.shipment.findMany({
      where: {
        deletedAt: null,
        status: { in: ['Booked', 'Loading'] },
        etd: { not: null, lt: asOf },
        atd: null,
      },
      select: { id: true, shipmentNumber: true, orderId: true, customerName: true, etd: true },
      take: limit,
    }),
    prisma.shipment.findMany({
      where: {
        deletedAt: null,
        status: 'Shipped',
        eta: { not: null, lt: asOf },
        ata: null,
      },
      select: { id: true, shipmentNumber: true, orderId: true, customerName: true, eta: true },
      take: limit,
    }),
  ]);

  const departures: DelayedShipmentRow[] = [];
  for (const ship of overdueDep) {
    const etdMs = new Date(ship.etd! + 'T00:00:00Z').getTime();
    const daysOverdue = Math.round((asOfMs - etdMs) / DAY_MS);
    if (daysOverdue <= 0) continue;
    departures.push({
      id: ship.id, shipmentNumber: ship.shipmentNumber, orderId: ship.orderId, customerName: ship.customerName,
      kind: 'dep', plannedDate: ship.etd!, daysOverdue, tier: tierForOverdueDays(daysOverdue),
    });
  }

  const arrivals: DelayedShipmentRow[] = [];
  for (const ship of overdueArr) {
    const etaMs = new Date(ship.eta! + 'T00:00:00Z').getTime();
    const daysOverdue = Math.round((asOfMs - etaMs) / DAY_MS);
    if (daysOverdue <= 0) continue;
    arrivals.push({
      id: ship.id, shipmentNumber: ship.shipmentNumber, orderId: ship.orderId, customerName: ship.customerName,
      kind: 'arr', plannedDate: ship.eta!, daysOverdue, tier: tierForOverdueDays(daysOverdue),
    });
  }

  return { asOf, departures, arrivals, total: departures.length + arrivals.length };
}
