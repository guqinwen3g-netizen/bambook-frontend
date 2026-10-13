/**
 * B42 A1（S0-A2 文案线第 10 批）· email 域 25 处路由级直发的收敛守卫。
 *
 * 收敛前每一处都是 `message: String(e?.message ?? e)` 这一类的变体 —— **原始异常文本直接进对外响应**。
 * 邮件域特别贵：SMTP/IMAP 的原文里带邮箱地址、主机名与连接串，`/outbox/:id/send` 与 8 个
 * IMAP 代理端点都会把它发给前端；而 PII 一旦上了屏，光"改文案"不够 —— 所以本文件的判据是三条同时成立：
 *   ① 响应体里**不许**出现原始异常文本（用唯一哨兵串判，不靠"看起来像中文"）；
 *   ② 出现的必须是**本端点专属**文案，不是万能兜底句（`!== GENERIC_ROUTE_ERROR_MESSAGE`；
 *      这条专门抓"接了真源但没给 fallbackMessage"——B29 棘轮量的就是这个洞）；
 *   ③ 真相没丢：同一笔异常仍被 `logger.error` 带走（D51 的前置是"这里本来就有日志"，
 *      收敛之后必须**仍然**有，否则就是把可诊断性换成了可读性）。
 *
 * ★ 25 = 本批首版 14 + 复核补的 11。首版只数了"`message: String(e?.message ?? e)` 这一种形状"，
 *   漏掉了 `error: e.message`、`'前缀: ' + e.message`、`.send('Download failed: ' + e.message)`
 *   三种兄弟形状（同一个缺陷族，落点不同）⇒ 复核 BLOCK。教训与 notifications 那批同源：
 *   **数一族缺陷要按落点数，不能按形状数**。
 *
 * ★ 为什么 25 个端点逐个打（上一批被复核抓到"标题写 10 处、实际只打 1 个端点"）：
 *   只要有一处漏打，把那一处改回原样本文件一处都不会红。
 *   ⇒ 末尾"用例数 == 源码里 safeRouteError 站点数"的断言就是防这张表偷懒的。
 *   ⚠️ 站点数判据只覆盖**本域两个路由文件**，不是全仓判据（按 D49 不新增棘轮）。
 *   ⚠️ service 层那三处（outboxSend / emailSyncService）不在本文件的路由判据范围内：
 *      `sendOutboxEmail` 从不抛错，路由对它是**原样转发** `result.error`
 *      ⇒ 那一层的出口收敛由 `outboxSend.test.ts` / `emailSyncService.test.ts` 钉，见下方"结构守卫"里的文件清单。
 */
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/errorCodes';
import { createEmailRouter } from '../route';
import { createEmailTemplateRouter } from '../templateRoute';
import { logger } from '../../lib/logger';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
/**
 * 两个令牌不是图省事，是**矩阵就这么规定的**（`_shared/rolePermissionMatrix.ts`，
 * 见 `emailWriteScopeGate.test.ts:12-16` 的注释）：
 *   - `admin` 只有 `emails:read` ⇒ 高权限端点（`requireRole(...HIGH_RISK_ROLES)`）与只读端点归它；
 *   - `emails:write` 在 SALES 手上 ⇒ 写端点必须换 sales，否则测的是 403 而不是 catch 出口。
 * ⇒ 用错令牌不会让测试变松，但会**恒红**（本文件第一版就是这么红的）。
 */
const adminCookie = `bambook_token=${jwt.sign({ userId: 'u_admin', roles: ['admin'] }, SECRET)}`;
const salesCookie = `bambook_token=${jwt.sign({ userId: 'u_sales', roles: ['sales'] }, SECRET)}`;

/**
 * 只在测试里出现的"内部原文"指纹：任何一段都不许出现在响应体里。
 * ★ 后半截（`user=sales@…`）是**特意加的**：IMAP/SMTP 库的真实报错就是这个形状
 *   —— 带发件邮箱与主机名。只放 Prisma 串会测不到本域最贵的那一类外泄。
 */
const RAW_PARTS = ['P2010', 'connection terminated', 'pool#37', 'mailer.example.internal', 'sales@mailer.example.internal'];
// hoisted：`vi.mock` 工厂在 import 之前求值，哨兵必须一起提前，否则工厂里拿到 undefined
const H = vi.hoisted(() => ({
  RAW_SENTINEL: 'PrismaClientKnownRequestError: P2010 connection terminated at pool#37 on mailer.example.internal user=sales@mailer.example.internal',
}));
const RAW_SENTINEL = H.RAW_SENTINEL;
/**
 * 本域有 11 处的异常源**不是 prisma**，而是 IMAP/SMTP 库（`/fetch` `/send` `/mark_*` `/move`
 * `/attachment` `/detail`）。不打真邮箱是硬约束 ⇒ 在**库边界**注入同一个哨兵：
 * 生产上这些位置抛出来的正是这种带主机名与账号的原文，注入点与故障点一致。
 */
const imapMocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('imap-simple', () => ({ __esModule: true, default: { connect: imapMocks.connect }, connect: imapMocks.connect }));
const nmMocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: nmMocks.createTransport }, createTransport: nmMocks.createTransport }));
/**
 * ★ 发件这条唯一一处不走 prisma 抛出：`sendOutboxEmail` 自己把数据层异常吸收成
 *   `{ok:false, error:{statusCode:404}}` 早退 ⇒ 路由的 catch 根本进不去（实测 404，
 *   而 404 里恰好没有原文 = **假绿**）。所以这一处在**服务边界**注入哨兵，
 *   测的是它真的抛出来时路由说什么。吸收本身是另一条缺陷（B42 的 C 族），另账。
 */
vi.mock('../outboxSend', () => ({
  sendOutboxEmail: async () => { throw new Error(H.RAW_SENTINEL); },
}));

/**
 * 任何深度的数据访问都**异步**抛给定异常。
 * ★ 必须是"可调用的递归 Proxy"：`prisma.email.findMany()` 走的是 `get('email') → get('findMany') → apply`
 *   三跳，只代理一跳会让 `prisma.email` 变成一个函数、`.findMany` 变 undefined，
 *   于是抛的是 `prisma.email.findMany is not a function` —— **测试绿在错误的原因上**
 *   （本文件第一版就是这么抓到自己：日志里那句原文与哨兵无关，第 ③ 条判据当场不成立）。
 *   用 async apply 是为了与真 prisma 一致（恒返 rejected promise，而不是同步 throw）。
 */
function throwingPrisma(err: Error): any {
  const node: any = new Proxy(async function () { /* 占位，真实行为在 apply 钩子里 */ }, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined; // 别被当成 thenable
      return node;
    },
    apply: async () => { throw err; },
  });
  return node;
}

function baseApp(router: express.Router, mount: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const cookies: Record<string, string> = {};
    if (req.headers.cookie) {
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
    }
    req.cookies = cookies;
    next();
  });
  app.use(mount, router);
  return app;
}

function makeEmailApp(err: Error = new Error(RAW_SENTINEL)) {
  // 8 个 IMAP 代理端点的异常源在库边界（见上方 vi.mock 注释），prisma 桩则覆盖另外几处
  imapMocks.connect.mockRejectedValue(err);
  nmMocks.createTransport.mockReturnValue({ sendMail: async () => { throw err; } } as any);
  return baseApp(createEmailRouter({ prisma: throwingPrisma(err), requireAuth: true, apiKeys: new Set(['ak']) } as any), '/api/v1/email');
}

function makeTemplateApp(err: Error = new Error(RAW_SENTINEL)) {
  // AI 生成端点的异常源是 LLM 调用器（不是 prisma）⇒ 注入同一个哨兵，保住"每条都测的是出口"
  const llm = async () => { throw err; };
  return baseApp(
    createEmailTemplateRouter({ prisma: throwingPrisma(err), requireAuth: true, apiKeys: new Set(['ak']), llm } as any),
    '/api/v1/email-templates',
  );
}

type Case = {
  /** 人类可读名（只出现在断言消息里） */
  name: string;
  /** 源码站点定位：`文件:VERB path` —— 期望码与期望文案都从源码那一份真源解析出来，测试不重抄 */
  at: string;
  app: () => express.Express;
  /** 缺省 = admin 令牌；写端点必须用 sales（矩阵：emails:write 在 SALES 手上，用错令牌测的是 403） */
  tok?: 'sales';
  send: (a: express.Express, token: string) => any;
};

/**
 * ★ 期望值从源码解析，不在测试里重抄文案（判据只能有一份实现）。
 * 解析规则：按源码顺序把每个 `safeRouteError(err, { fallbackCode, fallbackMessage })`
 * 归到它**上方最近**的 `router.<verb>('<path>'` 上。
 * 缺 `fallbackMessage` 的站点匹配不上 ⇒ 下面的"站点数 == 用例数"当场红（= 每个端点必须自带文案）。
 */
type Site = { key: string; code: string; message: string };
function sitesOf(file: string, src: string): Site[] {
  const routers = [...src.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)];
  const calls = [...src.matchAll(
    /safeRouteError\(\s*[\w$]+\s*,\s*\{[^}]*?fallbackCode:\s*'([A-Z0-9_]+)'[^}]*?fallbackMessage:\s*'([^']+)'/g,
  )];
  return calls.map((c) => {
    const owner = routers.filter((r) => r.index! < c.index!).pop();
    return {
      key: `${file}:${(owner ? owner[1].toUpperCase() : '?')} ${owner ? owner[2] : '未归属'}`,
      code: c[1],
      message: c[2],
    };
  });
}

const ROUTE_SRC = readFileSync(path.resolve(__dirname, '../route.ts'), 'utf-8');
const TEMPLATE_SRC = readFileSync(path.resolve(__dirname, '../templateRoute.ts'), 'utf-8');
const OUTBOX_SRC = readFileSync(path.resolve(__dirname, '../outboxSend.ts'), 'utf-8');
const SYNC_SRC = readFileSync(path.resolve(__dirname, '../emailSyncService.ts'), 'utf-8');
const SCAN_FILES: Array<[string, string]> = [
  ['route.ts', ROUTE_SRC],
  ['templateRoute.ts', TEMPLATE_SRC],
  ['outboxSend.ts', OUTBOX_SRC],
  ['emailSyncService.ts', SYNC_SRC],
];

const SITES: Site[] = [...sitesOf('route.ts', ROUTE_SRC), ...sitesOf('templateRoute.ts', TEMPLATE_SRC)];

const CASES: Case[] = [
  // ── server/src/email/route.ts（18 处）
  { name: 'GET / 邮件列表', at: 'route.ts:GET /', app: makeEmailApp, send: (a, tok) => request(a).get('/api/v1/email').set('Cookie', tok) },
  { name: 'PATCH /:id 标记邮件', at: 'route.ts:PATCH /:id', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).patch('/api/v1/email/E-1').set('Cookie', tok).send({ isRead: true }) },
  { name: 'POST /backfill-links 关联回填', at: 'route.ts:POST /backfill-links', app: makeEmailApp, send: (a, tok) => request(a).post('/api/v1/email/backfill-links').set('Cookie', tok).send({}) },
  { name: 'POST /:id/auto-link 自动关联', at: 'route.ts:POST /:id/auto-link', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/E-1/auto-link').set('Cookie', tok).send({}) },
  { name: 'POST /:id/classify 单封分类', at: 'route.ts:POST /:id/classify', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/E-1/classify').set('Cookie', tok).send({}) },
  { name: 'POST /classify-backfill 补分类', at: 'route.ts:POST /classify-backfill', app: makeEmailApp, send: (a, tok) => request(a).post('/api/v1/email/classify-backfill').set('Cookie', tok).send({}) },
  { name: 'POST /:id/create-followup 转跟进', at: 'route.ts:POST /:id/create-followup', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/E-1/create-followup').set('Cookie', tok).send({ subject: '跟进' }) },
  // outboxSend 在服务边界被改成"真的抛错"，这样打到的才是路由那一层出口（吸收本身另账 B67）
  { name: 'POST /outbox/:id/send 发件', at: 'route.ts:POST /outbox/:id/send', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/outbox/EO-1/send').set('Cookie', tok).send({}) },
  // ↓ 以下 8 处是复核补进来的：异常源是 IMAP/SMTP 库，不是 prisma，首版按形状数的时候全漏了
  { name: 'POST /fetch IMAP 拉列表', at: 'route.ts:POST /fetch', app: makeEmailApp, send: (a, tok) => request(a).post('/api/v1/email/fetch').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', box: 'INBOX' }) },
  { name: 'POST /send SMTP 直发', at: 'route.ts:POST /send', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/send').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', to: 'c@d.com', subject: 'x' }) },
  { name: 'POST /mark_read 标记已读', at: 'route.ts:POST /mark_read', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/mark_read').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7 }) },
  { name: 'POST /mark_starred 标记星标', at: 'route.ts:POST /mark_starred', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/mark_starred').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7 }) },
  { name: 'POST /mark_important 标记重要', at: 'route.ts:POST /mark_important', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/mark_important').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7 }) },
  { name: 'POST /move 移动邮件', at: 'route.ts:POST /move', app: makeEmailApp, tok: 'sales', send: (a, tok) => request(a).post('/api/v1/email/move').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7, toBox: 'Archive' }) },
  { name: 'POST /attachment 附件下载（响应是纯文本）', at: 'route.ts:POST /attachment', app: makeEmailApp, send: (a, tok) => request(a).post('/api/v1/email/attachment').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7, filename: 'a.pdf' }) },
  { name: 'POST /detail 邮件详情（IMAP）', at: 'route.ts:POST /detail', app: makeEmailApp, send: (a, tok) => request(a).post('/api/v1/email/detail').set('Cookie', tok).send({ email: 's@mailer.example.internal', password: 'p', uid: 7 }) },
  // intents 有前置 400（mailbox/uids 必填）⇒ 带合法 query，否则测的是早退分支而不是 catch
  { name: 'GET /intents 意图列表', at: 'route.ts:GET /intents', app: makeEmailApp, send: (a, tok) => request(a).get('/api/v1/email/intents?mailbox=INBOX&uids=1,2').set('Cookie', tok) },
  { name: 'GET /:id 单封详情', at: 'route.ts:GET /:id', app: makeEmailApp, send: (a, tok) => request(a).get('/api/v1/email/E-1').set('Cookie', tok) },
  // ── server/src/email/templateRoute.ts（7 处）
  { name: 'GET / 模板列表', at: 'templateRoute.ts:GET /', app: makeTemplateApp, send: (a, tok) => request(a).get('/api/v1/email-templates').set('Cookie', tok) },
  { name: 'POST / 新建模板', at: 'templateRoute.ts:POST /', app: makeTemplateApp, send: (a, tok) => request(a).post('/api/v1/email-templates').set('Cookie', tok).send({ name: 'T', subject: 'S', body: 'B', type: 'general' }) },
  { name: 'PATCH /:id 更新模板', at: 'templateRoute.ts:PATCH /:id', app: makeTemplateApp, send: (a, tok) => request(a).patch('/api/v1/email-templates/EMTPL__1').set('Cookie', tok).send({ subject: 'S2' }) },
  { name: 'POST /:id/use 套用模板', at: 'templateRoute.ts:POST /:id/use', app: makeTemplateApp, send: (a, tok) => request(a).post('/api/v1/email-templates/EMTPL__1/use').set('Cookie', tok).send({ variables: {} }) },
  { name: 'POST /ai-generate AI 生成', at: 'templateRoute.ts:POST /ai-generate', app: makeTemplateApp, send: (a, tok) => request(a).post('/api/v1/email-templates/ai-generate').set('Cookie', tok).send({ scenario: '催付尾款', type: 'payment_reminder' }) },
  { name: 'DELETE /:id 删除模板', at: 'templateRoute.ts:DELETE /:id', app: makeTemplateApp, send: (a, tok) => request(a).delete('/api/v1/email-templates/EMTPL__1').set('Cookie', tok) },
  { name: 'POST /seed 内置模板初始化', at: 'templateRoute.ts:POST /seed', app: makeTemplateApp, send: (a, tok) => request(a).post('/api/v1/email-templates/seed').set('Cookie', tok).send({}) },
];

/**
 * 本域对外出口"原文直发"的形状检测（形状无关，见下面 6 条正面对照）。
 * ⚠️ 两个正则各管一半，缺一不可：
 *   `RAW_OUTWARD` 认"这行引用了**异常对象**的 message"—— 刻意写成要有 `e`/`err`/`error`/`cause`
 *   这个前缀，否则收敛后的 `message: safe.message` 也会被误判（`safe.message` 同样含 `.message`）；
 *   `SEND_OR_WRAP` 认"这行是个对外出口或错误包装"。
 * ⚠️ 判不到的情形（如实记）：`res.json({ error: result.error })` 这种**原样转发 service 错误对象**
 *   的行本身不含异常引用，检测器看不见 ⇒ 那一层的收敛由被转发方（outboxSend.ts / emailSyncService.ts
 *   也在扫描清单里）自己钉。
 */
const RAW_OUTWARD = /(?:\b(?:e|err|error|ex|cause)\??\.message\b|(?<![\w$])[\w$]*(?:Err|Error|error)\??\.message\b|String\(\s*(?:e|err|error)\b)/g;
const SEND_OR_WRAP = /(res\.|\.json\(|\.send\(|buildOutboxSendError\(|buildEmailSyncError\()/;
/** 所有文件都享有的豁免：日志行（真相必须在） */
const ALWAYS_ALLOWED = [/logger\.(error|warn|info)/];
/**
 * ★ **按文件**豁免，不按名字全局豁免。
 *   第一版写成全局 `buildEmailSyncError(` ⇒ 任何文件里出现这个名字就自动放过 ——
 *   而 `src/agent/emailSyncFlow.ts:17` 恰好有一个**同名但完全不同**的实现（它把 message 原样透传给工具反馈），
 *   将来把那个文件纳入扫描清单时就会被这条豁免静默放过（复核抓到的正是这种"豁免范围大于证据范围"）。
 *   同步域这条豁免的证据：`emailSyncService.test.ts` 的"换一条完全不同的原文，对外文案必须一模一样"。
 */
const FILE_ALLOWED: Record<string, RegExp[]> = {
  'emailSyncService.ts': [/\bbuildEmailSyncError\s*\(/],
};

/** 从"某个调用的起点"走到它的右括号，返回参数区间 [开括号后, 闭括号]；找不到括号返回 null。 */
function callArgSpan(src: string, from: number): [number, number] | null {
  const open = src.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return [open + 1, i]; }
  }
  return null;
}

function rawOutwardStatements(src: string, file = ''): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(RAW_OUTWARD)) {
    // 取"所在语句"：从匹配点往前到最近的分号/右花括号，往后到下一个分号
    const before = src.slice(0, m.index!);
    const start = Math.max(before.lastIndexOf(';'), before.lastIndexOf('}')) + 1;
    const endRel = src.slice(m.index!).indexOf(';');
    const end = endRel < 0 ? src.length : m.index! + endRel + 1;
    const stmt = src.slice(start, end);
    if (!SEND_OR_WRAP.test(stmt)) continue;
    if (ALWAYS_ALLOWED.some((re) => re.test(stmt))) continue;
    /**
     * ★ 复核 I-2：豁免**只覆盖被豁免那个调用的参数区间**，不覆盖整条语句。
     *   第一版按"这条语句里出现了 buildEmailSyncError( 就整句放过" ⇒
     *   `message: buildEmailSyncError(…).message + '：' + e.message` 这种"包一层再拼一口原文"被静默放过，
     *   而豁免的证据（"换原文文案必须一模一样"）只覆盖**函数返回值**，不覆盖旁边拼上去的裸原文
     *   ⇒ 正是本仓定义的"豁免范围 > 证据范围"。
     */
    const hitsInside = [...src.matchAll(RAW_OUTWARD)].map((r) => r.index!).filter((ix) => ix >= start && ix < end);
    let covered = new Set<number>();
    for (const re of FILE_ALLOWED[file] ?? []) {
      for (const am of stmt.matchAll(new RegExp(re.source, 'g'))) {
        const span = callArgSpan(src, start + am.index!);
        if (!span) continue;
        for (const h of hitsInside) if (h >= span[0] && h <= span[1]) covered.add(h);
      }
    }
    if (hitsInside.length && hitsInside.every((h) => covered.has(h))) continue;
    const flat = stmt.replace(/\s+/g, ' ').trim();
    if (!out.includes(flat)) out.push(flat);
  }
  return out;
}

describe('B42 A1 · email 路由出口：25 处逐个打，原文不外泄、每端点说自己那句话、日志不丢真相', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('★ 用例表与源码站点必须一一对应（漏一条 = 这张表在假装覆盖全量）', () => {
    expect(SITES.length, '站点数变了 ⇒ 同步本表（新增出口不许静默不测；没带 fallbackMessage 的站点也会在这里红）').toBe(CASES.length);
    for (const c of CASES) {
      expect(SITES.find((s) => s.key === c.at), `${c.name} 在源码里找不到对应站点`).toBeTruthy();
    }
    for (const s of SITES) {
      expect(CASES.find((c) => c.at === s.key), `站点 ${s.key} 没有被任何用例打到`).toBeTruthy();
    }
    // 解析器不许把两笔调用并成一条（并了 = 上面两条循环会一起失真）
    expect(new Set(SITES.map((s) => s.key)).size).toBe(SITES.length);
  });

  /**
   * ★ 形状无关的结构守卫（复核抓到的正是"只认一种形状"）：
   *   本域四个文件（2 个路由 + 2 个 service）里，任何**对外出口**都不许引用异常原文。
   *   第一版这里写的是 `message:\s*String\(...\)` 一条正则 —— 对 `error: e.message`、
   *   `'前缀: ' + err.message`、`.send('Download failed: ' + e.message)` 三种真实存在的形状
   *   **一条都抓不到**（恒绿的空判据）。下面用 6 条正面对照把它钉成有牙的。
   */
  it('★ 结构守卫：本域四个文件里"对外出口引用异常原文"的站点数为 0', () => {
    for (const [name, src] of SCAN_FILES) {
      expect(rawOutwardStatements(src, name), `${name} 又出现原文直发的写法：\n${rawOutwardStatements(src, name).join('\n')}`).toEqual([]);
    }
    // ★ 豁免不许越界：同一句"引用异常原文"，出现在**没有该豁免**的文件里必须被抓（否则豁免就是全局免检牌）
    const SYNC_ONLY = `return { ok: false, error: buildEmailSyncError('SYNC_FAILED', e?.message || String(e)) };`;
    expect(rawOutwardStatements(SYNC_ONLY, 'emailSyncService.ts'), '本文件的豁免失效了？').toEqual([]);
    for (const other of ['route.ts', 'outboxSend.ts', 'agent/emailSyncFlow.ts']) {
      expect(rawOutwardStatements(SYNC_ONLY, other).length,
        `同名函数在 ${other} 也被放过 ⇒ 豁免范围大于证据范围`).toBe(1);
    }
    /**
     * ★ 复核 I-2：豁免必须**只覆盖被豁免那个调用的参数区间**。
     *   下面这句"包一层再在括号外拼一口裸原文"就发生在**享受豁免的那个文件里**，
     *   如果豁免按整条语句生效就会被放过 ⇒ 而它的证据（"换原文文案一模一样"）只覆盖函数返回值。
     */
    const WRAP_PLUS_RAW = `return { ok: false, error: { code: 'SYNC_FAILED', message: buildEmailSyncError('SYNC_FAILED', e?.message).message + '：' + e.message } };`;
    expect(rawOutwardStatements(WRAP_PLUS_RAW, 'emailSyncService.ts').length,
      '在豁免函数旁边拼裸原文 = 仍然原文外泄，必须被抓').toBe(1);
    // 同一句去掉括号外那半截 ⇒ 必须不报（证明上一条是被"括号外那半截"触发的，不是恒红）
    const WRAP_ONLY = `return { ok: false, error: { code: 'SYNC_FAILED', message: buildEmailSyncError('SYNC_FAILED', e?.message).message } };`;
    expect(rawOutwardStatements(WRAP_ONLY, 'emailSyncService.ts'), '纯包一层的合法写法不许误伤').toEqual([]);
  });

  /** 正面对照：检测器必须抓得住每一种历史上真实出现过的形状（否则上面那条是空转） */
  const POSITIVE = [
    `res.status(500).json({ ok: false, error: { code: 'X', message: String(e?.message ?? e) } });`,
    `res.status(500).json({ ok: false, error: e.message });`,
    `res.status(500).json({ error: '邮箱连接失败: ' + err.message });`,
    `res.status(500).send('Download failed: ' + e.message);`,
    `return { ok: false, error: buildOutboxSendError('SMTP_SEND_FAILED', 'SMTP send failed: ' + String(e?.message ?? e)) };`,
    // 第 6 条是**跨行**形状：notifications 那批被抓到的同类缺陷就是"正则只认单行"，这里主动补上
    `res.status(500).json({\n ok: false,\n error: { code: 'X_FAILED', message: String(e?.message ?? e) },\n });`,
  ];
  for (const [i, snippet] of POSITIVE.entries()) {
    it(`正面对照 ${i + 1}：检测器抓得住这种历史形状 ${'→'} ${snippet.slice(0, 46)}…`, () => {
      expect(rawOutwardStatements(snippet).length, '检测器抓不到 ⇒ 结构守卫是空转').toBe(1);
    });
  }

  /** 反面对照：合法写法不许被抓（尤其"日志行必须带原文"这条不能被误伤） */
  // ★ 每条都带**所在文件**：豁免是按文件生效的，不写文件就等于没享受豁免（这正是设计）
  const NEGATIVE: Array<[string, string]> = [
    [`logger.error('[email] SMTP send failed', { emailId, error: e?.message || String(e) });`, 'outboxSend.ts'],
    [`return { ok: false, error: buildEmailSyncError('SYNC_FAILED', e?.message || String(e)) };`, 'emailSyncService.ts'],
    [`res.status(500).json({ ok: false, error: { code: safe.code, message: safe.message } });`, 'route.ts'],
    [`res.json({ ok: true, data: email });`, 'route.ts'],
  ];
  for (const [i, [snippet, file]] of NEGATIVE.entries()) {
    it(`反面对照 ${i + 1}（${file}）：合法写法不该被抓（抓了就是把日志判据做反）`, () => {
      expect(rawOutwardStatements(snippet, file), snippet).toEqual([]);
    });
  }

  /** 从任意一种响应形状里取出"用户实际看到的那句话" */
  function outward(res: request.Response): { msg: string; code?: string } {
    const b: any = res.body;
    if (b && typeof b === 'object' && b.error && typeof b.error === 'object') return { msg: String(b.error.message ?? ''), code: b.error.code };
    if (b && typeof b === 'object' && typeof b.error === 'string') return { msg: b.error };
    if (b && typeof b === 'object' && typeof b.message === 'string') return { msg: b.message, code: b.code };
    return { msg: String(res.text ?? '') };
  }

  for (const c of CASES) {
    it(`${c.name} ⇒ 只发本端点自己的那句话，响应体里不许有原始异常文本`, async () => {
      const site = SITES.find((s) => s.key === c.at)!;
      const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
      const res = await c.send(c.app(), c.tok === 'sales' ? salesCookie : adminCookie);
      const body = JSON.stringify(res.body) + String(res.text ?? '');
      const { msg, code } = outward(res);

      expect(res.status, `${c.name} 档位不对：${body}`).toBe(500);
      // ① 用户看到的必须是**这个站点**在源码里写的那句话（期望值同源解析，不重抄）
      expect(msg, `${c.name} 说的不是自己那句话：${msg}`).toBe(site.message);
      expect(msg).not.toBe(GENERIC_ROUTE_ERROR_MESSAGE);
      if (code !== undefined) expect(code, `${c.name} 码不对`).toBe(site.code);
      // ② 原文一个字都不许出现（含邮箱地址与主机名）
      for (const part of RAW_PARTS) expect(body, `${c.name} 把内部异常发给了用户（含 ${part}）`).not.toContain(part);
      // ③ 真相仍在日志里
      const logged = errSpy.mock.calls.map((a) => JSON.stringify(a)).join('\n');
      expect(logged, `${c.name} 换了文案但把异常原文也弄丢了 ⇒ 排障无从下手`).toContain('P2010');
    });
  }

  it('★ 反向自检：哨兵确实会出现在"未收敛"的写法里（否则上面那些 not.toContain 是空转）', () => {
    // 用一个刻意保留原文的假出口证明 RAW_PARTS 判据不是恒真
    const app = express();
    app.get('/probe', (_req, res) => {
      res.status(500).json({ ok: false, error: { code: 'X', message: String(new Error(RAW_SENTINEL).message) } });
    });
    return request(app).get('/probe').expect((r) => {
      const body = JSON.stringify(r.body);
      for (const part of RAW_PARTS) expect(body).toContain(part); // 判据能抓到 = 前面那批断言有牙
    });
  });
});
