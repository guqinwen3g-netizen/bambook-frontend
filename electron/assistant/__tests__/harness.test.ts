import { describe, expect, it, vi } from 'vitest';
import { fitContext, repairHistory, runTurn, DEFAULT_LIMITS, type HarnessEvent } from '../harness';
import { ToolRegistry, type ToolDefinition } from '../tools';
import type { ChatMessage, ModelClient, ModelRequest, ModelResult } from '../types';

const scripted = (steps: Array<ModelResult | ((r: ModelRequest) => Promise<ModelResult>)>) => {
  const seen: ModelRequest[] = [];
  const client: ModelClient = { complete: async r => { seen.push({ ...r, messages: [...r.messages] }); const s = steps[seen.length - 1]; if (!s) throw new Error('no more steps'); return typeof s === 'function' ? s(r) : s; } };
  return { client, seen };
};
const call = (id: string, name: string, args: unknown = {}) => ({ id, name, arguments: JSON.stringify(args) });
const tool = (over: Partial<ToolDefinition> & Pick<ToolDefinition, 'name'>): ToolDefinition => ({ description: 'd', parameters: { type: 'object', properties: {} }, risk: 'read', confirm: 'never', run: async () => ({ ok: true }), ...over });
const base = (client: ModelClient, tools: ToolRegistry, extra: Partial<Parameters<typeof runTurn>[0]> = {}) => {
  const events: HarnessEvent[] = [];
  return { events, input: { client, system: 's', history: [], userText: '做事', tools, sessionId: 's1', signal: new AbortController().signal, onEvent: (e: HarnessEvent) => events.push(e), confirm: async () => true, ...extra } };
};

describe('runTurn', () => {
  it('loops model → tool → model and records every message in order', async () => {
    const run = vi.fn(async () => ({ now: 'x' }));
    const { client, seen } = scripted([{ text: '', toolCalls: [call('c1', 'read_a')] }, { text: '完成', toolCalls: [] }]);
    const onMessage = vi.fn();
    const { input } = base(client, new ToolRegistry([tool({ name: 'read_a', run })]), { onMessage });
    const r = await runTurn(input);
    expect(r).toMatchObject({ text: '完成', stopReason: 'completed', steps: 2 });
    expect(r.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(onMessage).toHaveBeenCalledTimes(4);
    expect(seen[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1', content: '{"now":"x"}' });
  });

  it('asks once per form/task/object group for grouped writes and each time for external actions', async () => {
    const write = tool({ name: 'save_dev', risk: 'write', confirm: 'grouped', groupKey: a => String(a.devId) });
    const send = tool({ name: 'send_mail', risk: 'external', confirm: 'each' });
    const { client } = scripted([
      { text: '', toolCalls: [call('a', 'save_dev', { devId: 1 }), call('b', 'save_dev', { devId: 1 }), call('c', 'save_dev', { devId: 2 })] },
      { text: '', toolCalls: [call('d', 'send_mail'), call('e', 'send_mail')] },
      { text: 'ok', toolCalls: [] },
    ]);
    const confirm = vi.fn(async () => true);
    const { input } = base(client, new ToolRegistry([write, send]), { confirm });
    await runTurn(input);
    expect(confirm.mock.calls.map(c => (c as any)[0].groupKey)).toEqual(['save_dev:1', 'save_dev:2', 'send_mail:*', 'send_mail:*']);
  });

  it('does not execute denied actions and tells the model not to retry', async () => {
    const run = vi.fn(async () => 'sent');
    const { client, seen } = scripted([{ text: '', toolCalls: [call('a', 'send_mail')] }, { text: '好的，不发送', toolCalls: [] }]);
    const { input, events } = base(client, new ToolRegistry([tool({ name: 'send_mail', risk: 'external', confirm: 'each', run })]), { confirm: async () => false });
    await runTurn(input);
    expect(run).not.toHaveBeenCalled();
    expect(seen[1].messages.at(-1)?.content).toContain('没有确认');
    expect(events).toContainEqual({ type: 'confirm_resolved', callId: 'a', approved: false });
  });

  it('reports unknown tools, bad arguments and tool timeouts back to the model', async () => {
    const slow = tool({ name: 'slow', timeoutMs: 20, run: () => new Promise(() => undefined) });
    const needs = tool({ name: 'needs', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } });
    const { client, seen } = scripted([{ text: '', toolCalls: [call('a', 'nope'), call('b', 'needs'), call('c', 'slow')] }, { text: 'done', toolCalls: [] }]);
    const { input } = base(client, new ToolRegistry([slow, needs]));
    await runTurn(input);
    const results = seen[1].messages.filter(m => m.role === 'tool').map(m => m.content);
    expect(results[0]).toContain('不存在');
    expect(results[1]).toContain('缺少参数');
    expect(results[2]).toContain('超过');
  });

  it('stops on cancel, on max steps, and truncates oversized results', async () => {
    const controller = new AbortController();
    const { client } = scripted([async r => { controller.abort(); await new Promise(res => setTimeout(res, 5)); if (r.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return { text: '', toolCalls: [] }; }]);
    const { input } = base(client, new ToolRegistry(), { signal: controller.signal });
    expect((await runTurn(input)).stopReason).toBe('cancelled');

    const loop = scripted(Array.from({ length: 3 }, (_, i) => ({ text: '', toolCalls: [call('c' + i, 'big')] })));
    const big = tool({ name: 'big', run: async () => 'x'.repeat(500) });
    const second = base(loop.client, new ToolRegistry([big]), { limits: { maxSteps: 2, maxToolResultChars: 100 } });
    const r = await runTurn(second.input);
    expect(r.stopReason).toBe('max_steps');
    expect(r.messages.find(m => m.role === 'tool')?.content).toContain('已截取前 100');
  });

  it('runs read tools in parallel but writes sequentially', async () => {
    const order: string[] = [];
    const slowRead = (name: string) => tool({ name, run: async () => { order.push(name + ':start'); await new Promise(r => setTimeout(r, 10)); order.push(name + ':end'); return 1; } });
    const write = tool({ name: 'w', risk: 'local_write', run: async () => { order.push('w'); return 1; } });
    const { client } = scripted([{ text: '', toolCalls: [call('1', 'r1'), call('2', 'r2'), call('3', 'w')] }, { text: 'ok', toolCalls: [] }]);
    await runTurn(base(client, new ToolRegistry([slowRead('r1'), slowRead('r2'), write])).input);
    expect(order).toEqual(['r1:start', 'r2:start', 'r1:end', 'r2:end', 'w']);
  });
});

describe('context helpers', () => {
  it('repairs dangling tool calls left by an interrupted turn', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [call('a', 't'), call('b', 't')] }, { role: 'tool', toolCallId: 'a', name: 't', content: 'ok' }, { role: 'user', content: 'next' }];
    const fixed = repairHistory(history);
    expect(fixed.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(fixed[3]).toMatchObject({ toolCallId: 'b' });
  });

  it('drops whole oldest turns to fit the budget while keeping the current turn', () => {
    const turn = (i: number): ChatMessage[] => [{ role: 'user', content: 'u' + i + 'x'.repeat(3000) }, { role: 'assistant', content: 'a' + i }];
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const current: ChatMessage[] = [{ role: 'user', content: 'now' }];
    const { messages, dropped } = fitContext('s', history, current, { ...DEFAULT_LIMITS, contextWindow: 7000, maxOutputTokens: 1000 });
    expect(dropped).toBeGreaterThan(0);
    expect(messages[0].role).toBe('user');
    expect(messages.at(-1)).toEqual(current[0]);
  });

  it('refuses to register write or external tools without confirmation', () => {
    expect(() => new ToolRegistry([tool({ name: 'w', risk: 'write', confirm: 'never' })])).toThrow();
    expect(() => new ToolRegistry([tool({ name: 'e', risk: 'external', confirm: 'grouped' })])).toThrow();
  });
});
