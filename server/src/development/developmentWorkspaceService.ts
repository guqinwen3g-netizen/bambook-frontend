import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { businessError } from '../shared/errorCodes';
import { exactJsonValue } from '../lib/exactJsonValue';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertDevelopmentVersionQualityPass, assertDevelopmentQualitySourceCurrent, assertDevelopmentVersionReadyForConsumption,
  developmentVersionSnapshot, readDevelopmentVersionDecisions } from './developmentVersionGate';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { assembleBusinessWorkspace, continueBusinessWorkspace, readWorkspaceActivations, workspaceDigest, parseWorkspaceScope,
  type WorkspaceNodeFact, type WorkspaceAdapter } from '../shared/businessWorkspaceContinuation';
import type { BusinessWorkspaceScope, BusinessWorkspaceEvidence } from '../shared/businessWorkspaceContract';

const reason = (code: string, message: string) => ({ code, message });
function assertScope(scope: BusinessWorkspaceScope, caseId: string) {
  if (!['development_case', 'development_version'].includes(scope.kind) || !('caseId' in scope) || scope.caseId !== caseId)
    throw businessError('INVALID_INPUT', '工作区不属于当前准确开发案。');
}
async function knownGate(work: () => Promise<unknown>): Promise<Array<{ code: string; message: string }>> {
  try { await work(); return []; }
  catch (error) { if (error instanceof DevelopmentDomainError) return [reason(error.code, error.message)]; throw error; }
}
const ref = (kind: string, rows: any[]): BusinessWorkspaceEvidence[] => rows.map(row => ({ kind, id: row.id }));

export function createDevelopmentWorkspaceService(options: { prisma: any }) {
  const adapter = (caseId: string, prior: TokenPayload | null | undefined): WorkspaceAdapter => ({
    async authorize(db, scope, mode) {
      assertScope(scope, caseId);
      const { actor } = await authorizeDevelopmentSource(db, prior?.userId, prior, caseId, { write: mode === 'write' });
      if (scope.kind === 'development_version' && !await db.developmentSampleVersion.findFirst({ where: { id: scope.sampleVersionId, developmentCaseId: caseId, deletedAt: null }, select: { id: true } }))
        throw businessError('NOT_FOUND', '准确开发版本不存在或不属于当前开发案。');
      return actor;
    },
    async lock(db, scope) {
      await db.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
      if (scope.kind === 'development_version') {
        await db.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id"=${scope.sampleVersionId} AND "developmentCaseId"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
        await db.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "developmentCaseId"=${caseId} AND ("sampleVersionId"=${scope.sampleVersionId} OR "sampleVersionId"=(SELECT "parentVersionId" FROM "DevelopmentSampleVersion" WHERE "id"=${scope.sampleVersionId})) AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE`);
      }
    },
    async context(db, scope, actor) {
      const development = await db.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!development) throw businessError('NOT_FOUND', '开发案已不可读。');
      const [versions, batches, lifecycle] = await Promise.all([
        db.developmentSampleVersion.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        db.sampleBatch.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' } }),
        db.developmentLifecycleEvent.findFirst({ where: { developmentCaseId: caseId }, orderBy: { revision: 'desc' } }),
      ]);
      const writable = hasScope(actor, 'products:write'), operational = development.stage !== 'cancelled' && (!lifecycle || lifecycle.state === 'active');
      const downstream = development.stage !== 'cancelled' && (!lifecycle || lifecycle.state === 'active' || lifecycle.state === 'closed' && lifecycle.outcome === 'completed');
      const lifecycleReasons = operational ? [] : [reason('DEVELOPMENT_PAUSED_OR_CLOSED', '当前开发已暂停、结案或取消；原业务事实仍可回看。')];
      const summaries = versions.map((version: any) => ({ kind: 'development_version', id: version.id, roundId: version.roundId,
        versionLabel: version.versionLabel, versionKind: version.versionKind, parentVersionId: version.parentVersionId ?? null,
        factoryRelationId: version.supplierRelationId, factoryName: version.supplierName ?? null,
        physicalBatchCount: batches.filter((batch: any) => batch.sampleVersionId === (version.parentVersionId || version.id)).length }));
      const overview: Record<string, unknown> = { id: development.id, code: development.code, name: development.name, businessLine: development.type,
        initiator: development.initiator ?? null, customerRelationId: development.customerRelationId ?? null, ownerId: development.ownerId ?? null,
        recordedLegacyStage: development.stage, lifecycleState: lifecycle?.state ?? null };
      if (scope.kind === 'development_case') {
        const identity = { scope, ownerId: development.ownerId, type: development.type };
        const scopeFingerprint = workspaceDigest(identity), activatedNodeIds = await readWorkspaceActivations(db, scope, scopeFingerprint);
        return assembleBusinessWorkspace({ scope, identity, overview, childSummaries: summaries, activatedNodeIds, canWrite: writable,
          facts: [{ id: 'tasks', label: '轮次与工厂任务', precedingIds: [], hasHistory: false, initial: true, eligible: operational,
            blockedReasons: lifecycleReasons, evidenceRefs: ref('DevelopmentSampleVersion', versions) }] });
      }
      if (scope.kind !== 'development_version') throw businessError('INVALID_INPUT', '请选择准确开发版本。');
      const version = versions.find((row: any) => row.id === scope.sampleVersionId);
      if (!version) throw businessError('NOT_FOUND', '准确开发版本已不可读。');
      const physicalVersion = version.versionKind === 'minor' ? versions.find((row: any) => row.id === version.parentVersionId && row.versionKind === 'major') : version;
      const physicalBatches = physicalVersion ? batches.filter((row: any) => row.sampleVersionId === physicalVersion.id && row.supplierRelationId === version.supplierRelationId) : [];
      const items = physicalBatches.length ? await db.sampleCardItem.findMany({ where: { devCaseId: caseId, batchId: { in: physicalBatches.map((row: any) => row.id) }, deletedAt: null }, select: { id: true, batchId: true }, orderBy: { id: 'asc' } }) : [];
      const returned = physicalBatches.some((row: any) => row.returnedAt != null && items.some((item: any) => item.batchId === row.id));
      const recordedReturn = physicalBatches.some((row: any) => row.returnedAt != null);
      const decisions = (await readDevelopmentVersionDecisions(db, caseId, [version.id])).get(version.id);
      const reviews = decisions?.developmentQcHistory ?? [], confirmations = decisions?.versionConfirmationHistory ?? [];
      const assets = await db.productAsset.findMany({ where: { sourceDevelopmentCaseId: caseId, sourceSampleVersionId: version.id, deletedAt: null }, select: { id: true, sku: true, name: true, sourceSampleVersionId: true }, orderBy: { id: 'asc' } });
      const qualityReasons = await knownGate(async () => { const review = await assertDevelopmentVersionQualityPass(db, caseId, version.id); await assertDevelopmentQualitySourceCurrent(db, review); });
      const consumptionReasons = await knownGate(() => assertDevelopmentVersionReadyForConsumption(db, caseId, version.id));
      const sourceReasons = returned ? [] : [reason('RETURN_RESULTS_REQUIRED', '本版尚无可核验的实际返样与同一实体库记录。')];
      const taskReady = !!(physicalVersion?.factoryRequirements?.trim() && physicalBatches.length && physicalBatches.every((row: any) => row.planQuantity != null && Number(row.planQuantity) > 0 && row.planUnit));
      const orderLinks = assets.length && hasScope(actor, 'orders:read') ? await db.orderLine.findMany({ where: { confirmedSourceType: 'Asset', confirmedSourceId: { in: assets.map((asset: any) => asset.id) }, order: { deletedAt: null, AND: [await freshOrderLineScope(db, actor)] } }, select: { id: true, orderId: true } }) : [];
      const identity = { scope, version: developmentVersionSnapshot(version), physicalVersion: physicalVersion ? developmentVersionSnapshot(physicalVersion) : null,
        case: { id: caseId, type: development.type, ownerId: development.ownerId, customerRelationId: development.customerRelationId ?? null } };
      const activatedNodeIds = await readWorkspaceActivations(db, scope, workspaceDigest(identity));
      const facts: WorkspaceNodeFact[] = [
        { id: 'tasks', label: '本厂任务', precedingIds: [], initial: true, hasHistory: taskReady, eligible: operational, blockedReasons: lifecycleReasons, evidenceRefs: [{ kind: 'DevelopmentSampleVersion', id: version.id }] },
        { id: 'results', label: '成果与实物', precedingIds: ['tasks'], hasHistory: recordedReturn, eligible: operational && (taskReady || returned), unknown: recordedReturn && !returned,
          blockedReasons: operational && (taskReady || returned) ? [] : [...lifecycleReasons, reason('TASK_REQUIREMENTS_REQUIRED', '先核对本厂打样要求、形态数量与单位。')], evidenceRefs: ref('SampleBatch', physicalBatches) },
        { id: 'qc', label: '正式 QC', precedingIds: ['results'], hasHistory: !!reviews.length, eligible: operational && returned, blockedReasons: [...lifecycleReasons, ...sourceReasons], evidenceRefs: ref('DevelopmentSampleQualityReview', reviews) },
        { id: 'confirmation', label: '实际需求方确认', precedingIds: ['results'], hasHistory: !!confirmations.length, eligible: operational && returned, blockedReasons: [...lifecycleReasons, ...sourceReasons], evidenceRefs: ref('DevelopmentVersionConfirmation', confirmations) },
        { id: 'archive', label: '产品留档', precedingIds: ['qc'], hasHistory: !!assets.length, eligible: downstream && !qualityReasons.length,
          blockedReasons: [...(!downstream ? lifecycleReasons : []), ...qualityReasons], evidenceRefs: ref('ProductAsset', assets) },
        { id: 'order', label: '准确版本转订单', precedingIds: ['qc', 'confirmation'], hasHistory: !!orderLinks.length,
          eligible: downstream && !!assets.length && !consumptionReasons.length && hasScope(actor, 'orders:write'),
          blockedReasons: [...(!downstream ? lifecycleReasons : []), ...consumptionReasons, ...(!assets.length ? [reason('ASSET_REQUIRED', '请先从本版正式 QC 成果保留产品档案。')] : []),
            ...(!hasScope(actor, 'orders:write') ? [reason('FORBIDDEN', '当前账号没有新订单写权限。')] : [])], evidenceRefs: ref('OrderLine', orderLinks) },
      ];
      return assembleBusinessWorkspace({ scope, identity, overview: { ...overview, version: developmentVersionSnapshot(version), physicalSampleVersionId: physicalVersion?.id ?? null,
        physicalBatches: physicalBatches.map((row: any) => ({ id: row.id, sampleType: row.sampleType, returnedAt: row.returnedAt == null ? null : String(row.returnedAt), physicalItemIds: items.filter((item: any) => item.batchId === row.id).map((item: any) => item.id) })), linkedAssets: assets },
        facts, activatedNodeIds, canWrite: writable, childSummaries: summaries });
    },
  });
  async function read(caseId: string, prior: TokenPayload | null | undefined, sampleVersionId?: string) {
    const scope = parseWorkspaceScope(sampleVersionId !== undefined ? { kind: 'development_version', caseId, sampleVersionId } : { kind: 'development_case', caseId });
    const access = adapter(caseId, prior), actor = await access.authorize(options.prisma, scope, 'read');
    const context = await access.context(options.prisma, scope, actor);
    await access.authorize(options.prisma, scope, 'read');
    return exactJsonValue(context);
  }
  return { read, continue: (caseId: string, prior: TokenPayload | null | undefined, input: unknown, ip?: string | null) =>
    continueBusinessWorkspace({ prisma: options.prisma, prior, input, adapter: adapter(caseId, prior), ip }) };
}
