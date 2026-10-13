/**
 * Email Outbox send service.
 * 消费后端 POST /api/v1/email/outbox/:id/send contract（task_mqyqerqb）。
 * 不使用旧 /api/email/send 任意邮件体路径。
 */
import { apiService } from './apiService';
import type { OutboxSendResult } from '../types';

export interface OutboxSendCredentials {
  user: string;
  pass: string;
  host?: string;
  port?: number;
}

export const emailOutboxService = {
  /**
   * 发送 Outbox Email（只对 direction=outbound, mailbox=Outbox 的邮件）。
   * 成功返回 { ok:true, data:{emailId,messageId,sentAt,auditId} }。
   * 失败返回 { ok:false, error:{code,message,statusCode} }——保持 Outbox UI 状态。
   */
  async sendOutboxEmail(emailId: string, credentials: OutboxSendCredentials, endpoint?: string): Promise<OutboxSendResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/email/outbox/${encodeURIComponent(emailId)}/send`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({
        email: credentials.user,
        password: credentials.pass,
        host: credentials.host,
        port: credentials.port,
      }),
    });
    const receipt: unknown = await res.json().catch(() => null);
    const body = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? receipt as Record<string, unknown> : null;
    // Native route returns a flat receipt. Only a complete receipt for this
    // email can advance the UI; an ambiguous reply must never trigger a retry.
    const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (res.ok && body?.ok === true && body.emailId === emailId
      && nonBlank(body.messageId) && nonBlank(body.auditId)
      && nonBlank(body.sentAt) && Number.isFinite(Date.parse(body.sentAt))) {
      return { ok: true, data: {
        emailId, messageId: body.messageId, sentAt: body.sentAt, auditId: body.auditId,
      } };
    }
    const error = body?.error;
    if (body?.ok === false && error && typeof error === 'object' && !Array.isArray(error)) {
      const detail = error as Record<string, unknown>;
      if (nonBlank(detail.code) && nonBlank(detail.message)
        && Number.isInteger(detail.statusCode) && Number(detail.statusCode) >= 400 && Number(detail.statusCode) <= 599) {
        return { ok: false, error: { code: detail.code, message: detail.message, statusCode: Number(detail.statusCode) } };
      }
    }
    return { ok: false, error: {
      code: 'UNKNOWN_ERROR',
      message: '未取得可信的发送回执，请核对原邮件的发送记录，勿重复发送。',
      statusCode: res.ok ? 502 : res.status,
    } };
  },

  /** 判断邮件是否为可发送的 Outbox 邮件（direction=outbound && mailbox=Outbox && 未发送） */
  isSendableOutbox(email: { direction?: string; mailbox?: string; sentAt?: string | null; messageId?: string | null }): boolean {
    return email.direction === 'outbound'
      && email.mailbox === 'Outbox'
      && !email.sentAt
      && !email.messageId;
  },

  /** 创建 Outbox Email（create route，不含 password） */
  async createOutboxEmail(input: { fromAddress: string; to: string[]; subject: string; bodyText: string; fromName?: string; threadId?: string }, endpoint?: string): Promise<{ ok: true; emailId: string; mailbox: string; direction: string; auditId: string }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/email/outbox', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({
        fromAddress: input.fromAddress,
        fromName: input.fromName,
        to: input.to,
        subject: input.subject,
        bodyText: input.bodyText,
        threadId: input.threadId,
      }),
    });
    let json: any;
    try { json = await res.json(); } catch { throw new Error(`create outbox failed: HTTP ${res.status} (non-JSON response)`) as Error & { code: string }; }
    if (!res.ok || !json?.ok) {
      const err = new Error(json?.error?.message || json?.message || `create outbox failed: HTTP ${res.status}`) as Error & { code: string };
      err.code = json?.error?.code || `HTTP_${res.status}`;
      throw err;
    }
    return { ok: true, emailId: json.emailId, mailbox: json.mailbox, direction: json.direction, auditId: json.auditId };
  },

  /** 创建 Reply Outbox Email（reply route，含 originalEmailId，不含 password） */
  async createReplyOutboxEmail(input: { originalEmailId: string; fromAddress: string; to: string[]; subject: string; bodyText: string; fromName?: string; threadId?: string }, endpoint?: string): Promise<{ ok: true; emailId: string; mailbox: string; direction: string; auditId: string }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/email/replies', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({
        originalEmailId: input.originalEmailId,
        fromAddress: input.fromAddress,
        fromName: input.fromName,
        to: input.to,
        subject: input.subject,
        bodyText: input.bodyText,
        threadId: input.threadId,
      }),
    });
    let json: any;
    try { json = await res.json(); } catch { throw new Error(`create reply outbox failed: HTTP ${res.status} (non-JSON response)`) as Error & { code: string }; }
    if (!res.ok || !json?.ok) {
      const err = new Error(json?.error?.message || json?.message || `create reply outbox failed: HTTP ${res.status}`) as Error & { code: string };
      err.code = json?.error?.code || `HTTP_${res.status}`;
      throw err;
    }
    return { ok: true, emailId: json.emailId, mailbox: json.mailbox, direction: json.direction, auditId: json.auditId };
  },
};
