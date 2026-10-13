/**
 * sampleShipmentHistory.ts — ★ C5 「寄样历史」的唯一真源（**零依赖纯函数**，2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 C5「分批寄样」，实测订正了清单描述）──
 * 实测：本仓寄样有**三个入口**，其中只有一个支持分批寄样 ——
 *   ✅ `EarlyProductionSample`：`attachments.rounds[]` **追加** ⇒ 分批寄样**已可表达**
 *   ❌ `FabricShipmentSample`（面料出运取样）：覆盖行内字段 + 只留 `attachments.lastShipment`
 *   ❌ 成衣轮次（`DevelopmentCase` gate rounds）：覆盖 `target.shipment`
 * ⇒ 后两个入口「同一主体分两次寄样」**只留最后一次**，历史丢失（客户问"上次那 2 米什么时候寄的"查不到）。
 * 清单原文说「`SampleBatch` 仍是单值」—— 方向对但**主体说错了**（真身是这两个入口的覆盖式写入）。
 *
 * ── 修法：**统一到既有模式**（attachments 数组追加），**零 migration** ──
 * 本仓既有的、已被早产样验证过的模式就是「在 `attachments` 里维护一个**追加式数组**」。
 * 与其为寄样单独建一张表（多一处事实、多一条迁移），不如把另外两个入口**对齐到同一模式**：
 *   · `FabricShipmentSample.attachments.shipments[]`（追加；`lastShipment` 保留兼容）
 *   · 成衣轮次 `shipmentHistory[]`（追加；`shipment` 保留兼容）
 *
 * ⓘ **已知代价（写下来，别当没有）**：Json 数组**不可索引** ⇒
 *   「按快递单号反查」「跨主体寄样费用统计」这类需求需要扫表读 Json（样品量级小，可接受）。
 *   若将来真要寄样报表，再建 `SampleShipmentRecord` 表并把历史迁过去 —— 那时才有依据。
 *
 * ── 三条纪律（纯函数在这里，调用点只管用）──
 *   ① **追加**而不是覆盖（历史的定义）
 *   ② **保留最后一次**在既有字段里（既有消费方零改动 —— 与 C3 的 shipmentQuantity 快照同思路）
 *   ③ 数组**有界**：只保留最近 N 条（防 Json 无界增长；被截断时显式上报，不静默丢）
 */

/** 一次寄样记录（三个入口共用同一形状） */
export interface SampleShipmentEntry {
  sentDate: string;
  courier?: string | null;
  trackingNumber?: string | null;
  recipientName?: string | null;
  recipientContact?: string | null;
  shippingFee?: number | null;
  documents?: unknown[];
  note?: string | null;
  shippedBy?: string | null;
  shippedAt?: number | null;
}

/** 历史数组上限（超出后丢最旧；`truncated` 会显式上报） */
export const SHIPMENT_HISTORY_LIMIT = 50;

export interface AppendResult {
  /** 追加后的历史（最旧在前） */
  history: SampleShipmentEntry[];
  /** 本次是否发生了截断（**显式**，不静默丢） */
  truncated: boolean;
  /** 被丢弃的条数 */
  droppedCount: number;
}

/**
 * 追加一条寄样记录（**纯函数**，不修改入参）。
 *
 * 口径：最旧在前（与早产样 `attachments.rounds[]` 一致）；超过上限丢**最旧**的。
 */
export function appendShipmentHistory(
  existing: unknown,
  entry: SampleShipmentEntry,
  limit: number = SHIPMENT_HISTORY_LIMIT,
): AppendResult {
  const arr: SampleShipmentEntry[] = Array.isArray(existing) ? (existing as SampleShipmentEntry[]) : [];
  const next = [...arr, entry];
  const max = Math.max(1, limit);
  if (next.length <= max) return { history: next, truncated: false, droppedCount: 0 };
  const droppedCount = next.length - max;
  return { history: next.slice(droppedCount), truncated: true, droppedCount };
}

/** 历史条数（非数组视为 0） */
export function shipmentCountOf(existing: unknown): number {
  return Array.isArray(existing) ? existing.length : 0;
}

/**
 * 取**最后一次**寄样（用于回写既有单值字段 / 展示"最新一次"）。
 * 排序：`sentDate` 降序 → `shippedAt` 降序（同一天多次寄样时后者区分先后）。
 * 空历史 → null（**不猜**）。
 */
export function latestShipmentOf(existing: unknown): SampleShipmentEntry | null {
  const arr: SampleShipmentEntry[] = Array.isArray(existing) ? (existing as SampleShipmentEntry[]) : [];
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => {
    const d = String(b?.sentDate ?? '').localeCompare(String(a?.sentDate ?? ''));
    if (d !== 0) return d;
    return Number(b?.shippedAt ?? 0) - Number(a?.shippedAt ?? 0);
  });
  return sorted[0] ?? null;
}

/** 寄样费用合计（用于"这个样品寄样花了多少"；非数值不计入） */
export function totalShippingFeeOf(existing: unknown): number {
  const arr: SampleShipmentEntry[] = Array.isArray(existing) ? (existing as SampleShipmentEntry[]) : [];
  let sum = 0;
  for (const e of arr) {
    const v = Number(e?.shippingFee);
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return Math.round(sum * 100) / 100;
}

/** 是否属于"分批寄样"（≥2 次）—— 界面据此提示「已寄 N 次」 */
export function isMultiShipment(existing: unknown): boolean {
  return shipmentCountOf(existing) >= 2;
}
