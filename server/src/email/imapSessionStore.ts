/**
 * IMAP 会话凭据短期 store（in-memory，多次取用，TTL 过期）。
 *
 * 用途（L7：密码从 URL 移除）：
 *   /api/email/detail 已持有用户 IMAP 凭据（POST body），为内嵌图片生成
 *   <img src="/api/email/image?..."> 代理地址时，不再把 password 拼进 URL，
 *   改为把凭据放入本 store，URL 只携带一次性随机 session token。
 *
 * 与 agent/emailCredentialStore 的差异：那个是审批流 one-shot（取一次即销毁）；
 * 本 store 服务 <img> 标签多次加载/刷新场景，TTL 内可重复取用，到期自动失效。
 * 进程重启 session 丢失 → 图片 401，前端重新打开邮件详情即可重建。
 */

import crypto from 'crypto';

export interface ImapSessionCredential {
  user: string;
  pass: string;
  host?: string;
  port?: number;
}

const store = new Map<string, { cred: ImapSessionCredential; expiresAt: number }>();
const TTL_MS = 30 * 60 * 1000; // 30 分钟

function sweepExpired(now: number): void {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function putImapSession(cred: ImapSessionCredential): string {
  const now = Date.now();
  sweepExpired(now);
  const token = `imap_${now.toString(36)}_${crypto.randomBytes(24).toString('base64url')}`;
  store.set(token, { cred, expiresAt: now + TTL_MS });
  return token;
}

export function getImapSession(token: string): ImapSessionCredential | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry.cred;
}

/** tests 用 */
export function clearImapSessions(): void {
  store.clear();
}
