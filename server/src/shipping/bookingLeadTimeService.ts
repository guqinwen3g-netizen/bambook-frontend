import { businessNowDate } from '../shared/businessClock';
/**
 * bookingLeadTimeService.ts — REQ2-20 旺季舱位提醒（DR-061，X-09 L0→L3）
 *
 * 设计真源：docs/design/04-模块设计/04-出货与单据/旺季舱位提醒.md
 *
 * DR-061 三决策：
 *   ① 规则可配置（SystemConfig logistics 组 global::shipping.bookingLeadTime）：
 *      { peakMonths: number[], peakDays: number, normalDays: number }，默认旺季(8/9/10 月) 21 天/平时 14 天；
 *      配置缺失/非法 fail-open 回默认（提醒类能力不阻断）
 *   ② 扫描口径：订单（非取消/关闭态且有 dueDate）且无未取消出运安排（ShipmentOrderAllocation 非 Cancelled）
 *      → 需订舱日 = dueDate − leadDays（按 dueDate 所在月是否旺季取天数）→ 已到/已过 → 预警
 *   ③ 预警分级：overdue（已过交期）/ urgent（剩余 ≤3 天）/ warning（其余）；建议文案按旺季/平时区分
 *
 * 纯扫描查询（零写路径）；调度通知（RiskAlert/Notification 日级幂等）列增强。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { getSystemConfigService } from '../config/systemConfigService';
import { isValidLocalDateKey, localDateKey } from '../shared/localDate';


export interface BookingLeadTimeRule {
  peakMonths: number[]; // 旺季月份（1-12）
  peakDays: number; // 旺季提前订舱天数
  normalDays: number; // 平时提前订舱天数
}

export const DEFAULT_BOOKING_RULE: BookingLeadTimeRule = {
  peakMonths: [8, 9, 10],
  peakDays: 21,
  normalDays: 14,
};

const CONFIG_KEY = 'shipping.bookingLeadTime';

export interface BookingReminderItem {
  orderId: string;
  poNumber: string | null;
  customer: string;
  dueDate: string;
  leadDays: number;
  isPeak: boolean;
  requiredByDate: string;
  remainingDays: number;
  level: 'overdue' | 'urgent' | 'warning';
  suggestion: string;
}

function parseRule(raw: unknown): BookingLeadTimeRule {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOOKING_RULE };
  const obj = raw as Record<string, unknown>;
  const peakMonths = Array.isArray(obj.peakMonths)
    ? obj.peakMonths.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 12)
    : [];
  const peakDays = Number(obj.peakDays);
  const normalDays = Number(obj.normalDays);
  return {
    peakMonths: peakMonths.length > 0 ? peakMonths : [...DEFAULT_BOOKING_RULE.peakMonths],
    peakDays: Number.isInteger(peakDays) && peakDays > 0 && peakDays <= 120 ? peakDays : DEFAULT_BOOKING_RULE.peakDays,
    normalDays: Number.isInteger(normalDays) && normalDays > 0 && normalDays <= 120 ? normalDays : DEFAULT_BOOKING_RULE.normalDays,
  };
}

function parseDate(s: string): Date | null {
  if (!isValidLocalDateKey(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d: Date): string {
  return localDateKey(d);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function createBookingLeadTimeService(prisma: PrismaClient) {
  const db = prisma as any;

  async function loadRule(): Promise<BookingLeadTimeRule> {
    try {
      const configSvc = getSystemConfigService(prisma);
      const r = await configSvc.get(CONFIG_KEY, { scope: 'global' });
      return parseRule(r?.value);
    } catch (e: any) {
      logger.warn('[BookingLeadTime] config load failed (fail-open default)', { error: e?.message });
      return { ...DEFAULT_BOOKING_RULE };
    }
  }

  /**
   * 扫描待订舱预警：无未取消出运安排的活跃订单中，已到/过需订舱日者。
   * @param now 当前时点（默认 now；测试可注入）
   */
  async function listBookingReminders(now: Date = businessNowDate()): Promise<{ rule: BookingLeadTimeRule; items: BookingReminderItem[] }> {
    const rule = await loadRule();
    const orders = await db.order.findMany({
      where: {
        deletedAt: null,
        status: { notIn: ['Cancelled', 'Closed'] },
      },
      select: { id: true, poNumber: true, customer: true, dueDate: true },
      take: 2000,
    });
    if (orders.length === 0) return { rule, items: [] };

    // 已有出运安排的订单（allocation 非 Cancelled 即视为已安排——无论 shipment 状态）
    const allocations = await db.shipmentOrderAllocation.findMany({
      where: { status: { not: 'Cancelled' } },
      select: { orderId: true },
    });
    const arrangedOrderIds = new Set<string>(allocations.map((a: any) => a.orderId));

    // Compare calendar days after projecting the supplied instant to Shanghai.
    // UTC getters would keep yesterday during the first eight business hours.
    const today = parseDate(localDateKey(now))!;
    const items: BookingReminderItem[] = [];
    for (const o of orders) {
      if (arrangedOrderIds.has(o.id)) continue;
      const due = typeof o.dueDate === 'string' ? parseDate(o.dueDate) : null;
      if (!due) continue;
      const dueMonth = due.getUTCMonth() + 1;
      const isPeak = rule.peakMonths.includes(dueMonth);
      const leadDays = isPeak ? rule.peakDays : rule.normalDays;
      const requiredBy = new Date(due.getTime() - leadDays * 86400000);
      if (today < requiredBy) continue; // 未到需订舱窗口
      const remainingDays = daysBetween(today, due);
      const level: BookingReminderItem['level'] = remainingDays < 0 ? 'overdue' : remainingDays <= 3 ? 'urgent' : 'warning';
      items.push({
        orderId: o.id,
        poNumber: o.poNumber ?? null,
        customer: o.customer ?? '',
        dueDate: fmtDate(due),
        leadDays,
        isPeak,
        requiredByDate: fmtDate(requiredBy),
        remainingDays,
        level,
        suggestion: remainingDays < 0
          ? '已过交期——加急订舱或与客户协商改期'
          : isPeak
            ? `旺季舱位紧张（需提前 ${rule.peakDays} 天），剩余 ${remainingDays} 天，立即订舱锁定舱位`
            : `按平时提前期 ${rule.normalDays} 天，剩余 ${remainingDays} 天，尽快订舱`,
      });
    }
    items.sort((a, b) => a.remainingDays - b.remainingDays);
    return { rule, items };
  }

  return { listBookingReminders, loadRule };
}
