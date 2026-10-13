import { describe, it, expect } from 'vitest';
import {
  parseErrorCode,
  userActionForCode,
  buildOrderConfirmError,
  type OrderConfirmErrorCode,
} from '../feedbackContract';

describe('P1-C feedbackContract: parseErrorCode 稳定错误码', () => {
  const cases: Array<{ input: string; expected: OrderConfirmErrorCode }> = [
    { input: 'does not support modified', expected: 'APPROVAL_MODIFIED_UNSUPPORTED' },
    { input: 'not approved (status=rejected)', expected: 'APPROVAL_REJECTED' },
    { input: 'not found or not approved', expected: 'APPROVAL_NOT_FOUND' },
    { input: 'approvalId not provided', expected: 'APPROVAL_ID_MISSING' },
    { input: 'no approved process draft', expected: 'PROCESS_DRAFT_MISSING' },
    { input: 'hash mismatch (expected abc, got def)', expected: 'PROCESS_DRAFT_HASH_MISMATCH' },
    { input: 'semantic validation failed: MISSING_FINANCE_CREATE_INVOICE', expected: 'SEMANTIC_VALIDATION_FAILED' },
    { input: 'PRECONDITIONS_FAILED: MISSING_CUSTOMER_RELATION', expected: 'PRECONDITIONS_FAILED' },
    { input: 'ORDER_NOT_FOUND: poNumber=PO-001', expected: 'ORDER_NOT_FOUND' },
    { input: 'STATUS_DRIFT: expected Pending, actual Confirmed', expected: 'STATUS_DRIFT' },
    { input: 'INVOICE_AMOUNT_INVALID: amount=0', expected: 'INVOICE_AMOUNT_INVALID' },
    { input: 'INVOICE_CURRENCY_MISSING', expected: 'INVOICE_CURRENCY_MISSING' },
    { input: 'COMMIT_TRANSACTION_FAILED: DB error', expected: 'COMMIT_TRANSACTION_FAILED' },
    { input: 'COMMIT_FAILED: unknown reason', expected: 'COMMIT_TRANSACTION_FAILED' },
    { input: 'some unrecognized error', expected: 'UNKNOWN_ERROR' },
  ];

  for (const { input, expected } of cases) {
    it(`"${input.slice(0, 40)}" -> ${expected}`, () => {
      expect(parseErrorCode(input)).toBe(expected);
    });
  }
});

describe('P1-C feedbackContract: userActionForCode 覆盖所有 code', () => {
  const allCodes: OrderConfirmErrorCode[] = [
    'APPROVAL_REJECTED', 'APPROVAL_MODIFIED_UNSUPPORTED', 'APPROVAL_NOT_FOUND', 'APPROVAL_ID_MISSING',
    'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'PRECONDITIONS_FAILED',
    'ORDER_NOT_FOUND', 'STATUS_DRIFT', 'INVOICE_AMOUNT_INVALID', 'INVOICE_CURRENCY_MISSING',
    'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR',
  ];
  for (const code of allCodes) {
    it(`${code} 有非空 userAction`, () => {
      const action = userActionForCode(code);
      expect(action).toBeTruthy();
      expect(action.length).toBeGreaterThan(5);
    });
  }
});

describe('P1-C feedbackContract: buildOrderConfirmError 构造', () => {
  it('返回 code + message + userAction + details', () => {
    const err = buildOrderConfirmError('STATUS_DRIFT: expected Pending, actual Confirmed');
    expect(err.code).toBe('STATUS_DRIFT');
    expect(err.message).toContain('STATUS_DRIFT');
    expect(err.userAction).toBeTruthy();
    expect(err.userAction).toContain('刷新');
  });

  it('带 details 透传', () => {
    const err = buildOrderConfirmError('semantic validation failed', ['MISSING_FINANCE_CREATE_INVOICE', 'STATUS_AFTER_NOT_CONFIRMED']);
    expect(err.code).toBe('SEMANTIC_VALIDATION_FAILED');
    expect(err.details).toEqual(['MISSING_FINANCE_CREATE_INVOICE', 'STATUS_AFTER_NOT_CONFIRMED']);
  });
});
