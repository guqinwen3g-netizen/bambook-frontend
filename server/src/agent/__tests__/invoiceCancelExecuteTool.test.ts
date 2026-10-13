import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildInvoiceCancelDraft } from '../invoiceCancelFlow';

vi.mock('../../finance/voidDeleteService', () => ({
  cancelInvoice: vi.fn(),
}));
import { cancelInvoice } from '../../finance/voidDeleteService';

describe('task invoice-cancel-flow: executeTool commit 路径', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skipApprovalCheck + approved → committed', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'a1' } });
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.cancel', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.cancel', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.invoiceId).toBe('INV__1');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.cancel', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.cancel', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.cancel', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('service 失败（CANCEL_FAILED）→ failed（不伪 committed）', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: false, error: { code: 'CANCEL_FAILED', message: 'sync reject' } });
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.cancel', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'invoice.cancel', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect((result as any).error?.code || (result as any).errorFeedback?.code).toBe('CANCEL_FAILED');
  });

  it('no service bypass：executeTool 只调 cancelInvoice', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'a1' } });
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:invoice.cancel', payload: { processDraft: draft } }) },
    } as any;
    await executeTool(prisma, { toolId: 'invoice.cancel', input: {}, approvalId: 'AP1' } as any);
    expect(cancelInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('task invoice-cancel-flow: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft（before 用真实 status）', async () => {
    let createdApproval: any = null;
    const prisma = {
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', status: 'PartiallyPaid', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'invoice.cancel',
      toolInput: { invoiceId: 'INV__1', reason: '客户退货' },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect((result.processDraft.subOperations[0].after as any).invoiceId).toBe('INV__1');
    // beforeAfterDiff 用真实 status（PartiallyPaid），不 hardcode
    expect(result.processDraft.beforeAfterDiff[0].before).toBe('PartiallyPaid');
    expect(createdApproval.payload.processDraft).toBeTruthy();
  });

  it('首次调用缺 invoiceId → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'invoice.cancel',
      toolInput: { reason: 'test' },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('INVOICE_CANCEL_PRECONDITIONS_FAILED');
  });

  it('invoice 不存在 → preconditions_failed（读真实 invoice 校验）', async () => {
    const prisma = {
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      invoice: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'invoice.cancel',
      toolInput: { invoiceId: 'INV_MISSING' },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or deleted');
  });
});
