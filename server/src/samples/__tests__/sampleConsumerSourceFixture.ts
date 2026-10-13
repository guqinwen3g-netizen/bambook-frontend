import { vi } from 'vitest';
import { advanceSampleBatchStage } from '../../development/fabricDevelopmentService';
import { fabricAuthorizationFixture } from '../../development/__tests__/fabricAuthorizationFixture';
import { bindSampleOrigins, sampleProjectionKey, snapshotSampleOrigin } from '../sampleOriginService';

/** Stateful storage seam only. Approval/history/binding evidence is written by
 * the real native services; this fixture is not PostgreSQL or company evidence. */
export function makeSampleConsumerSourceFixture(options: { directOrder?: boolean; sampleType?: string; canonical?: boolean } = {}) {
  const actorId = 'CONSUMER_ACTOR';
  const state: any = {
    cases: [{ id: 'CONSUMER_CASE', type: 'fabric', stage: 'sampling', customerRelationId: 'CONSUMER_CUSTOMER',
      ownerId: actorId, specComposition: 'cotton', specWeight: '150', deletedAt: null }],
    batches: [{ id: 'CONSUMER_BATCH', batchCode: 'CONSUMER-BATCH', developmentCaseId: 'CONSUMER_CASE',
      supplierRelationId: 'CONSUMER_FACTORY', sampleType: 'yardage', round: 1, status: 'sent',
      confirmStatus: 'unconfirmed', updatedAt: 10n, deletedAt: null, specNote: 'native-physical-v1', attachments: {} }],
    samples: [{ id: 'CONSUMER_SAMPLE', code: 'CONSUMER-SAMPLE', type: options.sampleType ?? 'seal', status: 'approved', round: 4,
      sourceCaseId: options.directOrder ? null : 'CONSUMER_CASE', sourceOrderId: options.directOrder ? 'CONSUMER_ORDER' : null,
      customerRelationId: 'CONSUMER_CUSTOMER', supplierRelationId: 'CONSUMER_FACTORY', supplierName: 'Actual factory',
      productAssetId: 'CONSUMER_ASSET', projectionKey: options.canonical ? sampleProjectionKey('fabric_output', 'CONSUMER_BATCH', 1) : null,
      deletedAt: null }],
    assets: [{ id: 'CONSUMER_ASSET', sku: 'CONSUMER-FABRIC', name: 'Actual product', mainCategory: 'Fabric',
      deletedAt: null, fabricProfile: { articleNo: 'ARTICLE', construction: 'plain', weightValueGsm: 150,
        millOrganizationId: 'CONSUMER_FACTORY' }, garmentProfile: null }],
    sources: [], audits: [], seals: [], links: [], references: [], customerCodes: [],
    orders: [{ id: 'CONSUMER_ORDER', type: 'fabric', sourceCaseId: options.directOrder ? null : 'CONSUMER_CASE',
      customerRelationId: 'CONSUMER_CUSTOMER', millRelationId: 'CONSUMER_FACTORY', deletedAt: null }],
    lines: [{ id: 'CONSUMER_LINE', orderId: 'CONSUMER_ORDER', materialCode: null, millQuality: null,
      confirmedSourceType: null, confirmedSourceId: null, specSnapshot: null }],
  };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
  const copy = (row: any) => row == null ? row : structuredClone(row);
  const delegate = (rows: () => any[]) => ({
    findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
      const result = rows().filter(row => matches(row, where)).map(copy);
      if (orderBy?.id) result.sort((a, b) => String(a.id).localeCompare(String(b.id)) * (orderBy.id === 'desc' ? -1 : 1));
      return result;
    }),
    findFirst: vi.fn(async ({ where }: any) => copy(rows().find(row => matches(row, where)) ?? null)),
    findUnique: vi.fn(async ({ where }: any) => copy(rows().find(row => matches(row, where)) ?? null)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows().find(row => matches(row, where));
      if (!row) throw Error('Fixture update target missing');
      Object.assign(row, copy(data));
      return copy(row);
    }),
    create: vi.fn(async ({ data }: any) => { const row = copy(data); rows().push(row); return copy(row); }),
  });
  const tx: any = {
    ...fabricAuthorizationFixture(actorId),
    $queryRaw: vi.fn(async () => [{ id: 'synthetic-locked' }]),
    developmentLifecycleEvent: { findFirst: vi.fn(async () => null) },
    developmentCase: delegate(() => state.cases), sampleBatch: delegate(() => state.batches),
    sample: delegate(() => state.samples), sampleSource: delegate(() => state.sources),
    orderSampleSource: { findUnique: vi.fn(async () => null) },
    sealSample: delegate(() => state.seals), sealSampleBatch: delegate(() => state.links),
    productAsset: delegate(() => state.assets), entityReference: delegate(() => state.references),
    fabricCustomerCode: delegate(() => state.customerCodes), fabricProfile: delegate(() => state.assets.map((a: any) => a.fabricProfile).filter(Boolean)),
    order: delegate(() => state.orders), orderLine: delegate(() => state.lines),
    auditLog: { ...delegate(() => state.audits), create: vi.fn(async ({ data }: any) => {
      const row = { ...copy(data), createdAt: new Date() }; state.audits.push(row); return copy(row);
    }) },
  };
  const prisma: any = { ...tx, $transaction: async (fn: any) => {
    const before = structuredClone(state);
    try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
  } };
  return { state, tx, db: tx, prisma, actorId, actor: { userId: actorId } as any };
}

export type SampleConsumerSourceFixture = ReturnType<typeof makeSampleConsumerSourceFixture>;

/** Uses the real native approval writer and immutable binding audit writer.
 * Samples have independent workflow round 4; native Batch source round is 1. */
export async function approveAndBindSampleConsumerOrigins(f: SampleConsumerSourceFixture) {
  for (const batch of f.state.batches) {
    const result = await advanceSampleBatchStage({ prisma: f.prisma, batchId: batch.id,
      action: 'approve', input: {}, actorId: f.actorId, trustedActor: f.actor });
    if (!result.ok) throw Error('Native fixture approval failed: ' + JSON.stringify(result.error));
  }
  await bindSampleOrigins(f.tx, f.state.samples[0], f.state.batches.map((batch: any) =>
    snapshotSampleOrigin(batch, f.state.cases.find((devCase: any) => devCase.id === batch.developmentCaseId))), f.actorId);
  return f;
}
