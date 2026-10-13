import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  buildQuotationCreateDraft,
  buildQuotationUpdateDraft,
  registerQuotationFlowTools,
} from '../quotationFlow';

vi.mock('../../quotations/quotationService', () => ({
  createQuotationService: vi.fn(),
  QUOTATION_CREATE_FIELDS: [
    'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
    'validUntil', 'deliveryTerms', 'paymentTerms', 'salesperson', 'inquiryRef', 'exchangeRate',
    'baseCurrency', 'notes', 'lines', 'trackAMedianUsd', 'trackAUnit', 'trackBFinalUsd',
  ],
  QUOTATION_UPDATE_PATCH_FIELDS: [
    'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
    'validUntil', 'deliveryTerms', 'paymentTerms', 'salesperson', 'inquiryRef', 'exchangeRate',
    'baseCurrency', 'notes', 'lines',
  ],
}));
import { createQuotationService } from '../../quotations/quotationService';

// 自注册：toolRuntime 的注册表优先分发命中本 Flow 的 commit handler
registerQuotationFlowTools();

const createQuotation = vi.fn();
const updateQuotation = vi.fn();

const createInput = {
  quotationNumber: 'Q-2026-0001',
  currency: 'USD',
  customerName: 'Globex Apparel',
  issueDate: '2026-08-17',
  lines: [{ description: 'Wool Blend Fabric', unit: 'm', quantity: 500, unitPrice: 8.2 }],
};

describe('task quotation-flow: executeTool commit（注册表分发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createQuotationService as any).mockReturnValue({ createQuotation, updateQuotation });
  });

  it('quotation.create approved → committed', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:quotation.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.quotationId).toBe('Q__1');
    expect(createQuotation).toHaveBeenCalledTimes(1);
  });

  it('quotation.update approved → committed', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { paymentTerms: 'TT 30天' }, currentSnapshot: { paymentTerms: 'TT' } });
    updateQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:quotation.update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(updateQuotation).toHaveBeenCalledTimes(1);
  });

  it('无 approvalId → APPROVAL_ID_MISSING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('approval 不存在 → APPROVAL_NOT_FOUND，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.update', input: {}, approvalId: 'AP-X' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
    expect(updateQuotation).not.toHaveBeenCalled();
  });

  it('approval pending → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'quotation.update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(updateQuotation).not.toHaveBeenCalled();
  });
});

describe('task quotation-flow: executeTool 全链路重放幂等（receipt 收口层）', () => {
  function makeReceiptAwarePrisma(draft: any) {
    const receipts = new Map<string, any>();
    const prisma = {
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:quotation.create', payload: { processDraft: draft } }),
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
    (createQuotationService as any).mockReturnValue({ createQuotation, updateQuotation });
  });

  it('同一 approvalId 重放 → service 仅执行一次，第二次返回缓存结果（replayed）', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'quotation.create', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('committed');
    expect(createQuotation).toHaveBeenCalledTimes(1);
    expect(receipts.get('commit:quotation.create:AP1')?.status).toBe('committed');

    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(createQuotation).toHaveBeenCalledTimes(1);
  });

  it('commit 失败 → receipt 删除允许修复后重试（不留永久阻塞）', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockRejectedValueOnce(new Error('db connection lost'));
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'quotation.create', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(false);
    expect(receipts.has('commit:quotation.create:AP1')).toBe(false);

    createQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('committed');
    expect(createQuotation).toHaveBeenCalledTimes(2);
  });
});
