import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 E / E1 — 调度任务：应收发票逾期分级预警
 *
 * 每小时扫描应收发票（type=Receivable，status ∈ Issued/PartiallyPaid，**amount>0**），
 * 以「有效到期日」口径分级通知（warning / critical）：
 *   - 有效到期日 effectiveDue = dueDate ?? issueDate + 30 天（Net 30 惯例推定，
 *     覆盖未填到期日的存量发票）
 *   - 逾期 1-14 天 → warning
 *   - 逾期 ≥15 天 → critical
 *   - 未逾期 → 不通知
 *
 * 与 stuckProcessDetector 的关系：
 *   本任务取代其第 3 段「发票 >30 天未收款」。旧段注释声称判 dueDate，
 *   实现却只判 issueDate > 30 天——Net 60 发票开票 31 天误报、Net 7 发票
 *   逾期 20 天漏报，口径错误从根因修正为到期日口径并分级。
 *
 * 去重规则（与 expiryWatchdog 一致）：
 *   dedupKey 含 tier：`receivable:overdue:${invoiceId}:${tier}:${today}`
 *   同级别当天只发一次；级别升级（warning→critical）会重新通知。
 *
 * 日期字段均为 String YYYY-MM-DD（本地日历日比较，避免时区漂移）。
 *
 * Track F 接入（信用控制规则.md §2.4 规则① + 双路径解冻②）：
 *   run 内除通知扫描外，追加信用自动冻结/解冻扫描（detectCreditFreezeAndThaw）：
 *   - 应收逾期 >60 天（Net61+ 桶）客户 → creditService.runAutoFreezeScan 自动冻结
 *     （Active→Frozen + CreditLimitHistory + AuditLog，幂等，lastAutoScanDate 巡检标记）
 *   - 系统自动冻结的客户逾期款全额核销后 → creditService.runAutoThawScan 兜底自动解冻
 *     （事件接口点 creditService.autoThawIfSettled 供核销域在 Allocation 写入时调用）
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { createCreditService } from '../../credit/creditService';
import { logger } from '../../lib/logger';
// ★ 「未结清应收」判据唯一真源（含 amount>0 守卫）—— 0 元/负额票不该被催办
import { openReceivableWhere, hasOpenAmount } from '../../shared/openReceivable';

const BATCH_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Net 30 推定：dueDate 缺失时以开票日 +30 天为有效到期日 */
const NET30_DAYS = 30;
/** 逾期 ≥15 天升 critical */
const CRITICAL_OVERDUE_DAYS = 15;

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

/** 本地零点毫秒 → YYYY-MM-DD */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 有效到期日（本地零点毫秒）：dueDate 优先，缺失按 Net 30 推定；均无法解析返回 null */
function effectiveDueMs(dueDate: string | null, issueDate: string): number | null {
  const due = parseDate(dueDate);
  if (due !== null) return due;
  const issue = parseDate(issueDate);
  if (issue === null) return null;
  return issue + NET30_DAYS * DAY_MS;
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
  const todayStr = formatDate(todayMs);

  const invoices = await prisma.invoice.findMany({
    where: openReceivableWhere(), // ★ 含 amount>0 守卫：0 元/负额票不催办
    select: {
      id: true, invoiceNumber: true, amount: true, currency: true,
      issueDate: true, dueDate: true, status: true,
      orderId: true, customerName: true,
    },
    take: BATCH_LIMIT,
  });

  let sent = 0;
  for (const inv of invoices) {
    if (!hasOpenAmount(inv.amount)) continue; // 兜底：mock / 内存行也要挡住
    const dueMs = effectiveDueMs(inv.dueDate, inv.issueDate);
    if (dueMs === null) continue;

    const daysOverdue = Math.round((todayMs - dueMs) / DAY_MS);
    if (daysOverdue < 1) continue;

    const tier: Tier = daysOverdue >= CRITICAL_OVERDUE_DAYS ? 'critical' : 'warning';
    const dueStr = formatDate(dueMs);
    const estimated = inv.dueDate == null; // 推定口径需在正文中透明披露

    const dedupKey = `receivable:overdue:${inv.id}:${tier}:${todayStr}`;
    const existing = await prisma.notification.findFirst({
      where: { type: 'receivable_overdue', metadata: { path: ['dedupKey'], equals: dedupKey } },
      select: { id: true },
    });
    if (existing) continue;

    const amountStr = `${inv.amount} ${inv.currency}`;
    const customerStr = inv.customerName ? `（客户 ${inv.customerName}）` : '';
    const partialStr = inv.status === 'PartiallyPaid' ? '，已部分核销' : '';
    await notificationService.broadcastNotification({
      type: 'receivable_overdue',
      title: `发票 ${inv.invoiceNumber} 逾期 ${daysOverdue} 天未收清`,
      body: `应收发票 ${inv.invoiceNumber}${customerStr}（金额 ${amountStr}${partialStr}）${estimated ? `未填到期日，按 Net 30 推定 ${dueStr} 到期` : `到期日 ${dueStr}`}，已逾期 ${daysOverdue} 天，请跟进客户回款。`,
      level: tier,
      link: `/finance?tab=invoices&id=${inv.id}`,
      metadata: {
        dedupKey,
        tier,
        entityType: 'Invoice',
        entityId: inv.id,
        orderId: inv.orderId,
        daysOverdue,
        dueDate: dueStr,
        dueDateEstimated: estimated,
        status: inv.status,
      },
    });
    sent++;
  }

  if (sent > 0) {
    logger.info('[ReceivableOverdue] notifications sent', { count: sent });
  }
  return sent;
}

/**
 * 信用自动冻结/解冻扫描（Track F 规则① + 解冻路径②，导出供测试直接驱动）。
 * 与通知扫描共用同一 today 基准；幂等由 creditService 内部状态机保证。
 */
export async function detectCreditFreezeAndThaw(
  prisma: PrismaClient,
  today: Date = businessNowDate(),
): Promise<{ frozenCount: number; thawedCount: number }> {
  const creditService = createCreditService({ prisma });
  const freeze = await creditService.runAutoFreezeScan({ today });
  const thaw = await creditService.runAutoThawScan({ today });
  if (freeze.frozenCount > 0 || thaw.thawedCount > 0) {
    logger.info('[ReceivableOverdue] credit freeze/thaw scan', {
      frozenCount: freeze.frozenCount,
      thawedCount: thaw.thawedCount,
    });
  }
  return { frozenCount: freeze.frozenCount, thawedCount: thaw.thawedCount };
}

export function createReceivableOverdueDetectorTask(): ScheduledTask {
  return {
    id: 'receivable_overdue_detector',
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
        logger.error('[ReceivableOverdue] failed', { error: e?.message });
      }
      try {
        await detectCreditFreezeAndThaw(prisma);
      } catch (e: any) {
        logger.error('[ReceivableOverdue] credit freeze/thaw scan failed', { error: e?.message });
      }
    },
  };
}
