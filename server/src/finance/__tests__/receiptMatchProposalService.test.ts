import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReceiptMatchProposalService, isReceiptProposalConcurrencyConflict, normalizeReceiptMatchInput } from '../receiptMatchProposalService';

// These are bounded service contracts. They are not PG concurrency/rollback or
// mounted-router evidence; receiptAllocationRealDb owns those independent probes.
const seams = vi.hoisted(() => ({ context: undefined as any, visible: null as string[] | null,
  apply: vi.fn(), publish: vi.fn() }));
vi.mock('../../auth/permissionService', async original => ({ ...(await original<any>()),
  createPermissionService: () => ({ getUserPermissionContext: async () => seams.context }) }));
vi.mock('../../auth/orderVisibility', () => ({ resolveVisibleOrderIds: async () => seams.visible }));
vi.mock('../allocationService', async original => ({ ...(await original<any>()), applyAllocation: seams.apply }));
vi.mock('../allocationMutationService', () => ({ publishAllocationEvents: seams.publish }));
vi.mock('../receiptClaimService', () => ({ resolveInvoiceOrderIds: async () => ['order-visible'] }));

function fixture() {
  const rows = new Map<string, any>();
  const audits = new Map<string, any>();
  const tx: any = {
    receiptMatchProposal: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => { const row = rows.get(where.id); if (!row) throw new Error('missing fixture'); return row; }),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, requestedAmount: String(data.requestedAmount), decisionActorId: null, decidedAt: null, decisionNote: null, allocationId: null }; rows.set(data.id, row); return row; }),
      findMany: vi.fn(async ({ where }: any) => [...rows.values()].filter(row => !where.requesterId || row.requesterId === where.requesterId)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || row.status !== where.status || row.revision !== where.revision || row.payloadFingerprint !== where.payloadFingerprint) return { count: 0 };
        rows.set(row.id, { ...row, ...data, revision: row.revision + 1 }); return { count: 1 };
      }),
    },
    invoice: { findFirst: vi.fn(async () => ({ id: 'invoice', type: 'Receivable', status: 'Issued', currency: 'USD', amount: '100', orderId: 'order-visible' })) },
    paymentVoucher: {
      findFirst: vi.fn(async () => ({ id: 'voucher', type: 'Receipt', status: 'unreconciled', currency: 'USD', amount: '100', customerRelationId: 'customer-visible', deletedAt: null })),
      findUnique: vi.fn(async () => ({ id: 'voucher', type: 'Receipt', status: 'unreconciled', currency: 'USD', amount: '100', customerRelationId: 'customer-visible', deletedAt: null })),
    },
    order: { findMany: vi.fn(async () => [{ customerRelationId: 'customer-visible' }]) },
    invoiceAllocation: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    creditNoteAllocation: { findMany: vi.fn(async () => []) },
    auditLog: { findUnique: vi.fn(async ({ where }: any) => audits.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { audits.set(data.id, data); return data; }) },
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []), // Ordinary receipt; interface seam, not PG locking proof.
    creditNoteRefund: { findUnique: vi.fn(async () => null) },
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (callback: any) => callback(tx)) };
  return { rows, audits, tx, prisma, service: createReceiptMatchProposalService(prisma) };
}
const input = { voucherId: 'voucher', invoiceId: 'invoice', currency: 'USD', amount: '25.1234', note: 'customer supplied matching reference', requestId: 'proposal-1' };
const actor = { userId: 'sales-real-subject' };
function permissions(userId: string, scopes: string[]) {
  seams.context = { userId, roleIds: ['custom-role'], legacyRoleCodes: [], departmentIds: [], scopes };
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions(actor.userId, ['invoices:read', 'invoices:suggest_match']);
  seams.visible = null;
  seams.publish.mockResolvedValue(undefined);
  seams.apply.mockResolvedValue({ allocationId: 'allocation-real-inner-result', newInvoiceStatus: 'PartiallyPaid',
    newVoucherStatus: 'partially_reconciled', voucherAppliedAmount: { toString: () => '25.1234' }, auditId: 'allocation-audit', thirdPartyPayment: null });
});

describe('receipt proposal: independent suggestion and finance confirmation contracts', () => {
  it('recognizes raw SQL serialization specifically; unrelated P2010/P2003 and message text never become a 409 conflict', () => {
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2034' })).toBe(true);
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2010', meta: { code: '23503' } })).toBe(false);
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2010', meta: { code: '42601' } })).toBe(false);
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2003' })).toBe(false);
    expect(isReceiptProposalConcurrencyConflict({ code: 'P2010' })).toBe(false);
    expect(isReceiptProposalConcurrencyConflict({ message: 'SQLSTATE 40001' } as any)).toBe(false);
  });
  it.each([0, -1, '0.00001', '100000000000000', '', null, Infinity])('does not fabricate a valid positive four-decimal amount from %s', amount => {
    expect(() => normalizeReceiptMatchInput({ ...input, amount })).toThrow(/金额/);
  });
  it('a valid exact four-decimal proposal stores an actual actor audit and writes no allocation', async () => {
    const f = fixture();
    const result = await f.service.submit(actor, input);
    expect(result.item).toMatchObject({ requesterId: actor.userId, status: 'Pending', revision: 1, requestedAmount: '25.1234', currency: 'USD' });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: actor.userId, action: 'receipt_match_proposed' }) }));
    expect(seams.apply).not.toHaveBeenCalled();
    expect(seams.publish).not.toHaveBeenCalled();
  });
  it('loaded empty authorization refuses submit even when the caller supplies a legacy sales role', async () => {
    permissions(actor.userId, []);
    const f = fixture();
    await expect(f.service.submit({ ...actor, roles: ['sales'] } as any, input)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.tx.receiptMatchProposal.create).not.toHaveBeenCalled();
  });
  it('same actor/request/content replays without duplicate proposal, while changed note or amount conflicts', async () => {
    const f = fixture();
    const original = await f.service.submit(actor, input);
    expect((await f.service.submit(actor, { ...input, amount: '25.1234000' })).replayed).toBe(true);
    expect(f.tx.receiptMatchProposal.create).toHaveBeenCalledTimes(1);
    expect((await f.service.submit(actor, input)).item.id).toBe(original.item.id);
    await expect(f.service.submit(actor, { ...input, note: 'different request content' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(f.service.submit(actor, { ...input, amount: '26' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('same-content replay rechecks current source visibility before returning a historical result', async () => {
    const f = fixture();
    await f.service.submit(actor, input);
    seams.visible = [];
    await expect(f.service.submit(actor, input)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
  it('sales without explicit reconcile cannot confirm their own pending suggestion', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    await expect(f.service.decide(actor, created.item.id, 'Confirmed', { revision: 1, requestId: 'decision-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.rows.get(created.item.id).status).toBe('Pending');
    expect(seams.apply).not.toHaveBeenCalled();
  });
  it('finance confirms the unchanged amount once, preserves actual actor and delivers only after transaction completion', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    permissions('finance-real-subject', ['invoices:read', 'invoices:reconcile']);
    const request = { revision: 1, requestId: 'confirm-1', note: 'checked bank evidence' };
    const confirmed = await f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Confirmed', request);
    expect(confirmed.item).toMatchObject({ status: 'Confirmed', revision: 2, decisionActorId: 'finance-real-subject', requestedAmount: '25.1234', allocationId: 'allocation-real-inner-result' });
    expect(seams.apply).toHaveBeenCalledWith(f.prisma, f.tx, expect.objectContaining({ actorId: 'finance-real-subject', appliedAmount: '25.1234' }));
    expect(seams.publish).toHaveBeenCalledTimes(1);
    expect(seams.publish.mock.invocationCallOrder[0]).toBeGreaterThan(f.tx.auditLog.create.mock.invocationCallOrder.at(-1)!);
    expect((await f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Confirmed', request)).replayed).toBe(true);
    expect(seams.apply).toHaveBeenCalledTimes(1);
    expect(seams.publish).toHaveBeenCalledTimes(1);
    await expect(f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Confirmed', { ...request, note: 'new content' })).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
  });
  it('required decision audit failure never emits a committed allocation event (unit evidence only)', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    permissions('finance-real-subject', ['invoices:reconcile']);
    f.tx.auditLog.create.mockRejectedValueOnce(new Error('synthetic mandatory audit failure'));
    await expect(f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Confirmed', { revision: 1, requestId: 'audit-failure' })).rejects.toThrow('synthetic mandatory audit failure');
    expect(seams.publish).not.toHaveBeenCalled();
    // No rollback assertion on an in-memory mock. Only the real PG fault probe
    // may establish that ledger, projections and proposal all remained unchanged.
  });
  it('only the requester withdraws; a finance rejection has a reason and cannot be overwritten', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    permissions('other-sales', ['invoices:suggest_match']);
    await expect(f.service.decide({ userId: 'other-sales' }, created.item.id, 'Withdrawn', { revision: 1, requestId: 'foreign-withdraw' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    permissions('finance-real-subject', ['invoices:reconcile']);
    await expect(f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Rejected', { revision: 1, requestId: 'reject-empty' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const rejected = await f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Rejected', { revision: 1, requestId: 'reject-reason', note: 'wrong invoice reference' });
    expect(rejected.item).toMatchObject({ status: 'Rejected', decisionNote: 'wrong invoice reference', allocationId: null });
    await expect(f.service.decide({ userId: 'finance-real-subject' }, created.item.id, 'Confirmed', { revision: 2, requestId: 'cannot-reopen' })).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    expect(seams.apply).not.toHaveBeenCalled();
  });
  it('current DB suggest grant is limited by the signed read-only ceiling', async () => {
    const f = fixture();
    permissions(actor.userId, ['invoices:read', 'invoices:suggest_match']);
    await expect(f.service.submit({ ...actor, permissionCeiling: ['invoices:read'] }, input))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.tx.receiptMatchProposal.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('current DB reconcile grant is limited by the signed read-only ceiling', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    permissions('finance-real-subject', ['invoices:read', 'invoices:reconcile']);
    await expect(f.service.decide({ userId: 'finance-real-subject', permissionCeiling: ['invoices:read'] },
      created.item.id, 'Confirmed', { revision: 1, requestId: 'read-ceiling-confirm' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.rows.get(created.item.id).status).toBe('Pending');
    expect(seams.apply).not.toHaveBeenCalled();
    expect(seams.publish).not.toHaveBeenCalled();
  });
  it('wildcard ceiling permits the actual DB suggestion and reconcile grants', async () => {
    const f = fixture();
    const created = await f.service.submit({ ...actor, permissionCeiling: ['*'] }, input);
    permissions('finance-real-subject', ['invoices:read', 'invoices:reconcile']);
    const confirmed = await f.service.decide({ userId: 'finance-real-subject', permissionCeiling: ['*'] },
      created.item.id, 'Confirmed', { revision: 1, requestId: 'wildcard-ceiling-confirm' });
    expect(confirmed.item.status).toBe('Confirmed');
    expect(seams.apply).toHaveBeenCalledTimes(1);
    expect(seams.apply).toHaveBeenCalledWith(f.prisma, f.tx, expect.objectContaining({ actorId: 'finance-real-subject' }));
  });
  it('client body permission labels cannot supply a revoked DB suggestion grant', async () => {
    const f = fixture();
    permissions(actor.userId, ['invoices:read']);
    await expect(f.service.submit({ ...actor, permissions: ['*'], roles: ['owner'], permissionCeiling: ['*'] } as any,
      { ...input, permissions: ['invoices:suggest_match'] } as any))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.tx.receiptMatchProposal.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('a revoked DB reconcile grant stays rejected with a wildcard ceiling and supplied finance labels', async () => {
    const f = fixture();
    const created = await f.service.submit(actor, input);
    permissions('finance-real-subject', ['invoices:read']);
    await expect(f.service.decide({ userId: 'finance-real-subject', roles: ['finance'], permissions: ['invoices:reconcile'], permissionCeiling: ['*'] } as any,
      created.item.id, 'Confirmed', { revision: 1, requestId: 'revoked-confirm', permissions: ['invoices:reconcile'] } as any))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.rows.get(created.item.id).status).toBe('Pending');
    expect(seams.apply).not.toHaveBeenCalled();
    expect(seams.publish).not.toHaveBeenCalled();
  });

});
