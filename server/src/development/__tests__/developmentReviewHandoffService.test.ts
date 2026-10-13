import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ lock: vi.fn(), execution: vi.fn(), source: vi.fn(), current: vi.fn(), guard: vi.fn(), businessNow: vi.fn(() => Date.parse('2026-10-08T00:18:00.000Z')) }));
vi.mock('../../shared/businessClock', async () => ({ ...await vi.importActual<object>('../../shared/businessClock'), businessNowMs: mocks.businessNow }));
vi.mock('../developmentOperationalGuard', async () => ({ ...await vi.importActual<object>('../developmentOperationalGuard'), assertDevelopmentOperationalWrite: mocks.guard }));
vi.mock('../developmentSampleQualityService', () => ({
  lockDevelopmentQualityReview: mocks.lock, authorizeDevelopmentQualityExecution: mocks.execution,
  assertReviewSourceCurrent: mocks.current, serializeDevelopmentQualityReview: (row: any) => ({ ...row, updatedAt: String(row.updatedAt), startedAt: row.startedAt == null ? null : String(row.startedAt) }),
}));
vi.mock('../developmentConversionAuthority', () => ({ authorizeDevelopmentSource: mocks.source }));
vi.mock('../../auth/tokenHelpers', () => ({ loadUserWithRoles: async (tx: any, id: string) => tx.userAccount.findFirst({ where: { id } }),
  buildLoadedAuthTokenPayload: async (_tx: any, user: any) => ({ userId: user.id, roles: [], permissions: user.permissions }) }));
import { DevelopmentDomainError } from '../developmentOperationalGuard';
import { createDevelopmentReviewHandoffService, normalizeDevelopmentReviewHandoff } from '../developmentReviewHandoffService';
import type { TokenPayload } from '../../auth/service';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'bambook-development-qc-unit-')); vi.clearAllMocks(); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const token = (userId: string): TokenPayload => ({ userId, roles: [], departmentIds: [], permissions: ['qc:read', 'qc:inspect', 'qc:fabric_chain:write'] });
const fp = 'a'.repeat(64);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=', 'base64');
function fixture() {
  let review: any = { id: 'review-1', developmentCaseId: 'case-1', sampleBatchId: 'batch-1', sampleVersionId: 'version-1',
    sourceFingerprint: fp, status: 'queued', requestedBy: 'sales', startedBy: null, startedAt: null, updatedAt: 100n, evidence: [] };
  const audits: any[] = [], notifications: any[] = [];
  const users: any[] = ['qc-1', 'qc-2'].map(id => ({ id, displayName: id, status: 'active', deletedAt: null, primaryDeptId:'qc-dept', permissions: token(id).permissions }));
  users.push({ id: 'sales', displayName: 'business', status: 'active', deletedAt: null, permissions: ['products:read'] });
  let revoked = false, stale = false, compareAndSetFails = false;
  const actorFor = (id: string) => ({ ...token(id), permissions: users.find(row => row.id === id)?.permissions ?? [] });
  const development = { id: 'case-1', type: 'fabric', ownerId: 'sales' };
  const requireExecution = async (_tx: any, _caseId: string, id: string) => {
    const actor = actorFor(id);
    if (revoked || !actor.permissions?.includes('qc:inspect') || !actor.permissions?.includes('qc:fabric_chain:write')) throw new DevelopmentDomainError('FORBIDDEN', '专业授权已收回');
    return { actor, development };
  };
  mocks.execution.mockImplementation(requireExecution);
  mocks.lock.mockImplementation(async (tx: any, input: any) => ({ ...await requireExecution(tx, review.developmentCaseId, input.actorId), review: { ...review } }));
  mocks.current.mockImplementation(async () => { if (stale) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '准确来源已变化'); });
  mocks.source.mockImplementation(async (_tx: any, id: string, _prior: any, _caseId: string, input: any) => {
    const actor = actorFor(id);
    if (revoked || !actor.permissions?.includes(input.scope)) throw new DevelopmentDomainError('FORBIDDEN', '读取授权已收回');
    return { actor, development };
  });
  const auditMatches = (row: any, where: any) => (!where.action || typeof where.action === 'string' ? !where.action || row.action === where.action : where.action.in.includes(row.action))
    && (!where.actorId || row.actorId === where.actorId) && (!where.targetId || row.targetId === where.targetId) && (!where.targetType || row.targetType === where.targetType)
    && (!where.detail || where.detail.path.reduce((value: any, key: string) => value?.[key], row.detail) === where.detail.equals);
  const tx: any = {
    team: {findMany:vi.fn(async()=>[{id:'qc-team',status:'active',deletedAt:null,departmentId:'qc-dept',leaderId:'qc-1',department:{parentId:'company',status:'active',metadata:{businessAttributes:['fabric_qc']}},members:[{userId:'qc-1'},{userId:'qc-2'}]}])},
    $queryRaw: vi.fn(async (query: { sql: string }) => {
      if (query.sql.includes('pg_advisory_xact_lock') && !query.sql.includes(')::text'))
        throw new Error('Prisma cannot deserialize a PostgreSQL void result');
      return [{ id: review.id }];
    }),
    userAccount: { findFirst: vi.fn(async ({ where }: any) => users.find(row => row.id === where.id) ?? null), findMany: vi.fn(async () => users) },
    developmentLifecycleEvent: { findFirst: vi.fn(async () => null) },
    developmentSampleQualityReview: {
      findUnique: vi.fn(async ({ where }: any) => where.id === review.id ? { ...review } : null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (compareAndSetFails || where.id !== review.id || where.startedBy !== review.startedBy || where.updatedAt !== review.updatedAt
          || where.sourceFingerprint !== review.sourceFingerprint || !where.status.in.includes(review.status)) return { count: 0 };
        review = { ...review, ...data }; return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => { const row = { ...data, createdAt: new Date() }; audits.push(row); return row; }),
      findFirst: vi.fn(async ({ where }: any) => audits.find(row => auditMatches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => audits.filter(row => auditMatches(row, where))) },
    notification: { create: vi.fn(async ({ data }: any) => { notifications.push(data); return data; }) },
  };
  const db: any = { $transaction: async (run: any) => { const prior = { ...review }, auditCount = audits.length, notificationCount = notifications.length;
    try { return await run(tx); } catch (error) { review = prior; audits.splice(auditCount); notifications.splice(notificationCount); throw error; } } };
  const service = createDevelopmentReviewHandoffService(db, root);
  const input = (requestKey = 'original-claim') => ({ requestKey, expectedStartedBy: review.startedBy, expectedUpdatedAt: String(review.updatedAt), sourceFingerprint: fp, reason: '实际到厂人员认领本次准确版本' });
  return { service, tx, audits, notifications, users, input, get review() { return review; }, setReview: (value: any) => { review = { ...review, ...value }; },
    revoke: () => { revoked = true; }, stale: () => { stale = true; }, failCompareAndSet: () => { compareAndSetFails = true; } };
}

describe('exact development QC execution handoffs and native file proof', () => {
  it.each(['2026-10-07T08:00:00.000Z', '2026-10-09T08:00:00.000Z'])('keeps claim/transfer occurrence on business time and CAS monotonic on process time %s', async wallIso => {
    const wallMs = Date.parse(wallIso), businessMs = mocks.businessNow(), wall = vi.spyOn(Date, 'now').mockReturnValue(wallMs), f = fixture();
    f.setReview({ updatedAt: BigInt(wallMs + 500) });
    const claimInput = f.input(), claimed = await f.service.claim('review-1', claimInput, token('qc-1'));
    expect(claimed).toMatchObject({ item: { startedAt: String(businessMs), updatedAt: String(wallMs + 501) }, receipt: { occurredAt: String(businessMs) } });
    wall.mockReturnValue(wallMs + 1000);
    const transferred = await f.service.transfer('review-1', { ...f.input('clock-transfer'), toUserId: 'qc-2' }, token('qc-1'));
    expect(transferred).toMatchObject({ item: { startedAt: String(businessMs), updatedAt: String(wallMs + 1000) }, receipt: { occurredAt: String(businessMs) } });
    wall.mockReturnValue(wallMs + 60_000);
    expect(await f.service.claim('review-1', claimInput, token('qc-1'))).toEqual({ ...claimed, replayed: true });
    expect(f.review.updatedAt).toBe(BigInt(wallMs + 1000)); expect(f.audits).toHaveLength(2);
    expect((await f.service.context('review-1', token('qc-2'))).history.map((row: { occurredAt: string }) => row.occurredAt)).toEqual([String(businessMs), String(businessMs)]);
  });
  it('claims once, transfers to a real eligible QC, preserves history and replays the original ACK after transfer', async () => {
    const f = fixture(), claimInput = f.input();
    const claimed = await f.service.claim('review-1', claimInput, token('qc-1'));
    expect(claimed).toMatchObject({ replayed: false, item: { startedBy: 'qc-1', status: 'in_progress' }, receipt: { actorId: 'qc-1', fromUserId: null, toUserId: 'qc-1', sampleVersionId: 'version-1' } });
    const transferred = await f.service.transfer('review-1', { ...f.input('transfer-key'), toUserId: 'qc-2', reason: '同厂路线调整，正式移交' }, token('qc-1'));
    expect(transferred.receipt).toMatchObject({ fromUserId: 'qc-1', toUserId: 'qc-2' });
    expect(f.review.startedBy).toBe('qc-2');
    const replay = await f.service.claim('review-1', claimInput, token('qc-1'));
    expect(replay).toEqual({ ...claimed, replayed: true });
    expect(f.review.startedBy).toBe('qc-2'); expect(f.audits).toHaveLength(2); expect(f.notifications).toHaveLength(2);
    await expect(f.service.claim('review-1', { ...claimInput, reason: '另一个命令' }, token('qc-1'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });

  it('rejects stolen execution, stale revisions, an ineligible recipient and revoked authority even on replay', async () => {
    const f = fixture(), command = f.input(); await f.service.claim('review-1', command, token('qc-1'));
    await expect(f.service.transfer('review-1', { ...f.input('steal'), toUserId: 'qc-2' }, token('qc-2'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.service.transfer('review-1', { ...f.input('stale'), expectedUpdatedAt: '100', toUserId: 'qc-2' }, token('qc-1'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    f.users.find(row => row.id === 'qc-2').permissions = ['qc:read', 'qc:write'];
    await expect(f.service.transfer('review-1', { ...f.input('not-professional'), toUserId: 'qc-2' }, token('qc-1'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.revoke(); await expect(f.service.claim('review-1', command, token('qc-1'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.review.startedBy).toBe('qc-1'); expect(f.audits).toHaveLength(1);
  });

  it('never infers a version or wins a failed compare-and-set', async () => {
    const f = fixture(); f.stale();
    await expect(f.service.claim('review-1', f.input(), token('qc-1'))).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.review.startedBy).toBeNull(); expect(f.audits).toHaveLength(0);
    const g = fixture(); g.failCompareAndSet();
    await expect(g.service.claim('review-1', g.input(), token('qc-1'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(g.audits).toHaveLength(0);
  });

  it('binds real bytes to the review and uploader; a lost upload ACK survives transfer but new uploads cannot', async () => {
    const f = fixture(); await f.service.claim('review-1', f.input(), token('qc-1'));
    const command = { requestKey: 'upload-1', sourceFingerprint: fp, file: { originalname: '现场.png', buffer: png } };
    const uploaded = await f.service.upload('review-1', command, token('qc-1'));
    expect(uploaded.file).toMatchObject({ sourceId: 'review-1', sourceKind: 'development_review', sourceFingerprint: fp, uploadedBy: 'qc-1', size: png.length });
    await f.service.transfer('review-1', { ...f.input('transfer-after-upload'), toUserId: 'qc-2' }, token('qc-1'));
    expect(await f.service.upload('review-1', command, token('qc-1'))).toEqual({ ...uploaded, replayed: true });
    await expect(f.service.upload('review-1', { ...command, requestKey: 'new-file' }, token('qc-1'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const directory = path.join(root, 'qc-evidence', 'development_review'); expect(await fs.readdir(directory)).toHaveLength(1);
    await expect(f.service.upload('review-1', { ...command, sourceFingerprint: 'b'.repeat(64) }, token('qc-2'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect((await f.service.download('review-1', uploaded.file.id, token('qc-2'))).bytes).toEqual(png);
    await expect(f.service.download('review-1', uploaded.file.id, token('sales'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.setReview({ status: 'reviewed', reviewedBy: 'qc-2', evidence: [uploaded.file] });
    expect((await f.service.download('review-1', uploaded.file.id, token('sales'))).file.uploadedBy).toBe('qc-1');
    const audit = f.audits.find(row => row.action === 'upload_qc_evidence');
    await fs.writeFile(path.join(root, audit.detail.after.relativePath), Buffer.from('tampered bytes'));
    await expect(f.service.download('review-1', uploaded.file.id, token('sales'))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reads the exact executor and history without creating or repairing any fact', async () => {
    const f = fixture(); f.setReview({ status: 'in_progress', startedBy: null });
    const context = await f.service.context('review-1', token('qc-1'));
    expect(context).toMatchObject({ currentExecutor: null, canClaim: true, canExecute: false, canTransfer: false, files: [], history: [] });
    expect(context.users.map(row => row.id)).toEqual(['qc-1', 'qc-2']);
    expect(f.tx.developmentSampleQualityReview.updateMany).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled(); expect(f.tx.notification.create).not.toHaveBeenCalled();
  });

  it('requires explicit original executor/revision/source and does not accept caller-picked claim recipients', () => {
    const f = fixture();
    expect(() => normalizeDevelopmentReviewHandoff({ ...f.input(), toUserId: 'qc-2' }, 'claim', 'qc-1')).toThrow();
    expect(() => normalizeDevelopmentReviewHandoff({ ...f.input(), expectedStartedBy: undefined }, 'claim', 'qc-1')).toThrow();
    expect(() => normalizeDevelopmentReviewHandoff({ ...f.input(), expectedUpdatedAt: '100.1' }, 'claim', 'qc-1')).toThrow();
  });
});


describe('routed development QC team responsibility', () => {
  it('keeps head responsibility separate from the assigned executor until they start', async () => {
    const f=fixture();f.setReview({routingTeamId:'qc-team',responsibleHeadId:'qc-1'});
    const context=await f.service.context('review-1',token('qc-1'));
    expect(context).toMatchObject({canClaim:true,canAssign:true,currentExecutor:null});
    const result=await f.service.assign('review-1',{...f.input('head-assign'),toUserId:'qc-2'},token('qc-1'));
    expect(result.item).toMatchObject({status:'queued',startedBy:'qc-2',startedAt:null,responsibleHeadId:'qc-1'});
    expect((await f.service.context('review-1',token('qc-2')))).toMatchObject({canClaim:false,canStart:true,canExecute:false});
    expect(f.notifications).toHaveLength(1);
  });
  it('lets the configured qualified head self-assign',async()=>{
    const f=fixture();f.setReview({routingTeamId:'qc-team',responsibleHeadId:'qc-1'});
    const result=await f.service.assign('review-1',{...f.input('self-assign'),toUserId:'qc-1'},token('qc-1'));
    expect(result.item).toMatchObject({status:'in_progress',startedBy:'qc-1'});
  });
  it('rejects another member assigning work on behalf of the head',async()=>{
    const f=fixture();f.setReview({routingTeamId:'qc-team',responsibleHeadId:'qc-1'});
    await expect(f.service.assign('review-1',{...f.input('forged-assign'),toUserId:'qc-1'},token('qc-2'))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.audits).toHaveLength(0);expect(f.notifications).toHaveLength(0);
  });
  it('rejects recipients outside the routed team even with professional chain permissions',async()=>{
    const f=fixture();f.setReview({routingTeamId:'qc-team',responsibleHeadId:'qc-1'});
    f.users.push({id:'qc-outside',displayName:'outside',status:'active',deletedAt:null,primaryDeptId:'qc-dept',permissions:token('qc-outside').permissions});
    await expect(f.service.assign('review-1',{...f.input('outside-assign'),toUserId:'qc-outside'},token('qc-1'))).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.review.startedBy).toBeNull();
  });
  it('head may formally transfer assigned work with an audited reason',async()=>{
    const f=fixture();f.setReview({routingTeamId:'qc-team',responsibleHeadId:'qc-1',startedBy:'qc-2',status:'in_progress'});
    const result=await f.service.transfer('review-1',{...f.input('head-transfer'),toUserId:'qc-1'},token('qc-1'));
    expect(result.item).toMatchObject({startedBy:'qc-1'});expect(result.receipt).toMatchObject({fromUserId:'qc-2',toUserId:'qc-1',reason:expect.any(String)});
  });
});
