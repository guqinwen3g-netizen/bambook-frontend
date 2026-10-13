import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createSequenceService } from '../sequence/sequenceService';
import { todayLocalKey } from '../shared/localDate';
import { createPaymentVoucher } from '../finance/paymentVoucherMutationService';
import {assertVoucherCashUse} from '../finance/companyCashAccountService';
import { assertClaimCreditNoteAccount, creditNoteBalanceStatus, creditNoteDigest, creditNoteEffectiveAmount, lockCreditNoteForSettlement } from './claimCreditNoteVersionService';
import { appendRefundEvent, assertRefundHistory, cashRefundApprovalPayload, cashRefundReservedAmount,
  CashRefundError, type CashRefundVisibility, currentRefundActor, lockCashRefund, lockCashRefundByPaymentRequest,
  readCashRefundDecision, refundAmount, refundDate, refundId, refundPayee, refundRefusal, refundReplay,
  refundRequestId, requireRefundVisibility, assertCashRefundEvidence } from './claimCashRefundFact';
import { canonicalClaimJson } from './claimApprovalFact';
import { hasScope } from '../auth/permissionService';
import { assertRefundReplayEnvelope, assertRefundRequestNotRetired, normalizeRefundRequest, refundRequestEnvelope } from './claimCashRefundRequestFact';

export interface CreateCashRefundInput {
  clientRequestId: string; expectedVersion: number; amount: string | number;
  payeeSnapshot: { accountHolder: string; accountNumber?: string; bankName?: string; swift?: string; method: string };
  expectedPaymentDate?: string; reason: string;
}
export interface ConfirmCashRefundInput {
  companyAccountId?:string;expectedAccountRevision?:number;
  clientRequestId: string; actualDate: string; actualMethod: string; paymentReference: string; evidenceIds: string[];
}
export interface CashRefundServiceOptions {
  prisma: PrismaClient; assertVisible?: CashRefundVisibility;
  /** Server private-storage reader verifies the immutable bytes at confirmation. */
  assertEvidence?: (evidence: any) => Promise<void>;
}
export function createClaimCashRefundService(options: CashRefundServiceOptions) {
  const { prisma, assertVisible } = options;
  const approvalCreate = createApprovalCreateService({ prisma, routingService: createApprovalRoutingService({ prisma }) });
  const sequenceService = createSequenceService(prisma);
  const visible = async (tx: any, note: any, prior: TokenPayload, scope?: string) => {
    const actor = await currentRefundActor(tx, prior, scope);
    if (!scope && !['aftersales:read', 'finance:read', 'vouchers:read'].some(value => hasScope(actor, value as any))) throw new CashRefundError('FORBIDDEN', '需要退款或财务读取权限');
    await requireRefundVisibility(tx, note, actor, assertVisible);
    return actor;
  };
  const transaction = <T>(fn: (tx: any) => Promise<T>): Promise<T> => (prisma as any).$transaction(fn);

  async function create(noteId: string, input: CreateCashRefundInput, prior: TokenPayload, predecessorId?: string) {
    const clientRequestId = refundRequestId(input?.clientRequestId);
    return transaction(async tx => {
      const note = await lockCreditNoteForSettlement(tx, noteId);
      const actor = await visible(tx, note, prior, 'finance:payment_request:create');
      await assertRefundRequestNotRetired(tx, noteId, clientRequestId, predecessorId ? 'resubmit' : 'create');
      const requestEnvelope = refundRequestEnvelope(predecessorId ? 'resubmit' : 'create', input);
      const parameters: any = normalizeRefundRequest(predecessorId ? 'resubmit' : 'create', input, predecessorId);
      const parametersHash = creditNoteDigest(parameters), amount = new Prisma.Decimal(parameters.amount);
      const replay = await tx.creditNoteRefund.findUnique({ where: { creditNoteId_requestId: { creditNoteId: noteId, requestId: clientRequestId } } });
      if (replay) {
        await assertRefundHistory(tx, replay);
        if (replay.requesterId !== actor.userId || replay.parametersHash !== parametersHash || canonicalClaimJson(replay.parameters) !== canonicalClaimJson(parameters)) refundRefusal('同退款申请编号的主体或参数不同，不能重复创建');
        const requested = await tx.creditNoteRefundEvent.findUnique({ where: { refundId_requestId: { refundId: replay.id, requestId: clientRequestId } } });
        assertRefundReplayEnvelope(requested, requestEnvelope);
        return { refund: replay, paymentRequest: await tx.paymentRequest.findUnique({ where: { id: replay.paymentRequestId } }), replayed: true };
      }
      const account = await assertClaimCreditNoteAccount(tx, note);
      if (!account || !note.customerRelationId || note.status === 'Cancelled') throw new CashRefundError('INVALID_STATE', '现金退款须有完整真实客户退款账户；旧单据请人工对账');
      if (account.version.version !== input.expectedVersion) refundRefusal('退款账户版本已变化，请重新加载');
      let predecessor: any = null;
      if (predecessorId) {
        const previous = await lockCashRefund(tx, predecessorId);
        predecessor = previous.refund;
        await assertRefundHistory(tx, predecessor);
        if (predecessor.creditNoteId !== noteId || predecessor.requesterId !== actor.userId
            || !['PendingApproval', 'Approved', 'Rejected', 'Cancelled', 'Invalidated'].includes(predecessor.status)) refundRefusal('仅原申请人可重新提交尚未实际执行的退款');
        const replaced = await tx.creditNoteRefundEvent.findFirst({ where: { refundId: predecessorId, kind: { in: ['Resubmitted', 'Invalidated'] } } });
        if (replaced?.parameters.successorId) refundRefusal('此退款已经重新送审，请从后续新申请续办');
      }
      const reserved = await cashRefundReservedAmount(tx, noteId, predecessorId);
      if (amount.gt(new Prisma.Decimal(note.openAmount).minus(reserved))) throw new CashRefundError('OVER_APPLIED', '退款申请超过未结余额扣除其他退款预留后的可用金额');
      const createdAt = BigInt(Date.now()), id = refundId('CNR'), requestId = refundId('PAYR');
      const requestNumber = await sequenceService.nextNumber(tx, 'paymentRequest', { occupied: async (number: string) => !!await tx.paymentRequest.findFirst({ where: { requestNumber: number }, select: { id: true } }) });
      const pr = await tx.paymentRequest.create({ data: { id: requestId, requestNumber, payeeType: 'Customer',
        supplierId: null, supplierName: null, customerRelationId: note.customerRelationId, customerName: note.customerName,
        requestDate: todayLocalKey(), expectedPaymentDate: parameters.expectedPaymentDate,
        totalAmount: amount, currency: note.currency, applicantId: actor.userId, reviewerId: actor.userId,
        status: 'Pending', paymentCategory: 'customer_reimburse', ownerId: actor.userId,
        departmentId: actor.departmentIds?.[0] ?? null, remark: parameters.reason } });
      let refund = await tx.creditNoteRefund.create({ data: { id, creditNoteId: noteId, versionId: account.version.id,
        paymentRequestId: pr.id, customerRelationId: note.customerRelationId, amount, currency: note.currency,
        payeeSnapshot: parameters.payeeSnapshot, contentFingerprint: '', requesterId: actor.userId,
        requestId: clientRequestId, parameters, parametersHash, status: 'PendingApproval', createdAt, updatedAt: createdAt } });
      const payload = await cashRefundApprovalPayload(tx, refund, pr);
      const approval = await approvalCreate.createBusinessApproval({ requesterId: actor.userId,
        actionType: 'finance:payment_request', targetType: 'PaymentRequest', targetId: pr.id, payload, risk: 'high', client: tx });
      const paymentRequest = await tx.paymentRequest.update({ where: { id: pr.id }, data: { approvalRequestId: approval.id, reviewerId: approval.reviewerId } });
      refund = await tx.creditNoteRefund.update({ where: { id }, data: { contentFingerprint: payload.contentFingerprint } });
      await appendRefundEvent(tx, refund, 'Requested', actor.userId, clientRequestId, {
        requestEnvelope,
        statusBefore: null, statusAfter: 'PendingApproval', requestParametersHash: parametersHash,
        contentFingerprint: payload.contentFingerprint, approvalRequestId: approval.id, predecessorId: predecessorId ?? null,
      });
      if (predecessor) {
        const statusBefore = predecessor.status;
        const statusAfter = ['PendingApproval', 'Approved'].includes(statusBefore) ? 'Invalidated' : statusBefore;
        await appendRefundEvent(tx, predecessor, statusAfter === 'Invalidated' ? 'Invalidated' : 'Resubmitted', actor.userId,
          'resubmitted:' + id, { statusBefore, statusAfter, successorId: id, reason: parameters.reason });
        await tx.creditNoteRefund.update({ where: { id: predecessor.id }, data: { status: statusAfter, updatedAt: createdAt } });
        if (statusAfter === 'Invalidated' && ['PendingApproval', 'Approved'].includes(statusBefore))
          await tx.paymentRequest.update({ where: { id: predecessor.paymentRequestId }, data: { status: 'Cancelled' } });
        const old = await tx.paymentRequest.findUnique({ where: { id: predecessor.paymentRequestId } });
        if (old?.approvalRequestId) {
          await tx.$queryRawUnsafe('SELECT id FROM "ApprovalRequest" WHERE id = $1 FOR UPDATE', old.approvalRequestId);
          await tx.approvalRequest.updateMany({ where: { id: old.approvalRequestId, status: 'pending' },
            data: { status: 'cancelled', decidedAt: new Date(), decisionNote: '退款重送审，保留历史；后续请求 ' + id } });
        }
      }
      return { refund, paymentRequest, approvalRequestId: approval.id, availableToSettle: new Prisma.Decimal(note.openAmount).minus(reserved).minus(amount).toString(), replayed: false };
    });
  }
  async function syncDecision(paymentRequestId: string) {
    return transaction(async tx => {
      const source = await lockCashRefundByPaymentRequest(tx, paymentRequestId);
      if (!source) return null;
      const { refund, paymentRequest: pr } = source;
      await assertRefundHistory(tx, refund);
      if (refund.status !== 'PendingApproval') return { refund, paymentRequest: pr, synced: false };
      const approval = await tx.approvalRequest.findUnique({ where: { id: pr.approvalRequestId } });
      if (!approval || approval.status === 'pending') return { refund, paymentRequest: pr, synced: false };
      if (!['approved', 'rejected'].includes(approval.status)) refundRefusal('退款审批状态不能当作通过或驳回，请人工续办');
      const fact = await readCashRefundDecision(tx, refund, pr, approval.status);
      const nextStatus = approval.status === 'approved' ? 'Approved' : 'Rejected';
      await appendRefundEvent(tx, refund, nextStatus, fact.decisionActorId, 'decision:' + fact.decisionAuditId,
        { statusBefore: 'PendingApproval', statusAfter: nextStatus, approvalRequestId: approval.id, decisionAuditId: fact.decisionAuditId, contentFingerprint: refund.contentFingerprint });
      const updatedRefund = await tx.creditNoteRefund.update({ where: { id: refund.id }, data: { status: nextStatus, decisionAuditId: fact.decisionAuditId, updatedAt: BigInt(Date.now()) } });
      const paymentRequest = await tx.paymentRequest.update({ where: { id: pr.id }, data: { status: nextStatus } });
      return { refund: updatedRefund, paymentRequest, synced: true };
    });
  }
  async function command(id: string, kind: 'Started' | 'Cancelled', input: { clientRequestId: string; reason?: string }, prior: TokenPayload) {
    const requestId = refundRequestId(input?.clientRequestId);
    return transaction(async tx => {
      const source = await lockCashRefund(tx, id), { refund, creditNote: note, paymentRequest: pr } = source;
      const actor = await visible(tx, note, prior, kind === 'Started' ? 'vouchers:write' : 'finance:payment_request:create');
      const action = kind === 'Started' ? 'start' : 'cancel';
      await assertRefundRequestNotRetired(tx, note.id, requestId, action, id);
      const requestEnvelope = refundRequestEnvelope(action, input), parameters: any = normalizeRefundRequest(action, input);
      await assertRefundHistory(tx, refund);
      const replay = await refundReplay(tx, refund, kind, actor.userId, requestId, parameters);
      if (replay) { assertRefundReplayEnvelope(replay, requestEnvelope); return { ...source, event: replay, replayed: true }; }
      await assertClaimCreditNoteAccount(tx, note);
      if (kind === 'Started') {
        if (refund.status !== 'Approved' || pr.status !== 'Approved') refundRefusal('仅已批准且未执行退款可开始付款');
        await readCashRefundDecision(tx, refund, pr);
      } else if (refund.requesterId !== actor.userId || !['PendingApproval', 'Approved'].includes(refund.status)) refundRefusal('仅申请人可撤回未实际执行的退款；执行中须先核对银行结果，已付款不能假取消');
      const status = kind === 'Started' ? 'Executing' : 'Cancelled';
      const eventParameters = { command: parameters, requestEnvelope, statusBefore: refund.status, statusAfter: status };
      const event = await appendRefundEvent(tx, refund, kind, actor.userId, requestId, eventParameters);
      const updated = await tx.creditNoteRefund.update({ where: { id }, data: { status, updatedAt: BigInt(Date.now()) } });
      const paymentRequest = await tx.paymentRequest.update({ where: { id: pr.id }, data: { status: kind === 'Started' ? 'Executing' : 'Cancelled' } });
      if (kind === 'Cancelled' && pr.approvalRequestId) {
        await tx.$queryRawUnsafe('SELECT id FROM "ApprovalRequest" WHERE id = $1 FOR UPDATE', pr.approvalRequestId);
        await tx.approvalRequest.updateMany({ where: { id: pr.approvalRequestId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date(), decisionNote: parameters.reason } });
      }
      return { refund: updated, paymentRequest, event, replayed: false };
    });
  }
  async function confirm(id: string, input: ConfirmCashRefundInput, prior: TokenPayload) {
    const requestId = refundRequestId(input?.clientRequestId);
    return transaction(async tx => {
      const { refund, paymentRequest: pr, creditNote: note } = await lockCashRefund(tx, id);
      const actor = await visible(tx, note, prior, 'vouchers:write');
      await assertRefundRequestNotRetired(tx, note.id, requestId, 'confirm', id);
      const requestEnvelope = refundRequestEnvelope('confirm', input), commandParameters: any = normalizeRefundRequest('confirm', input);
      const paymentDate = commandParameters.paymentDate;
      await assertRefundHistory(tx, refund);
      const previous = await tx.creditNoteRefundEvent.findUnique({ where: { refundId_requestId: { refundId: id, requestId } } });
      if (previous) {
        const event = await refundReplay(tx, refund, 'Paid', actor.userId, requestId, commandParameters);
        assertRefundReplayEnvelope(event, requestEnvelope);
        if (canonicalClaimJson(previous.parameters.command) !== canonicalClaimJson(commandParameters)) refundRefusal('同实付确认的日期、方式、流水或证据不同，不能重放');
        const paymentVoucher=await tx.paymentVoucher.findUnique({where:{id:refund.paymentVoucherId}});
        if(paymentVoucher)await assertVoucherCashUse(tx,actor,paymentVoucher);
        return { refund, paymentRequest: pr, creditNote: note, paymentVoucher, event, replayed: true };
      }
      if(!commandParameters.companyAccountId||!Number.isSafeInteger(commandParameters.expectedAccountRevision))throw new CashRefundError('VALIDATION_FAILED','确认真实退款须选择实际公司账户并核对当前账户版本');
      const account = await assertClaimCreditNoteAccount(tx, note);
      if (refund.status !== 'Executing' || pr.status !== 'Executing') refundRefusal('须先由财务开始实际付款，再登记完成；凭证生成不是实付');
      const fact = await readCashRefundDecision(tx, refund, pr);
      const duplicateSettlement = await tx.creditNoteSettlementEvent.findUnique({ where: { creditNoteId_requestId: { creditNoteId: note.id, requestId } } });
      if (duplicateSettlement) refundRefusal('本结算请求编号已用于另一笔退款或抵扣，请核对原结果');
      if (input.actualMethod !== refund.payeeSnapshot.method) refundRefusal('实际付款方式与批准账户不一致，须按准确事实重新送审');
      const evidence = await tx.creditNoteRefundEvidence.findMany({ where: { id: { in: commandParameters.evidenceIds }, refundId: id, purpose: 'PaymentProof' } });
      if (evidence.length !== input.evidenceIds.length || evidence.some((row: any) => !/^[a-f0-9]{64}$/.test(row.sha256) || row.fileSize <= 0)) refundRefusal('付款证据必须来自本退款的真实服务端上传');
      if (!options.assertEvidence) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '私有付款证据校验尚未配置，不能确认实付');
      for (const row of evidence) { await assertCashRefundEvidence(tx, row); await options.assertEvidence(row); }
      const reserved = await cashRefundReservedAmount(tx, note.id, id);
      if (new Prisma.Decimal(refund.amount).gt(new Prisma.Decimal(note.openAmount).minus(reserved))) throw new CashRefundError('OVER_APPLIED', '当前真实余额不足以完成本退款，请核对账户和预留');
      const made = await createPaymentVoucher({ prisma, tx, actorId: actor.userId, actor,
        cashRefundExecution: { refundId: id, paymentRequestId: pr.id },
        input: { type: 'Disbursement', voucherCategory: 'customer_reimburse', amount: String(refund.amount), currency: refund.currency,
          paymentDate, paymentMethod: input.actualMethod, customerRelationId: refund.customerRelationId, customerName: pr.customerName,
          companyAccountId:commandParameters.companyAccountId,expectedAccountRevision:commandParameters.expectedAccountRevision,
          bankReference:commandParameters.paymentReference,evidenceNote:`真实退款私有证明：${commandParameters.evidenceIds.join(',')}`,
          paymentRequestId: pr.id, attachments: { paymentReference: commandParameters.paymentReference, evidenceIds: commandParameters.evidenceIds } } });
      if (!made.ok) throw new CashRefundError('INVALID_STATE', '客户退款付款凭证未能完整落库');
      const voucher = made.data.voucher, settlementEventId = refundId('CNSE'), now = BigInt(Date.now());
      const openBefore = new Prisma.Decimal(note.openAmount), nextOpen = openBefore.minus(refund.amount);
      const status = creditNoteBalanceStatus(creditNoteEffectiveAmount(note), nextOpen);
      const parameters = { ...commandParameters, command: commandParameters, requestEnvelope, statusBefore: 'Executing', statusAfter: 'Paid',
        refundId: id, paymentRequestId: pr.id, paymentVoucherId: voucher.id, settlementEventId,
        versionId: refund.versionId, decisionAuditId: fact.decisionAuditId, contentFingerprint: refund.contentFingerprint };
      const event = await appendRefundEvent(tx, refund, 'Paid', actor.userId, requestId, parameters);
      await tx.creditNoteSettlementEvent.create({ data: { id: settlementEventId, creditNoteId: note.id, kind: 'CashRefund',
        amount: refund.amount, currency: refund.currency, actorId: actor.userId, requestId, refundId: id,
        paymentVoucherId: voucher.id, parameters, parametersHash: creditNoteDigest(parameters), createdAt: now } });
      const updated = await tx.creditNoteRefund.update({ where: { id }, data: { status: 'Paid', paymentVoucherId: voucher.id, updatedAt: now } });
      const paymentRequest = await tx.paymentRequest.update({ where: { id: pr.id }, data: { status: 'Paid', paymentVoucherId: voucher.id } });
      const creditNote = await tx.creditNote.update({ where: { id: note.id }, data: { openAmount: nextOpen, status,
        refundedAt: paymentDate, refundedBy: actor.userId, updatedAt: now } });
      await tx.auditLog.create({ data: { id: refundId('alog'), actorId: actor.userId, action: 'CREDIT_NOTE_SETTLED',
        targetType: 'CreditNote', targetId: note.id, operationType: 'transition', detail: { creditNoteSettlement: {
          schemaVersion: 1, eventId: settlementEventId, actorId: actor.userId, requestId, parameters, parametersHash: creditNoteDigest(parameters),
          versionId: account!.version.id, contentFingerprint: account!.version.contentFingerprint, createdAt: String(now),
          amountAtExecution: creditNoteEffectiveAmount(note).toString(), openBefore: openBefore.toString(), openAfter: nextOpen.toString(), statusAfter: status } } } });
      await assertClaimCreditNoteAccount(tx, creditNote);
      return { refund: updated, paymentRequest, creditNote, paymentVoucher: voucher, event, replayed: false };
    });
  }
  async function get(id: string, prior: TokenPayload) {
    return transaction(async tx => {
      const source = await lockCashRefund(tx, id);
      await visible(tx, source.creditNote, prior); await assertClaimCreditNoteAccount(tx, source.creditNote); await assertRefundHistory(tx, source.refund);
      const reservedAmount = await cashRefundReservedAmount(tx, source.creditNote.id);
      const events = await tx.creditNoteRefundEvent.findMany({ where: { refundId: id }, orderBy: { sequence: 'asc' } });
      const evidence = await tx.creditNoteRefundEvidence.findMany({ where: { refundId: id } });
      return { ...source, events, evidence: evidence.map(({ privateStorageKey: _key, ...row }: any) => row),
        reservedAmount: reservedAmount.toString(), availableToSettle: new Prisma.Decimal(source.creditNote.openAmount).minus(reservedAmount).toString() };
    });
  }
  async function failure(id: string, input: { clientRequestId: string; occurredAt: string; reference: string; evidenceIds: string[]; reason: string }, prior: TokenPayload) {
    const requestId = refundRequestId(input?.clientRequestId);
    return transaction(async tx => {
      const { refund, paymentRequest: pr, creditNote } = await lockCashRefund(tx, id);
      const actor = await visible(tx, creditNote, prior, 'vouchers:write');
      await assertRefundRequestNotRetired(tx, creditNote.id, requestId, 'failure', id);
      const requestEnvelope = refundRequestEnvelope('failure', input), commandParameters: any = normalizeRefundRequest('failure', input);
      await assertRefundHistory(tx, refund);
      const replay = await refundReplay(tx, refund, 'Failed', actor.userId, requestId, commandParameters);
      if (replay) { assertRefundReplayEnvelope(replay, requestEnvelope); return { refund, paymentRequest: pr, event: replay, replayed: true }; }
      await assertClaimCreditNoteAccount(tx, creditNote);
      if (refund.status !== 'Executing' || pr.status !== 'Executing' || refund.paymentVoucherId) refundRefusal('仅结果已核实未付款的执行中退款可登记失败，已实付须走实际银行返款');
      await readCashRefundDecision(tx, refund, pr);
      const evidence = await tx.creditNoteRefundEvidence.findMany({ where: { id: { in: commandParameters.evidenceIds }, refundId: id, purpose: 'PaymentFailure' } });
      if (!options.assertEvidence) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '私有付款证据校验尚未配置，不能登记实际拒付');
      if (evidence.length !== commandParameters.evidenceIds.length) refundRefusal('付款失败须有本请求真实服务端拒付证据');
      for (const row of evidence) { await assertCashRefundEvidence(tx, row); await options.assertEvidence!(row); }
      const event = await appendRefundEvent(tx, refund, 'Failed', actor.userId, requestId, { command: commandParameters, requestEnvelope, statusBefore: 'Executing', statusAfter: 'Approved' });
      const updated = await tx.creditNoteRefund.update({ where: { id }, data: { status: 'Approved', updatedAt: BigInt(Date.now()) } });
      const paymentRequest = await tx.paymentRequest.update({ where: { id: pr.id }, data: { status: 'Approved' } });
      return { refund: updated, paymentRequest, event, replayed: false };
    });
  }
  async function list(noteId: string, prior: TokenPayload) {
    return transaction(async tx => {
      const note = await lockCreditNoteForSettlement(tx, noteId); await visible(tx, note, prior);
      await assertClaimCreditNoteAccount(tx, note);
      const reservedAmount = await cashRefundReservedAmount(tx, noteId);
      const items = await tx.creditNoteRefund.findMany({ where: { creditNoteId: noteId }, orderBy: { createdAt: 'asc' } });
      return { creditNote: note, items, reservedAmount: reservedAmount.toString(), availableToSettle: new Prisma.Decimal(note.openAmount).minus(reservedAmount).toString() };
    });
  }
  return { create, syncDecision, start: (id: string, input: { clientRequestId: string }, actor: TokenPayload) => command(id, 'Started', input, actor),
    cancel: (id: string, input: { clientRequestId: string; reason: string }, actor: TokenPayload) => command(id, 'Cancelled', input, actor), confirm, failure, get, list };
}
