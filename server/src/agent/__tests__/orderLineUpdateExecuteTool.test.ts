import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildOrderLineUpdateDraft } from '../orderLineUpdateFlow';

vi.mock('../../orders/orderLineMutationService', () => ({
  updateOrderLine: vi.fn(),
}));
import { updateOrderLine } from '../../orders/orderLineMutationService';

describe('task order-line-update-flow: executeTool commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('approved → committed', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: true, data: { line: { id: 'ORD__1__0010' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.line_update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.line_update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.line_update', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.line_update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.line_update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('service 失败（UPDATE_LINE_FAILED）→ failed', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: false, error: { code: 'UPDATE_LINE_FAILED', message: 'sync reject' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.line_update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'order.line_update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
  });

  it('no service bypass：只调 updateOrderLine', async () => {
    const draft = buildOrderLineUpdateDraft({ lineId: 'ORD__1__0010', patch: { quantity: 200 } });
    (updateOrderLine as any).mockResolvedValue({ ok: true, data: { line: { id: 'ORD__1__0010' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:order.line_update', payload: { processDraft: draft } }) } } as any;
    await executeTool(prisma, { toolId: 'order.line_update', input: {}, approvalId: 'AP1' } as any);
    expect(updateOrderLine).toHaveBeenCalledTimes(1);
  });
});

describe('task order-line-update-flow: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + processDraft（before 从真实 line 读）', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD__1__0010', quantity: 100, materialCode: 'PROD-1' }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010', patch: { quantity: 200 } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(result.processDraft.beforeAfterDiff[0].before).toBe(100);
    expect(result.processDraft.beforeAfterDiff[0].after).toBe(200);
  });

  it('缺参数 → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });

  it('order line 不存在 → preconditions_failed', async () => {
    const prisma = {
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'MISSING', patch: { quantity: 200 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });

  it('before snapshot 动态 select patch 字段（多字段，before 都从真实 line 读）', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD__1__0010', quantity: 100, materialCode: 'PROD-OLD', description: 'original desc', unit: 'KG' }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010', patch: { quantity: 200, materialCode: 'PROD-NEW', description: 'new desc' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    const diffMap: Record<string, any> = {};
    for (const d of result.processDraft.beforeAfterDiff) diffMap[d.field] = d;
    expect(diffMap.quantity.before).toBe(100);
    expect(diffMap.quantity.after).toBe(200);
    expect(diffMap.materialCode.before).toBe('PROD-OLD');
    expect(diffMap.materialCode.after).toBe('PROD-NEW');
    expect(diffMap.description.before).toBe('original desc');
    expect(diffMap.description.after).toBe('new desc');
  });

  it('混合合法+非法字段 → fail closed（不进 approval，不调 updateOrderLine）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn() },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    // patch 含合法 quantity + 非法 orderId/deletedAt → 整体 reject
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010', patch: { quantity: 200, orderId: 'HACKED', deletedAt: 999 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable fields');
    expect(result.message).toContain('orderId');
    expect(result.message).toContain('deletedAt');
    // approval 没创建（fail closed，不进 approval）
    expect(approvalCreate).not.toHaveBeenCalled();
    // orderLine.findUnique 没调用（非法字段在读取前就 reject）
    expect(prisma.orderLine.findUnique).not.toHaveBeenCalled();
  });

  it('pure illegal patch（只传 orderId/deletedAt）→ fail closed（non-writable fields，不进 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      approvalRequest: { create: approvalCreate },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn() },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010', patch: { orderId: 'HACKED', deletedAt: 999, createdAt: 123 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable fields');
    expect(result.message).toContain('orderId');
    expect(result.message).toContain('deletedAt');
    expect(result.message).toContain('createdAt');
    // fail closed：不创建 approval，不读取 orderLine，不调用 updateOrderLine
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(prisma.orderLine.findUnique).not.toHaveBeenCalled();
  });

  it('合法 unitPrice before snapshot 从真实 line 读', async () => {
    const prisma = {
      approvalRequest: { create: vi.fn().mockResolvedValue({}) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      orderLine: { findUnique: vi.fn().mockResolvedValue({ id: 'ORD__1__0010', unitPrice: 15.5, unit: 'KG' }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'order.line_update', toolInput: { lineId: 'ORD__1__0010', patch: { unitPrice: 20, unit: 'M' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    const diffMap: Record<string, any> = {};
    for (const d of result.processDraft.beforeAfterDiff) diffMap[d.field] = d;
    expect(diffMap.unitPrice.before).toBe(15.5);
    expect(diffMap.unitPrice.after).toBe(20);
    expect(diffMap.unit.before).toBe('KG');
    expect(diffMap.unit.after).toBe('M');
  });
});
