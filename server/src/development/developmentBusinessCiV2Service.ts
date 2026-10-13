import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { currentExporterProfileSnapshot } from '../templates/docTemplates/financeInvoice';
import { todayLocalKey } from '../shared/localDate';
import { readDevelopmentExpenseSnapshot } from './developmentExpenseSnapshot';
import { developmentCostTotals, readDevelopmentCommercialCostSelectionInTx } from './developmentCiCostSelection';
import { assertDevelopmentBillingCoverageCurrentInTx } from './developmentBillingCoverageService';
import { assertDevelopmentBillingNotClaimedInTx, readDevelopmentCommercialBillingInTx } from './developmentCommercialBillingService';
import { supersedeDevelopmentFinanceTasksByCiInTx } from './developmentFinanceTask';
import { authorizeDevelopmentCiCase, ciConflict, ciHash, ciJson, developmentCiBillingItemIds, developmentCiCaseWhere,
  developmentCiSnapshot, developmentCiV2Ref, readDevelopmentCiVersionInTx } from './developmentCiSource';
import { normalizeDevelopmentCiFields } from './developmentBusinessCiService';

type Context = { prisma: any; actor: TokenPayload | null | undefined };
export type DevelopmentCiV2Command = { action: 'save' | 'issue' | 'cancel'; requestKey: string; billingItemIds: string[];
  documentId?: string; expectedVersion: number; expectedSourceFingerprint: string; fields?: any };
export function normalizeDevelopmentCiBillingIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 500 || value.some(id => typeof id !== 'string' || !id.trim() || id.trim().length > 200))
    throw businessError('INVALID_INPUT', '请选择本案明确的客户收费项。');
  const ids = value.map(id => id.trim()).sort();
  if (new Set(ids).size !== ids.length) throw businessError('INVALID_INPUT', '收费项选择不得重复。');
  return ids;
}

async function assertApproval(tx: any, billing: any) {
  try {
  if (['approval_pending', 'submitted'].includes(billing.developmentWorkflowState)) ciConflict('本收费项仍在原审批或财务核对中，请继续原处理。');
  if (billing.developmentApprovalId || !new Prisma.Decimal(billing.waivedAmount).isZero()) {
    const approval = billing.developmentApprovalId ? await tx.approvalRequest.findUnique({ where: { id: billing.developmentApprovalId } }) : null;
    const audits = approval ? await tx.auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: approval.id } }) : [];
    const payload = approval?.payload ?? {};
    const facts = audits.filter((audit: any) => {
      const fact = audit.detail?.approvalDecisionFact;
      return audit.action === 'approve_business_request' && fact?.schemaVersion === 1 && fact.status === 'approved'
        && fact.actionType === 'development:fee' && fact.targetType === 'BillingItem' && fact.targetId === billing.id
        && audit.actorId === (approval?.bossFinalBypassBy ?? approval?.reviewerId) && fact.decisionActorId === audit.actorId
        && fact.decidedAt === approval?.decidedAt?.toISOString() && fact.contentFingerprint === payload.contentFingerprint;
    });
    const finalInput = facts[0]?.detail?.approvalDecisionFact?.modifiedInput ?? { amount: payload.amount, waivedAmount: payload.waivedAmount };
    const { contentFingerprint, ...approvedProposal } = payload;
    if (!approval || approval.status !== 'approved' || approval.actionType !== 'development:fee' || approval.targetType !== 'BillingItem' || approval.targetId !== billing.id
      || payload.caseId !== billing.sourceId || payload.bearerRelationId !== billing.bearerRelationId || payload.currency !== billing.currency
      || payload.bearerType !== billing.bearerType || payload.expenseReviewId !== billing.developmentExpenseReviewId || ciHash(approvedProposal) !== contentFingerprint
      || facts.length !== 1 || !new Prisma.Decimal(finalInput.amount).eq(billing.amount) || !new Prisma.Decimal(finalInput.waivedAmount).eq(billing.waivedAmount))
      ciConflict('本收费项减免缺少与当前最终金额一致的原批准，请沿原审批处理。');
  }
  if (!new Prisma.Decimal(billing.offsetAmount).isZero()) ciConflict('开发费抵货款尚无可核验冲抵事实，不能自动抵扣。');
  } catch (error: any) {
    if (error?.code === 'CONFLICT') throw error;
    ciConflict('本收费项原批准或金额依据无法核验，请沿原收费审批处理。');
  }
}

async function readSource(tx: any, context: Context, caseId: string, ids: string[], writing: boolean, documentId?: string) {
  const access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, writing ? 'business-write' : 'business-read');
  const expenses = await readDevelopmentExpenseSnapshot(tx, caseId, { commercialSelection: true });
  const billings: any[] = [], chargeLines: any[] = [], allocations: any[] = [], costs: any[] = [], decisions: any[] = [], costSelections: any[] = [];
  let currency: string | undefined;
  for (const id of ids) {
    const billing = await tx.billingItem.findFirst({ where: { id, sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee', deletedAt: null } });
    if (!billing || billing.bearerType !== 'customer' || billing.bearerRelationId !== access.customer.id || billing.status === 'cancelled'
      || billing.invoiceId || billing.status === 'invoiced' || billing.developmentWorkflowState === 'business_ci_issued')
      ciConflict('收费项不属于本案同一客户，或已取消、签发、登记应收。');
    if (!['CNY', 'USD'].includes(billing.currency) || currency && currency !== billing.currency) ciConflict('不同币种客户收费须分别开票。');
    currency = billing.currency;
    await assertApproval(tx, billing);
    if (billing.developmentExpenseReviewId) await assertDevelopmentBillingCoverageCurrentInTx(tx, billing);
    const commercial = await readDevelopmentCommercialBillingInTx(tx, billing, expenses.records);
    await readDevelopmentCommercialCostSelectionInTx(tx, caseId, access.customer.id, billing.id, commercial.costs.map((cost: any) => cost.id), expenses);
    const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: id, releasedAt: null } });
    if (coverage.length !== commercial.costs.length || commercial.costs.some((cost: any) => !coverage.some((line: any) => line.costRecordId === cost.id
      && line.costCurrency === cost.currency && new Prisma.Decimal(line.costAmount).eq(cost.amount)))) ciConflict('明确成本选择与原覆盖记录不一致。');
    billings.push(billing); chargeLines.push(...commercial.lines); costs.push(...commercial.costs);
    costSelections.push(billing.developmentCommercialCostSelection);
    allocations.push({ billingItemId: id, amount: commercial.totalAmount, currency, description: commercial.lines.map((line: any) => line.description).join('；') });
    decisions.push(ciJson({ id, amount: billing.amount, waivedAmount: billing.waivedAmount, offsetAmount: billing.offsetAmount,
      currency, bearerType: billing.bearerType, bearerRelationId: billing.bearerRelationId, workflowVersion: billing.developmentWorkflowVersion,
      commercialFingerprint: commercial.fingerprint, approvalId: billing.developmentApprovalId ?? null }));
  }
  if (new Set(costs.map(cost => cost.id)).size !== costs.length) ciConflict('所选收费项的成本依据重叠，请核对原收费分配。');
  await assertDevelopmentBillingNotClaimedInTx(tx, caseId, ids, documentId);
  costs.sort((a, b) => a.id.localeCompare(b.id));
  const facts = { caseId, caseCode: access.development.code, customerRelationId: access.customer.id, billingItemIds: ids,
    sourceDecisions: decisions, chargeLines, billingAllocations: allocations, costSelections, costs, costTotals: developmentCostTotals(costs), currency };
  return { ...access, billings, facts, fingerprint: ciHash(facts), currency: currency!,
    totalAmount: allocations.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.amount), new Prisma.Decimal(0)).toFixed(4) };
}

async function findExactDocument(tx: any, caseId: string, ids: string[], documentId?: string) {
  if (documentId) {
    const doc = await tx.tradeDocument.findFirst({ where: { id: documentId, ...developmentCiCaseWhere(caseId), deletedAt: null } });
    if (!doc) ciConflict('原票不属于本开发案。');
    return doc;
  }
  const documents = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), status: { in: ['Draft', 'Issued'] }, deletedAt: null }, orderBy: { id: 'asc' } });
  for (const doc of documents) {
    const version = await tx.documentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { version: 'desc' } });
    if (ciHash(developmentCiBillingItemIds(developmentCiSnapshot(version, doc))) === ciHash(ids)) return doc;
  }
  return null;
}

export async function previewDevelopmentCiV2Source(context: Context, caseId: string, rawIds: string[], documentId?: string) {
  const ids = normalizeDevelopmentCiBillingIds(rawIds);
  return context.prisma.$transaction(async (tx: any) => {
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
    const existing = await findExactDocument(tx, caseId, ids, documentId);
    const document = existing ? await readDevelopmentCiVersionInTx(tx, existing.id, context.actor) : null;
    if (document?.document.status === 'Issued' && ciHash(ids) !== ciHash(developmentCiBillingItemIds(document.snapshot)))
      ciConflict('所选收费成员与已签发原票不一致，请继续准确原票。');
    if (document?.document.status === 'Issued') return { caseId, billingItemIds: developmentCiBillingItemIds(document.snapshot),
      billingItemId: ids.length === 1 ? ids[0] : undefined, sourceFingerprint: document.snapshot.sourceFingerprint,
      totalAmount: document.snapshot.totalAmount, currency: document.snapshot.currency, chargeLines: document.snapshot.chargeLines ?? [],
      billingAllocations: document.snapshot.billingAllocations ?? [], costs: document.snapshot.costs, costTotals: document.snapshot.costTotals,
      totals: document.snapshot.costTotals, document, suggestedFields: document.snapshot.fields };
    const current = await readSource(tx, context, caseId, ids, false, existing?.id);
    return { ...current.facts, billingItemId: ids.length === 1 ? ids[0] : undefined, sourceFingerprint: current.fingerprint,
      totalAmount: current.totalAmount, totals: current.facts.costTotals, document,
      suggestedFields: document?.snapshot.fields ?? { issueDate: todayLocalKey(), dueDate: null, paymentTerms: '', note: '开发样品收费',
        billTo: { name: current.customer.englishName || current.customer.name, address: current.customer.contactInfo || '' }, exporter: await currentExporterProfileSnapshot(tx) } };
  });
}

export async function commandDevelopmentCiV2(context: Context, caseId: string, raw: DevelopmentCiV2Command) {
  const ids = normalizeDevelopmentCiBillingIds(raw?.billingItemIds);
  if (!['save', 'issue', 'cancel'].includes(raw.action) || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0
    || typeof raw.requestKey !== 'string' || !raw.requestKey.trim() || raw.requestKey.length > 200 || !/^[a-f0-9]{64}$/.test(raw.expectedSourceFingerprint)
    || raw.documentId != null && (typeof raw.documentId !== 'string' || !raw.documentId.trim() || raw.documentId.trim().length > 200))
    throw businessError('INVALID_INPUT', '开发 CI 操作、版本或原请求无效。');
  const command = { action: raw.action, requestKey: raw.requestKey.trim(), billingItemIds: ids, expectedVersion: raw.expectedVersion,
    expectedSourceFingerprint: raw.expectedSourceFingerprint, documentId: raw.documentId?.trim() ?? null,
    fields: raw.action === 'save' ? normalizeDevelopmentCiFields(raw.fields) : null };
  const commandHash = ciHash(command);
  return context.prisma.$transaction(async (tx: any) => {
    let access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    const auditId = `devci_${ciHash([caseId, access.actor.userId, command.requestKey])}`;
    const previous = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (previous) {
      const receipt = previous.detail?.receipt;
      if (previous.action !== 'development_ci_command' || previous.actorId !== access.actor.userId || receipt?.commandHash !== commandHash
        || receipt.auditId !== auditId || receipt.caseId !== caseId || ciHash(receipt.billingItemIds) !== ciHash(ids)) ciConflict('原请求已用于另一操作或原回执无法核对。');
      const document = await readDevelopmentCiVersionInTx(tx, receipt.documentId, context.actor, { version: receipt.version });
      if (document.version.id !== receipt.versionId) ciConflict('原回执与票据版本不一致。');
      return { receipt, document, replayed: true };
    }
    let document = await findExactDocument(tx, caseId, ids, command.documentId ?? undefined);
    const latest = document ? await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } }) : null;
    const old = latest && document ? developmentCiSnapshot(latest, document) : null;
    const allIds = [...new Set([...ids, ...(old ? developmentCiBillingItemIds(old) : [])])].sort();
    for (const id of allIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
    const hint = raw.action === 'cancel' ? null : await readSource(tx, context, caseId, ids, true, document?.id);
    const costIds = [...new Set<string>([...(hint?.facts.costs ?? []), ...(old?.costs ?? [])].map((cost: any) => cost.id))].sort();
    for (const id of costIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
    for (const id of allIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${id} ORDER BY "id" FOR UPDATE`);
    if (document) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${document.id} FOR UPDATE`);
    access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    const lockedDocument = document ? await tx.tradeDocument.findFirst({ where: { id: document.id, deletedAt: null } }) : null;
    const lockedLatest = document ? await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } }) : null;
    if (document && (ciHash(lockedDocument) !== ciHash(document) || ciHash(lockedLatest) !== ciHash(latest))) ciConflict('原票在取得锁时变化，请刷新。');
    if (document && document.status !== 'Draft' || (latest?.version ?? 0) !== command.expectedVersion) ciConflict('原票已签发、取消或被其他操作更新，请读取当前版本。');
    if (raw.action !== 'save' && (!document || !old)) ciConflict('请先保存并核对 CI 草稿。');
    if (raw.action !== 'save' && ciHash(developmentCiBillingItemIds(old)) !== ciHash(ids)) ciConflict('操作成员与原草稿不一致。');
    const current = raw.action === 'cancel' ? null : await readSource(tx, context, caseId, ids, true, document?.id);
    if (current && (current.fingerprint !== hint!.fingerprint || current.fingerprint !== command.expectedSourceFingerprint)) ciConflict('客户收费或准确成本依据已变化，请刷新后核对。');
    if (raw.action === 'issue' && old.sourceFingerprint !== current!.fingerprint) ciConflict('草稿依据已变化，请保存本次明确资料后再签发。');
    if (raw.action === 'cancel' && old.sourceFingerprint !== command.expectedSourceFingerprint) ciConflict('取消须核对准确原草稿。');
    const now = BigInt(Date.now()), documentId = document?.id ?? `TD_DEVCI_${randomUUID()}`, version = (latest?.version ?? 0) + 1,
      versionId = `DVER_DEVCI_${randomUUID()}`;
    const accepted = raw.action === 'save' ? command.fields : old.fields;
    const draft = raw.action === 'cancel' ? { ...old, command: { requestKey: command.requestKey, commandHash, action: raw.action } }
      : { protocolVersion: 2, sourceKind: 'development', ...current!.facts, billingItemId: ids.length === 1 ? ids[0] : null,
        sourceFingerprint: current!.fingerprint, totalAmount: current!.totalAmount, issueDate: accepted.issueDate, dueDate: accepted.dueDate,
        paymentTerms: accepted.paymentTerms, fields: accepted, parties: { billTo: { relationId: current!.customer.id, ...accepted.billTo } },
        exporterSnapshot: accepted.exporter, lines: current!.facts.chargeLines, command: { requestKey: command.requestKey, commandHash, action: raw.action },
        issuedAt: raw.action === 'issue' ? now.toString() : null, issuedBy: raw.action === 'issue' ? access.actor.userId : null };
    delete draft.snapshotFingerprint;
    const snapshot = { ...draft, snapshotFingerprint: ciHash(draft) };
    const header = { status: raw.action === 'cancel' ? 'Cancelled' : raw.action === 'issue' ? 'Issued' : 'Draft', issueDate: accepted.issueDate,
      issuedBy: raw.action === 'issue' ? access.actor.userId : null, consignee: accepted.billTo.name, consignor: accepted.exporter.nameEn,
      totalAmount: new Prisma.Decimal(snapshot.totalAmount), currency: snapshot.currency, updatedAt: now };
    document = document ? await tx.tradeDocument.update({ where: { id: documentId }, data: { ...header,
      ...(raw.action === 'save' ? { sourceRef: developmentCiV2Ref(caseId, documentId) } : {}) } })
      : await tx.tradeDocument.create({ data: { id: documentId, documentNumber: `DEV-CI-${randomUUID().toUpperCase()}`, type: 'CommercialInvoice',
        domain: 'finance', relationId: access.customer.id, sourceRef: developmentCiV2Ref(caseId, documentId), sourceInvoiceId: null, createdAt: now, ...header } });
    const claims = await tx.developmentCiBillingClaim.findMany({ where: { documentId, releasedAt: null } });
    const removed = claims.filter((claim: any) => raw.action === 'cancel' || !ids.includes(claim.billingItemId));
    if (removed.some((claim: any) => claim.issuedVersionId)) ciConflict('已签发成员不可释放。');
    if (removed.length) await tx.developmentCiBillingClaim.updateMany({ where: { id: { in: removed.map((claim: any) => claim.id) }, releasedAt: null },
      data: { releasedAt: now, releaseReason: raw.action === 'cancel' ? '业务明确取消原 CI 草稿' : '业务明确修改 CI 草稿成员' } });
    if (raw.action !== 'cancel') for (const id of ids) if (!claims.some((claim: any) => claim.billingItemId === id))
      await tx.developmentCiBillingClaim.create({ data: { id: randomUUID(), billingItemId: id, documentId, createdAt: now } });
    await tx.documentVersion.create({ data: { id: versionId, documentId, version, content: ciJson({ developmentCommercialInvoiceSnapshot: snapshot }),
      changeReason: raw.action === 'cancel' ? '业务明确取消开发 CI 草稿' : raw.action === 'issue' ? '业务签发多项开发收费 CI' : '业务保存多项开发收费 CI 草稿', changedBy: access.actor.userId, createdAt: now } });
    if (raw.action === 'issue') {
      await tx.developmentCiBillingClaim.updateMany({ where: { documentId, releasedAt: null }, data: { issuedVersionId: versionId } });
      for (const billing of current!.billings) {
        await tx.billingItem.update({ where: { id: billing.id }, data: { status: 'confirmed', confirmedAt: now, confirmedBy: access.actor.userId,
          developmentWorkflowState: 'business_ci_issued', developmentAssigneeId: null, updatedAt: now } });
        await supersedeDevelopmentFinanceTasksByCiInTx(tx, { caseId, billingItemId: billing.id, documentId, versionId,
          requestKey: command.requestKey, actorId: access.actor.userId, issuedAt: now });
      }
    }
    const receipt = { operation: 'development_ci_command', actorId: access.actor.userId, caseId, billingItemIds: ids,
      billingItemId: ids.length === 1 ? ids[0] : null, requestKey: command.requestKey, commandHash, action: raw.action, documentId, version, versionId, auditId };
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    await tx.auditLog.create({ data: { id: auditId, actorId: access.actor.userId, action: 'development_ci_command', targetType: 'TradeDocument', targetId: documentId,
      transactionId: command.requestKey, detail: ciJson({ source: 'development:business-ci', receipt, command }) } });
    return { receipt, document: await readDevelopmentCiVersionInTx(tx, documentId, context.actor, { writing: true }), replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: any) => {
    if (error?.code === 'P2002' || error?.code === 'P2034' || error?.meta?.code === '40001') ciConflict('收费项或草稿刚被另一操作占用，本次未提交，请保留原请求核对。');
    throw error;
  });
}
