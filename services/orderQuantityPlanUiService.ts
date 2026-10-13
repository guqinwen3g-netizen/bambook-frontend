import { parseOrderQuantity, normalizeOrderQuantityUnit } from '../server/src/shared/orderQuantitySummary';

export type QuantityPlanDraftRow = {
  lineId: string;
  beforeQuantity: string;
  unit: string;
  beforeUnitPrice: string | null;
  beforeNetValue: string | null;
  afterQuantity: string;
  afterNetValue: string;
};
export type QuantityPlanDraft = { orderId: string; expectedUpdatedAt: string; rows: QuantityPlanDraftRow[] };

const fail = (message: string): never => { throw new Error(message); };
const exact = (value: unknown, allowZero = true) => parseOrderQuantity(value, { allowZero });
const nullableMoney = (value: unknown) => value === null ? null : exact(value);

function epoch(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString();
  return fail('订单版本不完整，请刷新实际订单后重新核对');
}

/** Build from the fetched real order lines; never infer a split from a header total. */
export function prepareQuantityPlanDraft(order: {
  id: string;
  updatedAt?: unknown;
  lines?: readonly {
    id: unknown;
    orderId?: unknown;
    lineNumber?: unknown;
    quantity: unknown;
    unit?: unknown;
    unitPrice?: unknown;
    netValue?: unknown;
  }[];
}): QuantityPlanDraft {
  if (!order.id || !order.lines?.length) return fail('缺少实际订单行，不能用订单总量猜逐行计划');
  const ids = new Set<string>();
  const rows = [...order.lines].sort((a, b) => {
    const an = Number.isSafeInteger(a.lineNumber) ? a.lineNumber as number : Number.MAX_SAFE_INTEGER;
    const bn = Number.isSafeInteger(b.lineNumber) ? b.lineNumber as number : Number.MAX_SAFE_INTEGER;
    return an - bn || String(a.id).localeCompare(String(b.id));
  }).map(line => {
    if (typeof line.id !== 'string' || !line.id || ids.has(line.id) || (line.orderId != null && line.orderId !== order.id)) {
      return fail('订单行原件重复或归属错误');
    }
    ids.add(line.id);
    const unit = normalizeOrderQuantityUnit(line.unit);
    if (!unit) return fail('订单行单位尚未明确，请先核对原件');
    const quantity = exact(line.quantity);
    const netValue = nullableMoney(line.netValue);
    const unitPrice = nullableMoney(line.unitPrice);
    return {
      lineId: line.id,
      beforeQuantity: quantity,
      unit,
      beforeUnitPrice: unitPrice,
      beforeNetValue: netValue,
      afterQuantity: quantity,
      afterNetValue: netValue ?? '',
    };
  });
  return { orderId: order.id, expectedUpdatedAt: epoch(order.updatedAt), rows };
}

/**
 * Exact v2 wire plan. Every row is present. An unchanged row with an unknown
 * historical net value stays null; a changed row requires an explicit net value.
 */
export function buildQuantityPlan(draft: QuantityPlanDraft) {
  if (!draft.orderId || !draft.rows.length) return fail('缺少数量计划原件');
  const ids = new Set<string>();
  let changed = false;
  const lines = draft.rows.map(row => {
    if (!row.lineId || ids.has(row.lineId)) return fail('数量计划不可重复订单行');
    ids.add(row.lineId);
    const unit = normalizeOrderQuantityUnit(row.unit);
    if (!unit) return fail('数量计划缺少明确单位');
    const beforeQuantity = exact(row.beforeQuantity);
    const afterQuantity = exact(row.afterQuantity, false);
    const quantityChanged = beforeQuantity !== afterQuantity;
    if (quantityChanged) changed = true;
    const afterNetValue = row.afterNetValue === ''
      ? quantityChanged
        ? fail('数量变化的行必须明确填写变更后净额')
        : row.beforeNetValue
      : exact(row.afterNetValue);
    if (quantityChanged && afterNetValue === null) return fail('数量变化的行必须明确填写变更后净额');
    return {
      lineId: row.lineId,
      beforeQuantity,
      unit,
      afterQuantity,
      beforeUnitPrice: nullableMoney(row.beforeUnitPrice),
      beforeNetValue: nullableMoney(row.beforeNetValue),
      afterNetValue,
    };
  }).sort((a, b) => a.lineId.localeCompare(b.lineId));
  if (!changed) return fail('逐行数量计划没有实际数量变化');
  return {
    version: 2 as const,
    orderId: draft.orderId,
    expectedUpdatedAt: epoch(draft.expectedUpdatedAt),
    lines,
  };
}
