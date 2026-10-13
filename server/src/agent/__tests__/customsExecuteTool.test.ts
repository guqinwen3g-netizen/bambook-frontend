import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  buildCustomsRegisterLcDraft,
  buildCustomsUpdateDeclarationDraft,
  registerCustomsFlowTools,
} from '../customsFlow';

vi.mock('../../customs/customsService', () => ({
  createCustomsService: vi.fn(),
  LETTER_OF_CREDIT_CREATE_FIELDS: [
    'lcNumber', 'relationId', 'orderId', 'type', 'issueDate', 'issueBank', 'advisingBank',
    'negotiatingBank', 'confirmingBank', 'applicant', 'beneficiary', 'amount', 'currency',
    'availableAmount', 'expiryDate', 'expiryPlace', 'presentationDeadline', 'shipmentDeadline',
    'tradeTerms', 'portOfLoading', 'portOfDischarge', 'documentsRequired', 'specialConditions',
    'discrepancies', 'notes',
  ],
  CUSTOMS_DECLARATION_UPDATE_FIELDS: [
    'declarationNumber', 'shipmentId', 'orderId', 'relationId', 'type', 'declarationDate',
    'customsCode', 'declarationPort', 'tradeTerms', 'totalValue', 'currency', 'totalPackages',
    'grossWeight', 'netWeight', 'originCountry', 'destinationCountry', 'consignee', 'consignor',
    'declarant', 'agent', 'notes',
  ],
}));
import { createCustomsService } from '../../customs/customsService';

// 自注册：toolRuntime 的注册表优先分发命中本 Flow 的 commit handler
registerCustomsFlowTools();

const createLetterOfCredit = vi.fn();
const updateDeclaration = vi.fn();

const lcInput = {
  lcNumber: 'LC-2026-0001',
  type: 'Irrevocable',
  amount: 120000,
  currency: 'USD',
  applicant: 'Globex Apparel',
  beneficiary: 'Bambook Textile',
  expiryDate: '2026-12-31',
};

describe('task customs-flow: executeTool commit（注册表分发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createCustomsService as any).mockReturnValue({ createLetterOfCredit, updateDeclaration });
  });

  it('customs.register_lc approved → committed', async () => {
    const draft = buildCustomsRegisterLcDraft({ input: lcInput });
    createLetterOfCredit.mockResolvedValue({ id: 'LC__1', lcNumber: 'LC-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:customs.register_lc', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.register_lc', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.entityId).toBe('LC__1');
    expect(result.documentNumber).toBe('LC-2026-0001');
    expect(createLetterOfCredit).toHaveBeenCalledTimes(1);
  });

  it('customs.update_declaration 旧审批重放被拒绝，service 不可写历史报关记录', async () => {
    const draft = buildCustomsUpdateDeclarationDraft({ declarationId: 'CD__1', patch: { declarationPort: '上海港' }, currentSnapshot: { declarationPort: '宁波港' } });
    updateDeclaration.mockResolvedValue({ id: 'CD__1', declarationNumber: 'CD-2026-0001' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:customs.update_declaration', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.update_declaration', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('EXTERNAL_DECLARATION_REQUIRED');
    expect(updateDeclaration).not.toHaveBeenCalled();
  });

  it('无 approvalId → APPROVAL_ID_MISSING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.register_lc', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(createLetterOfCredit).not.toHaveBeenCalled();
  });

  it('approval 不存在 → APPROVAL_NOT_FOUND，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.update_declaration', input: {}, approvalId: 'AP-X' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
    expect(updateDeclaration).not.toHaveBeenCalled();
  });

  it('approval pending → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.register_lc', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(createLetterOfCredit).not.toHaveBeenCalled();
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'customs.update_declaration', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(updateDeclaration).not.toHaveBeenCalled();
  });
});

describe('task customs-flow: executeTool 全链路重放幂等（receipt 收口层）', () => {
  function makeReceiptAwarePrisma(draft: any) {
    const receipts = new Map<string, any>();
    const prisma = {
      approvalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:customs.register_lc', payload: { processDraft: draft } }),
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
    (createCustomsService as any).mockReturnValue({ createLetterOfCredit, updateDeclaration });
  });

  it('同一 approvalId 重放 → service 仅执行一次，第二次返回缓存结果（replayed）', async () => {
    const draft = buildCustomsRegisterLcDraft({ input: lcInput });
    createLetterOfCredit.mockResolvedValue({ id: 'LC__1', lcNumber: 'LC-2026-0001' });
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'customs.register_lc', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('committed');
    expect(createLetterOfCredit).toHaveBeenCalledTimes(1);
    expect(receipts.get('commit:customs.register_lc:AP1')?.status).toBe('committed');

    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(createLetterOfCredit).toHaveBeenCalledTimes(1);
  });

  it('commit 失败 → receipt 删除允许修复后重试（不留永久阻塞）', async () => {
    const draft = buildCustomsRegisterLcDraft({ input: lcInput });
    createLetterOfCredit.mockRejectedValueOnce(new Error('db connection lost'));
    const { prisma, receipts } = makeReceiptAwarePrisma(draft);
    const call = { toolId: 'customs.register_lc', input: {}, approvalId: 'AP1' } as any;

    const first: any = await executeTool(prisma, call);
    expect(first.ok).toBe(false);
    expect(receipts.has('commit:customs.register_lc:AP1')).toBe(false);

    createLetterOfCredit.mockResolvedValue({ id: 'LC__1', lcNumber: 'LC-2026-0001' });
    const second: any = await executeTool(prisma, call);
    expect(second.ok).toBe(true);
    expect(second.status).toBe('committed');
    expect(createLetterOfCredit).toHaveBeenCalledTimes(2);
  });
});
