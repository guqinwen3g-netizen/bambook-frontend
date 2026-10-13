import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService } from '../identity';
import { executeAgentTool, runAgentToolCalls } from '../toolRuntime';

// Real identity/policy/runtime and reviewer resolver. Only storage is replaced:
// these probes do not prove PostgreSQL transactions, JWT freshness, a complete
// business handoff, or a company-specific exception/approval policy.
function storage() {
  const prisma = {
    userAccount: {
      findFirst: vi.fn(async ({ where }: any) => where.id === 'actor-execution'
        ? { id: 'actor-execution', status: 'active', primaryDeptId: 'department-execution' }
        : where.id === 'reviewer-execution' ? { id: 'reviewer-execution', status: 'active' } : null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    department: { findUnique: vi.fn().mockResolvedValue({ id: 'department-execution', status: 'active', headId: 'reviewer-execution', parentId: null }) },
    userRole: { findMany: vi.fn().mockResolvedValue([]) },
    agentTool: { upsert: vi.fn().mockResolvedValue({}) },
    agentToolRun: { create: vi.fn(async ({ data }: any) => data) },
    approvalRequest: { create: vi.fn(async ({ data }: any) => data), findUnique: vi.fn() },
    productAsset: { count: vi.fn().mockResolvedValue(7), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn() },
    relation: { findFirst: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    orderStatusTransition: { create: vi.fn() },
    invoice: { create: vi.fn(), update: vi.fn() },
    paymentVoucher: { create: vi.fn(), update: vi.fn() },
    invoiceAllocation: { create: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(),
  };
  return prisma;
}
function actor(permissions: string[]) {
  return createIdentityService().resolveActorContext({ userId: 'actor-execution', roles: ['manager'], permissions, authorizationLoaded: true });
}
function noBusinessWrites(prisma: ReturnType<typeof storage>) {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  for (const method of [prisma.order.update, prisma.order.create, prisma.orderStatusTransition.create, prisma.invoice.create, prisma.invoice.update, prisma.paymentVoucher.create, prisma.paymentVoucher.update, prisma.invoiceAllocation.create, prisma.invoiceAllocation.upsert, prisma.productAsset.create, prisma.productAsset.update]) expect(method).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External action prohibited in action-authorization probe'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Agent execution action boundary (real runtime with storage substitutes)', () => {
  it.each([{ permissions: ['orders:read'] }, { permissions: [] }])('executeAgentTool denies order write before approval/draft/business access with scopes $permissions', async ({ permissions }) => {
    const prisma = storage();
    await expect(executeAgentTool({ prisma: prisma as any, actor: await actor(permissions), toolId: 'orders.update_status', toolInput: { orderId: 'order-execution', toStatus: 'Confirmed' }, skipApprovalCheck: true })).rejects.toThrow('TOOL_NOT_ALLOWED: INSUFFICIENT_SCOPE: orders:write');
    noBusinessWrites(prisma);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', toolId: 'orders.update_status', actorId: 'actor-execution', error: 'INSUFFICIENT_SCOPE: orders:write' }) });
  });

  it('runAgentToolCalls cannot enter a write handler or approval queue through an orders domain read grant', async () => {
    const prisma = storage();
    const hits = await runAgentToolCalls({ prisma: prisma as any, actor: await actor(['orders:read']), calls: [{ toolId: 'orders.update_status', input: { orderId: 'order-execution', toStatus: 'Confirmed' }, reason: 'scope denial probe' }] });
    expect(hits).toEqual([]);
    noBusinessWrites(prisma);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', error: 'INSUFFICIENT_SCOPE: orders:write' }) });
  });

  it('receipt with only voucher write cannot draft or reconcile an existing voucher', async () => {
    const prisma = storage();
    await expect(executeAgentTool({ prisma: prisma as any, actor: await actor(['vouchers:write']), toolId: 'payment.receive_and_reconcile', toolInput: {}, skipApprovalCheck: true })).rejects.toThrow('TOOL_NOT_ALLOWED: INSUFFICIENT_SCOPE: invoices:reconcile');
    noBusinessWrites(prisma);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('execute boundary forwards actual entity input before a relation read under a product-only grant', async () => {
    const prisma = storage();
    await expect(executeAgentTool({ prisma: prisma as any, actor: await actor(['products:read']), toolId: 'entities.hydrate', toolInput: { refs: [{ entityType: 'relation.person', id: 'other-person' }] } })).rejects.toThrow('TOOL_NOT_ALLOWED: INSUFFICIENT_SCOPE: relations:read');
    expect(prisma.relation.findFirst).not.toHaveBeenCalled();
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    noBusinessWrites(prisma);
  });

  it('loop boundary forwards actual entity input before the same unauthorized relation read', async () => {
    const prisma = storage();
    const hits = await runAgentToolCalls({ prisma: prisma as any, actor: await actor(['products:read']), calls: [{ toolId: 'entities.hydrate', input: { refs: [{ entityType: 'relation.person', id: 'other-person' }] }, reason: 'input-dependent scope probe' }] });
    expect(hits).toEqual([]);
    expect(prisma.relation.findFirst).not.toHaveBeenCalled();
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', error: 'INSUFFICIENT_SCOPE: relations:read' }) });
    noBusinessWrites(prisma);
  });

  it('generic records query does not expose an unsupported payroll model (not proof of a future salary dual-scope boundary)', async () => {
    const prisma = storage();
    const salary = { findMany: vi.fn() };
    // records.query currently lacks a manifest seed (existing approval fallback).
    // Resume flag reaches its actual model rejection; it never grants a scope.
    const result = await executeAgentTool({ prisma: { ...prisma, salary } as any, actor: await actor(['products:read']), toolId: 'records.query', toolInput: { entity: 'Salary' }, skipApprovalCheck: true });
    expect(result).toMatchObject({ ok: true, entity: 'Salary', reason: 'ENTITY_NOT_SUPPORTED' });
    expect(salary.findMany).not.toHaveBeenCalled();
    expect(prisma.productAsset.count).not.toHaveBeenCalled();
    noBusinessWrites(prisma);
  });

  it('valid products read executes the actual query handler and records success', async () => {
    const prisma = storage();
    const result = await executeAgentTool({ prisma: prisma as any, actor: await actor(['products:read']), toolId: 'products.query', toolInput: { limit: 1 } });
    expect(result).toMatchObject({ ok: true, total: 7, count: 0, items: [] });
    expect(prisma.productAsset.count).toHaveBeenCalledTimes(1);
    expect(prisma.productAsset.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'success', toolId: 'products.query' }) });
    noBusinessWrites(prisma);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('valid order write grant still creates a pending approval assigned through the real department resolver', async () => {
    const prisma = storage();
    const result: any = await executeAgentTool({ prisma: prisma as any, actor: await actor(['orders:write']), toolId: 'orders.update_status', toolInput: { orderId: 'order-execution', toStatus: 'Confirmed' } });
    expect(result).toMatchObject({ status: 'approval_required', approvalRequired: true, toolId: 'orders.update_status' });
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
    const request = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(request).toMatchObject({ id: result.approvalId, requesterId: 'actor-execution', reviewerId: 'reviewer-execution', reviewerResolverRoute: 'DEPT_HEAD', departmentSnapshotId: 'department-execution', status: 'pending', actionType: 'tool:orders.update_status' });
    expect(result.approvalId).not.toMatch(/^ar_temp_/);
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'approval_required', approvalId: result.approvalId }) });
    noBusinessWrites(prisma);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('loop runtime preserves pending-approval output under an effective write grant', async () => {
    const prisma = storage();
    const hits = await runAgentToolCalls({ prisma: prisma as any, actor: await actor(['orders:write']), calls: [{ toolId: 'orders.update_status', input: { orderId: 'order-execution', toStatus: 'Confirmed' }, reason: 'approval preservation probe' }] });
    expect(hits).toHaveLength(1);
    expect(hits[0].category).toBe('ApprovalPending');
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'pending', requesterId: 'actor-execution', reviewerId: 'reviewer-execution' }) });
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'approval_required' }) });
    noBusinessWrites(prisma);
  });
});
