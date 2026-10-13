/**
 * secretPolicy.ts — 服务端密钥强度策略
 *
 * ## 为什么需要
 *
 * 原生产断言只校验「JWT_SECRET 有没有设」：
 *   `if (NODE_ENV === 'production' && !secret) throw ...`
 *
 * 这挡得住「忘了配」，挡不住**照抄模板**：
 * `server/.env.example` 里写的是 `JWT_SECRET="replace-with-a-long-random-secret"`，
 * 而这个 example 文件**是已跟踪、会随公开仓库发布的**。谁照抄一份不改，
 * 断言就会放行——于是整个系统的 JWT 签名密钥变成一个人人可查的常量，
 * 任何人都能给自己签一个任意 userId / roles 的 token，等于完全绕过登录。
 *
 * 同理，代码里的兜底默认值 `change-me-in-production-at-least-32-chars`
 * 也在公开仓库里（且被十几个测试文件引用），一旦被当成配置值写入 env，性质相同。
 *
 * 因此策略从「有没有」升级为「是不是已知公开值 / 是否过短」。
 */

/**
 * 已知会出现在公开仓库或模板里的密钥值。
 * 命中即**致命**：签名密钥已公开，任何人可伪造 token。
 */
export const KNOWN_PUBLIC_JWT_SECRETS: ReadonlySet<string> = new Set([
  'change-me-in-production-at-least-32-chars',
  'replace-with-a-long-random-secret',
  'replace-me',
  'secret',
  'changeme',
]);

/** 低于此长度视为偏弱（仅告警，不中断启动） */
export const MIN_RECOMMENDED_SECRET_LENGTH = 32;

export type SecretProblem = {
  level: 'fatal' | 'warn';
  message: string;
};

/**
 * 评估一个 JWT 签名密钥是否可用。
 * 返回空数组 = 没问题。
 */
export function jwtSecretProblems(secret: string | undefined | null): SecretProblem[] {
  const value = String(secret ?? '').trim();
  const problems: SecretProblem[] = [];

  if (!value) {
    // 保留英文原文：既有测试与运维检索都按 "JWT_SECRET is not configured" 匹配
    problems.push({ level: 'fatal', message: 'JWT_SECRET is not configured（未配置签名密钥）' });
    return problems;
  }

  if (KNOWN_PUBLIC_JWT_SECRETS.has(value)) {
    problems.push({
      level: 'fatal',
      message:
        'JWT_SECRET 仍是公开仓库/模板里的已知值（任何人都能查到，可伪造任意身份的 token）',
    });
  }

  if (value.length < MIN_RECOMMENDED_SECRET_LENGTH) {
    problems.push({
      level: 'warn',
      message: `JWT_SECRET 长度 ${value.length} 短于建议的 ${MIN_RECOMMENDED_SECRET_LENGTH}`,
    });
  }

  return problems;
}

export const hasFatalSecretProblem = (problems: SecretProblem[]): boolean =>
  problems.some((p) => p.level === 'fatal');

/**
 * 报告问题，但**每个进程每种问题只报一次**——
 * createAuthService 在多处被调用，不去重会刷屏。
 */
const reported = new Set<string>();

export function reportSecretProblemsOnce(problems: SecretProblem[], scope = 'JWT_SECRET'): void {
  for (const problem of problems) {
    const key = `${scope}|${problem.level}|${problem.message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const log = problem.level === 'fatal' ? console.error : console.warn;
    log(`[SECURITY] ${scope}：${problem.message}`);
  }
}
