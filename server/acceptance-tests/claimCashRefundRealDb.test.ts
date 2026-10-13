/**
 * Actual Claim → assigned leader → CN → customer refund → payment decision →
 * Finance execution, private upload and settlement in the runner's private PG.
 * A2/A3 and the 9/17 role contract independently require a real financial outlet,
 * current Finance authority and one remaining-liability projection. Creating a
 * supplier voucher or merely approving a payment request is never customer Paid.
 * Canonical identities with isolated copies of the default grants and synthetic
 * payment documents are technical evidence, not company account UAT, a bank
 * transfer, bank verification of the payee, or bank confirmation of the later return facts. The return probes below use real system entry points with synthetic bank documents.
 * No approved dispositions, CN versions, refunds, payment facts or events are
 * hand-seeded. Deliberate corruption occurs only AFTER the real approval path.
 * No seed/bootstrap/index/scheduler/shared DB/reset; root owns execution/cleanup.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { DEFAULT_ROLE_PERMISSION_MATRIX, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createClaimRouter } from '../src/claims/claimRoute';
import { createClaimCashRefundReturnRouter } from '../src/claims/claimCashRefundReturnRoute';
import { createClaimCashRefundRouter } from '../src/claims/claimCashRefundRoute';
import { assertClaimCreditNoteVisibility } from '../src/claims/claimVisibility';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { createApprovalDecisionService } from '../src/approvals/approvalDecisionService';
import { createPaymentRequestRouter } from '../src/paymentRequests/paymentRequestRoute';
import { createPaymentRequestService } from '../src/paymentRequests/paymentRequestService';
import { createFinanceRouter } from '../src/finance/route';
import { createReceiptMatchProposalService } from '../src/finance/receiptMatchProposalService';
import { claimReceipt, listClaimableReceipts } from '../src/finance/receiptClaimService';
import { applyAllocation } from '../src/finance/allocationService';
import { updatePaymentVoucher, createPaymentVoucher } from '../src/finance/paymentVoucherMutationService';
import { creditNoteDigest } from '../src/claims/claimCreditNoteVersionService';
import { refundFenceId } from '../src/claims/claimCashRefundRequestFact';
import { loadPaymentRequestDocData, renderPaymentRequestBody } from '../src/templates/docTemplates/paymentRequest';

const prefix = 'acceptance-claim-cash-' + randomUUID();
let prisma: PrismaClient | undefined, privateBase = '', counter = 0;
const db = () => { if (!prisma) throw Error('Private cash refund cluster not initialized'); return prisma; };
const models = () => db() as any;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const proofBytes = Buffer.from('%PDF-1.4\nSynthetic private payment evidence for isolated test, no bank transfer\n%%EOF');

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Independent reviewed cash acceptance sandbox required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`,
    'verify private actual cluster identity BEFORE any fixture write').toEqual([{ name, directory, port: Number(port) }]);
  privateBase = await fs.mkdtemp(path.join(os.tmpdir(), 'bambook-cash-proof-'));
});
afterAll(async () => {
  await prisma?.$disconnect();
  if (privateBase) await fs.rm(privateBase, { recursive: true, force: true }); // only this generated file tree; never DB records
});

function app(database: PrismaClient = db(), privateFilesDir = path.join(privateBase, 'private')) {
  const application = express(); application.use(express.json());
  application.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  application.use(createAccountStatusGuard(db()));
  application.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  const approvalCreate = createApprovalCreateService({ prisma: database, routingService: createApprovalRoutingService({ prisma: database }) });
  const payments = createPaymentRequestService({ prisma: database, approvalCreateService: approvalCreate });
  application.use('/api/v1', createClaimRouter({ prisma: database, requireAuth: true }));
  application.use('/api/v1', createClaimCashRefundRouter({ prisma: database, privateFilesDir,
    uploadDir: path.join(privateBase, 'public'), assertCreditNoteVisible: assertClaimCreditNoteVisibility }));
  application.use('/api/v1', createClaimCashRefundReturnRouter({ prisma: database, privateFilesDir,
    uploadDir: path.join(privateBase, 'public'), assertCreditNoteVisible: assertClaimCreditNoteVisibility }));
  application.use('/api/v1/approvals', createApprovalRouter({ prisma: database, requireAuth: true,
    onDecided: async approval => {
      if (approval.actionType === 'finance:payment_request' && approval.targetType === 'PaymentRequest' && approval.targetId) {
        const result = await payments.syncApprovalDecision({ paymentRequestId: approval.targetId, actorId: approval.actualDecisionActor });
        if (!result.ok) throw Error('Actual payment projection rejected: ' + diagnostic(result.error));
      }
    } }));
  application.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma: database, requireAuth: true }));
  application.use('/api/v1/finance', createFinanceRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return application;
}
async function person(id: string, roleId: SystemRoleId, departmentId: string) {
  await db().userAccount.create({ data: { id, displayName: id, status: 'active', primaryDeptId: departmentId } });
  await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: roleId, isSystem: true } });
  const copy = id + '-default-copy'; await db().role.create({ data: { id: copy, name: 'Private default matrix copy', isSystem: false } });
  for (const assigned of [roleId, copy]) await db().userRole.create({ data: { id: id + '-role-' + assigned, userId: id, roleId: assigned, departmentId } });
  // Do not mutate shared canonical grants. If another file pollutes that role,
  // the explicit Finance/Sales assertions below fail instead of hiding it.
  for (const [scope, allowed] of Object.entries(DEFAULT_ROLE_PERMISSION_MATRIX[roleId])) {
    if (allowed !== true) continue;
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-grant-' + scope, roleId: copy, permissionId: permission.id } });
  }
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), id));
  return { id, copy, actor, token: createAuthService().signToken(actor) };
}
async function fixture() {
  const id = prefix + '-' + ++counter, departmentId = id + '-department';
  await db().department.create({ data: { id: departmentId, name: 'Private cash acceptance department' } });
  const leader = await person(id + '-leader', 'role-admin', departmentId);
  await db().department.update({ where: { id: departmentId }, data: { headId: leader.id } });
  const sales = await person(id + '-sales', 'role-sales', departmentId), finance = await person(id + '-finance', 'role-finance', departmentId);
  expect(sales.actor.permissions).toContain('aftersales:write'); expect(sales.actor.permissions).not.toContain('vouchers:write');
  expect(sales.actor.permissions).not.toContain('invoices:reconcile');
  expect(finance.actor.permissions).toEqual(expect.arrayContaining(['invoices:write', 'invoices:reconcile', 'vouchers:write', 'aftersales:read']));
  expect(finance.actor.permissions).not.toContain('aftersales:write');
  // Real team membership gives Sales read access to this Finance-created source
  // invoice; department membership alone is not a business data-scope grant.
  await db().team.create({ data: { id: id + '-team', name: id + '-team', departmentId } });
  for (const member of [sales.id, finance.id]) await db().teamMember.create({ data: { id: id + '-member-' + member, teamId: id + '-team', userId: member } });
  const customer = await db().relation.create({ data: { id: id + '-customer', name: 'Synthetic cash customer ' + counter,
    category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()),
    ownerId: sales.id, salesRepIds: [sales.id] } });
  const application = app();
  const invoice = await request(application).post('/api/v1/finance').set('Authorization', 'Bearer ' + finance.token)
    .send({ invoiceNumber: id + '-invoice', type: 'Receivable', status: 'Issued', amount: '1000', currency: 'USD',
      customerRelationId: customer.id, customerName: customer.name, issueDate: '2026-10-01' });
  expect(invoice.status, diagnostic(invoice.body)).toBe(201);
  const created = await request(application).post('/api/v1/claims').set('Authorization', 'Bearer ' + sales.token)
    .send({ customerRelationId: customer.id, sourceInvoiceId: invoice.body.id, problemDesc: 'Actual cash refund acceptance' });
  expect(created.status, diagnostic(created.body)).toBe(201);
  const f = { id, departmentId, leader, sales, finance, customer, invoiceId: invoice.body.id as string,
    caseId: created.body.claimCase.id as string, creditNoteId: '', app: application };
  await appendMoney(f, 'initial', '500');
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Person = Fixture['sales'];
const post = (f: Fixture, suffix: string, body: any, who: Person = f.sales, application = f.app) =>
  request(application).post('/api/v1/' + suffix).set('Authorization', 'Bearer ' + who.token).send(body);
const get = (f: Fixture, suffix: string, who: Person = f.sales, application = f.app) =>
  request(application).get('/api/v1/' + suffix).set('Authorization', 'Bearer ' + who.token);
async function appendMoney(f: Omit<Fixture, never>, label: string, amount: string) {
  const added = await post(f, 'claims/' + f.caseId + '/dispositions', { kind: 'Allowance', amount, currency: 'USD', notes: label });
  expect(added.status, diagnostic(added.body)).toBe(201);
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: added.body.approvalRequestId } });
  expect(approval).toMatchObject({ requesterId: f.sales.id, reviewerId: f.leader.id, actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', status: 'pending' });
  const decided = await post(f, 'approvals/' + approval.id + '/decide', { status: 'approved', decisionNote: 'Actual synthetic general leader' }, f.leader);
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  const advanced = await post(f, 'claims/dispositions/' + added.body.disposition.id + '/approve', {}); expect(advanced.status, diagnostic(advanced.body)).toBe(200);
  const executed = await post(f, 'claims/dispositions/' + added.body.disposition.id + '/execute', { clientRequestId: 'EXEC-' + label });
  expect(executed.status, diagnostic(executed.body)).toBe(200); f.creditNoteId = executed.body.creditNote.id;
  expect(await models().claimCreditNoteLine.count({ where: { creditNoteId: f.creditNoteId } })).toBeGreaterThan(0);
}
const createBody = (f: Fixture, requestId = 'refund-create', amount = '125', version = 1) => ({
  clientRequestId: requestId, expectedVersion: version, amount, reason: 'Customer cash repayment', expectedPaymentDate: '2026-10-05',
  payeeSnapshot: { accountHolder: f.customer.name, accountNumber: 'synthetic-customer-account', bankName: 'Synthetic customer bank', swift: 'TESTBANK', method: 'TT' },
});
async function createRefund(f: Fixture, body = createBody(f), application = f.app) {
  const response = await post(f, 'credit-notes/' + f.creditNoteId + '/refunds', body, f.sales, application);
  expect(response.status, diagnostic(response.body)).toBe(201);
  expect(response.body.refund).toMatchObject({ creditNoteId: f.creditNoteId, customerRelationId: f.customer.id, requesterId: f.sales.id, requestId: body.clientRequestId, status: 'PendingApproval' });
  expect(response.body.paymentRequest).toMatchObject({ payeeType: 'Customer', customerRelationId: f.customer.id,
    customerName: f.customer.name, supplierId: null, supplierName: null, status: 'Pending', reviewerId: f.leader.id });
  return response.body as any;
}
async function decideRefund(f: Fixture, refund: any, status = 'approved') {
  const pending = await db().approvalRequest.findUniqueOrThrow({ where: { id: refund.paymentRequest.approvalRequestId } });
  expect(pending).toMatchObject({ requesterId: f.sales.id, reviewerId: f.leader.id, actionType: 'finance:payment_request', targetType: 'PaymentRequest', targetId: refund.paymentRequest.id });
  const response = await post(f, 'approvals/' + pending.id + '/decide', { status, decisionNote: 'Actual assigned payment decision' }, f.leader);
  expect(response.status, diagnostic(response.body)).toBe(200);
  const current = await models().creditNoteRefund.findUniqueOrThrow({ where: { id: refund.refund.id } });
  expect(current.status).toBe(status === 'approved' ? 'Approved' : 'Rejected');
  expect(await db().paymentRequest.findUniqueOrThrow({ where: { id: refund.paymentRequest.id } })).toMatchObject({ status: current.status, paymentVoucherId: null });
  const audit = await db().auditLog.findUniqueOrThrow({ where: { id: current.decisionAuditId } });
  expect(audit.actorId).toBe(f.leader.id);
  expect((audit.detail as any).decisionActorAuthority).toMatchObject({ userId: f.leader.id, roleIds: expect.arrayContaining(['role-admin']), authorizationLoaded: true });
  return current;
}
async function approvedRefund(f: Fixture, body = createBody(f)) { const made = await createRefund(f, body); await decideRefund(f, made); return made; }
async function start(f: Fixture, r: any, requestId = 'start-1', who = f.finance) {
  const response = await post(f, 'credit-note-refunds/' + r.refund.id + '/start', { clientRequestId: requestId }, who);
  expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.refund.status).toBe('Executing'); return response;
}
async function upload(f: Fixture, r: any, purpose = 'PaymentProof', application = f.app) {
  const response = await request(application).post('/api/v1/credit-note-refunds/' + r.refund.id + '/evidence')
    .set('Authorization', 'Bearer ' + f.finance.token).field('purpose', purpose).attach('file', proofBytes, { filename: 'synthetic-bank-proof.pdf', contentType: 'application/pdf' });
  expect(response.status, diagnostic(response.body)).toBe(201);
  expect(response.body).toMatchObject({ refundId: r.refund.id, purpose, uploadedBy: f.finance.id, fileSize: proofBytes.length });
  expect(response.body.privateStorageKey).toBeUndefined(); return response.body;
}
const paidBody = (evidence: any, id = 'paid-1') => ({ clientRequestId: id, actualDate: '2026-10-01', actualMethod: 'TT', paymentReference: 'synthetic-bank-reference', evidenceIds: [evidence.id] });
async function paid(f: Fixture, r: any, input: any, application = f.app, who = f.finance) {
  return post(f, 'credit-note-refunds/' + r.refund.id + '/confirm', input, who, application);
}
async function state(f: Fixture) {
  const refunds = await models().creditNoteRefund.findMany({ where: { creditNoteId: f.creditNoteId }, orderBy: { id: 'asc' } });
  const returns = await models().creditNoteRefundReturn.findMany({ where: { creditNoteId: f.creditNoteId }, orderBy: { id: 'asc' } });
  const ids = refunds.map((r: any) => r.id), requestIds = refunds.map((r: any) => r.paymentRequestId), voucherIds = [...refunds.map((r: any) => r.paymentVoucherId), ...returns.map((r: any) => r.receiptVoucherId)].filter(Boolean);
  const paymentRequests = await db().paymentRequest.findMany({ where: { id: { in: requestIds } }, orderBy: { id: 'asc' } });
  return { note: await db().creditNote.findUniqueOrThrow({ where: { id: f.creditNoteId } }), refunds, paymentRequests, returns,
    returnEvidence: await models().creditNoteRefundReturnEvidence.findMany({ where: { returnId: { in: returns.map((r: any) => r.id) } }, orderBy: { id: 'asc' } }),
    approvalRequests: await db().approvalRequest.findMany({ where: { id: { in: paymentRequests.map(r => r.approvalRequestId!).filter(Boolean) } }, orderBy: { id: 'asc' } }),
    refundEvents: await models().creditNoteRefundEvent.findMany({ where: { refundId: { in: ids } }, orderBy: [{ refundId: 'asc' }, { sequence: 'asc' }] }),
    evidence: await models().creditNoteRefundEvidence.findMany({ where: { refundId: { in: ids } }, orderBy: { id: 'asc' } }),
    settlements: await models().creditNoteSettlementEvent.findMany({ where: { creditNoteId: f.creditNoteId }, orderBy: { id: 'asc' } }),
    allocations: await db().creditNoteAllocation.findMany({ where: { creditNoteId: f.creditNoteId }, orderBy: { id: 'asc' } }),
    vouchers: await db().paymentVoucher.findMany({ where: { OR: [{ id: { in: voucherIds } }, { customerRelationId: f.customer.id }] }, orderBy: { id: 'asc' } }),
    voucherAllocations: await db().invoiceAllocation.findMany({ where: { voucherId: { in: voucherIds } }, orderBy: { id: 'asc' } }),
    invoice: await db().invoice.findUniqueOrThrow({ where: { id: f.invoiceId } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: [f.sales.id, f.finance.id, f.leader.id] },
      action: { in: ['CREDIT_NOTE_REFUND_EVENT', 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED', 'CREDIT_NOTE_SETTLED', 'CREDIT_NOTE_REFUND_RETURN_RECORDED', 'CREDIT_NOTE_REFUND_REQUEST_RETIRED'] } }, orderBy: { id: 'asc' } }),
  };
}
async function denied(f: Fixture, action: () => Promise<any>, status = 409) {
  const before = await state(f), response = await action(); expect(response.status, diagnostic(response.body)).toBe(status);
  expect(await state(f)).toEqual(before); return response;
}
function sqlFault(f: Fixture, predicate: (args: any) => boolean) {
  const observed: { count: number; code?: string; staged?: any } = { count: 0 };
  const database = new Proxy(db(), { get(target, key) {
    if (key !== '$transaction') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return (callback: any, opts?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field !== 'auditLog') { const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value; }
      return new Proxy(client.auditLog, { get(delegate, method) {
        if (method !== 'create') { const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value; }
        return async (args: any) => {
          if (!predicate(args)) return delegate.create(args);
          observed.count++;
          const current: any = client;
          observed.staged = { cashReturns: await current.creditNoteRefundReturn.count({ where: { creditNoteId: f.creditNoteId } }),
            returnEvents: await current.creditNoteSettlementEvent.count({ where: { creditNoteId: f.creditNoteId, kind: 'CashRefundReturn' } }), vouchers: await client.paymentVoucher.count({ where: { customerRelationId: f.customer.id } }),
            refundEvents: await current.creditNoteRefundEvent.count({ where: { refund: { creditNoteId: f.creditNoteId }, kind: 'Paid' } }),
            settlements: await current.creditNoteSettlementEvent.count({ where: { creditNoteId: f.creditNoteId, kind: 'CashRefund' } }),
            note: await client.creditNote.findUnique({ where: { id: f.creditNoteId } }) };
          try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-actor' } }); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
      } });
    } })), opts);
  } });
  return { database, observed };
}

/** Delay only the real transaction's first parent lock. The HTTP command and
 * every business fact still use the real native services and real PostgreSQL. */
function delayedParentLock(f: Fixture) {
  let release!: () => void, markEntered!: () => void, delayed = false;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const database = new Proxy(db(), { get(target, key) {
    if (key !== '$transaction') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return (callback: any, opts?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      const value = Reflect.get(client, field);
      if (field !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(client) : value;
      return async (sql: string, ...args: any[]) => {
        if (!delayed && /FOR UPDATE/.test(sql) && args.includes(f.caseId)) { delayed = true; markEntered(); await resume; }
        return client.$queryRawUnsafe(sql, ...args);
      };
    } })), { ...opts, timeout: 15000 });
  } });
  return { database, entered, release };
}
const checkBody = (action: string, originalPayload: any) => ({ action, originalClientRequestId: originalPayload.clientRequestId, originalPayload });
const retireBody = (action: string, originalPayload: any, key = 'retire-' + originalPayload.clientRequestId) => ({
  ...checkBody(action, originalPayload), retirementClientRequestId: key, reason: 'Explicitly correct the saved system-entry request; no bank action',
});

describe.sequential('Actual customer cash refunds, finance responsibilities and immutable payouts in isolated PG', () => {
  it('CASH01 actual defaults separate Sales claim/issuance and Finance offset/payment, approval/start reserve without paying', async () => {
    const f = await fixture(), r = await createRefund(f);
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body).toMatchObject({ reservedAmount: '125', availableToSettle: '375' });
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/apply', { appliedAmount: '25', toInvoiceId: f.invoiceId, clientRequestId: 'sales-offset' }), 403);
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/issue', { expectedVersion: 1, clientRequestId: 'finance-issue' }, f.finance), 403);
    const issued = await post(f, 'credit-notes/' + f.creditNoteId + '/issue', { expectedVersion: 1, clientRequestId: 'sales-issue' }); expect(issued.status, diagnostic(issued.body)).toBe(200);
    await decideRefund(f, r);
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/start', { clientRequestId: 'sales-start' }), 403);
    await start(f, r);
    const current = await state(f); expect(String(current.note.openAmount)).toBe('500'); expect(current.vouchers).toEqual([]); expect(current.settlements).toEqual([]);
    expect(current.paymentRequests[0]).toMatchObject({ payeeType: 'Customer', status: 'Executing', paymentVoucherId: null });
    const view = await get(f, 'credit-note-refunds/' + r.refund.id, f.finance); expect(view.status, diagnostic(view.body)).toBe(200);
    expect(view.body).toMatchObject({ reservedAmount: '125', availableToSettle: '375', refund: { status: 'Executing', requestId: 'refund-create', requesterId: f.sales.id } });
    await denied(f, () => post(f, 'payment-requests/' + r.paymentRequest.id + '/issue-voucher', {}, f.finance));
  });
  it('CASH02 actual multipart private evidence and exact date/method/reference produce one immutable Paid outlet; exact replays do not burn twice', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r), input = paidBody(evidence);
    const confirmed = await paid(f, r, input); expect(confirmed.status, diagnostic(confirmed.body)).toBe(200);
    expect(confirmed.body.creditNote).toMatchObject({ openAmount: '375', status: 'PartiallyApplied', refundedAt: input.actualDate, refundedBy: f.finance.id });
    expect(confirmed.body.paymentVoucher).toMatchObject({ type: 'Disbursement', customerRelationId: f.customer.id, customerName: f.customer.name,
      amount: '125', currency: 'USD', paymentDate: '2026-10-01', paymentMethod: 'TT', voucherCategory: 'customer_reimburse',
      attachments: { paymentReference: input.paymentReference, evidenceIds: [evidence.id], paymentRequestId: r.paymentRequest.id } });
    expect(confirmed.body.paymentVoucher.paymentDate).not.toBe(r.paymentRequest.expectedPaymentDate);
    const committed = await state(f); expect(committed.settlements).toHaveLength(1); expect(committed.vouchers).toHaveLength(1);
    expect(committed.settlements[0]).toMatchObject({ kind: 'CashRefund', refundId: r.refund.id, paymentVoucherId: confirmed.body.paymentVoucher.id, actorId: f.finance.id, requestId: input.clientRequestId });
    const replay = await paid(f, r, input); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.paymentVoucher.id).toBe(confirmed.body.paymentVoucher.id); expect(await state(f)).toEqual(committed);
    await denied(f, () => paid(f, r, { ...input, actualDate: '2026-10-02' }));
    const download = await get(f, 'credit-note-refunds/' + r.refund.id + '/evidence/' + evidence.id, f.finance);
    expect(download.status, diagnostic(download.body)).toBe(200); expect(download.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(download.body)).toEqual(proofBytes);
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body).toMatchObject({ reservedAmount: '0', availableToSettle: '375' });
  });
  it('CASH03 pending reservations and concurrent real requests cannot consume the same CN liability or over-offset it', async () => {
    const f = await fixture(), responses = await Promise.all([
      post(f, 'credit-notes/' + f.creditNoteId + '/refunds', createBody(f, 'concurrent-a', '300')),
      post(f, 'credit-notes/' + f.creditNoteId + '/refunds', createBody(f, 'concurrent-b', '300')),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]); expect((await state(f)).refunds).toHaveLength(1);
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/apply', { appliedAmount: '201', toInvoiceId: f.invoiceId, clientRequestId: 'too-much' }, f.finance));
    const offset = await post(f, 'credit-notes/' + f.creditNoteId + '/apply', { appliedAmount: '200', toInvoiceId: f.invoiceId, clientRequestId: 'actual-offset' }, f.finance);
    expect(offset.status, diagnostic(offset.body)).toBe(200); expect(offset.body.creditNote.openAmount).toBe('300');
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body).toMatchObject({ reservedAmount: '300', availableToSettle: '0' });
  });
  it('CASH04 same create ID and complete parameters replay once; changed amount/account/actor cannot create a second request', async () => {
    const f = await fixture(), body = createBody(f), r = await createRefund(f, body), committed = await state(f);
    const replay = await post(f, 'credit-notes/' + f.creditNoteId + '/refunds', body); expect(replay.status, diagnostic(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, refund: { id: r.refund.id, requesterId: f.sales.id, requestId: body.clientRequestId } }); expect(await state(f)).toEqual(committed);
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', { ...body, amount: '126' }));
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', { ...body, payeeSnapshot: { ...body.payeeSnapshot, accountNumber: 'changed' } }));
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', body, f.finance));
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', createBody(f, 'stale', '10', 2)));
  });
  it('CASH05 an approved exact old CN version survives lawful append; expectedVersion is checked only on new requests', async () => {
    const f = await fixture(), r = await approvedRefund(f), original = await models().creditNoteDocumentVersion.findUniqueOrThrow({ where: { id: r.refund.versionId } });
    await appendMoney(f, 'lawful-append', '75'); await start(f, r); const evidence = await upload(f, r);
    const confirmed = await paid(f, r, paidBody(evidence)); expect(confirmed.status, diagnostic(confirmed.body)).toBe(200);
    expect(confirmed.body.creditNote.openAmount).toBe('450'); expect(await models().creditNoteDocumentVersion.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body.versions).toHaveLength(2);
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', createBody(f, 'new-stale', '25', 1)));
  });
  it('CASH06 assigned decisions reject changed full payment snapshot before approving, and consumption rejects later account mutation', async () => {
    const f = await fixture(), pending = await createRefund(f);
    await db().paymentRequest.update({ where: { id: pending.paymentRequest.id }, data: { totalAmount: '126' } });
    await denied(f, () => post(f, 'approvals/' + pending.paymentRequest.approvalRequestId + '/decide', { status: 'approved', decisionNote: 'Must refuse wrong amount' }, f.leader));
    const second = await fixture(), approved = await approvedRefund(second);
    await models().creditNoteRefund.update({ where: { id: approved.refund.id }, data: { payeeSnapshot: { ...approved.refund.payeeSnapshot, accountNumber: 'damaged-after-real-decision' } } });
    await denied(second, () => post(second, 'credit-note-refunds/' + approved.refund.id + '/start', { clientRequestId: 'damaged-start' }, second.finance));
  });
  it('CASH07 missing/foreign server evidence and wrong actual method/date cannot record Paid; stored private bytes must match their hash', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r), input = paidBody(evidence);
    await denied(f, () => paid(f, r, { ...input, evidenceIds: [] }), 400);
    await denied(f, () => paid(f, r, { ...input, evidenceIds: [prefix + '-foreign-evidence'] }));
    await denied(f, () => paid(f, r, { ...input, actualMethod: 'Cash' }));
    await denied(f, () => paid(f, r, { ...input, actualDate: '2026-02-30' }), 400);
    const row = await models().creditNoteRefundEvidence.findUniqueOrThrow({ where: { id: evidence.id } });
    await fs.writeFile(path.join(privateBase, 'private', row.privateStorageKey), Buffer.from('changed private bytes'));
    await denied(f, () => paid(f, r, input));
  });
  it.each(['wrong action', 'modified'])('CASH06B actual refund FK protects the kernel from %s before any decision or financial projection', async variant => {
    const f = await fixture(), r = await createRefund(f);
    if (variant === 'wrong action') {
      await db().approvalRequest.update({ where: { id: r.paymentRequest.approvalRequestId }, data: { actionType: 'finance:unrelated-request' } });
      await denied(f, () => post(f, 'approvals/' + r.paymentRequest.approvalRequestId + '/decide', { status: 'approved', decisionNote: 'True refund FK cannot become another action' }, f.leader));
    } else {
      const before = await state(f);
      await expect(createApprovalDecisionService(db()).decide({ id: r.paymentRequest.approvalRequestId,
        actor: { userId: f.leader.id, roles: f.leader.actor.roles, roleIds: f.leader.actor.roleIds, authorizationLoaded: true },
        decision: 'modified', source: 'api:agent', decisionNote: 'Changed account needs a new request', modifiedInput: { amount: '1' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', statusCode: 400 });
      expect(await state(f)).toEqual(before);
    }
  });
  it('CASH08 reject/cancel/resubmit release only unexecuted reservations and preserve original approvals, real decision actors and supersession history', async () => {
    const f = await fixture(), r = await createRefund(f); await decideRefund(f, r, 'rejected');
    const rejectedApproval = await db().approvalRequest.findUniqueOrThrow({ where: { id: r.paymentRequest.approvalRequestId } });
    const successor = await post(f, 'credit-note-refunds/' + r.refund.id + '/resubmit', createBody(f, 'retry-approved', '150'));
    expect(successor.status, diagnostic(successor.body)).toBe(201); expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: rejectedApproval.id } })).toEqual(rejectedApproval);
    await decideRefund(f, successor.body); const approved = await db().approvalRequest.findUniqueOrThrow({ where: { id: successor.body.paymentRequest.approvalRequestId } });
    const cancelled = await post(f, 'credit-note-refunds/' + successor.body.refund.id + '/cancel', { clientRequestId: 'cancel-1', reason: 'No bank execution yet' });
    expect(cancelled.status, diagnostic(cancelled.body)).toBe(200); expect(cancelled.body.refund.status).toBe('Cancelled');
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(approved);
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body).toMatchObject({ reservedAmount: '0', availableToSettle: '500' });
    expect((await state(f)).refundEvents.map((event: any) => event.kind)).toEqual(expect.arrayContaining(['Requested', 'Rejected', 'Resubmitted', 'Approved', 'Cancelled']));
    const pending = await createRefund(f, createBody(f, 'pending-replaced', '30'));
    const next = await post(f, 'credit-note-refunds/' + pending.refund.id + '/resubmit', createBody(f, 'pending-new', '35')); expect(next.status, diagnostic(next.body)).toBe(201);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: pending.paymentRequest.approvalRequestId } })).toMatchObject({ status: 'cancelled', requesterId: f.sales.id });
    await denied(f, () => post(f, 'approvals/' + pending.paymentRequest.approvalRequestId + '/decide', { status: 'approved', decisionNote: 'Superseded cannot approve' }, f.leader));
  });
  it('CASH09 unresolved bank execution cannot be cancelled; actual server failure proof returns to Approved while retaining the reservation', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r);
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/cancel', { clientRequestId: 'unsafe-cancel', reason: 'Bank result unknown' }));
    const evidence = await upload(f, r, 'PaymentFailure'), body = { clientRequestId: 'bank-failure', occurredAt: '2026-10-01', reference: 'synthetic-bank-decline', reason: 'Bank confirms no debit', evidenceIds: [evidence.id] };
    const failed = await post(f, 'credit-note-refunds/' + r.refund.id + '/failure', body, f.finance); expect(failed.status, diagnostic(failed.body)).toBe(200);
    expect(failed.body.refund.status).toBe('Approved'); const committed = await state(f); expect(committed.vouchers).toEqual([]); expect(String(committed.note.openAmount)).toBe('500');
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body).toMatchObject({ reservedAmount: '125', availableToSettle: '375' });
    const replay = await post(f, 'credit-note-refunds/' + r.refund.id + '/failure', body, f.finance); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true); expect(await state(f)).toEqual(committed);
    await start(f, r, 'start-after-real-failure');
  });
  it('CASH10 actual Finance grant removal defeats a previously signed write token without modifying payment/credit history', async () => {
    const f = await fixture(), r = await approvedRefund(f), permission = await db().permission.findUniqueOrThrow({ where: { scope: 'vouchers:write' } });
    await db().rolePermission.deleteMany({ where: { roleId: f.finance.copy, permissionId: permission.id } });
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/start', { clientRequestId: 'stale-finance-start' }, f.finance), 403);
  });
  it('CASH11 generic voucher HTTP mutations and direct Agent/proposal allocation kernel cannot rewrite, destroy or allocate a Paid refund', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r);
    const confirmed = await paid(f, r, paidBody(evidence)); expect(confirmed.status, diagnostic(confirmed.body)).toBe(200); const voucherId = confirmed.body.paymentVoucher.id;
    await denied(f, () => request(f.app).patch('/api/v1/finance/vouchers/' + voucherId).set('Authorization', 'Bearer ' + f.finance.token).send({ amount: '126' }));
    await denied(f, () => post(f, 'finance/vouchers/' + voucherId + '/cancel', { reason: 'Do not fake a bank return' }, f.finance));
    await denied(f, () => request(f.app).delete('/api/v1/finance/vouchers/' + voucherId).set('Authorization', 'Bearer ' + f.finance.token));
    await denied(f, () => post(f, 'finance/allocations', { invoiceId: f.invoiceId, voucherId, appliedAmount: '25', appliedDate: '2026-10-01' }, f.finance));
    const before = await state(f);
    await expect(db().$transaction(tx => applyAllocation(db(), tx, { invoiceId: f.invoiceId, voucherId, appliedAmount: '25', actorId: f.finance.id, source: 'acceptance actual shared Agent kernel' }))).rejects.toMatchObject({ code: 'INVALID_STATE', statusCode: 409 });
    expect(await state(f)).toEqual(before);
    const direct = await updatePaymentVoucher({ prisma: db(), voucherId, input: { amount: '126' }, actorId: f.finance.id });
    expect(direct).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } }); expect(await state(f)).toEqual(before);
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/cancel', { clientRequestId: 'fake-paid-cancel', reason: 'Cannot restore paid cash by metadata' }));
  });
  it.each(['Paid-event', 'Settlement'])('CASH12 actual required %s audit FK P2003 rolls back all staged voucher, payment status, events and CN balance', async auditKind => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r);
    const fault = sqlFault(f, args => auditKind === 'Paid-event'
      ? args.data.detail?.cashRefundEvent?.kind === 'Paid' : args.data.action === 'CREDIT_NOTE_SETTLED');
    const response = await denied(f, () => paid(f, r, paidBody(evidence), app(fault.database)), 500);
    expect(response.body).toMatchObject({ error: 'CLAIM_CASH_REFUND_FAILED' }); expect(response.body.message).not.toMatch(/Prisma|P2003|foreign key|CreditNoteRefund|SELECT/);
    expect(fault.observed).toMatchObject({ count: 1, code: 'P2003', staged: { vouchers: 1 } });
    if (auditKind === 'Settlement') expect(fault.observed.staged).toMatchObject({ refundEvents: 1, settlements: 1, note: { openAmount: expect.anything() } });
    expect(String((await state(f)).note.openAmount)).toBe('500'); expect((await state(f)).vouchers).toEqual([]);
  });
  it('CASH13 concurrent same Paid command returns the same immutable voucher and bank-reference fact, not two payouts', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r), body = paidBody(evidence);
    const responses = await Promise.all([paid(f, r, body), paid(f, r, body)]);
    for (const response of responses) expect(response.status, diagnostic(response.body)).toBe(200);
    expect(responses[0].body.paymentVoucher.id).toBe(responses[1].body.paymentVoucher.id);
    const after = await state(f); expect(after.vouchers).toHaveLength(1); expect(after.settlements).toHaveLength(1);
    expect(after.refundEvents.filter((event: any) => event.kind === 'Paid')).toHaveLength(1); expect(String(after.note.openAmount)).toBe('375');
  });
  it('CASH14 known foreign refund/evidence IDs obey actual parent scope, and missing required private/visibility dependencies cannot confirm', async () => {
    const f = await fixture(), other = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r);
    await denied(f, () => get(f, 'credit-note-refunds/' + r.refund.id, other.sales), 404);
    await denied(f, () => get(f, 'credit-note-refunds/' + r.refund.id + '/evidence/' + evidence.id, other.sales), 404);
    const missing = express(); missing.use(express.json()); missing.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    missing.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
    missing.use('/api/v1', createClaimCashRefundRouter({ prisma: db(), privateFilesDir: path.join(privateBase, 'private'), uploadDir: path.join(privateBase, 'public') }));
    await denied(f, () => paid(f, r, paidBody(evidence), missing), 503);
    const publicStorage = app(db(), path.join(privateBase, 'public', 'must-not-be-public'));
    const rejected = await request(publicStorage).post('/api/v1/credit-note-refunds/' + r.refund.id + '/evidence')
      .set('Authorization', 'Bearer ' + f.finance.token).attach('file', proofBytes, { filename: 'bank-proof.pdf' });
    expect(rejected.status, diagnostic(rejected.body)).toBe(503);
  });
  it('CASH15 cash standalone read serializes real Decimal and BigInt without index prototype or an application JSON replacer', async () => {
    const f = await fixture(), r = await createRefund(f, createBody(f, 'decimal-exact', '0.0001'));
    const standalone = express(); standalone.use(express.json());
    standalone.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
    standalone.use('/api/v1', createClaimCashRefundRouter({ prisma: db(), privateFilesDir: path.join(privateBase, 'private'),
      uploadDir: path.join(privateBase, 'public'), assertCreditNoteVisible: assertClaimCreditNoteVisibility }));
    const response = await get(f, 'credit-note-refunds/' + r.refund.id, f.finance, standalone);
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.refund.amount).toBe('0.0001');
    expect(typeof response.body.refund.createdAt).toBe('string'); expect(response.body).toMatchObject({ reservedAmount: '0.0001', availableToSettle: '499.9999' });
  });
  it('CASH16 a lost create/start/confirm response resolves to exact immutable acknowledgements after later state and version changes', async () => {
    const f = await fixture(), original = createBody(f, 'lost-create'), r = await createRefund(f, original);
    await decideRefund(f, r); const startedBody = { clientRequestId: 'lost-start' };
    await start(f, r, startedBody.clientRequestId); const evidence = await upload(f, r), confirmedBody = paidBody(evidence, 'lost-confirm');
    expect((await paid(f, r, confirmedBody)).status).toBe(200);
    await appendMoney(f, 'healthy-source-append', '75');
    const before = await state(f);
    const createCheck = await post(f, 'credit-notes/' + f.creditNoteId + '/refund-request-result', checkBody('create', original));
    expect(createCheck.status, diagnostic(createCheck.body)).toBe(200);
    expect(createCheck.body).toMatchObject({ schemaVersion: 1, state: 'applied', action: 'create', actorId: f.sales.id,
      originalPayload: original, originalParameterHash: creditNoteDigest(original), parent: { creditNoteId: f.creditNoteId, refundId: null },
      ack: { refundId: r.refund.id, kind: 'Requested', statusAtExecution: 'PendingApproval' }, meaning: 'system_record_only' });
    for (const [action, body, kind, status] of [['start', startedBody, 'Started', 'Executing'], ['confirm', confirmedBody, 'Paid', 'Paid']] as const) {
      const check = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-result', checkBody(action, body), f.finance);
      expect(check.status, diagnostic(check.body)).toBe(200); expect(check.body).toMatchObject({ state: 'applied', actorId: f.finance.id,
        originalPayload: body, originalParameterHash: creditNoteDigest(body), ack: { kind, refundId: r.refund.id, statusAtExecution: status } });
      const retire = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', retireBody(action, body), f.finance);
      expect(retire.status, diagnostic(retire.body)).toBe(200); expect(retire.body.state).toBe('applied'); expect(retire.body.fenceAuditId).toBeUndefined();
    }
    const conflict = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-result', checkBody('confirm', { ...confirmedBody, actualDate: '2026-10-02' }), f.finance);
    expect(conflict.body.state).toBe('conflict'); expect(await state(f)).toEqual(before);
  });
  it('CASH17 missing request lookup is unknown, but a committed permanent fence blocks a queued late real creation', async () => {
    const f = await fixture(), original = createBody(f, 'late-create'), path = 'credit-notes/' + f.creditNoteId;
    const missing = await post(f, path + '/refund-request-result', checkBody('create', original));
    expect(missing.status, diagnostic(missing.body)).toBe(200); expect(missing.body).toMatchObject({ state: 'unknown', retry: 'same_request_only' });
    const delayed = delayedParentLock(f), late = post(f, path + '/refunds', original, f.sales, app(delayed.database)).then(response => response);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([delayed.entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Actual writer did not reach reviewed parent lock')), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
      const retire = await post(f, path + '/refund-request-retire', retireBody('create', original));
      expect(retire.status, diagnostic(retire.body)).toBe(200); expect(retire.body).toMatchObject({ state: 'not_applied',
        fenceAuditId: refundFenceId(f.creditNoteId, original.clientRequestId), originalPayload: original, originalParameterHash: creditNoteDigest(original) });
    } finally { delayed.release(); }
    const lateResponse = await late; expect(lateResponse.status, diagnostic(lateResponse.body)).toBe(409);
    const after = await state(f); expect(after.refunds).toEqual([]); expect(after.paymentRequests).toEqual([]); expect(after.vouchers).toEqual([]); expect(String(after.note.openAmount)).toBe('500');
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: refundFenceId(f.creditNoteId, original.clientRequestId) } });
    expect(audit).toMatchObject({ actorId: f.sales.id, action: 'CREDIT_NOTE_REFUND_REQUEST_RETIRED' });
    expect((audit.detail as any).cashRefundRequestFence).toMatchObject({ originalPayload: original, state: 'not_applied' });
  });
  it('CASH18 concurrent fence retries return one exact mandatory audit; body, actor, child and action changes cannot split the terminal key', async () => {
    const f = await fixture(), r = await approvedRefund(f), original = { clientRequestId: 'fenced-start' }, body = retireBody('start', original);
    const responses = await Promise.all([post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', body, f.finance), post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', body, f.finance)]);
    for (const response of responses) expect(response.status, diagnostic(response.body)).toBe(200);
    expect(responses[0].body).toEqual(responses[1].body); expect(responses[0].body.state).toBe('not_applied');
    expect(await db().auditLog.count({ where: { id: responses[0].body.fenceAuditId } })).toBe(1);
    const conflict = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', { ...body, reason: 'Different retirement reason' }, f.finance);
    expect(conflict.body.state).toBe('conflict');
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/start', original, f.finance));
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/cancel', { ...original, reason: 'Cannot bypass through another action' }));
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/confirm', { ...original, actualDate: '2026-02-30' }, f.finance));
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/failure', { ...original, occurredAt: '2026-02-30' }, f.finance));
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/resubmit', createBody(f, original.clientRequestId)));
    const other = await approvedRefund(f, createBody(f, 'another-child'));
    await denied(f, () => post(f, 'credit-note-refunds/' + other.refund.id + '/start', original, f.finance));
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', createBody(f, original.clientRequestId)));
  });
  it('CASH19 a rejected old payload/version can be explicitly fenced and corrected with a new ID; the late old key stays blocked', async () => {
    const f = await fixture(), invalid = createBody(f, 'invalid-old', '0');
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', invalid), 400);
    const retired = await post(f, 'credit-notes/' + f.creditNoteId + '/refund-request-retire', retireBody('create', invalid));
    expect(retired.status, diagnostic(retired.body)).toBe(200); expect(retired.body.state).toBe('not_applied');
    await appendMoney(f, 'source-now-v2', '25');
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', { ...invalid, expectedVersion: 2, amount: '125' }));
    const stale = createBody(f, 'stale-v1', '125', 1);
    await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refunds', stale));
    const staleRetired = await post(f, 'credit-notes/' + f.creditNoteId + '/refund-request-retire', retireBody('create', stale));
    expect(staleRetired.body.state).toBe('not_applied');
    const corrected = await createRefund(f, createBody(f, 'new-corrected-v2', '125', 2));
    expect(corrected.refund.status).toBe('PendingApproval'); expect((await state(f)).refunds).toHaveLength(1);
  });
  it('CASH20 retiring an unknown confirm concerns system entry only and retains Executing/reservation until accurate payment facts use a new key', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const evidence = await upload(f, r), original = { ...paidBody(evidence, 'unknown-confirm'), actualDate: '2026-02-30' };
    await denied(f, () => paid(f, r, original), 400);
    const before = await state(f), retired = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', retireBody('confirm', original), f.finance);
    expect(retired.status, diagnostic(retired.body)).toBe(200); expect(retired.body).toMatchObject({ state: 'not_applied', meaning: 'system_record_only' });
    const after = await state(f);
    expect({ ...after, audits: after.audits.filter(audit => audit.id !== retired.body.fenceAuditId) }).toEqual(before);
    const fence = after.audits.find(audit => audit.id === retired.body.fenceAuditId);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(fence).toMatchObject({ actorId: f.finance.id, action: 'CREDIT_NOTE_REFUND_REQUEST_RETIRED' });
    expect((fence!.detail as any).cashRefundRequestFence).toMatchObject({ originalPayload: original, state: 'not_applied' });
    expect(before.refunds[0].status).toBe('Executing'); expect(before.vouchers).toEqual([]);
    expect((await get(f, 'credit-notes/' + f.creditNoteId + '/versions', f.finance)).body.reservedAmount).toBe('125');
    await denied(f, () => paid(f, r, paidBody(evidence, original.clientRequestId)));
    const corrected = await paid(f, r, paidBody(evidence, 'accurate-confirm-new-key'));
    expect(corrected.status, diagnostic(corrected.body)).toBe(200); expect((await state(f)).vouchers).toHaveLength(1);
  });
  it('CASH21 real mandatory fence audit FK rollback yields no negative receipt and the exact old request remains retryable', async () => {
    const f = await fixture(), original = createBody(f, 'no-fence-on-fault'), fault = sqlFault(f, args => args.data.action === 'CREDIT_NOTE_REFUND_REQUEST_RETIRED');
    const rejected = await denied(f, () => post(f, 'credit-notes/' + f.creditNoteId + '/refund-request-retire', retireBody('create', original), f.sales, app(fault.database)), 500);
    expect(rejected.body.state).toBeUndefined(); expect(fault.observed).toMatchObject({ count: 1, code: 'P2003' });
    expect(await db().auditLog.findUnique({ where: { id: refundFenceId(f.creditNoteId, original.clientRequestId) } })).toBeNull();
    await createRefund(f, original);
  });
  it('CASH22 current scope/parent/immutable history failures never become not_applied proofs, and all command kinds preserve exact source receipts', async () => {
    const f = await fixture(), r = await approvedRefund(f); await start(f, r); const failureEvidence = await upload(f, r, 'PaymentFailure');
    const failure = { clientRequestId: 'verified-decline', occurredAt: '2026-10-01', reference: 'synthetic-real-decline', reason: 'Synthetic bank-confirmed decline', evidenceIds: [failureEvidence.id] };
    expect((await post(f, 'credit-note-refunds/' + r.refund.id + '/failure', failure, f.finance)).status).toBe(200);
    const failureAck = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-result', checkBody('failure', failure), f.finance);
    expect(failureAck.body).toMatchObject({ state: 'applied', ack: { kind: 'Failed', statusAtExecution: 'Approved' } });
    const cancel = { clientRequestId: 'exact-cancel', reason: 'Withdraw prior to execution' };
    expect((await post(f, 'credit-note-refunds/' + r.refund.id + '/cancel', cancel)).status).toBe(200);
    const cancelAck = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-result', checkBody('cancel', cancel));
    expect(cancelAck.body).toMatchObject({ state: 'applied', ack: { kind: 'Cancelled', statusAtExecution: 'Cancelled' } });
    const resubmit = createBody(f, 'exact-resubmit');
    const successor = await post(f, 'credit-note-refunds/' + r.refund.id + '/resubmit', resubmit); expect(successor.status, diagnostic(successor.body)).toBe(201);
    const ack = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-result', checkBody('resubmit', resubmit));
    expect(ack.body).toMatchObject({ state: 'applied', parent: { refundId: r.refund.id }, ack: { kind: 'Requested', refundId: successor.body.refund.id } });
    const other = await fixture(), missing = retireBody('start', { clientRequestId: 'never-known' });
    // Finance's confirmed default is all-company financial/source visibility;
    // it is not a foreign-parent negative. Grant only this private Sales copy
    // the command scope, retaining its independently restricted actual L2.
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'vouchers:write' } });
    await db().rolePermission.create({ data: { id: other.id + '-restricted-refund-writer', roleId: other.sales.copy, permissionId: permission.id } });
    const scopedActor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), other.sales.id));
    expect(scopedActor.permissions).toContain('vouchers:write');
    const scopedWriter = { ...other.sales, actor: scopedActor, token: createAuthService().signToken(scopedActor) };
    expect((await createPermissionService({ prisma: db() }).getDataScopeResolver(scopedActor, 'aftersales')).rule.kind).not.toBe('all');
    expect((await createPermissionService({ prisma: db() }).getDataScopeResolver(other.finance.actor, 'aftersales')).rule.kind).toBe('all');
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', missing, scopedWriter), 404);
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', missing, f.sales), 403);
    const paidEvent = await models().creditNoteRefundEvent.findFirstOrThrow({ where: { refundId: r.refund.id, kind: 'Failed' } });
    await db().auditLog.update({ where: { id: paidEvent.auditId }, data: { detail: { deliberatelyCorruptedAfterTruePath: true } } });
    const corrupted = await post(f, 'credit-note-refunds/' + r.refund.id + '/request-retire', missing, f.finance);
    expect(corrupted.status, diagnostic(corrupted.body)).toBe(409); expect(corrupted.body.state).toBeUndefined();
    expect(await db().auditLog.findUnique({ where: { id: refundFenceId(f.creditNoteId, 'never-known') } })).toBeNull();
  });
  it('CASH23 real Customer payment-request template reads approved amount/holder/CN version accurately and rejects changed approval content', async () => {
    const f = await fixture(), body = createBody(f, 'template-real-customer', '12.9999');
    body.payeeSnapshot.accountHolder = 'Synthetic approved account holder';
    const r = await approvedRefund(f, body); await start(f, r);
    const data = await loadPaymentRequestDocData(db(), r.paymentRequest.id), note = await db().creditNote.findUniqueOrThrow({ where: { id: f.creditNoteId } });
    expect(data).toMatchObject({ pr: { status: 'Executing', totalAmount: '12.9999', sourceNumber: note.creditNoteNumber + ' / v1',
      customerRefund: { customerName: f.customer.name, accountHolder: body.payeeSnapshot.accountHolder, version: 1, creditNoteNumber: note.creditNoteNumber } } });
    const html = renderPaymentRequestBody(data!, { nameEn: 'Synthetic acceptance exporter' } as any);
    expect(html).toContain('12.9999 USD'); expect(html).toContain(body.payeeSnapshot.accountHolder); expect(html).toContain(f.customer.name); expect(html).toContain(note.creditNoteNumber);
    expect(html).not.toContain(body.payeeSnapshot.accountNumber); expect((await state(f)).vouchers).toEqual([]);
    await models().creditNoteRefund.update({ where: { id: r.refund.id }, data: { payeeSnapshot: { ...body.payeeSnapshot, accountHolder: 'Changed after approval' } } });
    await expect(loadPaymentRequestDocData(db(), r.paymentRequest.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('CASH24 a real writer racing retirement produces exactly one applied fact or one terminal fence, never both or a false negative receipt', async () => {
    const f = await fixture(), original = createBody(f, 'race-create-retire'), path = 'credit-notes/' + f.creditNoteId;
    const [writer, retirement] = await Promise.all([post(f, path + '/refunds', original), post(f, path + '/refund-request-retire', retireBody('create', original))]);
    expect(retirement.status, diagnostic(retirement.body)).toBe(200);
    const source = await state(f), fence = await db().auditLog.findUnique({ where: { id: refundFenceId(f.creditNoteId, original.clientRequestId) } });
    if (retirement.body.state === 'applied') {
      expect(writer.status, diagnostic(writer.body)).toBe(201); expect(source.refunds).toHaveLength(1); expect(fence).toBeNull();
      expect(retirement.body.ack).toMatchObject({ kind: 'Requested', refundId: writer.body.refund.id });
    } else {
      expect(retirement.body.state).toBe('not_applied'); expect(writer.status, diagnostic(writer.body)).toBe(409);
      expect(source.refunds).toEqual([]); expect(fence?.id).toBe(retirement.body.fenceAuditId);
    }
    const lookup = await post(f, path + '/refund-request-result', checkBody('create', original));
    expect(lookup.body.state).toBe(retirement.body.state); expect(source.vouchers).toEqual([]); expect(String(source.note.openAmount)).toBe('500');
  });
});

async function actuallyPaid(f: Fixture, label = 'return-paid') {
  const r = await approvedRefund(f, createBody(f, label)); await start(f, r, label + '-start');
  const proof = await upload(f, r), response = await paid(f, r, paidBody(proof, label + '-confirm'));
  expect(response.status, diagnostic(response.body)).toBe(200); return r;
}
async function returnProof(f: Fixture, r: any, application = f.app) {
  const response = await request(application).post('/api/v1/credit-note-refunds/' + r.refund.id + '/return-evidence')
    .set('Authorization', 'Bearer ' + f.finance.token).attach('file', proofBytes, { filename: 'synthetic-inbound-bank-proof.pdf', contentType: 'application/pdf' });
  expect(response.status, diagnostic(response.body)).toBe(201);
  expect(response.body).toMatchObject({ refundId: r.refund.id, purpose: 'PaymentReturnProof', uploadedBy: f.finance.id });
  expect(response.body.privateStorageKey).toBeUndefined(); return response.body;
}
const returnBody = (proof: any, id = 'return-1', amount = '25') => ({ clientRequestId: id, expectedVersion: 1,
  returnedPrincipal: amount, receivedNet: amount, bankFee: '0', feeBearer: null, actualDate: '2026-10-02', actualMethod: 'TT',
  bankReference: id + '-inbound-bank-ref', evidenceIds: [proof.id] });
const bankReturn = (f: Fixture, r: any, body: any, application = f.app, who = f.finance) => post(f, 'credit-note-refunds/' + r.refund.id + '/returns', body, who, application);

describe('V1G01 actual customer bank return, immutable Paid source and one CN balance recovery', () => {
  it('BANKR13 candidate Receipt read is exact customer/currency, preserves nullable original facts and rechecks current read grants', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), other = await fixture();
    const base = { type: 'Receipt' as const, amount: '25', bankFee: '0', currency: 'USD', paymentDate: '2026-10-02', paymentMethod: 'TT' };
    const create = async (input: any) => {
      const result = await createPaymentVoucher({ prisma: db(), actorId: f.finance.id, input });
      expect(result.ok, diagnostic(result)).toBe(true); if (!result.ok) throw Error(diagnostic(result)); return result.data.voucher;
    };
    const selected = await create({ ...base, customerRelationId: f.customer.id,
      attachments: { paymentReference: 'explicit-candidate-reference', receivedNet: '25', evidenceIds: [proof.id] } });
    const manual = await create({ ...base, customerRelationId: f.customer.id });
    const foreign = await create({ ...base, customerRelationId: other.customer.id });
    const wrongCurrency = await create({ ...base, customerRelationId: f.customer.id, currency: 'CNY' });
    const endpoint = '/api/v1/credit-note-refunds/' + r.refund.id + '/return-receipts';
    const response = await request(f.app).get(endpoint).set('Authorization', 'Bearer ' + f.finance.token);
    expect(response.status, diagnostic(response.body)).toBe(200);
    expect(response.body).toMatchObject({ refundId: r.refund.id, creditNoteId: f.creditNoteId, customerRelationId: f.customer.id,
      currency: 'USD', meaning: 'unallocated_receipts_require_bank_fact_match' });
    expect(response.body.items.map((row: any) => row.id)).toEqual(expect.arrayContaining([selected.id, manual.id]));
    expect(response.body.items.map((row: any) => row.id)).not.toContain(foreign.id);
    expect(response.body.items.map((row: any) => row.id)).not.toContain(wrongCurrency.id);
    expect(response.body.items.find((row: any) => row.id === selected.id)).toMatchObject({ amount: '25', appliedAmount: null, invoiceId: null,
      paymentReference: 'explicit-candidate-reference', receivedNet: '25', evidenceIds: [proof.id] });
    expect(response.body.items.find((row: any) => row.id === manual.id)).toMatchObject({ paymentReference: null, receivedNet: null, evidenceIds: [], appliedAmount: null });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'vouchers:read' } });
    await db().rolePermission.deleteMany({ where: { roleId: f.finance.copy, permissionId: permission.id } });
    const revoked = await request(f.app).get(endpoint).set('Authorization', 'Bearer ' + f.finance.token);
    expect(revoked.status, diagnostic(revoked.body)).toBe(403); expect(revoked.body.items).toBeUndefined();
  });
  it('BANKR01 explicit principal/net/actual fee restore exact partial amounts repeatedly without changing original Paid documents or reservations', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), before = await state(f);
    const reserved = await createRefund(f, createBody(f, 'reserved-after-paid', '300'));
    const body = { ...returnBody(proof, 'partial-return', '12.9999'), receivedNet: '10.9999', bankFee: '2', feeBearer: 'SHA' };
    const response = await bankReturn(f, r, body); expect(response.status, diagnostic(response.body)).toBe(201);
    expect(response.body).toMatchObject({ refund: { id: r.refund.id, status: 'Paid', amount: '125' },
      cashReturn: { returnedPrincipal: '12.9999', receivedNet: '10.9999', bankFee: '2', feeBearer: 'SHA' },
      receiptVoucher: { type: 'Receipt', status: 'reconciled', amount: '12.9999', bankFee: '2', invoiceId: null, appliedAmount: null },
      creditNote: { openAmount: '387.9999', status: 'PartiallyApplied' }, returnedPrincipalTotal: '12.9999', remainingReturnable: '112.0001', availableToSettle: '87.9999' });
    const proof2 = await returnProof(f, r), more = await bankReturn(f, r, returnBody(proof2, 'partial-return-2', '112.0001'));
    expect(more.status, diagnostic(more.body)).toBe(201); expect(more.body).toMatchObject({ returnedPrincipalTotal: '125', remainingReturnable: '0', availableToSettle: '200', creditNote: { openAmount: '500', status: 'Open' } });
    const after = await state(f);
    expect(after.refunds.find((row: any) => row.id === r.refund.id)).toEqual(before.refunds[0]);
    expect(after.paymentRequests.find((row: any) => row.id === r.paymentRequest.id)).toEqual(before.paymentRequests[0]);
    expect(after.refundEvents.filter((row: any) => row.refundId === r.refund.id)).toEqual(before.refundEvents);
    expect(after.vouchers.find(row => row.id === before.vouchers[0].id)).toEqual(before.vouchers[0]);
    expect(after.settlements.filter((row: any) => row.kind === 'CashRefund')).toEqual(before.settlements);
    expect(after.refunds.find((row: any) => row.id === reserved.refund.id).status).toBe('PendingApproval');
    expect(after.allocations).toEqual([]); expect(after.voucherAllocations).toEqual([]);
    expect((await get(f, 'credit-note-refunds/' + r.refund.id + '/returns', f.finance)).body).toMatchObject({ remainingReturnable: '0', reservedAmount: '300', availableToSettle: '200' });
  });
  it('BANKR02 lost response replays exact return receipt after a healthy CN append; changed body, actor, old version and over-return never write', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof);
    const first = await bankReturn(f, r, body); expect(first.status, diagnostic(first.body)).toBe(201);
    await appendMoney(f, 'legal-append-after-return', '50'); const before = await state(f);
    const replay = await bankReturn(f, r, body); expect(replay.status, diagnostic(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, cashReturn: { id: first.body.cashReturn.id }, receiptVoucher: { id: first.body.receiptVoucher.id }, settlementEventId: first.body.settlementEventId });
    expect(await state(f)).toEqual(before);
    const checked = await post(f, 'credit-note-refunds/' + r.refund.id + '/return-request-result', checkBody('return', body), f.finance);
    expect(checked.status, diagnostic(checked.body)).toBe(200); expect(checked.body).toMatchObject({ state: 'applied', action: 'return', originalPayload: body,
      originalParameterHash: creditNoteDigest(body), parent: { creditNoteId: f.creditNoteId, refundId: r.refund.id },
      ack: { kind: 'Returned', returnId: first.body.cashReturn.id, paymentVoucherId: first.body.receiptVoucher.id, statusAtExecution: 'Paid' }, meaning: 'system_record_only' });
    await denied(f, () => bankReturn(f, r, { ...body, receivedNet: '26' }));
    await denied(f, () => bankReturn(f, r, body, f.app, f.leader), 403);
    const otherFinance = await person(f.id + '-other-finance', 'role-finance', f.departmentId);
    await denied(f, () => bankReturn(f, r, body, f.app, otherFinance));
    await denied(f, () => bankReturn(f, r, returnBody(proof, 'stale-new')));
    await denied(f, () => bankReturn(f, r, { ...returnBody(proof, 'over-new', '100.0001'), expectedVersion: 2 }));
    const conflict = await post(f, 'credit-note-refunds/' + r.refund.id + '/return-request-retire', retireBody('return', { ...body, bankReference: 'different-ref' }), f.finance);
    expect(conflict.status).toBe(200); expect(conflict.body.state).toBe('conflict'); expect(conflict.body.fenceAuditId).toBeUndefined();
  });
  it('BANKR03 invalid explicit arithmetic, unclear charged-fee bearer, currency/source injection, zero and mixed receipt preserve actual money for manual reconciliation', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof);
    for (const change of [{ returnedPrincipal: '0', receivedNet: '0' }, { receivedNet: '24' }, { bankFee: '1' },
      { bankFee: '1', receivedNet: '24', feeBearer: null }, { bankFee: '1', receivedNet: '24', feeBearer: 'guess' },
      { currency: 'EUR' }, { customerRelationId: 'other' }, { actualDate: '2026-02-30' }, { receivedNet: '25.00001' }]) {
      await denied(f, () => bankReturn(f, r, { ...body, ...change }), 400);
    }
    const ordinary = await post(f, 'finance/vouchers', { type: 'Receipt', amount: '50', bankFee: '0', currency: 'EUR', paymentDate: '2026-10-02', paymentMethod: 'TT', customerRelationId: f.customer.id }, f.finance);
    expect(ordinary.status, diagnostic(ordinary.body)).toBe(201);
    await denied(f, () => bankReturn(f, r, { ...body, receiptVoucherId: ordinary.body.id }));
    expect(await db().paymentVoucher.findUniqueOrThrow({ where: { id: ordinary.body.id } })).toMatchObject({ currency: 'EUR', status: 'unreconciled', invoiceId: null });
  });
  it('BANKR04 explicitly reused Receipt must match every real fact and consume once; original payment proof and any prior allocation fail', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof, 'reuse-receipt');
    const created = await createPaymentVoucher({ prisma: db(), actorId: f.finance.id, input: { type: 'Receipt', amount: body.returnedPrincipal, bankFee: body.bankFee,
      feeBearer: body.feeBearer, currency: 'USD', paymentDate: body.actualDate, paymentMethod: body.actualMethod, customerRelationId: f.customer.id,
      attachments: { paymentReference: body.bankReference, receivedNet: body.receivedNet, evidenceIds: body.evidenceIds } } });
    expect(created.ok).toBe(true); if (!created.ok) throw Error(diagnostic(created)); const receiptId = created.data.voucher.id;
    const originalProof = await models().creditNoteRefundEvidence.findFirstOrThrow({ where: { refundId: r.refund.id, purpose: 'PaymentProof' } });
    await denied(f, () => bankReturn(f, r, { ...body, evidenceIds: [originalProof.id] }));
    await denied(f, () => bankReturn(f, r, { ...body, receiptVoucherId: receiptId, bankReference: 'different-bank-reference' }));
    const count = await db().paymentVoucher.count({ where: { customerRelationId: f.customer.id } });
    const accepted = await bankReturn(f, r, { ...body, receiptVoucherId: receiptId }); expect(accepted.status, diagnostic(accepted.body)).toBe(201);
    expect(accepted.body.receiptVoucher.id).toBe(receiptId); expect(await db().paymentVoucher.count({ where: { customerRelationId: f.customer.id } })).toBe(count);
    await denied(f, () => bankReturn(f, r, { ...body, clientRequestId: 'repeat-actual-receipt', receiptVoucherId: receiptId }));
    const proof2 = await returnProof(f, r), allocated = await post(f, 'finance/vouchers', { type: 'Receipt', amount: '25', bankFee: '0', currency: 'USD', paymentDate: body.actualDate, paymentMethod: 'TT', customerRelationId: f.customer.id }, f.finance);
    expect(allocated.status, diagnostic(allocated.body)).toBe(201);
    const allocation = await post(f, 'finance/allocations', { invoiceId: f.invoiceId, voucherId: allocated.body.id, appliedAmount: '5', appliedDate: body.actualDate }, f.finance);
    expect(allocation.status, diagnostic(allocation.body)).toBe(201);
    await denied(f, () => bankReturn(f, r, { ...returnBody(proof2, 'already-allocated'), receiptVoucherId: allocated.body.id }));
  });
  it('BANKR05 concurrent same stable request returns one immutable record; different request IDs cannot consume the same bank flow twice', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof, 'parallel-same-id');
    const pair = await Promise.all([bankReturn(f, r, body), bankReturn(f, r, body)]);
    expect(pair.map(row => row.status).sort()).toEqual([200, 201]); expect(new Set(pair.map(row => row.body.cashReturn.id)).size).toBe(1);
    const proof2 = await returnProof(f, r), a = returnBody(proof2, 'parallel-bank-a'), b = { ...a, clientRequestId: 'parallel-bank-b' };
    const race = await Promise.all([bankReturn(f, r, a), bankReturn(f, r, b)]); expect(race.map(row => row.status).sort()).toEqual([201, 409]);
    const after = await state(f); expect(after.returns).toHaveLength(2); expect(after.settlements.filter((row: any) => row.kind === 'CashRefundReturn')).toHaveLength(2);
    expect(String(after.note.openAmount)).toBe('425'); expect(after.vouchers.filter(row => row.type === 'Receipt')).toHaveLength(2);
  });
  it('BANKR06 one actual bank tuple cannot be restored through two different real CN/refunds, including concurrent creation', async () => {
    const f = await fixture(), r = await actuallyPaid(f), created = await post(f, 'claims', { customerRelationId: f.customer.id, sourceInvoiceId: f.invoiceId, problemDesc: 'Second actual claim, same real customer' });
    expect(created.status, diagnostic(created.body)).toBe(201);
    const second: Fixture = { ...f, caseId: created.body.claimCase.id, creditNoteId: '' }; await appendMoney(second, 'second-case', '500');
    const r2 = await actuallyPaid(second, 'second-cash-source'), proof = await returnProof(f, r), proof2 = await returnProof(second, r2);
    const a = returnBody(proof, 'cross-cn-a'), b = { ...returnBody(proof2, 'cross-cn-b'), bankReference: a.bankReference };
    const race = await Promise.all([bankReturn(f, r, a), bankReturn(second, r2, b)]); expect(race.map(row => row.status).sort(), diagnostic(race.map(row => row.body))).toEqual([201, 409]);
    const rows = await models().creditNoteRefundReturn.findMany({ where: { customerRelationId: f.customer.id, bankReference: a.bankReference } }); expect(rows).toHaveLength(1);
    expect(await db().paymentVoucher.count({ where: { customerRelationId: f.customer.id, type: 'Receipt' } })).toBe(1);
    const states = await Promise.all([state(f), state(second)]); expect(states.map(row => String(row.note.openAmount)).sort()).toEqual(['375', '400']);
    expect(states.flatMap(row => row.returns)).toHaveLength(1); expect(states.flatMap(row => row.settlements).filter((row: any) => row.kind === 'CashRefundReturn')).toHaveLength(1);
    expect(race.find(row => row.status === 409)?.body.message).toMatch(/人工核对|消费|流水/);
  });
  it.each(['return-fact-audit', 'settlement-audit'])('BANKR07 actual mandatory %s FK failure rolls back Receipt, return, joins, settlement and CN balance together', async stage => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), fault = sqlFault(f, args => stage === 'return-fact-audit'
      ? args.data.action === 'CREDIT_NOTE_REFUND_RETURN_RECORDED' : args.data.action === 'CREDIT_NOTE_SETTLED');
    await denied(f, () => bankReturn(f, r, returnBody(proof), app(fault.database)), 500);
    expect(fault.observed.count).toBe(1); expect(fault.observed.code).toBe('P2003'); expect(fault.observed.staged.vouchers).toBe(2);
    expect(fault.observed.staged.cashReturns).toBe(stage === 'return-fact-audit' ? 0 : 1);
    expect(fault.observed.staged.returnEvents).toBe(stage === 'return-fact-audit' ? 0 : 1);
  });
  it('BANKR08 changed return bytes or missing original payout bytes refuse recovery, and evidence-audit FK failure removes the staged private file', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), row = await models().creditNoteRefundEvidence.findUniqueOrThrow({ where: { id: proof.id } });
    const file = path.join(privateBase, 'private', row.privateStorageKey); await fs.writeFile(file, Buffer.concat([proofBytes, Buffer.from('corrupted')]));
    await denied(f, () => bankReturn(f, r, returnBody(proof)));
    await fs.writeFile(file, proofBytes);
    const original = await models().creditNoteRefundEvidence.findFirstOrThrow({ where: { refundId: r.refund.id, purpose: 'PaymentProof' } }), originalPath = path.join(privateBase, 'private', original.privateStorageKey);
    await fs.unlink(originalPath); await denied(f, () => bankReturn(f, r, returnBody(proof)), 500); await fs.writeFile(originalPath, proofBytes);
    const directory = path.join(privateBase, 'private', 'cash-refunds'), beforeFiles = (await fs.readdir(directory)).sort();
    const fault = sqlFault(f, args => args.data.action === 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED');
    await denied(f, () => request(app(fault.database)).post('/api/v1/credit-note-refunds/' + r.refund.id + '/return-evidence')
      .set('Authorization', 'Bearer ' + f.finance.token).attach('file', proofBytes, { filename: 'failed-upload.pdf' }), 500);
    expect(fault.observed.code).toBe('P2003'); expect((await fs.readdir(directory)).sort()).toEqual(beforeFiles);
  });
  it('BANKR09 current write scope, actual restricted L2 and damaged authority/source audit refuse return reads/writes without new financial facts', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof), other = await fixture();
    await denied(f, () => bankReturn(f, r, body, f.app, f.sales), 403);
    await denied(f, () => get(f, 'credit-note-refunds/' + r.refund.id + '/returns', other.sales), 404);
    const voucherWrite = await db().permission.findUniqueOrThrow({ where: { scope: 'vouchers:write' } });
    const roleId = other.sales.id + '-default-copy'; await db().rolePermission.create({ data: { id: roleId + '-bank-voucher-grant', roleId, permissionId: voucherWrite.id } });
    const actor = await buildLoadedAuthTokenPayload(db(), (await loadUserWithRoles(db(), other.sales.id))!);
    const scoped = { ...other.sales, actor, token: createAuthService().signToken(actor) };
    await denied(f, () => bankReturn(f, r, body, f.app, scoped), 404);
    await db().rolePermission.deleteMany({ where: { roleId: f.finance.id + '-default-copy', permissionId: voucherWrite.id } });
    await denied(f, () => bankReturn(f, r, body), 403);
    await db().rolePermission.create({ data: { id: f.id + '-regrant-vouchers', roleId: f.finance.id + '-default-copy', permissionId: voucherWrite.id } });
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: (await models().creditNoteRefund.findUniqueOrThrow({ where: { id: r.refund.id } })).decisionAuditId } });
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: { ...audit.detail as any, decisionActorAuthority: { authorizationLoaded: true, userId: other.leader.id, roleIds: ['role-admin'] } } } });
    await denied(f, () => bankReturn(f, r, body));
  });
  it('BANKR10 exact unknown result, permanent return fence and a paused late writer cannot race into false not_applied or a duplicate bank recovery', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof, 'late-return-key');
    const unknown = await post(f, 'credit-note-refunds/' + r.refund.id + '/return-request-result', checkBody('return', body), f.finance);
    expect(unknown.status).toBe(200); expect(unknown.body.state).toBe('unknown'); expect(unknown.body.fenceAuditId).toBeUndefined();
    const paused = delayedParentLock(f), late = bankReturn(f, r, body, app(paused.database)).then(row => row);
    await paused.entered;
    try {
      const fenced = await post(f, 'credit-note-refunds/' + r.refund.id + '/return-request-retire', retireBody('return', body), f.finance);
      expect(fenced.status, diagnostic(fenced.body)).toBe(200); expect(fenced.body).toMatchObject({ state: 'not_applied', originalPayload: body, originalParameterHash: creditNoteDigest(body), meaning: 'system_record_only' });
      const check = await post(f, 'credit-note-refunds/' + r.refund.id + '/return-request-result', checkBody('return', body), f.finance);
      expect(check.body).toMatchObject({ state: 'not_applied', fenceAuditId: fenced.body.fenceAuditId });
    } finally { paused.release(); }
    const rejected = await late; expect(rejected.status, diagnostic(rejected.body)).toBe(409);
    expect(await models().creditNoteRefundReturn.count({ where: { creditNoteId: f.creditNoteId } })).toBe(0);
    const corrected = await bankReturn(f, r, { ...body, clientRequestId: 'explicit-corrected-after-fence' }); expect(corrected.status, diagnostic(corrected.body)).toBe(201);
    await denied(f, () => post(f, 'credit-note-refunds/' + r.refund.id + '/start', { clientRequestId: 'explicit-corrected-after-fence' }, f.finance));
  });
  it('BANKR12 ordinary allocation racing explicit Receipt reuse has exactly one financial consumer and never both invoice and CN recovery', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), body = returnBody(proof, 'race-reuse-receipt');
    const created = await createPaymentVoucher({ prisma: db(), actorId: f.finance.id, input: { type: 'Receipt', amount: body.returnedPrincipal,
      bankFee: '0', currency: 'USD', paymentDate: body.actualDate, paymentMethod: body.actualMethod, customerRelationId: f.customer.id,
      attachments: { paymentReference: body.bankReference, receivedNet: body.receivedNet, evidenceIds: body.evidenceIds } } });
    expect(created.ok).toBe(true); if (!created.ok) throw Error(diagnostic(created)); const voucherId = created.data.voucher.id;
    const [returned, allocated] = await Promise.allSettled([
      bankReturn(f, r, { ...body, receiptVoucherId: voucherId }),
      db().$transaction(tx => applyAllocation(db(), tx, { invoiceId: f.invoiceId, voucherId, appliedAmount: '25', actorId: f.finance.id, source: 'acceptance-racing-Agent' })),
    ]);
    expect(returned.status).toBe('fulfilled'); if (returned.status !== 'fulfilled') throw returned.reason;
    const rows = await models().creditNoteRefundReturn.findMany({ where: { creditNoteId: f.creditNoteId } });
    const allocations = await db().invoiceAllocation.findMany({ where: { voucherId } });
    expect(rows.length + allocations.length).toBe(1);
    if (returned.value.status === 201) {
      expect(rows).toHaveLength(1); expect(allocations).toHaveLength(0); expect(allocated.status).toBe('rejected');
      expect(String((await state(f)).note.openAmount)).toBe('400');
    } else {
      expect(returned.value.status, diagnostic(returned.value.body)).toBe(409); expect(rows).toHaveLength(0); expect(allocations).toHaveLength(1);
      expect(allocated.status).toBe('fulfilled'); expect(String((await state(f)).note.openAmount)).toBe('375');
    }
    expect(await db().paymentVoucher.count({ where: { customerRelationId: f.customer.id, type: 'Receipt' } })).toBe(1);
    expect(await models().creditNoteSettlementEvent.count({ where: { creditNoteId: f.creditNoteId, kind: 'CashRefundReturn' } })).toBe(rows.length);
  });
  it('BANKR11 real returned Receipt cannot be rewritten, voided, deleted, or consumed by HTTP or direct Agent allocation, even if its status projection is corrupted', async () => {
    const f = await fixture(), r = await actuallyPaid(f), proof = await returnProof(f, r), result = await bankReturn(f, r, returnBody(proof));
    expect(result.status, diagnostic(result.body)).toBe(201); const voucherId = result.body.receiptVoucher.id;
    await denied(f, () => request(f.app).patch('/api/v1/finance/vouchers/' + voucherId).set('Authorization', 'Bearer ' + f.finance.token).send({ amount: '26' }));
    await denied(f, () => post(f, 'finance/vouchers/' + voucherId + '/cancel', {}, f.finance));
    await denied(f, () => request(f.app).delete('/api/v1/finance/vouchers/' + voucherId).set('Authorization', 'Bearer ' + f.finance.token));
    await models().paymentVoucher.update({ where: { id: voucherId }, data: { status: 'unreconciled' } });
    const before = await state(f);
    await expect(db().$transaction(tx => applyAllocation(db(), tx, { invoiceId: f.invoiceId, voucherId, appliedAmount: '1', actorId: f.finance.id, source: 'acceptance-direct-Agent' }))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await state(f)).toEqual(before);
    await denied(f, () => post(f, 'finance/allocations', { invoiceId: f.invoiceId, voucherId, appliedAmount: '1' }, f.finance));
    const receipts = await listClaimableReceipts(db(), { visibleOrderIds: null }); expect(receipts.ok).toBe(true);
    if (!receipts.ok) throw Error(diagnostic(receipts)); expect(receipts.data!.some(row => row.voucherId === voucherId)).toBe(false);
    const claim = await claimReceipt(db(), { voucherId, invoiceId: f.invoiceId, amount: 1, actorId: f.finance.id, requestId: 'return-is-not-sales-receipt', visibleOrderIds: null });
    expect(claim).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    const proposalInput = { voucherId, invoiceId: f.invoiceId, amount: '1', currency: 'USD', requestId: 'return-not-proposal' };
    await expect(createReceiptMatchProposalService(db()).submit(f.sales.actor, proposalInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const suggestPermission = await db().permission.upsert({ where: { scope: 'invoices:suggest_match' }, update: {},
      create: { id: prefix + '-permission-invoices:suggest_match', scope: 'invoices:suggest_match' } });
    await db().rolePermission.create({ data: { id: f.id + '-grant-receipt-suggest', roleId: f.sales.copy, permissionId: suggestPermission.id } });
    const authorizedSales = await buildLoadedAuthTokenPayload(db(), (await loadUserWithRoles(db(), f.sales.id))!);
    expect(authorizedSales.permissions).toContain('invoices:suggest_match');
    // This source invoice has no Order: scoped Sales cannot discover it through
    // the matching service's order contract. Test the FK guard with an actual
    // authorized Finance actor that can see the source, rather than bypassing L2.
    await expect(createReceiptMatchProposalService(db()).submit(authorizedSales, proposalInput)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db().rolePermission.create({ data: { id: f.id + '-finance-grant-receipt-suggest', roleId: f.finance.copy, permissionId: suggestPermission.id } });
    const authorizedFinance = await buildLoadedAuthTokenPayload(db(), (await loadUserWithRoles(db(), f.finance.id))!);
    await expect(createReceiptMatchProposalService(db()).submit(authorizedFinance, proposalInput)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await state(f)).toEqual(before);
  });
});
