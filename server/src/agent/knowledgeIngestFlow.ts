import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { computeProcessDraftHash, type ProcessDraft } from './toolRegistry';
import { ingestKnowledgeDocument, type KnowledgeIngestInput, type KnowledgeIngestErrorCode } from '../ai/knowledgeIngestService';

export type KnowledgeIngestFlowErrorCode =
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'COMMIT_FAILED'
  | KnowledgeIngestErrorCode;

export interface KnowledgeIngestFlowError { code: KnowledgeIngestFlowErrorCode; message: string; }

export function buildKnowledgeIngestError(code: KnowledgeIngestFlowErrorCode, message: string): KnowledgeIngestFlowError {
  return { code, message };
}

export interface KnowledgeIngestCommitted {
  status: 'committed';
  documentId: string;
  checksum: string;
  chunkCount: number;
  auditId: string;
  idempotencyKey: string;
}

export interface KnowledgeIngestDraftInput extends KnowledgeIngestInput {}

export function buildKnowledgeIngestDraft(input: KnowledgeIngestDraftInput): ProcessDraft {
  const { title, text, sourceType, sourceUri, tags, metadata, scopes } = input;
  const afterPayload = {
    title,
    text,
    sourceType: sourceType || 'manual',
    sourceUri: sourceUri || null,
    tags: tags || [],
    metadata: metadata || {},
    scopes: scopes || [],
  };

  const subOperations = [{
    toolId: 'knowledge.ingest',
    entityId: title,
    action: 'ingest_knowledge_document',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'knowledgeDocuments',
    entityId: title,
    field: 'id',
    before: null as any,
    after: 'pending' as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['knowledge'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `knowledge.ingest:${title}:${hash}`;

  return { ...content, idempotencyKey } as ProcessDraft;
}

export function validateKnowledgeIngestDraftSemantics(draft: ProcessDraft): { ok: boolean; error?: KnowledgeIngestFlowError } {
  if (!draft?.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildKnowledgeIngestError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.title) {
    return { ok: false, error: buildKnowledgeIngestError('INVALID_INPUT', 'title is required') };
  }
  if (!after?.text || String(after.text).trim().length === 0) {
    return { ok: false, error: buildKnowledgeIngestError('INVALID_INPUT', 'text is required and must not be empty') };
  }
  if (String(after.text).length > 500000) {
    return { ok: false, error: buildKnowledgeIngestError('INVALID_INPUT', 'text exceeds 500000 character limit') };
  }
  return { ok: true };
}

export function verifyKnowledgeIngestDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface CommitParams {
  /** ★ B58：审批请求人（由 toolDispatchRegistry 注入）；缺省落 'system' */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export type CommitResult =
  | { ok: true; feedback: KnowledgeIngestCommitted }
  | { ok: false; feedback: { status: 'failed'; error: KnowledgeIngestFlowError; approvalId?: string } };

export async function commitKnowledgeIngest(params: CommitParams): Promise<CommitResult> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: ProcessDraft | undefined = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildKnowledgeIngestError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyKnowledgeIngestDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildKnowledgeIngestError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateKnowledgeIngestDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;

  try {
    const result = await ingestKnowledgeDocument({
      prisma,
      input: {
        title: String(after.title),
        text: String(after.text),
        sourceType: after.sourceType,
        sourceUri: after.sourceUri,
        tags: after.tags,
        metadata: after.metadata,
        scopes: after.scopes,
      },
      actorId: auditActorFrom(params),
      auditSource: 'agent:tool:knowledge.ingest',
      auditOperation: 'knowledge_ingest',
    });

    if (!result.ok) {
      return {
        ok: false,
        feedback: { status: 'failed', error: buildKnowledgeIngestError((result as any).error.code as KnowledgeIngestFlowErrorCode, (result as any).error.message), approvalId },
      };
    }

    return {
      ok: true,
      feedback: {
        status: 'committed',
        documentId: result.result.documentId,
        checksum: result.result.checksum,
        chunkCount: result.result.chunkCount,
        auditId: result.result.auditId,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: buildKnowledgeIngestError('COMMIT_FAILED', String(e?.message ?? e)), approvalId } };
  }
}
