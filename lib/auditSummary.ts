/**
 * 审计流水一行的可读摘要 —— **两个出口共用的一份真源**。
 *
 * 出处：原先只住在 `components/AuditHistorySection.tsx` 内部（v3.237 补 35 原样搬来，行为未改）。
 * 现在第二个消费者是管理面板「系统日志」表：库里 `fieldPath` 非空的行分布在 8 个 targetType 上，
 * 而"原值 → 新值"此前只有订单详情页那个浮层渲染得出来 ⇒ 其余记录类型的字段级留痕落库了却读不到。
 * 共享这一份，是为了不再抄第二份（抄一份＝把"两出口同一句话"变成两条可以各自腐烂的文字）。
 */

export interface AuditSummaryRow {
  action?: string | null;
  fieldPath?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
}

/** 动作可读化（通用规则，非逐 action 字典）：create_/update_/delete_/cancel_ 前缀 → 创建/更新/删除/作废
 *  ★ 冒号族（`order:confirm` 等）现状不翻译 —— 口径见 §9 B286，改它要单独一批。 */
function actionLabel(action: string): string {
  if (action.startsWith('create_')) return `创建 · ${action.slice(7)}`;
  if (action.startsWith('update_')) return `更新 · ${action.slice(7)}`;
  if (action.startsWith('delete_')) return `删除 · ${action.slice(7)}`;
  if (action.startsWith('cancel_')) return `作废 · ${action.slice(7)}`;
  return action;
}

/** 值 → 文字：取不到（null/undefined）交「—」，不伪造空串；对象 JSON 化后截 60 字符 */
function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  } catch {
    return String(v);
  }
}

/** 字段级审计优先（`列名: 原值 → 新值`），否则回退动作摘要 */
export function auditRowSummary(row: AuditSummaryRow): string {
  if (row.fieldPath) {
    return `${row.fieldPath}: ${valueText(row.beforeValue)} → ${valueText(row.afterValue)}`;
  }
  return actionLabel(row.action ?? '');
}
