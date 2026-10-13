import { describe, it, expect, vi } from 'vitest';
import { legacyApprovedFabricBatch } from './fabricAuthorizationFixture';
import { previewDevelopmentClosure as preview, recordDevelopmentLifecycle as act, previewDevelopmentExpenseReview as previewCosts,
  confirmDevelopmentExpenseReview as review, assertDevelopmentExpenseReviewCurrentInTx as current } from '../developmentClosureService';
function fixture(type = 'fabric') {
  const state: any = { development: { id: 'D', type, stage: 'approved', updatedAt: 1n, currentRound: 2 }, // A truthful legacy recorded approval+asset is a storage seam, not native approval evidence.
    batches: type === 'fabric' ? [legacyApprovedFabricBatch({ id: 'B-ready', developmentCaseId: 'D', convertedProductAssetId: 'P-ready' })] : [], seals: [], samples: [], pending: [], costs: [], events: [], reviews: [], audits: [] };
  const table = (name: string) => ({
    findMany: vi.fn(async () => [...state[name]].reverse().slice(0,20)),
    findFirst: vi.fn(async ({ where }: any) => [...state[name]].reverse().find((r: any) => (!where.id || r.id === where.id) && r.developmentCaseId === where.developmentCaseId) ?? null),
    findUnique: vi.fn(async ({ where }: any) => state[name].find((r: any) => r.developmentCaseId === where.developmentCaseId_requestKey.developmentCaseId && r.requestKey === where.developmentCaseId_requestKey.requestKey) ?? null),
    create: vi.fn(async ({ data }: any) => { state[name].push(data); return data; }),
  });
  const tx: any = {
    userAccount: { findMany: vi.fn(async()=>[{id:'u',displayName:'业务员'}]) },
    $queryRaw: vi.fn(async () => [{ id: 'D' }]), developmentCase: { findFirst: vi.fn(async () => state.development) },
    sampleBatch: { findMany: vi.fn(async () => state.batches) }, sealSample: { findMany: vi.fn(async () => state.seals) }, sample: { findMany: vi.fn(async () => state.samples) },
    developmentPendingExpense: { findMany: vi.fn(async ({ where }: any) => state.pending.filter((r: any) => !where.status || where.status === r.status)) },
    costRecord: { findMany: vi.fn(async () => state.costs) }, developmentLifecycleEvent: table('events'), developmentExpenseReview: table('reviews'),
    auditLog: { create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
  };
  const context = { actorId: 'u', authorize: vi.fn(async () => ({})), prisma: { $transaction: async (fn: any) => {
    const before = { events: [...state.events], reviews: [...state.reviews], audits: [...state.audits] };
    try { return await fn(tx); } catch (e) { Object.assign(state, before); throw e; }
  } } };
  const action = async (action: 'close' | 'pause' | 'resume', extra: any = {}) => {
    const p = await preview(context, 'D'); return act(context, 'D', { action, reason: '业务确认依据', requestKey: `${action}-${p.revision}`, expectedRevision: p.revision, expectedFingerprint: p.fingerprint, ...(action === 'close' ? { outcome: 'completed' as const } : {}), ...extra });
  };
  const confirm = async () => { const p = await previewCosts(context, 'D'); return review(context, 'D', { expectedFingerprint: p.fingerprint, requestKey: 'review', note: '所有费用及账单已核实' }); };
  return { context, tx, state, action, confirm };
}
const cost = (amount = '12.3456', currency = 'CNY') => ({ id: 'C', sourceType: 'DevelopmentCase', sourceId: 'D', costType: 'shipping', amount, currency, incurredAt: '2026-09-30', updatedAt: 1n });
describe('explicit closure and whole-case cost review', () => {
  it.each(['fabric','garment'])('%s: sample approval does not close or review the case', async type => {
    const f = fixture(type); expect((await preview(f.context, 'D')).state).toBe('active');
    await expect(f.confirm()).rejects.toMatchObject({ code: 'CASE_NOT_CLOSED' });
    const closed = await f.action('close'); expect(closed.state).toBe('closed'); expect(f.state.reviews).toHaveLength(0);
    f.state.costs.push(cost()); const reviewed = await f.confirm();
    expect(reviewed.snapshot.costs.totals).toEqual([{currency:'CNY',amount:'12.3456'}]);
    expect(await current(f.tx,'D',reviewed.id)).toBe(reviewed);
  });
  it.each(['needs_recast', 'rejected'])('explicit completion preserves %s without inventing product eligibility', async customerStatus => {
    const f = fixture(); f.state.batches[0] = { ...f.state.batches[0], customerStatus };
    const before = structuredClone(f.state.batches);
    const closed = await f.action('close');
    expect(closed.state).toBe('closed');
    expect(f.state.batches).toEqual(before);
    expect(f.state.development.stage).toBe('approved');
  });
  it('pause and closed-case resume preserve stage, financial facts and history', async () => {
    const f = fixture(); await f.action('pause'); expect((await preview(f.context,'D')).state).toBe('paused');
    await expect(f.confirm()).rejects.toMatchObject({code:'CASE_NOT_CLOSED'});
    await f.action('resume'); expect(f.state.development.stage).toBe('approved'); expect(f.state.events).toHaveLength(2);
    await f.action('close'); f.state.costs.push(cost());
    const before = structuredClone({ development: f.state.development, batches: f.state.batches, costs: f.state.costs });
    const resumed = await f.action('resume', { reason: '客户追加复样要求' });
    expect(resumed).toMatchObject({ action: 'resume', state: 'active', reason: '客户追加复样要求', revision: 4 });
    expect(f.state.events).toHaveLength(4);
    expect({ development: f.state.development, batches: f.state.batches, costs: f.state.costs }).toEqual(before);
    expect(f.state.audits.at(-1).detail.after.reason).toBe('客户追加复样要求');
    await expect(f.action('resume')).rejects.toMatchObject({ code: 'INVALID_LIFECYCLE_TRANSITION' });
  });
  it('cannot restore a closed case without an explicit reason', async () => {
    const f = fixture(); await f.action('close', { outcome: 'stopped' });
    await expect(f.action('resume', { reason: '  ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.state.events).toHaveLength(1);
  });
  it('unfinished samples and bills require disposition but do not prevent explicit closure', async () => {
    const f=fixture(); f.state.samples.push({id:'S',type:'dev',code:'sample',status:'sent',updatedAt:1n});
    f.state.pending.push({id:'P',description:'快递费',status:'pending',version:1,ownerId:'u'});
    await expect(f.action('close')).rejects.toMatchObject({code:'DISPOSITION_REQUIRED'});
    const closed=await f.action('close',{disposition:'样品不再寄送，快递账单由业务员继续追到'});
    expect(closed.snapshot.openItems).toHaveLength(2);
    await expect(f.confirm()).rejects.toMatchObject({code:'EXPENSES_PENDING'});
    f.state.pending[0]={...f.state.pending[0],status:'cancelled',version:2,resolutionNote:'快递方确认不发生费用'};
    expect((await f.confirm()).lifecycleEventId).toBe(closed.id);
  });
  it('stopping records actual outcome without inventing sample approval', async () => {
    const f=fixture(); f.state.development.stage='developing';
    const row=await f.action('close',{outcome:'stopped',reason:'客户放弃开发'});
    expect(row.outcome).toBe('stopped');expect(f.state.development.stage).toBe('developing');expect(f.state.reviews).toHaveLength(0);
  });
  it('completion does not require approval, an archive or financial settlement', async () => {
    const f = fixture(); f.state.development.stage = 'developing'; f.state.batches = [];
    f.state.costs.push(cost());
    const closed = await f.action('close', { reason: '业务员确认本次开发工作完成' });
    expect(closed).toMatchObject({ state: 'closed', outcome: 'completed' });
    expect(f.state.development.stage).toBe('developing');
    expect(f.state.costs).toHaveLength(1);
  });
  it('explicitly disposes of unfinished work without approving QC or customer facts', async () => {
    const f = fixture(); f.state.development.stage = 'developing';
    Object.assign(f.state.batches[0], { status: 'making', customerStatus: 'pending', convertedProductAssetId: null });
    const before = structuredClone(f.state.batches);
    await expect(f.action('close')).rejects.toMatchObject({ code: 'DISPOSITION_REQUIRED' });
    expect(f.state.events).toHaveLength(0);
    const closed = await f.action('close', { disposition: '本次结束，未完成样品保留记录，后续另行恢复安排' });
    expect(closed.snapshot.openItems).toHaveLength(1);
    expect(f.state.batches).toEqual(before);
    expect(f.state.development.stage).toBe('developing');
  });
  it('old preview cannot close changed sample/case content', async () => {
    const f=fixture(); const p=await preview(f.context,'D'); f.state.batches.push({id:'B',batchCode:'batch',status:'making',updatedAt:2n});
    await expect(act(f.context,'D',{action:'close',outcome:'completed',reason:'done',requestKey:'old',expectedRevision:0,expectedFingerprint:p.fingerprint,disposition:'will handle'})).rejects.toMatchObject({code:'STALE_VERSION'});
    expect(f.state.events).toHaveLength(0);
  });
  it('same action request replays once and a different payload conflicts', async () => {
    const f=fixture();const p=await preview(f.context,'D');const input={action:'pause' as const,reason:'等待客户',requestKey:'same',expectedRevision:0,expectedFingerprint:p.fingerprint};
    const a=await act(f.context,'D',input);const b=await act(f.context,'D',input);expect(a.id).toBe(b.id);expect(f.state.events).toHaveLength(1);
    await expect(act(f.context,'D',{...input,reason:'different'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  });
  it('review replay does not create duplicates, new expense invalidates without rewriting history', async () => {
    const f=fixture();await f.action('close');f.state.costs.push(cost());const p=await previewCosts(f.context,'D');
    const input={expectedFingerprint:p.fingerprint,requestKey:'review',note:'齐备'};
    const r=await review(f.context,'D',input);expect((await review(f.context,'D',input)).id).toBe(r.id);expect(f.state.reviews).toHaveLength(1);
    f.state.costs[0]=cost('25');await expect(current(f.tx,'D',r.id)).rejects.toMatchObject({code:'REVIEW_STALE'});
    expect(r.snapshot.costs.totals[0].amount).toBe('12.3456');
    await expect(review(f.context,'D',{...input,requestKey:'stale-new'})).rejects.toMatchObject({code:'STALE_VERSION'});
  });
  it('new or changed zero-cost sample sources invalidate the whole-case review', async () => {
    const f=fixture(); await f.action('close'); const r=await f.confirm();
    f.state.samples.push({id:'S',type:'dev',code:'new sample',status:'confirmed',updatedAt:1n});
    await expect(current(f.tx,'D',r.id)).rejects.toMatchObject({code:'REVIEW_STALE'});
    f.state.samples=[]; expect(await current(f.tx,'D',r.id)).toBe(r);
    f.state.development.updatedAt=2n;
    await expect(current(f.tx,'D',r.id)).rejects.toMatchObject({code:'REVIEW_STALE'});
  });
  it('changed cancellation evidence invalidates review', async () => {
    const f=fixture(); f.state.pending.push({id:'P',status:'cancelled',version:2,resolutionNote:'没发生'}); await f.action('close');const r=await f.confirm();
    f.state.pending[0].resolutionNote='新依据';await expect(current(f.tx,'D',r.id)).rejects.toMatchObject({code:'REVIEW_STALE'});
  });
  it('unsupported historical currency and cross-case review cannot be accepted', async () => {
    const f=fixture();await f.action('close');f.state.costs.push(cost('1','EUR'));
    await expect(f.confirm()).rejects.toMatchObject({code:'UNSUPPORTED_CURRENCY'});
    await expect(current(f.tx,'OTHER','unknown')).rejects.toMatchObject({code:'REVIEW_REQUIRED'});
  });
  it('query and audit failures roll back rather than pretend reviewed', async () => {
    const f=fixture();await f.action('close');f.tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.confirm()).rejects.toThrow('audit unavailable');expect(f.state.reviews).toHaveLength(0);
    f.tx.costRecord.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(previewCosts(f.context,'D')).rejects.toThrow('database unavailable');
  });
  it('permission is rechecked after the case lock', async () => {
    const f=fixture();f.context.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoked'));
    await expect(preview(f.context,'D')).rejects.toThrow('revoked');expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  });
});

it('review history survives refresh and marks stale after a late cost', async () => {
 const f=fixture();await f.action('close');await f.confirm();
 const before=await previewCosts(f.context,'D');expect(before.hasCurrentReview).toBe(true);expect(before.history[0]).toMatchObject({current:true,createdByName:'业务员'});
 f.state.costs.push(cost());const after=await previewCosts(f.context,'D');expect(after.hasCurrentReview).toBe(false);expect(after.history[0].current).toBe(false);expect(after.history[0].id).toBe(before.history[0].id);
});
