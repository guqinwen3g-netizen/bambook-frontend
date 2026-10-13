/**
 * Agent-P1-email-send-outbox-flow-contract
 *
 * email.send draft→approval→commit 消费已 merged 的 Outbox send service。
 * draft 只引用/选择已有 outbound Outbox Email（emailId），不重新构造任意邮件体。
 * commit 调用 sendOutboxEmail（共用 Outbox send service 契约），不绕过 DB 事实源，不直接 nodemailer。
 * what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复 emailId。
 */

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { sendOutboxEmail, type OutboxSendErrorCode } from '../email/outboxSend';
import { takeEmailSendCredential } from './emailCredentialStore';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type EmailSendOutboxErrorCode = OutboxSendErrorCode
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'EMAIL_NOT_FOUND'
  // B67：读这封邮件失败（不是「不存在」）。与 `email/outboxSend` 的码表同步——
  //   这个 map 是 Record<union,string>，少一条就会在运行时给出 userAction=undefined。
  | 'EMAIL_READ_FAILED'
  | 'EMAIL_NOT_OUTBOUND'
  | 'EMAIL_NOT_OUTBOX'
  | 'EMAIL_ALREADY_SENT'
  | 'MISSING_RECIPIENT'
  | 'MISSING_CREDENTIALS'
  | 'SMTP_SEND_FAILED'
  | 'SMTP_MESSAGE_ID_MISSING'
  | 'DB_UPDATE_FAILED'
  | 'UNKNOWN_ERROR';

export interface EmailSendOutboxError {
  code: EmailSendOutboxErrorCode;
  message: string;
  userAction: string;
}

export interface EmailSendOutboxCommitted {
  status: 'committed';
  emailId: string;
  messageId: string;
  sentAt: string;
  auditId: string;
  idempotencyKey: string;
}

export type EmailSendOutboxFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | EmailSendOutboxCommitted
  | { status: 'failed'; error: EmailSendOutboxError; approvalId?: string };

export function buildEmailSendOutboxError(code: EmailSendOutboxErrorCode, message: string): EmailSendOutboxError {
  const userActionMap: Record<EmailSendOutboxErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起发送流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '发送 draft 语义校验失败，请检查 emailId',
    EMAIL_NOT_FOUND: 'Outbox 邮件不存在，请检查 emailId',
    EMAIL_READ_FAILED: '系统读不到这封邮件（不是它不存在），本次未发送；请稍后重试或让管理员查服务日志',
    EMAIL_NOT_OUTBOUND: '邮件方向非 outbound，不可发送',
    EMAIL_NOT_OUTBOX: '邮件不在 Outbox，不可发送',
    EMAIL_ALREADY_SENT: '邮件已发送，无需重复发送',
    MISSING_RECIPIENT: '邮件无有效收件人',
    MISSING_CREDENTIALS: 'SMTP 凭据缺失（user/pass）',
    SMTP_SEND_FAILED: 'SMTP 发送失败，邮件保持 Outbox，请稍后重试',
    SMTP_MESSAGE_ID_MISSING: 'SMTP 发送完成但未返回 messageId，请检查 SMTP 服务',
    DB_UPDATE_FAILED: 'SMTP 已发送但 DB 更新失败，请联系管理员核对',
    SEND_LEDGER_UNAVAILABLE: '发送记录暂时无法核对，请恢复数据库读取后核对原回执，勿重新发送',
    SEND_IN_PROGRESS: '原发送已经开始，请核对原发送记录，勿重新发送',
    SEND_RESULT_UNCERTAIN: '发送结果尚未确认，请核对原邮件与服务商记录，勿重新发送',
    SEND_CONTENT_CHANGED: '邮件内容或发送账号已经变化，请核对原审批与发送记录',
    SEND_RECEIPT_INVALID: '原发送回执不完整，请联系管理员核对，勿重新发送',
    SEND_ACTOR_REQUIRED: '请使用真实登录账号执行发送或恢复',
    SEND_PERMISSION_DENIED: '当前账号无邮件发送权限，审批不能代替现有授权',
    ATTACHMENT_NOT_READY: '附件发送尚未就绪，不能发送含附件的邮件',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  // ★ 兜底不是装饰：这张表是手写的，service 每加一枚码就要同步一次（B67 这次就差点漏掉
  //   EMAIL_READ_FAILED ⇒ userAction 变 undefined，工具反馈里会出现一句没有建议的失败）。
  return { code, message, userAction: userActionMap[code] ?? '请核对原发送记录，勿重新发送；联系管理员确认结果' };
}

export interface EmailSendOutboxDraftInput {
  emailId: string;
  /** Only the server-read native snapshot can populate this approval context. */
  sendContext?: { sendContextVersion: 1; emailId: string; contentHash: string; content: Record<string, unknown> };
  credentials: {
    user: string;
    pass: string;
    host?: string;
    port?: number;
  };
}

/** Safe email-only projection for runtime records and unexecuted MCP plan steps. */
export function redactEmailSendInput(input: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, credentials, ...rest } = input;
  const c = credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials as any : {};
  return { ...rest, credentials: { user: c.user || input.email || '', pass: '',
    ...(c.host !== undefined ? { host: c.host } : {}), ...(c.port !== undefined ? { port: c.port } : {}),
    ...(typeof c.credentialRef === 'string' ? { credentialRef: c.credentialRef } : {}) } };
}

/**
 * draft 只引用已有 Outbox Email（emailId），不重新构造邮件体。
 * credentials 编码进 subOperations.after（what-you-approve-is-what-you-commit）。
 */
export function buildEmailSendOutboxDraft(input: EmailSendOutboxDraftInput): ProcessDraft {
  const { emailId, credentials } = input;
  const afterPayload = {
    emailId,
    ...(input.sendContext ? { sendContextVersion: input.sendContext.sendContextVersion,
      contentHash: input.sendContext.contentHash, content: input.sendContext.content } : {}),
    credentialsUser: credentials.user,
    credentialsHost: credentials.host || 'smtp.qiye.aliyun.com',
    credentialsPort: credentials.port || 465,
  };

  const subOperations: SubOperation[] = [{
    toolId: 'email.send',
    entityId: emailId,
    action: 'send_outbox_email',
    before: { emailId, mailbox: 'Outbox' },
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'emails',
    entityId: emailId,
    field: 'mailbox',
    before: 'Outbox' as any,
    after: 'Sent' as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['emails'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `email.send:${emailId}:${hash}`;

  return { ...content, idempotencyKey };
}

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function validateEmailSendOutboxDraftSemantics(draft: any): { ok: boolean; error?: EmailSendOutboxError } {
  if (!draft?.subOperations || draft.subOperations.length !== 1 || draft.subOperations[0].toolId !== 'email.send'
    || draft.subOperations[0].action !== 'send_outbox_email') {
    return { ok: false, error: buildEmailSendOutboxError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.emailId) {
    return { ok: false, error: buildEmailSendOutboxError('SEMANTIC_VALIDATION_FAILED', 'draft must contain emailId in subOperations.after') };
  }
  if (!after?.credentialsUser) {
    return { ok: false, error: buildEmailSendOutboxError('MISSING_CREDENTIALS', 'draft must contain credentials.user in subOperations.after') };
  }
  if (after.sendContextVersion !== 1 || !after.content || typeof after.content !== 'object' || Array.isArray(after.content)
    || after.content.id !== after.emailId || draft.subOperations[0].entityId !== after.emailId
    || !/^[a-f0-9]{64}$/.test(after.contentHash || '')
    || createHash('sha256').update(JSON.stringify(canonical(after.content))).digest('hex') !== after.contentHash) {
    return { ok: false, error: buildEmailSendOutboxError('SEMANTIC_VALIDATION_FAILED', '需要重新读取原邮件并审批完整发送内容，旧 ID 审批不能直接发送') };
  }
  return { ok: true };
}

export function verifyEmailSendOutboxDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface EmailSendOutboxCommitParams {
  /** Actual trusted execution identity, never substituted with the requester. */
  actorId?: string;
  trustedActor?: TokenPayload;
  requesterId?: string;
  recoveryOnly?: boolean;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
  // Ephemeral secret store only; never recover a plaintext password from approval payload.
  credentialsPassword?: string;
  credentialRef?: string;
}

/**
 * commit 调用 sendOutboxEmail（共用 Outbox send service），不绕过 DB 事实源，不直接 nodemailer。
 */
export async function commitEmailSendOutbox(
  params: EmailSendOutboxCommitParams,
): Promise<{ ok: true; feedback: EmailSendOutboxCommitted } | { ok: false; feedback: { status: 'failed'; error: EmailSendOutboxError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload, credentialsPassword } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSendOutboxError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyEmailSendOutboxDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSendOutboxError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateEmailSendOutboxDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;
  const emailId = after.emailId;
  let password = credentialsPassword;
  if (params.credentialRef) {
    // This unlocked read controls secret consumption only. The producer still
    // owns locked authorization, content CAS and all send/recovery decisions.
    try {
      const prior = await (prisma as any).emailSendAttempt.findUnique({ where: { emailId } });
      if (!prior && !params.recoveryOnly) password = takeEmailSendCredential(params.credentialRef, {
        actorId: params.actorId || '', emailId, smtpUser: after.credentialsUser, contentHash: after.contentHash,
      }) || '';
    } catch {
      return { ok: false, feedback: { status: 'failed', error: buildEmailSendOutboxError('SEND_LEDGER_UNAVAILABLE',
        '原发送记录暂时无法核对，未消费发送凭据、未联系邮件服务器'), approvalId } };
    }
  }

  // 调用共用 sendOutboxEmail（不绕 DB，不直接 nodemailer）
  const result = await sendOutboxEmail({
    prisma,
    emailId,
    credentials: {
      user: after.credentialsUser,
      pass: password || '',
      host: after.credentialsHost,
      port: after.credentialsPort,
    },
    actorId: params.actorId,
    actor: params.trustedActor,
    expectedContentHash: after.contentHash,
    expectedSmtpUser: after.credentialsUser,
    recoveryOnly: params.recoveryOnly,
  });

  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildEmailSendOutboxError(result.error!.code as EmailSendOutboxErrorCode, result.error!.message), approvalId } };
  }

  return {
    ok: true,
    feedback: {
      status: 'committed',
      emailId: result.data!.emailId,
      messageId: result.data!.messageId,
      sentAt: result.data!.sentAt,
      auditId: result.data!.auditId,
      idempotencyKey: draft.idempotencyKey,
    },
  };
}
