/**
 * 台账 **B68**（G1/G3 真值面）：HTTP 状态档不得由异常文本里的中文关键词猜。
 *
 * ★ 这一族最坏的地方是**方向**：77 个调用点里 76 个不传 fallback ⇒ 默认 400，
 *   一条 `ECONNREFUSED` / Prisma `P2003` / 事务超时会被说成"你的请求有问题"，
 *   用户以为是自己填错了，运维去查请求参数 —— 排障方向被假陈述带偏。
 *   本批收敛成一份实现：`shared/bizStatus.ts`。
 *
 * ★★ v2.45 复核更正（第一版这里写"三份已经漂 ⇒ 同一个原因在两个域不同档"）：词表逐条比是不同，
 *   但 MES 那份本来就有 `includes('不可')`，"不可编辑/不可审核"都含"不可" ⇒ **三域当时的行为一致**，
 *   取并集**不改变任何对外档位**。这条假陈述也出现在台账 v2.35/v2.42 两处，已一并更正。
 *   （复现：`git show 19d8bc5f~1:server/src/mes/mesRoute.ts` 第 100-105 行。）
 *
 * 判据形状（D56：域测试 + 可证伪探针为主证据）：
 *   ① 单元层把四档优先级各钉一条，并**同场跑一遍旧的关键词实现**当对照 ⇒ 证明新判据不是空转；
 *   ② 活路径层（`feedback-fix-must-land-on-live-path`）：三个 router 各打一条**真发出去的 HTTP 请求**，
 *      让替身 prisma 抛系统故障 ⇒ 必须 5xx；再抛业务文案 ⇒ 档位必须照旧。
 *      没有这一层，共享函数可以写得很对但一行都没被执行到。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { statusFromError } from '../bizStatus';
import { createCustomsRouter } from '../../customs/customsRoute';
import { createCustomsV2Router } from '../../customs/customsRouteV2';
import { createMesRouter } from '../../mes/mesRoute';

/** 改造前那份关键词实现（三个域取并集）—— 只作对照用，跑在同一个输入上 */
function legacyStatus(msg: string, fallback = 400): number {
  if (msg.includes('不存在')) return 404;
  if (msg.includes('已存在')) return 409;
  if (msg.includes('非法') || msg.includes('不可删除') || msg.includes('不可编辑') || msg.includes('不可审核') || msg.includes('不可') || msg.includes('超过')) return 409;
  return fallback;
}

const SYSTEM_MSGS = [
  'connect ECONNREFUSED 127.0.0.1:5432',
  // ★ v2.45 复核 IMPORTANT-3：第一版这里写的是 'PrismaClientKnownRequestError: … P2003' ——
  //   真 Prisma 错误的 message **不含类名、也不含 P2xxx**（码在 `.code` 上），替身不忠实真实形状。
  //   下面换成真实形状（文本里只有 `Foreign key constraint violated`），并由新增的 2b 档（看 `.code`）兜住。
  'Invalid `prisma.tradeDocument.create()` invocation:\n\nForeign key constraint violated: `TradeDocument_declarationId_fkey (index)`',
  'Transaction already closed: a database transaction cannot be committed',
  'query_timeout: statement timeout exceeded',
  '数据库连接池不可用',              // 中文里带「不可」——正是旧表会误判成 409 的那一类
];

describe('B68 · 状态档判定顺序：自带状态 > 已登记码 > Prisma P2xxx > 系统故障 > 业务关键词 > fallback', () => {
  /**
   * ★ v2.45 新增（复核 IMPORTANT-3 的直接后果）：真实 Prisma 错误的文本形状**不一定**含系统故障关键词
   *   （P2025 那句连 "not found" 都是 "found none"）⇒ 只看文本会退回 400。
   *   这一档改看 `error.code`，是"数据库故障对外说成 5xx"真正的兜底。
   */
  it('★ 2b：错误带 Prisma 的 P2xxx 码 ⇒ 500，即使文本一个关键词都不命中', () => {
    const bare = { code: 'P2025', message: 'Expected a record, found none.' };   // 文本无系统字样
    expect(statusFromError(bare)).toBe(500);
    expect(statusFromError({ code: 'P2002', message: 'Unique constraint failed on the fields' })).toBe(500);
    // 对照一：旧关键词实现在这两句上给的是 fallback（P2002 那句因含"约束"类中文才有档，英文一律漏）
    expect(legacyStatus(String(bare.message))).toBe(400);
    // 对照二：P1xxx（引擎初始化错误）**不在**这一档 ⇒ 不许顺手扩，落到文本档/兜底档
    expect(statusFromError({ code: 'P1001', message: '完全不像故障的业务文案' })).toBe(400);
  });

  it('① 错误自己带 statusCode 时，它就是答案（不再回头看文本）', () => {
    const e = Object.assign(new Error('报关单不存在'), { statusCode: 410, code: 'DECLARATION_GONE' });
    expect(statusFromError(e)).toBe(410);
    // 对照：文本里有「不存在」，旧实现会给 404 ⇒ 新实现认自带档位优先
    expect(legacyStatus(e.message)).toBe(404);
  });

  it('② 错误带**已登记**的码 ⇒ 取注册表档位（单一真源，不在路由里重抄）', () => {
    expect(statusFromError(Object.assign(new Error('x'), { code: 'NOT_FOUND' }))).toBe(404);
    expect(statusFromError(Object.assign(new Error('x'), { code: 'GATE_BLOCKED' }))).toBe(409);
    expect(statusFromError(Object.assign(new Error('x'), { code: 'NOTIFICATION_CATALOG_FAILED' }))).toBe(500);
  });

  it('★ ③ 系统故障一律抬到 5xx —— 旧实现在这里全给 4xx（这一条就是 B68 的病灶）', () => {
    for (const msg of SYSTEM_MSGS) {
      expect(statusFromError(new Error(msg)), `${msg} 应当是 5xx`).toBeGreaterThanOrEqual(500);
      expect(legacyStatus(msg), `旧实现对同一条给的是 ${legacyStatus(msg)} ⇒ 把系统故障说成客户端错`).toBeLessThan(500);
    }
  });

  it('④ 业务文案的档位**不许被顺手改掉**（收敛实现 ≠ 重定契约）', () => {
    for (const [msg, want] of [['报关单不存在', 404], ['该 HS 编码已存在', 409], ['工序时长超过上限', 409], ['该订单不可删除', 409]] as const) {
      expect(statusFromError(new Error(msg)), `${msg} 应保持 ${want}`).toBe(want);
      expect(legacyStatus(msg)).toBe(want);
    }
  });

  it('⑤ 都不认时才用 fallback（默认 400，与改造前一致），空消息也不炸', () => {
    expect(statusFromError(new Error('please try later'))).toBe(400);
    expect(statusFromError(new Error('please try later'), 503)).toBe(503);
    expect(statusFromError(undefined)).toBe(400);
    expect(statusFromError('字符串错误也可以传')).toBe(400);
  });

  /**
   * ★ v2.45 复核 BLOCK-2 后改了标题：第一版这里写"⇒ 前两档现在真的可达"，但**这两个域根本没有人产出
   *   `statusCode`**（`grep -rn statusCode server/src/{customs,mes}` 排除测试 = 0 命中，`processChainService`
   *   抛的几枚 code 也未登记进 `errorCodes`）⇒ 第 1、2 档今天**拿不到输入**，本批真正生效的是第 3 档 + 2b。
   *   标题不再声称"收口完成"，只声称"入参形状已改对，等域内补码之后 1、2 档即刻生效"。
   */
  /**
   * 分母说明（v2.46 复量，两个口径都对得上，别把这两个数当同一个）：
   *   改造前三份 `errStatus` 共 **77** 处调用（33/22/22，各文件另有 1 行是定义）；
   *   v2.46 起 `statusFromError` 共 **80** 处（36/22/22）——净增的 3 处是 v2.46 收进来的组合文档三站点，
   *   它们改造前是**内联三元**，本来就不在那 77 里。
   *   ★ v3.06 复量 **81**（customsRoute 36、customsRouteV2 **23**、mesRoute 22）：
   *   `customsRouteV2.ts` 的 `GET /documents/:id` 从"写死 404"改走真尺（B124 ②）⇒ 该文件净增 1 处。
   *   报价两站（B124 ①）也接了真尺，但 `quotations` 不在本判据的三域分母里
   *   ⇒ **两个数不能加减**（口径不同：这里只数 customs/mes 三个文件）。
   */
  it('★ 三域 81 个调用点（改造前 77）的入参必须是"本文件 catch 绑定的那个错误对象"（不得是文本/别名）', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const root = path.resolve(__dirname, '../../customs');
    const root2 = path.resolve(__dirname, '../../mes');
    const sites: Record<string, number> = {
      // ★ v2.46 分母 33→36：组合文档那三处内联三元被收进来（customsRoute.ts:770/799/830）
      [path.join(root, 'customsRoute.ts')]: 36,
      // v3.06 grew 22→23 for /documents/:id. c281d338 then retired
      // exactly GET /declarations/:id into safeRouteError; other 22 remain.
      [path.join(root, 'customsRouteV2.ts')]: 22,
      [path.join(root2, 'mesRoute.ts')]: 22,
    };
    for (const [f, want] of Object.entries(sites)) {
      const src = fs.readFileSync(f, 'utf-8');
      const bad = textFedSites(src);
      expect(bad, `${f} 有站点把文本/别名喂进判档 ⇒ 第 1、2 档永远走不到：\n${bad.join('\n')}`).toEqual([]);
      // 不许在域内重立本地别名/第二份实现（本批正是把三份收一份的；兜底档只能有一处默认值）
      expect(src, `${f} 又长出本地 errStatus 壳 ⇒ 兜底档会出现第二个默认值`).not.toMatch(/\berrStatus\b/);
      // 分母钉住（不再是 toBeGreaterThan(0) 那种"塌到 1 也不红"的地板）
      const n = (src.match(/\bstatusFromError\(/g) ?? []).length;
      expect(n, `${f} 的调用点数从 ${want} 变了 ⇒ 台账 B68 行的分母要同步`).toBe(want);
    }
  });

  /**
   * 正面对照（复核 IMPORTANT-5 直接催生）：第一版只禁 `x.message` 一种写法，
   * 而 `const msg = String(e?.message || e)` 之后 `statusFromError(msg)` 这种**别名**能溜过去
   * （`customsRoute.ts:828` 现场就有这个形状）⇒ 判据换成"首参必须是本文件 catch 绑定的变量名"。
   */
  it('★ 正面对照：文本形状与别名形状都要被抓（否则上面那条是恒绿）', () => {
    const caughtSample = [
      "try { await svc.a(); } catch (e) { res.status(statusFromError(e?.message ?? '')).json({}); }",
      "try { await svc.b(); } catch (err) { const msg = String(err?.message || err); res.status(statusFromError(msg)).json({}); }",
      "try { await svc.c(); } catch (e) { res.status(statusFromError(e, 500)).json({}); }",       // 唯一合法形状
    ].join('\n');
    const bad = textFedSites(caughtSample);
    expect(bad.length).toBe(2);                                   // 文本 + 别名各一条
    expect(bad.some((l) => l.includes('e?.message'))).toBe(true);
    expect(bad.some((l) => l.includes('statusFromError(msg'))).toBe(true);
  });
});

/** 普查实现（只此一份）：返回"首参不是本文件 catch 绑定名"的 statusFromError 调用行 */
function textFedSites(src: string): string[] {
  const caught = new Set([...src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const out: string[] = [];
  for (const m of src.matchAll(/\bstatusFromError\(\s*([^,)]+)/g)) {
    const arg = m[1].trim();
    if (!caught.has(arg)) out.push(`statusFromError(${arg}…`);
  }
  return out;
}

describe('B68 活路径 · 三个 router 真发请求：系统故障不得再报 400', () => {
  const SYSTEM = 'connect ECONNREFUSED 127.0.0.1:5432';

  function appWith(router: express.Router, prefix: string) {
    const app = express();
    app.use(express.json());
    app.use(prefix, router);
    return app;
  }
  /** prisma 替身：让列表/单条读取按指定文案抛错 */
  const prismaThrowing = (msg: string) => new Proxy({}, {
    get: () => new Proxy({}, { get: () => async () => { throw new Error(msg); } }),
  }) as any;

  const cases = [
    { name: 'customs V1 GET /hs-codes/:code', app: () => appWith(createCustomsRouter({ prisma: prismaThrowing(SYSTEM), requireAuth: false, apiKeys: new Set() } as any), '/api/v1/customs'), url: '/api/v1/customs/hs-codes/HS1', legacyWas400: true },
    { name: 'customs V2 GET /hs-codes/:code', app: () => appWith(createCustomsV2Router({ prisma: prismaThrowing(SYSTEM), requireAuth: false, apiKeys: new Set() } as any), '/api/v2/customs'), url: '/api/v2/customs/hs-codes/HS1', legacyWas400: true },
    // MES 这一站点的调用点本来就传了 500 ⇒ 它不是"被改好"的那一类；留在这里是为了证明**共享实现真的在活路径上被走到**
    { name: 'MES GET /work-stations/:id/utilization（该站点旧 fallback 已是 500）', app: () => appWith(createMesRouter({ prisma: prismaThrowing(SYSTEM), requireAuth: false, apiKeys: new Set() } as any), '/api/v1/mes'), url: '/api/v1/mes/work-stations/WS1/utilization?startDate=2026-01-01&endDate=2026-02-01', legacyWas400: false },
  ];

  for (const c of cases) {
    it(`${c.name}：数据层 ECONNREFUSED ⇒ 500（而不是把系统故障说成"你的请求有问题"的 400）`, async () => {
      const res = await request(c.app()).get(c.url);
      expect(res.status, `档位应为 500，实得 ${res.status}`).toBe(500);
      if (c.legacyWas400) {
        // ★ 这条断言不是恒真：这类站点没传 fallback ⇒ 旧关键词表对同一句给 400
        expect(legacyStatus(SYSTEM), '对照：旧实现对同一条给 400').toBe(400);
      }
    });
  }

  it('同一批 router 上业务文案仍走 404（证明不是"一律 500"糊过去）', async () => {
    for (const prefix of ['/api/v1/customs', '/api/v2/customs']) {
      const factory: any = prefix.includes('v1') ? createCustomsRouter : createCustomsV2Router;
      const app = appWith(factory({ prisma: prismaThrowing('HS 编码不存在'), requireAuth: false, apiKeys: new Set() } as any), prefix);
      const res = await request(app).get(`${prefix}/hs-codes/HS1`);
      expect(res.status, `${prefix} 上「不存在」应保持 404，实得 ${res.status}`).toBe(404);
    }
  });

  it('★ 反向自检：判据确实会红 —— 把系统故障文案交给旧实现就落在 4xx', () => {
    // 这条不测产品代码，测的是"上面那三条断言的判据不是恒真"
    expect(SYSTEM_MSGS.every((m) => legacyStatus(m) < 500)).toBe(true);
  });
});
