import { ChatMessage } from '../types';
import { getAgentRuntimeApiBaseUrl, getAgentRuntimeDevHeaders } from './apiBase';

export type AssistantSessionSummary = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  lastMessage?: {
    role: string;
    content: string;
    createdAt: string;
  } | null;
};

const AUTH_TOKEN_KEY = 'bambook_auth_token';

function getRuntimeApiBase() {
  return getAgentRuntimeApiBaseUrl();
}

function authHeaders(extra: Record<string, string> = {}) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) || sessionStorage.getItem(AUTH_TOKEN_KEY);
  const devHeaders = getAgentRuntimeDevHeaders();
  if (Object.keys(devHeaders).length) return { ...devHeaders, ...extra };
  return token ? { ...devHeaders, ...extra, Authorization: `Bearer ${token}` } : { ...devHeaders, ...extra };
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
  }
  return data as T;
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (networkErr) {
    throw new Error(`网络连接失败，请检查服务是否可用: ${(networkErr as Error)?.message || 'unknown'}`);
  }
}

export type AssistantSessionPage = {
  sessions: AssistantSessionSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type ListSessionsOptions = {
  /** 上一页最后一条 session id（服务端按 updatedAt desc 锚定） */
  cursor?: string;
  /** 标题或消息内容关键词 */
  search?: string;
  take?: number;
};

export const assistantSessionService = {
  async listSessions(options: ListSessionsOptions = {}): Promise<AssistantSessionPage> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.search?.trim()) params.set('search', options.search.trim());
    if (typeof options.take === 'number' && Number.isFinite(options.take)) params.set('take', String(options.take));
    const query = params.toString();
    const response = await safeFetch(`${getRuntimeApiBase()}/agent/sessions${query ? `?${query}` : ''}`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    const data = await readJson<{
      sessions: AssistantSessionSummary[];
      pageInfo?: { hasMore?: boolean; nextCursor?: string | null };
    }>(response);
    return {
      sessions: data.sessions || [],
      hasMore: Boolean(data.pageInfo?.hasMore),
      nextCursor: typeof data.pageInfo?.nextCursor === 'string' ? data.pageInfo.nextCursor : null,
    };
  },

  async createSession(title = '新对话'): Promise<AssistantSessionSummary> {
    const response = await safeFetch(`${getRuntimeApiBase()}/agent/sessions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ title }),
    });
    const data = await readJson<{ session: AssistantSessionSummary }>(response);
    return data.session;
  },

  async loadMessages(sessionId: string): Promise<{ session: AssistantSessionSummary; messages: ChatMessage[] }> {
    const response = await safeFetch(`${getRuntimeApiBase()}/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    return readJson(response);
  },

  async saveMessage(sessionId: string, message: ChatMessage): Promise<void> {
    await safeFetch(`${getRuntimeApiBase()}/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({
        role: message.role,
        text: message.text,
        attachments: message.attachments || [],
        sources: message.sources || [],
        thoughtProcess: message.thoughtProcess,
      }),
    }).then(readJson);
  },

  async updateSessionTitle(sessionId: string, title: string): Promise<AssistantSessionSummary> {
    const response = await safeFetch(`${getRuntimeApiBase()}/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ title }),
    });
    const data = await readJson<{ session: AssistantSessionSummary }>(response);
    return data.session;
  },

  async archiveSession(sessionId: string): Promise<void> {
    await safeFetch(`${getRuntimeApiBase()}/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
      credentials: 'include',
    }).then(readJson);
  },
};
