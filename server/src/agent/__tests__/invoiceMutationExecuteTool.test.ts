import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';
import path from 'path';
import { executeTool as actualExecuteTool, executeAgentTool } from '../toolRuntime';
import { buildInvoiceCreateDraft, buildInvoiceUpdateDraft } from '../invoiceMutationFlow';
vi.mock('../../finance/invoiceMutationService', () => ({ createInvoice: vi.fn(), updateInvoice: vi.fn(), INVOICE_CREATE_FIELDS: ['invoiceNumber','type','status','amount','currency','issueDate','dueDate','exchangeRate','baseCurrency','orderId','customerRelationId','customerName','notes','attachments'], INVOICE_PATCH_FIELDS: ['type','status','amount','currency','issueDate','dueDate','exchangeRate','baseCurrency','orderId','customerRelationId','customerName','notes','attachments'] }));
import { createInvoice, updateInvoice } from '../../finance/invoiceMutationService';
// Storage/credential seam only: the real permission loader runs against an
// active, undeleted technical operator with explicit role grants and no personal
// overrides. This does not prove real DB authority or create an approval fact.
const trustedSystemActor = { userId: SYSTEM_AUDIT_ACTOR, roles: ['admin'], departmentIds: [],
  permissionScopes: ['invoices:write'], permissionsAuthoritative: true, permissionCeiling: ['invoices:write'],
  memoryScopes: [], knowledgeScopes: ['company'], toolScopes: ['finance'] } as any;
function authorityPrisma(extra: any = {}) {
  return { ...extra, userAccount: { ...extra.userAccount,
    findUnique: vi.fn(async ({ where }: any) => where.id === SYSTEM_AUDIT_ACTOR ? {
      id: SYSTEM_AUDIT_ACTOR, status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin',
        permissions: [{ permission: { scope: 'invoices:write' } }] } }],
    } : null),
  }, userPermissionOverrides: { findMany: vi.fn(async () => []) } } as any;
}
const trustedContext = { actorId: SYSTEM_AUDIT_ACTOR, actor: trustedSystemActor };
const executeTool = (prisma: any, call: any) => actualExecuteTool(prisma, call, trustedContext);
const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance','relations'], knowledgeScopes: ['company'], departmentIds: [] } as any;
const input = { invoiceNumber: 'INV-1', type: 'Receivable', amount: '100.0000', currency: 'USD', issueDate: '2026-07-02' };
describe('invoice.create/update executeTool + executeAgentTool', () => {
  beforeEach(() => vi.clearAllMocks());
  it('executeTool approved commits and pending/modified/missing fail closed', async () => {
    const draft = buildInvoiceCreateDraft({ input });
    (createInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'AL-1' } });
    const okPrisma = authorityPrisma({ approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:invoice.create', payload: { processDraft: draft } }) } });
    expect((await executeTool(okPrisma, { toolId: 'invoice.create', input: {}, approvalId: 'AP-1' } as any) as any).ok).toBe(true);
    const pending = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    expect((await executeTool(pending, { toolId: 'invoice.update', input: {}, approvalId: 'AP-1' } as any) as any).ok).toBe(false);
    const modified = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'modified', payload: {} }) } } as any;
    expect((await executeTool(modified, { toolId: 'invoice.update', input: {}, approvalId: 'AP-1' } as any) as any).errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect((await executeTool({} as any, { toolId: 'invoice.update', input: {} } as any) as any).errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });
  it('executeTool update approved commits via updateInvoice', async () => {
    const draft = buildInvoiceUpdateDraft({ invoiceId: 'INV__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    (updateInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'AL-2' } });
    const prisma = authorityPrisma({ approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:invoice.update', payload: { processDraft: draft } }) } });
    expect((await executeTool(prisma, { toolId: 'invoice.update', input: {}, approvalId: 'AP-1' } as any) as any).ok).toBe(true);
    expect(updateInvoice).toHaveBeenCalledTimes(1);
  });
  it('executeAgentTool create approval_required; missing/null amount and illegal field fail closed', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'AP-1' }) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const ok: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.create', toolInput: { input }, sessionId: 's1' });
    expect(ok.status).toBe('approval_required');
    const bad: any = await executeAgentTool({ prisma: { approvalRequest: { create: vi.fn() }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any, actor, toolId: 'invoice.create', toolInput: { input: { ...input, amount: null } }, sessionId: 's1' });
    expect(bad.status).toBe('preconditions_failed');
    const illegal: any = await executeAgentTool({ prisma: { approvalRequest: { create: vi.fn() }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any, actor, toolId: 'invoice.create', toolInput: { input: { ...input, deletedAt: 1 } }, sessionId: 's1' });
    expect(illegal.status).toBe('preconditions_failed');
  });
  it('executeAgentTool update approval_required; illegal patch/missing deleted fail closed', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'AP-1' }) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', amount: '100.0000', deletedAt: null }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const ok: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.update', toolInput: { invoiceId: 'INV__1', patch: { amount: '120.0000' } }, sessionId: 's1' });
    expect(ok.status).toBe('approval_required');
    const illegal: any = await executeAgentTool({ prisma: { approvalRequest: { create: vi.fn() }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, invoice: { findUnique: vi.fn() } } as any, actor, toolId: 'invoice.update', toolInput: { invoiceId: 'INV__1', patch: { deletedAt: 1 } }, sessionId: 's1' });
    expect(illegal.status).toBe('preconditions_failed');
    const deleted: any = await executeAgentTool({ prisma: { approvalRequest: { create: vi.fn() }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', deletedAt: BigInt(1) }) } } as any, actor, toolId: 'invoice.update', toolInput: { invoiceId: 'INV__1', patch: { amount: '1' } }, sessionId: 's1' });
    expect(deleted.status).toBe('preconditions_failed');
  });
  it('create explicit invalid transition status fails before approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.create', toolInput: { input: { ...input, status: 'Paid' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('cannot transition');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('update invalid transition status fails before approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, invoice: { findUnique: vi.fn().mockResolvedValue({ id: 'INV__1', status: 'Draft', deletedAt: null }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'invoice.update', toolInput: { invoiceId: 'INV__1', patch: { status: 'Paid' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('cannot transition');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('manifest exposes invoice.create/update', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    expect(manifest).toContain("id: 'invoice.create'");
    expect(manifest).toContain("id: 'invoice.update'");
  });
});
