import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerInternalTradeFlowTools,
  buildInternalTradeCreateDraft,
  buildInternalTradeConfirmDraft,
} from '../internalTradeFlow';

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

registerInternalTradeFlowTools();

// Dispatcher/service-spy seam: approval requester and trusted runtime identity
// are explicit. This fixture does not qualify native authorization or approvals.
const executionContext = (userId: string) => ({ actorId: userId, actor: {
  userId, roles: [], departmentIds: [], permissionScopes: ['order:internal_trade:write'],
  permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: [],
} });

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

describe('internal_trade create/confirm executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('internal_trade.create approved → committed', async () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    mocks.createInternalTransfer.mockResolvedValue({
      ok: true,
      data: { transfer: { id: 'OIT_M1' }, mirror: { id: 'OIT_R1' }, approvalRequestId: 'AR-BIZ-1', payload: { status: 'PendingConfirm' } },
    });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', requesterId: 'usr_1', status: 'approved', actionType: 'tool:internal_trade.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.create', input: {}, approvalId: 'AP-1' } as any, executionContext('usr_1'));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.transferId).toBe('OIT_M1');
    expect(result.domainApprovalId).toBe('AR-BIZ-1');
    expect(mocks.createInternalTransfer).toHaveBeenCalledTimes(1);
  });

  it('internal_trade.confirm approved → committed', async () => {
    const draft = buildInternalTradeConfirmDraft({ transferId: 'OIT_M1', actorId: 'usr_fabric' });
    mocks.confirmInternalTransfer.mockResolvedValue({ ok: true, data: { transfer: { id: 'OIT_M1' }, payload: { status: 'Effective' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', requesterId: 'usr_fabric', status: 'approved', actionType: 'tool:internal_trade.confirm', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.confirm', input: {}, approvalId: 'AP-2' } as any, executionContext('usr_fabric'));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.transferStatus).toBe('Effective');
    expect(mocks.confirmInternalTransfer).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'internal_trade.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.confirm', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.confirmInternalTransfer).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildInternalTradeCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), settlementPrice: 0.01 } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:internal_trade.create', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createInternalTransfer).not.toHaveBeenCalled();
  });
});
