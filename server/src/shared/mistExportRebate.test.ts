import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistCommand, type MistContext, type MistState } from './mistWorkspace';
import { orderRebate, rebateCandidateBills, rebateClaimTotals, rebateRateFor, readRebate } from './mistExportRebate';
import type { SupplierBill } from './mistPayables';

function setup() {
  let n = 0; const ctx: MistContext = { id: () => `rb-${++n}`, now: '2026-10-17T04:00:00Z', actorName: '林舒', actorId: 'demo-finance' };
  let state = createMistState(ctx, 'demo');
  // 演示数据自带一张专票与退税率；本组用例从空白退税资料开始核对计算。
  state.exportRebate = { rates: [], claims: [] }; state.payables!.bills = state.payables!.bills.filter(b => !b.lines.some(l => state.fulfillment.purchases.find(p => p.id === l.purchaseId)?.kind === 'finished'));
  const order = state.orders.find(o => o.code === 'SO-G-2026-017')!, line = state.orderLines.find(l => l.orderId === order.id)!;
  const customs = state.fulfillment.customs.find(c => state.fulfillment.shipments.find(s => s.id === c.shipmentId)?.state === 'departed')!;
  const po = { ...state.fulfillment.purchases[0], id: 'po-017', code: 'PC-017', orderId: order.id, lineId: line.id, kind: 'finished' as const, state: 'approved' as const };
  state.fulfillment.purchases.push(po);
  const bill = (id: string, invoiceNo: string, amount: number, taxAmount: number, extra: Partial<SupplierBill> = {}): SupplierBill => ({ id, code: 'AP-' + id, supplierId: po.supplierId, supplier: po.supplier, invoiceNo, invoiceDate: '2026-10-10', currency: 'CNY', amount, taxAmount, taxRate: '13%', lines: [{ purchaseId: po.id, purchaseCode: po.code, kind: 'finished', amount }], terms: [], due: '2026-11-10', dueBasis: '月结', fileIds: [], note: '', state: 'open', registeredAt: ctx.now, registeredBy: '林舒', ...extra });
  state.payables!.bills.push(bill('b1', '0451001', 113000, 13000), bill('b2', '0451002', 56500, 6500), bill('b3', '0451003', 10000, 0), bill('b4', '0451004', 1130, 130, { currency: 'USD' }));
  state.receipts.push({ id: 'r-tax', code: 'BR-TAX-01', date: '2026-10-16', payer: '国家金库上海分库', amount: 19500, remaining: 19500, currency: 'CNY', ref: '出口退税', state: 'unmatched' });
  const run = (command: MistCommand) => { const out = applyMistCommand(state, command, ctx); state = out.state; return out.result as { id: string }; };
  return { get state() { return state; }, run, customs, order };
}

describe('出口退税', () => {
  it('演示数据：已离港报关单有一张可配单的 13% 专票与退税率，预计应退 26,000 元', () => {
    const state = createMistState({ id: (() => { let n = 0; return () => `d-${++n}`; })(), now: '2026-10-17T04:00:00Z', actorName: '林舒' }, 'demo');
    const customs = state.fulfillment.customs.find(c => state.fulfillment.shipments.find(s => s.id === c.shipmentId)?.state === 'departed')!;
    const bills = rebateCandidateBills(state, customs);
    expect(bills.map(b => [b.amount, b.taxAmount])).toEqual([[226000, 26000]]);
    expect(rebateRateFor(state, customs.hsCode, '2026-10-13')?.rate).toBe('13');
  });
  it('财务权限：登记与申报用开票权，到账勾稽用核销权', () => {
    expect(mistCommandPermission({ type: 'rebate.rate.save', payload: { hsCode: '620331', rate: '13', effectiveFrom: '2020-03-20', basis: 'x' } })).toBe('invoices:write');
    expect(mistCommandPermission({ type: 'rebate.claim.receive', payload: { id: 'x', receiptId: 'y', amount: 1 } })).toBe('invoices:reconcile');
  });

  it('退税率按出口日期取最新生效版本，编码最长前缀优先，作废版本不参与', () => {
    const f = setup();
    f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203', rate: '9', effectiveFrom: '2019-01-01', basis: '旧公告' } });
    f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203.31', rate: '10', effectiveFrom: '2019-04-01', basis: '公告 A' } });
    const v13 = f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203.31', rate: '13', effectiveFrom: '2020-03-20', basis: '公告 B' } }).id;
    expect(rebateRateFor(f.state, '6203.3100', '2020-03-19')?.rate).toBe('10');
    expect(rebateRateFor(f.state, '6203.3100', '2026-10-13')?.rate).toBe('13');
    expect(rebateRateFor(f.state, '6204.11', '2026-10-13')).toBeUndefined();
    expect(() => f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203.31', rate: '13', effectiveFrom: '2020-03-20', basis: '重复' } })).toThrow('已有生效版本');
    expect(() => f.run({ type: 'rebate.rate.save', payload: { hsCode: '62AB', rate: '13', effectiveFrom: '2020-03-20', basis: 'x' } })).toThrow('HS 编码');
    expect(() => f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203', rate: '18', effectiveFrom: '2020-03-20', basis: 'x' } })).toThrow('0–17');
    f.run({ type: 'rebate.rate.void', payload: { id: v13, reason: '登错生效日' } });
    expect(rebateRateFor(f.state, '6203.3100', '2026-10-13')?.rate).toBe('10');
  });

  it('配单申报 → 核准调减 → 分次到账勾稽占用流水 → 冲回释放 → 少收写原因结清', () => {
    const f = setup();
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b1'], filedAt: '2026-10-16', batchRef: 'SB-01' } })).toThrow('请先登记退税率版本');
    const rate = f.run({ type: 'rebate.rate.save', payload: { hsCode: '6203.31', rate: '13', effectiveFrom: '2020-03-20', basis: '财政部 税务总局公告 2020 年第 15 号' } }).id;
    // 候选只含本票订单的人民币专票；普票（税额 0）与外币票不在其中。
    expect(rebateCandidateBills(f.state, f.customs).map(b => b.id)).toEqual(['b1', 'b2']);
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b3'], filedAt: '2026-10-16', batchRef: 'SB-01' } })).toThrow('税额为零');
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b4'], filedAt: '2026-10-16', batchRef: 'SB-01' } })).toThrow('不是人民币');
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b1'], filedAt: '2026-10-18', batchRef: 'SB-01' } })).toThrow('未来');
    const id = f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b1', 'b2'], filedAt: '2026-10-16', batchRef: 'SB-01' } }).id;
    let claim = readRebate(f.state).claims.find(c => c.id === id)!;
    // 计税金额 100000 + 50000，× 13% = 19500
    expect([claim.taxable, claim.expected, claim.state]).toEqual([150000, 19500, 'filed']);
    expect(orderRebate(f.state, f.order.id)).toEqual({ expected: 19500, approved: 19500, received: 0 });
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b1'], filedAt: '2026-10-16', batchRef: 'SB-02' } })).toThrow('已在');
    expect(() => f.run({ type: 'rebate.rate.void', payload: { id: rate, reason: 'x' } })).toThrow('已按该版本申报');

    expect(() => f.run({ type: 'rebate.claim.approve', payload: { id, date: '2026-10-16', amount: 19000, ref: '核准通知 01' } })).toThrow('差异原因');
    f.run({ type: 'rebate.claim.approve', payload: { id, date: '2026-10-16', amount: 19000, ref: '核准通知 01', reason: '一张发票部分品名不符，审核调减 500' } });
    claim = readRebate(f.state).claims.find(c => c.id === id)!;
    expect([claim.state, rebateClaimTotals(claim).open]).toEqual(['approved', 19000]);

    expect(() => f.run({ type: 'rebate.claim.receive', payload: { id, receiptId: 'r-tax', amount: 19500 } })).toThrow('超过本申报待到账金额');
    const first = f.run({ type: 'rebate.claim.receive', payload: { id, receiptId: 'r-tax', amount: 10000 } }).id;
    expect(f.state.receipts.find(r => r.id === 'r-tax')!.remaining).toBe(9500);
    f.run({ type: 'rebate.claim.reverseReceipt', payload: { id, entryId: first, reason: '勾错流水' } });
    expect(f.state.receipts.find(r => r.id === 'r-tax')!.remaining).toBe(19500);
    expect(() => f.run({ type: 'rebate.claim.receive', payload: { id, receiptId: 'r-tax', amount: 18800, settle: true } })).toThrow('少收原因');
    f.run({ type: 'rebate.claim.receive', payload: { id, receiptId: 'r-tax', amount: 18800, settle: true, reason: '税务机关扣抵滞纳金 200' } });
    claim = readRebate(f.state).claims.find(c => c.id === id)!;
    expect([claim.state, rebateClaimTotals(claim).received, rebateClaimTotals(claim).open, rebateClaimTotals(claim).difference]).toEqual(['received', 18800, 0, -700]);
    expect(f.state.receipts.find(r => r.id === 'r-tax')!.remaining).toBe(700);
    expect(orderRebate(f.state, f.order.id)).toEqual({ expected: 19500, approved: 19000, received: 18800 });
    expect(() => f.run({ type: 'rebate.claim.withdraw', payload: { id, reason: 'x' } })).toThrow('先冲回到账');
  });

  it('到账合计达到核准额自动结清；撤回释放发票后可重新申报', () => {
    const f = setup();
    f.run({ type: 'rebate.rate.save', payload: { hsCode: '620331', rate: '13', effectiveFrom: '2020-03-20', basis: '公告' } });
    const id = f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b2'], filedAt: '2026-10-16', batchRef: 'SB-01' } }).id;
    f.run({ type: 'rebate.claim.receive', payload: { id, receiptId: 'r-tax', amount: 6500 } });
    expect(readRebate(f.state).claims[0].state).toBe('received');
    const entry = readRebate(f.state).claims[0].receipts[0].id;
    f.run({ type: 'rebate.claim.reverseReceipt', payload: { id, entryId: entry, reason: '银行退回' } });
    expect(readRebate(f.state).claims[0].state).toBe('filed');
    f.run({ type: 'rebate.claim.withdraw', payload: { id, reason: '漏配一张专票，撤回重报' } });
    expect(rebateCandidateBills(f.state, f.customs).map(b => b.id)).toEqual(['b1', 'b2']);
    const again = f.run({ type: 'rebate.claim.file', payload: { customsId: f.customs.id, billIds: ['b1', 'b2'], filedAt: '2026-10-17', batchRef: 'SB-02' } }).id;
    expect(readRebate(f.state).claims.find(c => c.id === again)!.expected).toBe(19500);
  });

  it('未放行或未离港的报关单不能申报', () => {
    const f = setup();
    f.run({ type: 'rebate.rate.save', payload: { hsCode: '620331', rate: '13', effectiveFrom: '2020-03-20', basis: '公告' } });
    const state = f.state as MistState; const customs = state.fulfillment.customs.find(c => c.id === f.customs.id)!;
    customs.status = 'submitted';
    expect(() => f.run({ type: 'rebate.claim.file', payload: { customsId: customs.id, billIds: ['b1'], filedAt: '2026-10-16', batchRef: 'SB' } })).toThrow('尚未海关放行');
  });
});
