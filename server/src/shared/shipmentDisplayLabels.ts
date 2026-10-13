/**
 * shipmentDisplayLabels.ts — 运单状态/类型的**中文标签唯一真源**（2026-09-29 抽取）
 *
 * 为什么要有这一份（与 `orderDisplayLabels.ts` 同因）：
 *   原表是 `server/src/shipping/route.ts` 里的 **`const SHIPMENT_STATUS_LABEL`（未 export）**
 *   ⇒ **前端够不到它** ⇒ `DocumentCenter` 的下拉项只能印**枚举原值**
 *   （中文界面上出现 `Draft` / `Shipped`）。
 *   ★ 这不是"前端忘了用标签表"，是"**真源不可达**" —— 根因在可达性，不在使用方。
 *
 * ★ 纪律沿用订单那份：**查不到 ⇒ null（宁空不裸码）**，回退**不用原值**。
 */

/** 运单状态 → 中文标签。枚举镜像 `VALID_SHIPMENT_STATUS`（8 态，见 shared/statusTransition.ts）。 */
export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿',
  Booked: '已订舱',
  Loading: '装货中',
  Shipped: '已发运',
  Arrived: '已到港',
  Cleared: '已清关',
  Delivered: '已交付',
  Cancelled: '已取消',
};

/** 运单类型 → 中文标签（`Shipment.type` 枚举） */
export const SHIPMENT_TYPE_LABEL: Record<string, string> = {
  Export: '出口',
  Import: '进口',
  Domestic: '内贸',
};

/** 查不到 ⇒ null（宁空不裸码）。 */
export function shipmentStatusLabel(status: unknown): string | null {
  if (status == null || status === '') return null;
  return SHIPMENT_STATUS_LABEL[String(status)] ?? null;
}

export function shipmentTypeLabel(type: unknown): string | null {
  if (type == null || type === '') return null;
  return SHIPMENT_TYPE_LABEL[String(type)] ?? null;
}
