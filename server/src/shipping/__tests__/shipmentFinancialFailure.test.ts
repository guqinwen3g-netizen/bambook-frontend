import { describe, expect, it } from 'vitest';
import { financialFailure } from '../shipmentFinancialAuthority';

describe('financial source failure preserves deliberate public detail only', () => {
  it('typed gate details survive the actual native adapter without changing their shape', () => {
    const details = { blockedBy: ['ORDER_NOT_CONFIRMED'], shipmentId: 'synthetic-shipment' };
    const error = Object.assign(new Error('当前订单尚未确认，不能排柜。'), { code: 'GATE_BLOCKED', statusCode: 409, details });
    expect(financialFailure(error, 'LIST_FAILED')).toEqual({ ok: false, error: { code: 'GATE_BLOCKED',
      message: '当前订单尚未确认，不能排柜。', status: 409, details } });
  });
  it('typed refusal without details does not invent an empty public detail field', () => {
    const error = Object.assign(new Error('原运单不存在。'), { code: 'SHIPMENT_NOT_FOUND', statusCode: 404 });
    const actual = financialFailure(error, 'LIST_FAILED');
    expect(actual.error.status).toBe(404);
    expect(Object.prototype.hasOwnProperty.call(actual.error, 'details')).toBe(false);
  });
  it('untyped storage detail is withheld; batch-list failure stays safe and contextual', () => {
    const actual = financialFailure(Object.assign(new Error('SQL P2003 private_credentials'),
      { details: { internalTable: 'private_credentials' } }), 'LIST_FAILED');
    expect(actual.error.status).toBe(500); expect(actual.error.code).toBe('LIST_FAILED');
    expect(actual.error.message).toContain('批次');
    expect(JSON.stringify(actual)).not.toMatch(/SQL|P2003|private_credentials|internalTable/);
    expect(Object.prototype.hasOwnProperty.call(actual.error, 'details')).toBe(false);
  });
});
