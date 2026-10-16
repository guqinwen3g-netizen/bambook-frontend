/** 会话撤销判定（无依赖，主 API 守卫与 Mist authority 共用）。 */
/**
 * 「退出所有设备」/ 管理员重置密码写入 metadata.sessionsRevokedAt（ISO）。签发时间（JWT iat，秒）早于该秒的令牌一律失效；
 * 同一秒内重新登录的新令牌保留（iat 精度为秒）。Mist 服务端 authority 复用同一判定。
 */
export function sessionRevokedBeforeSec(metadata: unknown): number {
  const at = (metadata as any)?.sessionsRevokedAt;
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
export function isTokenRevoked(metadata: unknown, iat: unknown): boolean {
  const before = sessionRevokedBeforeSec(metadata);
  return before > 0 && typeof iat === 'number' && iat < before;
}
