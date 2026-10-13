import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildPaymentVoucherCreateDraft, buildPaymentVoucherUpdateDraft } from '../paymentVoucherMutationFlow';

vi.mock('../../finance/paymentVoucherMutationService', () => ({
  createPaymentVoucher: vi.fn(),
  updatePaymentVoucher: vi.fn(),
  VALID_PAYMENT_VOUCHER_STATUS: ['unreconciled', 'partially_reconciled', 'reconciled'],
  PAYMENT_VOUCHER_CREATE_FIELDS: ['voucherNumber','type','amount','currency','paymentDate','paymentMethod','status','bankFee','exchangeRate','baseCurrency','invoiceId','appliedAmount','orderId','customerRelationId','customerName','notes','attachments'],
  PAYMENT_VOUCHER_PATCH_FIELDS: ['type','amount','currency','paymentDate','paymentMethod','bankFee','exchangeRate','baseCurrency','invoiceId','appliedAmount','orderId','customerRelationId','customerName','notes','attachments'],
}));
import { createPaymentVoucher, updatePaymentVoucher } from '../../finance/paymentVoucherMutationService';

const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
const createInput = { voucherNumber: 'PV-1', type: 'Receipt', amount: '100.0000', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT' };

describe('payment_voucher create/update executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('payment_voucher.create approved → committed', async () => {
    const draft = buildPaymentVoucherCreateDraft({ input: createInput });
    (createPaymentVoucher as any).mockResolvedValue({ ok: true, data: { voucher: { id: 'PAY__1' }, auditId: 'AL-1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:payment_voucher.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(createPaymentVoucher).toHaveBeenCalledTimes(1);
  });

  it('payment_voucher.update approved → committed', async () => {
    const draft = buildPaymentVoucherUpdateDraft({ voucherId: 'PAY__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    (updatePaymentVoucher as any).mockResolvedValue({ ok: true, data: { voucher: { id: 'PAY__1' }, auditId: 'AL-2' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:payment_voucher.update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.update', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(updatePaymentVoucher).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'payment_voucher.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(createPaymentVoucher).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.update', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(updatePaymentVoucher).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，create/update service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const createResult: any = await executeTool(prisma, { toolId: 'payment_voucher.create', input: {}, approvalId: 'AP-1' } as any);
    const updateResult: any = await executeTool(prisma, { toolId: 'payment_voucher.update', input: {}, approvalId: 'AP-1' } as any);
    expect(createResult.ok).toBe(false);
    expect(updateResult.ok).toBe(false);
    expect(createResult.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(updateResult.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(createPaymentVoucher).not.toHaveBeenCalled();
    expect(updatePaymentVoucher).not.toHaveBeenCalled();
  });
});

describe('payment_voucher create/update executeAgentTool draft-first', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create 首次 → approval_required + processDraft', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'AP-1' }) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.create', toolInput: { input: createInput }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('payment_voucher.create');
  });

  it('create 缺必填 → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.create', toolInput: { input: { voucherNumber: 'PV-1' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('create invalid amount → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.create', toolInput: { input: { ...createInput, amount: 'NaN' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('invalid decimal');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('create 非法字段 → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.create', toolInput: { input: { ...createInput, deletedAt: 1 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('create 非法 status → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.create', toolInput: { input: { ...createInput, status: 'paid' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('invalid status');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('update 首次 → approval_required + before snapshot', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'AP-1' }) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'PAY__1', amount: '100.0000', deletedAt: null }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.update', toolInput: { voucherId: 'PAY__1', patch: { amount: '120.0000' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.beforeAfterDiff[0].before).toBe('100.0000');
  });

  it('update 非法字段 → fail closed（不读 DB，不创建 approval）', async () => {
    const approvalCreate = vi.fn();
    const findUnique = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, paymentVoucher: { findUnique } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.update', toolInput: { voucherId: 'PAY__1', patch: { amount: '120.0000', deletedAt: 1 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable');
    expect(findUnique).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('update voucher 不存在/deletedAt → fail closed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'PAY__1', deletedAt: BigInt(1) }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.update', toolInput: { voucherId: 'PAY__1', patch: { amount: '120.0000' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});
