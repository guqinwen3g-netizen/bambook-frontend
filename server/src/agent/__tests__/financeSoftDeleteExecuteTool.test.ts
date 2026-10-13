import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildInvoiceDeleteDraft, buildPaymentVoucherDeleteDraft } from '../financeSoftDeleteFlow';

vi.mock('../../finance/voidDeleteService', () => ({
  deleteInvoice: vi.fn(),
  deleteVoucher: vi.fn(),
}));
import { deleteInvoice, deleteVoucher } from '../../finance/voidDeleteService';

describe('task finance-soft-delete-flow: executeTool invoice.delete commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('approved → committed', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.delete', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('service 失败（HAS_ALLOCATIONS）→ failed', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: false, error: { code: 'HAS_ALLOCATIONS', message: 'has allocations' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
  });

  it('no service bypass', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.delete', payload: { processDraft: draft } }) } } as any;
    await executeTool(prisma, { toolId: 'invoice.delete', input: {}, approvalId: 'AP1' } as any);
    expect(deleteInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('task finance-soft-delete-flow: executeTool payment_voucher.delete commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('approved → committed', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:payment_voucher.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.delete', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('service 失败（VOUCHER_NOT_FOUND）→ failed', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: false, error: { code: 'VOUCHER_NOT_FOUND', message: 'not found' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:payment_voucher.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_voucher.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
  });

  it('no service bypass', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:payment_voucher.delete', payload: { processDraft: draft } }) } } as any;
    await executeTool(prisma, { toolId: 'payment_voucher.delete', input: {}, approvalId: 'AP1' } as any);
    expect(deleteVoucher).toHaveBeenCalledTimes(1);
  });
});

describe('task finance-soft-delete-flow: executeAgentTool draft→approval', () => {
  it('invoice.delete 首次调用 → approval_required + processDraft', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.delete', toolInput: { invoiceId: 'INV__1' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('invoice.delete');
  });

  it('payment_voucher.delete 首次调用 → approval_required + processDraft', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'PV__1', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.delete', toolInput: { voucherId: 'PV__1' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('payment_voucher.delete');
  });

  it('invoice.delete 缺 invoiceId → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.delete', toolInput: {}, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });

  it('invoice.delete invoice 不存在 → preconditions_failed（不创建 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue(null) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.delete', toolInput: { invoiceId: 'INV_MISSING' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or already deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('invoice.delete invoice 已 deletedAt → preconditions_failed（不创建 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', deletedAt: 1000 }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.delete', toolInput: { invoiceId: 'INV__1' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or already deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('invoice.delete invoice 存在且未 deletedAt → approval_required', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.delete', toolInput: { invoiceId: 'INV__1' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(approvalCreate).toHaveBeenCalledTimes(1);
  });

  it('payment_voucher.delete voucher 不存在 → preconditions_failed（不创建 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(null) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.delete', toolInput: { voucherId: 'PV_MISSING' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or already deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('payment_voucher.delete voucher 已 deletedAt → preconditions_failed（不创建 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue({ id: 'PV__1', deletedAt: 1000 }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'payment_voucher.delete', toolInput: { voucherId: 'PV__1' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or already deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});
