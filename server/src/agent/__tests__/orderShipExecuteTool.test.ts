import { describe, expect, it, vi } from 'vitest';
import { legacySourceStorage, storageRowLocks } from './shippingLegacyStorageFixture';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildOrderShipDraft } from '../orderShipFlow';

// ============================================================================
// ERP-P1-order-ship: 真实 executeTool + executeAgentTool 行为测试
// ============================================================================

function makeShipCommitTx(order: any = { id: 'O1', status: 'Confirmed', deletedAt: null }) {
  const source = legacySourceStorage();
  return {
    ...source.models,
    $queryRaw: storageRowLocks({ Order: () => order ? [order] : [], OrderLine: () => source.rows.orderLines, ReleaseScope: () => source.rows.releaseScopes }, source.rows.locks),
    shipment: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, orderId: data.orderId })) },
    shipmentEvent: { create: vi.fn().mockResolvedValue({}) },
    order: { findUnique: vi.fn().mockResolvedValue(order), update: vi.fn().mockResolvedValue({}) },
    orderStatusTransition: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe('task order-ship: executeTool order.ship commit 路径', () => {
  it('skipApprovalCheck + approvalId + approved → committed', async () => {
    const draft = buildOrderShipDraft({ orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } });
    const tx = makeShipCommitTx();
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.ship', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, {
      toolId: 'order.ship',
      input: { orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } },
      approvalId: 'AP1',
    } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.shipmentStatus).toBe('Booked');
    // linkOrderStatusFromShipment: Booked → Order Shipping
    expect(tx.orderStatusTransition.create).toHaveBeenCalledTimes(1);
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.ship', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(prisma.approvalRequest.findUnique).not.toHaveBeenCalled();
  });

  it('approval 不存在 → APPROVAL_NOT_FOUND', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.ship', input: {}, approvalId: 'NOPE' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.ship', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.ship', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });
});

describe('task order-ship: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft', async () => {
    let createdApproval: any = null;
    const prisma = {
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'user1', role: 'admin', id: 'user1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor,
      toolId: 'order.ship',
      toolInput: { orderId: 'O1', shipment: { shipmentNumber: 'S1', shippingMethod: 'FCL', status: 'Booked' } },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(result.processDraft.subOperations[0].after.orderId).toBe('O1');
    // ProcessDraft 写入 ApprovalRequest payload
    expect(createdApproval.payload.processDraft).toBeTruthy();
    expect(createdApproval.payload.processDraft.subOperations[0].after.orderId).toBe('O1');
  });

  it('首次调用缺 shipmentNumber → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'user1', role: 'admin', id: 'user1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor,
      toolId: 'order.ship',
      toolInput: { orderId: 'O1', shipment: { shippingMethod: 'FCL' } },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('ORDER_SHIP_PRECONDITIONS_FAILED');
  });
});
