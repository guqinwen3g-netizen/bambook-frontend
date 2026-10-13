import { describe, expect, it } from 'vitest';
import type { OrderConfirmCommitResult, OrderConfirmErrorFeedback } from '../types';
import {
  classifyOrderConfirmFeedback,
  extractOrderConfirmResult,
  extractOrderConfirmErrorFeedback,
  ERROR_CODE_LABEL,
} from './orderConfirmFeedback';

describe('classifyOrderConfirmFeedback', () => {
  it('classifies ok+committed as committed', () => {
    const r: OrderConfirmCommitResult = { ok: true, committed: true, orderId: 'ord_1', invoiceId: 'inv_1' };
    expect(classifyOrderConfirmFeedback(r, false)).toBe('committed');
  });

  it('classifies null result without error as approval_required', () => {
    expect(classifyOrderConfirmFeedback(null, false)).toBe('approval_required');
  });

  it('classifies null result with error as failed', () => {
    expect(classifyOrderConfirmFeedback(null, true)).toBe('failed');
  });

  it('classifies result with errorFeedback as failed', () => {
    const r: OrderConfirmCommitResult = {
      ok: false, committed: false,
      errorFeedback: { code: 'STATUS_DRIFT', message: 'drift', userAction: '刷新' },
    };
    expect(classifyOrderConfirmFeedback(r, true)).toBe('failed');
  });

  it('classifies result with error string as failed', () => {
    const r: OrderConfirmCommitResult = { ok: false, committed: false, error: 'COMMIT_FAILED: ...' };
    expect(classifyOrderConfirmFeedback(r, true)).toBe('failed');
  });

  it('P1-C 契约化：errorFeedback 存在即 failed，即使 block.error 为空', () => {
    // 场景：block.errorPreview 存在但 block.error 为空（P1-C 稳定失败信号）
    const fb: OrderConfirmErrorFeedback = { code: 'STATUS_DRIFT', message: 'drift', userAction: '刷新' };
    expect(classifyOrderConfirmFeedback(null, false, fb)).toBe('failed');
  });

  it('P1-C 契约化：errorFeedback 存在 + result 也不影响 failed 判定', () => {
    const fb: OrderConfirmErrorFeedback = { code: 'STATUS_DRIFT', message: 'drift', userAction: '刷新' };
    const r: OrderConfirmCommitResult = { ok: false, committed: false };
    expect(classifyOrderConfirmFeedback(r, false, fb)).toBe('failed');
  });

  it('P1-C 契约化：无 errorFeedback + 无 error + 无 result → approval_required', () => {
    expect(classifyOrderConfirmFeedback(null, false, null)).toBe('approval_required');
  });

  // P1-D §3.3: APPROVAL_REJECTED 走中性 rejected（用户主动拒绝，非系统错误）
  it('P1-D: APPROVAL_REJECTED 分类为 rejected（中性态，非 failed）', () => {
    const fb: OrderConfirmErrorFeedback = { code: 'APPROVAL_REJECTED', message: 'rejected', userAction: '重新发起' };
    expect(classifyOrderConfirmFeedback(null, true, fb)).toBe('rejected');
  });

  it('P1-D: APPROVAL_REJECTED 即使 result 存在也分类为 rejected', () => {
    const fb: OrderConfirmErrorFeedback = { code: 'APPROVAL_REJECTED', message: 'rejected', userAction: '重新发起' };
    const r: OrderConfirmCommitResult = { ok: false, committed: false };
    expect(classifyOrderConfirmFeedback(r, true, fb)).toBe('rejected');
  });
});

// P1-D runtime QA: 基于真实 backend E2E payload（agentLoop.e2e.test.ts fixture）验证三态
describe('P1-D runtime QA: 真实 E2E payload 三态验证', () => {
  // committed 态：对齐 agentLoop.e2e.test.ts L88-133 的真实 outputPreview
  const committedPayload: OrderConfirmCommitResult = {
    ok: true, committed: true,
    orderId: 'order_real_id', poNumber: 'PO-001',
    previousStatus: 'Pending', newStatus: 'Confirmed',
    transactionId: 'tx_e2e_123',
    invoiceId: 'INV_e2e_1', invoiceNumber: 'INV-20260628-123456',
    amount: 12000, currency: 'USD',
    customerRelationId: 'rel_001', customerName: 'ACME Corp',
    auditId: 'audit_commit_tx_e2e_123',
    idempotencyKey: 'draft_hash_e2e',
    entityLinks: [
      { linkKind: 'aboutOrder', fromType: 'invoice', fromId: 'INV_e2e_1', toType: 'order', toId: 'order_real_id' },
      { linkKind: 'billTo', fromType: 'invoice', fromId: 'INV_e2e_1', toType: 'relation.organization', toId: 'rel_001' },
    ],
  };

  it('committed: 真实 E2E payload 分类正确', () => {
    expect(classifyOrderConfirmFeedback(committedPayload, false)).toBe('committed');
  });

  it('committed: 含全部 P1-D §2.1 必需结构化字段', () => {
    expect(committedPayload.invoiceNumber).toBe('INV-20260628-123456');
    expect(committedPayload.amount).toBe(12000);
    expect(committedPayload.currency).toBe('USD');
    expect(committedPayload.customerName).toBe('ACME Corp');
    expect(committedPayload.entityLinks).toHaveLength(2);
  });

  // failed 态：对齐 agentLoop.e2e.test.ts L159-190 的真实 errorPreview
  it('failed: STATUS_DRIFT 真实 errorPreview 分类为 failed', () => {
    const fb: OrderConfirmErrorFeedback = {
      code: 'STATUS_DRIFT', message: 'STATUS_DRIFT: expected Pending, actual Confirmed',
      userAction: '订单状态已被并发修改，请刷新订单状态后重新确认。',
    };
    expect(classifyOrderConfirmFeedback(null, true, fb)).toBe('failed');
  });

  it('failed: errorPreview 含稳定 code + userAction（P1-D §5 必需 next-step）', () => {
    const fb: OrderConfirmErrorFeedback = {
      code: 'INVOICE_AMOUNT_INVALID', message: 'amount=0',
      userAction: '发票金额无效（必须 > 0），请检查订单 totalActual/totalNet/quoteAmount。',
    };
    expect(fb.userAction).toContain('请检查');
  });

  // approval_required 态：对齐 agentLoop.e2e.test.ts L78-82
  it('approval_required: 无 outputPreview 无 error 时分类正确', () => {
    expect(classifyOrderConfirmFeedback(null, false, null)).toBe('approval_required');
  });
});

describe('extractOrderConfirmResult', () => {
  it('extracts valid commit result from outputPreview', () => {
    expect(extractOrderConfirmResult({ ok: true, committed: true, orderId: 'ord_1', invoiceId: 'inv_1', invoiceNumber: 'INV-001', amount: 100, currency: 'CNY' })).not.toBeNull();
  });

  it('returns null when ok/committed missing', () => {
    expect(extractOrderConfirmResult({ orderId: 'ord_1' })).toBeNull();
    expect(extractOrderConfirmResult({ ok: true })).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(extractOrderConfirmResult(null)).toBeNull();
    expect(extractOrderConfirmResult('str')).toBeNull();
  });
});

describe('extractOrderConfirmErrorFeedback', () => {
  it('extracts from block metadata errorPreview (agentLoop P1-C path)', () => {
    const meta = { errorPreview: { code: 'STATUS_DRIFT', message: 'drift', userAction: '刷新订单', details: ['expected Pending'] } };
    const fb = extractOrderConfirmErrorFeedback(meta, null);
    expect(fb).not.toBeNull();
    expect(fb!.code).toBe('STATUS_DRIFT');
    expect(fb!.userAction).toContain('刷新');
  });

  it('falls back to result.errorFeedback when no errorPreview', () => {
    const result: OrderConfirmCommitResult = {
      ok: false, committed: false,
      errorFeedback: { code: 'PROCESS_DRAFT_MISSING', message: 'missing', userAction: '重新生成' },
    };
    const fb = extractOrderConfirmErrorFeedback(null, result);
    expect(fb).not.toBeNull();
    expect(fb!.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('returns null when neither available', () => {
    expect(extractOrderConfirmErrorFeedback(null, null)).toBeNull();
    expect(extractOrderConfirmErrorFeedback({}, null)).toBeNull();
  });

  it('ignores malformed errorPreview (missing userAction)', () => {
    const meta = { errorPreview: { code: 'STATUS_DRIFT' } };
    expect(extractOrderConfirmErrorFeedback(meta, null)).toBeNull();
  });
});

describe('ERROR_CODE_LABEL coverage', () => {
  it('provides Chinese label for all stable error codes', () => {
    const codes = [
      'APPROVAL_REJECTED', 'APPROVAL_MODIFIED_UNSUPPORTED', 'APPROVAL_NOT_FOUND', 'APPROVAL_ID_MISSING',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'PRECONDITIONS_FAILED', 'ORDER_NOT_FOUND', 'STATUS_DRIFT', 'INVOICE_AMOUNT_INVALID',
      'INVOICE_CURRENCY_MISSING', 'COMMIT_TRANSACTION_FAILED', 'UNKNOWN_ERROR',
    ] as const;
    for (const code of codes) {
      const label = ERROR_CODE_LABEL[code];
      expect(label).toBeDefined();
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
