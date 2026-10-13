import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertFabricSealEligible, readFabricHistory } from './fabricBatchHistory';
import { sampleConsumerOriginProof, type SampleConsumerOriginProof } from '../samples/sampleConsumerSource';
import { sampleOriginFingerprint, snapshotSampleOrigin, type SampleOriginSnapshot } from '../samples/sampleOriginService';
import { createHash } from 'node:crypto';
import { assertDevelopmentVersionReadyForConsumption, type ExactDevelopmentVersionProof } from './developmentVersionGate';

export type ConfirmedSpecOrigin = {
  snapshot: SampleOriginSnapshot;
  sourceFingerprint: string;
  evidenceAuditIds: string[];
  exactDevelopmentVersionProof?: ExactDevelopmentVersionProof;
};
export type ConfirmedDevelopmentSpec = {
  specSnapshot: Record<string, unknown>;
  sampleOriginProof: SampleConsumerOriginProof | null;
  confirmedSpecification: Record<string, unknown>;
};
export type ConfirmedDevelopmentSpecInput = {
  sourceType: 'Sample' | 'SealSample'; sourceId: string; caseId: string; factoryRelationId: string;
  asset: { id: string; sku: string; name: string; mainCategory: string };
  origins: ConfirmedSpecOrigin[]; sampleOriginProof?: SampleConsumerOriginProof | null;
};
const reject = (): never => {
  throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '确认规格版本未能核验，请核对原确认依据；不能使用档案当前规格替代。');
};
const json = (v: any): any => JSON.parse(JSON.stringify(v, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
const same = (a: any, b: any) => JSON.stringify(canonical(json(a))) === JSON.stringify(canonical(json(b)));
const ids = (values: string[]) => [...new Set(values)].sort();
const raw = (v: unknown): unknown => v ?? null;

/** Preserve the accepted text. A number without a unit does not imply gsm/cm. */
function measure(value: unknown, family: 'weight' | 'width') {
  const text = typeof value === 'string' ? value : null;
  const match = text?.trim().match(/^(\d+(?:\.\d+)?)\s*(.*?)$/);
  const numeric = match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
  const token = match?.[2].toLowerCase() ?? '';
  const unit = family === 'weight'
    ? /^(gsm|g\/m²|g\/m2|g\/m\^2)$/.test(token) ? 'gsm' : null
    : /^(cm|mm|m)$/.test(token) ? token : /^(in|inch|inches|")$/.test(token) ? 'inch' : null;
  return { text, value: numeric, unit };
}

/** Internal pure projection of already checked immutable origins, never a public request DTO. */
export function buildConfirmedDevelopmentSpec(input: ConfirmedDevelopmentSpecInput): ConfirmedDevelopmentSpec {
  if (!['Sample', 'SealSample'].includes(input.sourceType) || !input.sourceId || !input.caseId || !input.factoryRelationId
    || !Array.isArray(input.origins) || !input.origins.length || input.origins.some(o => !o?.snapshot?.batch || !o.snapshot.content)) reject();
  const origins = [...input.origins].sort((a, b) => a.snapshot.batch.id.localeCompare(b.snapshot.batch.id));
  if (ids(origins.map(o => o.snapshot.batch.id)).length !== origins.length) reject();
  for (const o of origins) {
    const version = o.snapshot.version;
    if (o.snapshot.schemaVersion !== 1 || o.snapshot.batch.caseId !== input.caseId || o.snapshot.batch.factoryId !== input.factoryRelationId
      || !version || typeof version.updatedAt !== 'string' || !/^\d+$/.test(version.updatedAt)
      || (version.historyRevision !== null && (!Number.isSafeInteger(version.historyRevision) || version.historyRevision < 0))
      || (version.eventId !== null && (typeof version.eventId !== 'string' || !version.eventId))
      || !Number.isSafeInteger(o.snapshot.batch.sourceRound) || o.snapshot.batch.sourceRound < 1
      || o.sourceFingerprint !== sampleOriginFingerprint(o.snapshot) || !o.evidenceAuditIds.length || o.evidenceAuditIds.some(id => !id)) reject();
  }
  const content: any = origins[0].snapshot.content.caseContent;
  if (!content || !['fabric', 'garment'].includes(content.type) || String(input.asset.mainCategory).toLowerCase() !== content.type
    || origins.some(o => !same(o.snapshot.content.caseContent, content))) reject();
  const spec: Record<string, unknown> = { sku: input.asset.sku, name: input.asset.name, mainCategory: input.asset.mainCategory,
    catalogIdentity: { productAssetId: input.asset.id, sku: input.asset.sku, name: input.asset.name } };
  if (content.type === 'fabric') {
    const weight = measure(content.specWeight, 'weight'), width = measure(content.specWidth, 'width');
    spec.fabric = { composition: raw(content.specComposition), construction: raw(content.specWeave), finish: raw(content.specFinish),
      weightText: raw(content.specWeight), weightValue: weight.value, weightUnit: weight.unit, weightValueGsm: weight.unit === 'gsm' ? weight.value : null,
      widthText: raw(content.specWidth), widthValue: width.value, widthUnit: width.unit,
      articleNo: null, yarnCount: null, pattern: null, millQuality: null, millColorCode: null };
  } else {
    spec.garment = { styleNo: raw(content.styleSpec), sizeSpec: raw(content.sizeSpec), mainFabric: raw(content.fabricSpec),
      constructionNote: raw(content.processSpec), processSpec: raw(content.processSpec),
      silhouette: null, fit: null, liningFabric: null, sizeRange: null, baseSize: null };
  }
  const basis = { schemaVersion: 1, sourceType: input.sourceType, sourceId: input.sourceId, caseId: input.caseId,
    factoryRelationId: input.factoryRelationId, family: content.type, caseContent: content,
    origins: origins.map(o => ({ snapshot: o.snapshot, sourceFingerprint: o.sourceFingerprint, evidenceAuditIds: ids(o.evidenceAuditIds) })) };
  const confirmedSpecification = json({ ...basis, contentFingerprint: createHash('sha256').update(JSON.stringify(canonical(basis))).digest('hex') });
  const exactProofs = origins.map(o => o.exactDevelopmentVersionProof ?? o.snapshot.content.exactDevelopmentVersionProof as any).filter(Boolean);
  if (exactProofs.length) {
    if (exactProofs.length !== origins.length || ids(exactProofs.map(proof => proof.sampleVersionId)).length !== 1
      || exactProofs.some(proof => proof.caseId !== input.caseId || proof.sampleVersionId !== (origins[0].snapshot.batch.selectedSampleVersionId ?? origins[0].snapshot.batch.sampleVersionId))) reject();
    spec.exactDevelopmentVersionProof = exactProofs[0];
    const version = exactProofs[0].sourceSnapshot?.version;
    const familySpec = content.type === 'fabric' ? spec.fabric : spec.garment;
    Object.assign(familySpec as object, { factoryRequirements: version?.factoryRequirements ?? null, minorChangeNote: version?.minorChangeNote ?? null });
  }
  return { specSnapshot: json({ ...spec, confirmedSpecification,
    ...(input.sampleOriginProof ? { sampleOriginProof: input.sampleOriginProof } : {}) }),
  confirmedSpecification, sampleOriginProof: input.sampleOriginProof ?? null };
}

/** Caller owns source authorization/transaction locks. Facts are read from DB, not caller snapshots. */
export async function loadConfirmedDevelopmentSpec(db: any, input: {
  sourceType: 'Sample' | 'SealSample'; sourceId: string; productAssetId: string;
  caseId?: string; factoryRelationId?: string | null;
}): Promise<ConfirmedDevelopmentSpec> {
  let caseId: string, factoryId: string, origins: ConfirmedSpecOrigin[], proof: SampleConsumerOriginProof | null = null;
  if (input.sourceType === 'Sample') {
    const sample = await db.sample.findFirst({ where: { id: input.sourceId, deletedAt: null } });
    if (!sample || !['sealed', 'approved', 'confirmed'].includes(sample.status) || !sample.sourceCaseId || !sample.supplierRelationId
      || sample.productAssetId !== input.productAssetId) reject();
    caseId = sample.sourceCaseId; factoryId = sample.supplierRelationId;
    const checkedProof = await sampleConsumerOriginProof(db, sample);
    if (!checkedProof || !checkedProof.origins.length) return reject();
    proof = checkedProof;
    const bindings = await db.sampleSource.findMany({ where: { sampleId: sample.id }, orderBy: { id: 'asc' } });
    if (bindings.length !== checkedProof.origins.length) reject();
    origins = await Promise.all(bindings.map(async (b: any) => {
      const verified = checkedProof.origins.find(o => o.id === b.id);
      if (!verified || verified.sourceFingerprint !== b.sourceFingerprint || verified.evidenceAuditId !== b.evidenceAuditId) reject();
      const approvals = checkedProof.nativeApprovals.filter(a => a.sampleBatchId === b.sampleBatchId).flatMap(a => a.auditIds);
      const seals = checkedProof.nativeSealApprovals.filter(a => a.sealId === b.sourceSealId).flatMap(a => a.events.map(e => e.auditId));
      if (!approvals.length) reject();
      const versionId = b.sourceSnapshot?.batch?.selectedSampleVersionId ?? b.sourceSnapshot?.batch?.sampleVersionId;
      if (!versionId) reject();
      const current = await assertDevelopmentVersionReadyForConsumption(db, caseId, versionId);
      const frozen = b.sourceSnapshot?.content?.exactDevelopmentVersionProof;
      if (frozen && (frozen.sampleVersionId !== versionId || !same(frozen.sourceSnapshot, current.exactDevelopmentVersionProof.sourceSnapshot))) reject();
      return { snapshot: b.sourceSnapshot, sourceFingerprint: b.sourceFingerprint, evidenceAuditIds: ids([b.evidenceAuditId, ...approvals, ...seals]),
        exactDevelopmentVersionProof: frozen ?? current.exactDevelopmentVersionProof };
    }));
  } else if (input.sourceType === 'SealSample') {
    const seal = await db.sealSample.findFirst({ where: { id: input.sourceId, deletedAt: null } });
    if (!seal || !['sealed', 'converted'].includes(seal.status) || seal.convertedProductAssetId !== input.productAssetId) reject();
    caseId = seal.developmentCaseId; factoryId = seal.supplierRelationId;
    await assertFabricSealEligible(db, seal);
    const links = await db.sealSampleBatch.findMany({ where: { sealSampleId: seal.id } });
    const batches = await db.sampleBatch.findMany({ where: { id: { in: links.map((l: any) => l.sampleBatchId) }, deletedAt: null } });
    const development = await db.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
    if (!development || development.type !== 'fabric' || !links.length || links.length !== batches.length) reject();
    const events = batches.map((b: any) => [...readFabricHistory(b).events].reverse().find(e => e.kind === 'seal' && e.round === b.round && e.after.sealId === seal.id));
    if (events.some((e: any) => !e) || ids(events.map((e: any) => e.auditId)).length !== 1) reject();
    const audit = await db.auditLog.findUnique({ where: { id: events[0]!.auditId } });
    const facts = audit?.detail?.after?.batchFacts;
    if (!audit || audit.action !== 'seal_sample_confirm' || audit.targetType !== 'SealSample' || audit.targetId !== seal.id
      || audit.detail?.source !== 'route:dev:fabric-seal' || events.some((e: any) => e.actorId !== audit.actorId)
      || !Array.isArray(facts) || facts.length !== batches.length || ids(facts.map((f: any) => f.batchId)).length !== batches.length) reject();
    origins = await Promise.all(batches.map(async (batch: any) => {
      const frozen = facts.find((f: any) => f.batchId === batch.id)?.originSnapshot;
      if (!frozen || sampleOriginFingerprint(frozen) !== sampleOriginFingerprint(snapshotSampleOrigin(batch, development))) reject();
      if (batch.sampleVersionId) {
        const current = await assertDevelopmentVersionReadyForConsumption(db, caseId, batch.sampleVersionId);
        const proof = facts.find((f: any) => f.batchId === batch.id)?.exactDevelopmentVersionProof;
        if (!proof || proof.sampleVersionId !== batch.sampleVersionId || !same(proof.sourceSnapshot, current.exactDevelopmentVersionProof.sourceSnapshot)) reject();
        return { snapshot: frozen, sourceFingerprint: sampleOriginFingerprint(frozen),
          evidenceAuditIds: ids([audit.id, proof.qualityCompletionAuditId, proof.confirmationAuditId]), exactDevelopmentVersionProof: proof };
      }
      const approve = [...readFabricHistory(batch).events].reverse().find(e => e.kind === 'approve' && e.round === batch.round);
      if (!approve) reject();
      return { snapshot: frozen, sourceFingerprint: sampleOriginFingerprint(frozen), evidenceAuditIds: ids([audit.id, approve!.auditId]) };
    }));
  } else return reject();
  if (input.caseId && input.caseId !== caseId || input.factoryRelationId && input.factoryRelationId !== factoryId) reject();
  const asset = await db.productAsset.findUnique({ where: { id: input.productAssetId } });
  if (!asset || asset.deletedAt != null) reject();
  for (const origin of origins) {
    const exactVersionId = origin.snapshot.batch.selectedSampleVersionId ?? origin.snapshot.batch.sampleVersionId;
    if (!exactVersionId || asset.sourceDevelopmentCaseId !== caseId || asset.sourceSampleVersionId !== exactVersionId) reject();
  }
  return buildConfirmedDevelopmentSpec({ sourceType: input.sourceType, sourceId: input.sourceId, caseId, factoryRelationId: factoryId, asset, origins, sampleOriginProof: proof });
}
