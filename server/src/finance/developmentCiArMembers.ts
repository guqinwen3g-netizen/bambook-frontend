import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { ciConflict, ciHash, developmentCiBillingAllocations, developmentCiBillingItemIds } from '../development/developmentCiSource';

export const developmentCiInvoiceLines = (snapshot: any) => developmentCiBillingAllocations(snapshot).map((row: any) => ({
  sourceType: 'BillingItem', sourceId: row.billingItemId, amount: row.amount, currency: row.currency, description: row.description,
}));

/** Generic/legacy producers must keep their development BI facts and the complete line total. */
export function assertDevelopmentBillingInvoiceFacts(invoice: any, billings: any[], lines: any[]) {
  const development = billings.filter(row => row.sourceType === 'DevelopmentCase');
  if (!development.length) return;
  const reject = () => { throw businessError('HANDOFF_CONFLICT', '开发收费的原净额、币种、客户及发票明细合计必须与票头一致，请从原收费处理。'); };
  try {
    for (const billing of development) {
      const net = new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
      const ownLines = lines.filter(line => line.sourceType === 'BillingItem' && line.sourceId === billing.id);
      const anchored = invoice.sourceType === 'BillingItem' && invoice.sourceId === billing.id;
      if (!net.gt(0) || billing.deletedAt != null || !['confirmed', 'invoiced'].includes(billing.status) || billing.bearerType !== 'customer'
        || invoice.type !== 'Receivable' || invoice.customerRelationId !== billing.bearerRelationId || invoice.currency !== billing.currency
        || billing.invoiceId && invoice.id && billing.invoiceId !== invoice.id
        || anchored && !net.eq(invoice.amount)
        || (!anchored || ownLines.length) && (ownLines.length !== 1 || ownLines[0].currency !== billing.currency || !net.eq(ownLines[0].amount))) reject();
    }
    if (lines.length && (lines.some(line => (line.currency || 'CNY') !== invoice.currency)
      || !lines.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount ?? 0), new Prisma.Decimal(0)).eq(invoice.amount))) reject();
  } catch (error: any) {
    if (error?.code === 'HANDOFF_CONFLICT') throw error;
    reject();
  }
}
export function assertDevelopmentCiInvoiceLineSet(snapshot: any, lines: any[]) {
  if (!Array.isArray(lines)) ciConflict('原票应收成员明细缺失。');
  const fact = (row: any) => ({ sourceType: row.sourceType, sourceId: row.sourceId,
    amount: new Prisma.Decimal(row.amount).toFixed(4), currency: row.currency, description: row.description ?? null });
  try {
    const expected = developmentCiInvoiceLines(snapshot).map(fact).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const actual = lines.map(fact).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    if (ciHash(actual) !== ciHash(expected)) ciConflict('应收收费成员、净额或说明与已签发原票不一致。');
  } catch (error: any) {
    if (error?.code === 'CONFLICT') throw error;
    ciConflict('原票应收成员明细无效。');
  }
}
export async function assertRegisteredDevelopmentCiMembersInTx(tx: any, snapshot: any, invoice: any, document?: any) {
  if (invoice.type !== 'Receivable' || invoice.deletedAt != null || ['Draft', 'Cancelled'].includes(invoice.status)
    || invoice.currency !== snapshot.currency || !new Prisma.Decimal(invoice.amount).eq(snapshot.totalAmount) || invoice.customerRelationId !== snapshot.customerRelationId
    || invoice.customerName !== snapshot.parties.billTo.name || invoice.issueDate !== snapshot.issueDate || (invoice.dueDate ?? null) !== (snapshot.dueDate ?? null)
    || invoice.orderId != null || document && invoice.invoiceNumber !== document.documentNumber)
    ciConflict('原应收票头与签发开发 CI 不一致，请核对原账。');
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
  assertDevelopmentCiInvoiceLineSet(snapshot, lines);
  for (const id of developmentCiBillingItemIds(snapshot)) {
    const billing = await tx.billingItem.findFirst({ where: { id, sourceType: 'DevelopmentCase', sourceId: snapshot.caseId, deletedAt: null } });
    const allocation = developmentCiBillingAllocations(snapshot).find((row: any) => row.billingItemId === id);
    if (!billing || billing.invoiceId !== invoice.id || billing.invoiceNumber !== invoice.invoiceNumber || billing.status !== 'invoiced'
      || billing.developmentWorkflowState !== 'business_ci_issued' || billing.bearerType !== 'customer' || billing.bearerRelationId !== snapshot.customerRelationId
      || billing.currency !== allocation.currency || !new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount).eq(allocation.amount))
      ciConflict('原票应收与收费成员回填不一致，请核对原账。');
  }
}
