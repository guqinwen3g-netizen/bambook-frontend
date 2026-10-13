/**
 * inventoryOwnershipService.ts — D7-② 货权标记 + 按货权汇总的存货口径
 *
 * 拍板（矩阵 §D7 拍板 2）：第三方仓/货代仓要区分货权，**资产/存货报表必须按货权而非按物理位置汇总**
 * ——「货权已转移的货不得计入我方存货」。与 D2-Q4「CIF 垫付运费改开应收」同属一处原则：
 * **账按权利义务记，不按物理位置记。**
 *
 * 设计决策（2026-09-16 核准时定，理由见 docs/D7-仓库货权与样品转化-现状核准-2026-09-16.md）：
 *   **货权字段放在 `InventoryItem`（「这批货」），而不是 `Warehouse`（「这个仓」）**——
 *   同一个第三方仓里可能同时存在我方货权（Owned）与货权已转移（Transferred）的货，
 *   挂在仓上表达不了这种混合。
 *
 * ⚠️ 汇总纪律（沿用 T7-① 的多币种教训，同一类错误不重复犯）：
 *   - **数量跨单位不可加**（M / YD / KG / PC 相加没有意义）→ 按 `unit` 分组
 *   - **金额跨币种不可加** → 按 `currency` 分组
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';

/**
 * ★ C6（2026-09-18）货权枚举从 2 档扩到 4 档。
 *
 * 为什么需要：原来只有 `Owned`（我方货权）/ `Transferred`（已转移），
 * 而面料外贸有两类**货权仍属我方、但不在自己仓里**的货，此前无处可标：
 *   · **寄售**：货已放到客户/海外仓，卖出才结算 —— 货权仍属我方
 *   · **在途**：已发运未到货（CIF/DDP 未交付、或已发运未交单）—— 货权仍属我方
 * 标不出来的后果：这两类货被硬塞进 `Owned`（"我方存货"虚高、且看不出"能不能马上用"），
 * 或者被塞进 `Transferred`（**我方存货静默少算**）—— 两种都是错账。
 *
 * ⓘ **零 migration**：`InventoryItem.ownership` 是普通 `String @default("Owned")`，
 *   没有 DB 层枚举约束 ⇒ 加取值不需要迁移。
 */
export const INVENTORY_OWNERSHIP = ['Owned', 'Transferred', 'Consignment', 'InTransit'] as const;
export type InventoryOwnership = (typeof INVENTORY_OWNERSHIP)[number];

export const OWNERSHIP_LABELS: Record<string, string> = {
  Owned: '我方货权',
  Transferred: '货权已转移',
  Consignment: '寄售（货权仍属我方）',
  InTransit: '在途（货权仍属我方）',
};

/**
 * ★ 判据真源：**哪些货权档计入「我方存货」**。
 *
 * 口径（依据 D7-② 拍板「账按权利义务记，不按物理位置记」）：
 *   · `Owned`        → 计入（在我方仓、货权属我方）
 *   · `Consignment`  → **计入**（在客户/海外仓，但货权仍属我方）
 *   · `InTransit`    → **计入**（在途，货权仍属我方 —— 若已按 FOB 交单转移，应标 `Transferred`）
 *   · `Transferred`  → **不计入**（货权已转移）
 * ⚠️ 单点真源：汇总、UI 文案、徽标语义**都读这里**，不许各处各写一份判断。
 */
export const OWNERSHIP_COUNTS_AS_OUR_STOCK: Record<string, boolean> = {
  Owned: true,
  Consignment: true,
  InTransit: true,
  Transferred: false,
};

/** 是否计入我方存货（未知档位按**不计入**处理 —— 不把不知道的东西算进存货） */
export function countsAsOurStock(ownership?: string | null): boolean {
  const v = String(ownership ?? 'Owned').trim() || 'Owned';
  return OWNERSHIP_COUNTS_AS_OUR_STOCK[v] === true;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

const d2n = (d: Prisma.Decimal) => Number(new Prisma.Decimal(d).toFixed(4));
const dec = (v: unknown) => {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  try { return new Prisma.Decimal(v as any); } catch { return new Prisma.Decimal(0); }
};

export interface OwnershipGroup {
  ownership: string;
  ownershipLabel: string;
  itemCount: number;
  /** 按单位分组的数量（**跨单位不可加**） */
  quantityByUnit: Array<{ unit: string; quantity: number }>;
  /** 按币种分组的金额 = Σ(quantity × unitCost)（**跨币种不可加**；无 unitCost 的项不计入金额） */
  valueByCurrency: Array<{ currency: string; value: number }>;
}

export interface OwnershipSummary {
  /** 分货权档明细（**所有档**，含不计入存货的 Transferred） */
  byOwnership: OwnershipGroup[];
  /**
   * 我方存货合计 = **计入我方存货的各档合并**（`OWNERSHIP_COUNTS_AS_OUR_STOCK`）。
   * 数量按单位分组、金额按币种分组（跨单位/跨币种不相加）。
   */
  ourStock: OwnershipGroup | null;
  /** 我方存货的分档明细（可用 Owned / 在途 InTransit / 寄售 Consignment）—— 便于分开看 */
  ourStockBreakdown: OwnershipGroup[];
  /**
   * @deprecated 历史字段名，**语义已升级**：现在等同 `ourStock`（含在途 + 寄售），
   * 不再是「只含 Owned」。保留是为了不破坏既有消费方；**新代码请用 `ourStock`**。
   * （C6 之前只含 Owned ⇒ 在途/寄售的我方货会被静默少算。）
   */
  ownedOnly: OwnershipGroup | null;
  warehouseId: string | null;
}

export function createInventoryOwnershipService(prisma: PrismaClient) {

  /** 设置/变更某库存项的货权（转第三方仓、货权转移、收回等） */
  async function setOwnership(params: {
    itemId: string;
    ownership: string;
    note?: string | null;
    actorId?: string | null;
    ip?: string | null;
  }): Promise<Result<any>> {
    const ownership = String(params.ownership ?? '').trim();
    if (!(INVENTORY_OWNERSHIP as readonly string[]).includes(ownership)) {
      return fail('INVALID_INPUT', `货权必须是 ${INVENTORY_OWNERSHIP.join(' / ')}，收到 ${String(params.ownership)}`);
    }
    try {
      const item = await (prisma as any).inventoryItem.findFirst({
        where: { id: params.itemId, deletedAt: null },
        select: { id: true, description: true, ownership: true, warehouseId: true },
      });
      if (!item) return fail('NOT_FOUND', `库存项 ${params.itemId} 不存在`, 404);
      if (String(item.ownership ?? 'Owned') === ownership) {
        return ok({ item, changed: false, message: `货权已是 ${ownership}，无需变更` });
      }

      const updated = await (prisma as any).inventoryItem.update({
        where: { id: params.itemId },
        data: { ownership, updatedAt: BigInt(Date.now()) },
      });

      await writeRouteAuditLog({
        prisma, actorId: params.actorId || 'api', source: 'route:inventory:ownership',
        operation: 'set_inventory_ownership', targetType: 'InventoryItem', targetId: params.itemId,
        before: { ownership: item.ownership ?? 'Owned' },
        after: { ownership, note: params.note ?? null },
        ip: params.ip ?? null,
      });

      return ok({ item: updated, changed: true });
    } catch (e: any) {
      logger.error('[InventoryOwnership] setOwnership failed', { error: e?.message, itemId: params.itemId });
      return fail('SET_OWNERSHIP_FAILED', String(e?.message ?? e), 500);
    }
  }

  /**
   * 按货权汇总存货（报表口径）。
   * 只统计未软删库存项；数量按单位分组、金额按币种分组（跨单位/跨币种不相加）。
   */
  async function summarizeByOwnership(params: { warehouseId?: string | null; readScopeWhere?: Prisma.InventoryItemWhereInput } = {}): Promise<Result<OwnershipSummary>> {
    try {
      const where: any = { deletedAt: null };
      if (params.readScopeWhere) where.AND = [params.readScopeWhere];
      if (params.warehouseId) where.warehouseId = params.warehouseId;
      const rows: any[] = await (prisma as any).inventoryItem.findMany({
        where,
        select: { id: true, ownership: true, quantity: true, unit: true, unitCost: true, currency: true },
      });

      // Stock has left the source warehouse but remains our asset until destination receipt.
      // Count only outstanding quantities; each actual receipt already belongs to inventoryItem.
      const transit = await prisma.inventoryTransfer.findMany({where:{status:'in_transit',sourceItem:{AND:[where]}},include:{sourceItem:{select:{ownership:true,unitCost:true,currency:true}}}});
      for(const task of transit){const remaining=new Prisma.Decimal(task.quantity).minus(task.receivedQuantity);if(remaining.lte(0))continue;rows.push({id:task.id,quantity:remaining,unit:task.unit,unitCost:task.sourceItem.unitCost,currency:task.sourceItem.currency,ownership:task.sourceItem.ownership==='Transferred'?'Transferred':'InTransit'});}

      interface Bucket {
        itemCount: number;
        qtyByUnit: Map<string, Prisma.Decimal>;
        valByCurrency: Map<string, Prisma.Decimal>;
      }
      const buckets = new Map<string, Bucket>();
      const bucketOf = (ownership: string): Bucket => {
        let b = buckets.get(ownership);
        if (!b) {
          b = { itemCount: 0, qtyByUnit: new Map(), valByCurrency: new Map() };
          buckets.set(ownership, b);
        }
        return b;
      };

      for (const r of rows) {
        const ownership = String(r.ownership ?? 'Owned').trim() || 'Owned';
        const b = bucketOf(ownership);
        b.itemCount += 1;
        const unit = String(r.unit ?? '').trim() || '(未标单位)';
        b.qtyByUnit.set(unit, (b.qtyByUnit.get(unit) ?? new Prisma.Decimal(0)).plus(dec(r.quantity)));
        if (r.unitCost != null) {
          const cur = String(r.currency ?? '').trim() || 'CNY';
          const val = dec(r.quantity).mul(dec(r.unitCost));
          b.valByCurrency.set(cur, (b.valByCurrency.get(cur) ?? new Prisma.Decimal(0)).plus(val));
        }
      }

      const toGroup = (ownership: string, b: Bucket): OwnershipGroup => ({
        ownership,
        ownershipLabel: ownership === 'OurStock' ? '我方存货（可用 + 在途 + 寄售）' : (OWNERSHIP_LABELS[ownership] ?? ownership),
        itemCount: b.itemCount,
        quantityByUnit: [...b.qtyByUnit.entries()]
          .sort(([a], [c]) => a.localeCompare(c))
          .map(([unit, d]) => ({ unit, quantity: d2n(d) })),
        valueByCurrency: [...b.valByCurrency.entries()]
          .sort(([a], [c]) => a.localeCompare(c))
          .map(([currency, d]) => ({ currency, value: d2n(d) })),
      });

      const byOwnership = [...buckets.entries()]
        .sort(([a], [b2]) => a.localeCompare(b2))
        .map(([ownership, b]) => toGroup(ownership, b));

      // ★ C6：我方存货 = **计入我方存货的各档合并**（可用 + 在途 + 寄售），
      //   判据读真源 `countsAsOurStock`（不许在这里另写一份 if）。
      const ourStockBuckets = [...buckets.entries()].filter(([ownership]) => countsAsOurStock(ownership));
      const merged: Bucket = { itemCount: 0, qtyByUnit: new Map(), valByCurrency: new Map() };
      for (const [, b] of ourStockBuckets) {
        merged.itemCount += b.itemCount;
        for (const [unit, d] of b.qtyByUnit) merged.qtyByUnit.set(unit, (merged.qtyByUnit.get(unit) ?? new Prisma.Decimal(0)).plus(d));
        for (const [cur, d] of b.valByCurrency) merged.valByCurrency.set(cur, (merged.valByCurrency.get(cur) ?? new Prisma.Decimal(0)).plus(d));
      }
      const ourStock = ourStockBuckets.length > 0 ? toGroup('OurStock', merged) : null;
      const ourStockBreakdown = ourStockBuckets
        .sort(([a], [b2]) => a.localeCompare(b2))
        .map(([ownership, b]) => toGroup(ownership, b));

      return ok({
        byOwnership,
        ourStock,
        ourStockBreakdown,
        // @deprecated 别名：语义已升级为 ourStock（含在途 + 寄售），保留以免破坏既有消费方
        ownedOnly: ourStock,
        warehouseId: params.warehouseId ?? null,
      });
    } catch (e: any) {
      logger.error('[InventoryOwnership] summarize failed', { error: e?.message });
      return fail('SUMMARIZE_FAILED', String(e?.message ?? e), 500);
    }
  }

  return { setOwnership, summarizeByOwnership };
}
