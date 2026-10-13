import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildOrderStatusTransitionDraft,
  validateOrderStatusTransitionDraftSemantics,
  commitOrderStatusTransition,
  buildOrderDeleteDraft,
  validateOrderDeleteDraftSemantics,
  commitOrderDelete,
  buildOrderLifecycleError,
  type OrderLifecycleFlowErrorCode,
} from '../orderLifecycleFlow';

vi.mock('../../orders/orderLifecycleService', () => ({
  deleteOrder: vi.fn(),
  transitionOrderStatus: vi.fn(),
  VALID_ORDER_STATUSES: ['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'],
}));
import { deleteOrder, transitionOrderStatus } from '../../orders/orderLifecycleService';
import type { CreditExceptionConsumptionErrorCode } from '../../credit/creditExceptionGate';

describe('finite credit consumption service error boundary', () => {
  const codes: CreditExceptionConsumptionErrorCode[] = ['INVALID_VALID_UNTIL', 'EXCEPTION_CONSUMER_REQUIRED', 'EXCEPTION_NOT_FOUND',
    'EXCEPTION_SCOPE_INVALID', 'EXCEPTION_NOT_FOR_THIS_ENTITY', 'EXCEPTION_ALREADY_CONSUMED', 'EXCEPTION_EXPIRED',
    'EXCEPTION_NOT_ACTIVE', 'EXCEPTION_CONSUME_CONFLICT', 'EXCEPTION_CONSUME_FAILED'];
  it.each(codes)('%s survives the actual flow service-result boundary with meaningful next action', async code => {
    const message = 'Synthetic service denial after its order transaction failed';
    const built = buildOrderLifecycleError(code, message);
    expect(built.code).toBe(code); expect(built.message).toBe(message); expect(built.userAction).toMatch(/范围.*有效期.*次数/);
    expect(built.userAction).not.toMatch(/已回滚|没有改动/); // A generic builder cannot certify DB state.
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    (transitionOrderStatus as any).mockResolvedValueOnce({ ok: false, error: { code, message } });
    const result = await commitOrderStatusTransition({ prisma: {} as any, approvalId: 'AP-credit-boundary', approvalPayload: { processDraft: draft } });
    expect(result.ok).toBe(false); expect((result.feedback as any).error).toEqual(built);
  });
  it('the pre-existing unknown-error fallback does not masquerade as credit rejection or promise rollback', () => {
    const result = buildOrderLifecycleError('UNKNOWN_ERROR', 'Unclassified process state');
    expect(result.code).toBe('UNKNOWN_ERROR'); expect(result.userAction).toBeTruthy(); expect(result.userAction).not.toMatch(/已回滚|没有改动/);
  });
});

describe('task order-lifecycle-flow: buildOrderStatusTransitionDraft', () => {
  it('生成含 orderId+toStatus 的 ProcessDraft（before 用真实 status）', () => {
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    expect(draft.subOperations[0].toolId).toBe('order.status_transition');
    expect((draft.subOperations[0].after as any).orderId).toBe('ORD__1');
    expect((draft.subOperations[0].after as any).toStatus).toBe('Confirmed');
    expect(draft.beforeAfterDiff[0].before).toBe('Pending');
  });
});

describe('task order-lifecycle-flow: buildOrderDeleteDraft', () => {
  it('生成含 orderId 的 ProcessDraft', () => {
    const draft = buildOrderDeleteDraft({ orderId: 'ORD__1' });
    expect(draft.subOperations[0].toolId).toBe('order.delete');
    expect((draft.subOperations[0].after as any).orderId).toBe('ORD__1');
    expect(draft.beforeAfterDiff[0].field).toBe('deletedAt');
  });
});

describe('task order-lifecycle-flow: validateOrderStatusTransitionDraftSemantics（fail closed）', () => {
  it('缺 orderId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { toStatus: 'Confirmed' } }], idempotencyKey: 't' } as any;
    expect(validateOrderStatusTransitionDraftSemantics(draft).ok).toBe(false);
  });
  it('非法 toStatus → INVALID_STATUS', () => {
    const draft = { subOperations: [{ after: { orderId: 'ORD__1', toStatus: 'Cancelled' } }], idempotencyKey: 't' } as any;
    const r = validateOrderStatusTransitionDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_STATUS');
  });
});

describe('task order-lifecycle-flow: commitOrderStatusTransition（复用 service）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitOrderStatusTransition({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('成功 commit → committed', async () => {
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    (transitionOrderStatus as any).mockResolvedValue({ ok: true, data: { order: { id: 'ORD__1' }, auditId: 'a1' } });
    const r = await commitOrderStatusTransition({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(transitionOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('service 失败（ORDER_NOT_FOUND）→ failed', async () => {
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    (transitionOrderStatus as any).mockResolvedValue({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'not found' } });
    const r = await commitOrderStatusTransition({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_NOT_FOUND');
  });

  it('no service bypass：只调 transitionOrderStatus', async () => {
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    (transitionOrderStatus as any).mockResolvedValue({ ok: true, data: { order: { id: 'ORD__1' }, auditId: 'a1' } });
    await commitOrderStatusTransition({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(transitionOrderStatus).toHaveBeenCalledTimes(1);
  });
});

describe('task order-lifecycle-flow: commitOrderDelete（复用 service）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('成功 commit → committed', async () => {
    const draft = buildOrderDeleteDraft({ orderId: 'ORD__1' });
    (deleteOrder as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const r = await commitOrderDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(deleteOrder).toHaveBeenCalledTimes(1);
  });

  it('service 失败（ORDER_ALREADY_DELETED）→ failed', async () => {
    const draft = buildOrderDeleteDraft({ orderId: 'ORD__1' });
    (deleteOrder as any).mockResolvedValue({ ok: false, error: { code: 'ORDER_ALREADY_DELETED', message: 'already' } });
    const r = await commitOrderDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_ALREADY_DELETED');
  });
});

describe('task order-lifecycle-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: OrderLifecycleFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'ORDER_NOT_FOUND', 'ORDER_ALREADY_DELETED', 'INVALID_STATUS', 'NO_CHANGE', 'DELETE_FAILED', 'TRANSITION_FAILED', 'ORDER_MAIN_APPROVAL_REQUIRED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildOrderLifecycleError(code, 'test').userAction.length).toBeGreaterThan(0);
  });

  it('主单审批未通过时给出具体可执行提示', () => {
    const result = buildOrderLifecycleError('ORDER_MAIN_APPROVAL_REQUIRED', '订单必须先通过业务域主单审批，不能直接确认。');
    expect(result.userAction).toContain('先提交并完成订单审批');
  });
});
