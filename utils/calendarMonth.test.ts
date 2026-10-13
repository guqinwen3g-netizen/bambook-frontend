/**
 * 日历月份导航 —— StrictMode 安全的纯计算（2026-09-17，P4-1 P2-#16）
 *
 * ── 病灶 ─────────────────────────────────────────────────
 * 旧实现在 `setViewMonth` 的 **updater 里调 `setViewYear`**（updater 内副作用）。
 * React **StrictMode 会双调 updater**（用于检测不纯的 updater）⇒ `setViewYear` 被调两次
 * ⇒ 跨年时**年份跳 ±2**（2026-01 往回一页 → **2023-12**，而正确答案是 2025-12）。
 *
 * ── 本文件钉四件事 ───────────────────────────────────────
 *   1. **正确性**：`shiftMonthOf` 的跨年/同年/多步/零步全部正确（含负数取模）
 *   2. **★ 复现旧实现的双调后果**：用一段「忠实复现旧语义」的模拟证明
 *      双调 updater 真的会跳 ±2 —— 这样修法就不是「凭感觉改」，而是**针对已复现的失效模式**
 *   3. **纯性**：同入参多次调用结果恒等（纯函数是可被 StrictMode 双调的前提）
 *   4. **源码守卫**：`shiftMonth` **函数体**内不得再出现「updater 形式」的 setState
 *      （精确到函数体 —— 全文 `toContain` 会被同文件其它 updater 蒙混）
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shiftMonthOf } from './calendarMonth';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** ★ 截出目标函数体（本次修复的注释里也提到旧写法，故必须先剥注释） */
function blockOf(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const end = src.indexOf('\n  };', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

const FRONTEND_CODE = stripComments(
  readFileSync(new URL('../components/CalendarManager.tsx', import.meta.url), 'utf8'),
);
const SHIFT_FN = blockOf(FRONTEND_CODE, 'const shiftMonth = (delta: number) => {');

describe('★ shiftMonthOf · 纯计算正确性', () => {
  it('★ 承重：跨年往回（2026-01 减 1 月 → 2025-12，不是 2023-12）', () => {
    expect(shiftMonthOf(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 });
  });

  it('★ 承重：跨年往前（2026-12 加 1 月 → 2027-01）', () => {
    expect(shiftMonthOf(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 });
  });

  it('同年内平移，且 delta=0 恒等', () => {
    expect(shiftMonthOf(2026, 5, 1)).toEqual({ year: 2026, monthIndex: 6 });
    expect(shiftMonthOf(2026, 5, -1)).toEqual({ year: 2026, monthIndex: 4 });
    expect(shiftMonthOf(2026, 5, 0)).toEqual({ year: 2026, monthIndex: 5 });
  });

  it('多步跨年（>12 个月）也正确 —— 总月数算术，无 if 分支', () => {
    expect(shiftMonthOf(2026, 0, -13)).toEqual({ year: 2024, monthIndex: 11 });
    expect(shiftMonthOf(2026, 11, 13)).toEqual({ year: 2028, monthIndex: 0 });
    expect(shiftMonthOf(2026, 6, -18)).toEqual({ year: 2025, monthIndex: 0 }); // 2026-07 − 18 月 = 2025-01
  });

  it('★ 负数取模归一：绝不返回负的 monthIndex', () => {
    // ⚠️ 必须覆盖 **total 为负** 的情形 —— 否则本用例空过：
    //    `year=2026` 时 `year*12 + m + delta` 恒为正，`total % 12` 也是正的，
    //    于是「未归一化的裸取模」也能通过（实测证伪时本用例**没红**）。
    //    `year=0, m=0, delta=-1` → total = -1 → 裸取模给 -1（非法），归一化给 11（正确）。
    for (let y = 0; y <= 2; y++) {
      for (const m of [0, 6, 11]) {
        for (const delta of [-1, -12, -13, -25, -100]) {
          const r = shiftMonthOf(y, m, delta);
          expect(r.monthIndex, `y=${y} m=${m} delta=${delta}`).toBeGreaterThanOrEqual(0);
          expect(r.monthIndex, `y=${y} m=${m} delta=${delta}`).toBeLessThanOrEqual(11);
        }
      }
    }
    // 直接钉住那条边界：total = -1
    expect(shiftMonthOf(0, 0, -1)).toEqual({ year: -1, monthIndex: 11 });
  });

  it('纯性：同入参多次调用结果恒等（可被 StrictMode 双调的前提）', () => {
    const a = shiftMonthOf(2026, 0, -1);
    const b = shiftMonthOf(2026, 0, -1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // 每次返回新对象，不共享可变引用
  });
});

describe('★ 旧实现失效模式复现（证明修法针对真实故障）', () => {
  /**
   * 忠实复现旧语义：在 updater 里改外部 `year`（对应旧代码的 `setViewYear(y => y - 1)`）。
   * StrictMode 会**用相同入参调用 updater 两次** ⇒ 副作用发生两次。
   */
  function oldShiftWithDoubleInvoke(viewYear: number, viewMonth: number, delta: number) {
    let year = viewYear;
    const updater = (prev: number) => {
      const next = prev + delta;
      if (next < 0) { year -= 1; return 11; }
      if (next > 11) { year += 1; return 0; }
      return next;
    };
    updater(viewMonth);          // 第 1 次
    const m = updater(viewMonth); // 第 2 次（StrictMode 双调，入参相同）
    return { year, monthIndex: m };
  }

  it('★ 旧语义双调 → 年份跳 ±2（2026-01 往回 → 2024-12，正是「跳错 ±2 年」）', () => {
    expect(oldShiftWithDoubleInvoke(2026, 0, -1)).toEqual({ year: 2024, monthIndex: 11 });
    expect(oldShiftWithDoubleInvoke(2026, 11, 1)).toEqual({ year: 2028, monthIndex: 0 });
  });

  it('★ 新实现不受双调影响（纯函数，无外部可变状态）', () => {
    expect(shiftMonthOf(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 });
    expect(shiftMonthOf(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 }); // 第二次仍正确
  });
});

describe('★ 源码守卫：shiftMonth 函数体内不得有 updater 内副作用', () => {
  it('能定位到 shiftMonth 函数体（防止守卫空过）', () => {
    expect(SHIFT_FN, '未定位到 shiftMonth 函数体').not.toBe('');
  });

  it('★ shiftMonth 必须用纯计算，且不再出现「updater 形式」的 setState', () => {
    expect(SHIFT_FN).toContain('shiftMonthOf(viewYear, viewMonth, delta)');
    // updater 形式 = `setViewYear(x => …)` / `setViewMonth(x => …)`
    expect(SHIFT_FN).not.toMatch(/setView(Year|Month)\s*\(\s*\(?[A-Za-z_$][\w$]*\)?\s*=>/);
  });

  it('守卫自检：正则确实能咬住旧写法（证明上面那条有区分度）', () => {
    const OLD = `const shiftMonth = (delta: number) => {
    setSelectedDateKey(null);
    setViewMonth(prev => {
      const next = prev + delta;
      if (next < 0) { setViewYear(y => y - 1); return 11; }
      return next;
    });
  };`;
    expect(OLD).toMatch(/setView(Year|Month)\s*\(\s*\(?[A-Za-z_$][\w$]*\)?\s*=>/);
    expect(OLD).not.toContain('shiftMonthOf(');
  });
});
