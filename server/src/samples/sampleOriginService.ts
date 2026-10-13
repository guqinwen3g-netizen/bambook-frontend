import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { assertFabricBatchEvidence, assertFabricSealEligible, fabricBatchEligibility, readFabricHistory } from '../development/fabricBatchHistory';
import { assertNativeGarmentRound, garmentCaseContent, garmentRoundContent } from '../development/garmentNativeSourceEvidence';
import { assertDevelopmentVersionReadyForConsumption } from '../development/developmentVersionGate';

export type SampleOriginSnapshot = {
  schemaVersion: 1;
  batch: { id: string; code: string; caseId: string; factoryId: string; sampleType: string; sourceRound: number;
    sampleVersionId?: string | null; selectedSampleVersionId?: string | null; versionLabel?: string | null; parentBatchId?: string | null; minorVersion?: number; minorChangeNote?: string | null };
  content: Record<string, unknown>;
  version: { updatedAt: string; historyRevision: number | null; eventId: string | null };
};
export type SampleOriginBinding = {
  id: string; sampleId: string; sampleBatchId: string; sourceRound: number; sourceSealId: string | null;
  sourceSnapshot: SampleOriginSnapshot; sourceFingerprint: string; sourceUpdatedAt: string;
  sourceHistoryRevision: number | null; sourceEventId: string | null; evidenceAuditId: string;
  boundAt: string; boundBy: string; provenance: string;
};
export type SampleOriginContext = {
  status: 'resolved' | 'unresolved' | 'conflict'; currentUsable: boolean; reasons: string[];
  projectionKey: string | null; originKind: 'canonical' | 'inherited' | 'physical' | 'unknown'; origins: SampleOriginBinding[];
  nativeApprovals?: Array<{ sampleBatchId: string; sourceRound: number; eventId: string | null; auditIds: string[] }>;
  nativeSealApprovals?: Array<{ sealId: string; events: Array<{ sampleBatchId: string; eventId: string; auditId: string }> }>;
};
export type SampleOriginCommand = {
  batchId: string; sourceRound: number; expectedUpdatedAt: string; expectedHistoryRevision?: number | null; expectedFactoryId?: string; expectedEventId?: string | null; expectedContentFingerprint?: string;
};
export type SampleSealOriginCommand = { sealId: string; expectedUpdatedAt: string; expectedFactoryId?: string; components: SampleOriginCommand[] };
export type SampleOriginLockHints = { caseIds: string[]; sealIds: string[]; batchIds: string[] };
const safe = (value: any): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: any, b: any) => JSON.stringify(canonical(safe(a))) === JSON.stringify(canonical(safe(b)));
const ids = (values: any[]) => [...new Set(values.filter(Boolean).map(String))].sort();
const reject = (message: string): never => { throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', message); };
const sourceSnapshotForStoredShape = (current: SampleOriginSnapshot, stored: any): SampleOriginSnapshot => {
  // Schema v1 source bindings written before the version-label fields remain
  // verifiable. Compare only fields that the immutable historical snapshot had.
  const batch:any={...current.batch};
  for(const field of ['sampleVersionId','versionLabel','parentBatchId','minorVersion','minorChangeNote'])
    if(!Object.prototype.hasOwnProperty.call(stored?.batch??{},field))delete batch[field];
  return {...current,batch};
};

function currentSnapshotForStoredOrigin(batch: any, development: any, stored: SampleOriginSnapshot): SampleOriginSnapshot {
  return stored.batch?.selectedSampleVersionId ? snapshotSealedGarmentOrigin(batch, development) : snapshotSampleOrigin(batch, development);
}

/** Identity deliberately excludes workflow status, updatedAt, approval and hashes. */
export function sampleProjectionKey(kind: 'garment_pp' | 'fabric_output', batchId: string, sourceRound: number, sampleVersionId?: string): string {
  if (!batchId || !Number.isSafeInteger(sourceRound) || sourceRound < 1) reject('样品来源批次或轮次不完整');
  return sampleVersionId && kind === 'garment_pp' ? `v2:${kind}:${batchId}:${sourceRound}:${sampleVersionId}` : `v1:${kind}:${batchId}:${sourceRound}`;
}
export function sealProjectionKey(sealId: string): string {
  if (!sealId) reject('封样来源不完整');
  return `v1:seal_output:${sealId}`;
}

/** Content proof is separate from mutable lifecycle/version tokens. */
export function sampleOriginFingerprint(snapshot: SampleOriginSnapshot): string {
  return createHash('sha256').update(JSON.stringify(canonical({ schemaVersion: snapshot.schemaVersion, batch: snapshot.batch, content: snapshot.content }))).digest('hex');
}
export function snapshotSampleOrigin(batch: any, development: any): SampleOriginSnapshot {
  if (!batch || batch.deletedAt != null || !development || development.deletedAt != null
    || batch.developmentCaseId !== development.id || !batch.supplierRelationId
    || !Number.isSafeInteger(batch.round) || batch.round < 1 || !/^\d+$/.test(String(batch.updatedAt))) reject('样品批次的开发案、工厂或来源轮次不完整');
  const garment = batch.sampleType === 'garment-round';
  if (garment ? development.type !== 'garment' : development.type !== 'fabric' || !['lab-dip', 'handloom', 'yardage'].includes(batch.sampleType)) {
    reject('样品批次与开发业务线不一致，不能猜测 pp/trim 或其他来源');
  }
  const a = batch.attachments ?? {};
  const history = garment ? null : readFabricHistory(batch);
  const content = garment ? {
    version: batch.version ?? a.version ?? null, purpose: batch.purpose ?? a.purpose ?? null,
    materialConfig: batch.materialConfig ?? a.materialConfig ?? null,
    caseContent: { type: development.type, customerRelationId: development.customerRelationId ?? null,
      styleSpec: development.styleSpec ?? null, sizeSpec: development.sizeSpec ?? null,
      fabricSpec: development.fabricSpec ?? null, processSpec: development.processSpec ?? null },
  } : { specNote: batch.specNote ?? null, dyeLotNo: batch.dyeLotNo ?? null, photos: batch.photos ?? null,
    caseContent: { type: development.type, customerRelationId: development.customerRelationId ?? null,
      source: development.source ?? null, dyeMethod: development.dyeMethod ?? null,
      specComposition: development.specComposition ?? null, specWeight: development.specWeight ?? null,
      specWidth: development.specWidth ?? null, specWeave: development.specWeave ?? null, specFinish: development.specFinish ?? null } };
  return safe({ schemaVersion: 1, batch: { id: batch.id, code: batch.batchCode, caseId: development.id,
    factoryId: batch.supplierRelationId, sampleType: batch.sampleType, sourceRound: batch.round,
    sampleVersionId: batch.sampleVersionId ?? null,
    versionLabel: batch.versionLabel ?? null, parentBatchId: batch.parentBatchId ?? null,
    minorVersion: Number.isSafeInteger(batch.minorVersion) ? batch.minorVersion : 0,
    minorChangeNote: batch.minorChangeNote ?? null }, content,
  version: { updatedAt: String(batch.updatedAt), historyRevision: history?.revision ?? null, eventId: history?.events[history.events.length - 1]?.id ?? null } });
}

/** A version-specific PP business projection shares physical ancestry. The
 * original warehouse receipt uses snapshotSampleOrigin and stays unchanged. */
export function snapshotSealedGarmentOrigin(batch: any, development: any): SampleOriginSnapshot {
  const base = snapshotSampleOrigin(batch, development), a = batch.attachments ?? {};
  const proof = a.sealedDevelopmentVersionProof;
  if (batch.sampleType !== 'garment-round' || !a.sealedVersionId || proof?.sampleVersionId !== a.sealedVersionId
    || proof.physicalSampleVersionId !== batch.sampleVersionId || proof.physicalSampleBatchId !== batch.id)
    reject('产前样必须保留准确封样版本与同一原实物来源');
  return safe({ ...base, batch: { ...base.batch, selectedSampleVersionId: a.sealedVersionId },
    content: { ...base.content, exactDevelopmentVersionProof: proof } });
}
function validBinding(row: any): boolean {
  const snapshot = row.sourceSnapshot;
  return !!snapshot && snapshot.schemaVersion === 1 && snapshot.batch?.id === row.sampleBatchId
    && snapshot.batch?.sourceRound === row.sourceRound && !!snapshot.batch?.caseId && !!snapshot.batch?.factoryId
    && Number.isSafeInteger(row.sourceRound) && row.sourceRound > 0 && snapshot.content != null
    && typeof snapshot.version?.updatedAt === 'string' && snapshot.version.updatedAt === String(row.sourceUpdatedAt)
    && snapshot.version.historyRevision === (row.sourceHistoryRevision ?? null)
    && snapshot.version.eventId === (row.sourceEventId ?? null)
    && row.sourceFingerprint === sampleOriginFingerprint(snapshot) && !!row.evidenceAuditId && !!row.boundBy
    && ['native', 'recorded_exact', 'current_link_recorded', 'inherited'].includes(row.provenance);
}
const serializeBinding = (row: any): SampleOriginBinding => ({ ...row, sourceUpdatedAt: String(row.sourceUpdatedAt), boundAt: String(row.boundAt),
  sourceSealId: row.sourceSealId ?? null, sourceHistoryRevision: row.sourceHistoryRevision ?? null, sourceEventId: row.sourceEventId ?? null });

/** Batched exact-source read. A known lane does not imply a known physical origin.
 * Historic identity stays readable when current use becomes invalid. */
export async function readSampleOriginContexts(db: any, samples: any[]): Promise<SampleOriginContext[]> {
  if (!samples.length) return [];
  const rows = await db.sampleSource.findMany({ where: { sampleId: { in: ids(samples.map(sample => sample.id)) } }, orderBy: { id: 'asc' } });
  const [batches, cases, seals, sealLinks] = await Promise.all([
    rows.length ? db.sampleBatch.findMany({ where: { id: { in: ids(rows.map((row: any) => row.sampleBatchId)) } } }) : [],
    rows.length ? db.developmentCase.findMany({ where: { id: { in: ids(rows.map((row: any) => row.sourceSnapshot?.batch?.caseId)) } } }) : [],
    rows.some((row: any) => row.sourceSealId) ? db.sealSample.findMany({ where: { id: { in: ids(rows.map((row: any) => row.sourceSealId)) } } }) : [],
    rows.some((row: any) => row.sourceSealId) ? db.sealSampleBatch.findMany({ where: { sealSampleId: { in: ids(rows.map((row: any) => row.sourceSealId)) } } }) : [],
  ]);
  const nativeAuditIds: string[] = [];
  for (const batch of batches) if (batch.sampleType !== 'garment-round') {
    try { nativeAuditIds.push(...readFabricHistory(batch).events.map(event => event.auditId)); } catch { /* Invalid source becomes explicit below. */ }
  }
  const audits = rows.length ? await db.auditLog.findMany({ where: { OR: [
    { id: { in: ids([...nativeAuditIds, ...rows.map((row: any) => row.evidenceAuditId)]) } },
    { targetType: 'DevelopmentCase', targetId: { in: cases.map((row: any) => row.id) }, action: { in: ['submit_garment_sample_qc','confirm_garment_sample'] } },
    { targetType: 'SealSample', targetId: { in: seals.map((row: any) => row.id) }, action: 'seal_sample_confirm' },
  ] } }) : [];
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]: any) => value && typeof value === 'object' && 'in' in value ? value.in.includes(row[key]) : row[key] === value);
  const evidenceDb = {
    auditLog: { findFirst: async ({ where }: any) => audits.find((row: any) => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => audits.filter((row: any) => matches(row, where)) },
    sealSampleBatch: { findMany: async ({ where }: any) => sealLinks.filter((row: any) => matches(row, where)) },
    sampleBatch: { findMany: async ({ where }: any) => batches.filter((row: any) => matches(row, where)) },
  };
  const nativeInvalid = new Set<string>();
  const approvalVersionUnknown = new Set<string>();
  const nativeApprovals = new Map<string, NonNullable<SampleOriginContext['nativeApprovals']>[number]>();
  for (const batch of batches) {
    if (batch.sampleVersionId) {
      // These are current native DB reads. Dependency errors must propagate;
      // only minted business failures mark a historically readable origin bad.
      try {
        if (batch.sampleType === 'garment-round') {
          await assertNativeGarmentRound(db, batch, true);
          const frozen = batch.attachments?.sealedDevelopmentVersionProof;
          nativeApprovals.set(batch.id, { sampleBatchId: batch.id, sourceRound: batch.round, eventId: null,
            auditIds: ids([frozen.qualityCompletionAuditId, frozen.confirmationAuditId]) });
        } else {
          const current = await assertDevelopmentVersionReadyForConsumption(db, batch.developmentCaseId, batch.sampleVersionId);
          nativeApprovals.set(batch.id, { sampleBatchId: batch.id, sourceRound: batch.round, eventId: null,
            auditIds: ids([current.exactDevelopmentVersionProof.qualityCompletionAuditId, current.exactDevelopmentVersionProof.confirmationAuditId]) });
        }
      } catch (error) { if (!(error instanceof DevelopmentDomainError)) throw error; nativeInvalid.add(batch.id); }
      continue;
    }
    try {
      if (batch.sampleType === 'garment-round') {
        await assertNativeGarmentRound(evidenceDb, batch, true);
        const development = cases.find((item: any) => item.id === batch.developmentCaseId);
        const proofs = audits.filter((item: any) => item.targetType === 'DevelopmentCase' && item.targetId === batch.developmentCaseId
          && item.detail?.source === 'route:samples:garment-gate' && item.detail.after?.roundId === batch.id);
        const confirmation = batch.attachments?.confirmation;
        const exactAudits: string[] = [];
        const versionProven = ['submit_garment_sample_qc','confirm_garment_sample'].every(action => {
          const matching = proofs.filter((item: any) => item.action === action && (action === 'submit_garment_sample_qc'
            ? item.actorId === batch.qcReviewedBy && item.detail.after.qcStatus === 'passed'
              && String(item.detail.after.qcReviewedAt) === String(batch.qcReviewedAt)
            : item.actorId === confirmation?.registeredBy && item.detail.after.customerStatus === 'approved'
              && String(item.detail.after.registeredAt) === String(confirmation?.registeredAt)
              && item.detail.after.confirmationDate === confirmation?.date && item.detail.after.channel === confirmation?.channel));
          const latest = [...matching].sort((a: any,b: any) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
          if (latest) exactAudits.push(latest.id);
          return !!latest?.detail.after.caseContent && same(latest.detail.after.caseContent, garmentCaseContent(development))
            && !!latest.detail.after.roundContent && same(latest.detail.after.roundContent, garmentRoundContent(batch));
        });
        if (!versionProven) approvalVersionUnknown.add(batch.id);
        else nativeApprovals.set(batch.id, { sampleBatchId: batch.id, sourceRound: batch.round, eventId: null, auditIds: ids(exactAudits) });
      }
      else {
        await assertFabricBatchEvidence(evidenceDb, batch);
        const approval = [...readFabricHistory(batch).events].reverse().find(event => event.round === batch.round && event.kind === 'approve');
        const audit = approval ? audits.find((item: any) => item.id === approval.auditId) : null;
        const frozen = audit?.detail?.after?.originSnapshot;
        const development = cases.find((item: any) => item.id === batch.developmentCaseId);
        if (!approval || !frozen || sampleOriginFingerprint(frozen) !== sampleOriginFingerprint(sourceSnapshotForStoredShape(snapshotSampleOrigin(batch, development),frozen))) approvalVersionUnknown.add(batch.id);
        else nativeApprovals.set(batch.id, { sampleBatchId: batch.id, sourceRound: batch.round, eventId: approval.id, auditIds: [approval.auditId] });
      }
    }
    catch { nativeInvalid.add(batch.id); } // Only cached evidence/data is examined here; query failures above still propagate.
  }
  const sealInvalid = new Set<string>();
  const nativeSealApprovals = new Map<string, NonNullable<SampleOriginContext['nativeSealApprovals']>[number]>();
  for (const seal of seals) {
    const nativeComponents = sealLinks.filter((link: any) => link.sealSampleId === seal.id).map((link: any) => batches.find((batch: any) => batch.id === link.sampleBatchId));
    try {
      if (seal.deletedAt != null || !['sealed','converted'].includes(seal.status)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封样来源失效');
      await assertFabricSealEligible(nativeComponents.some((batch: any) => batch?.sampleVersionId) ? db : evidenceDb, seal);
      const components = sealLinks.filter((link: any) => link.sealSampleId === seal.id).map((link: any) => batches.find((batch: any) => batch.id === link.sampleBatchId));
      const events = components.map((batch: any) => {
        const event = batch && [...readFabricHistory(batch).events].reverse().find(fact => fact.kind === 'seal' && fact.round === batch.round && fact.after.sealId === seal.id);
        if (!event) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封样缺少实际轮次的封样事实');
        return { sampleBatchId: batch.id, eventId: event.id, auditId: event.auditId };
      }).sort((left: any, right: any) => left.sampleBatchId.localeCompare(right.sampleBatchId));
      nativeSealApprovals.set(seal.id, { sealId: seal.id, events });
    }
    catch (error) { if (nativeComponents.some((batch: any) => batch?.sampleVersionId) && !(error instanceof DevelopmentDomainError)) throw error; sealInvalid.add(seal.id); }
  }
  const batchMap = new Map(batches.map((row: any) => [row.id, row])), caseMap = new Map(cases.map((row: any) => [row.id, row])), auditMap = new Map(audits.map((row: any) => [row.id, row]));
  return samples.map(sample => {
    const owned = rows.filter((row: any) => row.sampleId === sample.id), reasons: string[] = [];
    let conflict = false;
    if (!owned.length) reasons.push('NO_EXACT_ORIGIN');
    for (const row of owned) {
      if (!validBinding(row)) { reasons.push('ORIGIN_SNAPSHOT_INVALID'); conflict = true; continue; }
      const b = row.sourceSnapshot.batch, audit: any = auditMap.get(row.evidenceAuditId);
      const fact = audit?.detail?.after?.origins?.find((item: any) => item.sampleBatchId === row.sampleBatchId && item.sourceRound === row.sourceRound);
      if (!audit || audit.actorId !== row.boundBy || audit.targetType !== 'Sample' || audit.targetId !== sample.id
        || audit.detail?.source !== 'route:samples:origin' || !['bind_sample_origins','inherit_sample_origins'].includes(audit.action)
        || audit.detail.after.origins.length !== owned.length
        || (audit.detail.after.projectionKey ?? null) !== (sample.projectionKey ?? null)
        || !fact || fact.sourceFingerprint !== row.sourceFingerprint || !same(fact.sourceSnapshot, row.sourceSnapshot)
        || fact.provenance !== row.provenance || (fact.sourceSealId ?? null) !== (row.sourceSealId ?? null)) {
        reasons.push('ORIGIN_BINDING_AUDIT_MISSING'); conflict = true;
      }
      if (sample.sourceCaseId !== b.caseId || (sample.supplierRelationId ?? null) !== b.factoryId) { reasons.push('SAMPLE_ORIGIN_IDENTITY_CONFLICT'); conflict = true; }
      const batch: any = batchMap.get(row.sampleBatchId), development: any = caseMap.get(b.caseId);
      if (!batch || batch.deletedAt != null || !development || development.deletedAt != null) { reasons.push('ORIGIN_PARENT_MISSING_OR_DELETED'); continue; }
      if (batch.developmentCaseId !== b.caseId || batch.supplierRelationId !== b.factoryId || batch.sampleType !== b.sampleType) { reasons.push('ORIGIN_PARENT_IDENTITY_CHANGED'); continue; }
      if (batch.round !== row.sourceRound) { reasons.push('ORIGIN_ROUND_SUPERSEDED'); continue; }
      try {
        if (sampleOriginFingerprint(sourceSnapshotForStoredShape(currentSnapshotForStoredOrigin(batch, development, row.sourceSnapshot),row.sourceSnapshot)) !== row.sourceFingerprint) reasons.push('ORIGIN_CONTENT_CHANGED');
      } catch { reasons.push('ORIGIN_PARENT_INVALID'); }
      if (batch.sampleVersionId) {
        if (batch.sampleType === 'garment-round' && batch.attachments?.sealedRoundStatus !== 'sealed') reasons.push('ORIGIN_NOT_CURRENTLY_APPROVED');
      } else if (batch.sampleType === 'garment-round') {
        if (batch.status !== 'approved' || batch.qcStatus !== 'passed' || batch.customerStatus && batch.customerStatus !== 'approved'
          || batch.attachments?.sealedRoundStatus !== 'sealed') reasons.push('ORIGIN_NOT_CURRENTLY_APPROVED');
      } else {
        try { if (!fabricBatchEligibility(batch).eligible) reasons.push('ORIGIN_NOT_CURRENTLY_APPROVED'); }
        catch { reasons.push('ORIGIN_PARENT_INVALID'); }
      }
      if (nativeInvalid.has(batch.id)) reasons.push('ORIGIN_NATIVE_APPROVAL_EVIDENCE_INVALID');
      if (approvalVersionUnknown.has(batch.id)) reasons.push('ORIGIN_APPROVAL_VERSION_UNPROVEN');
      if (row.sourceSealId) {
        const seal = seals.find((item: any) => item.id === row.sourceSealId);
        const exactBatchIds = ids(owned.filter((item: any) => item.sourceSealId === row.sourceSealId).map((item: any) => item.sampleBatchId));
        const currentBatchIds = ids(sealLinks.filter((item: any) => item.sealSampleId === row.sourceSealId).map((item: any) => item.sampleBatchId));
        if (!seal || seal.deletedAt != null) reasons.push('ORIGIN_SEAL_MISSING_OR_DELETED');
        else if (seal.developmentCaseId !== b.caseId || seal.supplierRelationId !== b.factoryId || !same(exactBatchIds, currentBatchIds)) reasons.push('ORIGIN_SEAL_COMPONENTS_CHANGED');
        else if (sealInvalid.has(seal.id)) reasons.push('ORIGIN_SEAL_EVIDENCE_INVALID');
        else {
          const exactSealAudit = audits.find((item: any) => item.targetType === 'SealSample' && item.targetId === seal.id && item.action === 'seal_sample_confirm'
            && item.detail?.source === 'route:dev:fabric-seal' && Array.isArray(item.detail?.after?.batchFacts)
            && item.detail.after.batchFacts.length === exactBatchIds.length
            && owned.filter((origin: any) => origin.sourceSealId === seal.id).every((origin: any) => item.detail.after.batchFacts.some((fact: any) => fact.batchId === origin.sampleBatchId
              && fact.originSnapshot?.batch?.sourceRound === origin.sourceRound && sampleOriginFingerprint(fact.originSnapshot) === origin.sourceFingerprint)));
          if (!exactSealAudit) reasons.push('ORIGIN_SEAL_VERSION_UNPROVEN');
        }
      }
    }
    if (sample.projectionKey) {
      let expectedProjection: string | null = null;
      const sealIds = ids(owned.map((row: any) => row.sourceSealId));
      try {
        if (sealIds.length === 1 && owned.every((row: any) => row.sourceSealId === sealIds[0])) {
          expectedProjection = sealProjectionKey(sealIds[0]);
        } else if (owned.length === 1 && !owned[0].sourceSealId) {
          const origin = owned[0], type = origin.sourceSnapshot?.batch?.sampleType;
          if (type === 'garment-round') expectedProjection = sampleProjectionKey('garment_pp', origin.sampleBatchId, origin.sourceRound, origin.sourceSnapshot.batch.selectedSampleVersionId ?? undefined);
          else if (['lab-dip', 'handloom', 'yardage'].includes(type)) expectedProjection = sampleProjectionKey('fabric_output', origin.sampleBatchId, origin.sourceRound);
        }
      } catch { /* Malformed identity is reported with the other read reasons. */ }
      if (expectedProjection !== sample.projectionKey) { conflict = true; reasons.push('ORIGIN_PROJECTION_IDENTITY_CONFLICT'); }
    }
    const factories = ids(owned.map((row: any) => row.sourceSnapshot?.batch?.factoryId)), caseIds = ids(owned.map((row: any) => row.sourceSnapshot?.batch?.caseId));
    if (factories.length > 1 || caseIds.length > 1) { conflict = true; reasons.push('ORIGIN_COMPONENT_IDENTITY_CONFLICT'); }
    return { status: conflict ? 'conflict' : owned.length ? 'resolved' : 'unresolved', currentUsable: owned.length > 0 && !reasons.length,
      reasons: [...new Set(reasons)], projectionKey: sample.projectionKey ?? null,
      nativeApprovals: ids(owned.map((row: any) => row.sampleBatchId)).flatMap(id => nativeApprovals.has(id) ? [nativeApprovals.get(id)!] : []),
      nativeSealApprovals: ids(owned.map((row: any) => row.sourceSealId)).flatMap(id => nativeSealApprovals.has(id) ? [nativeSealApprovals.get(id)!] : []),
      originKind: !owned.length ? 'unknown' : sample.projectionKey ? 'canonical' : owned.every((row: any) => row.provenance === 'inherited') ? 'inherited' : 'physical',
      origins: owned.map(serializeBinding) };
  });
}
export function assertSampleOriginUsable(context: SampleOriginContext): void {
  if (context.status !== 'resolved' || !context.currentUsable) reject('样品的精确批次、来源轮次或冻结版本未能核对，不能继续业务事实操作；请保留原实物并核对来源。');
}
/** Physical custody/ancestry is independent of approval. Unknown legacy rows
 * retain unknown identity; an existing invalid binding may not be inherited. */
export function assertSampleOriginIdentity(context: SampleOriginContext): void {
  if (!context.origins.length && context.status === 'unresolved') return;
  if (context.status !== 'resolved' || context.reasons.some(reason => ['ORIGIN_PARENT_MISSING_OR_DELETED', 'ORIGIN_PARENT_IDENTITY_CHANGED', 'ORIGIN_PARENT_INVALID', 'ORIGIN_SEAL_MISSING_OR_DELETED', 'ORIGIN_SEAL_COMPONENTS_CHANGED'].includes(reason))) {
    reject('样品冻结来源或存续主体未能核对，不能更换或继承实物身份');
  }
}

/** Discover the entire parent set before any Sample lock. Caller must re-read
 * bindings after locks; Case→Seal→Batch→Order→Asset→Sample→Card, sorted per kind. */
export async function sampleOriginLockHints(db: any, sampleIds: string[]): Promise<SampleOriginLockHints> {
  const rows = sampleIds.length ? await db.sampleSource.findMany({ where: { sampleId: { in: ids(sampleIds) } } }) : [];
  const sealIds = ids(rows.map((row: any) => row.sourceSealId));
  const [seals, links] = await Promise.all([
    sealIds.length ? db.sealSample.findMany({ where: { id: { in: sealIds } }, select: { id: true, developmentCaseId: true } }) : [],
    sealIds.length ? db.sealSampleBatch.findMany({ where: { sealSampleId: { in: sealIds } } }) : [],
  ]);
  const batchIds = ids([...rows.map((row: any) => row.sampleBatchId), ...links.map((row: any) => row.sampleBatchId)]);
  const batches = batchIds.length ? await db.sampleBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, developmentCaseId: true } }) : [];
  return { caseIds: ids([...rows.map((row: any) => row.sourceSnapshot?.batch?.caseId), ...seals.map((row: any) => row.developmentCaseId), ...batches.map((row: any) => row.developmentCaseId)]), sealIds, batchIds };
}
export async function lockSampleOriginParents(tx: any, hints: SampleOriginLockHints): Promise<void> {
  for (const id of ids(hints.caseIds)) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${id} FOR UPDATE`);
  for (const id of ids(hints.sealIds)) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SealSample" WHERE "id"=${id} FOR UPDATE`);
  for (const id of ids(hints.batchIds)) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${id} FOR UPDATE`);
}
export async function loadSampleOriginCommand(tx: any, caseId: string, command: SampleOriginCommand) {
  if (!command || Object.keys(command).some(key => !['batchId','sourceRound','expectedUpdatedAt','expectedHistoryRevision','expectedFactoryId','expectedEventId','expectedContentFingerprint'].includes(key))
    || typeof command.batchId !== 'string' || !command.batchId || !Number.isSafeInteger(command.sourceRound) || command.sourceRound < 1
    || typeof command.expectedUpdatedAt !== 'string' || !/^\d+$/.test(command.expectedUpdatedAt)
    || command.expectedFactoryId !== undefined && (typeof command.expectedFactoryId !== 'string' || !command.expectedFactoryId)
    || command.expectedHistoryRevision !== undefined && command.expectedHistoryRevision !== null && (!Number.isSafeInteger(command.expectedHistoryRevision) || command.expectedHistoryRevision < 0)
    || command.expectedEventId !== undefined && command.expectedEventId !== null && (typeof command.expectedEventId !== 'string' || !command.expectedEventId)
    || command.expectedContentFingerprint !== undefined && (typeof command.expectedContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(command.expectedContentFingerprint))) reject('请明确选择样品批次、来源轮次和原版本；不能用名称或附件推断来源');
  await lockSampleOriginParents(tx, { caseIds: [caseId], sealIds: [], batchIds: [command.batchId] });
  const batch = await tx.sampleBatch.findFirst({ where: { id: command.batchId, deletedAt: null } });
  const development = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
  const snapshot = snapshotSampleOrigin(batch, development);
  if (batch.developmentCaseId !== caseId || batch.round !== command.sourceRound || String(batch.updatedAt) !== command.expectedUpdatedAt
    || command.expectedHistoryRevision !== undefined && snapshot.version.historyRevision !== command.expectedHistoryRevision
    || command.expectedFactoryId !== undefined && snapshot.batch.factoryId !== command.expectedFactoryId
    || command.expectedEventId !== undefined && snapshot.version.eventId !== command.expectedEventId
    || command.expectedContentFingerprint !== undefined && sampleOriginFingerprint(snapshot) !== command.expectedContentFingerprint) reject('样品来源已变化，请重新读取批次轮次和版本');
  return { batch, development, snapshot };
}
export async function loadSealSampleOriginCommand(tx: any, caseId: string, command: SampleSealOriginCommand) {
  if (!command || Object.keys(command).some(key => !['sealId','expectedUpdatedAt','expectedFactoryId','components'].includes(key)) || !command.sealId
    || typeof command.expectedUpdatedAt !== 'string' || !/^\d+$/.test(command.expectedUpdatedAt)
    || !Array.isArray(command.components) || !command.components.length || ids(command.components.map(component => component.batchId)).length !== command.components.length) reject('请明确封样和全部组件的来源轮次、版本');
  await lockSampleOriginParents(tx, { caseIds: [caseId], sealIds: [command.sealId], batchIds: command.components.map(component => component.batchId) });
  const seal = await tx.sealSample.findFirst({ where: { id: command.sealId, deletedAt: null } });
  const links = await tx.sealSampleBatch.findMany({ where: { sealSampleId: command.sealId } });
  if (!seal || seal.developmentCaseId !== caseId || !['sealed','converted'].includes(seal.status) || String(seal.updatedAt) !== command.expectedUpdatedAt
    || command.expectedFactoryId !== undefined && command.expectedFactoryId !== seal.supplierRelationId
    || !same(ids(links.map((link: any) => link.sampleBatchId)), ids(command.components.map(component => component.batchId)))) reject('封样来源、版本或全部组件已变化');
  const sources = [];
  for (const component of [...command.components].sort((a,b) => a.batchId.localeCompare(b.batchId))) {
    const source = await loadSampleOriginCommand(tx, caseId, component);
    if (source.development.type !== 'fabric' || source.batch.supplierRelationId !== seal.supplierRelationId) reject('封样必须保留同一工厂的完整批次组合');
    sources.push(source);
  }
  await assertFabricSealEligible(tx, seal);
  return { seal, development: sources[0].development, snapshots: sources.map(source => source.snapshot), factoryId: seal.supplierRelationId };
}

/** Internal transaction helper. Authorization and physical creation are owned
 * by native caller; requests never supply snapshots, fingerprints or provenance. */
export async function bindSampleOrigins(tx: any, sample: any, snapshots: SampleOriginSnapshot[], actorId: string, options: { sourceSealId?: string; provenance?: 'native' | 'recorded_exact' | 'current_link_recorded'; transactionId?: string; registrationRequest?: Record<string, unknown> } = {}): Promise<void> {
  if (!actorId || !snapshots.length || snapshots.some(s => s.batch.caseId !== sample.sourceCaseId || s.batch.factoryId !== sample.supplierRelationId)
    || ids(snapshots.map(s => s.batch.id + ':' + s.batch.sourceRound)).length !== snapshots.length) reject('样品与批次来源不一致或重复，不能绑定');
  const [currentBatches, development] = await Promise.all([
    tx.sampleBatch.findMany({ where: { id: { in: snapshots.map(snapshot => snapshot.batch.id) }, deletedAt: null } }),
    tx.developmentCase.findFirst({ where: { id: sample.sourceCaseId, deletedAt: null } }),
  ]);
  if (currentBatches.length !== snapshots.length || snapshots.some(snapshot => {
    const batch = currentBatches.find((row: any) => row.id === snapshot.batch.id);
    return !batch || batch.round !== snapshot.batch.sourceRound || String(batch.updatedAt) !== snapshot.version.updatedAt
      || sampleOriginFingerprint(currentSnapshotForStoredOrigin(batch, development, snapshot)) !== sampleOriginFingerprint(snapshot);
  })) reject('样品绑定时实际批次、来源轮次或冻结版本已变化');
  if (options.sourceSealId) {
    const seal = await tx.sealSample.findFirst({ where: { id: options.sourceSealId, deletedAt: null } });
    const links = await tx.sealSampleBatch.findMany({ where: { sealSampleId: options.sourceSealId } });
    if (!seal || seal.developmentCaseId !== sample.sourceCaseId || seal.supplierRelationId !== sample.supplierRelationId
      || !['sealed','converted'].includes(seal.status) || !same(ids(links.map((link: any) => link.sampleBatchId)), ids(snapshots.map(snapshot => snapshot.batch.id)))) reject('绑定必须保留实际同厂封样的全部组件');
  }
  const existing = await tx.sampleSource.findMany({ where: { sampleId: sample.id }, orderBy: { id: 'asc' } });
  const facts = snapshots.map(s => ({ sampleBatchId: s.batch.id, sourceRound: s.batch.sourceRound, sourceSealId: options.sourceSealId ?? null,
    sourceSnapshot: s, sourceFingerprint: sampleOriginFingerprint(s), provenance: options.provenance ?? 'native' })).sort((a,b) => a.sampleBatchId.localeCompare(b.sampleBatchId));
  if (existing.length) {
    if (existing.length !== facts.length || existing.some((row: any) => !facts.some(f => f.sampleBatchId === row.sampleBatchId && f.sourceRound === row.sourceRound
      && f.sourceFingerprint === row.sourceFingerprint && f.sourceSealId === (row.sourceSealId ?? null)))) reject('实物样品已有不同的不可变来源，不能替换其身份');
    const [context] = await readSampleOriginContexts(tx, [sample]);
    if (context.status !== 'resolved') reject('已有来源绑定或审计未能核对');
    return;
  }
  const evidenceAuditId = await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:samples:origin', operation: 'bind_sample_origins',
    targetType: 'Sample', targetId: sample.id, transactionId: options.transactionId ?? null, after: { sampleId: sample.id, projectionKey: sample.projectionKey ?? null, origins: facts, ...(options.registrationRequest ? { registrationRequest: options.registrationRequest } : {}) } });
  for (const fact of facts) await tx.sampleSource.create({ data: { id: 'SSRC__' + randomUUID(), sampleId: sample.id, ...fact,
    sourceUpdatedAt: BigInt(fact.sourceSnapshot.version.updatedAt), sourceHistoryRevision: fact.sourceSnapshot.version.historyRevision,
    sourceEventId: fact.sourceSnapshot.version.eventId, evidenceAuditId, boundAt: BigInt(Date.now()), boundBy: actorId } });
}

/** Descendants inherit exact ancestry, never canonical native approval. Caller
 * holds all discovered parent locks before parent/child Sample locks. */
export async function cloneSampleOrigins(tx: any, parentSampleId: string, childSampleId: string, actorId: string): Promise<void> {
  const [parent, child] = await Promise.all([tx.sample.findFirst({ where: { id: parentSampleId, deletedAt: null } }), tx.sample.findFirst({ where: { id: childSampleId, deletedAt: null } })]);
  if (!parent || !child || child.projectionKey) reject('复刻或分割的实物身份不存在或误用了原生投影键');
  const [context] = await readSampleOriginContexts(tx, [parent]);
  assertSampleOriginIdentity(context);
  if (!context.origins.length) return; // Preserve legacy unknown; never manufacture ancestry.
  if (context.origins.some(origin => origin.sourceSnapshot.batch.caseId !== child.sourceCaseId || origin.sourceSnapshot.batch.factoryId !== child.supplierRelationId)) reject('子样不能更换原样批次或工厂来源');
  const existing = await tx.sampleSource.findMany({ where: { sampleId: childSampleId } });
  if (existing.length) reject('子样已有精确来源，不能重复或替换继承');
  const facts = context.origins.map(origin => ({ sampleBatchId: origin.sampleBatchId, sourceRound: origin.sourceRound, sourceSealId: origin.sourceSealId,
    sourceSnapshot: origin.sourceSnapshot, sourceFingerprint: origin.sourceFingerprint, provenance: 'inherited' }));
  const auditId = await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:samples:origin', operation: 'inherit_sample_origins', targetType: 'Sample', targetId: childSampleId,
    after: { parentSampleId, childSampleId, parentBindingIds: context.origins.map(o => o.id), origins: facts, nativeApprovalInherited: false } });
  for (const fact of facts) await tx.sampleSource.create({ data: { id: 'SSRC__' + randomUUID(), sampleId: childSampleId, ...fact,
    sourceUpdatedAt: BigInt(fact.sourceSnapshot.version.updatedAt), sourceHistoryRevision: fact.sourceSnapshot.version.historyRevision,
    sourceEventId: fact.sourceSnapshot.version.eventId, evidenceAuditId: auditId, boundAt: BigInt(Date.now()), boundBy: actorId } });
}

/** Ordinary metadata edits cannot relabel already bound physical identity. */
export function assertSampleOriginMetadata(context: SampleOriginContext, existing: any, proposed: any): void {
  if (!context.origins.length) return;
  if (context.status !== 'resolved' || ['sourceCaseId','supplierRelationId','subType'].some(key => (existing[key] ?? null) !== (proposed[key] ?? null))) reject('已绑定的实物样品不能通过普通编辑或复刻更换批次、工厂或规格身份');
}
