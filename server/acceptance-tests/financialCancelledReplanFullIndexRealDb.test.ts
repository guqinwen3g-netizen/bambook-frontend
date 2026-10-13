/** Four finite real full-index/private-PG controls. Technical accounts/orders are
 * fixtures; financial plans, cancellation, invoice/IOA and notes use HTTP
 * producers. No SQL manufactures payment, stock, shipping or approval facts.
 * These controls do not qualify whole shipping/finance, default roles or UI. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import cp, { type ChildProcess } from 'node:child_process'; import { randomUUID, createHash } from 'node:crypto';
import request from 'supertest';
const sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
assert(sandbox.startsWith('/private/tmp/bambook-financial-cancel-replan-'));
const marker = JSON.parse(fs.readFileSync(path.join(sandbox, 'PRIVATE-PG-MARKER.json'), 'utf8'));
assert(marker.authorized && marker.root === sandbox && fs.realpathSync(sandbox) === sandbox);
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, String(marker.port)); assert.equal(url.pathname, '/' + marker.name);
assert.equal(fs.realpathSync(marker.directory), sandbox + '/postgres'); assert.equal(process.env.BAMBOOK_NO_SCHEDULER, '1');
const { PrismaClient, Prisma } = require('@prisma/client') as typeof import('@prisma/client');
const { createAuthService } = require('../dist/auth/service') as typeof import('../src/auth/service');
const { loadUserWithRoles, buildLoadedAuthTokenPayload } = require('../dist/auth/tokenHelpers') as typeof import('../src/auth/tokenHelpers');
const db = new PrismaClient(), peer = new PrismaClient();
const origin = 'http://127.0.0.1:' + marker.apiPort, prefix = 'acceptance-cancel-replan-' + randomUUID();
let api: ChildProcess | undefined; const observations: any[] = [];
const json = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x);
const hash = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (r: any) => r.body.error?.code ?? r.body.error;
beforeAll(async () => {
 expect(await db.$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
  .toEqual([{ name: marker.name, directory: marker.directory, port: marker.port }]);
 const output = fs.openSync(sandbox + '/raw/index-' + Date.now() + '.log', 'a');
 api = cp.spawn(process.execPath, ['dist/index.js'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(marker.apiPort) }, stdio: ['ignore', output, output] });
 fs.closeSync(output); fs.writeFileSync(sandbox + '/INDEX-OWNERSHIP.json', json({ pid: api.pid, cwd: path.resolve('.'), port: marker.apiPort }));
 for (let i = 0; i < 100; i++) { if (api.exitCode !== null) throw Error('Private full index exited before health');
  try { const r = await fetch(origin + '/api/health'); if (r.ok) return; } catch {} await wait(50); }
 throw Error('Private full index did not become healthy');
});
afterAll(async () => {
 if (api) { api.kill('SIGTERM'); for (let i = 0; i < 50 && api.exitCode === null && api.signalCode === null; i++) await wait(50);
  if (api.exitCode === null && api.signalCode === null) { api.kill('SIGKILL'); for (let i = 0; i < 20 && api.exitCode === null && api.signalCode === null; i++) await wait(50); }
  expect(api.exitCode !== null || api.signalCode !== null).toBe(true); }
 await peer.$disconnect(); await db.$disconnect();
 fs.writeFileSync(sandbox + '/OBSERVATIONS-' + Date.now() + '.json', json({ observations, indexStopped: !api || api.exitCode !== null || api.signalCode !== null }));
});
async function fixture(label: string) {
 const id = prefix + '-' + label + '-' + randomUUID(), userId = id + '-logistics', customerId = id + '-customer', orderId = id + '-order', now = BigInt(Date.now());
 await db.role.upsert({ where: { id: 'role-logistics' }, update: {}, create: { id: 'role-logistics', name: 'Synthetic logistics identity', isSystem: true } });
 await db.userAccount.create({ data: { id: userId, displayName: 'Synthetic financial-plan actor', status: 'active' } });
 await db.userRole.create({ data: { id: id + '-ur', userId, roleId: 'role-logistics' } });
 await db.userPermissionOverrides.createMany({ data: ['orders:read', 'shipments:read', 'shipments:write', 'invoices:read', 'invoices:write'].map(scope => ({ id: id + '-' + scope, userId, scope, isActive: true, grantedBy: userId, reason: 'Explicit private technical capability, not default-role UAT' })) });
 await db.relation.create({ data: { id: customerId, name: 'Synthetic private customer', category: 'Customer', type: 'Company', isOrganization: true, ownerId: userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
 await db.order.create({ data: { id: orderId, poNumber: id, customer: 'Synthetic private customer', customerRelationId: customerId, product: 'Synthetic controlled order', type: 'Fabric', quantity: 100, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 100, salesCurrency: 'USD', ownerId: userId, importedAt: now, updatedAt: now } });
 const actor = await buildLoadedAuthTokenPayload(db, (await loadUserWithRoles(db, userId))!); expect(actor.authorizationLoaded).toBe(true);
 expect(actor.permissions).toContain('shipments:write'); return { id, userId, customerId, orderId, actor, token: createAuthService().signToken(actor) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const http = (f: Fixture, method: 'get' | 'post' | 'put', url: string, token = f.token) => request(origin)[method](url).set('Authorization', 'Bearer ' + token);
const batchPath = '/api/v1/shipping/order-batches';
const plan = (f: Fixture, ratio: number, isFinalBatch: boolean, notes = 'Synthetic explicitly entered settlement plan') => ({ orderId: f.orderId, plannedRatio: ratio, plannedQty: String(ratio), unit: 'M', amount: String(ratio), currency: 'USD', isFinalBatch, notes });
async function create(f: Fixture, ratio: number, final: boolean) { const r = await http(f, 'post', batchPath).send(plan(f, ratio, final)); expect(r.status, json(r.body)).toBe(201); return r.body.batch; }
async function cancel(f: Fixture, batch: any) { const r = await http(f, 'put', batchPath + '/' + batch.id).send({ status: 'cancelled' }); expect(r.status, json(r.body)).toBe(200); expect(r.body.batch.status).toBe('cancelled'); return r.body.batch; }
const batch = (id: string) => db.orderShipmentBatch.findUniqueOrThrow({ where: { id } });
const audits = (id: string) => db.auditLog.findMany({ where: { targetType: 'OrderShipmentBatch', targetId: id }, orderBy: { id: 'asc' } });
async function monetary(f: Fixture) { const ioa = await db.invoiceOrderAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
 const ids = ioa.map(r => r.invoiceId); return { invoiceOrderAllocations: ioa, invoices: await db.invoice.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }), cashAllocations: await db.invoiceAllocation.findMany({ where: { invoiceId: { in: ids } }, orderBy: { id: 'asc' } }) }; }
it('FCR01 cancelling an original 60% final allows a new active 100% final, preserving cancelled row, original audit and real invoice/IOA separately from cash', async () => {
 const f = await fixture('replan'), old = await create(f, 60, true);
 const invoice = await http(f, 'post', '/api/v1/finance').send({ invoiceNumber: f.id + '-native-draft', type: 'Receivable', status: 'Draft', amount: '60', currency: 'USD', issueDate: '2026-10-03', orderId: f.orderId, customerRelationId: f.customerId, customerName: 'Synthetic private customer', orderAllocations: [{ orderId: f.orderId, batchId: old.id, allocatedAmount: '60', note: 'Explicit preserved original debt anchor' }] });
 expect(invoice.status, json(invoice.body)).toBe(201);
 const beforeMoney = json(await monetary(f)); expect((await monetary(f)).invoiceOrderAllocations).toHaveLength(1); expect((await monetary(f)).cashAllocations).toHaveLength(0);
 await cancel(f, old); const original = json(await batch(old.id)), originalAudits = await audits(old.id), originalHash = hash(originalAudits);
 const next = await create(f, 100, true); expect(next.batchNo).toBe(old.batchNo + 1); expect(next.isFinalBatch).toBe(true);
 expect(json(await batch(old.id))).toBe(original); expect(await audits(old.id)).toEqual(originalAudits); expect(json(await monetary(f))).toBe(beforeMoney);
 const all = await db.orderShipmentBatch.findMany({ where: { orderId: f.orderId, deletedAt: null } });
 expect(all.filter(r => r.status !== 'cancelled' && r.isFinalBatch)).toHaveLength(1); expect(all.filter(r => r.status !== 'cancelled').reduce((sum, r) => sum + Number(r.plannedRatio), 0)).toBe(100);
 observations.push({ label: 'FCR01', originalId: old.id, replacementId: next.id, originalAuditsSHA256: originalHash, invoiceOrderAllocations: 1, cashAllocations: 0, oldFrozen: true });
});
it('FCR02 cancelled historical notes can be amended after a new final without reactivating old ratio/final; plan fields and repeat cancellation remain frozen', async () => {
 const f = await fixture('notes'), old = await create(f, 60, true); await cancel(f, old); const replacement = await create(f, 100, true);
 const frozen = await batch(old.id), active = json(await batch(replacement.id)), originalAudits = await audits(old.id);
 const updated = await http(f, 'put', batchPath + '/' + old.id).send({ notes: 'Explicit historical cancellation explanation; no plan revival' });
 expect(updated.status, json(updated.body)).toBe(200); expect(updated.body.batch.status).toBe('cancelled');
 const current = await batch(old.id), { notes: _beforeNote, updatedAt: _beforeTime, ...beforeFields } = frozen, { notes: _afterNote, updatedAt: _afterTime, ...afterFields } = current;
 expect(afterFields).toEqual(beforeFields); expect(current.notes).toBe('Explicit historical cancellation explanation; no plan revival'); expect(json(await batch(replacement.id))).toBe(active);
 const appended = await audits(old.id); for (const a of originalAudits) expect(appended.find(r => r.id === a.id)).toEqual(a); expect(appended).toHaveLength(originalAudits.length + 1);
 const beforeDenied = json({ old: current, active: await batch(replacement.id), audits: appended });
 for (const input of [{ plannedRatio: 0 }, { plannedQty: '0' }, { amount: '0' }, { isFinalBatch: false }]) { const denied = await http(f, 'put', batchPath + '/' + old.id).send(input); expect(denied.status).toBe(409); expect(code(denied)).toBe('PLAN_FROZEN'); }
 const twice = await http(f, 'put', batchPath + '/' + old.id).send({ status: 'cancelled' }); expect(twice.status).toBe(409); expect(code(twice)).toBe('ALREADY_CANCELLED');
 const revival = await http(f, 'put', batchPath + '/' + old.id).send({ status: 'planned' }); expect(revival.status).toBe(400); expect(code(revival)).toBe('INVALID_TRANSITION');
 expect(json({ old: await batch(old.id), active: await batch(replacement.id), audits: await audits(old.id) })).toBe(beforeDenied);
 observations.push({ label: 'FCR02', noteAppended: true, oldPlanFrozen: true, replacementUnchanged: true, deniedPlanMutations: 4, repeatCancelDenied: true, revivalDenied: true });
});
it('FCR03 current planned ratio and final uniqueness remain enforced; current withdrawal, empty signed ceiling and inactive account cause no plan or audit writes', async () => {
 const f = await fixture('constraints'); await create(f, 40, false); await create(f, 60, true);
 const state = async () => json({ batches: await db.orderShipmentBatch.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }), audits: await db.auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }) });
 const before = await state();
 const overflow = await http(f, 'post', batchPath).send(plan(f, 1, false)); expect(overflow.status).toBe(400); expect(code(overflow)).toBe('RATIO_EXCEEDED');
 const finalDuplicate = await http(f, 'post', batchPath).send(plan(f, 0, true)); expect(finalDuplicate.status).toBe(409); expect(code(finalDuplicate)).toBe('FINAL_BATCH_DUPLICATE');
 const ceiling = createAuthService().signToken({ ...f.actor, permissionCeiling: [] }); expect((await http(f, 'post', batchPath, ceiling).send(plan(f, 0, false))).status).toBe(403);
 await db.userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: false } });
 try { const revoked = await http(f, 'post', batchPath).send(plan(f, 0, false)); expect(revoked.status, json(revoked.body)).toBe(403); }
 finally { await db.userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: true } }); }
 await db.userAccount.update({ where: { id: f.userId }, data: { status: 'disabled' } });
 try { const disabled = await http(f, 'post', batchPath).send(plan(f, 0, false)); expect([401, 403]).toContain(disabled.status); }
 finally { await db.userAccount.update({ where: { id: f.userId }, data: { status: 'active' } }); }
 expect(await state()).toBe(before); observations.push({ label: 'FCR03', currentRatios: 100, currentFinalCount: 1, overflow: 400, duplicateFinal: 409, ceilingDenied: true, storedRevocationDenied: true, inactiveDenied: true, noBusinessOrAuditWrites: true });
});
it('FCR04 actual concurrent cancellation and two replacement requests wait on distinct backend connections under the existing native source/order lock; one replacement wins', async () => {
 const f = await fixture('race'), old = await create(f, 100, true); let release!: () => void, acquired!: () => void;
 const held = new Promise<void>(resolve => { acquired = resolve; }), permit = new Promise<void>(resolve => { release = resolve; });
 const holder = peer.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${f.orderId} FOR UPDATE`; acquired(); await permit; });
 await held;
 const waiting = () => db.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%' AND query LIKE '%Order%' ORDER BY pid");
 const waitFor = async (n: number) => { for (let i = 0; i < 60; i++) { const rows = await waiting(); if (rows.length >= n) return rows; await wait(20); } throw Error('Actual HTTP lock waiters not observed: ' + n); };
 let cancellation: Promise<any> | undefined, first: Promise<any> | undefined, second: Promise<any> | undefined, waiters: Array<{pid:number}> = [];
 try {
  cancellation = http(f, 'put', batchPath + '/' + old.id).send({ status: 'cancelled' }).then(r => r); await waitFor(1);
  first = http(f, 'post', batchPath).send(plan(f, 100, true)).then(r => r); second = http(f, 'post', batchPath).send(plan(f, 100, true)).then(r => r);
  waiters = await waitFor(3); expect(new Set(waiters.map(row => row.pid)).size).toBeGreaterThanOrEqual(3);
 } finally { release(); await holder; }
 const cancelled = await cancellation!; expect(cancelled.status, json(cancelled.body)).toBe(200);
 const results = await Promise.all([first!, second!]); expect(results.map(r => r.status).sort()).toEqual([201, 400]); expect(code(results.find(r => r.status === 400))).toBe('RATIO_EXCEEDED');
 const rows = await db.orderShipmentBatch.findMany({ where: { orderId: f.orderId, deletedAt: null }, orderBy: { batchNo: 'asc' } });
 expect(rows).toHaveLength(2); expect(rows[0].status).toBe('cancelled'); expect(rows[0].plannedRatio?.toString()).toBe('100'); expect(rows[0].isFinalBatch).toBe(true);
 const effective = rows.filter(r => r.status !== 'cancelled'); expect(effective).toHaveLength(1); expect(effective[0].isFinalBatch).toBe(true); expect(effective[0].batchNo).toBe(old.batchNo + 1);
 expect(effective.reduce((sum, r) => sum + Number(r.plannedRatio), 0)).toBe(100);
 const actions = await db.auditLog.findMany({ where: { actorId: f.userId, targetType: 'OrderShipmentBatch' } }); expect(actions.filter(r => r.action === 'create_order_shipment_batch')).toHaveLength(2); expect(actions.filter(r => r.action === 'update_order_shipment_batch')).toHaveLength(1);
 observations.push({ label: 'FCR04', distinctActualBackendPids: waiters.map(row => row.pid), concurrentRequests: 3, statuses: [cancelled.status, ...results.map(r => r.status)], activeFinalCount: 1, activeRatio: 100, failedRequestNoAudit: true });
});
