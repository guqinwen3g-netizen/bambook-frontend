import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildOrderStatusTransitionDraft, buildOrderDeleteDraft } from '../orderLifecycleFlow';

vi.mock('../../orders/orderLifecycleService', () => ({
  deleteOrder: vi.fn(),
  transitionOrderStatus: vi.fn(),
  VALID_ORDER_STATUSES: ['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'],
}));
import { deleteOrder, transitionOrderStatus } from '../../orders/orderLifecycleService';

describe('task order-lifecycle-flow: executeTool commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('order.status_transition approved → committed', async () => {
    const draft = buildOrderStatusTransitionDraft({ orderId: 'ORD__1', toStatus: 'Confirmed', currentStatus: 'Pending' });
    (transitionOrderStatus as any).mockResolvedValue({ ok: true, data: { order: { id: 'ORD__1' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.status_transition', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.status_transition', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('order.status_transition 无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.status_transition', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('order.status_transition approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.status_transition', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('order.status_transition approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.status_transition', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('order.delete approved → committed', async () => {
    const draft = buildOrderDeleteDraft({ orderId: 'ORD__1' });
    (deleteOrder as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('order.delete 无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.delete', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('no service bypass：executeTool 只调 service', async () => {
    const draft = buildOrderDeleteDraft({ orderId: 'ORD__1' });
    (deleteOrder as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.delete', payload: { processDraft: draft } }) } } as any;
    await executeTool(prisma, { toolId: 'order.delete', input: {}, approvalId: 'AP1' } as any);
    expect(deleteOrder).toHaveBeenCalledTimes(1);
  });
});

describe('task order-lifecycle-flow: executeAgentTool draft→approval', () => {
  it('order.status_transition 首次调用 → approval_required', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD__1', status: 'Pending', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.status_transition', toolInput: { orderId: 'ORD__1', toStatus: 'Confirmed' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(result.processDraft.beforeAfterDiff[0].before).toBe('Pending');
  });

  it('order.delete 首次调用 → approval_required', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      order: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD__1', deletedAt: null }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.delete', toolInput: { orderId: 'ORD__1' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('order.delete');
  });

  it('order.status_transition 缺参数 → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.status_transition', toolInput: { orderId: 'ORD__1' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });
});
