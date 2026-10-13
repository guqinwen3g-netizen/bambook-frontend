/**
 * 日历「月份导航」的纯计算（零 import —— 便于直接行为断言）。
 *
 * ── 病灶（P4-1 P2-#16）────────────────────────────────────
 * 旧实现在 `CalendarManager.shiftMonth` 里写成：
 * ```ts
 * setViewMonth(prev => {
 *   const next = prev + delta;
 *   if (next < 0) { setViewYear(y => y - 1); return 11; }   // ← ★ 在 updater 里调另一个 setState
 *   if (next > 11) { setViewYear(y => y + 1); return 0; }
 *   return next;
 * });
 * ```
 * **在 state updater 里调另一个 setState = 副作用**。React **StrictMode** 会
 * **双调 updater**（用于检测不纯的 updater）⇒ `setViewYear` 被调用**两次**
 * ⇒ 跨年时**年份跳 ±2**（2026-01 往回一页 → 2023-12 而不是 2025-12）。
 *
 * ── 修法 ─────────────────────────────────────────────────
 * 把年月计算抽成**纯函数**，在 updater **外**算好，updater 只回纯值：
 * ```ts
 * const next = shiftMonthOf(viewYear, viewMonth, delta);
 * setViewYear(next.year);
 * setViewMonth(next.monthIndex);
 * ```
 * 纯函数同时让这件事**可被直接行为断言**（不必渲染组件、不必依赖 StrictMode 环境）。
 *
 * 实现用「总月数」算术（`year * 12 + monthIndex + delta`），
 * 因此对任意 `delta` 都正确（不限于 ±1），也不需要 `if` 分支。
 */

export interface YearMonth {
  /** 四位年份 */
  year: number;
  /** 月份下标 **0–11**（与 `Date#getMonth()` 一致，不是 1–12） */
  monthIndex: number;
}

/**
 * 把 `(year, monthIndex)` 平移 `delta` 个月。
 *
 * @param monthIndex **0–11**（`Date#getMonth()` 口径）
 * @param delta      可正可负，绝对值不限（内部用总月数算术，无 `if` 分支）
 */
export function shiftMonthOf(year: number, monthIndex: number, delta: number): YearMonth {
  const total = year * 12 + monthIndex + delta;
  return {
    year: Math.floor(total / 12),
    // `%` 对负数会返回负值，故先取模再归一（避免 -1 % 12 = -1 这类结果）
    monthIndex: ((total % 12) + 12) % 12,
  };
}
