/**
 * orderLineShippedQty.ts — 「订单行已出运量」的唯一真源 + 快照同步（2026-09-18 · C3）
 *
 * ── 为什么必须有这一处（零基础障碍清单 C3，实测比清单描述更严重）──
 * 清单写的是「出运侧只算上限，可以无限少出」。实测发现**根因更狠**：
 *   `OrderLine.shipmentQuantity`（订单详情「溢短装条款」面板的唯一数据源）
 *   **只被 `internalTrade/internalTransferService` 写过** —— **出运模块从不写它**。
 *   ⇒ 面板永远显示「未发货」，`checkTolerance` 的短装/溢装判定**从不触发**，
 *     等于给业务员看一块**永远绿的假面板**（比没有更糟：它会让人以为条款已经校验过了）。
 *
 * ── 两个口径（必须与既有实现一致，否则出现「同数不同判」）──
 *   ① **算哪些票**：与 `shipping/allocationService.assertOrderLineNotOverAllocated` 同口径
 *      —— 排除 `Cancelled` 的运单（`Draft/Booked/Loading` 的分配**算数**）。
 *      为什么不按「已离厂」算：上限校验就是按这个集合算的，若这里改成「只算离厂」，
 *      会出现「上限校验说没超、容差面板说短装」的分裂 —— **同源比"更精确"重要**。
 *   ② **怎么分摊**：行级分配直接归该行；整单分配（`orderLineId = null`）按**行量比例**分摊
 *      （与 allocationService 的 `lineShares` 同一函数，已收口）。
 *
 * ── 一条刻意的保守（防误伤）──
 *   历史上业务员可能手工在 `shipmentQuantity` 登记过发货台账（`orderLineWritable` 至今允许写它）。
 *   本函数的**调用点全部是「出运事实刚发生变化」**（分配增/删/改 · 票取消/删除）⇒ 以出运事实
 *   覆盖（含覆盖为 0）才是对的；而**从未走过出运模块**的订单不会被调用，手工台账值不受影响。
 *   ⇒ **语义边界放在调用点，函数内不设隐性条件**。
 *   （初版把「无分配 ⇒ 不动」写在函数里，直接导致「删掉最后一条分配后快照停在旧值」——
 *    被真库演练 ⑤ 抓出来：`expected 10000 to be 0`。）
 */
import { round4 } from '../lib/unitConversion';
import { normalizeQtyToBase } from './qtyUnit';
import { isShipmentCancelled } from './shippingLock';

export interface ShippedAllocationRef {
  orderLineId: string | null;
  shipmentId: string;
  actualQty: unknown;
  unit?: string | null;
}

export interface OrderLineRef {
  id: string;
  quantity: unknown;
  unit?: string | null;
}

/**
 * 行量比例分摊（★ 与 shipping/allocationService 同源：该处已改为 import 本函数）。
 * 全部行量非法/为 0 时退化为均分（保底，避免除零）。
 */
export function lineShares(lines: Array<{ id: string; quantity: unknown }>): Map<string, number> {
  const total = lines.reduce((s, l) => {
    const q = Number(l.quantity);
    return s + (Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);
  const map = new Map<string, number>();
  for (const l of lines) {
    const q = Number(l.quantity);
    map.set(l.id, total > 0 ? (Number.isFinite(q) && q > 0 ? q / total : 0) : 1 / Math.max(1, lines.length));
  }
  return map;
}

export interface ShippedQtyAttribution {
  /** 行 id → 已出运量（已归一到该行单位，round4） */
  byLine: Map<string, number>;
  /** 单位与行单位不可互算 → **不计入**（不猜），调用方应提示数据问题 */
  incomparable: Array<{ shipmentId: string; orderLineId: string | null; unit: string | null }>;
  /** 订单没有可用行量、整单分配无处可归 */
  unallocatable: string[];
}

/**
 * 纯函数：把「出运分配」归属到订单行。
 *
 * 行级分配 → 全额归该行；整单分配 → 按行量比例分摊到各行。
 * 单位不可互算（如行 PCS vs 分配 M）→ 记入 `incomparable` 并**跳过**（报错优于算错，
 * 但这里在只读投影里不能抛错，故显式上报让调用方/守卫能发现）。
 */
export function attributeShippedQtyToLines(input: {
  allocations: ShippedAllocationRef[];
  lines: OrderLineRef[];
}): ShippedQtyAttribution {
  const { allocations = [], lines = [] } = input;
  const byLine = new Map<string, number>();
  const incomparable: ShippedQtyAttribution['incomparable'] = [];
  const unallocatable: string[] = [];
  for (const l of lines) byLine.set(l.id, 0);
  if (lines.length === 0) {
    return { byLine, incomparable, unallocatable: allocations.map(a => a.shipmentId) };
  }

  const lineById = new Map(lines.map(l => [l.id, l]));
  const shares = lineShares(lines);

  const add = (lineId: string, qty: number) => byLine.set(lineId, round4((byLine.get(lineId) ?? 0) + qty));

  for (const a of allocations) {
    const qty = Number(a.actualQty ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    // ① 行级分配：orderLineId 指向本单的某行
    const target = a.orderLineId ? lineById.get(a.orderLineId) : undefined;
    if (target) {
      const normalized = normalizeQtyToBase(qty, a.unit, target.unit);
      if (normalized === null) {
        incomparable.push({ shipmentId: a.shipmentId, orderLineId: a.orderLineId, unit: a.unit ?? null });
        continue;
      }
      add(target.id, normalized);
      continue;
    }

    // ② 整单分配（orderLineId=null，或指向别的订单的行——脏数据，同样按整单处理）
    let attributed = false;
    for (const l of lines) {
      const share = shares.get(l.id) ?? 0;
      if (share <= 0) continue;
      const normalized = normalizeQtyToBase(round4(qty * share), a.unit, l.unit);
      if (normalized === null) {
        incomparable.push({ shipmentId: a.shipmentId, orderLineId: null, unit: a.unit ?? null });
        attributed = true; // 已上报，别重复计入 unallocatable
        break;
      }
      add(l.id, normalized);
      attributed = true;
    }
    if (!attributed) unallocatable.push(a.shipmentId);
  }

  return { byLine, incomparable, unallocatable };
}

export interface SyncShippedQtyResult {
  /** 是否执行了覆盖（false = 该订单没有任何出运分配，保留既有值） */
  applied: boolean;
  /** 实际被改写的行数（幂等：值没变不写） */
  updatedLines: number;
  incomparable: ShippedQtyAttribution['incomparable'];
}

/**
 * 事务内：把订单行的 `shipmentQuantity` 快照刷新为「Σ 出运分配」（真源）。
 *
 * 幂等：值未变化的行**不写**（避免无谓写 + AuditLog/事件噪声）。
 * 必须在调用方事务内执行（与分配增删改同事务，防「分配改了、快照没跟上」）。
 */
export async function syncOrderLineShipmentQuantity(
  tx: any,
  orderId: string,
): Promise<SyncShippedQtyResult> {
  const empty: SyncShippedQtyResult = { applied: false, updatedLines: 0, incomparable: [] };
  if (!orderId) return empty;

  const lines: Array<{ id: string; quantity: unknown; unit: string | null; shipmentQuantity: unknown }> =
    await tx.orderLine.findMany({
      where: { orderId },
      select: { id: true, quantity: true, unit: true, shipmentQuantity: true },
    });
  if (lines.length === 0) return empty;

  const allocations: Array<{ orderLineId: string | null; shipmentId: string; actualQty: unknown; unit: string | null }> =
    await tx.shipmentOrderAllocation.findMany({
      where: { orderId },
      select: { orderLineId: true, shipmentId: true, actualQty: true, unit: true },
    });
  // ⓘ **一条分配都没有时照样覆盖为 0** —— 这是 2026-09-18 真库演练纠正过的一处：
  //   初版写「无分配 ⇒ 不动（保留手工台账）」，结果「删掉最后一条分配」后快照停在旧值
  //   （演练 ⑤ 直接红：expected 10000 to be 0）。正确判据不是「有没有分配」，
  //   而是「**谁在调用我**」——调用点全是「出运事实刚刚发生变化」（分配增/删/改、票取消/删除），
  //   此时覆盖（含 0）才是对的；而「从未走过出运模块」的订单**根本不会被调用**，
  //   它的手工台账值自然不受影响。⇒ 语义边界放在调用点，函数内不设隐性条件。

  // 排除已取消运单（与 allocationService 上限校验同口径）
  const shipmentIds = [...new Set(allocations.map(a => a.shipmentId))];
  const shipments: Array<{ id: string; status: string }> = await tx.shipment.findMany({
    where: { id: { in: shipmentIds }, deletedAt: null },
    select: { id: true, status: true },
  });
  const counted = new Set(shipments.filter(s => !isShipmentCancelled(s.status)).map(s => s.id));

  const attribution = attributeShippedQtyToLines({
    allocations: allocations.filter(a => counted.has(a.shipmentId)),
    lines,
  });

  let updatedLines = 0;
  for (const l of lines) {
    const next = attribution.byLine.get(l.id) ?? 0;
    const prev = l.shipmentQuantity == null ? 0 : Number(l.shipmentQuantity);
    if (Number.isFinite(prev) && Math.abs(prev - next) < 1e-9) continue;
    await tx.orderLine.update({ where: { id: l.id }, data: { shipmentQuantity: next } });
    updatedLines += 1;
  }

  return { applied: true, updatedLines, incomparable: attribution.incomparable };
}
