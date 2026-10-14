/**
 * 供应商票据与应付（公司端财务首轮）。
 * 业务口径：供应商开出增值税发票后，财务登记票据并形成应付；付款是另一件事实，
 * 一笔付款可以分到同一供应商、同币种的多张票据，没分完的钱留作“未分配”，不自动配。
 * 采购合同金额不是应付余额；应付余额 = 票据金额 − 已分配付款，不能手改。
 */
import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import { MistCommandError, mistMoneyMinor, type MistState, type MistContext, type MistPayment } from './mistWorkspace';
import { platformBusinessDate } from './mistPlatform';

export type SupplierBillLine = { purchaseId: string; purchaseCode: string; kind: 'material' | 'finished' | 'processing'; amount: number };
export type SupplierBill = {
  id: string; code: string; supplierId: string; supplier: string; invoiceNo: string; invoiceDate: string;
  currency: string; amount: number; taxAmount: number; taxRate: string; lines: SupplierBillLine[];
  terms: string[]; due: string; dueBasis: string; fileIds: string[]; note: string;
  state: 'open' | 'void'; registeredAt: string; registeredBy: string; voided?: { at: string; actor: string; reason: string };
};
export type SupplierPayment = {
  id: string; paymentId: string; code: string; supplierId: string; supplier: string; date: string;
  amount: number; currency: string; reference: string; fileIds: string[]; note: string; createdAt: string; actor: string;
};
export type SupplierPaymentAllocation = { id: string; supplierPaymentId: string; billId: string; amount: number; currency: string; at: string; actor: string };
export type PayablesState = { bills: SupplierBill[]; payments: SupplierPayment[]; allocations: SupplierPaymentAllocation[] };
type AllocationInput = Array<{ billId: string; amount: number }>;
export type PayablesCommand =
  | { type: 'payable.bill.register'; payload: { supplierId: string; invoiceNo: string; invoiceDate: string; currency: string; amount: number; taxAmount: number; taxRate?: string; lines: Array<{ purchaseId: string; amount: number }>; due: string; dueBasis: string; fileIds?: string[]; note?: string } }
  | { type: 'payable.bill.void'; payload: { id: string; reason: string } }
  | { type: 'payable.payment.register'; payload: { supplierId: string; date: string; amount: number; currency: string; reference: string; fileIds?: string[]; note?: string; allocations?: AllocationInput } }
  | { type: 'payable.payment.allocate'; payload: { supplierPaymentId: string; allocations: AllocationInput } };
export const PAYABLE_COMMANDS = ['payable.bill.register', 'payable.bill.void', 'payable.payment.register', 'payable.payment.allocate'] as const;

type Root = MistState & { payables?: PayablesState };
function fail(message: string, code = 'VALIDATION'): never { throw new MistCommandError(code, message); }
const text = (value: unknown, label: string, required = true, max = 2000) => {
  if (value === undefined || value === null || value === '') { if (required) fail(label + '未填写'); return ''; }
  if (typeof value !== 'string' || value.length > max) fail(label + '格式无效');
  const v = value.trim(); if (required && !v) fail(label + '未填写'); return v;
};
const day = (value: unknown, label: string) => { const v = text(value, label); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) fail(label + '格式无效'); return v; };
const minor = (value: unknown, label: string, allowZero = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label + '必须是数字');
  let m: number; try { m = mistMoneyMinor(value); } catch { fail(label + '最多两位小数'); }
  if (m < 0 || (!allowZero && m === 0)) fail(label + (allowZero ? '不能为负数' : '必须大于零'));
  return m;
};
const major = (m: number) => m / 100;
const key = (v: string) => v.trim().toLocaleLowerCase();

export const createPayablesState = (_context?: MistContext, _root?: unknown): PayablesState => ({ bills: [], payments: [], allocations: [] });
export function payablesCommandPermission(command: PayablesCommand) {
  if (command.type === 'payable.bill.register' || command.type === 'payable.bill.void') return MIST_FINANCE_SCOPES.invoice;
  if (command.type === 'payable.payment.register') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.payment.allocate') return MIST_FINANCE_SCOPES.reconcile;
  return fail('未知应付操作');
}
const ledger = (root: Root): PayablesState => { if (!root.payables) root.payables = createPayablesState(); return root.payables; };
const read = (root: Root): PayablesState => root.payables || createPayablesState();

/** 合同金额按 数量 × 单价 原币计算（分），只作为“最多能开多少票”的上限，不是应付余额。 */
export function purchaseContractMinor(p: { quantity: number; price: number }) { return Math.round(p.quantity * p.price * 100); }
export function purchaseInvoicedMinor(root: Root, purchaseId: string, exceptBillId = '') {
  return read(root).bills.filter(b => b.state === 'open' && b.id !== exceptBillId).flatMap(b => b.lines).filter(l => l.purchaseId === purchaseId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0);
}
export function billPaidMinor(root: Root, billId: string) { return read(root).allocations.filter(a => a.billId === billId).reduce((n, a) => n + mistMoneyMinor(a.amount), 0); }
export function billOpenMinor(root: Root, bill: SupplierBill) { return bill.state === 'void' ? 0 : Math.max(0, mistMoneyMinor(bill.amount) - billPaidMinor(root, bill.id)); }
export function supplierPaymentUnallocatedMinor(root: Root, payment: SupplierPayment) { return mistMoneyMinor(payment.amount) - read(root).allocations.filter(a => a.supplierPaymentId === payment.id).reduce((n, a) => n + mistMoneyMinor(a.amount), 0); }

export type PayableBillView = SupplierBill & { paid: number; open: number; overdue: boolean; status: 'unpaid' | 'partial' | 'paid' | 'void' };
export function payableBills(root: Root, today: string): PayableBillView[] {
  return read(root).bills.map(b => {
    const paid = major(billPaidMinor(root, b.id)), open = major(billOpenMinor(root, b));
    const status = b.state === 'void' ? 'void' : open <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    return { ...b, paid, open, overdue: status !== 'void' && open > 0 && b.due < today, status } as PayableBillView;
  }).sort((a, b) => (a.status === 'void' ? 1 : 0) - (b.status === 'void' ? 1 : 0) || a.due.localeCompare(b.due) || a.code.localeCompare(b.code));
}
export type SupplierPaymentView = SupplierPayment & { allocated: number; unallocated: number };
export function supplierPayments(root: Root): SupplierPaymentView[] {
  return read(root).payments.map(p => { const un = supplierPaymentUnallocatedMinor(root, p); return { ...p, allocated: major(mistMoneyMinor(p.amount) - un), unallocated: major(un) }; }).sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code));
}
/** 每个供应商按原币汇总：已登记票据、已付、未付、未分配付款。不同币种不合计。 */
export function supplierPayableSummary(root: Root, today: string) {
  const groups = new Map<string, { supplierId: string; supplier: string; currency: string; billed: number; paid: number; open: number; unallocated: number; bills: number; overdue: number }>();
  const g = (supplierId: string, supplier: string, currency: string) => { const k = JSON.stringify([supplierId, currency]); if (!groups.has(k)) groups.set(k, { supplierId, supplier, currency, billed: 0, paid: 0, open: 0, unallocated: 0, bills: 0, overdue: 0 }); return groups.get(k)!; };
  for (const b of payableBills(root, today)) if (b.status !== 'void') { const r = g(b.supplierId, b.supplier, b.currency); r.billed += mistMoneyMinor(b.amount); r.paid += mistMoneyMinor(b.paid); r.open += mistMoneyMinor(b.open); if (b.open > 0) r.bills++; if (b.overdue) r.overdue++; }
  for (const p of supplierPayments(root)) if (p.unallocated > 0) g(p.supplierId, p.supplier, p.currency).unallocated += mistMoneyMinor(p.unallocated);
  return [...groups.values()].map(r => ({ ...r, billed: major(r.billed), paid: major(r.paid), open: major(r.open), unallocated: major(r.unallocated) })).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.currency.localeCompare(b.currency));
}
/** 已批准合同里还没登记票据的部分 = 财务待登记来源（不是应付）。 */
export function payableSources(root: Root) {
  return (root.fulfillment?.purchases || []).filter(p => p.state === 'approved').map(p => {
    const contract = purchaseContractMinor(p), invoiced = purchaseInvoicedMinor(root, p.id);
    return { purchase: p, contract: major(contract), invoiced: major(invoiced), uninvoiced: major(Math.max(0, contract - invoiced)) };
  });
}
/** 采购 / 加工页回读：这张合同登记了哪些票据、各自付了多少。 */
export function purchasePayableReadback(root: Root, purchaseId: string, today: string) {
  return payableBills(root, today).filter(b => b.lines.some(l => l.purchaseId === purchaseId)).map(b => ({ bill: b, lineAmount: b.lines.filter(l => l.purchaseId === purchaseId).reduce((n, l) => n + l.amount, 0) }));
}

function event(root: Root, c: MistContext, entityId: string, message: string) {
  root.events.unshift({ id: c.id(), entityType: 'payable', entityId, actor: c.actorName, at: c.now, text: message, fileIds: [] });
}
function files(root: Root, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) fail('附件格式无效');
  return [...new Set(value.map(id => { const v = text(id, '附件'); if (!root.files.some(f => f.id === v)) fail('附件不存在，请重新上传'); return v; }))];
}
const nextCode = (prefix: string, existing: Array<{ code: string }>, now: string) => {
  const head = prefix + '-' + now.slice(0, 4) + '-'; let n = existing.filter(r => r.code.startsWith(head)).length + 1;
  while (existing.some(r => r.code === head + String(n).padStart(4, '0'))) n++;
  return head + String(n).padStart(4, '0');
};
function allocate(root: Root, c: MistContext, payment: SupplierPayment, input: unknown) {
  if (input === undefined) return 0;
  if (!Array.isArray(input) || input.length > 100) fail('分配明细格式无效');
  const s = ledger(root); let left = supplierPaymentUnallocatedMinor(root, payment), applied = 0; const seen = new Set<string>();
  for (const row of input as AllocationInput) {
    const billId = text(row?.billId, '应付票据'); if (seen.has(billId)) fail('同一张票据在本次分配中重复出现'); seen.add(billId);
    const bill = s.bills.find(b => b.id === billId) || fail('应付票据不存在', 'NOT_FOUND');
    if (bill.state === 'void') fail(`${bill.code} 已作废，不能分配付款`, 'PRECONDITION');
    if (bill.supplierId !== payment.supplierId) fail(`${bill.code} 不是该供应商的票据，不能分配`);
    if (bill.currency !== payment.currency) fail(`${bill.code} 币种为 ${bill.currency}，与付款币种 ${payment.currency} 不同；当前不做汇率换算`);
    const amount = minor(row.amount, '分配金额');
    if (amount > billOpenMinor(root, bill)) fail(`${bill.code} 分配金额超过未付余额`);
    if (amount > left) fail('分配合计超过这笔付款的未分配金额');
    s.allocations.push({ id: c.id(), supplierPaymentId: payment.id, billId: bill.id, amount: major(amount), currency: payment.currency, at: c.now, actor: c.actorName });
    left -= amount; applied++;
  }
  return applied;
}

export function applyPayablesCommand(root: Root, command: PayablesCommand, c: MistContext): { id: string; applied?: number } {
  const today = platformBusinessDate(c.now), s = ledger(root), p = command.payload as any;
  switch (command.type) {
    case 'payable.bill.register': {
      const supplierId = text(p.supplierId, '供应商'), invoiceNo = text(p.invoiceNo, '供应商发票号', true, 80), invoiceDate = day(p.invoiceDate, '发票日期');
      if (invoiceDate > today) fail('发票日期不能在未来');
      const currency = text(p.currency, '币种', true, 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) fail('币种无效');
      const amount = minor(p.amount, '价税合计'), tax = minor(p.taxAmount ?? 0, '税额', true); if (tax > amount) fail('税额不能大于价税合计');
      if (s.bills.some(b => b.state === 'open' && b.supplierId === supplierId && key(b.invoiceNo) === key(invoiceNo))) fail(`该供应商的发票号 ${invoiceNo} 已登记过，请核对是否重复`, 'CONFLICT');
      if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 50) fail('请至少选择一张来源合同，并写明本票对应金额');
      const purchases = root.fulfillment?.purchases || [], seen = new Set<string>(); let sum = 0; let supplier = '';
      const lines: SupplierBillLine[] = (p.lines as Array<{ purchaseId: string; amount: number }>).map(row => {
        const purchaseId = text(row?.purchaseId, '来源合同'); if (seen.has(purchaseId)) fail('同一张合同在本票中重复出现'); seen.add(purchaseId);
        const po = purchases.find(x => x.id === purchaseId) || fail('来源合同不存在', 'NOT_FOUND');
        if (po.state !== 'approved') fail(`${po.code} 尚未批准，不能登记供应商票据`, 'PRECONDITION');
        if (po.supplierId !== supplierId) fail(`${po.code} 不是该供应商的合同`);
        if (po.currency !== currency) fail(`${po.code} 币种为 ${po.currency}，与票据币种 ${currency} 不同`);
        const m = minor(row.amount, po.code + ' 对应金额');
        if (m + purchaseInvoicedMinor(root, po.id) > purchaseContractMinor(po)) fail(`${po.code} 累计登记票据金额会超过合同金额，请核对或先走合同变更`);
        sum += m; supplier = po.supplier;
        return { purchaseId: po.id, purchaseCode: po.code, kind: po.kind, amount: major(m) };
      });
      if (sum !== amount) fail('各合同对应金额合计必须等于价税合计');
      const due = day(p.due, '到期日'), dueBasis = text(p.dueBasis, '到期日依据', true, 500);
      const terms = [...new Set(lines.map(l => purchases.find(x => x.id === l.purchaseId)!.terms).filter(Boolean))];
      const id = c.id();
      s.bills.push({ id, code: nextCode('AP', s.bills, c.now), supplierId, supplier, invoiceNo, invoiceDate, currency, amount: major(amount), taxAmount: major(tax), taxRate: text(p.taxRate, '税率', false, 40), lines, terms, due, dueBasis, fileIds: files(root, p.fileIds), note: text(p.note, '备注', false), state: 'open', registeredAt: c.now, registeredBy: c.actorName });
      event(root, c, id, `登记供应商票据 ${invoiceNo}（${supplier}）`);
      return { id };
    }
    case 'payable.bill.void': {
      const bill = s.bills.find(b => b.id === text(p.id, '应付票据')) || fail('应付票据不存在', 'NOT_FOUND');
      if (bill.state === 'void') fail('该票据已作废', 'PRECONDITION');
      if (billPaidMinor(root, bill.id) > 0) fail('该票据已有付款分配，不能直接作废；付款冲回尚未接入', 'PRECONDITION');
      bill.state = 'void'; bill.voided = { at: c.now, actor: c.actorName, reason: text(p.reason, '作废原因', true, 500) };
      event(root, c, bill.id, `作废供应商票据 ${bill.invoiceNo}`);
      return { id: bill.id };
    }
    case 'payable.payment.register': {
      const supplierId = text(p.supplierId, '收款供应商'), date = day(p.date, '付款日期'); if (date > today) fail('付款日期不能在未来');
      const currency = text(p.currency, '币种', true, 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) fail('币种无效');
      const amount = minor(p.amount, '付款金额'), reference = text(p.reference, '银行流水号 / 参考号', true, 120);
      const supplier = (root.fulfillment?.purchases || []).find(x => x.supplierId === supplierId)?.supplier || s.bills.find(b => b.supplierId === supplierId)?.supplier || fail('找不到该供应商的合同或票据', 'NOT_FOUND');
      if (s.payments.some(x => x.supplierId === supplierId && key(x.reference) === key(reference))) fail(`流水号 ${reference} 已登记过这家供应商的付款，请核对是否重复`, 'CONFLICT');
      const id = c.id(), paymentId = c.id(), code = nextCode('PAY', root.payments, c.now);
      const record: MistPayment = { id: paymentId, code, date, payee: supplier, amount: major(amount), currency, ref: reference };
      root.payments.push(record);
      const payment: SupplierPayment = { id, paymentId, code, supplierId, supplier, date, amount: major(amount), currency, reference, fileIds: files(root, p.fileIds), note: text(p.note, '备注', false), createdAt: c.now, actor: c.actorName };
      s.payments.push(payment);
      const applied = allocate(root, c, payment, p.allocations);
      event(root, c, id, `登记供应商付款 ${code}（${supplier}）`);
      return { id, applied };
    }
    case 'payable.payment.allocate': {
      const payment = s.payments.find(x => x.id === text(p.supplierPaymentId, '供应商付款')) || fail('供应商付款不存在', 'NOT_FOUND');
      if (!Array.isArray(p.allocations) || !p.allocations.length) fail('请选择要分配的票据');
      const applied = allocate(root, c, payment, p.allocations);
      event(root, c, payment.id, `分配付款 ${payment.code} 到 ${applied} 张票据`);
      return { id: payment.id, applied };
    }
  }
  return fail('未知应付操作');
}
