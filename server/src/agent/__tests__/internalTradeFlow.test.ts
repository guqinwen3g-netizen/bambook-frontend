import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInternalTradeCreateDraft,
  commitInternalTradeCreate,
  buildInternalTradeConfirmDraft,
  commitInternalTradeConfirm,
  validateInternalTradeCreateDraftSemantics,
  validateInternalTradeConfirmDraftSemantics,
  buildInternalTradeFlowError,
  type InternalTradeFlowErrorCode,
  registerInternalTradeFlowTools,
} from '../internalTradeFlow';
import type { TokenPayload } from '../../auth/service';
import type { ActorContext } from '../types';
import { dispatchFromRegistry } from '../toolDispatchRegistry';

// Storage/service-spy seam only; opt-in PG exercises actual authority and writes.
const createActor: TokenPayload = { userId: 'usr_1', roles: [], departmentIds: [], permissions: ['order:internal_trade:write'], authorizationLoaded: true };
const confirmActor: TokenPayload = { ...createActor, userId: 'usr_fabric' };
const createAuthority = { originalRequesterId: 'usr_1', trustedActor: createActor };
const confirmAuthority = { originalRequesterId: 'usr_fabric', trustedActor: confirmActor };

const mocks = vi.hoisted(() => ({
  createInternalTransfer: vi.fn(),
  confirmInternalTransfer: vi.fn(),
}));

vi.mock('../../internalTrade/internalTransferService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createInternalTransferService: () => ({
      createInternalTransfer: mocks.createInternalTransfer,
      confirmInternalTransfer: mocks.confirmInternalTransfer,
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
  requestDepartmentId: 'DEPT_GARMENT',
  supplyDepartmentId: 'DEPT_FABRIC',
  garmentOrderId: 'ORD_G1',
  fabricOrderId: 'ORD_F1',
  materialCode: 'FAB-40S-POPLIN',
  quantity: 5000,
  settlementPrice: 12.5,
  dueDate: '2026-09-15',
  requesterId: 'usr_1',
};

describe('internalTradeFlow create/confirm draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create draft 含 ProcessDraft 六字段 + toolId/action', () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('internal_trade.create');
    expect(draft.subOperations[0].action).toBe('create_internal_transfer');
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'orderInternalTransfer', entityId: 'ORD_G1', field: 'status', before: null, after: 'PendingConfirm' });
    expect(draft.impactScope).toEqual(['internalTrade', 'orders', 'finance', 'approvals', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey).toContain('internal_trade.create:ORD_G1:pd:');
  });

  it('create commit 成功复用 createInternalTransfer service', async () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    mocks.createInternalTransfer.mockResolvedValue({
      ok: true,
      data: { transfer: { id: 'OIT_M1' }, mirror: { id: 'OIT_R1' }, approvalRequestId: 'AR-BIZ-1', payload: { status: 'PendingConfirm' } },
    });
    const r = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, ...createAuthority });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.transferId).toBe('OIT_M1');
      expect(r.feedback.mirrorId).toBe('OIT_R1');
      expect(r.feedback.domainApprovalId).toBe('AR-BIZ-1');
    }
    expect(mocks.createInternalTransfer).toHaveBeenCalledWith(expect.objectContaining({
      garmentOrderId: 'ORD_G1', fabricOrderId: 'ORD_F1', quantity: 5000, settlementPrice: 12.5, requesterId: 'usr_1',
    }));
  });

  it('create hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), settlementPrice: 0.01 } }] };
    const r = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled();
  });

  it('create 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('create 语义校验：缺必填字段 / 非法数量 / 双方订单相同 → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateInternalTradeCreateDraftSemantics(buildInternalTradeCreateDraft({ input: { ...createInput, materialCode: '' } })).ok).toBe(false);
    expect(validateInternalTradeCreateDraftSemantics(buildInternalTradeCreateDraft({ input: { ...createInput, quantity: 0 } })).ok).toBe(false);
    expect(validateInternalTradeCreateDraftSemantics(buildInternalTradeCreateDraft({ input: { ...createInput, fabricOrderId: 'ORD_G1' } })).ok).toBe(false);
  });

  it('create service 返回 TRANSFER_ALREADY_EXISTS → failed + 错误码透传', async () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    mocks.createInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'TRANSFER_ALREADY_EXISTS', message: '方向唯一冲突', statusCode: 409 } });
    const r = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, ...createAuthority });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('TRANSFER_ALREADY_EXISTS');
  });

  it('confirm draft 含 status diff + irreversible=true', () => {
    const draft = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric' });
    expect(draft.subOperations[0].toolId).toBe('internal_trade.confirm');
    expect(draft.subOperations[0].action).toBe('confirm_internal_transfer');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'orderInternalTransfer', entityId: 'OIT_M1', field: 'status', before: 'PendingConfirm', after: 'Effective' });
    expect(draft.irreversible).toBe(true);
    expect(draft.idempotencyKey).toContain('internal_trade.confirm:OIT_M1:pd:');
  });

  it('confirm commit 成功复用 confirmInternalTransfer service', async () => {
    const draft = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric', confirmedQuantity: 5000 });
    mocks.confirmInternalTransfer.mockResolvedValue({ ok: true, data: { transfer: { id: 'OIT_M1' }, payload: { status: 'Effective' } } });
    const r = await commitInternalTradeConfirm({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft }, ...confirmAuthority });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.transferStatus).toBe('Effective');
    expect(mocks.confirmInternalTransfer).toHaveBeenCalledWith({ id: 'OIT_M1', actorId: 'usr_fabric', confirmedQuantity: 5000, confirmedDueDate: undefined, trustedActor: confirmActor });
  });

  it('confirm hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { transferId: 'OIT_M2', actorId: 'usr_fabric' } }] };
    const r = await commitInternalTradeConfirm({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.confirmInternalTransfer).not.toHaveBeenCalled();
  });

  it('confirm 语义校验：缺 transferId / 非法 confirmedQuantity → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateInternalTradeConfirmDraftSemantics(buildInternalTradeConfirmDraft({ transferId: '', actorId: 'usr_fabric' })).ok).toBe(false);
    expect(validateInternalTradeConfirmDraftSemantics(buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric', confirmedQuantity: -1 })).ok).toBe(false);
  });

  it('confirm service 返回 SETTLEMENT_PRICE_NOT_APPROVED → failed + 错误码透传', async () => {
    const draft = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric' });
    mocks.confirmInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'SETTLEMENT_PRICE_NOT_APPROVED', message: '结算价未批准', statusCode: 409 } });
    const r = await commitInternalTradeConfirm({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft }, ...confirmAuthority });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('SETTLEMENT_PRICE_NOT_APPROVED');
  });

  it('所有 error code 有 userAction', () => {
    const codes: InternalTradeFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'MISSING_REQUIRED_FIELD', 'GARMENT_ORDER_NOT_FOUND', 'FABRIC_ORDER_NOT_FOUND',
      'FABRIC_ORDER_NOT_INTERNAL_TRADE', 'GARMENT_ORDER_INTERNAL_CONFLICT', 'SAME_ORDER_CONFLICT',
      'INVALID_QUANTITY', 'INVALID_SETTLEMENT_PRICE', 'INVALID_DUE_DATE', 'TRANSFER_ALREADY_EXISTS',
      'TRANSFER_NOT_FOUND', 'INVALID_TRANSFER_STATE', 'SETTLEMENT_PRICE_NOT_APPROVED',
      'SHIPMENT_NOT_FOUND', 'SHIPMENT_NOT_OF_FABRIC_ORDER', 'INVALID_DELIVERY_QUANTITY',
      'OVER_DELIVERY', 'NO_REVIEWER_RESOLVED', 'INTERNAL_ERROR',
    ];
    for (const code of codes) expect(buildInternalTradeFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });

  it('hash-valid draft identity cannot replace the original real approval requester', async () => {
    const create = buildInternalTradeCreateDraft({ input: { ...createInput, requesterId: 'other-current-privileged-user' } });
    const confirm = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'other-current-privileged-user' });
    const created = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: create }, ...createAuthority });
    const confirmed = await commitInternalTradeConfirm({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: confirm }, ...confirmAuthority });
    expect(created).toMatchObject({ ok: false, feedback: { error: { code: 'FORBIDDEN' } } });
    expect(confirmed).toMatchObject({ ok: false, feedback: { error: { code: 'FORBIDDEN' } } });
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled(); expect(mocks.confirmInternalTransfer).not.toHaveBeenCalled();
  });

  it('missing runtime credential fails closed; body trustedActor and permissions do not substitute', async () => {
    const draft = buildInternalTradeCreateDraft({ input: { ...createInput, trustedActor: createActor, permissionCeiling: ['*'] } });
    const result = await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, originalRequesterId: 'usr_1' });
    expect(result).toMatchObject({ ok: false, feedback: { error: { code: 'FORBIDDEN' } } });
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled();
  });

  it('permitted different executor keeps original draft binding and uses only its own capped principal', async () => {
    const trustedActor: TokenPayload = { ...createActor, userId: 'actual-permitted-executor', permissionCeiling: [] };
    const create = buildInternalTradeCreateDraft({ input: createInput });
    const confirm = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric' });
    mocks.createInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'actual execution cap is empty', statusCode: 403 } });
    mocks.confirmInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'actual execution cap is empty', statusCode: 403 } });
    expect(await commitInternalTradeCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: create }, originalRequesterId: 'usr_1', trustedActor })).toMatchObject({ ok: false });
    expect(await commitInternalTradeConfirm({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: confirm }, originalRequesterId: 'usr_fabric', trustedActor })).toMatchObject({ ok: false });
    expect(mocks.createInternalTransfer).toHaveBeenCalledWith(expect.objectContaining({ requesterId: trustedActor.userId, trustedActor }));
    expect(mocks.confirmInternalTransfer).toHaveBeenCalledWith(expect.objectContaining({ actorId: trustedActor.userId, trustedActor }));
    expect(create.subOperations[0].after.requesterId).toBe('usr_1'); expect(confirm.subOperations[0].after.actorId).toBe('usr_fabric');
  });

  it.each(['internal_trade.create', 'internal_trade.confirm'] as const)('registered %s forwards fourth-argument trusted actor and preserves explicit empty cap', async toolId => {
    registerInternalTradeFlowTools();
    const actor: ActorContext = { userId: 'actual-executor', roles: [], departmentIds: [], permissionScopes: ['order:internal_trade:write'], permissionsAuthoritative: true, permissionCeiling: [], memoryScopes: [], knowledgeScopes: [], toolScopes: ['internal_trade'] };
    const draft = toolId === 'internal_trade.create' ? buildInternalTradeCreateDraft({ input: createInput }) : buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_1' });
    const storage: any = { approvalRequest: { findUnique: vi.fn(async () => ({ id: 'AP-dispatch', status: 'approved', requesterId: 'usr_1', actionType: `tool:${toolId}`, payload: { processDraft: draft } })) } };
    mocks.createInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'cap blocks', statusCode: 403 } });
    mocks.confirmInternalTransfer.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'cap blocks', statusCode: 403 } });
    const result = await dispatchFromRegistry(storage, { toolId, input: { actor: createActor }, approvalId: 'AP-dispatch' }, { actor });
    expect(result).toMatchObject({ hit: true, result: { ok: false, errorFeedback: { code: 'FORBIDDEN' } } });
    const called = toolId === 'internal_trade.create' ? mocks.createInternalTransfer : mocks.confirmInternalTransfer;
    expect(called).toHaveBeenCalledWith(expect.objectContaining({ ...(toolId === 'internal_trade.create' ? { requesterId: actor.userId } : { actorId: actor.userId }), trustedActor: expect.objectContaining({ userId: actor.userId, permissionCeiling: [], authorizationLoaded: true }) }));
  });
});
