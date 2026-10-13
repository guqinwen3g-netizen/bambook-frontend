import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  buildProcurementCreateDraft,
  buildProcurementUpdateStatusDraft,
  registerProcurementFlowTools,
} from '../procurementFlow';

vi.mock('../../procurement/procurementService', () => ({
  createProcurementService: vi.fn(),
  MANUAL_PURCHASE_ORDER_TRANSITION_TARGETS: ['Sent', 'Confirmed', 'Cancelled', 'Closed'],
  PURCHASE_ORDER_CREATE_FIELDS: [
    'poNumber', 'currency', 'supplierRelationId', 'supplierName', 'supplierCode', 'orderDate',
    'expectedDeliveryDate', 'deliveryTerms', 'paymentTerms', 'shipToAddress', 'orderId', 'quotationId',
    'bomId', 'buyer', 'exchangeRate', 'baseCurrency', 'notes', 'lines',
  ],
}));
import { createProcurementService } from '../../procurement/procurementService';

// 自注册：toolRuntime 的注册表优先分发命中本 Flow 的 commit handler
// （主控合并接线前，测试内显式注册；registerTool 重复注册仅 warn 覆盖，无副作用）
registerProcurementFlowTools();

const createPurchaseOrder = vi.fn();
const transitionPurchaseOrderStatus = vi.fn();

const createInput = {
  poNumber: 'PO-2026-0001',
  currency: 'USD',
  supplierName: 'Acme Textile',
  orderDate: '2026-08-17',
  lines: [{ description: 'Cotton Fabric', unit: 'm', quantity: 1000, unitPrice: 2.5 }],
};

describe('task procurement-flow: executeTool commit（注册表分发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createProcurementService as any).mockReturnValue({ createPurchaseOrder, transitionPurchaseOrderStatus });
  });

  it('procurement.create approved → committed', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:procurement.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.purchaseOrderId).toBe('PO__1');
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it('procurement.update_status approved → committed', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Sent', currentStatus: 'Draft' });
    transitionPurchaseOrderStatus.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:procurement.update_status', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.update_status', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('无 approvalId → APPROVAL_ID_MISSING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('approval 不存在 → APPROVAL_NOT_FOUND，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.create', input: {}, approvalId: 'AP-X' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('approval pending → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.update_status', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'procurement.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('task procurement-flow: executeTool 全链路重放幂等（receipt 收口层）', () => {
  function makeReceiptAwarePrisma(draft: any) {
    const receipts = new Map<string, any>();
    const prisma = {
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:procurement.create', payload: { processDraft: draft } }),
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
    (createProcurementService as any).mockReturnValue({ createPurchaseOrder, transitionPurchaseOrderStatus });
  });

  it('同一 approvalId 重放 → service 仅执行一次，第二次返回缓存结果（replayed）', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'procurement.create', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('committed');
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(receipts.get('commit:procurement.create:AP1')?.status).toBe('committed');

    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it('commit 失败 → receipt 删除允许修复后重试（不留永久阻塞）', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockRejectedValueOnce(new Error('db connection lost'));
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'procurement.create', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(false);
    expect(receipts.has('commit:procurement.create:AP1')).toBe(false);

    createPurchaseOrder.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('committed');
    expect(createPurchaseOrder).toHaveBeenCalledTimes(2);
  });
});
