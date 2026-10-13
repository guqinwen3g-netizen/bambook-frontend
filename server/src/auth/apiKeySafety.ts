/**
 * apiKeySafety.ts — API Key 卫生自检（凭证不能印在玻璃上）
 *
 * ## 为什么需要这个模块
 *
 * Vite 的既定契约：**`VITE_` 前缀的环境变量会被内联进客户端产物**。
 * 也就是说，写在 `VITE_*` 里的任何值，都会被原样打包进浏览器能下载的 JS 里。
 *
 * 而服务端此前把 `VITE_BAMBOOK_API_KEY` 当作一把合法的 API Key 接受
 * （原 `SDK_CONFIG.apiKeys` 与 `parseAgentPrincipalBindings` 都把它列进来源）。
 * 二者叠加的后果是：**凡能下载前端产物的人，都握有一把能过服务端鉴权的钥匙**。
 *
 * 实测证据（2026-09-15）：
 *  - 线上产物 `assets/App-*.js` 中可直接 grep 出 48 位密钥；
 *  - 前端在 /api/v2/orders、/api/v2/relations、/api/v1/finance 等 13 个业务接口上
 *    真实携带该 key 发出请求；
 *  - 在本地链路（服务端 key 与 VITE_ key 同值）下，仅凭该 key 无需登录即可读到
 *    `/api/orders` 208KB、`/api/relations` 27KB 等业务数据；
 *  - 写操作因 `requireJwtForWrite` 只认 JWT，未被波及（401）。
 *
 * 更隐蔽的风险：`server/.env.local` 的注释原本明确要求
 * 「BAMBOOK_API_KEY 与根 .env.local 的 VITE_BAMBOOK_API_KEY 一致」——
 * 即**文档化的装机步骤本身就会把服务端密钥变成公开值**。
 *
 * ## 本模块的口径
 *
 *  1. 服务端**不再**从任何 `VITE_` 变量读取凭证（它们按定义是公开的）；
 *  2. 启动时做一次交叉自检：若某个待接受的密钥同时出现在任意 `VITE_*` 变量中，
 *     说明它已经（或即将）被打进前端产物 → **剔除并告警**（fail-closed）。
 *     不选择「进程启动失败」，是为了避免一把配置错误的 key 把整个服务拖下线，
 *     正常员工的 JWT 登录不受影响；但 API-Key 通道对该 key 立即失效。
 */

/** 会被 Vite 内联进客户端产物的环境变量前缀 */
const CLIENT_EXPOSED_PREFIX = 'VITE_';

/** 日志脱敏：只留前 4 位 + 长度，够定位、不足以复用 */
export function redactKey(key: string): string {
  const value = String(key ?? '');
  if (!value) return '(空)';
  if (value.length <= 8) return `****（长度 ${value.length}）`;
  return `${value.slice(0, 4)}…（长度 ${value.length}）`;
}

/**
 * 收集所有会被打包进前端的环境变量值。
 * 只认 `VITE_` 前缀——这是 Vite 的公开契约，不是本项目的约定。
 */
export function collectClientExposedValues(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const exposed = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(CLIENT_EXPOSED_PREFIX)) continue;
    const value = String(raw ?? '').trim();
    // 空串与占位值不构成「泄露」，但也不该被当成凭证
    if (value) exposed.add(value);
  }
  return exposed;
}

export interface ApiKeyPartition {
  /** 可作为服务端凭证的密钥 */
  accepted: string[];
  /** 因出现在 VITE_ 变量中（等同公开）而被拒绝的密钥 */
  rejected: string[];
}

/**
 * 把候选密钥分成「可用」与「已公开」两堆。
 * 去重后按原顺序返回，便于日志稳定可读。
 */
export function partitionApiKeys(
  candidates: Iterable<string | undefined | null>,
  exposed: Set<string> = collectClientExposedValues(),
): ApiKeyPartition {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 落在 VITE_ 变量里 = 会出现在前端产物里 = 不是秘密
    if (exposed.has(key)) rejected.push(key);
    else accepted.push(key);
  }

  return { accepted, rejected };
}
