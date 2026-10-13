import { describe, expect, it, vi } from 'vitest';
import * as allocation from '../../finance/allocationService';
import * as supplier from '../../finance/supplierClaimSettlementGuard';
import * as refund from '../../claims/claimCashRefundFact';
import * as templates from '../../templates/render';
import { executeTool } from '../toolRuntime';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/routeError';

const privateText = 'SQL private table /internal/path';
const invoice = { id: 'invoice', deletedAt: null, status: 'Issued', type: 'Receivable', currency: 'USD', amount: '100' };
const voucher = { id: 'voucher', deletedAt: null, status: 'active', type: 'Receipt', currency: 'USD', amount: '100' };
function facts(change: { invoice?: any; voucher?: any; invoiceUsed?: string; voucherUsed?: string } = {}) {
  return { invoice: { findUnique: vi.fn(async (_args: any) => 'invoice' in change ? change.invoice : invoice) },
    paymentVoucher: { findUnique: vi.fn(async (_args: any) => 'voucher' in change ? change.voucher : voucher) },
    invoiceAllocation: { findMany: vi.fn(async (args: any) => args.where.invoiceId
      ? (change.invoiceUsed ? [{ voucherId: 'other-voucher', appliedAmount: change.invoiceUsed }] : [])
      : (change.voucherUsed ? [{ invoiceId: 'other-invoice', appliedAmount: change.voucherUsed }] : [])) },
    creditNoteAllocation: { findMany: vi.fn(async () => []) } };
}
async function caught(action: () => Promise<unknown>) { try { await action(); throw new Error('expected refusal'); } catch (error) { return error as any; } }
function projection(module: any, name: string, error: unknown) {
  expect(typeof module[name]).toBe('function'); return module[name](error);
}
async function carrier(error: unknown) {
  return executeTool({ $transaction: vi.fn(async () => { throw error; }) } as any,
    { toolId: 'finance.apply_voucher_to_invoice', input: { invoiceId: 'invoice', voucherId: 'voucher', appliedAmount: '20' }, reason: 'native-origin-control' });
}
const localCases: [string, number, string, any, string][] = [
  ['INVOICE_NOT_FOUND', 404, '发票不存在或已删除，请重新选择来源单据。', { invoice: null }, '20'],
  ['INVALID_INVOICE_STATUS', 400, 'invoice invoice status Draft does not allow allocation', { invoice: { ...invoice, status: 'Draft' } }, '20'],
  ['VOUCHER_NOT_FOUND', 404, '收付款凭证不存在或已删除，请重新选择来源凭证。', { voucher: null }, '20'],
  ['INVALID_VOUCHER_STATUS', 400, 'voucher voucher status void does not allow allocation', { voucher: { ...voucher, status: 'void' } }, '20'],
  ['CURRENCY_MISMATCH', 400, 'currency mismatch: invoice USD vs voucher EUR', { voucher: { ...voucher, currency: 'EUR' } }, '20'],
  ['ALLOCATION_DIRECTION_MISMATCH', 409, '发票应收应付方向与实际收付款凭证不一致，请核对原单据。', { voucher: { ...voucher, type: 'Disbursement' } }, '20'],
  ['AMOUNT_EXCEEDS_INVOICE', 400, 'appliedAmount 101 exceeds invoice amount 100', {}, '101'],
  ['AMOUNT_EXCEEDS_VOUCHER', 400, 'appliedAmount 20 exceeds voucher amount 10', { voucher: { ...voucher, amount: '10' } }, '20'],
  ['AMOUNT_EXCEEDS_INVOICE_REMAINING', 400, 'appliedAmount 20 exceeds invoice remaining 10', { invoiceUsed: '90' }, '20'],
  ['AMOUNT_EXCEEDS_VOUCHER_REMAINING', 400, 'appliedAmount 20 exceeds voucher remaining 10', { voucherUsed: '90' }, '20'],
];
describe('actual returned refusal producer provenance', () => {
  it.each(localCases)('actual allocation %s preserves original status/message through actual Agent carrier', async (code, statusCode, message, change, amount) => {
    const tx = facts(change);
    const error = await caught(() => allocation.assertAllocationFacts(tx, 'invoice', 'voucher', amount));
    expect(error).toMatchObject({ code, statusCode, message });
    const copy = projection(allocation, 'readAllocationRefusal', error);
    expect(copy).toEqual({ code, statusCode, message }); expect(Object.isFrozen(copy)).toBe(true);
    expect(await carrier(error)).toEqual({ ok: false, error: code, message });
    expect(tx.invoice.findUnique).toHaveBeenCalledWith({ where: { id: 'invoice' }, select: { id: true, deletedAt: true, status: true, type: true, currency: true, amount: true, customerRelationId: true, customerName: true } });
  });
  it.each(['nonunique', 'changed', 'settlement-race'] as const)('actual SupplierClaim %s preserves code/409/copy and locks', async kind => {
    const observed = { id: 'return', receiptId: 'receipt', claimInvoiceId: 'invoice', deletedAt: null, type: 'claim', status: 'confirmed' };
    const tx = { $queryRawUnsafe: vi.fn(async (_sql: string, _id: string) => kind === 'nonunique' ? [observed, observed] : [observed]),
      materialReturn: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
      invoice: { findUnique: vi.fn(async () => ({ status: 'Issued', amount: '100' })) }, invoiceAllocation: { findMany: vi.fn(async () => []) } };
    const error = await caught(() => kind === 'settlement-race'
      ? supplier.invalidateSupplierClaimSettlement(tx, { ...observed, status: 'settled' }, { invoiceId: 'invoice', triggerId: 'allocation', actorId: 'actor', operation: 'correction' })
      : supplier.lockSupplierClaimInvoice(tx, 'invoice'));
    const message = kind === 'nonunique' ? '索赔贷项的退料来源不唯一或类型不一致，请先核对来源。'
      : kind === 'changed' ? '索赔贷项来源已变化，不能继续核销，请刷新后核对。' : '索赔结算状态发生并发变化，本次更正已回滚，请刷新后重试。';
    expect(error).toMatchObject({ code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409, message });
    expect(projection(supplier, 'readSupplierClaimRefusal', error)).toEqual({ code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409, message });
    expect(await carrier(error)).toEqual({ ok: false, error: 'SOURCE_CLAIM_CONFLICT', message });
    error.message = privateText; error.code = 'FORBIDDEN'; error.statusCode = 403;
    expect(projection(supplier, 'readSupplierClaimRefusal', error)).toEqual({ code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409, message });
    expect(await carrier(error)).toEqual({ ok: false, error: 'SOURCE_CLAIM_CONFLICT', message });
    if (kind === 'changed') expect(tx.$queryRawUnsafe.mock.calls.map(v => v[0])).toEqual([
      'SELECT * FROM "MaterialReturn" WHERE "claimInvoiceId" = $1 AND "deletedAt" IS NULL ORDER BY id',
      'SELECT id FROM "MaterialReceipt" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "MaterialReturn" WHERE id = $1 FOR UPDATE']);
    if (kind === 'settlement-race') expect(tx.materialReturn.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'return', status: 'settled', claimInvoiceId: 'invoice', deletedAt: null } }));
  });
  it.each(['bank-return', 'cash-refund'] as const)('actual persisted %s FK preserves native CashRefund refusal', async kind => {
    const tx = { $queryRawUnsafe: vi.fn(async (_sql: string, _id: string) => []),
      creditNoteRefundReturn: { findUnique: vi.fn(async (_args: any) => kind === 'bank-return' ? { id: 'bank-return' } : null) },
      creditNoteRefund: { findUnique: vi.fn(async (_args: any) => kind === 'cash-refund' ? { id: 'cash-refund' } : null) } };
    const error = await caught(() => refund.assertNotCashRefundVoucher(tx, 'voucher'));
    const message = kind === 'bank-return' ? '实际银行返款收款已恢复原贷项负债，不可再分配发票、改写、作废或删除；请从专用返款事实核对'
      : '客户实付退款凭证不可独立改写、核销、作废或删除；实际银行返款须走后续专用返款流程';
    expect(error).toBeInstanceOf(refund.CashRefundError); expect(error).toMatchObject({ code: 'INVALID_STATE', statusCode: 409, message });
    expect(projection(refund, 'readCashRefundRefusal', error)).toEqual({ code: 'INVALID_STATE', statusCode: 409, message });
    expect(await carrier(error)).toEqual({ ok: false, error: 'INVALID_STATE', message });
    error.message = privateText; error.code = 'FORBIDDEN'; error.statusCode = 403;
    expect(projection(refund, 'readCashRefundRefusal', error)).toEqual({ code: 'INVALID_STATE', statusCode: 409, message });
    expect(await carrier(error)).toEqual({ ok: false, error: 'INVALID_STATE', message });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE', 'voucher');
    expect(tx.creditNoteRefundReturn.findUnique).toHaveBeenCalledWith({ where: { receiptVoucherId: 'voucher' } });
    expect(tx.creditNoteRefund.findUnique).toHaveBeenCalledTimes(kind === 'bank-return' ? 0 : 1);
  });
  it.each([
    ['ordinary', () => new Error(privateText)],
    ['known-code/status/name', () => Object.assign(new Error(privateText), { code: 'CURRENCY_MISMATCH', statusCode: 400, name: 'CashRefundError' })],
    ['actual class but not minted refusal', () => new refund.CashRefundError('INVALID_STATE', privateText)],
    ['plain shape', () => ({ code: 'INVOICE_NOT_FOUND', statusCode: 404, message: privateText })],
  ])('unknown %s cannot acquire native refusal provenance', async (_name, make) => {
    const error = make();
    for (const [module, name] of [[allocation, 'readAllocationRefusal'], [supplier, 'readSupplierClaimRefusal'], [refund, 'readCashRefundRefusal']] as const)
      expect(projection(module, name, error)).toBeUndefined();
    expect(await carrier(error)).toEqual({ ok: false, error: 'ALLOCATION_FAILED', message: GENERIC_ROUTE_ERROR_MESSAGE });
  });
  it('actual minted allocation snapshot survives mutation without publishing changed properties', async () => {
    const error = await caught(() => allocation.assertAllocationFacts(facts({ invoice: null }), 'invoice', 'voucher', '20'));
    const old = { code: error.code, statusCode: error.statusCode, message: error.message };
    error.code = 'FORBIDDEN'; error.statusCode = 403; error.message = privateText; error.details = [privateText];
    expect(projection(allocation, 'readAllocationRefusal', error)).toEqual(old);
    expect(await carrier(error)).toEqual({ ok: false, error: old.code, message: old.message });
    expect(projection(allocation, 'readAllocationRefusal', Object.assign(new Error(privateText), error))).toBeUndefined();
  });
  it('actual template generator catches unknown cause with a fixed public copy and nonserializable internal cause', () => {
    const cause = Object.assign(new Error(privateText), { code: 'FORBIDDEN', statusCode: 403 });
    let error: any;
    try { templates.renderTemplate('invoice.sample.pdas', { get items() { throw cause; } }); } catch (caughtError) { error = caughtError; }
    expect(error).toBeInstanceOf(templates.TemplateRenderError); expect(error.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(error.cause).toBe(cause); expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(error)).not.toContain(privateText);
    expect(projection(templates, 'readTemplateRefusal', error)).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(projection(templates, 'readTemplateRefusal', new templates.TemplateRenderError('invoice.sample.pdas', cause))).toBeUndefined();
    error.message = privateText; expect(projection(templates, 'readTemplateRefusal', error)).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    expect(projection(templates, 'readTemplateRefusal', Object.assign(Object.create(templates.TemplateRenderError.prototype), { message: privateText }))).toBeUndefined();
  });
  it('actual missing template remains an exact known refusal and successful HTML/user data is untouched', () => {
    let error: any; try { templates.renderTemplate('own-missing-id' as any, {}); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(templates.TemplateNotFoundError); expect(error.message).toBe('Template not found: own-missing-id');
    expect(projection(templates, 'readTemplateRefusal', error)).toBe('Template not found: own-missing-id');
    error.message = privateText; expect(projection(templates, 'readTemplateRefusal', error)).toBe('Template not found: own-missing-id');
    const rendered = templates.renderTemplate('invoice.sample.pdas', { invoiceNumber: '用户 SQL /user/path', invoiceDate: '2026-10-03', items: [] });
    expect(rendered.html).toContain('用户 SQL /user/path'); expect(rendered.bytes).toBe(Buffer.byteLength(rendered.html)); expect(rendered.sha).toMatch(/^[0-9a-f]{16}$/);
  });
});
