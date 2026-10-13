import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeAgentTool } from '../toolRuntime';
import { addVolcKnowledgeDocument } from '../../ai/volcKnowledge';
import type { ActorContext } from '../types';

/**
 * 2026-08-19 批次1-1d：RAG 降级显式化测试。
 *
 * searchKnowledge 通过 ragDegraded / ragDegradedReason / notice 向 LLM observation
 * 显式暴露语义检索可用性；"服务正常但零命中"（empty）不算降级。
 * volc 写入通道未配置 key → 显式 skip，不抛错（上传路由不再 502）。
 */

const ownerActor: ActorContext = {
  userId: 'u1',
  displayName: 'Tester',
  roles: ['owner'],
  departmentIds: ['company'],
  memoryScopes: ['personal:u1'],
  toolScopes: ['products', 'orders', 'relations', 'knowledge', 'finance', 'email', 'entities', 'development', 'templates'],
} as any;

function makeEmptyKnowledgePrisma() {
  return {
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    knowledgeDocument: { findMany: vi.fn(async () => []) },
    knowledgeItem: { findMany: vi.fn(async () => []) },
    agentTool: { upsert: vi.fn().mockResolvedValue({}) },
    agentToolPermission: { upsert: vi.fn().mockResolvedValue({}) },
    agentToolRun: { create: vi.fn().mockResolvedValue({ id: 'atr_1' }) },
    userAccount: { findFirst: vi.fn().mockResolvedValue(null) },
  } as any;
}

async function runKnowledgeSearch() {
  return executeAgentTool({
    prisma: makeEmptyKnowledgePrisma(),
    actor: ownerActor,
    toolId: 'knowledge.search',
    toolInput: { query: '样品发票规则', limit: 5 },
  } as any) as Promise<Record<string, any>>;
}

const ORIGINAL_RAG_KEY = process.env.BAMBOOK_RAG_API_KEY;

beforeEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BAMBOOK_RAG_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_RAG_KEY !== undefined) process.env.BAMBOOK_RAG_API_KEY = ORIGINAL_RAG_KEY;
  else delete process.env.BAMBOOK_RAG_API_KEY;
  vi.unstubAllGlobals();
});

describe('RAG 降级显式化（批次1-1d）', () => {
  it('未配置 BAMBOOK_RAG_API_KEY → ragDegraded=true not_configured + notice 提示降级为关键词匹配', async () => {
    const result = await runKnowledgeSearch();
    expect(result.ragDegraded).toBe(true);
    expect(result.ragDegradedReason).toBe('not_configured');
    expect(result.notice).toContain('语义检索（RAG 向量）不可用');
    expect(result.notice).toContain('关键词子串匹配');
    expect(result.dataSource).toBe('bambook-data-center');
  });

  it('RAG 服务不可达（fetch 抛错）→ ragDegraded=true unreachable', async () => {
    process.env.BAMBOOK_RAG_API_KEY = 'test-rag-key';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const result = await runKnowledgeSearch();
    expect(result.ragDegraded).toBe(true);
    expect(result.ragDegradedReason).toBe('unreachable');
    expect(result.notice).toBeTruthy();
  });

  it('RAG HTTP 错误（非 2xx）→ ragDegraded=true http_error', async () => {
    process.env.BAMBOOK_RAG_API_KEY = 'test-rag-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));

    const result = await runKnowledgeSearch();
    expect(result.ragDegraded).toBe(true);
    expect(result.ragDegradedReason).toBe('http_error');
  });

  it('RAG 服务正常但零命中 → ragDegraded=false（empty 非降级，无 notice）', async () => {
    process.env.BAMBOOK_RAG_API_KEY = 'test-rag-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    })));

    const result = await runKnowledgeSearch();
    expect(result.ragDegraded).toBe(false);
    expect(result.notice).toBeUndefined();
    expect(result.dataSource).toBe('bambook-data-center');
  });

  it('RAG 健康命中 → dataSource=bambook-rag，结果优先来自向量检索', async () => {
    process.env.BAMBOOK_RAG_API_KEY = 'test-rag-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{
          content: '样品发票必须包含成分比例。',
          source_title: '样品发票规则手册',
          score: 0.92,
          metadata: { category: 'company' },
        }],
      }),
    })));

    const result = await runKnowledgeSearch();
    expect(result.dataSource).toBe('bambook-rag');
    expect(result.ragDegraded).toBe(false);
    expect(result.items[0]).toMatchObject({ source: 'rag-knowledge:company', title: '样品发票规则手册' });
  });
});

describe('volcKnowledge 写入通道未配置显式化（批次1-1d）', () => {
  const ORIGINAL_VOLC_KEY = process.env.BAMBOOK_KNOWLEDGE_API_KEY;

  afterEach(() => {
    if (ORIGINAL_VOLC_KEY !== undefined) process.env.BAMBOOK_KNOWLEDGE_API_KEY = ORIGINAL_VOLC_KEY;
    else delete process.env.BAMBOOK_KNOWLEDGE_API_KEY;
  });

  it('未配置 BAMBOOK_KNOWLEDGE_API_KEY → 返回 skipped:not_configured，不抛错（上传路由不 502）', async () => {
    delete process.env.BAMBOOK_KNOWLEDGE_API_KEY;
    await expect(addVolcKnowledgeDocument({
      collectionName: 'c1', docId: 'd1', docName: 'n', docType: 'pdf', url: 'https://x/y.pdf',
    })).resolves.toEqual({ skipped: 'not_configured' });
  });
});
