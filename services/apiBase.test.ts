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

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubGlobal('localStorage', createStorage());
  });

  // —— PROD 构建语义：vitest 下 import.meta.env.DEV 默认 true，
  //    stub 为 false 模拟生产构建（与 vite build 的静态替换等价），断言生产行为逐字节不变 ———

  it('defaults business data requests to the production data center in PROD builds', async () => {
    vi.stubEnv('DEV', false);

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  // —— DEV 本地闭环：默认端点落本地 8081 后端 ———

  it('defaults business data requests to the local backend in DEV', async () => {
    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('http://localhost:8081/api');
  });

  it('honors an explicitly stored Cloudflare endpoint', async () => {
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'https://jiangsupanda.com/bambook',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  it('does not allow business data requests to use a local database endpoint in PROD builds', async () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'http://127.0.0.1:8081',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  it('keeps an explicitly stored localhost endpoint untouched in DEV (no remap to production)', async () => {
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'http://127.0.0.1:8081',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('http://127.0.0.1:8081/api');
  });

  it('does not allow VITE_API_BASE_URL to point business data at localhost in PROD builds', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8081/api');

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  it('allows an explicit localhost VITE_API_BASE_URL in DEV (local closed loop)', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8081/api');

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('http://localhost:8081/api');
  });

  it('does not allow Agent runtime requests to use localhost even when old dev flags are present in PROD builds', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_BAMBOOK_DEV_LOCAL_RUNTIME', '1');
    vi.stubEnv('VITE_BAMBOOK_DEV_LOCAL_API_BASE', 'http://localhost:8081/api');
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8081/api');

    const {
      getApiBaseUrl,
      getAgentRuntimeApiBaseUrl,
      getAgentRuntimeModeLabel,
      getAgentRuntimeDevHeaders,
    } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
    expect(getAgentRuntimeApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
    expect(getAgentRuntimeModeLabel()).toBe('数据中心 Agent Runtime');
    expect(getAgentRuntimeDevHeaders()).toEqual({});
  });

  it('ignores stale dev-only Agent runtime base settings', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_BAMBOOK_DEV_LOCAL_RUNTIME', '1');
    vi.stubEnv('VITE_BAMBOOK_DEV_LOCAL_API_BASE', 'http://47.100.99.170:8081/api');

    const { getAgentRuntimeApiBaseUrl } = await import('./apiBase');

    expect(getAgentRuntimeApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  it('allows deploy builds to use a relative API base', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/bambook/api');

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('/bambook/api');
  });

  it('migrates legacy direct-IP data endpoints back to Cloudflare in PROD builds', async () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: '47.100.99.170:8081',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });

  it('still migrates legacy direct-IP data endpoints in DEV (only localhost is exempt)', async () => {
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: '47.100.99.170:8081',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('http://localhost:8081/api');
  });

  it('does not allow the PDML fabric website to become the Bambook data center in PROD builds', async () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem('panda_system_config', JSON.stringify({
      cloudEndpoint: 'http://hd.jyiba.cn:49988/pdml#/pages/MLGL/BQCX',
    }));

    const { getApiBaseUrl } = await import('./apiBase');

    expect(getApiBaseUrl()).toBe('https://jiangsupanda.com/bambook/api');
  });
});
