/**
 * shipmentScheduleHistoryService.ts — ★ D5 运单「改期/物流变更」历史（只读，零写入）
 *
 * ── 为什么需要它 ──
 * 甩柜/改船期是面料外贸最高频的异常之一（船公司通知改期 → 业务员改运单 → 客户/报关/单证都要跟着改）。
 * 而此前 `update_shipment` 的审计**只记 status + shipmentNumber**
 * ⇒「这一票改过几次期、谁改的、改成什么」**全查不到**。
 *
 * 修法（**零 migration**）：写侧改为**逐字段**字段级审计（`shipmentMutationService` 里
 * `writeFieldAuditDiff` + `SHIPMENT_TRACKED_FIELD_KEYS`），读侧就是本服务 ——
 * 把那些字段级记录还原成「改期历史」。
 *
 * ⓘ 为什么读侧要单独一层：审计表是**全模块通用**的（`targetType` 五花八门、`fieldPath` 自由文本），
 *   让前端直接查审计会把「Shipment 的哪些字段算改期」这个判据散到前端去。
 *   判据只在本模块（`shipmentScheduleFields`）与这里出现 —— 与写侧同一份真源。
 */
import type { PrismaClient } from '@prisma/client';
import {
  SHIPMENT_TRACKED_FIELD_KEYS,
  scheduleFieldLabel,
  describeScheduleChange,
} from './shipmentScheduleFields';

export interface ScheduleChangeRow {
  auditId: string;
  /** Prisma 字段名（如 etd） */
  field: string;
  /** 中文标签（如 预计离港(ETD)） */
  fieldLabel: string;
  fromValue: unknown;
  toValue: unknown;
  /** 面向人的一句话：`预计离港(ETD) 2026-09-20 → 2026-09-27` */
  description: string;
  actorId: string | null;
  /** ISO 时间（AuditLog.createdAt） */
  at: string | null;
  /** 同一业务操作（PATCH）的串联 id —— 一次改期同时改了 ETD+船名时两条记录共享它 */
  transactionId: string | null;
}

export interface ShipmentScheduleHistory {
  shipmentId: string;
  /** 倒序（最新在前） */
  changes: ScheduleChangeRow[];
  count: number;
}

/**
 * 改期/物流变更历史（倒序）。
 *
 * 只取 `targetType='Shipment'` + `fieldPath ∈ 受追踪字段` 的字段级审计 ——
 * 与写侧 `SHIPMENT_TRACKED_FIELD_KEYS` **同一份真源**（改一处两侧同时生效）。
 */
export async function getShipmentScheduleHistory(
  prisma: PrismaClient,
  shipmentId: string,
  limit = 100,
): Promise<ShipmentScheduleHistory> {
  if (!shipmentId) return { shipmentId: '', changes: [], count: 0 };

  const rows: any[] = await (prisma as any).auditLog.findMany({
    where: {
      targetType: 'Shipment',
      targetId: shipmentId,
      fieldPath: { in: SHIPMENT_TRACKED_FIELD_KEYS },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 500),
    select: {
      id: true, fieldPath: true, beforeValue: true, afterValue: true,
      actorId: true, createdAt: true, transactionId: true,
    },
  });

  const changes: ScheduleChangeRow[] = rows.map(r => ({
    auditId: r.id,
    field: r.fieldPath,
    fieldLabel: scheduleFieldLabel(r.fieldPath),
    fromValue: r.beforeValue ?? null,
    toValue: r.afterValue ?? null,
    description: describeScheduleChange(r.fieldPath, r.beforeValue, r.afterValue),
    actorId: r.actorId ?? null,
    at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    transactionId: r.transactionId ?? null,
  }));

  return { shipmentId, changes, count: changes.length };
}

/** 只取「改期」类字段（ETD/ETA/ATD/ATA/订舱日）—— 用于「这一票被甩了几次柜」这类问题 */
export const SCHEDULE_DATE_FIELDS = ['bookingDate', 'etd', 'atd', 'eta', 'ata'];

export async function getShipmentRescheduleHistory(
  prisma: PrismaClient,
  shipmentId: string,
  limit = 100,
): Promise<ShipmentScheduleHistory> {
  const all = await getShipmentScheduleHistory(prisma, shipmentId, limit);
  const changes = all.changes.filter(c => SCHEDULE_DATE_FIELDS.includes(c.field));
  return { shipmentId, changes, count: changes.length };
}
