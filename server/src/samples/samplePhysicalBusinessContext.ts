import { resolveSampleBusinessContexts, type SampleBusinessContext, type SampleBusinessSource } from './sampleBusinessContext';
import type { PhysicalSampleSourceInput } from './samplePhysicalSourceService';

const ref = (value: unknown): string | null => typeof value === 'string' ? value.trim() || null : null;
const ids = (values: unknown[]) => [...new Set(values.map(ref).filter((v): v is string => !!v))].sort();
const live = (row: any) => row && row.deletedAt == null;

/** Read-only current business ownership. Card assets describe materials; only
 * Sample assets are business subjects. This is neither approval nor receipt
 * evidence. All explicit owner IDs must agree, even within the same lane.
 * SQL failures propagate; missing parents are visible review records.
 */
export async function resolvePhysicalSampleBusinessContexts(db: any, cards: PhysicalSampleSourceInput[]): Promise<SampleBusinessContext[]> {
  const sampleIds = ids(cards.map(c => c.sampleId)), batchIds = ids(cards.map(c => c.batchId));
  const [samples, batches] = await Promise.all([
    sampleIds.length ? db.sample.findMany({ where: { id: { in: sampleIds } }, select: { id: true, sourceCaseId: true, sourceOrderId: true, productAssetId: true, deletedAt: true } }) : [],
    batchIds.length ? db.sampleBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, developmentCaseId: true, deletedAt: true } }) : [],
  ]);
  const sampleMap = new Map<string, any>(samples.map((s: any) => [s.id, s])), batchMap = new Map<string, any>(batches.map((b: any) => [b.id, b]));
  const orderIds = ids([...cards.map(c => c.orderId), ...samples.filter(live).map((s: any) => s.sourceOrderId)]);
  const orders = orderIds.length ? await db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, sourceCaseId: true, deletedAt: true } }) : [];
  const orderMap = new Map<string, any>(orders.map((o: any) => [o.id, o]));
  const defects: Array<{ conflict: boolean; reasons: string[] }> = [];
  const owners: SampleBusinessSource[] = cards.map(card => {
    const reasons: string[] = []; let conflict = false;
    const invalidRef = (value: unknown) => value != null && (typeof value !== 'string' || !value.trim() || value.trim() !== value);
    for (const value of [card.devCaseId, card.orderId, card.sampleId, card.batchId]) if (invalidRef(value)) reasons.push('PHYSICAL_OWNER_REFERENCE_INVALID');
    const sampleId = ref(card.sampleId), batchId = ref(card.batchId);
    const sample = sampleId ? sampleMap.get(sampleId) : null, batch = batchId ? batchMap.get(batchId) : null;
    if (sampleId && !live(sample)) reasons.push('PHYSICAL_SAMPLE_MISSING_OR_DELETED');
    if (batchId && !live(batch)) reasons.push('PHYSICAL_BATCH_MISSING_OR_DELETED');
    if (live(sample) && [sample.sourceCaseId, sample.sourceOrderId, sample.productAssetId].some(invalidRef)) reasons.push('PHYSICAL_SAMPLE_OWNER_REFERENCE_INVALID');
    if (live(batch) && invalidRef(batch.developmentCaseId)) reasons.push('PHYSICAL_BATCH_CASE_REFERENCE_INVALID');
    const sampleCase = live(sample) ? ref(sample.sourceCaseId) : null, sampleOrder = live(sample) ? ref(sample.sourceOrderId) : null;
    const explicitCase = ref(card.devCaseId), explicitOrder = ref(card.orderId);
    const disagree = (a: string | null, b: string | null, reason: string) => { if (a && b && a !== b) { conflict = true; reasons.push(reason); } };
    disagree(explicitCase, sampleCase, 'PHYSICAL_CASE_SOURCE_CONFLICT');
    disagree(explicitOrder, sampleOrder, 'PHYSICAL_ORDER_SOURCE_CONFLICT');
    let caseId = sampleCase ?? explicitCase;
    const orderId = sampleOrder ?? explicitOrder, batchCase = live(batch) ? ref(batch.developmentCaseId) : null;
    if (live(batch) && !batchCase) reasons.push('PHYSICAL_BATCH_CASE_MISSING');
    disagree(caseId, batchCase, 'PHYSICAL_BATCH_CASE_CONFLICT'); caseId ??= batchCase;
    const order = orderId ? orderMap.get(orderId) : null, orderCase = live(order) ? ref(order.sourceCaseId) : null;
    if (live(order) && invalidRef(order.sourceCaseId)) reasons.push('PHYSICAL_ORDER_CASE_REFERENCE_INVALID');
    disagree(caseId, orderCase, 'PHYSICAL_ORDER_CASE_CONFLICT'); caseId ??= orderCase;
    defects.push({ conflict, reasons });
    return { sourceCaseId: caseId, sourceOrderId: orderId, productAssetId: live(sample) ? ref(sample.productAssetId) : null };
  });
  const contexts = await resolveSampleBusinessContexts(db, owners);
  return contexts.map((context, index) => {
    const defect = defects[index], reasons = [...new Set([...defect.reasons, ...context.reasons])];
    if (defect.conflict || context.status === 'conflict') return { status: 'conflict', businessLine: null, reasons };
    if (reasons.length || context.status !== 'resolved') return { status: 'unresolved', businessLine: null, reasons };
    return context;
  });
}
