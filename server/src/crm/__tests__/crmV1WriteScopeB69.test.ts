/**
 * G4.1 · B69：CRM **V1** 的 20 个写路由必须过 `crm:write`（此前只过 `authenticate()` ⇒ 零权限判定）。
 *
 * 为什么这批判据长这样（三条都是被上一轮复核教出来的）：
 *  1. **端点清单从源码派生**，不手写（R3 禁止手写清单）：解析 `router.<verb>('<path>', requireCrmWrite` 与
 *     全部的 `router.<verb>('<path>'`，两者必须相等 ⇒ **漏挂一条就红**；同时把"总数 == 20"钉住，
 *     防止将来加写端点时忘了挂门（新增未挂 = 两侧数不等）。
 *  2. **判定预期从权限真源派生**：某角色该不该被拒，看 `getDefaultScopeListForRole(...)` 里有没有 `crm:write`，
 *     不在测试里重抄"finance 不行、sales 行"（真源漂了测试要跟着漂，不能反过来）。
 *  3. **阳性对照必须有**：持权角色不许被挡。被挡住的"全 403"看起来比"权限生效"更像成功，
 *     所以只测拒绝侧的矩阵是**恒绿判据**（本仓抓过多次）。
 *
 * ⚠️ 被拒的请求**不会跑到 handler** ⇒ 不需要构造合法 body：401/403 侧用空对象打即可；
 *    阳性对照那条会真的进 handler（prisma 桩抛错 → 500），所以断言的是"不是 401/403"。
 */
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { createCrmRouter } from '../crmRoute';
import { SYSTEM_ROLE_IDS, getDefaultScopeListForRole } from '../../_shared/rolePermissionMatrix';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const SRC = readFileSync(path.resolve(__dirname, '../crmRoute.ts'), 'utf-8');

/** 源码里的全部写路由（`router.post|put|delete|patch('<path>'`） */
function writeRoutes(src: string): Array<{ method: string; p: string }> {
  return [...src.matchAll(/router\.(post|put|delete|patch)\(\s*'([^']+)'/g)]
    .map((m) => ({ method: m[1].toUpperCase(), p: m[2] }));
}
/** 已挂 `requireCrmWrite` 的写路由 */
function gatedRoutes(src: string): Array<{ method: string; p: string }> {
  return [...src.matchAll(/router\.(post|put|delete|patch)\(\s*'([^']+)'\s*,\s*requireCrmWrite/g)]
    .map((m) => ({ method: m[1].toUpperCase(), p: m[2] }));
}
const ALL = writeRoutes(SRC);
const GATED = gatedRoutes(SRC);
const key = (r: { method: string; p: string }) => `${r.method} ${r.p}`;

/** 把 `/:relationId/contacts` 这类模板补成可请求的字面路径 */
function concretize(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, 'X-1');
}

function makeApp(): express.Express {
  // 任何深度的数据访问都异步抛错：阳性对照只要"不是 401/403"，跑到 handler 即算通过门
  const node: any = new Proxy(async function () { /* 占位 */ }, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return node;
    },
    apply: async () => { throw new Error('stubbed prisma call should not run for denied requests'); },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/crm', createCrmRouter({ prisma: node, requireAuth: true, apiKeys: new Set(['k-no-identity']) } as any));
  return app;
}

// ⚠️ 这些请求一律走 `Authorization: Bearer`：V1 里没有 cookieParser（那是 index.ts 的活），
//    `extractActorFromRequest` 在单测里只认 Bearer —— 用 cookie 会得到 401"无身份"，
//    把"权限不足(403)"误判成"没登录(401)"，矩阵那半判据就空转了（本文件第一版正是这样红的）。
function tokenFor(roleId: string): string {
  // permissions 直接取真源派生结果 ⇒ 判据只有一份实现（矩阵），这里不重抄"谁能写 CRM"
  return jwt.sign({ userId: 'u_' + roleId, roles: [roleId], permissions: getDefaultScopeListForRole(roleId as any) }, SECRET);
}
const ROLE_IDS = Object.values(SYSTEM_ROLE_IDS) as string[];

describe('B69 · CRM V1 写面挂 crm:write（判据派生自源码与权限真源）', () => {
  it('★ 分母非空且 = 20（本行的数变了就说明有人在加/删写端点）', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(20);
    expect(ALL.length).toBe(20);
  });

  it('★ 每个写路由都挂了 requireCrmWrite（漏挂一条就红，包括以后新增的）', () => {
    const missing = ALL.filter((r) => !GATED.some((g) => key(g) === key(r))).map(key);
    expect(missing, `这些 V1 写路由仍然只有 authenticate()（= 零权限判定）：${missing.join(' , ')}`).toEqual([]);
    expect(GATED.length).toBe(ALL.length);
  });

  it('★ 改信用额度这两个端点在分母里（这条是本批的业务重点，不能被"平均覆盖"糊过去）', () => {
    expect(ALL.map(key)).toEqual(
      expect.arrayContaining(['POST /:relationId/credit-limit', 'PATCH /credit-limit/:id/status']),
    );
    for (const k of ['POST /:relationId/credit-limit', 'PATCH /credit-limit/:id/status']) {
      expect(GATED.map(key), `${k} 没挂门`).toContain(k);
    }
  });

  it('★ 不持 crm:write 的角色 × 全部 20 个写路由 → 403（矩阵派生，不手写"谁不行"）', async () => {
    const deniedRoles = ROLE_IDS.filter((r) => !getDefaultScopeListForRole(r as any).includes('crm:write'));
    expect(deniedRoles.length, '真源里居然人人都能写 CRM ⇒ 这条判据在空转').toBeGreaterThan(0);
    const app = makeApp();
    for (const role of deniedRoles) {
      for (const r of ALL) {
        const url = `/api/v1/crm${concretize(r.p)}`;
        const call = (request(app) as any)[r.method.toLowerCase()](url).set('Authorization', `Bearer ${tokenFor(role)}`);
        const res = await call.send({});
        expect(res.status, `${key(r)} 对 ${role} 竟然没挡（B69 未收口）`).toBe(403);
        // ★ 必须是**权限守卫这一层**挡的（`INSUFFICIENT_SCOPE`），不能是处理器里那层数据范围（DR-042）挡的
        //   —— 否则"某层碰巧返回 403"会被当成"权限门生效"，正是假绿的形状。
        expect(String((res.body as any)?.message ?? ''), `${key(r)} 的 403 不是权限层给的：${JSON.stringify(res.body)}`).toContain('INSUFFICIENT_SCOPE');
      }
    }
  });

  it('★ 阳性对照：持 crm:write 的角色 × 全部 20 个写路由 → 不被挡（不是 401/403）', async () => {
    const allowedRoles = ROLE_IDS.filter((r) => getDefaultScopeListForRole(r as any).includes('crm:write'));
    expect(allowedRoles.length, '矩阵里没有任何角色持 crm:write ⇒ 阳性对照不可达').toBeGreaterThan(0);
    const app = makeApp();
    for (const role of allowedRoles) {
      for (const r of ALL) {
        const url = `/api/v1/crm${concretize(r.p)}`;
        const res = await (request(app) as any)[r.method.toLowerCase()](url)
          .set('Authorization', `Bearer ${tokenFor(role)}`).send({});
        // 分两层看：401 = 身份层挡了（不对）；403 只允许来自**数据范围层**（DR-042 派生可见），
        // 不允许来自 scope 守卫（那说明 crm:write 没被认到 = 真源没接上）。
        expect(res.status, `${key(r)} 把持权角色 ${role} 当成没登录（401）`).not.toBe(401);
        if (res.status === 403) {
          expect(String((res.body as any)?.message ?? ''), `${key(r)} 的 403 来自 scope 守卫 ⇒ 持权角色被挡`).not.toContain('INSUFFICIENT_SCOPE');
        }
      }
    }
  });

  it('★ 裸 API-Key（没有身份）不再等于可写：20 个写路由一律 401', async () => {
    const app = makeApp();
    for (const r of ALL) {
      const res = await (request(app) as any)[r.method.toLowerCase()](
        `/api/v1/crm${concretize(r.p)}`,
      ).set('x-api-key', 'k-no-identity').send({});
      expect(res.status, `${key(r)} 仍允许无身份 API-Key 写（旧 authenticate 的洞）`).toBe(401);
    }
  });

  it('★ 反面对照：把某一条门摘掉，普查那条必须红（否则"20/20"是空转）', () => {
    const mutated = SRC.replace(/router\.post\('\/:relationId\/credit-limit',\s*requireCrmWrite/, "router.post('/:relationId/credit-limit',");
    const g = gatedRoutes(mutated);
    expect(writeRoutes(mutated).length).toBe(ALL.length);
    expect(g.map(key)).not.toContain('POST /:relationId/credit-limit');
    expect(g.length).toBe(ALL.length - 1);
  });
});
