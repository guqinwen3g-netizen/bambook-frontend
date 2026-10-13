/**
 * orderScheduleService.ts — H16-③ 订单进度对照（只读增强）
 *
 * 背景：H16 现状核准的三个缺口之一是「进度反馈」。按专业判断**降级为只读增强**——
 * 不做双向会话（B2B 客户更倾向直接找业务员，双向反馈的过度建设风险最高），
 * 而是把客户真正关心的那件事讲清楚：**我的货什么时候到？有没有延误？**
 *
 * 输出：订单交期（承诺客户的 dueDate）+ 计划/实际离港与到港 + **交期达成判定**（含偏差天数）。
 *
 * 数据边界（与 `timelineService` 同口径，只给对外节点）：
 *   - 给：dueDate / etd / atd / eta / ata / 是否已交付 / 偏差天数 / 一句人话结论；
 *   - **不给**：内部延误原因、工厂与供应商、成本运费、内部备注与审批。
 *
 * 纯只读：不写库、不触发状态重算。
 */
import type { PrismaClient } from '@prisma/client';
import { SHIPPED_SHIPMENT_STATUSES } from '../shared/shippingLock';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';


/** 交期达成判定 */
export type ScheduleStatus = 'on_time' | 'delayed' | 'overdue' | 'pending' | 'unknown';

export interface OrderSchedule {
  dueDate: string | null;      // 订单交期（承诺客户的）
  plannedEtd: string | null;   // 计划离港（取该单全部运单中最早的 ETD）
  actualAtd: string | null;    // 实际离港（取最晚的 ATD）
  plannedEta: string | null;   // 计划到港（最晚 ETA）
  actualAta: string | null;    // 实际到港（最晚 ATA）
  delivered: boolean;          // 是否已有运单进入 Delivered
  status: ScheduleStatus;
  /** 偏差天数（正数 = 晚于交期，负数 = 早于交期）；无法判定时为 null */
  deviationDays: number | null;
  /** 判定依据（给客户看的一句话） */
  basis: string;
}

const SHIPPED_STATUSES = new Set<string>(SHIPPED_SHIPMENT_STATUSES); // 收口到 shared/shippingLock
const DAY_MS = 86400000;

const toDay = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};

/** 日期差（天数，b − a）；两个入参都需 YYYY-MM-DD */
function diffDays(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / DAY_MS);
}

/**
 * 订单进度对照。订单不存在/已软删 → null（路由层已先做归属校验）。
 */
export async function buildOrderSchedule(
  prisma: PrismaClient,
  orderId: string,
  today = todayLocalKey(),
): Promise<OrderSchedule | null> {
  const db = prisma as any;

  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, dueDate: true },
  });
  if (!order) return null;

  // 该订单的全部运单（含经 DR-016 分配挂上来的，与时间线/详情同口径）
  const allocs: any[] = await db.shipmentOrderAllocation
    .findMany({ where: { orderId }, select: { shipmentId: true } })
    .catch(() => []);
  const allocIds = allocs.map(a => a.shipmentId).filter(Boolean);
  const shipments: any[] = await db.shipment.findMany({
    where: { deletedAt: null, OR: [{ orderId }, ...(allocIds.length ? [{ id: { in: allocIds } }] : [])] },
    select: { id: true, status: true, etd: true, atd: true, eta: true, ata: true },
  }).catch((e: any) => {
    logger.error('[OrderSchedule] shipments query failed', { error: e?.message, orderId });
    return [];
  });

  const active = shipments.filter(s => s.status !== 'Cancelled');
  const pickEarliest = (vals: Array<string | null>) => vals.filter(Boolean).sort()[0] ?? null;
  const pickLatest = (vals: Array<string | null>) => {
    const v = vals.filter(Boolean).sort();
    return v.length ? v[v.length - 1] : null;
  };

  const plannedEtd = pickEarliest(active.map(s => toDay(s.etd)));
  const actualAtd = pickLatest(active.map(s => toDay(s.atd)));
  const plannedEta = pickLatest(active.map(s => toDay(s.eta)));
  const actualAta = pickLatest(active.map(s => toDay(s.ata)));
  const delivered = active.some(s => s.status === 'Delivered');
  const shipped = active.some(s => SHIPPED_STATUSES.has(s.status));

  const dueDate = toDay(order.dueDate);

  let status: ScheduleStatus = 'unknown';
  let deviationDays: number | null = null;
  let basis = '未登记交期，无法判定进度';

  if (dueDate) {
    // 参照日：已交付 → 用实际完成日（优先 ATA，回退 ATD）；未交付 → 用今天（是否已逾期）
    const completionDay = actualAta ?? actualAtd;
    if (delivered && completionDay) {
      deviationDays = diffDays(dueDate, completionDay);
      if (deviationDays <= 0) {
        status = 'on_time';
        basis = deviationDays === 0
          ? `按交期 ${dueDate} 如期交付`
          : `早于交期 ${dueDate} ${Math.abs(deviationDays)} 天交付`;
      } else {
        status = 'delayed';
        basis = `晚于交期 ${dueDate} ${deviationDays} 天交付`;
      }
    } else if (delivered) {
      // 已交付但运单未登记实际到港/离港 —— 不猜日期，只给结论
      status = 'on_time';
      basis = '已交付（运单未登记实际日期，无法计算偏差）';
    } else {
      deviationDays = diffDays(dueDate, today);
      if (deviationDays > 0) {
        status = 'overdue';
        basis = shipped
          ? `已发运，但按交期 ${dueDate} 已逾期 ${deviationDays} 天`
          : `按交期 ${dueDate} 已逾期 ${deviationDays} 天（尚未发运）`;
      } else {
        status = 'pending';
        basis = shipped
          ? `已发运，距交期 ${dueDate} 还有 ${Math.abs(deviationDays)} 天`
          : `进行中，距交期 ${dueDate} 还有 ${Math.abs(deviationDays)} 天`;
      }
    }
  }

  return {
    dueDate,
    plannedEtd,
    actualAtd,
    plannedEta,
    actualAta,
    delivered,
    status,
    deviationDays,
    basis,
  };
}
