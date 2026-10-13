import { assertNativeGarmentRound, garmentRoundContent, garmentCaseContent } from './garmentNativeSourceEvidence';
export { assertNativeGarmentRound, garmentRoundContent, garmentCaseContent } from './garmentNativeSourceEvidence';
import { createHash } from 'node:crypto';
import { readSampleOriginContexts, sampleOriginLockHints, lockSampleOriginParents, sampleProjectionKey, assertSampleOriginUsable } from '../samples/sampleOriginService';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { DevelopmentDomainError, assertDevelopmentOperationalWrite } from './developmentOperationalGuard';

function reject(code: string, message: string): never { throw new DevelopmentDomainError(code, message); }
const safe = (value: any): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a: any, b: any) => JSON.stringify(canonical(safe(a))) === JSON.stringify(canonical(safe(b)));
const digest = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function garmentPpSampleFact(sample: any) {
  return safe({ id: sample.id, type: sample.type, sourceCaseId: sample.sourceCaseId, sourceOrderId: sample.sourceOrderId ?? null,
    round: sample.round, status: sample.status, approvedAt: sample.approvedAt, approvedBy: sample.approvedBy,
    supplierRelationId: sample.supplierRelationId ?? null, customerRelationId: sample.customerRelationId ?? null });
}
/** Always reload grants under the parent lock; the signed cap remains a ceiling. */
export async function assertGarmentSourceAccess(tx: any, actor: TokenPayload | undefined, caseId: string, write = true) {
  const { development } = await authorizeDevelopmentSource(tx, actor?.userId, actor, caseId, { write });
  if (!development || !['garment', 'pp', 'trim'].includes(development.type)) reject('NOT_FOUND', '成衣开发来源不存在或不可见');
  return development;
}

export async function assertGarmentSampleSource(tx: any, development: any, round: any, sample: any) {
  await assertNativeGarmentRound(tx, round, true);
  const a = round.attachments ?? {};
  if (!sample || sample.deletedAt || sample.sourceCaseId !== development.id) reject('NOT_FOUND', '样品来源不存在或不属于本案');
  const [origin] = await readSampleOriginContexts(tx, [sample]);
  assertSampleOriginUsable(origin);
  if (sample.projectionKey !== sampleProjectionKey('garment_pp', round.id, round.round, round.sampleVersionId ? a.sealedVersionId : undefined) || origin.origins.length !== 1
    || origin.origins[0].sampleBatchId !== round.id || origin.origins[0].sourceRound !== round.round
    || !['native','recorded_exact'].includes(origin.origins[0].provenance)) reject('CONFLICT', '所选实物不是该封样轮次的原生产前样；继承或同案记录不能替代原生产品');
  if (sample.type !== 'pp' || sample.status !== 'approved' || sample.round !== round.round
    || sample.sourceOrderId || sample.customerRelationId !== development.customerRelationId
    || sample.supplierRelationId !== round.supplierRelationId || String(sample.approvedAt) !== String(a.sealedAt)
    || sample.approvedBy !== a.sealedBy) reject('CONFLICT', '样品与当前封样实物来源不一致，请核对原记录');
  const rows = await tx.auditLog.findMany({ where: { OR: [
    { action: 'seal_garment_preproduction_sample', targetType: 'DevelopmentCase', targetId: development.id },
    { action: { in: ['sync_pp_sample', 'sync_pp_sample_create'] }, targetType: 'Sample', targetId: sample.id },
  ] } });
  const seals = rows.filter((r: any) => r.detail?.source === 'route:samples:garment-gate' && r.actorId === a.sealedBy
    && r.detail.after?.roundId === round.id && r.detail.after.status === 'sealed'
    && (!r.detail.after.sampleId || r.detail.after.sampleId === sample.id));
  const sync = rows.filter((r: any) => r.targetId === sample.id && r.detail?.source === 'route:samples:garment-gate'
    && r.actorId === sample.approvedBy && r.detail.after?.sourceCaseId === development.id && r.detail.after.round === round.round
    && (!r.detail.after.sourceRoundId || r.detail.after.sourceRoundId === round.id));
  if (!seals.length || !sync.length) reject('CONFLICT', '封样与实物样品的来源审计缺失，不能按同案或最新记录猜测');
  const exact = sync.filter((r: any) => r.detail.after.sourceRoundId === round.id && r.detail.after.sampleId === sample.id);
  const latest = [...sync].sort((x: any, y: any) => +new Date(y.createdAt) - +new Date(x.createdAt))[0];
  if (latest.detail.after.sampleFact && !equal(latest.detail.after.sampleFact, garmentPpSampleFact(sample))) reject('CONFLICT', '实物样品的批准来源已变化，请核对原记录');
  if (seals.some((r: any) => r.detail.after.roundContent && !equal(r.detail.after.roundContent, garmentRoundContent(round)))) reject('CONFLICT', '封样规格已变化，请核对原记录');
  return exact.length && seals.some((r: any) => r.detail.after.sourceRoundId === round.id && r.detail.after.sampleId === sample.id)
    ? 'recorded_exact' as const : 'current_link_recorded' as const;
}

async function assertAssetOrigin(tx: any, development: any, round: any, asset: any) {
  if (!asset || asset.deletedAt || asset.mainCategory !== 'Garment') reject('NOT_FOUND', '原成衣档案不存在或不可见');
  const audits = await tx.auditLog.findMany({ where: { action: 'convert_garment_to_asset', targetType: 'ProductAsset', targetId: asset.id } });
  if (audits.length !== 1) reject('CONFLICT', '原档案的转档来源不唯一或缺失，请核对原记录');
  const d = audits[0].detail;
  if (d?.source !== 'route:dev:garment-convert-asset' || d.after?.fromCase !== development.id) reject('CONFLICT', '原档案的开发来源审计不一致，请核对原记录');
  const origin = d.after;
  if (origin.sourceRoundId ? origin.sourceRoundId !== round.id : origin.sourceType === 'seal' ? origin.sourceId !== round.id : origin.sourceType !== 'node' || origin.sourceId !== 'confirmation') {
    reject('CONFLICT', '原档案并非来自所选轮次，请核对原记录');
  }
  if (origin.sourceType === 'node' && !origin.sourceRoundId) {
    const rounds = await tx.sampleBatch.findMany({ where: { developmentCaseId: development.id, sampleType: 'garment-round', status: 'approved', deletedAt: null } });
    const candidates = rounds.filter((r: any) => r.attachments?.confirmation?.result === 'approved'
      && Number(r.attachments.confirmation.registeredAt) <= +new Date(audits[0].createdAt));
    if (candidates.length !== 1 || candidates[0].id !== round.id) reject('CONFLICT', '旧转档未记录唯一轮次，不能还原历史关联；请人工核对来源');
  }
  if (origin.roundContent && !equal(origin.roundContent, garmentRoundContent(round))) reject('CONFLICT', '原档案与当前轮次规格已变化，请核对来源');
  if (origin.caseContent && !equal(origin.caseContent, garmentCaseContent(development))) reject('CONFLICT', '开发规格或客户来源已变化，请核对原档案版本');
  if (!origin.caseContent) {
    // Old conversion audits did not freeze the case contents. The actual current
    // profile must therefore establish a complete current correspondence; this
    // never supplies the missing historical snapshot or restores an approval.
    // These six mappings are the native converter's GarmentProfile fields.
    const profile = await tx.garmentProfile.findUnique({ where: { productAssetId: asset.id } });
    if (!profile || profile.deletedAt != null || profile.productAssetId !== asset.id) {
      reject('CONFLICT', '原档案的成衣规格缺失或已删除，请核对当前来源后再关联');
    }
    const fields = [
      [profile.styleNo, development.styleSpec], [profile.mainFabric, development.fabricSpec],
      [profile.sizeSpec, development.sizeSpec], [profile.constructionNote, development.processSpec],
      [profile.customerRelationId, development.customerRelationId],
      [profile.factoryRelationId, round.supplierRelationId || development.supplierRelationId],
    ];
    const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    if (fields.some(([actual, source]) => !present(actual) || !present(source) || actual !== source)) {
      reject('CONFLICT', '原档案与当前开发案的款号、面料、尺码、工艺、客户或工厂缺失或不一致，请核对来源');
    }
  }
  return origin.sourceRoundId ? 'recorded_exact' as const : 'current_link_recorded' as const;
}

/** Preserve an already exact same-round asset; a case pointer alone authorizes nothing. */
export async function exactGarmentAssetForRound(tx: any, development: any, round: any, assetId: string | null | undefined) {
  if (!assetId) return null;
  const rows = await tx.auditLog.findMany({ where: { action: 'convert_garment_to_asset', targetType: 'ProductAsset', targetId: assetId } });
  if (rows.length !== 1) return null;
  const origin = rows[0].detail?.after;
  if (origin?.fromCase !== development.id || !(origin.sourceRoundId === round.id || (origin.sourceType === 'seal' && origin.sourceId === round.id))) return null;
  const asset = await tx.productAsset.findFirst({ where: { id: assetId, deletedAt: null } });
  try { await assertAssetOrigin(tx, development, { ...round, attachments: round.attachments ?? { version: round.version, purpose: round.purpose, materialConfig: round.materialConfig } }, asset); }
  catch (e) { if (e instanceof DevelopmentDomainError) return null; throw e; }
  return asset?.id ?? null;
}

export type GarmentSourceLinkCommand = { sourceRoundId: string; targetSampleId: string; existingAssetId: string;
  expectedRoundUpdatedAt: string; expectedSampleUpdatedAt: string; expectedAssetUpdatedAt: string; requestKey: string };
export type GarmentSourceBinding = { schemaVersion: 1; sourceRoundId: string; sampleId: string; assetId: string; auditId: string;
  provenance: 'recorded_exact' | 'current_link_recorded'; historicalApprovalRestored: false;
  caseId: string; actorId: string; requestKey: string; command: GarmentSourceLinkCommand };
export async function linkGarmentSampleAsset(prisma: any, caseId: string, actor: TokenPayload, input: GarmentSourceLinkCommand, ip?: string | null) {
  if (!input || Object.keys(input).some(key => !['sourceRoundId','targetSampleId','existingAssetId','expectedRoundUpdatedAt','expectedSampleUpdatedAt','expectedAssetUpdatedAt','requestKey'].includes(key))
    || ['sourceRoundId','targetSampleId','existingAssetId','requestKey'].some(key => typeof (input as any)[key] !== 'string' || !(input as any)[key].trim() || (input as any)[key].length > 200)
    || ['expectedRoundUpdatedAt','expectedSampleUpdatedAt','expectedAssetUpdatedAt'].some(key => typeof (input as any)[key] !== 'string' || !/^\d+$/.test((input as any)[key]))) reject('INVALID_INPUT', '请完整选择原轮次、样品、资产与当前版本');
  const auditId = 'gsl_' + digest([caseId, input.requestKey]);
  const fingerprint = digest({ caseId, actorId: actor?.userId, input });
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} FOR UPDATE`);
    const development = await assertGarmentSourceAccess(tx, actor, caseId);
    const initialSample = await tx.sample.findFirst({ where: { id: input.targetSampleId, deletedAt: null } });
    const originHints = await sampleOriginLockHints(tx, [input.targetSampleId]);
    if (!initialSample || initialSample.sourceCaseId !== caseId || initialSample.sourceOrderId || originHints.caseIds.some(id => id !== caseId)) reject('CONFLICT', '所选实物来源不属于本案，不能猜测其他订单或开发来源');
    await lockSampleOriginParents(tx, { caseIds: [caseId], sealIds: originHints.sealIds, batchIds: [...new Set([...originHints.batchIds, input.sourceRoundId])].sort() });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductAsset" WHERE "id"=${input.existingAssetId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${input.targetSampleId} FOR UPDATE`);
    if (JSON.stringify(await sampleOriginLockHints(tx, [input.targetSampleId])) !== JSON.stringify(originHints)) reject('CONFLICT', '样品精确来源集合已变化，请刷新');
    const prior = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (prior) {
      const d = prior.detail;
      if (prior.actorId !== actor.userId || prior.action !== 'link_garment_sample_asset' || prior.targetType !== 'Sample'
        || prior.targetId !== input.targetSampleId || d?.source !== 'route:dev:garment-source-link' || d.parameterHash !== fingerprint
        || !equal(d.command, input) || d.after?.requestKey !== input.requestKey || d.after?.auditId !== auditId
        || d.after.schemaVersion !== 1 || d.after.sourceRoundId !== input.sourceRoundId || d.after.sampleId !== input.targetSampleId
        || d.after.assetId !== input.existingAssetId || d.after.caseId !== caseId || d.after.actorId !== actor.userId
        || d.after.historicalApprovalRestored !== false || !['recorded_exact','current_link_recorded'].includes(d.after.provenance)
        || !equal(d.after.command, input)) reject('CONFLICT', '原请求已用于其他关联或回执不完整，请核对原结果');
      return { sourceBinding: d.after as GarmentSourceBinding };
    }
    await assertDevelopmentOperationalWrite(tx, caseId, 'convert');
    const round = await tx.sampleBatch.findFirst({ where: { id: input.sourceRoundId, developmentCaseId: caseId, deletedAt: null } });
    const sample = await tx.sample.findFirst({ where: { id: input.targetSampleId, sourceCaseId: caseId, deletedAt: null } });
    const asset = await tx.productAsset.findFirst({ where: { id: input.existingAssetId, deletedAt: null } });
    if (!round || !sample) reject('NOT_FOUND', '轮次或样品来源不存在或不属于本案');
    if (String(round.updatedAt) !== input.expectedRoundUpdatedAt || String(sample.updatedAt) !== input.expectedSampleUpdatedAt
      || !asset || String(asset.updatedAt) !== input.expectedAssetUpdatedAt) reject('CONFLICT', '来源版本已变化，请重新读取并核对');
    // New writes must keep the actual profile stable until the link commits.
    // Product editing writes Profile before Asset; with Asset already locked,
    // waiting on Profile could invert that order. NOWAIT rejects that overlap.
    // Read-only candidates and immutable receipt replays never take this lock.
    try {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GarmentProfile" WHERE "productAssetId"=${asset.id} FOR UPDATE NOWAIT`);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010' && error.meta?.code === '55P03') {
        reject('CONFLICT', '原档案的成衣规格正在修改，本次未关联；请稍后核对来源并重试原请求');
      }
      throw error;
    }
    const sampleOrigin = await assertGarmentSampleSource(tx, development, round, sample);
    const assetOrigin = await assertAssetOrigin(tx, development, round, asset);
    if (sample.productAssetId && sample.productAssetId !== asset.id) reject('CONFLICT', '样品已关联其他资产，请核对原关联');
    const after: GarmentSourceBinding = { schemaVersion: 1, sourceRoundId: round.id, sampleId: sample.id, assetId: asset.id,
      auditId, provenance: sampleOrigin === 'recorded_exact' && assetOrigin === 'recorded_exact' ? 'recorded_exact' : 'current_link_recorded', historicalApprovalRestored: false,
      caseId, actorId: actor.userId, requestKey: input.requestKey, command: input };
    const result = await tx.sample.updateMany({ where: { id: sample.id, sourceCaseId: caseId, updatedAt: sample.updatedAt, productAssetId: sample.productAssetId, deletedAt: null },
      data: { productAssetId: asset.id, updatedAt: BigInt(Math.max(Date.now(), Number(sample.updatedAt) + 1)) } });
    if (result.count !== 1) reject('CONFLICT', '样品关联已变化，请刷新核对');
    await tx.auditLog.create({ data: { id: auditId, actorId: actor.userId, action: 'link_garment_sample_asset', targetType: 'Sample', targetId: sample.id, ip: ip ?? null,
      detail: { source: 'route:dev:garment-source-link', parameterHash: fingerprint, command: input,
        before: { productAssetId: sample.productAssetId }, after: { ...after, requestKey: input.requestKey } } } });
    return { sourceBinding: after };
  });
}

/** Parent-scoped candidates, never a company-wide Sample/Asset download. */
export async function listGarmentSourceLinks(prisma: any, caseId: string, actor: TokenPayload) {
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} FOR UPDATE`);
    const development = await assertGarmentSourceAccess(tx, actor, caseId);
    const rounds = await tx.sampleBatch.findMany({ where: { developmentCaseId: caseId, sampleType: 'garment-round', deletedAt: null }, orderBy: { id: 'asc' } });
    const origins = await tx.sampleSource.findMany({ where: { sampleBatchId: { in: rounds.map((round: any) => round.id) }, provenance: { in: ['native','recorded_exact'] } } });
    const samples = await tx.sample.findMany({ where: { id: { in: [...new Set(origins.map((origin: any) => origin.sampleId))] }, sourceCaseId: caseId, type: 'pp', deletedAt: null }, orderBy: { id: 'asc' } });
    const audits = await tx.auditLog.findMany({ where: { action: 'convert_garment_to_asset', targetType: 'ProductAsset', detail: { path: ['after','fromCase'], equals: caseId } } });
    const assets = await tx.productAsset.findMany({ where: { id: { in: audits.map((r: any) => r.targetId) }, deletedAt: null }, orderBy: { id: 'asc' } });
    const items: any[] = [], blockedReasons = new Set<string>();
    for (const round of rounds.filter((r: any) => r.attachments?.sealedRoundStatus === 'sealed')) for (const sample of samples.filter((sample: any) => sample.projectionKey === sampleProjectionKey('garment_pp', round.id, round.round) && origins.some((origin: any) => origin.sampleId === sample.id && origin.sampleBatchId === round.id && origin.sourceRound === round.round))) for (const asset of assets) {
      try {
        const s = await assertGarmentSampleSource(tx, development, round, sample), a = await assertAssetOrigin(tx, development, round, asset);
        if (sample.productAssetId && sample.productAssetId !== asset.id) continue;
        items.push({ sourceRoundId: round.id, sampleId: sample.id, sampleCode: sample.code, assetId: asset.id, sku: asset.sku, assetName: asset.name,
          expectedRoundUpdatedAt: String(round.updatedAt), expectedSampleUpdatedAt: String(sample.updatedAt), expectedAssetUpdatedAt: String(asset.updatedAt),
          provenance: s === 'recorded_exact' && a === 'recorded_exact' ? 'recorded_exact' : 'current_link_recorded' });
      } catch (e) { if (!(e instanceof DevelopmentDomainError)) throw e; blockedReasons.add(e.message); }
    }
    return { items, blockedReason: items.length ? null : [...blockedReasons][0] ?? '尚无可核查的封样实物与原资产关联，请先核对来源' };
  });
}
