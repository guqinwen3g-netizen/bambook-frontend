/**
 * REQ2-13 停用即时失效守卫测试（DR-056-③ 根因修复）
 *
 * 既有缺口：extractActorFromRequest 仅 jwt.verify 验签——停用后旧 token 在 7 天 TTL 内仍有效。
 * 覆盖：
 *   1. active 账号放行 / disabled / 软删 → 401 ACCOUNT_DISABLED
 *   2. fail-open：用户不存在（遗留 token）/ DB 异常 → 放行
 *   3. 30s TTL 缓存生效（同账号重复请求不重复打库）
 *   4. invalidateAccountStatusCache → 同进程即时失效（改状态后立刻 401）
 *   5. 匿名请求 / 无效 token 直接放行（交由下游守卫）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createAccountStatusGuard, invalidateAccountStatusCache } from '../accountStatusGuard';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const tokenOf = (userId: string) => jwt.sign({ userId, roles: ['owner'] }, SECRET);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function makeApp(userRow: any | Error) {
  const findUnique = userRow instanceof Error
    ? vi.fn().mockRejectedValue(userRow)
    : vi.fn().mockResolvedValue(userRow);
  const prisma: any = { userAccount: { findUnique } };
  const app = express();
  app.use(createAccountStatusGuard(prisma));
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  return { app, findUnique };
}

describe('REQ2-13 · accountStatusGuard（停用即时失效）', () => {
  // 模块级状态缓存跨用例共享：每例前失效，保证从 DB 真值起测
  beforeEach(() => { invalidateAccountStatusCache('u1'); });

  it('active 账号放行', async () => {
    const { app } = makeApp({ status: 'active', deletedAt: null });
    const res = await request(app).get('/probe').set(auth(tokenOf('u1')));
    expect(res.status).toBe(200);
  });

  it('disabled 账号 → 401 ACCOUNT_DISABLED（旧 token 立即失效）', async () => {
    const { app } = makeApp({ status: 'disabled', deletedAt: null });
    const res = await request(app).get('/probe').set(auth(tokenOf('u1')));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ACCOUNT_DISABLED');
  });

  it('软删账号 → 401', async () => {
    const { app } = makeApp({ status: 'active', deletedAt: new Date() });
    const res = await request(app).get('/probe').set(auth(tokenOf('u1')));
    expect(res.status).toBe(401);
  });

  it('fail-open：用户不存在 / DB 异常 → 放行', async () => {
    const missing = makeApp(null);
    expect((await request(missing.app).get('/probe').set(auth(tokenOf('u1')))).status).toBe(200);

    const dbErr = makeApp(new Error('connection refused'));
    expect((await request(dbErr.app).get('/probe').set(auth(tokenOf('u1')))).status).toBe(200);
  });

  it('匿名 / 无效 token 直接放行（交由下游守卫处理）', async () => {
    const { app, findUnique } = makeApp({ status: 'disabled', deletedAt: null });
    expect((await request(app).get('/probe')).status).toBe(200);
    expect((await request(app).get('/probe').set(auth('not-a-jwt'))).status).toBe(200);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('30s TTL 缓存：同账号重复请求不重复打库', async () => {
    const { app, findUnique } = makeApp({ status: 'active', deletedAt: null });
    await request(app).get('/probe').set(auth(tokenOf('u1')));
    await request(app).get('/probe').set(auth(tokenOf('u1')));
    await request(app).get('/probe').set(auth(tokenOf('u1')));
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidateAccountStatusCache：停用后同进程即时失效（不等 TTL）', async () => {
    let row: any = { status: 'active', deletedAt: null };
    const findUnique = vi.fn().mockImplementation(async () => row);
    const app = express();
    app.use(createAccountStatusGuard({ userAccount: { findUnique } } as any));
    app.get('/probe', (_req, res) => res.json({ ok: true }));

    const t = tokenOf('u1');
    expect((await request(app).get('/probe').set(auth(t))).status).toBe(200);
    // TTL 内改状态：缓存仍放行（跨进程兜底语义）
    row = { status: 'disabled', deletedAt: null };
    expect((await request(app).get('/probe').set(auth(t))).status).toBe(200);
    // 停用路径主动失效缓存 → 立即 401
    invalidateAccountStatusCache('u1');
    expect((await request(app).get('/probe').set(auth(t))).status).toBe(401);
  });
});
