/**
 * 批次 2a「LLM 网关备用 provider 配置化」测试
 *
 * 覆盖：
 *   A. resolveLlmProviderChain 链解析（主 provider / 备用启用与跳过 / 空链）
 *   B. createLlmCompleter 失败转移（主 500 → 备用成功 / 全链失败语义化 / AbortError 不转移）
 *   C. 同 provider 内流式失败降级非流式
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLlmProviderChain, createLlmCompleter } from '../llmProviders';

const ENV_KEYS = [
  'ARK_API_KEY', 'VOLCENGINE_API_KEY', 'TENCENT_API_KEY', 'ZHIPU_API_KEY',
  'BAMBOOK_MODEL_BASE_URL', 'BAMBOOK_MODEL_NAME',
  'BAMBOOK_LLM_BACKUP_URL', 'BAMBOOK_LLM_BACKUP_KEY', 'BAMBOOK_LLM_BACKUP_MODEL',
  'BAMBOOK_LLM_BACKUP2_URL', 'BAMBOOK_LLM_BACKUP2_KEY', 'BAMBOOK_LLM_BACKUP2_MODEL',
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

const BASE_INPUT = {
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  signal: new AbortController().signal,
};

function okCompletion(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

describe('A. resolveLlmProviderChain', () => {
  it('无任何 key → 空链', () => {
    expect(resolveLlmProviderChain()).toEqual([]);
  });

  it('仅主 key → 单 provider 链，id=primary', () => {
    process.env.ARK_API_KEY = 'k1';
    const chain = resolveLlmProviderChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe('primary');
    expect(chain[0].baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
  });

  it('主 + backup + backup2 → 三级链按序', () => {
    process.env.ARK_API_KEY = 'k1';
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    process.env.BAMBOOK_LLM_BACKUP_KEY = 'bk1';
    process.env.BAMBOOK_LLM_BACKUP_MODEL = 'm1';
    process.env.BAMBOOK_LLM_BACKUP2_URL = 'https://b2/v1';
    process.env.BAMBOOK_LLM_BACKUP2_KEY = 'bk2';
    const chain = resolveLlmProviderChain();
    expect(chain.map(p => p.id)).toEqual(['primary', 'backup', 'backup2']);
    expect(chain[1].model).toBe('m1');
    // backup2 未配 MODEL → 回落全局默认
    expect(chain[2].model).toBe('ark-code-latest');
  });

  it('备用缺 KEY → 跳过该备用', () => {
    process.env.ARK_API_KEY = 'k1';
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    const chain = resolveLlmProviderChain();
    expect(chain.map(p => p.id)).toEqual(['primary']);
  });

  it('无主 key 但配置备用 → 备用链可用', () => {
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    process.env.BAMBOOK_LLM_BACKUP_KEY = 'bk1';
    const chain = resolveLlmProviderChain();
    expect(chain.map(p => p.id)).toEqual(['backup']);
  });
});

describe('B. createLlmCompleter 失败转移', () => {
  it('空链 → 报未配置错误', async () => {
    const complete = createLlmCompleter();
    await expect(complete(BASE_INPUT)).rejects.toThrow('Model API key is not configured');
  });

  it('主 provider 500 → 备用 provider 成功返回', async () => {
    process.env.ARK_API_KEY = 'k1';
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    process.env.BAMBOOK_LLM_BACKUP_KEY = 'bk1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"primary down"}}', { status: 500 }))
      .mockResolvedValueOnce(okCompletion('from-backup'));
    vi.stubGlobal('fetch', fetchMock);

    const complete = createLlmCompleter();
    const result = await complete(BASE_INPUT);
    expect(result).toBe('from-backup');
    // 第一次打主 baseUrl，第二次打备用 baseUrl
    expect(String(fetchMock.mock.calls[0][0])).toContain('ark.cn-beijing.volces.com');
    expect(String(fetchMock.mock.calls[1][0])).toContain('https://b1/v1');
  });

  it('全链失败 → LLM_ALL_PROVIDERS_FAILED 含逐 provider 摘要', async () => {
    process.env.ARK_API_KEY = 'k1';
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    process.env.BAMBOOK_LLM_BACKUP_KEY = 'bk1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const complete = createLlmCompleter();
    await expect(complete(BASE_INPUT)).rejects.toThrow(/LLM_ALL_PROVIDERS_FAILED.*primary.*backup/s);
  });

  it('AbortError 不转移，直接抛出', async () => {
    process.env.ARK_API_KEY = 'k1';
    process.env.BAMBOOK_LLM_BACKUP_URL = 'https://b1/v1';
    process.env.BAMBOOK_LLM_BACKUP_KEY = 'bk1';
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);

    const complete = createLlmCompleter();
    await expect(complete(BASE_INPUT)).rejects.toBe(abortErr);
    // 只调用过一次（主 provider），未尝试备用
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('C. 流式降级', () => {
  it('流式失败（500）→ 同 provider 降级非流式成功', async () => {
    process.env.ARK_API_KEY = 'k1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('stream down', { status: 500 }))
      .mockResolvedValueOnce(okCompletion('non-stream-ok'));
    vi.stubGlobal('fetch', fetchMock);

    const complete = createLlmCompleter();
    const onDelta = vi.fn();
    const result = await complete({ ...BASE_INPUT, onDelta });
    expect(result).toBe('non-stream-ok');
    // 两次都打主 provider（无备用可转移）
    expect(String(fetchMock.mock.calls[0][0])).toContain('ark.cn-beijing.volces.com');
    expect(String(fetchMock.mock.calls[1][0])).toContain('ark.cn-beijing.volces.com');
  });

  it('流式成功 → 直接返回流式聚合文本', async () => {
    process.env.ARK_API_KEY = 'k1';
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      'data: [DONE]',
    ].join('\n');
    const streamRes = new Response(sseBody, { status: 200 });
    const fetchMock = vi.fn().mockResolvedValueOnce(streamRes);
    vi.stubGlobal('fetch', fetchMock);

    const complete = createLlmCompleter();
    const onDelta = vi.fn();
    const result = await complete({ ...BASE_INPUT, onDelta });
    expect(result).toBe('你好');
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
