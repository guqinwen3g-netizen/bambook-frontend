import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertDevelopmentVersionReadyForConsumption } from './developmentVersionGate';
const reject = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
const safe = (value: any): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a: any, b: any) => JSON.stringify(canonical(safe(a))) === JSON.stringify(canonical(safe(b)));

/** Current source content, independent of mutable lifecycle projections. */
export function garmentRoundContent(round: any) {
  const a = round.attachments ?? {};
  return safe({ id: round.id, developmentCaseId: round.developmentCaseId, round: round.round,
    version: round.version ?? a.version ?? null, purpose: round.purpose ?? a.purpose ?? null, materialConfig: round.materialConfig ?? a.materialConfig ?? null,
    supplierRelationId: round.supplierRelationId ?? null, supplierName: round.supplierName ?? null });
}
export function garmentCaseContent(development: any) {
  return safe({ id: development.id, type: development.type, customerRelationId: development.customerRelationId ?? null,
    supplierRelationId: development.supplierRelationId ?? null, styleSpec: development.styleSpec ?? null,
    sizeSpec: development.sizeSpec ?? null, fabricSpec: development.fabricSpec ?? null, processSpec: development.processSpec ?? null });
}

/** Native garment evidence, not fabric confirmStatus and not a label-only approval. */
export async function assertNativeGarmentRound(tx: any, round: any, sealed = false) {
  const a = round.attachments ?? {}, confirmation = a.confirmation;
  if (round.sampleVersionId) {
    const selectedVersionId = sealed ? a.sealedVersionId : round.sampleVersionId;
    if (!selectedVersionId || sealed && (a.sealedRoundStatus !== 'sealed'
      || a.sealedDevelopmentVersionProof?.sampleVersionId !== selectedVersionId))
      reject('DEVELOPMENT_SOURCE_CHANGED', '历史封样未记录准确开发版本，不能以旧 QC 或客户标量推算实际生产依据');
    const current = await assertDevelopmentVersionReadyForConsumption(tx, round.developmentCaseId, selectedVersionId);
    if (current.physicalVersion.id !== round.sampleVersionId || current.batch.id !== round.id)
      reject('DEVELOPMENT_SOURCE_CHANGED', '封样所选版本与原成衣实物来源不一致');
    if (sealed) {
      const frozen = a.sealedDevelopmentVersionProof;
      if (!equal(frozen.sourceSnapshot, current.exactDevelopmentVersionProof.sourceSnapshot))
        reject('DEVELOPMENT_SOURCE_CHANGED', '封样后的准确规格已变化，请保留原封样并另建准确修订');
      const audit = await tx.auditLog.findFirst({ where: { action: 'seal_garment_preproduction_sample', targetType: 'DevelopmentCase',
        targetId: round.developmentCaseId, actorId: a.sealedBy, detail: { path: ['source'], equals: 'route:samples:garment-gate' },
        AND: [{ detail: { path: ['after', 'roundId'], equals: round.id } }, { detail: { path: ['after', 'sealedVersionId'], equals: selectedVersionId } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!audit || !equal(audit.detail?.after?.exactDevelopmentVersionProof, frozen))
        reject('DEVELOPMENT_SOURCE_CHANGED', '准确封样缺少原生规格及双门禁冻结审计');
    }
    return current;
  }
  // The old native writer saved confirmation/approval audits but omitted this
  // nullable column. Null is tolerated only with all attachment, exact native
  // audit and current-content checks below; an explicit non-approved value is
  // never replaced by an older attachment. This does not repair historical data.
  if (round.deletedAt || round.sampleType !== 'garment-round' || round.status !== 'approved' || round.qcStatus !== 'passed'
    || (round.customerStatus !== 'approved' && round.customerStatus !== null) || !round.qcReviewedBy || !round.qcReviewedAt
    || confirmation?.result !== 'approved' || !confirmation.registeredBy || !confirmation.registeredAt
    || !a.submittedAt || (sealed && a.sealedRoundStatus !== 'sealed') || (!sealed && a.sealedRoundStatus === 'superseded')) {
    reject('CONFLICT', '当前成衣轮次的 QC、客户确认或封样依据已失效，请核对原记录');
  }
  if (Number(round.qcReviewedAt) > Number(a.submittedAt) || Number(a.submittedAt) > Number(confirmation.registeredAt)
    || (sealed && Number(confirmation.registeredAt) > Number(a.sealedAt))) reject('CONFLICT', '成衣样品的实际门禁时间不一致，请核对原记录');
  const audits = await tx.auditLog.findMany({ where: { targetType: 'DevelopmentCase', targetId: round.developmentCaseId,
    action: { in: ['submit_garment_sample_qc', 'confirm_garment_sample'] } } });
  const qc = audits.filter((row: any) => row.actorId === round.qcReviewedBy && row.detail?.source === 'route:samples:garment-gate'
    && row.detail.after?.roundId === round.id && row.detail.after.qcStatus === 'passed'
    && (!row.detail.after.qcReviewedAt || String(row.detail.after.qcReviewedAt) === String(round.qcReviewedAt)));
  const customer = audits.filter((row: any) => row.actorId === confirmation.registeredBy && row.detail?.source === 'route:samples:garment-gate'
    && row.detail.after?.roundId === round.id && row.detail.after.customerStatus === 'approved'
    && row.detail.after.confirmationDate === confirmation.date && row.detail.after.channel === confirmation.channel
    && (!row.detail.after.registeredAt || String(row.detail.after.registeredAt) === String(confirmation.registeredAt)));
  if (!qc.length || !customer.length) reject('CONFLICT', '成衣轮次的真实 QC 或客户确认审计缺失，请核对原记录');
  // New writers capture exact content; older records can only establish a current link, never restore historical version approval.
  const current = garmentRoundContent(round);
  for (const rows of [qc, customer]) {
    const last = [...rows].sort((x: any, y: any) => +new Date(y.createdAt) - +new Date(x.createdAt))[0];
    if (last.detail.after.roundContent && !equal(last.detail.after.roundContent, current)) reject('CONFLICT', '样品规格已变化，原双门禁不能作为当前版本的依据');
  }
}
