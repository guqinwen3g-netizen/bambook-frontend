/**
 * 登录防爆破：轻量内存限流器（Map + 滑动时间窗 + 定期清理）。
 *
 * 设计要点：
 *   - 键为调用方给出的字符串（/login 使用 `${ip}|${identifier}`，IP+账号双维）
 *   - 仅记录失败尝试；成功登录由调用方 reset(key) 清除计数
 *   - 窗口内失败次数达到 maxFailures 即封锁，直到最早一次失败滑出窗口
 *   - 定期 sweep 清理过期键，防止 Map 无界增长（timer unref，不阻塞进程退出）
 *
 * 不引入第三方依赖（项目无 express-rate-limit）。
 */

export type LoginRateLimitVerdict =
  | { blocked: false }
  | { blocked: true; retryAfterMs: number };

export type LoginRateLimiter = {
  /** 查询键当前是否被封锁（不记录失败）。 */
  check: (key: string) => LoginRateLimitVerdict;
  /** 记录一次失败，返回记录后的封锁判定。 */
  recordFailure: (key: string) => LoginRateLimitVerdict;
  /** 登录成功后清除该键计数。 */
  reset: (key: string) => void;
  /** 停止定期清理（测试/热重载场景防泄漏）。 */
  dispose: () => void;
};

export type LoginRateLimiterOptions = {
  /** 时间窗（毫秒），默认 15 分钟。 */
  windowMs?: number;
  /** 窗口内允许的最大失败次数，默认 5。 */
  maxFailures?: number;
  /** 过期键清理周期（毫秒），默认等于 windowMs。 */
  sweepIntervalMs?: number;
  /** 注入时钟（测试用）。 */
  now?: () => number;
};

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

export function createLoginRateLimiter(options: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const now = options.now ?? (() => Date.now());
  const failures = new Map<string, number[]>();

  const prune = (key: string, at: number): number[] => {
    const kept = (failures.get(key) ?? []).filter((ts) => at - ts < windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  };

  const verdictOf = (kept: number[], at: number): LoginRateLimitVerdict => {
    if (kept.length < maxFailures) return { blocked: false };
    const oldest = kept[0];
    return { blocked: true, retryAfterMs: Math.max(oldest + windowMs - at, 0) };
  };

  const sweep = setInterval(() => {
    const at = now();
    for (const key of Array.from(failures.keys())) {
      prune(key, at);
    }
  }, options.sweepIntervalMs ?? windowMs);
  // 不阻止进程退出（测试/脚本场景）
  if (typeof sweep.unref === 'function') sweep.unref();

  return {
    check(key) {
      const at = now();
      return verdictOf(prune(key, at), at);
    },
    recordFailure(key) {
      const at = now();
      const kept = prune(key, at);
      kept.push(at);
      failures.set(key, kept);
      return verdictOf(kept, at);
    },
    reset(key) {
      failures.delete(key);
    },
    dispose() {
      clearInterval(sweep);
      failures.clear();
    },
  };
}
