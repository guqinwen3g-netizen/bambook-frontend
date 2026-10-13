/**
 * B42 A1（S0-A2 文案线）· notifications 域 10 处路由级直发的收敛守卫。
 *
 * 这批的判据不是"返回 500"，而是两件事**同时**成立：
 *   ① 原始异常文本**不许**出现在响应体里（收敛前它就是从这一行直接上屏的）；
 *   ② 有意的**业务文案不许被吞**（B22 收敛最容易做出的新错 —— 把「币种必填」这类话换成兜底文案）。
 * 再加一条防漂移：这 18 枚码（本域 10 + products 域 8）**必须仍在注册表里**，
 *   否则 `safeRouteError` 会静默退回通用文案，而所有测试照样绿。
 *
 * ★ 为什么 10 个端点要**逐个打**（R4-T4 复核抓到本文件第一版的假覆盖）：
 *   第一版只打了 `GET /`，标题却写"10 处"。把 `:151`（dismiss）改回 `message: String(e?.message ?? e)`
 *   时，本文件**一处都不会红** —— 注册表里码还在、文件还 import 真源、
 *   `routeError.test.ts:45` 的正则匹配不了跨行的 `.json({\n ...`，而 B42 按 D49 **没有棘轮**。
 *   ⇒ "10 处"这句话只有 10 个端点各自被证明过才算数。
 *
 * ⚠️ 未覆盖（如实记）：本文件测的是**catch 出口**，不测每个端点的成功路径；
 *   服务层若把异常吞成 `{ok:false}` 走早退分支（如 dismiss 的 404），那是**另一条出口**，不在本文件断言范围内。
 */
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ERROR_CODES, lookupErrorCode } from '../../shared/errorCodes';
import { resetNotificationBindingsForTest, initializeNotificationBindings } from '../eventBindings';
import { createNotificationsRouter } from '../route';

/** 本域鉴权只读 `req.actor`（见 route.ts 的 requireUser）⇒ 由 makeApp 的中间件直接注入，不走 cookie */
const RAW_SENTINEL = 'PrismaClientKnownRequestError: P2010 connection terminated at pool#37';
const ROUTE_SRC = readFileSync(path.resolve(__dirname, '../route.ts'), 'utf-8');

/**
 * 任何一次数据访问都抛给定异常的替身。
 * ★ 用 Proxy 而不是手写 5 个方法：手写清单一旦漏掉某个端点真正调用的那个方法，
 *   就会以 `xxx is not a function` 的 TypeError 进 catch —— **测试照样绿，但绿在错误的原因上**
 *   （断言"响应里没有 P2010"会因为根本没抛出 P2010 而恒真）。
 */
function throwingBindings(err: Error): any {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      // ★ 必须是**异步** reject：真 prisma 恒返 promise。同步 throw 会让"错误在哪一帧被吞/被换"
      //   与线上不同 —— 第一版就是踩了这个（业务错被替换成兜底码，正向对照红在 500 而不是 403）。
      return async () => { throw err; };
    },
  });
}

function makeApp(err: Error = new Error(RAW_SENTINEL)) {
  resetNotificationBindingsForTest();
  initializeNotificationBindings(throwingBindings(err));
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { userId: 'u1', roles: ['sales'] };
    req.notificationUserId = 'u1';
    next();
  });
  app.use('/api/v1/notifications', createNotificationsRouter());
  return app;
}

const CASES: Array<{ name: string; code: string; send: (app: express.Express) => any }> = [
  { name: 'GET / 列表', code: 'NOTIFICATION_LIST_FAILED', send: (a) => request(a).get('/api/v1/notifications') },
  { name: 'GET /stats 未读统计', code: 'NOTIFICATION_STATS_FAILED', send: (a) => request(a).get('/api/v1/notifications/stats') },
  { name: 'POST /:id/read 标记已读', code: 'NOTIFICATION_MARK_READ_FAILED', send: (a) => request(a).post('/api/v1/notifications/N-1/read') },
  { name: 'POST /read-all 全部已读', code: 'NOTIFICATION_MARK_ALL_READ_FAILED', send: (a) => request(a).post('/api/v1/notifications/read-all') },
  { name: 'DELETE /:id 删除', code: 'NOTIFICATION_DELETE_FAILED', send: (a) => request(a).delete('/api/v1/notifications/N-1') },
  // dismiss 有前置 400（reason 必填/超长）⇒ 必须带合法 body，否则测的是早退分支而不是 catch
  { name: 'POST /:id/dismiss 忽略', code: 'NOTIFICATION_DISMISS_FAILED', send: (a) => request(a).post('/api/v1/notifications/N-1/dismiss').send({ reason: '客户已另行回复' }) },
  { name: 'GET /preferences 偏好列表', code: 'NOTIFICATION_PREFERENCES_FAILED', send: (a) => request(a).get('/api/v1/notifications/preferences') },
  // upsert 有前置 400（isEnabled 必须 boolean）⇒ 同上
  { name: 'PUT /preferences/:type 改偏好', code: 'NOTIFICATION_PREFERENCE_UPSERT_FAILED', send: (a) => request(a).put('/api/v1/notifications/preferences/order_created').send({ isEnabled: false }) },
  { name: 'GET /catalog 目录', code: 'NOTIFICATION_CATALOG_FAILED', send: (a) => request(a).get('/api/v1/notifications/catalog') },
  { name: 'POST /:id/convert-to-followup 转跟进', code: 'NOTIFICATION_CONVERT_FAILED', send: (a) => request(a).post('/api/v1/notifications/N-1/convert-to-followup').send({}) },
];

describe('B42 A1 · notifications 路由出口：10 处逐个打，原文不外泄、业务文案不吞', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('★ 用例条数必须等于源码里的 safeRouteError 站点数（漏一条 = 这张表在假装覆盖全量）', () => {
    const sites = (ROUTE_SRC.match(/safeRouteError\(/g) ?? []).length;
    expect(sites, '源码站点数变了 ⇒ 同步本表（新增端点不许静默不测）').toBe(10);
    expect(CASES.length).toBe(sites);
  });

  for (const c of CASES) {
    it(`${c.name} ⇒ 500 + ${c.code} + 注册表那句中文，响应体里不许有原始异常文本`, async () => {
      const res = await c.send(makeApp());
      const body = JSON.stringify(res.body);
      expect(res.status, `${c.name} 的档位不对：${body}`).toBe(500);
      expect(res.body.error, `${c.name} 的码不对：${body}`).toBe(c.code);
      // ★ 认的是**注册表那一份**（不在测试里重抄文案 = 不造第二套真源）
      expect(res.body.message).toBe(lookupErrorCode(c.code)!.message);
      expect(body, `${c.name} 把内部异常原文发给了用户`).not.toContain('P2010');
      expect(body).not.toContain('Prisma');
      expect(body).not.toContain('pool#37');
    });
  }

  /**
   * ★ 本域"业务文案不吞"这条性质**在这条缝口不可证** —— 实测不是推测：
   *   从数据层抛一枚带 `code`+`statusCode` 的业务错，10 个端点**全部**回兜底码（不是透传），
   *   因为 `notificationService.ts` 有 6 处内部 `catch`（:147/:286/:380/:426/:586/:612）先把它吸收了。
   *   ⇒ ① 本批**没有造成本域任何文案损失**（收敛前同一条路径也到不了路由，用户当时看到的是被吸收后的**原文**）；
   *   ② "业务错原样透传"由 **products 域**（`productErrorCopyB42.test.ts` 的 400/409 两例，路由自己抛的业务形状）
   *      与 `shared/routeError.test.ts`（`safeRouteError` 语义本体）钉；本例不重复声称。
   *   ③ 本例钉住的是这个结构事实本身：**若将来服务层不再吸收**（把错原样抛出），这里会变红 —— 那时把它换成正向对照，
   *      而不是把断言反过来。
   */
  it('★ 结构事实：业务错进不了通知域路由（服务层先吸收），但出口照样不许有原文', async () => {
    const absorbed: string[] = [];
    for (const c of CASES) {
      const res = await c.send(makeApp(Object.assign(new Error('该通知属于他人，无权查看。'), { code: 'FORBIDDEN_SCOPE', statusCode: 403 })));
      expect(res.status, `${c.name} 的档位变了 ⇒ 服务层的吸收点被改过，请连带复核本域文案损失`).toBe(500);
      expect(res.body.error, `${c.name} 的码不对`).toBe(c.code);
      const body = JSON.stringify(res.body);
      expect(body, `${c.name} 把内部异常原文发给了用户`).not.toContain('P2010');
      expect(body).not.toContain('Prisma');
      if (body.includes('该通知属于他人')) absorbed.push(c.name);
    }
    // 现状：没有任何一端把那句业务文案发出去（都被服务层吸收成兜底文案）—— 记下，别把它当"透传已验证"
    expect(absorbed, '这几端开始透传服务层吸收掉的文案 ⇒ 本注释与断言需要同步更新').toEqual([]);
  });

  it('★ 本批 18 枚兜底码都必须在注册表里且是 5xx（漏登记 = 用户只看到"服务器内部错误"，测试却全绿）', () => {
    const codes = [
      'NOTIFICATION_LIST_FAILED', 'NOTIFICATION_STATS_FAILED', 'NOTIFICATION_MARK_READ_FAILED',
      'NOTIFICATION_MARK_ALL_READ_FAILED', 'NOTIFICATION_DELETE_FAILED', 'NOTIFICATION_DISMISS_FAILED',
      'NOTIFICATION_PREFERENCES_FAILED', 'NOTIFICATION_PREFERENCE_UPSERT_FAILED',
      'NOTIFICATION_CATALOG_FAILED', 'NOTIFICATION_CONVERT_FAILED',
      'PRODUCT_LIST_FAILED', 'PRODUCT_EXCLUSIVITY_CHECK_FAILED', 'PRODUCT_QUERY_FAILED', 'PRODUCT_DETAIL_FAILED',
      'PRODUCT_CREATE_FAILED', 'PRODUCT_UPDATE_FAILED', 'PRODUCT_DELETE_FAILED', 'PRODUCT_IMAGE_UPLOAD_FAILED',
    ];
    expect(codes.length).toBe(18);
    for (const c of codes) {
      const spec = ERROR_CODES[c];
      expect(spec, `${c} 未登记进注册表 ⇒ safeRouteError 会静默退回通用文案`).toBeTruthy();
      expect(spec.status, `${c} 的档位不对`).toBeGreaterThanOrEqual(500);
      expect(spec.message, `${c} 文案为空`).toBeTruthy();
    }
    // 恒不匹配自检：没登记的码必须真的查不到（否则上面那个循环是空转）
    expect(lookupErrorCode('NOTIFICATION_CODE_THAT_DOES_NOT_EXIST')).toBeUndefined();
  });
});
