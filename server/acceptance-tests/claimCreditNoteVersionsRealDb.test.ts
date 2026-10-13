/**
 * Actual Claim/Approval/Finance HTTP + current DB authorization + isolated PG.
 * Independent acceptance basis: 9/17 A1/A2/A3/A7: one case has one money
 * account, each amount comes from the assigned general leader's real approval,
 * a balance reduction requires a real settlement outlet, and zero balance
 * determines closure. Issued versions preserve the agreed immutable document.
 * Synthetic accounts/custom grants are transport/storage evidence, not company
 * role UAT, rendered printing, cash refund, internal repair or cancellation.
 * Only legacy negative headers are seeded as explicitly incomplete history;
 * approved dispositions, approval decisions, CN lines/versions/offset events
 * are NEVER hand-created. No seed/bootstrap/scheduler/shared DB/cleanup.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createClaimRouter } from '../src/claims/claimRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createFinanceRouter } from '../src/finance/route';

const prefix = 'acceptance-claim-cn-version-' + randomUUID();
const scopes = ['aftersales:read', 'aftersales:write', 'finance:read', 'invoices:read', 'invoices:write', 'invoices:reconcile'];
let prisma: PrismaClient | undefined;
const db = () => { if (!prisma) throw Error('Independent claim CN PG not initialized'); return prisma; };
// The runner generates its private client for the new schema. Do not generate
// or install a client in the shared working tree to typecheck this probe.
const models = () => db() as any;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

function app(database: PrismaClient = db()) {
  const result = express(); result.use(express.json());
  result.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1', createClaimRouter({ prisma: database, requireAuth: true }));
  result.use('/api/v1/approvals', createApprovalRouter({ prisma: database, requireAuth: true }));
  result.use('/api/v1/finance', createFinanceRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return result;
}
async function fixture(key: string, invoiceAmount = '1000') {
  const id = prefix + '-' + key, leaderId = id + '-leader', operatorId = id + '-operator', departmentId = id + '-department';
  await db().userAccount.create({ data: { id: leaderId, displayName: 'Synthetic assigned general leader', status: 'active' } });
  await db().department.create({ data: { id: departmentId, name: 'Synthetic CN acceptance department', headId: leaderId } });
  await db().userAccount.update({ where: { id: leaderId }, data: { primaryDeptId: departmentId } });
  await db().userAccount.create({ data: { id: operatorId, displayName: 'Synthetic combined claim/finance operator', status: 'active', primaryDeptId: departmentId } });
  for (const [userId, canonicalRole] of [[leaderId, 'role-admin'], [operatorId, 'role-finance']]) {
    const configuredRole = userId + '-configured';
    await db().role.upsert({ where: { id: canonicalRole }, update: {}, create: { id: canonicalRole, name: 'Synthetic canonical ' + canonicalRole, isSystem: true } });
    await db().role.create({ data: { id: configuredRole, name: 'Synthetic explicit CN scopes', isSystem: false } });
    for (const roleId of [canonicalRole, configuredRole]) await db().userRole.create({ data: { id: userId + '-' + roleId, userId, roleId, departmentId } });
    // Never add grants to the shared canonical role: this fixture must not
    // change defaults/revocation tests executed in another file in the cluster.
    for (const scope of scopes) {
      const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
      await db().rolePermission.create({ data: { id: userId + '-' + scope, roleId: configuredRole, permissionId: permission.id } });
    }
  }
  const token = async (userId: string) => {
    const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
    expect(current).not.toBeNull(); expect(current!.scopes).toEqual(expect.arrayContaining(scopes));
    return createAuthService().signToken({ userId, roleIds: current!.roleIds, roles: current!.legacyRoleCodes,
      departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true });
  };
  const operatorToken = await token(operatorId), leaderToken = await token(leaderId), application = app();
  const customer = await db().relation.create({ data: { id: id + '-customer', name: 'Synthetic CN customer', category: 'Customer', type: 'Company',
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: operatorId, salesRepIds: [operatorId] } });
  const invoice = await request(application).post('/api/v1/finance').set('Authorization', 'Bearer ' + operatorToken)
    .send({ invoiceNumber: id + '-invoice', type: 'Receivable', status: 'Issued', amount: invoiceAmount, currency: 'USD',
      customerRelationId: customer.id, customerName: customer.name, issueDate: '2026-10-01' });
  expect(invoice.status, diagnostic(invoice.body)).toBe(201);
  expect(await db().invoice.findUniqueOrThrow({ where: { id: invoice.body.id } })).toMatchObject({ type: 'Receivable', status: 'Issued', customerRelationId: customer.id, currency: 'USD' });
  const created = await request(application).post('/api/v1/claims').set('Authorization', 'Bearer ' + operatorToken)
    .send({ customerRelationId: customer.id, customerName: customer.name, sourceInvoiceId: invoice.body.id, problemDesc: 'Independent approved money-account acceptance' });
  expect(created.status, diagnostic(created.body)).toBe(201);
  return { id, leaderId, operatorId, leaderToken, operatorToken, app: application, customer, invoiceId: invoice.body.id as string,
    caseId: created.body.claimCase.id as string, creditNoteId: '' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post(f: Fixture, path: string, body: any, token = f.operatorToken, application = f.app) {
  return request(application).post('/api/v1/' + path).set('Authorization', 'Bearer ' + token).send(body);
}
async function get(f: Fixture, path: string, token = f.operatorToken) {
  return request(f.app).get('/api/v1/' + path).set('Authorization', 'Bearer ' + token);
}
async function approvedMoney(f: Fixture, label: string, amount = '500', currency = 'USD',
  overrides: Record<string, unknown> = {}, executionOptions: Record<string, unknown> = {}) {
  const added = await post(f, 'claims/' + f.caseId + '/dispositions', { kind: 'Allowance', amount, currency, notes: label, ...overrides });
  expect(added.status, diagnostic(added.body)).toBe(201);
  const dispositionId = added.body.disposition.id as string, approvalId = added.body.approvalRequestId as string;
  const pending = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  expect(pending).toMatchObject({ status: 'pending', requesterId: f.operatorId, reviewerId: f.leaderId, actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', targetId: dispositionId });
  const decision = await post(f, 'approvals/' + approvalId + '/decide', { status: 'approved', decisionNote: 'Actual assigned synthetic general-leader approval' }, f.leaderToken);
  expect(decision.status, diagnostic(decision.body)).toBe(200);
  expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'approved', reviewerId: f.leaderId });
  const audits = await db().auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: approvalId, action: 'approve_business_request' } });
  expect(audits).toHaveLength(1); expect(audits[0].actorId).toBe(f.leaderId);
  expect((audits[0].detail as any).decisionActorAuthority).toMatchObject({ userId: f.leaderId, roleIds: expect.arrayContaining(['role-admin']), authorizationLoaded: true });
  const advance = await post(f, 'claims/dispositions/' + dispositionId + '/approve', {}, f.operatorToken);
  expect(advance.status, diagnostic(advance.body)).toBe(200);
  expect(await db().claimDisposition.findUniqueOrThrow({ where: { id: dispositionId } })).toMatchObject({ status: 'Approved', approverId: f.leaderId });
  return { dispositionId, approvalId, decisionAuditId: audits[0].id, fingerprint: (pending.payload as any).contentFingerprint, requestId: 'EXEC_' + label, executionOptions };
}
type Money = Awaited<ReturnType<typeof approvedMoney>>;
async function execute(f: Fixture, money: Money, application = f.app) {
  const response = await post(f, 'claims/dispositions/' + money.dispositionId + '/execute', { clientRequestId: money.requestId, ...money.executionOptions }, f.operatorToken, application);
  if (response.status === 200) f.creditNoteId = response.body.creditNote.id;
  return response;
}
async function money(f: Fixture, label: string, amount = '500') {
  const m = await approvedMoney(f, label, amount); const response = await execute(f, m);
  expect(response.status, diagnostic(response.body)).toBe(200); return m;
}
const issueBody = (requestId = 'ISSUE_1', version = 1) => ({ clientRequestId: requestId, expectedVersion: version });
const offsetBody = (f: Fixture, amount: string, requestId = 'OFFSET_1') => ({ appliedAmount: amount, toInvoiceId: f.invoiceId, clientRequestId: requestId });
async function issue(f: Fixture, body = issueBody(), token = f.operatorToken, application = f.app) {
  return post(f, 'credit-notes/' + f.creditNoteId + '/issue', body, token, application);
}
async function offset(f: Fixture, body: any, token = f.operatorToken, application = f.app) {
  return post(f, 'credit-notes/' + f.creditNoteId + '/apply', body, token, application);
}
async function state(f: Fixture) {
  const notes = await db().creditNote.findMany({ where: { claimCaseId: f.caseId }, orderBy: { id: 'asc' } });
  const ids = notes.map(row => row.id);
  const dispositions = await db().claimDisposition.findMany({ where: { claimCaseId: f.caseId }, orderBy: { id: 'asc' } });
  return { claim: await db().claimCase.findUniqueOrThrow({ where: { id: f.caseId } }), dispositions, notes,
    lines: await models().claimCreditNoteLine.findMany({ where: { creditNoteId: { in: ids } }, orderBy: { id: 'asc' } }),
    versions: await models().creditNoteDocumentVersion.findMany({ where: { creditNoteId: { in: ids } }, orderBy: { version: 'asc' } }),
    events: await models().creditNoteSettlementEvent.findMany({ where: { creditNoteId: { in: ids } }, orderBy: { id: 'asc' } }),
    allocations: await db().creditNoteAllocation.findMany({ where: { creditNoteId: { in: ids } }, orderBy: { id: 'asc' } }),
    invoice: await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } }),
    // Optional legacy route audit is not a financial event and is excluded.
    audits: await db().auditLog.findMany({ where: { targetId: { in: [...ids, ...dispositions.map(row => row.id)] },
      action: { in: ['CLAIM_CREDIT_NOTE_VERSION_CREATED', 'CLAIM_CREDIT_NOTE_ISSUED', 'CREDIT_NOTE_SETTLED', 'execute'] } }, orderBy: { id: 'asc' } }),
  };
}
async function denied(f: Fixture, operation: () => Promise<any>, expectedStatus = 409) {
  const before = await state(f), response = await operation();
  expect(response.status, diagnostic(response.body)).toBe(expectedStatus); expect(await state(f)).toEqual(before); return response;
}
/** Swap only a required audit actor FK input. Actual PG, not a thrown mock,
 * must raise P2003 after real domain rows have been staged in the external tx. */
function sqlFault(f: Fixture, action: string) {
  const observed: { injections: number; code?: string; staged?: any } = { injections: 0 };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
        if (method === 'create') return async (args: any) => {
          if (args.data.action !== action) return delegate.create(args);
          observed.injections++;
          const notes = await client.creditNote.findMany({ where: { claimCaseId: f.caseId } });
          const ids = notes.map(row => row.id), current: any = client;
          observed.staged = { notes: notes.map(row => ({ id: row.id, open: String(row.openAmount) })),
            lines: await current.claimCreditNoteLine.count({ where: { creditNoteId: { in: ids } } }),
            versions: await current.creditNoteDocumentVersion.count({ where: { creditNoteId: { in: ids } } }),
            issuedVersions: await current.creditNoteDocumentVersion.count({ where: { creditNoteId: { in: ids }, issuedAt: { not: null } } }),
            events: await current.creditNoteSettlementEvent.count({ where: { creditNoteId: { in: ids } } }),
            allocations: await client.creditNoteAllocation.count({ where: { creditNoteId: { in: ids } } }) };
          try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-actor' } }); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database, observed };
}

describe.sequential('actual approved claim CN account, immutable issued documents and offset facts in isolated PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe('/' + name);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(url.port).toBe(port); expect(Boolean(directory)).toBe(true);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>(
      "SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
    expect(identity, 'verify actual independent cluster identity before ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('CCV01 actual assigned decisions and concurrent executions aggregate two money dispositions into one logical CN with exact immutable source lines', async () => {
    const f = await fixture('concurrent-lines');
    const first = await approvedMoney(f, 'first', '500'), second = await approvedMoney(f, 'second', '200');
    const responses = await Promise.all([execute(f, first), execute(f, second)]);
    for (const response of responses) expect(response.status, diagnostic(response.body)).toBe(200);
    const after = await state(f); expect(after.notes).toHaveLength(1); expect(after.lines).toHaveLength(2); expect(after.versions).toHaveLength(2);
    expect((after.notes[0] as any).logicalClaimCaseId).toBe(f.caseId);
    expect(String((after.notes[0] as any).currentAmount)).toBe('700'); expect(String(after.notes[0].openAmount)).toBe('700');
    expect(after.claim.totalCreditAmount.toString()).toBe('700');
    for (const m of [first, second]) expect(after.lines.find((row: any) => row.claimDispositionId === m.dispositionId)).toMatchObject({
      approvalRequestId: m.approvalId, decisionAuditId: m.decisionAuditId, contentFingerprint: m.fingerprint, currency: 'USD' });
    expect(after.dispositions.every(row => row.status === 'Executed' && row.creditNoteId === after.notes[0].id)).toBe(true);
    const response = await get(f, 'claims/' + f.caseId + '/credit-note');
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.versions).toHaveLength(2);
  });
  it('CCV02 issue version 1, partially offset, append version 2: old issued snapshot stays byte-equivalent and current balance uses appended liability', async () => {
    const f = await fixture('issued-append'); await money(f, 'first');
    const issued = await issue(f); expect(issued.status, diagnostic(issued.body)).toBe(200);
    const original = await models().creditNoteDocumentVersion.findUniqueOrThrow({ where: { id: issued.body.version.id } });
    const applied = await offset(f, offsetBody(f, '200')); expect(applied.status, diagnostic(applied.body)).toBe(200);
    await money(f, 'second', '100');
    expect(await models().creditNoteDocumentVersion.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    const after = await state(f); expect(after.notes).toHaveLength(1);
    expect(String(after.notes[0].amount)).toBe('500'); expect(String((after.notes[0] as any).currentAmount)).toBe('600');
    expect(String(after.notes[0].openAmount)).toBe('400'); expect(after.notes[0].status).toBe('PartiallyApplied');
    expect(after.versions.map((row: any) => row.version)).toEqual([1, 2]); expect(after.events).toHaveLength(1);
    const print = await get(f, 'credit-notes/' + f.creditNoteId + '/versions?versionId=' + original.id);
    expect(print.status, diagnostic(print.body)).toBe(200); expect(print.body.printVersion.linesSnapshot).toEqual(original.linesSnapshot);
    expect(print.body.printVersion.amount).toBe('500');
    await denied(f, () => issue(f, issueBody('STALE', 1)));
    await denied(f, () => get(f, 'credit-notes/' + f.creditNoteId + '/versions?versionId=' + after.versions[1].id));
    await denied(f, () => get(f, 'credit-notes/' + f.creditNoteId + '/versions?versionId=foreign-version'));
  });
  it('CCV03 same issue request replays the original issued version after append; changed actor/version and another stale request refuse', async () => {
    const f = await fixture('issue-replay'); await money(f, 'first');
    const original = await issue(f); expect(original.status, diagnostic(original.body)).toBe(200); await money(f, 'second', '100');
    const before = await state(f), replay = await issue(f);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.version.id).toBe(original.body.version.id); expect(replay.body.issuedEventId).toBe(original.body.issuedEventId);
    expect(await state(f)).toEqual(before);
    await denied(f, () => issue(f, issueBody('ISSUE_1', 2)));
    await denied(f, () => issue(f, issueBody(), f.leaderToken));
    await denied(f, () => issue(f, issueBody('DIFFERENT', 1)));
  });
  it('CCV04 actual full invoice offset closes the account; same intent replays without another event, allocation, balance change or mandatory audit', async () => {
    const f = await fixture('offset-replay', '500'); await money(f, 'first');
    const body = offsetBody(f, '500'), original = await offset(f, body);
    expect(original.status, diagnostic(original.body)).toBe(200); expect(original.body.creditNote.status).toBe('Closed');
    const before = await state(f), replay = await offset(f, body);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.settlementEvent.id).toBe(original.body.settlementEvent.id); expect(await state(f)).toEqual(before);
    expect(before.events).toHaveLength(1); expect(before.allocations).toHaveLength(1); expect(before.invoice.status).toBe('Paid');
    const audit = before.audits.find(row => row.action === 'CREDIT_NOTE_SETTLED');
    expect(audit?.actorId).toBe(f.operatorId); expect((audit?.detail as any).creditNoteSettlement).toMatchObject({ eventId: original.body.settlementEvent.id, actorId: f.operatorId, requestId: 'OFFSET_1' });
    await denied(f, () => offset(f, { ...body, appliedAmount: '499' }));
    await denied(f, () => offset(f, { ...body, toInvoiceId: 'other-invoice' }), 404);
    await denied(f, () => offset(f, body, f.leaderToken));
    await denied(f, () => offset(f, { ...body, clientRequestId: 'NEW' }));
  });
  it('CCV05 missing real outlet or unimplemented cash refund refuses before reducing credit; an unrelated customer invoice cannot consume this approval', async () => {
    const f = await fixture('outlets'); await money(f, 'first');
    await denied(f, () => offset(f, { appliedAmount: '100', clientRequestId: 'NO_OUTLET' }), 400);
    await denied(f, () => offset(f, { appliedAmount: '100', refund: true, clientRequestId: 'NO_CASH' }), 400);
    // CreditNote is not a Receivable invoice and cannot be its own outlet.
    await denied(f, () => offset(f, { ...offsetBody(f, '100', 'SELF'), toInvoiceId: f.creditNoteId }), 404);
    const other = await fixture('unrelated-customer');
    await denied(f, () => offset(f, { ...offsetBody(f, '100'), toInvoiceId: other.invoiceId }));
  });
  it('CCV06 same CN earlier offset occupies invoice capacity; amount beyond the real remaining receivable refuses without financial writes', async () => {
    const f = await fixture('self-capacity', '300'); await money(f, 'first');
    expect((await offset(f, offsetBody(f, '200', 'FIRST'))).status).toBe(200);
    const rejected = await denied(f, () => offset(f, offsetBody(f, '150', 'SECOND')));
    expect(rejected.body.error).toBe('OVER_APPLIED'); expect(String((await state(f)).notes[0].openAmount)).toBe('300');
  });
  it('CCV07 concurrent distinct offset requests cannot exceed the approved account balance', async () => {
    const f = await fixture('concurrent-balance'); await money(f, 'first');
    const responses = await Promise.all([offset(f, offsetBody(f, '350', 'ONE')), offset(f, offsetBody(f, '350', 'TWO'))]);
    expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
    expect(responses.find(row => row.status === 409)!.body.error).toBe('OVER_APPLIED');
    const after = await state(f); expect(after.events).toHaveLength(1); expect(after.allocations).toHaveLength(1);
    expect(String(after.notes[0].openAmount)).toBe('150'); expect(String(after.allocations[0].appliedAmount)).toBe('350');
  });
  it('CCV08 concurrent identical offset requests serialize into one event and one balance mutation', async () => {
    const f = await fixture('concurrent-same-intent'); await money(f, 'first');
    const body = offsetBody(f, '200'), responses = await Promise.all([offset(f, body), offset(f, body)]);
    for (const response of responses) expect(response.status, diagnostic(response.body)).toBe(200);
    expect(responses.filter(row => row.body.replayed)).toHaveLength(1);
    expect(responses[0].body.settlementEvent.id).toBe(responses[1].body.settlementEvent.id);
    const after = await state(f); expect(after.events).toHaveLength(1); expect(after.allocations).toHaveLength(1);
    expect(after.audits.filter(row => row.action === 'CREDIT_NOTE_SETTLED')).toHaveLength(1);
    expect(String(after.notes[0].openAmount)).toBe('300');
  });
  it('CCV09 a second genuinely approved currency cannot implicitly exchange or append to the case CN', async () => {
    const f = await fixture('currency'); await money(f, 'first');
    const eur = await approvedMoney(f, 'eur', '100', 'EUR');
    await denied(f, () => execute(f, eur)); const after = await state(f);
    expect(after.notes).toHaveLength(1); expect(after.lines).toHaveLength(1); expect(after.versions).toHaveLength(1);
    expect(after.claim.totalCreditAmount.toString()).toBe('500');
  });
  it.each([1, 2])('CCV10 incomplete legacy case with %i historical CN headers refuses automatic promotion/merge and keeps all history', async count => {
    const f = await fixture('legacy-' + count), m = await approvedMoney(f, 'new');
    const now = BigInt(Date.now());
    for (let i = 0; i < count; i++) await db().creditNote.create({ data: { id: f.id + '-legacy-' + i, creditNoteNumber: f.id + '-legacy-' + i,
      claimCaseId: f.caseId, customerRelationId: f.customer.id, customerName: f.customer.name, sourceInvoiceId: f.invoiceId,
      currency: 'USD', amount: '25', openAmount: '25', status: 'Open', issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
    await denied(f, () => execute(f, m));
    await denied(f, () => get(f, 'claims/' + f.caseId + '/credit-note'));
    const after = await state(f); expect(after.notes).toHaveLength(count); expect(after.lines).toEqual([]); expect(after.versions).toEqual([]);
    expect(after.claim.totalCreditAmount.toString()).toBe('0');
  });
  it('CCV11 actual mandatory version-audit FK failure rolls back staged CN/header, approved line, document version, execution and case summary', async () => {
    const f = await fixture('version-fk'), m = await approvedMoney(f, 'new'), before = await state(f);
    const fault = sqlFault(f, 'CLAIM_CREDIT_NOTE_VERSION_CREATED');
    const response = await execute(f, m, app(fault.database));
    expect(response.status, diagnostic(response.body)).toBe(500); expect(response.body.error).toBe('INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { lines: 1, versions: 1, events: 0, allocations: 0 } });
    expect(fault.observed.staged.notes).toHaveLength(1); expect(await state(f)).toEqual(before);
  });
  it('CCV12 actual mandatory settlement-audit FK failure rolls back staged event, balance, net allocation and invoice settlement', async () => {
    const f = await fixture('settlement-fk', '500'); await money(f, 'first'); const before = await state(f);
    const fault = sqlFault(f, 'CREDIT_NOTE_SETTLED');
    const response = await offset(f, offsetBody(f, '500'), f.operatorToken, app(fault.database));
    expect(response.status, diagnostic(response.body)).toBe(500); expect(response.body.error).toBe('INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { lines: 1, versions: 1, events: 1, allocations: 1 } });
    expect(fault.observed.staged.notes[0].open).toBe('0'); expect(await state(f)).toEqual(before);
  });
  it('CCV13 current DB permission revocation reaches the actual guards for financial issuance; an old signed write token cannot issue', async () => {
    const f = await fixture('scope-revoked'); await money(f, 'first');
    const role = f.operatorId + '-configured', permission = await db().permission.findUniqueOrThrow({ where: { scope: 'aftersales:write' } });
    // Remove only this fixture actor's canonical-role binding first. Keep its
    // configured grants, proving a local scope withdrawal without inheriting
    // canonical grants another test file may have established in this cluster.
    await db().userRole.deleteMany({ where: { userId: f.operatorId, roleId: 'role-finance' } });
    const beforeContext = await createPermissionService({ prisma: db() }).getUserPermissionContext(f.operatorId);
    expect(beforeContext!.scopes).toContain('aftersales:write');
    await db().rolePermission.deleteMany({ where: { roleId: role, permissionId: permission.id } });
    const afterContext = await createPermissionService({ prisma: db() }).getUserPermissionContext(f.operatorId);
    expect(afterContext!.scopes).not.toContain('aftersales:write');
    const before = await state(f), response = await issue(f);
    expect([401, 403], diagnostic(response.body)).toContain(response.status); expect(await state(f)).toEqual(before);
  });
  it('CCV14 actual mandatory issue-audit FK failure rolls back the staged issued version and leaves no issue fact', async () => {
    const f = await fixture('issue-fk'); await money(f, 'first'); const before = await state(f);
    const fault = sqlFault(f, 'CLAIM_CREDIT_NOTE_ISSUED');
    const response = await issue(f, issueBody(), f.operatorToken, app(fault.database));
    expect(response.status, diagnostic(response.body)).toBe(500); expect(response.body.error).toBe('INTERNAL_ERROR');
    expect(fault.observed).toMatchObject({ injections: 1, code: 'P2003', staged: { versions: 1, issuedVersions: 1, events: 0, allocations: 0 } });
    expect(await state(f)).toEqual(before);
  });
  it('CCV15 actual Allowance plus approved ReturnRefund share one CN and preserve their different source scopes', async () => {
    const f = await fixture('mixed-money'); const first = await money(f, 'allowance');
    const now = BigInt(Date.now());
    const warehouse = await db().warehouse.create({ data: { id: f.id + '-warehouse', code: f.id + '-WH', name: 'Synthetic actual returns warehouse', type: 'Main', createdAt: now, updatedAt: now } });
    const returned = await approvedMoney(f, 'refund', '200', 'USD', { kind: 'ReturnRefund', materialCode: f.id + '-SKU', quantity: '2.5', unit: 'M', returnDisposition: 'Scrap' }, { warehouseId: warehouse.id });
    const executed = await execute(f, returned); expect(executed.status, diagnostic(executed.body)).toBe(200);
    const after = await state(f); expect(after.notes).toHaveLength(1); expect(after.lines).toHaveLength(2);
    expect(after.lines.map((line: any) => line.claimDispositionId).sort()).toEqual([first.dispositionId, returned.dispositionId].sort());
    expect(String((after.notes[0] as any).currentAmount)).toBe('700'); expect(String(after.notes[0].openAmount)).toBe('700');
    expect(after.claim.totalCreditAmount.toString()).toBe('700'); expect(after.claim.totalReturnQty.toString()).toBe('2.5');
    const d = await db().claimDisposition.findUniqueOrThrow({ where: { id: returned.dispositionId } });
    expect(d.creditNoteId).toBe(after.notes[0].id); expect(d.returnReceiptId).toEqual(expect.any(String));
    expect(await models().returnReceiptLine.findFirstOrThrow({ where: { claimDispositionId: returned.dispositionId } })).toMatchObject({ returnReceiptId: d.returnReceiptId, materialCode: f.id + '-SKU', unit: 'M', disposition: 'Scrap' });
  });

});
