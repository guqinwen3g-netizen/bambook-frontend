import { describe, expect, it } from 'vitest';
import { ChatgptAuth, CHATGPT_RESPONSES_URL } from '../models/chatgpt';
import { json, jwt, memorySecrets, scriptedFetch } from './helpers';

const idToken = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' } });

describe('ChatgptAuth (local device login)', () => {
  it('completes device login, stores credentials only in the local secret store and builds Codex headers', async () => {
    let now = 1_000_000;
    const secrets = memorySecrets();
    const f = scriptedFetch(call => {
      if (call.url.endsWith('/deviceauth/usercode')) return json({ device_auth_id: 'dev', user_code: 'ABCD-1234', interval: 1 });
      if (call.url.endsWith('/deviceauth/token')) return json({ authorization_code: 'code', code_verifier: 'ver' });
      return json({ access_token: jwt({ exp: 99_999_999 }), refresh_token: 'r1', id_token: idToken, expires_in: 3600 });
    });
    const auth = new ChatgptAuth(secrets, { fetch: f.fetch, now: () => now, schedule: () => setTimeout(() => undefined, 0) });
    const view = await auth.startLogin();
    expect(view).toMatchObject({ state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
    await auth.poll(view.loginId);
    expect(auth.getLogin(view.loginId).state).toBe('connected');
    expect(await auth.status()).toMatchObject({ connected: true, email: 'me@example.com', plan: 'pro' });
    expect([...secrets.data.keys()]).toEqual(['chatgpt']);
    const target = await auth.target();
    expect(target.url).toBe(CHATGPT_RESPONSES_URL);
    expect(target.headers).toMatchObject({ 'ChatGPT-Account-ID': 'acct-1', originator: 'bambook' });
    expect(new URLSearchParams(String(f.calls[2].init.body)).get('grant_type')).toBe('authorization_code');
    now += 2 * 3600 * 1000;
    await auth.target();
    expect(new URLSearchParams(String(f.calls[3].init.body)).get('grant_type')).toBe('refresh_token');
    await auth.logout();
    expect(secrets.data.size).toBe(0);
  });

  it('keeps polling while authorization is pending and explains device-code refusal', async () => {
    const f = scriptedFetch(call => (call.url.endsWith('/usercode') ? json({ device_auth_id: 'd', user_code: 'C' }) : new Response('', { status: 403 })));
    let scheduled = 0;
    const auth = new ChatgptAuth(memorySecrets(), { fetch: f.fetch, schedule: () => { scheduled++; return setTimeout(() => undefined, 0); } });
    const view = await auth.startLogin();
    await auth.poll(view.loginId);
    expect(auth.getLogin(view.loginId).state).toBe('pending');
    expect(scheduled).toBe(2);
    const refused = new ChatgptAuth(memorySecrets(), { fetch: scriptedFetch(() => new Response('', { status: 404 })).fetch });
    await expect(refused.startLogin()).rejects.toThrow('设备码授权');
  });

  it('reports a clear error when not connected', async () => {
    await expect(new ChatgptAuth(memorySecrets(), { fetch: scriptedFetch(() => json({})).fetch }).target()).rejects.toMatchObject({ code: 'CHATGPT_NOT_CONNECTED' });
  });
});
