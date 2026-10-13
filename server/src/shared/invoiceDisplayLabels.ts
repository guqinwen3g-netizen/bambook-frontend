/**
 * invoiceDisplayLabels.ts — 发票状态的**内部界面中文标签**（2026-09-29）
 *
 * ★★ 为什么与 `server/src/customer/route.ts` 里的 `INVOICE_STATUS_LABEL` **并存而不合并**：
 *   那一份是**给客户门户**的，值是**英文**（`Draft:'Draft'` / `PartiallyPaid:'Partially Paid'`）。
 *   ★ 但使用方明确指出：**"加拿大客户只是一个例子，我们还有超级多世界各地的客户"**
 *   ⇒ 门户那份**不能假定单一语言**（那属另一议题，已单列）。
 *   ★ 本文件只管**内部界面**的中文，**不动门户那份**。
 *
 * ★ 术语由使用方授权开发方定（R14）。
 * ★ 纪律沿用订单/运单那两份：**查不到 ⇒ null（宁空不裸码）**。
 */

/** 发票状态 → 内部界面中文标签。枚举镜像 `VALID_INVOICE_STATUS`（5 态）。 */
export const INVOICE_STATUS_LABEL_ZH: Record<string, string> = {
  Draft: '草稿',
  Issued: '已开票',
  PartiallyPaid: '部分核销',
  Paid: '已结清',
  Cancelled: '已作废',
};

/** 查不到 ⇒ null（宁空不裸码）。 */
export function invoiceStatusLabelZh(status: unknown): string | null {
  if (status == null || status === '') return null;
  return INVOICE_STATUS_LABEL_ZH[String(status)] ?? null;
}

/**
 * 产品状态 → 内部界面中文标签。
 * ★ 原来 `ProductsManager.tsx` 的 `PRODUCT_STATUS_OPTIONS` **label 与 value 一模一样**
 *   （`{ value: 'Active', label: 'Active' }`）⇒ 等于没有中文。
 * ★ 注意：同文件的 `GARMENT_STATUS_OPTIONS` 用的是**中文值**（`'开发样'`）⇒ 两种产品类型不一致，
 *   本表只覆盖**英文值**那一支；中文值那支**原样透传**。
 */
export const PRODUCT_STATUS_LABEL_ZH: Record<string, string> = {
  Development: '开发中',
  Active: '启用',
  Archived: '已归档',
};

/** 查不到 ⇒ 原样返回（产品状态里中文值本身就是标签，透传是对的）。 */
export function productStatusLabelZh(status: unknown): string | null {
  if (status == null || status === '') return null;
  const s = String(status);
  return PRODUCT_STATUS_LABEL_ZH[s] ?? s;
}
