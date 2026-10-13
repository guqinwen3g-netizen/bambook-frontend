import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';
import { buildRelationUpdateDraft, commitRelationUpdate, buildRelationDeleteDraft, commitRelationDelete } from '../relationMutationFlow';

vi.mock('../../relations/relationMutationService', () => ({
  updateRelation: vi.fn(),
  deleteRelation: vi.fn(),
  RELATION_UPDATE_FIELDS: ['name','category','type','isOrganization','parentId','tags','contactInfo'],
  VALID_RELATION_CATEGORIES: new Set(['Customer','Supplier','Agent','Partner','Government','Internal','Other']),
}));
import { updateRelation, deleteRelation } from '../../relations/relationMutationService';

describe('relationMutationFlow update/delete draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update draft preserves ProcessDraft 六字段 + beforeAfterDiff', () => {
    const draft = buildRelationUpdateDraft({ relationId: 'REL-1', patch: { name: 'New' }, currentSnapshot: { name: 'Old' } });
    expect(draft.subOperations[0].toolId).toBe('relation.update');
    expect(draft.subOperations[0].action).toBe('update_relation');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'relation', entityId: 'REL-1', field: 'name', before: 'Old', after: 'New' });
    expect(draft.impactScope).toEqual(['relations', 'entity-links', 'audit']);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('relation.update:REL-1:pd:');
  });

  it('update commit 复用 updateRelation service', async () => {
    const draft = buildRelationUpdateDraft({ relationId: 'REL-1', patch: { name: 'New' }, currentSnapshot: { name: 'Old' } });
    (updateRelation as any).mockResolvedValue({ ok: true, data: { relation: { id: 'REL-1' }, auditId: 'AL-1' } });
    const r = await commitRelationUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(updateRelation).toHaveBeenCalledWith(expect.objectContaining({ relationId: 'REL-1', input: { name: 'New' }, actorId: SYSTEM_AUDIT_ACTOR }));
  });

  it('update hash mismatch → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildRelationUpdateDraft({ relationId: 'REL-1', patch: { name: 'New' }, currentSnapshot: { name: 'Old' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { relationId: 'REL-1', patch: { name: 'HACK' } } }] };
    const r = await commitRelationUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(updateRelation).not.toHaveBeenCalled();
  });

  it('delete draft + commit 复用 deleteRelation service', async () => {
    const draft = buildRelationDeleteDraft({ relationId: 'REL-1', currentSnapshot: { name: 'Old' } });
    (deleteRelation as any).mockResolvedValue({ ok: true, data: { relation: { id: 'REL-1' }, auditId: 'AL-2' } });
    const r = await commitRelationDelete({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(deleteRelation).toHaveBeenCalledWith(expect.objectContaining({ relationId: 'REL-1', actorId: SYSTEM_AUDIT_ACTOR }));
  });

  it('delete hash mismatch → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildRelationDeleteDraft({ relationId: 'REL-1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { relationId: 'REL-2' } }] };
    const r = await commitRelationDelete({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(deleteRelation).not.toHaveBeenCalled();
  });
});
