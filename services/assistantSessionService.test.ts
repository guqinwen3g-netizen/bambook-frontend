import { beforeEach, describe, expect, it, vi } from 'vitest';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

vi.mock('./apiBase', () => ({
  getApiBaseUrl: () => 'https://bambook.test/api',
  getAgentRuntimeApiBaseUrl: () => 'https://bambook.test/api',
  getAgentRuntimeDevHeaders: () => ({}),
}));

describe('assistantSessionService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('renames a session through the backend PATCH endpoint', async () => {
    localStorage.setItem('bambook_auth_token', 'token-1');
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        session: {
          id: 'as_1',
          title: '新标题',
          status: 'active',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:01:00.000Z',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { assistantSessionService } = await import('./assistantSessionService');
    const session = await assistantSessionService.updateSessionTitle('as_1', '新标题');

    expect(session.title).toBe('新标题');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bambook.test/api/agent/sessions/as_1',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-1',
        }),
        body: JSON.stringify({ title: '新标题' }),
      }),
    );
  });

  it('lists sessions with cursor/search query params and returns page info', async () => {
    localStorage.setItem('bambook_auth_token', 'token-3');
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessions: [{ id: 'as_10', title: '面料询价', status: 'active', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' }],
        pageInfo: { hasMore: true, nextCursor: 'as_10', take: 50 },
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { assistantSessionService } = await import('./assistantSessionService');
    const page = await assistantSessionService.listSessions({ cursor: 'as_9', search: '面料' });

    expect(page.sessions).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('as_10');
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://bambook.test/api/agent/sessions?cursor=as_9&search=${encodeURIComponent('面料')}`,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('lists sessions without query string when no options are given', async () => {
    localStorage.setItem('bambook_auth_token', 'token-4');
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessions: [], pageInfo: { hasMore: false, nextCursor: null } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { assistantSessionService } = await import('./assistantSessionService');
    const page = await assistantSessionService.listSessions();

    expect(page).toEqual({ sessions: [], hasMore: false, nextCursor: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bambook.test/api/agent/sessions',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('archives a session through the backend soft-delete endpoint', async () => {
    sessionStorage.setItem('bambook_auth_token', 'token-2');
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { assistantSessionService } = await import('./assistantSessionService');
    await assistantSessionService.archiveSession('as_2');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://bambook.test/api/agent/sessions/as_2',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-2',
        }),
      }),
    );
  });
});
