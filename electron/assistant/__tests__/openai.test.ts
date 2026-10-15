import { describe, expect, it } from 'vitest';
import { ChatCompletionsClient, ResponsesClient } from '../models/openai';
import { normalizeProvider } from '../providers';
import { scriptedFetch, sse } from './helpers';

const config = normalizeProvider({ id: 'p-t', name: '测试', format: 'openai', base_url: 'https://api.example.com/v1', model: 'm1', reasoning: 'low' });
const tools = [{ name: 'current_time', description: 'time', parameters: { type: 'object', properties: {} } }];
const req = (extra = {}) => ({ system: 'sys', messages: [{ role: 'user' as const, content: '你好' }], tools, signal: new AbortController().signal, ...extra });

describe('ChatCompletionsClient', () => {
  it('streams text and assembles tool call deltas by index', async () => {
    const f = scriptedFetch(() => sse([
      { choices: [{ delta: { content: '好的' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'current_', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: ':1}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      '[DONE]',
    ]));
    const deltas: string[] = [];
    const r = await new ChatCompletionsClient(config, { url: 'https://api.example.com/v1/chat/completions', headers: { Authorization: 'Bearer k' } }, f.fetch).complete(req({ onEvent: (e: any) => e.type === 'text' && deltas.push(e.delta) }));
    expect(r).toEqual({ text: '好的', toolCalls: [{ id: 'c1', name: 'current_time', arguments: '{"a":1}' }], usage: { input: 10, output: 3 } });
    expect(deltas).toEqual(['好的']);
    const body = f.body(0);
    expect(body).toMatchObject({ model: 'm1', stream: true, reasoning_effort: 'low', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '你好' }] });
    expect(body.tools[0]).toEqual({ type: 'function', function: tools[0] });
  });

  it('maps tool history and HTTP failures without echoing the body', async () => {
    const f = scriptedFetch(() => new Response('{"error":"secret-proxy-detail rate_limit"}', { status: 429 }));
    const client = new ChatCompletionsClient(config, { url: 'u', headers: {} }, f.fetch, '测试');
    await expect(client.complete(req({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'current_time', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c1', name: 'current_time', content: '{}' }] }))).rejects.toMatchObject({ code: 'MODEL_LIMITED' });
    const sent = f.body(0).messages;
    expect(sent[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'current_time', arguments: '{}' } }] });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{}' });
    const g = scriptedFetch(() => new Response('nope', { status: 401 }));
    await expect(new ChatCompletionsClient(config, { url: 'u', headers: {} }, g.fetch).complete(req())).rejects.toThrow(/授权/);
  });
});

describe('ResponsesClient', () => {
  it('converts history to Responses items and reads function calls', async () => {
    const f = scriptedFetch(() => sse([
      { type: 'response.output_text.delta', delta: '查' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'fc1', name: 'current_time', arguments: '{}' } },
      { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'fc1', name: 'current_time', arguments: '{}' }], usage: { input_tokens: 5, output_tokens: 2 } } },
    ]));
    const client = new ResponsesClient({ ...config, format: 'openai-responses' }, { target: async () => ({ url: 'https://api.example.com/v1/responses', headers: {} }) }, f.fetch);
    const r = await client.complete(req({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '先查', toolCalls: [{ id: 'a', name: 'current_time', arguments: '{}' }] }, { role: 'tool', toolCallId: 'a', name: 'current_time', content: 'ok' }] }));
    expect(r.toolCalls).toEqual([{ id: 'fc1', name: 'current_time', arguments: '{}' }]);
    expect(r.usage).toEqual({ input: 5, output: 2 });
    const body = f.body(0);
    expect(body.instructions).toBe('sys');
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先查' }] },
      { type: 'function_call', call_id: 'a', name: 'current_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'ok' },
    ]);
    expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('retries once with refreshed credentials after 401 and surfaces stream failures', async () => {
    const f = scriptedFetch((_c, i) => (i === 0 ? new Response('', { status: 401 }) : sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached' } } }])));
    let refreshed = 0;
    const client = new ResponsesClient(config, { target: async () => ({ url: 'u', headers: { Authorization: 'old' } }), onUnauthorized: async () => { refreshed++; return { url: 'u', headers: { Authorization: 'new' } }; } }, f.fetch);
    await expect(client.complete(req())).rejects.toMatchObject({ code: 'MODEL_LIMITED' });
    expect(refreshed).toBe(1);
    expect((f.calls[1].init.headers as Record<string, string>).Authorization).toBe('new');
  });
});
