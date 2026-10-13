import { pricingInputError, pricingNotFoundError } from './pricingError';
/**
 * 阶段 P1 — 原材料价格历史服务（PRD 8.5 P1，轨道 A 估算校准数据源）
 *
 * 职责：
 *   1. MaterialPriceHistory CRUD：append 式价格记录（priceDate 为生效日），
 *      纱线/面料/辅料三类，支持关联供应商 snapshot。
 *   2. getPriceTrend：按 materialCode（或 materialType 通用行情）+ 日期范围
 *      返回时间升序序列，供轨道 A 估算校准与前端趋势图。
 *   3. getLatestPrice：指定物料最新一条有效价格。
 *
 * 设计原则（与 pricing 模块一致）：
 *   - 服务工厂模式 createMaterialPriceService(prisma)
 *   - 软删除（deletedAt BigInt）；中文校验错误消息
 */

import { PrismaClient, MaterialPriceHistory } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface MaterialPriceInput {
  materialType: string; // yarn | fabric | trimming
  materialCode?: string | null;
  name: string;
  specification?: string | null;
  price: number;
  unit: string; // M | YD | KG | PC
  currency?: string;
  priceDate: string; // YYYY-MM-DD
  source?: string; // manual | purchase-order | quotation
  supplierRelationId?: string | null;
  supplierName?: string | null;
  notes?: string | null;
}

export type MaterialPricePatch = Partial<MaterialPriceInput>;

export interface MaterialPriceListQuery {
  materialType?: string;
  materialCode?: string;
  source?: string;
  from?: string; // priceDate >= from
  to?: string; // priceDate <= to
  limit?: number;
  offset?: number;
}

const MATERIAL_TYPES = ['yarn', 'fabric', 'trimming'] as const;
const SOURCES = ['manual', 'purchase-order', 'quotation'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createMaterialPriceService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  async function getPriceOrThrow(id: string): Promise<MaterialPriceHistory> {
    const row = await db.materialPriceHistory.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw pricingNotFoundError('价格记录不存在');
    return row;
  }

  function assertInput(input: Partial<MaterialPriceInput>, partial: boolean): void {
    if (!partial || input.materialType !== undefined) {
      if (!input.materialType || !(MATERIAL_TYPES as readonly string[]).includes(input.materialType)) {
        throw pricingInputError(`非法物料类型：${input.materialType}（允许 yarn | fabric | trimming）`);
      }
    }
    if (!partial || input.name !== undefined) {
      if (!input.name?.trim()) throw pricingInputError('物料名称必填');
    }
    if (!partial || input.price !== undefined) {
      if (!Number.isFinite(input.price) || input.price! <= 0) throw pricingInputError('价格必须大于 0');
    }
    if (!partial || input.unit !== undefined) {
      if (!input.unit?.trim()) throw pricingInputError('单位必填');
    }
    if (!partial || input.priceDate !== undefined) {
      if (!input.priceDate || !DATE_RE.test(input.priceDate)) throw pricingInputError('priceDate 必须是 YYYY-MM-DD');
    }
    if (input.source !== undefined && !(SOURCES as readonly string[]).includes(input.source)) {
      throw pricingInputError(`非法来源：${input.source}`);
    }
  }

  async function createMaterialPrice(input: MaterialPriceInput, actorId: string): Promise<MaterialPriceHistory> {
    assertInput(input, false);
    const ts = now();
    const row = await db.materialPriceHistory.create({
      data: {
        id: generateId('MPH'),
        materialType: input.materialType,
        materialCode: input.materialCode?.trim() || null,
        name: input.name.trim(),
        specification: input.specification ?? null,
        price: input.price,
        unit: input.unit.trim(),
        currency: (input.currency ?? 'CNY').toUpperCase(),
        priceDate: input.priceDate,
        source: input.source ?? 'manual',
        supplierRelationId: input.supplierRelationId ?? null,
        supplierName: input.supplierName ?? null,
        notes: input.notes ?? null,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[MaterialPriceService] price created', { id: row.id, materialType: row.materialType, actorId });
    return row;
  }

  async function listMaterialPrices(query: MaterialPriceListQuery) {
    const where: any = { deletedAt: null };
    if (query.materialType) where.materialType = query.materialType;
    if (query.materialCode) where.materialCode = query.materialCode;
    if (query.source) where.source = query.source;
    if (query.from || query.to) {
      where.priceDate = {};
      if (query.from) where.priceDate.gte = query.from;
      if (query.to) where.priceDate.lte = query.to;
    }
    const take = Math.min(query.limit || 100, 500);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.materialPriceHistory.findMany({ where, orderBy: { priceDate: 'desc' }, take, skip }),
      db.materialPriceHistory.count({ where }),
    ]);
    return { items, total };
  }

  const PATCH_FIELDS = [
    'materialType', 'materialCode', 'name', 'specification', 'price', 'unit',
    'currency', 'priceDate', 'source', 'supplierRelationId', 'supplierName', 'notes',
  ] as const;

  async function updateMaterialPrice(id: string, patch: MaterialPricePatch, actorId: string): Promise<MaterialPriceHistory> {
    const row = await getPriceOrThrow(id);
    assertInput(patch, true);
    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    for (const f of PATCH_FIELDS) {
      if ((patch as any)[f] !== undefined) {
        data[f] = f === 'currency' ? String((patch as any)[f]).toUpperCase()
          : f === 'name' ? patch.name!.trim()
          : f === 'materialCode' ? ((patch as any)[f]?.trim() || null)
          : (patch as any)[f];
      }
    }
    const updated = await db.materialPriceHistory.update({ where: { id: row.id }, data });
    logger.info('[MaterialPriceService] price updated', { id: row.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  async function deleteMaterialPrice(id: string, actorId: string): Promise<void> {
    const row = await getPriceOrThrow(id);
    await db.materialPriceHistory.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[MaterialPriceService] price soft-deleted', { id: row.id, actorId });
  }

  /** 价格趋势：时间升序。materialCode 精确匹配；缺省按 materialType 返回通用行情 */
  async function getPriceTrend(query: { materialType: string; materialCode?: string; from?: string; to?: string }) {
    if (!query.materialType || !(MATERIAL_TYPES as readonly string[]).includes(query.materialType)) {
      throw pricingInputError(`非法物料类型：${query.materialType}`);
    }
    const where: any = { deletedAt: null, materialType: query.materialType };
    if (query.materialCode) where.materialCode = query.materialCode;
    if (query.from || query.to) {
      where.priceDate = {};
      if (query.from) where.priceDate.gte = query.from;
      if (query.to) where.priceDate.lte = query.to;
    }
    const rows = await db.materialPriceHistory.findMany({ where, orderBy: { priceDate: 'asc' }, take: 1000 });
    return rows.map((r: any) => ({
      priceDate: r.priceDate,
      price: Number(r.price),
      unit: r.unit,
      currency: r.currency,
      source: r.source,
      supplierName: r.supplierName ?? null,
    }));
  }

  /** 最新一条有效价格（priceDate 最新）；无记录返回 null */
  async function getLatestPrice(query: { materialType: string; materialCode: string }) {
    const row = await db.materialPriceHistory.findFirst({
      where: { deletedAt: null, materialType: query.materialType, materialCode: query.materialCode },
      orderBy: { priceDate: 'desc' },
    });
    return row ?? null;
  }

  return {
    createMaterialPrice,
    listMaterialPrices,
    updateMaterialPrice,
    deleteMaterialPrice,
    getPriceTrend,
    getLatestPrice,
  };
}

export type MaterialPriceService = ReturnType<typeof createMaterialPriceService>;
