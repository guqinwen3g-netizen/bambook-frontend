import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildOrderChangeCreateDraft,
  commitOrderChangeCreate,
  buildOrderChangeWithdrawDraft,
  commitOrderChangeWithdraw,
  validateOrderChangeCreateDraftSemantics,
  buildOrderChangesFlowError,
  type OrderChangesFlowErrorCode,
} from '../orderChangesFlow';

const mocks = vi.hoisted(() => ({
  createChangeRequest: vi.fn(),
  withdrawChangeRequest: vi.fn(),
}));

vi.mock('../../orderChanges/orderChangeRequestService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createOrderChangeRequestService: () => ({
      createChangeRequest: mocks.createChangeRequest,
      withdrawChangeRequest: mocks.withdrawChangeRequest,
    }),
  };
});
vi.mock('../../approvals/approvalRoutingService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalRoutingService: () => ({}) };
});
vi.mock('../../approvals/approvalCreateService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalCreateService: () => ({}) };
});

const createInput = {
  orderId: 'ORD-1',
  changeType: 'quantity',
  beforeSnapshot: { quantity: 200 },
  afterDelta: { quantity: 180 },
  changeReason: '客户要求减少订单数量以匹配实际产能',
  impactSummary: '数量减少 20 件，金额同步下调',
  requesterId: 'usr_1',
};
const actor: any = { userId: 'usr_1', roles: ['sales'], departmentIds: [],
  permissionScopes: ['order:change_request:create'], permissionsAuthoritative: true,
  memoryScopes: [], knowledgeScopes: [], toolScopes: [] };

describe('orderChangesFlow create/withdraw draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create draft 含 ProcessDraft 六字段 + toolId/action + 前后值 diff', () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('order_changes.create');
    expect(draft.subOperations[0].action).toBe('create_order_change_request');
    expect(draft.subOperations[0].before).toEqual({ quantity: 200 });
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'order', entityId: 'ORD-1', field: 'quantity', before: 200, after: 180 });
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'orderChangeRequest', entityId: 'ORD-1', field: 'status', before: null, after: 'Pending' });
    expect(draft.impactScope).toEqual(['orders', 'approvals', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('order_changes.create:ORD-1:pd:');
  });

  it('create commit 成功复用 createChangeRequest service', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    mocks.createChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_1', requestNumber: 'OCR-20260817-001' }, approvalRequestId: 'AR-BIZ-1' } });
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, actor });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.changeRequestId).toBe('OCR_1');
      expect(r.feedback.domainApprovalId).toBe('AR-BIZ-1');
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(mocks.createChangeRequest).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'ORD-1', changeType: 'quantity', requesterId: 'usr_1',
      trustedActor: expect.objectContaining({ userId: 'usr_1' }),
    }));
  });

  it('create rejects a ProcessDraft requester that differs from the trusted executor', async () => {
    const draft = buildOrderChangeCreateDraft({ input: { ...createInput, requesterId: 'spoofed-user' } });
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1',
      approvalPayload: { processDraft: draft }, actor });
    expect(r).toMatchObject({ ok: false, feedback: { error: { code: 'FORBIDDEN' } } });
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('create refuses to commit without a trusted execution actor', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r).toMatchObject({ ok: false, feedback: { error: { code: 'UNAUTHORIZED' } } });
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('create hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), afterDelta: { quantity: 999 } } }] };
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered }, actor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('create 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('create 语义校验：非法 changeType / 空 afterDelta → SEMANTIC_VALIDATION_FAILED', () => {
    const badType = buildOrderChangeCreateDraft({ input: { ...createInput, changeType: 'bogus' } });
    expect(validateOrderChangeCreateDraftSemantics(badType).ok).toBe(false);
    const emptyDelta = buildOrderChangeCreateDraft({ input: { ...createInput, afterDelta: {} } });
    const r = validateOrderChangeCreateDraftSemantics(emptyDelta);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error!.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('create service 返回 ORDER_NOT_APPROVED → failed + 错误码透传', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    mocks.createChangeRequest.mockResolvedValue({ ok: false, error: { code: 'ORDER_NOT_APPROVED', message: '仅已批准订单可发起变更申请', statusCode: 400 } });
    const r = await commitOrderChangeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, actor });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.feedback.error.code).toBe('ORDER_NOT_APPROVED');
      expect(r.feedback.error.userAction.length).toBeGreaterThan(0);
    }
  });

  it('withdraw draft 含 status diff（before snapshot 可选）', () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_1', currentSnapshot: { status: 'Pending' } });
    expect(draft.subOperations[0].toolId).toBe('order_changes.withdraw');
    expect(draft.subOperations[0].action).toBe('withdraw_order_change_request');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'orderChangeRequest', entityId: 'OCR_1', field: 'status', before: 'Pending', after: 'Cancelled' });
    expect(draft.idempotencyKey).toContain('order_changes.withdraw:OCR_1:pd:');
  });

  it('withdraw commit 成功复用 withdrawChangeRequest service', async () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_1' });
    mocks.withdrawChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_1', requestNumber: 'OCR-20260817-001', status: 'Cancelled' } } });
    const r = await commitOrderChangeWithdraw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft }, actor });
    expect(r.ok).toBe(true);
    expect(mocks.withdrawChangeRequest).toHaveBeenCalledWith({ changeRequestId: 'OCR_1', actorId: 'usr_1',
      actorRoles: ['sales'], trustedActor: expect.objectContaining({ userId: 'usr_1' }) });
  });

  it('withdraw ignores a ProcessDraft actorId as authority and injects the actual leader executor', async () => {
    const manager: any = { ...actor, userId: 'leader-1', roles: ['manager'] };
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'requester-1' });
    mocks.withdrawChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_1', status: 'Cancelled' } } });
    const r = await commitOrderChangeWithdraw({ prisma: {} as any, approvalId: 'AP-2',
      approvalPayload: { processDraft: draft }, actor: manager });
    expect(r.ok).toBe(true);
    expect(mocks.withdrawChangeRequest).toHaveBeenCalledWith({ changeRequestId: 'OCR_1', actorId: 'leader-1',
      actorRoles: ['manager'], trustedActor: expect.objectContaining({ userId: 'leader-1' }) });
  });

  it('withdraw refuses to commit without a trusted execution actor', async () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_1' });
    const r = await commitOrderChangeWithdraw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r).toMatchObject({ ok: false, feedback: { error: { code: 'UNAUTHORIZED' } } });
    expect(mocks.withdrawChangeRequest).not.toHaveBeenCalled();
  });

  it('withdraw hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { changeRequestId: 'OCR_1', actorId: 'usr_2' } }] };
    const r = await commitOrderChangeWithdraw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: tampered }, actor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.withdrawChangeRequest).not.toHaveBeenCalled();
  });

  it('withdraw service 返回 WITHDRAW_NOT_BY_REQUESTER → failed + 错误码透传', async () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_2' });
    mocks.withdrawChangeRequest.mockResolvedValue({ ok: false, error: { code: 'WITHDRAW_NOT_BY_REQUESTER', message: '仅申请人本人可撤回', statusCode: 403 } });
    const r = await commitOrderChangeWithdraw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft }, actor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('WITHDRAW_NOT_BY_REQUESTER');
  });

  it('所有 error code 有 userAction', () => {
    const codes: OrderChangesFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'NO_REVIEWER_RESOLVED', 'ORDER_NOT_FOUND', 'ORDER_NOT_APPROVED', 'ORDER_LIFECYCLE_GUARDED',
      'UNAUTHORIZED', 'FORBIDDEN', 'AUTHORIZATION_UNAVAILABLE', 'CUSTOMER_CONFIRMATION_REQUIRED',
      'ORDER_CHANGE_VERSION_MISMATCH', 'REVISION_NOT_ALLOWED', 'AMENDMENT_NOT_ALLOWED',
      'MISSING_BEFORE_AFTER', 'INVALID_CHANGE_TYPE', 'REASON_TOO_SHORT', 'IMPACT_TOO_SHORT',
      'PAUSE_FIELDS_REQUIRED', 'PAUSE_RESUME_DATE_INVALID', 'CHANGE_REQUEST_NOT_FOUND',
      'CHANGE_REQUEST_NOT_PENDING', 'CHANGE_REQUEST_NOT_APPROVED', 'ALREADY_APPLIED',
      'ORDER_SHIPPING_LOCKED', 'WITHDRAW_NOT_BY_REQUESTER', 'ORDER_STATUS_CONFLICT', 'CLOSING_NOT_REQUIRED',
    ];
    for (const code of codes) expect(buildOrderChangesFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
});
