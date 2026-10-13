/**
 * Agent-P4-inventory-flow-contract
 * inventory.adjust_stock draft→approval→commit 流程契约。
 *
 * commit 复用 inventoryService.createStockMovement（与 HTTP route 同一真源），
 * 事务内更新余额 + 写流水 + 审计日志均由 service 完成，Agent path 不手写 DB mutation。
 * 域 service 在 commit 内 await import 惰性加载（避免与既有测试的模块级 total-mock 产生导入链耦合）。
 */

import type { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';

export type InventoryFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'INVALID_MOVEMENT_TYPE'
  | 'MISSING_TARGET_WAREHOUSE'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_STOCK'
  | 'MOVEMENT_FAILED';

export interface InventoryFlowError {
  code: InventoryFlowErrorCode;
  message: string;
  userAction: string;
}

export interface InventoryFlowCommitted {
  status: 'committed';
  movementId: string;
  itemId: string;
  idempotencyKey: string;
}

export function buildInventoryFlowError(code: InventoryFlowErrorCode, message: string): InventoryFlowError {
  const userActionMap: Record<InventoryFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查库存变动输入（itemId/type/quantity）',
    INVALID_INPUT: '输入包含不可写字段，请移除后重新发起',
    INVALID_MOVEMENT_TYPE: '库存变动类型非法，请使用 Inbound/Outbound/Transfer/Adjustment/Lock/Unlock',
    MISSING_TARGET_WAREHOUSE: '调拨（Transfer）必须指定 targetWarehouseId',
    NOT_FOUND: '目标库存项或仓库不存在或已删除',
    INSUFFICIENT_STOCK: '库存余额不足（或锁定/解锁数量超界），请核对当前库存后调整数量',
    MOVEMENT_FAILED: '库存变动事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

/** 域 service 抛错（throw-based 契约，与 route 同口径）→ Flow 错误码 */
function mapInventoryError(e: any): InventoryFlowError {
  const msg: string = e?.message || '';
  if (msg.includes('非法库存变动类型') || msg.includes('未实现的变动类型')) return buildInventoryFlowError('INVALID_MOVEMENT_TYPE', msg);
  if (msg.includes('调拨必须指定目标仓库')) return buildInventoryFlowError('MISSING_TARGET_WAREHOUSE', msg);
  if (msg.includes('库存不足') || msg.includes('可锁定库存不足') || msg.includes('解锁数量超过已锁定')) return buildInventoryFlowError('INSUFFICIENT_STOCK', msg);
  if (msg.includes('不存在')) return buildInventoryFlowError('NOT_FOUND', msg);
  return buildInventoryFlowError('MOVEMENT_FAILED', msg || 'operation failed');
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

// ─── inventory.adjust_stock ────────────────────────────────────────
export function buildInventoryAdjustStockDraft(input: { movement: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { movement, currentSnapshot = {} } = input;
  const itemId = String((movement as any).itemId || '');
  const subOperations: SubOperation[] = [{
    toolId: 'inventory.adjust_stock',
    entityId: itemId,
    action: 'create_stock_movement',
    before: currentSnapshot,
    after: { ...movement },
  }];
  const beforeAfterDiff = Object.entries(movement).map(([field, after]) => ({
    entity: 'inventoryItem', entityId: itemId, field, before: (currentSnapshot as any)[field] ?? null, after,
  }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['inventory', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `inventory.adjust_stock:${itemId}:${(movement as any).type || 'unknown'}:${hash}` };
}

export function validateInventoryAdjustStockDraftSemantics(draft: any): { ok: boolean; error?: InventoryFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildInventoryFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.itemId) return { ok: false, error: buildInventoryFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain itemId') };
  if (!after?.type) return { ok: false, error: buildInventoryFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain type') };
  // 盘点（Adjustment）quantity 为目标绝对值，0 = 清零合法；其余类型必须 > 0（与 inventoryRoute 同口径）
  if (typeof after?.quantity !== 'number' || !Number.isFinite(after.quantity) || after.quantity < 0
      || (after.quantity === 0 && after.type !== 'Adjustment')) {
    return { ok: false, error: buildInventoryFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain finite quantity > 0 (Adjustment allows 0 = clear to zero)') };
  }
  if (after.type === 'Transfer' && !after?.targetWarehouseId) {
    return { ok: false, error: buildInventoryFlowError('MISSING_TARGET_WAREHOUSE', 'Transfer movement must contain targetWarehouseId') };
  }
  return { ok: true };
}

export function verifyInventoryAdjustStockDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitInventoryAdjustStock(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: InventoryFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: InventoryFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildInventoryFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildInventoryFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateInventoryAdjustStockDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const movement = draft.subOperations[0].after as Record<string, unknown>;
  const { createInventoryService, VALID_MOVEMENT_TYPES, STOCK_MOVEMENT_INPUT_FIELDS } = await import('../inventory/inventoryService');
  const illegalFields = Object.keys(movement).filter((k) => !(STOCK_MOVEMENT_INPUT_FIELDS as readonly string[]).includes(k));
  if (illegalFields.length > 0) {
    return { ok: false, feedback: { status: 'failed', error: buildInventoryFlowError('INVALID_INPUT', `movement contains non-writable fields: ${illegalFields.join(', ')}`), approvalId } };
  }
  if (!(VALID_MOVEMENT_TYPES as readonly string[]).includes(movement.type as string)) {
    return { ok: false, feedback: { status: 'failed', error: buildInventoryFlowError('INVALID_MOVEMENT_TYPE', `invalid movement type: ${String(movement.type)}`), approvalId } };
  }
  try {
    const svc = createInventoryService(prisma);
    const result = await svc.createStockMovement(movement as any, 'agent');
    return { ok: true, feedback: { status: 'committed', movementId: result.id, itemId: String(movement.itemId), idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: mapInventoryError(e), approvalId } };
  }
}

// ─── 自注册入口（toolRuntime 一次性接线；与 registerNewDomainQueryTools 同模式）──
export function registerInventoryFlowTools(): void {
  registerCommitTool('inventory.adjust_stock', async (ctx) => {
    const result = await commitInventoryAdjustStock({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok ? { ok: true, ...r.feedback } : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
