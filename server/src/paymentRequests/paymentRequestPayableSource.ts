/** An AP selection is an immutable approval basis, never a free-form attachment.
 * Contract advances and other genuine non-AP payments retain their own sources. */
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { ciHash } from '../development/developmentCiSource';
import { createFinanceSourceAccess } from '../finance/financeSourceAccess';
import { readSupplierVatPayableSource, SUPPLIER_VAT_PAYABLE_SOURCE } from '../finance/supplierVatPayableSource';

export const PAYMENT_REQUEST_PAYABLE_SOURCE = 'SupplierVatPayablePayment';
export type PaymentRequestPayableSelection = { invoiceId: string; requestedAmount: string; expectedSourceFingerprint: string };
type OriginalDocumentLabels = { invoiceNumber: string; vatCode: string | null; vatNumber: string; supplierName: string; contractNumbers: string[] };
export type PaymentRequestPayableEntry = { invoiceId: string; vatInvoiceId: string; sourceFingerprint: string;
  invoiceAmount: string; requestedAmount: string; appliedAmountAtSubmission: string; remainingAmountAtSubmission: string;
  originalDocument?: OriginalDocumentLabels };
export type PaymentRequestPayableSnapshot = { schemaVersion: 1; sourceType: typeof PAYMENT_REQUEST_PAYABLE_SOURCE;
  supplierId: string; currency: string; totalAmount: string; entries: PaymentRequestPayableEntry[]; sourceFingerprint: string };
const object = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const refuse = (message: string, code = 'PAYMENT_REQUEST_AP_CHANGED', statusCode = 409): never => {
  throw Object.assign(new Error(message), { code, statusCode });
};
function amount(value: unknown, zero = false): Prisma.Decimal {
  const raw = value instanceof Prisma.Decimal ? value.toString() : value;
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(raw))
    return refuse('应付选择金额须为最多四位小数的明确十进制数。', 'INVALID_INPUT', 400);
  const result = new Prisma.Decimal(raw);
  if (zero ? result.lt(0) : result.lte(0)) return refuse('应付选择金额无效。', 'INVALID_INPUT', 400);
  return result;
}
const id = (v: unknown): string => typeof v === 'string' && !!v.trim() && v.length <= 200 ? v.trim()
  : refuse('准确应付原票身份缺失。', 'INVALID_INPUT', 400);
const fingerprint = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v
  : refuse('应付原票来源指纹缺失，请重新核对原票。', 'INVALID_INPUT', 400);
function originalDocumentLabels(value: unknown): OriginalDocumentLabels {
  const row = object(value);
  if (!Array.isArray(row.contractNumbers) || !row.contractNumbers.length) return refuse('应付原票缺少可核对的准确合同编号。');
  return { invoiceNumber: id(row.invoiceNumber), vatCode: row.vatCode == null ? null : id(row.vatCode), vatNumber: id(row.vatNumber),
    supplierName: id(row.supplierName), contractNumbers: [...new Set(row.contractNumbers.map(id))].sort() };
}
function labelsFromOriginal(original: Awaited<ReturnType<typeof readSupplierVatPayableSource>>): OriginalDocumentLabels {
  return originalDocumentLabels({ invoiceNumber: original.invoice.invoiceNumber, vatCode: original.snapshot.vatOriginal.vatCode,
    vatNumber: original.snapshot.vatOriginal.vatNumber, supplierName: original.snapshot.vatOriginal.sellerName,
    contractNumbers: original.snapshot.sources.map(source => source.contractNumber) });
}
function trustedActor(value: unknown): TokenPayload {
  const actor = object(value);
  if (typeof actor.userId !== 'string' || !Array.isArray(actor.roles) || !Array.isArray(actor.permissions) || !Array.isArray(actor.departmentIds))
    return refuse('准确应付处理缺少当前可信登录身份。', 'UNAUTHORIZED', 401);
  return value as TokenPayload; // Preserve the exact credential, including its server-owned ceiling; never manufacture grants.
}

export function normalizePaymentRequestPayables(value: unknown): PaymentRequestPayableSelection[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    return refuse('请选择1至100张准确供应商应付原票。', 'PAYMENT_REQUEST_AP_REQUIRED');
  const result = value.map(value => {
    const row = object(value);
    if (Object.keys(row).some(key => !['invoiceId', 'requestedAmount', 'expectedSourceFingerprint'].includes(key)))
      return refuse('应付选择含不支持的字段。', 'INVALID_INPUT', 400);
    return { invoiceId: id(row.invoiceId), requestedAmount: amount(row.requestedAmount).toFixed(4),
      expectedSourceFingerprint: fingerprint(row.expectedSourceFingerprint) };
  }).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  if (new Set(result.map(row => row.invoiceId)).size !== result.length) return refuse('同一申请不能重复选择同一应付原票。', 'INVALID_INPUT', 400);
  return result;
}

function readSnapshot(value: unknown): PaymentRequestPayableSnapshot {
  const row = object(value);
  if (row.schemaVersion !== 1 || row.sourceType !== PAYMENT_REQUEST_PAYABLE_SOURCE || !Array.isArray(row.entries) || !row.entries.length || row.entries.length > 100)
    return refuse('原申请的准确应付冻结依据缺失，须重新提交准确申请。');
  const entries: PaymentRequestPayableEntry[] = row.entries.map((value: unknown) => {
    const entry = object(value);
    const original = amount(entry.invoiceAmount), applied = amount(entry.appliedAmountAtSubmission, true), remaining = amount(entry.remainingAmountAtSubmission, true);
    const requested = amount(entry.requestedAmount);
    if (!applied.plus(remaining).eq(original) || requested.gt(remaining)) return refuse('原申请逐票金额或余额冻结依据不守恒。');
    return { invoiceId: id(entry.invoiceId), vatInvoiceId: id(entry.vatInvoiceId), sourceFingerprint: fingerprint(entry.sourceFingerprint),
      invoiceAmount: original.toFixed(4), requestedAmount: requested.toFixed(4), appliedAmountAtSubmission: applied.toFixed(4), remainingAmountAtSubmission: remaining.toFixed(4),
      ...(entry.originalDocument == null ? {} : { originalDocument: originalDocumentLabels(entry.originalDocument) }) };
  }).sort((a: PaymentRequestPayableEntry, b: PaymentRequestPayableEntry) => a.invoiceId.localeCompare(b.invoiceId));
  if (new Set(entries.map(entry => entry.invoiceId)).size !== entries.length) return refuse('原申请重复覆盖同一张应付原票。');
  const total = amount(row.totalAmount), sum = entries.reduce((sum, entry) => sum.plus(entry.requestedAmount), new Prisma.Decimal(0));
  if (!sum.eq(total) || !/^[A-Z]{3}$/.test(row.currency)) return refuse('原申请币种或逐票申请金额不一致。');
  const basis: Omit<PaymentRequestPayableSnapshot, 'sourceFingerprint'> = { schemaVersion: 1, sourceType: PAYMENT_REQUEST_PAYABLE_SOURCE, supplierId: id(row.supplierId),
    currency: row.currency as string, totalAmount: total.toFixed(4), entries };
  if (fingerprint(row.sourceFingerprint) !== ciHash(basis)) return refuse('原申请准确应付冻结内容已变化。');
  return { ...basis, sourceFingerprint: row.sourceFingerprint };
}

export function hasPaymentRequestPayableBasis(request: any, payload?: unknown) {
  // sourceSnapshot is also used by quotations. Only the PaymentRequest's own
  // reserved field, or this explicit AP marker, identifies an AP application.
  return object(request?.attachments).sourceSnapshot != null || object(object(request?.attachments).sourceDocument).type === 'supplier_payable'
    || object(object(payload).sourceSnapshot).sourceType === PAYMENT_REQUEST_PAYABLE_SOURCE
    || object(object(payload).sourceDocument).type === 'supplier_payable';
}

export const isPaymentRequestApproval = (approval: any): boolean =>
  approval?.actionType === 'finance:payment_request' && approval?.targetType === 'PaymentRequest' && !!approval.targetId;

async function lockPayables(tx: any, ids: string[]) {
  for (const invoiceId of [...new Set(ids)].sort())
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id"=${invoiceId} FOR UPDATE`);
}
async function originalPayable(tx: any, access: Awaited<ReturnType<typeof createFinanceSourceAccess>>, invoiceId: string,
  supplierId: string, currency: string, consuming = true) {
  const row = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
  if (!row || row.type !== 'Payable' || row.sourceType !== SUPPLIER_VAT_PAYABLE_SOURCE || !row.sourceId
    || !['Issued', 'PartiallyPaid', 'Paid'].includes(row.status)) return refuse('所选应付不是可核实的供应商原票登记。');
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VatInvoice" WHERE "id"=${row.sourceId} FOR SHARE`);
  const original = await readSupplierVatPayableSource(tx, row.sourceId);
  if (original.invoice.id !== row.id || !await access.invoice(original.invoice)) return refuse('准确应付不在当前财务数据范围。', 'NOT_FOUND', 404);
  if (row.customerRelationId !== supplierId || row.currency !== currency) return refuse('应付原票收款供应商或币种与本次申请不一致。');
  if (consuming && !['Received', 'Verified', 'Declared'].includes(original.vatInvoice.status))
    return refuse('原供应商发票已作废、红冲或状态未知，不能据此新增申请、批准或登记新实付。');
  const allocations = await tx.invoiceAllocation.findMany({ where: { invoiceId }, select: { voucherId: true, appliedAmount: true } });
  const credits = await tx.creditNoteAllocation.findMany({ where: { invoiceId }, select: { appliedAmount: true } });
  const applied = [...allocations, ...credits].reduce((sum, item) => sum.plus(amount(String(item.appliedAmount), true)), new Prisma.Decimal(0));
  const face = amount(String(row.amount)), remaining = face.minus(applied);
  if (remaining.lt(0)) return refuse('应付原票已核销额超过原票金额，须先核清原账。');
  return { row, original, allocations, face, applied, remaining };
}
async function ownApplied(tx: any, requestId: string, allocations: Array<{ voucherId: string; appliedAmount: unknown }>) {
  const vouchers = await tx.paymentVoucher.findMany({ where: { attachments: { path: ['paymentRequestId'], equals: requestId } }, select: { id: true } });
  const ids = new Set(vouchers.map((row: any) => row.id));
  return allocations.filter(row => ids.has(row.voucherId)).reduce((sum, row) => sum.plus(String(row.appliedAmount)), new Prisma.Decimal(0));
}
async function otherReserved(tx: any, invoiceId: string, allocations: Array<{ voucherId: string; appliedAmount: unknown }>, exceptId?: string) {
  const requests = await tx.paymentRequest.findMany({ where: { deletedAt: null,
    status: { in: ['Pending', 'Approved', 'Executing', 'Paid', 'VoucherIssued'] },
    attachments: { path: ['sourceSnapshot', 'sourceType'], equals: PAYMENT_REQUEST_PAYABLE_SOURCE } } });
  let reserved = new Prisma.Decimal(0);
  for (const request of requests) {
    if (request.id === exceptId) continue;
    const frozen = readSnapshot(object(request.attachments).sourceSnapshot), entry = frozen.entries.find(entry => entry.invoiceId === invoiceId);
    if (!entry) continue;
    const outstanding = new Prisma.Decimal(entry.requestedAmount).minus(await ownApplied(tx, request.id, allocations));
    if (outstanding.lt(0)) return refuse('其他付款申请的逐票核销已超过批准额度，请核清原账。');
    reserved = reserved.plus(outstanding);
  }
  return reserved;
}

export type PaymentRequestPayableCandidate = {
  invoiceId: string; vatInvoiceId: string; invoiceNumber: string; vatNumber: string; vatCode: string | null;
  supplierId: string; supplierName: string; currency: string; contractNumbers: string[]; sourceFingerprint: string;
  invoiceAmount: string; appliedAmount: string; remainingAmount: string; reservedAmount: string; availableAmount: string;
};
/** A read preview uses the same original/source and reservation calculations
 * as the submit command. Only visible usable rows determine pagination. */
export async function listPaymentRequestPayableCandidates(tx: any, actor: unknown, input: {
  supplierId?: unknown; currency?: unknown; search?: unknown; cursor?: unknown; limit?: unknown;
}): Promise<{ items: PaymentRequestPayableCandidate[]; nextCursor: string | null; hasMore: boolean }> {
  const access = await createFinanceSourceAccess(tx, trustedActor(actor), ['finance:payment_request:create', 'invoices:read']);
  const supplierId = id(input.supplierId), currency = typeof input.currency === 'string' ? input.currency.trim() : '';
  const search = input.search == null ? '' : typeof input.search === 'string' ? input.search.trim().toLocaleLowerCase() : null;
  const cursor = input.cursor == null || input.cursor === '' ? null : id(input.cursor);
  const limit = input.limit == null || input.limit === '' ? 25 : Number(input.limit);
  if (!/^[A-Z]{3}$/.test(currency) || search == null || search.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return refuse('请选择准确供应商、币种，并使用有效分页或搜索条件。', 'INVALID_INPUT', 400);
  const items: PaymentRequestPayableCandidate[] = [];
  let after = cursor;
  while (items.length <= limit) {
    const rows = await tx.invoice.findMany({ where: { deletedAt: null, type: 'Payable', sourceType: SUPPLIER_VAT_PAYABLE_SOURCE,
      customerRelationId: supplierId, currency, status: { in: ['Issued', 'PartiallyPaid', 'Paid'] }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take: 100 });
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      let current: Awaited<ReturnType<typeof originalPayable>>;
      try { current = await originalPayable(tx, access, row.id, supplierId, currency); }
      catch (error: any) {
        // Hidden or no-longer-consumable originals must not leak a count or
        // position. Database/auth failures remain explicit failures.
        if (['NOT_FOUND', 'PAYMENT_REQUEST_AP_CHANGED', 'CONFLICT'].includes(error?.code)) continue;
        throw error;
      }
      const reserved = await otherReserved(tx, row.id, current.allocations), available = current.remaining.minus(reserved);
      if (!available.gt(0)) continue;
      const labels = labelsFromOriginal(current.original);
      if (search && ![labels.invoiceNumber, labels.vatNumber, labels.vatCode, labels.supplierName, ...labels.contractNumbers]
        .filter(Boolean).some(value => value!.toLocaleLowerCase().includes(search))) continue;
      items.push({ invoiceId: row.id, vatInvoiceId: current.row.sourceId, invoiceNumber: labels.invoiceNumber,
        vatNumber: labels.vatNumber, vatCode: labels.vatCode, supplierId, supplierName: labels.supplierName, currency,
        contractNumbers: labels.contractNumbers, sourceFingerprint: current.original.snapshot.sourceFingerprint,
        invoiceAmount: current.face.toFixed(4), appliedAmount: current.applied.toFixed(4), remainingAmount: current.remaining.toFixed(4),
        reservedAmount: reserved.toFixed(4), availableAmount: available.toFixed(4) });
      if (items.length > limit) break;
    }
    if (items.length > limit || rows.length < 100) break;
  }
  await access.finish();
  const hasMore = items.length > limit, page = items.slice(0, limit);
  return { items: page, nextCursor: hasMore ? page[page.length - 1].invoiceId : null, hasMore };
}

export async function freezePaymentRequestPayables(tx: any, input: { actor?: TokenPayload | null; applicantId: string;
  supplierId: string | null; currency: string; totalAmount: string; selections: unknown }): Promise<PaymentRequestPayableSnapshot> {
  const selected = normalizePaymentRequestPayables(input.selections);
  const access = await createFinanceSourceAccess(tx, trustedActor(input.actor), ['finance:payment_request:create', 'invoices:read']);
  if (access.actor.userId !== input.applicantId || !input.supplierId) return refuse('应付申请缺少当前可信操作人或准确供应商。', 'UNAUTHORIZED', 401);
  await lockPayables(tx, selected.map(row => row.invoiceId));
  const entries: PaymentRequestPayableEntry[] = [];
  for (const entry of selected) {
    const current = await originalPayable(tx, access, entry.invoiceId, input.supplierId, input.currency);
    if (current.original.snapshot.sourceFingerprint !== entry.expectedSourceFingerprint) return refuse('应付原票来源已变化，请重新核对所选原票。');
    if (new Prisma.Decimal(entry.requestedAmount).plus(await otherReserved(tx, entry.invoiceId, current.allocations)).gt(current.remaining))
      return refuse('所选应付已核销或被其他有效付款申请覆盖，本次申请超过未覆盖余额。');
    entries.push({ invoiceId: entry.invoiceId, vatInvoiceId: current.row.sourceId, sourceFingerprint: entry.expectedSourceFingerprint,
      invoiceAmount: current.face.toFixed(4), requestedAmount: entry.requestedAmount,
      appliedAmountAtSubmission: current.applied.toFixed(4), remainingAmountAtSubmission: current.remaining.toFixed(4), originalDocument: labelsFromOriginal(current.original) });
  }
  const total = amount(input.totalAmount);
  if (!entries.reduce((sum, entry) => sum.plus(entry.requestedAmount), new Prisma.Decimal(0)).eq(total)) return refuse('申请总额须准确等于逐张应付选择的本次付款金额。');
  const basis: Omit<PaymentRequestPayableSnapshot, 'sourceFingerprint'> = { schemaVersion: 1, sourceType: PAYMENT_REQUEST_PAYABLE_SOURCE, supplierId: input.supplierId,
    currency: input.currency, totalAmount: total.toFixed(4), entries };
  await access.finish();
  return { ...basis, sourceFingerprint: ciHash(basis) };
}

/** Original-key replay still checks current authority and source identity, but
 * must return its old receipt after later legitimate payments/allocations. */
export async function assertPaymentRequestPayableBasis(tx: any, input: { request: any; approvalPayload?: unknown;
  actor?: unknown; checkCapacity?: boolean; scopes?: ('invoices:read' | 'vouchers:write')[] }) {
  const { request } = input;
  if (!hasPaymentRequestPayableBasis(request, input.approvalPayload)) return null;
  const snapshot = requestBasis(request, input.approvalPayload);
  const access = await createFinanceSourceAccess(tx, trustedActor(input.actor), input.scopes ?? ['invoices:read']);
  await lockPayables(tx, snapshot.entries.map(row => row.invoiceId));
  for (const entry of snapshot.entries) {
    const current = await originalPayable(tx, access, entry.invoiceId, snapshot.supplierId, snapshot.currency, input.checkCapacity !== false);
    if (current.row.sourceId !== entry.vatInvoiceId || current.original.snapshot.sourceFingerprint !== entry.sourceFingerprint
      || !current.face.eq(entry.invoiceAmount)
      || entry.originalDocument && ciHash(entry.originalDocument) !== ciHash(labelsFromOriginal(current.original))) return refuse('原批准应付的原票、金额或来源已变化，请重新核对。');
    if (input.checkCapacity !== false) {
      const outstanding = new Prisma.Decimal(entry.requestedAmount).minus(await ownApplied(tx, request.id, current.allocations));
      if (outstanding.lt(0) || outstanding.plus(await otherReserved(tx, entry.invoiceId, current.allocations, request.id)).gt(current.remaining))
        return refuse('原批准应付的未核销余额或其他申请覆盖已变化，本次不能继续审批或实付。');
    }
  }
  await access.finish();
  return snapshot;
}

function requestBasis(request: any, approvalPayload: unknown): PaymentRequestPayableSnapshot {
  const snapshot = readSnapshot(object(request.attachments).sourceSnapshot), payload = object(approvalPayload);
  if (!payload.sourceSnapshot || ciHash(payload.sourceSnapshot) !== ciHash(snapshot)
    || ciHash(object(request.attachments).sourceDocument) !== ciHash({ type: 'supplier_payable', id: snapshot.sourceFingerprint })
    || ciHash(payload.sourceDocument) !== ciHash(object(request.attachments).sourceDocument)
    || request.supplierId !== snapshot.supplierId || request.currency !== snapshot.currency
    || !new Prisma.Decimal(request.totalAmount).eq(snapshot.totalAmount)) return refuse('当前申请、审批与准确应付冻结来源不一致。');
  return snapshot;
}

/** The common allocation kernel calls this after its invoice lock. This is a
 * source invariant, not an authorization substitute: HTTP/Agent still perform
 * their existing fresh invoice/voucher access checks with the actual actor. */
export async function assertPaymentRequestPayableAllocation(tx: any, input: { voucher: any; invoiceId: string;
  appliedAmount: string; invoiceAllocations: Array<{ voucherId: string; appliedAmount: unknown }> }) {
  const attachments = object(input.voucher.attachments), actual = object(attachments.actualPayment);
  const requestId = attachments.paymentRequestId;
  if (!requestId) {
    if (actual.payableSourceFingerprint != null) return refuse('准确应付付款凭证缺少原申请关联。');
    return;
  }
  const request = await tx.paymentRequest.findUnique({ where: { id: requestId } });
  if (!request) return refuse('付款凭证关联的原申请不存在，不能转用于其他原票。');
  if (!hasPaymentRequestPayableBasis(request)) return; // Genuine contract advances retain their existing settlement path.
  const approval = request.approvalRequestId && await tx.approvalRequest.findUnique({ where: { id: request.approvalRequestId } });
  if (!approval || !isPaymentRequestApproval(approval) || approval.targetId !== request.id || approval.status !== 'approved'
    || approval.requesterId !== request.applicantId || !approval.reviewerId) return refuse('付款凭证缺少原准确应付批准事实。');
  const snapshot = requestBasis(request, approval.payload), entry = snapshot.entries.find(row => row.invoiceId === input.invoiceId);
  if (!entry) return refuse('本次原票不在该实际付款的准确批准应付集合中，不能挪用已批准付款。');
  if (actual.protocolVersion !== 1 || actual.paymentRequestId !== request.id || actual.approvalRequestId !== approval.id
    || actual.payableSourceFingerprint !== snapshot.sourceFingerprint || input.voucher.type !== 'Disbursement'
    || input.voucher.currency !== snapshot.currency || input.voucher.customerRelationId !== snapshot.supplierId)
    return refuse('实际付款凭证与原批准应付来源不一致。');
  const original = await readSupplierVatPayableSource(tx, entry.vatInvoiceId);
  if (original.invoice.id !== input.invoiceId || original.invoice.sourceId !== entry.vatInvoiceId
    || original.snapshot.sourceFingerprint !== entry.sourceFingerprint || !new Prisma.Decimal(original.invoice.amount).eq(entry.invoiceAmount)
    || !['Received', 'Verified', 'Declared'].includes(original.vatInvoice.status)) return refuse('原应付票据已变化、作废或红冲，不能新增核销。');
  const vouchers = await tx.paymentVoucher.findMany({ where: { attachments: { path: ['paymentRequestId'], equals: request.id } }, select: { id: true } });
  const ownIds = new Set(vouchers.map((row: any) => row.id));
  const others = input.invoiceAllocations.filter(row => row.voucherId !== input.voucher.id && ownIds.has(row.voucherId))
    .reduce((sum, row) => sum.plus(String(row.appliedAmount)), new Prisma.Decimal(0));
  if (others.plus(input.appliedAmount).gt(entry.requestedAmount)) return refuse('该申请所有付款凭证对本张原票的累计核销超过逐票批准金额。');
}

/** Shared by every decision channel and the original approval read routes. */
export async function assertPaymentRequestPayableApproval(tx: any, approval: any, actor: unknown, checkCapacity = true) {
  if (!isPaymentRequestApproval(approval)) return null;
  let request = await tx.paymentRequest.findUnique({ where: { id: approval.targetId } });
  if (!hasPaymentRequestPayableBasis(request, approval.payload)) return null;
  if (checkCapacity) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PaymentRequest" WHERE "id"=${approval.targetId} FOR UPDATE`);
    request = await tx.paymentRequest.findUnique({ where: { id: approval.targetId } });
  }
  if (!request || request.deletedAt || request.approvalRequestId !== approval.id || request.applicantId !== approval.requesterId)
    return refuse('原审批与准确应付付款申请不一致。');
  return assertPaymentRequestPayableBasis(tx, { request, approvalPayload: approval.payload, actor, checkCapacity });
}

export async function assertPaymentRequestPayableRead(tx: any, request: any, actor: unknown) {
  if (!hasPaymentRequestPayableBasis(request)) return;
  const approval = request.approvalRequestId && await tx.approvalRequest.findUnique({ where: { id: request.approvalRequestId } });
  if (!approval) return refuse('准确应付申请的原审批依据缺失。');
  await assertPaymentRequestPayableApproval(tx, approval, actor, false);
}
