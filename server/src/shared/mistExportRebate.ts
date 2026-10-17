/**
 * 出口退税（外贸企业“免退税”口径，2026-10-17 按行业通行做法确定首版；用户已确认实施）。
 *
 * - 退税率版本：财务按 HS 编码登记退税率与生效日（依据财政部/税务总局公告或出口退税率文库）；同一编码可有多个版本，
 *   按报关单出口日期（本系统取出运实际离港日，上海时区）适用“生效日不晚于出口日期的最新版本”；编码按最长前缀匹配。
 *   版本不改写，登错的版本在未被申报使用前作废并写原因。
 * - 申报（配单）：海关已放行且出运已离港的报关单，由财务勾选本票订单对应的供应商增值税专用发票（人民币、税额大于零、未作废、
 *   未被其他有效申报占用）。应退税额 = Σ 发票计税金额（价税合计 − 税额）× 适用退税率，按分取整。首版一张发票整票配一张报关单。
 * - 审核：登记税务机关审核通过（核准）金额；与应退税额不同须写原因（如审核调减）。
 * - 到账：退税款先按银行水单导入到账流水，再在申报上勾稽到账（人民币，可分次）；勾稽占用该笔流水余额，冲回则释放。
 *   到账合计达到核准额（未核准时为应退税额）自动结清；少收时可写原因结清差额。
 * - 撤回：未到账的申报可撤回（写原因），发票与报关单释放，可重新申报。
 * 不代替电子税务局申报，只登记已发生的事实与金额勾稽。
 */
import { MIST_FINANCE_SCOPES } from './mistFinancePermissions';
import { platformBusinessDate } from './mistPlatform';
import type { FulfillmentCustoms } from './mistFulfillment';
import type { SupplierBill } from './mistPayables';
import { MistCommandError, mistMoneyMinor, type MistContext, type MistState } from './mistWorkspace';

export type RebateRate = { id: string; code: string; hsCode: string; rate: string; effectiveFrom: string; basis: string; createdAt: string; actor: string; voided?: { at: string; actor: string; reason: string } };
export type RebateClaimLine = { billId: string; billCode: string; invoiceNo: string; supplier: string; invoiceDate: string; taxable: number; rebate: number };
export type RebateClaimReceipt = { id: string; receiptId: string; receiptCode: string; amount: number; date: string; at: string; actor: string; reversed?: { at: string; actor: string; reason: string } };
export type RebateClaim = {
  id: string; code: string; customsId: string; customsCode: string; declarationNo: string; shipmentId: string; shipmentCode: string; orderIds: string[];
  hsCode: string; exportDate: string; rateId: string; rate: string; lines: RebateClaimLine[]; taxable: number; expected: number;
  filedAt: string; batchRef: string; fileIds: string[]; note: string; state: 'filed' | 'approved' | 'received' | 'withdrawn';
  approved?: { date: string; amount: number; ref: string; reason: string; at: string; actor: string };
  receipts: RebateClaimReceipt[]; settled?: { at: string; actor: string; reason: string };
  withdrawn?: { at: string; actor: string; reason: string }; createdAt: string; actor: string;
};
export type ExportRebateState = { rates: RebateRate[]; claims: RebateClaim[] };
export type ExportRebateCommand =
  | { type: 'rebate.rate.save'; payload: { hsCode: string; rate: string; effectiveFrom: string; basis: string } }
  | { type: 'rebate.rate.void'; payload: { id: string; reason: string } }
  | { type: 'rebate.claim.file'; payload: { customsId: string; billIds: string[]; filedAt: string; batchRef: string; fileIds?: string[]; note?: string } }
  | { type: 'rebate.claim.approve'; payload: { id: string; date: string; amount: number; ref: string; reason?: string } }
  | { type: 'rebate.claim.receive'; payload: { id: string; receiptId: string; amount: number; settle?: boolean; reason?: string } }
  | { type: 'rebate.claim.reverseReceipt'; payload: { id: string; entryId: string; reason: string } }
  | { type: 'rebate.claim.withdraw'; payload: { id: string; reason: string } };
export const REBATE_COMMANDS = ['rebate.rate.save', 'rebate.rate.void', 'rebate.claim.file', 'rebate.claim.approve', 'rebate.claim.receive', 'rebate.claim.reverseReceipt', 'rebate.claim.withdraw'] as const;
export const REBATE_STATE_LABEL: Record<RebateClaim['state'], string> = { filed: '已申报 · 待审核', approved: '已核准 · 待到账', received: '已到账结清', withdrawn: '已撤回' };

type Root = MistState & { exportRebate?: ExportRebateState };
function fail(message: string, code = 'VALIDATION'): never { throw new MistCommandError(code, message); }
const text = (value: unknown, label: string, required = true, max = 2000) => {
  if (value === undefined || value === null || value === '') { if (required) fail(label + '未填写'); return ''; }
  if (typeof value !== 'string' || value.length > max) fail(label + '格式无效');
  const v = value.trim(); if (required && !v) fail(label + '未填写'); return v;
};
const day = (value: unknown, label: string) => { const v = text(value, label); if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) fail(label + '格式无效'); return v; };
const minor = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label + '必须是数字');
  let m = 0; try { m = mistMoneyMinor(value); } catch { fail(label + '最多两位小数'); }
  if (m <= 0) fail(label + '必须大于零');
  return m;
};
const major = (m: number) => m / 100;
const digits = (hs: string) => hs.replace(/\D/g, '');
/** 退税率以字符串保存（如 "13"、"9"、"10.5"），换成万分比整数计算，避免浮点误差。 */
export const rebateRateBasisPoints = (rate: string) => Math.round(Number(rate) * 100);
export const rebateFor = (taxableMinor: number, rate: string) => Math.round(taxableMinor * rebateRateBasisPoints(rate) / 10000);

export const createExportRebateState = (): ExportRebateState => ({ rates: [], claims: [] });
export const readRebate = (root: Pick<Root, 'exportRebate'>): ExportRebateState => ({ rates: root.exportRebate?.rates || [], claims: root.exportRebate?.claims || [] });
const ledger = (root: Root): ExportRebateState => { root.exportRebate ||= createExportRebateState(); root.exportRebate.rates ||= []; root.exportRebate.claims ||= []; return root.exportRebate; };

export function exportRebateCommandPermission(command: ExportRebateCommand): string {
  if (command.type === 'rebate.claim.receive' || command.type === 'rebate.claim.reverseReceipt') return MIST_FINANCE_SCOPES.reconcile;
  if ((REBATE_COMMANDS as readonly string[]).includes(command.type)) return MIST_FINANCE_SCOPES.invoice;
  return fail('未知退税操作');
}

/** 报关单出口日期：本系统以出运实际离港日（上海时区）为准；未离港返回空。 */
export function rebateExportDate(root: Pick<MistState, 'fulfillment'>, customs: FulfillmentCustoms) {
  const s = root.fulfillment?.shipments.find(row => row.id === customs.shipmentId);
  return s?.state === 'departed' && s.departedAt ? platformBusinessDate(s.departedAt) : '';
}
/** 适用退税率：编码最长前缀匹配，同一编码取生效日不晚于出口日期的最新版本；作废版本不参与。 */
export function rebateRateFor(root: Pick<Root, 'exportRebate'>, hsCode: string, date: string): RebateRate | undefined {
  const code = digits(hsCode); if (!code || !date) return undefined;
  return readRebate(root).rates.filter(r => !r.voided && code.startsWith(digits(r.hsCode)) && r.effectiveFrom <= date)
    .sort((a, b) => digits(b.hsCode).length - digits(a.hsCode).length || b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt))[0];
}
export const liveRebateClaims = (root: Pick<Root, 'exportRebate'>) => readRebate(root).claims.filter(c => c.state !== 'withdrawn');
export const rebateClaimForCustoms = (root: Pick<Root, 'exportRebate'>, customsId: string) => liveRebateClaims(root).find(c => c.customsId === customsId);
export const rebateBillTaxableMinor = (bill: Pick<SupplierBill, 'amount' | 'taxAmount'>) => mistMoneyMinor(bill.amount) - mistMoneyMinor(bill.taxAmount);
const shipmentOrderIds = (root: Pick<MistState, 'fulfillment'>, shipmentId: string) => [...new Set((root.fulfillment?.shipments.find(s => s.id === shipmentId)?.lines || []).map(l => l.orderId))];
/** 可配单的进项发票：本票订单的采购合同对应、人民币、税额大于零（增值税专用发票）、未作废、未被其他有效申报占用。 */
export function rebateCandidateBills(root: Root, customs: FulfillmentCustoms): SupplierBill[] {
  const orders = new Set(shipmentOrderIds(root, customs.shipmentId)), purchases = root.fulfillment?.purchases || [];
  const used = new Set(liveRebateClaims(root).flatMap(c => c.lines.map(l => l.billId)));
  return (root.payables?.bills || []).filter(b => b.state === 'open' && b.currency === 'CNY' && mistMoneyMinor(b.taxAmount) > 0 && !used.has(b.id)
    && b.lines.some(l => orders.has(purchases.find(p => p.id === l.purchaseId)?.orderId || '')));
}
const liveReceipts = (claim: RebateClaim) => claim.receipts.filter(r => !r.reversed);
/** 申报金额汇总：核准前以应退税额为基准。 */
export function rebateClaimTotals(claim: RebateClaim) {
  const basis = mistMoneyMinor(claim.approved ? claim.approved.amount : claim.expected), received = liveReceipts(claim).reduce((n, r) => n + mistMoneyMinor(r.amount), 0);
  return { basis: major(basis), received: major(received), open: major(claim.settled ? 0 : Math.max(0, basis - received)), difference: major(received - mistMoneyMinor(claim.expected)) };
}
/** 某笔到账流水被退税勾稽占用的金额（供流水余额重算）。 */
export function rebateReceiptUsedMinor(root: Pick<Root, 'exportRebate'>, receiptId: string) {
  return readRebate(root).claims.reduce((n, c) => n + c.receipts.filter(r => !r.reversed && r.receiptId === receiptId).reduce((m, r) => m + mistMoneyMinor(r.amount), 0), 0);
}
/** 按订单归集退税（人民币）：发票按各采购合同行金额占价税合计的比例分摊到订单；expected 应退、approved 核准（未核准按应退）、received 已到账。 */
export function orderRebate(root: Root, orderId: string) {
  const purchases = root.fulfillment?.purchases || [], bills = root.payables?.bills || [];
  let expected = 0, received = 0, approved = 0;
  for (const claim of liveRebateClaims(root)) {
    const total = mistMoneyMinor(claim.expected); if (!total) continue;
    let share = 0;
    for (const line of claim.lines) {
      const bill = bills.find(b => b.id === line.billId), billTotal = bill ? mistMoneyMinor(bill.amount) : 0; if (!bill || !billTotal) continue;
      const mine = bill.lines.filter(l => purchases.find(p => p.id === l.purchaseId)?.orderId === orderId).reduce((n, l) => n + mistMoneyMinor(l.amount), 0);
      share += mistMoneyMinor(line.rebate) * mine / billTotal;
    }
    if (!share) continue;
    const ratio = share / total, totals = rebateClaimTotals(claim);
    expected += share; approved += mistMoneyMinor(totals.basis) * ratio; received += mistMoneyMinor(totals.received) * ratio;
  }
  return { expected: major(Math.round(expected)), approved: major(Math.round(approved)), received: major(Math.round(received)) };
}

const nextCode = (prefix: string, existing: Array<{ code: string }>, now: string) => {
  const head = prefix + '-' + now.slice(0, 4) + '-'; let n = existing.filter(r => r.code.startsWith(head)).length + 1;
  while (existing.some(r => r.code === head + String(n).padStart(4, '0'))) n++;
  return head + String(n).padStart(4, '0');
};
function event(root: Root, c: MistContext, entityId: string, message: string) { root.events.unshift({ id: c.id(), entityType: 'rebate', entityId, actor: c.actorName, at: c.now, text: message, fileIds: [] }); }
function files(root: Root, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) fail('附件格式无效');
  return [...new Set(value.map(id => { const v = text(id, '附件'); if (!root.files.some(f => f.id === v)) fail('附件不存在，请重新上传'); return v; }))];
}
const claimOf = (s: ExportRebateState, id: unknown) => { const key = text(id, '退税申报'); return s.claims.find(c => c.id === key) || fail('退税申报不存在', 'NOT_FOUND'); };
/** 到账合计达到基准额即结清；冲回后未达基准则回到核准/申报状态。 */
const settleState = (claim: RebateClaim) => {
  if (claim.state === 'withdrawn') return;
  const basis = mistMoneyMinor(claim.approved ? claim.approved.amount : claim.expected), received = liveReceipts(claim).reduce((n, r) => n + mistMoneyMinor(r.amount), 0);
  claim.state = claim.settled || (received > 0 && received >= basis) ? 'received' : claim.approved ? 'approved' : 'filed';
};

export function applyExportRebateCommand(root: Root, command: ExportRebateCommand, c: MistContext): { id: string } {
  const today = platformBusinessDate(c.now), s = ledger(root), p = command.payload as any;
  switch (command.type) {
    case 'rebate.rate.save': {
      const hsCode = text(p.hsCode, 'HS 编码', true, 20); if (!/^[\d.\s]+$/.test(hsCode) || !/^\d{4,10}$/.test(digits(hsCode))) fail('HS 编码须为 4–10 位数字（可含点号）');
      const rate = text(p.rate, '退税率', true, 6); if (!/^\d{1,2}(\.\d{1,2})?$/.test(rate) || Number(rate) > 17) fail('退税率须为 0–17 之间的百分比，最多两位小数');
      const effectiveFrom = day(p.effectiveFrom, '生效日'), basis = text(p.basis, '依据（公告文号或退税率文库版本）', true, 300);
      if (s.rates.some(r => !r.voided && digits(r.hsCode) === digits(hsCode) && r.effectiveFrom === effectiveFrom)) fail(`HS ${hsCode} 在 ${effectiveFrom} 已有生效版本；如登记有误请先作废原版本`, 'CONFLICT');
      const id = c.id();
      s.rates.push({ id, code: nextCode('TR', s.rates, c.now), hsCode, rate: String(Number(rate)), effectiveFrom, basis, createdAt: c.now, actor: c.actorName });
      event(root, c, id, `登记退税率 HS ${hsCode} · ${Number(rate)}%（${effectiveFrom} 起）`);
      return { id };
    }
    case 'rebate.rate.void': {
      const key = text(p.id, '退税率版本'), rate = s.rates.find(r => r.id === key) || fail('退税率版本不存在', 'NOT_FOUND');
      if (rate.voided) fail('该版本已作废', 'PRECONDITION');
      const used = liveRebateClaims(root).find(cl => cl.rateId === rate.id); if (used) fail(`${used.code} 已按该版本申报，不能作废；如申报有误请先撤回申报`, 'PRECONDITION');
      rate.voided = { at: c.now, actor: c.actorName, reason: text(p.reason, '作废原因', true, 500) };
      event(root, c, rate.id, `作废退税率 HS ${rate.hsCode} · ${rate.rate}%：${rate.voided.reason}`);
      return { id: rate.id };
    }
    case 'rebate.claim.file': {
      const customsId = text(p.customsId, '报关单'), customs = (root.fulfillment?.customs || []).find(x => x.id === customsId) || fail('报关单不存在', 'NOT_FOUND');
      if (customs.status !== 'cleared') fail('报关单尚未海关放行，不能申报退税', 'PRECONDITION');
      const shipment = root.fulfillment.shipments.find(x => x.id === customs.shipmentId);
      const exportDate = rebateExportDate(root, customs); if (!exportDate) fail('出运尚未登记实际离港，取得出口日期后才能申报退税', 'PRECONDITION');
      const existing = rebateClaimForCustoms(root, customs.id); if (existing) fail(`报关单已在 ${existing.code} 中申报`, 'CONFLICT');
      const rate = rebateRateFor(root, customs.hsCode, exportDate) || fail(`没有适用于 HS ${customs.hsCode}（出口日期 ${exportDate}）的退税率，请先登记退税率版本`, 'PRECONDITION');
      if (rebateRateBasisPoints(rate.rate) <= 0) fail(`HS ${customs.hsCode} 适用退税率为 0，不能申报退税`, 'PRECONDITION');
      const filedAt = day(p.filedAt, '申报日'); if (filedAt > today) fail('申报日不能在未来'); if (filedAt < exportDate) fail('申报日不能早于出口日期');
      if (!Array.isArray(p.billIds) || !p.billIds.length || p.billIds.length > 50) fail('请至少勾选一张增值税专用发票');
      const candidates = rebateCandidateBills(root, customs), seen = new Set<string>();
      const lines: RebateClaimLine[] = (p.billIds as unknown[]).map(raw => {
        const id = text(raw, '增值税发票'); if (seen.has(id)) fail('同一张发票重复勾选'); seen.add(id);
        const bill = candidates.find(b => b.id === id);
        if (!bill) {
          const any = (root.payables?.bills || []).find(b => b.id === id);
          fail(!any ? '发票不存在' : any.state !== 'open' ? `${any.invoiceNo} 已作废` : any.currency !== 'CNY' ? `${any.invoiceNo} 不是人民币发票` : mistMoneyMinor(any.taxAmount) <= 0 ? `${any.invoiceNo} 税额为零，不是可退税的增值税专用发票` : liveRebateClaims(root).some(cl => cl.lines.some(l => l.billId === id)) ? `${any.invoiceNo} 已被其他退税申报占用` : `${any.invoiceNo} 不属于本票出运的订单采购`, 'PRECONDITION');
        }
        const taxable = rebateBillTaxableMinor(bill);
        return { billId: bill.id, billCode: bill.code, invoiceNo: bill.invoiceNo, supplier: bill.supplier, invoiceDate: bill.invoiceDate, taxable: major(taxable), rebate: major(rebateFor(taxable, rate.rate)) };
      });
      const taxable = lines.reduce((n, l) => n + mistMoneyMinor(l.taxable), 0), expected = lines.reduce((n, l) => n + mistMoneyMinor(l.rebate), 0);
      const batchRef = text(p.batchRef, '申报批次号 / 受理回执号', true, 120);
      const id = c.id(), code = nextCode('RB', s.claims, c.now);
      s.claims.push({ id, code, customsId: customs.id, customsCode: customs.code, declarationNo: customs.declarationNo, shipmentId: customs.shipmentId, shipmentCode: shipment?.code || '', orderIds: shipmentOrderIds(root, customs.shipmentId),
        hsCode: customs.hsCode, exportDate, rateId: rate.id, rate: rate.rate, lines, taxable: major(taxable), expected: major(expected), filedAt, batchRef, fileIds: files(root, p.fileIds), note: text(p.note, '备注', false, 1000), state: 'filed', receipts: [], createdAt: c.now, actor: c.actorName });
      event(root, c, id, `登记退税申报 ${code}：报关单 ${customs.declarationNo} · ${lines.length} 张专票 · 应退 ${major(expected).toFixed(2)} CNY（${rate.rate}%）`);
      return { id };
    }
    case 'rebate.claim.approve': {
      const claim = claimOf(s, p.id);
      if (claim.state !== 'filed') fail(claim.state === 'withdrawn' ? '申报已撤回' : '该申报已登记过审核结果', 'PRECONDITION');
      const date = day(p.date, '核准日'); if (date > today) fail('核准日不能在未来'); if (date < claim.filedAt) fail('核准日不能早于申报日');
      const amount = minor(p.amount, '核准退税额'); if (amount > mistMoneyMinor(claim.expected)) fail('核准退税额不能超过应退税额；如税务机关核定口径不同，请撤回后按实际发票重新申报');
      const reason = text(p.reason, '差异原因', amount !== mistMoneyMinor(claim.expected), 500);
      if (amount < liveReceipts(claim).reduce((n, r) => n + mistMoneyMinor(r.amount), 0)) fail('核准退税额小于已勾稽到账，请先冲回多勾稽的到账');
      claim.approved = { date, amount: major(amount), ref: text(p.ref, '审核通知 / 批复文号', true, 120), reason, at: c.now, actor: c.actorName };
      settleState(claim);
      event(root, c, claim.id, `登记退税核准 ${claim.code}：${major(amount).toFixed(2)} CNY${reason ? `（${reason}）` : ''}`);
      return { id: claim.id };
    }
    case 'rebate.claim.receive': {
      const claim = claimOf(s, p.id);
      if (claim.state === 'withdrawn' || claim.state === 'received') fail(claim.state === 'withdrawn' ? '申报已撤回' : '该申报已到账结清', 'PRECONDITION');
      const receiptId = text(p.receiptId, '到账流水'), receipt = root.receipts.find(r => r.id === receiptId) || fail('到账流水不存在', 'NOT_FOUND');
      if (receipt.currency !== 'CNY') fail('退税款为人民币，请选择人民币到账流水');
      const amount = minor(p.amount, '勾稽金额');
      if (amount > mistMoneyMinor(receipt.remaining)) fail(`流水 ${receipt.code} 未分配余额不足`);
      const open = mistMoneyMinor(rebateClaimTotals(claim).open); if (amount > open) fail(`超过本申报待到账金额 ${major(open).toFixed(2)} CNY；如到账多于核准额请先核对`);
      if (p.settle !== undefined && typeof p.settle !== 'boolean') fail('结清标记无效');
      const reason = p.settle === true && amount < open ? text(p.reason, '少收原因', true, 500) : '';
      const entry: RebateClaimReceipt = { id: c.id(), receiptId: receipt.id, receiptCode: receipt.code, amount: major(amount), date: receipt.date.slice(0, 10), at: c.now, actor: c.actorName };
      claim.receipts.push(entry);
      if (reason) claim.settled = { at: c.now, actor: c.actorName, reason };
      settleState(claim);
      event(root, c, claim.id, `退税到账勾稽 ${claim.code}：流水 ${receipt.code} · ${major(amount).toFixed(2)} CNY${(claim.state as RebateClaim['state']) === 'received' ? '，已结清' : ''}${reason ? `（少收：${reason}）` : ''}`);
      return { id: entry.id };
    }
    case 'rebate.claim.reverseReceipt': {
      const claim = claimOf(s, p.id), entryId = text(p.entryId, '到账勾稽'), entry = claim.receipts.find(r => r.id === entryId) || fail('到账勾稽不存在', 'NOT_FOUND');
      if (entry.reversed) fail('该到账勾稽已冲回', 'PRECONDITION');
      entry.reversed = { at: c.now, actor: c.actorName, reason: text(p.reason, '冲回原因', true, 500) };
      delete claim.settled; settleState(claim);
      const receipt = root.receipts.find(r => r.id === entry.receiptId);
      if (receipt && receipt.state === 'matched') receipt.state = 'unmatched';
      event(root, c, claim.id, `冲回退税到账勾稽 ${claim.code}：流水 ${entry.receiptCode} · ${entry.amount.toFixed(2)} CNY（${entry.reversed.reason}）`);
      return { id: entry.id };
    }
    case 'rebate.claim.withdraw': {
      const claim = claimOf(s, p.id);
      if (claim.state === 'withdrawn') fail('申报已撤回', 'PRECONDITION');
      if (liveReceipts(claim).length) fail('申报已有到账勾稽，请先冲回到账再撤回', 'PRECONDITION');
      claim.withdrawn = { at: c.now, actor: c.actorName, reason: text(p.reason, '撤回原因', true, 500) }; claim.state = 'withdrawn';
      event(root, c, claim.id, `撤回退税申报 ${claim.code}：${claim.withdrawn.reason}`);
      return { id: claim.id };
    }
  }
  return fail('未知退税操作');
}