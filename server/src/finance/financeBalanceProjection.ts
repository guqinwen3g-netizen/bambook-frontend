import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createFinanceSourceAccess } from './financeSourceAccess';
import { hasScope } from '../auth/permissionService';
import { businessError } from '../shared/errorCodes';

const zero = () => new Prisma.Decimal(0);
const activeInvoice = (row: any) => row.deletedAt == null && ['Issued', 'PartiallyPaid', 'Paid'].includes(row.status);
const activeCash = (row: any) => row.deletedAt == null && !['cancelled', 'void'].includes(row.status);

/** No currency conversion and no allocation of unassigned cash by inference. */
export async function readFinanceBalanceProjection(tx: any, prior: TokenPayload | null | undefined) {
  const access = await createFinanceSourceAccess(tx, prior, []);
  if (!hasScope(access.actor, 'invoices:read') || !hasScope(access.actor, 'vouchers:read'))
    throw businessError('FORBIDDEN', '查看票款余额需要当前票据与收付款读取权限。');
  const invoices: any[] = [], vouchers: any[] = [];
  for (const row of await tx.invoice.findMany({ where: { deletedAt: null, status: { in: ['Issued', 'PartiallyPaid', 'Paid'] } } }))
    if (activeInvoice(row) && await access.invoice(row)) invoices.push(row);
  for (const row of await tx.paymentVoucher.findMany({ where: { deletedAt: null, status: { notIn: ['cancelled', 'void'] } } }))
    if (activeCash(row) && await access.voucher(row)) vouchers.push(row);
  const invoiceIds = invoices.map(row => row.id), voucherIds = vouchers.map(row => row.id);
  const allAllocations = await tx.invoiceAllocation.findMany({ where: { OR: [{ invoiceId: { in: invoiceIds } }, { voucherId: { in: voucherIds } }] } });
  const allocatedVoucherIds = [...new Set<string>(allAllocations.map((row: any) => row.voucherId))];
  const allocatedVouchers = allocatedVoucherIds.length ? await tx.paymentVoucher.findMany({ where: { id: { in: allocatedVoucherIds }, deletedAt: null } }) : [];
  const cashById = new Map<string, any>(allocatedVouchers.filter(activeCash).map((row: any) => [row.id, row]));
  const creditAllocations = invoiceIds.length ? await tx.creditNoteAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } }) : [];
  const currencies = [...new Set<string>([...invoices, ...vouchers].map(row => row.currency))].sort();
  const byCurrency = currencies.map(currency => {
    const side = (type: 'Receivable' | 'Payable') => {
      let total = zero(), paid = zero(), creditApplied = zero(); let count = 0;
      for (const invoice of invoices.filter(row => row.currency === currency && row.type === type)) {
        const amount = new Prisma.Decimal(invoice.amount), sign = amount.isNegative() ? -1 : 1;
        const expectedType = type === 'Receivable' ? sign < 0 ? 'Disbursement' : 'Receipt' : sign < 0 ? 'Receipt' : 'Disbursement';
        let applied = zero(), credits = zero();
        for (const allocation of allAllocations.filter((row: any) => row.invoiceId === invoice.id)) {
          const voucher = cashById.get(allocation.voucherId);
          if (voucher?.currency === currency && voucher.type === expectedType) applied = applied.plus(allocation.appliedAmount);
        }
        for (const allocation of creditAllocations.filter((row: any) => row.invoiceId === invoice.id)) credits = credits.plus(allocation.appliedAmount);
        if (applied.plus(credits).gt(amount.abs())) throw businessError('CONFLICT', '账款实际核销超过原票，无法核实余额。');
        total = total.plus(amount); paid = paid.plus(applied.times(sign)); creditApplied = creditApplied.plus(credits.times(sign)); count++;
      }
      const outstanding = total.minus(paid).minus(creditApplied);
      return { total: total.toFixed(4), paid: paid.toFixed(4), creditApplied: creditApplied.toFixed(4), outstanding: outstanding.toFixed(4), count };
    };
    const cash = (type: 'Receipt' | 'Disbursement') => {
      let total = zero(), allocated = zero();
      for (const voucher of vouchers.filter(row => row.currency === currency && row.type === type)) {
        total = total.plus(voucher.amount);
        for (const row of allAllocations.filter((row: any) => row.voucherId === voucher.id)) allocated = allocated.plus(row.appliedAmount);
      }
      if (allocated.gt(total)) throw businessError('CONFLICT', '现金分配超过实际收付款，无法核实余额。');
      return { total: total.toFixed(4), allocated: allocated.toFixed(4), unallocated: total.minus(allocated).toFixed(4) };
    };
    return { currency, receivable: side('Receivable'), payable: side('Payable'), receipts: cash('Receipt'), disbursements: cash('Disbursement') };
  });
  await access.finish();
  return { currency: byCurrency.length === 1 ? byCurrency[0].currency : null,
    receivable: byCurrency.length === 1 ? byCurrency[0].receivable : null,
    payable: byCurrency.length === 1 ? byCurrency[0].payable : null, byCurrency };
}
