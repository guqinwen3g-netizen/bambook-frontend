/**
 * shipmentScheduleFields.ts — 「改期/物流变更」留痕字段的**唯一真源**（2026-09-18 · D5）
 *
 * ── 为什么需要它（零基础障碍清单 D5：甩柜/改船期缺改期留痕，实测比描述更广）──
 * `updateShipment` 的审计 **before/after 只写了 `status` + `shipmentNumber`**：
 *   ```ts
 *   before: { status: existing.status, shipmentNumber: existing.shipmentNumber },
 *   after:  { status: upd.status,     shipmentNumber: upd.shipmentNumber },
 *   ```
 * ⇒ **改 ETD/ETA（甩柜、改船期）、改船名航次、改装卸港、改柜号封条 —— 全部查不到改了什么**。
 *   而甩柜/改船期正是面料外贸最高频的异常之一（船公司通知改期 → 业务员改运单 → 客户/报关/单证都要跟着改）。
 *
 * ── 修法（**零 migration**）──
 * 本仓已有字段级审计基础设施（`AuditLog.fieldPath/beforeValue/afterValue` +
 * `writeFieldAuditDiff` 批量 diff）。所以：
 *   ① 改物流字段时，用 `writeFieldAuditDiff` 为**每个真正变更的字段**写一条字段级审计；
 *   ② 改期历史 = 查这些字段级审计（`targetType='Shipment' + targetId + fieldPath ∈ 本表`）。
 * 为什么**不**新建「改期表」：字段级审计已能表达同一事实，且是**全模块通用**的真源；
 *   再建一张专用表会出现「同一事实两处记」的漂移风险（本仓反复踩过）。
 * 为什么**不**塞进 `ShipmentEvent`：该表语义是**节点事件**（`toNode` 取值 = 运单状态），
 *   改期不是节点 —— 硬塞会污染节点时间轴（同 C4 拒绝复用 `StockMovement` 的理由）。
 */

/** 参与「变更留痕」的运单字段（键 = Prisma 字段名，值 = 中文标签） */
export const SHIPMENT_TRACKED_FIELDS: Record<string, string> = {
  status: '状态',
  bookingDate: '订舱日',
  etd: '预计离港(ETD)',
  atd: '实际离港(ATD)',
  eta: '预计到港(ETA)',
  ata: '实际到港(ATA)',
  vesselOrFlight: '船名/航班',
  voyageNumber: '航次',
  portOfLoading: '装货港',
  portOfDischarge: '卸货港',
  containerNumber: '柜号',
  sealNumber: '封条号',
  carrierName: '承运人',
  trackingNumber: '跟踪号',
  exportDeclarationCompletedAt: '出口申报完成时间',
  exportDeclarationReference: '外部申报编号',
  exportDeclarationEvidenceDocumentId: '出口申报凭证',
};

/** 只读：用于 `writeFieldAuditDiff({ trackedFields })` 与改期历史查询 */
export const SHIPMENT_TRACKED_FIELD_KEYS: string[] = Object.keys(SHIPMENT_TRACKED_FIELDS);

/** 改期/物流变更的中文标签（未知字段原样返回，不猜） */
export function scheduleFieldLabel(field: string): string {
  return SHIPMENT_TRACKED_FIELDS[field] ?? field;
}

const blank = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
};

/** 面向人的一句话：`ETD 2026-09-20 → 2026-09-27`（空值显示 —，不显示 null） */
export function describeScheduleChange(field: string, from: unknown, to: unknown): string {
  return `${scheduleFieldLabel(field)} ${blank(from)} → ${blank(to)}`;
}

/**
 * 纯函数：从 before/after 快照 diff 出**真正变更**的受追踪字段。
 *
 * ⚠️ 口径**刻意与写侧 `writeFieldAuditDiff` 完全一致**（JSON 浅比较、只比 trackedFields）：
 *   真源若"比写侧更聪明"（例如自作主张把 `''` 与 `null` 视作同一值），
 *   就会出现「真源说没变、写侧却落了痕」的不一致 —— 真源不能是谎言。
 *   ⇒ **空串归一放到调用点**（`normalizeScheduleSnapshot`），不藏在 diff 里。
 * 单独抽出来是为了**可单测**（避免"审计写了但字段没被追踪"这类静默漏收）。
 */
export function diffScheduleFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  trackedFields: string[] = SHIPMENT_TRACKED_FIELD_KEYS,
): Array<{ field: string; from: unknown; to: unknown }> {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const field of trackedFields) {
    const b = before[field];
    const a = after[field];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    out.push({ field, from: b ?? null, to: a ?? null });
  }
  return out;
}

/**
 * 调用点用的归一：把受追踪字段里的**空串归一为 null**。
 *
 * 为什么需要：表单清空某字段常写成 `''`，而未填是 `null` —— 两者在界面上都显示「—」，
 * 若不去重就会留下「封条号 — → —」这种无意义留痕（噪音会淹没真正的改期记录）。
 * 为什么放在调用点而不是 `diffScheduleFields` 里：见该函数注释（真源必须与写侧行为一致）。
 */
export function normalizeScheduleSnapshot<T extends Record<string, unknown>>(
  snapshot: T,
  trackedFields: string[] = SHIPMENT_TRACKED_FIELD_KEYS,
): T {
  const out: Record<string, unknown> = { ...snapshot };
  for (const f of trackedFields) {
    if (out[f] === '') out[f] = null;
  }
  return out as T;
}
