/**
 * ERP-P1-email-outbox-send-route-foundation
 *
 * Outbox Email 显式 SMTP 发送地基。
 * 只能发送已存在的 Email(direction=outbound, mailbox=Outbox) 事实行。
 * SMTP 成功后才把同一 Email 更新为 Sent 并写 sentAt/messageId；SMTP 失败保持 Outbox。
 * 不修改 email.reply_and_send / invoice.issue 的 commit 边界（它们仍只写 Outbox）。
 */

import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import type { TokenPayload } from '../auth/service';
import { executeDurableOutboxSend } from './outboxSendAttemptService';

export type OutboxSendErrorCode =
  | 'EMAIL_NOT_FOUND'
  /** B67：读这封邮件这件事本身失败（连接/超时/查询错）⇒ 不许与"不存在"共用一个码 */
  | 'EMAIL_READ_FAILED'
  | 'EMAIL_NOT_OUTBOUND'
  | 'EMAIL_NOT_OUTBOX'
  | 'EMAIL_ALREADY_SENT'
  | 'MISSING_RECIPIENT'
  | 'MISSING_CREDENTIALS'
  | 'SMTP_SEND_FAILED'
  | 'SMTP_MESSAGE_ID_MISSING'
  | 'DB_UPDATE_FAILED'
  | 'UNKNOWN_ERROR'
  | 'SEND_LEDGER_UNAVAILABLE'
  | 'SEND_IN_PROGRESS'
  | 'SEND_RESULT_UNCERTAIN'
  | 'SEND_CONTENT_CHANGED'
  | 'SEND_RECEIPT_INVALID'
  | 'SEND_ACTOR_REQUIRED'
  | 'SEND_PERMISSION_DENIED'
  | 'ATTACHMENT_NOT_READY';

export interface OutboxSendError {
  code: OutboxSendErrorCode;
  message: string;
  statusCode: number;
}

export interface OutboxSendResult {
  ok: boolean;
  error?: OutboxSendError;
  data?: {
    emailId: string;
    messageId: string;
    sentAt: string;
    auditId: string;
  };
}

export function buildOutboxSendError(code: OutboxSendErrorCode, message: string): OutboxSendError {
  const statusCodeMap: Record<OutboxSendErrorCode, number> = {
    EMAIL_NOT_FOUND: 404,
    // 档位不新造语义：读失败与"SMTP 已发但写库失败"同属系统侧问题 ⇒ 沿用本表已有的 500。
    EMAIL_READ_FAILED: 500,
    EMAIL_NOT_OUTBOUND: 400,
    EMAIL_NOT_OUTBOX: 400,
    EMAIL_ALREADY_SENT: 409,
    MISSING_RECIPIENT: 400,
    MISSING_CREDENTIALS: 400,
    SMTP_SEND_FAILED: 502,
    SMTP_MESSAGE_ID_MISSING: 502,
    DB_UPDATE_FAILED: 500,
    UNKNOWN_ERROR: 500,
    SEND_LEDGER_UNAVAILABLE: 503,
    SEND_IN_PROGRESS: 409,
    SEND_RESULT_UNCERTAIN: 409,
    SEND_CONTENT_CHANGED: 409,
    SEND_RECEIPT_INVALID: 409,
    SEND_ACTOR_REQUIRED: 401,
    SEND_PERMISSION_DENIED: 403,
    ATTACHMENT_NOT_READY: 409,
  };
  return { code, message, statusCode: statusCodeMap[code] };
}

export interface OutboxSendParams {
  prisma: PrismaClient;
  emailId: string;
  credentials: {
    user: string;
    pass: string;
    host?: string;
    port?: number;
  };
  actorId?: string;
  actor?: TokenPayload;
  expectedContentHash?: string;
  expectedSmtpUser?: string;
  recoveryOnly?: boolean;
  createTransporter?: typeof nodemailer.createTransport;
}

export async function sendOutboxEmail(params: OutboxSendParams): Promise<OutboxSendResult> {
  return executeDurableOutboxSend(params);
}
