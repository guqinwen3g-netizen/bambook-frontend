import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 E / E1 — 调度任务：生产计划超期 + 延期通知窗口主动推送
 *
 * 每小时扫描未完成订单（status ∉ Delivered/Alert），把既有
 * GET /production/alerts/scan 的被动查询升级为主动通知：
 *   1. 生产计划超期：productionPlanDeadline（下单后 7 天内需出生产计划）已过
 *      - 逾期 1-3 天 → warning
 *      - 逾期 >3 天 → critical
 *   2. 延期通知窗口：delayNoticeDeadline（交期前 15 天）已到 → critical
 *      （需评估能否按期交付，不能则须在窗口内向客户发延期通知）
 *
 * 扫描口径与 production/route.ts alerts/scan 保持一致（同一 where 条件；
 * route.ts 为安全基线只读文件不修改，本任务自含扫描逻辑）。
 * 分级差异：alerts/scan 面向 UI 面板（severity high/critical），
 * 本任务面向通知推送（warning/critical），metadata 记录天数供下游消费。
 *
 * 去重规则（与 expiryWatchdog 一致）：
 *   dedupKey 含 tier：`prod:plan:${orderId}:${tier}:${today}` / `prod:notice:${orderId}:${today}`
 *   同级别当天只发一次；级别升级（warning→critical）会重新通知。
 *
 * 日期字段均为 String YYYY-MM-DD（本地日历日比较，避免时区漂移）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';

const BATCH_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 生产计划逾期 >3 天升 critical（沿用 shipmentDelay 分级惯例） */
const CRITICAL_OVERDUE_DAYS = 3;

type Tier = 'warning' | 'critical';

let lastRunHour = -1;

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 扫描 + 通知主流程（导出供测试直接驱动）。
 * @returns 发送的通知数
 */
export async function detectAndNotify(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<number> {
  const notificationService = createNotificationService(prisma);
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['Delivered', 'Alert'] },
      OR: [{ productionPlanDeadline: { not: null } }, { delayNoticeDeadline: { not: null } }],
    },
    select: {
      id: true, poNumber: true, customer: true, status: true,
      dueDate: true, productionPlanDeadline: true, delayNoticeDeadline: true,
    },
    take: BATCH_LIMIT,
  });

  let sent = 0;

  const notifyOnce = async (dedupKey: string, payload: {
    title: string; body: string; level: Tier; metadata: Record<string, any>;
  }) => {
    const existing = await prisma.notification.findFirst({
      where: { type: 'production_deadline', metadata: { path: ['dedupKey'], equals: dedupKey } },
      select: { id: true },
    });
    if (existing) return;
    await notificationService.broadcastNotification({
      type: 'production_deadline',
      title: payload.title,
      body: payload.body,
      level: payload.level,
      link: `/orders?id=${payload.metadata.entityId}`,
      metadata: { dedupKey, ...payload.metadata },
    });
    sent++;
  };

  for (const o of orders) {
    const orderLabel = o.poNumber || o.id;
    const customerStr = o.customer ? `（客户 ${o.customer}）` : '';

    // ── 1. 生产计划超期 ──
    const planMs = parseDate(o.productionPlanDeadline);
    if (planMs !== null && planMs < todayMs) {
      const daysOverdue = Math.round((todayMs - planMs) / DAY_MS);
      const tier: Tier = daysOverdue > CRITICAL_OVERDUE_DAYS ? 'critical' : 'warning';
      await notifyOnce(`prod:plan:${o.id}:${tier}:${todayStr}`, {
        title: `订单 ${orderLabel} 生产计划超期 ${daysOverdue} 天`,
        body: `订单 ${orderLabel}${customerStr}生产计划截止日 ${o.productionPlanDeadline} 已过 ${daysOverdue} 天（状态 ${o.status}），请确认生产计划是否已下达。`,
        level: tier,
        metadata: {
          tier,
          entityType: 'Order',
          entityId: o.id,
          orderId: o.id,
          alertKind: 'production_plan_overdue',
          daysOverdue,
          deadline: o.productionPlanDeadline,
          status: o.status,
        },
      });
    }

    // ── 2. 延期通知窗口 ──
    const noticeMs = parseDate(o.delayNoticeDeadline);
    if (noticeMs !== null && noticeMs <= todayMs) {
      const dueStr = o.dueDate || '未填交期';
      await notifyOnce(`prod:notice:${o.id}:${todayStr}`, {
        title: `订单 ${orderLabel} 延期通知窗口已开启`,
        body: `订单 ${orderLabel}${customerStr}交期 ${dueStr}，延期通知窗口（交期前 15 天）已到。若预计无法按期交付，须立即向客户发出延期通知；若可按期交付请推进生产并在系统确认。`,
        level: 'critical',
        metadata: {
          tier: 'critical',
          entityType: 'Order',
          entityId: o.id,
          orderId: o.id,
          alertKind: 'delay_notice_window',
          deadline: o.delayNoticeDeadline,
          dueDate: o.dueDate,
          status: o.status,
        },
      });
    }
  }

  if (sent > 0) {
    logger.info('[ProductionDeadline] notifications sent', { count: sent });
  }
  return sent;
}

export function createProductionDeadlineWatchdogTask(): ScheduledTask {
  return {
    id: 'production_deadline_watchdog',
    shouldRun: (now: Date) => {
      const hour = now.getHours();
      if (hour !== lastRunHour) {
        lastRunHour = hour;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await detectAndNotify(prisma);
      } catch (e: any) {
        logger.error('[ProductionDeadline] failed', { error: e?.message });
      }
    },
  };
}
