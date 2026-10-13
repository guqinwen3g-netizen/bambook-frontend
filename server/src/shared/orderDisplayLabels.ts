/**
 * 订单台账的**展示标签真源**（状态 / 类型）。
 *
 * ★ 为什么收成这一个文件（2026-09-26 现量出来的两件事）：
 *   ① `server/src/orders/routeV2.ts` 导出的 xlsx 里「类型」列直接写 `o.type`（英文枚举）、
 *      「负责人」列写 `o.ownerId`（内部账号 id），而屏面同一格是中文/人名 ⇒ **发给工厂和客户的文件里是机器码**；
 *   ② 状态标签在全仓有**三份**：导出那份（6 键，无 Cancelled）、屏面状态卡那份（7 键）、
 *      屏面筛选下拉那份（`Shipping` 写作**发货中**，另两份是「出运中」）⇒ 同一个页面两个控件对同一个状态说两个字。
 *   本文件是 ① 的修法与 ② 的**唯一出处**：出口一律从这里取，谁再抄一份字面量就会被守卫点名。
 *
 * ⚠️ 未拍板的一项：`Shipping` 到底叫「出运中」还是「发货中」——**业务口径**，见台账 §12.1 第 37 条。
 *    在拍板之前这里保持**多数派**（两份用「出运中」），筛选下拉那处仍写「发货中」并由守卫登记为**具名例外**
 *    （例外清单不是放宽：新增分歧必红、把字统一了却忘了删例外也必红）。
 *
 * 回退策略：查不到标签时**返回 null，由调用方留空**，不许把英文枚举原样落到文件里
 * （同 §9 B226 那条"不许把脏值上屏"、§9 B227"同一格两个出口必须同串"）。
 */

/** 订单状态 → 中文标签。键集＝屏面状态卡那份（含 Cancelled，导出旧版缺它）。 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  Pending: '待确认',
  Confirmed: '已确认',
  Production: '生产中',
  Shipping: '出运中',
  Delivered: '已交付',
  Alert: '异常',
  Cancelled: '已取消',
};

/** 订单类型 → 中文标签（＝屏面 `DB_TYPE_ZH` 那份）。 */
export const ORDER_TYPE_LABEL: Record<string, string> = {
  Fabric: '面料',
  Garment: '成衣',
  Other: '其他',
};

/** 查不到 ⇒ null（宁空不裸码）。 */
export function orderStatusLabel(status: unknown): string | null {
  if (status == null || status === '') return null;
  return ORDER_STATUS_LABEL[String(status)] ?? null;
}

export function orderTypeLabel(type: unknown): string | null {
  if (type == null || type === '') return null;
  return ORDER_TYPE_LABEL[String(type)] ?? null;
}
