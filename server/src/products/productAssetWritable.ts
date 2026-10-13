/**
 * Agent-P1: ProductAsset 可写字段共用 helper（route + Agent flow 共用，避免反向依赖 route 模块）。
 */

export const PRODUCT_ASSET_WRITABLE_FIELDS = new Set([
  'sku',
  'name',
  'mainCategory',
  'subCategoryId',
  'season',
  'cost',
  'status',
  'techPackUrl',
  'imageUrl',
]);

export function stripProductAssetWritable(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!PRODUCT_ASSET_WRITABLE_FIELDS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}
