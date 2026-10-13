import { expect, it } from 'vitest';
import { proformaInvoiceHttpError } from '../proformaInvoiceHttpError';

it.each(['NOT_FOUND', 'QUOTATION_NOT_FOUND'])('%s retains the missing-document rejection', code => {
  expect(proformaInvoiceHttpError({ code, message: '原单据不存在' })).toEqual({ status: 404, code, message: '原单据不存在' });
});
it.each(['QUOTATION_NOT_ACCEPTED', 'NOT_PROFORMA', 'ALREADY_CONVERTED', 'INVALID_STATUS'])('%s retains the PI domain rejection instead of borrowing another domain status', code => {
  expect(proformaInvoiceHttpError({ code, message: '原单据状态不允许开票' })).toEqual({ status: 400, code, message: '原单据状态不允许开票' });
});
it('number allocation failure is a server failure, never an invalid-caller response', () => {
  expect(proformaInvoiceHttpError({ code: 'SEQUENCE_FAILED', message: '编号未能生成，请稍后重试' })).toEqual({ status: 500, code: 'SEQUENCE_FAILED', message: '编号未能生成，请稍后重试' });
});
it.each([['LC_GATE_BLOCKED', 403], ['LC_EXCEPTION_CHECK_FAILED', 500]] as const)('%s uses the registered gate tier and safe copy', (code, status) => {
  const result = proformaInvoiceHttpError({ code, message: 'SQL select secret from internal_table' });
  expect(result.status).toBe(status); expect(result.code).toBe(code); expect(result.message).toMatch(/[\u4e00-\u9fff]/); expect(result.message).not.toContain('secret');
});
it.each([{ code: 'FUTURE_FAILURE', message: 'Prisma secret_table' }, { code: 'INTERNAL_ERROR', message: 'SQL secret_table' }, { code: null, message: 'secret_table' }, undefined])('an unknown or internal failure is safe 500 without SQL leakage', error => {
  const result = proformaInvoiceHttpError(error);
  expect(result.status).toBe(500); expect(result.code).toBe('INTERNAL_ERROR'); expect(result.message).toContain('核对原单据'); expect(result.message).not.toContain('secret_table');
});
