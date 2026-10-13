/**
 * colorCardService.ts — REQ2-09 Pantone 色号库（DR-051）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/Pantone色号库.md
 *
 * DR-051 三决策：
 *   ① 通用色卡建模（code 开放唯一，Pantone TCX 仅 seed 起步；客户自定义色号可建）
 *   ② 相近色用 Lab ΔE76（RGB 欧氏距离不符合视觉感知；CIEDE2000 列增强）
 *   ③ 打色批次挂色号（可选 FK + colorCode 快照，色卡变更/删除后历史不失真）
 *
 * 数据口径：内置 Pantone TCX 子集为公开近似 sRGB 值——对色以实物色卡为准。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { PANTONE_TCX_SEED } from './colorCardSeedData';

// ────────────────────────────────────────────────────────────────────
// 色彩科学：sRGB → XYZ → Lab，ΔE76（DR-051-②）
// ────────────────────────────────────────────────────────────────────

/** sRGB 分量（0-255）→ 线性化 */
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** sRGB → CIE XYZ（D65） */
function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  return [
    lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375,
    lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750,
    lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041,
  ];
}

/** XYZ → CIE Lab（D65 白点） */
function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const xn = 0.95047, yn = 1.0, zn = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / xn), fy = f(y / yn), fz = f(z / zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ΔE76（Lab 欧氏距离） */
export function deltaE76(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = xyzToLab(...rgbToXyz(a.r, a.g, a.b));
  const lb = xyzToLab(...rgbToXyz(b.r, b.g, b.b));
  const dl = la[0] - lb[0], da = la[1] - lb[1], db = la[2] - lb[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

/** 相近历史打色的 ΔE 阈值（DR-051-②：ΔE ≤ 15 属"明显相近"，纺织人眼可辨但同族） */
export const NEARBY_DELTA_E = 15;
/** nearest 推荐返回数 */
export const NEAREST_LIMIT = 8;

export type ColorCardResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): ColorCardResult<never> => ({ ok: false, error: { code, message, status } });

function assertRgb(input: Record<string, unknown>): { r: number; g: number; b: number } {
  const out: Record<string, number> = {};
  for (const k of ['r', 'g', 'b'] as const) {
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw Object.assign(new Error(`${k} 必须是 0-255 整数（sRGB）`), { code: 'INVALID_RGB' });
    }
    out[k] = n;
  }
  return out as { r: number; g: number; b: number };
}

function generateId(): string {
  return `CLR__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createColorCardService(prisma: PrismaClient) {
  const db = prisma as any;

  // ── 列表/搜索（code/name 模糊，family 筛选） ──
  async function listColors(params: { search?: string; family?: string; limit?: number }): Promise<ColorCardResult<{ items: any[]; total: number }>> {
    const where: any = { deletedAt: null };
    if (params.family) where.family = params.family;
    if (params.search) {
      const q = params.search.trim();
      if (q) where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ];
    }
    const take = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const [items, total] = await Promise.all([
      db.colorCard.findMany({ where, orderBy: { code: 'asc' }, take }),
      db.colorCard.count({ where }),
    ]);
    return { ok: true, data: { items, total } };
  }

  // ── 详情 + nearest（Lab ΔE 升序，排除自身） ──
  async function getColorByCode(code: string): Promise<ColorCardResult<any>> {
    const card = await db.colorCard.findFirst({ where: { code, deletedAt: null } });
    if (!card) return fail('COLOR_NOT_FOUND', `色号 ${code} 不存在`, 404);
    const all = await db.colorCard.findMany({
      where: { deletedAt: null, id: { not: card.id } },
      select: { id: true, code: true, name: true, family: true, r: true, g: true, b: true },
    });
    const nearest = all
      .map((c: any) => ({ ...c, deltaE: Math.round(deltaE76(card, c) * 10) / 10 }))
      .sort((a: any, b: any) => a.deltaE - b.deltaE)
      .slice(0, NEAREST_LIMIT);
    return { ok: true, data: { color: card, nearest } };
  }

  // ── 新增自定义色卡 ──
  async function createColor(input: Record<string, unknown>): Promise<ColorCardResult<any>> {
    try {
      const code = String(input.code ?? '').trim();
      if (!code) return fail('CODE_REQUIRED', 'code 必填（如 19-4052 TCX 或客户色号）');
      const rgb = assertRgb(input);
      const dup = await db.colorCard.findFirst({ where: { code } });
      if (dup) {
        // 软删同码行复活（与迁移孪生复活同哲学：唯一键不被死行占用）
        if (dup.deletedAt != null) {
          const now = BigInt(Date.now());
          const revived = await db.colorCard.update({
            where: { id: dup.id },
            data: { name: input.name != null ? String(input.name).trim() || null : dup.name, family: input.family != null ? String(input.family).trim() || null : dup.family, ...rgb, source: 'custom', deletedAt: null, updatedAt: now },
          });
          return { ok: true, data: { color: revived, revived: true } };
        }
        return fail('CODE_DUPLICATED', `色号 ${code} 已存在`, 409);
      }
      const now = BigInt(Date.now());
      const color = await db.colorCard.create({
        data: {
          id: generateId(), code,
          name: input.name != null ? String(input.name).trim() || null : null,
          family: input.family != null ? String(input.family).trim() || null : null,
          ...rgb, source: 'custom', createdAt: now, updatedAt: now,
        },
      });
      logger.info('[ColorCard] created', { code });
      return { ok: true, data: { color } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[ColorCard] create failed', { error: e?.message });
      return fail('CREATE_FAILED', '色卡创建失败', 500);
    }
  }

  // ── 维护（code 不可改——被引用稳定性 DR-051-①） ──
  async function updateColor(id: string, input: Record<string, unknown>): Promise<ColorCardResult<any>> {
    try {
      const card = await db.colorCard.findFirst({ where: { id, deletedAt: null } });
      if (!card) return fail('COLOR_NOT_FOUND', `色卡 ${id} 不存在`, 404);
      const data: any = { updatedAt: BigInt(Date.now()) };
      if (input.code != null && String(input.code).trim() !== card.code) {
        return fail('CODE_IMMUTABLE', '色号 code 不可修改（历史打色靠 code 快照关联，改码破坏追溯）');
      }
      if (input.name != null) data.name = String(input.name).trim() || null;
      if (input.family != null) data.family = String(input.family).trim() || null;
      if (input.r != null || input.g != null || input.b != null) {
        const rgb = assertRgb({ r: input.r ?? card.r, g: input.g ?? card.g, b: input.b ?? card.b });
        Object.assign(data, rgb);
      }
      const color = await db.colorCard.update({ where: { id }, data });
      return { ok: true, data: { color } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message);
      logger.error('[ColorCard] update failed', { error: e?.message });
      return fail('UPDATE_FAILED', '色卡更新失败', 500);
    }
  }

  // ── 软删（历史打色靠 colorCode 快照不失真） ──
  async function deleteColor(id: string): Promise<ColorCardResult<{ id: string }>> {
    const card = await db.colorCard.findFirst({ where: { id, deletedAt: null } });
    if (!card) return fail('COLOR_NOT_FOUND', `色卡 ${id} 不存在`, 404);
    await db.colorCard.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
    logger.info('[ColorCard] soft-deleted', { code: card.code });
    return { ok: true, data: { id } };
  }

  // ── 该色号历史打色（includeNearby=true 并集 ΔE≤15 相近色，DR-051-②） ──
  async function listColorBatchesForColor(code: string, includeNearby: boolean): Promise<ColorCardResult<any>> {
    const card = await db.colorCard.findFirst({ where: { code, deletedAt: null } });
    if (!card) return fail('COLOR_NOT_FOUND', `色号 ${code} 不存在`, 404);

    let codes: string[] = [card.code];
    if (includeNearby) {
      const all = await db.colorCard.findMany({
        where: { deletedAt: null, id: { not: card.id } },
        select: { code: true, r: true, g: true, b: true },
      });
      codes = codes.concat(all.filter((c: any) => deltaE76(card, c) <= NEARBY_DELTA_E).map((c: any) => c.code));
    }

    const batches = await db.sampleColorBatch.findMany({
      where: { colorCode: { in: codes }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, batchCode: true, stage: true, colorCode: true, dyeLotNo: true, batchNo: true,
        colorRating: true, defectCauses: true, customerStatus: true, supplierName: true,
        developmentCaseId: true, orderId: true, createdAt: true,
      },
    });
    return {
      ok: true,
      data: {
        color: { code: card.code, name: card.name, family: card.family, r: card.r, g: card.g, b: card.b },
        matchedCodes: codes,
        batches,
      },
    };
  }

  // ── seed（幂等 upsert：只补缺，不覆盖已改数据） ──
  async function seedPantoneTcx(): Promise<{ inserted: number; skipped: number }> {
    const existing = new Set(
      (await db.colorCard.findMany({ where: { code: { in: PANTONE_TCX_SEED.map(c => c.code) } }, select: { code: true } }))
        .map((c: any) => c.code),
    );
    const now = BigInt(Date.now());
    let inserted = 0;
    for (const c of PANTONE_TCX_SEED) {
      if (existing.has(c.code)) continue;
      await db.colorCard.create({
        data: {
          id: `${generateId()}${inserted.toString(36)}`, code: c.code, name: c.name, family: c.family,
          r: c.r, g: c.g, b: c.b, source: 'seed', createdAt: now, updatedAt: now,
        },
      });
      inserted++;
    }
    logger.info('[ColorCard] seed done', { inserted, skipped: existing.size });
    return { inserted, skipped: existing.size };
  }

  return { listColors, getColorByCode, createColor, updateColor, deleteColor, listColorBatchesForColor, seedPantoneTcx };
}
