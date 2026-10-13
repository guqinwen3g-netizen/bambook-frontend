/**
 * 阶段 P2 — 电子画册服务（PRD 6.2 P2 LookbookCatalog）
 *
 * 职责：
 *   产品图片 + 描述 + 价格 → Web 预览 / 打印 PDF 的画册载体。
 *   items 为 JSON 快照数组：写操作时服务端从 ProductAsset 重取 sku/name/imageUrl，
 *   客户端仅提供 productAssetId 选择依据与 price/currency/description/sortOrder 展示参数——
 *   画册内容口径以档案真源为准，防止客户端伪造产品名称/图片。
 *
 * 状态机：Draft → Published（须 ≥1 条目，记录 publishedAt）→ Archived；Published 可回退 Draft。
 * 设计原则与各域服务一致：服务工厂 / 软删除 / 中文校验错误消息。
 */

import { PrismaClient, LookbookCatalog } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';

export interface LookbookItemInput {
  productAssetId: string;
  price?: number | null;
  currency?: string | null;
  description?: string | null;
  sortOrder?: number;
}

export interface LookbookItemSnapshot {
  productAssetId: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  sortOrder: number;
}

export interface LookbookInput {
  title: string;
  description?: string | null;
}

export type LookbookPatch = Partial<LookbookInput>;

const LOOKBOOK_STATUSES = ['Draft', 'Published', 'Archived'] as const;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

export function createLookbookService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  async function getLookbookOrThrow(id: string): Promise<LookbookCatalog> {
    const row = await db.lookbookCatalog.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) throw new Error('画册不存在');
    return row;
  }

  function parseItems(raw: unknown): LookbookItemSnapshot[] {
    // Prisma Json 字段读回即为解析后的数组；兼容历史双重编码字符串
    if (Array.isArray(raw)) return raw as LookbookItemSnapshot[];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /** 从档案真源构建条目快照（sku/name/imageUrl 服务端重取） */
  async function buildItemSnapshots(items: LookbookItemInput[]): Promise<LookbookItemSnapshot[]> {
    if (!Array.isArray(items)) throw new Error('条目列表非法');
    if (items.length > 200) throw new Error('单个画册条目数不可超过 200');

    const snapshots: LookbookItemSnapshot[] = [];
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const assetId = item?.productAssetId?.trim();
      if (!assetId) throw new Error(`第 ${index + 1} 条目的 productAssetId 必填`);
      if (seen.has(assetId)) throw new Error(`产品 ${assetId} 在画册中重复`);
      seen.add(assetId);

      const asset = await db.productAsset.findUnique({
        where: { id: assetId },
        include: { images: { where: { deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 } },
      });
      if (!asset || asset.deletedAt !== null) throw new Error(`产品 ${assetId} 不存在`);

      if (item.price !== undefined && item.price !== null && (!Number.isFinite(item.price) || item.price < 0)) {
        throw new Error(`第 ${index + 1} 条目价格非法`);
      }

      const primaryImage = Array.isArray(asset.images) && asset.images.length > 0 ? asset.images[0] : null;
      snapshots.push({
        productAssetId: asset.id,
        sku: asset.sku,
        name: asset.name,
        imageUrl: primaryImage?.filePath ?? asset.imageUrl ?? null,
        description: item.description?.trim() || null,
        price: item.price ?? null,
        currency: item.currency?.trim() || null,
        sortOrder: Number.isFinite(item.sortOrder) ? Number(item.sortOrder) : index,
      });
    }
    snapshots.sort((a, b) => a.sortOrder - b.sortOrder);
    return snapshots;
  }

  async function createLookbook(input: LookbookInput, actorId: string): Promise<LookbookCatalog> {
    const title = input.title?.trim();
    if (!title) throw new Error('画册标题必填');
    const ts = now();
    const row = await db.lookbookCatalog.create({
      data: {
        id: generateId('LB'),
        title,
        description: input.description?.trim() || null,
        status: 'Draft',
        items: [],
        publishedAt: null,
        createdBy: actorId,
        createdAt: BigInt(ts),
        updatedAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[LookbookService] lookbook created', { id: row.id, title, actorId });
    return row;
  }

  async function listLookbooks(query: { status?: string; limit?: number; offset?: number }) {
    const where: any = { deletedAt: null };
    if (query.status) {
      if (!(LOOKBOOK_STATUSES as readonly string[]).includes(query.status)) throw new Error(`非法状态：${query.status}`);
      where.status = query.status;
    }
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.lookbookCatalog.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      db.lookbookCatalog.count({ where }),
    ]);
    return { items, total };
  }

  async function getLookbook(id: string): Promise<LookbookCatalog> {
    return getLookbookOrThrow(id);
  }

  async function updateLookbook(id: string, patch: LookbookPatch, actorId: string): Promise<LookbookCatalog> {
    const row = await getLookbookOrThrow(id);
    if (row.status === 'Archived') throw new Error('已归档画册不可修改');
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('画册标题必填');

    const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
    if (patch.title !== undefined) data.title = patch.title.trim();
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    const updated = await db.lookbookCatalog.update({ where: { id: row.id }, data });
    logger.info('[LookbookService] lookbook updated', { id: row.id, actorId, fields: Object.keys(patch) });
    return updated;
  }

  /** 整体替换条目（幂等：同一输入产出同一快照数组） */
  async function setLookbookItems(id: string, items: LookbookItemInput[], actorId: string): Promise<LookbookCatalog> {
    const row = await getLookbookOrThrow(id);
    if (row.status === 'Archived') throw new Error('已归档画册不可修改');
    const snapshots = await buildItemSnapshots(items);
    const updated = await db.lookbookCatalog.update({
      where: { id: row.id },
      data: { items: snapshots, updatedAt: BigInt(now()) },
    });
    logger.info('[LookbookService] lookbook items replaced', { id: row.id, count: snapshots.length, actorId });
    return updated;
  }

  async function publishLookbook(id: string, actorId: string): Promise<LookbookCatalog> {
    const row = await getLookbookOrThrow(id);
    if (row.status === 'Archived') throw new Error('已归档画册不可发布');
    if (row.status === 'Published') return row; // 幂等
    if (parseItems(row.items).length === 0) throw new Error('画册无条目，不可发布');
    const updated = await db.lookbookCatalog.update({
      where: { id: row.id },
      data: { status: 'Published', publishedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[LookbookService] lookbook published', { id: row.id, actorId });
    return updated;
  }

  async function unpublishLookbook(id: string, actorId: string): Promise<LookbookCatalog> {
    const row = await getLookbookOrThrow(id);
    if (row.status !== 'Published') throw new Error('仅已发布画册可回退为草稿');
    const updated = await db.lookbookCatalog.update({
      where: { id: row.id },
      data: { status: 'Draft', publishedAt: null, updatedAt: BigInt(now()) },
    });
    logger.info('[LookbookService] lookbook unpublished', { id: row.id, actorId });
    return updated;
  }

  async function archiveLookbook(id: string, actorId: string): Promise<LookbookCatalog> {
    const row = await getLookbookOrThrow(id);
    if (row.status === 'Archived') return row; // 幂等
    const updated = await db.lookbookCatalog.update({
      where: { id: row.id },
      data: { status: 'Archived', updatedAt: BigInt(now()) },
    });
    logger.info('[LookbookService] lookbook archived', { id: row.id, actorId });
    return updated;
  }

  async function deleteLookbook(id: string, actorId: string): Promise<void> {
    const row = await getLookbookOrThrow(id);
    await db.lookbookCatalog.update({
      where: { id: row.id },
      data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
    });
    logger.info('[LookbookService] lookbook soft-deleted', { id: row.id, actorId });
  }

  return {
    createLookbook,
    listLookbooks,
    getLookbook,
    updateLookbook,
    setLookbookItems,
    publishLookbook,
    unpublishLookbook,
    archiveLookbook,
    deleteLookbook,
  };
}

export type LookbookService = ReturnType<typeof createLookbookService>;
