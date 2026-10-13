import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { canonicalCustomerConfirmationJson, CustomerConfirmationError } from '../customerConfirmations/customerConfirmationService';
import type { CustomerConfirmationCommand, CustomerConfirmationTargetAdapter } from '../customerConfirmations/customerConfirmationTypes';
import type { OrderChangeRequestService } from './orderChangeRequestService';
import { assertOrderChangeApprovalDecisionFact, buildOrderChangeFinalVersion, OrderChangeFinalVersionError } from './orderChangeFinalVersion';

const supportedTypes = new Set(['price', 'quantity', 'delivery']);
const typeLabels: Record<string, string> = { price: '价格变更', quantity: '数量变更', delivery: '交期变更' };

function fallbackVersion(input: unknown) {
  return createHash('sha256').update(canonicalCustomerConfirmationJson(input)).digest('hex');
}

function readableScopeLabel(changeType: string, version: any, orderLines: any[]): string | null {
  const typeLabel = typeLabels[changeType];
  if (!typeLabel) return null;
  const lineIds = Array.isArray(version?.scope?.lineIds) ? version.scope.lineIds : [];
  const lineNumbers = lineIds.map((id: unknown) => orderLines.find(line => line.id === id)?.lineNumber)
    .filter((value: unknown) => Number.isSafeInteger(value)).map((value: number) => `#${value}`);
  const exactLines = lineNumbers.length ? `订单明细 ${lineNumbers.join('、')}` : '订单明细 0 项';
  return `${typeLabel} · ${exactLines}`;
}

function exactApplyAuditFacts(audits: any[], cr: any, approval: any): boolean {
  const expected = Object.entries((cr.afterDelta ?? {}) as Record<string, unknown>);
  if (!expected.length || !cr.appliedAt || !cr.appliedBy || !approval?.id) return false;
  const facts = (audits ?? []).filter(audit => audit?.detail?.changeRequestId === cr.id
    && audit?.detail?.changeType === (approval?.payload as any)?.changeType
    && audit?.action === 'order_change_approved'
    && audit?.targetType === 'Order' && audit?.targetId === cr.orderId
    && audit?.transactionId === approval.id && audit?.actorId === cr.appliedBy);
  if (facts.length !== expected.length) return false;
  return expected.every(([field, value]) => {
    const matching = facts.filter(audit => audit.fieldPath === field
      && canonicalCustomerConfirmationJson(audit.afterValue) === canonicalCustomerConfirmationJson(value));
    return matching.length === 1;
  });
}

async function hasExactCustomerProof(tx: any, confirmation: any, cr: any, fingerprint: string, scopeFingerprint: string) {
  if (!confirmation || confirmation.outcome !== 'accepted'
    || confirmation.targetType !== 'OrderChangeRequest' || confirmation.targetId !== cr.id
    || confirmation.finalContentFingerprint !== fingerprint || confirmation.scopeFingerprint !== scopeFingerprint
    || confirmation.internalApprovalId !== cr.approvalRequestId || !confirmation.auditId || !confirmation.recordedBy)
    return false;
  const [audit, links] = await Promise.all([
    tx.auditLog.findUnique({ where: { id: confirmation.auditId } }),
    tx.businessConfirmationEvidence.findMany({ where: { confirmationId: confirmation.id }, include: { evidence: { include: { files: true } } } }),
  ]);
  if (!audit || audit.action !== 'business_customer_confirmation_recorded' || audit.targetId !== confirmation.id
    || audit.actorId !== confirmation.recordedBy || !links?.length) return false;
  return links.every((link: any) => {
    const evidence = link?.evidence;
    if (!evidence?.sourceFingerprint || !evidence?.sourceSnapshot) return false;
    if (evidence.sourceType === 'screenshot') return evidence.files?.some((file: any) => file.purpose === 'screenshot') === true;
    return evidence.sourceType === 'email_selection';
  });
}

function readbackEffect(input: { cr: any; approval: any; sourceMatchesFrozen: boolean; approvalAuditValid: boolean;
  customerAccepted: boolean; applyAuditValid: boolean }) {
  const { cr, approval, sourceMatchesFrozen, approvalAuditValid, customerAccepted, applyAuditValid } = input;
  if (cr.status === 'Applied') return customerAccepted && approvalAuditValid && applyAuditValid
    ? 'applied' : 'applied_unverified';
  if (cr.status === 'Approved' && approval?.status === 'approved' && approvalAuditValid) {
    if (!sourceMatchesFrozen) return 'version_changed';
    return customerAccepted ? 'apply_pending' : 'awaiting_customer_confirmation';
  }
  if (cr.status === 'Pending' && approval?.status === 'pending') return 'awaiting_internal_approval';
  if (cr.status === 'Rejected' || approval?.status === 'rejected') return 'rejected';
  if (cr.status === 'Cancelled' || cr.status === 'Canceled' || cr.status === 'Superseded') return 'cancelled';
  if (cr.status === 'Draft') return 'draft';
  return 'unknown';
}

export interface OrderChangeCustomerConfirmationAdapterOptions {
  prisma: PrismaClient;
  service: OrderChangeRequestService;
}

/** Native OrderChangeRequest gate for the shared customer confirmation service. */
export function createOrderChangeCustomerConfirmationAdapter(options: OrderChangeCustomerConfirmationAdapterOptions) {
  const { prisma, service } = options;

  async function inspect(tx: any, targetId: string, actor: TokenPayload, mode: 'read' | 'confirm') {
    const requiredScope = mode === 'confirm' ? 'order:change_request:apply' : 'orders:read';
    if (!actor?.userId || actor.authorizationLoaded !== true || !hasScope({ ...actor, roles: [] }, requiredScope))
      throw new CustomerConfirmationError('FORBIDDEN', '当前账号无权读取或登记此订单变更的客户确认。', 403);
    if (mode === 'confirm' && !hasScope({ ...actor, roles: [] }, 'orders:read'))
      throw new CustomerConfirmationError('FORBIDDEN', '登记客户确认还需要当前订单读取权限。', 403);

    const hint = await tx.orderChangeRequest.findUnique({ where: { id: targetId } });
    if (!hint || hint.deletedAt) throw new CustomerConfirmationError('NOT_FOUND', '订单变更申请不存在或当前无权查看。', 404);
    if (mode === 'confirm') {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', hint.orderId);
      await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', targetId);
    }
    const scope = await freshOrderLineScope(tx, actor);
    const order = await tx.order.findFirst({ where: { id: hint.orderId, deletedAt: null, AND: [scope] } });
    const cr = await tx.orderChangeRequest.findUnique({ where: { id: targetId } });
    if (!order || !cr || cr.deletedAt || cr.orderId !== hint.orderId)
      throw new CustomerConfirmationError('NOT_FOUND', '订单变更申请不存在或当前无权查看。', 404);

    if (mode === 'confirm') await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', cr.orderId);
    const orderLines = await tx.orderLine.findMany({ where: { orderId: cr.orderId }, orderBy: { id: 'asc' } });
    const approval = cr.approvalRequestId
      ? await tx.approvalRequest.findUnique({ where: { id: cr.approvalRequestId } })
      : null;
    if (mode === 'confirm' && approval?.id)
      await tx.$queryRawUnsafe('SELECT "id" FROM "ApprovalRequest" WHERE "id"=$1 FOR UPDATE', approval.id);
    const currentApproval = approval?.id ? await tx.approvalRequest.findUnique({ where: { id: approval.id } }) : null;

    let version: ReturnType<typeof buildOrderChangeFinalVersion> | null = null;
    let versionError: unknown = null;
    const changeType = (currentApproval?.payload as any)?.changeType;
    const approved = (cr.status === 'Approved' || cr.status === 'Applied') && currentApproval?.status === 'approved';
    const pending = cr.status === 'Pending' && currentApproval?.status === 'pending';
    if (supportedTypes.has(changeType)) {
      try {
        const appliedReadback = cr.status === 'Applied' && currentApproval?.status === 'approved';
        version = buildOrderChangeFinalVersion({ changeRequest: cr, order, orderLines, approval: currentApproval,
          requireApproved: approved, allowStaleSource: true, useFrozenSource: appliedReadback,
          allowAppliedReadback: appliedReadback });
      } catch (error) {
        versionError = error;
      }
    }
    const currentVersionFingerprint = version?.finalContentFingerprint
      ?? fallbackVersion({ targetId, approvalId: cr.approvalRequestId, orderId: cr.orderId,
        source: orderLines.map((line: any) => ({ id: line.id, lineNumber: line.lineNumber, quantity: line.quantity?.toString?.() ?? line.quantity,
          unitPrice: line.unitPrice?.toString?.() ?? line.unitPrice, netValue: line.netValue?.toString?.() ?? line.netValue })),
        approvalPayload: currentApproval?.payload ?? null, beforeSnapshot: cr.beforeSnapshot, afterDelta: cr.afterDelta });
    const finalContentFingerprint = currentVersionFingerprint;
    const scopeFingerprint = version?.scopeFingerprint ?? finalContentFingerprint;
    const fingerprintMatchesPersisted = !!version && cr.finalContentFingerprint === finalContentFingerprint;
    const sourceMatchesForConfirmation = version?.sourceMatchesFrozen === true;
    let approvalAuditValid = false;
    if (approved && currentApproval && version) {
      try {
        const audits = await tx.auditLog.findMany({ where: { OR: [
          { targetType: 'ApprovalRequest', targetId: currentApproval.id },
          { detail: { path: ['approvalId'], equals: currentApproval.id } },
        ] } });
        assertOrderChangeApprovalDecisionFact(currentApproval, audits);
        approvalAuditValid = true;
      } catch (error) {
        versionError = error;
      }
    }
    const currentProposedVersion = (approved || pending) && fingerprintMatchesPersisted
      && (cr.status === 'Applied' || sourceMatchesForConfirmation);
    // Pending requests are immutable version snapshots. A customer may have
    // already accepted that exact candidate; any later amendment gets a new
    // fingerprint and cannot reuse this evidence or apply before approval.
    const eligible = currentProposedVersion && !versionError && !!version
      && (pending || (approved && approvalAuditValid)) && cr.status !== 'Applied';
    const scopeValue = version?.scope ?? { schemaVersion: 1, targetId, changeType: null, fields: [] };
    const confirmedVersionFingerprint = typeof cr.finalContentFingerprint === 'string'
      ? cr.finalContentFingerprint : finalContentFingerprint;
    const confirmedVersionScopeFingerprint = confirmedVersionFingerprint;
    const confirmation = supportedTypes.has(changeType) ? await tx.businessConfirmation.findFirst({
      where: { targetType: 'OrderChangeRequest', targetId, finalContentFingerprint: confirmedVersionFingerprint,
        scopeFingerprint: confirmedVersionScopeFingerprint },
      orderBy: { revision: 'desc' },
    }) : null;
    const customerAccepted = await hasExactCustomerProof(tx, confirmation, cr,
      confirmedVersionFingerprint, confirmedVersionScopeFingerprint);
    let applyAuditValid = false;
    if (cr.status === 'Applied' && currentApproval) {
      const applyAudits = await tx.auditLog.findMany({ where: { action: 'order_change_approved', targetType: 'Order',
        targetId: cr.orderId, transactionId: currentApproval.id } });
      applyAuditValid = exactApplyAuditFacts(applyAudits, cr, currentApproval);
    }
    const effect = readbackEffect({ cr, approval: currentApproval, sourceMatchesFrozen: sourceMatchesForConfirmation,
      approvalAuditValid, customerAccepted, applyAuditValid });
    const businessVersionLabel = cr.status === 'Applied' ? '已生效版本'
      : approved ? '当前批准版本' : pending ? '待审批申请版本' : '当前变更版本';
    return {
      eligible,
      businessLabel: '订单变更申请',
      businessReference: typeof cr.requestNumber === 'string' ? cr.requestNumber : null,
      versionLabel: businessVersionLabel,
      scopeLabel: readableScopeLabel(changeType, version, orderLines),
      finalContentFingerprint,
      internalApprovalId: cr.approvalRequestId ?? null,
      scopeFingerprint,
      scope: scopeValue,
      recommendation: { orderId: cr.orderId, relationId: order.customerRelationId ?? undefined },
      nativeStatus: {
        changeRequestStatus: cr.status,
        approvalStatus: currentApproval?.status ?? null,
        canConfirm: hasScope({ ...actor, roles: [] }, 'order:change_request:apply') && cr.status !== 'Applied',
        customerConfirmation: confirmation ? {
          outcome: confirmation.outcome, recordedBy: confirmation.recordedBy,
          recordedAt: confirmation.recordedAt == null ? null : String(confirmation.recordedAt),
          matchesCurrentVersion: confirmedVersionFingerprint === finalContentFingerprint
            && confirmedVersionScopeFingerprint === scopeFingerprint && fingerprintMatchesPersisted,
          evidenceAuditValid: customerAccepted,
        } : null,
        effect,
        applyAuditValid,
        ...(versionError instanceof OrderChangeFinalVersionError ? { ineligibleReason: versionError.message } : {}),
      },
    };
  }

  const adapter: CustomerConfirmationTargetAdapter & {
    searchTargetIds: (tx: any, actor: TokenPayload, input: { sourceEmail: { orderId?: string | null; relationId?: string | null }; businessReference?: string }) => Promise<string[]>;
    onRecordedInTx: (tx: any, input: { targetId: string; actor: TokenPayload; command: CustomerConfirmationCommand; confirmation: any }) => Promise<any>;
    continueAfterRecord: (input: { targetId: string; actor: TokenPayload; command: CustomerConfirmationCommand; confirmation: any }) => Promise<any>;
  } = {
    targetType: 'OrderChangeRequest',
    inspect,
    async searchTargetIds(tx, actor, input): Promise<string[]> {
      if (!actor?.userId || actor.authorizationLoaded !== true || !hasScope({ ...actor, roles: [] }, 'orders:read'))
        throw new CustomerConfirmationError('FORBIDDEN', '当前账号无权搜索订单变更客户确认事项。', 403);

      const businessReference = input.businessReference?.trim();
      if (businessReference) {
        // Manual search is an exact native business number; never enumerate the company.
        const matches: any[] = await tx.orderChangeRequest.findMany({
          where: { requestNumber: businessReference, deletedAt: null },
          select: { id: true }, take: 5,
        });
        const ids = new Set<string>();
        for (const row of matches ?? []) if (typeof row?.id === 'string') ids.add(row.id);
        return [...ids];
      }

      const orderIds = new Set<string>();
      if (typeof input.sourceEmail?.orderId === 'string' && input.sourceEmail.orderId.trim())
        orderIds.add(input.sourceEmail.orderId.trim());
      if (typeof input.sourceEmail?.relationId === 'string' && input.sourceEmail.relationId.trim()) {
        const scope = await freshOrderLineScope(tx, actor);
        const linkedOrders: any[] = await tx.order.findMany({
          where: { customerRelationId: input.sourceEmail.relationId.trim(), deletedAt: null, AND: [scope] },
          select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 50,
        });
        for (const row of linkedOrders ?? []) if (typeof row?.id === 'string') orderIds.add(row.id);
      }
      if (!orderIds.size) return [];
      const rows: any[] = await tx.orderChangeRequest.findMany({
        where: { orderId: { in: [...orderIds] }, status: { in: ['Pending', 'Approved'] }, deletedAt: null },
        select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 40,
      });
      const ids = new Set<string>();
      for (const row of rows ?? []) if (typeof row?.id === 'string') ids.add(row.id);
      return [...ids];
    },
    async onRecordedInTx(tx, input) {
      const readback = await inspect(tx, input.targetId, input.actor, 'read');
      return { nativeStatus: readback.nativeStatus,
        effect: input.command.outcome === 'accepted' ? 'accepted_waiting_apply' : 'recorded_without_order_write' };
    },
    async continueAfterRecord(input) {
      const readCurrent = () => prisma.$transaction((tx: any) => inspect(tx, input.targetId, input.actor, 'read'));
      let readback = await readCurrent();
      const effect = (readback.nativeStatus as any)?.effect;
      const status = (readback.nativeStatus as any)?.changeRequestStatus;
      if (input.command.outcome !== 'accepted') {
        return { nativeStatus: readback.nativeStatus,
          effect: { status: 'not_applicable', reason: '客户答复不是接受，订单条款未写入。' } };
      }
      if (effect === 'applied') {
        return { nativeStatus: readback.nativeStatus,
          effect: { status: 'applied', changeRequestId: input.targetId, recovered: true } };
      }
      if (status === 'Pending') {
        return { nativeStatus: readback.nativeStatus,
          effect: { status: 'pending', reason: '客户已接受锁定的申请版本，仍待内部审批；如批准内容变化，须重新取得客户确认。' } };
      }
      if (status === 'Rejected' || status === 'Cancelled' || status === 'Canceled' || status === 'Superseded') {
        return { nativeStatus: readback.nativeStatus,
          effect: { status: 'not_applicable', reason: `订单变更当前状态为${status}，没有写入订单。` } };
      }
      if (status !== 'Approved' || effect !== 'apply_pending') {
        return { nativeStatus: readback.nativeStatus,
          effect: { status: 'pending', reason: effect === 'version_changed'
            ? '客户确认后订单版本已变化，订单未修改，请重新核对并发起新变更。'
            : '客户确认已登记，但当前批准版本或来源仍待核对，订单尚未写入。' } };
      }
      const result = await service.applyChangeRequest({ changeRequestId: input.targetId,
        appliedBy: input.actor.userId, trustedActor: input.actor });
      if (result.ok) {
        readback = await readCurrent();
        if ((readback.nativeStatus as any)?.effect === 'applied') {
          return { nativeStatus: readback.nativeStatus,
            effect: { status: 'applied', changeRequestId: result.data.changeRequest.id, applied: result.data.applied } };
        }
      } else if (result.error.code === 'ALREADY_APPLIED') {
        // A concurrent/replayed continuation is successful only after the native
        // approval, customer proof and one matching apply audit all read back.
        readback = await readCurrent();
        if ((readback.nativeStatus as any)?.effect === 'applied') {
          return { nativeStatus: readback.nativeStatus,
            effect: { status: 'applied', changeRequestId: input.targetId, recovered: true } };
        }
      } else {
        readback = await readCurrent();
      }
      return { nativeStatus: readback.nativeStatus,
        effect: { status: 'pending', code: result.ok ? 'APPLY_READBACK_UNVERIFIED' : result.error.code,
          message: result.ok ? '订单变更提交后尚未取得可核对的生效审计，状态待核对。'
            : result.error.message } };
    },
  };
  return adapter;
}

export const createOrderChangeConfirmationAdapter = createOrderChangeCustomerConfirmationAdapter;
