import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { buildOutboxSendError, type OutboxSendParams, type OutboxSendResult, type OutboxSendErrorCode } from './outboxSend';

const fields = ['id', 'fromAddress', 'fromName', 'toAddresses', 'ccAddresses', 'bccAddresses',
  'replyToAddress', 'subject', 'bodyText', 'bodyHtml', 'hasAttachments', 'attachmentCount'] as const;
const select = Object.fromEntries([...fields, 'direction', 'mailbox', 'messageId', 'sentAt', 'deletedAt'].map(k => [k, true]));
const snapshot = (email: any) => Object.fromEntries(fields.map(k => [k, email[k] ?? null]));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const nonBlank = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
function reject(code: OutboxSendErrorCode, message: string): never { throw Object.assign(Error(message), { sendError: buildOutboxSendError(code, message) }); }
function failure(code: OutboxSendErrorCode, message: string): OutboxSendResult { return { ok: false, error: buildOutboxSendError(code, message) }; }
function addresses(raw: unknown): string[] {
  const parsed = raw == null ? [] : JSON.parse(String(raw));
  if (!Array.isArray(parsed) || parsed.some(v => !nonBlank(v) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw Error('invalid address');
  return parsed;
}
function recipients(content: any): string[] {
  return [...new Set([content.toAddresses, content.ccAddresses, content.bccAddresses].flatMap(addresses)
    .map(address => { const at = address.lastIndexOf('@'); return address.slice(0, at) + '@' + address.slice(at + 1).toLowerCase(); }))].sort();
}
function recipientReceipt(info: any, content: any, requestedMessageId: string) {
  if (!Array.isArray(info?.accepted) || !Array.isArray(info?.rejected) || info.rejected.length
    || info.pending !== undefined && (!Array.isArray(info.pending) || info.pending.length)) throw Error('SMTP recipient evidence unavailable');
  const accepted = recipients({ toAddresses: JSON.stringify(info.accepted) });
  const expected = recipients(content);
  if (!expected.length || JSON.stringify(accepted) !== JSON.stringify(expected)) throw Error('SMTP recipient acceptance is incomplete');
  return { receiptVersion: 1, messageId: info.messageId, requestedMessageId, accepted, expected, rejected: [], pending: [] };
}
async function authorize(tx: any, params: OutboxSendParams) {
  if (!nonBlank(params.actorId) || params.actor && params.actor.userId !== params.actorId) reject('SEND_ACTOR_REQUIRED', '请登录后核对发送账号。');
  const context = await createPermissionService({ prisma: tx }).getUserPermissionContext(params.actorId!);
  if (!context) reject('SEND_ACTOR_REQUIRED', '当前发送账号不可用，请重新登录。');
  const current: any = { ...params.actor, userId: params.actorId, roles: context.legacyRoleCodes, roleIds: context.roleIds,
    permissions: context.scopes, authorizationLoaded: true };
  if (!hasScope(current, 'emails:write')) reject('SEND_PERMISSION_DENIED', '当前账号没有邮件发送权限。');
}
async function lockEmail(tx: any, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Email" WHERE "id" = ${id} FOR UPDATE`;
  return tx.email.findUnique({ where: { id }, select });
}
function validateReceipt(attempt: any, email: any) {
  if (!attempt || attempt.emailId !== email.id || hash(attempt.contentSnapshot) !== attempt.contentHash
    || hash(snapshot(email)) !== attempt.contentHash) reject('SEND_CONTENT_CHANGED', '邮件内容与原发送记录不一致，请核对原邮件，勿重复发送。');
  if (!nonBlank(attempt.smtpMessageId) || !nonBlank(attempt.receiptSentAt) || !Number.isFinite(Date.parse(attempt.receiptSentAt)))
    reject('SEND_RECEIPT_INVALID', '原发送回执不完整，请核对原邮件，勿重复发送。');
  try {
    const proof = attempt.smtpReceipt;
    if (proof?.receiptVersion !== 1 || proof.messageId !== attempt.smtpMessageId || proof.requestedMessageId !== attempt.requestedMessageId
      || hash(recipientReceipt(proof, attempt.contentSnapshot, attempt.requestedMessageId)) !== hash(proof)) throw Error('incomplete stored SMTP recipient proof');
  } catch { reject('SEND_RECEIPT_INVALID', '原收件人发送回执不完整，请核对原邮件，勿重复发送。'); }
}
function approvedContext(params: OutboxSendParams, contentHash: string, smtpUser: string | undefined) {
  if (params.expectedContentHash !== undefined && (!/^[a-f0-9]{64}$/.test(params.expectedContentHash)
    || params.expectedContentHash !== contentHash) || params.expectedSmtpUser !== undefined && params.expectedSmtpUser !== smtpUser)
    reject('SEND_CONTENT_CHANGED', '邮件内容或发送账号与审批原件不一致，请核对原件，未重新发送。');
}
/** Shared server-read approval snapshot. Never accepts a caller-supplied body. */
export async function readDurableOutboxContext(params: Pick<OutboxSendParams, 'prisma' | 'emailId' | 'actorId' | 'actor'>) {
  try {
    const data = await (params.prisma as any).$transaction(async (tx: any) => {
      const email = await lockEmail(tx, params.emailId); await authorize(tx, params as OutboxSendParams);
      if (!email || email.deletedAt != null) reject('EMAIL_NOT_FOUND', '原邮件不存在或不可用。');
      if (email.direction !== 'outbound') reject('EMAIL_NOT_OUTBOUND', '只有已登记的发件邮件可以发送。');
      if (email.mailbox !== 'Outbox') reject('EMAIL_NOT_OUTBOX', '原邮件不在发件箱。');
      if (email.messageId || email.sentAt) reject('EMAIL_ALREADY_SENT', '原邮件已有发送记录，请核对原发送回执。');
      const content = snapshot(email);
      return { sendContextVersion: 1 as const, emailId: email.id, contentHash: hash(content), content };
    });
    return { ok: true as const, data };
  } catch (error: any) {
    return { ok: false as const, error: error.sendError
      || buildOutboxSendError('SEND_LEDGER_UNAVAILABLE', '原发件内容与当前授权暂时无法核对，请稍后重试。') };
  }
}
async function finalize(prisma: any, params: OutboxSendParams): Promise<OutboxSendResult> {
  let acceptedMessageId: string | undefined;
  try {
    return await prisma.$transaction(async (tx: any) => {
      const email = await lockEmail(tx, params.emailId); await authorize(tx, params);
      if (!email || email.deletedAt != null) reject('EMAIL_NOT_FOUND', '原邮件不存在或已移除，请核对发送记录，勿重复发送。');
      const attempt = await tx.emailSendAttempt.findUnique({ where: { emailId: params.emailId } });
      validateReceipt(attempt, email);
      approvedContext(params, attempt.contentHash, attempt.smtpUser);
      acceptedMessageId = attempt.smtpMessageId;
      if (attempt.status === 'sent') {
        const audit = nonBlank(attempt.auditId) ? await tx.auditLog.findUnique({ where: { id: attempt.auditId } }) : null;
        if (!audit || audit.targetId !== email.id || audit.targetType !== 'Email' || audit.action !== 'outbox_email_sent'
          || audit.actorId !== attempt.actorId || audit.transactionId !== attempt.id || audit.operationType !== 'transition'
          || audit.detail?.source !== 'route:email:outbox_send' || audit.detail?.before?.mailbox !== 'Outbox'
          || audit.detail?.before?.messageId !== null || audit.detail?.before?.sentAt !== null
          || audit.detail?.after?.messageId !== attempt.smtpMessageId || audit.detail?.after?.sentAt !== attempt.receiptSentAt
          || audit.detail?.after?.attemptId !== attempt.id || audit.detail?.after?.contentHash !== attempt.contentHash
          || audit.detail?.after?.mailbox !== 'Sent' || audit.detail?.after?.smtpResult !== 'success'
          || email.mailbox !== 'Sent' || email.messageId !== attempt.smtpMessageId || email.sentAt !== attempt.receiptSentAt)
          reject('SEND_RECEIPT_INVALID', '原发送记录与回执不一致，请核对原邮件，勿重复发送。');
      } else {
        if (attempt.status !== 'accepted') reject('SEND_RESULT_UNCERTAIN', '原发送结果尚未确认，请核对原邮件，勿重复发送。');
        if (email.direction !== 'outbound' || email.mailbox !== 'Outbox' || email.messageId || email.sentAt)
          reject('SEND_CONTENT_CHANGED', '原邮件状态已变化，未重新发送，请核对发送记录。');
        await tx.email.update({ where: { id: email.id }, data: { mailbox: 'Sent', messageId: attempt.smtpMessageId,
          sentAt: attempt.receiptSentAt, updatedAt: BigInt(Date.now()) } });
        const auditId = await writeRouteAuditLog({ prisma: tx, actorId: attempt.actorId, source: 'route:email:outbox_send',
          operation: 'outbox_email_sent', targetType: 'Email', targetId: email.id,
          before: { mailbox: 'Outbox', messageId: null, sentAt: null },
          after: { mailbox: 'Sent', messageId: attempt.smtpMessageId, sentAt: attempt.receiptSentAt, smtpResult: 'success',
            attemptId: attempt.id, contentHash: attempt.contentHash }, transactionId: attempt.id, operationType: 'transition' });
        await tx.emailSendAttempt.update({ where: { id: attempt.id }, data: { status: 'sent', auditId } });
        attempt.auditId = auditId;
      }
      return { ok: true, data: { emailId: email.id, messageId: attempt.smtpMessageId, sentAt: attempt.receiptSentAt, auditId: attempt.auditId } };
    });
  } catch (error: any) {
    if (error.sendError) return { ok: false, error: error.sendError };
    logger.error('[email] durable SMTP receipt native finalization failed', { emailId: params.emailId, error: error?.message });
    return failure('DB_UPDATE_FAILED', `发送回执已保留${acceptedMessageId ? `（${acceptedMessageId}）` : ''}，本地发送记录尚未完成；请核对原邮件，不要重复发送。`);
  }
}

export async function executeDurableOutboxSend(params: OutboxSendParams): Promise<OutboxSendResult> {
  const prisma: any = params.prisma;
  // Preserve the existing distinction between storage read failure and absence.
  let before: any;
  try { before = await prisma.email.findUnique({ where: { id: params.emailId }, select }); }
  catch (error: any) { logger.error('[email] outbox read failed', { emailId: params.emailId, error: error?.message });
    return failure('EMAIL_READ_FAILED', '系统暂时读不到原邮件，本次没有发送，请稍后核对。'); }
  if (!before || before.deletedAt != null) return failure('EMAIL_NOT_FOUND', '原邮件不存在或不可用。');
  let prepared: any;
  try {
    prepared = await prisma.$transaction(async (tx: any) => {
      const email = await lockEmail(tx, params.emailId); await authorize(tx, params);
      if (!email || email.deletedAt != null) reject('EMAIL_NOT_FOUND', '原邮件不存在或不可用。');
      const prior = await tx.emailSendAttempt.findUnique({ where: { emailId: email.id } });
      if (prior) {
        approvedContext(params, prior.contentHash, prior.smtpUser);
        if (['accepted', 'sent'].includes(prior.status)) return { recovery: true };
        reject(prior.status === 'claimed' ? 'SEND_IN_PROGRESS' : 'SEND_RESULT_UNCERTAIN', '这封邮件已有发送记录，结果尚未确认，请核对原邮件，勿重复发送。');
      }
      if (params.recoveryOnly) reject('SEND_RESULT_UNCERTAIN', '未找到可信的原生发送占位及回执，不能根据旧审批结果重新发送，请核对原邮件。');
      if (email.direction !== 'outbound') reject('EMAIL_NOT_OUTBOUND', '只有已登记的发件邮件可以发送。');
      if (email.mailbox !== 'Outbox') reject('EMAIL_NOT_OUTBOX', '原邮件不在发件箱。');
      if (email.messageId || email.sentAt) reject('EMAIL_ALREADY_SENT', '原邮件已有发送记录，勿重复发送。');
      let to: string[], cc: string[], bcc: string[];
      try { to = addresses(email.toAddresses); cc = addresses(email.ccAddresses); bcc = addresses(email.bccAddresses); }
      catch { reject('MISSING_RECIPIENT', '收件、抄送或密送地址无效，请核对原邮件。'); }
      if (!to!.length || !nonBlank(email.fromAddress)) reject('MISSING_RECIPIENT', '请核对发件及收件地址。');
      if (!nonBlank(params.credentials?.user) || !nonBlank(params.credentials?.pass)) reject('MISSING_CREDENTIALS', '请提供本次发送账号凭据。');
      // Never silently drop native attachments while their exact payload is not yet qualified.
      if (email.hasAttachments || Number(email.attachmentCount) > 0) reject('ATTACHMENT_NOT_READY', '本次附件发送尚未完成核验，未发送邮件。');
      const content = snapshot(email), contentHash = hash(content), id = 'email-send:' + hash(email.id);
      approvedContext(params, contentHash, params.credentials.user);
      const attempt = await tx.emailSendAttempt.create({ data: { id, emailId: email.id, actorId: params.actorId,
        status: 'claimed', contentHash, contentSnapshot: content, smtpUser: params.credentials.user,
        requestedMessageId: `<${hash({ emailId: email.id, contentHash })}@bambook.local>` } });
      return { attempt, email, to, cc, bcc };
    });
  } catch (error: any) {
    if (error.sendError) return { ok: false, error: error.sendError };
    logger.error('[email] durable send preparation failed', { emailId: params.emailId, error: error?.message });
    return failure('SEND_LEDGER_UNAVAILABLE', '发送记录暂时无法核对，本次没有联系邮件服务器，请稍后核对。');
  }
  if (prepared.recovery) return finalize(prisma, params);
  const { attempt, email, to, cc, bcc } = prepared;
  let info: any, proof: any;
  try {
    const transport = (params.createTransporter || nodemailer.createTransport)({ host: params.credentials.host || 'smtp.qiye.aliyun.com',
      port: params.credentials.port || 465, secure: true, auth: { user: params.credentials.user, pass: params.credentials.pass } } as any);
    info = await transport.sendMail({ messageId: attempt.requestedMessageId,
      from: { address: email.fromAddress, name: email.fromName || '' }, to, cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined, replyTo: email.replyToAddress || undefined, subject: email.subject,
      text: email.bodyText || undefined, html: email.bodyHtml || undefined });
    if (!nonBlank(info?.messageId)) throw Error('SMTP receipt message ID unavailable');
    proof = recipientReceipt(info, attempt.contentSnapshot, attempt.requestedMessageId);
  } catch (error: any) {
    logger.error('[email] SMTP outcome uncertain', { emailId: email.id, error: error?.message });
    try { await prisma.emailSendAttempt.updateMany({ where: { id: attempt.id, status: 'claimed' }, data: {
      status: 'unknown', ...(nonBlank(info?.messageId) ? { smtpMessageId: info.messageId } : {}),
    } }); }
    catch (saveError: any) { logger.error('[email] uncertain send state persistence failed', { emailId: email.id, error: saveError?.message }); }
    return failure('SEND_RESULT_UNCERTAIN', '未取得可信的邮件服务器回执，发送结果待核对，请核对原邮件，勿重复发送。');
  }
  try {
    const saved = await prisma.emailSendAttempt.updateMany({ where: { id: attempt.id, status: 'claimed' },
      data: { status: 'accepted', smtpMessageId: info.messageId, smtpReceipt: proof,
        receiptSentAt: new Date().toISOString().slice(0, 19).replace('T', ' ') } });
    if (saved.count !== 1) throw Error('durable receipt reservation changed');
  } catch (error: any) {
    logger.error('[email] SMTP accepted receipt persistence failed', { emailId: email.id, error: error?.message });
    return failure('SEND_RESULT_UNCERTAIN', '邮件服务器已有发送回执，但本地回执保存未确认，请核对原邮件，勿重复发送。');
  }
  return finalize(prisma, params);
}
