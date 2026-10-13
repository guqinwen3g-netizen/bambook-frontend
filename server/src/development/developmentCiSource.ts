import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { exactJsonValue } from '../lib/exactJsonValue';
import { businessError, isBusinessError } from '../shared/errorCodes';

export const DEVELOPMENT_CI_PREFIX = 'business-ci:v1:development:';
export const DEVELOPMENT_CI_V2_PREFIX = 'business-ci:v2:development:';
export const DEVELOPMENT_CI_SOURCE = 'BusinessDevelopmentCI';
export const ciJson = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const ciHash = (value: any): string => createHash('sha256').update(JSON.stringify(canonical(ciJson(value)))).digest('hex');
export const developmentCiRef = (caseId: string, billingItemId: string) => `${DEVELOPMENT_CI_PREFIX}${caseId}:${billingItemId}`;
export const developmentCiV2Ref = (caseId: string, documentId: string) => `${DEVELOPMENT_CI_V2_PREFIX}${caseId}:${documentId}`;
export const developmentCiCaseWhere = (caseId?: string) => ({ type: 'CommercialInvoice', domain: 'finance', sourceInvoiceId: null,
  OR: [DEVELOPMENT_CI_PREFIX, DEVELOPMENT_CI_V2_PREFIX].map(prefix => ({ sourceRef: { startsWith: caseId ? `${prefix}${caseId}:` : prefix } })) });
export const developmentCiBillingItemIds = (snapshot: any): string[] => snapshot.protocolVersion === 1 ? [snapshot.billingItemId] : snapshot.billingItemIds;
export const developmentCiBillingAllocations = (snapshot: any): any[] => snapshot.protocolVersion === 1
  ? [{ billingItemId: snapshot.billingItemId, amount: snapshot.totalAmount, currency: snapshot.currency, description: snapshot.fields.note }]
  : snapshot.billingAllocations;
export function ciConflict(message: string): never { throw businessError('CONFLICT', message); }
export function ciInvisible(): never { throw businessError('NOT_FOUND', '票据或原业务来源不存在，或当前无权访问。'); }
export const isDevelopmentCi = (row: any) => row?.type === 'CommercialInvoice' && row.domain === 'finance'
  && row.sourceInvoiceId == null && typeof row.sourceRef === 'string' && [DEVELOPMENT_CI_PREFIX, DEVELOPMENT_CI_V2_PREFIX].some(prefix => row.sourceRef.startsWith(prefix));

/** Stored grants and the initiating credential ceiling are both authoritative. */
export async function currentCiActor(tx: any, prior: TokenPayload | null | undefined, scopes: readonly PermissionScope[]): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前登录账号处理票据。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '当前票据权限暂时无法核验。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  for (const scope of scopes) if (!hasScope(actor, scope)) throw businessError('FORBIDDEN', '当前账号没有此票据操作权限。');
  return actor;
}

export async function authorizeDevelopmentCiCase(tx: any, prior: TokenPayload | null | undefined, caseId: string,
  mode: 'business-read' | 'business-write' | 'finance-read' | 'finance-write') {
  const finance = mode.startsWith('finance'), writing = mode.endsWith('write');
  const actor = await currentCiActor(tx, prior, finance ? ['invoices:read', ...(writing ? ['invoices:write' as const] : [])]
    : [writing ? 'products:write' : 'products:read']);
  const development = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
  if (!development?.customerRelationId) ciInvisible();
  const customer = await tx.relation.findFirst({ where: { id: development.customerRelationId, deletedAt: null } });
  if (!customer) ciInvisible();
  const resolver = await createPermissionService({ prisma: tx }).getDataScopeResolver(actor, finance ? 'finance' : 'products');
  // Follow-up and actual team grants are source L2. A separate relations role
  // with directory/global write visibility cannot enlarge products/finance.
  const follows = customer.ownerId === actor.userId || Array.isArray(customer.salesRepIds) && customer.salesRepIds.includes(actor.userId);
  if (resolver.rule.kind !== 'all' && !follows) {
    if (resolver.rule.kind !== 'team') ciInvisible();
    const grant = await tx.teamDataGrant.findFirst({ where: { entityType: 'relation', entityId: customer.id,
      teamId: { in: resolver.allowedTeamIds ?? [] }, revokedAt: null, team: { deletedAt: null },
      permission: writing ? 'read+followup' : { in: ['read', 'read+followup'] } }, select: { id: true } });
    if (!grant) ciInvisible();
  }
  return { actor, development, customer };
}

export function developmentCiSnapshot(version: any, document: any) {
  const snapshot = version?.content?.developmentCommercialInvoiceSnapshot;
  if (snapshot?.protocolVersion === 2) return developmentCiV2Snapshot(snapshot, document);
  if (!isDevelopmentCi(document) || !snapshot || snapshot.protocolVersion !== 1 || snapshot.sourceKind !== 'development'
    || !snapshot.caseId || !snapshot.billingItemId || document.sourceRef !== developmentCiRef(snapshot.caseId, snapshot.billingItemId)
    || document.relationId !== snapshot.customerRelationId || document.currency !== snapshot.currency
    || !new Prisma.Decimal(String(snapshot.totalAmount)).eq(document.totalAmount)
    || !Array.isArray(snapshot.costs) || !Array.isArray(snapshot.lines) || snapshot.lines.length !== 1
    || snapshot.lines[0].sourceType !== 'BillingItem' || snapshot.lines[0].sourceId !== snapshot.billingItemId
    || !new Prisma.Decimal(String(snapshot.lines[0].amount)).eq(snapshot.totalAmount)
    || snapshot.lines[0].currency !== snapshot.currency
    || !snapshot.sourceFingerprint || !snapshot.parties?.billTo?.name || !snapshot.exporterSnapshot?.nameEn
    || !snapshot.fields?.billTo?.name || !snapshot.fields?.exporter?.nameEn) ciConflict('开发 CI 的冻结来源快照缺失或与原票不一致。');
  if (snapshot.issueDate !== document.issueDate || snapshot.fields?.issueDate !== snapshot.issueDate
    || (snapshot.fields?.dueDate ?? null) !== (snapshot.dueDate ?? null) || snapshot.fields?.paymentTerms !== snapshot.paymentTerms
    || ciHash(snapshot.fields?.billTo) !== ciHash({ name: snapshot.parties.billTo.name, address: snapshot.parties.billTo.address })
    || ciHash(snapshot.fields?.exporter) !== ciHash(snapshot.exporterSnapshot)) ciConflict('开发 CI 票面字段与冻结版本不一致。');
  const { snapshotFingerprint, ...content } = snapshot;
  if (!snapshotFingerprint || snapshotFingerprint !== ciHash(content)) ciConflict('开发 CI 冻结版本校验失败。');
  return snapshot;
}

function developmentCiV2Snapshot(snapshot: any, document: any) {
  try {
    const ids = snapshot.billingItemIds, allocations = snapshot.billingAllocations, lines = snapshot.chargeLines;
    if (!isDevelopmentCi(document) || snapshot.sourceKind !== 'development' || !snapshot.caseId
      || !Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id: any) => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length || ciHash(ids) !== ciHash([...ids].sort())
      || !(document.sourceRef === developmentCiV2Ref(snapshot.caseId, document.id)
        || ids.length === 1 && document.sourceRef === developmentCiRef(snapshot.caseId, ids[0]))
      || document.relationId !== snapshot.customerRelationId || document.currency !== snapshot.currency
      || !new Prisma.Decimal(snapshot.totalAmount).gt(0) || !new Prisma.Decimal(snapshot.totalAmount).eq(document.totalAmount)
      || !Array.isArray(snapshot.costs) || !Array.isArray(lines) || !lines.length || !Array.isArray(allocations) || allocations.length !== ids.length
      || ciHash(snapshot.lines) !== ciHash(lines) || new Set(lines.map((line: any) => line.id)).size !== lines.length
      || ciHash(allocations.map((line: any) => line.billingItemId).sort()) !== ciHash(ids)
      || !Array.isArray(snapshot.sourceDecisions) || ciHash(snapshot.sourceDecisions.map((row: any) => row.id).sort()) !== ciHash(ids)
      || !Array.isArray(snapshot.costSelections) || ciHash(snapshot.costSelections.map((row: any) => row.billingItemId).sort()) !== ciHash(ids))
      ciConflict('开发 CI 的多项冻结成员缺失或与原票不一致。');
    for (const id of ids) {
      const memberLines = lines.filter((line: any) => line.billingItemId === id), allocation = allocations.find((row: any) => row.billingItemId === id),
        decision = snapshot.sourceDecisions.find((row: any) => row.id === id), selection = snapshot.costSelections.find((row: any) => row.billingItemId === id);
      if (!memberLines.length || new Set(memberLines.map((line: any) => line.displayOrder)).size !== memberLines.length
        || memberLines.some((line: any) => !line.purpose || !line.description || !['DevelopmentCase', 'DevelopmentSampleRound', 'DevelopmentSampleVersion', 'SampleBatch'].includes(line.sourceType) || !line.sourceId || !line.sourceLabel
          || !line.roundLabel || !Number.isSafeInteger(line.displayOrder) || line.displayOrder < 0
          || line.sourceType === 'DevelopmentCase' && (line.sourceId !== snapshot.caseId || line.roundLabel !== '整案' || line.roundId != null || line.roundNumber != null)
          || line.sourceType !== 'DevelopmentCase' && (!Number.isSafeInteger(line.roundNumber) || line.roundNumber < 1 || line.roundLabel !== `R${line.roundNumber}`)
          || line.currency !== snapshot.currency || !new Prisma.Decimal(line.amount).gt(0) || new Prisma.Decimal(line.amount).decimalPlaces() > 4)
        || allocation.currency !== snapshot.currency || !memberLines.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount), new Prisma.Decimal(0)).eq(allocation.amount)
        || decision.currency !== snapshot.currency || decision.bearerType !== 'customer' || decision.bearerRelationId !== snapshot.customerRelationId
        || [decision.amount, decision.waivedAmount, decision.offsetAmount].some((value: any) => !new Prisma.Decimal(value).isFinite() || new Prisma.Decimal(value).lt(0) || new Prisma.Decimal(value).decimalPlaces() > 4)
        || !new Prisma.Decimal(decision.amount).minus(decision.waivedAmount).minus(decision.offsetAmount).eq(allocation.amount)
        || !decision.commercialFingerprint || selection.caseId !== snapshot.caseId || !Array.isArray(selection.costs) || selection.costFingerprint !== ciHash(selection.costs)
        || ciHash({ decision: { id, amount: String(decision.amount), waivedAmount: String(decision.waivedAmount), offsetAmount: String(decision.offsetAmount),
          currency: decision.currency, bearerType: decision.bearerType, bearerRelationId: decision.bearerRelationId, approvalId: decision.approvalId ?? null },
          chargeLines: memberLines, costSelection: selection }) !== decision.commercialFingerprint)
        ciConflict('开发 CI 商业明细的轮次、用途或净价分配不一致。');
    }
    if (lines.some((line: any) => !ids.includes(line.billingItemId))
      || ciHash(snapshot.costSelections.flatMap((selection: any) => selection.costs).sort((a: any, b: any) => a.id.localeCompare(b.id))) !== ciHash(snapshot.costs)
      || !allocations.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.amount), new Prisma.Decimal(0)).eq(snapshot.totalAmount)
      || new Set(snapshot.costs.map((cost: any) => cost.id)).size !== snapshot.costs.length
      || !snapshot.sourceFingerprint || !snapshot.parties?.billTo?.name || !snapshot.exporterSnapshot?.nameEn
      || !snapshot.fields?.billTo?.name || !snapshot.fields?.exporter?.nameEn) ciConflict('开发 CI 冻结金额或商业来源不一致。');
    const facts = { caseId: snapshot.caseId, caseCode: snapshot.caseCode, customerRelationId: snapshot.customerRelationId, billingItemIds: ids,
      sourceDecisions: snapshot.sourceDecisions, chargeLines: lines, billingAllocations: allocations, costSelections: snapshot.costSelections,
      costs: snapshot.costs, costTotals: snapshot.costTotals, currency: snapshot.currency };
    if (ciHash(facts) !== snapshot.sourceFingerprint) ciConflict('开发 CI 商业成员或成本选择与冻结依据指纹不一致。');
    if (snapshot.issueDate !== document.issueDate || snapshot.fields.issueDate !== snapshot.issueDate
      || (snapshot.fields.dueDate ?? null) !== (snapshot.dueDate ?? null) || snapshot.fields.paymentTerms !== snapshot.paymentTerms
      || ciHash(snapshot.fields.billTo) !== ciHash({ name: snapshot.parties.billTo.name, address: snapshot.parties.billTo.address })
      || ciHash(snapshot.fields.exporter) !== ciHash(snapshot.exporterSnapshot)) ciConflict('开发 CI 票面字段与冻结版本不一致。');
    const { snapshotFingerprint, ...content } = snapshot;
    if (!snapshotFingerprint || snapshotFingerprint !== ciHash(content)) ciConflict('开发 CI 冻结版本校验失败。');
    return snapshot;
  } catch (error) {
    if (isBusinessError(error)) throw error;
    return ciConflict('开发 CI 多项冻结内容无效。');
  }
}

/** Issued snapshots remain historical facts when later costs or customer labels change. */
export async function readDevelopmentCiVersionInTx(tx: any, documentId: string, prior: TokenPayload | null | undefined,
  options: { version?: number; finance?: boolean; writing?: boolean } = {}) {
  const document = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  if (!isDevelopmentCi(document)) ciInvisible();
  const latestVersion = await tx.documentVersion.findFirst({ where: { documentId }, orderBy: { version: 'desc' } });
  const version = options.version === undefined ? latestVersion
    : await tx.documentVersion.findFirst({ where: { documentId, version: options.version } });
  if (!version || !latestVersion) ciConflict('开发 CI 版本不存在。');
  const snapshot = developmentCiSnapshot(version, version.id === latestVersion.id ? document : { ...document,
    // A selected old draft is rendered from its own header snapshot.
    currency: version.content?.developmentCommercialInvoiceSnapshot?.currency,
    totalAmount: version.content?.developmentCommercialInvoiceSnapshot?.totalAmount,
    issueDate: version.content?.developmentCommercialInvoiceSnapshot?.issueDate,
    sourceRef: version.content?.developmentCommercialInvoiceSnapshot?.protocolVersion === 1
      ? developmentCiRef(snapshotCaseId(version), version.content.developmentCommercialInvoiceSnapshot.billingItemId) : document.sourceRef });
  const access = await authorizeDevelopmentCiCase(tx, prior, snapshot.caseId,
    options.finance ? (options.writing ? 'finance-write' : 'finance-read') : (options.writing ? 'business-write' : 'business-read'));
  if (access.development.customerRelationId !== snapshot.customerRelationId) ciInvisible();
  const ids = developmentCiBillingItemIds(snapshot);
  for (const id of ids) {
    const billing = await tx.billingItem.findFirst({ where: { id, sourceType: 'DevelopmentCase', sourceId: snapshot.caseId, deletedAt: null } });
    if (!billing) ciInvisible();
  }
  if (snapshot.protocolVersion === 2 && version.id === latestVersion.id && ['Draft', 'Issued'].includes(document.status)) {
    const claims = await tx.developmentCiBillingClaim.findMany({ where: { documentId, releasedAt: null } });
    if (ciHash(claims.map((claim: any) => claim.billingItemId).sort()) !== ciHash(ids)
      || claims.some((claim: any) => document.status === 'Issued' && claim.issuedVersionId !== version.id)) ciConflict('原票收费成员占用与冻结版本不一致。');
  }
  if (version.id === latestVersion.id && (document.status === 'Issued') !== Boolean(snapshot.issuedAt)) ciConflict('开发 CI 当前状态与签发版本不一致。');
  const finalDocument = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } });
  const finalVersion = await tx.documentVersion.findFirst({ where: { documentId, version: version.version } });
  if (!finalDocument || !finalVersion || ciHash(finalDocument) !== ciHash(document) || ciHash(finalVersion) !== ciHash(version)) ciConflict('原票在读取过程中变化，请重新读取。');
  await authorizeDevelopmentCiCase(tx, prior, snapshot.caseId, options.finance ? (options.writing ? 'finance-write' : 'finance-read') : (options.writing ? 'business-write' : 'business-read'));
  return { document: ciJson(document), version: ciJson(version), latestVersion: ciJson(latestVersion), snapshot: ciJson(snapshot), actor: access.actor };
}

const snapshotCaseId = (version: any) => version.content?.developmentCommercialInvoiceSnapshot?.caseId;
