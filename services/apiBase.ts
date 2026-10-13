/**
 * 统一 API 根路径：
 *
 * 优先级（从高到低）：
 * 1. 环境变量 VITE_API_BASE_URL   — 仅允许数据中心/相对 API 路径
 * 2. 用户在设置页填的 cloudEndpoint — Cloudflare / Bambook 数据入口
 * 3. 兜底                          — DEV 闭环本地 8081 后端；PROD 走生产数据中心
 */

const PROD_BAMBOOK_ENDPOINT = 'https://jiangsupanda.com/bambook';
const DEV_BAMBOOK_ENDPOINT = 'http://localhost:8081';

/** DEV 运行时（vite dev / vitest）判定；调用时读取，便于测试 stub。 */
export function isDevRuntime(): boolean {
  return Boolean(import.meta.env.DEV);
}

/** 默认数据中心端点：DEV 闭环本地后端；PROD 构建静态替换回生产值，行为不变。 */
export function getDefaultBambookEndpoint(): string {
  // 直读 import.meta.env.DEV（构建期静态替换为 false），保证 DEV 端点字符串被生产打包 DCE。
  return import.meta.env.DEV ? DEV_BAMBOOK_ENDPOINT : PROD_BAMBOOK_ENDPOINT;
}

export const DEFAULT_BAMBOOK_ENDPOINT = getDefaultBambookEndpoint();
export const CORPORATE_MASTER_IP = 'jiangsupanda.com';
const LOCAL_DATA_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const NON_BAMBOOK_DATA_HOSTS = new Set([...LOCAL_DATA_HOSTS, '47.100.99.170', 'hd.jyiba.cn']);

function isLocalDataHost(hostname: string): boolean {
  return LOCAL_DATA_HOSTS.has(hostname.toLowerCase());
}

export function normalizeDataCenterEndpoint(endpoint?: string): string {
  const raw = endpoint?.trim().replace(/\/$/, '') || '';
  if (!raw) return getDefaultBambookEndpoint();
  const normalized = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(normalized);
    // DEV 本地闭环：显式 localhost 端点原样保留（主机+端口不丢失）；
    // 仅 PROD 构建强制重映射回生产数据中心（业务数据不落本机库）。
    if (isDevRuntime() && isLocalDataHost(url.hostname)) {
      return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
    }
    if (NON_BAMBOOK_DATA_HOSTS.has(url.hostname.toLowerCase())) return getDefaultBambookEndpoint();
    if (url.pathname.toLowerCase().includes('/pdml')) return getDefaultBambookEndpoint();
    if (url.pathname.endsWith('/api')) {
      url.pathname = url.pathname.slice(0, -4) || '/';
    }
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
  } catch {
    return getDefaultBambookEndpoint();
  }
}

export function withApiSuffix(endpoint: string): string {
  const ep = endpoint.trim().replace(/\/$/, '');
  if (!ep) return '';
  if (ep.startsWith('/')) return ep.endsWith('/api') ? ep : `${ep}/api`;
  const normalized = /^https?:\/\//.test(ep) ? ep : `http://${ep}`;
  return normalized.endsWith('/api') ? normalized : `${normalized}/api`;
}

function normalizeExplicitApiBase(apiBase?: string): string {
  const raw = apiBase?.trim().replace(/\/$/, '') || '';
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;
  const normalized = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(normalized);
    // 与 normalizeDataCenterEndpoint 同口径：DEV 下显式 localhost 端点放行（本地闭环），PROD 一律拒绝。
    if (isDevRuntime() && isLocalDataHost(url.hostname)) {
      return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
    }
    if (NON_BAMBOOK_DATA_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (url.pathname.toLowerCase().includes('/pdml')) return '';
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function isDevLocalAgentRuntimeEnabled(): boolean {
  return false;
}

export function getAgentRuntimeApiBaseUrl(): string {
  return getApiBaseUrl();
}

export function getAgentRuntimeModeLabel(): string {
  return '数据中心 Agent Runtime';
}

export function getAgentRuntimeDevHeaders(): Record<string, string> {
  return {};
}

export function getApiBaseUrl(): string {
  // 1. 环境变量最高优先，但账号/业务数据不能指向本机库。
  const envUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (envUrl?.trim()) {
    const apiBase = normalizeExplicitApiBase(envUrl);
    if (apiBase) return apiBase;
  }

  // 2. 用户在设置页配置的 Cloudflare 入口。业务数据不能默认落到本机库。
  try {
    const raw = localStorage.getItem('panda_system_config');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg?.cloudEndpoint && cfg.cloudEndpoint.trim()) {
        const apiBase = withApiSuffix(normalizeDataCenterEndpoint(cfg.cloudEndpoint));
        if (apiBase) return apiBase;
      }
    }
  } catch {
    // localStorage 不可用或解析失败，继续走后面的逻辑
  }

  return withApiSuffix(getDefaultBambookEndpoint());
}
