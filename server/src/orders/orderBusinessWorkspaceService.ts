import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { currentOrderLineWriteActor, freshOrderLineScope } from './orderLineWriteAccess';
import { businessError } from '../shared/errorCodes';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { assertConfirmedFabricSourceEligible } from '../development/fabricAssetEligibility';
import { resolveGarmentMaterialProof } from './internalFabricGate';
import { readRequiredSampleFamilies } from './orderRequiredSampleFamilies';
import { evaluateProductionRelease } from '../production/releaseService';
import { exactJsonValue } from '../lib/exactJsonValue';
import { assembleBusinessWorkspace, continueBusinessWorkspace, readWorkspaceActivations, workspaceDigest, parseWorkspaceScope,
  type WorkspaceAdapter, type WorkspaceNodeFact } from '../shared/businessWorkspaceContinuation';
import type { BusinessWorkspaceScope } from '../shared/businessWorkspaceContract';

const reason = (code: string, message: string) => ({ code, message });
type OrderWorkspaceScope = Extract<BusinessWorkspaceScope, { kind: 'order_main' | 'order_line' | 'production_branch' }>;
function assertScope(scope: BusinessWorkspaceScope, orderId: string): asserts scope is OrderWorkspaceScope {
  if (!['order_main', 'order_line', 'production_branch'].includes(scope.kind) || !('orderId' in scope) || scope.orderId !== orderId)
    throw businessError('INVALID_INPUT', '工作区不属于当前准确订单。');
}
async function currentReadActor(db: any, prior: TokenPayload | null | undefined) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请登录后读取准确订单工作区。');
  const user = await loadUserWithRoles(db, prior.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
  const actor = await buildLoadedAuthTokenPayload(db, user);
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有订单读取权限。');
  return actor;
}

export function createOrderBusinessWorkspaceService(options: { prisma: any }) {
  const adapter = (orderId: string, prior: TokenPayload | null | undefined): WorkspaceAdapter => ({
    async authorize(db, scope, mode) {
      assertScope(scope, orderId);
      const actor = mode === 'read' ? await currentReadActor(db, prior) : await currentOrderLineWriteActor(db, prior, 'update');
      const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [await freshOrderLineScope(db, actor)] }, select: { id: true } });
      if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不在当前范围。');
      if (scope.kind !== 'order_main') {
        const line = await db.orderLine.findUnique({ where: { id: scope.orderLineId }, select: { id: true, orderId: true } });
        if (!line || line.orderId !== orderId) throw businessError('ORDER_LINE_NOT_FOUND', '所选准确条目不属于当前订单。');
        if (scope.kind === 'production_branch') {
          const batch = await db.productionBatch.findUnique({ where: { id: scope.productionBatchId }, select: { orderId: true, orderLineId: true, revision: true } });
          if (!batch || batch.orderId !== orderId || batch.orderLineId !== scope.orderLineId) throw businessError('NOT_FOUND', '准确工厂分支不属于当前条目。');
          if (batch.revision !== scope.productionBatchRevision) throw businessError('CONFLICT', '工厂分支已变更，请读取当前准确修订。');
        }
      }
      return actor;
    },
    async lock(db, scope) {
      assertScope(scope, orderId);
      await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
      if (scope.kind !== 'order_main') await db.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${scope.orderLineId} AND "orderId"=${orderId} FOR UPDATE`);
      if (scope.kind === 'production_branch') await db.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "id"=${scope.productionBatchId} AND "orderId"=${orderId} AND "orderLineId"=${scope.orderLineId} FOR UPDATE`);
    },
    async context(db, scope, actor) {
      assertScope(scope, orderId);
      const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) throw businessError('ORDER_NOT_FOUND', '订单已不可读。');
      const [lines, approvals, batches] = await Promise.all([
        db.orderLine.findMany({ where: { orderId }, orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] }),
        db.approvalRequest.findMany({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: orderId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        db.productionBatch.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
      ]);
      const latest = approvals[0] ?? null, pending = latest?.status === 'pending';
      const approved = approvals.find((row: any) => row.status === 'approved' && row.reviewerId && row.decidedAt != null && row.payload?.snapshot?.order?.id === orderId);
      const audit = approved ? await db.auditLog.findFirst({ where: { action: 'approve_order_main_approval', targetType: 'ApprovalRequest', targetId: approved.id, actorId: approved.reviewerId,
        detail: { path: ['source'], equals: 'api:order-main-approval' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : null;
      const formal = !pending && !['Pending', 'Cancelled', 'Archived'].includes(order.status) && !!approved && audit?.detail?.after?.orderId === orderId && audit.detail.after.decision === 'approved';
      const approvalReasons = formal ? [] : [reason(pending ? 'ORDER_APPROVAL_PENDING' : 'ORDER_MAIN_APPROVAL_REQUIRED', pending ? '主单审批处理中，履约尚未解锁。' : '缺少真实主单批准及完成审计；旧订单状态不能代替批准依据。')];
      const selected = scope.kind === 'order_main' ? null : lines.find((row: any) => row.id === scope.orderLineId);
      const branch = scope.kind === 'production_branch' ? batches.find((row: any) => row.id === scope.productionBatchId && row.orderLineId === scope.orderLineId) : null;
      if (scope.kind !== 'order_main' && !selected) throw businessError('ORDER_LINE_NOT_FOUND', '准确订单行已不可读。');
      let sourceReasons: Array<{ code: string; message: string }> = [], materialReasons: Array<{ code: string; message: string }> = [];
      if (selected) {
        if (!selected.confirmedSourceType || !selected.confirmedSourceId || selected.specSnapshot == null) sourceReasons = [reason('CONFIRMED_SOURCE_NOT_FOUND', '此条目尚无准确产品/开发版本来源及规格依据。')];
        else try { await assertConfirmedFabricSourceEligible(db, { type: selected.confirmedSourceType, id: selected.confirmedSourceId }); }
        catch (error) { if (error instanceof DevelopmentDomainError) sourceReasons = [reason(error.code, error.message)]; else throw error; }
        try { await resolveGarmentMaterialProof(db, order, selected); }
        catch (error) { if (error instanceof DevelopmentDomainError) materialReasons = [reason(error.code, error.message)]; else throw error; }
      }
      const ownBatches = selected ? batches.filter((row: any) => row.orderLineId === selected.id) : [];
      // Opening this neutral input area is not shipment eligibility. A real
      // approved branch release is the minimum recorded fulfillment basis;
      // planned quantities and all sending gates remain canonical preview input.
      const branchReleases = branch ? await db.releaseScope.findMany({ where: { orderId, orderLineId: selected.id,
        productionBatchId: branch.id, productionBatchRevision: branch.revision, deletedAt: null }, orderBy: { id: 'asc' } }) : [];
      let branchReleaseReady = false;
      if (branchReleases.length === 1) {
        const current = await evaluateProductionRelease({ prisma: db, scopeId: branchReleases[0].id });
        if (!current.ok) throw businessError('INTERNAL_ERROR', '当前准确工厂分支的履约依据暂时无法核验。');
        branchReleaseReady = current.data.eligible;
      }
      const handoffs = await db.shipmentHandoffLine.findMany({ where: { orderId, ...(selected ? { orderLineId: selected.id } : {}), ...(branch ? { productionBatchId: branch.id, productionBatchRevision: branch.revision } : {}) }, select: { id: true, handoffId: true, orderLineId: true, productionBatchId: true, productionBatchRevision: true } });
      const identity = { scope, order: { id: order.id, type: order.type, ownerId: order.ownerId, customerRelationId: order.customerRelationId ?? null },
        ...(selected ? { line: { id: selected.id, confirmedSourceType: selected.confirmedSourceType, confirmedSourceId: selected.confirmedSourceId,
          specSnapshot: selected.specSnapshot, quantity: selected.quantity, unit: selected.unit, fulfillmentMode: selected.fulfillmentMode, cmtIncludedItems: selected.cmtIncludedItems } } : {}),
        ...(branch ? { branch: { id: branch.id, revision: branch.revision, factoryRelationId: branch.factoryRelationId, sourceFingerprint: branch.sourceFingerprint } } : {}) };
      const activatedNodeIds = await readWorkspaceActivations(db, scope, workspaceDigest(identity));
      const lineReasons = selected ? [] : [reason('EXACT_ORDER_LINE_REQUIRED', '先明确打开某个产品条目，再办理该条目的履约。')];
      const facts: WorkspaceNodeFact[] = [
        { id: 'overview', label: '概况与主单审批', precedingIds: [], initial: true, hasHistory: false, eligible: true, blockedReasons: [], evidenceRefs: approvals.map((row: any) => ({ kind: 'ApprovalRequest', id: row.id })) },
        { id: 'agreement', label: '产品与约定', precedingIds: [], initial: true, hasHistory: formal, eligible: true, blockedReasons: [], evidenceRefs: lines.map((row: any) => ({ kind: 'OrderLine', id: row.id })) },
        { id: 'fulfillment', label: '本条履约与质量', precedingIds: ['agreement'], hasHistory: !!ownBatches.length, eligible: formal && !!selected && !sourceReasons.length,
          blockedReasons: [...approvalReasons, ...lineReasons, ...sourceReasons], evidenceRefs: ownBatches.map((row: any) => ({ kind: 'ProductionBatch', id: row.id, revision: row.revision })) },
        { id: 'shipment', label: '拟发范围预检与历史', precedingIds: ['fulfillment'], hasHistory: !!handoffs.length,
          eligible: formal && !!branch && branchReleaseReady && !sourceReasons.length && hasScope(actor, 'shipments:write'),
          blockedReasons: [...approvalReasons, ...sourceReasons, ...(!branch ? [reason('EXACT_PRODUCTION_BRANCH_REQUIRED', '先明确选择实际工厂分支及当前修订，再填写本次拟发范围。')] : []),
            ...(!branchReleaseReady ? [reason('BRANCH_FULFILLMENT_REQUIRED', '本分支尚无当前有效的原生放行履约依据；中性生产计划不是已开产或可发。')] : []),
            ...(!hasScope(actor, 'shipments:write') ? [reason('FORBIDDEN', '当前账号没有出运交接预检权限。')] : [])],
          evidenceRefs: [...handoffs.map((row: any) => ({ kind: 'ShipmentHandoff', id: row.handoffId })), ...branchReleases.map((row: any) => ({ kind: 'ReleaseScope', id: row.id, revision: row.scopeRevision }))] },
        // Money and change history are independent business contexts, not a
        // later production milestone. They mount only when explicitly opened.
        { id: 'finance', label: '财务关联', precedingIds: [], initial: true, hasHistory: false, eligible: true, blockedReasons: [], evidenceRefs: [] },
        { id: 'history', label: '变更与留痕', precedingIds: [], initial: true, hasHistory: true, eligible: true, blockedReasons: [], evidenceRefs: approvals.map((row: any) => ({ kind: 'ApprovalRequest', id: row.id })) },
      ];
      return assembleBusinessWorkspace({ scope, identity, overview: exactJsonValue({ id: order.id, code: order.code, poNumber: order.poNumber, businessLine: order.businessLine ?? order.type,
        customerRelationId: order.customerRelationId ?? null, orderPurpose: order.orderPurpose ?? null, internalPurpose: order.internalPurpose ?? null,
        internalDemandTeamId: order.internalDemandTeamId ?? null, internalReceiverId: order.internalReceiverId ?? null, recordedLegacyStatus: order.status,
        mainApproval: latest ? { id: latest.id, status: latest.status, reviewerId: latest.reviewerId ?? null, decidedAt: latest.decidedAt ?? null } : null,
        formalApprovalVerified: formal, ...(selected ? { selectedLineId: selected.id, materialBlockedReasons: materialReasons, requiredSampleFamilies: readRequiredSampleFamilies(selected.requiredSampleFamilies, order) } : {}),
        ...(branch ? { selectedProductionBranch: { id: branch.id, revision: branch.revision, factoryRelationId: branch.factoryRelationId, unit: branch.unit,
          recordedQuantity: branch.quantity, fulfillmentBasisVerified: branchReleaseReady }, shipmentPreparationOnly: true } : {}) }),
        activatedNodeIds, canWrite: hasScope(actor, 'orders:write'), facts,
        childSummaries: exactJsonValue(selected ? ownBatches.map((row: any) => ({ kind: 'production_branch', id: row.id, revision: row.revision, orderLineId: row.orderLineId,
          factoryRelationId: row.factoryRelationId, state: row.state, quantity: row.quantity, unit: row.unit, sizeBreakdown: row.sizeBreakdown ?? null }))
          : lines.map((row: any) => ({ kind: 'order_line', id: row.id, itemNo: row.itemNo, description: row.description, quantity: row.quantity, unit: row.unit,
            fulfillmentMode: row.fulfillmentMode ?? null, sourceIdentityStatus: row.confirmedSourceType && row.confirmedSourceId && row.specSnapshot != null ? 'recorded' : 'unknown',
            productionBranchIds: batches.filter((batch: any) => batch.orderLineId === row.id).map((batch: any) => batch.id) }))) });
    },
  });
  async function read(orderId: string, prior: TokenPayload | null | undefined, input: { orderLineId?: string; productionBatchId?: string; productionBatchRevision?: number } = {}) {
    if (input.productionBatchRevision !== undefined && input.productionBatchId === undefined || input.productionBatchId !== undefined && (input.orderLineId === undefined || input.productionBatchRevision === undefined))
      throw businessError('INVALID_INPUT', '准确工厂分支必须同时提供订单行、分支及修订号。');
    const scope = parseWorkspaceScope(input.productionBatchId !== undefined ? { kind: 'production_branch', orderId, orderLineId: input.orderLineId,
      productionBatchId: input.productionBatchId, productionBatchRevision: input.productionBatchRevision }
      : input.orderLineId !== undefined ? { kind: 'order_line', orderId, orderLineId: input.orderLineId } : { kind: 'order_main', orderId });
    const access = adapter(orderId, prior), actor = await access.authorize(options.prisma, scope, 'read');
    const context = await access.context(options.prisma, scope, actor);
    await access.authorize(options.prisma, scope, 'read');
    return context;
  }
  return { read, continue: (orderId: string, prior: TokenPayload | null | undefined, input: unknown, ip?: string | null) =>
    continueBusinessWorkspace({ prisma: options.prisma, prior, input, adapter: adapter(orderId, prior), ip }) };
}
