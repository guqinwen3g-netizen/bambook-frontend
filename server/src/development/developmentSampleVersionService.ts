import { businessNowMs } from '../shared/businessClock';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { developmentVersionSnapshot, resolveDevelopmentVersionForBatch } from './developmentVersionGate';

type EnsureRoundInput = {
  developmentCaseId: string;
  round: number;
  purpose?: string | null;
  clientVersion?: string | null;
  materialConfig?: string | null;
  notes?: string | null;
  actorId?: string | null;
  now?: bigint;
};

/** Create or read the shared change-request container for one case and round. */
export async function ensureDevelopmentSampleRound(tx: any, input: EnsureRoundInput) {
  const current = await tx.developmentSampleRound.findFirst({
    where: { developmentCaseId: input.developmentCaseId, round: input.round },
  });
  if (current) {
    if (current.deletedAt != null) throw Object.assign(new Error('该轮次记录已归档，不能再追加版本'), { code: 'ROUND_ARCHIVED', statusCode: 409 });
    for (const [field, value] of [['purpose', input.purpose], ['clientVersion', input.clientVersion], ['materialConfig', input.materialConfig], ['notes', input.notes]] as const) {
      if (value != null && current[field] != null && String(current[field]) !== String(value)) {
        throw Object.assign(new Error(`第 ${input.round} 轮的${field}与已登记要求不一致`), { code: 'ROUND_METADATA_MISMATCH', statusCode: 409 });
      }
    }
    if (input.notes != null && current.notes == null) {
      return tx.developmentSampleRound.update({ where: { id: current.id }, data: { notes: input.notes, updatedAt: input.now ?? BigInt(Date.now()) } });
    }
    return current;
  }
  const now = input.now ?? BigInt(Date.now());
  return tx.developmentSampleRound.create({
    data: {
      id: `DSR__${randomUUID()}`,
      developmentCaseId: input.developmentCaseId,
      round: input.round,
      purpose: input.purpose ?? null,
      clientVersion: input.clientVersion ?? null,
      materialConfig: input.materialConfig ?? null,
      notes: input.notes ?? null,
      createdBy: input.actorId ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export async function updateDevelopmentSampleVersionTask(params: {
  prisma: any; versionId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null;
  input: { factoryRequirements?: string; targetCompletionDate?: string | null; referenceAttachments?: string[]; samplePlans?: Array<{ batchId: string; quantity: number; unit: string }>; expectedUpdatedAt: string };
}) {
  const { prisma, versionId, actorId, ip, input } = params;
  try {
    const factoryRequirements = input.factoryRequirements === undefined ? undefined : input.factoryRequirements.trim();
    const targetCompletionDate = input.targetCompletionDate === undefined ? undefined : input.targetCompletionDate?.trim() || null;
    const referenceAttachments = input.referenceAttachments;
    const samplePlans = input.samplePlans;
    if (factoryRequirements !== undefined && factoryRequirements.length > 8000) throw new DevelopmentDomainError('INVALID_INPUT', '工厂打样要求不能超过 8000 字');
    if (targetCompletionDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetCompletionDate)) throw new DevelopmentDomainError('INVALID_INPUT', '要求完成日期格式须为 YYYY-MM-DD');
    if (referenceAttachments !== undefined && (!Array.isArray(referenceAttachments) || referenceAttachments.length > 20
      || referenceAttachments.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048))) {
      throw new DevelopmentDomainError('INVALID_INPUT', '参考附件最多 20 项，每项须为有效链接');
    }
    if (samplePlans !== undefined && (!Array.isArray(samplePlans) || samplePlans.some(plan => !plan.batchId || !Number.isFinite(plan.quantity) || plan.quantity <= 0 || !plan.unit?.trim()))) {
      throw new DevelopmentDomainError('INVALID_INPUT', '每种样品形态的数量和单位须有效');
    }
    if (!/^\d+$/.test(input.expectedUpdatedAt)) throw new DevelopmentDomainError('INVALID_INPUT', '工厂任务版本格式不正确');
    const item = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.developmentSampleVersion.findFirst({ where: { id: versionId, deletedAt: null } });
      if (!existing) throw new DevelopmentDomainError('NOT_FOUND', '工厂开发任务不存在或已归档');
      await assertDevelopmentOperationalWrite(tx, existing.developmentCaseId, 'sample');
      await authorizeDevelopmentSource(tx, actorId, params.trustedActor, existing.developmentCaseId);
      await tx.$queryRawUnsafe('SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id" = $1 FOR UPDATE', versionId);
      const current = await tx.developmentSampleVersion.findFirst({ where: { id: versionId, deletedAt: null } });
      if (!current || String(current.updatedAt) !== input.expectedUpdatedAt) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '工厂任务已变化，请刷新后再编辑');
      const batches = await tx.sampleBatch.findMany({ where: { sampleVersionId: versionId, deletedAt: null }, orderBy: [{ sampleType: 'asc' }, { id: 'asc' }] });
      if (samplePlans !== undefined) {
        if (samplePlans.length !== batches.length || batches.some((batch: any) => !samplePlans.some(plan => plan.batchId === batch.id))) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '样品形态已变化，请刷新工厂任务后再编辑');
        for (const batch of batches) {
          const plan = samplePlans.find(item => item.batchId === batch.id)!;
          if (batch.sampleType === 'yardage' ? plan.unit !== '米' : ['lab-dip', 'handloom'].includes(batch.sampleType) ? plan.unit !== '份' || !Number.isInteger(plan.quantity) : false) {
            throw new DevelopmentDomainError('INVALID_INPUT', '米样按米、手织样和色样按份登记；份数必须为整数');
          }
          await tx.sampleBatch.update({ where: { id: batch.id }, data: { planQuantity: plan.quantity, planUnit: plan.unit.trim(), updatedAt: BigInt(Date.now()) } });
        }
      }
      const data: any = { updatedAt: BigInt(Date.now()) };
      if (factoryRequirements !== undefined) data.factoryRequirements = factoryRequirements || null;
      if (targetCompletionDate !== undefined) data.targetCompletionDate = targetCompletionDate;
      if (referenceAttachments !== undefined) data.referenceAttachments = referenceAttachments;
      const updated = await tx.developmentSampleVersion.update({ where: { id: versionId }, data });
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:dev:sample-version', operation: 'update_development_sample_version_task',
        targetType: 'DevelopmentSampleVersion', targetId: versionId,
        before: { factoryRequirements: current.factoryRequirements ?? null, targetCompletionDate: current.targetCompletionDate ?? null, referenceAttachments: current.referenceAttachments ?? [], samplePlans: batches.map((batch: any) => ({ batchId: batch.id, quantity: batch.planQuantity?.toString() ?? null, unit: batch.planUnit ?? null })) },
        after: { factoryRequirements: updated.factoryRequirements ?? null, targetCompletionDate: updated.targetCompletionDate ?? null, referenceAttachments: updated.referenceAttachments ?? [], samplePlans: samplePlans ?? batches.map((batch: any) => ({ batchId: batch.id, quantity: batch.planQuantity?.toString() ?? null, unit: batch.planUnit ?? null })) }, ip: ip ?? null });
      return { id: updated.id, developmentCaseId: updated.developmentCaseId, roundRequirementsSnapshot: updated.roundRequirementsSnapshot ?? null,
        factoryRequirements: updated.factoryRequirements ?? null, targetCompletionDate: updated.targetCompletionDate ?? null,
        referenceAttachments: updated.referenceAttachments ?? [], updatedAt: String(updated.updatedAt) };
    });
    return { ok: true as const, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return { ok: false as const, error: { code: error.code, message: error.message, status: error.statusCode } };
    return { ok: false as const, error: { code: 'SAMPLE_VERSION_UPDATE_FAILED', message: '工厂开发任务更新失败，请刷新后重试。', status: 500 } };
  }
}

export async function updateDevelopmentSampleRoundRequirements(params: {
  prisma: any; roundId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null;
  input: { notes: string; expectedUpdatedAt: string };
}) {
  try {
    const notes = params.input.notes.trim();
    if (notes.length > 8000) throw new DevelopmentDomainError('INVALID_INPUT', '本轮共同要求不能超过 8000 字');
    if (!/^\d+$/.test(params.input.expectedUpdatedAt)) throw new DevelopmentDomainError('INVALID_INPUT', '轮次版本格式不正确');
    const item = await params.prisma.$transaction(async (tx: any) => {
      const existing = await tx.developmentSampleRound.findFirst({ where: { id: params.roundId, deletedAt: null } });
      if (!existing) throw new DevelopmentDomainError('NOT_FOUND', '开发轮次不存在或已归档');
      await assertDevelopmentOperationalWrite(tx, existing.developmentCaseId, 'sample');
      await authorizeDevelopmentSource(tx, params.actorId, params.trustedActor, existing.developmentCaseId);
      await tx.$queryRawUnsafe('SELECT "id" FROM "DevelopmentSampleRound" WHERE "id" = $1 FOR UPDATE', params.roundId);
      const current = await tx.developmentSampleRound.findFirst({ where: { id: params.roundId, deletedAt: null } });
      if (!current || String(current.updatedAt) !== params.input.expectedUpdatedAt) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '轮次要求已变化，请刷新后再编辑');
      const updated = await tx.developmentSampleRound.update({ where: { id: params.roundId }, data: { notes: notes || null, updatedAt: BigInt(Date.now()) } });
      await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: 'route:dev:sample-round', operation: 'update_development_sample_round_requirements',
        targetType: 'DevelopmentSampleRound', targetId: params.roundId,
        before: { notes: current.notes ?? null }, after: { notes: updated.notes ?? null }, ip: params.ip ?? null });
      return { id: updated.id, developmentCaseId: updated.developmentCaseId, round: updated.round, notes: updated.notes ?? null, updatedAt: String(updated.updatedAt) };
    });
    return { ok: true as const, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return { ok: false as const, error: { code: error.code, message: error.message, status: error.statusCode } };
    return { ok: false as const, error: { code: 'SAMPLE_ROUND_UPDATE_FAILED', message: '本轮共同要求更新失败，请刷新后重试。', status: 500 } };
  }
}

type EnsureVersionInput = {
  round: any;
  supplierRelationId: string;
  supplierName?: string | null;
  /** Historical callers may supply a label; new labels are allocated from persisted case facts. */
  versionLabel?: string;
  sourceVersionId?: string | null;
  factoryRequirements?: string | null;
  targetCompletionDate?: string | null;
  referenceAttachments?: unknown;
  actorId?: string | null;
  now?: bigint;
};

/** Allocate a new physical sample independently of its scheduling round.
 * The case lock serializes factory codes and physical sequence numbers. Existing
 * labels are historical facts; allocation never rewrites them. */
export async function ensureDevelopmentSampleMajorVersion(tx: any, input: EnsureVersionInput) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${input.round.developmentCaseId} AND "deletedAt" IS NULL FOR UPDATE`);
  const rows = await tx.developmentSampleVersion.findMany({
    where: { developmentCaseId: input.round.developmentCaseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (input.sourceVersionId != null && typeof input.sourceVersionId !== 'string') throw new DevelopmentDomainError('INVALID_INPUT', '来源版本编号必须是文本');
  const sourceVersionId = input.sourceVersionId?.trim() || null;
  if (sourceVersionId && !rows.some((row: any) => row.id === sourceVersionId && row.deletedAt == null && row.supplierRelationId === input.supplierRelationId)) {
    throw new DevelopmentDomainError('INVALID_INPUT', '继续打样的来源版本必须属于本案同一工厂，且仍可查看');
  }
  const codes = new Map<string, string>();
  const used = new Set<string>();
  // Explicit codes already allocated by this model take precedence over ambiguous
  // old round-local letters. Different historical factories may both have used A.
  for (const row of rows) {
    if (row.factoryCode && !codes.has(row.supplierRelationId) && !used.has(row.factoryCode)) {
      codes.set(row.supplierRelationId, row.factoryCode); used.add(row.factoryCode);
    }
  }
  const letters = (index: number): string => {
    let value = index + 1, result = '';
    while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
    return result;
  };
  const nextCode = () => { let index = 0; while (used.has(letters(index))) index++; return letters(index); };
  for (const row of rows) {
    if (codes.has(row.supplierRelationId)) continue;
    const historical = /^R\d+-([A-Z]+)(?:-|\.|$)/.exec(row.versionLabel ?? '')?.[1];
    const code = historical && !used.has(historical) ? historical : nextCode();
    codes.set(row.supplierRelationId, code); used.add(code);
  }
  const factoryCode = codes.get(input.supplierRelationId) ?? nextCode();
  const physicalRows = rows.filter((row: any) => row.supplierRelationId === input.supplierRelationId && row.versionKind !== 'minor');
  const physicalSequence = Math.max(physicalRows.length, ...physicalRows.map((row: any) => Number(row.physicalSequence) || 0)) + 1;
  const roundNumber = Number(input.round.round);
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) throw new DevelopmentDomainError('INVALID_INPUT', '开发轮次必须为正整数');
  const versionLabel = `R${roundNumber}-${factoryCode}-${physicalSequence}`;
  const now = input.now ?? BigInt(Date.now());
  return tx.developmentSampleVersion.create({
    data: {
      id: `DSV__${randomUUID()}`, roundId: input.round.id,
      developmentCaseId: input.round.developmentCaseId,
      supplierRelationId: input.supplierRelationId, supplierName: input.supplierName ?? null,
      versionLabel, factoryCode, physicalSequence, sourceVersionId,
      roundRequirementsSnapshot: input.round.notes ?? null,
      factoryRequirements: input.factoryRequirements ?? input.round.notes ?? null,
      targetCompletionDate: input.targetCompletionDate ?? null,
      referenceAttachments: input.referenceAttachments ?? null,
      versionKind: 'major', minorVersion: 0,
      createdBy: input.actorId ?? null, createdAt: now, updatedAt: now,
    },
  });
}

/** Add a written garment adjustment beneath its physical major version. */
export async function createDevelopmentSampleMinorVersion(tx: any, input: {
  parent: any;
  id?: string;
  note: string;
  existingMinorCount?: number;
  actorId?: string | null;
  now?: bigint;
}) {
  const note = input.note.trim();
  if (!note) throw Object.assign(new Error('请填写本次微调的明确内容'), { code: 'INVALID_INPUT', statusCode: 400 });
  const latest = await tx.developmentSampleVersion.findFirst({
    where: { parentVersionId: input.parent.id, versionKind: 'minor', deletedAt: null },
    orderBy: { minorVersion: 'desc' },
  });
  const minorVersion = Math.max(latest?.minorVersion ?? 0, input.existingMinorCount ?? 0) + 1;
  const now = input.now ?? BigInt(Date.now());
  return tx.developmentSampleVersion.create({
    data: {
      id: input.id ?? `DSV__${randomUUID()}`,
      roundId: input.parent.roundId,
      developmentCaseId: input.parent.developmentCaseId,
      supplierRelationId: input.parent.supplierRelationId,
      supplierName: input.parent.supplierName ?? null,
      versionLabel: `${input.parent.versionLabel}.${minorVersion}`,
      versionKind: 'minor',
      factoryCode: input.parent.factoryCode ?? null,
      physicalSequence: input.parent.physicalSequence ?? null,
      sourceVersionId: input.parent.id,
      parentVersionId: input.parent.id,
      minorVersion,
      minorChangeNote: note,
      createdBy: input.actorId ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export async function createDevelopmentSampleMinorVersionCommand(params: {
  prisma: any; caseId: string; parentVersionId: string; actorId: string; trustedActor?: TokenPayload;
  input: { requestKey: string; note: string }; ip?: string | null;
}) {
  try {
    const requestKey = confirmationText(params.input?.requestKey, '原请求编号', 128)!;
    const note = confirmationText(params.input?.note, '本次微调内容', 8000)!;
    const id = `DSV_CMD_${createHash('sha256').update(JSON.stringify([params.caseId, requestKey])).digest('hex')}`;
    const item = await params.prisma.$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx, params.caseId, 'sample');
      await authorizeDevelopmentSource(tx, params.actorId, params.trustedActor, params.caseId);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id" = ${params.parentVersionId} AND "developmentCaseId" = ${params.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
      const prior = await tx.developmentSampleVersion.findFirst({ where: { id, developmentCaseId: params.caseId } });
      if (prior) {
        if (prior.deletedAt != null || prior.parentVersionId !== params.parentVersionId || prior.minorChangeNote !== note || prior.createdBy !== params.actorId)
          throw new DevelopmentDomainError('REQUEST_CONFLICT', '原请求编号已对应其他微调内容，请用原内容核对回执');
        return { ...prior, createdAt: String(prior.createdAt), updatedAt: String(prior.updatedAt), deletedAt: null };
      }
      const parent = await tx.developmentSampleVersion.findFirst({ where: { id: params.parentVersionId, developmentCaseId: params.caseId, versionKind: 'major', deletedAt: null } });
      if (!parent) throw new DevelopmentDomainError('NOT_FOUND', '原实物大版本不存在或不属于当前开发案');
      const minor = await createDevelopmentSampleMinorVersion(tx, { parent, id, note, actorId: params.actorId });
      await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: 'route:dev:sample-version', operation: 'create_development_sample_minor_version',
        targetType: 'DevelopmentSampleVersion', targetId: minor.id, after: { caseId: params.caseId, parentVersionId: parent.id, versionLabel: minor.versionLabel, note, requestKey }, ip: params.ip ?? null, operationType: 'create' });
      return { ...minor, createdAt: String(minor.createdAt), updatedAt: String(minor.updatedAt), deletedAt: null };
    });
    return { ok: true as const, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return { ok: false as const, error: { code: error.code, message: error.message, status: error.statusCode } };
    return { ok: false as const, error: { code: 'MICRO_VERSION_FAILED', message: '微调版本未能保存，请用原请求编号核对回执后重试。', status: 500 } };
  }
}

export function serializeDevelopmentVersionConfirmation(row: any) {
  return { ...row, confirmedAt: String(row.confirmedAt), recordedAt: String(row.recordedAt) };
}

function confirmationText(value: unknown, label: string, limit: number, optional = false): string | null {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new DevelopmentDomainError('INVALID_INPUT', `${label}须填写且不能超过 ${limit} 字`);
  return value.trim();
}

/** Actual requester identity/time is supplied as a business fact. The trusted
 * logged-in staff member is only its recorder; neither field substitutes the other. */
export async function recordDevelopmentVersionConfirmation(params: {
  prisma: any; caseId: string; versionId: string; actorId: string; trustedActor?: TokenPayload; input: any; ip?: string | null;
}) {
  try {
    const input = params.input;
    const requestKey = confirmationText(input?.requestKey, '原请求编号', 128)!;
    const confirmerType = confirmationText(input?.confirmerType, '实际确认方类型', 30)!;
    if (!['customer', 'internal'].includes(confirmerType)) throw new DevelopmentDomainError('INVALID_INPUT', '实际确认方类型须为 customer 或 internal');
    const result = confirmationText(input?.result, '确认结果', 30)!;
    if (!['approved', 'rejected', 'needs_adjustment'].includes(result)) throw new DevelopmentDomainError('INVALID_INPUT', '确认结果须为 approved、rejected 或 needs_adjustment');
    const confirmedAt = typeof input?.confirmedAt === 'number' && Number.isSafeInteger(input.confirmedAt) ? String(input.confirmedAt) : input?.confirmedAt;
    if (typeof confirmedAt !== 'string' || !/^\d{1,16}$/.test(confirmedAt) || BigInt(confirmedAt) <= BigInt(0) || BigInt(confirmedAt) > BigInt(businessNowMs()))
      throw new DevelopmentDomainError('INVALID_INPUT', '请填写实际确认时间的毫秒时间戳，不能用录入时间代替或填写未来时间');
    const evidence = input?.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 30 || evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048))
      throw new DevelopmentDomainError('INVALID_INPUT', '确认依据附件须为不超过 30 项的有效链接');
    const fact = {
      confirmerType, confirmerName: confirmationText(input?.confirmerName, '实际确认人', 120)!,
      confirmerUserId: confirmationText(input?.confirmerUserId, '内部确认人账号', 200, true),
      confirmerRelationId: confirmationText(input?.confirmerRelationId, '实际确认方联系人或机构关联', 200, true),
      confirmerOrganization: confirmationText(input?.confirmerOrganization, '实际确认机构', 240, true),
      confirmedAt, result, basis: confirmationText(input?.basis, '实际确认依据', 8000)!, evidence,
    };
    const sampleBatchId = confirmationText(input?.sampleBatchId, '所评审实物来源', 200, true);
    const fingerprint = createHash('sha256').update(JSON.stringify({ caseId: params.caseId, versionId: params.versionId, actorId: params.actorId, sampleBatchId, fact })).digest('hex');
    const item = await params.prisma.$transaction(async (tx: any) => {
      const { development } = await authorizeDevelopmentSource(tx, params.actorId, params.trustedActor, params.caseId);
      const prior = await tx.developmentVersionConfirmation.findUnique({ where: { requestKey } });
      if (prior) {
        if (prior.developmentCaseId !== params.caseId || prior.sampleVersionId !== params.versionId || prior.recordedBy !== params.actorId || prior.requestFingerprint !== fingerprint)
          throw new DevelopmentDomainError('REQUEST_CONFLICT', '原请求编号已有其他确认事实，请使用原内容核对回执');
        return serializeDevelopmentVersionConfirmation(prior);
      }
      // An original successful receipt is a read, not a new operational fact.
      await assertDevelopmentOperationalWrite(tx, params.caseId, 'sample');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id" = ${params.versionId} AND "developmentCaseId" = ${params.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
      const selectedVersion = await tx.developmentSampleVersion.findFirst({ where: { id: params.versionId, developmentCaseId: params.caseId, deletedAt: null } });
      if (!selectedVersion) throw new DevelopmentDomainError('NOT_FOUND', '准确开发版本不存在或不属于当前开发案');
      const physicalVersionId = selectedVersion.versionKind === 'minor' ? selectedVersion.parentVersionId : selectedVersion.id;
      const sourceBatches = await tx.sampleBatch.findMany({ where: { developmentCaseId: params.caseId, sampleVersionId: physicalVersionId, deletedAt: null,
        ...(sampleBatchId ? { id: sampleBatchId } : {}) }, orderBy: { id: 'asc' } });
      const returnedBatches = sourceBatches.filter((batch: any) => batch.returnedAt != null && batch.developmentCaseId === params.caseId && batch.sampleVersionId === physicalVersionId && (!sampleBatchId || batch.id === sampleBatchId));
      if (!returnedBatches.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '该准确版本没有已记录的返样实物来源，不能推算需求方确认');
      const context = await resolveDevelopmentVersionForBatch(tx, { caseId: params.caseId, batch: returnedBatches[0], sampleVersionId: params.versionId });
      const physicalItems = await tx.sampleCardItem.findMany({ where: { devCaseId: params.caseId, batchId: { in: returnedBatches.map((batch: any) => batch.id) }, deletedAt: null },
        orderBy: { id: 'asc' }, select: { id: true, code: true, batchId: true, cardType: true } });
      if (!physicalItems.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原返样实物关联缺失，请核对样品台账后再登记');
      if (fact.confirmerType === 'customer' && !development.customerRelationId) throw new DevelopmentDomainError('INVALID_INPUT', '内部开发尚无客户来源，不能登记为客户确认；请据实选择内部需求方');
      if (fact.confirmerUserId) {
        if (fact.confirmerType !== 'internal') throw new DevelopmentDomainError('INVALID_INPUT', '内部确认人账号仅用于内部需求方，客户确认请登记实际联系人');
        const confirmer = await tx.userAccount.findFirst({ where: { id: fact.confirmerUserId, deletedAt: null }, select: { id: true } });
        if (!confirmer || confirmer.id !== fact.confirmerUserId) throw new DevelopmentDomainError('INVALID_INPUT', '所选实际内部确认人账号不存在');
      }
      const sourceSnapshot = {
        case: { id: development.id, customerRelationId: development.customerRelationId ?? null, initiator: development.initiator ?? null },
        version: developmentVersionSnapshot(context.version), physicalVersion: developmentVersionSnapshot(context.physicalVersion),
        sampleBatches: returnedBatches.map((batch: any) => ({ id: batch.id, sampleVersionId: batch.sampleVersionId, returnedAt: String(batch.returnedAt) })),
        physicalItems,
      };
      const sourceFingerprint = createHash('sha256').update(JSON.stringify(sourceSnapshot)).digest('hex');
      const created = await tx.developmentVersionConfirmation.create({ data: {
        id: `DVC__${randomUUID()}`, developmentCaseId: params.caseId, sampleVersionId: params.versionId,
        requestKey, requestFingerprint: fingerprint, ...fact, confirmedAt: BigInt(fact.confirmedAt), recordedBy: params.actorId, recordedAt: BigInt(Date.now()),
        sourceSnapshot, sourceFingerprint,
      } });
      const serialized = serializeDevelopmentVersionConfirmation(created);
      await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: 'route:dev:version-confirmation', operation: 'record_development_version_confirmation',
        targetType: 'DevelopmentSampleVersion', targetId: params.versionId, after: serialized, ip: params.ip ?? null, operationType: 'create' });
      return serialized;
    });
    return { ok: true as const, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return { ok: false as const, error: { code: error.code, message: error.message, status: error.statusCode } };
    return { ok: false as const, error: { code: 'VERSION_CONFIRMATION_FAILED', message: '需求方确认记录未能保存，请使用原请求编号核对回执后重试。', status: 500 } };
  }
}

export async function listDevelopmentVersionConfirmations(params: {
  prisma: any; caseId: string; versionIds?: string[]; actorId?: string; trustedActor?: TokenPayload;
}) {
  try {
    if (params.versionIds && (!Array.isArray(params.versionIds) || params.versionIds.length > 200 || params.versionIds.some(id => typeof id !== 'string' || !id.trim())))
      throw new DevelopmentDomainError('INVALID_INPUT', '准确版本筛选格式不正确');
    await authorizeDevelopmentSource(params.prisma, params.actorId ?? params.trustedActor?.userId, params.trustedActor, params.caseId, { write: false });
    const rows = await params.prisma.developmentVersionConfirmation.findMany({ where: { developmentCaseId: params.caseId,
      ...(params.versionIds ? { sampleVersionId: { in: params.versionIds } } : {}) }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 500 });
    return { ok: true as const, data: { items: rows.map(serializeDevelopmentVersionConfirmation) } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return { ok: false as const, error: { code: error.code, message: error.message, status: error.statusCode } };
    return { ok: false as const, error: { code: 'VERSION_CONFIRMATION_LIST_FAILED', message: '需求方确认历史读取失败，请稍后重试。', status: 500 } };
  }
}
