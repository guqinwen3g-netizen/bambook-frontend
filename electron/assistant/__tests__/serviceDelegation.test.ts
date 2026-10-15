import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantService, type AssistantEvent } from '../service';
import type { SecretStore } from '../types';
import { json, memorySecrets, scriptedFetch, sse, type Call } from './helpers';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-dlg-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const NOW = new Date('2026-10-15T08:00:00Z');
const provider = { id: 'p-one', name: '测试模型', format: 'openai', base_url: 'https://api.example.com/v1', model: 'm1' };
const API = 'https://bambook.example';
const grant = (token: string, workspaceId = 'w-1', expiresAt = '2026-10-15T10:00:00Z') => ({ accountKey: 'acct-a', token, expiresAt, workspaceId, apiBase: API });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async (events: AssistantEvent[], pred: (e: AssistantEvent) => boolean) => {
  for (let i = 0; i < 300; i++) { const e = events.find(pred); if (e) return e; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('timeout');
};
const ended = (e: AssistantEvent) => e.type === 'run_end' || e.type === 'run_error';
const toolCall = (name: string, args: unknown) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: JSON.stringify(args) } }] } }] }]);
const textReply = (text: string) => sse([{ choices: [{ delta: { content: text } }] }]);
const bambookOk = (workspaceId = 'w-1') => json({ workspace: { id: workspaceId, revision: 1 }, results: [] });
const hangUntilAbort = (call: Call) => new Promise<Response>((_r, rej) => call.init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));

async function setup(handler: (call: Call, index: number) => Response | Promise<Response>, options: { secrets?: SecretStore; now?: () => Date } = {}) {
  const events: AssistantEvent[] = [];
  const f = scriptedFetch(handler);
  const root = tmp();
  const s = new AssistantService({ rootDir: root, secrets: options.secrets ?? memorySecrets(), fetch: f.fetch, emit: e => events.push(e), now: options.now ?? (() => NOW) });
  await s.handle('account.select', { accountKey: 'acct-a' });
  await s.handle('providers.save', { config: provider, apiKey: 'sk-a' });
  return { s, events, f, root };
}

describe('AssistantService 业务委托', () => {
  it('keeps the delegation in memory per account and rejects late renewals for a switched account', async () => {
    const { s, root } = await setup(() => textReply('ok'));
    expect(await s.handle('session.delegation', grant('tok-a'))).toEqual({ connected: true, workspaceId: 'w-1', expiresAt: '2026-10-15T10:00:00.000Z' });
    for (const f of fs.readdirSync(root, { recursive: true }).map(String)) {
      const full = path.join(root, f);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8')).not.toContain('tok-a');
    }
    await s.handle('account.select', { accountKey: 'acct-b' });
    expect((await s.status()).delegation).toBeNull();
    await expect(s.handle('session.delegation', grant('tok-a-late'))).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect((await s.status()).delegation).toBeNull();
    await expect(s.handle('run.start', { providerId: 'p-one', text: 'x', accountKey: 'acct-a', workspaceId: 'w-1' })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    // 切回原账号是新的内存上下文，旧令牌不会复活。
    await s.handle('account.select', { accountKey: 'acct-a' });
    expect((await s.status()).delegation).toBeNull();
    await expect(s.handle('session.delegation', { ...grant('bad'), apiBase: 'file:///etc' })).rejects.toMatchObject({ code: 'DELEGATION_ORIGIN_INVALID' });
    await expect(s.handle('session.delegation', { ...grant('old'), expiresAt: '2026-10-15T07:59:00Z' })).rejects.toMatchObject({ code: 'DELEGATION_EXPIRED' });
  });

  it('renews in the same workspace without cancelling and later tool calls use the new token', async () => {
    const modelGate = deferred<void>();
    let modelCalls = 0;
    const { s, events, f } = await setup(async call => {
      if (call.url.startsWith(API)) return bambookOk();
      modelCalls++;
      if (modelCalls === 1) { await modelGate.promise; return toolCall('bambook_query', { type: 'order' }); }
      return textReply('完成');
    });
    await s.handle('session.delegation', grant('tok-1'));
    const run: any = await s.handle('run.start', { providerId: 'p-one', text: '查订单', accountKey: 'acct-a', workspaceId: 'w-1' });
    await s.handle('session.delegation', grant('tok-2', 'w-1', '2026-10-15T10:30:00Z'));
    modelGate.resolve();
    expect(await waitFor(events, ended)).toMatchObject({ type: 'run_end', runId: run.runId, stopReason: 'completed' });
    const reads = f.calls.filter(c => c.url.startsWith(API));
    expect(reads).toHaveLength(1);
    expect((reads[0].init.headers as any)['x-bambook-delegation']).toBe('tok-2');
    expect(JSON.stringify(events)).not.toContain('tok-');
  });

  it('cancels a running task when the delegation moves to another workspace', async () => {
    const { s, events } = await setup(hangUntilAbort);
    await s.handle('session.delegation', grant('tok-1'));
    const run: any = await s.handle('run.start', { providerId: 'p-one', text: '一直跑', accountKey: 'acct-a', workspaceId: 'w-1' });
    await s.handle('session.delegation', grant('tok-x', 'w-2'));
    expect(await waitFor(events, ended)).toMatchObject({ runId: run.runId, stopReason: 'cancelled' });
  });

  it('asks the page to reconnect when the delegation expired mid-run, without calling the server', async () => {
    let clock = NOW, i = 0;
    const { s, events, f } = await setup(call => call.url.startsWith(API) ? bambookOk() : (i++ === 0 ? toolCall('bambook_get', { type: 'order', id: 'o1' }) : textReply('需要重新授权')), { now: () => clock });
    await s.handle('session.delegation', grant('tok-1', 'w-1', '2026-10-15T08:01:00Z'));
    clock = new Date('2026-10-15T08:05:00Z');
    await s.handle('run.start', { providerId: 'p-one', text: '读订单', accountKey: 'acct-a', workspaceId: 'w-1' });
    expect(await waitFor(events, e => e.type === 'delegation_needed')).toEqual({ type: 'delegation_needed', workspaceId: 'w-1', reason: 'expired' });
    await waitFor(events, ended);
    expect(f.calls.some(c => c.url.startsWith(API))).toBe(false);
  });

  it('refuses to continue a conversation bound to another workspace and requires the current delegation', async () => {
    const { s, events } = await setup(call => call.url.startsWith(API) ? bambookOk() : textReply('好'));
    await expect(s.handle('run.start', { providerId: 'p-one', text: 'x', accountKey: 'acct-a', workspaceId: 'w-1' })).rejects.toMatchObject({ code: 'DELEGATION_NEEDED' });
    await s.handle('session.delegation', grant('tok-1'));
    const first: any = await s.handle('run.start', { providerId: 'p-one', text: '在甲空间', accountKey: 'acct-a', workspaceId: 'w-1' });
    await waitFor(events, ended);
    expect((await s.handle('sessions.get', { id: first.sessionId }) as any).meta.workspaceId).toBe('w-1');
    await s.handle('session.delegation', grant('tok-2', 'w-2'));
    await expect(s.handle('run.start', { providerId: 'p-one', text: '接着说', sessionId: first.sessionId, accountKey: 'acct-a', workspaceId: 'w-2' })).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
    await expect(s.handle('run.start', { providerId: 'p-one', text: '冒用旧空间', accountKey: 'acct-a', workspaceId: 'w-1' })).rejects.toMatchObject({ code: 'DELEGATION_NEEDED' });
  });

  it('does not start the old run when the account switches while credentials are being read', async () => {
    const base = memorySecrets();
    const gate = deferred<void>();
    let slow = false;
    const secrets: SecretStore = { ...base, get: async k => { if (slow) { slow = false; await gate.promise; } return base.get(k); } };
    const { s, events, f } = await setup(() => textReply('不该运行'), { secrets });
    await s.handle('session.delegation', grant('tok-1'));
    slow = true;
    const pending = s.handle('run.start', { providerId: 'p-one', text: '旧账号任务', accountKey: 'acct-a', workspaceId: 'w-1' });
    await new Promise(r => setTimeout(r, 5));
    await s.handle('account.select', { accountKey: 'acct-b' });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
    await new Promise(r => setTimeout(r, 20));
    expect(events.filter(e => e.type.startsWith('run'))).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(await s.handle('sessions.list')).toEqual([]);
  });

  it('clearing the authorization cancels runs and leaves no delegation behind', async () => {
    const { s, events } = await setup(hangUntilAbort);
    await s.handle('session.delegation', grant('tok-1'));
    const run: any = await s.handle('run.start', { providerId: 'p-one', text: '长任务', accountKey: 'acct-a', workspaceId: 'w-1' });
    expect(await s.handle('session.delegation', { accountKey: 'acct-a', clear: true })).toEqual({ connected: false, workspaceId: null, expiresAt: null });
    expect(await waitFor(events, ended)).toMatchObject({ runId: run.runId, stopReason: 'cancelled' });
    expect((await s.status()).delegation).toBeNull();
  });
});
