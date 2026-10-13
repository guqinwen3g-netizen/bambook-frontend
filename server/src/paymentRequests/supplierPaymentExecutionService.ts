/** An approval authorizes the request; only this explicit financial command
 * records a supplier's actual payment. No date, amount or method is inferred. */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { ciJson } from '../development/developmentCiSource';
import { createFinanceSourceAccess } from '../finance/financeSourceAccess';
import { beginFinanceCommand } from '../finance/financeCommandReceipt';
import { createPaymentVoucher } from '../finance/paymentVoucherMutationService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';
import {assertVoucherCashUse} from '../finance/companyCashAccountService';
import { isValidLocalDateKey } from '../shared/localDate';
import { assertPaymentRequestPayableBasis } from './paymentRequestPayableSource';


export type SupplierActualPaymentInput = {
  requestKey: string; expectedRequestUpdatedAt: string;
  amount: string | number; currency: string; paymentDate: string; paymentMethod: string;
  bankReference?: string; evidenceNote?: string;
  companyAccountId?: string; expectedAccountRevision?: number; actualAccountAmount?: string;
  bankFee?:string;feeBearer?:string;
};
export type SupplierActualPaymentResult = { ok: true; data: any }
  | { ok: false; error: { code: string; message: string; statusCode: number } };

export function actualFinancialDate(value: unknown): string {
  if (!isValidLocalDateKey(value))
    throw businessError('INVALID_INPUT', '请填写真实有效的实际发生日期（YYYY-MM-DD）。');
  return value;
}
function actualAmount(value: unknown) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d{1,4})?$/.test(String(value)))
    throw businessError('INVALID_INPUT', '本次实际付款金额须为最多四位小数的正数。');
  const amount = new Prisma.Decimal(String(value));
  if (!amount.isFinite() || amount.lte(0) || amount.gte('100000000000000'))
    throw businessError('INVALID_INPUT', '本次实际付款金额超出合法范围。');
  return amount;
}
const revision = (row: any) => row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);

/** Deleted/cancelled vouchers still represent an observed bank movement.
 * Neither undoing an allocation nor hiding a voucher restores this capacity. */
export async function readSupplierPaymentFacts(tx: any, request: any) {
  const rows = await tx.paymentVoucher.findMany({ where: { OR: [
    { attachments: { path: ['paymentRequestId'], equals: request.id } },
    ...(request.paymentVoucherId ? [{ id: request.paymentVoucherId }] : []),
  ] }, orderBy: { createdAt: 'asc' } });
  let paid = new Prisma.Decimal(0);
  for (const row of rows) {
    if (row.type !== 'Disbursement' || row.currency !== request.currency || row.customerRelationId !== request.supplierId
      || !new Prisma.Decimal(row.amount).isFinite() || !new Prisma.Decimal(row.amount).gt(0))
      throw businessError('CONFLICT', '该申请的历史付款来源或币种不一致，不能推算可付余额。');
    paid = paid.plus(row.amount);
  }
  const remaining = new Prisma.Decimal(request.totalAmount).minus(paid);
  if (remaining.lt(0)) throw businessError('CONFLICT', '历史已登记付款超过原申请，须先核实原记录，不能继续生成付款。');
  return { paidAmount: paid.toFixed(4), remainingAmount: remaining.toFixed(4),
    vouchers: rows.map((row: any) => ({ id: row.id, voucherNumber: row.voucherNumber, amount: String(row.amount), currency: row.currency,
      paymentDate: row.paymentDate, paymentMethod: row.paymentMethod, status: row.status, deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
      verifiedActual: row.attachments?.actualPayment?.protocolVersion === 1 })) };
}

async function authorizeRequest(tx: any, access: Awaited<ReturnType<typeof createFinanceSourceAccess>>, request: any) {
  if (!request || request.deletedAt || request.payeeType === 'Customer' || !request.supplierId)
    throw businessError('NOT_FOUND', '供应商付款申请不存在，或缺少准确供应商来源。');
  if (!await tx.relation.findFirst({ where: { id: request.supplierId, deletedAt: null } }))
    throw businessError('CONFLICT', '实际收款供应商已不存在，请核对原申请。');
  const source = request.attachments?.sourceDocument;
  if (source?.type === 'order') {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${source.id} FOR SHARE`);
    if (!await access.order(source.id)) throw businessError('NOT_FOUND', '原付款订单不可访问。');
  } else if (source?.type === 'purchase_order') {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id"=${source.id} FOR SHARE`);
    const purchase = await tx.purchaseOrder.findFirst({where:{id:source.id,deletedAt:null}});
    if (!purchase || purchase.supplierRelationId !== request.supplierId || purchase.currency !== request.currency)
      throw businessError('CONFLICT','原采购付款的供应商或币种已变化，请核对原申请。');
    if (!access.all && !await access.source({type:'PurchaseOrder',id:source.id}))
      throw businessError('NOT_FOUND','原采购付款来源不在当前财务范围。');
  } else if (source?.type === 'expense') {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${source.id} FOR SHARE`);
    if (!await tx.costRecord.findFirst({where:{id:source.id,deletedAt:null}}))
      throw businessError('CONFLICT','原实际费用来源不存在。');
    if (!access.all && !await access.source({type:'CostRecord',id:source.id}))
      throw businessError('NOT_FOUND','原费用付款来源不在当前财务范围。');
  } else if (source?.type === 'warehouse') {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id"=${source.id} FOR SHARE`);
    const warehouse = await tx.warehouse.findFirst({where:{id:source.id,deletedAt:null}});
    if (!warehouse || warehouse.profile?.custodianRelationId !== request.supplierId)
      throw businessError('CONFLICT','原仓库保管组织已变化，请核对真实收款方。');
  } else if (!access.all && !await access.customer(request.supplierId)) {
    throw businessError('NOT_FOUND', '该供应商付款来源不在当前财务范围。');
  }
  if (!access.all && !await access.customer(request.supplierId))
    throw businessError('NOT_FOUND','实际收款供应商不在当前财务范围。');
}

export async function recordSupplierActualPayment(params: { prisma: PrismaClient; actor?: TokenPayload | null;
  actorId?: string; paymentRequestId: string; input: SupplierActualPaymentInput }): Promise<SupplierActualPaymentResult> {
  try {
    const result = await params.prisma.$transaction(async (tx: any) => {
      const access = await createFinanceSourceAccess(tx, params.actor, ['vouchers:write']);
      if (params.actorId !== access.actor.userId) throw businessError('UNAUTHORIZED', '实际付款缺少可信财务操作人。');
      const command = await beginFinanceCommand(tx, access.actor, 'payment_request.record_payment', { ...params.input, paymentRequestId: params.paymentRequestId });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentRequest" WHERE "id"=${params.paymentRequestId} FOR UPDATE`);
      const request = await tx.paymentRequest.findUnique({ where: { id: params.paymentRequestId } });
      await authorizeRequest(tx, access, request);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Relation" WHERE "id"=${request.supplierId} FOR SHARE`);
      if (command.replayed) {
        const approval = request.approvalRequestId && await tx.approvalRequest.findUnique({ where: { id: request.approvalRequestId } });
        await assertPaymentRequestPayableBasis(tx, { request, approvalPayload: approval?.payload, actor: access.actor,
          checkCapacity: false, scopes: ['invoices:read', 'vouchers:write'] });
        const row = await tx.paymentVoucher.findUnique({ where: { id: command.receipt.voucher.id } });
        if (!row || row.attachments?.paymentRequestId !== request.id || !await access.voucher({ ...row, deletedAt: null }))
          throw businessError('NOT_FOUND', '原实际付款事实不可访问。');
        await assertVoucherCashUse(tx,access.actor,row);
        await access.finish({ deletedVoucherIds: [row.id] });
        return { ...command.receipt, replayed: true, idempotent: true };
      }
      const input = params.input;
      if (input.expectedRequestUpdatedAt !== revision(request)) throw businessError('CONFLICT', '付款申请版本已变化，请刷新并核对本次实际付款。');
      if (!['Approved', 'VoucherIssued'].includes(request.status) || !request.approvalRequestId)
        throw businessError('CONFLICT', '付款申请尚未批准或已付足，本次不能登记新的付款。');
      if (await tx.creditNoteRefund.findUnique({ where: { paymentRequestId: request.id } }))
        throw businessError('CONFLICT', '客户 CN 退款须使用专用实际退款执行入口。');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${request.approvalRequestId} FOR SHARE`);
      const approval = await tx.approvalRequest.findUnique({ where: { id: request.approvalRequestId } });
      if (!approval || approval.status !== 'approved' || approval.targetType !== 'PaymentRequest' || approval.targetId !== request.id
        || approval.actionType !== 'finance:payment_request' || approval.requesterId !== request.applicantId)
        throw businessError('CONFLICT', '原申请缺少准确有效的批准事实，请核对审批来源。');
      const payableSource = await assertPaymentRequestPayableBasis(tx, { request, approvalPayload: approval.payload,
        actor: access.actor, scopes: ['invoices:read', 'vouchers:write'] });
      const amount = actualAmount(input.amount), paymentDate = actualFinancialDate(input.paymentDate);
      if (input.currency !== request.currency) throw businessError('CONFLICT', '本次实际付款币种与原申请不一致。');
      if (!['TT', 'LC', 'OA', 'DP', 'DA', 'Cash', 'Other'].includes(input.paymentMethod))
        throw businessError('INVALID_INPUT', '请选择本次实际付款方式，不使用预计方式代填。');
      const bankReference = input.bankReference?.trim() || null, evidenceNote = input.evidenceNote?.trim() || null;
      if (!bankReference && !evidenceNote) throw businessError('INVALID_INPUT', '登记已发生付款必须有真实银行流水或核实证据。');
      const facts = await readSupplierPaymentFacts(tx, request);
      if (amount.gt(facts.remainingAmount)) throw businessError('CONFLICT', '本次付款超过原申请剩余额度；撤销凭证不会让银行已付金额恢复。');
      const sourceOrderId = request.attachments?.sourceDocument?.type === 'order' ? request.attachments.sourceDocument.id : undefined;
      const voucherInput = { type: 'Disbursement', voucherCategory: request.paymentCategory, amount: amount.toFixed(4), currency: request.currency,
        companyAccountId:input.companyAccountId,expectedAccountRevision:input.expectedAccountRevision,actualAccountAmount:input.actualAccountAmount,
        bankFee:input.bankFee,feeBearer:input.feeBearer,
        bankReference:input.bankReference,evidenceNote:input.evidenceNote,
        paymentDate, paymentMethod: input.paymentMethod, customerRelationId: request.supplierId, customerName: request.supplierName,
        orderId: sourceOrderId, paymentRequestId: request.id,
        notes: `付款申请 ${request.requestNumber} 的本次实际付款`, attachments: { actualPayment: {
          protocolVersion: 1, paymentRequestId: request.id, approvalRequestId: request.approvalRequestId,
          ...(payableSource ? { payableSourceFingerprint: payableSource.sourceFingerprint } : {}),
          expectedRequestUpdatedAt: input.expectedRequestUpdatedAt, bankReference, evidenceNote, recordedBy: access.actor.userId,
          recordedAt: String(Date.now()), requestKey: input.requestKey } } };
      const created = await createPaymentVoucher({ prisma: params.prisma, tx, actor: access.actor, actorId: access.actor.userId,
        input: voucherInput, supplierPaymentExecution: { paymentRequestId: request.id } });
      if (!created.ok) throw businessError('CONFLICT', created.error.message);
      const paidAmount = new Prisma.Decimal(facts.paidAmount).plus(amount), remainingAmount = new Prisma.Decimal(request.totalAmount).minus(paidAmount);
      const status = request.status === 'VoucherIssued' ? 'VoucherIssued' : remainingAmount.isZero() ? 'Paid' : 'Approved';
      const linked = await tx.paymentRequest.updateMany({ where: { id: request.id, updatedAt: request.updatedAt, status: request.status },
        data: { status, paymentVoucherId: request.paymentVoucherId ?? created.data.voucher.id,
          updatedAt: new Date(Math.max(Date.now(), new Date(request.updatedAt).getTime() + 1)) } });
      if (linked.count !== 1) throw businessError('CONFLICT', '原申请在付款登记中变化，请使用原请求核对结果。');
      const updated = await tx.paymentRequest.findUnique({ where: { id: request.id } });
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: access.actor.userId, source: 'service:payment-request:actual-payment',
        operation: 'payment_request_actual_payment', targetType: 'PaymentRequest', targetId: request.id,
        before: { status: request.status, paidAmount: facts.paidAmount, remainingAmount: facts.remainingAmount },
        after: { status, voucherId: created.data.voucher.id, amount: amount.toFixed(4), paidAmount: paidAmount.toFixed(4), remainingAmount: remainingAmount.toFixed(4),
          paymentDate, paymentMethod: input.paymentMethod, bankReference, evidenceNote }, transactionId: input.requestKey });
      await authorizeRequest(tx, access, updated); await access.finish();
      return { ...await command.commit({ paymentRequest: ciJson(updated), voucher: created.data.voucher, auditId,
        paidAmount: paidAmount.toFixed(4), remainingAmount: remainingAmount.toFixed(4) }), replayed: false, idempotent: false };
    });
    if (!result.replayed) publishBusinessEvent({ type: 'PaymentVoucherCreated', sourceEntityType: 'PaymentVoucher', sourceEntityId: result.voucher.id,
      actorId: params.actorId!, transactionId: result.auditId, orderId: result.voucher.orderId ?? undefined,
      payload: { voucherId: result.voucher.id, voucherNumber: result.voucher.voucherNumber, type: 'Disbursement', amount: String(result.voucher.amount),
        currency: result.voucher.currency, paymentDate: result.voucher.paymentDate, paymentMethod: result.voucher.paymentMethod,
        paymentRequestId: params.paymentRequestId } }).catch(() => undefined);
    return { ok: true, data: result };
  } catch (error) {
    const safe = safeRouteError(error, { fallbackCode: 'CREATE_FAILED', fallbackMessage: '实际付款结果暂不可确认，请保留原请求重试并核对银行凭据。' });
    return { ok: false, error: { code: safe.code, message: safe.message, statusCode: safe.status } };
  }
}
