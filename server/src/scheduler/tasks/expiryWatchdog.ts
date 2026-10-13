import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 A-P0 — 调度任务：LC / 退税到期预警
 *
 * 每小时扫描以下到期场景，按剩余天数分级通知（info / warning / critical）：
 *   1. 信用证有效期（expiryDate）：30 天 info → 14 天 warning → 7 天/已过期 critical
 *   2. 最迟装运期（shipmentDeadline）：14 天 info → 7 天 warning → 已过期 critical
 *   3. 交单期限（presentationDeadline）：10 天 info → 5 天 warning → 已过期 critical
 *   4. 退税申报截止（出口日期次年 4 月 30 日）：90 天 info → 30 天 warning → 已逾期 critical
 *
 * 业务规则：
 *   - LC 仅扫描活动状态（Issued / Presented / Discrepant），
 *     Settled / Expired / Cancelled 视为闭环不再预警。
 *   - 退税截止日规则：财税口径 —— 货物报关出口之日次月起至次年 4 月 30 日
 *     前的各增值税纳税申报期内申报；简化为 exportDate 所在年份的次年 4 月 30 日。
 *   - 分级去重：dedupKey 含 tier，同级别当天只发一次；级别升级会重新通知。
 *
 * 日期字段均为 String YYYY-MM-DD（本地日历日比较，避免时区漂移）。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';

const BATCH_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

type Tier = 'info' | 'warning' | 'critical';

const LC_ACTIVE_STATUSES = ['Issued', 'Presented', 'Discrepant'];
const TAX_REFUND_OPEN_STATUSES = ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected'];

let lastRunHour = -1;

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 目标日期 - 今天（日历天，本地时区）；目标已过为负数 */
function daysUntil(targetMs: number, todayMs: number): number {
  return Math.round((targetMs - todayMs) / DAY_MS);
}

/** 通用分级：past → critical；≤ warnDays → critical；≤ infoDays → warning/info 由参数控制 */
function tierFor(days: number, infoDays: number, warnDays: number, criticalDays: number): Tier | null {
  if (days < 0) return 'critical';
  if (days <= criticalDays) return 'critical';
  if (days <= warnDays) return 'warning';
  if (days <= infoDays) return 'info';
  return null;
}

/** 退税申报截止日：出口年份次年 4 月 30 日 */
function taxRefundDeadline(exportDateMs: number): number {
  const d = new Date(exportDateMs);
  return new Date(d.getFullYear() + 1, 3, 30).getTime(); // 月份 0-based → 3 = April
}

interface ExpiryCheck {
  kind: string;
  notificationType: string;
  entityId: string;
  refNumber: string;
  days: number;
  deadlineStr: string;
  tier: Tier;
  title: string;
  body: string;
  link: string;
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

  const checks: ExpiryCheck[] = [];
  const db = prisma as any;

  // ── 1. 信用证三期限 ──
  const lcs = await db.letterOfCredit.findMany({
    where: { status: { in: LC_ACTIVE_STATUSES }, deletedAt: null },
    select: {
      id: true, lcNumber: true, status: true, amount: true, currency: true,
      expiryDate: true, shipmentDeadline: true, presentationDeadline: true,
      applicant: true, orderId: true,
    },
    take: BATCH_LIMIT,
  });

  for (const lc of lcs) {
    const amountStr = `${lc.amount} ${lc.currency}`;

    const expiryMs = parseDate(lc.expiryDate);
    if (expiryMs !== null) {
      const days = daysUntil(expiryMs, todayMs);
      const tier = tierFor(days, 30, 14, 7);
      if (tier) {
        checks.push({
          kind: 'lc_expiry', notificationType: 'lc_expiry',
          entityId: lc.id, refNumber: lc.lcNumber, days, deadlineStr: lc.expiryDate!, tier,
          title: days < 0 ? `信用证 ${lc.lcNumber} 已过期` : `信用证 ${lc.lcNumber} 即将到期（${days} 天）`,
          body: days < 0
            ? `信用证 ${lc.lcNumber}（金额 ${amountStr}）已于 ${lc.expiryDate} 过期，请立即确认是否延期或闭卷。`
            : `信用证 ${lc.lcNumber}（金额 ${amountStr}）有效期至 ${lc.expiryDate}，剩余 ${days} 天，请确保按期交单。`,
          link: `/customs?tab=lettersOfCredit&id=${lc.id}`,
        });
      }
    }

    const shipMs = parseDate(lc.shipmentDeadline);
    if (shipMs !== null) {
      const days = daysUntil(shipMs, todayMs);
      const tier = tierFor(days, 14, 7, 0);
      if (tier) {
        checks.push({
          kind: 'lc_shipment_deadline', notificationType: 'lc_shipment_deadline',
          entityId: lc.id, refNumber: lc.lcNumber, days, deadlineStr: lc.shipmentDeadline!, tier,
          title: days < 0 ? `信用证 ${lc.lcNumber} 已逾最迟装运期` : `信用证 ${lc.lcNumber} 最迟装运期临近（${days} 天）`,
          body: days < 0
            ? `信用证 ${lc.lcNumber} 最迟装运期 ${lc.shipmentDeadline} 已过，未装运将构成不符点，请立即处理。`
            : `信用证 ${lc.lcNumber} 最迟装运期 ${lc.shipmentDeadline}，剩余 ${days} 天，请确认生产/订舱进度。`,
          link: `/customs?tab=lettersOfCredit&id=${lc.id}`,
        });
      }
    }

    const presentMs = parseDate(lc.presentationDeadline);
    if (presentMs !== null) {
      const days = daysUntil(presentMs, todayMs);
      const tier = tierFor(days, 10, 5, 0);
      if (tier) {
        checks.push({
          kind: 'lc_presentation_deadline', notificationType: 'lc_presentation_deadline',
          entityId: lc.id, refNumber: lc.lcNumber, days, deadlineStr: lc.presentationDeadline!, tier,
          title: days < 0 ? `信用证 ${lc.lcNumber} 已逾交单期` : `信用证 ${lc.lcNumber} 交单期临近（${days} 天）`,
          body: days < 0
            ? `信用证 ${lc.lcNumber} 交单期限 ${lc.presentationDeadline} 已过，请立即交单议付或申请改证。`
            : `信用证 ${lc.lcNumber} 交单期限 ${lc.presentationDeadline}，剩余 ${days} 天，请备齐全套单据。`,
          link: `/customs?tab=lettersOfCredit&id=${lc.id}`,
        });
      }
    }
  }

  // ── 2. 退税申报截止 ──
  const refunds = await db.taxRefund.findMany({
    where: { status: { in: TAX_REFUND_OPEN_STATUSES }, deletedAt: null, exportDate: { not: null } },
    select: { id: true, refundNumber: true, status: true, exportDate: true, refundAmount: true, orderId: true },
    take: BATCH_LIMIT,
  });

  for (const tr of refunds) {
    const exportMs = parseDate(tr.exportDate);
    if (exportMs === null) continue;
    const deadlineMs = taxRefundDeadline(exportMs);
    const deadlineStr = `${new Date(deadlineMs).getFullYear()}-04-30`;
    const days = daysUntil(deadlineMs, todayMs);
    const tier = tierFor(days, 90, 30, 0);
    if (!tier) continue;

    const amountStr = tr.refundAmount ? `${tr.refundAmount} CNY` : '金额未核定';
    checks.push({
      kind: 'tax_refund_deadline', notificationType: 'tax_refund_deadline',
      entityId: tr.id, refNumber: tr.refundNumber, days, deadlineStr, tier,
      title: days < 0 ? `退税申报 ${tr.refundNumber} 已逾期` : `退税申报 ${tr.refundNumber} 截止临近（${days} 天）`,
      body: days < 0
        ? `退税申报 ${tr.refundNumber}（${amountStr}）法定期限 ${deadlineStr} 已过，逾期将无法退税，请立即与税务确认补救。`
        : `退税申报 ${tr.refundNumber}（出口日 ${tr.exportDate}）须在 ${deadlineStr} 前完成申报，剩余 ${days} 天。`,
      link: `/customs?tab=taxRefunds&id=${tr.id}`,
    });
  }

  // ── 3. 分级去重发送 ──
  let sent = 0;
  for (const c of checks) {
    const expiryKey = `expiry:${c.kind}:${c.entityId}:${c.tier}:${todayStr}`;
    const existing = await prisma.notification.findFirst({
      where: { type: c.notificationType, metadata: { path: ['expiryKey'], equals: expiryKey } },
      select: { id: true },
    });
    if (existing) continue;

    await notificationService.broadcastNotification({
      type: c.notificationType,
      title: c.title,
      body: c.body,
      level: c.tier,
      link: c.link,
      metadata: {
        expiryKey,
        entityType: c.kind.startsWith('lc_') ? 'LetterOfCredit' : 'TaxRefund',
        entityId: c.entityId,
        daysRemaining: c.days,
        deadline: c.deadlineStr,
        tier: c.tier,
      },
    });
    sent++;
  }

  if (sent > 0) {
    logger.info('[ExpiryWatchdog] notifications sent', { count: sent });
  }
  return sent;
}

export function createExpiryWatchdogTask(): ScheduledTask {
  return {
    id: 'expiry_watchdog',
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
        logger.error('[ExpiryWatchdog] failed', { error: e?.message });
      }
    },
  };
}
