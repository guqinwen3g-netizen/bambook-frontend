/** Actual Express → guarded link producer, stateful synthetic storage; no company HTTP/PG.
 * Ledger 08 §4.1/4.4: fabric cases return fabric batches; garment rounds create one Card per garment.
 * A collaborating team's name does not change the authoritative development business line.
 * This exercises the existing legacy intake seam, not native exact-version return/QC or PG locks.
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createSampleRoomService } from '../sampleRoomService';
import { bindSampleOrigins, snapshotSampleOrigin } from '../sampleOriginService';
import { createSampleRouter } from '../sampleRoute';
import { createSampleCardSampleLinkRouter } from '../sampleCardSampleLinkRoute';
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// BEGIN STORAGE FIXTURE (also used verbatim in the HTTP control file; no shared production test seam).
const actor: any = { userId: 'LINK-ACTOR', roles: ['sales'], permissions: ['products:read', 'sample:room:write'], permissionCeiling: ['products:read', 'sample:room:write'] };
const copy = (v: any): any => Prisma.Decimal.isDecimal(v) ? new Prisma.Decimal(v) : v instanceof Date ? new Date(v)
  : Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v;
function storage(kind = 'fabric') {
  const state: any = { cases: [{ id: 'CASE', code: 'DEV-SYNTHETIC', name: 'Synthetic source', type: kind, ownerId: actor.userId, customerRelationId: 'CUSTOMER', updatedAt: 20n, deletedAt: null }],
    batches: [{ id: 'BATCH', batchCode: 'SB-SYNTHETIC', developmentCaseId: 'CASE', supplierRelationId: 'FACTORY', sampleType: kind === 'garment' ? 'garment-round' : 'yardage',
      round: 1, status: 'pending', updatedAt: 10n, createdAt: 1n, deletedAt: null, actualQuantity: new Prisma.Decimal(kind === 'garment' ? '3' : '0.75'), actualUnit: kind === 'garment' ? '件' : 'M', attachments: {} }],
    relations: ['CUSTOMER', 'FACTORY'].map(id => ({ id, ownerId: actor.userId, salesRepIds: [], deletedAt: null })), seals: [], links: [], samples: [], sources: [], cards: [], loans: [], audits: [],
    orders: [], assets: [], warehouses: [], overrides: [], memberships: [], grants: [], users: [{ id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ departmentId: null, role: { id: 'role-sales', permissions: ['products:read', 'sample:room:write'].map(scope => ({ permission: { scope } })) } }] }] };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([f, v]: any) => f === 'OR' ? v.some((w: any) => matches(row, w))
    : f === 'AND' ? v.every((w: any) => matches(row, w)) : f === 'team' ? matches(row.team, v) : v && typeof v === 'object' && 'in' in v ? v.in.includes(row[f])
      : v && typeof v === 'object' && 'gt' in v ? row[f] > v.gt : v && typeof v === 'object' && 'path' in v ? v.path.reduce((x: any, k: string) => x?.[k], row[f]) === v.equals : row[f] === v);
  const delegate = (name: string) => ({
    findMany: vi.fn(async ({ where, orderBy, take, skip = 0 }: any = {}) => { const rows = state[name].filter((r: any) => matches(r, where)); if (orderBy?.id) rows.sort((a: any, b: any) => a.id.localeCompare(b.id)); return rows.slice(skip, take === undefined ? undefined : skip + take); }),
    findFirst: vi.fn(async ({ where }: any) => state[name].find((r: any) => matches(r, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => state[name].find((r: any) => matches(r, where)) ?? null),
    count: vi.fn(async ({ where }: any = {}) => state[name].filter((r: any) => matches(r, where)).length),
    create: vi.fn(async ({ data }: any) => { if (state[name].some((r: any) => r.id === data.id)) throw Object.assign(Error('synthetic unique violation'), { code: 'P2002' });
      const r = { deletedAt: null, ...(name === 'cards' ? { sampleId: null } : name === 'loans' ? { returnedAt: null } : {}), ...copy(data), ...(name === 'audits' ? { createdAt: new Date() } : {}) }; state[name].push(r); return copy(r); }),
    update: vi.fn(async ({ where, data }: any) => { const r = state[name].find((r: any) => matches(r, where)); if (!r) throw Error('synthetic missing update'); Object.assign(r, copy(data)); return copy(r); }),
    updateMany: vi.fn(async ({ where, data }: any) => { const rows = state[name].filter((r: any) => matches(r, where)); rows.forEach((r: any) => Object.assign(r, copy(data))); return { count: rows.length }; }),
  });
  const tx: any = { $queryRaw: vi.fn(async () => [{ id: 'synthetic locked' }]), $executeRaw: vi.fn(async () => 1),
    userAccount: delegate('users'), userPermissionOverrides: delegate('overrides'), relation: delegate('relations'), developmentCase: delegate('cases'),
    sampleBatch: delegate('batches'), sealSample: delegate('seals'), sealSampleBatch: delegate('links'), sample: delegate('samples'), sampleSource: delegate('sources'),
    sampleCardItem: delegate('cards'), sampleCardLoan: delegate('loans'), auditLog: delegate('audits'), order: delegate('orders'), productAsset: delegate('assets'), warehouse: delegate('warehouses'),
    teamMember: delegate('memberships'), teamDataGrant: delegate('grants'),
    developmentLifecycleEvent: { findFirst: vi.fn(async () => null) } };
  // Serial synthetic transactions model atomic rollback/receipt uniqueness only, not PG locking.
  let tail: Promise<any> = Promise.resolve();
  const prisma: any = { ...tx, $transaction: vi.fn((fn: any) => { const run = tail.then(async () => { const before = copy(state); try { return await fn(tx); } catch (e) { Object.assign(state, before); throw e; } }); tail = run.catch(() => undefined); return run; }) };
  return { state, tx, prisma };
}
async function fixture(kind = 'fabric') {
  const f = storage(kind); const room = createSampleRoomService(f.prisma);
  const received = await room.registerReceivedBatchCards('BATCH', { receiptVersion: 2, cardType: kind === 'garment' ? 'garment' : 'fabric', expectedSourceRound: 1, expectedCaseId: 'CASE', expectedFactoryId: 'FACTORY', expectedBatchUpdatedAt: '10', physicalCardCount: 3, actualQuantity: kind === 'garment' ? '3' : '0.75', actualUnit: kind === 'garment' ? '件' : 'M' }, actor.userId);
  if (!received.ok) throw Error(`real receipt fixture failed ${received.error.code}: ${received.error.message}`);
  const borrowed = await room.createLoan(f.state.cards[0].id, { requestKey: 'link-route-fixture-loan-01', loanType: 'borrow', borrowerName: 'Synthetic employee', loanQuantity: 1 }, actor);
  if (!borrowed.ok) throw Error(`real borrow fixture failed ${borrowed.error.code}`);
  const sample = { id: 'SAMPLE', code: 'SMP-SYNTHETIC', type: 'dev', status: 'draft', projectionKey: null, sourceCaseId: 'CASE', sourceOrderId: null, productAssetId: null,
    supplierRelationId: 'FACTORY', customerRelationId: 'CUSTOMER', length: kind === 'garment' ? null : new Prisma.Decimal('0.75'), notes: 'ordinary purpose', createdAt: 1n, updatedAt: 2n, deletedAt: null };
  f.state.samples.push(sample);
  await bindSampleOrigins(f.tx, sample, [snapshotSampleOrigin(f.state.batches[0], f.state.cases[0])], actor.userId, { provenance: 'recorded_exact' });
  f.tx.sampleCardItem.updateMany.mockClear(); f.tx.$queryRaw.mockClear();
  return { ...f, room, cardId: f.state.cards[0].id };
}
// END STORAGE FIXTURE
const token = (patch: any = {}) => jwt.sign({ ...actor, ...patch }, process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars');
const auth = (patch: any = {}) => ({ Authorization: `Bearer ${token(patch)}` });
const root = '/api/v1/samples';
const path = (f: any) => `${root}/room/items/${f.cardId}/sample-link`;
function appFor(f: any, requireAuth = true, onDataChange?: any, old = false) {
  const app = express(); app.use(express.json()); app.use(root, old ? createSampleRouter({ prisma: f.prisma, requireAuth, onDataChange })
    : createSampleCardSampleLinkRouter({ prisma: f.prisma, requireAuth, onDataChange })); return app;
}
async function commandFor(f: any, app: any, requestKey = 'http-card-link-original') {
  const c = await request(app).get(`${path(f)}/context`).set(auth());
  const candidates = await request(app).get(`${path(f)}/candidates`).set(auth());
  expect(c.status).toBe(200); expect(candidates.status).toBe(200); const item = candidates.body.items[0]; expect(item).toBeTruthy();
  return { linkVersion: 1, requestKey, targetSampleId: item.sample.id, matchedSampleSourceId: item.matchedSampleSourceId,
    expectedCardUpdatedAt: c.body.expectedCardUpdatedAt, expectedReceiptHash: c.body.expectedReceiptHash,
    expectedTargetIdentityHash: item.expectedTargetIdentityHash, expectedBindingSetHash: item.expectedBindingSetHash };
}
describe('Original Card link versioned actual HTTP contract', () => {
  it('company Sample router mounts the exact protocol and recovers its original committed receipt', async () => {
    const f = await fixture(); const app = appFor(f, true, undefined, true);
    const input = await commandFor(f, app, 'full-router-original-link');
    const linked = await request(app).post(`${path(f)}/exact`).set(auth()).send(input);
    expect(linked.status).toBe(200); expect(linked.body.state).toBe('committed');
    expect(linked.body.data).toBeUndefined(); expect(linked.body.currentCard).toMatchObject({ sampleId: 'SAMPLE', quantity: 3, availableQty: 2 });
    const recovered = await request(app).get(`${path(f)}/requests/${input.requestKey}`).set(auth());
    expect(recovered.status).toBe(200); expect(recovered.body.ack).toEqual(linked.body.ack);
  });
  it('company Sample router in development mode still refuses anonymous forged actor writes', async () => {
    const f = await fixture(); const app = appFor(f, false, undefined, true);
    const res = await request(app).post(`${path(f)}/exact`).send({ actorId: actor.userId });
    expect(res.status).toBe(401); expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
  it('protocol capability is present on the exact multi-segment endpoint, top-level and no guessed legacy fallback', async () => {
    const f = await fixture(); const app = appFor(f, true, undefined, process.env.SAMPLE_LINK_BASELINE_OLD === '1');
    const res = await request(app).get(`${path(f)}/context`).set(auth());
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ ok: true, linkVersion: 1, operation: 'link_received_card_to_sample', mode: 'v2-receipt-exact-origin', persistentReceipt: true, createsInventory: false, autoApproval: false, matchedComponentOnly: true, directSourcesOnly: true, eligible: true });
    expect(res.body.data).toBeUndefined(); expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
  it.each([true, false])('anonymous/body forged actor is 401 with requireAuth=%s, no writes', async required => {
    const f = await fixture(); const app = appFor(f, required); const input = await commandFor(f, app); const before = copy(f.state);
    const res = await request(app).post(`${path(f)}/exact`).send({ ...input, actor: { ...actor, roles: ['owner'] } }); expect(res.status).toBe(401); expect(f.state).toEqual(before); expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
    const read = await request(app).get(`${path(f)}/context`); expect(read.status).toBe(401);
  });
  it('actual versioned POST binds borrowed original Card then GET recovers after stored Room write withdrawal', async () => {
    const f = await fixture(); const notify = vi.fn(); const app = appFor(f, true, notify); const input = await commandFor(f, app);
    const first = await request(app).post(`${path(f)}/exact`).set(auth()).send(input); expect(first.status).toBe(200); expect(first.body).toMatchObject({ ok: true, state: 'committed', replayed: false, currentCard: { sampleId: 'SAMPLE', quantity: 3, availableQty: 2 } }); expect(first.body.data).toBeUndefined(); expect(notify).toHaveBeenCalledTimes(1);
    const replay = await request(app).post(`${path(f)}/exact`).set(auth()).send(input); expect(replay.status).toBe(200); expect(replay.body.ack).toEqual(first.body.ack); expect(notify).toHaveBeenCalledTimes(1);
    f.state.users[0].roles[0].role.permissions = [{ permission: { scope: 'products:read' } }]; const before = copy(f.state);
    const blocked = await request(app).post(`${path(f)}/exact`).set(auth()).send(input); expect(blocked.status).toBe(403);
    const recovered = await request(app).get(`${path(f)}/requests/${input.requestKey}`).set(auth({ permissions: ['products:read'], permissionCeiling: ['products:read'] })); expect(recovered.status).toBe(200); expect(recovered.body).toMatchObject({ ok: true, state: 'committed', ack: first.body.ack }); expect(f.state).toEqual(before);
  });
  it('an authorized read without Room grant discovers protocol but cannot write', async () => {
    const f = await fixture(); const app = appFor(f); const input = await commandFor(f, app); f.state.users[0].roles[0].role.permissions = [{ permission: { scope: 'products:read' } }];
    const c = await request(app).get(`${path(f)}/context`).set(auth({ permissions: ['products:read'], permissionCeiling: ['products:read'] })); expect(c.status).toBe(200); expect(c.body).toMatchObject({ eligible: false, reasons: ['ROOM_WRITE_REQUIRED'] });
    expect((await request(app).post(`${path(f)}/exact`).set(auth()).send(input)).status).toBe(403);
  });
  it.each([{ linkVersion: 2 }, { quantity: 99 }, { sourceSnapshot: {} }, { requestKey: true }, { expectedCardUpdatedAt: 1 }])('actual malformed POST %j cannot fall through ordinary Room writes', async patch => {
    const f = await fixture(); const app = appFor(f); const input = await commandFor(f, app); const before = copy(f.state);
    const res = await request(app).post(`${path(f)}/exact`).set(auth()).send({ ...input, ...patch }); expect(res.status).toBe(400); expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT' }); expect(f.state).toEqual(before);
  });
  it('signed products-only ceiling cannot be expanded by token roles or body privileges', async () => {
    const f = await fixture(); const app = appFor(f); const input = await commandFor(f, app); const before = copy(f.state);
    const res = await request(app).post(`${path(f)}/exact`).set(auth({ roles: ['owner'], permissionCeiling: ['products:read'] })).send(input); expect(res.status).toBe(403); expect(f.state).toEqual(before);
  });
  it('notification failure follows durable commit and replay never repeats notification or writes', async () => {
    const f = await fixture(); const notify = vi.fn(() => { throw Error('private notification fault'); }); const app = appFor(f, true, notify); const input = await commandFor(f, app);
    const first = await request(app).post(`${path(f)}/exact`).set(auth()).send(input); expect(first.status).toBe(200); const committed = copy(f.state);
    const recovered = await request(app).get(`${path(f)}/requests/${input.requestKey}`).set(auth()); expect(recovered.status).toBe(200); expect(recovered.body.ack).toEqual(first.body.ack);
    expect((await request(app).post(`${path(f)}/exact`).set(auth()).send(input)).body.replayed).toBe(true); expect(notify).toHaveBeenCalledTimes(1); expect(f.state).toEqual(committed);
  });
  it('audit SQL failure is safe 500 and fully rolls back actual producer, never confirmed success', async () => {
    const f = await fixture(); const app = appFor(f); const input = await commandFor(f, app); const original = f.tx.auditLog.create.getMockImplementation()!;
    f.tx.auditLog.create.mockImplementation(async (args: any) => { if (args.data.action === 'sample_card_sample_link_receipt') throw Error('private synthetic SQL diagnostic'); return original(args); }); const before = copy(f.state);
    const res = await request(app).post(`${path(f)}/exact`).set(auth()).send(input); expect(res.status).toBe(500); expect(JSON.stringify(res.body)).not.toContain('private synthetic'); expect(f.state).toEqual(before);
  });
  it('legacy receipt is explicitly blocked in context; candidate SQL failure is an error, not empty items', async () => {
    const f = await fixture(); const app = appFor(f); f.state.cards[0].receiptSnapshot = null;
    const context = await request(app).get(`${path(f)}/context`).set(auth()); expect(context.status).toBe(200); expect(context.body).toMatchObject({ eligible: false, expectedReceiptHash: null, reasons: ['RECEIPT_OR_CREATE_AUDIT_UNVERIFIED'] });
    f.tx.sampleCardItem.findUnique.mockRejectedValue(Error('private SQL')); const failed = await request(app).get(`${path(f)}/candidates`).set(auth()); expect(failed.status).toBe(500); expect(failed.body.items).toBeUndefined();
  });
});

// NEW reverse capability: real company router must expose the current target's qualified original Card.
describe('Target anchored original Card read capability', () => {
  it('reads the borrowed original fabric-source Card through the company reverse GET without inventory writes', async () => {
    const f = await fixture(); const app = appFor(f, true, undefined, true); const before = copy(f.state);
    const res = await request(app).get(`${root}/room/sample-links/SAMPLE/received-cards`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, linkVersion: 1, readerVersion: 1, queryMode: 'target-sample-exact-unlinked-v2', anchorSampleId: 'SAMPLE', targetEligibility: { eligible: true, reasons: [] }, hasMore: false, nextCursor: null });
    expect(res.body.data).toBeUndefined(); expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ card: { id: f.cardId, sampleId: null, cardType: 'fabric', quantity: 3, availableQty: 2 }, receiptStatus: 'verified', frozenSourceRound: 1, matchedComponentOnly: true });
    expect(res.body.items[0].activeLoans).toHaveLength(1); expect(f.state).toEqual(before); expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('Same Sample linked-review capability', () => {
  it('company anchored review reads lawful legacy terminal custody but excludes resolved same-owner objects', async () => {
    const f = await fixture(); const app = appFor(f, true, undefined, true);
    f.state.cards[0].sampleId = 'SAMPLE';
    f.state.cards.push({ id: 'LEGACY-REVIEW', code: 'SC-LEGACY', name: 'Historical object', cardType: 'fabric', status: 'retired', quantity: 1, availableQty: 1, unit: 'PC', sampleId: 'SAMPLE', devCaseId: 'UNKNOWN-LINE', receiptSnapshot: null, batchId: null, orderId: null, createdAt: 1n, updatedAt: 1n, deletedAt: null });
    f.state.cases.push({ id: 'UNKNOWN-LINE', type: 'draft', customerRelationId: 'CUSTOMER', deletedAt: null }); const before = copy(f.state);
    const res = await request(app).get(`${root}/room/sample-links/SAMPLE/linked-review`).set(auth());
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ readerVersion: 1, queryMode: 'same-sample-linked-review', anchorSampleId: 'SAMPLE', pagination: { limit: 20, cursor: null }, hasMore: false, nextCursor: null });
    expect(res.body.items).toHaveLength(1); expect(res.body.items[0]).toMatchObject({ card: { id: 'LEGACY-REVIEW', sampleId: 'SAMPLE', status: 'retired' }, receiptStatus: 'manual', businessContext: { status: 'conflict' }, linkEligibility: { eligible: false } });
    expect(res.body.items[0].expectedReceiptHash).toBeUndefined(); expect(f.state).toEqual(before);
  });
});
