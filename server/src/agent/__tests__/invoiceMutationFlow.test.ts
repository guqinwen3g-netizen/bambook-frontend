import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';
import { buildInvoiceCreateDraft, commitInvoiceCreate, buildInvoiceUpdateDraft, commitInvoiceUpdate } from '../invoiceMutationFlow';
vi.mock('../../finance/invoiceMutationService', () => ({ createInvoice: vi.fn(), updateInvoice: vi.fn(), INVOICE_CREATE_FIELDS: ['invoiceNumber','type','status','amount','currency','issueDate','dueDate','exchangeRate','baseCurrency','orderId','customerRelationId','customerName','notes','attachments'], INVOICE_PATCH_FIELDS: ['type','status','amount','currency','issueDate','dueDate','exchangeRate','baseCurrency','orderId','customerRelationId','customerName','notes','attachments'] }));
import { createInvoice, updateInvoice } from '../../finance/invoiceMutationService';
// Storage/credential seam only: the real permission loader runs against an
// active, undeleted technical operator with explicit role grants and no personal
// overrides. This does not prove real DB authority or create an approval fact.
function authorityPrisma(extra: any = {}) {
  return { ...extra, department: { findMany: vi.fn(async () => []) }, userAccount: { ...extra.userAccount,
    findUnique: vi.fn(async ({ where }: any) => where.id === SYSTEM_AUDIT_ACTOR ? {
      id: SYSTEM_AUDIT_ACTOR, status: 'active', deletedAt: null, primaryDeptId: 'synthetic-finance-department',
      primaryDepartment: { id: 'synthetic-finance-department', status: 'active', parentId: 'synthetic-company', metadata: { businessAttributes: ['finance'] } },
      roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin',
        permissions: [{ permission: { scope: 'invoices:write' } }] } }],
    } : null),
  }, userPermissionOverrides: { findMany: vi.fn(async () => []) } } as any;
}
const trustedToken = { userId: SYSTEM_AUDIT_ACTOR, roles: ['admin'], roleIds: ['role-admin'], departmentIds: [],
  permissions: ['invoices:write'], authorizationLoaded: true, permissionCeiling: ['invoices:write'] } as any;
const input = { invoiceNumber: 'INV-1', type: 'Receivable', amount: '100.0000', currency: 'USD', issueDate: '2026-07-02' };
describe('invoiceMutationFlow', () => {
  beforeEach(() => vi.clearAllMocks());
  it('create draft + commit 复用 createInvoice', async () => {
    const draft = buildInvoiceCreateDraft({ input });
    expect(draft.subOperations[0].toolId).toBe('invoice.create');
    expect(draft.beforeAfterDiff.length).toBeGreaterThan(0);
    (createInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'AL-1' } });
    const r = await commitInvoiceCreate({ prisma: authorityPrisma(), trustedActor: trustedToken, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({ input, actorId: SYSTEM_AUDIT_ACTOR }));
  });
  it('create hash mismatch 不调用 service', async () => {
    const draft = buildInvoiceCreateDraft({ input });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...input, amount: '999' } }] };
    const r = await commitInvoiceCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    expect(createInvoice).not.toHaveBeenCalled();
  });
  it('update draft + commit 复用 updateInvoice', async () => {
    const draft = buildInvoiceUpdateDraft({ invoiceId: 'INV__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    (updateInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'AL-2' } });
    const r = await commitInvoiceUpdate({ prisma: authorityPrisma(), trustedActor: trustedToken, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(updateInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'INV__1', input: { amount: '120.0000' }, actorId: SYSTEM_AUDIT_ACTOR }));
  });
  it('update hash mismatch 不调用 service', async () => {
    const draft = buildInvoiceUpdateDraft({ invoiceId: 'INV__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { invoiceId: 'INV__1', patch: { amount: '999' } } }] };
    const r = await commitInvoiceUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    expect(updateInvoice).not.toHaveBeenCalled();
  });
});
