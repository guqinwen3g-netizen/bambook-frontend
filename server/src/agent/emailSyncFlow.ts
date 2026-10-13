import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import { computeProcessDraftHash, type ProcessDraft } from './toolRegistry';
import { syncEmailsFromImap, type EmailSyncResult, type EmailSyncErrorCode } from '../email/emailSyncService';

export type EmailSyncFlowErrorCode =
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'MISSING_CREDENTIALS'
  | 'APPROVAL_ID_MISSING'
  | 'COMMIT_FAILED'
  | EmailSyncErrorCode;

export interface EmailSyncFlowError { code: EmailSyncFlowErrorCode; message: string; }

export function buildEmailSyncError(code: EmailSyncFlowErrorCode, message: string): EmailSyncFlowError {
  return { code, message };
}

export interface EmailSyncCommitted {
  status: 'committed';
  accountMasked: string;
  synced: number;
  skipped: number;
  errors: number;
  auditIds: string[];
  idempotencyKey: string;
}

export interface EmailSyncDraftInput {
  credentialsUser: string;
  host?: string;
  port?: number;
  box?: string;
  limit?: number;
}

export function buildEmailSyncDraft(input: EmailSyncDraftInput): ProcessDraft {
  const { credentialsUser, host, port, box, limit } = input;
  const afterPayload = {
    credentialsUser,
    credentialsHost: host || 'imap.qiye.aliyun.com',
    credentialsPort: port || 993,
    box: box || 'INBOX',
    limit: limit || 100,
  };

  const subOperations = [{
    toolId: 'email.sync',
    entityId: credentialsUser,
    action: 'sync_imap_emails',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'emails',
    entityId: credentialsUser,
    field: 'syncedAt',
    before: {},
    after: 'now',
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['emails'],
    irreversible: false,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `email.sync:${credentialsUser}:${hash}`;

  return { ...content, idempotencyKey } as ProcessDraft;
}

export function validateEmailSyncDraftSemantics(draft: ProcessDraft): { ok: boolean; error?: EmailSyncFlowError } {
  if (!draft?.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildEmailSyncError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.credentialsUser) {
    return { ok: false, error: buildEmailSyncError('MISSING_CREDENTIALS', 'draft must contain credentials.user in subOperations.after') };
  }
  return { ok: true };
}

export function verifyEmailSyncDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
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
  credentialsPassword: string;
}

export type CommitResult =
  | { ok: true; feedback: EmailSyncCommitted }
  | { ok: false; feedback: { status: 'failed'; error: EmailSyncFlowError; approvalId?: string } };

export async function commitEmailSync(params: CommitParams): Promise<CommitResult> {
  const { prisma, approvalId, approvalPayload, credentialsPassword } = params;

  const draft: ProcessDraft | undefined = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSyncError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyEmailSyncDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSyncError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateEmailSyncDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;
  const user = String(after.credentialsUser || '');
  const pass = String(credentialsPassword || '');

  if (!user || !pass) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSyncError('MISSING_CREDENTIALS', 'credentials.user or recovered password missing/expired'), approvalId } };
  }

  try {
    const result: EmailSyncResult = await syncEmailsFromImap({
      prisma,
      credentials: { user, pass, host: after.credentialsHost, port: after.credentialsPort },
      box: after.box,
      limit: after.limit,
      actorId: auditActorFrom(params),
    });

    if (!result.ok) {
      return {
        ok: false,
        feedback: { status: 'failed', error: buildEmailSyncError(result.error!.code as EmailSyncFlowErrorCode, result.error!.message), approvalId },
      };
    }

    return {
      ok: true,
      feedback: {
        status: 'committed',
        accountMasked: result.data!.accountMasked,
        synced: result.data!.synced,
        skipped: result.data!.skipped,
        errors: result.data!.errors,
        auditIds: result.data!.auditIds,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSyncError('COMMIT_FAILED', String(e?.message ?? e)), approvalId } };
  }
}
