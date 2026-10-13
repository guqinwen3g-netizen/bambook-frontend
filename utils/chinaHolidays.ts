/**
 * chinaHolidays — 中国法定节假日与调休工作日数据（日历页基础数据层）。
 *
 * ⚠️ 数据校正入口：下方 HOLIDAY_DATA 按国务院办公厅每年发布的放假安排通知
 * 手工维护。2026 年安排真源 = **国办发明电〔2025〕7号**（2025-11-04 发布，
 * https://www.gov.cn/zhengce/content/202511/content_7047090.htm ）；
 * 如与实际通知有出入（尤其调休上班日），直接改 HOLIDAY_DATA 对应条目即可，无代码改动。
 * 跨年时（2027 起）在 HOLIDAY_DATA 追加新年份条目。
 *
 * ⚠️ 改数据时**必须同时**看 `components/CalendarManager.test.tsx` 的两个守卫：
 *   ① 行为守卫（逐日四态判定）—— 钉住官方原文的关键日期
 *   ② 结构不变量 —— 调休上班日必须是周末，且不得与法定假期重叠
 *
 * 查询接口（日期 key 统一 'YYYY-MM-DD'，与日历页日期模型一致）：
 *   getHolidayInfo(dateKey) → { name } | null   法定节假日（含调休连休日）
 *   isAdjustedWorkday(dateKey) → boolean          周末调休上班日（显示「班」）
 *   isRestDay(dateKey) → boolean                  休息日（节假日或未调休的周末）
 *   resolveDayType(dateKey) → 'holiday' | 'workday' | 'weekend' | 'adjusted-workday'
 */

/** 法定节假日段：连休区间（含端点）+ 节日名 */
interface HolidayRange {
  /** 'YYYY-MM-DD' */
  start: string;
  /** 'YYYY-MM-DD'（含） */
  end: string;
  name: string;
}

interface YearHolidayData {
  holidayRanges: HolidayRange[];
  /** 调休上班日（落在本是周末的日期上，显示「班」徽标） */
  adjustedWorkdays: string[];
}

const HOLIDAY_DATA: Record<string, YearHolidayData> = {
  // ★ 2026 年真源：《国务院办公厅关于2026年部分节假日安排的通知》
  //   国办发明电〔2025〕7号（2025-11-04 发布）
  //   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
  //   原文逐条（2026-09-17 逐条核对过，改动请回原文核对）：
  //     元旦：1月1日（周四）至3日（周六），共3天；1月4日（周日）上班
  //     春节：2月15日（周日）至23日（周一），共9天；2月14日（周六）、2月28日（周六）上班
  //     清明：4月4日（周六）至6日（周一），共3天
  //     劳动节：5月1日（周五）至5日（周二），共5天；5月9日（周六）上班
  //     端午：6月19日（周五）至21日（周日），共3天
  //     中秋：9月25日（周五）至27日（周日），共3天
  //     国庆：10月1日（周四）至**7日**（周三），共7天；**9月20日（周日）**、10月10日（周六）上班
  //   ⚠️ 修前有 3 处与原文不符：国庆多算 1 天（10-08 实为工作日）、漏 1-04、漏 9-20。
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
    // 调休上班日（依据官方通知；如与实际通知不符改这里）
    // 不变量：必须是「本是周末的日子」（见 CalendarManager.test.tsx 的结构守卫）
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

/** 日期 → 'YYYY-MM-DD'（本地时区，避免 toISOString 的 UTC 偏移日漂移） */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' → Date（本地时区正午，避开 DST 边界） */
export function fromDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

function findHolidayRange(dateKey: string): HolidayRange | null {
  const year = dateKey.slice(0, 4);
  const data = HOLIDAY_DATA[year];
  if (!data) return null;
  return data.holidayRanges.find(range => dateKey >= range.start && dateKey <= range.end) ?? null;
}

/** 法定节假日（含调休连休日）。返回节日名，非节假日返回 null */
export function getHolidayInfo(dateKey: string): { name: string } | null {
  const range = findHolidayRange(dateKey);
  return range ? { name: range.name } : null;
}

/** 周末调休上班日（该日期原本是周末但按通知上班，显示「班」） */
export function isAdjustedWorkday(dateKey: string): boolean {
  const data = HOLIDAY_DATA[dateKey.slice(0, 4)];
  if (!data) return false;
  return data.adjustedWorkdays.includes(dateKey);
}

export type ChinaDayType = 'holiday' | 'workday' | 'weekend' | 'adjusted-workday';

/**
 * 日类型判定（优先级：法定假 > 调休班 > 周末 > 工作日）。
 * 无该年数据时退化为纯周末判定（老数据年份/跨年未配置时日历仍可用）。
 */
export function resolveDayType(date: Date): ChinaDayType {
  const dateKey = toDateKey(date);
  if (getHolidayInfo(dateKey)) return 'holiday';
  const weekday = date.getDay(); // 0=周日 6=周六
  const isWeekend = weekday === 0 || weekday === 6;
  if (isAdjustedWorkday(dateKey)) return 'adjusted-workday';
  if (isWeekend) return 'weekend';
  return 'workday';
}
