import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantService, type AssistantEvent } from '../service';
import { ToolRegistry } from '../tools';
import { SessionStore } from '../sessionStore';
import { memorySecrets, scriptedFetch, sse } from './helpers';
import { nextRestartDelay, HOST_LIMITS } from '../protocol';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const provider = { id: 'p-one', name: '测试模型', format: 'openai', base_url: 'https://api.example.com/v1', model: 'm1' };
const waitFor = async (events: AssistantEvent[], type: AssistantEvent['type']) => {
  for (let i = 0; i < 200; i++) { const e = events.find(x => x.type === type); if (e) return e; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('timeout waiting for ' + type);
};

describe('AssistantService', () => {
  it('isolates providers and secrets per account and never writes the API key into config files', async () => {
    const root = tmp(), secrets = memorySecrets();
    const s = new AssistantService({ rootDir: root, secrets, fetch: scriptedFetch(() => sse([])).fetch, emit: () => undefined });
    await expect(s.handle('providers.list')).rejects.toMatchObject({ code: 'NO_ACCOUNT' });
    await s.handle('account.select', { accountKey: 'server|user-a', displayName: '甲' });
    const views: any = await s.handle('providers.save', { config: provider, apiKey: 'sk-secret-123' });
    expect(views).toEqual([expect.objectContaining({ id: 'p-one', has_api_key: true })]);
    expect(JSON.stringify(views)).not.toContain('sk-secret');
    const files = fs.readdirSync(root, { recursive: true }).map(String);
    for (const f of files) { const full = path.join(root, f); if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8')).not.toContain('sk-secret'); }
    expect([...secrets.data.keys()][0]).toMatch(/^[a-f0-9]{24}:provider:p-one$/);
    await s.handle('account.select', { accountKey: 'server|user-b' });
    expect(await s.handle('providers.list')).toEqual([]);
  });

  it('runs a turn end to end, persists the session and resumes history', async () => {
    const events: AssistantEvent[] = [];
    const f = scriptedFetch((_c, i) => sse(i === 0
      ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'current_time', arguments: '{}' } }] } }] }]
      : [{ choices: [{ delta: { content: i === 1 ? '现在是下午' : '第二轮' } }] }]));
    const s = new AssistantService({ rootDir: tmp(), secrets: memorySecrets(), fetch: f.fetch, emit: e => events.push(e), now: () => new Date('2026-10-15T08:00:00Z') });
    await s.handle('account.select', { accountKey: 'k', displayName: '业务员甲' });
    await s.handle('providers.save', { config: provider, apiKey: 'sk-1' });
    await expect(s.handle('run.start', { providerId: 'p-one', text: ' ' })).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    const { sessionId } = await s.handle('run.start', { providerId: 'p-one', text: '现在几点？' }) as any;
    const end: any = await waitFor(events, 'run_end');
    expect(end).toMatchObject({ sessionId, stopReason: 'completed', text: '现在是下午' });
    expect((f.calls[0].init.headers as any).Authorization).toBe('Bearer sk-1');
    expect(f.body(0).messages[0].content).toContain('业务员甲');
    const saved: any = await s.handle('sessions.get', { id: sessionId });
    expect(saved.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(saved.meta.title).toBe('现在几点？');
    events.length = 0;
    await s.handle('run.start', { providerId: 'p-one', text: '再说一次', sessionId });
    await waitFor(events, 'run_end');
    expect(f.body(2).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual(['现在几点？', '再说一次']);
  });

  it('requires the one-time confirmation token issued for a pending action', async () => {
    const events: AssistantEvent[] = [];
    let executed = 0;
    const tools = () => new ToolRegistry([{ name: 'send_mail', description: 'send', parameters: { type: 'object', properties: {} }, risk: 'external', confirm: 'each', run: async () => { executed++; return 'sent'; } }]);
    const f = scriptedFetch((_c, i) => sse(i === 0 ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'send_mail', arguments: '{}' } }] } }] }] : [{ choices: [{ delta: { content: '已发送' } }] }]));
    const s = new AssistantService({ rootDir: tmp(), secrets: memorySecrets(), fetch: f.fetch, emit: e => events.push(e), tools });
    await s.handle('account.select', { accountKey: 'k' });
    await s.handle('providers.save', { config: provider, apiKey: 'sk' });
    const { runId } = await s.handle('run.start', { providerId: 'p-one', text: '发邮件' }) as any;
    const request: any = await waitFor(events, 'confirm_request');
    expect(request.request).toMatchObject({ tool: 'send_mail', risk: 'external' });
    await expect(s.handle('confirm.resolve', { runId, token: 'forged', approved: true })).rejects.toMatchObject({ code: 'CONFIRM_NOT_FOUND' });
    expect(executed).toBe(0);
    await s.handle('confirm.resolve', { runId, token: request.token, approved: true });
    await waitFor(events, 'run_end');
    expect(executed).toBe(1);
    await expect(s.handle('confirm.resolve', { runId, token: request.token, approved: true })).rejects.toMatchObject({ code: 'CONFIRM_NOT_FOUND' });
  });

  it('enforces API key presence, run concurrency and cancellation', async () => {
    const events: AssistantEvent[] = [];
    const hang = scriptedFetch((call) => new Promise<Response>((_res, rej) => call.init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })));
    const s = new AssistantService({ rootDir: tmp(), secrets: memorySecrets(), fetch: hang.fetch, emit: e => events.push(e) });
    await s.handle('account.select', { accountKey: 'k' });
    await s.handle('providers.save', { config: provider });
    await expect(s.handle('run.start', { providerId: 'p-one', text: 'x' })).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    await s.handle('providers.save', { config: provider, apiKey: 'sk' });
    const a: any = await s.handle('run.start', { providerId: 'p-one', text: '一' });
    await s.handle('run.start', { providerId: 'p-one', text: '二' });
    await expect(s.handle('run.start', { providerId: 'p-one', text: '三' })).rejects.toMatchObject({ code: 'TOO_MANY_RUNS' });
    await expect(s.handle('run.start', { providerId: 'p-one', text: '同会话', sessionId: a.sessionId })).rejects.toMatchObject({ code: 'TOO_MANY_RUNS' });
    await s.handle('run.cancel', { runId: a.runId });
    const end: any = await waitFor(events, 'run_end');
    expect(end).toMatchObject({ runId: a.runId, stopReason: 'cancelled' });
    s.cancelAll();
  });
});

describe('SessionStore', () => {
  it('skips a torn last line after a crash and lists newest first', () => {
    const dir = tmp();
    let t = 0;
    const store = new SessionStore(dir, () => new Date(1_700_000_000_000 + (t += 1000)));
    const a = store.create('第一', null), b = store.create('第二', 'p');
    store.appendMessage(a.id, { role: 'user', content: 'hi' });
    fs.appendFileSync(path.join(dir, `${b.id}.jsonl`), '{"type":"message","at":"x","mess');
    store.rename(b.id, '改名');
    expect(store.get(b.id)?.meta.title).toBe('改名');
    expect(store.list().map(m => m.id)).toEqual([a.id, b.id]);
    expect(() => store.get('../etc/passwd')).toThrow();
  });
});

describe('host restart policy', () => {
  it('backs off exponentially and stops after repeated crashes within the window', () => {
    expect(nextRestartDelay([], 0)).toBe(1000);
    expect(nextRestartDelay([0, 1, 2], 10)).toBe(8000);
    expect(nextRestartDelay([0, 1, 2, 3, 4], 10)).toBeNull();
    expect(nextRestartDelay([0, 1, 2, 3, 4], HOST_LIMITS.restartWindowMs + 10)).toBe(1000);
  });
});
