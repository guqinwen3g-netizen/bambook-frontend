/**
 * 统一日期展示格式：YYYY-MM-DD。
 * 规避 toLocaleDateString / 原生 date input 随系统区域在 MM/DD/YYYY 与
 * 「月/日/年」之间漂移的问题，全应用日期文本一律走这里。
 */
export function formatYmd(input: number | string | Date | null | undefined): string {
  if (input === null || input === undefined || input === '') return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
