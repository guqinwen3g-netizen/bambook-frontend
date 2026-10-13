// @vitest-environment jsdom
// authService 模块在浏览器语义下运行（window.location 等），文件级开启 jsdom
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

describe('authService checkAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('keeps a settled guest screen mounted during a pending focus refresh', async () => {
    const unauthorized = { ok: false, status: 401, text: async () => '{}' };
    let finishRefresh!: (response: typeof unauthorized) => void;
    const fetchSpy = vi.fn().mockResolvedValueOnce(unauthorized)
      .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    vi.stubGlobal('fetch', fetchSpy);
    const { checkAuth, getAuthState, subscribe } = await import('./authService');
    expect(getAuthState().isLoading).toBe(true);
    await checkAuth();
    const observer = vi.fn();
    const unsubscribe = subscribe(observer);
    const refresh = checkAuth();
    expect(getAuthState()).toMatchObject({ isLoading: false, isAuthenticated: false });
    expect(observer.mock.calls.every(([state]) => !state.isLoading)).toBe(true);
    finishRefresh(unauthorized);
    await refresh;
    expect(getAuthState()).toMatchObject({ isLoading: false, isAuthenticated: false });
    unsubscribe();
  });

  it('checks the cookie session when no auth token is stored', async () => {
    // PROD 构建语义（vitest 下 DEV 默认 true，stub false 断言生产行为不变）
    vi.stubEnv('DEV', false);
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'UNAUTHORIZED' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { checkAuth } = await import('./authService');

    await expect(checkAuth()).resolves.toEqual({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/me',
      expect.objectContaining({
        method: 'GET',
        headers: {},
        credentials: 'include',
      }),
    );
  });

  it('restores the user from an existing cookie session when no local token is stored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        user: {
          id: 'u-cookie',
          displayName: 'Cookie User',
          email: 'cookie@example.com',
          roles: ['viewer'],
          permissions: ['orders:read'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { checkAuth, getAuthState } = await import('./authService');

    await expect(checkAuth()).resolves.toMatchObject({
      isLoading: false,
      isAuthenticated: true,
      user: { displayName: 'Cookie User' },
    });
    expect(getAuthState().user?.email).toBe('cookie@example.com');
    expect(JSON.parse(localStorage.getItem('bambook_auth_user') || '{}').displayName).toBe('Cookie User');
  });

  it('renders from cached user permissions while refreshing the session in the background', async () => {
    localStorage.setItem('bambook_auth_token', 'token-1');
    localStorage.setItem('bambook_auth_user', JSON.stringify({
      id: 'u1',
      displayName: 'Cached User',
      email: 'cached@example.com',
      roles: ['viewer'],
      permissions: ['relations:read'],
      departmentIds: ['company'],
      department: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const { View } = await import('../types');
    const { checkAuth, getAuthState, canAccessView } = await import('./authService');

    expect(getAuthState()).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
      user: { displayName: 'Cached User' },
    });
    expect(canAccessView(View.Relations)).toBe(true);

    await expect(checkAuth()).resolves.toMatchObject({
      isLoading: false,
      isAuthenticated: true,
      user: { displayName: 'Cached User' },
    });
  });

  it('drops the cached user in dev when a session refresh returns 401 (session definitively dead)', async () => {
    localStorage.setItem('bambook_auth_token', 'token-1');
    localStorage.setItem('bambook_auth_user', JSON.stringify({
      id: 'u1',
      displayName: 'Cached User',
      email: 'cached@example.com',
      roles: ['viewer'],
      permissions: ['orders:read'],
      departmentIds: ['company'],
      department: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'UNAUTHORIZED', message: 'Token expired or invalid.' }),
    })));

    const { checkAuth, getAuthState } = await import('./authService');

    await expect(checkAuth()).resolves.toMatchObject({
      isLoading: false,
      isAuthenticated: false,
      user: null,
    });
    expect(getAuthState().isAuthenticated).toBe(false);
  });

  it('logs in against the default cloud API when no endpoint is stored (PROD builds)', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          avatarUrl: 'data:image/webp;base64,abc',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('defaults login to the local backend in DEV when no endpoint is stored (dev closed loop)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8081/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('updates the cached current user when profile avatar changes', async () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem('bambook_auth_token', 'token-1');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          avatarUrl: 'data:image/webp;base64,next',
          roles: ['viewer'],
          permissions: ['orders:read'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { updateMyProfile, getAuthState } = await import('./authService');
    const user = await updateMyProfile({ avatarUrl: 'data:image/webp;base64,next' });

    expect(fetch).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/me',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl: 'data:image/webp;base64,next' }),
      }),
    );
    expect(user.avatarUrl).toBe('data:image/webp;base64,next');
    expect(getAuthState().user?.avatarUrl).toBe('data:image/webp;base64,next');
    expect(JSON.parse(localStorage.getItem('bambook_auth_user') || '{}').avatarUrl).toBe('data:image/webp;base64,next');
  });

  it('keeps LAN phone preview login on the default cloud API when no endpoint is stored (PROD builds)', async () => {
    vi.stubEnv('DEV', false);
    // window stub 必须保留 setTimeout/clearTimeout（authService fetchWithTimeout 依赖），
    // 只覆盖 location.hostname 模拟 LAN 手机预览场景
    vi.stubGlobal('window', {
      location: {
        hostname: '192.168.31.46',
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('honors stored Cloudflare endpoint for LAN phone preview login', async () => {
    vi.stubGlobal('window', {
      location: {
        hostname: '192.168.31.46',
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'https://jiangsupanda.com/bambook',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not log in against a local database endpoint from stored config (PROD builds)', async () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'http://127.0.0.1:8081',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'https://jiangsupanda.com/bambook/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps login on an explicitly stored local endpoint in DEV (no remap to production)', async () => {
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'http://127.0.0.1:8081',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['owner'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8081/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses permission scopes to decide whether pages are visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['viewer'],
          permissions: ['orders:read', 'products:read'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { View } = await import('../types');
    const { canAccessView, hasPermission, login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(hasPermission('orders:read')).toBe(true);
    expect(hasPermission('ai:chat')).toBe(false);
    expect(canAccessView(View.Orders)).toBe(true);
    expect(canAccessView(View.Assistant)).toBe(false);
    expect(canAccessView(View.AccountSettings)).toBe(true);
    // W-C 真源对齐：SystemSettings 派生 permission: settings:system:read（仅 ADMIN 持有），
    // 普通用户（viewer + orders/products）不再隐式放开
    expect(canAccessView(View.SystemSettings)).toBe(false);
  });

  it.each([
    { grants: ['*'], ceiling: undefined, read: true, write: true },
    { grants: [], ceiling: undefined, read: false, write: false },
    { grants: ['*'], ceiling: [], read: false, write: false },
    { grants: ['*'], ceiling: ['orders:read'], read: true, write: false },
    { grants: ['orders:read'], ceiling: ['*'], read: true, write: false },
    { grants: [], ceiling: ['*'], read: false, write: false },
  ])('uses current grants intersected with the session ceiling even for an owner: $grants / $ceiling', async ({ grants, ceiling, read, write }) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({
      token: 'private-test-credential', user: { id: 'u-owner', displayName: 'Owner', email: 'owner@acceptance.invalid',
        roles: ['owner'], permissions: grants, ...(ceiling === undefined ? {} : { permissionCeiling: ceiling }), departmentIds: [], department: null },
    }) })));
    const { login, hasPermission } = await import('./authService');
    await login('owner@acceptance.invalid', 'test-password');
    expect(hasPermission('orders:read')).toBe(read);
    expect(hasPermission('orders:write')).toBe(write);
    expect(hasPermission('orders:write', 'orders:read')).toBe(read || write);
  });

  it('does not grant AI access from legacy role fallback when auth responses omit permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        token: 'token-1',
        user: {
          id: 'u1',
          displayName: 'User One',
          email: 'user@example.com',
          roles: ['viewer'],
          departmentIds: ['company'],
          department: null,
        },
      }),
    })));

    const { View } = await import('../types');
    const { canAccessView, login } = await import('./authService');
    await login('user@example.com', 'correct-password');

    expect(canAccessView(View.Assistant)).toBe(false);
    expect(canAccessView(View.Products)).toBe(true);
  });
});
