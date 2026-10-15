/**
 * 供应商票据与应付（公司端财务首轮）。
 * 业务口径：供应商开出增值税发票后，财务登记票据并形成应付；付款是另一件事实，
 * 一笔付款可以分到同一供应商、同币种的多张票据，没分完的钱留作“未分配”，不自动配。
 * 采购合同金额不是应付余额；应付余额 = 票据金额 − 已分配付款，不能手改。
 *
 * 预付款与付款申请（2026-10-15 用户确认 / 授权专业判断）：
 * - 合同付款计划由财务按合同条款登记（本批只接预付款计划），计划不是应付，也不与结算相加；
 * - 所有付款（含预付）先由业务员或财务提交付款申请，经主管审批后，财务按已批准申请登记实付；
 * - 预付款挂在合同上，等待结算确认后抵扣，不能分配到票据；
 * - 付款或分配登记错误由财务直接冲回并写原因：原记录保留，另记反向记录，不删除不改写。
 *
 * 结算与抵扣（决策总账 8.4.1 采用口径）：
 * - 业务员依据实际收货记录提交结算（拒收数量不计入），财务复核确认后才成为已确认结算；
 * - 预付抵扣建议额 = 合同已付预付 × 本次结算数量 ÷ 合同数量；最后一次结算抵扣剩余全部预付；
 *   财务可调整，但须写原因。争议和未确认扣款单列，不自动抵减；
 * - 发票到后关联已确认结算，结算里的预付抵扣按票额比例计入该票，不形成第二笔应付；
 * - 进度款 / 尾款计划只记录合同付款安排，不直接付款；付款仍按票据申请。
 *
 * 应付收尾（2026-10-15 专业判断，记入决策总账 8.4.1）：
 * - 发票先于结算到达：票据可先登记为“待关联结算”，不形成可付应付、不能申请付款；结算确认后再关联；
 * - 售后索赔中工厂同意“从货款中扣”的金额，由财务按票据登记扣款（DD-），减少该票未付；扣满即落实追偿；
 * - 短交最终结算后剩余的预付，由财务登记供应商退款或转到同一供应商的其他合同（PM-），可冲回。
 */
import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import type { MistReviewTask } from './mistReview';
import { MistCommandError, mistMoneyMinor, type MistState, type MistContext, type MistPayment } from './mistWorkspace';
import { platformBusinessDate } from './mistPlatform';

/** awaitingSettlement：发票先于结算到达，暂挂待关联已确认结算；暂挂期间不形成可付应付。 */
export type SupplierBillLine = { purchaseId: string; purchaseCode: string; kind: 'material' | 'finished' | 'processing'; amount: number; settlementId?: string; settlementCode?: string; awaitingSettlement?: boolean; linkedAt?: string; linkedBy?: string };
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
  requestId?: string; purpose?: 'prepayment' | 'bill' | 'settlement'; purchaseId?: string; planId?: string;
  /** 按结算不等票付款时的来源结算。 */ settlementId?: string;
  /** 系统上线前已付、无付款申请的历史补登；不走审批，留操作人。 */ backfill?: boolean;
  /** 旧付款（审批规则前登记、无申请）事后对应到付款计划。 */ planLinked?: { at: string; actor: string; note: string };
};
export type SupplierPaymentAllocation = { id: string; supplierPaymentId: string; billId: string; amount: number; currency: string; at: string; actor: string };
/** 合同预付款计划：财务按合同条款登记触发条件，不是应付，也不代表到期。 */
export type PaymentPlanStage = 'prepayment' | 'progress' | 'final';
export type PrepaymentPlan = {
  /** 旧记录没有 stage，视为预付款。 */
  stage?: PaymentPlanStage;
  id: string; code: string; purchaseId: string; purchaseCode: string; supplierId: string; supplier: string; currency: string;
  amount: number; trigger: string; basis: string; due: string; note: string; state: 'active' | 'cancelled';
  registeredAt: string; registeredBy: string; cancelled?: { at: string; actor: string; reason: string };
};
export type PaymentRequestLine = { billId: string; billCode: string; invoiceNo: string; amount: number };
export type PaymentRequest = {
  id: string; code: string; purpose: 'prepayment' | 'bill' | 'settlement'; supplierId: string; supplier: string; currency: string; amount: number;
  planId?: string; purchaseId?: string; purchaseCode?: string; settlementId?: string; settlementCode?: string; lines: PaymentRequestLine[]; reason: string; fileIds: string[];
  requesterId: string; requester: string; submittedAt: string; reviewerIds: string[]; snapshot: Array<{ label: string; value: string }>;
  state: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  decision?: { actorId: string; actor: string; at: string; decision: 'approved' | 'rejected'; note: string };
  cancelled?: { at: string; actor: string; reason: string };
  /** 当前有效实付；冲回后清空，历史保留在 paymentHistory。 */
  supplierPaymentId?: string; paymentHistory: string[];
};
/** 结算争议 / 未确认扣款：单列记录，不自动抵减。 */
export type SettlementDispute = { description: string; amount: number };
/** 供应商结算：业务员按实际收货提交，财务复核确认；确认时决定预付抵扣。 */
export type SupplierSettlement = {
  id: string; code: string; purchaseId: string; purchaseCode: string; supplierId: string; supplier: string; currency: string;
  unit: string; price: number; receiptIds: string[]; quantity: number; rejected: number; amount: number; final: boolean;
  disputes: SettlementDispute[]; note: string; fileIds: string[];
  state: 'pending' | 'confirmed' | 'returned' | 'cancelled' | 'reversed';
  submitterId: string; submittedBy: string; submittedAt: string;
  confirmation?: { actorId: string; actor: string; at: string; suggestedPrepayment: number; prepaymentApplied: number; adjustReason: string; note: string };
  returned?: { at: string; actor: string; reason: string }; cancelled?: { at: string; actor: string; reason: string }; reversed?: { at: string; actor: string; reason: string };
};
/** 工厂索赔扣款：按售后追偿中工厂同意“从货款中扣”的金额，从指定票据的未付中扣减。冲回保留原记录。 */
export type SupplierDeduction = {
  id: string; code: string; supplierId: string; supplier: string; currency: string; amount: number;
  claimId: string; claimCode: string; recoveryId: string; billId: string; billCode: string; reference: string; note: string;
  at: string; actor: string; reversed?: { at: string; actor: string; reason: string };
};
/** 剩余预付处理：短交最终结算后剩余的预付，登记供应商退款或转到同一供应商的其他合同。冲回保留原记录。 */
export type PrepaymentMove = {
  id: string; code: string; kind: 'refund' | 'transfer'; purchaseId: string; purchaseCode: string; targetPurchaseId?: string; targetPurchaseCode?: string;
  supplierId: string; supplier: string; currency: string; amount: number; date: string; reference: string; reason: string; paymentId?: string;
  at: string; actor: string; reversed?: { at: string; actor: string; reason: string };
};
/** 反向记录：冲回付款或冲回分配，原记录保留。 */
export type PayableReversal = { id: string; kind: 'payment' | 'allocation'; targetId: string; parentId?: string; amount: number; currency: string; reason: string; at: string; actor: string };
export type PayablesState = { bills: SupplierBill[]; payments: SupplierPayment[]; allocations: SupplierPaymentAllocation[]; plans?: PrepaymentPlan[]; requests?: PaymentRequest[]; reversals?: PayableReversal[]; settlements?: SupplierSettlement[]; deductions?: SupplierDeduction[]; prepaymentMoves?: PrepaymentMove[] };
type AllocationInput = Array<{ billId: string; amount: number }>;
export type PayablesCommand =
  | { type: 'payable.bill.register'; payload: { supplierId: string; invoiceNo: string; invoiceDate: string; currency: string; amount: number; taxAmount: number; taxRate?: string; lines: Array<{ purchaseId: string; amount: number; settlementId?: string; awaitingSettlement?: boolean }>; due: string; dueBasis: string; fileIds?: string[]; note?: string } }
  | { type: 'payable.bill.void'; payload: { id: string; reason: string } }
  | { type: 'payable.bill.link'; payload: { id: string; links: Array<{ purchaseId: string; settlementId: string }> } }
  | { type: 'payable.deduction.register'; payload: { recoveryId: string; billId: string; amount: number; reference: string; note?: string } }
  | { type: 'payable.deduction.reverse'; payload: { id: string; reason: string } }
  | { type: 'payable.prepayment.refund'; payload: { purchaseId: string; amount: number; date: string; reference: string; reason: string } }
  | { type: 'payable.prepayment.transfer'; payload: { purchaseId: string; targetPurchaseId: string; amount: number; reason: string } }
  | { type: 'payable.prepayment.reverse'; payload: { id: string; reason: string } }
  | { type: 'payable.plan.register'; payload: { purchaseId: string; stage?: PaymentPlanStage; amount: number; trigger: string; basis: string; due?: string; note?: string } }
  | { type: 'payable.plan.cancel'; payload: { id: string; reason: string } }
  | { type: 'payable.request.submit'; payload: { purpose: 'prepayment'; planId: string; amount: number; reason: string; fileIds?: string[] } | { purpose: 'settlement'; settlementId: string; amount: number; reason: string; fileIds?: string[] } | { purpose: 'bill'; supplierId: string; currency: string; lines: Array<{ billId: string; amount: number }>; planId?: string; reason: string; fileIds?: string[] } }
  | { type: 'payable.request.decide'; payload: { id: string; decision: 'approved' | 'rejected'; note: string } }
  | { type: 'payable.request.cancel'; payload: { id: string; reason: string } }
  | { type: 'payable.payment.register'; payload: { requestId?: string; supplierId?: string; date: string; amount: number; currency?: string; reference: string; fileIds?: string[]; note?: string; allocations?: AllocationInput } }
  | { type: 'payable.payment.backfill'; payload: { planId: string; date: string; amount: number; reference: string; billId?: string; note?: string; fileIds?: string[] } }
  | { type: 'payable.payment.plan'; payload: { supplierPaymentId: string; planId: string | null; note?: string } }
  | { type: 'payable.purchase.cancel'; payload: { purchaseId: string; reason: string; prepayment?: 'refund' | 'transfer'; targetPurchaseId?: string } }
  | { type: 'payable.payment.allocate'; payload: { supplierPaymentId: string; allocations: AllocationInput } }
  | { type: 'payable.payment.reverse'; payload: { supplierPaymentId: string; reason: string } }
  | { type: 'payable.allocation.reverse'; payload: { allocationId: string; reason: string } }
  | { type: 'payable.settlement.submit'; payload: { purchaseId: string; receiptIds: string[]; final?: boolean; disputes?: SettlementDispute[]; note?: string; fileIds?: string[] } }
  | { type: 'payable.settlement.cancel'; payload: { id: string; reason: string } }
  | { type: 'payable.settlement.confirm'; payload: { id: string; prepaymentApplied: number; adjustReason?: string; note?: string } }
  | { type: 'payable.settlement.return'; payload: { id: string; reason: string } }
  | { type: 'payable.settlement.reverse'; payload: { id: string; reason: string } };
export const PAYABLE_COMMANDS = ['payable.bill.register', 'payable.bill.void', 'payable.plan.register', 'payable.plan.cancel', 'payable.request.submit', 'payable.request.decide', 'payable.request.cancel', 'payable.payment.register', 'payable.payment.allocate', 'payable.payment.reverse', 'payable.allocation.reverse', 'payable.settlement.submit', 'payable.settlement.cancel', 'payable.settlement.confirm', 'payable.settlement.return', 'payable.settlement.reverse', 'payable.bill.link', 'payable.deduction.register', 'payable.deduction.reverse', 'payable.prepayment.refund', 'payable.prepayment.transfer', 'payable.prepayment.reverse', 'payable.payment.backfill', 'payable.payment.plan', 'payable.purchase.cancel'] as const;
/** 结算提交沿用合同经办权限（业务员）；复核确认、退回与冲回沿用核销权限（财务）。 */
export const SETTLEMENT_SCOPES = { submit: 'procurement:write', confirm: MIST_FINANCE_SCOPES.reconcile } as const;
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

export const createPayablesState = (_context?: MistContext, _root?: unknown): PayablesState => ({ bills: [], payments: [], allocations: [], plans: [], requests: [], reversals: [], settlements: [], deductions: [], prepaymentMoves: [] });
export function payablesCommandPermission(command: PayablesCommand) {
  if (command.type === 'payable.bill.register' || command.type === 'payable.bill.void' || command.type === 'payable.bill.link' || command.type === 'payable.plan.register' || command.type === 'payable.plan.cancel') return MIST_FINANCE_SCOPES.invoice;
  // 索赔扣款减少票据未付，属于核销；退款是资金到账，沿凭证写；转抵是在合同之间核销预付。
  if (command.type === 'payable.deduction.register' || command.type === 'payable.deduction.reverse' || command.type === 'payable.prepayment.transfer') return MIST_FINANCE_SCOPES.reconcile;
  if (command.type === 'payable.prepayment.refund') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.prepayment.reverse') return MIST_FINANCE_SCOPES.reconcile;
  if (command.type === 'payable.request.submit' || command.type === 'payable.request.cancel') return PAYMENT_REQUEST_SCOPES.create;
  // 历史补登是登记已发生的付款（凭证写）；旧付款对应计划只改计划跟踪（与登记计划同权）；取消合同是合同经办（业务员）。
  if (command.type === 'payable.payment.backfill') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.payment.plan') return MIST_FINANCE_SCOPES.invoice;
  if (command.type === 'payable.purchase.cancel') return SETTLEMENT_SCOPES.submit;
  if (command.type === 'payable.request.decide') return PAYMENT_REQUEST_SCOPES.approve;
  if (command.type === 'payable.payment.reverse') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.allocation.reverse') return MIST_FINANCE_SCOPES.reconcile;
  if (command.type === 'payable.payment.register') return MIST_FINANCE_SCOPES.voucher;
  if (command.type === 'payable.payment.allocate') return MIST_FINANCE_SCOPES.reconcile;
  if (command.type === 'payable.settlement.submit' || command.type === 'payable.settlement.cancel') return SETTLEMENT_SCOPES.submit;
  if (command.type === 'payable.settlement.confirm' || command.type === 'payable.settlement.return' || command.type === 'payable.settlement.reverse') return SETTLEMENT_SCOPES.confirm;
  return fail('未知应付操作');
}
/** 登记付款和核销是两个已有权限；一次提交同时办理时必须两项都具备。 */
export function payablesCommandPermissions(command: PayablesCommand): string[] {
  const permissions: string[] = [payablesCommandPermission(command)];
  if (command.type === 'payable.payment.register' && Array.isArray(command.payload.allocations) && command.payload.allocations.length) permissions.push(MIST_FINANCE_SCOPES.reconcile);
  if (command.type === 'payable.payment.backfill' && command.payload.billId) permissions.push(MIST_FINANCE_SCOPES.reconcile);
  // 冲回付款会连带冲回其分配，始终同时需要核销权。
  if (command.type === 'payable.payment.reverse') permissions.push(MIST_FINANCE_SCOPES.reconcile);
  // 退款既是到账（凭证写），也减少合同可抵扣预付（核销）。
  if (command.type === 'payable.prepayment.refund') permissions.push(MIST_FINANCE_SCOPES.reconcile);
  return permissions;
}
type Full = Required<PayablesState>;
const fill = (s: PayablesState): Full => { s.plans ||= []; s.requests ||= []; s.reversals ||= []; s.settlements ||= []; s.deductions ||= []; s.prepaymentMoves ||= []; return s as Full; };
const ledger = (root: Root): Full => { if (!root.payables) root.payables = createPayablesState(); return fill(root.payables); };
const read = (root: Root): Full => { const s = root.payables || createPayablesState(); return { ...s, plans: s.plans || [], requests: s.requests || [], reversals: s.reversals || [], settlements: s.settlements || [], deductions: s.deductions || [], prepaymentMoves: s.prepaymentMoves || [] }; };
export const paymentReversed = (root: Root, paymentId: string) => read(root).reversals.some(r => r.kind === 'payment' && r.targetId === paymentId);
export const allocationReversed = (root: Root, allocationId: string) => read(root).reversals.some(r => r.kind === 'allocation' && r.targetId === allocationId);
const activeAllocations = (root: Root) => read(root).allocations.filter(a => !allocationReversed(root, a.id));

/** 合同金额按 数量 × 单价 原币计算（分），只作为“最多能开多少票”的上限，不是应付余额。 */
export function purchaseContractMinor(p: { quantity: number; price: number }) { return Math.round(p.quantity * p.price * 100); }
export function purchaseInvoicedMinor(root: Root, purchaseId: string, exceptBillId = '') {
  return read(root).bills.filter(b => b.state === 'open' && b.id !== exceptBillId).flatMap(b => b.lines).filter(l => l.purchaseId === purchaseId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0);
}
export function billPaidMinor(root: Root, billId: string) { return activeAllocations(root).filter(a => a.billId === billId).reduce((n, a) => n + mistMoneyMinor(a.amount), 0); }
/** 有效（未冲回）的索赔扣款。 */
const activeDeductions = (root: Root) => read(root).deductions.filter(d => !d.reversed);
export function billDeductedMinor(root: Root, billId: string) { return activeDeductions(root).filter(d => d.billId === billId).reduce((n, d) => n + mistMoneyMinor(d.amount), 0); }
/** 票据是否仍有行暂挂待关联结算。 */
export const billHeld = (bill: SupplierBill) => bill.state === 'open' && bill.lines.some(l => l.awaitingSettlement && !l.settlementId);
/** 未付 = 票额 − 已分配付款 − 预付抵扣 − 按结算先付（不等票）− 索赔扣款。暂挂票据的未付另行显示，不是可付应付。 */
export function billOpenMinor(root: Root, bill: SupplierBill) { return bill.state === 'void' ? 0 : Math.max(0, mistMoneyMinor(bill.amount) - billPaidMinor(root, bill.id) - billPrepaymentCreditMinor(root, bill) - billAdvanceCreditMinor(root, bill) - billDeductedMinor(root, bill.id)); }
export const planStage = (plan: PrepaymentPlan): PaymentPlanStage => plan.stage || 'prepayment';
const PLAN_STAGE_LABEL: Record<PaymentPlanStage, string> = { prepayment: '预付款', progress: '进度款', final: '尾款' };
export const paymentPlanStageLabel = (stage: PaymentPlanStage) => PLAN_STAGE_LABEL[stage];
/** 已确认（未冲回）的结算。 */
const confirmedSettlements = (root: Root, purchaseId?: string) => read(root).settlements.filter(x => x.state === 'confirmed' && (!purchaseId || x.purchaseId === purchaseId));
/** 合同已付预付（未冲回）与已被结算抵扣的金额。 */
const activeMoves = (root: Root) => read(root).prepaymentMoves.filter(m => !m.reversed);
/** 从其他合同转入的预付。 */
export function purchasePrepaymentTransferredInMinor(root: Root, purchaseId: string) { return activeMoves(root).filter(m => m.kind === 'transfer' && m.targetPurchaseId === purchaseId).reduce((n, m) => n + mistMoneyMinor(m.amount), 0); }
/** 已退款或转出的剩余预付。 */
export function purchasePrepaymentMovedOutMinor(root: Root, purchaseId: string, kind?: PrepaymentMove['kind']) { return activeMoves(root).filter(m => m.purchaseId === purchaseId && (!kind || m.kind === kind)).reduce((n, m) => n + mistMoneyMinor(m.amount), 0); }
/** 合同可用于抵扣的预付 = 本合同已付预付（未冲回）+ 转入；退款 / 转出另算。 */
export function purchasePrepaidMinor(root: Root, purchaseId: string) { return read(root).payments.filter(p => p.purchaseId === purchaseId).reduce((n, p) => n + prepaymentHeldMinor(root, p), 0) + purchasePrepaymentTransferredInMinor(root, purchaseId); }
export function purchasePrepaymentAppliedMinor(root: Root, purchaseId: string, exceptSettlementId = '') { return confirmedSettlements(root, purchaseId).filter(x => x.id !== exceptSettlementId).reduce((n, x) => n + mistMoneyMinor(x.confirmation?.prepaymentApplied || 0), 0); }
export function purchasePrepaymentAvailableMinor(root: Root, purchaseId: string) { return Math.max(0, purchasePrepaidMinor(root, purchaseId) - purchasePrepaymentAppliedMinor(root, purchaseId) - purchasePrepaymentMovedOutMinor(root, purchaseId)); }
/** 结算已关联到有效票据的金额（票据按结算登记，避免同一笔结算重复开票形成第二笔应付）。 */
export function settlementInvoicedMinor(root: Root, settlementId: string, exceptBillId = '') {
  return read(root).bills.filter(b => b.state === 'open' && b.id !== exceptBillId).flatMap(b => b.lines).filter(l => l.settlementId === settlementId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0);
}
/**
 * 结算中的预付抵扣按票额比例计入关联票据：每张票 = 抵扣额 × 本票对应额 ÷ 结算金额（四舍五入到分），
 * 关联票据合计达到结算金额时最后一张承担尾差。作废票据不计。
 */
export function settlementCreditsMinor(root: Root, settlementId: string) {
  const s = read(root), st = s.settlements.find(x => x.id === settlementId), out = new Map<string, number>();
  if (!st || st.state !== 'confirmed') return out;
  const applied = mistMoneyMinor(st.confirmation?.prepaymentApplied || 0), total = mistMoneyMinor(st.amount);
  if (!applied || !total) return out;
  const lines = s.bills.filter(b => b.state === 'open').sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.code.localeCompare(b.code)).flatMap(b => b.lines.filter(l => l.settlementId === settlementId).map(l => ({ billId: b.id, amount: mistMoneyMinor(l.amount) })));
  let cumulative = 0, credited = 0;
  for (const l of lines) { cumulative += l.amount; const credit = cumulative >= total ? applied - credited : Math.round(applied * l.amount / total); credited += credit; out.set(l.billId, (out.get(l.billId) || 0) + credit); }
  return out;
}
export function billPrepaymentCreditMinor(root: Root, bill: SupplierBill) {
  if (bill.state === 'void') return 0;
  return [...new Set(bill.lines.map(l => l.settlementId).filter(Boolean) as string[])].reduce((n, id) => n + (settlementCreditsMinor(root, id).get(bill.id) || 0), 0);
}
/** 按结算不等票先付的付款（未冲回）。 */
const advancePayments = (root: Root, settlementId: string) => read(root).payments.filter(p => p.purpose === 'settlement' && p.settlementId === settlementId && !paymentReversed(root, p.id)).sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
export function settlementAdvancePaidMinor(root: Root, settlementId: string) { return advancePayments(root, settlementId).reduce((n, p) => n + mistMoneyMinor(p.amount), 0); }
/** 先付款按票据登记顺序抵到关联本结算的票据：每张票最多抵到“本票对应额 − 本票预付抵扣”。 */
export function settlementAdvanceCreditsMinor(root: Root, settlementId: string) {
  const s = read(root), out = new Map<string, number>(); let pool = settlementAdvancePaidMinor(root, settlementId);
  if (!pool) return out;
  const prepay = settlementCreditsMinor(root, settlementId);
  for (const b of s.bills.filter(b => b.state === 'open').sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.code.localeCompare(b.code))) for (const l of b.lines.filter(l => l.settlementId === settlementId)) {
    const credit = Math.min(pool, Math.max(0, mistMoneyMinor(l.amount) - (prepay.get(b.id) || 0))); if (credit <= 0) continue;
    out.set(b.id, (out.get(b.id) || 0) + credit); pool -= credit;
  }
  return out;
}
export function billAdvanceCreditMinor(root: Root, bill: SupplierBill) {
  if (bill.state === 'void') return 0;
  return [...new Set(bill.lines.map(l => l.settlementId).filter(Boolean) as string[])].reduce((n, id) => n + (settlementAdvanceCreditsMinor(root, id).get(bill.id) || 0), 0);
}
const sumMap = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0);
/** 已付未收票 = 按结算先付 − 已抵到关联票据的部分。 */
export function settlementAdvanceOpenMinor(root: Root, settlementId: string) { return Math.max(0, settlementAdvancePaidMinor(root, settlementId) - sumMap(settlementAdvanceCreditsMinor(root, settlementId))); }
/** 结算不等票可申请付款 = 未开票部分 − 还没随票计入的预付抵扣 − 已申请 / 已付但还没抵到票据的先付款。 */
export function settlementAdvanceRoomMinor(root: Root, settlementId: string, exceptRequestId = '') {
  const s = read(root), st = s.settlements.find(x => x.id === settlementId);
  if (!st || st.state !== 'confirmed') return 0;
  const uninvoiced = mistMoneyMinor(st.amount) - settlementInvoicedMinor(root, st.id), prepayLeft = mistMoneyMinor(st.confirmation?.prepaymentApplied || 0) - sumMap(settlementCreditsMinor(root, st.id));
  const live = s.requests.filter(r => r.purpose === 'settlement' && r.settlementId === st.id && r.id !== exceptRequestId && LIVE_REQUEST.includes(r.state)).reduce((n, r) => n + mistMoneyMinor(r.amount), 0);
  return Math.max(0, uninvoiced - Math.max(0, prepayLeft) - (live - sumMap(settlementAdvanceCreditsMinor(root, st.id))));
}
/** 结算有在途或已付的不等票付款申请（冲回结算前须先撤回 / 冲回）。 */
export function settlementHasLiveAdvance(root: Root, settlementId: string) { return read(root).requests.some(r => r.purpose === 'settlement' && r.settlementId === settlementId && LIVE_REQUEST.includes(r.state)); }
/** 旧付款（无申请、非补登、未冲回）可对应的计划：同供应商同币种的有效计划，预付计划须同合同预付款，进度款 / 尾款须已分配到该合同票据，且额度足够。 */
export function legacyPaymentPlanOptions(root: Root, payment: SupplierPayment) {
  const s = read(root);
  if (payment.requestId || payment.backfill || payment.planId || paymentReversed(root, payment.id)) return [];
  return s.plans.filter(plan => plan.state === 'active' && plan.supplierId === payment.supplierId && plan.currency === payment.currency
    && (planStage(plan) === 'prepayment' ? payment.purpose === 'prepayment' && payment.purchaseId === plan.purchaseId : payment.purpose !== 'prepayment' && activeAllocations(root).some(a => a.supplierPaymentId === payment.id && s.bills.find(b => b.id === a.billId)?.lines.some(l => l.purchaseId === plan.purchaseId)))
    && planRequestedMinor(root, plan.id) + mistMoneyMinor(payment.amount) <= mistMoneyMinor(plan.amount));
}
/** 进度款 / 尾款补登可对应的票据：含该合同、未作废、未暂挂、还有可付余额。 */
export function backfillBillOptions(root: Root, planId: string) {
  const plan = read(root).plans.find(x => x.id === planId);
  return plan ? payableBills(root, '').filter(b => b.status !== 'void' && !b.held && b.lines.some(l => l.purchaseId === plan.purchaseId)).map(b => ({ bill: b, room: major(Math.max(0, billOpenMinor(root, b) - billRequestedUnpaidMinor(root, b.id))) })).filter(x => x.room > 0) : [];
}
/** 每笔先付款还没收到票的部分：按付款先后由已抵到票据的金额依次冲减。 */
function advanceOpenByPayment(root: Root) {
  const out = new Map<string, number>();
  for (const id of new Set(read(root).payments.filter(p => p.purpose === 'settlement' && p.settlementId).map(p => p.settlementId!))) {
    let credited = sumMap(settlementAdvanceCreditsMinor(root, id));
    for (const p of advancePayments(root, id)) { const m = mistMoneyMinor(p.amount), used = Math.min(m, credited); credited -= used; out.set(p.id, m - used); }
  }
  return out;
}
/** 先付款超过 30 天还没收到票，提醒财务催票。 */
export const ADVANCE_INVOICE_REMIND_DAYS = 30;
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** 已进入有效结算（待复核或已确认）的收货记录不能再次结算。 */
const receiptSettled = (root: Root, receiptId: string, exceptSettlementId = '') => read(root).settlements.some(x => x.id !== exceptSettlementId && (x.state === 'pending' || x.state === 'confirmed') && x.receiptIds.includes(receiptId));
const settledQuantity = (root: Root, purchaseId: string, exceptSettlementId = '') => confirmedSettlements(root, purchaseId).filter(x => x.id !== exceptSettlementId).reduce((n, x) => n + x.quantity, 0);
/** 预付抵扣建议：最后一次结算（勾选最终结算或累计数量达到合同数量）抵扣剩余全部预付，否则按数量比例；不超过结算金额。 */
export function settlementSuggestedPrepaymentMinor(root: Root, settlement: Pick<SupplierSettlement, 'id' | 'purchaseId' | 'quantity' | 'amount' | 'final'>) {
  const po = (root.fulfillment?.purchases || []).find(x => x.id === settlement.purchaseId);
  const available = purchasePrepaidMinor(root, settlement.purchaseId) - purchasePrepaymentAppliedMinor(root, settlement.purchaseId, settlement.id) - purchasePrepaymentMovedOutMinor(root, settlement.purchaseId);
  if (!po || available <= 0) return 0;
  const last = settlement.final || settledQuantity(root, po.id, settlement.id) + settlement.quantity >= po.quantity;
  const proportional = po.quantity > 0 ? Math.round(purchasePrepaidMinor(root, po.id) * settlement.quantity / po.quantity) : 0;
  return Math.max(0, Math.min(last ? available : proportional, available, mistMoneyMinor(settlement.amount)));
}
export function settlementReceipts(root: Root, purchaseId: string, exceptSettlementId = '') {
  return (root.fulfillment?.receipts || []).filter(r => r.purchaseId === purchaseId).map(r => ({ receipt: r, settled: receiptSettled(root, r.id, exceptSettlementId) }));
}
/** 未分配 = 可以再分配到票据的钱；已冲回付款和预付款（等结算抵扣）都不算。 */
export function supplierPaymentUnallocatedMinor(root: Root, payment: SupplierPayment) {
  if (paymentReversed(root, payment.id) || payment.purpose === 'prepayment' || payment.purpose === 'settlement') return 0;
  return mistMoneyMinor(payment.amount) - activeAllocations(root).filter(a => a.supplierPaymentId === payment.id).reduce((n, a) => n + mistMoneyMinor(a.amount), 0);
}
/** 已付且未冲回的预付款，等待结算确认后抵扣。 */
export function prepaymentHeldMinor(root: Root, payment: SupplierPayment) { return payment.purpose === 'prepayment' && !paymentReversed(root, payment.id) ? mistMoneyMinor(payment.amount) : 0; }

export type PayableBillView = SupplierBill & { paid: number; prepaymentCredit: number; advanceCredit: number; deducted: number; open: number; overdue: boolean; held: boolean; status: 'held' | 'unpaid' | 'partial' | 'paid' | 'void' };
export function payableBills(root: Root, today: string): PayableBillView[] {
  return read(root).bills.map(b => {
    const paid = major(billPaidMinor(root, b.id)), credit = major(billPrepaymentCreditMinor(root, b)), advance = major(billAdvanceCreditMinor(root, b)), deducted = major(billDeductedMinor(root, b.id)), open = major(billOpenMinor(root, b)), held = billHeld(b);
    const status = b.state === 'void' ? 'void' : held ? 'held' : open <= 0 ? 'paid' : paid > 0 || credit > 0 || advance > 0 || deducted > 0 ? 'partial' : 'unpaid';
    return { ...b, paid, prepaymentCredit: credit, advanceCredit: advance, deducted, open, held, overdue: status !== 'void' && status !== 'held' && open > 0 && b.due < today, status } as PayableBillView;
  }).sort((a, b) => (a.status === 'void' ? 1 : 0) - (b.status === 'void' ? 1 : 0) || a.due.localeCompare(b.due) || a.code.localeCompare(b.code));
}
export type SupplierPaymentView = SupplierPayment & { allocated: number; unallocated: number; prepaid: number; reversed?: PayableReversal; requestCode?: string; aheadOpen: number; aheadOverdue: boolean; planCode?: string };
export function supplierPayments(root: Root, today = ''): SupplierPaymentView[] {
  const s = read(root), ahead = advanceOpenByPayment(root);
  return s.payments.map(p => {
    const aheadOpen = ahead.get(p.id) || 0;
    const un = supplierPaymentUnallocatedMinor(root, p), allocated = activeAllocations(root).filter(a => a.supplierPaymentId === p.id).reduce((n, a) => n + mistMoneyMinor(a.amount), 0);
    return { ...p, allocated: major(allocated), unallocated: major(un), prepaid: major(prepaymentHeldMinor(root, p)), reversed: s.reversals.find(r => r.kind === 'payment' && r.targetId === p.id), requestCode: s.requests.find(r => r.id === p.requestId)?.code,
      aheadOpen: major(aheadOpen), aheadOverdue: !!today && aheadOpen > 0 && addDays(p.date, ADVANCE_INVOICE_REMIND_DAYS) < today, planCode: s.plans.find(x => x.id === p.planId)?.code };
  }).sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code));
}
/** 每个供应商按原币汇总：已登记票据、已付、未付、未分配付款。不同币种不合计。 */
export function supplierPayableSummary(root: Root, today: string) {
  const groups = new Map<string, { supplierId: string; supplier: string; currency: string; billed: number; paid: number; open: number; unallocated: number; prepaid: number; held: number; heldBills: number; bills: number; overdue: number; ahead: number; aheadOverdue: number; refundDue: number }>();
  const g = (supplierId: string, supplier: string, currency: string) => { const k = JSON.stringify([supplierId, currency]); if (!groups.has(k)) groups.set(k, { supplierId, supplier, currency, billed: 0, paid: 0, open: 0, unallocated: 0, prepaid: 0, held: 0, heldBills: 0, bills: 0, overdue: 0, ahead: 0, aheadOverdue: 0, refundDue: 0 }); return groups.get(k)!; };
  for (const b of payableBills(root, today)) if (b.status !== 'void') {
    const r = g(b.supplierId, b.supplier, b.currency);
    // 暂挂票据：发票已到、结算未确认，单列，不计入已登记应付和未付。
    if (b.held) { r.held += mistMoneyMinor(b.amount); r.heldBills++; continue; }
    r.billed += mistMoneyMinor(b.amount); r.paid += mistMoneyMinor(b.paid); r.open += mistMoneyMinor(b.open); if (b.open > 0) r.bills++; if (b.overdue) r.overdue++;
  }
  for (const p of supplierPayments(root, today)) {
    if (p.unallocated > 0) g(p.supplierId, p.supplier, p.currency).unallocated += mistMoneyMinor(p.unallocated);
    // 已付未收票：按结算先付、票据还没到；超过 30 天单独计数提醒催票。
    if (p.aheadOpen > 0) { const r = g(p.supplierId, p.supplier, p.currency); r.ahead += mistMoneyMinor(p.aheadOpen); if (p.aheadOverdue) r.aheadOverdue++; }
  }
  // 预付（待抵扣）= 已付预付 + 转入 − 已抵扣 − 退款 / 转出，按合同累计后归到供应商。
  const purchases = root.fulfillment?.purchases || [];
  for (const purchaseId of new Set([...read(root).payments.filter(p => p.purpose === 'prepayment' && p.purchaseId).map(p => p.purchaseId!), ...activeMoves(root).filter(m => m.targetPurchaseId).map(m => m.targetPurchaseId!)])) {
    const left = purchasePrepaymentAvailableMinor(root, purchaseId), po = purchases.find(x => x.id === purchaseId), pay = read(root).payments.find(p => p.purchaseId === purchaseId);
    // 合同取消且选择退款：剩余预付是“待退回”，不再等结算抵扣。
    if (left > 0 && (po || pay)) { const r = g(po?.supplierId || pay!.supplierId, po?.supplier || pay!.supplier, po?.currency || pay!.currency); if (po?.state === 'cancelled' && po.cancellation?.prepayment === 'refund') r.refundDue += left; else r.prepaid += left; }
  }
  return [...groups.values()].map(r => ({ ...r, billed: major(r.billed), paid: major(r.paid), open: major(r.open), unallocated: major(r.unallocated), prepaid: major(r.prepaid), held: major(r.held), ahead: major(r.ahead), refundDue: major(r.refundDue) })).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.currency.localeCompare(b.currency));
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
export function planRequestedMinor(root: Root, planId: string, exceptRequestId = '') { return read(root).requests.filter(r => r.planId === planId && r.id !== exceptRequestId && LIVE_REQUEST.includes(r.state)).reduce((n, r) => n + mistMoneyMinor(r.amount), 0) + planUnrequestedPaidMinor(root, planId); }
/** 没有付款申请却对应到计划的付款：历史补登，或审批规则前的旧付款事后对应。 */
export function planUnrequestedPaidMinor(root: Root, planId: string) { return read(root).payments.filter(p => p.planId === planId && !p.requestId && !paymentReversed(root, p.id)).reduce((n, p) => n + mistMoneyMinor(p.amount), 0); }
export function planPaidMinor(root: Root, planId: string) { return read(root).payments.filter(p => p.planId === planId && !paymentReversed(root, p.id)).reduce((n, p) => n + mistMoneyMinor(p.amount), 0); }
/** 票据已进入付款申请但还没付的金额，避免同一张票被重复申请。 */
export function billRequestedUnpaidMinor(root: Root, billId: string, exceptRequestId = '') { return read(root).requests.filter(r => r.purpose === 'bill' && r.id !== exceptRequestId && (r.state === 'pending' || r.state === 'approved')).flatMap(r => r.lines).filter(l => l.billId === billId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0); }
export type PrepaymentPlanView = PrepaymentPlan & { stage: PaymentPlanStage; requested: number; paid: number; available: number };
export function prepaymentPlans(root: Root, purchaseId?: string): PrepaymentPlanView[] {
  return read(root).plans.filter(p => !purchaseId || p.purchaseId === purchaseId).map(p => {
    const requested = planRequestedMinor(root, p.id);
    return { ...p, stage: planStage(p), requested: major(requested), paid: major(planPaidMinor(root, p.id)), available: p.state === 'active' ? major(Math.max(0, mistMoneyMinor(p.amount) - requested)) : 0 };
  }).sort((a, b) => a.purchaseCode.localeCompare(b.purchaseCode) || a.code.localeCompare(b.code));
}
export function paymentRequests(root: Root): PaymentRequest[] {
  const order: Record<PaymentRequest['state'], number> = { pending: 0, approved: 1, rejected: 2, paid: 3, cancelled: 4 };
  return [...read(root).requests].sort((a, b) => order[a.state] - order[b.state] || b.submittedAt.localeCompare(a.submittedAt));
}
/** 采购合同回读：预付款计划、已付、已抵扣与剩余待抵扣。 */
export function purchasePrepaymentReadback(root: Root, purchaseId: string) {
  const all = prepaymentPlans(root, purchaseId).filter(p => p.state === 'active'), plans = all.filter(p => p.stage === 'prepayment');
  const applied = major(purchasePrepaymentAppliedMinor(root, purchaseId)), available = major(purchasePrepaymentAvailableMinor(root, purchaseId));
  const po = (root.fulfillment?.purchases || []).find(x => x.id === purchaseId), cancelled = po?.state === 'cancelled' ? po.cancellation : undefined;
  const closed = confirmedSettlements(root, purchaseId).some(x => x.final) || !!cancelled, moves = prepaymentMoves(root).filter(m => m.purchaseId === purchaseId || m.targetPurchaseId === purchaseId);
  const transferredIn = major(purchasePrepaymentTransferredInMinor(root, purchaseId));
  return { plans, schedule: all.filter(p => p.stage !== 'prepayment'), planned: plans.reduce((n, p) => n + p.amount, 0), paid: major(purchasePrepaidMinor(root, purchaseId)) - transferredIn, transferredIn, applied,
    refunded: major(purchasePrepaymentMovedOutMinor(root, purchaseId, 'refund')), transferredOut: major(purchasePrepaymentMovedOutMinor(root, purchaseId, 'transfer')), available, residualAfterFinal: closed ? available : 0, moves,
    cancelled, refundDue: cancelled?.prepayment === 'refund' ? available : 0 };
}
/** 剩余预付处理记录（退款 / 转抵），新的在前。 */
export function prepaymentMoves(root: Root): PrepaymentMove[] { return [...read(root).prepaymentMoves].sort((a, b) => b.at.localeCompare(a.at) || b.code.localeCompare(a.code)); }
/** 可接收转抵的合同：同一供应商、同币种、已批准、未最终结算，且不是来源合同。 */
export function prepaymentTransferTargets(root: Root, purchaseId: string) {
  const po = (root.fulfillment?.purchases || []).find(x => x.id === purchaseId);
  return po ? (root.fulfillment?.purchases || []).filter(x => x.id !== po.id && x.state === 'approved' && x.supplierId === po.supplierId && x.currency === po.currency && !confirmedSettlements(root, x.id).some(st => st.final)) : [];
}
export type ClaimLike = { id: string; code: string; state: string; coordination?: { recoveries: Array<{ id: string; supplierId: string; supplierName: string; currency: string; state: string; agreed?: number; method?: string; settled?: number; settledRef?: string; settledDate?: string; events: Array<{ at: string; by: string; action: string; note: string }> }> } };
const claimsOf = (root: Root) => ((root as Root & { platform?: { claims?: ClaimLike[] } }).platform?.claims || []);
/** 某笔追偿已在应付中扣款（未冲回）的金额。 */
export function recoveryDeductedMinor(root: Root, recoveryId: string, exceptId = '') { return activeDeductions(root).filter(d => d.recoveryId === recoveryId && d.id !== exceptId).reduce((n, d) => n + mistMoneyMinor(d.amount), 0); }
/** 可从货款中扣的追偿：工厂已同意、方式为“从货款中扣”或“组合方式”、还有未扣金额。 */
export function deductibleRecoveries(root: Root, supplierId?: string, currency?: string) {
  return claimsOf(root).filter(c => c.state !== 'Closed' && c.state !== 'Cancelled').flatMap(c => (c.coordination?.recoveries || []).filter(r => r.state === 'Agreed' && (r.method === 'deduction' || r.method === 'mixed') && (!supplierId || r.supplierId === supplierId) && (!currency || r.currency === currency)).map(r => {
    const deducted = recoveryDeductedMinor(root, r.id);
    return { claimId: c.id, claimCode: c.code, recovery: r, deducted: major(deducted), left: major(Math.max(0, mistMoneyMinor(r.agreed || 0) - deducted)) };
  })).filter(x => x.left > 0);
}
export function supplierDeductions(root: Root, billId?: string): SupplierDeduction[] { return read(root).deductions.filter(d => !billId || d.billId === billId).sort((a, b) => b.at.localeCompare(a.at) || b.code.localeCompare(a.code)); }
export type SettlementView = SupplierSettlement & { invoiced: number; uninvoiced: number; net: number; suggested: number; available: number };
export function supplierSettlements(root: Root, purchaseId?: string): SettlementView[] {
  const order: Record<SupplierSettlement['state'], number> = { pending: 0, confirmed: 1, returned: 2, cancelled: 3, reversed: 4 };
  return read(root).settlements.filter(x => !purchaseId || x.purchaseId === purchaseId).map(x => {
    const invoiced = x.state === 'confirmed' ? settlementInvoicedMinor(root, x.id) : 0, applied = mistMoneyMinor(x.confirmation?.prepaymentApplied || 0);
    return { ...x, invoiced: major(invoiced), uninvoiced: x.state === 'confirmed' ? major(Math.max(0, mistMoneyMinor(x.amount) - invoiced)) : 0, net: major(mistMoneyMinor(x.amount) - applied),
      suggested: x.state === 'pending' ? major(settlementSuggestedPrepaymentMinor(root, x)) : major(mistMoneyMinor(x.confirmation?.suggestedPrepayment || 0)),
      available: x.state === 'pending' ? major(purchasePrepaymentAvailableMinor(root, x.purchaseId)) : 0 };
  }).sort((a, b) => order[a.state] - order[b.state] || b.submittedAt.localeCompare(a.submittedAt));
}
/** 可登记票据时关联的结算：已确认且还有未开票金额。 */
export function invoiceableSettlements(root: Root, purchaseId: string, exceptBillId = '') {
  return confirmedSettlements(root, purchaseId).map(x => ({ settlement: x, left: major(Math.max(0, mistMoneyMinor(x.amount) - settlementInvoicedMinor(root, x.id, exceptBillId))) })).filter(x => x.left > 0);
}
/** 该合同票据是否必须关联结算：已有确认结算或已付预付时，必须关联，避免预付和结算重复形成应付。 */
export function purchaseRequiresSettlementLink(root: Root, purchaseId: string) { return confirmedSettlements(root, purchaseId).length > 0 || purchasePrepaidMinor(root, purchaseId) > 0; }
/** 主管审批收件箱：只给提交时冻结的申请快照和附件。撤回且未决定的申请不再出现。 */
export function getPayableReviews(root: Root): MistReviewTask[] {
  return read(root).requests.filter(r => !(r.state === 'cancelled' && !r.decision)).map(r => ({
    id: 'payment:' + r.id, kind: 'payment' as const, entityId: r.id, title: `${r.code} · ${r.supplier} · ${fx(major(mistMoneyMinor(r.amount)))} ${r.currency}`,
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
/** 金额展示：千分位、两位小数（审批材料、提示与流水统一）。 */
const fx = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    if (billHeld(bill)) fail(`${bill.code} 还在等待关联已确认结算，暂不能分配付款`, 'PRECONDITION');
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
      const lines: SupplierBillLine[] = (p.lines as Array<{ purchaseId: string; amount: number; settlementId?: string; awaitingSettlement?: boolean }>).map(row => {
        const purchaseId = text(row?.purchaseId, '来源合同'); if (seen.has(purchaseId)) fail('同一张合同在本票中重复出现'); seen.add(purchaseId);
        const po = purchases.find(x => x.id === purchaseId) || fail('来源合同不存在', 'NOT_FOUND');
        if (po.state !== 'approved') fail(`${po.code} 尚未批准，不能登记供应商票据`, 'PRECONDITION');
        if (po.supplierId !== supplierId) fail(`${po.code} 不是该供应商的合同`);
        if (po.currency !== currency) fail(`${po.code} 币种为 ${po.currency}，与票据币种 ${currency} 不同`);
        const m = minor(row.amount, po.code + ' 对应金额');
        if (m + purchaseInvoicedMinor(root, po.id) > purchaseContractMinor(po)) fail(`${po.code} 累计登记票据金额会超过合同金额，请核对或先走合同变更`);
        let link: Pick<SupplierBillLine, 'settlementId' | 'settlementCode' | 'awaitingSettlement'> = {};
        if (row.settlementId) {
          const st = s.settlements.find(x => x.id === text(row.settlementId, '关联结算')) || fail('关联结算不存在', 'NOT_FOUND');
          if (st.purchaseId !== po.id) fail(`${st.code} 不属于 ${po.code}`);
          if (st.state !== 'confirmed') fail(`${st.code} 尚未经财务确认，不能关联票据`, 'PRECONDITION');
          const left = mistMoneyMinor(st.amount) - settlementInvoicedMinor(root, st.id);
          if (m > left) fail(`${st.code} 未开票金额 ${fx(major(Math.max(0, left)))} ${st.currency}，本票对应金额超出；同一笔结算不能重复开票`);
          link = { settlementId: st.id, settlementCode: st.code };
        } else if (row.awaitingSettlement === true) {
          // 发票先于结算到达：先登记、暂挂，结算确认后再关联；暂挂期间不能申请付款。
          if (confirmedSettlements(root, po.id).some(x => x.final)) fail(`${po.code} 已完成最终结算，请关联已有结算`, 'PRECONDITION');
          link = { awaitingSettlement: true };
        } else if (row.awaitingSettlement !== undefined && row.awaitingSettlement !== false) fail('暂挂标记无效');
        else if (purchaseRequiresSettlementLink(root, po.id)) fail(`${po.code} 已有已确认结算或已付预付款，票据须关联已确认结算；结算还没确认时可先登记为“待关联结算”`, 'PRECONDITION');
        sum += m; supplier = po.supplier;
        return { purchaseId: po.id, purchaseCode: po.code, kind: po.kind, amount: major(m), ...link };
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
      if (billDeductedMinor(root, bill.id) > 0) fail('该票据已登记索赔扣款，请先冲回扣款再作废', 'PRECONDITION');
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
      if (request.purpose === 'settlement' && input.length) fail('按结算先付的款等供应商票据到后自动抵到关联票据，不能直接分配');
      if (request.purpose === 'bill') {
        const want = new Map(request.lines.map(l => [l.billId, mistMoneyMinor(l.amount)]));
        if (input.length !== want.size || input.some(r => want.get(r?.billId) !== (typeof r?.amount === 'number' ? mistMoneyMinor(r.amount) : NaN))) fail('付款分配须与已批准申请的票据和金额一致');
      }
      const id = c.id(), paymentId = c.id(), code = nextCode('PAY', root.payments, c.now);
      root.payments.push({ id: paymentId, code, date, payee: request.supplier, amount: major(amount), currency: request.currency, ref: reference } as MistPayment);
      const payment: SupplierPayment = { id, paymentId, code, supplierId: request.supplierId, supplier: request.supplier, date, amount: major(amount), currency: request.currency, reference, fileIds: files(root, p.fileIds), note: text(p.note, '备注', false), createdAt: c.now, actor: c.actorName, requestId: request.id, purpose: request.purpose, ...(request.purpose === 'prepayment' ? { purchaseId: request.purchaseId, planId: request.planId } : request.purpose === 'settlement' ? { purchaseId: request.purchaseId, settlementId: request.settlementId } : request.planId ? { planId: request.planId } : {}) };
      s.payments.push(payment);
      const applied = request.purpose === 'bill' ? allocate(root, c, payment, input) : 0;
      request.state = 'paid'; request.supplierPaymentId = id; request.paymentHistory.push(id);
      event(root, c, id, `按付款申请 ${request.code} 登记${request.purpose === 'prepayment' ? '预付款' : request.purpose === 'settlement' ? `按结算 ${request.settlementCode} 先付（发票未到）` : '供应商付款'} ${code}（${request.supplier}）`);
      return { id, applied };
    }
    case 'payable.plan.register': {
      const po = (root.fulfillment?.purchases || []).find(x => x.id === text(p.purchaseId, '来源合同')) || fail('来源合同不存在', 'NOT_FOUND');
      if (po.state !== 'approved') fail(`${po.code} 尚未批准，不能登记付款计划`, 'PRECONDITION');
      const stage: PaymentPlanStage = p.stage === undefined ? 'prepayment' : (['prepayment', 'progress', 'final'] as const).includes(p.stage) ? p.stage : fail('付款计划类型无效');
      const amount = minor(p.amount, PLAN_STAGE_LABEL[stage] + '金额'), trigger = text(p.trigger, '付款触发条件', true, 500), basis = text(p.basis, '合同条款依据', true, 500);
      const due = p.due ? day(p.due, '计划付款日') : '';
      const planned = s.plans.filter(x => x.purchaseId === po.id && x.state === 'active').reduce((n, x) => n + mistMoneyMinor(x.amount), 0);
      if (planned + amount > purchaseContractMinor(po)) fail(`${po.code} 付款计划合计会超过合同金额`);
      const id = c.id(), code = nextCode('PP', s.plans, c.now);
      s.plans.push({ stage, id, code, purchaseId: po.id, purchaseCode: po.code, supplierId: po.supplierId, supplier: po.supplier, currency: po.currency, amount: major(amount), trigger, basis, due, note: text(p.note, '备注', false), state: 'active', registeredAt: c.now, registeredBy: c.actorName });
      event(root, c, id, `登记 ${po.code} ${PLAN_STAGE_LABEL[stage]}计划 ${code}（${fx(major(amount))} ${po.currency}）`);
      return { id };
    }
    case 'payable.plan.cancel': {
      const plan = s.plans.find(x => x.id === text(p.id, '付款计划')) || fail('付款计划不存在', 'NOT_FOUND');
      if (plan.state !== 'active') fail('该计划已取消', 'PRECONDITION');
      if (planRequestedMinor(root, plan.id) > 0) fail('该计划已有付款申请或已付款，请先撤回申请或冲回付款', 'PRECONDITION');
      plan.state = 'cancelled'; plan.cancelled = { at: c.now, actor: c.actorName, reason: text(p.reason, '取消原因', true, 500) };
      event(root, c, plan.id, `取消${PLAN_STAGE_LABEL[planStage(plan)]}计划 ${plan.code}`);
      return { id: plan.id };
    }
    case 'payable.request.submit': {
      if (!c.actorId) fail('无法识别申请人', 'FORBIDDEN');
      const reason = text(p.reason, '申请说明', true, 1000), fileIds = files(root, p.fileIds), money = (m: number, cur: string) => fx(major(m)) + ' ' + cur;
      const reviewerIds = [...new Set((c.authority?.paymentReviewerIds || []).filter(id => id !== c.actorId))];
      if (!reviewerIds.length) fail('当前没有可审批付款申请的主管，请联系管理员配置部门主管', 'PRECONDITION');
      const id = c.id(), code = nextCode('PR', s.requests, c.now);
      let request: PaymentRequest;
      if (p.purpose === 'prepayment') {
        const plan = s.plans.find(x => x.id === text(p.planId, '预付款计划')) || fail('预付款计划不存在', 'NOT_FOUND');
        if (plan.state !== 'active') fail(`${plan.code} 已取消，不能申请付款`, 'PRECONDITION');
        if (planStage(plan) !== 'prepayment') fail(`${plan.code} 是${PLAN_STAGE_LABEL[planStage(plan)]}计划，须在供应商票据到后按票据申请付款`, 'PRECONDITION');
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
      } else if (p.purpose === 'settlement') {
        // 发票未到、按已确认结算先付：须写明未收票原因；付款记为“已付未收票”，票到关联结算后自动抵到票据。
        const st = s.settlements.find(x => x.id === text(p.settlementId, '结算')) || fail('结算不存在', 'NOT_FOUND');
        if (st.state !== 'confirmed') fail(`${st.code} 尚未经财务确认，不能按结算申请付款`, 'PRECONDITION');
        const amount = minor(p.amount, '申请金额'), room = settlementAdvanceRoomMinor(root, st.id);
        if (amount > room) fail(`${st.code} 不等票可申请 ${money(room, st.currency)}（未开票部分扣除待随票计入的预付抵扣和已申请的先付款），本次申请超出`);
        const applied = mistMoneyMinor(st.confirmation?.prepaymentApplied || 0), invoiced = settlementInvoicedMinor(root, st.id);
        const snapshot = [
          { label: '申请类型', value: '按结算付款（发票未到）' }, { label: '供应商', value: st.supplier },
          { label: '结算', value: `${st.code} · ${st.purchaseCode} · 实收 ${st.quantity} ${st.unit} · ${money(mistMoneyMinor(st.amount), st.currency)}${st.final ? ' · 最终结算' : ''}` },
          { label: '预付抵扣 / 结算净额', value: `${money(applied, st.currency)} / ${money(mistMoneyMinor(st.amount) - applied, st.currency)}` },
          { label: '已收票', value: money(invoiced, st.currency) }, { label: '本结算此前不等票已申请', value: money(s.requests.filter(r => r.purpose === 'settlement' && r.settlementId === st.id && LIVE_REQUEST.includes(r.state)).reduce((n, r) => n + mistMoneyMinor(r.amount), 0), st.currency) },
          { label: '本次申请金额', value: money(amount, st.currency) }, { label: '未收票原因', value: reason }, { label: '申请人', value: c.actorName },
        ];
        request = { id, code, purpose: 'settlement', supplierId: st.supplierId, supplier: st.supplier, currency: st.currency, amount: major(amount), purchaseId: st.purchaseId, purchaseCode: st.purchaseCode, settlementId: st.id, settlementCode: st.code, lines: [], reason, fileIds, requesterId: c.actorId, requester: c.actorName, submittedAt: c.now, reviewerIds, snapshot, state: 'pending', paymentHistory: [] };
      } else if (p.purpose === 'bill') {
        const supplierId = text(p.supplierId, '收款供应商'), currency = text(p.currency, '币种', true, 3).toUpperCase();
        if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 50) fail('请至少选择一张要付款的票据');
        const seen = new Set<string>(); let total = 0; let supplier = '';
        const lines: PaymentRequestLine[] = (p.lines as Array<{ billId: string; amount: number }>).map(row => {
          const billId = text(row?.billId, '应付票据'); if (seen.has(billId)) fail('同一张票据在本次申请中重复出现'); seen.add(billId);
          const bill = s.bills.find(b => b.id === billId) || fail('应付票据不存在', 'NOT_FOUND');
          if (bill.state === 'void') fail(`${bill.code} 已作废`, 'PRECONDITION');
          if (billHeld(bill)) fail(`${bill.code} 还在等待关联已确认结算，暂不能申请付款`, 'PRECONDITION');
          if (bill.supplierId !== supplierId || bill.currency !== currency) fail(`${bill.code} 与本次申请的供应商或币种不同`);
          const m = minor(row.amount, bill.code + ' 申请金额'), left = billOpenMinor(root, bill) - billRequestedUnpaidMinor(root, bill.id);
          if (m > left) fail(`${bill.code} 可申请金额 ${money(Math.max(0, left), currency)}（未付余额扣除其他未付申请），本次申请超出`);
          total += m; supplier = bill.supplier;
          return { billId: bill.id, billCode: bill.code, invoiceNo: bill.invoiceNo, amount: major(m) };
        });
        let plan: PrepaymentPlan | undefined;
        if (p.planId) {
          plan = s.plans.find(x => x.id === text(p.planId, '付款计划')) || fail('付款计划不存在', 'NOT_FOUND');
          if (plan.state !== 'active' || planStage(plan) === 'prepayment') fail(`${plan.code} 不是有效的进度款 / 尾款计划`, 'PRECONDITION');
          if (!lines.some(l => s.bills.find(b => b.id === l.billId)!.lines.some(x => x.purchaseId === plan!.purchaseId))) fail(`${plan.code} 所属合同 ${plan.purchaseCode} 不在本次申请的票据中`);
          const used = planRequestedMinor(root, plan.id);
          if (used + total > mistMoneyMinor(plan.amount)) fail(`${plan.code} 剩余可申请 ${money(mistMoneyMinor(plan.amount) - used, plan.currency)}，本次申请超出`);
        }
        const snapshot = [
          { label: '申请类型', value: plan ? `供应商票据付款 · ${PLAN_STAGE_LABEL[planStage(plan)]}` : '供应商票据付款' }, { label: '供应商', value: supplier },
          ...lines.map(l => { const b = s.bills.find(x => x.id === l.billId)!, credit = billPrepaymentCreditMinor(root, b); return { label: `${l.billCode} · 发票 ${l.invoiceNo}`, value: `票额 ${money(mistMoneyMinor(b.amount), currency)}${credit ? ` · 预付抵扣 ${money(credit, currency)}` : ''} · 未付 ${money(billOpenMinor(root, b), currency)} · 本次 ${money(mistMoneyMinor(l.amount), currency)} · 到期 ${b.due}（${b.dueBasis}）` }; }),
          ...(plan ? [{ label: '付款计划', value: `${plan.code} · ${money(mistMoneyMinor(plan.amount), plan.currency)} · 触发条件：${plan.trigger}` }] : []),
          { label: '本次申请金额', value: money(total, currency) }, { label: '申请说明', value: reason }, { label: '申请人', value: c.actorName },
        ];
        request = { id, code, purpose: 'bill', supplierId, supplier, currency, amount: major(total), lines, ...(plan ? { planId: plan.id, purchaseId: plan.purchaseId, purchaseCode: plan.purchaseCode } : {}), reason, fileIds, requesterId: c.actorId, requester: c.actorName, submittedAt: c.now, reviewerIds, snapshot, state: 'pending', paymentHistory: [] };
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
      if (payment.purpose === 'prepayment' && payment.purchaseId && purchasePrepaidMinor(root, payment.purchaseId) - mistMoneyMinor(payment.amount) < purchasePrepaymentAppliedMinor(root, payment.purchaseId) + purchasePrepaymentMovedOutMinor(root, payment.purchaseId)) fail(`${payment.code} 的预付款已被结算抵扣、退款或转抵，请先冲回相关记录再冲回付款`, 'PRECONDITION');
      if (payment.purpose === 'settlement' && payment.settlementId && settlementAdvancePaidMinor(root, payment.settlementId) - mistMoneyMinor(payment.amount) < sumMap(settlementAdvanceCreditsMinor(root, payment.settlementId))) fail(`${payment.code} 已抵到供应商票据，请先作废关联票据再冲回付款`, 'PRECONDITION');
      const reason = text(p.reason, '冲回原因', true, 500), rid = c.id();
      for (const a of activeAllocations(root).filter(a => a.supplierPaymentId === payment.id)) s.reversals.push({ id: c.id(), kind: 'allocation', targetId: a.id, parentId: rid, amount: a.amount, currency: a.currency, reason, at: c.now, actor: c.actorName });
      s.reversals.push({ id: rid, kind: 'payment', targetId: payment.id, amount: payment.amount, currency: payment.currency, reason, at: c.now, actor: c.actorName });
      const voucherAccount = root.payments.find(v => v.id === payment.paymentId)?.accountId;
      root.payments.push({ id: c.id(), code: nextCode('PAY', root.payments, c.now), date: today, payee: payment.supplier, amount: -payment.amount, currency: payment.currency, ref: `冲回 ${payment.code} · ${reason}`, ...(voucherAccount ? { accountId: voucherAccount } : {}) } as MistPayment);
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
    case 'payable.settlement.submit': {
      if (!c.actorId) fail('无法识别提交人', 'FORBIDDEN');
      const po = (root.fulfillment?.purchases || []).find(x => x.id === text(p.purchaseId, '来源合同')) || fail('来源合同不存在', 'NOT_FOUND');
      if (po.state !== 'approved') fail(`${po.code} 尚未批准，不能结算`, 'PRECONDITION');
      if (confirmedSettlements(root, po.id).some(x => x.final)) fail(`${po.code} 已完成最终结算；如需更正请由财务冲回最终结算`, 'PRECONDITION');
      if (s.settlements.some(x => x.purchaseId === po.id && x.state === 'pending')) fail(`${po.code} 有待财务复核的结算，请等复核或撤回后再提交`, 'CONFLICT');
      if (!Array.isArray(p.receiptIds) || !p.receiptIds.length || p.receiptIds.length > 100) fail('请选择本次结算对应的实际收货记录');
      const ids = [...new Set((p.receiptIds as unknown[]).map(v => text(v, '收货记录')))];
      if (ids.length !== p.receiptIds.length) fail('同一条收货记录在本次结算中重复出现');
      const receipts = ids.map(id => (root.fulfillment?.receipts || []).find(r => r.id === id) || fail('收货记录不存在', 'NOT_FOUND'));
      for (const r of receipts) { if (r.purchaseId !== po.id) fail('收货记录不属于该合同'); if (receiptSettled(root, r.id)) fail(`${r.date} 的收货记录已在其他结算中`, 'CONFLICT'); }
      const quantity = receipts.reduce((n, r) => n + r.quantity, 0), rejected = receipts.reduce((n, r) => n + r.rejected, 0);
      if (quantity <= 0) fail('所选收货记录没有实收合格数量；拒收数量不计入结算');
      const amount = Math.round(quantity * po.price * 100);
      const live = s.settlements.filter(x => x.purchaseId === po.id && x.state === 'confirmed').reduce((n, x) => n + mistMoneyMinor(x.amount), 0);
      if (live + amount > purchaseContractMinor(po)) fail(`${po.code} 累计结算金额会超过合同金额；超收部分须先走合同变更`);
      if (p.final !== undefined && typeof p.final !== 'boolean') fail('最终结算标记无效');
      if (p.disputes !== undefined && (!Array.isArray(p.disputes) || p.disputes.length > 20)) fail('争议 / 扣款格式无效');
      const disputes = ((p.disputes || []) as SettlementDispute[]).map(d => ({ description: text(d?.description, '争议 / 扣款说明', true, 500), amount: major(minor(d?.amount, '争议 / 扣款金额')) }));
      const id = c.id(), code = nextCode('ST', s.settlements, c.now);
      s.settlements.push({ id, code, purchaseId: po.id, purchaseCode: po.code, supplierId: po.supplierId, supplier: po.supplier, currency: po.currency, unit: po.unit, price: po.price, receiptIds: ids, quantity, rejected, amount: major(amount), final: !!p.final || settledQuantity(root, po.id) + quantity >= po.quantity, disputes, note: text(p.note, '结算说明', false, 1000), fileIds: files(root, p.fileIds), state: 'pending', submitterId: c.actorId, submittedBy: c.actorName, submittedAt: c.now });
      event(root, c, id, `提交 ${po.code} 结算 ${code}（实收 ${quantity} ${po.unit} · ${fx(major(amount))} ${po.currency}），待财务复核`);
      return { id };
    }
    case 'payable.settlement.cancel': {
      const st = s.settlements.find(x => x.id === text(p.id, '结算')) || fail('结算不存在', 'NOT_FOUND');
      if (st.state !== 'pending') fail('只有待复核的结算可以撤回', 'PRECONDITION');
      if (st.submitterId !== c.actorId) fail('只有提交人可以撤回结算', 'FORBIDDEN');
      st.state = 'cancelled'; st.cancelled = { at: c.now, actor: c.actorName, reason: text(p.reason, '撤回原因', true, 500) };
      event(root, c, st.id, `撤回结算 ${st.code}`);
      return { id: st.id };
    }
    case 'payable.settlement.return': {
      const st = s.settlements.find(x => x.id === text(p.id, '结算')) || fail('结算不存在', 'NOT_FOUND');
      if (st.state !== 'pending') fail('结算已处理或已撤回', 'CONFLICT');
      if (st.submitterId === c.actorId) fail('不能复核本人提交的结算', 'FORBIDDEN');
      st.state = 'returned'; st.returned = { at: c.now, actor: c.actorName, reason: text(p.reason, '退回原因', true, 500) };
      event(root, c, st.id, `退回结算 ${st.code}：${st.returned.reason}`);
      return { id: st.id };
    }
    case 'payable.settlement.confirm': {
      const st = s.settlements.find(x => x.id === text(p.id, '结算')) || fail('结算不存在', 'NOT_FOUND');
      if (st.state !== 'pending') fail('结算已处理或已撤回', 'CONFLICT');
      if (!c.actorId || st.submitterId === c.actorId) fail('不能复核本人提交的结算', 'FORBIDDEN');
      if (st.final && confirmedSettlements(root, st.purchaseId).some(x => x.final)) fail(`${st.purchaseCode} 已有最终结算`, 'CONFLICT');
      const po = (root.fulfillment?.purchases || []).find(x => x.id === st.purchaseId) || fail('来源合同不存在', 'NOT_FOUND');
      const live = confirmedSettlements(root, po.id).reduce((n, x) => n + mistMoneyMinor(x.amount), 0);
      if (live + mistMoneyMinor(st.amount) > purchaseContractMinor(po)) fail(`${po.code} 累计结算金额会超过合同金额；超收部分须先走合同变更`);
      const suggested = settlementSuggestedPrepaymentMinor(root, st), applied = minor(p.prepaymentApplied, '本次预付抵扣', true);
      const available = purchasePrepaymentAvailableMinor(root, st.purchaseId);
      if (applied > available) fail(`本次预付抵扣超过合同剩余可抵扣预付 ${fx(major(available))} ${st.currency}`);
      if (applied > mistMoneyMinor(st.amount)) fail('本次预付抵扣不能超过结算金额');
      const adjustReason = text(p.adjustReason, '调整原因', applied !== suggested, 500);
      st.state = 'confirmed'; st.confirmation = { actorId: c.actorId, actor: c.actorName, at: c.now, suggestedPrepayment: major(suggested), prepaymentApplied: major(applied), adjustReason: applied !== suggested ? adjustReason : '', note: text(p.note, '复核意见', false, 1000) };
      event(root, c, st.id, `确认结算 ${st.code}（${fx(st.amount)} ${st.currency}${applied ? `，预付抵扣 ${fx(major(applied))}` : ''}${applied !== suggested ? `，调整原因：${adjustReason}` : ''}）`);
      return { id: st.id };
    }
    case 'payable.settlement.reverse': {
      const st = s.settlements.find(x => x.id === text(p.id, '结算')) || fail('结算不存在', 'NOT_FOUND');
      if (st.state !== 'confirmed') fail('只有已确认的结算可以冲回', 'PRECONDITION');
      if (settlementInvoicedMinor(root, st.id) > 0) fail(`${st.code} 已关联供应商票据，请先作废关联票据再冲回结算`, 'PRECONDITION');
      if (s.requests.some(r => r.purpose === 'settlement' && r.settlementId === st.id && LIVE_REQUEST.includes(r.state))) fail(`${st.code} 有按结算的付款申请或付款，请先撤回申请、冲回付款再冲回结算`, 'PRECONDITION');
      if (st.final && purchasePrepaymentMovedOutMinor(root, st.purchaseId) > 0) fail(`${st.purchaseCode} 的剩余预付已登记退款或转抵，请先冲回这些记录再冲回最终结算`, 'PRECONDITION');
      if (purchasePrepaidMinor(root, st.purchaseId) - purchasePrepaymentAppliedMinor(root, st.purchaseId, st.id) < purchasePrepaymentMovedOutMinor(root, st.purchaseId)) fail('冲回后可抵扣预付会小于已退款 / 转出金额，请先冲回相关记录', 'PRECONDITION');
      st.state = 'reversed'; st.reversed = { at: c.now, actor: c.actorName, reason: text(p.reason, '冲回原因', true, 500) };
      event(root, c, st.id, `冲回结算 ${st.code}：${st.reversed.reason}；收货记录与预付抵扣释放`);
      return { id: st.id };
    }
    case 'payable.bill.link': {
      const bill = s.bills.find(b => b.id === text(p.id, '应付票据')) || fail('应付票据不存在', 'NOT_FOUND');
      if (bill.state === 'void') fail('该票据已作废', 'PRECONDITION');
      if (!billHeld(bill)) fail(`${bill.code} 没有待关联结算的合同行`, 'PRECONDITION');
      if (!Array.isArray(p.links) || !p.links.length || p.links.length > 50) fail('请选择要关联的结算');
      const seen = new Set<string>(); const linked: string[] = [];
      for (const row of p.links as Array<{ purchaseId: string; settlementId: string }>) {
        const purchaseId = text(row?.purchaseId, '来源合同'); if (seen.has(purchaseId)) fail('同一张合同重复出现'); seen.add(purchaseId);
        const line = bill.lines.find(l => l.purchaseId === purchaseId && l.awaitingSettlement && !l.settlementId) || fail('该合同行不在待关联状态', 'PRECONDITION');
        const st = s.settlements.find(x => x.id === text(row.settlementId, '关联结算')) || fail('关联结算不存在', 'NOT_FOUND');
        if (st.purchaseId !== purchaseId) fail(`${st.code} 不属于 ${line.purchaseCode}`);
        if (st.state !== 'confirmed') fail(`${st.code} 尚未经财务确认，不能关联票据`, 'PRECONDITION');
        const left = mistMoneyMinor(st.amount) - settlementInvoicedMinor(root, st.id);
        if (mistMoneyMinor(line.amount) > left) fail(`${st.code} 未开票金额 ${fx(major(Math.max(0, left)))} ${st.currency}，不足以关联 ${line.purchaseCode} 的 ${fx(line.amount)}；如票额跨多笔结算，请取消登记后按结算分行重新登记`);
        line.settlementId = st.id; line.settlementCode = st.code; line.linkedAt = c.now; line.linkedBy = c.actorName; linked.push(st.code);
      }
      event(root, c, bill.id, `票据 ${bill.code} 关联结算 ${linked.join('、')}${billHeld(bill) ? '（仍有合同行待关联）' : '，已形成可付应付'}`);
      return { id: bill.id };
    }
    case 'payable.deduction.register': {
      const recoveryId = text(p.recoveryId, '工厂追偿'), bill = s.bills.find(b => b.id === text(p.billId, '应付票据')) || fail('应付票据不存在', 'NOT_FOUND');
      let claim: ClaimLike | undefined, recovery: NonNullable<ClaimLike['coordination']>['recoveries'][number] | undefined;
      for (const row of claimsOf(root)) { const r = row.coordination?.recoveries.find(x => x.id === recoveryId); if (r) { claim = row; recovery = r; break; } }
      if (!claim || !recovery) return fail('工厂追偿记录不存在', 'NOT_FOUND');
      if (claim.state === 'Closed' || claim.state === 'Cancelled') fail('索赔案件已结束', 'PRECONDITION');
      if (recovery.state !== 'Agreed') fail('须工厂已同意承担、尚未落实的追偿才能从货款中扣', 'PRECONDITION');
      if (recovery.method !== 'deduction' && recovery.method !== 'mixed') fail('工厂同意的补偿方式不是从货款中扣', 'PRECONDITION');
      if (bill.state === 'void') fail(`${bill.code} 已作废`, 'PRECONDITION');
      if (billHeld(bill)) fail(`${bill.code} 还在等待关联已确认结算，暂不能扣款`, 'PRECONDITION');
      if (bill.supplierId !== recovery.supplierId) fail(`${bill.code} 不是追偿工厂 ${recovery.supplierName} 的票据`);
      if (bill.currency !== recovery.currency) fail(`${bill.code} 币种为 ${bill.currency}，与追偿币种 ${recovery.currency} 不同；当前不做汇率换算`);
      const amount = minor(p.amount, '扣款金额'), left = mistMoneyMinor(recovery.agreed || 0) - recoveryDeductedMinor(root, recovery.id);
      if (amount > left) fail(`该追偿还可扣 ${fx(major(Math.max(0, left)))} ${recovery.currency}，本次扣款超出`);
      const room = billOpenMinor(root, bill) - billRequestedUnpaidMinor(root, bill.id);
      if (amount > room) fail(`${bill.code} 可扣金额 ${fx(major(Math.max(0, room)))} ${bill.currency}（未付扣除待付申请），本次扣款超出`);
      const id = c.id(), code = nextCode('DD', s.deductions, c.now), reference = text(p.reference, '扣款依据（扣款通知 / 对账单）', true, 200);
      s.deductions.push({ id, code, supplierId: bill.supplierId, supplier: bill.supplier, currency: bill.currency, amount: major(amount), claimId: claim.id, claimCode: claim.code, recoveryId: recovery.id, billId: bill.id, billCode: bill.code, reference, note: text(p.note, '备注', false, 500), at: c.now, actor: c.actorName });
      const done = recovery.method === 'deduction' && amount === left;
      if (done) {
        const codes = s.deductions.filter(d => !d.reversed && d.recoveryId === recovery!.id).map(d => d.code);
        recovery.state = 'Settled'; recovery.settled = recovery.agreed; recovery.settledRef = '应付扣款 ' + codes.join('、'); recovery.settledDate = today;
        recovery.events.push({ at: c.now, by: c.actorName, action: 'settle', note: '从货款中扣满 ' + recovery.currency + ' ' + fx(major(mistMoneyMinor(recovery.agreed || 0))) + ' · ' + codes.join('、') });
        for (const t of root.tasks) if (t.kind === 'claim-recovery:' + recovery.id && t.target.id === claim.id) t.done = true;
      } else recovery.events.push({ at: c.now, by: c.actorName, action: 'deduct', note: `应付扣款 ${code} · ${bill.code} · ${recovery.currency} ${fx(major(amount))}` });
      root.events.unshift({ id: c.id(), entityType: 'claim', entityId: claim.id, at: c.now, actor: c.actorName, text: `财务从 ${bill.code} 扣工厂补偿 ${recovery.currency} ${fx(major(amount))}（${code}）${done ? '，追偿已落实' : ''}`, fileIds: [] });
      event(root, c, bill.id, `登记索赔扣款 ${code}：${claim.code} · ${fx(major(amount))} ${bill.currency}`);
      return { id };
    }
    case 'payable.deduction.reverse': {
      const d = s.deductions.find(x => x.id === text(p.id, '索赔扣款')) || fail('索赔扣款不存在', 'NOT_FOUND');
      if (d.reversed) fail(`${d.code} 已冲回`, 'PRECONDITION');
      const claim = claimsOf(root).find(x => x.id === d.claimId), recovery = claim?.coordination?.recoveries.find(r => r.id === d.recoveryId);
      if (claim && (claim.state === 'Closed' || claim.state === 'Cancelled')) fail('索赔案件已结束，不能冲回扣款；请人工核对与工厂的往来', 'PRECONDITION');
      if (recovery?.state === 'Settled' && !(recovery.settledRef || '').startsWith('应付扣款')) fail('该追偿已由协调人登记实际落实（含本笔扣款），不能单独冲回扣款；请人工核对与工厂的往来', 'PRECONDITION');
      const reason = text(p.reason, '冲回原因', true, 500);
      d.reversed = { at: c.now, actor: c.actorName, reason };
      if (recovery) {
        if (recovery.state === 'Settled' && (recovery.settledRef || '').startsWith('应付扣款')) { recovery.state = 'Agreed'; delete recovery.settled; delete recovery.settledRef; delete recovery.settledDate; }
        recovery.events.push({ at: c.now, by: c.actorName, action: 'deduct-reverse', note: `冲回应付扣款 ${d.code}：${reason}` });
        root.events.unshift({ id: c.id(), entityType: 'claim', entityId: d.claimId, at: c.now, actor: c.actorName, text: `冲回应付扣款 ${d.code}：${reason}；追偿回到工厂已同意、待落实`, fileIds: [] });
      }
      event(root, c, d.billId, `冲回索赔扣款 ${d.code}：${reason}`);
      return { id: d.id };
    }
    case 'payable.prepayment.refund':
    case 'payable.prepayment.transfer': {
      const po = (root.fulfillment?.purchases || []).find(x => x.id === text(p.purchaseId, '来源合同')) || fail('来源合同不存在', 'NOT_FOUND');
      if (po.state !== 'cancelled' && !confirmedSettlements(root, po.id).some(x => x.final)) fail(`${po.code} 还没有已确认的最终结算，也未取消；剩余预付须在最终结算或合同取消后才能退款或转抵`, 'PRECONDITION');
      const available = purchasePrepaymentAvailableMinor(root, po.id), amount = minor(p.amount, command.type === 'payable.prepayment.refund' ? '退款金额' : '转抵金额');
      if (amount > available) fail(`${po.code} 剩余预付 ${fx(major(available))} ${po.currency}，本次超出`);
      const reason = text(p.reason, command.type === 'payable.prepayment.refund' ? '退款说明' : '转抵依据', true, 500), id = c.id(), code = nextCode('PM', s.prepaymentMoves, c.now);
      const base = { id, code, purchaseId: po.id, purchaseCode: po.code, supplierId: po.supplierId, supplier: po.supplier, currency: po.currency, amount: major(amount), reason, at: c.now, actor: c.actorName };
      if (command.type === 'payable.prepayment.refund') {
        const date = day(p.date, '到账日期'); if (date > today) fail('到账日期不能在未来');
        const reference = text(p.reference, '银行流水号 / 参考号', true, 120);
        if (s.prepaymentMoves.some(m => m.kind === 'refund' && !m.reversed && m.supplierId === po.supplierId && key(m.reference) === key(reference))) fail(`流水号 ${reference} 已登记过这家供应商的退款`, 'CONFLICT');
        const paymentId = c.id();
        root.payments.push({ id: paymentId, code: nextCode('PAY', root.payments, c.now), date, payee: po.supplier, amount: -major(amount), currency: po.currency, ref: `供应商退回预付 ${po.code} · ${reference}` } as MistPayment);
        s.prepaymentMoves.push({ ...base, kind: 'refund', date, reference, paymentId });
        event(root, c, id, `登记 ${po.code} 剩余预付退款 ${code}（${fx(major(amount))} ${po.currency} · ${reference}）`);
      } else {
        const target = prepaymentTransferTargets(root, po.id).find(x => x.id === text(p.targetPurchaseId, '转入合同')) || fail('转入合同须为同一供应商、同币种、已批准且未最终结算的合同', 'PRECONDITION');
        s.prepaymentMoves.push({ ...base, kind: 'transfer', targetPurchaseId: target.id, targetPurchaseCode: target.code, date: today, reference: '' });
        event(root, c, id, `${po.code} 剩余预付 ${fx(major(amount))} ${po.currency} 转抵到 ${target.code}（${code}）`);
      }
      return { id };
    }
    case 'payable.prepayment.reverse': {
      const m = s.prepaymentMoves.find(x => x.id === text(p.id, '剩余预付处理')) || fail('剩余预付处理记录不存在', 'NOT_FOUND');
      if (m.reversed) fail(`${m.code} 已冲回`, 'PRECONDITION');
      if (m.kind === 'transfer' && m.targetPurchaseId && purchasePrepaymentAvailableMinor(root, m.targetPurchaseId) < mistMoneyMinor(m.amount)) fail(`${m.targetPurchaseCode} 已使用转入的预付（结算抵扣、退款或再转出），请先冲回这些记录`, 'PRECONDITION');
      const reason = text(p.reason, '冲回原因', true, 500);
      m.reversed = { at: c.now, actor: c.actorName, reason };
      const refundAccount = root.payments.find(v => v.id === m.paymentId)?.accountId;
      if (m.kind === 'refund') root.payments.push({ id: c.id(), code: nextCode('PAY', root.payments, c.now), date: today, payee: m.supplier, amount: m.amount, currency: m.currency, ref: `冲回退款登记 ${m.code} · ${reason}`, ...(refundAccount ? { accountId: refundAccount } : {}) } as MistPayment);
      event(root, c, m.id, `冲回剩余预付${m.kind === 'refund' ? '退款' : '转抵'} ${m.code}：${reason}`);
      return { id: m.id };
    }
    case 'payable.payment.backfill': {
      // 系统上线前已付、没有付款申请的款：按凭证补登到付款计划的对应一期，不再补走审批，留操作人记录；错了可冲回付款。
      const plan = s.plans.find(x => x.id === text(p.planId, '付款计划')) || fail('付款计划不存在', 'NOT_FOUND');
      if (plan.state !== 'active') fail(`${plan.code} 已取消`, 'PRECONDITION');
      const po = (root.fulfillment?.purchases || []).find(x => x.id === plan.purchaseId) || fail('来源合同不存在', 'NOT_FOUND');
      if (po.state !== 'approved') fail(`${po.code} 不在已批准状态，不能补登付款`, 'PRECONDITION');
      const date = day(p.date, '实际付款日期'); if (date > today) fail('付款日期不能在未来');
      const amount = minor(p.amount, '补登金额'), used = planRequestedMinor(root, plan.id);
      if (used + amount > mistMoneyMinor(plan.amount)) fail(`${plan.code} 剩余 ${fx(major(mistMoneyMinor(plan.amount) - used))} ${plan.currency}（已扣除申请和已补登），本次补登超出`);
      const reference = text(p.reference, '付款凭证号 / 银行流水号', true, 120);
      if (s.payments.some(x => x.supplierId === plan.supplierId && key(x.reference) === key(reference) && !paymentReversed(root, x.id))) fail(`凭证号 ${reference} 已登记过这家供应商的付款，请核对是否重复`, 'CONFLICT');
      const stage = planStage(plan); let bill: SupplierBill | undefined;
      if (stage === 'prepayment') { if (p.billId) fail('预付款补登挂在合同上，不分配到票据'); }
      else {
        bill = s.bills.find(b => b.id === text(p.billId, '对应票据（进度款 / 尾款须对应已登记的供应商票据）')) || fail('应付票据不存在', 'NOT_FOUND');
        if (!bill.lines.some(l => l.purchaseId === po.id)) fail(`${bill.code} 不含合同 ${po.code}`);
        const room = billOpenMinor(root, bill) - billRequestedUnpaidMinor(root, bill.id);
        if (amount > room) fail(`${bill.code} 可补登 ${fx(major(Math.max(0, room)))} ${bill.currency}（未付扣除待付申请），本次超出`);
      }
      const id = c.id(), paymentId = c.id(), code = nextCode('PAY', root.payments, c.now);
      root.payments.push({ id: paymentId, code, date, payee: plan.supplier, amount: major(amount), currency: plan.currency, ref: reference } as MistPayment);
      const payment: SupplierPayment = { id, paymentId, code, supplierId: plan.supplierId, supplier: plan.supplier, date, amount: major(amount), currency: plan.currency, reference, fileIds: files(root, p.fileIds), note: text(p.note, '补登说明', false, 1000), createdAt: c.now, actor: c.actorName, purpose: stage === 'prepayment' ? 'prepayment' : 'bill', planId: plan.id, backfill: true, ...(stage === 'prepayment' ? { purchaseId: po.id } : {}) };
      s.payments.push(payment);
      if (bill) allocate(root, c, payment, [{ billId: bill.id, amount: major(amount) }]);
      event(root, c, id, `历史补登付款 ${code}：${plan.code} ${PLAN_STAGE_LABEL[stage]} · ${fx(major(amount))} ${plan.currency} · 凭证 ${reference} · 付款日 ${date}（系统上线前已付，未走付款申请）`);
      return { id };
    }
    case 'payable.payment.plan': {
      const payment = s.payments.find(x => x.id === text(p.supplierPaymentId, '供应商付款')) || fail('供应商付款不存在', 'NOT_FOUND');
      if (payment.requestId || payment.backfill) fail('按申请付款或历史补登的付款已随申请 / 补登对应计划', 'PRECONDITION');
      if (paymentReversed(root, payment.id)) fail(`${payment.code} 已冲回`, 'PRECONDITION');
      if (p.planId === null || p.planId === '') {
        if (!payment.planLinked) fail(`${payment.code} 没有对应付款计划`, 'PRECONDITION');
        const old = s.plans.find(x => x.id === payment.planId); delete payment.planId; delete payment.planLinked;
        event(root, c, payment.id, `取消旧付款 ${payment.code} 与计划 ${old?.code || ''} 的对应`);
        return { id: payment.id };
      }
      if (payment.planId) fail(`${payment.code} 已对应计划，请先取消对应`, 'PRECONDITION');
      const plan = s.plans.find(x => x.id === text(p.planId, '付款计划')) || fail('付款计划不存在', 'NOT_FOUND');
      if (plan.state !== 'active') fail(`${plan.code} 已取消`, 'PRECONDITION');
      if (plan.supplierId !== payment.supplierId || plan.currency !== payment.currency) fail(`${plan.code} 与这笔付款的供应商或币种不同`);
      if (planStage(plan) === 'prepayment') { if (payment.purpose !== 'prepayment' || payment.purchaseId !== plan.purchaseId) fail(`${payment.code} 不是合同 ${plan.purchaseCode} 的预付款`); }
      else if (payment.purpose === 'prepayment' || !activeAllocations(root).some(a => a.supplierPaymentId === payment.id && s.bills.find(b => b.id === a.billId)?.lines.some(l => l.purchaseId === plan.purchaseId))) fail(`${payment.code} 没有分配到合同 ${plan.purchaseCode} 的票据，不能对应${PLAN_STAGE_LABEL[planStage(plan)]}计划`);
      const used = planRequestedMinor(root, plan.id);
      if (used + mistMoneyMinor(payment.amount) > mistMoneyMinor(plan.amount)) fail(`${plan.code} 剩余 ${fx(major(mistMoneyMinor(plan.amount) - used))} ${plan.currency}，这笔付款 ${fx(payment.amount)} 超出`);
      payment.planId = plan.id; payment.planLinked = { at: c.now, actor: c.actorName, note: text(p.note, '对应说明', false, 500) };
      event(root, c, payment.id, `旧付款 ${payment.code} 对应到${PLAN_STAGE_LABEL[planStage(plan)]}计划 ${plan.code}`);
      return { id: payment.id };
    }
    case 'payable.purchase.cancel': {
      // 合同未执行即取消：没有收货、结算、票据和在途付款申请；已付预付须选择让工厂退款或转抵到其他合同。
      const po = (root.fulfillment?.purchases || []).find(x => x.id === text(p.purchaseId, '采购合同')) || fail('采购合同不存在', 'NOT_FOUND');
      if (po.state !== 'approved') fail(po.state === 'cancelled' ? `${po.code} 已取消` : `${po.code} 尚未批准；草稿或待审批的单据直接修改或退回即可`, 'PRECONDITION');
      if ((root.fulfillment?.receipts || []).some(r => r.purchaseId === po.id)) fail(`${po.code} 已有收货记录，不能直接取消；请走结算或拒收退换`, 'PRECONDITION');
      if (s.settlements.some(x => x.purchaseId === po.id && (x.state === 'pending' || x.state === 'confirmed'))) fail(`${po.code} 有待复核或已确认的结算，不能取消`, 'PRECONDITION');
      if (s.bills.some(b => b.state === 'open' && b.lines.some(l => l.purchaseId === po.id))) fail(`${po.code} 已登记供应商票据，请先由财务作废票据`, 'PRECONDITION');
      const planIds = new Set(s.plans.filter(x => x.purchaseId === po.id).map(x => x.id));
      if (s.requests.some(r => (r.state === 'pending' || r.state === 'approved') && (r.purchaseId === po.id || (r.planId && planIds.has(r.planId))))) fail(`${po.code} 有待审批或已批准未付的付款申请，请先撤回`, 'PRECONDITION');
      const reason = text(p.reason, '取消原因', true, 1000), prepaid = purchasePrepaymentAvailableMinor(root, po.id);
      let disposition: Pick<NonNullable<typeof po.cancellation>, 'prepayment' | 'targetPurchaseId' | 'targetPurchaseCode'> = {};
      if (prepaid > 0) {
        if (p.prepayment !== 'refund' && p.prepayment !== 'transfer') fail(`${po.code} 已付预付 ${fx(major(prepaid))} ${po.currency}，请选择让工厂退款，或转抵到这家工厂的其他合同`);
        if (p.prepayment === 'transfer') {
          const target = prepaymentTransferTargets(root, po.id).find(x => x.id === text(p.targetPurchaseId, '转抵合同')) || fail('转抵合同须为同一供应商、同币种、已批准且未最终结算的合同', 'PRECONDITION');
          disposition = { prepayment: 'transfer', targetPurchaseId: target.id, targetPurchaseCode: target.code };
        } else disposition = { prepayment: 'refund' };
      }
      po.state = 'cancelled'; po.cancellation = { at: c.now, actor: c.actorName, reason, prepaid: major(prepaid), ...disposition };
      for (const plan of s.plans.filter(x => x.purchaseId === po.id && x.state === 'active')) { plan.state = 'cancelled'; plan.cancelled = { at: c.now, actor: c.actorName, reason: '合同取消：' + reason }; }
      const tail = prepaid <= 0 ? '' : disposition.prepayment === 'refund' ? `；已付预付 ${fx(major(prepaid))} ${po.currency} 待工厂退回，到账后由财务登记` : `；已付预付 ${fx(major(prepaid))} ${po.currency} 待财务转抵到 ${disposition.targetPurchaseCode}`;
      root.events.unshift({ id: c.id(), entityType: 'procurement', entityId: po.id, at: c.now, actor: c.actorName, text: `合同取消：${reason}${tail}`, fileIds: [] });
      return { id: po.id };
    }
    case 'payable.payment.allocate': {
      const payment = s.payments.find(x => x.id === text(p.supplierPaymentId, '供应商付款')) || fail('供应商付款不存在', 'NOT_FOUND');
      if (paymentReversed(root, payment.id)) fail(`${payment.code} 已冲回，不能再分配`, 'PRECONDITION');
      if (payment.purpose === 'prepayment') fail('预付款等结算确认后抵扣，不能直接分配到票据', 'PRECONDITION');
      if (payment.purpose === 'settlement') fail('按结算先付的款等票据关联结算后自动抵扣，不能直接分配', 'PRECONDITION');
      if (!Array.isArray(p.allocations) || !p.allocations.length) fail('请选择要分配的票据');
      const applied = allocate(root, c, payment, p.allocations);
      event(root, c, payment.id, `分配付款 ${payment.code} 到 ${applied} 张票据`);
      return { id: payment.id, applied };
    }
  }
  return fail('未知应付操作');
}
