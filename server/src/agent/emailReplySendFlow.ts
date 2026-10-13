/**
 * ERP-P1-email-reply-send-flow-contract
 *
 * email.reply_and_send draft→approval→commit 最小闭环契约。
 * commit 写 Email(direction=outbound) + AuditLog（事务内），不自动 SMTP 发送（留后续任务）。
 * what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复。
 */

import { PrismaClient } from '@prisma/client';
import { writeRouteAuditLog, auditActorFrom } from '../audit/routeAudit';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type EmailReplySendErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'ORIGINAL_EMAIL_NOT_FOUND'
  | 'MISSING_RECIPIENT'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface EmailReplySendError {
  code: EmailReplySendErrorCode;
  message: string;
  userAction: string;
  details?: string[];
}

export interface EmailReplySendCommitted {
  status: 'committed';
  emailId: string;
  direction: string;
  threadId: string | null;
  transactionId: string;
  auditId: string;
  idempotencyKey: string;
}

export type EmailReplySendFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | EmailReplySendCommitted
  | { status: 'failed'; error: EmailReplySendError; approvalId?: string };

export function buildEmailReplySendError(code: EmailReplySendErrorCode, message: string, details?: string[]): EmailReplySendError {
  const userActionMap: Record<EmailReplySendErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起邮件回复流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '邮件 draft 语义校验失败，请检查收件人/主题/正文',
    ORIGINAL_EMAIL_NOT_FOUND: '检查原邮件 ID 是否存在',
    MISSING_RECIPIENT: '收件人不能为空',
    COMMIT_TRANSACTION_FAILED: '事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code], details };
}

export interface EmailReplySendDraftInput {
  replyToEmailId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  relationId?: string;
  orderId?: string;
}

export function buildEmailReplySendDraft(input: EmailReplySendDraftInput): ProcessDraft {
  const { replyToEmailId, to, cc, subject, bodyText, bodyHtml, relationId, orderId } = input;

  const afterPayload: Record<string, any> = {
    to, cc: cc || [], subject, bodyText, bodyHtml: bodyHtml || null,
    replyToEmailId: replyToEmailId || null, relationId: relationId || null, orderId: orderId || null,
  };

  const subOperations: SubOperation[] = [{
    toolId: 'email.reply_and_send',
    entityId: replyToEmailId || 'new-outbound',
    action: 'create_outbound_email',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'emails',
    entityId: replyToEmailId || 'new-outbound',
    field: 'outbound',
    before: null,
    after: { to, subject },
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['emails'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `email.reply_and_send:${replyToEmailId || 'new'}:${hash}`;

  return { ...content, idempotencyKey };
}

export function recoverEmailPayloadFromDraft(draft: ProcessDraft): Record<string, any> | null {
  const sub = draft.subOperations?.[0];
  if (!sub?.after) return null;
  return sub.after as Record<string, any>;
}

export function validateEmailReplySendDraftSemantics(draft: any): { ok: boolean; error?: EmailReplySendError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildEmailReplySendError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!Array.isArray(after?.to) || after.to.length === 0) {
    return { ok: false, error: buildEmailReplySendError('MISSING_RECIPIENT', 'to (recipients) must be a non-empty array') };
  }
  if (!after?.subject || !after?.bodyText) {
    return { ok: false, error: buildEmailReplySendError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subject and bodyText in subOperations.after') };
  }
  return { ok: true };
}

export function verifyEmailReplySendDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface EmailReplySendCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitEmailReplySend(
  params: EmailReplySendCommitParams,
): Promise<{ ok: true; feedback: EmailReplySendCommitted } | { ok: false; feedback: { status: 'failed'; error: EmailReplySendError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailReplySendError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyEmailReplySendDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailReplySendError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateEmailReplySendDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const recovered = recoverEmailPayloadFromDraft(draft);
  if (!recovered) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailReplySendError('PROCESS_DRAFT_MISSING', 'cannot recover email payload from draft'), approvalId } };
  }

  const transactionId = `ers_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let auditId = '';
  let committed: Partial<EmailReplySendCommitted> = {};

  try {
    await prisma.$transaction(async (tx: any) => {
      const now = BigInt(Date.now());
      const emailId = `EML__${Date.now().toString(36)}`;
      const { to, cc, subject, bodyText, bodyHtml, replyToEmailId, relationId, orderId } = recovered;

      // fromAddress 是我方发件身份（contract 占位，后续 SMTP 任务从凭据托管读）
      // 不用 original.fromAddress——那是对方/客户的地址，用它等于冒充对方发件
      const fromAddress = 'agent@bambook.local';
      const fromName = 'Bambook Agent';
      let threadId: string | null = null;
      let inReplyToMessageId: string | null = null;

      // 回复场景：读原邮件 threadId/messageId（仅用于 threading，不用 fromAddress）
      if (replyToEmailId) {
        const original = await tx.email.findUnique({
          where: { id: replyToEmailId },
          select: { id: true, threadId: true, messageId: true, deletedAt: true },
        });
        if (!original || original.deletedAt) {
          throw Object.assign(new Error(`original email ${replyToEmailId} not found or deleted`), { code: 'ORIGINAL_EMAIL_NOT_FOUND' });
        }
        threadId = original.threadId;
        inReplyToMessageId = original.messageId;
      }

      // 写 Email(direction=outbound, mailbox=Outbox)——不 SMTP 发送（contract 边界）
      // 不写 sentAt/messageId：未通过 SMTP 发送，不应有发送时间戳/RFC Message-ID
      // mailbox=Outbox 表达"待 SMTP 发送"，不是已发送的 Sent
      const email = await tx.email.create({
        data: {
          id: emailId,
          direction: 'outbound',
          status: 'read',
          fromAddress,
          fromName,
          toAddresses: JSON.stringify(to),
          ccAddresses: cc?.length ? JSON.stringify(cc) : null,
          subject,
          bodyText,
          bodyHtml: bodyHtml || null,
          mailbox: 'Outbox',
          mailboxOwnerUserId: params.actorId || null,
          threadId,
          messageId: null,
          sentAt: null,
          relationId: relationId || null,
          orderId: orderId || null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // audit（事务内闭环）
      const aId = `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await writeRouteAuditLog({
        prisma: tx, actorId: auditActorFrom(params), source: 'agent:email.reply_and_send:commit',
        operation: 'email_reply_send_committed', targetType: 'Email', targetId: email.id,
        after: { emailId: email.id, direction: 'outbound', threadId, transactionId, replyToEmailId: replyToEmailId || null },
      });
      auditId = aId;
      committed = { emailId: email.id, direction: 'outbound', threadId };
    });

    return {
      ok: true,
      feedback: {
        status: 'committed',
        emailId: committed.emailId!,
        direction: committed.direction!,
        threadId: committed.threadId || null,
        transactionId,
        auditId,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    const code = e?.code === 'ORIGINAL_EMAIL_NOT_FOUND' ? 'ORIGINAL_EMAIL_NOT_FOUND' : 'COMMIT_TRANSACTION_FAILED';
    return {
      ok: false,
      feedback: { status: 'failed', error: buildEmailReplySendError(code as EmailReplySendErrorCode, String(e?.message ?? e)), approvalId },
    };
  }
}
