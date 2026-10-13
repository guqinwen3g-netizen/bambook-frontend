/**
 * 登录防爆破限流回归套件（运维冲刺 · 弱口令治理+防爆破）
 *
 * 覆盖：
 *   A. 限流器单元行为（滑动窗口/阈值/reset/窗口过期恢复）
 *   B. /login 端点集成（同 IP+账号 5 次失败后第 6 次 429；不同账号不受阻；成功清除计数）
 *
 * 测试通过 createAuthRouter 的 loginRateLimit 注入显式阈值，不影响生产默认值
 * （15 分钟 / 5 次）；亦可用 BAMBOOK_LOGIN_RATE_LIMIT_DISABLED=1 整体关闭。
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createAuthRouter } from '../auth/route';
import { createLoginRateLimiter } from '../auth/loginRateLimiter';

// ─── A. 限流器单元测试 ───────────────────────────────────────────────────────
describe('createLoginRateLimiter（单元）', () => {
  it('窗口内失败达到阈值后封锁，retryAfterMs 为正', () => {
    let now = 1_000_000;
    const limiter = createLoginRateLimiter({ windowMs: 60_000, maxFailures: 3, now: () => now });
    const key = 'ip|account';
    expect(limiter.check(key).blocked).toBe(false);
    limiter.recordFailure(key);
    limiter.recordFailure(key);
    const third = limiter.recordFailure(key);
    expect(third.blocked).toBe(true);
    const verdict = limiter.check(key);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) expect(verdict.retryAfterMs).toBeGreaterThan(0);
    limiter.dispose();
  });

  it('不同键互不影响', () => {
    const limiter = createLoginRateLimiter({ windowMs: 60_000, maxFailures: 2 });
    limiter.recordFailure('ip|a');
    limiter.recordFailure('ip|a');
    expect(limiter.check('ip|a').blocked).toBe(true);
    expect(limiter.check('ip|b').blocked).toBe(false);
    limiter.dispose();
  });

  it('reset 清除计数', () => {
    const limiter = createLoginRateLimiter({ windowMs: 60_000, maxFailures: 2 });
    limiter.recordFailure('ip|a');
    limiter.recordFailure('ip|a');
    expect(limiter.check('ip|a').blocked).toBe(true);
    limiter.reset('ip|a');
    expect(limiter.check('ip|a').blocked).toBe(false);
    limiter.dispose();
  });

  it('最早失败滑出窗口后自动解封', () => {
    let now = 1_000_000;
    const limiter = createLoginRateLimiter({ windowMs: 60_000, maxFailures: 2, now: () => now });
    limiter.recordFailure('ip|a');
    now += 30_000;
    limiter.recordFailure('ip|a');
    expect(limiter.check('ip|a').blocked).toBe(true);
    now += 31_000; // 第一次失败已滑出 60s 窗口
    expect(limiter.check('ip|a').blocked).toBe(false);
    limiter.dispose();
  });
});

// ─── B. /login 端点集成测试 ──────────────────────────────────────────────────
const EXISTING_EMAIL = 'exists@bambook.test';
const CORRECT_PASSWORD = 'correct-horse-staple';

function buildPrismaMock() {
  const passwordHash = bcrypt.hashSync(CORRECT_PASSWORD, 4); // 测试用低 cost，加速
  return {
    userAccount: {
      findFirst: vi.fn(async ({ where }: any) => {
        const emailCond = where?.OR?.find((c: any) => c?.email?.equals);
        if (emailCond?.email?.equals === EXISTING_EMAIL) {
          return {
            id: 'usr_login_test',
            displayName: 'Login Tester',
            email: EXISTING_EMAIL,
            avatarUrl: null,
            passwordHash,
            status: 'active',
            primaryDeptId: 'dept-company',
            primaryDepartment: null,
            roles: [],
          };
        }
        return null;
      }),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
  } as any;
}

function buildApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use(
    '/auth',
    createAuthRouter({
      prisma,
      // 显式阈值：与生产默认一致（15 分钟/5 次），窗口缩短不影响计数语义
      loginRateLimit: { windowMs: 15 * 60 * 1000, maxFailures: 5 },
    }),
  );
  return app;
}

describe('/login 防爆破（集成）', () => {
  it('同一 IP+账号连续 5 次失败后，第 6 次返回 429 RATE_LIMITED', async () => {
    const app = buildApp(buildPrismaMock());
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/auth/login').send({ email: 'nobody@bambook.test', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_CREDENTIALS');
      // 401 文案前端直渲，必须为中文（R678 登录域收口）
      expect(res.body.message).toBe('姓名/邮箱或密码不正确。');
    }
    const blocked = await request(app).post('/auth/login').send({ email: 'nobody@bambook.test', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error).toBe('RATE_LIMITED');
    expect(blocked.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('某账号被封不影响同 IP 下其他账号登录', async () => {
    const app = buildApp(buildPrismaMock());
    for (let i = 0; i < 5; i++) {
      await request(app).post('/auth/login').send({ email: 'nobody@bambook.test', password: 'wrong' });
    }
    // 另一个账号仍可正常走完密码校验（此处密码错误 → 401 而非 429）
    const other = await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: 'wrong' });
    expect(other.status).toBe(401);
    expect(other.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('登录成功后清除该 IP+账号的失败计数', async () => {
    const app = buildApp(buildPrismaMock());
    // 先积累 4 次失败
    for (let i = 0; i < 4; i++) {
      await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: 'wrong' });
    }
    // 成功登录 → 计数清零
    const ok = await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: CORRECT_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    // 再失败 4 次：若未清零，第 1 次失败时计数已达 5 会被 429
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: 'wrong' });
      expect(res.status).toBe(401);
    }
    // 第 5 次失败达到阈值，下一次请求被 429
    await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: 'wrong' });
    const blocked = await request(app).post('/auth/login').send({ email: EXISTING_EMAIL, password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });

  it('loginRateLimit: false 时不限流（测试/应急开关）', async () => {
    const prisma = buildPrismaMock();
    const app = express();
    app.use(express.json());
    app.use('/auth', createAuthRouter({ prisma, loginRateLimit: false }));
    for (let i = 0; i < 8; i++) {
      const res = await request(app).post('/auth/login').send({ email: 'nobody@bambook.test', password: 'wrong' });
      expect(res.status).toBe(401);
    }
  });
});
