import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildProductAssetCreateDraft, buildProductAssetUpdateDraft, buildProductAssetDeleteDraft } from '../productAssetMutationFlow';

vi.mock('../../products/productAssetMutationService', () => ({
  createProductAsset: vi.fn(),
  updateProductAsset: vi.fn(),
  deleteProductAsset: vi.fn(),
}));
import { createProductAsset, updateProductAsset, deleteProductAsset } from '../../products/productAssetMutationService';

describe('task product-asset-mutation-flow: executeTool commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('product_asset.create approved → committed', async () => {
    const draft = buildProductAssetCreateDraft({ body: { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric' } });
    (createProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:product_asset.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'product_asset.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('product_asset.create 无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'product_asset.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('product_asset.update approved → committed', async () => {
    const draft = buildProductAssetUpdateDraft({ assetId: 'PROD-1', patch: { name: 'Updated' } });
    (updateProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:product_asset.update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'product_asset.update', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('product_asset.delete approved → committed', async () => {
    const draft = buildProductAssetDeleteDraft({ assetId: 'PROD-1' });
    (deleteProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:product_asset.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'product_asset.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'product_asset.delete', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });
});

describe('task product-asset-mutation-flow: executeAgentTool draft→approval', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('product_asset.create 首次 → approval_required', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({}) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.create', toolInput: { body: { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('product_asset.create');
  });

  it('product_asset.create 缺 sku → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.create', toolInput: { body: { name: 'Twill' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });

  it('product_asset.update 首次 → approval_required', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({}) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, productAsset: { findFirst: vi.fn().mockResolvedValue({ id: 'PROD-1', sku: 'FAB-1', name: 'Old', deletedAt: null }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.update', toolInput: { assetId: 'PROD-1', patch: { name: 'Updated' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
  });

  it('product_asset.update 非法字段（orderId/deletedAt）→ fail closed（不创建 approval）', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, productAsset: { findFirst: vi.fn() } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.update', toolInput: { assetId: 'PROD-1', patch: { name: 'OK', orderId: 'HACK', deletedAt: 999 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable fields');
    expect(result.message).toContain('orderId');
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(prisma.productAsset.findFirst).not.toHaveBeenCalled();
  });

  it('product_asset.update assetId 不存在 → preconditions_failed', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({});
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, productAsset: { findFirst: vi.fn().mockResolvedValue(null) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.update', toolInput: { assetId: 'MISSING', patch: { name: 'Updated' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('product_asset.delete 首次 → approval_required', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({}) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, productAsset: { findFirst: vi.fn().mockResolvedValue({ id: 'PROD-1', deletedAt: null }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.delete', toolInput: { assetId: 'PROD-1' }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
  });

  it('product_asset.delete assetId 不存在 → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) }, productAsset: { findFirst: vi.fn().mockResolvedValue(null) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'product_asset.delete', toolInput: { assetId: 'MISSING' }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
  });
});
