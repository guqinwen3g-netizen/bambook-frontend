import { businessNowMs } from '../../shared/businessClock';
/**
 * Phase 0 Sprint 2 — 调度任务：卡滞业务流程检测
 *
 * 每小时扫描以下卡滞场景，创建 warning 级别通知：
 *   1. 订单确认后 >7 天仍未进入生产（updatedAt 超过 7 天）
 *   2. 发货单创建后 >3 天仍为 Draft（未订舱）
 *   3. 收款凭证登记后 >2 天未核销（unreconciled）
 *
 * 每个卡滞实体每天只发一次通知（通过通知 metadata.stuckKey 去重）
 *
 * 注意：Order/Shipment/Invoice/PaymentVoucher 的 createdAt/updatedAt 是 BigInt（Unix 毫秒），
 * 时间比较用 number，格式化时用 new Date(Number(value))。
 *
 * 历史变更（阶段 E / E1）：原第 3 段「发票 >30 天未收款」已移除，
 * 由 receivableOverdueDetector 取代——旧段注释声称判 dueDate，实现却只判
 * issueDate > 30 天（Net 60 误报 / Net 7 漏报），口径修正为到期日分级预警。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';
// ★ 「业务日」唯一真源（本地时区 = 中国日）。旧写法 `toISOString().slice(0,10)` 取 UTC 日，
//   本地 00:00–08:00 会差一天（`stuckKey` 的去重日期翻转 → 同一件事重复通知）。
import { todayLocalKey, localDateKeyFromBigInt } from '../../shared/localDate';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 20;

let lastRunHour = -1;

function formatDate(bigIntValue: bigint | null | undefined): string {
  return localDateKeyFromBigInt(bigIntValue);
}

export function createStuckProcessDetectorTask(): ScheduledTask {
  return {
    id: 'stuck_process_detector',
    shouldRun: (now: Date) => {
      const hour = now.getHours();
      if (hour !== lastRunHour) {
        lastRunHour = hour;
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      const now = businessNowMs();
      const notificationService = createNotificationService(prisma);
      const today = todayLocalKey();
      let stuckCount = 0;

      try {
        // 1. 订单确认后 >7 天未进入生产
        const confirmedCutoff = now - SEVEN_DAYS_MS;
        const stuckOrders = await prisma.order.findMany({
          where: {
            status: 'Confirmed',
            updatedAt: { lt: confirmedCutoff },
            deletedAt: null,
          },
          select: { id: true, poNumber: true, customer: true, updatedAt: true },
          take: BATCH_LIMIT,
        });
        for (const order of stuckOrders) {
          const stuckKey = `stuck:order:${order.id}:${today}`;
          const existing = await prisma.notification.findFirst({
            where: { type: 'stuck_order', metadata: { path: ['stuckKey'], equals: stuckKey } },
            select: { id: true },
          });
          if (existing) continue;

          await notificationService.broadcastNotification({
            type: 'stuck_order',
            title: `订单 ${order.poNumber} 生产停滞`,
            body: `订单 ${order.poNumber}（客户 ${order.customer}）确认已超过 7 天，仍未进入生产。上次更新：${formatDate(order.updatedAt)}`,
            level: 'warning',
            link: `/orders?id=${order.id}`,
            metadata: { stuckKey, entityType: 'Order', entityId: order.id, orderId: order.id },
          });
          stuckCount++;
        }

        // 2. 发货单 >3 天仍为 Draft
        const draftCutoff = now - THREE_DAYS_MS;
        const stuckShipments = await prisma.shipment.findMany({
          where: {
            status: 'Draft',
            updatedAt: { lt: draftCutoff },
            deletedAt: null,
          },
          select: { id: true, shipmentNumber: true, orderId: true, updatedAt: true },
          take: BATCH_LIMIT,
        });
        for (const ship of stuckShipments) {
          const stuckKey = `stuck:shipment:${ship.id}:${today}`;
          const existing = await prisma.notification.findFirst({
            where: { type: 'stuck_shipment', metadata: { path: ['stuckKey'], equals: stuckKey } },
            select: { id: true },
          });
          if (existing) continue;

          await notificationService.broadcastNotification({
            type: 'stuck_shipment',
            title: `发货单 ${ship.shipmentNumber} 未订舱`,
            body: `发货单 ${ship.shipmentNumber} 创建已超过 3 天，仍为 Draft 状态，请尽快订舱。`,
            level: 'warning',
            link: `/shipments?id=${ship.id}`,
            metadata: { stuckKey, entityType: 'Shipment', entityId: ship.id, orderId: ship.orderId },
          });
          stuckCount++;
        }

        // 3. 收款凭证 >2 天未核销
        const voucherCutoff = now - TWO_DAYS_MS;
        const stuckVouchers = await prisma.paymentVoucher.findMany({
          where: {
            status: 'unreconciled',
            createdAt: { lt: voucherCutoff },
            deletedAt: null,
          },
          select: { id: true, voucherNumber: true, amount: true, currency: true, createdAt: true },
          take: BATCH_LIMIT,
        });
        for (const voc of stuckVouchers) {
          const stuckKey = `stuck:voucher:${voc.id}:${today}`;
          const existing = await prisma.notification.findFirst({
            where: { type: 'stuck_voucher', metadata: { path: ['stuckKey'], equals: stuckKey } },
            select: { id: true },
          });
          if (existing) continue;

          await notificationService.broadcastNotification({
            type: 'stuck_voucher',
            title: `收款凭证 ${voc.voucherNumber} 未核销`,
            body: `凭证 ${voc.voucherNumber}（金额 ${voc.amount} ${voc.currency}）登记已超过 2 天，仍未核销。`,
            level: 'warning',
            link: `/finance?tab=vouchers&id=${voc.id}`,
            metadata: { stuckKey, entityType: 'PaymentVoucher', entityId: voc.id },
          });
          stuckCount++;
        }

        if (stuckCount > 0) {
          logger.info('[StuckDetector] notifications sent', { count: stuckCount });
        }
      } catch (e: any) {
        logger.error('[StuckDetector] failed', { error: e?.message });
      }
    },
  };
}
