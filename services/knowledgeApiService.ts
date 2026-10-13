import { DEFAULT_KNOWLEDGE_API_ENDPOINT } from './apiService';

export interface KnowledgeApiHealth {
  status: string;
}

export interface KnowledgeSearchResult {
  id?: string;
  content?: string;
  document?: string;
  text?: string;
  source_title?: string;
  metadata?: Record<string, unknown>;
  distance?: number;
  score?: number;
  [key: string]: unknown;
}

export interface KnowledgeApiTestResult {
  ok: boolean;
  status?: string;
  detail?: string;
  testedUrl?: string;
  statusCode?: number;
}

export interface KnowledgeIngestBody {
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchBody {
  query: string;
  top_k?: number;
}

export interface KnowledgeChatDebugBody {
  message: string;
}

const normalizeKnowledgeEndpoint = (endpoint?: string): string => {
  const raw = endpoint?.trim() || DEFAULT_KNOWLEDGE_API_ENDPOINT;
  return raw.replace(/\/+$/, '');
};

const buildKnowledgeUrl = (path: string, endpoint?: string): string => {
  const base = normalizeKnowledgeEndpoint(endpoint);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
};

const authHeaders = (apiKey?: string): HeadersInit => {
  const trimmed = apiKey?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
};

async function requestKnowledgeJson<T>(
  path: string,
  options: RequestInit & { endpoint?: string; apiKey?: string } = {},
): Promise<T> {
  const { endpoint, apiKey, headers, ...init } = options;
  const res = await fetch(buildKnowledgeUrl(path, endpoint), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(apiKey),
      ...headers,
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Knowledge API ${res.status}: ${detail || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export const knowledgeApiService = {
  buildKnowledgeUrl,
  normalizeKnowledgeEndpoint,

  async health(endpoint?: string): Promise<KnowledgeApiHealth> {
    return requestKnowledgeJson<KnowledgeApiHealth>('/health', {
      endpoint,
      method: 'GET',
      headers: {},
    });
  },

  async testConnection(endpoint?: string, apiKey?: string): Promise<KnowledgeApiTestResult> {
    try {
      const healthUrl = this.buildKnowledgeUrl('/health', endpoint);
      const health = await this.health(endpoint);
      if (health.status !== 'ok') {
        return { ok: false, status: health.status, testedUrl: healthUrl, detail: '健康检查返回格式异常。' };
      }

      if (!apiKey?.trim()) {
        return { ok: true, status: health.status, testedUrl: healthUrl, detail: '健康检查通过；未填写 API Key，已跳过 Bearer 认证接口测试。' };
      }

      await this.debugContext({ message: '健康检查' }, endpoint, apiKey);
      return { ok: true, status: health.status, testedUrl: healthUrl };
    } catch (error: any) {
      const message = error?.message || '知识库 API 连接失败。';
      const statusMatch = message.match(/Knowledge API (\d+)/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
      return {
        ok: false,
        testedUrl: this.buildKnowledgeUrl('/health', endpoint),
        statusCode,
        detail: statusCode === 401
          ? '知识库 Bearer Token 缺失或无效。请检查知识库 API Key。'
          : message,
      };
    }
  },

  async search(body: KnowledgeSearchBody, endpoint?: string, apiKey?: string): Promise<KnowledgeSearchResult[]> {
    const data = await requestKnowledgeJson<{ results: KnowledgeSearchResult[] }>('/v1/knowledge/search', {
      endpoint,
      apiKey,
      method: 'POST',
      body: JSON.stringify(body),
    });
    return Array.isArray(data.results) ? data.results : [];
  },

  async ingest(body: KnowledgeIngestBody, endpoint?: string, apiKey?: string): Promise<{ inserted_chunks: number }> {
    return requestKnowledgeJson<{ inserted_chunks: number }>('/v1/knowledge/ingest', {
      endpoint,
      apiKey,
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async debugContext(body: KnowledgeChatDebugBody, endpoint?: string, apiKey?: string): Promise<KnowledgeSearchResult[]> {
    const data = await requestKnowledgeJson<{ results: KnowledgeSearchResult[] }>('/v1/chat/debug-context', {
      endpoint,
      apiKey,
      method: 'POST',
      body: JSON.stringify(body),
    });
    return Array.isArray(data.results) ? data.results : [];
  },
};
