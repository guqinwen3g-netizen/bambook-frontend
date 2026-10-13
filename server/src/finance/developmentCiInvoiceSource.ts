import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { DEVELOPMENT_CI_SOURCE, ciConflict, ciHash, ciJson, readDevelopmentCiVersionInTx } from '../development/developmentCiSource';
import { requireFinanceInvoiceAccess } from './financeSourceAccess';
import { assertRegisteredDevelopmentCiMembersInTx } from './developmentCiArMembers';

/** The AR is a registration of one issued version, never a second CI. */
export async function readDevelopmentCiInvoiceSource(prisma: any, invoiceId: string, actor: TokenPayload | null | undefined) {
  return prisma.$transaction(async (tx: any) => {
    const { invoice, access } = await requireFinanceInvoiceAccess(tx, actor, invoiceId);
    if (invoice.sourceType !== DEVELOPMENT_CI_SOURCE || !invoice.sourceId || invoice.type !== 'Receivable' || invoice.status === 'Cancelled')
      ciConflict('本应收不是有效的开发 CI 登记。');
    const version = await tx.documentVersion.findUnique({ where: { id: invoice.sourceId } });
    if (!version) ciConflict('原业务签发版本缺失，不能重建票据。');
    const source = await readDevelopmentCiVersionInTx(tx, version.documentId, actor, { finance: true, version: version.version });
    const snapshot = source.snapshot;
    if (source.document.status !== 'Issued' || !snapshot.issuedAt || source.latestVersion.id !== version.id || source.version.id !== invoice.sourceId
      || invoice.invoiceNumber !== source.document.documentNumber || invoice.currency !== snapshot.currency
      || !new Prisma.Decimal(invoice.amount).eq(snapshot.totalAmount) || invoice.customerRelationId !== snapshot.customerRelationId
      || invoice.customerName !== snapshot.parties.billTo.name || invoice.issueDate !== snapshot.issueDate || (invoice.dueDate ?? null) !== (snapshot.dueDate ?? null))
      ciConflict('财务登记与业务已签发原票不一致，请核对原账。');
    const auditId = `devar_${ciHash([source.document.id, version.id])}`;
    await assertRegisteredDevelopmentCiMembersInTx(tx, snapshot, invoice);
    const audit = await tx.auditLog.findUnique({ where: { id: auditId } });
    const receipt = audit?.detail?.receipt;
    if (audit?.action !== 'register_development_ci_receivable' || audit.targetType !== 'Invoice' || audit.targetId !== invoice.id
      || receipt?.invoiceId !== invoice.id || receipt.versionId !== version.id || receipt.documentId !== source.document.id || receipt.auditId !== auditId)
      ciConflict('开发 CI 财务登记缺少原回执，不能补造原票。');
    await access.finish();
    return { ...source, invoice: ciJson(invoice), fingerprint: ciHash({ documentId: source.document.id, versionId: version.id,
      snapshotFingerprint: snapshot.snapshotFingerprint, invoiceId, invoiceNumber: invoice.invoiceNumber, amount: invoice.amount,
      currency: invoice.currency, customerRelationId: invoice.customerRelationId, issueDate: invoice.issueDate, dueDate: invoice.dueDate }) };
  });
}
