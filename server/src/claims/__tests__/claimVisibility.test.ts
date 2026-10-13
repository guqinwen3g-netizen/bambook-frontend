/** Behavioral unit seams, not PG/locking or complete company-role acceptance.
 * Rules come from DR-042 L2/derived subtrees and DR-016 actual invoice links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as permissionModule from '../../auth/permissionService';
import { claimPage, createClaimVisibility, validateClaimSourceFacts } from '../claimVisibility';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';
import { listClaimCases } from '../claimCaseService';
import { listOpenCreditNotes } from '../creditNoteService';

const actor = { userId: 'u', roles: ['sales'], permissions: ['aftersales:read'], authorizationLoaded: true } as any;
function database(roleId = 'role-sales') {
  const user = { id: 'u', status: 'active', deletedAt: null, roles: [{ roleId, role: { permissions: [] } }] };
  const delegate = () => ({ findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) });
  const db: any = { userAccount: delegate(), userPermissionOverrides: delegate(), relation: delegate(),
    teamMember: delegate(), teamDataGrant: delegate(), order: delegate(), invoice: delegate(), invoiceOrderAllocation: delegate(),
    claimCase: delegate(), claimDisposition: delegate(), returnReceipt: delegate(), returnReceiptLine: delegate(),
    repairWorkOrder: delegate(), creditNote: { ...delegate(), aggregate: vi.fn().mockResolvedValue({ _sum: { openAmount: null } }) } };
  db.userAccount.findFirst.mockResolvedValue(user);
  db.relation.findMany.mockResolvedValue([{ id: 'R_OWN' }]);
  return { db, user };
}
beforeEach(__clearTeamShareCacheForTests);
afterEach(() => vi.restoreAllMocks());
// Explicit independently configured module rules. This is a resolver seam,
// not a claim that such a company-role configuration has been deployed.
function distinctModuleRules() {
  const original = permissionModule.createPermissionService;
  vi.spyOn(permissionModule, 'createPermissionService').mockImplementation(options => ({
    ...original(options),
    getDataScopeResolver: vi.fn(async (_actor, module) => module === 'aftersales'
      ? { rule: { kind: 'all' as const } }
      : { rule: { kind: module === 'orders' ? 'team' as const : 'self' as const }, allowedUserIds: ['u'] }),
  }));
}
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([field, condition]: [string, any]) => {
    if (field === 'AND') return condition.every((part: any) => matches(row, part));
    if (field === 'OR') return condition.some((part: any) => matches(row, part));
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return condition.in.includes(row[field]);
      if ('not' in condition) return (row[field] ?? null) !== condition.not;
    }
    return (row[field] ?? null) === condition;
  });
}
describe('Claim source facts never use caller names as identity', () => {
  it('unbound name stays a description without inventing a relation', async () => {
    const { db } = database();
    expect(await validateClaimSourceFacts(db, { customerName: 'ACME' })).toMatchObject({ customerRelationId: null, sourceOrderId: null, sourceInvoiceId: null, customerName: 'ACME' });
    expect(db.relation.findFirst).not.toHaveBeenCalled();
  });
  it('guessed or deleted customer ID is refused, even when the name matches', async () => {
    const { db } = database();
    await expect(validateClaimSourceFacts(db, { customerRelationId: 'GUESS', customerName: 'ACME' })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(db.relation.findFirst).toHaveBeenCalledWith({ where: { id: 'GUESS', deletedAt: null, category: 'Customer' } });
  });
  it('the actual order customer must match the supplied customer ID', async () => {
    const { db } = database(); db.order.findFirst.mockResolvedValue({ id: 'O', customerRelationId: 'R_OWN' });
    await expect(validateClaimSourceFacts(db, { sourceOrderId: 'O', customerRelationId: 'R_OTHER' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.relation.findFirst).not.toHaveBeenCalled();
  });
  it('DR-016 distinct billTo is retained when real IOA proves the selected order', async () => {
    const { db } = database(); db.order.findFirst.mockResolvedValue({ id: 'O', customerRelationId: 'R_OWN' });
    db.invoice.findFirst.mockResolvedValue({ id: 'INV', type: 'Receivable', customerRelationId: 'R_BILL', orderId: null });
    db.invoiceOrderAllocation.findFirst.mockResolvedValue({ invoiceId: 'INV', orderId: 'O' });
    db.relation.findFirst.mockResolvedValue({ id: 'R_OWN', name: 'Real business customer' });
    const fact = await validateClaimSourceFacts(db, { sourceOrderId: 'O', sourceInvoiceId: 'INV', customerName: 'Wrong name' });
    expect(fact).toMatchObject({ customerRelationId: 'R_OWN', customerName: 'Real business customer', invoice: { customerRelationId: 'R_BILL' } });
    expect(db.invoiceOrderAllocation.findFirst).toHaveBeenCalledWith({ where: { invoiceId: 'INV', orderId: 'O', deletedAt: null } });
  });
  it('an unrelated real invoice is not accepted as a source snapshot', async () => {
    const { db } = database(); db.order.findFirst.mockResolvedValue({ id: 'O', customerRelationId: 'R_OWN' });
    db.invoice.findFirst.mockResolvedValue({ id: 'INV', customerRelationId: 'R_OWN', orderId: 'OTHER' });
    await expect(validateClaimSourceFacts(db, { sourceOrderId: 'O', sourceInvoiceId: 'INV' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('invoice alone cannot impersonate a different business customer', async () => {
    const { db } = database(); db.invoice.findFirst.mockResolvedValue({ id: 'INV', customerRelationId: 'R_BILL' });
    await expect(validateClaimSourceFacts(db, { sourceInvoiceId: 'INV', customerRelationId: 'R_OTHER' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('source storage failure is unavailable, not missing or successfully empty', async () => {
    const { db } = database(); db.order.findFirst.mockRejectedValue(new Error('SQL_READ_FAILED'));
    await expect(validateClaimSourceFacts(db, { sourceOrderId: 'O' })).rejects.toMatchObject({ code: 'DEPENDENCY_CHECK_FAILED', statusCode: 503 });
  });
});
describe('Current authority and actual parent visibility', () => {
  it('aftersales all does not restore an independently restricted order or invoice anchor', async () => {
    distinctModuleRules(); const { db } = database();
    db.order.findMany.mockResolvedValue([{ id: 'O_VISIBLE' }]); db.invoice.findMany.mockResolvedValue([{ id: 'I_VISIBLE' }]);
    const visibility = createClaimVisibility(db, actor), where = await visibility.caseScopeWhere();
    const claim = { customerRelationId: 'R_ANY', sourceOrderId: 'O_VISIBLE', sourceInvoiceId: 'I_VISIBLE' };
    expect(matches(claim, where)).toBe(true);
    expect(matches({ ...claim, sourceOrderId: 'O_PRIVATE' }, where)).toBe(false);
    expect(matches({ ...claim, sourceInvoiceId: 'I_PRIVATE' }, where)).toBe(false);
    expect(matches({ customerRelationId: null, sourceOrderId: null, sourceInvoiceId: null, reportedBy: 'another' }, where)).toBe(true);
    expect(db.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [expect.objectContaining({ OR: expect.any(Array) })] }) }));
    expect(db.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ AND: [{ ownerId: 'u' }] }) }));
    db.claimCase.findFirst.mockImplementation(async ({ where: query }: any) => matches({ ...claim, id: 'C', deletedAt: null, sourceInvoiceId: 'I_PRIVATE' }, query) ? claim : null);
    await expect(visibility.requireCase('C')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('a credit note with a visible case still needs its own restricted invoice anchor', async () => {
    distinctModuleRules(); const { db } = database(); db.claimCase.findMany.mockResolvedValue([{ id: 'C_VISIBLE' }]);
    db.invoice.findMany.mockResolvedValue([{ id: 'I_VISIBLE' }]);
    const where = await createClaimVisibility(db, actor).creditNoteScopeWhere();
    const note = { claimCaseId: 'C_VISIBLE', logicalClaimCaseId: 'C_VISIBLE', customerRelationId: 'R_ANY', sourceInvoiceId: 'I_VISIBLE' };
    expect(matches(note, where)).toBe(true);
    expect(matches({ ...note, sourceInvoiceId: 'I_PRIVATE' }, where)).toBe(false);
    expect(matches({ ...note, claimCaseId: 'C_PRIVATE' }, where)).toBe(false);
    expect(matches({ ...note, claimCaseId: null, logicalClaimCaseId: null }, where)).toBe(true);
    expect(matches({ claimCaseId: null, logicalClaimCaseId: null, customerRelationId: null, sourceInvoiceId: null }, where)).toBe(true);
  });
  it('the existing unrestricted history path requires all three independently unrestricted modules', async () => {
    const { db } = database('role-finance'); const visibility = createClaimVisibility(db, actor);
    expect(await visibility.caseScopeWhere()).toEqual({}); expect(await visibility.creditNoteScopeWhere()).toEqual({});
    expect(db.order.findMany).not.toHaveBeenCalled(); expect(db.invoice.findMany).not.toHaveBeenCalled();
  });
  it('current canonical DB identity replaces stale broad roles while retaining credential ceiling', async () => {
    const { db } = database(); db.userPermissionOverrides.findMany.mockResolvedValue([{ scope: 'aftersales:read' }]);
    const current = await createClaimVisibility(db, { ...actor, roles: ['owner'], permissionCeiling: ['aftersales:read'] }).currentActor();
    expect(current.roles).toEqual(['sales']); expect(current.authorizationLoaded).toBe(true);
    expect(current.permissions).toEqual(['aftersales:read']); expect(current.permissionCeiling).toEqual(['aftersales:read']);
  });
  it('disabled actor is refused before reading business rows', async () => {
    const { db, user } = database(); user.status = 'inactive';
    await expect(createClaimVisibility(db, actor).requireCase('C')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', statusCode: 401 });
    expect(db.claimCase.findFirst).not.toHaveBeenCalled();
  });
  it('creation rejects a previously writable snapshot after current DB scope withdrawal', async () => {
    const { db } = database();
    await expect(createClaimVisibility(db, { ...actor, permissions: ['aftersales:write'] }).assertCreateSources({ customerName: 'Description' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });
  it('caught legacy team resolver query fault still becomes explicit503', async () => {
    const { db } = database(); db.teamMember.findMany.mockRejectedValue(new Error('TEAM_LOOKUP_FAILED'));
    await expect(createClaimVisibility(db, actor).caseScopeWhere()).rejects.toMatchObject({ code: 'DEPENDENCY_CHECK_FAILED', statusCode: 503 });
    expect(db.claimCase.findMany).not.toHaveBeenCalled();
  });
  it('case details are selected with parent scope and never retried without it', async () => {
    const { db } = database(); db.order.findMany.mockResolvedValue([{ id: 'O_OWN' }]);
    await expect(createClaimVisibility(db, actor).requireCase('C_PRIVATE')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(db.claimCase.findFirst).toHaveBeenCalledTimes(1);
    expect(db.claimCase.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'C_PRIVATE', deletedAt: null, AND: [expect.objectContaining({ OR: expect.any(Array) })] } });
  });
  it('mixed return receipt and disposition parents are denied before any write', async () => {
    const { db } = database(); db.returnReceiptLine.findUnique.mockResolvedValue({ id: 'L', returnReceiptId: 'RR', claimDispositionId: 'D' });
    db.returnReceipt.findFirst.mockResolvedValue({ id: 'RR', claimCaseId: 'C1' });
    db.claimDisposition.findFirst.mockResolvedValue({ id: 'D', claimCaseId: 'C2' });
    await expect(createClaimVisibility(db, actor).requireChild('returnLine', 'L')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.claimCase.findFirst).not.toHaveBeenCalled();
  });
});
describe('Pagination and liability use the same scoped full query', () => {
  it('case count and page share filter, deterministic order and offset', async () => {
    const { db } = database(); const scopeWhere = { reportedBy: 'u' }; db.claimCase.count.mockResolvedValue(7);
    expect((await listClaimCases(db, { limit: 2, offset: 4, scopeWhere })).data).toMatchObject({ total: 7, limit: 2, offset: 4 });
    expect(db.claimCase.count).toHaveBeenCalledWith({ where: db.claimCase.findMany.mock.calls[0][0].where });
    expect(db.claimCase.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 2 }));
  });
  it('closed document history stays readable without counting cancelled liability or only paged amounts', async () => {
    const { db } = database(); db.creditNote.count.mockResolvedValue(9); db.creditNote.aggregate.mockResolvedValue({ _sum: { openAmount: '85.50' } });
    const result = await listOpenCreditNotes(db, { limit: 1, offset: 2, includeClosed: true, scopeWhere: { claimCaseId: 'C' } });
    expect(result.data).toMatchObject({ total: 9, totalOpen: '85.5', limit: 1, offset: 2 });
    const where = db.creditNote.findMany.mock.calls[0][0].where;
    expect(db.creditNote.count).toHaveBeenCalledWith({ where });
    expect(db.creditNote.aggregate).toHaveBeenCalledWith({ where: { AND: [where, { status: { in: ['Open', 'PartiallyApplied'] } }] }, _sum: { openAmount: true } });
  });
  it.each([{ limit: 0 }, { limit: 1.1 }, { offset: -1 }, { limit: 501 }])('invalid page %j never becomes an unbounded query', input => {
    expect(() => claimPage(input)).toThrow('limit');
  });
});
