/** Orchestration/storage substitutes only. Real Claim→Approval→CN and PostgreSQL
 * locks, concurrency, rollback and private-file upload are the opt-in PG probe. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createClaimCashRefundService } from '../claimCashRefundService';
import { appendRefundEvent, assertRefundHistory, cashRefundApprovalPayload, cashRefundReservedAmount,
  currentRefundActor, refundAmount, refundDate, refundPayee } from '../claimCashRefundFact';
import { creditNoteDigest } from '../claimCreditNoteVersionService';
import { createClaimCashRefundRequestService } from '../claimCashRefundRequestService';
import { refundFenceId } from '../claimCashRefundRequestFact';
// This file substitutes the canonical voucher producer; account/source locks
// are exercised by financeF1Integrity and the native company-cash acceptance.
vi.mock('../../finance/companyCashAccountService',()=>({assertVoucherCashUse:vi.fn(async()=>undefined)}));

vi.mock('../claimCreditNoteVersionService', async importOriginal => {
  const original = await importOriginal<any>();
  return { ...original, assertClaimCreditNoteAccount: vi.fn(async (_tx, note) => ({
    version: { id: 'V1', version: 1, contentFingerprint: 'version-fact' },
    open: new Prisma.Decimal(note.openAmount), reserved: new Prisma.Decimal(0), availableToSettle: new Prisma.Decimal(note.openAmount),
  })) };
});
vi.mock('../../finance/paymentVoucherMutationService', () => ({ createPaymentVoucher: vi.fn(async ({ tx, input }: any) => {
  const voucher = await tx.paymentVoucher.create({ data: { id: 'PV1', ...input, status: 'unreconciled' } });
  await tx.paymentRequest.update({ where: { id: input.paymentRequestId }, data: { status: 'Paid', paymentVoucherId: voucher.id } });
  return { ok: true, data: { voucher, auditId: 'producer-audit-substitute' } };
}) }));

const clone = (value: any): any => value instanceof Prisma.Decimal ? new Prisma.Decimal(value)
  : value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
async function fixture() {
  const T: Record<string, any[]> = {
    creditNote: [{ id: 'CN1', claimCaseId: 'CASE1', logicalClaimCaseId: 'CASE1', amount: new Prisma.Decimal(500), currentAmount: new Prisma.Decimal(500), openAmount: new Prisma.Decimal(500), currency: 'USD', customerRelationId: 'C1', customerName: 'Actual customer', status: 'Open' }],
    creditNoteDocumentVersion: [], creditNoteRefund: [], creditNoteRefundEvent: [], creditNoteRefundEvidence: [], creditNoteRefundReturn: [],
    claimCase: [{ id: 'CASE1', deletedAt: null }], claimCreditNoteLine: [],
    paymentRequest: [], approvalRequest: [], auditLog: [], paymentVoucher: [], creditNoteSettlementEvent: [],
    relation: [{ id: 'C1', name: 'Actual customer', category: 'Customer', deletedAt: null }],
    userAccount: [{ id: 'finance', status: 'active', deletedAt: null, roles: [{ roleId: 'role-finance', role: { id: 'role-finance', permissions: ['vouchers:write', 'vouchers:read', 'finance:payment_request:create'].map(scope => ({ permission: { scope } })) } }] }],
    userPermissionOverrides: [],
  };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'detail' && value?.path) return value.path.reduce((current: any, part: string) => current?.[part], row.detail) === value.equals;
    if (key.includes('_') && value && typeof value === 'object') return matches(row, value);
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
  const db: any = { $queryRawUnsafe: vi.fn(async () => []), T };
  for (const name of Object.keys(T)) db[name] = {
    findUnique: vi.fn(async ({ where }: any) => T[name].find(row => matches(row, where)) ?? null),
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      const rows = T[name].filter(row => matches(row, where));
      if (orderBy?.sequence === 'desc') rows.sort((a, b) => b.sequence - a.sequence);
      return rows[0] ?? null;
    }),
    findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
      const rows = T[name].filter(row => matches(row, where));
      if (orderBy?.sequence === 'asc') rows.sort((a, b) => a.sequence - b.sequence);
      return rows;
    }),
    create: vi.fn(async ({ data }: any) => { T[name].push({ ...data }); return T[name].at(-1); }),
    update: vi.fn(async ({ where, data }: any) => { const row = T[name].find(item => matches(item, where)); Object.assign(row, data); return row; }),
    updateMany: vi.fn(async ({ where, data }: any) => { const rows = T[name].filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; }),
  };
  db.$transaction = vi.fn(async (fn: any) => {
    const before = clone(T);
    try { return await fn(db); }
    catch (error) { for (const key of Object.keys(T)) T[key] = before[key]; throw error; }
  });
  const payeeSnapshot = refundPayee({ accountHolder: 'Actual customer', accountNumber: 'cust-account', bankName: 'Customer bank', method: 'TT' });
  const linesSnapshot = { schemaVersion: 1, claimCaseId: 'CASE1', customerRelationId: 'C1', lines: [{ id: 'line1' }] };
  T.creditNoteDocumentVersion.push({ id: 'V1', version: 1, creditNoteId: 'CN1', currency: 'USD', linesSnapshot, contentFingerprint: creditNoteDigest(linesSnapshot) });
  const parameters = { amount: '125', payeeSnapshot };
  const refund: any = { id: 'R1', creditNoteId: 'CN1', versionId: 'V1', paymentRequestId: 'PR1', customerRelationId: 'C1',
    amount: new Prisma.Decimal(125), currency: 'USD', payeeSnapshot, requesterId: 'sales', requestId: 'create-1', parameters,
    parametersHash: creditNoteDigest(parameters), status: 'PendingApproval', createdAt: BigInt(1) };
  const pr: any = { id: 'PR1', requestNumber: 'PAYR1', applicantId: 'sales', reviewerId: 'leader', payeeType: 'Customer',
    customerRelationId: 'C1', customerName: 'Actual customer', supplierId: null, supplierName: null,
    totalAmount: new Prisma.Decimal(125), currency: 'USD', paymentCategory: 'customer_reimburse', requestDate: '2026-10-01',
    expectedPaymentDate: '2026-10-03', status: 'Approved', approvalRequestId: 'A1' };
  T.creditNoteRefund.push(refund); T.paymentRequest.push(pr);
  const payload = await cashRefundApprovalPayload(db, refund, pr); refund.contentFingerprint = payload.contentFingerprint;
  T.approvalRequest.push({ id: 'A1', targetType: 'PaymentRequest', targetId: 'PR1', actionType: 'finance:payment_request',
    requesterId: 'sales', reviewerId: 'leader', status: 'approved', payload, decidedAt: new Date('2026-10-01T01:00:00Z') });
  T.auditLog.push({ id: 'DECISION1', actorId: 'leader', targetType: 'ApprovalRequest', targetId: 'A1', detail: {
    decisionActorAuthority: { authorizationLoaded: true, userId: 'leader', roleIds: ['role-admin'] },
    approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: 'finance:payment_request', targetType: 'PaymentRequest',
      targetId: 'PR1', contentFingerprint: payload.contentFingerprint, decisionActorId: 'leader', decidedAt: '2026-10-01T01:00:00.000Z' } } });
  await appendRefundEvent(db, refund, 'Requested', 'sales', 'create-1', { statusBefore: null, statusAfter: 'PendingApproval', requestParametersHash: refund.parametersHash,
    contentFingerprint: refund.contentFingerprint, approvalRequestId: 'A1' });
  await appendRefundEvent(db, refund, 'Approved', 'leader', 'decision:DECISION1', { statusBefore: 'PendingApproval', statusAfter: 'Approved',
    contentFingerprint: refund.contentFingerprint, approvalRequestId: 'A1', decisionAuditId: 'DECISION1' });
  refund.status = 'Approved'; refund.decisionAuditId = 'DECISION1';
  const evidence = { id: 'E1', refundId: 'R1', purpose: 'PaymentProof', sha256: 'a'.repeat(64), fileSize: 20, uploadedBy: 'finance', uploadedAt: BigInt(3) };
  T.creditNoteRefundEvidence.push(evidence);
  T.auditLog.push({ id: 'EA1', actorId: 'finance', action: 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED', targetType: 'CreditNoteRefundEvidence', targetId: 'E1',
    detail: { evidence: { schemaVersion: 1, refundId: 'R1', evidenceId: 'E1', purpose: 'PaymentProof', sha256: evidence.sha256, fileSize: 20, uploadedBy: 'finance', uploadedAt: '3' } } });
  const actor: any = { userId: 'finance', roles: ['finance'], permissions: ['vouchers:write'], departmentIds: [], authorizationLoaded: true };
  const service = createClaimCashRefundService({ prisma: db, assertVisible: vi.fn(async () => undefined), assertEvidence: vi.fn(async () => undefined) });
  return { db, T, refund, pr, actor, service };
}
beforeEach(() => vi.clearAllMocks());
describe('cash refund independent guards and orchestration', () => {
  it.each(['2026-02-30', '2026-13-01', '', '2026-1-01'])('rejects nonexistent actual payment date %s', value => expect(() => refundDate(value)).toThrow());
  it.each(['0', '-1', '0.00001', '100000000000000', 'NaN', '0x7d', '1.25e2'])('rejects unrepresentable financial amount %s', value => expect(() => refundAmount(value)).toThrow());
  it('does not invent a bank account or default payment method', () => {
    expect(() => refundPayee({ accountHolder: 'customer', method: 'TT' })).toThrow();
    expect(() => refundPayee({ accountHolder: 'customer', accountNumber: 'real', bankName: 'real' })).toThrow();
  });
  it('reads current Finance grants despite the stale signed write snapshot', async () => {
    const f = await fixture(); f.T.userAccount[0].roles[0].role.permissions = [];
    await expect(currentRefundActor(f.db, f.actor, 'vouchers:write')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('preserves the verified credential ceiling on current DB Finance grants', async () => {
    const f = await fixture();
    await expect(currentRefundActor(f.db, { ...f.actor, permissionCeiling: ['finance:read'] }, 'vouchers:write')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('starting execution reserves liability without creating a voucher or burning balance', async () => {
    const f = await fixture(); await f.service.start('R1', { clientRequestId: 'start-1' }, f.actor);
    expect(f.T.creditNote[0].openAmount.toString()).toBe('500'); expect(f.T.paymentVoucher).toEqual([]);
    expect((await cashRefundReservedAmount(f.db, 'CN1')).toString()).toBe('125');
    expect(f.T.creditNoteRefund[0].status).toBe('Executing');
  });
  it('a customer archive changed to supplier cannot authorize a customer refund payment', async () => {
    const f = await fixture(); f.T.relation[0].category = 'Supplier';
    await expect(f.service.start('R1', { clientRequestId: 's1' }, f.actor)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.T.paymentVoucher).toEqual([]); expect(f.T.creditNote[0].openAmount.toString()).toBe('500');
  });
  it('same start actor and command replay the immutable event without a second transition', async () => {
    const f = await fixture(), input = { clientRequestId: 'start-1' };
    await f.service.start('R1', input, f.actor); const result = await f.service.start('R1', input, f.actor);
    expect(result.replayed).toBe(true); expect(f.T.creditNoteRefundEvent.filter(row => row.kind === 'Started')).toHaveLength(1);
  });
  it('a fake terminal projection cannot release a real pending reservation', async () => {
    const f = await fixture(); f.refund.status = 'Cancelled';
    await expect(cashRefundReservedAmount(f.db, 'CN1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('changed amount or payee cannot reuse the immutable Requested approval fingerprint', async () => {
    const f = await fixture(); f.refund.amount = new Prisma.Decimal(250);
    await expect(cashRefundReservedAmount(f.db, 'CN1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    f.refund.amount = new Prisma.Decimal(125); f.refund.payeeSnapshot = { ...f.refund.payeeSnapshot, accountNumber: 'different' };
    await expect(cashRefundReservedAmount(f.db, 'CN1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('cannot ignore extra start parameters under a stable command identifier', async () => {
    const f = await fixture();
    await expect(f.service.start('R1', { clientRequestId: 's1', actualMethod: 'Other' } as any, f.actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f.T.creditNoteRefund[0].status).toBe('Approved'); expect(f.T.paymentVoucher).toEqual([]);
  });
  it('refuses an unconfigured row-visibility seam', async () => {
    const f = await fixture(), service = createClaimCashRefundService({ prisma: f.db });
    await expect(service.start('R1', { clientRequestId: 's1' }, f.actor)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
    expect(f.T.paymentVoucher).toEqual([]);
  });
  it('records actual payment, settlement and remaining liability together', async () => {
    const f = await fixture(); await f.service.start('R1', { clientRequestId: 'start-1' }, f.actor);
    const input = { companyAccountId:'ACCOUNT',expectedAccountRevision:1,clientRequestId: 'paid-1', actualDate: '2026-10-01', actualMethod: 'TT', paymentReference: 'actual-bank-1', evidenceIds: ['E1'] };
    const result = await f.service.confirm('R1', input, f.actor);
    expect(result.creditNote.openAmount.toString()).toBe('375'); expect(result.creditNote.status).toBe('PartiallyApplied');
    expect(f.T.creditNoteSettlementEvent[0]).toMatchObject({ kind: 'CashRefund', refundId: 'R1', paymentVoucherId: 'PV1', actorId: 'finance' });
    expect(f.T.creditNoteRefund[0].status).toBe('Paid'); expect(f.T.paymentRequest[0].status).toBe('Paid');
    expect(f.T.creditNoteRefundEvent.at(-1).parameters).toMatchObject({ paymentDate: '2026-10-01', paymentReference: 'actual-bank-1' });
    await assertRefundHistory(f.db, f.T.creditNoteRefund[0]);
    expect((await f.service.confirm('R1', input, f.actor)).replayed).toBe(true);
    await expect(f.service.confirm('R1', { ...input, actualDate: '2026-10-02' }, f.actor)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.T.paymentVoucher).toHaveLength(1); expect(f.T.creditNoteSettlementEvent).toHaveLength(1);
  });
  it('mandatory Paid audit failure rolls back staged voucher and every financial projection in the storage substitute', async () => {
    const f = await fixture(); await f.service.start('R1', { clientRequestId: 'start-1' }, f.actor);
    const before = clone(f.T), original = f.db.auditLog.create.getMockImplementation();
    f.db.auditLog.create.mockImplementation(async (args: any) => {
      if (args.data.detail?.cashRefundEvent?.kind === 'Paid') throw Object.assign(new Error('required audit FK fault'), { code: 'P2003' });
      return original(args);
    });
    await expect(f.service.confirm('R1', { companyAccountId:'ACCOUNT',expectedAccountRevision:1,clientRequestId: 'paid-1', actualDate: '2026-10-01', actualMethod: 'TT', paymentReference: 'actual', evidenceIds: ['E1'] }, f.actor)).rejects.toMatchObject({ code: 'P2003' });
    expect(f.T).toEqual(before);
  });
  it('wrong actual method or foreign evidence never settles a customer balance', async () => {
    const f = await fixture(); await f.service.start('R1', { clientRequestId: 'start-1' }, f.actor);
    const input = { companyAccountId:'ACCOUNT',expectedAccountRevision:1,clientRequestId: 'p1', actualDate: '2026-10-01', actualMethod: 'Cash', paymentReference: 'real', evidenceIds: ['E1'] };
    await expect(f.service.confirm('R1', input, f.actor)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    f.T.creditNoteRefundEvidence[0].refundId = 'OTHER';
    await expect(f.service.confirm('R1', { ...input, actualMethod: 'TT' }, f.actor)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.T.creditNote[0].openAmount.toString()).toBe('500'); expect(f.T.paymentVoucher).toEqual([]);
  });
  it('absence remains unknown until an explicit audited fence closes the same original key', async () => {
    const f = await fixture(), protocol = createClaimCashRefundRequestService({ prisma: f.db, assertVisible: async () => undefined });
    const body = { action: 'start' as const, originalClientRequestId: 'late-start', originalPayload: { clientRequestId: 'late-start' } };
    expect(await protocol.result('R1', 'refund', body, f.actor)).toMatchObject({ state: 'unknown', retry: 'same_request_only' });
    const before = clone(f.T), retire = { ...body, retirementClientRequestId: 'retire-start', reason: 'Explicit correction of saved intent' };
    const result = await protocol.retire('R1', 'refund', retire, f.actor);
    expect(result).toMatchObject({ state: 'not_applied', originalParameterHash: creditNoteDigest(body.originalPayload),
      actorId: 'finance', parent: { creditNoteId: 'CN1', refundId: 'R1' }, fenceAuditId: refundFenceId('CN1', 'late-start'), meaning: 'system_record_only' });
    expect(f.T.creditNoteRefund).toEqual(before.creditNoteRefund); expect(f.T.paymentVoucher).toEqual([]);
    expect((await protocol.retire('R1', 'refund', retire, f.actor)).fenceAuditId).toBe(result.fenceAuditId);
    expect(f.T.auditLog.filter(row => row.action === 'CREDIT_NOTE_REFUND_REQUEST_RETIRED')).toHaveLength(1);
    await expect(f.service.start('R1', body.originalPayload, f.actor)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await protocol.retire('R1', 'refund', { ...retire, reason: 'Changed retirement reason' }, f.actor)).state).toBe('conflict');
    expect((await protocol.result('R1', 'refund', { ...body, originalPayload: { clientRequestId: 'late-start', reason: 'Changed old request' } }, f.actor)).state).toBe('conflict');
  });
  it('a committed start is acknowledged from its immutable event after its current projection changes', async () => {
    const f = await fixture(), protocol = createClaimCashRefundRequestService({ prisma: f.db, assertVisible: async () => undefined });
    const originalPayload = { clientRequestId: 'receipt-start' };
    await f.service.start('R1', originalPayload, f.actor);
    await f.service.confirm('R1', { companyAccountId:'ACCOUNT',expectedAccountRevision:1,clientRequestId: 'receipt-paid', actualDate: '2026-10-01', actualMethod: 'TT', paymentReference: 'real-system-fact', evidenceIds: ['E1'] }, f.actor);
    const check = { action: 'start' as const, originalClientRequestId: 'receipt-start', originalPayload };
    const result = await protocol.result('R1', 'refund', check, f.actor);
    expect(result).toMatchObject({ state: 'applied', ack: { kind: 'Started', statusAtExecution: 'Executing', refundId: 'R1' } });
    expect(f.T.creditNoteRefund[0].status).toBe('Paid');
    const before = clone(f.T);
    expect((await protocol.retire('R1', 'refund', { ...check, retirementClientRequestId: 'cannot-retire-applied', reason: 'Check lost response' }, f.actor)).state).toBe('applied');
    expect(f.T).toEqual(before);
  });
  it('old semantic history without an exact wire envelope is not fabricated into an exact receipt or a negative proof', async () => {
    const f = await fixture(), protocol = createClaimCashRefundRequestService({ prisma: f.db, assertVisible: async () => undefined });
    // The fixture deliberately lacks the historical wire body. Even the same
    // actual requester cannot replace the existing creation by a negative proof.
    f.T.userAccount[0].id = 'sales';
    const requester = { ...f.actor, userId: 'sales' };
    const body = { action: 'create' as const, originalClientRequestId: 'create-1', originalPayload: { clientRequestId: 'create-1', amount: '125' } };
    expect((await protocol.result('CN1', 'note', body, requester)).state).toBe('unknown');
    expect((await protocol.retire('CN1', 'note', { ...body, retirementClientRequestId: 'legacy-retire', reason: 'Must retain historical fact' }, requester)).state).toBe('unknown');
    expect(f.T.auditLog.filter(row => row.action === 'CREDIT_NOTE_REFUND_REQUEST_RETIRED')).toEqual([]);
  });
  it('a required retirement audit failure rolls back the substitute and cannot block the original request', async () => {
    const f = await fixture(), protocol = createClaimCashRefundRequestService({ prisma: f.db, assertVisible: async () => undefined });
    const before = clone(f.T), original = f.db.auditLog.create.getMockImplementation();
    f.db.auditLog.create.mockImplementation(async (args: any) => {
      if (args.data.action === 'CREDIT_NOTE_REFUND_REQUEST_RETIRED') throw Object.assign(new Error('retirement audit actor FK fault'), { code: 'P2003' });
      return original(args);
    });
    await expect(protocol.retire('R1', 'refund', { action: 'start', originalClientRequestId: 'audit-failed-start', originalPayload: { clientRequestId: 'audit-failed-start' }, retirementClientRequestId: 'retirement-1', reason: 'Correct old request' }, f.actor)).rejects.toMatchObject({ code: 'P2003' });
    expect(f.T).toEqual(before);
    await f.service.start('R1', { clientRequestId: 'audit-failed-start' }, f.actor);
    expect(f.T.creditNoteRefund[0].status).toBe('Executing');
  });
});
