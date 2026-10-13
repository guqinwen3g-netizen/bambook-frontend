/**
 * dyeLotStockService.ts — ★ D1 库存层「缸号（dye lot）配料」核对（只读，2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 D1「缺库存层 lot」，真库实测驱动）──
 * 面料行业实务：**同缸号才能同批裁**（避免缸差），裁床要按缸号配料。
 * 而现状（真库实测）：
 *   · `InventoryItem.batchNumber` 是**自由文本批次号**，没有缸号语义、没有色差等级
 *   · 缸号/色差评级只存在于 `SampleColorBatch`（打色/大货缸差登记），**挂在开发案/订单上**，
 *     与库存**零交集**（实测：库存 12 条 batchNumber vs 1 条已登记 dyeLotNo，交集 0）
 * ⇒ 业务员无法回答「这批货是哪个缸的、色差几级、能不能用来做这一单」。
 *
 * ── 修法选择（**零 migration**，理由写在下面）──
 * 不改 schema，改做**只读对撞**：把库存的 `batchNumber` 与已登记的 `SampleColorBatch.dyeLotNo`
 * 对撞，能对上的就带出该缸的色差评级；对不上的显式标「未登记缸号」（数据缺口可见）。
 * 为什么不加 `InventoryItem.dyeLotNo` 字段（那更"正"）：
 *   ① 与 `batchNumber` 语义重叠，两个字段都能填缸号 = 必然漂移（本仓反复踩过）
 *   ② 生产已累计 28 条待迁移，非必要不再叠加
 *   ③ 真库目前**没有真实业务数据**（全是演示数据）⇒ 现在拍字段语义没有依据
 * ⇒ 先在**只读层**把「按缸号看库存」这件事做出来；等业务确认要显式字段，再走迁移。
 *
 * ── 风险分级（把色差评级翻译成业务动作）──
 *   low（可正常用）：colorRating ≥ 4 且左右/前后色差 ≥ 4
 *   medium（需复核）：colorRating = 3
 *   high（慎用）：colorRating ≤ 2
 *   unknown：该批次号**未登记缸号**（无法判断，不是"没问题"）
 * ⚠️ 未登记一律 `unknown` 而**不是** `low` —— 「不知道」不能显示成「没问题」（本仓空值红线纪律）。
 */
import type { Prisma, PrismaClient } from '@prisma/client';

// ────────────────────────────────────────────────────────────────
// 真源（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

/** 库存行（参与缸号归集的最小形态） */
export interface DyeLotStockItemRef {
  itemId: string;
  batchNumber?: string | null;
  quantity: number | string | null | undefined;
  unit?: string | null;
  category?: string | null;
  warehouseId?: string | null;
  description?: string | null;
}

/** 已登记的缸号（来自 SampleColorBatch） */
export interface DyeLotRef {
  dyeLotNo?: string | null;
  colorRating?: number | null;
  sideDiff?: number | null;
  endDiff?: number | null;
  defectCauses?: string[] | null;
  stage?: string | null;
  orderId?: string | null;
}

export type DyeLotRisk = 'low' | 'medium' | 'high' | 'unknown';

export interface DyeLotStockGroup {
  /** 缸号（= 库存 batchNumber，trim 归一） */
  lot: string;
  itemCount: number;
  /** 按单位分组的数量（**跨单位不可加** —— 与货权汇总同纪律） */
  quantityByUnit: Array<{ unit: string; quantity: number }>;
  /** 该缸号是否在 SampleColorBatch 里登记过 */
  registered: boolean;
  colorRating: number | null;
  sideDiff: number | null;
  endDiff: number | null;
  defectCauses: string[];
  risk: DyeLotRisk;
  /** 面向人的一句话（可直接展示） */
  note: string;
}

export interface DyeLotStockResult {
  lots: DyeLotStockGroup[];
  /** 未登记缸号的批次号（数据缺口，业务需补登记） */
  unregisteredLots: string[];
  /** 没有任何批次号的库存行数（无法按缸号归集） */
  noBatchCount: number;
  summary: {
    lotCount: number;
    registeredCount: number;
    unregisteredCount: number;
    highRiskCount: number;
  };
}

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** 色差评级 → 风险等级（判据见文件头） */
export function dyeLotRiskOf(ref: DyeLotRef | null | undefined): DyeLotRisk {
  if (!ref) return 'unknown';
  const rating = num(ref.colorRating);
  if (rating == null) return 'unknown';
  if (rating <= 2) return 'high';
  if (rating === 3) return 'medium';
  // ≥4：再看左右/前后色差（未评视为不扣分 —— 未评 ≠ 差，避免误报）
  const side = num(ref.sideDiff);
  const end = num(ref.endDiff);
  if ((side != null && side <= 3) || (end != null && end <= 3)) return 'medium';
  return 'low';
}

const RISK_LABEL: Record<DyeLotRisk, string> = {
  low: '可正常使用',
  medium: '需复核',
  high: '慎用（色差明显）',
  unknown: '未登记缸号，无法判断',
};

/** 面向人的一句话 */
export function describeDyeLot(group: { lot: string; registered: boolean; colorRating: number | null; sideDiff: number | null; endDiff: number | null; risk: DyeLotRisk }): string {
  if (!group.registered) return `缸号 ${group.lot}：未在缸差登记里找到（无法判断色差，请补登记）`;
  const parts: string[] = [`主评级 ${group.colorRating ?? '—'}`];
  if (group.sideDiff != null) parts.push(`左右 ${group.sideDiff}`);
  if (group.endDiff != null) parts.push(`前后 ${group.endDiff}`);
  return `缸号 ${group.lot}：${parts.join(' / ')} ⇒ ${RISK_LABEL[group.risk]}`;
}

/**
 * 纯函数：按缸号（= 库存 `batchNumber`）归集库存，并对撞已登记缸号带出色差评级。
 *
 * 口径：
 *   · 批次号 trim 归一后分组；**空批次号不计入任何缸**（单独计数）
 *   · 数量**按单位分组**（跨单位相加是错的）
 *   · 同一缸号在 `SampleColorBatch` 有多条时取**最新一条**（调用方按 createdAt 排序后传入）
 */
export function summarizeDyeLotStock(input: {
  items: DyeLotStockItemRef[];
  dyeLots: DyeLotRef[];
}): DyeLotStockResult {
  const { items = [], dyeLots = [] } = input;

  const lotByCode = new Map<string, DyeLotRef>();
  for (const d of dyeLots) {
    const code = (d.dyeLotNo ?? '').trim();
    if (!code) continue;
    if (!lotByCode.has(code)) lotByCode.set(code, d); // 调用方已按时间倒序 ⇒ 首条最新
  }

  const groups = new Map<string, DyeLotStockItemRef[]>();
  let noBatchCount = 0;
  for (const it of items) {
    const code = (it.batchNumber ?? '').trim();
    if (!code) { noBatchCount += 1; continue; }
    const arr = groups.get(code) ?? [];
    arr.push(it);
    groups.set(code, arr);
  }

  const lots: DyeLotStockGroup[] = [...groups.entries()].map(([lot, rows]) => {
    const byUnit = new Map<string, number>();
    for (const r of rows) {
      const q = num(r.quantity);
      if (q == null) continue;
      const u = (r.unit ?? '').trim() || '—';
      byUnit.set(u, round4((byUnit.get(u) ?? 0) + q));
    }
    const ref = lotByCode.get(lot) ?? null;
    const risk = dyeLotRiskOf(ref);
    const group: DyeLotStockGroup = {
      lot,
      itemCount: rows.length,
      quantityByUnit: [...byUnit.entries()].map(([unit, quantity]) => ({ unit, quantity })),
      registered: ref != null,
      colorRating: num(ref?.colorRating ?? null),
      sideDiff: num(ref?.sideDiff ?? null),
      endDiff: num(ref?.endDiff ?? null),
      defectCauses: (ref?.defectCauses ?? []) as string[],
      risk,
      note: '',
    };
    group.note = describeDyeLot(group);
    return group;
  });

  // 高风险/未登记的排前面（业务员最需要先看）
  const order: Record<DyeLotRisk, number> = { high: 0, unknown: 1, medium: 2, low: 3 };
  lots.sort((a, b) => order[a.risk] - order[b.risk] || a.lot.localeCompare(b.lot));

  const unregisteredLots = lots.filter(l => !l.registered).map(l => l.lot);

  return {
    lots,
    unregisteredLots,
    noBatchCount,
    summary: {
      lotCount: lots.length,
      registeredCount: lots.filter(l => l.registered).length,
      unregisteredCount: unregisteredLots.length,
      highRiskCount: lots.filter(l => l.risk === 'high').length,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 只读查询（真库）
// ────────────────────────────────────────────────────────────────

/**
 * 库存缸号配料核对（只读）。
 *
 * @param params.category 只统计某类库存（如 Fabric）
 * @param params.warehouseId 只统计某仓
 */
export async function getDyeLotStock(
  prisma: PrismaClient,
  params: { category?: string; warehouseId?: string; readScopeWhere?: Prisma.InventoryItemWhereInput; colorBatchScopeWhere?: Prisma.SampleColorBatchWhereInput } = {},
): Promise<DyeLotStockResult> {
  const db: any = prisma as any;

  const where: Record<string, unknown> = { deletedAt: null };
  if (params.readScopeWhere) where.AND = [params.readScopeWhere];
  if (params.category) where.category = params.category;
  if (params.warehouseId) where.warehouseId = params.warehouseId;

  const [items, dyeLots] = await Promise.all([
    db.inventoryItem.findMany({
      where,
      select: { id: true, batchNumber: true, quantity: true, unit: true, category: true, warehouseId: true, description: true },
    }),
    // 按登记时间**倒序**（summarizeDyeLotStock 取首条为最新）
    db.sampleColorBatch.findMany({
      where: { deletedAt: null, ...(params.colorBatchScopeWhere ? { AND: [params.colorBatchScopeWhere] } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { dyeLotNo: true, colorRating: true, sideDiff: true, endDiff: true, defectCauses: true, stage: true, orderId: true },
    }),
  ]);

  return summarizeDyeLotStock({
    items: (items as any[]).map(i => ({
      itemId: i.id, batchNumber: i.batchNumber, quantity: i.quantity, unit: i.unit,
      category: i.category, warehouseId: i.warehouseId, description: i.description,
    })),
    dyeLots: dyeLots as any[],
  });
}
