import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInventoryAdjustStockDraft,
  validateInventoryAdjustStockDraftSemantics,
  verifyInventoryAdjustStockDraftHash,
  commitInventoryAdjustStock,
  buildInventoryFlowError,
  type InventoryFlowErrorCode,
} from '../inventoryFlow';

vi.mock('../../inventory/inventoryService', () => ({
  createInventoryService: vi.fn(),
  VALID_MOVEMENT_TYPES: ['Inbound', 'Outbound', 'Transfer', 'Adjustment', 'Lock', 'Unlock'],
  STOCK_MOVEMENT_INPUT_FIELDS: [
    'itemId', 'type', 'quantity', 'unit', 'unitCost', 'targetWarehouseId',
    'reason', 'referenceType', 'referenceId', 'movementDate', 'notes',
  ],
}));
import { createInventoryService } from '../../inventory/inventoryService';

const createStockMovement = vi.fn();

const movementInput = { itemId: 'ITEM__1', type: 'Outbound', quantity: 50, unit: 'm', reason: '生产领料' };

describe('task inventory-flow: buildInventoryAdjustStockDraft', () => {
  it('生成含六字段的 ProcessDraft（before 用 currentSnapshot）', () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput, currentSnapshot: { quantity: 100 } });
    expect(draft.subOperations[0].toolId).toBe('inventory.adjust_stock');
    expect(draft.subOperations[0].action).toBe('create_stock_movement');
    expect(draft.subOperations[0].entityId).toBe('ITEM__1');
    expect((draft.subOperations[0].before as any).quantity).toBe(100);
    expect(draft.beforeAfterDiff.length).toBe(Object.keys(movementInput).length);
    expect(draft.impactScope).toEqual(['inventory', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey).toContain('inventory.adjust_stock:ITEM__1:Outbound:');
  });
});

describe('task inventory-flow: validateInventoryAdjustStockDraftSemantics（fail closed）', () => {
  it('缺 itemId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { type: 'Inbound', quantity: 10 } }] } as any;
    const r = validateInventoryAdjustStockDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('缺 type → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { itemId: 'ITEM__1', quantity: 10 } }] } as any;
    expect(validateInventoryAdjustStockDraftSemantics(draft).ok).toBe(false);
  });

  it('quantity <= 0 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { itemId: 'ITEM__1', type: 'Inbound', quantity: 0 } }] } as any;
    expect(validateInventoryAdjustStockDraftSemantics(draft).ok).toBe(false);
  });

  it('quantity 非有限数 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { itemId: 'ITEM__1', type: 'Inbound', quantity: Number.NaN } }] } as any;
    expect(validateInventoryAdjustStockDraftSemantics(draft).ok).toBe(false);
  });

  it('Transfer 缺 targetWarehouseId → MISSING_TARGET_WAREHOUSE', () => {
    const draft = { subOperations: [{ after: { itemId: 'ITEM__1', type: 'Transfer', quantity: 10 } }] } as any;
    const r = validateInventoryAdjustStockDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('MISSING_TARGET_WAREHOUSE');
  });

  it('合法 draft → ok', () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    expect(validateInventoryAdjustStockDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task inventory-flow: commitInventoryAdjustStock（复用 service）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createInventoryService as any).mockReturnValue({ createStockMovement });
  });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...movementInput, quantity: 999 } }] };
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('非法字段 → INVALID_INPUT，service 不被调', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: { ...movementInput, warehouseId: 'WH__1' } });
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_INPUT');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('非法变动类型 → INVALID_MOVEMENT_TYPE，service 不被调', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: { ...movementInput, type: 'Destroy' } });
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_MOVEMENT_TYPE');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('成功 commit → committed，svc.createStockMovement 以 actor=agent 调用一次', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockResolvedValue({ id: 'MOV__1' });
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.movementId).toBe('MOV__1');
      expect(r.feedback.itemId).toBe('ITEM__1');
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(createStockMovement).toHaveBeenCalledTimes(1);
    expect(createStockMovement).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'ITEM__1', type: 'Outbound' }), 'agent');
  });

  it('service 抛「库存不足」→ INSUFFICIENT_STOCK', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockRejectedValue(new Error('库存不足：当前 10，需出库 50'));
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('service 抛「不存在」→ NOT_FOUND', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockRejectedValue(new Error('库存物料 ITEM__1 不存在'));
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_FOUND');
  });

  it('service 抛未知错 → MOVEMENT_FAILED', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockRejectedValue(new Error('db connection lost'));
    const r = await commitInventoryAdjustStock({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('MOVEMENT_FAILED');
  });
});

describe('task inventory-flow: verifyInventoryAdjustStockDraftHash', () => {
  it('原始 draft hash 自洽', () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    expect(verifyInventoryAdjustStockDraftHash(draft).ok).toBe(true);
  });
});

describe('task inventory-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: InventoryFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'INVALID_INPUT', 'INVALID_MOVEMENT_TYPE', 'MISSING_TARGET_WAREHOUSE',
      'NOT_FOUND', 'INSUFFICIENT_STOCK', 'MOVEMENT_FAILED',
    ];
    for (const code of codes) expect(buildInventoryFlowError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
