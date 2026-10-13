import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildKnowledgeIngestDraft,
  validateKnowledgeIngestDraftSemantics,
  verifyKnowledgeIngestDraftHash,
  commitKnowledgeIngest,
  buildKnowledgeIngestError,
} from '../knowledgeIngestFlow';

vi.mock('../../ai/knowledgeIngestService', () => ({
  ingestKnowledgeDocument: vi.fn(),
}));
import { ingestKnowledgeDocument } from '../../ai/knowledgeIngestService';

describe('task knowledge-ingest-flow: buildKnowledgeIngestDraft', () => {
  it('produces 6-field ProcessDraft with pd: hash idempotencyKey', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'Test Doc', text: 'content', scopes: ['company'] });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].action).toBe('ingest_knowledge_document');
    expect(draft.impactScope).toEqual(['knowledge']);
    expect(draft.irreversible).toBe(true);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.beforeAfterDiff).toHaveLength(1);
    expect(draft.idempotencyKey).toContain(':pd:');
    expect(draft.idempotencyKey).toContain('knowledge.ingest:Test Doc');
  });
});

describe('task knowledge-ingest-flow: validateKnowledgeIngestDraftSemantics', () => {
  it('valid draft passes', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'content' });
    expect(validateKnowledgeIngestDraftSemantics(draft).ok).toBe(true);
  });
  it('empty text → INVALID_INPUT', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: '   ' });
    expect(validateKnowledgeIngestDraftSemantics(draft).ok).toBe(false);
  });
  it('oversized text → INVALID_INPUT', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'x'.repeat(500001) });
    const r = validateKnowledgeIngestDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_INPUT');
  });
});

describe('task knowledge-ingest-flow: hash anti-tamper', () => {
  it('valid draft passes hash check', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'c' });
    expect(verifyKnowledgeIngestDraftHash(draft).ok).toBe(true);
  });
  it('tampered after.text → hash mismatch', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'original' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, text: 'tampered' } }] };
    expect(verifyKnowledgeIngestDraftHash(tampered).ok).toBe(false);
  });
  it('tampered idempotencyKey → hash mismatch', () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'c' });
    const tampered = { ...draft, idempotencyKey: 'knowledge.ingest:T:pd:bogus' };
    expect(verifyKnowledgeIngestDraftHash(tampered).ok).toBe(false);
  });
});

describe('task knowledge-ingest-flow: commitKnowledgeIngest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('success → committed, ingestKnowledgeDocument called once', async () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'content' });
    vi.mocked(ingestKnowledgeDocument).mockResolvedValue({ ok: true, result: { documentId: 'KD_1', checksum: 'abc', chunkCount: 3, auditId: 'alog_1' } });
    const result: any = await commitKnowledgeIngest({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feedback.documentId).toBe('KD_1');
      expect(result.feedback.chunkCount).toBe(3);
    }
    expect(ingestKnowledgeDocument).toHaveBeenCalledTimes(1);
  });

  it('missing processDraft → fail closed, service NOT called', async () => {
    const result: any = await commitKnowledgeIngest({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
    expect(ingestKnowledgeDocument).not.toHaveBeenCalled();
  });

  it('hash mismatch → fail closed, service NOT called', async () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'c' });
    const tampered = { ...draft, idempotencyKey: 'knowledge.ingest:T:pd:bogus' };
    const result: any = await commitKnowledgeIngest({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(ingestKnowledgeDocument).not.toHaveBeenCalled();
  });

  it('service failure (DUPLICATE_CHECKSUM) → mapped error, no pseudo-success', async () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'c' });
    vi.mocked(ingestKnowledgeDocument).mockResolvedValue({ ok: false, error: { code: 'DUPLICATE_CHECKSUM', message: 'dup' } });
    const result: any = await commitKnowledgeIngest({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('DUPLICATE_CHECKSUM');
  });

  it('service failure (CREATE_FAILED) → mapped error', async () => {
    const draft = buildKnowledgeIngestDraft({ title: 'T', text: 'c' });
    vi.mocked(ingestKnowledgeDocument).mockResolvedValue({ ok: false, error: { code: 'CREATE_FAILED', message: 'db error' } });
    const result: any = await commitKnowledgeIngest({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.feedback.error.code).toBe('CREATE_FAILED');
  });
});

describe('task knowledge-ingest-flow: buildKnowledgeIngestError', () => {
  it('produces stable error', () => {
    const e = buildKnowledgeIngestError('COMMIT_FAILED', 'test');
    expect(e.code).toBe('COMMIT_FAILED');
    expect(e.message).toBe('test');
  });
});
