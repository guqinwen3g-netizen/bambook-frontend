import { describe, expect, it, vi } from 'vitest';
import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';
import { createSample } from '../sampleManageService';
import { getSampleRegistrationContext } from '../sampleRegistrationContextService';
import { registerSampleCommand, recoverSampleRegistration } from '../sampleRegistrationCommandService';
import express from 'express';
import request from 'supertest';
import { createSampleRouter } from '../sampleRoute';
import { authHeader } from '../../__tests__/authTestHelper';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';

const actor: any = { userId: 'ACTOR', roles: ['owner'], permissions: ['products:read', 'products:write'], permissionCeiling: ['products:read', 'products:write'] };
const copyStorage = (value: any): any => Prisma.Decimal.isDecimal(value) ? new Prisma.Decimal(value) : value instanceof Date ? new Date(value)
  : Array.isArray(value) ? value.map(copyStorage) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyStorage(item)])) : value;
function fixture() {
  const state: any = { cases: [{ id: 'C-F', type: 'fabric', customerRelationId: 'CUSTOMER', specComposition: 'cotton', updatedAt: 20n, deletedAt: null }],
    batches: [{ id: 'B-A', batchCode: 'A', developmentCaseId: 'C-F', supplierRelationId: 'FACTORY', sampleType: 'yardage', round: 1,
      specNote: 'v1', status: 'pending', attachments: {}, updatedAt: 10n, deletedAt: null }], seals: [], links: [], samples: [], sources: [], audits: [], seq: 0 };
  const path = (obj: any, keys: string[]) => keys.reduce((v, key) => v?.[key], obj);
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) =>
    key === 'OR' ? value.some((w: any) => matches(row, w)) : value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key])
      : value && typeof value === 'object' && 'path' in value ? path(row[key], value.path) === value.equals : row[key] === value);
  const delegate = (name: string) => ({
    findMany: vi.fn(async ({ where }: any = {}) => state[name].filter((row: any) => matches(row, where))),
    findFirst: vi.fn(async ({ where }: any) => state[name].find((row: any) => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => state[name].find((row: any) => matches(row, where)) ?? null),
    create: vi.fn(async ({ data }: any) => { const row = { deletedAt: null, ...data }; if (name === 'audits') row.createdAt = new Date(); state[name].push(row); return row; }),
  });
  const tx: any = { ...fabricAuthorizationFixture('ACTOR'), $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    developmentCase: delegate('cases'), sampleBatch: delegate('batches'), sealSample: delegate('seals'), sealSampleBatch: delegate('links'),
    developmentLifecycleEvent: { findFirst: vi.fn(async () => null) }, order: { findMany: vi.fn(async () => []) }, productAsset: { findMany: vi.fn(async () => []) },
    sample: delegate('samples'), sampleSource: delegate('sources'), auditLog: delegate('audits'),
    businessSequence: { upsert: vi.fn(async () => ({ seq: state.seq })), update: vi.fn(async () => ({ seq: ++state.seq })) },
    teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => { const before = copyStorage(state); try { return await fn(tx); } catch (e) { Object.assign(state, before); throw e; } }) };
  return { state, tx, prisma };
}
async function openedCommand(f: ReturnType<typeof fixture>, key = 'exact-source-first', type = 'dev') {
  const opened = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: f.state.cases[0].id });
  if (!opened.ok) throw Error(opened.error.code);
  return { registrationVersion: 2, requestKey: key, type, subType: 'development', sourceCaseId: f.state.cases[0].id,
    expectedCaseUpdatedAt: opened.data.development.updatedAt, expectedCaseContentFingerprint: opened.data.development.contentFingerprint, origin: opened.data.batches[0].command };
}
async function sealedCommand(f: ReturnType<typeof fixture>) {
  f.state.batches[0].status = 'approved'; f.state.batches[0].approvedAt = 1n; f.state.batches[0].approvedBy = actor.userId;
  f.state.batches.push({ ...f.state.batches[0], id: 'B-B', batchCode: 'B' });
  f.state.seals.push({ id: 'SEAL', developmentCaseId: 'C-F', supplierRelationId: 'FACTORY', status: 'sealed', updatedAt: 30n, deletedAt: null });
  f.state.links = ['B-A', 'B-B'].map(sampleBatchId => ({ sealSampleId: 'SEAL', sampleBatchId }));
  const opened = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); if (!opened.ok) throw Error(opened.error.code);
  return { registrationVersion: 2, requestKey: 'full-seal-request', type: 'seal', sourceCaseId: 'C-F',
    expectedCaseUpdatedAt: opened.data.development.updatedAt, expectedCaseContentFingerprint: opened.data.development.contentFingerprint, sealOrigin: opened.data.seals[0].command };
}
describe('Exact ordinary Sample registration command', () => {
  it('legacy producer rejects exact registration protocol instead of silently creating an unknown-source draft', async () => {
    const f = fixture();
    const result = await createSample({ prisma: f.prisma, actorId: actor.userId, trustedActor: actor,
      input: { type: 'dev', registrationVersion: 2, requestKey: 'opened-case-command' } as any });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', status: 400 } });
    expect(f.state.samples).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('registers an unapproved exact source as one ordinary draft with durable creation and binding proof; a retry reads the same receipt', async () => {
    const f = fixture(); const opened = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' });
    expect(opened.ok).toBe(true); if (!opened.ok) throw Error('context unavailable');
    const input = { registrationVersion: 2, requestKey: 'exact-source-first', type: 'dev', subType: 'development', sourceCaseId: 'C-F',
      expectedCaseUpdatedAt: opened.data.development.updatedAt, expectedCaseContentFingerprint: opened.data.development.contentFingerprint, origin: opened.data.batches[0].command };
    const first = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(first.ok).toBe(true); if (!first.ok) throw Error(first.error.code);
    expect(first.data.sample).toMatchObject({ type: 'dev', status: 'draft', projectionKey: null, sourceCaseId: 'C-F', supplierRelationId: 'FACTORY' });
    expect(first.data.acknowledgement.sourceBindings[0]).toMatchObject({ sampleBatchId: 'B-A', sourceRound: 1, sourceSealId: null });
    expect(f.state.samples).toHaveLength(1); expect(f.state.sources).toHaveLength(1); expect(f.state.audits).toHaveLength(3);
    const snapshot = structuredClone(f.state);
    const retry = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(retry.ok && retry.data.replayed).toBe(true);
    expect(retry.ok && retry.data.acknowledgement).toEqual(first.data.acknowledgement); expect(f.state).toEqual(snapshot);
    expect(f.state.batches[0].status).toBe('pending');
  });
  it('same source under distinct request keys permits distinct ordinary purposes without reserving a canonical PP output', async () => {
    const f = fixture(); const first = await openedCommand(f, 'first-fit-purpose', 'pp');
    const a = await registerSampleCommand({ prisma: f.prisma, actor, input: first });
    const b = await registerSampleCommand({ prisma: f.prisma, actor, input: { ...first, requestKey: 'second-color-purpose', subType: 'color-check' } });
    expect(a.ok && b.ok).toBe(true); expect(f.state.samples).toHaveLength(2); expect(f.state.sources).toHaveLength(2);
    expect(f.state.samples.every((sample: any) => sample.projectionKey === null && sample.status === 'draft')).toBe(true);
    expect(f.state.samples[0].id).not.toBe(f.state.samples[1].id);
  });
  it.each(['timestamp', 'specification', 'customer', 'business-line'])('refuses opened Case %s changes even when the batch timestamp is unchanged', async kind => {
    const f = fixture(); const input = await openedCommand(f);
    if (kind === 'timestamp') f.state.cases[0].updatedAt = 21n;
    if (kind === 'specification') f.state.cases[0].specComposition = 'polyester';
    if (kind === 'customer') f.state.cases[0].customerRelationId = 'OTHER-CUSTOMER';
    if (kind === 'business-line') f.state.cases[0].type = 'garment';
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 } });
    expect(f.state.batches[0].updatedAt).toBe(10n); expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0); expect(f.state.seq).toBe(0);
  });
  it.each(['factory', 'round', 'version', 'content', 'history'])('refuses %s changes in the opened exact batch with zero business writes', async kind => {
    const f = fixture(); const input = await openedCommand(f);
    if (kind === 'factory') f.state.batches[0].supplierRelationId = 'OTHER-FACTORY';
    if (kind === 'round') f.state.batches[0].round = 2;
    if (kind === 'version') f.state.batches[0].updatedAt = 11n;
    if (kind === 'content') f.state.batches[0].specNote = 'v2';
    if (kind === 'history') f.state.batches[0].attachments = { fabricHistory: { schemaVersion: 99, events: [] } };
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.status).toBe(409);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0); expect(f.state.seq).toBe(0);
  });
  it('garment current round retains garment business source and explicit null fabric history without approving or material guessing', async () => {
    const f = fixture(); f.state.cases[0].type = 'garment'; f.state.cases[0].styleSpec = 'fit v1';
    f.state.batches[0].sampleType = 'garment-round'; f.state.batches[0].attachments = { version: 'fit-01', purpose: 'fit', materialConfig: { referenceFabric: 'cotton' } };
    const input = await openedCommand(f, 'garment-fit-request'); expect(input.origin).toMatchObject({ expectedHistoryRevision: null, expectedEventId: null });
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.sample.businessContext).toMatchObject({ status: 'resolved', businessLine: 'garment' });
    expect(result.data.sample.status).toBe('draft'); expect(f.state.batches[0].status).toBe('pending');
  });
  it('original receipt survives subsequent approval, notes, new rounds and closed Case without resetting mutable Sample state', async () => {
    const f = fixture(); const input = await openedCommand(f); const first = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(first.ok).toBe(true); if (!first.ok) return;
    f.state.samples[0].status = 'approved'; f.state.samples[0].notes = 'later verified'; f.state.samples[0].deletedAt = 90n;
    f.state.cases[0].updatedAt = 200n; f.state.cases[0].specComposition = 'changed'; f.state.batches[0].round = 2; f.state.batches[0].updatedAt = 300n;
    f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue({ state: 'closed', revision: 1, outcome: 'completed' });
    const before = structuredClone(f.state);
    const replay = await registerSampleCommand({ prisma: f.prisma, actor, input }); const recovered = await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: input.requestKey });
    expect(replay.ok && replay.data.acknowledgement).toEqual(first.data.acknowledgement); expect(recovered.ok && recovered.data.state).toBe('committed');
    if (replay.ok) expect(replay.data.currentSample).toMatchObject({ status: 'approved', notes: 'later verified', deletedAt: '90' });
    expect(f.state).toEqual(before);
  });
  it.each(['purpose', 'type', 'case-token'])('same request key with changed %s conflicts and preserves the original creation', async kind => {
    const f = fixture(); const input = await openedCommand(f); expect((await registerSampleCommand({ prisma: f.prisma, actor, input })).ok).toBe(true);
    const changed: any = { ...input }; if (kind === 'purpose') changed.subType = 'another'; if (kind === 'type') changed.type = 'pp'; if (kind === 'case-token') changed.expectedCaseUpdatedAt = '21';
    const before = structuredClone(f.state); const result = await registerSampleCommand({ prisma: f.prisma, actor, input: changed });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } }); expect(f.state).toEqual(before);
  });
  it.each(['receipt', 'native-audit', 'binding-audit', 'binding-row', 'all-audits', 'source-only', 'extra-trace', 'receipt-hash', 'native-fact', 'missing-native-proof'])('missing or damaged %s never becomes a fresh registration', async kind => {
    const f = fixture(); const input = await openedCommand(f); const first = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(first.ok).toBe(true); if (!first.ok) return; const ack = first.data.acknowledgement;
    if (kind === 'receipt') f.state.audits = f.state.audits.filter((audit: any) => audit.id !== ack.receiptAuditId);
    if (kind === 'native-audit') f.state.audits = f.state.audits.filter((audit: any) => audit.id !== ack.auditProof.create.id);
    if (kind === 'binding-audit') f.state.audits = f.state.audits.filter((audit: any) => audit.action !== 'bind_sample_origins');
    if (kind === 'binding-row') f.state.sources[0].sourceFingerprint = 'corrupt';
    if (kind === 'all-audits') f.state.audits = [];
    if (kind === 'source-only') { f.state.audits = []; f.state.samples = []; }
    if (kind === 'extra-trace') f.state.audits.push({ id: 'EXTRA', transactionId: ack.receiptAuditId });
    if (kind === 'receipt-hash') f.state.audits.find((audit: any) => audit.id === ack.receiptAuditId).detail.after.ackHash = 'damaged';
    if (kind === 'native-fact') f.state.audits.find((audit: any) => audit.id === ack.auditProof.create.id).detail.after.registrationSampleFact.notes = 'tampered';
    if (kind === 'missing-native-proof') delete f.state.audits.find((audit: any) => audit.id === ack.receiptAuditId).detail.after.ack.auditProof.create;
    const before = structuredClone(f.state); const retry = await registerSampleCommand({ prisma: f.prisma, actor, input }); const recovery = await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: input.requestKey });
    expect(retry).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } }); expect(recovery).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } }); expect(f.state).toEqual(before);
  });
  it.each(['bind-audit', 'native-audit', 'receipt', 'source-row', 'actor-FK', 'numbering'])('a %s write failure rolls back Sample, bindings, audits and numbering', async step => {
    const f = fixture(); const input = await openedCommand(f); const create = f.tx.auditLog.create.getMockImplementation()!;
    f.tx.auditLog.create.mockImplementation(async (args: any) => {
      if (step === 'actor-FK') throw Object.assign(Error('injected actor FK fault'), { code: 'P2003' });
      if (args.data.action === ({ 'bind-audit': 'bind_sample_origins', 'native-audit': 'create_sample', receipt: 'sample_registration_receipt' } as any)[step]) throw Error('injected storage fault'); return create(args);
    });
    if (step === 'source-row') f.tx.sampleSource.create.mockRejectedValue(Error('injected source fault'));
    if (step === 'numbering') f.tx.businessSequence.update.mockRejectedValue(Error('injected numbering SQL fault'));
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.status).toBe(500);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0); expect(f.state.seq).toBe(0);
  });
  it('recovery without an observed receipt is explicitly not_confirmed and permits only the original request retry', async () => {
    const f = fixture(); const result = await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: 'unobserved-original' });
    expect(result).toMatchObject({ ok: true, data: { state: 'not_confirmed', retryOriginalRequest: true } }); expect(f.state.samples).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('paused development blocks new design work but preserves the existing production Draft contract', async () => {
    const f = fixture(); f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue({ state: 'paused', revision: 1 });
    const design = await openedCommand(f, 'paused-design-request'); const blocked = await registerSampleCommand({ prisma: f.prisma, actor, input: design });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_PAUSED', status: 409 } }); expect(f.state.samples).toHaveLength(0);
    const production = await registerSampleCommand({ prisma: f.prisma, actor, input: { ...design, type: 'pp', requestKey: 'existing-production-request' } });
    expect(production.ok).toBe(true); expect(f.state.samples[0].status).toBe('draft');
  });
  it('legacy HTTP create refuses origin even without V2 fields, while an ordinary unlinked progressive draft remains allowed', async () => {
    const f = fixture(); const app = express(); app.use(express.json()); app.use('/api/v1/samples', createSampleRouter({ prisma: f.prisma, requireAuth: false }));
    const refusal = await request(app).post('/api/v1/samples').set(authHeader()).send({ type: 'dev', origin: { batchId: 'B-A' } });
    expect(refusal.status).toBe(400); expect(f.state.samples).toHaveLength(0);
    const ordinary = await request(app).post('/api/v1/samples').set(authHeader()).send({ type: 'dev', notes: 'progressive draft' }); expect(ordinary.status).toBe(201); expect(f.state.samples).toHaveLength(1);
  });
  it('an exact composite source binds its complete same-factory set and keeps the ordinary Sample draft', async () => {
    const f = fixture(); const input = await sealedCommand(f); const first = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(first.ok).toBe(true); expect(f.state.sources).toHaveLength(2); expect(f.state.samples[0]).toMatchObject({ type: 'seal', status: 'draft', projectionKey: null });
    expect(f.state.sources.every((source: any) => source.sourceSealId === 'SEAL')).toBe(true);
    const before = structuredClone(f.state); expect((await registerSampleCommand({ prisma: f.prisma, actor, input })).ok).toBe(true); expect(f.state).toEqual(before);
  });
  it.each(['omit', 'add', 'round', 'factory', 'seal-version'])('full seal %s drift cannot create a partial or substituted ordinary Sample', async kind => {
    const f = fixture(); const input: any = await sealedCommand(f);
    if (kind === 'omit') input.sealOrigin.components = input.sealOrigin.components.slice(0, 1);
    if (kind === 'add') f.state.links.push({ sealSampleId: 'SEAL', sampleBatchId: 'LATER' });
    if (kind === 'round') f.state.batches[1].round = 2;
    if (kind === 'factory') f.state.batches[1].supplierRelationId = 'OTHER';
    if (kind === 'seal-version') f.state.seals[0].updatedAt = 31n;
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0); expect(f.state.seq).toBe(0);
  });
  it('a parent change while waiting for Batch lock is reread and refused before invoking the native producer', async () => {
    const f = fixture(); const input = await openedCommand(f); const lock = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "SampleBatch"')) f.state.batches[0].supplierRelationId = 'CHANGED-WHILE-WAITING'; return lock(query); });
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED' } });
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.tx.sampleSource.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'current-grant', 'signed-ceiling', 'anonymous', 'read-only'])('current %s denial causes no Sample/source/receipt writes', async kind => {
    const f = fixture(); const input = await openedCommand(f); let trusted: any = actor;
    const user = await f.tx.userAccount.findUnique({ where: { id: 'ACTOR' } });
    if (kind === 'inactive') { user.status = 'inactive'; f.tx.userAccount.findFirst.mockResolvedValue(null); }
    if (kind === 'current-grant') user.roles[0].role.permissions = [];
    if (kind === 'signed-ceiling') trusted = { ...actor, permissionCeiling: ['products:read'] };
    if (kind === 'anonymous') trusted = null;
    if (kind === 'read-only') user.roles[0].role.permissions = [{ permission: { scope: 'products:read' } }];
    const result = await registerSampleCommand({ prisma: f.prisma, actor: trusted, input }); expect(result.ok).toBe(false);
    if (!result.ok) expect([401, 403]).toContain(result.error.status);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('fresh L2 data-share revocation blocks new and prior command ACK access without falling back to role-name authority', async () => {
    const f = fixture(); const input = await openedCommand(f); expect((await registerSampleCommand({ prisma: f.prisma, actor, input })).ok).toBe(true);
    const user = await f.tx.userAccount.findUnique({ where: { id: 'ACTOR' } }); user.roles[0].role.id = 'custom-sales';
    f.tx.relation.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id, ownerId: 'OTHER', salesRepIds: [], deletedAt: null }));
    const before = structuredClone(f.state);
    expect(await registerSampleCommand({ prisma: f.prisma, actor, input })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', status: 404 } });
    expect(await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: input.requestKey })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', status: 404 } }); expect(f.state).toEqual(before);
  });
  it('read-only authorized recovery can confirm a committed result after the write grant is revoked', async () => {
    const f = fixture(); const input = await openedCommand(f); const first = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(first.ok).toBe(true);
    const user = await f.tx.userAccount.findUnique({ where: { id: 'ACTOR' } }); user.roles[0].role.permissions = [{ permission: { scope: 'products:read' } }];
    expect(await registerSampleCommand({ prisma: f.prisma, actor, input })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    const recovered = await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: input.requestKey }); expect(recovered.ok && recovered.data.state).toBe('committed'); expect(f.state.samples).toHaveLength(1);
  });
  it.each(['scope-read', 'case-read', 'source-read', 'audit-read'])('%s SQL failure fails closed without native producer or receipt writes', async kind => {
    const f = fixture(); const input = await openedCommand(f);
    if (kind === 'scope-read') f.tx.userAccount.findUnique.mockRejectedValue(Error('private SQL text secret'));
    if (kind === 'case-read') f.tx.developmentCase.findFirst.mockRejectedValue(Error('private SQL text secret'));
    if (kind === 'source-read') f.tx.sampleBatch.findMany.mockRejectedValue(Error('private SQL text secret'));
    if (kind === 'audit-read') f.tx.auditLog.findUnique.mockRejectedValue(Error('private SQL text secret'));
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.status).toBeGreaterThanOrEqual(500); expect(result.error.message).not.toContain('private SQL'); }
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.tx.sampleSource.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('same-key overlapping decisions serialize on the synthetic transaction lock and return one frozen acknowledgement', async () => {
    const f = fixture(); const input = await openedCommand(f); const native = f.prisma.$transaction.getMockImplementation()!;
    let tail: Promise<any> = Promise.resolve();
    f.prisma.$transaction.mockImplementation((fn: any) => { const result = tail.then(() => native(fn)); tail = result.catch(() => undefined); return result; });
    const [first, second] = await Promise.all([registerSampleCommand({ prisma: f.prisma, actor, input }), registerSampleCommand({ prisma: f.prisma, actor, input })]);
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    expect(first.data.acknowledgement).toEqual(second.data.acknowledgement); expect([first.data.replayed, second.data.replayed].sort()).toEqual([false, true]);
    expect(f.state.samples).toHaveLength(1); expect(f.state.sources).toHaveLength(1); expect(f.state.audits).toHaveLength(3);
    // This models serialized storage only. Root must qualify the actual PG row/advisory locks independently.
  });
  it('the actual HTTP context/exact/recovery contract returns V2 proof and notifies only first creation', async () => {
    const f = fixture(); const notify = vi.fn(); const app = express(); app.use(express.json()); app.use('/api/v1/samples', createSampleRouter({ prisma: f.prisma, requireAuth: true, onDataChange: notify }));
    const token = jwt.sign(actor, process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars'); const headers = authHeader(token);
    const opened = await request(app).get('/api/v1/samples/registration/context?caseId=C-F').set(headers); expect(opened.status).toBe(200); expect(opened.body.registrationVersion).toBe(2);
    const input = { registrationVersion: 2, requestKey: 'http-exact-register', type: 'dev', sourceCaseId: 'C-F', expectedCaseUpdatedAt: opened.body.development.updatedAt,
      expectedCaseContentFingerprint: opened.body.development.contentFingerprint, origin: opened.body.batches[0].command };
    const first = await request(app).post('/api/v1/samples/registration/exact').set(headers).send(input); expect(first.status).toBe(201); expect(first.body.acknowledgement.receiptAuditId).toMatch(/^sample-register:/);
    const retry = await request(app).post('/api/v1/samples/registration/exact').set(headers).send(input); expect(retry.status).toBe(200); expect(retry.body.acknowledgement).toEqual(first.body.acknowledgement);
    const recovered = await request(app).get('/api/v1/samples/registration/requests/http-exact-register').set(headers); expect(recovered.status).toBe(200); expect(recovered.body.state).toBe('committed'); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('HTTP API-key/anonymous context or exact registration never bypasses the user-session contract', async () => {
    const f = fixture(); const input = await openedCommand(f); const app = express(); app.use(express.json()); app.use('/api/v1/samples', createSampleRouter({ prisma: f.prisma, requireAuth: true, apiKeys: new Set(['synthetic-key']) }));
    for (const url of ['/api/v1/samples/registration/context?caseId=C-F', '/api/v1/samples/registration/requests/http-exact-register']) {
      expect((await request(app).get(url).set('x-api-key', 'synthetic-key')).status).toBe(401);
    }
    expect((await request(app).post('/api/v1/samples/registration/exact').set('x-api-key', 'synthetic-key').send(input)).status).toBe(401);
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([{ registrationVersion: 1 }, { requestKey: 'short' }, { sourceOrderId: 'UNVERIFIED-ORDER' }, { status: 'approved' }, { origin: { batchId: 'B-A' } }])('invalid or unsupported exact command %j refuses without calling a transaction', async override => {
    const f = fixture(); const input = await openedCommand(f); f.prisma.$transaction.mockClear();
    expect(await registerSampleCommand({ prisma: f.prisma, actor, input: { ...input, ...override } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', status: 400 } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.state.samples).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('context preserves explicit actual zero and exact Decimal planned quantities without creating physical stock or approval evidence', async () => {
    const f = fixture(); f.state.batches[0].actualQuantity = new Prisma.Decimal(0); f.state.batches[0].actualUnit = 'PC';
    f.state.batches[0].planQuantity = new Prisma.Decimal('2.1250'); f.state.batches[0].planUnit = 'meter';
    const result = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.batches[0].actual).toEqual({ quantity: '0', unit: 'PC' }); expect(result.data.batches[0].planned).toEqual({ quantity: '2.125', unit: 'meter' });
    expect(result.data.autoApproval).toBe(false); expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });

  it('locks source factory Relations after Case and before Seal/Batch or the request key', async () => {
    const f = fixture(); const input = await sealedCommand(f); f.tx.$queryRaw.mockClear();
    expect((await registerSampleCommand({ prisma: f.prisma, actor, input })).ok).toBe(true);
    const queries = f.tx.$queryRaw.mock.calls.map(([query]: any[]) => String(query.sql));
    const at = (table: string) => queries.findIndex((query: string) => query.includes('FROM "' + table + '"'));
    expect(at('DevelopmentCase')).toBeGreaterThanOrEqual(0); expect(at('Relation')).toBeGreaterThan(at('DevelopmentCase'));
    expect(at('SealSample')).toBeGreaterThan(at('Relation')); expect(at('SampleBatch')).toBeGreaterThan(at('SealSample'));
    expect(queries.findIndex((query: string) => query.includes('pg_advisory_xact_lock'))).toBeGreaterThan(at('SampleBatch'));
    const factoryQueries = f.tx.$queryRaw.mock.calls.filter(([query]: any[]) => query.sql.includes('FROM "Relation"'));
    expect(factoryQueries.map(([query]: any[]) => query.values)).toEqual([['FACTORY']]);
  });
  it('discovers and locks both mismatched seal and component factories in deterministic order before refusing the invalid source', async () => {
    const f = fixture(); const input: any = await sealedCommand(f);
    f.state.seals[0].supplierRelationId = 'A-SEAL-FACTORY'; input.sealOrigin.expectedFactoryId = 'A-SEAL-FACTORY'; f.tx.$queryRaw.mockClear();
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false);
    const queries = f.tx.$queryRaw.mock.calls.filter(([query]: any[]) => query.sql.includes('FROM "Relation"'));
    expect(queries.map(([query]: any[]) => query.values)).toEqual([['A-SEAL-FACTORY'], ['FACTORY']]);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('a factory deleted while waiting for its Relation lock refuses before any native creation', async () => {
    const f = fixture(); const input = await openedCommand(f); let deleted = false;
    const lock = f.tx.$queryRaw.getMockImplementation()!, read = f.tx.relation.findFirst.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "Relation"')) deleted = true; return lock(query); });
    f.tx.relation.findFirst.mockImplementation(async (args: any) => args.where.id === 'FACTORY' && deleted ? null : read(args));
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 } });
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.tx.sampleSource.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['batch', 'seal'])('rechecks %s factory survival at final commit and rolls back producer facts if the Relation disappears', async kind => {
    const f = fixture(); const input = kind === 'seal' ? await sealedCommand(f) : await openedCommand(f); let deleted = false;
    const create = f.tx.sample.create.getMockImplementation()!, read = f.tx.relation.findFirst.getMockImplementation()!;
    f.tx.sample.create.mockImplementation(async (args: any) => { const row = await create(args); deleted = true; return row; });
    f.tx.relation.findFirst.mockImplementation(async (args: any) => args.where.id === 'FACTORY' && deleted ? null : read(args));
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409 } });
    expect(f.tx.sample.create).toHaveBeenCalledTimes(1);
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0); expect(f.state.seq).toBe(0);
  });
  it('a factory lock SQL failure is not treated as a live source or permission to create', async () => {
    const f = fixture(); const input = await openedCommand(f); const lock = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "Relation"')) throw Error('private factory lock unavailable'); return lock(query); });
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error.status).toBeGreaterThanOrEqual(500); expect(result.error.message).not.toContain('private factory'); }
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.tx.sampleSource.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('factory liveness SQL failure after its lock is not normalized to a valid source', async () => {
    const f = fixture(); const input = await openedCommand(f); let locked = false;
    const lock = f.tx.$queryRaw.getMockImplementation()!, read = f.tx.relation.findFirst.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('FROM "Relation"')) locked = true; return lock(query); });
    f.tx.relation.findFirst.mockImplementation(async (args: any) => { if (args.where.id === 'FACTORY' && locked) throw Error('private factory read unavailable'); return read(args); });
    const result = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBeGreaterThanOrEqual(500);
    expect(f.tx.sample.create).not.toHaveBeenCalled(); expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('historical committed receipt still recovers without writing or acquiring factory locks after factory deletion', async () => {
    const f = fixture(); const input = await openedCommand(f); const first = await registerSampleCommand({ prisma: f.prisma, actor, input }); expect(first.ok).toBe(true);
    const read = f.tx.relation.findFirst.getMockImplementation()!; f.tx.relation.findFirst.mockImplementation(async (args: any) => args.where.id === 'FACTORY' ? null : read(args));
    f.tx.$queryRaw.mockClear(); const before = copyStorage(f.state);
    const result = await recoverSampleRegistration({ prisma: f.prisma, actor, requestKey: input.requestKey });
    expect(result.ok && result.data.state).toBe('committed'); if (first.ok && result.ok) expect(result.data.acknowledgement).toEqual(first.data.acknowledgement);
    expect(f.tx.$queryRaw.mock.calls.filter(([query]: any[]) => query.sql.includes('FROM "Relation"'))).toHaveLength(0); expect(f.state).toEqual(before);
  });
  it('garment Case with approved garment-round components never exposes a fabric seal command', async () => {
    const f = fixture(); await sealedCommand(f); f.state.cases[0].type = 'garment';
    for (const batch of f.state.batches) batch.sampleType = 'garment-round';
    const result = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.batches.every((batch: any) => batch.nativeFamily === 'garment-round' && batch.selectable)).toBe(true);
    expect(result.data.seals[0]).toMatchObject({ selectable: false, command: null }); expect(result.data.seals[0].reasons).toContain('SEAL_CASE_NOT_FABRIC');
    expect(f.state.samples).toHaveLength(0); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('a fabric seal with an invalid native component exposes neither an actionable command nor a selectable mixed-family candidate', async () => {
    const f = fixture(); await sealedCommand(f); f.state.batches[1].sampleType = 'garment-round';
    const result = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.seals[0]).toMatchObject({ selectable: false, command: null }); expect(result.data.seals[0].reasons).toContain('SEAL_NATIVE_FAMILY_MISMATCH');
  });
  it('a seal that is not ready exposes no command even when every component identity is complete', async () => {
    const f = fixture(); await sealedCommand(f); f.state.seals[0].status = 'draft';
    const result = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.seals[0]).toMatchObject({ selectable: false, command: null }); expect(result.data.seals[0].reasons).toContain('SEAL_NOT_READY');
  });
  it('ordinary unapproved batch identity remains selectable and registers a Draft without invoking approval requirements', async () => {
    const f = fixture(); const opened = await getSampleRegistrationContext({ prisma: f.prisma, actor, caseId: 'C-F' }); expect(opened.ok).toBe(true); if (!opened.ok) return;
    expect(opened.data.batches[0]).toMatchObject({ status: 'pending', selectable: true });
    const input = await openedCommand(f, 'factory-lock-draft'); const result = await registerSampleCommand({ prisma: f.prisma, actor, input });
    expect(result.ok && result.data.sample.status).toBe('draft'); expect(f.state.batches[0].status).toBe('pending');
  });
});
