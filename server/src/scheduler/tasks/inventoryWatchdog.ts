import { businessNowDate } from '../../shared/businessClock';
/**
 * 阶段 E / E1 — 调度任务：库存低储 / 超储预警
 *
 * 每小时扫描设置了预警线的库存项（InventoryItem.minStock / maxStock 非空）：
 *   1. 低储：可用量 available = quantity - lockedQuantity
 *      - available ≤ 0 → critical（断货）
 *      - 0 < available < minStock → warning（低于安全库存）
 *      - 仅在 minStock 非空时评估（未设预警线的项无口径，按单生产零库存不打扰）
 *   2. 超储：quantity > maxStock → info（积压占用资金，仅 maxStock 非空时评估）
 *
 * 去重规则（与 expiryWatchdog 一致）：
 *   dedupKey 含 tier：`inv:low:${itemId}:${tier}:${today}` / `inv:over:${itemId}:${today}`
 *   同级别当天只发一次；低储级别升级（warning→critical）会重新通知。
 *
 * 数量字段为 Prisma Decimal，比较前统一 Number() 转换。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { createNotificationService } from '../../notifications/notificationService';
import { logger } from '../../lib/logger';

const BATCH_LIMIT = 100;

let lastRunHour = -1;

interface InvRow {
  id: string;
  description: string;
  materialCode: string | null;
  category: string | null;
  warehouseId: string;
  locationCode: string | null;
  unit: string;
  quantity: any; // Decimal
  lockedQuantity: any; // Decimal
  minStock: any | null;
  maxStock: any | null;
}

function num(v: any): number {
  if (v == null) return NaN;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : NaN;
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
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const items: InvRow[] = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
      OR: [{ minStock: { not: null } }, { maxStock: { not: null } }],
    },
    select: {
      id: true, description: true, materialCode: true, category: true,
      warehouseId: true, locationCode: true, unit: true,
      quantity: true, lockedQuantity: true, minStock: true, maxStock: true,
    },
    take: BATCH_LIMIT,
  });

  let sent = 0;

  const notifyOnce = async (dedupKey: string, payload: {
    title: string; body: string; level: 'info' | 'warning' | 'critical'; metadata: Record<string, any>;
  }) => {
    const existing = await prisma.notification.findFirst({
      where: { type: 'inventory_alert', metadata: { path: ['dedupKey'], equals: dedupKey } },
      select: { id: true },
    });
    if (existing) return;
    await notificationService.broadcastNotification({
      type: 'inventory_alert',
      title: payload.title,
      body: payload.body,
      level: payload.level,
      link: `/inventory?id=${payload.metadata.entityId}`,
      metadata: { dedupKey, ...payload.metadata },
    });
    sent++;
  };

  for (const item of items) {
    const qty = num(item.quantity);
    const locked = num(item.lockedQuantity) || 0;
    const min = item.minStock != null ? num(item.minStock) : null;
    const max = item.maxStock != null ? num(item.maxStock) : null;
    if (!Number.isFinite(qty)) continue;
    const available = qty - locked;

    const label = item.materialCode ? `${item.materialCode} ${item.description}` : item.description;
    const locStr = item.locationCode ? `，库位 ${item.locationCode}` : '';

    // ── 低储 ──
    if (min != null && Number.isFinite(min)) {
      const tier = available <= 0 ? 'critical' : available < min ? 'warning' : null;
      if (tier) {
        await notifyOnce(`inv:low:${item.id}:${tier}:${todayStr}`, {
          title: available <= 0 ? `库存 ${label} 可用量耗尽` : `库存 ${label} 低于安全库存`,
          body: `物料 ${label}${locStr}：当前 ${qty} ${item.unit}，锁定 ${locked}，可用 ${available} ${item.unit}，安全线 ${min}。${available <= 0 ? '可用量已耗尽，请立即补料或调整分配。' : '可用量低于安全库存，请评估采购/备料。'}`,
          level: tier,
          metadata: {
            tier,
            entityType: 'InventoryItem',
            entityId: item.id,
            alertKind: 'low_stock',
            quantity: qty,
            lockedQuantity: locked,
            available,
            minStock: min,
            unit: item.unit,
            warehouseId: item.warehouseId,
          },
        });
      }
    }

    // ── 超储 ──
    if (max != null && Number.isFinite(max) && qty > max) {
      await notifyOnce(`inv:over:${item.id}:${todayStr}`, {
        title: `库存 ${label} 超储`,
        body: `物料 ${label}${locStr}：当前 ${qty} ${item.unit}，超储线 ${max}，已超出 ${qty - max} ${item.unit}，请关注积压资金占用。`,
        level: 'info',
        metadata: {
          tier: 'info',
          entityType: 'InventoryItem',
          entityId: item.id,
          alertKind: 'over_stock',
          quantity: qty,
          maxStock: max,
          unit: item.unit,
          warehouseId: item.warehouseId,
        },
      });
    }
  }

  if (sent > 0) {
    logger.info('[InventoryWatchdog] notifications sent', { count: sent });
  }
  return sent;
}

export function createInventoryWatchdogTask(): ScheduledTask {
  return {
    id: 'inventory_watchdog',
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
        logger.error('[InventoryWatchdog] failed', { error: e?.message });
      }
    },
  };
}
