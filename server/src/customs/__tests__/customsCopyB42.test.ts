/**
 * ★ B42 · A1 文案线（S0-A2 v3.03）：`customs/customsRouteV2.ts` 原文直发的收敛守卫。
 *
 * 病灶：catch 里 `res.status(500).json({ … message: String(e?.message ?? e) })`（4 处）与 `/documents`
 *   那组的 `message: e?.message` ⇒ **原始异常文本直接进对外 HTTP 响应体**；报关域抛出来的正是
 *   Prisma/SQL 原文（表名、列名、约束名、池号）。
 *
 * ★ 本域**刻意留 2 处不收**（`/documents/:id` 详情、`POST /documents` 创建）：它们的 catch 里混着服务层的
 *   **业务校验错**（`customsService.ts:264`、`:1564` 起、`:1782` 抛的是 plain `new Error('非法单据类型: X')` /
 *   `'贸易单据 X 不存在'`，**没有 code+statusCode**）⇒ 真源 `isBusinessError`（`shared/errorCodes.ts:233-236`）
 *   判它不是业务错，接上去会把用户本该看到的原因换成通用句 = **行为回退**，不是收敛。
 *   列表那站不同：`listTradeDocuments`（`customsService.ts:1731` 起，按括号深度配重切出的函数体 **33 行**）**零 `throw`**
 *   ⇒ catch 只吃数据层原文 ⇒ 收。而 `getTradeDocument`（`:1779`）有 `throw new Error('贸易单据 X 不存在')`、
 *   `createTradeDocument`（`:1564`）有 4 条裸抛 ⇒ 那两站不能收。
 *   ★ 这条"零 throw"是**本批判据的承重前提**，所以下面有断言钉它，不只是一句注释（复核 I-2）。
 *   ⇒ 同形状、两处落点、后果相反 —— 正是台账 D49/D58「不给 B42 加正则判据」的理由，本批又添一个实例。
 *
 * ⚠️ **收口 ≠ 本文件见底**（复核 I-5）：按 V2 尺（`scripts/lib/errorDebtScanners.mjs`）本文件仍有 **28 处**
 *   对外原文落点，绝大多数是 `{ error: e?.message || '…' }` 那一族（`message:` 键**之外**的另一族），
 *   本批只动 `message:` 那一组。逐文件处数由 `routeError.test.ts`（V1/V2 尺 `toEqual`）与
 *   `rawErrorLeakRatchet.test.ts`（本域刻意留 2 处）钉住 ⇒ **本文件不再抄一份泄漏正则**（一件事一把尺）。
 *
 * 判据（每站**四侧一起判**，问题收集成数组再断言 —— 复核 I-3：一条式先红会遮蔽后面的，多缺陷站点只报一条）：
 *   ① 响应体不含原始异常文本（逐段判唯一哨兵，不靠"看起来像中文"）；
 *   ② 文案是**本端点专属**：既 `!== GENERIC_ROUTE_ERROR_MESSAGE`，也必须含该端关键词
 *      （复核 I-2②：只测前半句时，两站文案互换照样全绿）；
 *   ③ 同一笔异常仍被 `logger.error` 带走（D51）；
 *   ④ 契约不变：码名与 HTTP 档位逐字不动，**且档位来自真源** —— ★ 复核 I-1：这一侧必须**逐站**验
 *      （以前只打一站，其余四站把 `safe.status` 写死成 500 照样全绿 = 真源被旁路而判据看不见）。
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { businessError, GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/errorCodes';
import { stripComments } from '../../../scripts/lib/errorDebtScanners.mjs';
import { createCustomsV2Router } from '../customsRouteV2';
import { logger } from '../../lib/logger';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RAW_SENTINEL = 'Invalid `prisma.customsDeclaration.findMany()` invocation:\n\nForeign key constraint violated: `CustomsDeclaration_declarationId_fkey (pool#37) P2003';
const RAW_PARTS = ['P2003', 'Foreign key constraint violated', 'customsDeclaration', 'declarationId_fkey', 'pool#37'];

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

/**
 * 写端点必须带身份：`requirePermission('customs:write')` 在完全无 actor 时给 **401**（实测）
 * ⇒ 只给 GET 配令牌就会测到 401 而不是 catch 出口（假绿）。`logistics` 持 `customs:write`（角色矩阵）。
 */
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const cookie = `bambook_token=${jwt.sign({ userId: 'u-b42-copy', roles: ['logistics'] }, SECRET)}`;

function app(err: Error) {
  const r = express();
  r.use(express.json());
  r.use((req: any, _res: any, next: any) => {
    const c: Record<string, string> = {};
    if (req.headers.cookie) req.headers.cookie.split(';').forEach((x: string) => { const [k, v] = x.trim().split('='); if (k) c[k] = v; });
    req.cookies = c;
    next();
  });
  r.use('/api/v2/customs', createCustomsV2Router({ prisma: throwingPrisma(err), requireAuth: false, apiKeys: new Set<string>() } as any));
  return r;
}

type Site = { name: string; method: 'get' | 'post'; path: string; params: Record<string, string>; shape: 'nested' | 'flat' | 'messageOnly'; code?: string; status: number; kw: string };

/**
 * ★ 复核 I-3：原先 `url` 与 `route` 是**两个互不相干的手写字面量**（只问"源码里出现过这个注册式"，
 *   且 flat 那行的正则没有收尾引号 ⇒ `/documents/:id` 也算命中）。
 *   现在**只有一个真源 = Express 注册路径 `path`**：`url` 由它把 `:param` 填成占位 id 派生，
 *   注册式正则也由它拼出来（**带收尾引号**）⇒ "两列对不上"结构上不可能，而不是靠人盯着。
 */
const PREFIX = '/api/v2/customs';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const urlOf = (s: Site) => PREFIX + s.path.replace(/:([A-Za-z]\w*)/g, (_m, k: string) => {
  const v = s.params[k];
  if (!v) throw new Error(`站点 ${s.name} 的 path 里有 :${k}，但 params 没给值`);
  return v;
});
const registeredAs = (s: Site) => new RegExp(`router\\.${s.method}\\('${esc(s.path)}'`);

/** kw = 本端点专属关键词（判据②靠它抓"文案互换"） */
const SITES: Site[] = [
  { name: '三单一致核对', method: 'get', path: '/shipments/:shipmentId/triple-consistency', params: { shipmentId: 'S1' }, shape: 'nested', code: 'TRIPLE_CONSISTENCY_FAILED', status: 500, kw: '三单' },
  { name: '退税报缺', method: 'get', path: '/declarations/:id/tax-refund/gaps', params: { id: 'D1' }, shape: 'nested', code: 'TAX_REFUND_GAPS_FAILED', status: 500, kw: '退税缺口' },
  { name: '退税重算', method: 'post', path: '/declarations/:id/tax-refund/recalc', params: { id: 'D1' }, shape: 'nested', code: 'TAX_REFUND_RECALC_FAILED', status: 500, kw: '退税重算' },
  { name: '成交方式一致性', method: 'get', path: '/declarations/:id/incoterm-consistency', params: { id: 'D1' }, shape: 'nested', code: 'INCOTERM_CONSISTENCY_FAILED', status: 500, kw: '成交方式' },
  // ★ 唯一一处 flat 形状（`{ error: '码', message }`）⇒ `shape` 分支不是摆设；接真源前后形状一字未动
  { name: '单证列表', method: 'get', path: '/documents', params: {}, shape: 'flat', code: 'INTERNAL_ERROR', status: 500, kw: '单证列表' },
  // V1 acceptance added two typed declaration read exits, preserving {error:string}.
  // Original five producer controls and their endpoint-specific copy stay intact.
  { name: '报关列表安全读取', method: 'get', path: '/declarations', params: {}, shape: 'messageOnly', status: 500, kw: GENERIC_ROUTE_ERROR_MESSAGE },
  { name: '报关详情安全读取', method: 'get', path: '/declarations/:id', params: { id: 'D1' }, shape: 'messageOnly', status: 500, kw: GENERIC_ROUTE_ERROR_MESSAGE },
];
const SOURCE = readFileSync(path.resolve(__dirname, '../customsRouteV2.ts'), 'utf-8');
const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf-8');
/** 收口那 5 站背后的服务段/helper（退税两站共用 `taxRefundCalcService.ts`） */
const SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ['customsService.ts · listTradeDocuments（单证列表那站）', 'FN:listTradeDocuments'],
  ['tripleDocumentConsistency.ts（三单一致那站）', 'FILE:tripleDocumentConsistency.ts'],
  ['incotermConsistency.ts（成交方式那站）', 'FILE:incotermConsistency.ts'],
  ['taxRefundCalcService.ts（退税两站）', 'FILE:taxRefundCalcService.ts'],
];

/**
 * 取一段"纯代码"文本（剥注释 ⇒ 注释里写的 `throw` 既骗不过判据、也不会被算成命中）。
 * ★ 函数体**必须按花括号配重切**，而"第一个花括号"**不是**函数体 ——
 *   本批连撞两次：`listTradeDocuments(params: { type?: string; … } = {}) {` 的第一个 `{` 是
 *   **参数内联类型**的字面量 ⇒ 从它开始配重，切到的是那 15 行类型声明（永远 0 个 throw = 空转的假绿），
 *   而真正的函数体一行都没看。⇒ 先跟到参数表右括号（`(` 深度归 0）之后再取第一个 `{`。
 */
function bodyOf(src: string, at: number): string {
  let paren = 0, angle = 0, i = at;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') paren++;
    else if (c === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  if (paren !== 0) throw new Error(`函数起点处括号不配对 ⇒ 拒绝给数（锚点 ${src.slice(at, at + 40)}…）`);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === '{' && angle === 0) break;
  }
  const open = i;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error('函数体花括号配不上 ⇒ 切片范围不可信，拒绝给数');
}

function codeOf(spec: string): string {
  if (spec.startsWith('FILE:')) return stripComments(read(spec.slice(5)));
  const name = spec.slice(3);
  const src = read('customsService.ts');
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`锚点没找到：function ${name}( ⇒ 判据瞎了，不是「零命中」`);
  return stripComments(bodyOf(src, at));
}

describe('B42·A1 · customsRouteV2：五个原出口与两个报关安全读出口、码名与真源档位逐站钉住', () => {
  beforeEach(() => { vi.mocked(logger.error).mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('★ 表自身合法：每行都是不同端点，且该端点确在源码里注册了路由（复核 I-2③：两行塌到同一端点曾全绿）', () => {
    expect(new Set(SITES.map((x) => `${x.method} ${urlOf(x)}`)).size, 'SITES 里有重复端点 ⇒ 用例数≠站点数').toBe(SITES.length);
    const missing = SITES.filter((x) => !registeredAs(x).test(SOURCE)).map((x) => `${x.method} ${x.path}`);
    expect(missing, '表里的端点在源码里找不到注册 ⇒ 这些行测的是不存在的出口').toEqual([]);
  });

  for (const s of SITES) {
    it(`${s.name}（${s.method.toUpperCase()} ${urlOf(s)}）`, async () => {
      const target = urlOf(s);
      const q = s.method === 'get' ? request(app(new Error(RAW_SENTINEL))).get(target) : request(app(new Error(RAW_SENTINEL))).post(target);
      const res = await q.set('Cookie', cookie);
      const body = JSON.stringify(res.body);
      const gotCode = s.shape === 'nested' ? res.body?.error?.code : s.shape === 'messageOnly' ? undefined : res.body?.error;
      const msg = String((s.shape === 'nested' ? res.body?.error?.message : s.shape === 'messageOnly' ? res.body?.error : res.body?.message) ?? '');
      const logged = vi.mocked(logger.error).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      const problems: string[] = [];                                  // 四侧**一起**判，不在第一个红就短路
      if (res.status !== s.status) problems.push(`④ 档位：期望 ${s.status}，实得 ${res.status}（401/403 说明没测到 catch 出口）`);
      if (gotCode !== s.code) problems.push(`④ 码名不许改：期望 ${s.code}，实得 ${JSON.stringify(gotCode)}`);
      for (const part of RAW_PARTS) if (body.includes(part)) problems.push(`① 响应体带出内部原文片段 ${part}`);
      if (!msg) problems.push(`② 文案缺失或退成空串：${body}`);
      else {
        if (s.shape === 'messageOnly') {
          if (msg !== GENERIC_ROUTE_ERROR_MESSAGE || Object.keys(res.body).join() !== 'error') problems.push('② 新报关读取必须保持通用安全句与原单字符串信封');
        } else if (msg === GENERIC_ROUTE_ERROR_MESSAGE) problems.push('② 退化成万能兜底句');
        if (!msg.includes(s.kw)) problems.push(`② 文案缺本端点关键词「${s.kw}」⇒ 不是本端点专属：${msg}`);
      }
      if (!logged.includes('Foreign key constraint violated')) problems.push(`③ 日志里没有这笔原文（真相被换成不可诊断）：${logged.slice(0, 160)}`);
      expect(problems, `${s.name}：${body}`).toEqual([]);
    });
  }

  /** ★ 复核 I-1：**逐站**验档位来自真源（以前只打一站 ⇒ 其余四站写死 500 照样全绿，真源被旁路而判据看不见）。 */
  for (const s of SITES) {
    it(`★ ④ 档位来自真源 · ${s.name}：业务错(409)透传，写死 500 会被这条抓到`, async () => {
      const biz = s.shape === 'messageOnly'
        ? businessError('CONFLICT', '没有权限查看该报关单')
        : Object.assign(new Error('没有权限查看该报关单'), { code: 'CUSTOMS_FORBIDDEN', statusCode: 409 });
      const res = await request(app(biz))[s.method](urlOf(s)).set('Cookie', cookie);
      const body = JSON.stringify(res.body);
      const gotCode = s.shape === 'nested' ? res.body?.error?.code : s.shape === 'messageOnly' ? undefined : res.body?.error;
      const msg = String((s.shape === 'nested' ? res.body?.error?.message : s.shape === 'messageOnly' ? res.body?.error : res.body?.message) ?? '');
      const problems: string[] = [];
      if (res.status !== 409) problems.push(`业务错自带的 409 被改写（实得 ${res.status}）⇒ 站点把档位写死了，真源没在用`);
      if (s.shape !== 'messageOnly' && gotCode !== 'CUSTOMS_FORBIDDEN') problems.push(`业务错自己的码名没透传：实得 ${JSON.stringify(gotCode)}`);
      if (s.shape === 'messageOnly' && (typeof res.body.error !== 'string' || Object.keys(res.body).join() !== 'error')) problems.push('业务拒绝必须保留原单字符串错误信封');
      if (!body.includes('没有权限查看该报关单')) problems.push(`业务文案没透传：${body}`);
      if (!msg) problems.push(`message 退成空：${body}`);
      expect(problems, `${s.name}：${body}`).toEqual([]);
    });
  }

  /**
   * ★ 复核 I-2：把"这 5 站可以收"的承重前提钉成断言。
   *   谁在 `listTradeDocuments`（真函数体 33 行、现量 0 个 `throw`）或那三个 helper 里加一句
   *   `throw new Error('每页最多 500 条')`（本域已有 15+ 条这种无 `code` 裸抛，见 `customsService.ts:264`），
   *   对应站点就重新变成"换成通用句 = 行为回退"，而上面 10 条例子**一条都不会红**。
   *   用的尺是仓里现成的 `stripComments`（不新造第二份"什么算泄漏"的正则）；锚点找不到时**抛错**而不是给 0。
   */
  it('★ 承重前提：收口那 5 站背后的服务段/helper 至今零 throw（前提破了必须重新判"该不该收"）', () => {
    const offenders = SEGMENTS
      .map(([name, spec]) => [name, (codeOf(spec).match(/\bthrow\b/g) ?? []).length] as const)
      .filter(([, n]) => n > 0);
    expect(offenders, '这些段落出现 `throw` ⇒ 该站 catch 里会混进业务原因，收口=吞掉用户该看的原因，必须重新定性（并同步本文件头与台账）').toEqual([]);
    /**
     * ★ 反面对照（防"零命中其实是因为尺瞎了"）：同一把尺、同一个切片函数，
     *   在**确实有裸抛**的 `createTradeDocument` 段必须数到 >0。
     */
    expect((codeOf('FN:createTradeDocument').match(/\bthrow\b/g) ?? []).length,
      '对照段本身有裸抛（实测 4 条：`单据类型 … 不支持手动创建`/`单据编号 … 已存在`/`throw e`/`单据编号生成失败`）⇒ 这里数到 0 说明锚点/配重/剥注释坏了，上面那条「零 throw」就不可信').toBeGreaterThan(0);
  });

  it(`★ 用例数 == 源码 safeRouteError 站点数（== ${SITES.length}）；flat 那一档必须有真站点撑着`, () => {
    expect((SOURCE.match(/\bsafeRouteError\(/g) ?? []).length, '站点数与用例数脱钩').toBe(SITES.length);
    expect(SITES.some((s) => s.shape === 'flat'), 'flat 那一档必须真有一站，否则 shape 分支是摆设').toBe(true);
    // ★ 刻意留的 2 处不在这里数（复核 I-5）：由 rawErrorLeakRatchet 的逐文件表钉，避免同一件事长出第二把尺
  });
});
