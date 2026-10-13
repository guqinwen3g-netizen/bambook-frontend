/**
 * chinaHolidays.ts（服务端副本）— 中国法定节假日与调休工作日数据 + **工作日计算**。
 *
 * ⚠️ **单一权威真源是** `/utils/chinaHolidays.ts`（前端根目录）。
 *    本文件是服务端快照副本 —— 服务端算「请假工作日天数」「考勤汇总」需要同一份节假日数据，
 *    而 `server/tsconfig.json` 的 rootDir=./src 不允许直接引用根目录模块。
 *    **修改真源时必须同步本文件**，否则前端日历显示的休息日与后端算的请假天数会不一致。
 *    漂移由 `server/src/__tests__/chinaHolidaysSync.test.ts` **数据对撞守卫**兜住（逐条比对）。
 *
 * ── 为什么服务端需要它（口径 C1，2026-09-17 业务方拍板）──────
 * 请假天数原按**自然日整天**标记，与员工填写的 `days` 无关（0.5 天算 1 天、跨周末也计入）。
 * 口径改为：**按工作日算 + 支持半天**（跨周末/法定节假日不计入）。
 * ⇒ 服务端必须能判定「某日是不是工作日」，故引入本模块。
 * 见 `docs/业务口径决策单-2026-09-17.md` **C1**。
 *
 * ── 与前端接口的差异 ─────────────────────────────────────
 * 前端 `resolveDayType(date: Date)` 吃 `Date`（日历渲染需要）；本副本统一吃 **dateKey 字符串**
 * （服务端全程用 'YYYY-MM-DD' 业务日，避免时区漂移 —— 与 `shared/localDate.ts` 同口径）。
 */

import { localDateKey } from '../shared/localDate';

/**
 * 'YYYY-MM-DD' → Date（**本地时区正午**，避开 DST 边界；与前端 `fromDateKey` 同口径）。
 * ⚠️ 不要用 `new Date('2026-01-01')` —— 那是按 UTC 解析，在 UTC+8 会把星期几算错一天。
 */
function parseLocalDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

/** 法定节假日段：连休区间（含端点）+ 节日名 */
export interface HolidayRange {
  /** 'YYYY-MM-DD' */
  start: string;
  /** 'YYYY-MM-DD'（含） */
  end: string;
  name: string;
}

export interface YearHolidayData {
  holidayRanges: HolidayRange[];
  /** 调休上班日（落在本是周末的日期上） */
  adjustedWorkdays: string[];
}

/**
 * ⚠️ **必须与 `utils/chinaHolidays.ts` 的 `HOLIDAY_DATA` 逐条一致**
 *   （由 `__tests__/chinaHolidaysSync.test.ts` 对撞守卫强制）。
 */
export const HOLIDAY_DATA: Record<string, YearHolidayData> = {
  // ★ 2026 年真源：《国务院办公厅关于2026年部分节假日安排的通知》
  //   国办发明电〔2025〕7号（2025-11-04 发布）
  '2026': {
    holidayRanges: [
      { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
      { start: '2026-02-15', end: '2026-02-23', name: '春节' },
      { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
      { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
      { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
      { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
      { start: '2026-10-01', end: '2026-10-07', name: '国庆节' },
    ],
    adjustedWorkdays: [
      '2026-01-04',
      '2026-02-14',
      '2026-02-28',
      '2026-05-09',
      '2026-09-20',
      '2026-10-10',
    ],
  },
};

function findHolidayRange(dateKey: string): HolidayRange | null {
  const data = HOLIDAY_DATA[dateKey.slice(0, 4)];
  if (!data) return null;
  return data.holidayRanges.find(r => dateKey >= r.start && dateKey <= r.end) ?? null;
}

/** 法定节假日（含调休连休日）。返回节日名，非节假日返回 null */
export function getHolidayInfo(dateKey: string): { name: string } | null {
  const range = findHolidayRange(dateKey);
  return range ? { name: range.name } : null;
}

/** 周末调休上班日（该日期原本是周末但按通知上班） */
export function isAdjustedWorkday(dateKey: string): boolean {
  const data = HOLIDAY_DATA[dateKey.slice(0, 4)];
  if (!data) return false;
  return data.adjustedWorkdays.includes(dateKey);
}

export type ChinaDayType = 'holiday' | 'workday' | 'weekend' | 'adjusted-workday';

/**
 * 日类型判定（优先级：法定假 > 调休班 > 周末 > 工作日）。
 * 无该年数据时退化为纯周末判定（跨年未配置时仍可用 —— 与前端同语义）。
 *
 * ⚠️ 用 `fromLocalDateKey` 取本地星期几，**不用 `new Date('YYYY-MM-DD')`**
 *   （后者按 UTC 解析，在 UTC+8 会把星期几算错一天）。
 */
export function resolveDayTypeKey(dateKey: string): ChinaDayType {
  if (getHolidayInfo(dateKey)) return 'holiday';
  if (isAdjustedWorkday(dateKey)) return 'adjusted-workday';
  const weekday = parseLocalDateKey(dateKey).getDay(); // 0=周日 6=周六
  return weekday === 0 || weekday === 6 ? 'weekend' : 'workday';
}

/** 是否工作日（法定工作日 **或** 调休上班日） */
export function isWorkday(dateKey: string): boolean {
  const t = resolveDayTypeKey(dateKey);
  return t === 'workday' || t === 'adjusted-workday';
}

/**
 * 区间内的工作日列表（含端点，按日期升序）。
 * `start > end` 返回空数组（不抛错 —— 调用方自己校验顺序）。
 */
export function listWorkdaysInclusive(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  if (!startKey || !endKey || startKey > endKey) return out;
  const cursor = parseLocalDateKey(startKey);
  // 上限保护：避免调用方传入畸形区间导致死循环（10 年）
  for (let guard = 0; guard < 4000; guard++) {
    const key = localDateKey(cursor);
    if (key > endKey) break;
    if (isWorkday(key)) out.push(key);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * 区间内的**工作日天数**（含端点）—— 口径 C1 的「请假天数」判据。
 *
 * ⚠️ 这是**整日**口径；半天假由调用方在整日基础上按 0.5 计
 *   （本函数不处理半天，避免把"半天的语义"埋进日期计算里）。
 */
export function countWorkdaysInclusive(startKey: string, endKey: string): number {
  return listWorkdaysInclusive(startKey, endKey).length;
}
