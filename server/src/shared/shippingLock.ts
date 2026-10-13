/**
 * shippingLock.ts — 「已发运」判据的**唯一真源**（**纯函数，零依赖**）
 *
 * ── 为什么必须收成一处（2026-09-18 实测）──
 * 「货已经发走了，这条数据就不能再改」这条规则，此前散在**三处各写一份**：
 *   ① shipping/allocationService：`SHIPPED_LOCKED_STATUSES = {Shipped, Arrived, Cleared, Delivered}`（运单侧）
 *   ② orderChanges/orderChangeRequestService：`{Shipping, Delivered}`（订单侧）
 *   ③ B3 新增的「改价/改量」判定（订单侧 + 运单侧都要看）
 * 两处枚举**语义不同但名字几乎一样**，改一处忘另一处 = 典型「收口点错位」。
 * 本文件把「运单已发运」与「订单已发运」这两个**不同口径**显式分开命名，谁都不许再内联。
 *
 * ── 两个口径（别混用）──
 *   · **运单侧**（Shipment.status）：Shipped 及之后（Arrived/Cleared/Delivered）= 货已离厂，
 *     库存已扣、发票可开、批次可结算 ⇒ 数量/单位不可再动（A1/A1-b）。
 *     ⓘ Booked/Loading 只是订舱/装柜，**还没离厂**，不算已发运。
 *   · **订单侧**（Order.status）：Shipping（有票在途）/ Delivered（已交付）。
 *     订单没有「已发货未出运」这一档，所以 Shipping 等价于「已启动出运」。
 *
 * ⚠️ 新增「已发运」判定**必须**用本模块，不要再手写 `status === 'Shipped'` 集合。
 */

/** 运单侧：货已离厂（库存已扣 / 可开票 / 可结算） */
export const SHIPPED_SHIPMENT_STATUSES = ['Shipped', 'Arrived', 'Cleared', 'Delivered'] as const;

/** 运单侧：仍可能在途（未取消、已启动）—— 用于「还有没有别的票在路上」 */
export const ACTIVE_SHIPMENT_EXCLUDED_STATUSES = ['Cancelled', 'Draft'] as const;

/** 订单侧：已启动出运 / 已交付 */
export const SHIPPED_ORDER_STATUSES = ['Shipping', 'Delivered'] as const;

const SHIPPED_SHIPMENT_SET = new Set<string>(SHIPPED_SHIPMENT_STATUSES);
const ACTIVE_EXCLUDED_SET = new Set<string>(ACTIVE_SHIPMENT_EXCLUDED_STATUSES);
const SHIPPED_ORDER_SET = new Set<string>(SHIPPED_ORDER_STATUSES);

/** 运单是否「已发运」（货已离厂） */
export function isShipmentShipped(status?: string | null): boolean {
  return !!status && SHIPPED_SHIPMENT_SET.has(status);
}

/** 运单是否「在途」（未取消且已启动：Draft 还没启动，Cancelled 已终止） */
export function isShipmentActive(status?: string | null): boolean {
  return !!status && !ACTIVE_EXCLUDED_SET.has(status);
}

/** 订单是否「已发运/已交付」（订单侧口径） */
export function isOrderShipped(status?: string | null): boolean {
  return !!status && SHIPPED_ORDER_SET.has(status);
}

/**
 * 运单是否已取消 —— 「跨票累计出运量」口径的排除条件。
 *
 * ⓘ 这个判定与上面三个**语义不同**，别混：累计出运量算的是「**已分配**的出运量」，
 *   `Draft/Booked/Loading` 的分配**算数**（业务员已承诺这票要装多少），只有 `Cancelled`
 *   才从累计里剔除。C3 的订单行已出运量快照与 allocationService 的上限校验**共用**它，
 *   否则会出现「上限校验说没超、容差面板说短装」的同数不同判。
 */
export function isShipmentCancelled(status?: string | null): boolean {
  return status === 'Cancelled';
}
