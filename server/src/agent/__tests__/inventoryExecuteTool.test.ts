import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import { buildInventoryAdjustStockDraft, registerInventoryFlowTools } from '../inventoryFlow';

vi.mock('../../inventory/inventoryService', () => ({
  createInventoryService: vi.fn(),
  VALID_MOVEMENT_TYPES: ['Inbound', 'Outbound', 'Transfer', 'Adjustment', 'Lock', 'Unlock'],
  STOCK_MOVEMENT_INPUT_FIELDS: [
    'itemId', 'type', 'quantity', 'unit', 'unitCost', 'targetWarehouseId',
    'reason', 'referenceType', 'referenceId', 'movementDate', 'notes',
  ],
}));
import { createInventoryService } from '../../inventory/inventoryService';

// 自注册：toolRuntime 的注册表优先分发命中本 Flow 的 commit handler
registerInventoryFlowTools();

const createStockMovement = vi.fn();

const movementInput = { itemId: 'ITEM__1', type: 'Outbound', quantity: 50, unit: 'm', reason: '生产领料' };

describe('task inventory-flow: executeTool commit（注册表分发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createInventoryService as any).mockReturnValue({ createStockMovement });
  });

  it('inventory.adjust_stock approved → committed', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockResolvedValue({ id: 'MOV__1' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:inventory.adjust_stock', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.movementId).toBe('MOV__1');
    expect(createStockMovement).toHaveBeenCalledTimes(1);
  });

  it('无 approvalId → APPROVAL_ID_MISSING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'inventory.adjust_stock', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('approval 不存在 → APPROVAL_NOT_FOUND，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP-X' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('approval pending → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(createStockMovement).not.toHaveBeenCalled();
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(createStockMovement).not.toHaveBeenCalled();
  });
});

describe('task inventory-flow: executeTool 全链路重放幂等（receipt 收口层）', () => {
  function makeReceiptAwarePrisma(draft: any) {
    const receipts = new Map<string, any>();
    const prisma = {
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:inventory.adjust_stock', payload: { processDraft: draft } }),
      },
      agentCommitReceipt: {
        create: vi.fn(async ({ data }: any) => {
          if (receipts.has(data.idempotencyKey)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          receipts.set(data.idempotencyKey, { ...data });
          return data;
        }),
        findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const updated = { ...receipts.get(where.idempotencyKey), ...data };
          receipts.set(where.idempotencyKey, updated);
          return updated;
        }),
        delete: vi.fn(async ({ where }: any) => { receipts.delete(where.idempotencyKey); return {}; }),
      },
    } as any;
    return { prisma, receipts };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (createInventoryService as any).mockReturnValue({ createStockMovement });
  });

  it('同一 approvalId 重放 → service 仅执行一次，第二次返回缓存结果（replayed）', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockResolvedValue({ id: 'MOV__1' });
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('committed');
    expect(createStockMovement).toHaveBeenCalledTimes(1);
    expect(receipts.get('commit:inventory.adjust_stock:AP1')?.status).toBe('committed');

    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(createStockMovement).toHaveBeenCalledTimes(1);
  });

  it('commit 失败 → receipt 删除允许修复后重试（不留永久阻塞）', async () => {
    const draft = buildInventoryAdjustStockDraft({ movement: movementInput });
    createStockMovement.mockRejectedValueOnce(new Error('db connection lost'));
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'inventory.adjust_stock', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(false);
    expect(receipts.has('commit:inventory.adjust_stock:AP1')).toBe(false);

    createStockMovement.mockResolvedValue({ id: 'MOV__1' });
    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('committed');
    expect(createStockMovement).toHaveBeenCalledTimes(2);
  });
});
