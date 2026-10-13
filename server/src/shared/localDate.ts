/**
 * localDate — 「业务日」（YYYY-MM-DD）在**服务端**的唯一真源。
 * 日期投影显式使用 Asia/Shanghai；今天由业务时钟提供，历史值不替换。
 *
 * ── 为什么需要它 ───────────────────────────────────────────
 * `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日**。
 * 服务端与业务都在 **Asia/Shanghai（UTC+8）** ⇒ 本地时间 **00:00–08:00** 之间，
 * UTC 日比中国日**早一天** → 日期键差一天：
 *   · 开票日 / 核销日 / 成本发生日 记成「昨天」
 *   · 逾期计算的 `today` / `asOf` 少算一天
 *   · 按日去重的 `dedupKey` 在凌晨与早上**翻转** → 同一件事**重复通知**
 *   · 批号 / 文件名前缀日期错一天
 *
 * ── 判据 ─────────────────────────────────────────────────
 *   · 日期投影使用显式 Asia/Shanghai，不依赖操作系统当前时区。
 *   · todayLocalKey 只读取业务时钟；传入历史 Date 的 epoch 不会改写。
 *   · 保护开发固定时间时，认证、缓存、审计与乐观锁仍使用墙钟。
 *
 * ── 用法 ─────────────────────────────────────────────────
 * ```ts
 * import { localDateKey, todayLocalKey, localDateKeyFromMs, localDateKeyFromBigInt } from '../shared/localDate';
 * const d = todayLocalKey();                        // 今天（中国日）
 * const key = localDateKeyFromBigInt(row.createdAt); // BigInt 毫秒 → 业务日
 * ```
 *
 * ⚠️ **不要**再用 `toISOString().slice(0, 10)` 造日期键，
 * 也**不要**自己再抄一遍 `getFullYear()/padStart` —— 结构守卫会打红
 * （`server/src/shared/__tests__/localDateKey.test.ts`）。
 *
 * 注：`toISOString()` 用于**完整 ISO 时间戳**（如日志字段、`updatedAt`）是合法的，
 * 守卫只针对「截断成 10 位日期」这一种用法。
 */

import { businessNowDate, BUSINESS_TIME_ZONE } from './businessClock';

/** Date → 'YYYY-MM-DD'（显式 Asia/Shanghai；不依赖运行机器时区） */
export function localDateKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(row => row.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** 今天的业务日（来自当前业务时钟，按 Asia/Shanghai 投影） */
export function todayLocalKey(): string {
  return localDateKey(businessNowDate());
}

/** 毫秒时间戳 → 业务日 */
export function localDateKeyFromMs(ms: number): string {
  return localDateKey(new Date(ms));
}

/**
 * BigInt 毫秒时间戳 → 业务日。
 * 时间戳缺失时返回 `fallback`（默认 `'未知'`）—— 调用方原本各自写 `'未知'` / `''`，
 * 需要不同占位符时显式传第二个参数。
 */
export function localDateKeyFromBigInt(v: bigint | null | undefined, fallback = '未知'): string {
  if (v == null) return fallback;
  return localDateKey(new Date(Number(v)));
}

/** Calendar input roundtrip in the business timezone; not a UTC date projection. */
export function isValidLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  const roundtrip = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return Number.isFinite(date.getTime()) && roundtrip === value;
}
