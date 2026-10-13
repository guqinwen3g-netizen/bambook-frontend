import { Prisma } from '@prisma/client';
import { canonicalClaimJson } from './claimApprovalFact';
import { creditNoteDigest } from './claimCreditNoteVersionService';
import { assertCashRefundEvidence, assertCashRefundSettlement, assertRefundHistory, CashRefundError,
  refundAmount, refundDate, refundRefusal, refundRequestId } from './claimCashRefundFact';

export interface CashRefundReturnInput {
  clientRequestId: string; expectedVersion: number; returnedPrincipal: string | number; receivedNet: string | number;
  bankFee: string | number; feeBearer?: string | null; actualDate: string; actualMethod: string;
  bankReference: string; evidenceIds: string[]; receiptVoucherId?: string;
  companyAccountId?:string;expectedAccountRevision?:number;
}
function nonnegativeMoney(value: unknown) {
  if ((typeof value !== 'string' && typeof value !== 'number') || typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) throw new CashRefundError('VALIDATION_FAILED', '净入账和本次实际扣费须为完整非负十进制金额');
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(value); } catch { throw new CashRefundError('VALIDATION_FAILED', '银行实录金额不合法'); }
  if (!amount.isFinite() || amount.lt(0) || amount.decimalPlaces() > 4 || amount.gte('100000000000000')) throw new CashRefundError('VALIDATION_FAILED', '银行实录金额须能完整保存，不能隐式舍入');
  return amount;
}
/** D7 currently records feeBearer but has NO net-receipt calculation helper.
 * These THREE explicit bank facts are checked arithmetically; OUR/BEN/SHA does
 * not infer principal or fees. Ordinary voucher/allocation semantics stay intact. */
export function normalizeCashRefundReturn(input: CashRefundReturnInput) {
  const clientRequestId = refundRequestId(input?.clientRequestId);
  if (Object.keys(input).some(key => !['clientRequestId', 'expectedVersion', 'returnedPrincipal', 'receivedNet', 'bankFee', 'feeBearer', 'actualDate', 'actualMethod', 'bankReference', 'evidenceIds', 'receiptVoucherId','companyAccountId','expectedAccountRevision'].includes(key))
      || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1
      || typeof input.bankReference !== 'string' || !input.bankReference.trim() || input.bankReference.length > 512
      || !['TT', 'LC', 'OA', 'DP', 'DA', 'Cash', 'Other'].includes(input.actualMethod)
      || !Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(input.evidenceIds).size !== input.evidenceIds.length
      || input.receiptVoucherId != null && (typeof input.receiptVoucherId !== 'string' || !input.receiptVoucherId.trim())) throw new CashRefundError('VALIDATION_FAILED', '返款须有真实日期、流水、方式、原字节证明和当前准确贷项版本');
  if(input.companyAccountId!=null&&(typeof input.companyAccountId!=='string'||!input.companyAccountId.trim()||!Number.isSafeInteger(input.expectedAccountRevision)))throw new CashRefundError('VALIDATION_FAILED','须核对真实返款公司账户和准确版本');
  const principal = refundAmount(input.returnedPrincipal), net = nonnegativeMoney(input.receivedNet), fee = nonnegativeMoney(input.bankFee);
  const feeBearer = input.feeBearer == null || input.feeBearer === '' ? null
    : typeof input.feeBearer === 'string' ? input.feeBearer.trim().toUpperCase() : 'invalid';
  if (feeBearer !== null && !['OUR', 'BEN', 'SHA'].includes(feeBearer) || fee.gt(0) && feeBearer === null) throw new CashRefundError('VALIDATION_FAILED', '本次实际扣费须有明确承担标识；未明确本金或扣费时保留真实收款暂挂待核');
  if (!principal.equals(net.plus(fee))) throw new CashRefundError('VALIDATION_FAILED', '实录返还本金必须等于实际净入账加本次我方被扣银行费；不可默认承担方或隐式换汇，混合收款请先暂挂核对');
  return { clientRequestId, expectedVersion: input.expectedVersion, returnedPrincipal: principal.toString(), receivedNet: net.toString(),
    bankFee: fee.toString(), feeBearer, actualDate: refundDate(input.actualDate), actualMethod: input.actualMethod,
    bankReference: input.bankReference.trim(), evidenceIds: [...input.evidenceIds].sort(), receiptVoucherId: input.receiptVoucherId ?? null,
    ...(input.companyAccountId!=null?{companyAccountId:input.companyAccountId,expectedAccountRevision:input.expectedAccountRevision}:{}) };
}
export async function readCashRefundPaidSource(tx: any, note: any, refund: any) {
  await assertRefundHistory(tx, refund);
  if (refund.status !== 'Paid' || !refund.paymentVoucherId || refund.creditNoteId !== note.id) refundRefusal('仅完整真实已付款退款可登记实际银行返款，未付申请不可制造收回资金');
  const source = await tx.creditNoteSettlementEvent.findUnique({ where: { refundId: refund.id } });
  if (!source) refundRefusal('原实付退款缺少真实结算出口');
  await assertCashRefundSettlement(tx, note, source);
  return source;
}
export async function readCashReturnSourceProof(tx: any, refundId: string, source: any) {
  const rows = await tx.creditNoteRefundEvidence.findMany({ where: { refundId, purpose: 'PaymentProof', id: { in: source.parameters.evidenceIds } } });
  if (rows.length !== source.parameters.evidenceIds.length) refundRefusal('原实付来源缺少完整原字节证明');
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isInteger(row.fileSize) || row.fileSize < 1
        || !['application/pdf', 'image/png', 'image/jpeg'].includes(row.mimeType)) refundRefusal('银行证明的原字节摘要、大小或类型不完整');
    await assertCashRefundEvidence(tx, row);
  }
  return rows;
}
export async function readCashReturnProof(tx: any, refundId: string, evidenceIds: string[]) {
  const rows = await tx.creditNoteRefundEvidence.findMany({ where: { refundId, purpose: 'PaymentReturnProof', id: { in: evidenceIds } } });
  if (rows.length !== evidenceIds.length) refundRefusal('返款须用本已付退款实际私有上传的本次银行返款证明，不能复用原付出证明');
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isInteger(row.fileSize) || row.fileSize < 1
        || !['application/pdf', 'image/png', 'image/jpeg'].includes(row.mimeType)) refundRefusal('银行证明的原字节摘要、大小或类型不完整');
    await assertCashRefundEvidence(tx, row);
  }
  return rows;
}
export async function assertReturnReceiptNeverAllocated(tx: any, receiptId: string) {
  const rows = await tx.invoiceAllocation.findMany({ where: { voucherId: receiptId } });
  const history = await tx.auditLog.findMany({ where: { targetType: 'InvoiceAllocation', OR: [
    { detail: { path: ['after', 'voucherId'], equals: receiptId } },
    { detail: { path: ['before', 'voucherId'], equals: receiptId } },
  ] } });
  if (rows.length || history.length) refundRefusal('此收款已有发票分配或原分配历史，须保留事实人工核对，不可再自动恢复贷项余额');
}
export function cashReturnSnapshot(row: any) {
  return { schemaVersion: 1, id: row.id, creditNoteId: row.creditNoteId, refundId: row.refundId, customerRelationId: row.customerRelationId,
    sourceSettlementEventId: row.sourceSettlementEventId, sourcePaymentVoucherId: row.sourcePaymentVoucherId,
    currentVersionId: row.currentVersionId, currentVersionFingerprint: row.currentVersionFingerprint, receiptVoucherId: row.receiptVoucherId,
    returnedPrincipal: String(row.returnedPrincipal), receivedNet: String(row.receivedNet), bankFee: String(row.bankFee), feeBearer: row.feeBearer ?? null,
    currency: row.currency, actualDate: row.actualDate, actualMethod: row.actualMethod, bankReference: row.bankReference,
    actorId: row.actorId, requestId: row.requestId, parameters: row.parameters, parametersHash: row.parametersHash, createdAt: String(row.createdAt) };
}
/** Physical bytes are checked by the service's private reader during commit and
 * the dedicated history/result read. This shared account proof validates their
 * immutable DB digest, upload audit, joins and the exact bank-reference intent. */
export async function assertCashRefundReturnFact(tx: any, note: any, row: any) {
  const refund = await tx.creditNoteRefund.findUnique({ where: { id: row.refundId } });
  if (!refund) refundRefusal('返款缺少原客户实付来源');
  const source = await readCashRefundPaidSource(tx, note, refund);
  const version = await tx.creditNoteDocumentVersion.findUnique({ where: { id: row.currentVersionId } });
  const receipt = await tx.paymentVoucher.findUnique({ where: { id: row.receiptVoucherId } });
  const audit = await tx.auditLog.findUnique({ where: { id: row.auditId } });
  const voucherAudits = await tx.auditLog.findMany({ where: { targetType: 'PaymentVoucher', targetId: row.receiptVoucherId, action: 'create_voucher' } });
  if (voucherAudits.length !== 1 || voucherAudits[0].detail?.after?.id !== row.receiptVoucherId
      || voucherAudits[0].detail?.after?.type !== 'Receipt') refundRefusal('实际返款收款缺少真实创建审计');
  const parameters = row.parameters, command = parameters?.command;
  if (row.creditNoteId !== note.id || row.customerRelationId !== refund.customerRelationId || row.sourceSettlementEventId !== source.id
      || row.sourcePaymentVoucherId !== refund.paymentVoucherId || row.currency !== source.currency || row.currency !== note.currency
      || !version || version.creditNoteId !== note.id || version.contentFingerprint !== row.currentVersionFingerprint
      || version.contentFingerprint !== creditNoteDigest(version.linesSnapshot)
      || !receipt || receipt.type !== 'Receipt' || receipt.deletedAt || receipt.status !== 'reconciled'
      || receipt.customerRelationId !== row.customerRelationId || receipt.currency !== row.currency || receipt.paymentDate !== row.actualDate
      || receipt.paymentMethod !== row.actualMethod || !new Prisma.Decimal(receipt.amount).equals(row.returnedPrincipal)
      || !new Prisma.Decimal(receipt.bankFee).equals(row.bankFee) || (receipt.feeBearer ?? null) !== (row.feeBearer ?? null)
      || receipt.invoiceId || receipt.appliedAmount != null || receipt.attachments?.paymentReference !== row.bankReference
      || receipt.attachments?.receivedNet !== String(row.receivedNet)
      || canonicalClaimJson(receipt.attachments?.evidenceIds) !== canonicalClaimJson(command?.evidenceIds)
      || parameters?.schemaVersion !== 1 || parameters.sourceSettlementEventId !== row.sourceSettlementEventId
      || parameters.sourcePaymentVoucherId !== row.sourcePaymentVoucherId || parameters.currentVersionId !== row.currentVersionId
      || parameters.currentVersionFingerprint !== row.currentVersionFingerprint
      || !command || row.requestId !== command.clientRequestId || row.parametersHash !== creditNoteDigest(parameters)
      || !audit || audit.actorId !== row.actorId || audit.action !== 'CREDIT_NOTE_REFUND_RETURN_RECORDED'
      || audit.targetType !== 'CreditNoteRefundReturn' || audit.targetId !== row.id
      || canonicalClaimJson(audit.detail?.cashRefundReturn) !== canonicalClaimJson(cashReturnSnapshot(row))) refundRefusal('银行返款、真实收款凭证、来源版本或必需审计不一致');
  const normalized = normalizeCashRefundReturn(command);
  if (canonicalClaimJson(normalized) !== canonicalClaimJson(command)
      || normalized.returnedPrincipal !== String(row.returnedPrincipal) || normalized.receivedNet !== String(row.receivedNet)
      || normalized.bankFee !== String(row.bankFee) || normalized.feeBearer !== (row.feeBearer ?? null)
      || normalized.actualDate !== row.actualDate || normalized.actualMethod !== row.actualMethod || normalized.bankReference !== row.bankReference
      || normalized.expectedVersion !== version.version) refundRefusal('银行返款本金、净额、扣费或实际流水不符合完整实录');
  const envelope = parameters.requestEnvelope;
  if (envelope?.schemaVersion !== 1 || envelope.action !== 'return' || envelope.originalClientRequestId !== row.requestId
      || envelope.originalParameterHash !== creditNoteDigest(envelope.originalPayload)
      || canonicalClaimJson(normalizeCashRefundReturn(envelope.originalPayload)) !== canonicalClaimJson(command)) refundRefusal('返款缺少准确完整原请求回执');
  const cohort = await tx.creditNoteRefundReturn.findMany({ where: { refundId: refund.id } });
  const total = cohort.reduce((sum: Prisma.Decimal, fact: any) => sum.plus(refundAmount(String(fact.returnedPrincipal))), new Prisma.Decimal(0));
  if (total.gt(source.amount) || new Prisma.Decimal(row.returnedPrincipal).gt(source.amount)) refundRefusal('实际累计返款超过原已付本金，不可恢复多于原真实付款的余额');
  const bindings = await tx.creditNoteRefundReturnEvidence.findMany({ where: { returnId: row.id } });
  if (bindings.length !== command.evidenceIds.length || new Set(bindings.map((binding: any) => binding.evidenceId)).size !== bindings.length
      || bindings.some((binding: any) => !command.evidenceIds.includes(binding.evidenceId))) refundRefusal('返款缺少准确的银行原字节证据绑定');
  const evidence = await readCashReturnProof(tx, refund.id, command.evidenceIds);
  await assertReturnReceiptNeverAllocated(tx, receipt.id);
  return { refund, source, version, receipt, evidence, sourceEvidence: await readCashReturnSourceProof(tx, refund.id, source) };
}
export async function assertCashRefundReturnSettlement(tx: any, note: any, event: any) {
  if (event.kind !== 'CashRefundReturn' || !event.refundReturnId || event.refundId || event.invoiceId || !event.sourceEventId) refundRefusal('返款余额恢复事件缺少精确真实出口');
  const row = await tx.creditNoteRefundReturn.findUnique({ where: { id: event.refundReturnId } });
  if (!row) refundRefusal('余额恢复缺少真实银行返款事实');
  await assertCashRefundReturnFact(tx, note, row);
  if (event.creditNoteId !== row.creditNoteId || event.sourceEventId !== row.sourceSettlementEventId || event.paymentVoucherId !== row.receiptVoucherId
      || event.actorId !== row.actorId || event.requestId !== row.requestId || event.currency !== row.currency
      || !new Prisma.Decimal(event.amount).equals(row.returnedPrincipal) || event.parametersHash !== row.parametersHash
      || canonicalClaimJson(event.parameters) !== canonicalClaimJson(row.parameters)) refundRefusal('银行返款事实与贷项余额恢复事件不一致');
  return row;
}
