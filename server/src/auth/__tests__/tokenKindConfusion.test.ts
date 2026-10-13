/**
 * token 类型混淆（token kind confusion）回归
 *
 * 背景：客户门户 token 与内部 token **共用同一 JWT_SECRET**
 * （见 server/src/customer/authService.ts）。客户侧 verifyToken 会校验
 * `kind === 'customer'`（拒内部 token），但内部侧 extractActorFromRequest
 * 此前只验签不验类型 —— 于是客户 token 被当成合法内部 actor 放行。
 *
 * 修复前实测（两侧同密钥）：
 *   · requireAuth 型路由        → 200 放行（actor.userId/roles/permissions 全 undefined）
 *   · requireRole 型路由        → 500（payload.roles.some 崩在 undefined 上）
 *   · requireAuth+requirePermission → 403（这条路径本身安全）
 *
 * 修复：extractActorFromRequest 补上对称的类型校验（必须带非空 userId，
 * 且不得是 kind='customer'）；requireRole 对缺失 roles 兜底为 []（不再 500）。
 *
 * ⚠️ 写这类测试的关键：middleware.ts 在**模块加载时**就固定了 JWT_SECRET，
 * 在测试文件里再改 process.env.JWT_SECRET 已经太晚（ESM import 提升），
 * 会造成两侧密钥不同而验签失败 → 全部 401 的**假绿**（看起来"很安全"）。
 * 必须显式用同一个密钥签发两种 token。
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../middleware';
import { requirePermission } from '../permissionGuard';
import { createCustomerAuthService } from '../../customer/authService';

// 与 auth/service.ts、customer/authService.ts 的默认密钥一致
// 跟随环境：middleware 在模块加载时用 process.env.JWT_SECRET（测试会加载
// server/.env.local），这里必须与它同源，否则两侧密钥不同 → 全部 401 的假绿/假红。
// 未配置时回退到与代码兜底一致的值，保证任何环境下两侧仍然同密钥。
const SHARED_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';

const customerAuth = createCustomerAuthService({ jwtSecret: SHARED_SECRET });
const customerToken = customerAuth.signToken({
  kind: 'customer',
  customerUserId: 'cu1',
  relationId: 'clientA',
  displayName: 'A Co',
});

/** 正常内部 token（与生产 buildAuthTokenPayload 同形：userId + roles + permissions） */
const internalToken = jwt.sign(
  { userId: 'u1', displayName: 'U1', roles: ['owner'], permissions: ['orders:read'], departmentIds: ['company'] },
  SHARED_SECRET,
);

/** 有 userId 但没有 roles 的内部 token（用于验证 requireRole 不再 500） */
const noRolesToken = jwt.sign({ userId: 'u2', displayName: 'U2', permissions: [], departmentIds: [] }, SHARED_SECRET);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/auth-only', requireAuth, (_req, res) => res.json({ ok: true, userId: (_req as any).actor?.userId ?? null }));
  app.get('/role', requireRole('owner'), (_req, res) => res.json({ ok: true }));
  app.get('/perm', requireAuth, requirePermission('orders:read' as any), (_req, res) => res.json({ ok: true }));
  return app;
}

describe('客户 token 不得被内部守卫接受（kind 混淆）', () => {
  it('requireAuth → 401，不得放行', async () => {
    const res = await request(buildApp()).get('/auth-only').set({ Authorization: `Bearer ${customerToken}` });
    expect(res.status).toBe(401);
  });

  it('requireRole → 401，不得 500（不得在无 roles 上崩溃）', async () => {
    const res = await request(buildApp()).get('/role').set({ Authorization: `Bearer ${customerToken}` });
    expect(res.status).toBe(401);
  });

  it('requireAuth + requirePermission → 401', async () => {
    const res = await request(buildApp()).get('/perm').set({ Authorization: `Bearer ${customerToken}` });
    expect(res.status).toBe(401);
  });
});

describe('正常内部 token 不受影响（防过度收紧）', () => {
  it('requireAuth → 200，且 actor.userId 正确', async () => {
    const res = await request(buildApp()).get('/auth-only').set({ Authorization: `Bearer ${internalToken}` });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('u1');
  });

  it('requireRole(owner) → 200', async () => {
    const res = await request(buildApp()).get('/role').set({ Authorization: `Bearer ${internalToken}` });
    expect(res.status).toBe(200);
  });

  it('requireAuth + requirePermission(orders:read) → 200', async () => {
    const res = await request(buildApp()).get('/perm').set({ Authorization: `Bearer ${internalToken}` });
    expect(res.status).toBe(200);
  });
});

describe('防御：缺 roles 的内部 token 不得让 requireRole 崩成 500', () => {
  it('requireAuth → 200（有 userId 就算合法身份）', async () => {
    const res = await request(buildApp()).get('/auth-only').set({ Authorization: `Bearer ${noRolesToken}` });
    expect(res.status).toBe(200);
  });

  it('requireRole → 403，不是 500', async () => {
    const res = await request(buildApp()).get('/role').set({ Authorization: `Bearer ${noRolesToken}` });
    expect(res.status).toBe(403);
  });
});

describe('无效/空凭证一律 401', () => {
  it('无 Authorization → 401', async () => {
    const res = await request(buildApp()).get('/auth-only');
    expect(res.status).toBe(401);
  });

  it('乱写 token → 401', async () => {
    const res = await request(buildApp()).get('/auth-only').set({ Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
  });
});
