import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerOrderChangesFlowTools,
  buildOrderChangeCreateDraft,
  buildOrderChangeWithdrawDraft,
} from '../orderChangesFlow';

const mocks = vi.hoisted(() => ({
  createChangeRequest: vi.fn(),
  withdrawChangeRequest: vi.fn(),
  authorizeActor: vi.fn(),
}));

vi.mock('../../customerConfirmations/customerConfirmationService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, currentCustomerConfirmationActor: mocks.authorizeActor };
});

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

registerOrderChangesFlowTools();

const actor: any = { userId: 'usr_1', roles: ['sales'], departmentIds: [],
  permissionScopes: ['order:change_request:create'], permissionsAuthoritative: true,
  memoryScopes: [], knowledgeScopes: [], toolScopes: [] };

const createInput = {
  orderId: 'ORD-1',
  changeType: 'quantity',
  beforeSnapshot: { quantity: 200 },
  afterDelta: { quantity: 180 },
  changeReason: '客户要求减少订单数量以匹配实际产能',
  impactSummary: '数量减少 20 件，金额同步下调',
  requesterId: 'usr_1',
};

describe('order_changes create/withdraw executeTool commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeActor.mockImplementation(async (_prisma: any, prior: any, requiredScope: string) => {
      if (!prior?.userId) throw Object.assign(new Error('missing actor'), { code: 'UNAUTHORIZED' });
      if (prior.permissionCeiling && !prior.permissionCeiling.includes('*') && !prior.permissionCeiling.includes(requiredScope))
        throw Object.assign(new Error('ceiling denied'), { code: 'FORBIDDEN' });
      return { ...prior, permissions: [requiredScope], authorizationLoaded: true };
    });
  });

  it('order_changes.create approved → committed', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    mocks.createChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_1', requestNumber: 'OCR-1' }, approvalRequestId: 'AR-BIZ-1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:order_changes.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any, { actor });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.changeRequestId).toBe('OCR_1');
    expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createChangeRequest).toHaveBeenCalledWith(expect.objectContaining({
      requesterId: 'usr_1', trustedActor: expect.objectContaining({ userId: 'usr_1' }),
    }));
  });

  it('order_changes.withdraw approved → committed', async () => {
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_1', actorId: 'usr_1' });
    mocks.withdrawChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_1', status: 'Cancelled' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'approved', actionType: 'tool:order_changes.withdraw', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.withdraw', input: {}, approvalId: 'AP-2' } as any, { actor });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(mocks.withdrawChangeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.withdrawChangeRequest).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'usr_1', actorRoles: ['sales'], trustedActor: expect.objectContaining({ userId: 'usr_1' }),
    }));
  });

  it('valid approval cannot be replayed or committed without a trusted runtime actor', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    const findApproval = vi.fn().mockResolvedValue({ id: 'AP-1', requesterId: 'usr_1', status: 'approved',
      actionType: 'tool:order_changes.create', payload: { processDraft: draft } });
    const receiptCreate = vi.fn();
    const prisma = { approvalRequest: { findUnique: findApproval }, agentCommitReceipt: { create: receiptCreate } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.errorFeedback.code).toBe('UNAUTHORIZED');
    expect(findApproval).not.toHaveBeenCalled();
    expect(receiptCreate).not.toHaveBeenCalled();
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('rechecks current DB capability and preserves the credential ceiling before receipt replay', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    const receiptCreate = vi.fn();
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', requesterId: 'usr_1', status: 'approved',
      actionType: 'tool:order_changes.create', payload: { processDraft: draft } }) }, agentCommitReceipt: { create: receiptCreate } } as any;
    const ceilingActor = { ...actor, permissionCeiling: ['orders:read'] };
    const result: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any,
      { actor: ceilingActor });
    expect(result.errorFeedback.code).toBe('FORBIDDEN');
    expect(receiptCreate).not.toHaveBeenCalled();
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();

    mocks.authorizeActor.mockRejectedValueOnce(Object.assign(new Error('scope removed'), { code: 'FORBIDDEN' }));
    const revoked: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any,
      { actor });
    expect(revoked.errorFeedback.code).toBe('FORBIDDEN');
    expect(receiptCreate).not.toHaveBeenCalled();
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'order_changes.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any, { actor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.withdraw', input: {}, approvalId: 'AP-2' } as any, { actor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.withdrawChangeRequest).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildOrderChangeCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), changeReason: '篡改后的理由xxxxxxxxxxxx' } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:order_changes.create', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.create', input: {}, approvalId: 'AP-1' } as any, { actor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createChangeRequest).not.toHaveBeenCalled();
  });

  it('重复注册保持幂等（重复调用 register 不破坏分发）', async () => {
    registerOrderChangesFlowTools();
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId: 'OCR_9', actorId: 'usr_1' });
    mocks.withdrawChangeRequest.mockResolvedValue({ ok: true, data: { changeRequest: { id: 'OCR_9', status: 'Cancelled' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-9', status: 'approved', actionType: 'tool:order_changes.withdraw', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order_changes.withdraw', input: {}, approvalId: 'AP-9' } as any, { actor });
    expect(result.ok).toBe(true);
    expect(result.changeRequestId).toBe('OCR_9');
  });
});
