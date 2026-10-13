/**
 * Phase B3 — 调度任务：出运延误预警
 *
 * 每小时扫描以下延误场景，分级通知（warning / critical）：
 *   1. 离港延误：ETD 已过且未回填 ATD（status ∈ Booked/Loading）—— 船已该开未开
 *   2. 到港延误：ETA 已过且未回填 ATA（status = Shipped）—— 货在途中超期
 *
 * 分级规则：
 *   - 逾期 1-3 天 → warning
 *   - 逾期 >3 天 → critical
 *
 * 去重规则（与 expiryWatchdog 一致）：
 *   - dedupKey 含 tier：`delay:dep|arr:${shipmentId}:${tier}:${today}`
 *   - 同级别当天只发一次；级别升级（warning→critical）会重新通知
 *
 * 与 stuckProcessDetector 的分工：
 *   - stuckProcessDetector 管"流程卡滞"（Draft 未订舱等业务状态停留）
 *   - 本任务管"时间违约"（ETD/ETA 已过但运输事实未发生）
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { scanDelayedShipments, type DelayKind, type DelayTier } from '../../shipping/shipmentDelayService';
import { logger } from '../../lib/logger';
// ★ 「业务日」唯一真源（本地时区 = 中国日）。旧写法 `toISOString().slice(0,10)` 取 UTC 日，
//   本地 00:00–08:00 会差一天：延误 `asOf` 少算一天 + 按日去重键翻转 → 重复通知。
import { todayLocalKey } from '../../shared/localDate';

let lastRunHour = -1;

export function createShipmentDelayDetectorTask(): ScheduledTask {
  return {
    id: 'shipment_delay_detector',
    shouldRun: (now: Date) => {
      const hour = now.getHours();
      if (hour !== lastRunHour) {
        lastRunHour = hour;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      const notificationService = createNotificationService(prisma);
      const today = todayLocalKey();
      let sent = 0;

      const notify = async (
        kind: DelayKind,
        ship: { id: string; shipmentNumber: string; orderId: string | null; customerName: string | null },
        plannedDate: string,
        daysOverdue: number,
        tier: DelayTier,
      ) => {
        const dedupKey = `delay:${kind}:${ship.id}:${tier}:${today}`;
        const existing = await prisma.notification.findFirst({
          where: { type: 'shipment_delay', metadata: { path: ['dedupKey'], equals: dedupKey } },
          select: { id: true },
        });
        if (existing) return;

        const kindLabel = kind === 'dep' ? '离港' : '到港';
        const plannedLabel = kind === 'dep' ? 'ETD' : 'ETA';
        await notificationService.broadcastNotification({
          type: 'shipment_delay',
          title: `运单 ${ship.shipmentNumber} ${kindLabel}延误 ${daysOverdue} 天`,
          body: `运单 ${ship.shipmentNumber}${ship.customerName ? `（客户 ${ship.customerName}）` : ''} ${plannedLabel} ${plannedDate} 已过，${kind === 'dep' ? '尚未实际离港' : '尚未实际到港'}，已延误 ${daysOverdue} 天。`,
          level: tier,
          link: `/shipments?id=${ship.id}`,
          metadata: { dedupKey, tier, entityType: 'Shipment', entityId: ship.id, orderId: ship.orderId, delayKind: kind, daysOverdue },
        });
        sent++;
      };

      try {
        // 延误口径统一由 shipmentDelayService.scanDelayedShipments 提供（单一权威源）
        const scan = await scanDelayedShipments(prisma, { asOf: today });
        for (const row of scan.departures) {
          await notify('dep', row, row.plannedDate, row.daysOverdue, row.tier);
        }
        for (const row of scan.arrivals) {
          await notify('arr', row, row.plannedDate, row.daysOverdue, row.tier);
        }

        if (sent > 0) {
          logger.info('[ShipmentDelay] notifications sent', { count: sent });
        }
      } catch (e: any) {
        logger.error('[ShipmentDelay] failed', { error: e?.message });
      }
    },
  };
}
