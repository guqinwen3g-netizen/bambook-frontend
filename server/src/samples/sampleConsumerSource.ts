import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { assertSampleOriginUsable, readSampleOriginContexts, type SampleOriginContext } from './sampleOriginService';

/** A development origin is separate from a direct-order sample's native
 * workflow. This proof never invents a development batch for order samples. */
export type SampleConsumerOriginProof = {
  schemaVersion: 1;
  sampleId: string;
  projectionKey: string | null;
  nativeApprovals: NonNullable<SampleOriginContext['nativeApprovals']>;
  nativeSealApprovals: NonNullable<SampleOriginContext['nativeSealApprovals']>;
  origins: Array<{
    id: string; sampleBatchId: string; sourceRound: number; sourceSealId: string | null;
    sourceFingerprint: string; sourceUpdatedAt: string; sourceHistoryRevision: number | null;
    sourceEventId: string | null; evidenceAuditId: string;
  }>;
};

export async function sampleConsumerOriginProof(db: any, sample: any): Promise<SampleConsumerOriginProof | null> {
  // Native order sources cannot become an empty legacy development proof.
  // Their consumers must verify the actual Line/Batch/ReleaseScope range.
  if (sample.sourceOrderId && await db.orderSampleSource.findUnique({ where: { sampleId: sample.id }, select: { id: true } })) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '订单样品须核对实际业务范围及原生检验、寄送、客户确认依据，不能使用旧开发来源的空证明。');
  }
  const bindings = await db.sampleSource.findMany({ where: { sampleId: sample.id }, select: { id: true } });
  if (!sample.sourceCaseId && !sample.projectionKey && !bindings.length) return null;
  const [context] = await readSampleOriginContexts(db, [sample]);
  assertSampleOriginUsable(context);
  return {
    schemaVersion: 1, sampleId: sample.id, projectionKey: context.projectionKey,
    nativeApprovals: context.nativeApprovals ?? [], nativeSealApprovals: context.nativeSealApprovals ?? [],
    origins: context.origins.map(origin => ({
      id: origin.id, sampleBatchId: origin.sampleBatchId, sourceRound: origin.sourceRound,
      sourceSealId: origin.sourceSealId, sourceFingerprint: origin.sourceFingerprint,
      sourceUpdatedAt: origin.sourceUpdatedAt, sourceHistoryRevision: origin.sourceHistoryRevision,
      sourceEventId: origin.sourceEventId, evidenceAuditId: origin.evidenceAuditId,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function assertFrozenSampleConsumerOrigin(current: SampleConsumerOriginProof | null, frozen: unknown): void {
  if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(frozen ?? null))) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '样品的批次、来源轮次或版本与原冻结依据不一致，请保留原事实并重新核对版本。');
  }
}
