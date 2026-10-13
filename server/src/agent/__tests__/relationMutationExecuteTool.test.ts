import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildRelationUpdateDraft, buildRelationDeleteDraft } from '../relationMutationFlow';

vi.mock('../../relations/relationMutationService', () => ({
  updateRelation: vi.fn(),
  deleteRelation: vi.fn(),
  RELATION_UPDATE_FIELDS: ['name','category','type','isOrganization','parentId','tags','contactInfo'],
  VALID_RELATION_CATEGORIES: new Set(['Customer','Supplier','Agent','Partner','Government','Internal','Other']),
}));
import { updateRelation, deleteRelation } from '../../relations/relationMutationService';

const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['relations','finance','orders','shipping','products'], knowledgeScopes: ['company'], departmentIds: [] } as any;

describe('relation.update/delete executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('relation.update approved → committed', async () => {
    const draft = buildRelationUpdateDraft({ relationId: 'REL-1', patch: { name: 'New' }, currentSnapshot: { name: 'Old' } });
    (updateRelation as any).mockResolvedValue({ ok: true, data: { relation: { id: 'REL-1' }, auditId: 'AL-1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:relation.update', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'relation.update', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(updateRelation).toHaveBeenCalledTimes(1);
  });

  it('relation.delete approved → committed', async () => {
    const draft = buildRelationDeleteDraft({ relationId: 'REL-1' });
    (deleteRelation as any).mockResolvedValue({ ok: true, data: { relation: { id: 'REL-1' }, auditId: 'AL-2' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:relation.delete', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'relation.delete', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(deleteRelation).toHaveBeenCalledTimes(1);
  });

  it('pending/modified/missing approval fail closed，service 不调用', async () => {
    const pending = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const modified = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'modified', payload: {} }) } } as any;
    const missing: any = {};
    expect((await executeTool(pending, { toolId: 'relation.update', input: {}, approvalId: 'AP-1' } as any) as any).ok).toBe(false);
    expect((await executeTool(modified, { toolId: 'relation.delete', input: {}, approvalId: 'AP-1' } as any) as any).ok).toBe(false);
    expect((await executeTool(missing, { toolId: 'relation.update', input: {} } as any) as any).errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(updateRelation).not.toHaveBeenCalled();
    expect(deleteRelation).not.toHaveBeenCalled();
  });
});

describe('relation.update/delete executeAgentTool draft-first', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update 首次 → approval_required + before snapshot', async () => {
    const prisma = { approvalRequest: { create: vi.fn().mockResolvedValue({ id: 'AP-1' }) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, relation: { findUnique: vi.fn().mockResolvedValue({ id: 'REL-1', name: 'Old', deletedAt: null }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'relation.update', toolInput: { relationId: 'REL-1', patch: { name: 'New' } }, sessionId: 's1' });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft.subOperations[0].toolId).toBe('relation.update');
    expect(result.processDraft.beforeAfterDiff[0].before).toBe('Old');
  });

  it('update 非法 patch 字段 → preconditions_failed，不读 DB，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const findUnique = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, relation: { findUnique } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'relation.update', toolInput: { relationId: 'REL-1', patch: { name: 'New', deletedAt: 1 } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('non-writable');
    expect(findUnique).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('update 非法 category → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, relation: { findUnique: vi.fn() } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'relation.update', toolInput: { relationId: 'REL-1', patch: { category: 'Bogus' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('invalid category');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('update missing/deleted → preconditions_failed，不创建 approval', async () => {
    const approvalCreate = vi.fn();
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, relation: { findUnique: vi.fn().mockResolvedValue({ id: 'REL-1', deletedAt: BigInt(1) }) } } as any;
    const result: any = await executeAgentTool({ prisma, actor, toolId: 'relation.update', toolInput: { relationId: 'REL-1', patch: { name: 'New' } }, sessionId: 's1' });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('not found or deleted');
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('delete 首次 → approval_required；deleted relation fail closed', async () => {
    const approvalCreate = vi.fn().mockResolvedValue({ id: 'AP-1' });
    const prisma = { approvalRequest: { create: approvalCreate }, agentToolRun: { create: vi.fn().mockResolvedValue({}) }, relation: { findUnique: vi.fn().mockResolvedValueOnce({ id: 'REL-1', name: 'Old', category: 'Customer', type: 'Customer', deletedAt: null }).mockResolvedValueOnce({ id: 'REL-2', deletedAt: BigInt(1) }) }, userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) }, actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) } } as any;
    const ok: any = await executeAgentTool({ prisma, actor, toolId: 'relation.delete', toolInput: { relationId: 'REL-1' }, sessionId: 's1' });
    const bad: any = await executeAgentTool({ prisma, actor, toolId: 'relation.delete', toolInput: { relationId: 'REL-2' }, sessionId: 's1' });
    expect(ok.status).toBe('approval_required');
    expect(ok.processDraft.subOperations[0].toolId).toBe('relation.delete');
    expect(bad.status).toBe('preconditions_failed');
  });
});


describe('relation.update/delete manifest exposure', () => {
  it('manifest exposes relation.update/delete for planner visibility', () => {
    const manifest = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
    expect(manifest).toContain("id: 'relation.update'");
    expect(manifest).toContain("id: 'relation.delete'");
    expect(manifest).toContain('relationId: string');
    expect(manifest).toContain('patch');
  });
});
