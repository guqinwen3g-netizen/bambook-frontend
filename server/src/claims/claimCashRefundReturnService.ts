import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { createPaymentVoucher } from '../finance/paymentVoucherMutationService';
import {assertCashCorrectionCapacity,assertVoucherCashUse} from '../finance/companyCashAccountService';
import { canonicalClaimJson } from './claimApprovalFact';
import { assertClaimCreditNoteAccount, assertCreditNoteSettlementEvent, creditNoteBalanceStatus, creditNoteDigest } from './claimCreditNoteVersionService';
import { CashRefundError, type CashRefundVisibility, currentRefundActor, lockCashRefund, refundId, refundRefusal, refundRequestId, requireRefundVisibility } from './claimCashRefundFact';
import { assertRefundRequestNotRetired, refundRequestEnvelope } from './claimCashRefundRequestFact';
import { assertCashRefundReturnFact, assertReturnReceiptNeverAllocated, cashReturnSnapshot, normalizeCashRefundReturn, readCashRefundPaidSource, readCashReturnProof, readCashReturnSourceProof, type CashRefundReturnInput } from './claimCashRefundReturnFact';

export interface CashRefundReturnServiceOptions {
  prisma: PrismaClient; assertVisible?: CashRefundVisibility;
  /** Must read the server's private original bytes and verify stored SHA/size. */
  assertEvidence?: (row: any) => Promise<void>;
}
/** This records a bank return already received. It neither executes a transfer
 * nor reverses the original Paid fact. Principal/net/fee are three explicit
 * bank facts; D7 has no net helper and feeBearer never guesses these amounts. */
export function createClaimCashRefundReturnService(options: CashRefundReturnServiceOptions) {
  const transaction = <T>(fn: (tx: any) => Promise<T>): Promise<T> => (options.prisma as any).$transaction(fn);
  async function visible(tx: any, note: any, prior: TokenPayload, writing = false) {
    const actor = await currentRefundActor(tx, prior, writing ? 'vouchers:write' : undefined);
    if (!writing && !['aftersales:read', 'finance:read', 'vouchers:read'].some(scope => hasScope(actor, scope as any))) throw new CashRefundError('FORBIDDEN', '需要实际返款读取权限');
    await requireRefundVisibility(tx, note, actor, options.assertVisible);
    return actor;
  }
  async function bytes(rows: any[]) {
    if (!options.assertEvidence) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '实际返款私有原字节校验尚未配置，不可确认返款');
    for (const row of rows) await options.assertEvidence(row);
  }
  async function history(tx: any, note: any, refund: any) {
    const account = await assertClaimCreditNoteAccount(tx, note);
    if (!account) throw new CashRefundError('INVALID_STATE', '返款须有完整准确的客户贷项来源');
    const source = await readCashRefundPaidSource(tx, note, refund);
    await bytes(await readCashReturnSourceProof(tx, refund.id, source));
    const rows = await tx.creditNoteRefundReturn.findMany({ where: { refundId: refund.id }, orderBy: { createdAt: 'asc' } });
    let returned = new Prisma.Decimal(0);
    for (const row of rows) {
      const fact = await assertCashRefundReturnFact(tx, note, row);
      await bytes(fact.evidence);
      const settlement = await tx.creditNoteSettlementEvent.findUnique({ where: { refundReturnId: row.id } });
      if (!settlement) refundRefusal('实际返款缺少唯一准确的贷项恢复事件');
      await assertCreditNoteSettlementEvent(tx, note, settlement);
      returned = returned.plus(row.returnedPrincipal);
    }
    if (returned.gt(source.amount)) refundRefusal('实际返款合计超过原付款本金');
    return { account, source, rows, returned, remaining: new Prisma.Decimal(source.amount).minus(returned) };
  }
  async function list(id: string, prior: TokenPayload) {
    return transaction(async tx => {
      const { creditNote, refund, paymentRequest } = await lockCashRefund(tx, id);
      await visible(tx, creditNote, prior);
      const result = await history(tx, creditNote, refund);
      // Storage paths are never returned as business evidence links.
      return { refund, paymentRequest, creditNote, items: result.rows, paidPrincipal: String(result.source.amount),
        returnedPrincipalTotal: result.returned.toString(), remainingReturnable: result.remaining.toString(),
        reservedAmount: result.account.reserved.toString(), availableToSettle: result.account.availableToSettle.toString(),
        currentVersion: result.account.version.version, meaning: 'recorded_bank_return_only' };
    });
  }
  /** Exact source reads precede human matching. Never fetch all-company bank
   * receipts or manufacture a zero appliedAmount from a nullable source. */
  async function listReceiptCandidates(id: string, prior: TokenPayload) {
    return transaction(async tx => {
      const { creditNote, refund } = await lockCashRefund(tx, id);
      await currentRefundActor(tx, prior, 'vouchers:read');
      await visible(tx, creditNote, prior);
      await history(tx, creditNote, refund);
      const receipts = await tx.paymentVoucher.findMany({ where: {
        type: 'Receipt', status: 'unreconciled', deletedAt: null,
        customerRelationId: refund.customerRelationId, currency: refund.currency,
        invoiceId: null, appliedAmount: null,
      }, orderBy: [{ paymentDate: 'desc' }, { id: 'asc' }], take: 100 });
      const ids = receipts.map((row: any) => row.id);
      const allocations = ids.length ? await tx.invoiceAllocation.findMany({ where: { voucherId: { in: ids } }, select: { voucherId: true } }) : [];
      const consumed = ids.length ? await tx.creditNoteRefundReturn.findMany({ where: { receiptVoucherId: { in: ids } }, select: { receiptVoucherId: true } }) : [];
      const excluded = new Set([...allocations.map((row: any) => row.voucherId), ...consumed.map((row: any) => row.receiptVoucherId)]);
      return { refundId: refund.id, creditNoteId: creditNote.id, customerRelationId: refund.customerRelationId,
        currency: refund.currency, meaning: 'unallocated_receipts_require_bank_fact_match',
        items: receipts.filter((row: any) => !excluded.has(row.id)).map((row: any) => ({
          id: row.id, voucherNumber: row.voucherNumber, type: row.type, status: row.status,
          customerRelationId: row.customerRelationId, currency: row.currency,
          amount: row.amount.toString(), bankFee: row.bankFee == null ? null : row.bankFee.toString(), feeBearer: row.feeBearer ?? null,
          paymentDate: row.paymentDate, paymentMethod: row.paymentMethod, invoiceId: row.invoiceId, appliedAmount: row.appliedAmount,
          paymentReference: typeof row.attachments?.paymentReference === 'string' ? row.attachments.paymentReference : null,
          receivedNet: typeof row.attachments?.receivedNet === 'string' ? row.attachments.receivedNet : null,
          evidenceIds: Array.isArray(row.attachments?.evidenceIds) && row.attachments.evidenceIds.every((value: unknown) => typeof value === 'string') ? row.attachments.evidenceIds : [],
        })) };
    });
  }
  async function record(id: string, input: CashRefundReturnInput, prior: TokenPayload) {
    const requestId = refundRequestId(input?.clientRequestId);
    try { return await transaction(async tx => {
      const { creditNote: note, refund, paymentRequest } = await lockCashRefund(tx, id);
      const actor = await visible(tx, note, prior, true);
      await assertRefundRequestNotRetired(tx, note.id, requestId, 'return', refund.id);
      const requestEnvelope = refundRequestEnvelope('return', input);
      const previous = await tx.creditNoteRefundReturn.findUnique({ where: { creditNoteId_requestId: { creditNoteId: note.id, requestId } } });
      if (previous) {
        if (previous.refundId !== refund.id || previous.actorId !== actor.userId
            || canonicalClaimJson(previous.parameters?.requestEnvelope) !== canonicalClaimJson(requestEnvelope)) refundRefusal('同返款编号的主体、原退款或完整参数不同，不能重放');
        const { account, returned, remaining } = await history(tx, note, refund);
        const receiptVoucher=await tx.paymentVoucher.findUnique({where:{id:previous.receiptVoucherId}});
        if(receiptVoucher)await assertVoucherCashUse(tx,actor,receiptVoucher);
        return { refund, paymentRequest, cashReturn: previous, receiptVoucher,
          settlementEventId: (await tx.creditNoteSettlementEvent.findUnique({ where: { refundReturnId: previous.id } })).id,
          creditNote: note, returnedPrincipalTotal: returned.toString(), remainingReturnable: remaining.toString(), availableToSettle: account.availableToSettle.toString(), replayed: true };
      }
      const command = normalizeCashRefundReturn(input), { account, source, returned, remaining } = await history(tx, note, refund);
      if(!command.companyAccountId||!Number.isSafeInteger(command.expectedAccountRevision))throw new CashRefundError('VALIDATION_FAILED','登记真实返款须选择实际公司账户并核对当前账户版本');
      if (note.status === 'Cancelled' || account.version.version !== command.expectedVersion) refundRefusal('贷项当前有效版本或负债状态已变化，请加载准确版本后核对');
      const amount = new Prisma.Decimal(command.returnedPrincipal), nextOpen = new Prisma.Decimal(note.openAmount).plus(amount);
      if (amount.gt(remaining) || nextOpen.gt(account.total)) throw new CashRefundError('OVER_APPLIED', '返款本金超原实付未返本金或当前有效贷项负债，不能自动恢复余额');
      // All return writers lock the same CN before any actual voucher. Ordinary
      // voucher/allocation writers share the receipt lock + true-FK recheck.
      await tx.$queryRawUnsafe('SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE', refund.paymentVoucherId);
      const originalPayment=await tx.paymentVoucher.findUnique({where:{id:refund.paymentVoucherId}});
      let originalCash:any=null;
      if(originalPayment?.cashEntryId){
        if(command.companyAccountId!==originalPayment.companyAccountId)refundRefusal('实际返款须明确原付款的同一公司账户；跨账户事实不能改写原银行来源');
        originalCash=await assertCashCorrectionCapacity(tx,actor,command.companyAccountId!,originalPayment.cashEntryId,new Prisma.Decimal(command.receivedNet),command.actualDate);
        if(command.expectedAccountRevision!==originalCash.account.revision)refundRefusal('实际返款公司账户版本已变化，请先核对原请求结果');
      }
      const evidence = await readCashReturnProof(tx, refund.id, command.evidenceIds);
      await bytes(evidence);
      const tuple = await tx.creditNoteRefundReturn.findFirst({ where: { customerRelationId: refund.customerRelationId, currency: refund.currency,
        actualDate: command.actualDate, actualMethod: command.actualMethod, bankReference: command.bankReference } });
      if (tuple) refundRefusal('同客户、币种、日期、方式及银行流水已登记返款；真实重号或混合流水须人工核对，不可重复恢复余额');
      let receipt: any;
      if (command.receiptVoucherId) {
        await tx.$queryRawUnsafe('SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE', command.receiptVoucherId);
        receipt = await tx.paymentVoucher.findUnique({ where: { id: command.receiptVoucherId } });
        await assertReturnReceiptNeverAllocated(tx, command.receiptVoucherId);
        if (!receipt || receipt.deletedAt || receipt.type !== 'Receipt' || receipt.status !== 'unreconciled'
            || receipt.customerRelationId !== refund.customerRelationId || receipt.currency !== refund.currency
            || receipt.paymentDate !== command.actualDate || receipt.paymentMethod !== command.actualMethod
            || !new Prisma.Decimal(receipt.amount).equals(amount) || !new Prisma.Decimal(receipt.bankFee).equals(command.bankFee)
            || (receipt.feeBearer ?? null) !== command.feeBearer || receipt.invoiceId || receipt.appliedAmount != null
            || receipt.attachments?.paymentReference !== command.bankReference || receipt.attachments?.receivedNet !== command.receivedNet
            || canonicalClaimJson(receipt.attachments?.evidenceIds) !== canonicalClaimJson(command.evidenceIds)
            || await tx.creditNoteRefundReturn.findUnique({ where: { receiptVoucherId: receipt.id } })
            || (await tx.invoiceAllocation.findMany({ where: { voucherId: receipt.id } })).length) refundRefusal('指定收款与本次客户实际返款事实不一致或已另消费，请保留原水单人工核对');
        await assertVoucherCashUse(tx,actor,receipt);
        if(originalCash){
          const cashEntry=await tx.cashAccountEntry.findUnique({where:{id:receipt.cashEntryId||''}});
          if(receipt.companyAccountId!==originalCash.account.id||!cashEntry||cashEntry.kind!=='Receipt'||!new Prisma.Decimal(cashEntry.amount).equals(command.receivedNet))refundRefusal('原水单的实际账户或银行净额与返款来源不一致');
          const changed=await tx.companyCashAccount.updateMany({where:{id:originalCash.account.id,revision:originalCash.account.revision},data:{revision:originalCash.account.revision+1,updatedAt:BigInt(Date.now())}});
          if(changed.count!==1)refundRefusal('实际返款账户来源已变化');
        }
      } else {
        const result = await createPaymentVoucher({ prisma: options.prisma, tx, actorId: actor.userId, actor,
          cashCorrectionSource:originalCash?{entryId:originalCash.original.id}:undefined,
          input: { type: 'Receipt', voucherCategory: 'customer_reimburse', amount: command.returnedPrincipal, currency: refund.currency,
            paymentDate: command.actualDate, paymentMethod: command.actualMethod, customerRelationId: refund.customerRelationId,
            customerName: note.customerName, bankFee: command.bankFee, feeBearer: command.feeBearer,
            companyAccountId:command.companyAccountId,expectedAccountRevision:command.expectedAccountRevision,actualAccountAmount:command.receivedNet,
            bankReference:command.bankReference,evidenceNote:`真实银行返款私有证明：${command.evidenceIds.join(',')}`,
            attachments: { paymentReference: command.bankReference, receivedNet: command.receivedNet, evidenceIds: command.evidenceIds } } });
        if (!result.ok) throw new Error('实际返款收款未能创建，必须回滚整笔贷项恢复');
        receipt = result.data.voucher;
      }
      receipt = await tx.paymentVoucher.update({ where: { id: receipt.id }, data: { status: 'reconciled', updatedAt: BigInt(Date.now()) } });
      const now = BigInt(Date.now()), returnId = refundId('CNRR'), auditId = refundId('alog'), eventId = refundId('CNSE');
      const parameters = { schemaVersion: 1, command, requestEnvelope, sourceSettlementEventId: source.id,
        sourcePaymentVoucherId: refund.paymentVoucherId, currentVersionId: account.version.id, currentVersionFingerprint: account.version.contentFingerprint };
      const data = { id: returnId, creditNoteId: note.id, refundId: refund.id, customerRelationId: refund.customerRelationId,
        sourceSettlementEventId: source.id, sourcePaymentVoucherId: refund.paymentVoucherId, currentVersionId: account.version.id,
        currentVersionFingerprint: account.version.contentFingerprint, receiptVoucherId: receipt.id,
        returnedPrincipal: amount, receivedNet: new Prisma.Decimal(command.receivedNet), bankFee: new Prisma.Decimal(command.bankFee),
        feeBearer: command.feeBearer, currency: refund.currency, actualDate: command.actualDate, actualMethod: command.actualMethod,
        bankReference: command.bankReference, actorId: actor.userId, requestId, parameters, parametersHash: creditNoteDigest(parameters), auditId, createdAt: now };
      await tx.auditLog.create({ data: { id: auditId, actorId: actor.userId, action: 'CREDIT_NOTE_REFUND_RETURN_RECORDED', targetType: 'CreditNoteRefundReturn',
        targetId: returnId, operationType: 'create', detail: { cashRefundReturn: cashReturnSnapshot(data) } } });
      const cashReturn = await tx.creditNoteRefundReturn.create({ data });
      for (const row of evidence) await tx.creditNoteRefundReturnEvidence.create({ data: { id: refundId('CNRRE'), returnId, evidenceId: row.id } });
      await tx.creditNoteSettlementEvent.create({ data: { id: eventId, creditNoteId: note.id, kind: 'CashRefundReturn', amount, currency: note.currency,
        refundReturnId: returnId, sourceEventId: source.id, paymentVoucherId: receipt.id, actorId: actor.userId, requestId, parameters, parametersHash: data.parametersHash, createdAt: now } });
      const status = creditNoteBalanceStatus(account.total, nextOpen);
      const creditNote = await tx.creditNote.update({ where: { id: note.id }, data: { openAmount: nextOpen, status, updatedAt: now } });
      await tx.auditLog.create({ data: { id: refundId('alog'), actorId: actor.userId, action: 'CREDIT_NOTE_SETTLED', targetType: 'CreditNote', targetId: note.id,
        operationType: 'transition', detail: { creditNoteSettlement: { schemaVersion: 1, eventId, actorId: actor.userId, requestId, parameters,
          parametersHash: data.parametersHash, versionId: account.version.id, contentFingerprint: account.version.contentFingerprint, createdAt: String(now),
          amountAtExecution: account.total.toString(), openBefore: String(note.openAmount), openAfter: nextOpen.toString(), statusAfter: status } } } });
      const verified = await assertClaimCreditNoteAccount(tx, creditNote);
      return { refund, paymentRequest, cashReturn, receiptVoucher: receipt, settlementEventId: eventId, creditNote,
        returnedPrincipalTotal: returned.plus(amount).toString(), remainingReturnable: remaining.minus(amount).toString(), availableToSettle: verified!.availableToSettle.toString(), replayed: false };
    }); } catch (error: any) {
      if (error?.code === 'P2002') refundRefusal('实际返款流水、收款或请求编号已经被消费；真实重号须人工核对，原实付记录保持不变');
      throw error;
    }
  }
  return { list, listReceiptCandidates, record };
}
