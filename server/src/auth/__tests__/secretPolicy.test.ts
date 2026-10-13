/**
 * secretPolicy 回归测试
 *
 * 背景：原生产断言只查「JWT_SECRET 有没有设」，不查「是不是公开仓库/模板里的
 * 已知值」。而 server/.env.example 写的占位值 `replace-with-a-long-random-secret`
 * 是已跟踪文件（随公开仓库发布），代码兜底默认值
 * `change-me-in-production-at-least-32-chars` 同样在仓库里。
 * 照抄模板不改 = 人人可伪造任意 userId / roles 的 token。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  jwtSecretProblems,
  hasFatalSecretProblem,
  KNOWN_PUBLIC_JWT_SECRETS,
} from '../secretPolicy';
import { createAuthService } from '../service';
import { createCustomerAuthService } from '../../customer/authService';

const STRONG = 'a'.repeat(48);

describe('jwtSecretProblems', () => {
  it('未配置 → 致命', () => {
    const problems = jwtSecretProblems(undefined);
    expect(hasFatalSecretProblem(problems)).toBe(true);
  });

  it('代码兜底默认值 → 致命（该值在公开仓库里）', () => {
    expect(hasFatalSecretProblem(jwtSecretProblems('change-me-in-production-at-least-32-chars'))).toBe(true);
  });

  it('核心：server/.env.example 的模板占位值 → 致命', () => {
    // 这是最可能踩的场景：照抄 example 不改，旧断言会放行
    expect(hasFatalSecretProblem(jwtSecretProblems('replace-with-a-long-random-secret'))).toBe(true);
  });

  it('过短但不是已知公开值 → 仅告警，不阻断启动', () => {
    const problems = jwtSecretProblems('short-but-random-value');
    expect(hasFatalSecretProblem(problems)).toBe(false);
    expect(problems.some((p) => p.level === 'warn')).toBe(true);
  });

  it('强密钥 → 无任何问题', () => {
    expect(jwtSecretProblems(STRONG)).toEqual([]);
  });

  it('已知公开值清单里不含正常密钥（避免误伤）', () => {
    expect(KNOWN_PUBLIC_JWT_SECRETS.has(STRONG)).toBe(false);
  });
});

describe('生产启动断言', () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prev;
  });

  it('生产 + 模板占位值 → 拒绝启动（内部 token 服务）', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createAuthService({ jwtSecret: 'replace-with-a-long-random-secret' })).toThrow(/SECURITY/);
  });

  it('生产 + 模板占位值 → 拒绝启动（客户门户 token 服务）', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      createCustomerAuthService({ jwtSecret: 'replace-with-a-long-random-secret' }),
    ).toThrow(/SECURITY/);
  });

  it('生产 + 未配置 → 拒绝启动（沿用旧行为）', () => {
    process.env.NODE_ENV = 'production';
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => createAuthService()).toThrow(/SECURITY/);
    } finally {
      if (savedSecret !== undefined) process.env.JWT_SECRET = savedSecret;
    }
  });

  it('对照：生产 + 强密钥 → 正常构建（不误伤）', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createAuthService({ jwtSecret: STRONG })).not.toThrow();
    expect(() => createCustomerAuthService({ jwtSecret: STRONG })).not.toThrow();
  });

  it('对照：非生产 + 模板占位值 → 只告警不中断（不阻塞本地开发）', () => {
    process.env.NODE_ENV = 'development';
    expect(() => createAuthService({ jwtSecret: 'replace-with-a-long-random-secret' })).not.toThrow();
  });
});
