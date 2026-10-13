/** True HTTP/current DB identity/isolated PG batch custody probes.
 * DR-D6 (Kevin, 2026-09-16) separates Decimal length from physical Int cards.
 * DR-054 receipt is independent from design and QC approval. Explicit zero is
 * the existing nonnegative Int stock contract, never an inferred physical 1.
 * These configured technical fixtures do not prove company-role UAT, all sample
 * length cutting/return workflows, manual code-allocation concurrency, or all
 * legacy inferred receipts corrected. No seed/index/scheduler/external action.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createDevelopmentRouter } from '../src/development/route';
import { createSampleRoomService } from '../src/samples/sampleRoomService';

const prefix = 'acceptance-batch-card-' + randomUUID();
let prisma: PrismaClient | undefined, sequence = 0;
const db = () => { if (!prisma) throw Error('Independent physical card DB is not initialized'); return prisma; };
// Runner privately generates the current schema; no shared client mutation.
const models = () => db() as any;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres')); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`,
    'private cluster identity is checked before any fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { if (prisma) await prisma.$disconnect(); });
async function actor(label: string, scopes = ['products:read', 'products:write', 'sample:room:write']) {
  const id = prefix + '-' + ++sequence + '-' + label, roleId = id + '-configured-role';
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: 'Synthetic physical card receiver', status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: 'Synthetic isolated receiver grants', isSystem: false } });
    await tx.userRole.create({ data: { id: id + '-assignment', userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
      await tx.rolePermission.create({ data: { id: id + '-grant-' + scope, roleId, permissionId: permission.id } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current!.scopes).toEqual([...scopes].sort()); expect(current!.authorizationLoaded).toBe(true);
  const payload = { userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true as const };
  return { id, roleId, payload, token: createAuthService().signToken(payload) };
}
async function fixture(label: string, type = 'fabric', scopes?: string[]) {
  const who = await actor(label, scopes), id = who.id + '-source'; const now = BigInt(Date.now());
  const customer = await db().relation.create({ data: { id: id + '-customer', name: 'Synthetic authorized sample customer', category: 'Client', type: 'Company',
    isOrganization: true, ownerId: who.id, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
  const supplier = await db().relation.create({ data: { id: id + '-supplier', name: 'Synthetic real source mill', category: 'Supplier', type: 'Company',
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
  const development = await db().developmentCase.create({ data: { id: id + '-case', code: id + '-case', name: 'Synthetic unapproved sample activity', type,
    stage: 'developing', owner: who.id, customerRelationId: customer.id, customerName: customer.name, createdAt: now, updatedAt: now } });
  const batch = await db().sampleBatch.create({ data: { id: id + '-batch', batchCode: id + '-batch', developmentCaseId: development.id,
    supplierRelationId: supplier.id, supplierName: supplier.name, sampleType: type === 'garment' ? 'garment-round' : 'yardage',
    status: 'pending', confirmStatus: 'unconfirmed', planQuantity: '20', planUnit: 'M', actualQuantity: '8', actualUnit: 'M', createdAt: now, updatedAt: now } });
  return { who, development, batch, notify: vi.fn(), input: {
    receiptVersion: 2, cardType: type === 'garment' ? 'garment' as const : 'fabric' as const,
    expectedSourceRound: batch.round, expectedCaseId: development.id, expectedFactoryId: supplier.id,
    physicalCardCount: 3, expectedBatchUpdatedAt: batch.updatedAt.toString(), actualQuantity: '2.75' as string | null, actualUnit: 'M' as string | null,
  } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(f: Fixture, database: PrismaClient = db()) {
  const application = express(); application.use(express.json());
  application.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  application.use(createAccountStatusGuard(db())); application.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  application.use('/api/v1/development', createDevelopmentRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), onDataChange: f.notify }));
  return application;
}
function receive(f: Fixture, patch: Record<string, unknown> = {}, database: PrismaClient = db()) {
  return request(app(f, database)).post('/api/v1/development/batches/' + f.batch.id + '/register-received')
    .set('Authorization', 'Bearer ' + f.who.token).send({ ...f.input, ...patch });
}
async function snapshot(f: Fixture) {
  return { batch: await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
    development: await db().developmentCase.findUniqueOrThrow({ where: { id: f.development.id } }),
    cards: await models().sampleCardItem.findMany({ where: { batchId: f.batch.id }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.who.id }, orderBy: { id: 'asc' } }) };
}
describe.sequential('physical card count and actual receipt atomicity in real PG', () => {
  it('2.75m and 3 cards persist as different types and one actor-authored receipt fact', async () => {
    const f = await fixture('fractional'); const response = await receive(f, { receivedBy: 'forged-client-actor', receiptSnapshot: { actualQuantity: '99' } });
    expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body).toMatchObject({ created: true, receiptStatus: 'verified', batch: { actualQuantity: '2.75' }, item: { quantity: 3, availableQty: 3, unit: 'PC' } });
    const after = await snapshot(f); expect(after.batch.actualQuantity?.toString()).toBe('2.75'); expect(after.batch.planQuantity?.toString()).toBe('20');
    expect(after.batch).toMatchObject({ status: 'pending', confirmStatus: 'unconfirmed', approvedBy: null, approvedAt: null, qcStatus: null });
    expect(after.development).toEqual(f.development); expect(after.cards).toHaveLength(1);
    expect(after.cards[0].receiptSnapshot).toMatchObject({ version: 2, nativeFamily: 'fabric-batch', batchId: f.batch.id, batchCode: f.batch.batchCode,
      developmentCaseId: f.development.id, factoryId: f.batch.supplierRelationId, sourceRound: f.batch.round, cardType: 'fabric',
      initialPhysicalCardCount: 3, actualQuantity: '2.75', actualUnit: 'M', physicalUnit: 'PC', receivedBy: f.who.id });
    expect(after.audits).toHaveLength(2); expect(after.audits.every(row => row.actorId === f.who.id)).toBe(true);
    expect((after.audits.find(row => row.action === 'sample_card_create')!.detail as any).after.receiptSnapshot).toEqual(after.cards[0].receiptSnapshot);
    expect((after.audits.find(row => row.action === 'update_sample_batch')!.detail as any).after.actualQuantity).toBe('2.75'); expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it('actual garment batch source allows explicitly counted pieces without manufacturing QC/customer approval', async () => {
    const f = await fixture('garment', 'garment'); const response = await receive(f, { actualQuantity: null, actualUnit: null, physicalCardCount: 2 });
    expect(response.status, diagnostic(response.body)).toBe(201); const after = await snapshot(f);
    expect(after.cards[0]).toMatchObject({ cardType: 'garment', quantity: 2, unit: 'PC', batchId: f.batch.id });
    expect(after.batch).toMatchObject({ sampleType: 'garment-round', actualQuantity: null, status: 'pending', qcStatus: null, qcReviewedBy: null, confirmStatus: 'unconfirmed', approvedBy: null });
  });
  it.each([null, '0', '0.75'])('length %s and explicit zero cards remain independent without fake 1', async actualQuantity => {
    const f = await fixture('zero'); const response = await receive(f, { actualQuantity, physicalCardCount: 0 });
    expect(response.status, diagnostic(response.body)).toBe(201); const after = await snapshot(f);
    expect(after.batch.actualQuantity?.toString() ?? null).toBe(actualQuantity); expect(after.cards[0]).toMatchObject({ quantity: 0, availableQty: 0, unit: 'PC' });
    const loan = await createSampleRoomService(db()).createLoan(after.cards[0].id, { requestKey: 'physical-db-fixture-loan-01', borrowerName: 'Cannot borrow zero cards', loanQuantity: 1 }, f.who.payload);
    expect(loan.ok).toBe(false); expect(await snapshot(f)).toEqual(after);
  });
  it('all Decimal(18,4) digits remain exact in PG, response and immutable audit snapshot', async () => {
    const f = await fixture('precise'); const response = await receive(f, { actualQuantity: '12345678901234.1234', physicalCardCount: 2147483647 });
    expect(response.status, diagnostic(response.body)).toBe(201); const after = await snapshot(f);
    expect(response.body.batch.actualQuantity).toBe('12345678901234.1234'); expect(after.batch.actualQuantity?.toString()).toBe('12345678901234.1234');
    expect(after.cards[0].receiptSnapshot.actualQuantity).toBe('12345678901234.1234'); expect(after.cards[0].quantity).toBe(2147483647);
  });
  it('missing/invalid explicit card counts write no batch, card, audit or notification', async () => {
    const f = await fixture('invalid-count'); const before = await snapshot(f);
    for (const physicalCardCount of [undefined, null, '3', 2.75, -1, 2147483648]) {
      const response = await receive(f, { physicalCardCount }); expect(response.status, diagnostic(response.body)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED'); expect(await snapshot(f)).toEqual(before);
    }
    expect(f.notify).not.toHaveBeenCalled();
  });
  it('invalid length inputs are rejected instead of saved as unknown/zero/rounded', async () => {
    const f = await fixture('invalid-length'); const before = await snapshot(f);
    for (const actualQuantity of ['-1', 'NaN', '1.23456', '1e3', 2.75]) {
      const response = await receive(f, { actualQuantity }); expect(response.status, diagnostic(response.body)).toBe(400); expect(await snapshot(f)).toEqual(before);
    }
    expect(f.notify).not.toHaveBeenCalled();
  });
  it('same receipt replays after actual borrowing and unrelated batch timestamp change without restoring stock', async () => {
    const f = await fixture('replay'); const first = await receive(f); expect(first.status, diagnostic(first.body)).toBe(201);
    const loan = await createSampleRoomService(db()).createLoan(first.body.item.id, { requestKey: 'physical-db-fixture-loan-02', borrowerName: 'Synthetic physical custody recipient', loanQuantity: 2 }, f.who.payload); expect(loan.ok, diagnostic(loan)).toBe(true);
    const changed = await request(app(f)).patch('/api/v1/development/batches/' + f.batch.id).set('Authorization', 'Bearer ' + f.who.token).send({ notes: 'Later unrelated development note' });
    expect(changed.status, diagnostic(changed.body)).toBe(200); const before = await snapshot(f);
    const replay = await receive(f); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toMatchObject({ created: false, item: { quantity: 3, availableQty: 1 } });
    expect(await snapshot(f)).toEqual(before); expect(f.notify.mock.calls.filter(([event]) => event.action === 'batch-received')).toHaveLength(1);
  });
  it('different initial count/source fact cannot overwrite receipt; stale first receipt leaves all rows unchanged', async () => {
    const f = await fixture('conflict'); const before = await snapshot(f);
    expect((await receive(f, { expectedBatchUpdatedAt: '0' })).status).toBe(409); expect(await snapshot(f)).toEqual(before);
    const first = await receive(f); expect(first.status, diagnostic(first.body)).toBe(201); const registered = await snapshot(f);
    for (const patch of [{ physicalCardCount: 4 }, { actualQuantity: '2.5' }, { actualUnit: 'YD' }]) {
      const response = await receive(f, patch); expect(response.status, diagnostic(response.body)).toBe(409); expect(response.body.error.code).toBe('BATCH_RECEIPT_CONFLICT'); expect(await snapshot(f)).toEqual(registered);
    }
  });
  it('concurrent same-batch receipts create exactly one physical row and one pair of success audits', async () => {
    const f = await fixture('concurrent'); const results = await Promise.all([receive(f), receive(f)]);
    expect(results.map(row => row.status).sort(), diagnostic(results.map(row => row.body))).toEqual([200, 201]);
    expect(new Set(results.map(row => row.body.item.id)).size).toBe(1); const after = await snapshot(f);
    expect(after.cards).toHaveLength(1); expect(after.audits).toHaveLength(2); expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it('legacy inferred or soft-deleted physical row is explicit unverified history and never rematerialized', async () => {
    const f = await fixture('legacy'); await models().sampleCardItem.create({ data: { id: f.batch.id + '-legacy', code: f.batch.id + '-legacy', name: 'Legacy inferred card',
      batchId: f.batch.id, devCaseId: f.development.id, quantity: 2, availableQty: 2, unit: 'M', receiptSnapshot: undefined, createdAt: BigInt(1), updatedAt: BigInt(1), deletedAt: BigInt(2) } });
    const before = await snapshot(f); const response = await receive(f);
    expect(response.status, diagnostic(response.body)).toBe(409); expect(response.body.error.code).toBe('BATCH_CARDS_LEGACY_UNVERIFIED'); expect(await snapshot(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
  });
  it.each(['update_sample_batch', 'sample_card_create'])('real mandatory %s audit FK failure rolls source/physical/audit back together', async action => {
    const f = await fixture('audit-fault'); const before = await snapshot(f);
    let injections = 0, sqlCode: string | undefined, actualSeenInside: string | undefined, cardSeenInside = false;
    const faultClient = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => {
        const audit = new Proxy(tx.auditLog, { get(delegate, key) {
          if (key === 'create') return async (args: any) => {
            if (args.data.action !== action) return delegate.create(args);
            injections++; actualSeenInside = (await tx.sampleBatch.findUniqueOrThrow({ where: { id: f.batch.id } })).actualQuantity?.toString();
            if (action === 'sample_card_create') cardSeenInside = !!(await tx.sampleCardItem.findUnique({ where: { id: args.data.targetId } }));
            try { return await delegate.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-audit-actor' } }); }
            catch (error: any) { sqlCode = error?.code; throw error; }
          };
          const value = Reflect.get(delegate, key); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const wrapped = new Proxy(tx, { get(client, key) { if (key === 'auditLog') return audit;
          const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value; } });
        return callback(wrapped);
      }, options);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) as PrismaClient;
    const response = await receive(f, {}, faultClient); expect(response.status, diagnostic(response.body)).toBe(500);
    expect(injections).toBe(1); expect(actualSeenInside).toBe('2.75'); expect(sqlCode).toBe('P2003');
    if (action === 'sample_card_create') expect(cardSeenInside).toBe(true);
    expect(await snapshot(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
  });
  it('both current write scopes are mandatory and withdrawal invalidates an already issued JWT', async () => {
    for (const scopes of [[], ['products:write'], ['sample:room:write']]) {
      const f = await fixture('missing-scope', 'fabric', scopes), before = await snapshot(f); const response = await receive(f);
      expect(response.status, diagnostic(response.body)).toBe(403); expect(await snapshot(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
    }
    const f = await fixture('withdrawal'), before = await snapshot(f); const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'sample:room:write' } });
    await db().rolePermission.deleteMany({ where: { roleId: f.who.roleId, permissionId: permission.id } });
    const response = await receive(f); expect(response.status, diagnostic(response.body)).toBe(403); expect(await snapshot(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
  });
  it.each(['paused', 'closed'])('existing %s development state gate prevents receipt updates and retains its history', async state => {
    const f = await fixture(state); await db().developmentLifecycleEvent.create({ data: { id: f.batch.id + '-lifecycle', developmentCaseId: f.development.id,
      revision: 1, action: state === 'paused' ? 'pause' : 'close', state, reason: 'Synthetic operational state fact', snapshot: {}, requestKey: f.batch.id, requestFingerprint: f.batch.id,
      createdBy: f.who.id, createdAt: BigInt(Date.now()) } });
    const before = await snapshot(f); const response = await receive(f); expect(response.status, diagnostic(response.body)).toBe(409);
    expect(response.body.error.code).toBe(state === 'paused' ? 'DEVELOPMENT_PAUSED' : 'DEVELOPMENT_CLOSED'); expect(await snapshot(f)).toEqual(before);
    expect(await db().developmentLifecycleEvent.count({ where: { developmentCaseId: f.development.id } })).toBe(1); expect(f.notify).not.toHaveBeenCalled();
  });
});
