/**
 * APPROVAL-B: actual claim creation/decision/consumption HTTP and PostgreSQL.
 * Independent rules: 9/17 B1/A7 (kernel, any amount -> general leader),
 * 9/30 operation/approval facts bound to version and scope. No new model fields.
 * The positive path creates a server snapshot via the actual add route and an
 * approved decision/audit via the assigned synthetic role-admin. This is not
 * current company-account, UI, automatic hook or complete claims UAT evidence.
 * Negative records are isolated fixture corruption/changes, never shared data.
 * Allowance emits an Open credit note; no cash refund/provider is performed.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createClaimRouter } from '../src/claims/claimRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';

let prisma: PrismaClient | undefined;
const prefix = 'acceptance-claim-fact-' + randomUUID();
const db = () => { if (!prisma) throw Error('Independent acceptance PG not initialized'); return prisma; };
const roleIds = { leader: 'role-admin', applicant: 'role-sales' };

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory,
    BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !name || !directory || !port) throw Error('Independent acceptance DB is required');
  const url = new URL(DATABASE_URL);
  expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(url.pathname).toBe('/' + name);
  expect(url.port).toBe(port);
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>(
    "SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
  expect(identity).toEqual([{ name, directory, port: Number(port) }]);
  // Actual non-empty role grants, not business/demo seed or company policy.
  for (const [kind, roleId] of Object.entries(roleIds)) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: 'Synthetic ' + kind, isSystem: true } });
    for (const scope of ['aftersales:read', 'aftersales:write', 'inventory:write', 'inventory:read', 'production:write', 'qc:write']) {
      const p = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-perm-' + scope, scope } });
      if (!await db().rolePermission.findFirst({ where: { roleId, permissionId: p.id } })) {
        await db().rolePermission.create({ data: { id: prefix + '-' + kind + '-' + scope, roleId, permissionId: p.id } });
      }
    }
  }
});
afterAll(async () => { await prisma?.$disconnect(); });

function claimApp(database: PrismaClient = db()) {
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1', createClaimRouter({ prisma: database, requireAuth: true }));
  app.use('/api/v1/approvals', createApprovalRouter({ prisma: db(), requireAuth: true }));
  return app;
}
const allowanceInput = { kind: 'Allowance', amount: '100.0000', currency: 'USD' };
async function fixture(key: string, input: Record<string, unknown> = allowanceInput) {
  const id = prefix + '-' + key, leaderId = id + '-leader', applicantId = id + '-applicant', departmentId = id + '-department';
  await db().userAccount.create({ data: { id: leaderId, displayName: 'Synthetic general leader', status: 'active' } });
  await db().department.create({ data: { id: departmentId, name: 'Synthetic claims department', headId: leaderId } });
  // BASE-39-A1: a department head also belongs to that department. Do not let
  // the legal routing control depend on current routing omitting this check.
  await db().userAccount.update({ where: { id: leaderId }, data: { primaryDeptId: departmentId } });
  await db().userAccount.create({ data: { id: applicantId, displayName: 'Synthetic applicant', status: 'active', primaryDeptId: departmentId } });
  for (const [userId, roleId] of [[leaderId, roleIds.leader], [applicantId, roleIds.applicant]]) {
    await db().userRole.create({ data: { id: userId + '-role', userId, roleId, departmentId } });
  }
  const makeToken = async (userId: string) => {
    const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
    expect(context!.scopes).toEqual(expect.arrayContaining(['aftersales:read', 'aftersales:write']));
    return createAuthService().signToken({ userId, roles: context!.legacyRoleCodes,
      roleIds: context!.roleIds, permissions: context!.scopes, departmentIds: context!.departmentIds, authorizationLoaded: true });
  };
  const leaderToken = await makeToken(leaderId), applicantToken = await makeToken(applicantId);
  const now = BigInt(Date.now());
  await db().claimCase.create({ data: { id, caseNumber: id, customerName: 'Synthetic customer',
    problemDesc: 'Acceptance quality claim', reportedAt: '2026-10-01', reportedBy: applicantId,
    createdAt: now, updatedAt: now } });
  const app = claimApp();
  const created = await request(app).post('/api/v1/claims/' + id + '/dispositions')
    .set('Authorization', 'Bearer ' + applicantToken).send(input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dispositionId = created.body.disposition.id as string, approvalId = created.body.approvalRequestId as string;
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  expect(approval).toMatchObject({ requesterId: applicantId, reviewerId: leaderId, status: 'pending',
    actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', targetId: dispositionId });
  if (input.kind === 'Allowance') expect(approval.payload).toMatchObject({ claimCaseId: id, kind: 'Allowance', amount: '100', currency: 'USD' });
  else expect(approval.payload).toMatchObject({ claimCaseId: id, kind: input.kind, materialCode: input.materialCode, quantity: String(input.quantity), unit: input.unit, returnDisposition: input.returnDisposition });
  return { id, key, leaderId, applicantId, leaderToken, applicantToken, dispositionId, approvalId, app };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function decide(f: Fixture, status: 'approved' | 'rejected' = 'approved') {
  const response = await request(f.app).post('/api/v1/approvals/' + f.approvalId + '/decide')
    .set('Authorization', 'Bearer ' + f.leaderToken).send({ status, decisionNote: 'Synthetic assigned-leader decision' });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const a = await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } });
  expect(a).toMatchObject({ status, reviewerId: f.leaderId });
  expect(a.decidedAt).toBeInstanceOf(Date);
  const audits = await db().auditLog.findMany({ where: { targetId: f.approvalId,
    action: status === 'approved' ? 'approve_business_request' : 'reject_business_request' } });
  expect(audits).toHaveLength(1);
  expect(audits[0].actorId).toBe(f.leaderId);
}

async function businessState(f: Fixture) {
  return {
    disposition: await db().claimDisposition.findUniqueOrThrow({ where: { id: f.dispositionId } }),
    claim: await db().claimCase.findUniqueOrThrow({ where: { id: f.id } }),
    creditNotes: await db().creditNote.findMany({ where: { claimCaseId: f.id }, orderBy: { id: 'asc' } }),
  };
}

async function advance(f: Fixture, token = f.leaderToken) {
  return request(f.app).post('/api/v1/claims/dispositions/' + f.dispositionId + '/approve')
    .set('Authorization', 'Bearer ' + token).send({});
}

async function expectDeniedAdvance(f: Fixture) {
  const before = await businessState(f), response = await advance(f), after = await businessState(f);
  console.log(JSON.stringify({ probe: 'claim-invalid-approval-fact', variant: f.key, http: response.status,
    before: before.disposition.status, after: after.disposition.status, approverId: after.disposition.approverId,
    credits: after.creditNotes.length, totalCredit: after.claim.totalCreditAmount.toString() }));
  expect.soft([403, 409], 'kernel fact missing/mismatched must refuse consumption').toContain(response.status);
  // Refusal audit is allowed; never require the full AuditLog table to be unchanged.
  expect(after).toEqual(before);
}

describe('APPROVAL-B: claims consume only a matching current approved fact', () => {
  it('positive: actual server snapshot + assigned leader decision permits advancement and Open CN output', async () => {
    const f = await fixture('matched');
    await decide(f);
    const approved = await advance(f);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await businessState(f)).disposition).toMatchObject({ status: 'Approved', approverId: f.leaderId });
    const executed = await request(f.app).post('/api/v1/claims/dispositions/' + f.dispositionId + '/execute')
      .set('Authorization', 'Bearer ' + f.applicantToken).send({});
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    const after = await businessState(f);
    expect(after.disposition.status).toBe('Executed');
    expect(after.creditNotes).toHaveLength(1);
    expect(after.disposition.creditNoteId).toBe(after.creditNotes[0].id);
    expect(after.creditNotes[0]).toMatchObject({ status: 'Open', currency: 'USD', claimCaseId: f.id, refundedAt: null });
    expect(after.creditNotes[0].amount.toString()).toBe('100');
    expect(after.creditNotes[0].openAmount.toString()).toBe('100');
    expect(after.claim.totalCreditAmount.toString()).toBe('100');
    expect(after.claim.status).toBe('Handled');
  });

  it('no approval record: leader role cannot substitute for an approved kernel fact', async () => {
    const f = await fixture('missing');
    await db().approvalRequest.delete({ where: { id: f.approvalId } });
    await expectDeniedAdvance(f);
  });
  it('pending approval does not authorize the disposition', async () => {
    await expectDeniedAdvance(await fixture('pending'));
  });
  it('a real rejected leader decision does not authorize the disposition', async () => {
    const f = await fixture('rejected'); await decide(f, 'rejected'); await expectDeniedAdvance(f);
  });
  it.each(['actionType', 'targetType', 'targetId'] as const)('approved %s mismatch cannot approve this disposition', async field => {
    const f = await fixture('wrong-' + field);
    // First obtain a genuine committed decision. Then corrupt one persisted
    // binding, exercising consumption independently of the kernel's new early
    // validation. Preserve the original approved-fact denial and no-write probes.
    await decide(f);
    const value = field === 'actionType' ? 'quotation:price-deviation' : field === 'targetType' ? 'Order' : f.id + '-other-disposition';
    if (field === 'targetId') {
      const d = await db().claimDisposition.findUniqueOrThrow({ where: { id: f.dispositionId } });
      await db().claimDisposition.create({ data: { ...d, id: value } });
    }
    await db().approvalRequest.update({ where: { id: f.approvalId }, data: { [field]: value } });
    await expectDeniedAdvance(f);
  });
  it.each(['actionType', 'targetType', 'targetId'] as const)('V1 kernel refuses a mismatched pending %s before any decision or successful audit', async field => {
    const f = await fixture('pending-wrong-' + field);
    const value = field === 'actionType' ? 'quotation:price-deviation' : field === 'targetType' ? 'Order' : f.id + '-another-disposition';
    if (field === 'targetId') {
      const d = await db().claimDisposition.findUniqueOrThrow({ where: { id: f.dispositionId } });
      await db().claimDisposition.create({ data: { ...d, id: value } });
    }
    await db().approvalRequest.update({ where: { id: f.approvalId }, data: { [field]: value } });
    const before = await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } });
    const beforeBusiness = await businessState(f);
    const response = await request(f.app).post('/api/v1/approvals/' + f.approvalId + '/decide')
      .set('Authorization', 'Bearer ' + f.leaderToken).send({ status: 'approved', decisionNote: 'Attempted approval of a corrupted pending binding' });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).toEqual(before);
    expect(await businessState(f)).toEqual(beforeBusiness);
    expect(await db().auditLog.count({ where: { targetId: f.approvalId, action: 'approve_business_request' } })).toBe(0);
  });
  it('amount changed after the real leader decision requires a new valid approval', async () => {
    const f = await fixture('changed-amount'); await decide(f);
    await db().claimDisposition.update({ where: { id: f.dispositionId }, data: { amount: '125', updatedAt: BigInt(Date.now()) } });
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).payload).toMatchObject({ amount: '100' });
    await expectDeniedAdvance(f);
  });
  it('a different advancement actor must not replace the true approved decision maker', async () => {
    const f = await fixture('decision-actor'); await decide(f);
    const before = await businessState(f), response = await advance(f, f.applicantToken), after = await businessState(f);
    console.log(JSON.stringify({ probe: 'claim-decision-actor', http: response.status,
      actualApprover: after.disposition.approverId, decisionMaker: f.leaderId, invokedBy: f.applicantId }));
    // Both a restricted consumer (refusal) and an authorized separate advancement
    // actor are valid. If accepted, the actual decision maker remains the leader.
    if ([403, 409].includes(response.status)) { expect(after).toEqual(before); return; }
    expect(response.status).toBe(200);
    expect(after.disposition.approverId).toBe(f.leaderId);
  });
  it('an old Approved flag with no approved fact cannot produce an actual credit note', async () => {
    const f = await fixture('legacy-approved-flag');
    await db().approvalRequest.delete({ where: { id: f.approvalId } });
    await db().claimDisposition.update({ where: { id: f.dispositionId }, data: { status: 'Approved', approverId: f.leaderId, approvedAt: '2026-10-01' } });
    const before = await businessState(f);
    const response = await request(f.app).post('/api/v1/claims/dispositions/' + f.dispositionId + '/execute')
      .set('Authorization', 'Bearer ' + f.applicantToken).send({});
    const after = await businessState(f);
    console.log(JSON.stringify({ probe: 'claim-legacy-approved-without-fact', http: response.status,
      status: after.disposition.status, credits: after.creditNotes.length, totalCredit: after.claim.totalCreditAmount.toString() }));
    expect.soft([403, 409]).toContain(response.status);
    expect(after).toEqual(before);
  });
});

// Exact goods, preserved approval history and inventory ledgers on the same independent PG.
const goodsInput = (kind: string, destination = kind === 'Repair' ? 'Repair' : 'Scrap') => ({ kind,
  materialCode: 'ACCEPTANCE-SKU-REAL', quantity: '2.5', unit: 'M', returnDisposition: destination,
  ...(kind === 'ReturnRefund' ? { amount: '20.1234', currency: 'USD' } : {}) });
async function resources(f: Fixture) {
  const now = BigInt(Date.now());
  const warehouse = await db().warehouse.create({ data: { id: f.id + '-warehouse', code: f.id + '-WH', name: 'Synthetic return warehouse', type: 'Main', createdAt: now, updatedAt: now } });
  const station = await db().workStation.create({ data: { id: f.id + '-station', code: f.id + '-ST', name: 'Synthetic repair station', type: 'Other', createdAt: now, updatedAt: now } });
  return { warehouse, station };
}
async function execute(f: Fixture, parameters: Record<string, unknown>, database: PrismaClient = db(), token = f.applicantToken) {
  return request(claimApp(database)).post('/api/v1/claims/dispositions/' + f.dispositionId + '/execute').set('Authorization', 'Bearer ' + token).send(parameters);
}
async function goodsState(f: Fixture) {
  const b = await businessState(f);
  const dispositions = await db().claimDisposition.findMany({ where: { claimCaseId: f.id }, orderBy: { id: 'asc' } });
  const receipts = await db().returnReceipt.findMany({ where: { claimCaseId: f.id }, orderBy: { id: 'asc' } });
  const shipmentIds = dispositions.map(d => d.replacementShipmentId).filter((id): id is string => Boolean(id));
  const receiptIds = receipts.map(r => r.id);
  const repairs = await db().repairWorkOrder.findMany({ where: { claimCaseId: f.id }, orderBy: { id: 'asc' } });
  return { ...b, dispositions, receipts, repairs,
    returnLines: await db().returnReceiptLine.findMany({ where: { returnReceiptId: { in: receiptIds } }, orderBy: { id: 'asc' } }),
    shipments: await db().shipment.findMany({ where: { id: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    shipmentLines: await db().shipmentLine.findMany({ where: { shipmentId: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    movement: await db().stockMovement.findMany({ where: { referenceId: { in: receiptIds } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: [f.applicantId, f.leaderId] }, action: { in: ['execute', 'CLAIM_RETURN_LINE_APPENDED', 'PACKING_LINES_REPLACE', 'CLAIM_REAPPROVAL_SUBMITTED'] } }, orderBy: { id: 'asc' } }),
  };
}
/** Fail the actual SQL FK AFTER domain writes. No mocked rollback/delegate success. */
function failMandatoryAudit(action: string) {
  return new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
        if (method === 'create') return (args: any) => delegate.create(args.data.action === action ? { ...args, data: { ...args.data, actorId: prefix + '-missing-account' } } : args);
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe('V1 actual claim goods and historical reapproval', () => {
  it.each(['ReturnRefund', 'Replace', 'Repair'])('CG01 %s creates exact approved goods and same-ID replay creates nothing extra', async kind => {
    const f = await fixture('goods-' + kind, goodsInput(kind)); const r = await resources(f);
    await decide(f); expect((await advance(f)).status).toBe(200);
    const parameters = { warehouseId: r.warehouse.id, ...(kind === 'Repair' ? { workStationId: r.station.id } : {}), clientRequestId: 'execute-' + kind };
    const response = await execute(f, parameters); expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await goodsState(f); expect(after.disposition.status).toBe('Executed');
    expect(after.receipts).toHaveLength(1); expect(after.returnLines).toHaveLength(1);
    expect(after.returnLines[0]).toMatchObject({ claimDispositionId: f.dispositionId, materialCode: 'ACCEPTANCE-SKU-REAL', unit: 'M', status: 'Draft' });
    expect(after.returnLines[0].expectedQuantity.toString()).toBe('2.5'); expect(after.returnLines[0].receivedQuantity.toString()).toBe('0');
    if (kind === 'Replace') { expect(after.shipments).toHaveLength(1); expect(after.shipmentLines).toHaveLength(1); expect(after.shipmentLines[0]).toMatchObject({ productCode: 'ACCEPTANCE-SKU-REAL', unit: 'M', orderLineId: null }); expect(after.shipmentLines[0].quantity!.toString()).toBe('2.5'); }
    if (kind === 'Repair') { expect(after.repairs).toHaveLength(1); expect(after.repairs[0]).toMatchObject({ dispositionId: f.dispositionId, materialCode: 'ACCEPTANCE-SKU-REAL', unit: 'M', status: 'Draft' }); expect(after.repairs[0].quantity.toString()).toBe('2.5'); }
    expect(after.creditNotes.length).toBe(kind === 'ReturnRefund' ? 1 : 0);
    const replay = await execute(f, parameters); expect(replay.status, JSON.stringify(replay.body)).toBe(200); expect(await goodsState(f)).toEqual(after);
    for (const [token, payload] of [[f.applicantToken, { ...parameters, notes: 'changed' }], [f.leaderToken, parameters]] as const) {
      const refused = await execute(f, payload, db(), token); expect(refused.status).toBe(409); expect(await goodsState(f)).toEqual(after);
    }
  });
  it('CG02 mandatory execution audit SQL failure rolls back return line, packing line, headers and projections', async () => {
    const f = await fixture('goods-audit-fault', goodsInput('Replace')); const r = await resources(f); await decide(f); expect((await advance(f)).status).toBe(200);
    const before = await goodsState(f); const response = await execute(f, { warehouseId: r.warehouse.id, clientRequestId: 'execute-fault' }, failMandatoryAudit('execute'));
    expect(response.status).toBe(500); expect(await goodsState(f)).toEqual(before);
  });
  it('CG03 second approved goods disposition appends one line to the case receipt; different warehouse refuses atomically', async () => {
    const f = await fixture('two-dispositions', goodsInput('Replace')); const r = await resources(f); await decide(f); expect((await advance(f)).status).toBe(200);
    expect((await execute(f, { warehouseId: r.warehouse.id, clientRequestId: 'first' })).status).toBe(200);
    const created = await request(f.app).post('/api/v1/claims/' + f.id + '/dispositions').set('Authorization', 'Bearer ' + f.applicantToken).send(goodsInput('Repair'));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const second = { ...f, dispositionId: created.body.disposition.id, approvalId: created.body.approvalRequestId };
    await decide(second); expect((await advance(second)).status).toBe(200);
    const now = BigInt(Date.now()); const other = await db().warehouse.create({ data: { id: f.id + '-other-WH', code: f.id + '-other-WH', name: 'Other synthetic warehouse', type: 'Main', createdAt: now, updatedAt: now } });
    const before = await goodsState(f);
    expect((await execute(second, { warehouseId: other.id, workStationId: r.station.id, clientRequestId: 'second-conflict' })).status).toBe(409); expect(await goodsState(f)).toEqual(before);
    expect((await execute(second, { warehouseId: r.warehouse.id, workStationId: r.station.id, clientRequestId: 'second' })).status).toBe(200);
    const after = await goodsState(f); expect(after.receipts).toHaveLength(1); expect(after.returnLines).toHaveLength(2); expect(after.receipts[0]).toMatchObject({ disposition: 'Mixed', status: 'Draft' });
  });
  it('CG04 legacy Approved requires explicit new version, keeps old facts and replays the same reapproval identity', async () => {
    const f = await fixture('reapproval-legacy'); const historic = await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } });
    await db().claimDisposition.update({ where: { id: f.dispositionId }, data: { status: 'Approved', approverId: f.leaderId, approvedAt: '2026-09-17' } });
    const before = await goodsState(f); expect((await execute(f, { clientRequestId: 'legacy-execute' })).status).toBe(409); expect(await goodsState(f)).toEqual(before);
    const path = '/api/v1/claims/dispositions/' + f.dispositionId + '/resubmit-approval'; const payload = { reason: '明确修订金额并重新送审', clientRequestId: 'resubmit-legacy', changes: { amount: '120.1234' } };
    const submitted = await request(f.app).post(path).set('Authorization', 'Bearer ' + f.applicantToken).send(payload);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: f.approvalId } })).toEqual(historic);
    expect(await db().claimDisposition.findUniqueOrThrow({ where: { id: f.dispositionId } })).toMatchObject({ status: 'Cancelled', approverId: f.leaderId, approvedAt: '2026-09-17', cancelledBy: f.applicantId });
    const after = await goodsState(f); expect(after.dispositions).toHaveLength(2); expect(after.creditNotes).toHaveLength(0);
    const replay = await request(f.app).post(path).set('Authorization', 'Bearer ' + f.applicantToken).send(payload); expect(replay.status).toBe(201); expect(replay.body.disposition.id).toBe(submitted.body.disposition.id); expect(await goodsState(f)).toEqual(after);
    const mismatch = await request(f.app).post(path).set('Authorization', 'Bearer ' + f.applicantToken).send({ ...payload, changes: { amount: '121' } }); expect(mismatch.status).toBe(409); expect(await goodsState(f)).toEqual(after);
    const replacement = { ...f, dispositionId: submitted.body.disposition.id, approvalId: submitted.body.approvalRequestId }; await decide(replacement); expect((await advance(replacement)).status).toBe(200); expect((await execute(replacement, { clientRequestId: 'revised-execute' })).status).toBe(200);
    expect((await businessState(replacement)).creditNotes[0].amount.toString()).toBe('120.1234');
  });
  it('CG05 reapproval required audit FK failure rolls back new disposition/approval and keeps old Approved history', async () => {
    const f = await fixture('reapproval-audit-fault'); await db().claimDisposition.update({ where: { id: f.dispositionId }, data: { status: 'Approved', approverId: f.leaderId, approvedAt: '2026-09-17' } });
    const before = await goodsState(f), beforeApprovals = await db().approvalRequest.findMany({ where: { requesterId: f.applicantId }, orderBy: { id: 'asc' } });
    const response = await request(claimApp(failMandatoryAudit('CLAIM_REAPPROVAL_SUBMITTED'))).post('/api/v1/claims/dispositions/' + f.dispositionId + '/resubmit-approval').set('Authorization', 'Bearer ' + f.applicantToken).send({ reason: '真实审计失败探针', clientRequestId: 'resubmit-fault', changes: { amount: '120' } });
    expect(response.status).toBe(500); expect(await goodsState(f)).toEqual(before); expect(await db().approvalRequest.findMany({ where: { requesterId: f.applicantId }, orderBy: { id: 'asc' } })).toEqual(beforeApprovals);
  });
  it('CG06 receive and scrap create real Inbound/Lock then Unlock/Outbound exactly once, preserving ownership', async () => {
    const f = await fixture('real-receive', goodsInput('ReturnRefund')); const r = await resources(f); await decide(f); expect((await advance(f)).status).toBe(200); expect((await execute(f, { warehouseId: r.warehouse.id, clientRequestId: 'receive-execute' })).status).toBe(200);
    const line = (await goodsState(f)).returnLines[0]; const now = BigInt(Date.now());
    const item = await db().inventoryItem.create({ data: { id: f.id + '-item', warehouseId: r.warehouse.id, materialCode: 'ACCEPTANCE-SKU-REAL', description: 'Synthetic returned item', batchNumber: f.id + '-batch', quantity: '0', lockedQuantity: '0', unit: 'M', ownership: 'Transferred', createdAt: now, updatedAt: now } });
    const path = '/api/v1/return-receipt-lines/' + line.id; const payload = { clientRequestId: 'receive-one', itemId: item.id, quantity: '2.5', unit: 'M' };
    const received = await request(f.app).post(path + '/receive').set('Authorization', 'Bearer ' + f.applicantToken).send(payload); expect(received.status, JSON.stringify(received.body)).toBe(200);
    const receivedState = { item: await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } }), ledger: await db().stockMovement.findMany({ where: { itemId: item.id }, orderBy: { id: 'asc' } }), case: await goodsState(f) };
    expect(receivedState.item.quantity.toString()).toBe('2.5'); expect(receivedState.item.lockedQuantity.toString()).toBe('2.5'); expect(receivedState.item.ownership).toBe('Transferred'); expect(receivedState.ledger.map(m => m.type).sort()).toEqual(['Inbound', 'Lock']);
    const replay = await request(f.app).post(path + '/receive').set('Authorization', 'Bearer ' + f.applicantToken).send(payload); expect(replay.status).toBe(200); expect(await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(receivedState.item); expect(await db().stockMovement.findMany({ where: { itemId: item.id }, orderBy: { id: 'asc' } })).toEqual(receivedState.ledger);
    const over = await request(f.app).post(path + '/receive').set('Authorization', 'Bearer ' + f.applicantToken).send({ ...payload, clientRequestId: 'receive-over' }); expect(over.status).toBe(409); expect(await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(receivedState.item);
    const scrap = { clientRequestId: 'scrap-one', receivedEventId: received.body.receivedEventId, reason: '批准报废真实批次' };
    const disposed = await request(f.app).post(path + '/scrap').set('Authorization', 'Bearer ' + f.applicantToken).send(scrap); expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
    const final = await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } }); expect(final.quantity.toString()).toBe('0'); expect(final.lockedQuantity.toString()).toBe('0'); expect(final.ownership).toBe('Transferred');
    const ledger = await db().stockMovement.findMany({ where: { itemId: item.id }, orderBy: { id: 'asc' } }); expect(ledger.map(m => m.type).sort()).toEqual(['Inbound', 'Lock', 'Outbound', 'Unlock']);
    expect((await request(f.app).post(path + '/scrap').set('Authorization', 'Bearer ' + f.applicantToken).send(scrap)).status).toBe(200); expect(await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(final); expect(await db().stockMovement.findMany({ where: { itemId: item.id }, orderBy: { id: 'asc' } })).toEqual(ledger);
  });
  it('CG07 receive mandatory audit FK failure rolls back actual inventory, movements and receipt quantities', async () => {
    const f = await fixture('receive-audit-fault', goodsInput('Repair')); const r = await resources(f); await decide(f); expect((await advance(f)).status).toBe(200); expect((await execute(f, { warehouseId: r.warehouse.id, workStationId: r.station.id, clientRequestId: 'receive-fault-execute' })).status).toBe(200);
    const line = (await goodsState(f)).returnLines[0]; const now = BigInt(Date.now()); const item = await db().inventoryItem.create({ data: { id: f.id + '-item', warehouseId: r.warehouse.id, materialCode: 'ACCEPTANCE-SKU-REAL', description: 'Synthetic return', quantity: '0', lockedQuantity: '0', unit: 'M', createdAt: now, updatedAt: now } });
    const before = await goodsState(f);
    const received = await request(claimApp(failMandatoryAudit('CLAIM_RETURN_RECEIVED'))).post('/api/v1/return-receipt-lines/' + line.id + '/receive').set('Authorization', 'Bearer ' + f.applicantToken).send({ clientRequestId: 'actual-audit-fault', itemId: item.id, quantity: '2.5', unit: 'M' });
    expect(received.status).toBe(500); expect(await goodsState(f)).toEqual(before); expect(await db().inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(item); expect(await db().stockMovement.count({ where: { itemId: item.id } })).toBe(0); expect(await db().auditLog.count({ where: { targetId: line.id, action: 'CLAIM_RETURN_RECEIVED' } })).toBe(0);
  });
});
