import { businessError } from '../shared/errorCodes';

/**
 * B261：`ProductAsset.subCategoryId` 的存在性一刀。
 *
 * 立账现场：数字档案里有 3 件成衣的 `subCategoryId` 值是字符串 `uncategorized`，
 * 而 `ProductSubCategory` 表里根本没有这一行 ⇒ "产品类别"视图没有任何一格承接它们
 * （Hub 那张卡说 15 件、分类视图只数到 12 件）。
 *
 * ★ 只补一刀，不扩改动面：**给了非哨兵的值就必须存在**。空值与哨兵 `uncategorized` 沿用今天的行为
 *   ——全仓有四个写入点会写这枚哨兵（本 service 建/改、`garmentDevelopmentService.ts:126`、
 *   `fabricDevelopmentService.ts:956`、前端 `ProductsManager.tsx:2939`），一次性迁走它要先动读侧口径，
 *   那是另一批的事；混进来会让"修一个悬空值"变成"改四处行为"。
 * ★ 纯空白今天会被原样写库（`x || 'uncategorized'` 只兜 falsy）⇒ 那也是一类悬空值，
 *   本刀顺手把它归一到哨兵：空白＝没挂子分类，不是一个 id。
 */
export const SUB_CATEGORY_SENTINEL = 'uncategorized';

/** 落库值：空/纯空白/缺字段 ⇒ 哨兵；其余原样。 */
export function normalizeSubCategoryId(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s || SUB_CATEGORY_SENTINEL;
}

/** 非哨兵的值必须在 `ProductSubCategory` 里存在且未软删，否则抛业务错误（400 档）。 */
export async function checkSubCategoryId(client: any, raw: unknown): Promise<void> {
  const s = String(raw ?? '').trim();
  if (!s || s === SUB_CATEGORY_SENTINEL) return;
  const hit = await client.productSubCategory.findFirst({ where: { id: s, deletedAt: null } });
  if (!hit) {
    throw businessError('VALIDATION_FAILED', '所选产品子分类不存在或已被删除，请在分类列表里重新选择。');
  }
}
