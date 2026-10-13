import { describe, expect, it } from 'vitest';
import { sampleConsumerOriginProof, assertFrozenSampleConsumerOrigin } from '../sampleConsumerSource';
import { assertConfirmedFabricSourceEligible } from '../../development/fabricAssetEligibility';
import { resolveConfirmedSource } from '../../development/convertService';
import { advanceSampleBatchStage } from '../../development/fabricDevelopmentService';
import { orderConfirmedSourceBinding } from '../../orders/orderConfirmedSourceBinding';
import { readSampleOriginContexts, sampleProjectionKey } from '../sampleOriginService';
import { makeSampleConsumerSourceFixture, approveAndBindSampleConsumerOrigins, type SampleConsumerSourceFixture } from './sampleConsumerSourceFixture';

const leaves = [
  { name: 'eligibility', run: (f: SampleConsumerSourceFixture) => assertConfirmedFabricSourceEligible(f.tx, { type: 'Sample', id: f.state.samples[0].id }) },
  { name: 'resolveConfirmedSource', run: (f: SampleConsumerSourceFixture) => resolveConfirmedSource({ prisma: f.prisma,
    confirmedSourceType: 'Sample', confirmedSourceId: f.state.samples[0].id, millRelationId: 'CONSUMER_FACTORY' }) },
  { name: 'orderConfirmedSourceBinding', run: (f: SampleConsumerSourceFixture) => orderConfirmedSourceBinding(f.tx,
    f.state.orders[0], f.state.lines[0], { confirmedSourceType: 'Sample', confirmedSourceId: f.state.samples[0].id }, f.actor) },
];
const selected = (f: SampleConsumerSourceFixture) => ({ type: 'Sample', id: f.state.samples[0].id });

describe('Sample consumer native development proof', () => {
  it('native order binding cannot become an empty legacy development approval', async () => {
    const f = makeSampleConsumerSourceFixture({ directOrder: true });
    f.tx.orderSampleSource.findUnique.mockResolvedValue({ id: 'actual-native-order-source' });
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toThrow('订单样品须核对实际业务范围');
  });
  it('native storage failure propagates instead of yielding legacy null proof', async () => {
    const f = makeSampleConsumerSourceFixture({ directOrder: true });
    f.tx.orderSampleSource.findUnique.mockRejectedValue(Error('native ledger unavailable'));
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toThrow('native ledger unavailable');
  });
  it('real native approval and binding writers establish proof separate from Sample workflow round', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture({ canonical: true }));
    expect(f.state.audits.map((row: any) => row.action)).toEqual(['advance_sample_batch', 'bind_sample_origins']);
    const proof = await sampleConsumerOriginProof(f.tx, f.state.samples[0]);
    expect(proof).toMatchObject({ schemaVersion: 1, sampleId: 'CONSUMER_SAMPLE', projectionKey: sampleProjectionKey('fabric_output', 'CONSUMER_BATCH', 1),
      origins: [{ sampleBatchId: 'CONSUMER_BATCH', sourceRound: 1, sourceHistoryRevision: 1 }] });
    expect(f.state.samples[0].round).toBe(4);
    expect((await readSampleOriginContexts(f.tx, f.state.samples))[0]).toMatchObject({ status: 'resolved', currentUsable: true });
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
    const before = structuredClone(f.state);
    await expect(assertConfirmedFabricSourceEligible(f.tx, selected(f))).resolves.toMatchObject({ factoryRelationId: 'CONSUMER_FACTORY' });
    const resolved = await resolveConfirmedSource({ prisma: f.prisma, confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE' });
    expect(resolved.ok).toBe(true); if (resolved.ok) expect(resolved.data.specSnapshot.sampleOriginProof).toEqual(proof);
    await expect(leaves[2].run(f)).resolves.toMatchObject({ specSnapshot: { sampleOriginProof: proof } });
    expect(f.state).toEqual(before);
  });

  for (const leaf of leaves) describe(leaf.name + ' actual consumer leaf', () => {
    it.each(['pp', 'ship', 'head', 'pioneer'])('retains independent direct-order %s with no development anchor or rows', async sampleType => {
      const f = makeSampleConsumerSourceFixture({ directOrder: true, sampleType });
      expect(await sampleConsumerOriginProof(f.tx, f.state.samples[0])).toBeNull();
      const before = structuredClone(f.state);
      const result: any = await leaf.run(f);
      expect(result).toBeDefined();
      if (leaf.name === 'resolveConfirmedSource') expect(result.ok).toBe(true);
      expect(f.state).toEqual(before);
    });
    it('leaf rejects legacy approved development Sample without exact origins', async () => {
      const f = makeSampleConsumerSourceFixture(); const before = structuredClone(f.state);
      await expect(leaf.run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
      expect(f.state).toEqual(before);
    });
    it('leaf rejects empty Case and projection headers while real origin rows remain', async () => {
      const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
      f.state.samples[0].sourceCaseId = null; f.state.samples[0].projectionKey = null;
      f.state.orders[0].sourceCaseId = null;
      const before = structuredClone(f.state);
      await expect(leaf.run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
      expect(f.state).toEqual(before);
    });
    it.each(['batch-content', 'case-content', 'new-round', 'negative-customer', 'native-audit-missing'])('leaf rejects %s despite approved Sample status', async mutation => {
      const f = makeSampleConsumerSourceFixture();
      if (mutation === 'negative-customer') f.state.batches[0].sampleType = 'lab-dip';
      await approveAndBindSampleConsumerOrigins(f);
      if (mutation === 'batch-content') f.state.batches[0].specNote = 'changed-after-native-approval';
      if (mutation === 'case-content') f.state.cases[0].specComposition = 'polyester';
      if (mutation === 'new-round') f.state.batches[0].round = 2;
      if (mutation === 'negative-customer') f.state.batches[0].customerStatus = 'rejected';
      if (mutation === 'native-audit-missing') f.state.audits = f.state.audits.filter((row: any) => row.action !== 'advance_sample_batch');
      const before = structuredClone(f.state);
      expect(f.state.samples[0].status).toBe('approved');
      await expect(leaf.run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
      expect(f.state).toEqual(before);
    });
    it.each(['sampleSource', 'sampleBatch', 'developmentCase', 'auditLog'])('leaf propagates %s storage failure without granting current usability', async model => {
      const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
      const fault = Object.assign(Error('exact-source SQL unavailable'), { code: 'P2022' });
      f.tx[model].findMany.mockRejectedValue(fault);
      const before = structuredClone(f.state);
      await expect(leaf.run(f)).rejects.toBe(fault);
      expect(f.state).toEqual(before);
    });
  });

  it('projection-only direct-order header cannot masquerade as proven development', async () => {
    const f = makeSampleConsumerSourceFixture({ directOrder: true, canonical: true });
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('canonical projection key conflicting with real native Batch identity is refused', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture({ canonical: true }));
    f.state.samples[0].projectionKey = sampleProjectionKey('fabric_output', 'WRONG_BATCH', 1);
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    const context = (await readSampleOriginContexts(f.tx, f.state.samples))[0];
    expect(context.status).toBe('conflict'); expect(context.currentUsable).toBe(false);
  });
  it('binding audit projection identity cannot be replaced by matching current header and Batch', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture({ canonical: true }));
    f.state.audits.find((row: any) => row.action === 'bind_sample_origins').detail.after.projectionKey = 'v1:fabric_output:WRONG_BATCH:1';
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it.each(['corrupt-fingerprint', 'missing-binding-audit'])('%s cannot establish current source identity', async mutation => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    if (mutation === 'corrupt-fingerprint') f.state.sources[0].sourceFingerprint = 'forged';
    else f.state.audits = f.state.audits.filter((row: any) => row.action !== 'bind_sample_origins');
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('multi-origin physical proof freezes every component in stable binding order', async () => {
    const f = makeSampleConsumerSourceFixture();
    f.state.batches.push({ ...structuredClone(f.state.batches[0]), id: 'CONSUMER_BATCH_2', batchCode: 'SECOND-BATCH', specNote: 'native-physical-v2' });
    await approveAndBindSampleConsumerOrigins(f);
    const proof = await sampleConsumerOriginProof(f.tx, f.state.samples[0]);
    expect(proof?.origins).toHaveLength(2);
    expect(proof?.origins.map(row => row.sampleBatchId).sort()).toEqual(['CONSUMER_BATCH', 'CONSUMER_BATCH_2']);
    f.state.sources.reverse();
    expect(await sampleConsumerOriginProof(f.tx, f.state.samples[0])).toEqual(proof);
    const frozen = structuredClone(proof)!; frozen.origins.pop();
    expect(() => assertFrozenSampleConsumerOrigin(proof, frozen)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
    f.state.batches[1].status = 'rejected';
    await expect(sampleConsumerOriginProof(f.tx, f.state.samples[0])).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('proof-free direct-order history replays without manufacturing source approval', async () => {
    const f = makeSampleConsumerSourceFixture({ directOrder: true });
    const result: any = await leaves[2].run(f);
    Object.assign(f.state.lines[0], { confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE', specSnapshot: structuredClone(result.specSnapshot) });
    const before = structuredClone(f.state);
    await expect(leaves[2].run(f)).resolves.toMatchObject({ productAssetId: 'CONSUMER_ASSET' });
    expect(f.state).toEqual(before); expect(f.state.sources).toHaveLength(0); expect(f.state.audits).toHaveLength(0);
  });
  it('proof comparison preserves original evidence and rejects missing or changed proof', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    const proof = await sampleConsumerOriginProof(f.tx, f.state.samples[0]);
    const frozen = JSON.parse(JSON.stringify(proof));
    expect(() => assertFrozenSampleConsumerOrigin(proof, frozen)).not.toThrow();
    expect(() => assertFrozenSampleConsumerOrigin(proof, undefined)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
    const different = structuredClone(frozen); different.origins[0].sourceRound = 2;
    expect(() => assertFrozenSampleConsumerOrigin(proof, different)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
    expect(frozen).toEqual(proof);
    expect(() => assertFrozenSampleConsumerOrigin(null, undefined)).not.toThrow();
    expect(() => assertFrozenSampleConsumerOrigin(null, frozen)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
  });
  it('same-selected OrderLine replay validates original proof without rewriting line facts', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    const result: any = await leaves[2].run(f);
    Object.assign(f.state.lines[0], { confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE',
      confirmedAt: 123n, confirmedBy: 'ORIGINAL_ACTOR', specSnapshot: structuredClone(result.specSnapshot) });
    const before = structuredClone(f.state);
    await expect(leaves[2].run(f)).resolves.toMatchObject({ specSnapshot: result.specSnapshot });
    expect(f.state).toEqual(before);
    delete f.state.lines[0].specSnapshot.sampleOriginProof;
    const missingBefore = structuredClone(f.state);
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' });
    expect(f.state).toEqual(missingBefore);
  });
  it('same-selected OrderLine cannot replay a different original source proof', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    const result: any = await leaves[2].run(f);
    result.specSnapshot.sampleOriginProof.origins[0].sourceFingerprint = 'another-approved-content';
    Object.assign(f.state.lines[0], { confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE', specSnapshot: result.specSnapshot });
    const before = structuredClone(f.state);
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' }); expect(f.state).toEqual(before);
  });
  it('new native approval token on the same immutable origin cannot reuse a prior frozen proof', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    const prior: any = await leaves[2].run(f);
    const frozen = structuredClone(prior.specSnapshot.sampleOriginProof);
    Object.assign(f.state.lines[0], { confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE',
      confirmedAt: 123n, confirmedBy: 'ORIGINAL_ACTOR', specSnapshot: structuredClone(prior.specSnapshot) });
    // Storage precondition for a same-round source reapproval. Native approval
    // facts/history are still produced by the real writer, never fabricated.
    f.state.batches[0].status = 'sent';
    const approved = await advanceSampleBatchStage({ prisma: f.prisma, batchId: 'CONSUMER_BATCH', action: 'approve',
      input: {}, actorId: f.actorId, trustedActor: f.actor });
    expect(approved.ok).toBe(true);
    const current = await sampleConsumerOriginProof(f.tx, f.state.samples[0]);
    expect(current?.origins).toEqual(frozen.origins);
    expect(current?.nativeApprovals).toHaveLength(1);
    expect(current?.nativeApprovals).not.toEqual(frozen.nativeApprovals);
    expect((await readSampleOriginContexts(f.tx, f.state.samples))[0].currentUsable).toBe(true);
    expect(() => assertFrozenSampleConsumerOrigin(current, frozen)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
    await expect(assertConfirmedFabricSourceEligible(f.tx, selected(f))).resolves.toMatchObject({ sampleOriginProof: current });
    const resolved = await leaves[1].run(f); expect(resolved).toMatchObject({ ok: true, data: { specSnapshot: { sampleOriginProof: current } } });
    const before = structuredClone(f.state);
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'DEVELOPMENT_SOURCE_CHANGED' }); expect(f.state).toEqual(before);
  });
  it('origin validity never relaxes true Order/factory/customer/category/exclusivity rules', async () => {
    const f = await approveAndBindSampleConsumerOrigins(makeSampleConsumerSourceFixture());
    f.state.samples[0].sourceOrderId = 'ANOTHER_ORDER';
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.samples[0].sourceOrderId = null; f.state.orders[0].millRelationId = 'ANOTHER_FACTORY';
    const factoryResult = await resolveConfirmedSource({ prisma: f.prisma, confirmedSourceType: 'Sample', confirmedSourceId: 'CONSUMER_SAMPLE', millRelationId: 'ANOTHER_FACTORY' });
    expect(factoryResult).toMatchObject({ ok: false, error: { code: 'MILL_MISMATCH' } });
    f.state.orders[0].millRelationId = 'CONSUMER_FACTORY'; f.state.orders[0].customerRelationId = 'ANOTHER_CUSTOMER';
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.orders[0].customerRelationId = 'CONSUMER_CUSTOMER'; f.state.orders[0].type = 'garment';
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.orders[0].type = 'fabric'; f.state.customerCodes.push({ productAssetId: 'CONSUMER_ASSET', isExclusive: true, deletedAt: null, customerOrganizationId: 'ANOTHER_CUSTOMER' });
    await expect(leaves[2].run(f)).rejects.toMatchObject({ code: 'EXCLUSIVE_FABRIC_BLOCKED' });
  });
});
