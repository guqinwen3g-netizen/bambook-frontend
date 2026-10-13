import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { createRelationServiceV2 } from '../relations/relationServiceV2';
import { createTeamShareService } from '../teams/teamShareService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import {
  canonicalCustomerConfirmationJson,
  currentCustomerConfirmationActor,
  CustomerConfirmationError,
  customerConfirmationSha256,
} from '../customerConfirmations/customerConfirmationService';
import type { CustomerConfirmationCommand, CustomerConfirmationTargetAdapter } from '../customerConfirmations/customerConfirmationTypes';
import { businessNowMs } from '../shared/businessClock';


export const FABRIC_USE_AUTHORIZATION_TARGET = 'FabricUseAuthorizationRequest';

/** Stable server keys. UI renders business labels; entrypoint owners should import these constants. */
export const FABRIC_USE_ACTIONS = {
  quotationCreate: 'quotation.create',
  quotationUpdate: 'quotation.update',
  quotationSend: 'quotation.send',
  quotationAccept: 'quotation.accept',
  quotationConvertToOrder: 'quotation.convert_to_order',
  orderLineCreate: 'order_line.create',
  orderLineUpdate: 'order_line.update',
  sampleSsRegister: 'fabric_sample.ss_register',
  sampleRcEnable: 'fabric_sample.rc_enable',
  shipmentLinesReplace: 'shipment.lines_replace',
} as const;

export type FabricUseAction = typeof FABRIC_USE_ACTIONS[keyof typeof FABRIC_USE_ACTIONS];
export const FABRIC_USE_ACTION_LABELS: Record<FabricUseAction, string> = {
  [FABRIC_USE_ACTIONS.quotationCreate]: '新增报价',
  [FABRIC_USE_ACTIONS.quotationUpdate]: '修改报价',
  [FABRIC_USE_ACTIONS.quotationSend]: '发送报价',
  [FABRIC_USE_ACTIONS.quotationAccept]: '接受报价',
  [FABRIC_USE_ACTIONS.quotationConvertToOrder]: '由已接受报价转订单',
  [FABRIC_USE_ACTIONS.orderLineCreate]: '新增订单用料',
  [FABRIC_USE_ACTIONS.orderLineUpdate]: '修改订单用料',
  [FABRIC_USE_ACTIONS.sampleSsRegister]: '登记 S/S 船样',
  [FABRIC_USE_ACTIONS.sampleRcEnable]: '登记 RC 匹头样',
  [FABRIC_USE_ACTIONS.shipmentLinesReplace]: '用于出运装箱',
};

const ACTION_SET = new Set<string>(Object.values(FABRIC_USE_ACTIONS));
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export type FabricAuthorizationErrorCode =
  | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_INPUT' | 'EXCLUSIVE_FABRIC_BLOCKED'
  | 'AUTHORIZATION_UNAVAILABLE' | 'VERSION_MISMATCH' | 'AUTHORIZATION_PENDING'
  | 'CUSTOMER_CONFIRMATION_REQUIRED' | 'PRODUCT_ARCHIVED';

export class FabricUseAuthorizationError extends Error {
  constructor(readonly code: FabricAuthorizationErrorCode, message: string, readonly statusCode: number) {
    super(message);
    this.name = 'FabricUseAuthorizationError';
  }
}

function fail(code: FabricAuthorizationErrorCode, message: string, statusCode: number): never {
  throw new FabricUseAuthorizationError(code, message, statusCode);
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableHash(value: unknown): string {
  return customerConfirmationSha256(canonicalCustomerConfirmationJson(value));
}

function parseTime(value: unknown, field: string): bigint | null {
  if (value == null || value === '') return null;
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(raw) || raw < 0) fail('INVALID_INPUT', `${field}时间无效。`, 400);
  return BigInt(raw);
}

function statusLabel(operation: string): string {
  return operation === 'revoke' ? '申请撤回授权' : operation === 'replace' ? '申请调整授权范围' : '申请客户授权';
}

function productFact(product: any) {
  const fabric = product?.fabricProfile;
  return {
    id: product.id, sku: product.sku, name: product.name, mainCategory: product.mainCategory, status: product.status,
    fabric: fabric ? { articleNo: fabric.articleNo ?? null, millQuality: fabric.millQuality ?? null,
      millColorCode: fabric.millColorCode ?? null, construction: fabric.construction ?? null,
      weightValue: fabric.weightValue == null ? null : String(fabric.weightValue), weightUnit: fabric.weightUnit ?? null } : null,
  };
}

function ensureActionSet(value: unknown, operation: string): FabricUseAction[] {
  if (operation === 'revoke') {
    if (value != null && (!Array.isArray(value) || value.length !== 0)) fail('INVALID_INPUT', '撤回申请不应包含新的使用范围。', 400);
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || value.some(action => typeof action !== 'string' || !ACTION_SET.has(action)))
    fail('INVALID_INPUT', '请选择明确的业务使用范围。', 400);
  return [...new Set(value)] as FabricUseAction[];
}

async function takeAuthorizationLock(tx: any, productAssetId: string, ownerRelationId?: string, granteeRelationId?: string) {
  const key = `fabric-use-authorization:${productAssetId}:${ownerRelationId ?? '*'}:${granteeRelationId ?? '*'}`;
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', key);
}

async function lockProductAndExclusiveOwner(tx: any, productAssetId: string, options: { allowDeleted?: boolean } = {}) {
  await tx.$queryRawUnsafe('SELECT "id" FROM "ProductAsset" WHERE "id"=$1 FOR UPDATE', productAssetId);
  const product = await tx.productAsset.findFirst({ where: { id: productAssetId, ...(options.allowDeleted ? {} : { deletedAt: null }) }, include: {
    fabricProfile: { select: { articleNo: true, millQuality: true, millColorCode: true, construction: true, weightValue: true, weightUnit: true } },
  } });
  if (!product) fail('NOT_FOUND', '面料档案不存在或已删除。', 404);
  const codes = await tx.fabricCustomerCode.findMany({
    where: { productAssetId, isExclusive: true, deletedAt: null },
    orderBy: { id: 'asc' },
  });
  for (const code of codes) await tx.$queryRawUnsafe('SELECT "id" FROM "FabricCustomerCode" WHERE "id"=$1 FOR UPDATE', code.id);
  const freshCodes = codes.length ? await tx.fabricCustomerCode.findMany({
    where: { productAssetId, isExclusive: true, deletedAt: null }, orderBy: { id: 'asc' },
  }) : [];
  if (freshCodes.length > 1) fail('AUTHORIZATION_UNAVAILABLE', '面料专属属主记录不唯一，授权已暂停，请先核对档案。', 409);
  return { product, exclusive: freshCodes[0] ?? null };
}

async function validCustomerRelations(tx: any, ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const rows = uniqueIds.length ? await tx.relation.findMany({
    where: { id: { in: uniqueIds }, deletedAt: null, isOrganization: true },
    select: { id: true, name: true, category: true, isOrganization: true, deletedAt: true },
  }) : [];
  const byId = new Map<string, any>(rows.filter((row: any) => typeof row.category === 'string'
    && row.category.trim().toLowerCase() === 'customer').map((row: any) => [row.id, row]));
  return byId;
}

async function assertRelationBusinessAccess(tx: any, actor: TokenPayload, relationId: string, mode: 'read' | 'write') {
  const valid = (await validCustomerRelations(tx, [relationId])).get(relationId);
  if (!valid) fail('NOT_FOUND', '客户档案不存在、已停用或类别不正确。', 404);
  try {
    const relationService = createRelationServiceV2(tx);
    const scoped = mode === 'write'
      ? await relationService.buildWriteScopeWhere(actor)
      : await relationService.buildScopeWhere(actor);
    const visible = await tx.relation.findFirst({ where: { id: relationId, deletedAt: null, AND: [scoped] }, select: { id: true } });
    if (!visible) fail('NOT_FOUND', '客户档案不存在或当前无权查看。', 404);
    const teamService = createTeamShareService(tx);
    const bizVisible = await teamService.hasBizReadAccess(actor, relationId, { fresh: true });
    if (!bizVisible) fail('NOT_FOUND', '客户档案不存在或当前无权查看。', 404);
    if (mode === 'write') {
      const writeVisible = await tx.relation.findFirst({ where: { id: relationId, deletedAt: null, AND: [await relationService.buildWriteScopeWhere(actor)] }, select: { id: true } });
      if (!writeVisible) fail('FORBIDDEN', '当前账号不在该客户档案的可写范围内。', 403);
    }
    return valid;
  } catch (error) {
    if (error instanceof FabricUseAuthorizationError) throw error;
    fail('AUTHORIZATION_UNAVAILABLE', '当前客户业务范围无法核验，请稍后重试。', 503);
  }
}

function activeActions(version: any): FabricUseAction[] {
  if (!version || !Array.isArray(version.allowedActions)) return [];
  return version.allowedActions.filter((item: unknown): item is FabricUseAction => typeof item === 'string' && ACTION_SET.has(item));
}

function effective(version: any, now: bigint) {
  return version && (version.effectiveFrom == null || version.effectiveFrom <= now)
    && (version.effectiveUntil == null || version.effectiveUntil >= now);
}

async function latestVersion(tx: any, productAssetId: string, ownerRelationId: string, granteeRelationId: string) {
  return tx.fabricUseAuthorizationVersion.findFirst({
    where: { productAssetId, ownerRelationId, granteeRelationId }, orderBy: { revision: 'desc' },
  });
}

async function verifyConfirmationEvidence(tx: any, confirmation: any) {
  if (!confirmation || confirmation.outcome !== 'accepted' || confirmation.internalApprovalId !== null
    || !confirmation.auditId || !confirmation.recordedBy) return false;
  const [audit, joins] = await Promise.all([
    tx.auditLog.findUnique({ where: { id: confirmation.auditId } }),
    tx.businessConfirmationEvidence.findMany({ where: { confirmationId: confirmation.id }, include: { evidence: { include: { files: true } } } }),
  ]);
  if (!audit || audit.action !== 'business_customer_confirmation_recorded' || audit.targetId !== confirmation.id
    || audit.actorId !== confirmation.recordedBy || !joins.length) return false;
  return joins.every((join: any) => {
    const evidence = join.evidence;
    if (!evidence?.sourceFingerprint || !evidence?.sourceSnapshot) return false;
    if (evidence.sourceType === 'screenshot') return evidence.files?.some((file: any) => file.purpose === 'screenshot') === true;
    return evidence.sourceType === 'email_selection';
  });
}

async function requestSnapshot(tx: any, input: { productAssetId: string; ownerRelationId: string; granteeRelationId: string;
  operation: string; allowedActions: FabricUseAction[]; effectiveFrom: bigint | null; effectiveUntil: bigint | null;
  expectedVersionId: string | null }) {
  const product = await tx.productAsset.findUnique({ where: { id: input.productAssetId }, select: {
    id: true, sku: true, name: true, mainCategory: true, status: true,
    fabricProfile: { select: { articleNo: true, millQuality: true, millColorCode: true, construction: true, weightValue: true, weightUnit: true } },
  } });
  const relations = await validCustomerRelations(tx, [input.ownerRelationId, input.granteeRelationId]);
  const owner = relations.get(input.ownerRelationId), grantee = relations.get(input.granteeRelationId);
  if (!product || !owner || !grantee) fail('NOT_FOUND', '面料或客户档案不存在或无法核验。', 404);
  const fact = {
    product: productFact(product),
    owner: { id: owner.id, name: owner.name },
    grantee: { id: grantee.id, name: grantee.name },
    operation: input.operation, allowedActions: input.allowedActions,
    effectiveFrom: input.effectiveFrom?.toString() ?? null,
    effectiveUntil: input.effectiveUntil?.toString() ?? null,
    expectedVersionId: input.expectedVersionId,
  };
  const displayScope = {
    schemaVersion: 1,
    product: { name: product.name, sku: product.sku, articleNo: product.fabricProfile?.articleNo ?? null,
      millQuality: product.fabricProfile?.millQuality ?? null, color: product.fabricProfile?.millColorCode ?? null },
    ownerCustomer: owner.name,
    authorizedCustomer: grantee.name,
    operation: statusLabel(input.operation),
    allowedActions: input.allowedActions.map(action => FABRIC_USE_ACTION_LABELS[action]),
    effectiveFrom: fact.effectiveFrom, effectiveUntil: fact.effectiveUntil,
  };
  return { productSnapshot: fact.product, fact, displayScope,
    finalContentFingerprint: stableHash({ schemaVersion: 1, fact }),
    scopeFingerprint: stableHash({ schemaVersion: 1, productId: product.id, ownerRelationId: owner.id,
      granteeRelationId: grantee.id, operation: input.operation, allowedActions: input.allowedActions,
      effectiveFrom: fact.effectiveFrom, effectiveUntil: fact.effectiveUntil, expectedVersionId: input.expectedVersionId }) };
}

export interface CreateFabricUseAuthorizationRequestInput {
  productAssetId: string;
  granteeRelationId: string;
  operation: 'grant' | 'replace' | 'revoke';
  allowedActions?: unknown;
  effectiveFrom?: unknown;
  effectiveUntil?: unknown;
  expectedVersionId?: string | null;
  requestKey: string;
  actor: TokenPayload;
  ip?: string | null;
  now?: number;
}

export async function createFabricUseAuthorizationRequestInTx(tx: any, input: CreateFabricUseAuthorizationRequestInput) {
  const productAssetId = nonempty(input.productAssetId), granteeRelationId = nonempty(input.granteeRelationId);
  if (!productAssetId || !granteeRelationId || !ID.test(productAssetId) || !ID.test(granteeRelationId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestKey))
    fail('INVALID_INPUT', '授权产品、客户或提交编号无效。', 400);
  if (!input.actor?.userId || input.actor.authorizationLoaded !== true || !hasScope({ ...input.actor, roles: [] }, 'products:write'))
    fail('FORBIDDEN', '当前账号没有产品授权登记权限。', 403);
  const operation = input.operation;
  if (!['grant', 'replace', 'revoke'].includes(operation)) fail('INVALID_INPUT', '授权操作无效。', 400);
  const allowedActions = ensureActionSet(input.allowedActions, operation);
  const effectiveFrom = operation === 'revoke' ? null : parseTime(input.effectiveFrom, '授权生效');
  const effectiveUntil = operation === 'revoke' ? null : parseTime(input.effectiveUntil, '授权截止');
  if (effectiveFrom != null && effectiveUntil != null && effectiveFrom > effectiveUntil)
    fail('INVALID_INPUT', '授权截止时间不能早于生效时间。', 400);

  await takeAuthorizationLock(tx, productAssetId);
  const { product, exclusive } = await lockProductAndExclusiveOwner(tx, productAssetId);
  if (product.mainCategory !== 'Fabric') fail('INVALID_INPUT', '客户专属授权仅适用于面料档案。', 409);
  if (String(product.status).toLowerCase() === 'archived') fail('PRODUCT_ARCHIVED', '已归档面料不能登记新的客户授权。', 409);
  if (!exclusive) fail('INVALID_INPUT', '该面料当前没有明确的专属属主，不能建立客户授权。', 409);
  const ownerRelationId = nonempty(exclusive.customerOrganizationId);
  if (!ownerRelationId) fail('INVALID_INPUT', '专属属主客户待核对，请先绑定客户档案。', 409);
  if (ownerRelationId === granteeRelationId) fail('INVALID_INPUT', '专属属主客户无需向自身登记授权。', 400);
  await takeAuthorizationLock(tx, productAssetId, ownerRelationId, granteeRelationId);
  const owner = await assertRelationBusinessAccess(tx, input.actor, ownerRelationId, 'write');
  const grantee = await assertRelationBusinessAccess(tx, input.actor, granteeRelationId, 'read');
  const expectedVersionId = nonempty(input.expectedVersionId);
  const snapshotInput = { productAssetId, ownerRelationId, granteeRelationId, operation, allowedActions, effectiveFrom, effectiveUntil, expectedVersionId };
  const snapshot = await requestSnapshot(tx, snapshotInput);
  const requestFingerprint = stableHash({ snapshot: snapshot.fact, actorId: input.actor.userId, requestKey: input.requestKey });
  const replay = await tx.fabricUseAuthorizationRequest.findUnique({ where: { recordedBy_requestKey: { recordedBy: input.actor.userId, requestKey: input.requestKey } } });
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) fail('VERSION_MISMATCH', '本次请求编号已用于其他授权内容，请刷新后重试。', 409);
    return { request: replay, replayed: true, ownerName: owner.name, granteeName: grantee.name };
  }
  const current = await latestVersion(tx, productAssetId, ownerRelationId, granteeRelationId);
  if (operation === 'replace' && (!current || current.state !== 'active'))
    fail('VERSION_MISMATCH', '当前没有可调整的有效授权，请刷新详情。', 409);
  if (operation === 'revoke' && (!current || current.state !== 'active'))
    fail('VERSION_MISMATCH', '当前没有可撤回的有效授权，请刷新详情。', 409);
  if (operation === 'grant' && current?.state === 'active')
    fail('VERSION_MISMATCH', '当前已有有效授权；调整范围请使用“调整授权”。', 409);
  if (expectedVersionId !== (current?.id ?? null))
    fail('VERSION_MISMATCH', '客户授权已变化，请刷新后重新核对。', 409);
  const pending = await tx.fabricUseAuthorizationRequest.findFirst({ where: { productAssetId, ownerRelationId, granteeRelationId }, orderBy: { recordedAt: 'desc' } });
  if (pending) {
    const linked = await tx.businessConfirmation.findFirst({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: pending.id } });
    if (!linked) fail('AUTHORIZATION_PENDING', '该客户已有一项授权申请待登记答复，请先完成或刷新原申请。', 409);
  }
  const now = BigInt(input.now ?? Date.now());
  const requestId = `FUA__${crypto.randomUUID()}`;
  const finalContentFingerprint = snapshot.finalContentFingerprint;
  const scopeFingerprint = snapshot.scopeFingerprint;
  const auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actor.userId,
    source: 'products:fabric-use-authorization', operation: 'fabric_use_authorization_requested',
    targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: requestId,
    after: { productAssetId, ownerRelationId, granteeRelationId, operation, allowedActions, expectedVersionId,
      finalContentFingerprint, scopeFingerprint }, ip: input.ip, operationType: 'create', transactionId: input.requestKey });
  const request = await tx.fabricUseAuthorizationRequest.create({ data: {
    id: requestId, productAssetId, ownerRelationId, granteeRelationId, operation, expectedVersionId,
    allowedActions: allowedActions as any, effectiveFrom, effectiveUntil,
    finalContentFingerprint, scopeFingerprint, productSnapshot: snapshot.productSnapshot as any,
    requestKey: input.requestKey, requestFingerprint, recordedBy: input.actor.userId, recordedAt: now,
  } });
  return { request, replayed: false, ownerName: owner.name, granteeName: grantee.name };
}

export function createFabricUseAuthorizationCustomerConfirmationAdapter(options: { prisma: PrismaClient }): CustomerConfirmationTargetAdapter {
  void options.prisma;

  async function inspect(tx: any, targetId: string, actor: TokenPayload, mode: 'read' | 'confirm' | 'replay') {
    const required = mode === 'read' ? 'products:read' : 'products:write';
    if (!actor?.userId || actor.authorizationLoaded !== true || !hasScope({ ...actor, roles: [] }, required))
      throw new CustomerConfirmationError('FORBIDDEN', '当前账号无权读取或登记此面料客户授权。', 403);
    const hint = await tx.fabricUseAuthorizationRequest.findUnique({ where: { id: targetId } });
    if (!hint) throw new CustomerConfirmationError('NOT_FOUND', '面料授权申请不存在或当前无权查看。', 404);
    if (mode !== 'read') await takeAuthorizationLock(tx, hint.productAssetId, hint.ownerRelationId, hint.granteeRelationId);
    const { product, exclusive } = await lockProductAndExclusiveOwner(tx, hint.productAssetId, { allowDeleted: mode !== 'confirm' });
    const currentOwnerId = exclusive?.customerOrganizationId ?? null;
    const productActive = product.deletedAt == null && String(product.status).toLowerCase() !== 'archived';
    const bindingCurrent = product.mainCategory === 'Fabric' && productActive && currentOwnerId === hint.ownerRelationId;
    if (mode === 'confirm' && !bindingCurrent)
      throw new CustomerConfirmationError('VERSION_MISMATCH', '产品归属或状态已变化，须重新核对授权范围。', 409);
    await assertRelationBusinessAccess(tx, actor, hint.ownerRelationId, mode === 'read' ? 'read' : 'write');
    await assertRelationBusinessAccess(tx, actor, hint.granteeRelationId, 'read');
    const current = await latestVersion(tx, hint.productAssetId, hint.ownerRelationId, hint.granteeRelationId);
    const expectedVersionCurrent = (current?.id ?? null) === (hint.expectedVersionId ?? null);
    if (mode === 'confirm' && !expectedVersionCurrent)
      throw new CustomerConfirmationError('VERSION_MISMATCH', '该客户的授权版本已变化，不能确认旧申请。', 409);
    const snapshot = await requestSnapshot(tx, { productAssetId: hint.productAssetId, ownerRelationId: hint.ownerRelationId,
      granteeRelationId: hint.granteeRelationId, operation: hint.operation, allowedActions: activeActions({ allowedActions: hint.allowedActions }),
      effectiveFrom: hint.effectiveFrom, effectiveUntil: hint.effectiveUntil, expectedVersionId: hint.expectedVersionId });
    const contentCurrent = snapshot.finalContentFingerprint === hint.finalContentFingerprint
      && snapshot.scopeFingerprint === hint.scopeFingerprint;
    if (mode === 'confirm' && !contentCurrent)
      throw new CustomerConfirmationError('VERSION_MISMATCH', '授权内容或客户范围已变化，不能沿用旧确认。', 409);
    const confirmations = await tx.businessConfirmation.findMany({
      where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId }, orderBy: { revision: 'desc' },
    });
    const accepted = confirmations.find((row: any) => row.finalContentFingerprint === hint.finalContentFingerprint
      && row.scopeFingerprint === hint.scopeFingerprint && row.outcome === 'accepted');
    const proofValid = accepted ? await verifyConfirmationEvidence(tx, accepted) : false;
    const latest = confirmations[0] ?? null;
    // Applying this request creates its own next version. That change must not
    // detach the proof from the very request it confirmed. New submissions still
    // require the original expected version above and an undecided request.
    const appliedOwnVersion = current?.requestId === hint.id && current?.confirmationId === accepted?.id && proofValid;
    const targetCurrent = bindingCurrent && contentCurrent && (expectedVersionCurrent || appliedOwnVersion);
    const eligible = bindingCurrent && contentCurrent && expectedVersionCurrent && !latest
      && (hint.operation === 'grant' || hint.operation === 'replace' || hint.operation === 'revoke');
    const grantee = (await validCustomerRelations(tx, [hint.granteeRelationId])).get(hint.granteeRelationId);
    const owner = (await validCustomerRelations(tx, [hint.ownerRelationId])).get(hint.ownerRelationId);
    const actions = activeActions({ allowedActions: hint.allowedActions });
    const scope = snapshot.displayScope;
    const currentFinalContentFingerprint = targetCurrent ? hint.finalContentFingerprint
      : stableHash({ historicalFingerprint: hint.finalContentFingerprint, currentProduct: productFact(product), currentOwnerId,
        currentVersionId: current?.id ?? null, deleted: product.deletedAt != null });
    const currentScopeFingerprint = targetCurrent ? hint.scopeFingerprint
      : stableHash({ historicalScopeFingerprint: hint.scopeFingerprint, currentOwnerId, currentVersionId: current?.id ?? null,
        productActive, productCategory: product.mainCategory });
    return {
      eligible,
      businessLabel: '面料客户授权',
      businessReference: `${product.sku || product.name} · ${statusLabel(hint.operation)}`,
      versionLabel: '本次授权版本',
      scopeLabel: actions.map(action => FABRIC_USE_ACTION_LABELS[action]).join('、') || '撤回当前授权',
      finalContentFingerprint: currentFinalContentFingerprint,
      internalApprovalId: null,
      scopeFingerprint: currentScopeFingerprint,
      scope,
      // The owner customer is the source of permission for this exclusive fabric.
      // validCustomerRelations deliberately does not select a contact email; never
      // infer a sending address from a field that is not part of that query.
      recommendation: { relationId: owner?.id ?? hint.ownerRelationId },
      nativeStatus: { state: accepted && proofValid ? (hint.operation === 'revoke' ? 'revoked' : 'active') : latest?.outcome === 'rejected' ? 'customer_rejected' : 'awaiting_customer',
        current: targetCurrent, currentProductStatus: product.status, currentProductDeleted: product.deletedAt != null,
        productName: product.name, ownerName: owner?.name ?? '', granteeName: grantee?.name ?? '', operation: hint.operation,
        allowedActions: actions.map(action => FABRIC_USE_ACTION_LABELS[action]), effectiveFrom: hint.effectiveFrom?.toString() ?? null,
        effectiveUntil: hint.effectiveUntil?.toString() ?? null, customerOutcome: latest?.outcome ?? null },
    };
  }

  return {
    targetType: FABRIC_USE_AUTHORIZATION_TARGET,
    async searchTargetIds(tx: any, actor: TokenPayload, input: { sourceEmail: { orderId?: string | null; relationId?: string | null }; businessReference?: string }) {
      if (!actor?.userId || actor.authorizationLoaded !== true || !hasScope({ ...actor, roles: [] }, 'products:read'))
        throw new CustomerConfirmationError('FORBIDDEN', '当前账号无权搜索面料客户授权事项。', 403);
      const relationId = nonempty(input.sourceEmail?.relationId);
      if (relationId) await assertRelationBusinessAccess(tx, actor, relationId, 'read');
      const reference = nonempty(input.businessReference);
      let productAssetIds: string[] = [];
      if (reference) {
        // The exact native request identifier is also a valid selector. It is
        // never enumerated globally and is still re-inspected by the route.
        if (reference.startsWith('FUA__')) {
          const request = await tx.fabricUseAuthorizationRequest.findUnique({ where: { id: reference },
            select: { id: true, ownerRelationId: true, granteeRelationId: true } });
          if (!request || (relationId && request.ownerRelationId !== relationId && request.granteeRelationId !== relationId)) return [];
          return [request.id];
        }
        // Exact native product reference only; ambiguous duplicate SKUs/articles
        // fail closed. Names and internal IDs are never used as authorization keys.
        const products = await tx.productAsset.findMany({ where: { deletedAt: null, mainCategory: 'Fabric', OR: [
          { sku: reference }, { fabricProfile: { is: { articleNo: reference } } },
        ] }, select: { id: true }, take: 3 });
        if (products?.length !== 1) return [];
        productAssetIds = [products[0].id];
      }
      if (productAssetIds.length) {
        const rows = await tx.fabricUseAuthorizationRequest.findMany({ where: {
          productAssetId: productAssetIds[0],
          ...(relationId ? { OR: [{ ownerRelationId: relationId }, { granteeRelationId: relationId }] } : {}),
        }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { id: true }, take: 40 });
        return (rows ?? []).map((row: any) => row.id).filter((id: any) => typeof id === 'string');
      }
      if (!relationId) return [];
      const rows = await tx.fabricUseAuthorizationRequest.findMany({ where: { OR: [
        { ownerRelationId: relationId }, { granteeRelationId: relationId },
      ] }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { id: true }, take: 40 });
      return (rows ?? []).map((row: any) => row.id).filter((id: any) => typeof id === 'string');
    },
    inspect,
    // A duplicate command reads its committed receipt using fresh write access.
    // The original request is no longer eligible after its own version applies.
    inspectReplay: (tx, targetId, actor) => inspect(tx, targetId, actor, 'replay'),
    async onRecordedInTx(tx, input) {
      const snapshot = await inspect(tx, input.targetId, input.actor, 'read');
      if (input.command.outcome !== 'accepted')
        return { nativeStatus: snapshot.nativeStatus, effect: { status: 'not_applicable', reason: '客户未接受，未产生授权版本。' } };
      if (input.confirmation.internalApprovalId !== null || input.confirmation.finalContentFingerprint !== snapshot.finalContentFingerprint
        || input.confirmation.scopeFingerprint !== snapshot.scopeFingerprint || !await verifyConfirmationEvidence(tx, input.confirmation))
        throw new CustomerConfirmationError('CUSTOMER_CONFIRMATION_REQUIRED', '客户接受记录、证据原件或授权范围无法核验，未产生授权版本。', 409);
      const hint = await tx.fabricUseAuthorizationRequest.findUnique({ where: { id: input.targetId } });
      if (!hint) throw new CustomerConfirmationError('NOT_FOUND', '面料授权申请不存在。', 404);
      const priorVersion = await tx.fabricUseAuthorizationVersion.findUnique({ where: { confirmationId: input.confirmation.id } });
      if (priorVersion) return { nativeStatus: snapshot.nativeStatus, effect: { status: 'recorded', versionId: priorVersion.id, replayed: true } };
      const latest = await latestVersion(tx, hint.productAssetId, hint.ownerRelationId, hint.granteeRelationId);
      if ((latest?.id ?? null) !== (hint.expectedVersionId ?? null))
        throw new CustomerConfirmationError('VERSION_MISMATCH', '授权版本已变化，未保存新的有效授权。', 409);
      const operation = hint.operation;
      if (operation === 'replace' && latest?.state !== 'active' || operation === 'revoke' && latest?.state !== 'active')
        throw new CustomerConfirmationError('VERSION_MISMATCH', '当前没有符合条件的有效授权版本。', 409);
      const revision = (latest?.revision ?? 0) + 1;
      const versionId = `FUAV__${crypto.randomUUID()}`;
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actor.userId,
        source: 'products:fabric-use-authorization', operation: operation === 'revoke' ? 'fabric_use_authorization_revoked' : 'fabric_use_authorization_accepted',
        targetType: 'FabricUseAuthorizationVersion', targetId: versionId,
        after: { productAssetId: hint.productAssetId, ownerRelationId: hint.ownerRelationId, granteeRelationId: hint.granteeRelationId,
          revision, state: operation === 'revoke' ? 'revoked' : 'active', allowedActions: operation === 'revoke' ? latest?.allowedActions : hint.allowedActions,
          confirmationId: input.confirmation.id, requestId: hint.id }, operationType: 'create', transactionId: input.confirmation.id });
      const version = await tx.fabricUseAuthorizationVersion.create({ data: {
        id: versionId, productAssetId: hint.productAssetId, ownerRelationId: hint.ownerRelationId, granteeRelationId: hint.granteeRelationId,
        revision, state: operation === 'revoke' ? 'revoked' : 'active',
        allowedActions: (operation === 'revoke' ? latest.allowedActions : hint.allowedActions) as any,
        effectiveFrom: operation === 'revoke' ? null : hint.effectiveFrom,
        effectiveUntil: operation === 'revoke' ? BigInt(Date.now()) : hint.effectiveUntil,
        requestId: hint.id, confirmationId: input.confirmation.id, supersedesVersionId: latest?.id ?? null,
        recordedBy: input.actor.userId, recordedAt: BigInt(Date.now()), auditId,
      } });
      return { nativeStatus: { ...snapshot.nativeStatus, state: version.state, revision }, effect: { status: version.state, versionId, revision } };
    },
  };
}

export interface AuthorizeFabricUseInput {
  productAssetId: string;
  customerRelationId: string;
  action: FabricUseAction;
  actor: TokenPayload;
  now?: number;
}

export async function authorizeFabricUseInTx(tx: any, input: AuthorizeFabricUseInput) {
  if (!ACTION_SET.has(input.action)) fail('INVALID_INPUT', '面料业务使用类型无效。', 400);
  const productAssetId = nonempty(input.productAssetId), customerRelationId = nonempty(input.customerRelationId);
  if (!productAssetId || !customerRelationId) fail('EXCLUSIVE_FABRIC_BLOCKED', '专属面料的属主或当前客户待核对。', 409);
  await takeAuthorizationLock(tx, productAssetId);
  const { product, exclusive } = await lockProductAndExclusiveOwner(tx, productAssetId);
  if (String(product.status).toLowerCase() === 'archived') fail('PRODUCT_ARCHIVED', '已归档面料不能新增业务引用。', 409);
  if (!exclusive) return { allowed: true as const, basisKind: 'unrestricted' as const, productAssetId, ownerRelationId: null, granteeRelationId: customerRelationId, authorizationVersionId: null, action: input.action };
  const ownerRelationId = nonempty(exclusive.customerOrganizationId);
  const relationMap = await validCustomerRelations(tx, [customerRelationId, ownerRelationId ?? '']);
  if (!ownerRelationId || !relationMap.has(ownerRelationId) || !relationMap.has(customerRelationId))
    fail('EXCLUSIVE_FABRIC_BLOCKED', '专属面料属主或当前客户档案待核对，暂不能建立新业务引用。', 409);
  if (ownerRelationId === customerRelationId)
    return { allowed: true as const, basisKind: 'owner' as const, productAssetId, ownerRelationId, granteeRelationId: customerRelationId, authorizationVersionId: null, action: input.action };
  const current = await latestVersion(tx, productAssetId, ownerRelationId, customerRelationId);
  const allowed = current?.state === 'active' && activeActions(current).includes(input.action) && effective(current, BigInt(input.now ?? businessNowMs()))
    && !!await verifyConfirmationEvidence(tx, await tx.businessConfirmation.findUnique({ where: { id: current.confirmationId } }));
  if (!allowed) fail('EXCLUSIVE_FABRIC_BLOCKED', '该面料为其他客户专属，当前客户未获得此项使用授权。', 409);
  return { allowed: true as const, basisKind: 'grant' as const, productAssetId, ownerRelationId, granteeRelationId: customerRelationId, authorizationVersionId: current.id, action: input.action };
}

export async function recordFabricUseAuthorizationUseInTx(tx: any, input: {
  decision: Awaited<ReturnType<typeof authorizeFabricUseInTx>>;
  action: FabricUseAction;
  businessTargetType: string;
  businessTargetId: string;
  businessLineId?: string | null;
  businessVersionFingerprint: string;
  actorId: string;
  now?: number;
  ip?: string | null;
}) {
  const d = input.decision;
  if (d.basisKind === 'unrestricted') return null;
  if (!d.ownerRelationId || !HASH.test(input.businessVersionFingerprint) || !input.businessTargetType.trim()
    || !input.businessTargetId.trim() || !input.actorId || !ACTION_SET.has(input.action) || input.action !== d.action)
    fail('INVALID_INPUT', '面料授权使用记录信息不完整或业务动作与核验结果不一致。', 400);
  const useFact = { basisKind: d.basisKind, authorizationVersionId: d.authorizationVersionId,
    productAssetId: d.productAssetId, ownerRelationId: d.ownerRelationId, granteeRelationId: d.granteeRelationId,
    action: input.action, businessTargetType: input.businessTargetType, businessTargetId: input.businessTargetId,
    businessLineId: input.businessLineId ?? null, businessVersionFingerprint: input.businessVersionFingerprint };
  const useKey = stableHash(useFact);
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `fabric-use-fact:${useKey}`);
  const replay = await tx.fabricUseAuthorizationUse.findUnique({ where: { useKey } });
  if (replay) return replay;
  const id = `FUAU__${crypto.randomUUID()}`;
  const auditId = await writeRouteAuditLog({ prisma: tx, actorId: input.actorId,
    source: 'products:fabric-use-authorization', operation: 'fabric_use_authorization_used',
    targetType: 'FabricUseAuthorizationUse', targetId: id, after: useFact, ip: input.ip,
    operationType: 'create', transactionId: useKey });
  return tx.fabricUseAuthorizationUse.create({ data: { id, useKey,
    basisKind: d.basisKind, authorizationVersionId: d.authorizationVersionId, productAssetId: d.productAssetId,
    ownerRelationId: d.ownerRelationId, granteeRelationId: d.granteeRelationId, action: input.action,
    businessTargetType: input.businessTargetType, businessTargetId: input.businessTargetId,
    businessLineId: input.businessLineId ?? null, businessVersionFingerprint: input.businessVersionFingerprint,
    recordedBy: input.actorId, recordedAt: BigInt(input.now ?? Date.now()), auditId,
  } });
}

export async function checkAndRecordFabricUseInTx(tx: any, input: AuthorizeFabricUseInput & {
  businessTargetType: string; businessTargetId: string; businessLineId?: string | null;
  businessVersionFingerprint: string; ip?: string | null;
}) {
  const decision = await authorizeFabricUseInTx(tx, input);
  if (decision.basisKind === 'unrestricted') return decision;
  const usage = await recordFabricUseAuthorizationUseInTx(tx, { decision, action: input.action,
    businessTargetType: input.businessTargetType, businessTargetId: input.businessTargetId,
    businessLineId: input.businessLineId, businessVersionFingerprint: input.businessVersionFingerprint,
    actorId: input.actor.userId, now: input.now, ip: input.ip });
  return { ...decision, usage };
}

export async function readFabricUseAuthorizationHistory(prisma: PrismaClient, input: {
  productAssetId: string; actor: TokenPayload; now?: number;
}) {
  const db = prisma as any;
  const product = await db.productAsset.findFirst({ where: { id: input.productAssetId, deletedAt: null }, select: { id: true, mainCategory: true } });
  if (!product || product.mainCategory !== 'Fabric') fail('NOT_FOUND', '面料档案不存在或当前无权查看。', 404);
  const exclusive = await db.fabricCustomerCode.findFirst({ where: { productAssetId: product.id, isExclusive: true, deletedAt: null } });
  if (!exclusive?.customerOrganizationId) return { ownerRelationId: null, ownerName: null,
    actionOptions: Object.entries(FABRIC_USE_ACTION_LABELS).map(([value, label]) => ({ value, label })), items: [], activeGrants: [] };
  await assertRelationBusinessAccess(db, input.actor, exclusive.customerOrganizationId, 'read');
  const [requests, versions] = await Promise.all([
    db.fabricUseAuthorizationRequest.findMany({ where: { productAssetId: product.id, ownerRelationId: exclusive.customerOrganizationId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], include: { grantee: { select: { id: true, name: true } }, recorder: { select: { id: true, displayName: true } } } }),
    db.fabricUseAuthorizationVersion.findMany({ where: { productAssetId: product.id, ownerRelationId: exclusive.customerOrganizationId },
      orderBy: [{ revision: 'desc' }], include: { grantee: { select: { id: true, name: true } }, recorder: { select: { id: true, displayName: true } }, confirmation: true } }),
  ]);
  const confirmationByRequest = new Map<string, any>();
  for (const row of requests) {
    const confirmation = await db.businessConfirmation.findFirst({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: row.id }, orderBy: { revision: 'desc' } });
    if (confirmation) confirmationByRequest.set(row.id, confirmation);
  }
  const versionByRequest = new Map<string, any>(versions.map((row: any) => [row.requestId, row]));
  const currentByPair = new Map<string, any>();
  for (const row of versions) {
    const key = `${row.productAssetId}|${row.ownerRelationId}|${row.granteeRelationId}`;
    if (!currentByPair.has(key) || row.revision > currentByPair.get(key).revision) currentByPair.set(key, row);
  }
  const items = await Promise.all(requests.map(async (request: any) => {
    const confirmation = confirmationByRequest.get(request.id) ?? null;
    const version = versionByRequest.get(request.id) ?? null;
    const current = currentByPair.get(`${request.productAssetId}|${request.ownerRelationId}|${request.granteeRelationId}`);
    const currentActive = current?.state === 'active' && current.id === version?.id && effective(current, BigInt(input.now ?? businessNowMs()));
    const status = version?.state === 'revoked' ? 'revoked'
      : currentActive ? 'active'
        : confirmation?.outcome === 'rejected' ? 'customer_rejected'
          : confirmation?.outcome === 'partial' ? 'needs_review'
            : confirmation?.outcome === 'accepted' ? 'historical' : 'awaiting_customer';
    return {
      requestId: request.id, operation: request.operation, status,
      ownerRelationId: request.ownerRelationId,
      granteeRelationId: request.granteeRelationId,
      granteeName: request.grantee?.name ?? '客户档案待核对',
      allowedActions: (request.operation === 'revoke' ? version?.allowedActions : request.allowedActions) ?? [],
      actionLabels: ((request.operation === 'revoke' ? version?.allowedActions : request.allowedActions) ?? [])
        .filter((action: any) => ACTION_SET.has(action)).map((action: FabricUseAction) => FABRIC_USE_ACTION_LABELS[action]),
      currentVersionId: current?.id ?? null,
      currentVersionState: current?.state ?? null,
      effectiveFrom: request.effectiveFrom?.toString() ?? null,
      effectiveUntil: request.effectiveUntil?.toString() ?? null,
      recordedAt: request.recordedAt?.toString() ?? null,
      recordedByName: request.recorder?.displayName ?? null,
      confirmationTarget: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: request.id,
        businessLabel: '面料客户授权', businessReference: request.productSnapshot?.sku || request.productSnapshot?.name || '面料授权',
        versionLabel: `授权申请`, scopeLabel: statusLabel(request.operation),
        finalContentFingerprint: request.finalContentFingerprint, internalApprovalId: null,
        scopeFingerprint: request.scopeFingerprint, scope: await awaitDisplayScope(db, request) },
      canRevoke: currentActive && input.actor.authorizationLoaded === true && hasScope({ ...input.actor, roles: [] }, 'products:write'),
    };
  }));
  return { ownerRelationId: exclusive.customerOrganizationId,
    ownerName: exclusive.customerNameSnapshot ?? (await db.relation.findUnique({ where: { id: exclusive.customerOrganizationId }, select: { name: true } }))?.name ?? null,
    actionOptions: Object.entries(FABRIC_USE_ACTION_LABELS).map(([value, label]) => ({ value, label })),
    items, activeGrants: items.filter((item: any) => item.status === 'active') };
}

async function awaitDisplayScope(_db: any, request: any) {
  const snapshot = request.productSnapshot ?? {};
  const ownerName = (await _db.relation.findUnique({ where: { id: request.ownerRelationId }, select: { name: true } }))?.name ?? '属主客户';
  const granteeName = (await _db.relation.findUnique({ where: { id: request.granteeRelationId }, select: { name: true } }))?.name ?? '授权客户';
  return { schemaVersion: 1, product: { name: snapshot.name, sku: snapshot.sku, articleNo: snapshot.fabric?.articleNo ?? null,
    millQuality: snapshot.fabric?.millQuality ?? null, color: snapshot.fabric?.millColorCode ?? null },
    ownerCustomer: ownerName, authorizedCustomer: granteeName, operation: statusLabel(request.operation),
    allowedActions: (Array.isArray(request.allowedActions) ? request.allowedActions : []).filter((action: any) => ACTION_SET.has(action))
      .map((action: FabricUseAction) => FABRIC_USE_ACTION_LABELS[action]),
    effectiveFrom: request.effectiveFrom?.toString() ?? null, effectiveUntil: request.effectiveUntil?.toString() ?? null };
}

export async function currentFabricAuthorizationActor(prisma: PrismaClient, prior: TokenPayload | null | undefined, scope: string) {
  try {
    return await currentCustomerConfirmationActor(prisma, prior, scope);
  } catch (error: any) {
    if (error instanceof CustomerConfirmationError) fail(error.code === 'AUTHORIZATION_UNAVAILABLE' ? 'AUTHORIZATION_UNAVAILABLE' : 'FORBIDDEN', error.message, error.statusCode);
    throw error;
  }
}
