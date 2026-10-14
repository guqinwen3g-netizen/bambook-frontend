/**
 * 供应商票据与应付（公司端财务首轮）。
 * 业务口径：供应商开出增值税发票后，财务登记票据并形成应付；付款是另一件事实，
 * 一笔付款可以分到同一供应商、同币种的多张票据，没分完的钱留作“未分配”，不自动配。
 * 采购合同金额不是应付余额；应付余额 = 票据金额 − 已分配付款，不能手改。
 *
 * 预付款与付款申请（2026-10-15 用户确认 / 授权专业判断）：
 * - 合同付款计划由财务按合同条款登记（本批只接预付款计划），计划不是应付，也不与结算相加；
 * - 所有付款（含预付）先由业务员或财务提交付款申请，经主管审批后，财务按已批准申请登记实付；
 * - 预付款挂在合同上，等待结算确认后抵扣（结算确认与抵扣下一批接入），不能分配到票据；
 * - 付款或分配登记错误由财务直接冲回并写原因：原记录保留，另记反向记录，不删除不改写。
 */
import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import type { MistReviewTask } from './mistReview';
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
  /** 新付款都来自已批准的付款申请；旧记录没有此字段。 */
  requestId?: string; purpose?: 'prepayment' | 'bill'; purchaseId?: string; planId?: string;
};
export type SupplierPaymentAllocation = { id: string; supplierPaymentId: string; billId: string; amount: number; currency: string; at: string; actor: string };
/** 合同预付款计划：财务按合同条款登记触发条件，不是应付，也不代表到期。 */
export type PrepaymentPlan = {
  id: string; code: string; purchaseId: string; purchaseCode: string; supplierId: string; supplier: string; currency: string;
  amount: number; trigger: string; basis: string; due: string; note: string; state: 'active' | 'cancelled';
  registeredAt: string; registeredBy: string; cancelled?: { at: string; actor: string; reason: string };
};
export type PaymentRequestLine = { billId: string; billCode: string; invoiceNo: string; amount: number };
export type PaymentRequest = {
  id: string; code: string; purpose: 'prepayment' | 'bill'; supplierId: string; supplier: string; currency: string; amount: number;
  planId?: string; purchaseId?: string; purchaseCode?: string; lines: PaymentRequestLine[]; reason: string; fileIds: string[];
  requesterId: string; requester: string; submittedAt: string; reviewerIds: string[]; snapshot: Array<{ label: string; value: string }>;
  state: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  decision?: { actorId: string; actor: string; at: string; decision: 'approved' | 'rejected'; note: string };
  cancelled?: { at: string; actor: string; reason: string };
  /** 当前有效实付；冲回后清空，历史保留在 paymentHistory。 */
  supplierPaymentId?: string; paymentHistory: string[];
};
/** 反向记录：冲回付款或冲回分配，原记录保留。 */
export type PayableReversal = { id: string; kind: 'payment' | 'allocation'; targetId: string; parentId?: string; amount: number; currency: string; reason: string; at: string; actor: string };
export type PayablesState = { bills: SupplierBill[]; payments: SupplierPayment[]; allocations: SupplierPaymentAllocation[]; plans?: PrepaymentPlan[]; requests?: PaymentRequest[]; reversals?: PayableReversal[] };
type AllocationInput = Array<{ billId: string; amount: number }>;
export type PayablesCommand =
  | { type: 'payable.bill.register'; payload: { supplierId: string; invoiceNo: string; invoiceDate: string; currency: string; amount: number; taxAmount: number; taxRate?: string; lines: Array<{ purchaseId: string; amount: number }>; due: string; dueBasis: string; fileIds?: string[]; note?: string } }
  | { type: 'payable.bill.void'; payload: { id: string; reason: string } }
  | { type: 'payable.plan.register'; payload: { purchaseId: string; amount: number; trigger: string; basis: string; due?: string; note?: string } }
  | { type: 'payable.plan.cancel'; payload: { id: string; reason: string } }
  | { type: 'payable.request.submit'; payload: { purpose: 'prepayment'; planId: string; amount: number; reason: string; fileIds?: string[] } | { purpose: 'bill'; supplierId: string; currency: string; lines: Array<{ billId: string; amount: number }>; reason: string; fileIds?: string[] } }
  | { type: 'payable.request.decide'; payload: { id: string; decision: 'approved' | 'rejected'; note: string } }
  | { type: 'payable.request.cancel'; payload: { id: string; reason: string } }
  | { type: 'payable.payment.register'; payload: { requestId?: string; supplierId?: string; date: string; amount: number; currency?: string; reference: string; fileIds?: string[]; note?: string; allocations?: AllocationInput } }
  | { type: 'payable.payment.allocate'; payload: { supplierPaymentId: string; allocations: AllocationInput } }
  | { type: 'payable.payment.reverse'; payload: { supplierPaymentId: string; reason: string } }
  | { type: 'payable.allocation.reverse'; payload: { allocationId: string; reason: string } };
export const PAYABLE_COMMANDS = ['payable.bill.register', 'payable.bill.void', 'payable.plan.register', 'payable.plan.cancel', 'payable.request.submit', 'payable.request.decide', 'payable.request.cancel', 'payable.payment.register', 'payable.payment.allocate', 'payable.payment.reverse', 'payable.allocation.reverse'] as const;
/** 岗位矩阵已有：付款申请创建（业务员、财务）与审批（业务主管）。 */
export const PAYMENT_REQUEST_SCOPES = { create: 'finance:payment_request:create', approve: 'finance:payment_request:approve' } as const;

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

export const createPayablesState = (_context?: MistContext, _root?: unknown): PayablesState => ({ bills: [], payments: [], allocations: [], plans: [], requests: [], reversals: [] });
export function payablesCommandPermission(command: PayablesCommand) {
  if (command.type === 'payable.bill.register' || command.type === 'payable.bill.void' || command.type === 'payable.plan.register' || command.type === 'payable.plan.cancel') return MIST_FINANCE_SCOPES.invoice;
  if (command.type === 'payable.request.submit' || command.type === 'payable.request.cancel') return PAYMENT_REQUEST_SCOPES.create;
  if (command.type === 'payable.request.decide') return PAYMENT_REQUEST_SCOPES.approve;
  if (command.type === 'payable.payment.reverse') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.allocation.reverse') return MIST_FINANCE_SCOPES.reconcile;
  if (command.type === 'payable.payment.register') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.payment.allocate') return MIST_FINANCE_SCOPES.reconcile;
  return fail('未知应付操作');
}
/** 登记付款和核销是两个已有权限；一次提交同时办理时必须两项都具备。 */
export function payablesCommandPermissions(command: PayablesCommand): string[] {
  const permissions: string[] = [payablesCommandPermission(command)];
  if (command.type === 'payable.payment.register' && Array.isArray(command.payload.allocations) && command.payload.allocations.length) permissions.push(MIST_FINANCE_SCOPES.reconcile);
  // 冲回付款会连带冲回其分配，始终同时需要核销权。
  if (command.type === 'payable.payment.reverse') permissions.push(MIST_FINANCE_SCOPES.reconcile);
  return permissions;
}
type Full = Required<PayablesState>;
const fill = (s: PayablesState): Full => { s.plans ||= []; s.requests ||= []; s.reversals ||= []; return s as Full; };
const ledger = (root: Root): Full => { if (!root.payables) root.payables = createPayablesState(); return fill(root.payables); };
const read = (root: Root): Full => { const s = root.payables || createPayablesState(); return { ...s, plans: s.plans || [], requests: s.requests || [], reversals: s.reversals || [] }; };
export const paymentReversed = (root: Root, paymentId: string) => read(root).reversals.some(r => r.kind === 'payment' && r.targetId === paymentId);
export const allocationReversed = (root: Root, allocationId: string) => read(root).reversals.some(r => r.kind === 'allocation' && r.targetId === allocationId);
const activeAllocations = (root: Root) => read(root).allocations.filter(a => !allocationReversed(root, a.id));

/** 合同金额按 数量 × 单价 原币计算（分），只作为“最多能开多少票”的上限，不是应付余额。 */
export function purchaseContractMinor(p: { quantity: number; price: number }) { return Math.round(p.quantity * p.price * 100); }
export function purchaseInvoicedMinor(root: Root, purchaseId: string, exceptBillId = '') {
  return read(root).bills.filter(b => b.state === 'open' && b.id !== exceptBillId).flatMap(b => b.lines).filter(l => l.purchaseId === purchaseId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0);
}
export function billPaidMinor(root: Root, billId: string) { return activeAllocations(root).filter(a => a.billId === billId).reduce((n, a) => n + mistMoneyMinor(a.amount), 0); }
export function billOpenMinor(root: Root, bill: SupplierBill) { return bill.state === 'void' ? 0 : Math.max(0, mistMoneyMinor(bill.amount) - billPaidMinor(root, bill.id)); }
/** 未分配 = 可以再分配到票据的钱；已冲回付款和预付款（等结算抵扣）都不算。 */
export function supplierPaymentUnallocatedMinor(root: Root, payment: SupplierPayment) {
  if (paymentReversed(root, payment.id) || payment.purpose === 'prepayment') return 0;
  return mistMoneyMinor(payment.amount) - activeAllocations(root).filter(a => a.supplierPaymentId === payment.id).reduce((n, a) => n + mistMoneyMinor(a.amount), 0);
}
/** 已付且未冲回的预付款，等待结算确认后抵扣。 */
export function prepaymentHeldMinor(root: Root, payment: SupplierPayment) { return payment.purpose === 'prepayment' && !paymentReversed(root, payment.id) ? mistMoneyMinor(payment.amount) : 0; }

export type PayableBillView = SupplierBill & { paid: number; open: number; overdue: boolean; status: 'unpaid' | 'partial' | 'paid' | 'void' };
export function payableBills(root: Root, today: string): PayableBillView[] {
  return read(root).bills.map(b => {
    const paid = major(billPaidMinor(root, b.id)), open = major(billOpenMinor(root, b));
    const status = b.state === 'void' ? 'void' : open <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    return { ...b, paid, open, overdue: status !== 'void' && open > 0 && b.due < today, status } as PayableBillView;
  }).sort((a, b) => (a.status === 'void' ? 1 : 0) - (b.status === 'void' ? 1 : 0) || a.due.localeCompare(b.due) || a.code.localeCompare(b.code));
}
export type SupplierPaymentView = SupplierPayment & { allocated: number; unallocated: number; prepaid: number; reversed?: PayableReversal; requestCode?: string };
export function supplierPayments(root: Root): SupplierPaymentView[] {
  const s = read(root);
  return s.payments.map(p => {
    const un = supplierPaymentUnallocatedMinor(root, p), allocated = activeAllocations(root).filter(a => a.supplierPaymentId === p.id).reduce((n, a) => n + mistMoneyMinor(a.amount), 0);
    return { ...p, allocated: major(allocated), unallocated: major(un), prepaid: major(prepaymentHeldMinor(root, p)), reversed: s.reversals.find(r => r.kind === 'payment' && r.targetId === p.id), requestCode: s.requests.find(r => r.id === p.requestId)?.code };
  }).sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code));
}
/** 每个供应商按原币汇总：已登记票据、已付、未付、未分配付款。不同币种不合计。 */
export function supplierPayableSummary(root: Root, today: string) {
  const groups = new Map<string, { supplierId: string; supplier: string; currency: string; billed: number; paid: number; open: number; unallocated: number; prepaid: number; bills: number; overdue: number }>();
  const g = (supplierId: string, supplier: string, currency: string) => { const k = JSON.stringify([supplierId, currency]); if (!groups.has(k)) groups.set(k, { supplierId, supplier, currency, billed: 0, paid: 0, open: 0, unallocated: 0, prepaid: 0, bills: 0, overdue: 0 }); return groups.get(k)!; };
  for (const b of payableBills(root, today)) if (b.status !== 'void') { const r = g(b.supplierId, b.supplier, b.currency); r.billed += mistMoneyMinor(b.amount); r.paid += mistMoneyMinor(b.paid); r.open += mistMoneyMinor(b.open); if (b.open > 0) r.bills++; if (b.overdue) r.overdue++; }
  for (const p of supplierPayments(root)) { if (p.unallocated > 0) g(p.supplierId, p.supplier, p.currency).unallocated += mistMoneyMinor(p.unallocated); if (p.prepaid > 0) g(p.supplierId, p.supplier, p.currency).prepaid += mistMoneyMinor(p.prepaid); }
  return [...groups.values()].map(r => ({ ...r, billed: major(r.billed), paid: major(r.paid), open: major(r.open), unallocated: major(r.unallocated), prepaid: major(r.prepaid) })).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.currency.localeCompare(b.currency));
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

const LIVE_REQUEST: PaymentRequest['state'][] = ['pending', 'approved', 'paid'];
/** 计划已被付款申请占用的金额（待审批、已批准未付、已付）。 */
export function planRequestedMinor(root: Root, planId: string, exceptRequestId = '') { return read(root).requests.filter(r => r.planId === planId && r.id !== exceptRequestId && LIVE_REQUEST.includes(r.state)).reduce((n, r) => n + mistMoneyMinor(r.amount), 0); }
export function planPaidMinor(root: Root, planId: string) { return read(root).payments.filter(p => p.planId === planId).reduce((n, p) => n + prepaymentHeldMinor(root, p), 0); }
/** 票据已进入付款申请但还没付的金额，避免同一张票被重复申请。 */
export function billRequestedUnpaidMinor(root: Root, billId: string, exceptRequestId = '') { return read(root).requests.filter(r => r.purpose === 'bill' && r.id !== exceptRequestId && (r.state === 'pending' || r.state === 'approved')).flatMap(r => r.lines).filter(l => l.billId === billId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0); }
export type PrepaymentPlanView = PrepaymentPlan & { requested: number; paid: number; available: number };
export function prepaymentPlans(root: Root, purchaseId?: string): PrepaymentPlanView[] {
  return read(root).plans.filter(p => !purchaseId || p.purchaseId === purchaseId).map(p => {
    const requested = planRequestedMinor(root, p.id);
    return { ...p, requested: major(requested), paid: major(planPaidMinor(root, p.id)), available: p.state === 'active' ? major(Math.max(0, mistMoneyMinor(p.amount) - requested)) : 0 };
  }).sort((a, b) => a.purchaseCode.localeCompare(b.purchaseCode) || a.code.localeCompare(b.code));
}
export function paymentRequests(root: Root): PaymentRequest[] {
  const order: Record<PaymentRequest['state'], number> = { pending: 0, approved: 1, rejected: 2, paid: 3, cancelled: 4 };
  return [...read(root).requests].sort((a, b) => order[a.state] - order[b.state] || b.submittedAt.localeCompare(a.submittedAt));
}
/** 采购合同回读：预付款计划、已申请与已付（待结算抵扣）。 */
export function purchasePrepaymentReadback(root: Root, purchaseId: string) {
  const plans = prepaymentPlans(root, purchaseId).filter(p => p.state === 'active');
  return { plans, planned: plans.reduce((n, p) => n + p.amount, 0), paid: plans.reduce((n, p) => n + p.paid, 0) };
}
/** 主管审批收件箱：只给提交时冻结的申请快照和附件。撤回且未决定的申请不再出现。 */
export function getPayableReviews(root: Root): MistReviewTask[] {
  return read(root).requests.filter(r => !(r.state === 'cancelled' && !r.decision)).map(r => ({
    id: 'payment:' + r.id, kind: 'payment' as const, entityId: r.id, title: `${r.code} · ${r.supplier} · ${major(mistMoneyMinor(r.amount)).toFixed(2)} ${r.currency}`,
    requesterId: r.requesterId, reviewerIds: r.reviewerIds, status: r.state === 'pending' ? 'pending' as const : r.decision?.decision === 'rejected' ? 'rejected' as const : 'approved' as const,
    submittedAt: r.submittedAt, requiredPermission: PAYMENT_REQUEST_SCOPES.approve, fileIds: [...r.fileIds], target: { view: 'payment-vouchers', id: r.id }, details: r.snapshot.map(d => ({ ...d })),
  }));
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
      if (billPaidMinor(root, bill.id) > 0) fail('该票据已有付款分配，请先冲回分配或付款并写明原因，再作废', 'PRECONDITION');
      if (billRequestedUnpaidMinor(root, bill.id) > 0) fail('该票据有待审批或已批准未付的付款申请，请先撤回申请', 'PRECONDITION');
      bill.state = 'void'; bill.voided = { at: c.now, actor: c.actorName, reason: text(p.reason, '作废原因', true, 500) };
      event(root, c, bill.id, `作废供应商票据 ${bill.invoiceNo}`);
      return { id: bill.id };
    }
    case 'payable.payment.register': {
      if (p.requestId === undefined || p.requestId === null || p.requestId === '') fail('所有付款须先提交付款申请并经主管批准，再按已批准申请登记实付', 'PRECONDITION');
      const request = s.requests.find(r => r.id === text(p.requestId, '付款申请')) || fail('付款申请不存在', 'NOT_FOUND');
      if (request.state === 'paid') fail(`${request.code} 已登记实付，请勿重复登记`, 'CONFLICT');
      if (request.state !== 'approved') fail(`${request.code} 尚未经主管批准，不能付款`, 'PRECONDITION');
      const date = day(p.date, '付款日期'); if (date > today) fail('付款日期不能在未来');
      if (request.decision && date < platformBusinessDate(request.decision.at)) fail('付款日期不能早于主管批准日期');
      const amount = minor(p.amount, '付款金额');
      if (amount !== mistMoneyMinor(request.amount)) fail('实付金额须与已批准申请一致；金额不同请撤回申请并重新提交审批');
      if (p.currency !== undefined && text(p.currency, '币种', true, 3).toUpperCase() !== request.currency) fail('币种与已批准申请不一致');
      if (p.supplierId !== undefined && text(p.supplierId, '收款供应商') !== request.supplierId) fail('收款供应商与已批准申请不一致');
      const reference = text(p.reference, '银行流水号 / 参考号', true, 120);
      if (s.payments.some(x => x.supplierId === request.supplierId && key(x.reference) === key(reference) && !paymentReversed(root, x.id))) fail(`流水号 ${reference} 已登记过这家供应商的付款，请核对是否重复`, 'CONFLICT');
      const input = Array.isArray(p.allocations) ? p.allocations as AllocationInput : [];
      if (request.purpose === 'prepayment' && input.length) fail('预付款挂在合同上，等结算确认后抵扣，不能分配到票据');
      if (request.purpose === 'bill') {
        const want = new Map(request.lines.map(l => [l.billId, mistMoneyMinor(l.amount)]));
        if (input.length !== want.size || input.some(r => want.get(r?.billId) !== (typeof r?.amount === 'number' ? mistMoneyMinor(r.amount) : NaN))) fail('付款分配须与已批准申请的票据和金额一致');
      }
      const id = c.id(), paymentId = c.id(), code = nextCode('PAY', root.payments, c.now);
      root.payments.push({ id: paymentId, code, date, payee: request.supplier, amount: major(amount), currency: request.currency, ref: reference } as MistPayment);
      const payment: SupplierPayment = { id, paymentId, code, supplierId: request.supplierId, supplier: request.supplier, date, amount: major(amount), currency: request.currency, reference, fileIds: files(root, p.fileIds), note: text(p.note, '备注', false), createdAt: c.now, actor: c.actorName, requestId: request.id, purpose: request.purpose, ...(request.purpose === 'prepayment' ? { purchaseId: request.purchaseId, planId: request.planId } : {}) };
      s.payments.push(payment);
      const applied = request.purpose === 'bill' ? allocate(root, c, payment, input) : 0;
      request.state = 'paid'; request.supplierPaymentId = id; request.paymentHistory.push(id);
      event(root, c, id, `按付款申请 ${request.code} 登记${request.purpose === 'prepayment' ? '预付款' : '供应商付款'} ${code}（${request.supplier}）`);
      return { id, applied };
    }
    case 'payable.plan.register': {
      const po = (root.fulfillment?.purchases || []).find(x => x.id === text(p.purchaseId, '来源合同')) || fail('来源合同不存在', 'NOT_FOUND');
      if (po.state !== 'approved') fail(`${po.code} 尚未批准，不能登记付款计划`, 'PRECONDITION');
      const amount = minor(p.amount, '预付金额'), trigger = text(p.trigger, '付款触发条件', true, 500), basis = text(p.basis, '合同条款依据', true, 500);
      const due = p.due ? day(p.due, '计划付款日') : '';
      const planned = s.plans.filter(x => x.purchaseId === po.id && x.state === 'active').reduce((n, x) => n + mistMoneyMinor(x.amount), 0);
      if (planned + amount > purchaseContractMinor(po)) fail(`${po.code} 预付款计划合计会超过合同金额`);
      const id = c.id(), code = nextCode('PP', s.plans, c.now);
      s.plans.push({ id, code, purchaseId: po.id, purchaseCode: po.code, supplierId: po.supplierId, supplier: po.supplier, currency: po.currency, amount: major(amount), trigger, basis, due, note: text(p.note, '备注', false), state: 'active', registeredAt: c.now, registeredBy: c.actorName });
      event(root, c, id, `登记 ${po.code} 预付款计划 ${code}（${major(amount).toFixed(2)} ${po.currency}）`);
      return { id };
    }
    case 'payable.plan.cancel': {
      const plan = s.plans.find(x => x.id === text(p.id, '预付款计划')) || fail('预付款计划不存在', 'NOT_FOUND');
      if (plan.state !== 'active') fail('该计划已取消', 'PRECONDITION');
      if (planRequestedMinor(root, plan.id) > 0) fail('该计划已有付款申请或已付预付款，请先撤回申请或冲回付款', 'PRECONDITION');
      plan.state = 'cancelled'; plan.cancelled = { at: c.now, actor: c.actorName, reason: text(p.reason, '取消原因', true, 500) };
      event(root, c, plan.id, `取消预付款计划 ${plan.code}`);
      return { id: plan.id };
    }
    case 'payable.request.submit': {
      if (!c.actorId) fail('无法识别申请人', 'FORBIDDEN');
      const reason = text(p.reason, '申请说明', true, 1000), fileIds = files(root, p.fileIds), money = (m: number, cur: string) => major(m).toFixed(2) + ' ' + cur;
      const reviewerIds = [...new Set((c.authority?.paymentReviewerIds || []).filter(id => id !== c.actorId))];
      if (!reviewerIds.length) fail('当前没有可审批付款申请的主管，请联系管理员配置部门主管', 'PRECONDITION');
      const id = c.id(), code = nextCode('PR', s.requests, c.now);
      let request: PaymentRequest;
      if (p.purpose === 'prepayment') {
        const plan = s.plans.find(x => x.id === text(p.planId, '预付款计划')) || fail('预付款计划不存在', 'NOT_FOUND');
        if (plan.state !== 'active') fail(`${plan.code} 已取消，不能申请付款`, 'PRECONDITION');
        const po = (root.fulfillment?.purchases || []).find(x => x.id === plan.purchaseId) || fail('来源合同不存在', 'NOT_FOUND');
        if (po.state !== 'approved') fail(`${po.code} 不在已批准状态，不能申请预付款`, 'PRECONDITION');
        const amount = minor(p.amount, '申请金额'), used = planRequestedMinor(root, plan.id);
        if (used + amount > mistMoneyMinor(plan.amount)) fail(`${plan.code} 剩余可申请 ${money(mistMoneyMinor(plan.amount) - used, plan.currency)}，本次申请超出`);
        const snapshot = [
          { label: '申请类型', value: '合同预付款' }, { label: '供应商', value: plan.supplier },
          { label: '来源合同', value: `${po.code} · ${po.description} · 合同金额 ${money(purchaseContractMinor(po), po.currency)}` },
          { label: '合同付款条件', value: po.terms || '未填写' },
          { label: '预付款计划', value: `${plan.code} · ${money(mistMoneyMinor(plan.amount), plan.currency)} · 触发条件：${plan.trigger}` },
          { label: '计划依据', value: plan.basis + (plan.due ? ` · 计划付款日 ${plan.due}` : '') },
          { label: '本计划此前已申请', value: money(used, plan.currency) },
          { label: '本次申请金额', value: money(amount, plan.currency) }, { label: '申请说明', value: reason }, { label: '申请人', value: c.actorName },
        ];
        request = { id, code, purpose: 'prepayment', supplierId: plan.supplierId, supplier: plan.supplier, currency: plan.currency, amount: major(amount), planId: plan.id, purchaseId: po.id, purchaseCode: po.code, lines: [], reason, fileIds, requesterId: c.actorId, requester: c.actorName, submittedAt: c.now, reviewerIds, snapshot, state: 'pending', paymentHistory: [] };
      } else if (p.purpose === 'bill') {
        const supplierId = text(p.supplierId, '收款供应商'), currency = text(p.currency, '币种', true, 3).toUpperCase();
        if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 50) fail('请至少选择一张要付款的票据');
        const seen = new Set<string>(); let total = 0; let supplier = '';
        const lines: PaymentRequestLine[] = (p.lines as Array<{ billId: string; amount: number }>).map(row => {
          const billId = text(row?.billId, '应付票据'); if (seen.has(billId)) fail('同一张票据在本次申请中重复出现'); seen.add(billId);
          const bill = s.bills.find(b => b.id === billId) || fail('应付票据不存在', 'NOT_FOUND');
          if (bill.state === 'void') fail(`${bill.code} 已作废`, 'PRECONDITION');
          if (bill.supplierId !== supplierId || bill.currency !== currency) fail(`${bill.code} 与本次申请的供应商或币种不同`);
          const m = minor(row.amount, bill.code + ' 申请金额'), left = billOpenMinor(root, bill) - billRequestedUnpaidMinor(root, bill.id);
          if (m > left) fail(`${bill.code} 可申请金额 ${money(Math.max(0, left), currency)}（未付余额扣除其他未付申请），本次申请超出`);
          total += m; supplier = bill.supplier;
          return { billId: bill.id, billCode: bill.code, invoiceNo: bill.invoiceNo, amount: major(m) };
        });
        const snapshot = [
          { label: '申请类型', value: '供应商票据付款' }, { label: '供应商', value: supplier },
          ...lines.map(l => { const b = s.bills.find(x => x.id === l.billId)!; return { label: `${l.billCode} · 发票 ${l.invoiceNo}`, value: `未付 ${money(billOpenMinor(root, b), currency)} · 本次 ${money(mistMoneyMinor(l.amount), currency)} · 到期 ${b.due}（${b.dueBasis}）` }; }),
          { label: '本次申请金额', value: money(total, currency) }, { label: '申请说明', value: reason }, { label: '申请人', value: c.actorName },
        ];
        request = { id, code, purpose: 'bill', supplierId, supplier, currency, amount: major(total), lines, reason, fileIds, requesterId: c.actorId, requester: c.actorName, submittedAt: c.now, reviewerIds, snapshot, state: 'pending', paymentHistory: [] };
      } else return fail('付款申请类型无效');
      s.requests.push(request);
      event(root, c, id, `提交付款申请 ${code}（${request.supplier} · ${money(mistMoneyMinor(request.amount), request.currency)}）`);
      return { id };
    }
    case 'payable.request.decide': {
      const request = s.requests.find(r => r.id === text(p.id, '付款申请')) || fail('付款申请不存在', 'NOT_FOUND');
      if (request.state !== 'pending') fail('付款申请已处理或已撤回', 'CONFLICT');
      if (!['approved', 'rejected'].includes(p.decision)) fail('审批决定无效');
      if (!c.actorId || c.actorId === request.requesterId || !request.reviewerIds.includes(c.actorId) || !(c.authority?.paymentReviewerIds || []).includes(c.actorId)) fail('当前账号不是本次付款申请的有效审批主管', 'FORBIDDEN');
      const note = text(p.note, '审批意见', true, 4000);
      request.state = p.decision; request.decision = { actorId: c.actorId, actor: c.actorName, at: c.now, decision: p.decision, note };
      event(root, c, request.id, `付款申请 ${request.code} ${p.decision === 'approved' ? '已批准' : '已退回'}：${note}`);
      return { id: request.id };
    }
    case 'payable.request.cancel': {
      const request = s.requests.find(r => r.id === text(p.id, '付款申请')) || fail('付款申请不存在', 'NOT_FOUND');
      if (request.state !== 'pending' && request.state !== 'approved') fail(request.state === 'paid' ? '已付款的申请不能撤回；如登记有误请冲回付款' : '该申请已结束', 'PRECONDITION');
      request.state = 'cancelled'; request.cancelled = { at: c.now, actor: c.actorName, reason: text(p.reason, '撤回原因', true, 500) };
      event(root, c, request.id, `撤回付款申请 ${request.code}`);
      return { id: request.id };
    }
    case 'payable.payment.reverse': {
      const payment = s.payments.find(x => x.id === text(p.supplierPaymentId, '供应商付款')) || fail('供应商付款不存在', 'NOT_FOUND');
      if (paymentReversed(root, payment.id)) fail(`${payment.code} 已冲回`, 'PRECONDITION');
      const reason = text(p.reason, '冲回原因', true, 500), rid = c.id();
      for (const a of activeAllocations(root).filter(a => a.supplierPaymentId === payment.id)) s.reversals.push({ id: c.id(), kind: 'allocation', targetId: a.id, parentId: rid, amount: a.amount, currency: a.currency, reason, at: c.now, actor: c.actorName });
      s.reversals.push({ id: rid, kind: 'payment', targetId: payment.id, amount: payment.amount, currency: payment.currency, reason, at: c.now, actor: c.actorName });
      root.payments.push({ id: c.id(), code: nextCode('PAY', root.payments, c.now), date: today, payee: payment.supplier, amount: -payment.amount, currency: payment.currency, ref: `冲回 ${payment.code} · ${reason}` } as MistPayment);
      const request = s.requests.find(r => r.id === payment.requestId && r.supplierPaymentId === payment.id);
      if (request) { request.state = 'approved'; delete request.supplierPaymentId; }
      event(root, c, payment.id, `冲回付款 ${payment.code}：${reason}${request ? `；申请 ${request.code} 回到已批准待付` : ''}`);
      return { id: rid };
    }
    case 'payable.allocation.reverse': {
      const a = s.allocations.find(x => x.id === text(p.allocationId, '付款分配')) || fail('付款分配不存在', 'NOT_FOUND');
      if (allocationReversed(root, a.id)) fail('该分配已冲回', 'PRECONDITION');
      const reason = text(p.reason, '冲回原因', true, 500), rid = c.id();
      s.reversals.push({ id: rid, kind: 'allocation', targetId: a.id, amount: a.amount, currency: a.currency, reason, at: c.now, actor: c.actorName });
      const payment = s.payments.find(x => x.id === a.supplierPaymentId), bill = s.bills.find(b => b.id === a.billId);
      event(root, c, a.supplierPaymentId, `冲回分配 ${payment?.code || ''} → ${bill?.code || ''}：${reason}；金额回到未分配`);
      return { id: rid };
    }
    case 'payable.payment.allocate': {
      const payment = s.payments.find(x => x.id === text(p.supplierPaymentId, '供应商付款')) || fail('供应商付款不存在', 'NOT_FOUND');
      if (paymentReversed(root, payment.id)) fail(`${payment.code} 已冲回，不能再分配`, 'PRECONDITION');
      if (payment.purpose === 'prepayment') fail('预付款等结算确认后抵扣，不能直接分配到票据', 'PRECONDITION');
      if (!Array.isArray(p.allocations) || !p.allocations.length) fail('请选择要分配的票据');
      const applied = allocate(root, c, payment, p.allocations);
      event(root, c, payment.id, `分配付款 ${payment.code} 到 ${applied} 张票据`);
      return { id: payment.id, applied };
    }
  }
  return fail('未知应付操作');
}
