import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { sumAppliedAmount } from '../finance/allocationService';
import { DEVELOPMENT_CI_SOURCE, authorizeDevelopmentCiCase, ciConflict, ciJson, developmentCiBillingItemIds, developmentCiCaseWhere, readDevelopmentCiVersionInTx } from './developmentCiSource';
import { assertRegisteredDevelopmentCiMembersInTx } from '../finance/developmentCiArMembers';

/** Source-scoped readback: no voucher allocations outside this case are disclosed. */
export async function readDevelopmentFinanceProjection(prisma: any, caseId: string, actor: TokenPayload | null | undefined) {
  const view = await prisma.$transaction(async (tx: any) => {
    const access = await authorizeDevelopmentCiCase(tx, actor, caseId, 'business-read');
    const docs = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), deletedAt: null }, orderBy: { createdAt: 'desc' } });
    const items: any[] = [];
    for (const doc of docs) {
      const source = await readDevelopmentCiVersionInTx(tx, doc.id, actor);
      if (source.snapshot.caseId !== caseId) ciConflict('票据与当前开发案不一致。');
      const invoice = await tx.invoice.findFirst({ where: { sourceType: DEVELOPMENT_CI_SOURCE, sourceId: source.version.id } });
      if (invoice?.deletedAt != null) ciConflict('原票财务登记已删除，请核清原账。');
      if (invoice && (invoice.type !== 'Receivable' || invoice.currency !== source.snapshot.currency
        || invoice.customerRelationId !== source.snapshot.customerRelationId || invoice.invoiceNumber !== source.document.documentNumber
        || !new Prisma.Decimal(invoice.amount).eq(source.snapshot.totalAmount))) ciConflict('财务登记与业务原票不一致，请核清原账。');
      if (invoice) await assertRegisteredDevelopmentCiMembersInTx(tx, source.snapshot, invoice);
      const applied = invoice ? await sumAppliedAmount(tx, invoice.id) : null;
      const allocations = invoice ? await tx.invoiceAllocation.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: 'asc' } }) : [];
      const receipts = [];
      for (const allocation of allocations) {
        const voucher = await tx.paymentVoucher.findFirst({ where: { id: allocation.voucherId, deletedAt: null },
          select: { id: true, voucherNumber: true, type: true, currency: true, paymentDate: true } });
        if (!voucher || voucher.type !== 'Receipt' || voucher.currency !== source.snapshot.currency) ciConflict('实际收款分配来源缺失或与票据方向不一致。');
        receipts.push({ id: allocation.id, appliedAmount: String(allocation.appliedAmount), appliedDate: allocation.appliedDate, voucher });
      }
      items.push({ documentId: doc.id, documentNumber: doc.documentNumber, versionId: source.version.id, version: source.version.version,
        status: doc.status, billingItemId: source.snapshot.billingItemId, billingItemIds: developmentCiBillingItemIds(source.snapshot), currency: source.snapshot.currency,
        amount: source.snapshot.totalAmount, issueDate: source.snapshot.issueDate, dueDate: source.snapshot.dueDate,
        customerName: source.snapshot.parties.billTo.name, snapshot: source.snapshot,
        registrationState: !invoice ? (doc.status === 'Issued' ? 'pending_registration' : doc.status === 'Cancelled' ? 'cancelled' : 'draft') : 'registered',
        invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, amount: String(invoice.amount),
          appliedAmount: applied!.toFixed(4), openAmount: new Prisma.Decimal(invoice.amount).abs().minus(applied!).toFixed(4), settlementDate: invoice.settlementDate } : null,
        receipts });
    }
    // Historical links stay explicit, never silently reclassified as a new business CI.
    const legacyBillings = await tx.billingItem.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: caseId, deletedAt: null,
      invoiceId: { not: null }, OR: [{ developmentWorkflowState: null }, { developmentWorkflowState: { not: 'business_ci_issued' } }] }, orderBy: { createdAt: 'desc' } });
    const legacy = [];
    for (const billing of legacyBillings) {
      const invoice = await tx.invoice.findFirst({ where: { id: billing.invoiceId, deletedAt: null } });
      if (!invoice || invoice.sourceType !== 'BillingItem' || invoice.sourceId !== billing.id
        || invoice.customerRelationId !== access.customer.id) ciConflict('历史收费发票关联缺失或不属于本案，请核对原账。');
      const applied = await sumAppliedAmount(tx, invoice.id);
      legacy.push({ billingItemId: billing.id, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status,
        amount: String(invoice.amount), currency: invoice.currency, appliedAmount: applied.toFixed(4), openAmount: new Prisma.Decimal(invoice.amount).abs().minus(applied).toFixed(4) });
    }
    await authorizeDevelopmentCiCase(tx, actor, caseId, 'business-read');
    return ciJson({ caseId, customerRelationId: access.customer.id, items, legacy });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const current = await authorizeDevelopmentCiCase(prisma, actor, caseId, 'business-read');
  if (view.customerRelationId !== current.customer.id) ciConflict('开发案客户在读取账款时变化，请重新读取。');
  return view;
}
