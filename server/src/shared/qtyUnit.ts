/**
 * qtyUnit.ts — 数量单位归一（把数量折到基准单位）的**唯一真源**（**零依赖纯函数**）
 *
 * ── 为什么抽出来（2026-09-18 · C3 批次）──
 * 原本这段逻辑是 `shipping/allocationService` 的私有函数。做 C3（溢短装条款接入出运事实）时，
 * 「订单行的已出运量」也要按同一口径把分配量折到**行单位**再相加 —— 若各写一份，
 * 就会出现「上限校验说超了、容差面板说没超」这类**同数不同判**的分裂。
 * 所以收口到本文件，双方都引它。
 *
 * ── 口径（禁止自造换算系数，一律走 lib/unitConversion）──
 *   · 双方都是可识别长度单位（m/yd）→ `convertLength` 精确换算
 *   · 任一方未填 unit → 视为同单位原值累加（历史数据按行单位理解，不换算）
 *   · 双方都填了 unit 且原始口径一致（如 pcs/PCS）→ 原值累加
 *   · 其余（PCS vs M、PCS vs SET 等混用）→ **null：报错优于算错**
 */
import { convertLength, normalizeLengthUnit } from '../lib/unitConversion';

export function normalizeQtyToBase(
  qty: number,
  fromUnit: string | null | undefined,
  baseUnit: string | null | undefined,
): number | null {
  const from = fromUnit == null ? null : normalizeLengthUnit(fromUnit);
  const base = baseUnit == null ? null : normalizeLengthUnit(baseUnit);
  if (from && base) return convertLength(qty, from, base);
  if (fromUnit == null || baseUnit == null) return qty;
  return String(fromUnit).trim().toLowerCase() === String(baseUnit).trim().toLowerCase() ? qty : null;
}
