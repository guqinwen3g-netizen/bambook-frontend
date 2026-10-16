// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const user = { id: 'boss', displayName: '老板', email: 'boss@example.test', roles: ['owner'], permissions: [], departmentIds: [], department: null };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;
beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('密码通过但需两步验证：不写会话，抛出 MFA_REQUIRED 携带第二步凭据；第二步走 /auth/login/mfa', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => url.endsWith('/auth/login')
    ? json({ ok: true, mfaRequired: true, mfaToken: 'step' })
    : json({ ok: true, user, token: 'session-token', echo: JSON.parse(String(init.body)) }));
  vi.stubGlobal('fetch', fetch);
  const auth = await import('./authService');
  const failure: any = await auth.login('boss@example.test', 'pw').catch(e => e);
  expect(failure.code).toBe('MFA_REQUIRED'); expect(failure.mfaToken).toBe('step');
  expect(auth.getAuthState().isAuthenticated).toBe(false); expect(localStorage.getItem('bambook_auth_token')).toBeNull();
  await auth.login('boss@example.test', '', { mfaToken: 'step', code: ' 123456 ' });
  const [url, init] = fetch.mock.calls[1];
  expect(url).toMatch(/\/auth\/login\/mfa$/); expect(JSON.parse(String(init.body))).toEqual({ mfaToken: 'step', code: '123456' });
  expect(auth.getAuthState()).toMatchObject({ isAuthenticated: true, user: { id: 'boss' } });
  expect(localStorage.getItem('bambook_auth_token')).toBe('session-token');
});

it('错误动态码透传服务端错误码', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, error: 'MFA_INVALID', message: '验证码不正确或已使用。' }, 401)));
  const auth = await import('./authService');
  const failure: any = await auth.login('x', '', { mfaToken: 't', code: '000000' }).catch(e => e);
  expect(failure.code).toBe('MFA_INVALID'); expect(failure.message).toBe('验证码不正确或已使用。');
  expect(auth.getAuthState().isAuthenticated).toBe(false);
});
