import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DEVELOPMENT_SAMPLE_TYPES } from './developmentSampleScope';

/** Internal reader: caller enforces scope and supplies its transaction/lock. Never a paginated UI query. */
export async function readDevelopmentExpenseSnapshot(db: any, caseId: string, options?: { commercialSelection: true }) {
  const development = await db.developmentCase.findFirst({ where: { id: caseId, deletedAt: null }, select: { id: true, stage: true, updatedAt: true } });
  if (!development) throw new Error('开发案不存在');
  // A failed source read must fail the review, not erase that source from the amount.
  // Soft-deleting a sample does not erase costs already incurred against it.
  const [batches, allSamples, seals] = await Promise.all([
    db.sampleBatch.findMany({ where: { developmentCaseId: caseId }, select: { id: true, updatedAt: true, deletedAt: true } }),
    db.sample.findMany({ where: { sourceCaseId: caseId }, select: { id: true, type: true, sourceOrderId: true, updatedAt: true, deletedAt: true } }),
    db.sealSample.findMany({ where: { developmentCaseId: caseId }, select: { id: true, updatedAt: true, deletedAt: true } }),
  ]);
  const samples = allSamples.filter((s: any) => DEVELOPMENT_SAMPLE_TYPES.includes(s.type));
  const otherSamples = allSamples.filter((s: any) => !DEVELOPMENT_SAMPLE_TYPES.includes(s.type));
  const sources = [
    { sourceType: 'DevelopmentCase', sourceId: caseId },
    ...batches.map((r: any) => ({ sourceType: 'SampleBatch', sourceId: r.id })),
    ...samples.map((r: any) => ({ sourceType: 'Sample', sourceId: r.id })),
    ...seals.map((r: any) => ({ sourceType: 'SealSample', sourceId: r.id })),
  ];
  const sourceDetails = [
    { sourceType: 'DevelopmentCase', sourceId: caseId, updatedAt: String(development.updatedAt ?? ''), deletedAt: null },
    ...[['SampleBatch', batches], ['Sample', samples], ['SealSample', seals]].flatMap(([type, items]: any) =>
      items.map((r: any) => ({ sourceType: type, sourceId: r.id, updatedAt: String(r.updatedAt ?? ''), deletedAt: r.deletedAt == null ? null : String(r.deletedAt) }))),
  ].sort((a, b) => `${a.sourceType}:${a.sourceId}`.localeCompare(`${b.sourceType}:${b.sourceId}`));
  const rows = await db.costRecord.findMany({ where: { deletedAt: null, OR: [...sources, ...otherSamples.map((s: any) => ({ sourceType: 'Sample', sourceId: s.id }))] }, orderBy: { id: 'asc' }, include: { evidence: { orderBy: { id: 'asc' }, select: { id:true,originalName:true,mimeType:true,byteSize:true,sha256:true,note:true,createdBy:true,createdAt:true,revokedBy:true,revokedAt:true,revokeReason:true } } } });
  // Existing production-sample costs need explicit ownership review, never silent exclusion.
  const otherIds = new Set(otherSamples.map((s: any) => s.id));
  const unresolvedIds = new Set(otherSamples.filter((s: any) => !s.sourceOrderId).map((s: any) => s.id));
  const unresolvedProductionExpenses = rows.filter((r: any) => r.sourceType === 'Sample' && unresolvedIds.has(r.sourceId))
    .map((r: any) => ({ id: r.id, sourceId: r.sourceId, amount: String(r.amount), currency: r.currency, updatedAt: String(r.updatedAt ?? '') }));
  const sourceKeys = new Set(sources.map(r => `${r.sourceType}:${r.sourceId}`));
  const seen = new Set<string>();
  const totals = new Map<string, Prisma.Decimal>();
  const unavailableExpenses: any[] = [];
  const records = rows.filter((r: any) => !(r.sourceType === 'Sample' && otherIds.has(r.sourceId))).flatMap((r: any) => {
    try {
      if (!r.id || seen.has(r.id) || !sourceKeys.has(`${r.sourceType}:${r.sourceId}`)) throw new Error('费用来源或唯一性异常');
      seen.add(r.id);
      if (r.amount === null || r.amount === undefined || String(r.amount).trim() === '') throw new Error('费用金额未确定');
      const amount = new Prisma.Decimal(String(r.amount));
      if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 4) throw new Error('费用金额无效');
      const currency = String(r.currency ?? '').trim();
      if (!currency) throw new Error('费用币种缺失');
      const record = { id: r.id, sourceType: r.sourceType, sourceId: r.sourceId, costType: r.costType,
        amount: amount.toFixed(4), currency, incurredAt: r.incurredAt, bearerType: r.bearerType,
        bearerRelationId: r.bearerRelationId ?? null, notes: r.notes ?? null,
        ...(r.developmentShippingSource != null ? { developmentShippingSource: r.developmentShippingSource } : {}),
        updatedAt: String(r.updatedAt ?? ''),
        ...(r.evidence?.length ? { evidence: r.evidence.map((e:any)=>({...e,createdAt:String(e.createdAt),revokedAt:e.revokedAt==null?null:String(e.revokedAt)})) } : {}) };
      totals.set(currency, (totals.get(currency) ?? new Prisma.Decimal(0)).plus(amount));
      return [record];
    } catch (error: any) {
      // Independent commercial selection reports this one unusable cost; the original
      // full-case review remains strict and retains its existing snapshot/hash shape.
      if (!options?.commercialSelection) throw error;
      unavailableExpenses.push({ id: r.id, sourceType: r.sourceType, sourceId: r.sourceId, costType: r.costType,
        amount: r.amount == null ? null : String(r.amount), currency: r.currency ?? null, unavailableReason: error.message });
      return [];
    }
  }).sort((a: any, b: any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const currencies = [...totals.keys()].sort();
  return { caseId, stage: development.stage, sources: sourceDetails, records, unresolvedProductionExpenses,
    ...(options?.commercialSelection ? { unavailableExpenses } : {}),
    totals: currencies.map(currency => ({ currency, amount: totals.get(currency)!.toFixed(4) })),
    unsupportedCurrencies: currencies.filter(currency => !['CNY', 'USD'].includes(currency)),
    fingerprint: createHash('sha256').update(JSON.stringify({ caseId, stage: development.stage, sources: sourceDetails, records, unresolvedProductionExpenses })).digest('hex') };
}
