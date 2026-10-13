/**
 * ★ B42 · A1 文案线（S0-A2 v3.03）：`quotations/quotationRoute.ts` 原文直发的收敛守卫。
 *
 * 与 customs 那批的关键差别（不是照抄上一个文件）：**这两站原本一条日志都没有**
 *   ⇒ 按 D51「先补日志再换文案」，本批先各加一行 `logger.error`（带原文）再接真源；
 *   否则"收敛泄漏"会顺手造成"故障从此不可诊断"（notifications 域第 8 批撞过同一件事）。
 *
 * ★ 另两站（条目级审批 / 总价审批）**刻意不接真源**，理由分两半，一半成立一半不成立：
 *   ✅ **文案半段成立**：`approvalRoutingService.ts:63-68` 的 `noReviewerError()` 只挂 `err.code`、
 *     **没有 `statusCode`** ⇒ 真源 `isBusinessError`（`shared/errorCodes.ts:233-236`）判它不是业务错
 *     ⇒ 接上去会把 `NO_REVIEWER_RESOLVED: …解析不到任何审批人 — …` 换成 `GENERIC_ROUTE_ERROR_MESSAGE`；
 *     而前端 `services/apiService.ts:412` 把 `error.message` 原样上 toast ⇒ 用户从此不知道要去配审批人。
 *     注册表里那枚码有可用文案（`errorCodes.ts:157`），但 `resolveError` 只按 `fallbackCode` 查表、
 *     永不查 `e.code` ⇒ 那份文案在这条路上不可达。
 *   ❌ **档位半段不成立（复核 I-4，本批自己核过并更正注释）**：原注释说"要补 `statusCode: 409` 才能收，
 *     改了会动对外档位所以另批做" —— 但 `statusFromError` 的第 2 档（`shared/bizStatus.ts:68-77`）
 *     **今天就已经**按 `e.code` 查注册表、对 `NO_REVIEWER_RESOLVED` 给 **409**。
 *     ⇒ 真实现状是：这两站把"审批人未配置"答成 **500**，而真源判它 409 —— 这是一条**已在跑的档位缺陷**
 *     （B68 同族，台账 v3.03 立 **B124**），就地一行 `res.status(statusFromError(e))` 可修，
 *     不需要动服务层。本批按"清文案不动契约"的范围没收它，但**不许再把它写成"改了会动契约"**。
 *
 * ⚠️ **收口 ≠ 本文件见底**（复核 I-5）：按 V2 尺（`scripts/lib/errorDebtScanners.mjs`）本文件仍有 **15 处**
 *   对外原文落点（`{ error: e?.message || '…' }` 那一族为主，在 `message:` 键之外）。
 *   逐文件处数由 `routeError.test.ts`（15）与 `rawErrorLeakRatchet.test.ts`（本域 3 处刻意留）钉住
 *   ⇒ **本文件不再抄一份泄漏正则**：同一件事只留一把尺。
 *
 * 判据四侧一起判（问题收集成数组，复核 I-3）：① 响应体不含原文；② 文案是本端点专属（含关键词 + 不是万能兜底句）；
 * ③ 日志仍带原文（★ 本域日志是本批新加的，这条即"真相没被换成不可诊断"的证据）；
 * ④ 码名与档位逐字不变、且档位来自真源 —— ★ 复核 I-1：**逐站**验，不是只验一站。另加 ⑤：`NOT_FOUND` 早退臂不许被吞。
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/errorCodes';
import { createQuotationRouter } from '../quotationRoute';
import { logger } from '../../lib/logger';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RAW_SENTINEL = 'Invalid `prisma.quotation.findMany()` invocation:\n\nThe value `Q-2026-9` written for field `quotationNumber` is too long for column type varchar(32) P2000 pool#12 at db-01.internal';
const RAW_PARTS = ['quotationNumber', 'varchar(32)', 'P2000', 'db-01.internal', 'pool#12'];

/** 递归可调用替身：三跳才真的抛（只代理一跳会抛 `is not a function` ⇒ 绿在错误的原因上） */
function throwingPrisma(err: Error): any {
  const node: any = new Proxy(async function () { /* 占位 */ }, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return node;
    },
    apply: async () => { throw err; },
  });
  return node;
}

/** sales 持 quotations:read + quotations:write（角色矩阵实测）；写端点还要 JWT ⇒ 无令牌会测到 401 而不是 catch 出口 */
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const cookie = `bambook_token=${jwt.sign({ userId: 'u-b42-quote', roles: ['sales'] }, SECRET)}`;

function app(err: Error) {
  const r = express();
  r.use(express.json());
  r.use((req: any, _res: any, next: any) => {
    const c: Record<string, string> = {};
    if (req.headers.cookie) req.headers.cookie.split(';').forEach((x: string) => { const [k, v] = x.trim().split('='); if (k) c[k] = v; });
    req.cookies = c;
    next();
  });
  r.use('/api/v1/quotations', createQuotationRouter({ prisma: throwingPrisma(err), requireAuth: false, apiKeys: new Set<string>() } as any));
  return r;
}

type Site = { name: string; method: 'get' | 'post'; path: string; params: Record<string, string>; query?: string; code?: string; kw: string; notFoundArm?: boolean };

/**
 * ★ 复核 I-3：`url` 与注册式正则由**同一个真源 `path`** 派生（原先是两个互不相干的手写字面量，
 *   且 `/router\.get\('\/by-target'/` 没收尾引号 ⇒ 前缀匹配、别处同名也算命中）。
 */
const PREFIX = '/api/v1/quotations';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const urlOf = (s: Site) => PREFIX + s.path.replace(/:([A-Za-z]\w*)/g, (_m, k: string) => {
  const v = s.params[k];
  if (!v) throw new Error(`站点 ${s.name} 的 path 里有 :${k}，但 params 没给值`);
  return v;
}) + (s.query ?? '');
const registeredAs = (s: Site) => new RegExp(`router\\.${s.method}\\('${esc(s.path)}'`);

const SITES: Site[] = [
  { name: '按对象查报价列表', method: 'get', path: '/by-target', params: {}, query: '?orderId=O1', code: 'INTERNAL_ERROR', kw: '报价单列表' },
  { name: '审批状态查询', method: 'get', path: '/:id/approval-status', params: { id: 'Q1' }, code: 'INTERNAL_ERROR', kw: '审批状态', notFoundArm: true },
  // Conversion preserves its flat {error, code?} response contract.
  { name: '报价转单', method: 'post', path: '/:id/convert-to-order', params: { id: 'Q1' }, kw: '报价转单' },
];
const SOURCE = readFileSync(path.resolve(__dirname, '../quotationRoute.ts'), 'utf-8');

describe('B42·A1 · quotationRoute：三个已收口错误出口与各自响应契约', () => {
  beforeEach(() => { vi.mocked(logger.error).mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('★ 表自身合法：每行都是不同端点，且该端点确在源码里注册了路由（复核 I-2③）', () => {
    expect(new Set(SITES.map((x) => `${x.method} ${urlOf(x)}`)).size, 'SITES 里有重复端点 ⇒ 用例数≠站点数').toBe(SITES.length);
    const missing = SITES.filter((x) => !registeredAs(x).test(SOURCE)).map((x) => x.path);
    expect(missing, '表里的端点在源码里找不到注册 ⇒ 这些行测的是不存在的出口').toEqual([]);
  });

  for (const s of SITES) {
    it(`${s.name}（${s.method.toUpperCase()} ${urlOf(s)}）`, async () => {
      const res = await request(app(new Error(RAW_SENTINEL)))[s.method](urlOf(s)).set('Cookie', cookie);
      const body = JSON.stringify(res.body);
      const msg = String(res.body?.error?.message ?? (typeof res.body?.error === 'string' ? res.body.error : ''));
      const logged = vi.mocked(logger.error).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      const problems: string[] = [];
      if (res.status !== 500) problems.push(`④ 档位：期望 500，实得 ${res.status}（401/403 说明没测到 catch 出口）`);
      if ((res.body?.error?.code ?? res.body?.code) !== s.code) problems.push(`④ 码名不许改：实得 ${JSON.stringify(res.body?.error?.code ?? res.body?.code)}`);
      for (const part of RAW_PARTS) if (body.includes(part)) problems.push(`① 响应体带出内部原文片段 ${part}`);
      if (!msg) problems.push(`② 文案缺失或退成空串：${body}`);
      else {
        if (msg === GENERIC_ROUTE_ERROR_MESSAGE) problems.push('② 退化成万能兜底句');
        if (!msg.includes(s.kw)) problems.push(`② 文案缺本端点关键词「${s.kw}」⇒ 不是本端点专属：${msg}`);
      }
      if (!logged.includes('varchar(32)')) problems.push(`③ 本域日志是本批新加的 ⇒ 这条就是"真相没被换成不可诊断"的证据：${logged.slice(0, 160)}`);
      expect(problems, `${s.name}：${body}`).toEqual([]);
    });
  }

  /** ★ 复核 I-1：**逐站**验档位来自真源。以前只打 approval-status 一站 ⇒ by-target 那站写死 500 照样全绿。 */
  for (const s of SITES) {
    it(`★ ④ 档位来自真源 · ${s.name}：业务错(409)透传，写死 500 会被这条抓到`, async () => {
      const biz = Object.assign(new Error('当前状态不允许查看审批'), { code: 'QUOTATION_STATE', statusCode: 409 });
      const res = await request(app(biz))[s.method](urlOf(s)).set('Cookie', cookie);
      const body = JSON.stringify(res.body);
      const problems: string[] = [];
      if (res.status !== 409) problems.push(`真源档位没用上（实得 ${res.status}）⇒ 站点把状态码写死了`);
      if ((res.body?.error?.code ?? res.body?.code) !== 'QUOTATION_STATE') problems.push(`业务错自己的码名没透传：实得 ${JSON.stringify(res.body?.error?.code ?? res.body?.code)}`);
      if (!body.includes('当前状态不允许查看审批')) problems.push(`业务文案没透传：${body}`);
      expect(problems, `${s.name}：${body}`).toEqual([]);
    });
  }

  /** ⑤ 业务早退不许被顺手吞掉：抛 code=NOT_FOUND 时仍须 404 且带业务文案（没有这条，"一律 500 + 换文案"也能让四侧全绿）*/
  it('★ 业务早退没被吞：抛 code=NOT_FOUND 时仍 404 且原样带业务文案', async () => {
    const biz = Object.assign(new Error('报价单不存在'), { code: 'NOT_FOUND' });
    const armed = SITES.filter((x) => x.notFoundArm);
    expect(armed.length, '必须至少有一站带 NOT_FOUND 早退臂，否则这条判据是恒真的（v1 就差点犯）').toBeGreaterThan(0);
    for (const s of armed) {
      const res = await request(app(biz)).get(urlOf(s)).set('Cookie', cookie);
      expect(res.status, `${s.name} 的业务 404 被改写了`).toBe(404);
      expect(JSON.stringify(res.body)).toContain('报价单不存在');
    }
  });

  it(`★ 用例数 == 源码 safeRouteError 站点数（== ${SITES.length}）`, () => {
    expect((SOURCE.match(/\bsafeRouteError\(/g) ?? []).length, '站点数与用例数脱钩').toBe(SITES.length);
    /**
     * ★ 复核 I-5：这里**不再**手写"什么算泄漏"的正则 ——
     *   `routeError.test.ts` 用 `errorDebtScanners` 的 V1/V2 尺对本文件 `toEqual` 逐处对账（15），
     *   `rawErrorLeakRatchet.test.ts` 钉"本域刻意留 3 处"（两处审批站 + 一处 `NOT_FOUND` 透传那一族）。
     *   再抄一份就是第三个嘴（本项目头号病：多套并行真源）。
     */
  });
});
