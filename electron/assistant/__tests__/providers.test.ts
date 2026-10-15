import { describe, expect, it } from 'vitest';
import { normalizeProvider, CHATGPT_BASE_URL } from '../providers';

describe('normalizeProvider', () => {
  it('keeps OpenBitFun-shaped fields for OpenAI-compatible providers', () => {
    const c = normalizeProvider({ id: 'p-one', name: 'DeepSeek', format: 'openai', base_url: 'https://api.example.com/v1/', model: 'deepseek-chat', context_window: '64000', max_tokens: 4096, temperature: 0.3, top_p: 0.9, custom_headers: { 'X-Org': 'a' }, custom_request_body: { seed: 1 } });
    expect(c).toMatchObject({ base_url: 'https://api.example.com/v1', context_window: 64000, max_tokens: 4096, temperature: 0.3, top_p: 0.9, custom_headers: { 'X-Org': 'a' }, custom_request_body: { seed: 1 } });
    expect(c).not.toHaveProperty('api_key');
  });

  it('pins ChatGPT login to the Codex backend and ignores custom transport fields', () => {
    const c = normalizeProvider({ id: 'p-gpt', name: '我的 ChatGPT', format: 'chatgpt-subscription', base_url: 'https://evil.example', custom_headers: { 'X-A': '1' }, reasoning: 'high' });
    expect(c).toMatchObject({ base_url: CHATGPT_BASE_URL, model: 'gpt-6-luna', reasoning: 'high' });
    expect(c.custom_headers).toBeUndefined();
  });

  it('rejects unsupported formats, insecure urls, reserved headers and body overrides', () => {
    const base = { id: 'p-x', name: 'x', model: 'm' };
    expect(() => normalizeProvider({ ...base, format: 'anthropic', base_url: 'https://a.b' })).toThrow('不支持');
    expect(() => normalizeProvider({ ...base, format: 'openai', base_url: 'http://api.example.com' })).toThrow('https');
    expect(() => normalizeProvider({ ...base, format: 'openai', base_url: 'https://u:p@api.example.com' })).toThrow('账号或密码');
    expect(() => normalizeProvider({ ...base, format: 'openai', base_url: 'https://a.b', custom_headers: { Authorization: 'x' } })).toThrow('不可自定义');
    expect(() => normalizeProvider({ ...base, format: 'openai', base_url: 'https://a.b', custom_request_body: { model: 'other' } })).toThrow('不可覆盖');
    expect(normalizeProvider({ ...base, format: 'openai', base_url: 'http://localhost:11434/v1' }).base_url).toBe('http://localhost:11434/v1');
  });
});
