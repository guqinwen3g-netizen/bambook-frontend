import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { ClaimResult } from './claimCaseService';
import { canonicalClaimJson, ClaimTransactionError, claimRefusal, lockClaimRows, readClaimApprovedFact } from './claimApprovalFact';
import { assertCashRefundSettlement, cashRefundReservedAmount } from './claimCashRefundFact';
import { assertCashRefundReturnSettlement } from './claimCashRefundReturnFact';

export const creditNoteDigest = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export function creditNoteEffectiveAmount(note: any): Prisma.Decimal {
  if (note.logicalClaimCaseId && note.currentAmount == null) claimRefusal('共案退款账户缺少当前金额投影，请人工对账');
  return new Prisma.Decimal(note.currentAmount ?? note.amount);
}
export function creditNoteBalanceStatus(amount: any, open: any): string {
  const total = new Prisma.Decimal(amount), remaining = new Prisma.Decimal(open);
  return remaining.lte(0) ? 'Closed' : remaining.lt(total) ? 'PartiallyApplied' : 'Open';
}
function lineSnapshot(line: any) {
  return { id: line.id, claimDispositionId: line.claimDispositionId, approvalRequestId: line.approvalRequestId,
    decisionAuditId: line.decisionAuditId, contentFingerprint: line.contentFingerprint, amount: String(line.amount), currency: line.currency };
}
function documentSnapshot(note: any, lines: any[], amount: any) {
  return { schemaVersion: 1, creditNoteId: note.id, creditNoteNumber: note.creditNoteNumber, claimCaseId: note.claimCaseId,
    customerRelationId: note.customerRelationId ?? null, customerName: note.customerName ?? null,
    sourceInvoiceId: note.sourceInvoiceId ?? null, issueDate: note.issueDate, reason: note.reason ?? null, notes: note.notes ?? null,
    currency: note.currency, amount: String(amount),
    lines: lines.map(lineSnapshot).sort((a, b) => a.id.localeCompare(b.id)) };
}
export async function lockCreditNoteForSettlement(tx: any, noteId: string) {
  const hint = await tx.creditNote.findUnique({ where: { id: noteId } });
  if (!hint || hint.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '退款单不存在' });
  if (hint.claimCaseId) {
    await tx.$queryRawUnsafe('SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', hint.claimCaseId);
    const claimCase = await tx.claimCase.findUnique({ where: { id: hint.claimCaseId } });
    if (!claimCase || claimCase.deletedAt) claimRefusal('退款账户缺少真实案件来源');
    // All same-case writers acquire the case first. Lock the actual source
    // dispositions and approvals before the account, matching execution.
    const lines = await tx.claimCreditNoteLine.findMany({ where: { creditNoteId: noteId } });
    for (const line of [...lines].sort((a: any, b: any) => a.claimDispositionId.localeCompare(b.claimDispositionId))) {
      const source = await lockClaimRows(tx, line.claimDispositionId);
      const fact = await readClaimApprovedFact(tx, source.disposition, source.claimCase);
      if (source.claimCase.id !== hint.claimCaseId || source.disposition.creditNoteId !== noteId
          || source.disposition.status !== 'Executed' || line.approvalRequestId !== fact.approval.id
          || line.decisionAuditId !== fact.decisionAuditId || line.contentFingerprint !== fact.contentFingerprint
          || line.currency !== source.disposition.currency || !new Prisma.Decimal(line.amount).equals(source.disposition.amount)) claimRefusal('共案退款明细与真实执行和批准来源不一致');
    }
  }
  await tx.$queryRawUnsafe('SELECT id FROM "CreditNote" WHERE id = $1 FOR UPDATE', noteId);
  const note = await tx.creditNote.findUnique({ where: { id: noteId } });
  if (!note || note.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '退款单不存在' });
  if ((note.claimCaseId ?? null) !== (hint.claimCaseId ?? null)) claimRefusal('取得退款账户锁前来源已变化');
  return note;
}

/** A settlement event is an immutable financial fact only with its matching
 * mandatory server actor audit. A net allocation row is never enough. */
export async function assertCreditNoteSettlementEvent(tx: any, note: any, event: any) {
  const isReturn = event.kind === 'CashRefundReturn';
  if (isReturn) await assertCashRefundReturnSettlement(tx, note, event);
  else if (event.kind === 'CashRefund') await assertCashRefundSettlement(tx, note, event);
  else if (event.kind !== 'InvoiceOffset' || !event.invoiceId || event.refundId || event.refundReturnId || event.paymentVoucherId) claimRefusal('退款结算种类或真实出口不准确');
  const parameters = event.kind === 'CashRefund' || isReturn ? event.parameters : { appliedAmount: String(event.amount), toInvoiceId: event.invoiceId, refund: false };
  if (event.creditNoteId !== note.id || (!isReturn && event.sourceEventId) || !event.actorId
      || event.currency !== note.currency || new Prisma.Decimal(event.amount).lte(0)
      || canonicalClaimJson(event.parameters) !== canonicalClaimJson(parameters)
      || event.parametersHash !== creditNoteDigest(parameters)) claimRefusal('退款核销事件缺少完整真实抵扣来源');
  const audits = await tx.auditLog.findMany({ where: { targetType: 'CreditNote', targetId: note.id, action: 'CREDIT_NOTE_SETTLED' } });
  const matches = audits.filter((row: any) => row.detail?.creditNoteSettlement?.eventId === event.id);
  const fact = matches[0]?.detail?.creditNoteSettlement;
  if (matches.length !== 1 || matches[0].actorId !== event.actorId || fact?.schemaVersion !== 1 || fact.actorId !== event.actorId
      || fact.requestId !== (event.requestId ?? null) || fact.parametersHash !== event.parametersHash
      || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(parameters)
      || fact.createdAt !== String(event.createdAt)
      || !(isReturn ? new Prisma.Decimal(fact.openBefore).plus(event.amount) : new Prisma.Decimal(fact.openBefore).minus(event.amount)).equals(fact.openAfter)
      || new Prisma.Decimal(fact.openAfter).gt(fact.amountAtExecution)
      || new Prisma.Decimal(fact.openAfter).lt(0) || fact.statusAfter !== creditNoteBalanceStatus(fact.amountAtExecution, fact.openAfter)) claimRefusal('退款核销事件缺少准确的主体、参数及必需审计');
  if (note.logicalClaimCaseId) {
    const version = fact.versionId && await tx.creditNoteDocumentVersion.findUnique({ where: { id: fact.versionId } });
    if (!version || version.creditNoteId !== note.id || !new Prisma.Decimal(version.amount).equals(fact.amountAtExecution)
        || version.contentFingerprint !== fact.contentFingerprint
        || version.contentFingerprint !== creditNoteDigest(version.linesSnapshot)) claimRefusal('退款核销审计缺少准确的单据版本来源');
  }
  return fact;
}

async function assertDocumentHistory(tx: any, note: any, lines: any[]) {
  const versions = await tx.creditNoteDocumentVersion.findMany({ where: { creditNoteId: note.id }, orderBy: { version: 'asc' } });
  versions.sort((a: any, b: any) => a.version - b.version);
  const audits = await tx.auditLog.findMany({ where: { targetType: 'CreditNote', targetId: note.id, action: 'CLAIM_CREDIT_NOTE_VERSION_CREATED' } });
  let previous: any = null;
  for (const [i, version] of versions.entries()) {
    const snapshotLines = version.linesSnapshot?.lines;
    if (version.version !== i + 1 || (version.previousVersionId ?? null) !== (previous?.id ?? null)
        || version.currency !== note.currency || !Array.isArray(snapshotLines) || !snapshotLines.length
        || new Set(snapshotLines.map((line: any) => line.id)).size !== snapshotLines.length
        || snapshotLines.some((line: any) => !lines.some((actual: any) => canonicalClaimJson(lineSnapshot(actual)) === canonicalClaimJson(line)))) claimRefusal('退款文档历史缺少准确且连续的批准明细');
    const selected = lines.filter((line: any) => snapshotLines.some((snapshot: any) => snapshot.id === line.id));
    const amount = selected.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount), new Prisma.Decimal(0));
    if (!amount.equals(version.amount) || version.contentFingerprint !== creditNoteDigest(version.linesSnapshot)
        || canonicalClaimJson(version.linesSnapshot) !== canonicalClaimJson(documentSnapshot(note, selected, amount))) claimRefusal('退款正式文档历史内容已损坏，不能用当前账户覆盖旧文档');
    const creation = audits.filter((row: any) => row.detail?.claimCreditNote?.versionId === version.id);
    const additions = selected.filter((line: any) => !previous?.linesSnapshot.lines.some((prior: any) => prior.id === line.id));
    const added = additions[0];
    if (additions.length !== 1 || creation.length !== 1 || creation[0].actorId !== version.createdBy
        || creation[0].detail.claimCreditNote.schemaVersion !== 1
        || creation[0].detail.claimCreditNote.documentFingerprint !== version.contentFingerprint
        || creation[0].detail.claimCreditNote.currentAmount !== amount.toString()
        || creation[0].detail.claimCreditNote.claimCaseId !== note.claimCaseId
        || creation[0].detail.claimCreditNote.claimDispositionId !== added.claimDispositionId
        || creation[0].detail.claimCreditNote.approvalRequestId !== added.approvalRequestId
        || creation[0].detail.claimCreditNote.decisionAuditId !== added.decisionAuditId
        || creation[0].detail.claimCreditNote.contentFingerprint !== added.contentFingerprint) claimRefusal('退款文档版本缺少必需的创建审计');
    if (previous && (snapshotLines.length <= previous.linesSnapshot.lines.length
        || previous.linesSnapshot.lines.some((line: any) => !snapshotLines.some((current: any) => canonicalClaimJson(line) === canonicalClaimJson(current))))) claimRefusal('退款新版本覆盖或删除了旧版本明细');
    if (Boolean(version.issuedAt) !== Boolean(version.issuedBy)) claimRefusal('退款发行主体和时间不完整');
    if (version.issuedAt) {
      const issuedAudits = await tx.auditLog.findMany({ where: { targetType: 'CreditNote', targetId: note.id, action: 'CLAIM_CREDIT_NOTE_ISSUED' } });
      const issued = issuedAudits.filter((row: any) => row.detail?.claimCreditNoteIssue?.versionId === version.id);
      const fact = issued[0]?.detail?.claimCreditNoteIssue;
      if (issued.length !== 1 || issued[0].actorId !== version.issuedBy || fact?.schemaVersion !== 1 || fact.actorId !== version.issuedBy
          || fact.contentFingerprint !== version.contentFingerprint || fact.issuedAt !== String(version.issuedAt)
          || !fact.requestId || fact.parametersHash !== creditNoteDigest({ expectedVersion: version.version })
          || canonicalClaimJson(fact.parameters) !== canonicalClaimJson({ expectedVersion: version.version })) claimRefusal('已发行正式文档缺少准确的发行事实');
    }
    previous = version;
  }
  if (!versions.length || !new Prisma.Decimal(versions[0].amount).equals(note.amount) || previous.id !== note.currentVersionId) claimRefusal('当前退款文档不是准确的最新版本');
  return versions;
}

/** Complete account + immutable document + net invoice projection must agree.
 * Historical incomplete case CNs are not silently promoted to new managed accounts.
 */
export async function assertClaimCreditNoteAccount(tx: any, note: any) {
  if (!note.claimCaseId) return null;
  const siblings = await tx.creditNote.findMany({ where: { claimCaseId: note.claimCaseId } });
  if (siblings.length !== 1 || siblings[0].id !== note.id || note.logicalClaimCaseId !== note.claimCaseId
      || note.deletedAt || !note.currentVersionId || note.currentAmount == null) claimRefusal('案件退款单存在多张或缺少完整历史明细，请人工对账后续办；不能自动汇合旧单');
  const lines = await tx.claimCreditNoteLine.findMany({ where: { creditNoteId: note.id } });
  const claimCase = await tx.claimCase.findUnique({ where: { id: note.claimCaseId } });
  const executed = await tx.claimDisposition.findMany({ where: { claimCaseId: note.claimCaseId, kind: { in: ['Allowance', 'ReturnRefund'] }, status: 'Executed', deletedAt: null } });
  if (!claimCase || claimCase.customerRelationId !== note.customerRelationId || (claimCase.customerName ?? null) !== note.customerName
      || (claimCase.sourceInvoiceId ?? null) !== note.sourceInvoiceId || claimCase.creditCurrency !== note.currency
      || claimCase.totalCreditAmount == null || !new Prisma.Decimal(claimCase.totalCreditAmount).equals(note.currentAmount)
      || executed.length !== lines.length || executed.some((d: any) => d.creditNoteId !== note.id || lines.filter((line: any) => line.claimDispositionId === d.id).length !== 1)) claimRefusal('共案退款来源、客户或案件汇总与实际执行明细不一致');
  if (!lines.length || lines.some((line: any) => line.currency !== note.currency)) claimRefusal('共案退款账户缺少同币种批准明细');
  if (new Set(lines.map((line: any) => line.claimDispositionId)).size !== lines.length || lines.some((line: any) => !new Prisma.Decimal(line.amount).isPositive())) claimRefusal('退款明细重复或金额非法');
  await assertDocumentHistory(tx, note, lines);
  const total = lines.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount), new Prisma.Decimal(0));
  if (!total.equals(note.currentAmount)) claimRefusal('共案退款当前金额与明细合计不一致');
  const version = await tx.creditNoteDocumentVersion.findUnique({ where: { id: note.currentVersionId } });
  const snapshot = documentSnapshot(note, lines, total);
  if (!version || version.creditNoteId !== note.id || version.currency !== note.currency || !new Prisma.Decimal(version.amount).equals(total)
      || version.contentFingerprint !== creditNoteDigest(version.linesSnapshot)
      || canonicalClaimJson(version.linesSnapshot) !== canonicalClaimJson(snapshot)) claimRefusal('当前正式文档版本与服务端退款明细不一致');
  const events = await tx.creditNoteSettlementEvent.findMany({ where: { creditNoteId: note.id } });
  const byInvoice = new Map<string, Prisma.Decimal>();
  let applied = new Prisma.Decimal(0);
  for (const event of events) {
    await assertCreditNoteSettlementEvent(tx, note, event);
    applied = event.kind === 'CashRefundReturn' ? applied.minus(event.amount) : applied.plus(event.amount);
    if (event.kind === 'InvoiceOffset') byInvoice.set(event.invoiceId, (byInvoice.get(event.invoiceId) ?? new Prisma.Decimal(0)).plus(event.amount));
  }
  const returns = await tx.creditNoteRefundReturn.findMany({ where: { creditNoteId: note.id } });
  const returnEvents = events.filter((event: any) => event.kind === 'CashRefundReturn');
  if (returns.length !== returnEvents.length || returns.some((row: any) => returnEvents.filter((event: any) => event.refundReturnId === row.id).length !== 1)) claimRefusal('真实返款与余额恢复事件不完整，不可从孤立收款恢复余额');
  const allocations = await tx.creditNoteAllocation.findMany({ where: { creditNoteId: note.id } });
  if (allocations.length !== byInvoice.size || allocations.some((allocation: any) => !byInvoice.get(allocation.invoiceId)?.equals(allocation.appliedAmount))) claimRefusal('退款抵扣净投影与不可变事件不一致，请人工对账');
  const open = total.minus(applied);
  if (applied.lt(0) || open.lt(0) || open.gt(total) || !open.equals(note.openAmount) || (note.status !== 'Cancelled' && note.status !== creditNoteBalanceStatus(total, open))) claimRefusal('退款未结余额或状态与真实核销事件不一致');
  const reserved = await cashRefundReservedAmount(tx, note.id);
  if (reserved.gt(open)) claimRefusal('客户退款预留超过真实未结余额，请核对原结算事实');
  return { lines, version, events, total, open, reserved, availableToSettle: open.minus(reserved) };
}

/** Caller already locked case/disposition/approval. The producer is the existing
 * creditNoteService; no alternate raw header creation path is introduced here.
 */
export async function appendClaimCreditNoteInTx(tx: any, context: { disposition: any; claimCase: any; fact: any },
  actorId: string, requestId: string | null, createNote: () => Promise<any>) {
  const { disposition: d, claimCase, fact } = context;
  const existing = await tx.creditNote.findMany({ where: { claimCaseId: claimCase.id } });
  if (existing.length > 1) claimRefusal('该案件已有多张旧退款单，须先人工对账，不能自动选择或合并');
  let note: any = existing[0];
  if (note) {
    note = await lockCreditNoteForSettlement(tx, note.id);
    await assertClaimCreditNoteAccount(tx, note);
    if (note.status === 'Cancelled' || note.currency !== d.currency || note.customerRelationId !== (claimCase.customerRelationId ?? null)
        || note.customerName !== (claimCase.customerName ?? null) || note.sourceInvoiceId !== (claimCase.sourceInvoiceId ?? null)) claimRefusal('共案退款客户、币种或账户状态不一致，不能追加或隐式换汇');
  } else {
    note = await createNote();
    note = await tx.creditNote.update({ where: { id: note.id }, data: { logicalClaimCaseId: claimCase.id, currentAmount: new Prisma.Decimal(d.amount) } });
  }
  const duplicate = await tx.claimCreditNoteLine.findUnique({ where: { claimDispositionId: d.id } });
  if (duplicate) claimRefusal('该处置已计入退款账户，不可重复增加金额');
  await tx.claimCreditNoteLine.create({ data: { id: newId('CNL'), creditNoteId: note.id, claimDispositionId: d.id,
    approvalRequestId: fact.approval.id, decisionAuditId: fact.decisionAuditId, contentFingerprint: fact.contentFingerprint,
    amount: new Prisma.Decimal(d.amount), currency: d.currency, createdAt: BigInt(Date.now()) } });
  const lines = await tx.claimCreditNoteLine.findMany({ where: { creditNoteId: note.id } });
  const amount = lines.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount), new Prisma.Decimal(0));
  const versions = await tx.creditNoteDocumentVersion.findMany({ where: { creditNoteId: note.id } });
  versions.sort((a: any, b: any) => a.version - b.version);
  if (versions.some((version: any, i: number) => version.version !== i + 1)) claimRefusal('正式文档版本历史损坏，不能覆盖续号');
  const snapshot = documentSnapshot(note, lines, amount);
  const version = await tx.creditNoteDocumentVersion.create({ data: { id: newId('CNV'), creditNoteId: note.id, version: versions.length + 1,
    previousVersionId: note.currentVersionId ?? null, linesSnapshot: snapshot, amount, currency: note.currency,
    contentFingerprint: creditNoteDigest(snapshot), createdBy: actorId, createdAt: BigInt(Date.now()), requestId,
    reason: `新增已批准处置 ${d.id}` } });
  const open = existing.length ? new Prisma.Decimal(note.openAmount).plus(d.amount) : amount;
  const updated = await tx.creditNote.update({ where: { id: note.id }, data: { currentAmount: amount, currentVersionId: version.id,
    openAmount: open, status: creditNoteBalanceStatus(amount, open), updatedAt: BigInt(Date.now()) } });
  await tx.auditLog.create({ data: { id: newId('alog'), actorId, action: 'CLAIM_CREDIT_NOTE_VERSION_CREATED', targetType: 'CreditNote', targetId: note.id,
    operationType: 'create', detail: { source: 'claim', claimCreditNote: { schemaVersion: 1, claimCaseId: claimCase.id,
      claimDispositionId: d.id, approvalRequestId: fact.approval.id, decisionAuditId: fact.decisionAuditId, contentFingerprint: fact.contentFingerprint,
      versionId: version.id, documentFingerprint: version.contentFingerprint, currentAmount: amount.toString(), openAmount: open.toString() } } } });
  return { ...updated, currentVersion: version };
}

export async function getClaimCreditNote(prisma: PrismaClient, caseId: string): Promise<ClaimResult<any>> {
  try { return await prisma.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe('SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', caseId);
    const claimCase = await tx.claimCase.findUnique({ where: { id: caseId } });
    if (!claimCase || claimCase.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '售后案件不存在' });
    const notes = await tx.creditNote.findMany({ where: { claimCaseId: caseId } });
    if (!notes.length) return { ok: true, data: { creditNote: null, currentVersion: null, versions: [] } };
    if (notes.length !== 1) claimRefusal('案件已有多张退款单，请人工对账，不能自动选择其中一张');
    const note = await lockCreditNoteForSettlement(tx, notes[0].id);
    const account = await assertClaimCreditNoteAccount(tx, note);
    return { ok: true, data: { creditNote: note, currentVersion: account!.version,
      reservedAmount: account!.reserved.toString(), availableToSettle: account!.availableToSettle.toString(),
      versions: await tx.creditNoteDocumentVersion.findMany({ where: { creditNoteId: note.id }, orderBy: { version: 'asc' } }) } };
  }); } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
export async function getCreditNoteVersions(prisma: PrismaClient, noteId: string, options: { versionId?: string } = {}): Promise<ClaimResult<any>> {
  try { return await prisma.$transaction(async (tx: any) => {
    const note = await lockCreditNoteForSettlement(tx, noteId); const account = await assertClaimCreditNoteAccount(tx, note);
    const versions = await tx.creditNoteDocumentVersion.findMany({ where: { creditNoteId: noteId }, orderBy: { version: 'asc' } });
    const printVersion = options.versionId ? versions.find((version: any) => version.id === options.versionId) : null;
    if (options.versionId && (!printVersion || !printVersion.issuedAt)) claimRefusal('正式打印须指定本单据已发行的准确 versionId，不可使用草稿或当前账户替换旧文档');
    return { ok: true, data: { creditNote: note, currentVersionId: note.currentVersionId ?? null, versions, printVersion,
      reservedAmount: account?.reserved.toString() ?? '0', availableToSettle: (account?.availableToSettle ?? new Prisma.Decimal(note.openAmount)).toString() } };
  }); } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
export async function issueClaimCreditNoteVersion(prisma: PrismaClient, noteId: string,
  input: { clientRequestId: string; expectedVersion: number }, actorId: string): Promise<ClaimResult<any>> {
  try {
    if (!input || Object.keys(input).some(key => !['clientRequestId', 'expectedVersion'].includes(key))
        || typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 200
        || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message: '发行须提供稳定请求标识及当前准确版本号' });
    return await prisma.$transaction(async (tx: any) => {
      const note = await lockCreditNoteForSettlement(tx, noteId);
      const account = await assertClaimCreditNoteAccount(tx, note);
      if (!account || note.status === 'Cancelled') claimRefusal('仅完整共案退款文档可发行，旧单据请先人工对账');
      const parameters = { expectedVersion: input.expectedVersion };
      const rows = await tx.auditLog.findMany({ where: { targetType: 'CreditNote', targetId: noteId, action: 'CLAIM_CREDIT_NOTE_ISSUED' } });
      const matches = rows.filter((row: any) => row.detail?.claimCreditNoteIssue?.requestId === input.clientRequestId);
      if (matches.length) {
        const fact = matches[0].detail.claimCreditNoteIssue;
        const version = await tx.creditNoteDocumentVersion.findUnique({ where: { id: fact.versionId } });
        if (matches.length !== 1 || fact?.schemaVersion !== 1 || matches[0].actorId !== actorId || fact.actorId !== actorId || fact.parametersHash !== creditNoteDigest(parameters)
            || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(parameters) || !version || version.creditNoteId !== noteId
            || version.contentFingerprint !== fact.contentFingerprint || version.issuedBy !== actorId || String(version.issuedAt) !== fact.issuedAt) claimRefusal('同发行请求的主体、版本或参数不同，不能重放');
        return { ok: true, data: { creditNote: note, version, issuedEventId: matches[0].id, replayed: true } };
      }
      const version = account.version;
      if (version.version !== input.expectedVersion || version.issuedAt) claimRefusal('退款正式文档版本已变化或已经发行，请核对原版本及请求标识');
      const issuedAt = BigInt(Date.now());
      const issued = await tx.creditNoteDocumentVersion.update({ where: { id: version.id }, data: { issuedAt, issuedBy: actorId } });
      const audit = await tx.auditLog.create({ data: { id: newId('alog'), actorId, action: 'CLAIM_CREDIT_NOTE_ISSUED', targetType: 'CreditNote', targetId: noteId,
        operationType: 'transition', detail: { source: 'claim', claimCreditNoteIssue: { schemaVersion: 1, actorId, requestId: input.clientRequestId,
          parameters, parametersHash: creditNoteDigest(parameters), versionId: version.id, contentFingerprint: version.contentFingerprint, issuedAt: String(issuedAt) } } } });
      return { ok: true, data: { creditNote: note, version: issued, issuedEventId: audit.id, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
