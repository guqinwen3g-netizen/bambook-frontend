/**
 * Agent-P1: ProductAsset mutation service（route + Agent flow 共用契约）。
 * 每个 mutation 内部 $transaction + AuditLog 同事务闭环，fail closed。
 * 支持 optional tx 参数：route 传 tx 共用同事务，Agent 不传则 service 自开 $transaction。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { checkSubCategoryId, normalizeSubCategoryId } from './subCategoryGuard';

export type ProductAssetMutationErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_AMOUNT'
  | 'NOT_FOUND'
  | 'ALREADY_DELETED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED';

/** DR-054 阶段 D：产品来源白名单（ProductAsset.source） */
export const PRODUCT_SOURCE_TYPES = [
  'manual', 'development', 'supplier_recommend', 'customer_sample', 'sourcing', 'specified_purchase', 'other',
] as const;

/** ProductAsset.cost is independent CNY unit cost, not a target or a sales price. */
export function parseProductAssetCost(v: unknown):
  { ok: true; value: Prisma.Decimal | null } | { ok: false } {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    return { ok: true, value: null };
  }
  if (typeof v !== 'number' && typeof v !== 'string') return { ok: false };
  if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false };
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v.trim())) return { ok: false };
  try {
    const value = new Prisma.Decimal(typeof v === 'string' ? v.trim() : v);
    // Match Decimal(18,4) storage without silently rounding or manufacturing zero.
    if (!value.isFinite() || value.isNegative() || value.decimalPlaces() > 4
      || value.greaterThan('99999999999999.9999')) return { ok: false };
    return { ok: true, value };
  } catch { return { ok: false }; }
}

function normalizeSource(v: any): string {
  const s = String(v ?? 'manual').trim();
  return (PRODUCT_SOURCE_TYPES as readonly string[]).includes(s) ? s : 'manual';
}

export interface ProductAssetMutationResult {
  ok: boolean;
  data?: { asset?: any; auditId: string };
  error?: { code: ProductAssetMutationErrorCode; message: string };
}

// ─── CREATE ────────────────────────────────────────────────────────
export async function createProductAsset(
  params: { prisma: PrismaClient; body: any; actorId: string; ip?: string; tx?: any },
): Promise<ProductAssetMutationResult> {
  const { prisma, body, actorId, ip } = params;
  const tx = params.tx;
  const now = Date.now();
  const sku = String(body.sku || '').trim();
  const name = String(body.name || '').trim();
  const mainCategory = String(body.mainCategory || '').trim();
  if (!sku || !name || !mainCategory) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'sku, name, mainCategory required' } };
  }
  const cost = parseProductAssetCost(body.cost);
  if (!cost.ok) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'cost must be valid decimal' } };
  }
  // B261：非哨兵的 subCategoryId 必须真实存在，否则一场建档就会留下"分类视图里看不见"的档案
  await checkSubCategoryId(tx || prisma, body.subCategoryId);
  const doCreate = async (cn: any) => {
    const created = await cn.productAsset.create({
      data: {
        id: String(body.id || `PROD-${now}`),
        sku, name, mainCategory,
        subCategoryId: normalizeSubCategoryId(body.subCategoryId),
        season: body.season || '',
        cost: cost.value,
        status: body.status || 'Development',
        source: normalizeSource(body.source),
        sourceDetail: body.sourceDetail != null && String(body.sourceDetail).trim() ? String(body.sourceDetail).trim() : null,
        techPackUrl: body.techPackUrl || null,
        imageUrl: body.imageUrl || null,
        updatedAt: BigInt(now),
        deletedAt: null,
      },
    });
    const auditId = await writeRouteAuditLog({
      prisma: cn, actorId, source: 'mutation-service:create_product_asset',
      operation: 'create_product_asset', targetType: 'ProductAsset', targetId: created.id,
      after: { id: created.id, sku, name, mainCategory, cost: cost.value?.toString() ?? null },
      ip: ip || null,
    });
    return { asset: created, auditId };
  };
  try {
    const asset = tx ? await doCreate(tx) : await (prisma as any).$transaction(doCreate);
    return { ok: true, data: asset };
  } catch (e: any) {
    return { ok: false, error: { code: 'CREATE_FAILED', message: String(e?.message ?? e) } };
  }
}

// ─── UPDATE ────────────────────────────────────────────────────────
export async function updateProductAsset(
  params: { prisma: PrismaClient; assetId: string; patch: Record<string, unknown>; actorId: string; ip?: string; tx?: any },
): Promise<ProductAssetMutationResult> {
  const { prisma, assetId, patch, actorId, ip } = params;
  const tx = params.tx;
  const existing = await (prisma as any).productAsset.findFirst({ where: { id: assetId, deletedAt: null } }).catch(() => null);
  if (!existing) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `product asset ${assetId} not found or deleted` } };
  }
  const cost = parseProductAssetCost(patch.cost);
  if (!cost.ok) {
    return { ok: false, error: { code: 'INVALID_AMOUNT', message: 'cost must be valid decimal' } };
  }
  // B261：同 create 那一刀（没带 subCategoryId 的更新不会被误伤：guard 只认非空值）
  await checkSubCategoryId(tx || prisma, patch.subCategoryId);
  const now = Date.now();
  const doUpdate = async (cn: any) => {
    const data: Record<string, unknown> = { updatedAt: BigInt(now) };
    for (const k of ['sku', 'name', 'mainCategory', 'subCategoryId', 'season', 'status', 'techPackUrl', 'imageUrl']) {
      if (patch[k] !== undefined) data[k] = k === 'subCategoryId' ? normalizeSubCategoryId(patch[k]) : patch[k];
    }
    if (patch.source !== undefined) data.source = normalizeSource(patch.source);
    if (patch.sourceDetail !== undefined) data.sourceDetail = patch.sourceDetail != null && String(patch.sourceDetail).trim() ? String(patch.sourceDetail).trim() : null;
    if (patch.cost !== undefined) data.cost = cost.value;
    const updated = await cn.productAsset.update({ where: { id: assetId }, data });
    const auditId = await writeRouteAuditLog({
      prisma: cn, actorId, source: 'mutation-service:update_product_asset',
      operation: 'update_product_asset', targetType: 'ProductAsset', targetId: assetId,
      before: { id: assetId, sku: existing.sku, name: existing.name, ...(patch.cost !== undefined ? { cost: existing.cost?.toString() ?? null } : {}) },
      after: { id: assetId, ...data },
      ip: ip || null,
    });
    return { asset: updated, auditId };
  };
  try {
    const result = tx ? await doUpdate(tx) : await (prisma as any).$transaction(doUpdate);
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: { code: 'UPDATE_FAILED', message: String(e?.message ?? e) } };
  }
}

// ─── DELETE (soft) ─────────────────────────────────────────────────
export async function deleteProductAsset(
  params: { prisma: PrismaClient; assetId: string; actorId: string; ip?: string; tx?: any },
): Promise<ProductAssetMutationResult> {
  const { prisma, assetId, actorId, ip } = params;
  const tx = params.tx;
  const existing = await (prisma as any).productAsset.findFirst({ where: { id: assetId, deletedAt: null } }).catch(() => null);
  if (!existing) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `product asset ${assetId} not found or already deleted` } };
  }
  const now = BigInt(Date.now());
  const doDelete = async (cn: any) => {
    await cn.productAsset.update({ where: { id: assetId }, data: { deletedAt: now, updatedAt: now } });
    const auditId = await writeRouteAuditLog({
      prisma: cn, actorId, source: 'mutation-service:delete_product_asset',
      operation: 'delete_product_asset', targetType: 'ProductAsset', targetId: assetId,
      before: { id: assetId, deletedAt: null },
      after: { id: assetId, deletedAt: Number(now) },
      ip: ip || null,
    });
    return { asset: { id: assetId }, auditId };
  };
  try {
    const result = tx ? await doDelete(tx) : await (prisma as any).$transaction(doDelete);
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: { code: 'DELETE_FAILED', message: String(e?.message ?? e) } };
  }
}
