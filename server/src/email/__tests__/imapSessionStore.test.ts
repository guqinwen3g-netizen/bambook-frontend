import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { putImapSession, getImapSession, clearImapSessions } from '../imapSessionStore';

/**
 * 批次 L（L7）— imapSessionStore：内嵌图片代理的短期凭据会话。
 * URL 只带随机 session token，不含明文密码；TTL 过期即失效。
 */
describe('imapSessionStore（L7：图片代理 URL 去密码）', () => {
  beforeEach(() => {
    clearImapSessions();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('put → get 取回完整凭据（user/pass/host/port）', () => {
    const token = putImapSession({ user: 'a@b.com', pass: 'secret', host: 'imap.example.com', port: 993 });
    expect(token).toMatch(/^imap_/);
    const cred = getImapSession(token);
    expect(cred).toEqual({ user: 'a@b.com', pass: 'secret', host: 'imap.example.com', port: 993 });
  });

  it('未知 token → null', () => {
    expect(getImapSession('imap_nonexistent')).toBeNull();
  });

  it('TTL（30 分钟）内可多次取用（非 one-shot，服务 <img> 多次加载）', () => {
    const token = putImapSession({ user: 'a@b.com', pass: 'secret' });
    expect(getImapSession(token)?.pass).toBe('secret');
    vi.setSystemTime(new Date('2026-08-28T10:29:00Z'));
    expect(getImapSession(token)?.pass).toBe('secret');
  });

  it('TTL 过期 → null 且 token 被清除', () => {
    const token = putImapSession({ user: 'a@b.com', pass: 'secret' });
    vi.setSystemTime(new Date('2026-08-28T10:31:00Z'));
    expect(getImapSession(token)).toBeNull();
  });

  it('clearImapSessions 清空全部会话', () => {
    const token = putImapSession({ user: 'a@b.com', pass: 'secret' });
    clearImapSessions();
    expect(getImapSession(token)).toBeNull();
  });
});
