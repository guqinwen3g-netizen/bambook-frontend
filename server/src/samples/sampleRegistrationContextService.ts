/** Exact ordinary registration is a source fact, never native approval. */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { exactJsonValue } from '../lib/exactJsonValue';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { snapshotSampleOrigin, sampleOriginFingerprint } from './sampleOriginService';
import { assertFabricSealEligible } from '../development/fabricBatchHistory';

export const SAMPLE_REGISTRATION_PROTOCOL = { registrationVersion: 2, mode: 'ordinary-draft-exact-source', persistentReceipt: true, autoApproval: false } as const;
export function registrationError(code: string, message: string): never { throw new DevelopmentDomainError(code, message); }
const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const registrationDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(sorted(exactJsonValue(value))) ?? '__undefined__').digest('hex');
export function registrationId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 200) registrationError('INVALID_INPUT', `${label}须为明确的记录标识。`);
  return value as string;
}
export function registrationCaseContent(row: any) {
  const fields = ['id', 'type', 'customerRelationId', 'supplierRelationId', 'productAssetId', 'source', 'departmentId', 'sampleCategory', 'sampleType',
    'sampleQuantity', 'sampleUnit', 'styleSpec', 'sizeSpec', 'fabricSpec', 'processSpec', 'dyeMethod', 'specComposition', 'specWeight', 'specWidth',
    'specWeave', 'specFinish', 'targetPrice', 'moqEstimate'];
  return exactJsonValue(Object.fromEntries(fields.map(field => [field, row[field] ?? null])));
}
export async function currentRegistrationActor(tx: any, actor: TokenPayload | null | undefined, mode: 'read' | 'write'): Promise<TokenPayload> {
  if (!actor?.userId) registrationError('UNAUTHORIZED', '请使用当前登录账号核对样品登记。');
  const user = await tx.userAccount.findFirst({ where: { id: actor!.userId, deletedAt: null, status: 'active' } });
  if (!user || user.id !== actor!.userId) registrationError('UNAUTHORIZED', '当前账号不可用，请重新登录。');
  const context = await createPermissionService({ prisma: tx }).getUserPermissionContext(actor!.userId);
  if (!context || context.userId !== actor!.userId) registrationError('AUTHORIZATION_UNAVAILABLE', '当前样品登记授权未能核对，请稍后重试。');
  const fresh: TokenPayload = { ...actor!, roles: context!.legacyRoleCodes, roleIds: context!.roleIds, permissions: context!.scopes,
    departmentIds: context!.departmentIds, authorizationLoaded: true };
  // Owner changes visibility; it cannot restore a revoked current action grant.
  if (!hasScope({ ...fresh, roles: [] }, 'products:read') || mode === 'write' && !hasScope({ ...fresh, roles: [] }, 'products:write'))
    registrationError('FORBIDDEN', '当前账号没有样品登记所需权限。');
  return fresh;
}
export async function authorizeRegistrationCase(tx: any, actor: TokenPayload, caseId: string, mode: 'read' | 'write', historical = false) {
  const fresh = await currentRegistrationActor(tx, actor, mode);
  const development = await tx.developmentCase.findFirst({ where: { id: caseId, ...(historical ? {} : { deletedAt: null }) } });
  if (!development) registrationError('NOT_FOUND', '样品登记来源不存在或不可见。');
  if (!historical && !['fabric', 'garment'].includes(development.type)) registrationError('DEVELOPMENT_SOURCE_CHANGED', '该开发案尚无受支持的准确批次来源，不能猜测业务线。');
  let access: string;
  if (development.customerRelationId) {
    const customer = await tx.relation.findFirst({ where: { id: development.customerRelationId, deletedAt: null } });
    if (!customer) registrationError('NOT_FOUND', '样品登记来源不存在或不可见。');
    access = await createTeamShareService(tx).resolveRelationAccess(fresh, customer.id, { fresh: true });
  } else {
    const resolver = await createPermissionService({ prisma: tx }).getDataScopeResolver(fresh, 'relations');
    access = resolveWriteKind(resolver.rule) === 'all' ? 'owner' : 'none';
  }
  if (access === 'none' || mode === 'write' && !['owner', 'team-followup'].includes(access)) registrationError('NOT_FOUND', '样品登记来源不存在或不可见。');
  return { development, actor: fresh, writeAllowed: hasScope({ ...fresh, roles: [] }, 'products:write') && ['owner', 'team-followup'].includes(access) };
}
export function registrationBatchContext(batch: any, development: any) {
  const snapshot = snapshotSampleOrigin(batch, development);
  return { batchId: batch.id, batchCode: batch.batchCode ?? null, nativeFamily: batch.sampleType === 'garment-round' ? 'garment-round' : 'fabric-batch', caseId: development.id,
    factoryId: batch.supplierRelationId, sourceRound: batch.round, sampleVersionId: batch.sampleVersionId ?? null,
    versionLabel: batch.versionLabel ?? null, formIndex: batch.formIndex ?? 0, batchUpdatedAt: String(batch.updatedAt),
    historyRevision: snapshot.version.historyRevision, eventId: snapshot.version.eventId, sampleType: batch.sampleType,
    content: snapshot.content, sourceContentFingerprint: sampleOriginFingerprint(snapshot), status: batch.status,
    actual: exactJsonValue({ quantity: batch.actualQuantity ?? null, unit: batch.actualUnit ?? null }),
    planned: exactJsonValue({ quantity: batch.planQuantity ?? null, unit: batch.planUnit ?? null }),
    command: { batchId: batch.id, sourceRound: batch.round, expectedUpdatedAt: String(batch.updatedAt), expectedFactoryId: batch.supplierRelationId,
      expectedHistoryRevision: snapshot.version.historyRevision, expectedEventId: snapshot.version.eventId, expectedContentFingerprint: sampleOriginFingerprint(snapshot) } };
}
export async function getSampleRegistrationContext(params: { prisma: any; actor: TokenPayload | null | undefined; caseId: unknown }) {
  try {
    const caseId = registrationId(params.caseId, '开发案');
    const data = await params.prisma.$transaction(async (tx: any) => {
      const { development, writeAllowed } = await authorizeRegistrationCase(tx, params.actor!, caseId, 'read');
      const [batches, seals, lifecycle] = await Promise.all([
        tx.sampleBatch.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' } }),
        tx.sealSample.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' } }),
        tx.developmentLifecycleEvent.findFirst({ where: { developmentCaseId: caseId }, orderBy: { revision: 'desc' } }),
      ]);
      const batchContexts: any[] = [];
      for (const batch of batches) {
        try {
          const context = registrationBatchContext(batch, development);
          const factory = await tx.relation.findFirst({ where: { id: context.factoryId, deletedAt: null } });
          batchContexts.push({ ...context, factoryName: factory?.companyName ?? factory?.name ?? batch.supplierName ?? null,
            selectable: !!factory, reasons: factory ? [] : ['FACTORY_MISSING_OR_DELETED'] });
        } catch (error) {
          if (!(error instanceof DevelopmentDomainError)) throw error;
          batchContexts.push({ batchId: batch.id, selectable: false, reasons: [error.code] });
        }
      }
      const sealContexts: any[] = [];
      for (const seal of seals) {
        const links = await tx.sealSampleBatch.findMany({ where: { sealSampleId: seal.id }, orderBy: { sampleBatchId: 'asc' } });
        const components = links.map((link: any) => batchContexts.find(batch => batch.batchId === link.sampleBatchId));
        const complete = components.length > 0 && components.every((batch: any) => batch?.selectable && batch.factoryId === seal.supplierRelationId);
        const reasons = complete ? [] : ['SEAL_COMPONENTS_INCOMPLETE'];
        if (development.type !== 'fabric') reasons.push('SEAL_CASE_NOT_FABRIC');
        if (!components.every((batch: any) => batch?.nativeFamily === 'fabric-batch')) reasons.push('SEAL_NATIVE_FAMILY_MISMATCH');
        if (!['sealed', 'converted'].includes(seal.status)) reasons.push('SEAL_NOT_READY');
        if (!reasons.length) {
          try { await assertFabricSealEligible(tx, seal); }
          catch (error) { if (!(error instanceof DevelopmentDomainError)) throw error; reasons.push(error.code); }
        }
        sealContexts.push({ sealId: seal.id, sealCode: seal.sealCode ?? null, name: seal.name ?? null, caseId, factoryId: seal.supplierRelationId, sealUpdatedAt: String(seal.updatedAt), status: seal.status,
          componentBatchIds: links.map((link: any) => link.sampleBatchId), components: components.map((component: any) => component ?? null),
          selectable: !reasons.length, reasons,
          command: !reasons.length ? { sealId: seal.id, expectedUpdatedAt: String(seal.updatedAt), expectedFactoryId: seal.supplierRelationId, components: components.map((component: any) => component.command) } : null });
      }
      const designReasons = !writeAllowed ? ['FORBIDDEN'] : lifecycle?.state === 'paused' ? ['DEVELOPMENT_PAUSED'] : lifecycle?.state === 'closed' ? ['DEVELOPMENT_CLOSED']
        : lifecycle && lifecycle.state !== 'active' ? ['INVALID_LIFECYCLE_STATE'] : [];
      const specs = registrationCaseContent(development);
      return { ...SAMPLE_REGISTRATION_PROTOCOL, snapshotAt: String(Date.now()),
        development: { caseId, code: development.code ?? null, name: development.name ?? null, type: development.type, updatedAt: String(development.updatedAt), specs, contentFingerprint: registrationDigest(specs),
          lifecycle: exactJsonValue(lifecycle ? { state: lifecycle.state, revision: lifecycle.revision, outcome: lifecycle.outcome ?? null } : null) },
        registrationEligibility: { design: { allowed: !designReasons.length, reasons: designReasons }, production: { allowed: writeAllowed, reasons: writeAllowed ? [] : ['FORBIDDEN'] } },
        batches: batchContexts, seals: sealContexts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { ok: true as const, data };
  } catch (error) {
    logger.error('[sample-registration-context] failed', { error });
    const safe = safeRouteError(error, { fallbackCode: 'SAMPLE_REGISTRATION_CONTEXT_FAILED', fallbackMessage: '准确样品来源暂时无法核对，请稍后重试。' });
    return { ok: false as const, error: { code: safe.code, message: safe.message, status: safe.status } };
  }
}
