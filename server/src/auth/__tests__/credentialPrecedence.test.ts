/**
 * 走查·身份一致性：一个请求里同时有 Bearer 和 cookie 时，谁说了算 —— 全仓只许有一条规则
 *
 * 一手屏面证人（2026-09-28，:3002 调试面板切到 Charlie Qian 之后）：
 *   - 页头显示 Jason Shen、localStorage 的 bambook_auth_user = usr_demo_boss
 *   - 而 token 解出来是 usr_demo_finance，业务接口也按 Charlie 判（发票列表 0 条＝Charlie 的范围）
 *   同一次会话里"屏上是谁"和"干活的是谁"分家了。
 * 根因不在前端：取凭证的两族落点写了**相反**的优先级 ⇒
 *   `auth/middleware.ts:50` 是 bearer 优先（且注释明写这是规则：显式凭证优先，否则切换账号后被旧 cookie 劫持）；
 *   `auth/route.ts` 的 GET /me、PATCH /me、POST /change-password 三处是 cookie 优先。
 * 本用例把规则收成一份实现，并钉住"不许再有第二份顺序"。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { extractActorFromRequest, optionalAuth, pickRequestToken, requireAuth, requireRole } from '../middleware';
import { createAuthService, type TokenPayload } from '../service';

const routeSrc = readFileSync(new URL('../route.ts', import.meta.url), 'utf8');
const middlewareSrc = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');

const reqWith = (bearer: string, cookie?: string) => ({
  headers: { authorization: bearer ? `Bearer ${bearer}` : '' },
  cookies: cookie === undefined ? undefined : { bambook_token: cookie },
} as any);

describe('凭证优先级 · 显式 Bearer 赢过被动 cookie（全仓唯一规则）', () => {
  it('并存 → 取 bearer，不是 cookie', () => {
    expect(pickRequestToken(reqWith('BEARER', 'COOKIE'))).toBe('BEARER');
  });

  it('只有 cookie → 仍取到 cookie（浏览器正常会话不能因此被登出）', () => {
    expect(pickRequestToken(reqWith('', 'COOKIE'))).toBe('COOKIE');
  });

  it('只有 bearer → 取 bearer；两者都没有 → 空串（调用方据此走 401）', () => {
    expect(pickRequestToken(reqWith('BEARER'))).toBe('BEARER');
    expect(pickRequestToken(reqWith(''))).toBe('');
  });

  it('Bearer 头里是空值（"Bearer   "）不算出示凭证 → 退回 cookie', () => {
    expect(pickRequestToken(reqWith('   ', 'COOKIE'))).toBe('COOKIE');
  });
});

describe('落点普查 · 不许留第二份顺序', () => {
  it('auth/route.ts 里"cookie 优先"的写法归零（此前 3 处：GET /me、PATCH /me、change-password）', () => {
    expect(routeSrc.match(/req\.cookies\?\.\[COOKIE_NAME\] \|\| bearer/g)?.length ?? 0).toBe(0);
  });

  it('原三处、refresh、退出所有设备与两步验证会话读凭证都调用同一份实现', () => {
    expect(routeSrc.match(/pickRequestToken\(req\)/g)?.length ?? 0).toBe(6);
  });

  it('中间件自己也住在这份实现里（规则不再散在两个文件）', () => {
    expect(middlewareSrc).toContain('export function pickRequestToken');
    expect(middlewareSrc).toContain('const token = pickRequestToken(req);');
  });
});

const snapshotSubject = 'u-current-server-authorization';
const signActor = (overrides: Partial<TokenPayload> = {}) => createAuthService().signToken({
  userId: snapshotSubject, displayName: 'Legacy JWT snapshot', roles: ['manager'],
  permissions: ['orders:read', 'orders:write'], departmentIds: [], ...overrides,
});
const loadedActor = (overrides: Partial<TokenPayload> = {}): TokenPayload => ({
  userId: snapshotSubject, displayName: 'Current server authorization', roles: ['manager'],
  permissions: [], departmentIds: [], authorizationLoaded: true, ...overrides,
});

function hydratedApp(serverActor?: TokenPayload) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Explicit trusted server-side seam, not request body/header deserialization.
  if (serverActor) app.use((req, _res, next) => { (req as any).actor = serverActor; next(); });
  const report: express.RequestHandler = (req, res) => {
    const subject = (req as any).actor as TokenPayload | undefined;
    res.json({ actor: subject ? {
      userId: subject.userId, displayName: subject.displayName, roles: subject.roles,
      permissions: subject.permissions, authorizationLoaded: subject.authorizationLoaded,
    } : null });
  };
  app.post('/required', requireAuth, report);
  app.post('/role', requireRole('manager'), report);
  app.post('/optional', optionalAuth, report);
  return app;
}

describe('Verified JWT identity and trusted same-subject loaded authorization', () => {
  it.each(['/required', '/role', '/optional'])('%s preserves a server-loaded empty authority instead of restoring old JWT grants', async path => {
    const current = loadedActor();
    const response = await request(hydratedApp(current)).post(path)
      .set('Authorization', `Bearer ${signActor()}`).send({});
    expect(response.status).toBe(200);
    expect(response.body.actor).toEqual({
      userId: current.userId, displayName: current.displayName, roles: current.roles,
      permissions: [], authorizationLoaded: true,
    });
  });

  it('the extractor returns the same trusted object, including the marker, after verifying its JWT subject', () => {
    const current = loadedActor();
    const req = { ...reqWith(signActor()), actor: current };
    expect(extractActorFromRequest(req)).toBe(current);
  });

  it('requireRole uses a current revoked role rather than granting the legacy JWT role again', async () => {
    const response = await request(hydratedApp(loadedActor({ roles: ['viewer'] }))).post('/role')
      .set('Authorization', `Bearer ${signActor()}`).send({});
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('FORBIDDEN');
  });

  it('requireRole permits a current server-granted role even when the verified old JWT role was viewer', async () => {
    const response = await request(hydratedApp(loadedActor())).post('/role')
      .set('Authorization', `Bearer ${signActor({ roles: ['viewer'] })}`).send({});
    expect(response.status).toBe(200);
    expect(response.body.actor.authorizationLoaded).toBe(true);
    expect(response.body.actor.roles).toEqual(['manager']);
  });

  it('an explicit Bearer for another identity wins over both the cookie and the previously loaded actor', async () => {
    const current = loadedActor();
    const other = { userId: 'u-explicit-other', displayName: 'Explicit Bearer', roles: ['viewer'] as TokenPayload['roles'], permissions: ['orders:read'] };
    const response = await request(hydratedApp(current)).post('/required')
      .set('Authorization', `Bearer ${signActor(other)}`)
      .set('Cookie', `bambook_token=${signActor()}`).send({});
    expect(response.status).toBe(200);
    expect(response.body.actor).toEqual(other);
  });

  it('an unmarked same-subject server actor does not replace the verified JWT snapshot', async () => {
    const unmarked = loadedActor();
    delete unmarked.authorizationLoaded;
    const response = await request(hydratedApp(unmarked)).post('/required')
      .set('Authorization', `Bearer ${signActor()}`).send({});
    expect(response.status).toBe(200);
    expect(response.body.actor.permissions).toEqual(['orders:read', 'orders:write']);
    expect(response.body.actor.authorizationLoaded).toBeUndefined();
  });

  it.each(['/required', '/role'])('%s still requires a valid JWT even if a server actor is marked loaded', async path => {
    const app = hydratedApp(loadedActor());
    expect((await request(app).post(path).send({})).status).toBe(401);
    expect((await request(app).post(path).set('Authorization', 'Bearer invalid-signature-token').send({})).status).toBe(401);
  });

  it('body.actor cannot masquerade as a loaded authority for a valid lower-role JWT', async () => {
    const response = await request(hydratedApp()).post('/role')
      .set('Authorization', `Bearer ${signActor({ roles: ['viewer'] })}`)
      .send({ actor: loadedActor() });
    expect(response.status).toBe(403);
  });
});
