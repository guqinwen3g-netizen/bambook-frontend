/**
 * 通用 Excel 导出（2026-08-22 全系统文档体系 B1 架构底座）。
 *
 * xlsx@0.18.5 已在 server 依赖（此前仅发货通知一个孤点调用）——本模块
 * 将其升级为全站通用导出基建：财务 6 大报表 / 报表中心运行结果 /
 * 业务列表批量导出共用此入口。多 sheet 天然支持（叠加场景：
 * 多客户对账各一个 sheet / 多筛选口径各一个 sheet）。
 */

import * as XLSX from 'xlsx';

export interface XlsxSheet {
  /** sheet 名（Excel 限制 31 字符，超长自动截断） */
  name: string;
  /** 表头（显示名） */
  columnLabels: string[];
  /** 字段键（与 rows 的 key 对应） */
  columns: string[];
  /** 数据行 */
  rows: Array<Record<string, unknown>>;
}

/** 单元格值规整：Decimal/BigInt → number，null/undefined → 空 */
function cellValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null) {
    // Prisma Decimal {s,e,d} 形态（经 JSON 序列化的旧缓存数据）
    const d = (v as any).d;
    if (Array.isArray(d)) {
      const n = Number(`${(v as any).s === -1 ? '-' : ''}${d.join('')}e${((v as any).e ?? 0) - d.length + 1}`);
      return Number.isFinite(n) ? n : String(v);
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * 构建 Excel 工作簿 Buffer（多 sheet）。
 * 每个表头行加粗由 Excel 默认样式承担（SheetJS 社区版不支持单元格样式，
 * 用 freeze 表头行保证可读性）。
 * 空数据兜底：sheets 为空（如对账单无账务记录）时合成「无数据」占位 sheet，
 * 保证工作簿始终合法（SheetJS 空工作簿会抛 "Workbook is empty"）。
 */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  const list: XlsxSheet[] = sheets.length > 0
    ? sheets
    : [{ name: 'No Data 无数据', columnLabels: ['提示 Note'], columns: ['note'], rows: [{ note: '当前筛选条件下无数据 No data under current filters' }] }];
  for (const sheet of list) {
    // sheet 名去重 + 31 字符截断（Excel 硬限制）
    let name = (sheet.name || 'Sheet').slice(0, 31);
    let i = 2;
    while (usedNames.has(name)) name = `${sheet.name.slice(0, 28)}_${i++}`;
    usedNames.add(name);

    const aoa: Array<Array<string | number | null>> = [sheet.columnLabels];
    for (const row of sheet.rows) {
      aoa.push(sheet.columns.map(c => cellValue(row[c])));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 冻结首行（表头）
    (ws as any)['!freeze'] = { xSplit: '0', ySplit: '1' };
    // 列宽自适应（中文按 2 字符宽估算，上限 40）
    ws['!cols'] = sheet.columnLabels.map((label, idx) => {
      const maxLen = Math.max(
        String(label).length * 2,
        ...sheet.rows.slice(0, 200).map(r => String(r[sheet.columns[idx]] ?? '').length * (String(r[sheet.columns[idx]] ?? '').match(/[\u4e00-\u9fa5]/) ? 2 : 1)),
      );
      return { wch: Math.min(40, Math.max(8, maxLen + 2)) };
    });
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** 通用下载响应头（attachment；文件名做 RFC 5987 双编码兼容中文） */
export function xlsxDownloadHeaders(fileName: string): Record<string, string> {
  const encoded = encodeURIComponent(fileName);
  return {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
  };
}
