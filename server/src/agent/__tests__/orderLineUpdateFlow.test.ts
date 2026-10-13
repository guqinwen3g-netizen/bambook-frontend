import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildOrderLineUpdateDraft,
  validateOrderLineUpdateDraftSemantics,
  verifyOrderLineUpdateDraftHash,
  commitOrderLineUpdate,
  buildOrderLineUpdateError,
  type OrderLineUpdateFlowErrorCode,
} from '../orderLineUpdateFlow';

vi.mock('../../orders/orderLineMutationService', () => ({
  updateOrderLine: vi.fn(),
}));
import { updateOrderLine } from '../../orders/orderLineMutationService';

describe('task order-line-update-flow: buildOrderLineUpdateDraft', () => {
  it('生成含 lineId+patch 的 ProcessDraft（before 从真实 snapshot 读）', () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 }, currentSnapshot: { quantity: 100 } });
    expect(draft.subOperations[0].toolId).toBe('order.line_update');
    expect((draft.subOperations[0].after as any).lineId).toBe('ORD__1__0010');
    expect((draft.subOperations[0].after as any).patch.quantity).toBe(200);
    expect(draft.beforeAfterDiff[0].before).toBe(100);
    expect(draft.beforeAfterDiff[0].after).toBe(200);
  });
});

describe('task order-line-update-flow: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    expect(verifyOrderLineUpdateDraftHash(draft).ok).toBe(true);
  });
  it('篡改 patch → hash 不匹配', () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, patch: { quantity: 999 } } }] };
    expect(verifyOrderLineUpdateDraftHash(tampered).ok).toBe(false);
  });
});

describe('task order-line-update-flow: validateSemantics（fail closed）', () => {
  it('缺 lineId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { patch: { quantity: 1 } } }], idempotencyKey: 't' } as any;
    expect(validateOrderLineUpdateDraftSemantics(draft).ok).toBe(false);
  });
  it('空 patch → INVALID_INPUT', () => {
    const draft = { subOperations: [{ after: { lineId: 'L1', patch: {} } }], idempotencyKey: 't' } as any;
    const r = validateOrderLineUpdateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_INPUT');
  });
});

describe('task order-line-update-flow: commitOrderLineUpdate（复用 service）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitOrderLineUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('成功 commit → committed', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: true, data: { line: { id: 'ORD__1__0010' }, auditId: 'a1' } });
    const r = await commitOrderLineUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(updateOrderLine).toHaveBeenCalledTimes(1);
  });

  it('service 失败（ORDER_LINE_NOT_FOUND）→ failed', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: false, error: { code: 'ORDER_LINE_NOT_FOUND', message: 'not found' } });
    const r = await commitOrderLineUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_LINE_NOT_FOUND');
  });

  it('no service bypass：只调 updateOrderLine', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: true, data: { line: { id: 'ORD__1__0010' }, auditId: 'a1' } });
    await commitOrderLineUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(updateOrderLine).toHaveBeenCalledTimes(1);
  });
});

describe('task order-line-update-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: OrderLineUpdateFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'INVALID_INPUT', 'ORDER_NOT_FOUND', 'ORDER_LINE_NOT_FOUND', 'DUPLICATE_ITEM_NO', 'CREATE_LINE_FAILED', 'UPDATE_LINE_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildOrderLineUpdateError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
