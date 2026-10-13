/**
 * CSV 单元格转义 —— 统一出口，兼防**公式注入**（CSV Injection / Formula Injection）。
 *
 * 为什么必须防：CSV 是纯文本。Excel / WPS / Numbers 打开时会把以 `=` `+` `-` `@`
 * Tab / CR 开头的单元格**当公式执行**——典型 payload 如
 * `=cmd|'/c calc'!A0`、`=HYPERLINK("http://evil.tld","点我查看")`、`=1+1`。
 * 客户名 / 地址 / 联系人 / 备注等字段均来自业务方录入或 Excel 导入，形状完全不可控
 * （真实场景里 `-` 开头的地址、`=` 开头的备注都出现过），导出后在客户端打开即触发。
 *
 * 为什么放共享层：系统有两个 CSV 出口各自实现过转义（relations 客户档案导出、
 * reporting 报表运行导出），各写一遍必然漂移。统一在此，两处引用。
 *
 * 防护手法（OWASP 标准）：值以危险字符开头时前置单引号 `'`
 * —— Excel 视其为"文本标记"，单元格显示时**不含**该引号，且不当公式执行。
 * 之后仍按标准 CSV 规则处理引号 / 逗号 / 换行。
 */

/** 会触发公式解析的首字符（含 Tab / CR——部分表格软件会忽略前导空白后再判定） */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** 需要整体加引号包裹的字符（逗号 / 双引号 / 换行 / 回车） */
const NEEDS_QUOTING = /[",\n\r]/;

export function csvCellSafe(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  const guarded = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 便捷：整行 → CSV 行 */
export function csvRowSafe(cells: unknown[]): string {
  return cells.map(csvCellSafe).join(',');
}
