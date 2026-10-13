/** Actual shipping router/current stored roles and grants/L2/native history.
 * Synthetic unapproved source headers and actual metadata update producer only;
 * no production approval, stock, company data or full workflow claim. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { setDefaultAgentApiKeyActors } from '../src/auth/agentPrincipal';
import { createShippingRouter } from '../src/shipping/route';
import { updateShipment } from '../src/shipping/shipmentMutationService';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const peer = new PrismaClient();
const prefix = `history-read-${randomUUID()}`;
const key = `${prefix}-key`;
const evidence = process.env.BAMBOOK_HISTORY_PROBE_EVIDENCE_DIR;
let seq = 0;
const receipts: unknown[] = [];
const stringify = (v: unknown) => JSON.stringify(v, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
function save(name: string, value: unknown) { if (evidence) fs.writeFileSync(path.join(evidence, name), stringify(value) + '\n'); }
db.$on('query', e => { if (evidence) fs.appendFileSync(path.join(evidence, 'history-native-queries.jsonl'), stringify(e) + '\n'); });
beforeAll(async () => {
  const identity = await db.$queryRawUnsafe('SELECT current_database() AS name,current_setting(\'data_directory\') AS directory,inet_server_port() AS port');
  expect(identity).toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
  expect(process.env.BAMBOOK_ACCEPTANCE_DB_NAME).toMatch(/^bambook_acceptance_[a-f0-9]+$/); save('history-native-identity.json', identity);
});
afterAll(async () => { save('history-read-receipts.json', receipts); setDefaultAgentApiKeyActors(new Map()); await peer.$disconnect(); await db.$disconnect(); });

async function fixture(label: string, scopes: string[] = ['shipments:read'], global = false) {
  const id = `${prefix}-${++seq}-${label}`, userId = `${id}-user`, otherId = `${id}-other`, roleId = global ? 'role-logistics' : `${id}-custom`;
  await db.userAccount.createMany({ data: [{ id: userId, displayName: 'Synthetic current history reader', status: 'active' }, { id: otherId, displayName: 'Synthetic other owner', status: 'active' }] });
  await db.role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: 'Synthetic actual stored role', isSystem: global } });
  await db.userRole.create({ data: { id: `${id}-role`, userId, roleId } });
  // Fixture source is written by the actual metadata producer under explicit
  // technical grants; these are removed before issuing the history credential.
  for (const scope of ['shipments:read', 'shipments:write', 'orders:read', 'orders:write']) {
    await db.userPermissionOverrides.create({ data: { id: `${id}-${scope}`, userId, scope, grantedBy: userId, reason: 'Private source producer technical grant' } });
  }
  const now = BigInt(Date.now()), orderId = `${id}-order`, foreignOrderId = `${id}-foreign-order`, shipmentId = `${id}-shipment`;
  for (const [oid, owner] of [[orderId, userId], [foreignOrderId, otherId]]) await db.order.create({ data: { id: oid, customer: 'Synthetic customer', product: 'Synthetic fabric', type: 'fabric', quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10, ownerId: owner, updatedAt: now } });
  await db.shipment.create({ data: { id: shipmentId, shipmentNumber: shipmentId, type: 'Export', status: 'Booked', shippingMethod: 'Sea', orderId, etd: '2026-10-10', createdAt: now, updatedAt: now } });
  const actor = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, userId));
  const written = await updateShipment({ prisma: db, shipmentId, actor, actorId: userId, hasStatus: false, patch: { etd: '2026-10-12', vesselOrFlight: 'Synthetic vessel' } });
  expect(written.ok, stringify(written)).toBe(true);
  await db.userPermissionOverrides.deleteMany({ where: { userId } });
  for (const scope of scopes) {
    const permission = await db.permission.upsert({ where: { scope }, create: { id: `${id}-perm-${scope}`, scope }, update: {} });
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, create: { id: `${id}-rp-${scope}`, roleId, permissionId: permission.id }, update: {} });
  }
  const prior = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, userId));
  return { id, userId, otherId, roleId, orderId, foreignOrderId, shipmentId, prior, token: createAuthService().signToken(prior) };
}
function application(options: { fault?: 'current' | 'order' | 'allocation' | 'audit'; afterAudit?: () => Promise<void>; actors?: Map<string, TokenPayload>; dev?: boolean } = {}) {
  const counts = { auditReads: 0, currentReads: 0, allocationReads: 0 };
  const client = db.$extends({ query: {
    userAccount: { async findFirst({ args, query }) { counts.currentReads++; if (options.fault === 'current') throw Error('synthetic current SELECT secret'); return query(args); } },
    order: { async findMany({ args, query }) { if (options.fault === 'order') throw Error('synthetic order SELECT secret'); return query(args); } },
    shipmentOrderAllocation: { async findMany({ args, query }) { counts.allocationReads++; if (options.fault === 'allocation') throw Error('synthetic allocation SELECT secret'); return query(args); } },
    auditLog: { async findMany({ args, query }) { counts.auditReads++; if (options.fault === 'audit') throw Error('synthetic audit SELECT secret'); const result = await query(args); await options.afterAudit?.(); return result; } },
  } }) as unknown as PrismaClient;
  setDefaultAgentApiKeyActors(options.actors ?? new Map());
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/api/v1/shipping', createShippingRouter({ prisma: client, requireAuth: !options.dev, apiKeys: new Set([key]), exceptionChecker: null }));
  return { app, counts };
}
async function read(label: string, f: Awaited<ReturnType<typeof fixture>>, h: ReturnType<typeof application>, options: { id?: string; token?: string; apiKey?: string; anonymous?: boolean; datesOnly?: boolean } = {}) {
  const target = options.id ?? f.shipmentId;
  const before = { audits: await db.auditLog.count(), shipments: await db.shipment.count(), events: await db.shipmentEvent.count(), allocations: await db.shipmentOrderAllocation.count() };
  const countBefore = { ...h.counts };
  let call = request(h.app).get(`/api/v1/shipping/${encodeURIComponent(target)}/schedule-history`).query(options.datesOnly ? { datesOnly: '1' } : {});
  if (!options.anonymous && !options.apiKey) call = call.set('Authorization', `Bearer ${options.token ?? f.token}`);
  if (options.apiKey) call = call.set('X-Bambook-API-Key', options.apiKey);
  const response = await call;
  const after = { audits: await db.auditLog.count(), shipments: await db.shipment.count(), events: await db.shipmentEvent.count(), allocations: await db.shipmentOrderAllocation.count() };
  receipts.push({ label, target, callerId: f.userId, status: response.status, body: response.body, before, after, delegateDelta: Object.fromEntries(Object.keys(h.counts).map(k => [k, (h.counts as any)[k] - (countBefore as any)[k]])) });
  save('history-read-receipts.json', receipts); expect(after).toEqual(before);
  expect(stringify(response.body)).not.toMatch(/synthetic .*SELECT secret|P2010|P2003|SELECT .*FROM|PrismaClient/i);
  return response;
}
function refusal(r: any, status: number) { expect(r.status, stringify(r.body)).toBe(status); expect(r.body.changes).toBeUndefined(); expect(r.body.error?.code).toBeTruthy(); }
async function revoke(f: Awaited<ReturnType<typeof fixture>>) { await peer.rolePermission.deleteMany({ where: { roleId: f.roleId } }); }

describe('actual shipping schedule history current read contract', () => {
  it('HR01 current ships-only grant reads its owned legacy source and native description/actor/time with datesOnly', async () => {
    const f = await fixture('owned'); expect(f.prior.permissions).toEqual(['shipments:read']); const h = application();
    const r = await read('owned', f, h); expect(r.status).toBe(200); expect(r.body.shipmentId).toBe(f.shipmentId); expect(r.body.count).toBe(2);
    const date = r.body.changes.find((c: any) => c.field === 'etd'); expect(date.description).toBe('预计离港(ETD) 2026-10-10 → 2026-10-12'); expect(date.actorId).toBe(f.userId); expect(Number.isFinite(Date.parse(date.at))).toBe(true);
    const dates = await read('datesOnly', f, h, { datesOnly: true }); expect(dates.status).toBe(200); expect(dates.body.count).toBe(1); expect(dates.body.changes[0]).toEqual(date);
  });
  it('HR02 allocation-linked visible order admits a multi-order shipment whose projection is foreign', async () => {
    const f = await fixture('multisource'); await db.shipment.update({ where: { id: f.shipmentId }, data: { orderId: f.foreignOrderId } });
    await db.shipmentOrderAllocation.create({ data: { id: `${f.id}-alloc`, shipmentId: f.shipmentId, orderId: f.orderId, plannedQty: 10, status: 'Planned', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    expect((await read('allocated-visible', f, application())).status).toBe(200);
  });
  it('HR03 current global logistics policy permits standalone history but self policy does not', async () => {
    const f = await fixture('standalone-global', ['shipments:read'], true); await db.shipment.update({ where: { id: f.shipmentId }, data: { orderId: null } });
    expect((await read('standalone-global', f, application())).status).toBe(200);
    const self = await fixture('standalone-self'); await db.shipment.update({ where: { id: self.shipmentId }, data: { orderId: null } }); const h = application();
    refusal(await read('standalone-self', self, h), 404); expect(h.counts.auditReads).toBe(0);
  });
  it('HR04 no current ships grant and signed legacy owner claim cannot read; audit is not touched', async () => {
    const f = await fixture('no-grant', []); const token = createAuthService().signToken({ ...f.prior, roles: ['owner'], permissions: ['shipments:read'] }); const h = application();
    refusal(await read('no-current-scope', f, h, { token }), 403); expect(h.counts.auditReads).toBe(0);
  });
  it('HR05 empty signed credential ceiling denies despite current stored grant and audit stays unread', async () => {
    const f = await fixture('empty-ceiling'); const token = createAuthService().signToken({ ...f.prior, permissionCeiling: [] }); const h = application();
    refusal(await read('empty-ceiling', f, h, { token }), 403); expect(h.counts.auditReads).toBe(0);
  });
  it.each(['foreign', 'missing', 'deleted'] as const)('HR06 %s source is 404 before any audit read', async kind => {
    const f = await fixture(kind); if (kind === 'foreign') await db.shipment.update({ where: { id: f.shipmentId }, data: { orderId: f.foreignOrderId } });
    if (kind === 'deleted') await db.shipment.update({ where: { id: f.shipmentId }, data: { deletedAt: BigInt(Date.now()) } }); const h = application();
    refusal(await read(kind, f, h, { id: kind === 'missing' ? `${f.id}-missing` : f.shipmentId }), 404); expect(h.counts.auditReads).toBe(0);
  });
  it('HR07 role withdrawal takes effect on the next request under the same valid old JWT', async () => {
    const f = await fixture('revoke-before'); await revoke(f); const h = application(); refusal(await read('revoked-before', f, h), 403); expect(h.counts.auditReads).toBe(0);
  });
  it('HR08 expired personal grant cannot survive a valid old credential', async () => {
    const f = await fixture('expired', []); await db.userPermissionOverrides.create({ data: { id: `${f.id}-temporary`, userId: f.userId, scope: 'shipments:read', grantedBy: f.userId, reason: 'Private expiry boundary', expiresAt: new Date(Date.now() + 60_000) } });
    const prior = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, f.userId)); await db.userPermissionOverrides.update({ where: { id: `${f.id}-temporary` }, data: { expiresAt: new Date(Date.now() - 60_000) } }); const h = application();
    refusal(await read('expired-personal', f, h, { token: createAuthService().signToken(prior) }), 403); expect(h.counts.auditReads).toBe(0);
  });
  it('HR09 current parent handoff is followed even when the old actor/source identity is unchanged', async () => {
    const f = await fixture('handoff-before'); await db.order.update({ where: { id: f.orderId }, data: { ownerId: f.otherId } }); const h = application();
    refusal(await read('handoff-before', f, h), 404); expect(h.counts.auditReads).toBe(0);
  });
  it.each(['current', 'order', 'allocation'] as const)('HR10 actual %s delegate failure is safe 503 before audit, never empty history', async fault => {
    const f = await fixture('fault-' + fault); if (fault === 'allocation') await db.shipment.update({ where: { id: f.shipmentId }, data: { orderId: f.foreignOrderId } }); const h = application({ fault });
    refusal(await read('fault-' + fault, f, h), 503); expect(h.counts.auditReads).toBe(0);
  });
  it('HR11 unknown actual Audit delegate fault is safe 500 rather than empty success or SQL text', async () => {
    const f = await fixture('audit-fault'); const h = application({ fault: 'audit' }); refusal(await read('audit-fault', f, h), 500); expect(h.counts.auditReads).toBe(1);
  });
  it.each(['grant', 'parent', 'target'] as const)('HR12 separate PG connection changes %s during audit read; return is denied without writes', async change => {
    const f = await fixture('during-' + change); let done = false; const h = application({ afterAudit: async () => { if (done) return; done = true;
      if (change === 'grant') await revoke(f);
      if (change === 'parent') await peer.order.update({ where: { id: f.orderId }, data: { ownerId: f.otherId } });
      if (change === 'target') await peer.shipment.update({ where: { id: f.shipmentId }, data: { deletedAt: BigInt(Date.now()) } });
    } });
    refusal(await read('during-' + change, f, h), change === 'grant' ? 403 : 404); expect(h.counts.auditReads).toBe(1);
  });
  it('HR13 explicit bound API key must retain current grant and ceiling; bare key and dev cannot gain authority', async () => {
    const f = await fixture('key'); const actors = new Map([[key, f.prior]]); const h = application({ actors }); expect((await read('bound-key', f, h, { apiKey: key })).status).toBe(200);
    await revoke(f); const denied = application({ actors }); refusal(await read('revoked-key', f, denied, { apiKey: key }), 403); expect(denied.counts.auditReads).toBe(0);
    const bare = application(); refusal(await read('bare-key', f, bare, { apiKey: key }), 401); expect(bare.counts.auditReads).toBe(0);
    const dev = application({ dev: true }); refusal(await read('anonymous-dev', f, dev, { anonymous: true }), 401); expect(dev.counts.auditReads).toBe(0);
  });
});
