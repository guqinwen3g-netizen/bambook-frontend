/**
 * task ERP-P1-invoice-shipment-status-transition-rules
 *
 * Invoice / Shipment 状态枚举单一来源 + 合法状态转移规则。
 * 非法转移 fail closed——route mutation 返回 400 INVALID_TRANSITION。
 *
 * 设计原则：
 *   - 状态枚举单一来源（VALID_INVOICE_STATUS / VALID_SHIPMENT_STATUS）
 *   - 合法转移 map（forward + 可回退点明确）
 *   - 终态（Cancelled）只能从非终态进入，不可回退
 */

// ── Invoice 状态枚举（schema.prisma 对齐）──
export const VALID_INVOICE_STATUS = ['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Cancelled'] as const;

// Invoice 合法转移 map（from → Set<to>）
const INVOICE_TRANSITIONS: Record<string, Set<string>> = {
  Draft: new Set(['Issued', 'Cancelled']),
  Issued: new Set(['PartiallyPaid', 'Paid', 'Cancelled']),
  PartiallyPaid: new Set(['Paid', 'Cancelled']),
  Paid: new Set(['Cancelled']), // Paid 可作废（信用退），不可回退到 PartiallyPaid
  Cancelled: new Set(), // 终态
};

// ── Shipment 状态枚举 ──
// `VALID_SHIPMENT_STATUS` 保留历史值以便读取旧记录；当前 MVP 可推进到“实际已出运”即结束。
export const VALID_SHIPMENT_STATUS = ['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled'] as const;
export const MVP_SHIPMENT_WRITE_STATUS = ['Draft', 'Booked', 'Loading', 'Shipped', 'Cancelled'] as const;

// Shipment 当前可写状态图；Arrived/Cleared/Delivered 仅保留作历史读取，不再推进。
const SHIPMENT_TRANSITIONS: Record<string, Set<string>> = {
  Draft: new Set(['Booked', 'Cancelled']),
  Booked: new Set(['Loading', 'Shipped', 'Cancelled']),
  Loading: new Set(['Shipped', 'Cancelled']),
  Shipped: new Set(['Cancelled']), // 只保留既有作废能力，不再进入目的地到货阶段
  Arrived: new Set(), // 历史只读状态
  Cleared: new Set(), // 历史只读状态
  Delivered: new Set(), // 历史只读状态
  Cancelled: new Set(), // 终态
};

export interface TransitionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * 校验状态转移合法性。
 * @param entityType 'Invoice' | 'Shipment'
 * @param from 当前状态
 * @param to 目标状态
 */
export function validateStatusTransition(
  entityType: 'Invoice' | 'Shipment',
  from: string,
  to: string,
): TransitionResult {
  const validStatuses = entityType === 'Invoice' ? VALID_INVOICE_STATUS : VALID_SHIPMENT_STATUS;
  const transitions = entityType === 'Invoice' ? INVOICE_TRANSITIONS : SHIPMENT_TRANSITIONS;

  // 目标必须合法枚举
  if (!validStatuses.includes(to as any)) {
    return { ok: false, error: 'INVALID_STATUS', message: `${entityType} status must be one of: ${validStatuses.join(', ')}` };
  }

  // 相同状态允许（幂等，不视为转移）
  if (from === to) return { ok: true };

  // 历史到港/清关/交付值可展示，但当前 MVP 不允许新流程写入这些节点。
  if (entityType === 'Shipment' && !MVP_SHIPMENT_WRITE_STATUS.includes(to as any)) {
    return { ok: false, error: 'INVALID_TRANSITION', message: '当前 MVP 出运流程止于实际离港/起飞的“已出运”，不记录目的地到港、清关或交付状态。' };
  }

  // task_mqy459c6: from 不在枚举（脏数据/旧枚举）→ fail closed（不静默放过）
  if (!transitions[from]) {
    return {
      ok: false,
      error: 'INVALID_CURRENT_STATUS',
      message: `${entityType} current status '${from}' is not a recognized status. Valid: ${validStatuses.join(', ')}`,
    };
  }

  // 检查转移合法性
  if (!transitions[from].has(to)) {
    return {
      ok: false,
      error: 'INVALID_TRANSITION',
      message: `${entityType} cannot transition from '${from}' to '${to}'. Allowed: ${[...transitions[from]].join(', ') || '(terminal state)'}`,
    };
  }

  return { ok: true };
}
