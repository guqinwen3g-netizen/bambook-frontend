/**
 * 实体变更史 → CSV（G4.3：任一张单据可导出「谁 / 何时 / 从什么改成什么」）
 *
 * 纯函数，不碰 DB / HTTP：每一格（含逗号 / 引号 / 换行 / 公式前缀）都要能被单测逐字钉住。
 * 口径（台账 §12.05 **D110**，v3.107 按复核 #26 收口）：
 *   · UTF-8 **带 BOM**（Excel 双击不乱码）；行分隔 CRLF（Excel 最不挑）；
 *   · 列固定 8 列：时间 / 操作人 / 操作类型 / 字段 / 原值 / 新值 / 动作 / 详情；
 *   · **转义与公式注入防护走仓内共享出口** `server/src/_shared/csvCell.ts`（`csvCellSafe` / `csvRowSafe`）
 *     —— 它的危险前缀集是 `= + - @ \t \r`，且有自己的回归测试；v3.104 第一版在本文件里**又写了一遍**
 *     窄一档的（漏 `\t` / `\r`）⇒ 复核 #26 抓到、已收口。**不要再在这里自造转义**；
 *   · 截断必须**显式**：超上限时由调用方传 `truncated`，末尾追加一行说明——不许静默少给。
 */

import { csvCellSafe, csvRowSafe } from '../_shared/csvCell';

export interface EntityAuditCsvActor {
  id?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface EntityAuditCsvRow {
  createdAt: Date | string;
  actor?: EntityAuditCsvActor | null;
  action?: string | null;
  operationType?: string | null;
  fieldPath?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  detail?: unknown;
}

export const ENTITY_AUDIT_CSV_HEADER = ['时间', '操作人', '操作类型', '字段', '原值', '新值', '动作', '详情'] as const;

/** Date → 本地时区 `YYYY-MM-DD HH:mm:ss`（与面板 formatTime 同形；非法值原样带出，不许因为一行坏数据整份失败） */
export function csvTime(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : String(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 对象/数组 → JSON 文本（共享出口是 `String(v)`，直接把对象丢进去会得到 "[object Object]"） */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

function actorText(actor?: EntityAuditCsvActor | null): string {
  if (!actor) return '';
  return actor.displayName || actor.email || actor.id || '';
}

/** 组装完整 CSV 文本（含 BOM）。行序由调用方保证（与面板一致：createdAt desc）。 */
export function buildEntityAuditCsv(rows: EntityAuditCsvRow[], opts: { truncated?: boolean; maxRows?: number } = {}): string {
  const lines = [ENTITY_AUDIT_CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      csvRowSafe([
        csvTime(r.createdAt),
        actorText(r.actor),
        r.operationType ?? '',
        r.fieldPath ?? '',
        plain(r.beforeValue),
        plain(r.afterValue),
        r.action ?? '',
        plain(r.detail),
      ]),
    );
  }
  if (opts.truncated) {
    const cap = opts.maxRows ?? rows.length;
    lines.push(csvCellSafe(`（已截断：该单据变更记录超过单次导出上限 ${cap} 条，仅含最近 ${rows.length} 条）`));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
