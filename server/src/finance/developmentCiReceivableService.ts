import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createInvoice } from './invoiceMutationService';
import { assertRegisteredDevelopmentCiMembersInTx, developmentCiInvoiceLines } from './developmentCiArMembers';
import { DEVELOPMENT_CI_PREFIX, DEVELOPMENT_CI_SOURCE, authorizeDevelopmentCiCase, ciConflict, ciHash, ciInvisible, ciJson,
  currentCiActor, developmentCiBillingItemIds, developmentCiBillingAllocations, developmentCiCaseWhere, readDevelopmentCiVersionInTx } from '../development/developmentCiSource';

export async function listPendingDevelopmentCiReceivables(prisma: any, prior: TokenPayload | null | undefined) {
  await currentCiActor(prisma, prior, ['invoices:read']);
  const documents = await prisma.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(), status: 'Issued', deletedAt: null }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }] });
  const items: any[] = [];
  for (const document of documents) {
    try {
      const row = await prisma.$transaction(async (tx: any) => {
        const source = await readDevelopmentCiVersionInTx(tx, document.id, prior, { finance: true });
        const registered = await tx.invoice.findFirst({ where: { sourceType: DEVELOPMENT_CI_SOURCE, sourceId: source.version.id } });
        if (registered) { await assertRegisteredDevelopmentCiMembersInTx(tx, source.snapshot, registered, source.document); return null; }
        return { documentId: document.id, documentNumber: source.document.documentNumber, versionId: source.version.id,
          version: source.version.version, caseId: source.snapshot.caseId, caseCode: source.snapshot.caseCode,
          billingItemId: source.snapshot.billingItemId, billingItemIds: developmentCiBillingItemIds(source.snapshot), customerRelationId: source.snapshot.customerRelationId,
          customerName: source.snapshot.parties.billTo.name, amount: source.snapshot.totalAmount, currency: source.snapshot.currency,
          issueDate: source.snapshot.issueDate, dueDate: source.snapshot.dueDate, sourceKind: 'development' };
      });
      if (row) items.push(row);
    } catch (error: any) { if (!['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) throw error; }
  }
  await currentCiActor(prisma, prior, ['invoices:read']);
  return { items, total: items.length };
}

/** Issued business data is immutable. Finance creates the AR fact and an original acknowledgement, never another CI. */
export async function registerDevelopmentCiReceivable(prisma: any, prior: TokenPayload | null | undefined, documentId: string,
  input: { requestKey: string; expectedVersionId: string }) {
  if (!input || typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 200
    || typeof input.expectedVersionId !== 'string' || !input.expectedVersionId) ciConflict('请保留待登记原票版本与请求编号。');
  const effects: Array<() => Promise<void>> = [];
  const result = await prisma.$transaction(async (tx: any) => {
    const initial = await readDevelopmentCiVersionInTx(tx, documentId, prior, { finance: true, writing: true });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${initial.snapshot.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    for (const id of developmentCiBillingItemIds(initial.snapshot).sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${id} FOR UPDATE`);
    for (const id of [...initial.snapshot.costs].map((cost: any) => cost.id).sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
    for (const id of developmentCiBillingItemIds(initial.snapshot).sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${id} ORDER BY "id" FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${documentId} FOR UPDATE`);
    const source = await readDevelopmentCiVersionInTx(tx, documentId, prior, { finance: true, writing: true });
    if (source.document.status !== 'Issued' || !source.snapshot.issuedAt || source.version.id !== source.latestVersion.id
      || input.expectedVersionId !== source.version.id) ciConflict('只能登记待办中已签发的准确开发 CI 版本，请刷新原票。');
    const auditId = `devar_${ciHash([documentId, source.version.id])}`;
    const existing = await tx.invoice.findFirst({ where: { sourceType: DEVELOPMENT_CI_SOURCE, sourceId: source.version.id } });
    const priorAudit = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (existing) {
      const receipt = priorAudit?.detail?.receipt;
      if (!receipt || priorAudit.action !== 'register_development_ci_receivable' || receipt.invoiceId !== existing.id
        || receipt.documentId !== documentId || receipt.versionId !== source.version.id || receipt.auditId !== auditId
        || priorAudit.targetType !== 'Invoice' || priorAudit.targetId !== existing.id || priorAudit.actorId !== receipt.actorId
        || receipt.caseId !== source.snapshot.caseId || receipt.commandHash !== ciHash({ documentId, versionId: source.version.id, requestKey: receipt.requestKey })
        || source.snapshot.protocolVersion === 2 && ciHash(receipt.billingItemIds) !== ciHash(developmentCiBillingItemIds(source.snapshot))
        || existing.deletedAt != null || existing.status === 'Cancelled' || existing.invoiceNumber !== source.document.documentNumber
        || existing.currency !== source.snapshot.currency || !new Prisma.Decimal(existing.amount).eq(source.snapshot.totalAmount)
        || existing.customerRelationId !== source.snapshot.customerRelationId) ciConflict('原登记记录或回执不一致，请核清原财务记录，不得重复登记。');
      await assertRegisteredDevelopmentCiMembersInTx(tx, source.snapshot, existing, source.document);
      return { invoice: ciJson(existing), receipt, replayed: true };
    }
    if (priorAudit) ciConflict('原登记回执存在但应收事实缺失，请核对原账。');
    const snapshot = source.snapshot;
    const billings: any[] = [];
    for (const id of developmentCiBillingItemIds(snapshot)) {
      const billing = await tx.billingItem.findFirst({ where: { id, sourceType: 'DevelopmentCase', sourceId: snapshot.caseId, deletedAt: null } });
      const allocation = developmentCiBillingAllocations(snapshot).find((row: any) => row.billingItemId === id);
      if (!billing || billing.invoiceId || billing.status !== 'confirmed' || billing.developmentWorkflowState !== 'business_ci_issued'
        || billing.bearerType !== 'customer' || billing.bearerRelationId !== snapshot.customerRelationId || billing.currency !== snapshot.currency
        || !new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount).eq(allocation.amount)) ciConflict('开发收费与已签发原票不一致，不能重复登记。');
      billings.push(billing);
    }
    const mutation = await createInvoice({ prisma, actor: source.actor, actorId: source.actor.userId,
      transaction: { tx, deferAfterCommit: work => effects.push(work) },
      developmentCiRegistration: { documentId, versionId: source.version.id, snapshotFingerprint: snapshot.snapshotFingerprint },
      input: { invoiceNumber: source.document.documentNumber, type: 'Receivable', status: 'Issued', amount: snapshot.totalAmount,
        currency: snapshot.currency, issueDate: snapshot.issueDate, dueDate: snapshot.dueDate,
        customerRelationId: snapshot.customerRelationId, customerName: snapshot.parties.billTo.name,
        sourceType: DEVELOPMENT_CI_SOURCE, sourceId: source.version.id, notes: `开发案 ${snapshot.caseCode} · ${snapshot.fields.note}`,
        invoiceLines: developmentCiInvoiceLines(snapshot) } });
    if (!mutation.ok || !mutation.data?.invoice) ciConflict(mutation.error?.message || '开发 CI 应收登记未成功。');
    const invoice = mutation.data.invoice;
    for (const billing of billings) await tx.billingItem.update({ where: { id: billing.id }, data: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber,
      status: 'invoiced', updatedAt: BigInt(Date.now()) } });
    await assertRegisteredDevelopmentCiMembersInTx(tx, snapshot, invoice, source.document);
    const receipt = { operation: 'register_development_ci_receivable', actorId: source.actor.userId, requestKey: input.requestKey,
      documentId, versionId: source.version.id, invoiceId: invoice.id, auditId, caseId: snapshot.caseId, billingItemIds: developmentCiBillingItemIds(snapshot),
      commandHash: ciHash({ documentId, versionId: source.version.id, requestKey: input.requestKey }) };
    await authorizeDevelopmentCiCase(tx, prior, snapshot.caseId, 'finance-write');
    await tx.auditLog.create({ data: { id: auditId, actorId: source.actor.userId, action: 'register_development_ci_receivable',
      targetType: 'Invoice', targetId: invoice.id, transactionId: input.requestKey,
      detail: ciJson({ source: 'finance:development-ci-registration', receipt }) } });
    return { invoice: ciJson(invoice), receipt, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: any) => {
    if (error?.code === 'P2034' || error?.code === 'P2010' && error?.meta?.code === '40001')
      ciConflict('开发 CI 或收费成员刚被另一操作更新，本次登记未提交，请保留原请求核对。');
    throw error;
  });
  for (const work of effects) { try { await work(); } catch { /* committed financial fact is authoritative */ } }
  return result;
}
