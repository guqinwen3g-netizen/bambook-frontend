/** Stateful synthetic storage, real receipt/binding/link producers. Not PG/role-release evidence.
 * Ledger 08 §4.1/4.4: fabric cases return fabric batches; garment rounds create one Card per garment.
 * A collaborating team's name does not change the authoritative development business line.
 * This exercises the existing legacy intake seam, not native exact-version return/QC or PG locks.
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createSampleRoomService } from '../sampleRoomService';
import { bindSampleOrigins, snapshotSampleOrigin, sampleOriginFingerprint } from '../sampleOriginService';
import { getSampleCardSampleLinkContext, listSampleCardSampleLinkCandidates, linkReceivedCardToSample, recoverSampleCardSampleLink, listReceivedCardsForSample, listSampleLinkedReviewCards } from '../sampleCardSampleLinkService';
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
  const borrowed = await room.createLoan(f.state.cards[0].id, { requestKey: 'link-service-fixture-loan-01', loanType: 'borrow', borrowerName: 'Synthetic employee', loanQuantity: 1 }, actor);
  if (!borrowed.ok) throw Error(`real borrow fixture failed ${borrowed.error.code}`);
  const sample = { id: 'SAMPLE', code: 'SMP-SYNTHETIC', type: 'dev', status: 'draft', projectionKey: null, sourceCaseId: 'CASE', sourceOrderId: null, productAssetId: null,
    supplierRelationId: 'FACTORY', customerRelationId: 'CUSTOMER', length: kind === 'garment' ? null : new Prisma.Decimal('0.75'), notes: 'ordinary purpose', createdAt: 1n, updatedAt: 2n, deletedAt: null };
  f.state.samples.push(sample);
  await bindSampleOrigins(f.tx, sample, [snapshotSampleOrigin(f.state.batches[0], f.state.cases[0])], actor.userId, { provenance: 'recorded_exact' });
  f.tx.sampleCardItem.updateMany.mockClear(); f.tx.$queryRaw.mockClear();
  return { ...f, room, cardId: f.state.cards[0].id };
}
// END STORAGE FIXTURE
async function opened(f: Awaited<ReturnType<typeof fixture>>, requestKey = 'original-card-link') {
  const c = await getSampleCardSampleLinkContext({ prisma: f.prisma, actor, cardId: f.cardId });
  const candidates = await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: f.cardId });
  if (!c.ok || !candidates.ok || !candidates.data.items.length) throw Error(`open failed ${JSON.stringify([c, candidates])}`);
  return { linkVersion: 1, requestKey, targetSampleId: 'SAMPLE', matchedSampleSourceId: candidates.data.items[0].matchedSampleSourceId,
    expectedCardUpdatedAt: c.data.expectedCardUpdatedAt, expectedReceiptHash: c.data.expectedReceiptHash,
    expectedTargetIdentityHash: candidates.data.items[0].expectedTargetIdentityHash, expectedBindingSetHash: candidates.data.items[0].expectedBindingSetHash };
}
const link = (f: any, input: any, who = actor) => linkReceivedCardToSample({ prisma: f.prisma, actor: who, cardId: f.cardId, input });
const recover = (f: any, requestKey: string, who = actor) => recoverSampleCardSampleLink({ prisma: f.prisma, actor: who, cardId: f.cardId, requestKey });
function assertNoWrite(f: any, before: any) { expect(f.state).toEqual(before); expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled(); }

describe('Original Card → proven Sample, finite stateful controls', () => {
  it.each(['legacy', 'separate_clocks'])('preserves original %s receipt proof while linking an exact original card, and rejects a forged wall timestamp', async mode => {
    const f = await fixture(), card = f.state.cards[0];
    const receipt = { ...card.receiptSnapshot, receivedAt: mode === 'legacy' ? String(card.createdAt) : '1791418680000',
      ...(mode === 'legacy' ? {} : { recordedAt: String(card.createdAt) }) };
    if (mode === 'legacy') delete receipt.recordedAt;
    card.receiptSnapshot = copy(receipt);
    const audit = f.state.audits.find((row: any) => row.action === 'sample_card_create' && row.targetId === card.id);
    audit.detail.after.receiptSnapshot = copy(receipt);
    const input = await opened(f), beforeReceipt = copy(card.receiptSnapshot);
    expect(await link(f, input)).toMatchObject({ ok: true, data: { state: 'committed' } });
    expect(f.state.cards[0].receiptSnapshot).toEqual(beforeReceipt);
    if (mode === 'separate_clocks') {
      card.receiptSnapshot.recordedAt = String(BigInt(card.createdAt) + 1n);
      audit.detail.after.receiptSnapshot = copy(card.receiptSnapshot);
      expect(await getSampleCardSampleLinkContext({ prisma: f.prisma, actor, cardId: card.id })).toMatchObject({ ok: true,
        data: { eligible: false, expectedReceiptHash: null, reasons: expect.arrayContaining(['RECEIPT_OR_CREATE_AUDIT_UNVERIFIED']) } });
      expect(await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: card.id })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    }
  });
  it.each(['fabric', 'garment'])('real %s receipt→borrow1→ordinary source binding links only original Card.sampleId/version', async kind => {
    const f = await fixture(kind); const input = await opened(f); const before = copy(f.state); const first = await link(f, input);
    const quantity = kind === 'garment' ? 1 : 3;
    expect(first).toMatchObject({ ok: true, data: { state: 'committed', replayed: false, currentCard: { cardType: kind, quantity, availableQty: quantity - 1, unit: 'PC', sampleId: 'SAMPLE' } } });
    if (!first.ok) return;
    expect(f.state.cards).toHaveLength(kind === 'garment' ? 3 : 1); expect(f.state.cards.slice(1)).toEqual(before.cards.slice(1));
    if (kind === 'garment') {
      expect(new Set(f.state.cards.map((card: any) => card.id)).size).toBe(3);
      expect(new Set(f.state.cards.map((card: any) => card.code)).size).toBe(3);
      for (const card of f.state.cards.slice(1)) expect(card).toMatchObject({ cardType: 'garment', quantity: 1, availableQty: 1, sampleId: null });
    }
    expect(f.state.samples).toEqual(before.samples); expect(f.state.loans).toEqual(before.loans); expect(f.state.batches).toEqual(before.batches); expect(f.state.sources).toEqual(before.sources);
    const { sampleId, updatedAt, ...preserved } = f.state.cards[0]; const { sampleId: oldSample, updatedAt: oldVersion, ...oldFields } = before.cards[0]; expect(preserved).toEqual(oldFields); expect(BigInt(updatedAt) > BigInt(oldVersion)).toBe(true);
    expect(f.tx.sampleCardItem.updateMany.mock.calls[0][0].data).toEqual({ sampleId: 'SAMPLE', updatedAt }); expect(f.state.audits.slice(before.audits.length).map((a: any) => a.action)).toEqual(['link_sample_card_to_sample', 'sample_card_sample_link_receipt']);
    const committed = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: true, data: { replayed: true, ack: first.data.ack } }); expect(await recover(f, input.requestKey)).toMatchObject({ ok: true, data: { state: 'committed', ack: first.data.ack } }); expect(f.state).toEqual(committed);
    const returned = await f.room.returnLoan(f.state.loans[0].id, 'same original loan', actor); expect(returned).toMatchObject({ ok: true, data: { item: { availableQty: quantity, sampleId: 'SAMPLE' } } });
    expect(f.state.cards.slice(1)).toEqual(before.cards.slice(1));
    expect(await f.room.returnLoan(f.state.loans[0].id, '', actor)).toMatchObject({ ok: false, error: { status: 409 } });
    const afterReturn = copy(f.state); expect(await recover(f, input.requestKey)).toMatchObject({ ok: true, data: { ack: first.data.ack, currentCard: { availableQty: quantity } } }); expect(f.state).toEqual(afterReturn);
  });
  it('frozen R1→R1 survives current R2, changed specifications/approval, paused/closed lifecycle and edited Sample purpose', async () => {
    const f = await fixture(); const input = await opened(f); f.state.batches[0].round = 2; f.state.batches[0].updatedAt = 99n; f.state.batches[0].status = 'approved'; f.state.batches[0].attachments = { version: 'v2' };
    f.state.cases[0].styleSpec = 'later changed'; f.state.samples[0].status = 'approved'; f.state.samples[0].round = 6; f.state.samples[0].notes = 'changed purpose'; f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue({ state: 'closed' });
    expect(await link(f, input)).toMatchObject({ ok: true, data: { state: 'committed' } });
  });
  it('receipt vs binding permits differing immutable version metadata with equal frozen content', async () => {
    const f = await fixture(); const r = f.state.sources[0]; r.sourceSnapshot.version.updatedAt = '999'; r.sourceUpdatedAt = 999n; r.sourceSnapshot.version.eventId = 'QC-LATER'; r.sourceEventId = 'QC-LATER';
    f.state.audits.find((a: any) => a.action === 'bind_sample_origins').detail.after.origins[0].sourceSnapshot = copy(r.sourceSnapshot);
    expect(await link(f, await opened(f))).toMatchObject({ ok: true });
  });
  it.each(['V1', 'null', 'create-missing', 'create-duplicate', 'create-actor', 'create-unit', 'create-quantity', 'create-receipt', 'card-createdAt', 'card-material', 'card-parent'])('blocks %s original receipt/proof, no writes', async kind => {
    const f = await fixture(); const input = await opened(f); const a = f.state.audits.find((a: any) => a.action === 'sample_card_create');
    if (kind === 'V1') f.state.cards[0].receiptSnapshot.version = 1; if (kind === 'null') f.state.cards[0].receiptSnapshot = null;
    if (kind === 'create-missing') f.state.audits = f.state.audits.filter((x: any) => x !== a); if (kind === 'create-duplicate') f.state.audits.push({ ...copy(a), id: 'DUPLICATE' });
    if (kind === 'create-actor') a.actorId = 'OTHER'; if (kind === 'create-unit') a.detail.after.unit = 'M'; if (kind === 'create-quantity') a.detail.after.availableQty = 2;
    if (kind === 'create-receipt') a.detail.after.receiptSnapshot.sourceRound = 2; if (kind === 'card-createdAt') f.state.cards[0].createdAt += 1n;
    if (kind === 'card-material') f.state.cards[0].cardType = 'garment'; if (kind === 'card-parent') f.state.cards[0].batchId = 'OTHER';
    const before = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 409 } }); assertNoWrite(f, before);
  });
  it.each(['inherited', 'no-bindings', 'bad-version', 'bad-fingerprint', 'missing-audit', 'duplicate-audit', 'extra-fact', 'missing-fact', 'wrong-actor', 'wrong-projection', 'factory', 'case'])('rejects full target proof %s, not one good origin chosen', async kind => {
    const f = await fixture(); const input = await opened(f); const r = f.state.sources[0]; const a = f.state.audits.find((a: any) => a.action === 'bind_sample_origins');
    if (kind === 'inherited') r.provenance = 'inherited'; if (kind === 'no-bindings') f.state.sources = []; if (kind === 'bad-version') r.sourceUpdatedAt += 1n; if (kind === 'bad-fingerprint') r.sourceFingerprint = '0'.repeat(64);
    if (kind === 'missing-audit') f.state.audits = f.state.audits.filter((x: any) => x !== a); if (kind === 'duplicate-audit') f.state.audits.push({ ...copy(a), id: 'EXTRA' });
    if (kind === 'extra-fact') a.detail.after.origins.push(copy(a.detail.after.origins[0])); if (kind === 'missing-fact') a.detail.after.origins = [];
    if (kind === 'wrong-actor') r.boundBy = 'OTHER'; if (kind === 'wrong-projection') f.state.samples[0].projectionKey = 'v1:garment_pp:WRONG:1';
    if (kind === 'factory') f.state.samples[0].supplierRelationId = 'OTHER'; if (kind === 'case') f.state.samples[0].sourceCaseId = 'OTHER';
    const before = copy(f.state); const result = await link(f, input); expect(result.ok).toBe(false); assertNoWrite(f, before);
  });
  it.each(['CAS', 'terminal-shipped', 'terminal-retired', 'deleted', 'already-same', 'already-other', 'factory-deleted', 'warehouse-inactive', 'order-other-line', 'subject-asset-conflict'])('first-link %s refuses without inventory/loan writes', async kind => {
    const f = await fixture(); const input = await opened(f);
    if (kind === 'CAS') f.state.cards[0].updatedAt = BigInt(f.state.cards[0].updatedAt) + 1n;
    if (kind.startsWith('terminal')) f.state.cards[0].status = kind.endsWith('shipped') ? 'shipped' : 'retired'; if (kind === 'deleted') f.state.cards[0].deletedAt = 999n;
    if (kind === 'already-same') f.state.cards[0].sampleId = 'SAMPLE'; if (kind === 'already-other') f.state.cards[0].sampleId = 'OTHER'; if (kind === 'factory-deleted') f.state.relations.find((r: any) => r.id === 'FACTORY').deletedAt = 3n;
    if (kind === 'warehouse-inactive') { f.state.cards[0].warehouseId = 'W'; f.state.warehouses.push({ id: 'W', isActive: false, deletedAt: null }); }
    if (kind === 'order-other-line') { f.state.cards[0].orderId = 'ORDER'; f.state.orders.push({ id: 'ORDER', sourceCaseId: 'CASE', type: 'garment', businessLine: 'garment', deletedAt: null }); }
    if (kind === 'subject-asset-conflict') { f.state.samples[0].productAssetId = 'A'; f.state.assets.push({ id: 'A', mainCategory: 'garment', garmentProfile: { id: 'GP' }, deletedAt: null }); }
    const before = copy(f.state); const r = await link(f, input); expect(r.ok).toBe(false); assertNoWrite(f, before);
  });
  it('changed current quantities and a fabric descriptor retain the exact fabric source owner and borrowed eligibility', async () => {
    const f = await fixture(); f.state.cards[0].quantity = 5; f.state.cards[0].availableQty = 1; f.state.cards[0].status = 'borrowed'; f.state.cards[0].productAssetId = 'FABRIC-MATERIAL';
    f.state.assets.push({ id: 'FABRIC-MATERIAL', mainCategory: 'fabric', fabricProfile: { id: 'FP' }, deletedAt: null }); expect(await link(f, await opened(f))).toMatchObject({ ok: true, data: { currentCard: { quantity: 5, availableQty: 1, status: 'borrowed' } } });
  });
  it.each(['room-revoked', 'products-revoked', 'ceiling', 'target-customer', 'case-customer', 'inactive', 'final-revoke'])('current authority %s denies and rolls back, token role does not restore it', async kind => {
    const f = await fixture(); const input = await opened(f); let who = actor;
    const revoke = (scope: string) => f.state.users[0].roles[0].role.permissions = f.state.users[0].roles[0].role.permissions.filter((p: any) => p.permission.scope !== scope);
    if (kind === 'room-revoked') revoke('sample:room:write'); if (kind === 'products-revoked') revoke('products:read'); if (kind === 'ceiling') who = { ...actor, permissionCeiling: ['products:read'] };
    if (kind === 'target-customer') { f.state.samples[0].customerRelationId = 'HIDDEN'; f.state.relations.push({ id: 'HIDDEN', ownerId: 'OTHER', salesRepIds: [], deletedAt: null }); }
    if (kind === 'case-customer') f.state.relations.find((r: any) => r.id === 'CUSTOMER').ownerId = 'OTHER'; if (kind === 'inactive') f.state.users[0].status = 'inactive';
    if (kind === 'final-revoke') { const original = f.tx.auditLog.create.getMockImplementation()!; f.tx.auditLog.create.mockImplementation(async (args: any) => { const r = await original(args); if (args.data.action === 'link_sample_card_to_sample') revoke('sample:room:write'); return r; }); }
    const before = copy(f.state); expect((await link(f, input, who)).ok).toBe(false); expect(f.state).toEqual(before);
  });
  it('Room write revoked after commit still permits authorized recovery GET; POST replay denied', async () => {
    const f = await fixture(); const input = await opened(f); const first = await link(f, input); expect(first.ok).toBe(true);
    f.state.users[0].roles[0].role.permissions = [{ permission: { scope: 'products:read' } }]; f.state.cards[0].status = 'shipped'; f.state.cards[0].quantity = 0; f.state.cards[0].availableQty = 0; f.state.cards[0].deletedAt = 30n;
    f.state.relations.find((r: any) => r.id === 'FACTORY').deletedAt = 1n; const before = copy(f.state);
    expect(await recover(f, input.requestKey)).toMatchObject({ ok: true, data: { state: 'committed', currentCard: { status: 'shipped' } } }); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 403 } }); expect(f.state).toEqual(before);
    f.state.relations.find((r: any) => r.id === 'CUSTOMER').ownerId = 'OTHER'; expect(await recover(f, input.requestKey)).toMatchObject({ ok: false, error: { status: 404 } });
  });
  it.each(['native-link', 'receipt', 'actor-FK'])('mandatory %s audit failure rolls back Card and both new audits', async fault => {
    const f = await fixture(); const input = await opened(f); const original = f.tx.auditLog.create.getMockImplementation()!;
    f.tx.auditLog.create.mockImplementation(async (args: any) => { if (fault === 'actor-FK' || args.data.action === (fault === 'native-link' ? 'link_sample_card_to_sample' : 'sample_card_sample_link_receipt')) throw Object.assign(Error('private synthetic fault'), { code: 'P2003' }); return original(args); });
    const before = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 500 } }); expect(f.state).toEqual(before);
  });
  it.each(['receipt', 'link', 'extra-trace', 'ack-hash', 'binding-proof', 'create-proof', 'card-unlinked'])('damaged committed %s never becomes a second write or not_confirmed', async damage => {
    const f = await fixture(); const input = await opened(f); const first = await link(f, input); if (!first.ok) throw Error(first.error.code); const ack = first.data.ack;
    if (damage === 'receipt') f.state.audits = f.state.audits.filter((a: any) => a.id !== ack.receiptAuditId); if (damage === 'link') f.state.audits = f.state.audits.filter((a: any) => a.id !== ack.auditProof.link.id);
    if (damage === 'extra-trace') f.state.audits.push({ id: 'EXTRA', transactionId: ack.receiptAuditId }); if (damage === 'ack-hash') f.state.audits.find((a: any) => a.id === ack.receiptAuditId).detail.after.ackHash = 'broken';
    if (damage === 'binding-proof') f.state.sources[0].sourceFingerprint = '0'.repeat(64); if (damage === 'create-proof') f.state.audits.find((a: any) => a.action === 'sample_card_create').detail.after.quantity = 999;
    if (damage === 'card-unlinked') f.state.cards[0].sampleId = null;
    const before = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 409 } }); expect(await recover(f, input.requestKey)).toMatchObject({ ok: false, error: { status: 409 } }); expect(f.state).toEqual(before);
  });
  it('same request key changing body or routed Card conflicts; two simultaneous identical commands commit once', async () => {
    const f = await fixture(); const input = await opened(f); const [a, b] = await Promise.all([link(f, input), link(f, input)]); expect(a.ok && b.ok).toBe(true); expect(f.state.audits.filter((a: any) => a.action === 'sample_card_sample_link_receipt')).toHaveLength(1);
    const before = copy(f.state); expect(await link(f, { ...input, expectedCardUpdatedAt: '999' })).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await linkReceivedCardToSample({ prisma: f.prisma, actor, cardId: 'OTHER-CARD', input })).toMatchObject({ ok: false, error: { status: 409 } }); expect(f.state).toEqual(before);
  });
  it('missing original receipt with unlinked proven Card is explicitly not_confirmed, no attempt inferred', async () => {
    const f = await fixture(); const before = copy(f.state); expect(await recover(f, 'unobserved-original')).toMatchObject({ ok: true, data: { state: 'not_confirmed', retryOriginalRequest: true } }); expect(f.state).toEqual(before);
  });
  it('full parent union locks in fixed order; changed parent at Card lock is refused without chasing new parents', async () => {
    const f = await fixture(); const input = await opened(f); const original = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query: any) => { if (query.sql.includes('SampleCardItem')) f.state.cards[0].warehouseId = 'NEW-W'; return original(query); });
    const before = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 409 } }); expect(f.state).toEqual(before);
    const tables = f.tx.$queryRaw.mock.calls.map(([q]: any) => q.sql); expect(tables[0]).toContain('DevelopmentCase'); expect(tables[1]).toContain('Relation'); expect(tables[2]).toContain('Relation'); expect(tables[3]).toContain('SampleBatch'); expect(tables[4]).toContain('"Sample"'); expect(tables[5]).toContain('SampleCardItem');
    expect(f.tx.$queryRaw.mock.calls.slice(1,3).map(([q]:any)=>q.values[0])).toEqual(['CUSTOMER','FACTORY']); expect(tables.some((s: string) => s.includes('Warehouse'))).toBe(false);
  });
  it('full seal keeps all components while linking just one; removed member blocks the command', async () => {
    const f = await fixture('fabric'); f.state.sources = []; f.state.audits = f.state.audits.filter((a: any) => a.action !== 'bind_sample_origins');
    f.state.batches.push({ ...copy(f.state.batches[0]), id: 'SECOND', batchCode: 'SECOND' }); f.state.seals.push({ id: 'SEAL', developmentCaseId: 'CASE', supplierRelationId: 'FACTORY', status: 'sealed', deletedAt: null });
    f.state.links = ['BATCH', 'SECOND'].map(sampleBatchId => ({ sealSampleId: 'SEAL', sampleBatchId }));
    await bindSampleOrigins(f.tx, f.state.samples[0], f.state.batches.map((b: any) => snapshotSampleOrigin(b, f.state.cases[0])), actor.userId, { sourceSealId: 'SEAL', provenance: 'recorded_exact' });
    const input = await opened(f); const first = await link(f, input); expect(first).toMatchObject({ ok: true, data: { ack: { matchedComponentOnly: true } } }); expect(f.state.sources).toHaveLength(2);
    f.state.links.pop(); expect(await recover(f, input.requestKey)).toMatchObject({ ok: false, error: { status: 409 } });
  });
  it('authorized+verified pagination reaches visible candidate beyond first 50; storage fault is 500, never empty', async () => {
    const f = await fixture(); const originals = copy({ sample: f.state.samples[0], source: f.state.sources[0], audit: f.state.audits.find((a: any) => a.action === 'bind_sample_origins') });
    f.state.samples = []; f.state.sources = []; f.state.audits = f.state.audits.filter((a: any) => a.action !== 'bind_sample_origins');
    for (let i = 0; i < 62; i++) {
      const id = `SAMPLE-${String(i).padStart(3, '0')}`; const auditId = `BIND-${i}`; f.state.samples.push({ ...copy(originals.sample), id, customerRelationId: i < 60 ? 'HIDDEN' : 'CUSTOMER' });
      f.state.sources.push({ ...copy(originals.source), id: `SOURCE-${i}`, sampleId: id, evidenceAuditId: auditId }); const a = copy(originals.audit); a.id = auditId; a.targetId = id; a.detail.after.sampleId = id; f.state.audits.push(a);
    }
    f.state.relations.push({ id: 'HIDDEN', ownerId: 'OTHER', salesRepIds: [], deletedAt: null });
    const page = await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: f.cardId, limit: 1 }); expect(page).toMatchObject({ ok: true, data: { hasMore: true, items: [{ sample: { id: 'SAMPLE-060' } }], nextCursor: 'SAMPLE-060' } });
    const next = await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: f.cardId, limit: 1, cursor: 'SAMPLE-060' }); expect(next).toMatchObject({ ok: true, data: { hasMore: false, items: [{ sample: { id: 'SAMPLE-061' } }] } });
    f.tx.auditLog.findMany.mockRejectedValue(Error('private SQL diagnostic')); const failed = await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: f.cardId }); expect(failed).toMatchObject({ ok: false, error: { status: 500 } }); expect(JSON.stringify(failed)).not.toContain('private SQL');
  });
  it.each(['boundAt', 'sealId', 'operation', 'source', 'version-event', 'case-class-drift'])('strict immutable metadata / lock identity %s cannot be skipped', async kind => {
    const f = await fixture(); const input = await opened(f);
    if (kind === 'boundAt') f.state.sources[0].boundAt = null;
    if (kind === 'sealId') f.state.sources[0].sourceSealId = 42;
    if (kind === 'operation') f.state.audits.find((a: any) => a.action === 'bind_sample_origins').operationType = 'update';
    if (kind === 'source') f.state.audits.find((a: any) => a.action === 'bind_sample_origins').detail.source = 'untrusted';
    if (kind === 'version-event') f.state.sources[0].sourceSnapshot.version.eventId = false;
    if (kind === 'case-class-drift') { const original = f.tx.$queryRaw.getMockImplementation()!; f.tx.$queryRaw.mockImplementation(async (q: any) => { if (q.sql.includes('SampleCardItem')) f.state.cases[0].type = 'garment'; return original(q); }); }
    const before = copy(f.state); expect((await link(f, input)).ok).toBe(false); assertNoWrite(f, before);
  });
  it('a valid differently frozen R2/content binding is not a candidate for the original R1 receipt', async () => {
    const f = await fixture(); const input = await opened(f); const row = f.state.sources[0]; row.sourceRound = 2; row.sourceSnapshot.batch.sourceRound = 2;
    row.sourceSnapshot.content.version = 'genuinely different'; row.sourceFingerprint = sampleOriginFingerprint(row.sourceSnapshot);
    const audit = f.state.audits.find((a: any) => a.action === 'bind_sample_origins'); audit.detail.after.origins[0].sourceRound = 2; audit.detail.after.origins[0].sourceSnapshot = copy(row.sourceSnapshot); audit.detail.after.origins[0].sourceFingerprint = row.sourceFingerprint;
    const before = copy(f.state); expect(await link(f, input)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await listSampleCardSampleLinkCandidates({ prisma: f.prisma, actor, cardId: f.cardId })).toMatchObject({ ok: true, data: { items: [], hasMore: false } }); assertNoWrite(f, before);
  });
  it('ordinary noncanonical full multi-origin target remains eligible with no automatic PP projection', async () => {
    const f = await fixture('fabric'); f.state.sources = []; f.state.audits = f.state.audits.filter((a: any) => a.action !== 'bind_sample_origins');
    f.state.batches.push({ ...copy(f.state.batches[0]), id: 'SECOND', batchCode: 'SECOND' });
    await bindSampleOrigins(f.tx, f.state.samples[0], f.state.batches.map((b: any) => snapshotSampleOrigin(b, f.state.cases[0])), actor.userId, { provenance: 'recorded_exact' });
    const before = copy(f.state); expect(await link(f, await opened(f))).toMatchObject({ ok: true, data: { currentSample: { projectionKey: null }, ack: { matchedComponentOnly: true } } }); expect(f.state.sources).toEqual(before.sources); expect(f.state.samples).toEqual(before.samples);
  });
  it('native request lock never asks Prisma to deserialize PostgreSQL void; lock precedes writes', async () => {
    const f = await fixture(); const input = await opened(f); const original = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (q: any) => {
      if (q.sql.includes('pg_advisory_xact_lock')) {
        // Faithful finite Prisma seam: an uncast PG void column raises P2010.
        if (!q.sql.includes(')::text')) throw Object.assign(Error('Failed to deserialize column of type void'), { code: 'P2010' });
        expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
        return [{ pg_advisory_xact_lock: '' }];
      }
      return original(q);
    });
    expect(await link(f, input)).toMatchObject({ ok: true, data: { state: 'committed' } });
    const locks = f.tx.$queryRaw.mock.calls.map(([q]: any) => q.sql);
    const requestIndex = locks.findIndex((q: string) => q.includes('pg_advisory_xact_lock'));
    expect(requestIndex).toBeGreaterThan(locks.findIndex((q: string) => q.includes('SampleCardItem')));
    expect(locks[requestIndex]).toContain(')::text');
  });
  it.each([{ linkVersion: 0 }, { quantity: 1 }, { status: 'approved' }, { expectedCardUpdatedAt: true }, { requestKey: 'short' }, { expectedReceiptHash: [] }])('malformed command %j is refused before transaction', async patch => {
    const f = await fixture(); const input = await opened(f); f.prisma.$transaction.mockClear(); const before = copy(f.state); expect(await link(f, { ...input, ...patch })).toMatchObject({ ok: false, error: { status: 400 } }); expect(f.prisma.$transaction).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });
});

describe('Target anchored original Card read guards', () => {
  it('rejects a stored read grant withdrawn after RR snapshot completion using the independent current connection', async () => {
    const f = await fixture(); const businessBefore = copy({cards:f.state.cards,loans:f.state.loans,audits:f.state.audits});
    const transaction = f.prisma.$transaction.getMockImplementation()!;
    f.prisma.$transaction.mockImplementationOnce(async (fn:any, options:any) => {
      const snapshot = await transaction(fn,options);
      // Snapshot finished with an eligible original Card. Only CURRENT stored authority is withdrawn.
      f.state.users[0].roles[0].role.permissions = [{permission:{scope:'sample:room:write'}}]; return snapshot;
    });
    const r = await listReceivedCardsForSample({prisma:f.prisma,actor,sampleId:'SAMPLE'});
    expect(r).toMatchObject({ok:false,error:{status:403}});
    expect({cards:f.state.cards,loans:f.state.loans,audits:f.state.audits}).toEqual(businessBefore);
  });
});

const reverse = (f:any, patch:any={}) => listReceivedCardsForSample({prisma:f.prisma,actor,sampleId:'SAMPLE',...patch});
const reviewed = (f:any, patch:any={}) => listSampleLinkedReviewCards({prisma:f.prisma,actor,sampleId:'SAMPLE',...patch});
function reviewCard(f:any, id='REVIEW', patch:any={}) {
  if (!f.state.cases.some((r:any)=>r.id==='UNKNOWN-LINE')) f.state.cases.push({id:'UNKNOWN-LINE',type:'draft',customerRelationId:'CUSTOMER',deletedAt:null});
  const card={id,code:`SC-${id}`,name:`Original ${id}`,cardType:'fabric',quantity:1,availableQty:1,unit:'PC',status:'in_stock',sampleId:'SAMPLE',devCaseId:'UNKNOWN-LINE',batchId:null,orderId:null,receiptSnapshot:null,createdAt:1n,updatedAt:1n,deletedAt:null,...patch}; f.state.cards.push(card); return card;
}
describe('Qualified reverse and fixed Sample review reads', () => {
  it.each(['fabric','garment'])('frozen %s R1 remains readable while native Batch is R2 pending, with its actual source family', async kind => {
    const f=await fixture(kind);f.state.batches[0].round=2;f.state.batches[0].status='pending';const before=copy(f.state);
    const r=await reverse(f);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.error.code);
    expect(r.data).toMatchObject({anchorSampleId:'SAMPLE',pagination:{limit:20,cursor:null}});
    expect(r.data.items).toHaveLength(kind==='garment'?3:1);
    expect(r.data.items.find((item:any)=>item.card.id===f.cardId)).toMatchObject({card:{cardType:kind,quantity:kind==='garment'?1:3,availableQty:kind==='garment'?0:2},receipt:{nativeFamily:kind==='garment'?'garment-round':'fabric-batch'},businessContext:{status:'resolved',businessLine:kind},frozenSourceRound:1,currentBatchRound:2});assertNoWrite(f,before);
  });
  it('qualified reverse pagination traverses 260 rejected originals before valid receipt, with no fixed first50 cutoff', async () => {
    const f=await fixture();
    for(let i=0;i<260;i++)f.state.cards.push({...copy(f.state.cards[0]),id:`AAA-${String(i).padStart(3,'0')}`,receiptSnapshot:null});
    const before=copy(f.state);const r=await reverse(f,{limit:1});
    expect(r).toMatchObject({ok:true,data:{items:[{card:{id:f.cardId}}],hasMore:false,nextCursor:null}});
    const calls=f.tx.sampleCardItem.findMany.mock.calls;expect(calls.filter(([x]:any)=>x.take===200).length).toBeGreaterThan(1);assertNoWrite(f,before);
  });
  it('two real batch receipts yield stable last-returned cursor and the next Card is not skipped by hasMore lookahead', async () => {
    const f=await fixture();const sample=f.state.samples[0];
    f.state.batches.push({...copy(f.state.batches[0]),id:'SECOND',batchCode:'SB-SECOND',updatedAt:10n});
    const received=await f.room.registerReceivedBatchCards('SECOND',{receiptVersion:2,cardType:'fabric',expectedSourceRound:1,expectedCaseId:'CASE',expectedFactoryId:'FACTORY',expectedBatchUpdatedAt:'10',physicalCardCount:2,actualQuantity:'0.75',actualUnit:'M'},actor.userId);expect(received.ok).toBe(true);
    // Assemble this test target once with a full two-component original binding producer.
    f.state.sources=[];f.state.audits=f.state.audits.filter((a:any)=>a.action!=='bind_sample_origins');
    await bindSampleOrigins(f.tx,sample,f.state.batches.map((b:any)=>snapshotSampleOrigin(b,f.state.cases[0])),actor.userId,{provenance:'recorded_exact'});
    f.tx.sampleCardItem.updateMany.mockClear();const before=copy(f.state);
    const page=await reverse(f,{limit:1});expect(page.ok).toBe(true);if(!page.ok)throw Error('page failed');
    expect(page.data.items).toHaveLength(1);expect(page.data.hasMore).toBe(true);expect(page.data.nextCursor).toBe(page.data.items[0].card.id);
    const next=await reverse(f,{limit:1,cursor:page.data.nextCursor});expect(next.ok).toBe(true);if(!next.ok)throw Error('next failed');
    expect(next.data.items).toHaveLength(1);expect(next.data.items[0].card.id).not.toBe(page.data.items[0].card.id);expect(next.data.hasMore).toBe(false);expect(next.data.nextCursor).toBeNull();
    expect(new Set([...page.data.items,...next.data.items].map(x=>x.card.id)).size).toBe(2);assertNoWrite(f,before);
  });
  it.each(['null-receipt','V1','create-missing','create-duplicate'])('reverse refuses unverifiable %s without inventing exact tokens',async bad=>{
    const f=await fixture();if(bad==='null-receipt')f.state.cards[0].receiptSnapshot=null;if(bad==='V1')f.state.cards[0].receiptSnapshot.version=1;
    if(bad==='create-missing')f.state.audits=f.state.audits.filter((a:any)=>a.action!=='sample_card_create');if(bad==='create-duplicate')f.state.audits.push({...copy(f.state.audits.find((a:any)=>a.action==='sample_card_create')),id:'DUPLICATE'});
    const before=copy(f.state);expect(await reverse(f)).toMatchObject({ok:true,data:{targetEligibility:{eligible:true},items:[],hasMore:false,nextCursor:null}});assertNoWrite(f,before);
  });
  it.each(['inherited','bind-missing','bind-incomplete','business-conflict'])('target %s is explicit unsupported eligibility, not exact tokens or an inventory total',async bad=>{
    const f=await fixture();if(bad==='inherited')f.state.sources[0].provenance='inherited';if(bad==='bind-missing')f.state.audits=f.state.audits.filter((a:any)=>a.action!=='bind_sample_origins');
    if(bad==='bind-incomplete')f.state.audits.find((a:any)=>a.action==='bind_sample_origins').detail.after.origins=[];
    if(bad==='business-conflict'){f.state.orders.push({id:'ORDER',type:'garment',businessLine:'garment',customerRelationId:'CUSTOMER',sourceCaseId:'CASE',deletedAt:null});f.state.samples[0].sourceOrderId='ORDER';}
    const before=copy(f.state);const r=await reverse(f);expect(r).toMatchObject({ok:true,data:{targetEligibility:{eligible:false},expectedTargetIdentityHash:null,expectedBindingSetHash:null,items:[]}});
    if(r.ok)expect((r.data as any).total).toBeUndefined();assertNoWrite(f,before);
  });
  it.each(['shipped','retired','deleted','linked'])('%s original is not eligible; reader does not change inventory or approvals',async terminal=>{
    const f=await fixture();if(terminal==='deleted')f.state.cards[0].deletedAt=30n;else if(terminal==='linked')f.state.cards[0].sampleId='SAMPLE';else f.state.cards[0].status=terminal;
    const before=copy(f.state);expect(await reverse(f)).toMatchObject({ok:true,data:{items:[],hasMore:false,nextCursor:null}});assertNoWrite(f,before);
  });
  it('Card explicit Order customer scope is required even when Case and target Sample are visible',async()=>{
    const f=await fixture();f.state.relations.push({id:'FOREIGN',ownerId:'OTHER',salesRepIds:[],deletedAt:null});f.state.orders.push({id:'ORDER',customerRelationId:'FOREIGN',sourceCaseId:'CASE',type:'fabric',businessLine:'fabric',deletedAt:null});f.state.cards[0].orderId='ORDER';
    const before=copy(f.state);expect(await reverse(f)).toMatchObject({ok:true,data:{items:[],hasMore:false}});assertNoWrite(f,before);
  });
  it('target Sample customer and all real Order/Case customers must be visible',async()=>{
    const f=await fixture();f.state.relations.push({id:'FOREIGN',ownerId:'OTHER',salesRepIds:[],deletedAt:null});f.state.samples[0].customerRelationId='FOREIGN';const before=copy(f.state);expect(await reverse(f)).toMatchObject({ok:false,error:{status:404}});assertNoWrite(f,before);
  });
  it('legacy Order-only custody uses its actual customer, remains readable review and blocked from exact association',async()=>{
    const f=await fixture();Object.assign(f.state.samples[0],{sourceCaseId:null,customerRelationId:null,sourceOrderId:'ORDER'});f.state.orders.push({id:'ORDER',customerRelationId:'CUSTOMER',sourceCaseId:null,type:'draft',businessLine:null,deletedAt:null});
    Object.assign(f.state.cards[0],{sampleId:'SAMPLE',devCaseId:null,batchId:null,orderId:'ORDER',receiptSnapshot:null});const before=copy(f.state);
    expect(await reviewed(f)).toMatchObject({ok:true,data:{anchorSampleId:'SAMPLE',items:[{card:{id:f.cardId},receiptStatus:'manual',linkEligibility:{eligible:false}}]}});
    expect(await reverse(f)).toMatchObject({ok:true,data:{targetEligibility:{eligible:false},expectedTargetIdentityHash:null,expectedBindingSetHash:null,items:[]}});assertNoWrite(f,before);
  });
  it('unanchored legacy custody requires CURRENT stored all scope; forged owner token does not grant it',async()=>{
    const f=await fixture();Object.assign(f.state.samples[0],{sourceCaseId:null,sourceOrderId:null,customerRelationId:null,productAssetId:null});Object.assign(f.state.cards[0],{sampleId:'SAMPLE',devCaseId:null,batchId:null,orderId:null,receiptSnapshot:null});
    expect(await reviewed(f,{actor:{...actor,roles:['owner'],roleIds:['role-super-admin']}})).toMatchObject({ok:false,error:{status:404}});
    f.state.users[0].roles[0].role.id='role-super-admin';const before=copy(f.state);
    const r=await reviewed(f);expect(r).toMatchObject({ok:true,data:{items:[{card:{id:f.cardId},businessContext:{status:'unresolved'},linkEligibility:{eligible:false}}]}});if(r.ok)expect(r.data.items[0].expectedReceiptHash).toBeUndefined();
    expect(await reverse(f)).toMatchObject({ok:true,data:{targetEligibility:{eligible:false},expectedTargetIdentityHash:null,expectedBindingSetHash:null}});assertNoWrite(f,before);
  });
  it('missing legacy Order cannot borrow Sample.customer scope as fabricated source visibility',async()=>{
    const f=await fixture();f.state.samples[0].sourceOrderId='MISSING-ORDER';const before=copy(f.state);expect(await reviewed(f)).toMatchObject({ok:false,error:{status:404}});assertNoWrite(f,before);
  });
  it('linked-review fixes Sample anchor, excludes every resolved lane and foreign physical owner before pagination',async()=>{
    const f=await fixture();f.state.cards[0].sampleId='SAMPLE';reviewCard(f,'VISIBLE');reviewCard(f,'OTHER-SAMPLE',{sampleId:'ANOTHER-SAMPLE'});
    f.state.relations.push({id:'FOREIGN',ownerId:'OTHER',salesRepIds:[],deletedAt:null});f.state.cases.push({id:'FOREIGN-CASE',type:'fabric',customerRelationId:'FOREIGN',name:'PRIVATE FOREIGN NAME',deletedAt:null});reviewCard(f,'HIDDEN',{devCaseId:'FOREIGN-CASE'});
    const before=copy(f.state);const r=await reviewed(f,{limit:1});expect(r).toMatchObject({ok:true,data:{items:[{card:{id:'VISIBLE'}}],hasMore:false,nextCursor:null}});expect(JSON.stringify(r)).not.toContain('PRIVATE FOREIGN NAME');assertNoWrite(f,before);
  });
  it('review shows all genuine active borrows and never calculates borrowed quantity from ownership difference',async()=>{
    const f=await fixture();expect((await f.room.createLoan(f.cardId,{ requestKey: 'link-service-fixture-loan-02',loanType:'borrow',borrowerName:'Second person',loanQuantity:1},actor)).ok).toBe(true);
    expect((await f.room.createLoan(f.cardId,{ requestKey: 'link-service-fixture-loan-03',loanType:'viewing',borrowerName:'Customer',loanQuantity:1},actor)).ok).toBe(true);
    f.state.cases.push({id:'OTHER-CASE',type:'fabric',customerRelationId:'CUSTOMER',deletedAt:null});f.state.cards[0].sampleId='SAMPLE';f.state.cards[0].devCaseId='OTHER-CASE';const before=copy(f.state);
    const r=await reviewed(f);expect(r).toMatchObject({ok:true,data:{items:[{card:{quantity:3,availableQty:1},receiptStatus:'legacyUnverified'}]}});
    if(!r.ok)throw Error('review failed');expect(r.data.items[0].activeLoans).toHaveLength(2);expect(r.data.items[0].activeLoans.every((x:any)=>x.loanType==='borrow')).toBe(true);assertNoWrite(f,before);
  });
  it.each(['sampleId','case-customer','card-parent','batch-case'])('RR completion cannot follow a changed %s into a newly visible scope',async changed=>{
    const f=await fixture();f.state.cases.push({id:'NEW-CASE',type:'garment',customerRelationId:'CUSTOMER',deletedAt:null});f.state.relations.push({id:'NEW-CUSTOMER',ownerId:actor.userId,salesRepIds:[],deletedAt:null});
    const transaction=f.prisma.$transaction.getMockImplementation()!;f.prisma.$transaction.mockImplementationOnce(async(fn:any,opts:any)=>{const snapshot=await transaction(fn,opts);
      if(changed==='sampleId')f.state.samples[0].sourceCaseId='NEW-CASE';if(changed==='case-customer')f.state.cases[0].customerRelationId='NEW-CUSTOMER';if(changed==='card-parent')f.state.cards[0].devCaseId='NEW-CASE';if(changed==='batch-case')f.state.batches[0].developmentCaseId='NEW-CASE';return snapshot;});
    expect(await reverse(f)).toMatchObject({ok:false,error:{status:409}});expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
  it('withdrawal of L2 relation after RR result is built denies CURRENT read rather than certifying old snapshot',async()=>{
    const f=await fixture();const transaction=f.prisma.$transaction.getMockImplementation()!;f.prisma.$transaction.mockImplementationOnce(async(fn:any,opts:any)=>{const snapshot=await transaction(fn,opts);f.state.relations.find((r:any)=>r.id==='CUSTOMER').ownerId='OTHER';return snapshot;});
    expect(await reverse(f)).toMatchObject({ok:false,error:{status:404}});expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
  it('read survives Room write withdrawal but rejects signed ceiling and CURRENT stored read withdrawal',async()=>{
    const f=await fixture();f.state.users[0].roles[0].role.permissions=[{permission:{scope:'products:read'}}];expect(await reverse(f)).toMatchObject({ok:true,data:{items:[{card:{id:f.cardId}}]}});
    expect(await reverse(f,{actor:{...actor,permissionCeiling:['sample:room:write']}})).toMatchObject({ok:false,error:{status:403}});
    f.state.users[0].roles[0].role.permissions=[];expect(await reviewed(f)).toMatchObject({ok:false,error:{status:403}});
  });
  it.each(['card-query','proof-query','classifier-query','permission-query','outside-current-query'])('SQL/auth failure %s returns an error, not empty inventory',async fault=>{
    const f=await fixture();if(fault==='card-query')f.tx.sampleCardItem.findMany.mockRejectedValue(Error('private SQL'));if(fault==='proof-query')f.tx.auditLog.findMany.mockRejectedValue(Error('private SQL'));
    if(fault==='classifier-query')f.tx.developmentCase.findMany.mockRejectedValue(Error('private SQL'));if(fault==='permission-query')f.tx.userAccount.findFirst.mockRejectedValue(Error('private SQL'));
    if(fault==='outside-current-query'){const transaction=f.prisma.$transaction.getMockImplementation()!;f.prisma.$transaction.mockImplementationOnce(async(fn:any,opts:any)=>{const snapshot=await transaction(fn,opts);f.tx.userAccount.findFirst.mockRejectedValue(Error('private SQL'));return snapshot;});}
    const r=await reverse(f);expect(r).toMatchObject({ok:false,error:{status:500}});expect(JSON.stringify(r)).not.toContain('private SQL');expect(f.tx.sampleCardItem.updateMany).not.toHaveBeenCalled();
  });
  it.each([0,101,true,1.5,'2.5',null])('invalid read limit %s is rejected before any RR read',async limit=>{
    const f=await fixture();f.prisma.$transaction.mockClear();expect(await reverse(f,{limit})).toMatchObject({ok:false,error:{status:400}});expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('exact-link mutation respects all current parent write ownership', () => {
  it.each(['read','read+followup'])('garment team %s share permits fabric inspection, and only followup permits association without changing source family',async permission=>{
    const f=await fixture();const input=await opened(f,'team-owned-link');
    f.state.relations.find((r:any)=>r.id==='CUSTOMER').ownerId='OTHER';
    f.state.memberships.push({userId:actor.userId,teamId:'GARMENT-TEAM',leftAt:null});
    f.state.grants.push({teamId:'GARMENT-TEAM',entityType:'relation',entityId:'CUSTOMER',permission,revokedAt:null,team:{id:'GARMENT-TEAM',name:'成衣业务组',deletedAt:null}});
    expect(await getSampleCardSampleLinkContext({prisma:f.prisma,actor,cardId:f.cardId})).toMatchObject({ok:true});
    expect(await reverse(f)).toMatchObject({ok:true,data:{items:[{receipt:{nativeFamily:'fabric-batch'},businessContext:{status:'resolved',businessLine:'fabric'}}]}});
    const before=copy(f.state);const r=await link(f,input);
    if(permission==='read'){expect(r).toMatchObject({ok:false,error:{status:404}});assertNoWrite(f,before);}
    else expect(r).toMatchObject({ok:true,data:{state:'committed'}});
  });
  it('a hidden customer on the actual Card order cannot be bypassed through a visible Case',async()=>{
    const f=await fixture();const input=await opened(f,'foreign-order-link');
    f.state.relations.push({id:'FOREIGN-CUSTOMER',ownerId:'OTHER',salesRepIds:[],deletedAt:null});
    f.state.orders.push({id:'ORDER',type:'fabric',businessLine:'fabric',sourceCaseId:'CASE',customerRelationId:'FOREIGN-CUSTOMER',deletedAt:null});
    f.state.cards[0].orderId='ORDER';const before=copy(f.state);
    expect(await link(f,input)).toMatchObject({ok:false,error:{status:404}});assertNoWrite(f,before);
  });
});
