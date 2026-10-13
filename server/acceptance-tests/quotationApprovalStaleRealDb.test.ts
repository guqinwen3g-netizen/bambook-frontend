// Native quotation/approval domain calls over real isolated PostgreSQL. This is
// not HTTP authorization, external delivery, customer identity or rendered UI proof.
// Approved rows are produced by the real assigned-reviewer decision kernel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createQuotationService } from '../src/quotations/quotationService';
import { createQuotationApprovalService } from '../src/quotations/quotationApproval';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { approvalReviewContentVersion, createApprovalDecisionService } from '../src/approvals/approvalDecisionService';

const db = new PrismaClient();
async function decideReviewed(prisma: PrismaClient, approvalId: string, reviewerId: string, decision: 'approved' | 'rejected' = 'approved') {
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  return createApprovalDecisionService(prisma).decide({ id: approvalId, actor: { userId: reviewerId, roles: [] }, decision,
    source: 'api:approvals', reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true });
}
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent sandbox required');
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect([url.pathname, url.port]).toEqual(['/' + name, port]);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  const actual = await db.$queryRaw<Array<{ name: string; directory: string; port: number }>>
    `SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
  expect(actual, 'physical identity before any fixture write').toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await db.$disconnect(); });

async function fixture(key: string) {
  const prefix = 'acceptance-quotation-stale-' + key;
  const actorId = prefix + '-sales', reviewerId = prefix + '-reviewer', departmentId = prefix + '-department';
  await db.department.create({ data: { id: departmentId, name: 'Synthetic quotation department', status: 'active' } });
  await db.userAccount.createMany({ data: [
    { id: actorId, displayName: 'Synthetic quotation sales', status: 'active', primaryDeptId: departmentId },
    { id: reviewerId, displayName: 'Synthetic assigned reviewer', status: 'active', primaryDeptId: departmentId },
  ] });
  await db.department.update({ where: { id: departmentId }, data: { headId: reviewerId } });
  const customerId = prefix + '-customer';
  await db.relation.create({ data: { id: customerId, name: prefix + ' customer', category: 'customer', type: 'company',
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
  const quotations = createQuotationService(db);
  const approvals = createQuotationApprovalService({ prisma: db,
    approvalCreateService: createApprovalCreateService({ prisma: db, routingService: createApprovalRoutingService({ prisma: db }) }) });
  const decisions = createApprovalDecisionService(db);
  const quote = await quotations.createQuotation({ quotationNumber: prefix, currency: 'USD', customerRelationId: customerId,
    customerName: prefix + ' customer', issueDate: '2026-10-01', lines: [
      { description: 'Synthetic fabric', quantity: 10000, unit: 'M', unitPrice: 2.5001 },
    ] }, actorId);
  const line = quote.lines[0];
  return { prefix, actorId, reviewerId, departmentId, customerId, quotations, approvals, decisions, quote, line };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const total = (await f.approvals.requestTotalApproval({ quotationId: f.quote.id, actorId: f.actorId })).totalApproval!;
  const line = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
  for (const request of [line, total]) {
    expect(request.reviewerId).toBe(f.reviewerId);
    await decideReviewed(db, request.id, f.reviewerId);
  }
  return db.approvalRequest.findMany({ where: { id: { in: [line.id, total.id] } }, orderBy: { id: 'asc' } });
}
async function unchangedHistory(rows: Awaited<ReturnType<typeof approved>>) {
  expect(await db.approvalRequest.findMany({ where: { id: { in: rows.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(rows);
}

describe('native real PG quotation approval current-source boundaries', () => {
  it('QAS01 real assigned decisions permit their unchanged quotation; facts and exact amounts remain', async () => {
    const f = await fixture('unchanged');
    const facts = await approved(f);
    const current = await f.approvals.getApprovalStatus({ quotationId: f.quote.id });
    expect(current.lineStatuses[0].status).toBe('approved');
    expect(current.totalStatus).toBe('approved');
    expect((await f.quotations.sendQuotation(f.quote.id, f.actorId)).status).toBe('Sent');
    expect((await db.quotation.findUniqueOrThrow({ where: { id: f.quote.id } })).totalAmount.toString()).toBe('25001');
    expect(await db.auditLog.count({ where: { targetId: { in: facts.map(row => row.id) }, action: 'approve_business_request' } })).toBe(2);
    await unchangedHistory(facts);
  });

  it('QAS02 Sent revise retaining line IDs invalidates current approval, preserves old approved facts and blocks resend', async () => {
    const f = await fixture('revise');
    const facts = await approved(f);
    await f.quotations.sendQuotation(f.quote.id, f.actorId);
    const revision = await f.quotations.reviseQuotation(f.quote.id, 'Synthetic new commercial round', f.actorId);
    expect([revision.version, revision.lines[0].id]).toEqual([2, f.line.id]);
    const current = await f.approvals.getApprovalStatus({ quotationId: f.quote.id });
    expect(current.lineStatuses[0].status, 'historical approval is not current-version permission').not.toBe('approved');
    expect(current.totalStatus).not.toBe('approved');
    expect(current.autoApproved).toBe(false);
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    expect((await db.quotation.findUniqueOrThrow({ where: { id: f.quote.id } })).status).toBe('Draft');
    expect(await db.auditLog.count({ where: { targetId: f.quote.id, action: 'send_quotation' } })).toBe(1);
    await unchangedHistory(facts);
  });

  it('QAS03 native draft line replacement cannot inherit old total approval or bypass it with new IDs', async () => {
    const f = await fixture('lines');
    const facts = await approved(f);
    const edited = await f.quotations.updateQuotation(f.quote.id, { lines: [
      { description: 'Changed actual fabric', quantity: 11000, unit: 'M', unitPrice: 3.5001 },
    ] }, f.actorId);
    expect(edited.lines[0].id).not.toBe(f.line.id);
    expect((await f.approvals.getApprovalStatus({ quotationId: f.quote.id })).totalStatus).not.toBe('approved');
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    expect((await db.quotation.findUniqueOrThrow({ where: { id: f.quote.id } })).status).toBe('Draft');
    expect(await db.auditLog.count({ where: { targetId: f.quote.id, action: 'send_quotation' } })).toBe(0);
    await unchangedHistory(facts);
  });

  it('QAS04 native currency-only edit is stale even when the old writer leaves version unchanged', async () => {
    const f = await fixture('currency');
    const facts = await approved(f);
    const edited = await f.quotations.updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    expect(edited.version).toBe(1); // Current native version rule; fingerprint must add the missing boundary.
    const current = await f.approvals.getApprovalStatus({ quotationId: f.quote.id });
    expect(current.lineStatuses[0].status).not.toBe('approved');
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    expect((await db.quotation.findUniqueOrThrow({ where: { id: f.quote.id } })).status).toBe('Draft');
    await unchangedHistory(facts);
  });

  it('QAS05 an actual pending request cannot be decided after its native quotation source changes', async () => {
    const f = await fixture('pending');
    const request = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    await f.quotations.updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    await expect(decideReviewed(db, request.id, f.reviewerId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).toEqual(request);
    expect(await db.auditLog.count({ where: { targetId: request.id, action: 'approve_business_request' } })).toBe(0);
  });

  it('QAS06 the actual requester supersedes stale pending atomically; exact-current retry returns the original new request', async () => {
    const f = await fixture('resubmit');
    const old = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    await f.quotations.updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    const current = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    expect(current.id).not.toBe(old.id);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).toEqual({ ...old, status: 'cancelled' });
    expect(await db.auditLog.count({ where: { targetId: old.id, action: 'quotation_approval_superseded' } })).toBe(1);
    expect((await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval.id).toBe(current.id);
    expect(await db.approvalRequest.count({ where: { requesterId: f.actorId, targetId: f.line.id } })).toBe(2);
    await decideReviewed(db, current.id, f.reviewerId);
    expect((await f.approvals.requestTotalApproval({ quotationId: f.quote.id, actorId: f.actorId })).autoApproved).toBe(true);
    expect((await f.quotations.sendQuotation(f.quote.id, f.actorId)).currency).toBe('EUR');
  });

  it('QAS07 actual SQL mandatory request-audit FK failure rolls back cancellation, new request and supersede audit', async () => {
    const f = await fixture('audit-rollback');
    const old = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    await f.quotations.updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    let injected = false;
    const faulty = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => callback(new Proxy(tx, {
        get(inner, txKey) {
          if (txKey === 'auditLog') return new Proxy(inner.auditLog, { get(model, method) {
            if (method === 'create') return async (args: any) => {
              if (args.data.action === 'request_quotation_approval') {
                injected = true;
                return model.create({ ...args, data: { ...args.data, actorId: f.prefix + '-missing-actor' } });
              }
              return model.create(args);
            };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(inner, txKey); return typeof value === 'function' ? value.bind(inner) : value;
        },
      })), options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = createQuotationApprovalService({ prisma: faulty, approvalCreateService:
      createApprovalCreateService({ prisma: faulty, routingService: createApprovalRoutingService({ prisma: faulty }) }) });
    await expect(service.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).rejects.toMatchObject({ code: 'P2003' });
    expect(injected).toBe(true);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db.approvalRequest.count({ where: { requesterId: f.actorId, targetId: f.line.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: old.id, action: 'quotation_approval_superseded' } })).toBe(0);
  });

  it('QAS08 actual accepted quotation with persisted source drift cannot convert using old approval', async () => {
    const f = await fixture('convert');
    const facts = await approved(f);
    await f.quotations.sendQuotation(f.quote.id, f.actorId);
    await f.quotations.acceptQuotation(f.quote.id, f.actorId, 'Synthetic customer acceptance, no external delivery');
    // A source-integrity fault, not a claim that native editing of Accepted is allowed.
    await db.quotation.update({ where: { id: f.quote.id }, data: { currency: 'EUR' } });
    await expect(f.quotations.convertToOrder(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    expect((await db.quotation.findUniqueOrThrow({ where: { id: f.quote.id } })).convertedOrderId).toBeNull();
    expect(await db.order.count({ where: { poNumber: f.quote.quotationNumber } })).toBe(0);
    expect(await db.auditLog.count({ where: { targetId: f.quote.id, action: 'convert_quotation_to_order' } })).toBe(0);
    await unchangedHistory(facts);
  });

  it('QAS09 missing historical snapshot is unverified, not migrated into a current approval by reading', async () => {
    const f = await fixture('legacy');
    const facts = await approved(f);
    // Remove the snapshot only to model historical stored data, retaining the real decision/audit.
    for (const row of facts) {
      const { quotationSnapshot: _snapshot, contentFingerprint: _fingerprint, ...legacy } = row.payload as Record<string, any>;
      await db.approvalRequest.update({ where: { id: row.id }, data: { payload: legacy } });
    }
    const before = await db.approvalRequest.findMany({ where: { id: { in: facts.map(row => row.id) } }, orderBy: { id: 'asc' } });
    const status = await f.approvals.getApprovalStatus({ quotationId: f.quote.id });
    expect([status.lineStatuses[0].status, status.totalStatus, status.autoApproved]).toEqual(['legacy_unverified', 'legacy_unverified', false]);
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_UNVERIFIED', statusCode: 409 });
    expect(await db.approvalRequest.findMany({ where: { id: { in: facts.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('QAS10 a concurrent native edit committed ahead of the decision source lock refuses the old snapshot', async () => {
    const f = await fixture('decision-race');
    const old = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    let held!: () => void, change!: () => void, attempted!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const changeNow = new Promise<void>(resolve => { change = resolve; });
    const lockAttempt = new Promise<void>(resolve => { attempted = resolve; });
    const keeper = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Quotation" WHERE "id" = ${f.quote.id} FOR UPDATE`;
      held(); await changeNow;
      const nativeInTx = new Proxy(db, { get(target, key) {
        if (key === '$transaction') return (callback: any) => callback(tx);
        if (key === 'quotation') return tx.quotation;
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await createQuotationService(nativeInTx).updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    }, { timeout: 30_000 });
    await holding;
    const contender = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => callback(new Proxy(tx, {
        get(inner, txKey) {
          if (txKey === '$queryRaw') return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join('').includes('Quotation')) attempted();
            return inner.$queryRaw(strings, ...values);
          };
          const value = Reflect.get(inner, txKey); return typeof value === 'function' ? value.bind(inner) : value;
        },
      })), options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const decision = decideReviewed(contender, old.id, f.reviewerId);
    const expectation = expect(decision).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_STALE', statusCode: 409 });
    await lockAttempt; change(); await keeper; await expectation;
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db.auditLog.count({ where: { targetId: old.id, action: 'approve_business_request' } })).toBe(0);
  });

  it.each(['pending', 'rejected'] as const)('QAS11 current total %s is not auto-approved over its real decision by approved lines', async state => {
    const f = await fixture('total-' + state);
    const total = (await f.approvals.requestTotalApproval({ quotationId: f.quote.id, actorId: f.actorId })).totalApproval!;
    const line = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    await decideReviewed(db, line.id, f.reviewerId);
    if (state === 'rejected') await decideReviewed(db, total.id, f.reviewerId, 'rejected');
    const current = await f.approvals.getApprovalStatus({ quotationId: f.quote.id });
    expect([current.lineStatuses[0].status, current.totalStatus, current.autoApproved]).toEqual(['approved', state, false]);
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({
      code: state === 'pending' ? 'QUOTATION_APPROVAL_PENDING' : 'QUOTATION_APPROVAL_REJECTED',
    });
    const retry = await f.approvals.requestTotalApproval({ quotationId: f.quote.id, actorId: f.actorId });
    expect(retry.autoApproved).toBe(false);
    if (state === 'pending') expect(retry.totalApproval!.id).toBe(total.id);
    else {
      expect(retry.totalApproval!.id).not.toBe(total.id);
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: total.id } })).status).toBe('rejected');
    }
  });

  it('QAS12 unknown historical pending is not erased by actual current line approval; only its requester supersedes it', async () => {
    const f = await fixture('unknown-pending');
    const old = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    const { quotationSnapshot: _snapshot, contentFingerprint: _fingerprint, ...legacy } = old.payload as Record<string, any>;
    await db.approvalRequest.update({ where: { id: old.id }, data: { payload: legacy } });
    const original = await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } });
    const peerActor = f.prefix + '-peer';
    await db.userAccount.create({ data: { id: peerActor, displayName: 'Synthetic second requester', status: 'active', primaryDeptId: f.departmentId } });
    const actual = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: peerActor })).approval;
    await decideReviewed(db, actual.id, f.reviewerId);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).toEqual(original);
    expect((await f.approvals.getApprovalStatus({ quotationId: f.quote.id })).autoApproved).toBe(false);
    await expect(f.quotations.sendQuotation(f.quote.id, f.actorId)).rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_UNVERIFIED', statusCode: 409 });
    const replacement = (await f.approvals.requestLineApproval({ quotationId: f.quote.id, lineId: f.line.id, actorId: f.actorId })).approval;
    expect(replacement.id).not.toBe(old.id);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: old.id } })).toEqual({ ...original, status: 'cancelled' });
    await decideReviewed(db, replacement.id, f.reviewerId);
    expect((await f.quotations.sendQuotation(f.quote.id, f.actorId)).status).toBe('Sent');
  });

  it('QAS13 historically decided approval retains once-only refusal after the native source changes or is deleted', async () => {
    const f = await fixture('resolved-once');
    const facts = await approved(f);
    await f.quotations.updateQuotation(f.quote.id, { currency: 'EUR' }, f.actorId);
    for (const row of facts) await expect(decideReviewed(db, row.id, f.reviewerId)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED', statusCode: 409 });
    await db.quotation.update({ where: { id: f.quote.id }, data: { deletedAt: BigInt(Date.now()) } });
    for (const row of facts) await expect(decideReviewed(db, row.id, f.reviewerId, 'rejected')).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED', statusCode: 409 });
    expect(await db.auditLog.count({ where: { targetId: { in: facts.map(row => row.id) }, action: 'approve_business_request' } })).toBe(2);
    await unchangedHistory(facts);
  });
});
