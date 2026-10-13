import fs from 'node:fs';
import path from 'node:path';
import { createPermissionService, hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import { andOrderScope, loadOrderQueryReadAccess } from '../orders/orderQueryReadAccess';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { buildQuotationListScopeWhere } from '../quotations/quotationService';
import { buildPaymentRequestScope, canSeePaymentRequest } from '../paymentRequests/paymentRequestScope';
import { assertPaymentRequestPayableApproval } from '../paymentRequests/paymentRequestPayableSource';
import { createClaimVisibility } from '../claims/claimVisibility';
import { assertDevelopmentExpenseAccess } from '../development/developmentExpenseAccess';
import { decodeInternalTransferPayload } from '../internalTrade/internalTransferService';
import { readInvoiceAttachment } from '../finance/invoiceAttachmentService';
import { buildCompositeSourceRef } from '../customs/compositeDocumentService';
import { resolveEmailAttachmentPath } from '../email/emailSyncService';
import { PRIVATE_FILES_DIR, isInsideDir } from '../lib/privateFiles';
import { assertSupplierCommitmentApprovalRead, SUPPLIER_COMMITMENT_APPROVAL_ACTION } from '../procurement/supplierCommitmentService';
import { assertOrderChangeApprovalRead } from '../orderChanges/orderChangeReadAccess';

const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function denied(): never {
  throw Object.assign(new Error('原业务不存在或当前用户无读取权限'), { code: 'FORBIDDEN', status: 403, statusCode: 403 });
}
async function freshActor(tx: any, actor: TokenPayload): Promise<TokenPayload> {
  if (!actor?.userId) return denied();
  const current = await createPermissionService({ prisma: tx }).getUserPermissionContext(actor.userId);
  if (!current) return denied();
  return { userId: actor.userId, displayName: actor.displayName, roles: current.legacyRoleCodes, roleIds: current.roleIds,
    permissions: current.scopes, departmentIds: current.departmentIds, authorizationLoaded: true,
    ...(actor.permissionCeiling === undefined ? {} : { permissionCeiling: [...actor.permissionCeiling] }) };
}
async function assertOrderRead(tx: any, actor: TokenPayload, orderId: string) {
  const access = await loadOrderQueryReadAccess(tx, { actor });
  const row = await tx.order.findFirst({ where: andOrderScope({ id: orderId, deletedAt: null }, access.orderWhere), select: { id: true } });
  if (!row) denied();
}
async function assertQuotationRead(tx: any, actor: TokenPayload, approval: any) {
  const current = await freshActor(tx, actor);
  if (!hasScope(current, 'quotations:read')) denied();
  const payload = object(approval.payload);
  const quotationId = String(payload.quotationId || (approval.targetType === 'Quotation' ? approval.targetId : '') || '');
  if (!quotationId) denied();
  const scope = await buildQuotationListScopeWhere(tx, current);
  const quotation = await tx.quotation.findFirst({ where: { id: quotationId, deletedAt: null, ...(Object.keys(scope).length ? { AND: [scope] } : {}) }, select: { id: true } });
  if (!quotation) denied();
  if (approval.targetType === 'QuotationLine') {
    const line = await tx.quotationLine.findFirst({ where: { id: approval.targetId, quotationId, deletedAt: null }, select: { id: true } });
    if (!line) denied();
  }
}
async function assertPaymentRequestRead(tx: any, actor: TokenPayload, approval: any) {
  const current = await freshActor(tx, actor);
  const item = await tx.paymentRequest.findFirst({ where: { id: approval.targetId, deletedAt: null },
    select: { applicantId: true, reviewerId: true } });
  if (!item) denied();
  const resolver = await createPermissionService({ prisma: tx }).getDataScopeResolver(current, 'paymentRequests');
  if (!canSeePaymentRequest(item, buildPaymentRequestScope(resolver, current.userId))) denied();
  await assertPaymentRequestPayableApproval(tx, approval, current, false);
}
async function assertInternalTransferRead(tx: any, actor: TokenPayload, approval: any) {
  const current = await freshActor(tx, actor);
  if (!hasScope(current, 'orders:read') && !hasScope(current, 'order:internal_trade:write')) denied();
  const master = await tx.orderInternalTransfer.findFirst({ where: { id: approval.targetId, deletedAt: null } });
  const payload = decodeInternalTransferPayload(master?.memo);
  if (!master || !payload || payload.role !== 'master' || payload.masterId !== master.id || master.orderId !== payload.garmentOrderId) denied();
  const mirror = payload.mirrorId ? await tx.orderInternalTransfer.findFirst({ where: { id: payload.mirrorId, deletedAt: null } }) : null;
  if (!mirror || mirror.orderId !== payload.fabricOrderId) denied();
  const scope = await buildOrderListScopeWhere(tx, current, { fresh: true });
  for (const orderId of [payload.garmentOrderId, payload.fabricOrderId]) {
    if (!await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] }, select: { id: true } })) denied();
  }
}

/** Recheck the same native row/data scope as the originating read route. Unknown types fail closed. */
export async function assertApprovalReviewSourceRead(tx: any, approval: any, actorInput: TokenPayload): Promise<void> {
  const actor = await freshActor(tx, actorInput);
  const payload = object(approval.payload);
  switch (approval.actionType) {
    case SUPPLIER_COMMITMENT_APPROVAL_ACTION:
      await assertSupplierCommitmentApprovalRead(tx, approval, actor); return;
    case 'development:fee':
      if (approval.targetType !== 'BillingItem' || typeof payload.caseId !== 'string') return denied();
      await assertDevelopmentExpenseAccess(tx, actor, payload.caseId, 'read');
      return;
    case 'finance:payment_request':
      if (approval.targetType !== 'PaymentRequest' || !approval.targetId) return denied();
      await assertPaymentRequestRead(tx, actor, approval); return;
    case 'quotation:line_approve': case 'quotation:total_approve': case 'quotation:price-deviation': case 'quotation:moq-exemption':
      await assertQuotationRead(tx, actor, approval); return;
    case 'order:change': case 'order:cancel': case 'order:pause': {
      await assertOrderChangeApprovalRead(tx, approval, actor); return;
    }
    case 'order:moq-exemption':
      if (approval.targetType !== 'Order' || !approval.targetId) return denied();
      await assertOrderRead(tx, actor, approval.targetId); return;
    case 'order:confirmation_sign':
      if (approval.targetType !== 'OrderConfirmation' || !approval.targetId) return denied();
      await assertOrderRead(tx, actor, approval.targetId); return;
    case 'contract:sign': {
      const sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
      if (approval.targetType !== 'Contract' || !approval.targetId || sourceIds.length < 2
        || sourceIds.some((id: unknown) => typeof id !== 'string' || !id.trim())
        || new Set(sourceIds).size !== sourceIds.length
        || buildCompositeSourceRef('CONTRACT', sourceIds) !== approval.targetId) return denied();
      for (const orderId of sourceIds) await assertOrderRead(tx, actor, orderId);
      return;
    }
    case 'order:short-ship-exemption': {
      if (approval.targetType !== 'OrderLine' || !approval.targetId) return denied();
      const line = await tx.orderLine.findFirst({ where: { id: approval.targetId, deletedAt: null }, select: { orderId: true } });
      if (!line?.orderId) return denied();
      await assertOrderRead(tx, actor, line.orderId); return;
    }
    case 'order:dr013-exception': {
      if (approval.targetType !== 'Dr013ExceptionRequest' || !approval.targetId) return denied();
      const source = await tx.dr013ExceptionRequest.findFirst({ where: { id: approval.targetId, deletedAt: null }, select: { scope: true } });
      const scope = object(source?.scope);
      if (!source) return denied();
      if (scope.targetType === 'Order' && typeof scope.targetId === 'string') { await assertOrderRead(tx, actor, scope.targetId); return; }
      if (scope.targetType === 'OrderLine' && typeof scope.targetId === 'string') {
        const line = await tx.orderLine.findFirst({ where: { id: scope.targetId, deletedAt: null }, select: { orderId: true } });
        if (!line?.orderId) return denied();
        await assertOrderRead(tx, actor, line.orderId); return;
      }
      return denied();
    }
    case 'order:internal_trade_price':
      if (approval.targetType !== 'OrderInternalTransfer' || !approval.targetId) return denied();
      await assertInternalTransferRead(tx, actor, approval); return;
    case 'aftersales:claim-disposition':
      if (approval.targetType !== 'ClaimDisposition' || !approval.targetId) return denied();
      await createClaimVisibility(tx, actor).requireChild('disposition', approval.targetId); return;
    default:
      return denied();
  }
}

function attachmentUrls(value: any, found: string[] = [], inAttachmentList = false): string[] {
  if (Array.isArray(value)) { for (const entry of value) attachmentUrls(entry, found, inAttachmentList); return found; }
  if (typeof value === 'string') { if (inAttachmentList && value.trim()) found.push(value.trim()); return found; }
  if (!value || typeof value !== 'object') return found;
  const row = object(value);
  for (const key of ['href', 'url', 'fileUrl']) if (typeof row[key] === 'string') found.push(row[key]);
  for (const key of ['attachments', 'files', 'evidence', 'evidenceFiles']) attachmentUrls(row[key], found, true);
  for (const key of ['content', 'claimCase']) attachmentUrls(row[key], found);
  return found;
}

/** Only marks attachments available after verifying each allowlisted native download route and its own L2 read gate. */
export async function canReadApprovalReviewAttachments(tx: any, approval: any, actorInput: TokenPayload): Promise<boolean> {
  const urls = [...new Set(attachmentUrls(approval.payload))];
  const allowed = urls.filter(url => /^\/api\/v1\/(?:email\/attachments|finance\/[^/]+\/attachments)\//.test(url));
  if (allowed.length !== urls.length) return false;
  if (!allowed.length) return true;
  try {
    const actor = await freshActor(tx, actorInput);
    for (const href of allowed) {
      const email = /^\/api\/v1\/email\/attachments\/([A-Za-z0-9_-]+)\/download$/.exec(href);
      if (email) {
        if (!hasScope(actor, 'emails:read')) return false;
        const attachment = await tx.emailAttachment.findUnique({ where: { id: email[1] }, select: { id: true, filePath: true } });
        if (!attachment?.filePath) return false;
        const storedPath = String(attachment.filePath);
        const legacy = storedPath.startsWith('uploads/email-attachments/');
        if (!legacy && !storedPath.startsWith('email-attachments/')) return false;
        const allowedRoot = legacy
          ? path.resolve(__dirname, '../../uploads/email-attachments')
          : path.resolve(PRIVATE_FILES_DIR, 'email-attachments');
        const resolvedPath = path.resolve(resolveEmailAttachmentPath(storedPath));
        if (!isInsideDir(allowedRoot, resolvedPath) || !fs.existsSync(resolvedPath)) return false;
        const realRoot = fs.realpathSync(allowedRoot);
        const realFile = fs.realpathSync(resolvedPath);
        if (!isInsideDir(realRoot, realFile) || !fs.statSync(realFile).isFile()) return false;
        continue;
      }
      const invoice = /^\/api\/v1\/finance\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)\/download$/.exec(href);
      if (!invoice) return false;
      await readInvoiceAttachment({ prisma: tx, actor, invoiceId: invoice[1], fileId: invoice[2] });
    }
    return true;
  } catch { return false; }
}
