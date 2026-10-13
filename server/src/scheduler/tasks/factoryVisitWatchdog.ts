import { businessNowDate } from '../../shared/businessClock';
/**
 * 调度任务：客户实地验厂到期提醒（PRD 7.1「客户实地验厂到期」）
 *
 * 每日 11:30 后运行一次。扫描在手订单（factoryVisitDate 非空、未完结状态）：
 *   - 距验厂日 2-7 天 → warning（确认接待安排）
 *   - 距验厂日 0-1 天 → critical（临近升级，新 dedup 键形成升级轨迹）
 *   - 验厂日已过 → 不再提醒（事件已发生；接待确认属会前动作）
 *
 * 数据入口：Order.factoryVisitDate（YYYY-MM-DD，订单表单可编辑）。
 * 幂等：riskService.raiseAlert dedupKey = factory_visit:${orderId}:${visitDate}:${tier}
 * （与 sampleDeadlineWatchdog 同口径：每个 tier 只发一次，非每日重发）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createRiskService, AlertLevel } from '../../risk/riskService';
import { logger } from '../../lib/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 验厂前 7 天进入提醒窗口 */
const VISIT_WINDOW_DAYS = 7;
/** 验厂前 1 天（含当天）升 critical */
const CRITICAL_DAYS_LEFT = 1;

/** 已完结 / 已出运 / 已开票收款状态不再追踪验厂安排 */
const EXCLUDED_STATUSES = ['Cancelled', 'Closed', 'Shipped', 'Invoiced', 'PartiallyPaid', 'Paid'];

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null（与 riskService 同口径） */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 扫描入口（watchdog 与测试直驱共用）：返回本次新产生的预警数。
 */
export async function scanFactoryVisits(prisma: PrismaClient, today: Date = businessNowDate()): Promise<{ alerted: number }> {
  const db = prisma as any;
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const risk = createRiskService(prisma);

  const orders = await db.order.findMany({
    where: { deletedAt: null, status: { notIn: EXCLUDED_STATUSES }, factoryVisitDate: { not: null } },
    select: { id: true, poNumber: true, customer: true, product: true, factoryVisitDate: true, clientDate: true },
    take: 100,
  });

  let alerted = 0;
  for (const order of orders) {
    const visitMs = parseDate(order.factoryVisitDate);
    if (visitMs === null) continue;

    const daysLeft = Math.floor((visitMs - todayMs) / DAY_MS);
    if (daysLeft < 0 || daysLeft > VISIT_WINDOW_DAYS) continue;

    const tier: AlertLevel = daysLeft <= CRITICAL_DAYS_LEFT ? 'critical' : 'warning';
    const label = order.poNumber ?? order.id;
    const when = daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : `${daysLeft} 天后`;

    const { created } = await risk.raiseAlert({
      type: 'factory_visit',
      level: tier,
      title: `客户计划于 ${order.factoryVisitDate} 实地验厂（订单 ${label}，${when}）`,
      content: `订单 ${label}（客户 ${order.customer ?? '未指定'}，产品 ${order.product ?? '未指定'}）客户计划于 ${order.factoryVisitDate} 实地验厂（${when}）${order.clientDate ? `，出厂交期 Exmill=${order.clientDate}` : ''}。请确认接待安排、产线现场与验货资料准备。`,
      relatedType: 'Order',
      relatedId: order.id,
      dedupKey: `factory_visit:${order.id}:${order.factoryVisitDate}:${tier}`,
    });
    if (created) alerted += 1;
  }

  if (alerted > 0) {
    logger.info('[FactoryVisitWatchdog] scan', { alerted });
  }
  return { alerted };
}

let lastRunDay = '';

function dayKeyOf(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function createFactoryVisitWatchdogTask(): ScheduledTask {
  return {
    id: 'factory_visit_watchdog',
    shouldRun: (now: Date) => {
      // 每日 11:30 后执行一次（与报价/厂前样提醒同窗口错峰复用）
      const dayKey = dayKeyOf(now);
      if ((now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 30)) && dayKey !== lastRunDay) {
        lastRunDay = dayKey;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await scanFactoryVisits(prisma);
      } catch (e: any) {
        logger.error('[FactoryVisitWatchdog] failed', { error: e?.message });
      }
    },
  };
}
