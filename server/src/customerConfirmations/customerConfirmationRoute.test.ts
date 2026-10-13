import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomerConfirmationRouter } from './customerConfirmationRoute';
import { CustomerConfirmationError } from './customerConfirmationService';

const mocks = vi.hoisted(() => ({
  currentActor: vi.fn(), assertMatches: vi.fn(), validate: vi.fn(), record: vi.fn(),
  prepare: vi.fn(), persist: vi.fn(), removeCreated: vi.fn(), readFile: vi.fn(),
}));
const actor: any = { userId: 'synthetic-sales', roles: ['sales'], permissions: [], authorizationLoaded: true };

vi.mock('../auth/middleware', () => ({ extractActorFromRequest: () => actor }));
vi.mock('./customerConfirmationService', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual,
    currentCustomerConfirmationActor: mocks.currentActor,
    assertCustomerConfirmationMatchesTarget: mocks.assertMatches,
    validateCustomerConfirmationCommand: mocks.validate,
    recordBusinessConfirmationInTx: mocks.record,
  };
});
vi.mock('./customerEvidenceCapture', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual,
    prepareCustomerConfirmationEvidence: mocks.prepare,
    persistPreparedCustomerEvidenceBlobsInTx: mocks.persist,
    removeNewlyCreatedFilesWhileLocked: mocks.removeCreated,
    readCustomerEvidenceFile: mocks.readFile,
  };
});

const targetSnapshot: any = { eligible: true, finalContentFingerprint: 'a'.repeat(64), internalApprovalId: 'approval-1',
  scopeFingerprint: 'b'.repeat(64), scope: { lineIds: ['line-1'] }, nativeStatus: { status: 'Approved' } };
const command: any = { targetType: 'OrderChangeRequest', targetId: 'OCR__1', finalContentFingerprint: 'a'.repeat(64),
  internalApprovalId: 'approval-1', scopeFingerprint: 'b'.repeat(64), scope: { lineIds: ['line-1'] },
  outcome: 'accepted', customerName: '联系人', confirmedAt: new Date().toISOString(), channel: 'screenshot',
  idempotencyKey: '11111111-1111-4111-8111-111111111111' };

function invokePost(router: any, body: any, file?: any) {
  const layer = router.stack.find((item: any) => item.route?.path === '/');
  const handler = layer.route.stack[0].handle;
  const req: any = { method: 'POST', headers: { 'content-type': 'application/json' }, body, file, ip: '127.0.0.1', params: {}, query: {} };
  const response: any = { statusCode: 200, body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(value: any) { this.body = value; return this; },
    send(value: any) { this.body = value; return this; },
    setHeader() { return this; } };
  return Promise.resolve(handler(req, response)).then(() => response);
}

function invokeGet(router: any, path: string, query: any = {}) {
  const layer = router.stack.find((item: any) => item.route?.path === path && item.route?.methods?.get);
  const handler = layer.route.stack[0].handle;
  const req: any = { method: 'GET', headers: {}, body: {}, file: null, ip: '127.0.0.1', params: {}, query };
  const response: any = { statusCode: 200, body: null,
    status(code: number) { this.statusCode = code; return this; },
    json(value: any) { this.body = value; return this; },
    send(value: any) { this.body = value; return this; },
    setHeader() { return this; } };
  return Promise.resolve(handler(req, response)).then(() => response);
}

function transactionContext(confirmations: any[] = [], sequence?: string[]) {
  return {
    $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => { sequence?.push('lock'); return []; }),
    businessConfirmation: {
      findUnique: vi.fn(async ({ where }: any) => {
        sequence?.push('prior');
        const key = where.recordedBy_requestKey;
        return confirmations.find(row => row.recordedBy === key.recordedBy && row.requestKey === key.requestKey) ?? null;
      }),
    },
  };
}
const prismaFor = (tx: any) => ({ $transaction: vi.fn(async (work: any) => work(tx)) });

describe('customer confirmation route transaction boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentActor.mockResolvedValue(actor);
    mocks.assertMatches.mockImplementation(() => undefined);
    mocks.validate.mockImplementation(() => undefined);
    mocks.prepare.mockResolvedValue({ sourceType: 'screenshot', sourceFingerprint: 'c'.repeat(64),
      sourceSnapshot: { kind: 'screenshot' }, selectionSnapshot: { kind: 'screenshot' }, blobs: [] });
    mocks.persist.mockResolvedValue({ newlyCreatedStorageKeys: [] });
    mocks.record.mockResolvedValue({ confirmation: { id: 'BCF__1', outcome: 'accepted' }, evidence: { id: 'CEV__1' }, replayed: false });
  });

  it('searches only registered native targets from a current readable inbound email and reinspects each target', async () => {
    const email = { id: 'EML__linked', direction: 'inbound', orderId: 'ORD__linked', relationId: 'REL__linked' };
    const tx: any = { email: { findFirst: vi.fn(async ({ where }: any) => where.id === email.id ? email : null) } };
    const prisma: any = { $transaction: vi.fn(async (work: any) => work(tx)) };
    const adapter: any = { targetType: 'OrderChangeRequest', searchTargetIds: vi.fn(async () => ['OCR__linked']),
      inspect: vi.fn(async () => ({ ...targetSnapshot, eligible: true, businessReference: 'OCR-2030-001' })) };
    const notSearchable: any = { targetType: 'UnregisteredDomain', inspect: vi.fn() };
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter, notSearchable] } as any });

    const res = await invokeGet(router, '/targets', { emailId: email.id });
    expect(res.statusCode).toBe(200);
    expect(mocks.currentActor).toHaveBeenCalledWith(tx, actor, 'emails:read');
    expect(tx.email.findFirst).toHaveBeenCalledWith({ where: { id: email.id, deletedAt: null }, select: {
      id: true, direction: true, orderId: true, relationId: true,
    } });
    expect(adapter.searchTargetIds).toHaveBeenCalledWith(tx, actor, { sourceEmail: email, businessReference: undefined });
    expect(adapter.inspect).toHaveBeenCalledWith(tx, 'OCR__linked', actor, 'read');
    expect(notSearchable.inspect).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, emailId: email.id, searchMode: 'linked', candidates: [
      { targetType: 'OrderChangeRequest', targetId: 'OCR__linked', businessReference: 'OCR-2030-001' },
    ] });
  });

  it('uses exact business reference search and excludes ineligible or non-inbound email targets', async () => {
    const tx: any = { email: { findFirst: vi.fn(async () => ({ id: 'EML__linked', direction: 'inbound', orderId: null, relationId: null })) } };
    const prisma: any = { $transaction: vi.fn(async (work: any) => work(tx)) };
    const adapter: any = { targetType: 'OrderChangeRequest', searchTargetIds: vi.fn(async (_tx, _actor, input) => {
      expect(input.businessReference).toBe('OCR-2030-014'); return ['OCR__stale', 'OCR__current'];
    }), inspect: vi.fn(async (_tx, id) => ({ ...targetSnapshot, eligible: id === 'OCR__current', businessReference: 'OCR-2030-014' })) };
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });

    const found = await invokeGet(router, '/targets', { emailId: 'EML__linked', businessReference: 'OCR-2030-014' });
    expect(found.statusCode).toBe(200);
    expect(found.body).toMatchObject({ searchMode: 'exact-reference', candidates: [{ targetId: 'OCR__current' }] });
    expect(adapter.inspect).toHaveBeenCalledTimes(2);

    tx.email.findFirst.mockResolvedValueOnce({ id: 'EML__outbound', direction: 'outbound', orderId: null, relationId: null });
    const outbound = await invokeGet(router, '/targets', { emailId: 'EML__outbound' });
    expect(outbound.statusCode).toBe(404);
    expect(adapter.searchTargetIds).toHaveBeenCalledTimes(1);
  });

  it('does not search candidate targets after the current email read grant is revoked', async () => {
    const tx: any = { email: { findFirst: vi.fn(async () => ({ id: 'EML__linked', direction: 'inbound', orderId: 'ORD__1', relationId: null })) } };
    const prisma: any = { $transaction: vi.fn(async (work: any) => work(tx)) };
    const adapter: any = { targetType: 'OrderChangeRequest', searchTargetIds: vi.fn(), inspect: vi.fn() };
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    mocks.currentActor.mockRejectedValueOnce(new CustomerConfirmationError('FORBIDDEN', 'emails:read revoked', 403));

    const res = await invokeGet(router, '/targets', { emailId: 'EML__linked' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(tx.email.findFirst).not.toHaveBeenCalled();
    expect(adapter.searchTargetIds).not.toHaveBeenCalled();
    expect(adapter.inspect).not.toHaveBeenCalled();
  });

  it('keeps a committed confirmation successful when post-commit native apply throws', async () => {
    const adapter: any = {
      targetType: 'OrderChangeRequest', inspect: vi.fn(async () => targetSnapshot),
      onRecordedInTx: vi.fn(async (_tx, input) => ({ nativeStatus: { changeRequestStatus: 'Approved', customerConfirmation: input.confirmation.id }, effect: 'accepted_waiting_apply' })),
      continueAfterRecord: vi.fn(async () => { throw new Error('synthetic apply outage'); }),
    };
    const tx = transactionContext();
    const prisma: any = prismaFor(tx);
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    const res = await invokePost(router, { command, source: { kind: 'screenshot' } }, { buffer: Buffer.from('synthetic') });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ ok: true, saved: true, replayed: false, continuationStatus: 'pending',
      confirmation: { id: 'BCF__1' }, nativeStatus: { changeRequestStatus: 'Approved' },
      effect: 'accepted_waiting_apply', continuationFailure: { code: 'NATIVE_CONTINUATION_FAILED' } });
    expect(adapter.onRecordedInTx).toHaveBeenCalledWith(tx, expect.objectContaining({ confirmation: { id: 'BCF__1', outcome: 'accepted' } }));
    expect(adapter.inspect).toHaveBeenCalledWith(tx, command.targetId, actor, 'confirm');
    expect(mocks.assertMatches).toHaveBeenCalledWith(command, targetSnapshot);
    expect(tx.businessConfirmation.findUnique).toHaveBeenCalledWith({ where: { recordedBy_requestKey: { recordedBy: actor.userId, requestKey: command.idempotencyKey } } });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `customer-confirmation-idempotency:${actor.userId}:${command.idempotencyKey}`);
    expect(mocks.removeCreated).not.toHaveBeenCalled();
  });

  it('fails closed for partial acceptance until a target adapter validates item-level scope', async () => {
    const adapter: any = { targetType: 'OrderChangeRequest', inspect: vi.fn(async () => targetSnapshot),
      onRecordedInTx: vi.fn(async () => ({ nativeStatus: {} })) };
    const tx = transactionContext();
    const prisma: any = prismaFor(tx);
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    const res = await invokePost(router, { command: { ...command, outcome: 'partial', decisionScope: { acceptedLineIds: ['line-1'] } },
      source: { kind: 'screenshot' } }, { buffer: Buffer.from('synthetic') });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('replays an exact committed confirmation after its target is no longer confirmable, using current write authorization and status', async () => {
    const prior = { id: 'BCF__prior', targetType: command.targetType, targetId: command.targetId,
      recordedBy: actor.userId, requestKey: command.idempotencyKey, requestFingerprint: 'f'.repeat(64), outcome: 'accepted' };
    const savedEvidence = { id: 'CEV__prior' };
    const order: string[] = [];
    const tx = transactionContext([prior], order);
    const prisma: any = prismaFor(tx);
    const appliedSnapshot = { ...targetSnapshot, eligible: false, nativeStatus: { status: 'applied', version: 'current-v2' } };
    const adapter: any = {
      targetType: command.targetType,
      inspect: vi.fn(),
      inspectReplay: vi.fn(async () => appliedSnapshot),
      onRecordedInTx: vi.fn(),
      continueAfterRecord: vi.fn(async () => ({ nativeStatus: null, effect: null })),
    };
    const router = createCustomerConfirmationRouter({ prisma, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    mocks.currentActor.mockImplementationOnce(async () => { order.push('actor'); return actor; })
      .mockImplementationOnce(async () => { order.push('actor'); return actor; });
    mocks.record.mockResolvedValueOnce({ confirmation: prior, evidence: savedEvidence, replayed: true });

    const res = await invokePost(router, { command, source: { kind: 'screenshot' } }, { buffer: Buffer.from('same evidence') });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, saved: true, replayed: true, confirmation: { id: prior.id },
      evidenceId: savedEvidence.id, nativeStatus: appliedSnapshot.nativeStatus,
      effect: { status: 'recorded', replayed: true } });
    expect(order).toEqual(['actor', 'lock', 'actor', 'prior']);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `customer-confirmation-idempotency:${actor.userId}:${command.idempotencyKey}`);
    expect(adapter.inspectReplay).toHaveBeenCalledWith(tx, command.targetId, actor);
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(mocks.assertMatches).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith({ tx, actor, source: { kind: 'screenshot' }, file: { buffer: Buffer.from('same evidence') } });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(tx, expect.objectContaining({ command, actor, evidence: expect.any(Object) }));
    expect(adapter.onRecordedInTx).not.toHaveBeenCalled();
    expect(adapter.continueAfterRecord).toHaveBeenCalledWith({ targetId: command.targetId, actor, command, confirmation: prior });
  });

  it('returns IDENTITY_KEY_REUSED when a retry changes the confirmation payload', async () => {
    const prior = { id: 'BCF__prior', targetType: command.targetType, targetId: command.targetId,
      recordedBy: actor.userId, requestKey: command.idempotencyKey, requestFingerprint: 'f'.repeat(64), outcome: 'accepted' };
    const tx = transactionContext([prior]);
    const adapter: any = { targetType: command.targetType, inspect: vi.fn(), inspectReplay: vi.fn(async () => targetSnapshot), onRecordedInTx: vi.fn() };
    const router = createCustomerConfirmationRouter({ prisma: prismaFor(tx) as any, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    const changed = { ...command, customerName: '另一位联系人' };
    mocks.record.mockRejectedValueOnce(new CustomerConfirmationError('IDEMPOTENCY_KEY_REUSED', '本次提交编号已用于不同内容。', 409));

    const res = await invokePost(router, { command: changed, source: { kind: 'screenshot' } }, { buffer: Buffer.from('evidence') });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(adapter.inspectReplay).toHaveBeenCalledWith(tx, command.targetId, actor);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(tx, expect.objectContaining({ command: changed }));
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(adapter.onRecordedInTx).not.toHaveBeenCalled();
  });

  it('checks current write authorization again after waiting for the idempotency lock', async () => {
    const prior = { id: 'BCF__prior', targetType: command.targetType, targetId: command.targetId,
      recordedBy: actor.userId, requestKey: command.idempotencyKey, requestFingerprint: 'f'.repeat(64), outcome: 'accepted' };
    const order: string[] = [];
    const tx = transactionContext([prior], order);
    const adapter: any = { targetType: command.targetType, inspect: vi.fn(), inspectReplay: vi.fn(), onRecordedInTx: vi.fn() };
    const router = createCustomerConfirmationRouter({ prisma: prismaFor(tx) as any, targetAdapters: { get: () => adapter, list: () => [adapter] } as any });
    mocks.currentActor.mockImplementationOnce(async () => { order.push('actor'); return actor; })
      .mockImplementationOnce(async () => { order.push('actor'); throw new CustomerConfirmationError('FORBIDDEN', '当前写权限已撤销。', 403); });

    const res = await invokePost(router, { command, source: { kind: 'screenshot' } }, { buffer: Buffer.from('evidence') });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(order).toEqual(['actor', 'lock', 'actor']);
    expect(tx.businessConfirmation.findUnique).not.toHaveBeenCalled();
    expect(adapter.inspectReplay).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('rejects a key already bound to a different target before requiring that target adapter', async () => {
    const prior = { id: 'BCF__prior', targetType: command.targetType, targetId: command.targetId,
      recordedBy: actor.userId, requestKey: command.idempotencyKey, requestFingerprint: 'f'.repeat(64), outcome: 'accepted' };
    const tx = transactionContext([prior]);
    const router = createCustomerConfirmationRouter({ prisma: prismaFor(tx) as any,
      targetAdapters: { get: () => undefined, list: () => [] } as any });

    const res = await invokePost(router, { command: { ...command, targetType: 'NoLongerRegistered' }, source: { kind: 'screenshot' } }, { buffer: Buffer.from('evidence') });
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(tx.businessConfirmation.findUnique).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
