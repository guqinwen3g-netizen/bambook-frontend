/**
 * ★ B15 取证工具的身份列自检（v3.04）—— `seenBy` 挂了两天一直是 `-`，等于没有判据。
 *
 * 要证明的命题只有一句：**"是不是被测应用答的"与"我连的是不是答我的那个端口"，两件事都能从指纹读出来。**
 * 每个断言都配两侧（缺一侧就是恒真/恒假的绿灯）：
 *   正面对照 ①①b：真 app（含它自己答的 404）⇒ 带 token、`want==peer` ⇒ `match=Y`
 *   负面对照 ②②b：非 Express 的应答者（裸 `net.Server`）⇒ 缺 token；`noct` 只在该档该亮时才亮
 * ★ 为什么必须成对（v3.04 复核 IM-1/MN-1 的教训）：**只写负面对照时，`markApp` 整块失效也不会红**
 *   —— 本批第一版就正好栽在这一条上（`markApp` 取错对象 ⇒ ②仍绿，只有 ①①b 红了）。
 * ⚠️ 本文件是全仓 server 测试里**唯一真开 TCP 监听器**的用例（复核 MN-3）⇒
 *   它一旦红，**先怀疑环境（socket 层劫持，即 B15 本身）**，不要直接读成"markApp 坏了"；
 *   所以它和 ①①b 分成两个 describe，便于二分。
 */
import express from 'express';
import http from 'http';
import net from 'net';
import request from 'supertest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
APP_TOKEN, EXPECT_APP_HEADER, OWN_PID, doWeListen, httpErrEvidence, httpEvidence, needsOwner, ownerFields, portOfUrl, portOwner
} from '../shared/__tests__/utils/httpEvidence';

/** 从指纹串里取一栏（值到下一个空格为止） */
function col(fingerprint: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}=([^\\s]*)`).exec(fingerprint);
  return m ? m[1] : '<缺栏>';
}

function makeApp() {
  const app = express();
  app.get('/known', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('B15 身份列 · 正面对照（真 app）', () => {
  it('① 200 带 token，且 want/peer 端口一致 ⇒ match=Y（钩子真装上了、端口列真能算）', async () => {
    const t = request(makeApp()).get('/known');
    const res = await t;
    const want = portOfUrl((t as any).url);
    const fp = httpEvidence(res, want);
    expect(res.status, `健康请求应当由被测应用答；拿到 401/404 就是 B15 现场（本文件自己也逃不掉）。${httpEvidence(res, portOfUrl((t as any).url))}`).toBe(200);
    expect((res.headers as Record<string, string | undefined>)[EXPECT_APP_HEADER],
      `markApp 没生效 ⇒ 身份列等于没有：${fp}`).toBe(APP_TOKEN);
    /** ★ `want`/`peer` 端口对：用与 test-setup 同一把尺（`test.url` 解析）自己算一遍，防它成为"又一个死列" */
    expect(want, 'portOfUrl 必须能从 test.url 解出打算连的端口（拿不到 ⇒ match 恒为 - = 死列）').toBeGreaterThan(0);
    expect(col(fp, 'match'), `want 与 peer 应当一致：${fp}`).toBe('Y');
    expect(col(fp, 'peer'), 'peer 必须是 127.0.0.1:<端口>（对端才是"谁答的"）').toMatch(/^127\.0\.0\.1:\d+$/);
    expect(col(fp, 'seenBy'), 'seenBy 栏与响应头必须读出同一枚 token').toBe(APP_TOKEN);
    /** ★ `pid` 列的阳性对照（不加这钉它就是下一个"名字像身份、值没人核"的死列 —— 复核 BL-1 同族）：
     *    红样里 `seenBy=-` 时，唯一的硬判据是"对端端口的持有者 pid 等不等于本进程"，所以这一栏必须被算出来且算对。 */
    expect(col(fp, 'pid'), 'pid 必须是本进程 pid（与 lsof 对撞用）').toBe(String(OWN_PID));
  });

  it('①b Express 自己答的 404：带 token、有 content-type ⇒ 既不该被判成"缺身份"也不该点亮 noct', async () => {
    const t = request(makeApp()).get('/never-registered');
    const res = await t;
    const fp = httpEvidence(res, portOfUrl((t as any).url));
    expect(res.status).toBe(404);
    expect(col(fp, 'seenBy'), '应用答的 404 必须带身份 ⇒ 缺了就说明包在路由之后（判据只覆盖一半）').toBe(APP_TOKEN);
    expect(col(fp, 'noct'), `Express 未匹配路由的 404 带 ct=text/html ⇒ noct 不许亮：${fp}`).toBe('-');
    expect(String(res.headers['content-type']), '对照前提：这条形状的 ct 是 html').toContain('text/html');
  });
});

describe('B15 身份列 · 负面对照（不是被测应用答的）＋ 覆盖边界', () => {
  it('② 裸 net.Server 手搓 404 text/plain ⇒ 缺 token（这一条**只**防 seenBy 失锚，不防 markApp 失效）', async () => {
    const srv = net.createServer((sk) => {
      sk.once('data', () => sk.end('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 9\r\n\r\nNot Found'));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const res = await request(`http://127.0.0.1:${port}`).get('/anything');
      const fp = httpEvidence(res, port);
      expect(res.status, '对照样本身要拿到 404').toBe(404);
      expect(col(fp, 'seenBy'), '不是被测 app 答的 ⇒ 必须缺 token（B15 的直接判据）').toBe('-');
      expect(col(fp, 'match'), 'peer 就是它自己 listen 的端口 ⇒ match 应当是 Y（端口列的阳性对照）').toBe('Y');
      /** ★ 复核 IM-4 写进判据：`text/plain` 那一族 ct 存在 ⇒ `noct` **不亮**，所以主判据不是它 */
      expect(col(fp, 'noct'), `第 45 组那族（ct=text/plain）noct 不亮 ⇒ 谁拿 noct 做 triage 就会漏主族，这条不许被"顺手改成 Y"`).toBe('-');
    } finally {
      srv.close();
    }
  });

  it('②b `noct` 只覆盖"无 content-type"那一档：第 45 组的空 404 形状要亮 Y', () => {
    const empty404 = { status: 404, body: {}, text: '', headers: {}, req: { socket: { remoteAddress: '127.0.0.1', remotePort: 1234 } } };
    expect(col(httpEvidence(empty404, 1234), 'noct'), '第 45 组形状（ct=- text=""）必须点亮 noct').toBe('Y');
    expect(col(httpEvidence(empty404, 9999), 'match'), 'want 与 peer 不等 ⇒ match=N（"被别的进程接走"的判据位）').toBe('N');
    expect(col(httpEvidence(empty404), 'match'), '拿不到 want ⇒ -（这栏不参与判断，也不算"排除了端口问题"）').toBe('-');
  });

  it('③ 没有响应的失败（socket hang up / Parse Error）也要占一行，不许被"更早的成功响应"冒充指纹', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(httpErrEvidence(err), '错误列要带 code，便于和 B15 既有形状对上').toContain('ECONNRESET');
    expect(httpErrEvidence(new Error('Parse Error: Expected HTTP/, RTSP/ or ICE/'))).toContain('Parse Error');
  });
});

describe('B15 指纹工具：全仓只此一份实现', () => {
  /**
   * ★ 复核 IM-1：上一版只扫 `function fingerprint(` 一种形状 ⇒ 三处箭头/同名影子全看不见（"有守卫反而更放心"）。
   *   这里扫**本地定义**：`function X(` 与 `const X = ` / `let X =` 两种形状都算，白名单只有工具文件本身。
   */
  it('④ `httpEvidence` / `expectStatus` 的本地定义数 = 0（只有 utils 里那一份实现）', () => {
    const files = walk(resolveServerSrc());
    const defined: string[] = [];
    for (const f of files) {
      if (f.endsWith('shared/__tests__/utils/httpEvidence.ts')) continue;    // 唯一实现
      const src = readFileSync(f, 'utf-8');
      for (const name of ['httpEvidence', 'expectStatus']) {
        if (new RegExp(`(function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*[:=]?)`).test(src)) defined.push(`${f.replace(resolveServerSrc() + '/', '')} :: ${name}`);
      }
    }
    expect(defined, '又长出本地影子实现 ⇒ 指纹口径会漂（本批已把 4 处收成 1 处，见 v3.04 台账）').toEqual([]);
  });

  /**
   * ★ 行为侧的钉子（复核 IM-3 要求：不钉文件布局/换行/引号，只钉"这列有没有被算出来"）。
   *   `port=` 那一列的教训是**名字像身份、值是本端端口** ⇒ 任何身份类列都必须有阳性对照，
   *   所以这里钉"test-setup 必须把 want 与 res 一起交给共用指纹函数"，而不是钉它的代码排版。
   */
  it('⑤ test-setup 必须把"打算连的端口"喂进共用指纹（否则 match 列永远是 - = 又一个死列）', () => {
    const src = readFileSync(path.resolve(__dirname, '../test-setup.ts'), 'utf-8');
    expect(src, '没 import 共用指纹 = 第二份实现又长回来').toMatch(/from '\.\/shared\/__tests__\/utils\/httpEvidence'/);
    expect(src, '没解包 http.Server = seenBy 静默失效（本批真实栽过）').toMatch(/function asExpressApp\(/);
    expect(src, '端口这一侧必须用 portOfUrl(test.url) 而不是 server.address()（响应后已被 close）').toMatch(/portOfUrl\(/);
    /** ★ 故意**不钉参数顺序与末尾实参**（v3.05 里加第 4 个实参时，钉死的写法当场假红 —— 复核 IM-3 说的情形）。
     *    行为侧由 ⑥d/⑥e 保证：喂进去的值确实会出现在指纹串里。 */
    expect(src, 'want 没喂进共用指纹 ⇒ match 恒为 -（死列）').toMatch(/httpEvidence\(\s*r\.res\s*,\s*r\.want\b/);
    /** 复核 I-5：不钉局部变量名/参数顺序（改名与加实参都曾被钉成假红），只钉"统一走 ownerFields"这一处接线 */
    expect(src, 'test-setup 没走 ownerFields ⇒ 采样点散落，守卫测不到真接线').toMatch(/ownerFields\(r\.res,\s*r\.want,\s*seen\)/);
  });
});

/** 只读遍历 `server/src`（不遍历整个仓库：本判据管的是测试侧实现） */
function resolveServerSrc() {
  return path.resolve(__dirname, '..');
}
/** 遍历 `server/src`（本判据管的是测试侧实现，不去扫仓库其他树） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)); }
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('B15 v3.05 现场采样：端口持有者（owner 列）', () => {
  it('⑥a 阳性对照：自己 listen 的端口，owner 必须数出本进程 pid（否则这一栏是装饰）', async () => {
    const srv = net.createServer((sk) => sk.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const owner = portOwner(port);
      expect(owner, 'lsof 没跑起来 / 解析错 ⇒ owner 列会恒为 -，等于没有').not.toBe('-');
      expect(/^(\d+)\(/.exec(owner)?.[1], `owner 的 pid 必须**精确等于**本进程（子串匹配会被 1234 命中 12345）：${owner}`).toBe(String(process.pid));
    } finally { srv.close(); }
  });

  it('⑥b 空态对照：**不在临时端口区间**的固定号上应当没有 LISTEN ⇒ 老实返回 -（不抛错、不猜）', () => {
    /**
     * ⚠️ 复核 B-1 把原来的写法推翻了：上一版这里写"取一个刚关闭的端口"，但 `listen(0)` 是**异步**的
     *   ⇒ `refPort()` 里那个 port 恒为 0 ⇒ 实际测的一直是硬编码 65001，而 **65001 落在 macOS 临时端口区间
     *   (49152–65535) 里** —— 那正是测试自己会占用的号段 ⇒ 我等于**新造了一枚随机红源**（本仓头号病）。
     *   ⇒ 现在显式挑一个区间外、也非产品端口的号（20001），并说明它证的是"空态返回 -"，不是"证明没人劫持"。
     */
    expect(portOwner(20001), '空态必须是 -（拿不到 ≠ 有人持有；也不许反过来当作"已排除"）').toBe('-');
    expect(portOwner(undefined), '没有端口时返回 -，不抛错（真实调用点产出的就是这个 undefined 分支）').toBe('-');
  });

  it('⑥c needsOwner 两侧都要对：带 token 的失败不采样，缺 token 的 4xx 才采样', () => {
    const withToken = { status: 404, headers: { [EXPECT_APP_HEADER]: APP_TOKEN }, req: { socket: { remotePort: 1 } } };
    const bare = { status: 404, headers: {}, req: { socket: { remotePort: 1 } } };
    const ok = { status: 200, headers: {}, req: { socket: { remotePort: 1 } } };
    expect(needsOwner(withToken as any), '应用自己答的 404 不必采样（它是被测应用）').toBe(false);
    expect(needsOwner(bare as any), '缺身份头的 4xx 必须去现场抓一次').toBe(true);
    expect(needsOwner(ok as any), '2xx 不触发（不许给每个成功响应都跑一次外部命令）').toBe(false);
  });


  it('⑥e `mine` 两侧对照：自己正在听的号必须是 Y，无人听的号只能是 N 或 -（不许假装排除）', async () => {
    const srv = net.createServer((sk) => sk.end());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      expect(doWeListen(port), `本进程正在听的端口应当判 Y（实测端口 ${port}）`).toBe('Y');
    } finally { srv.close(); }
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const gone = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const free = doWeListen(gone);
    expect(['N', '-'], `关闭后应当判 N（一个 LISTEN 都没有时给 N），不许抛错；实得 ${free}`).toContain(free);
    expect(doWeListen(undefined), '没有端口 ⇒ -，不抛错').toBe('-');
  });


  it('⑥f ownerFields 用**真响应**走完整链路（I-4：合成对象测不到 res.req.socket 在响应后是否为 null）', async () => {
    const t = request(makeApp()).get('/known');
    const res = await t;
    const want = portOfUrl((t as any).url);
    // 应用自己答的 200 ⇒ 不该采样（两侧都白拿 ⇒ 一次外部命令也不许跑）
    expect(needsOwner(res as any), '健康响应不该触发采样').toBe(false);
    expect(ownerFields(res as any, want), 'needsOwner=false 时必须给空对象').toEqual({});
    // 现在制造一个"缺身份头的 4xx"：拿 ② 那种裸 net.Server 的真响应，走**同一个** ownerFields
    const srv = net.createServer((sk) => sk.once('data', () => sk.end('HTTP/1.1 404 Not Found\r\n\r\n')));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const bad = await request(`http://127.0.0.1:${port}`).get('/x');
      const f = ownerFields(bad as any, port);
      expect(needsOwner(bad as any), '缺 token 的 404 必须触发采样').toBe(true);
      expect(f.owner, `真响应走完整链路必须数出持有者（实测 ${JSON.stringify(f)}）`).toMatch(/^\d+\(/);
      expect(f.mine, '我们自己 listen 的号，mine 应当判 Y（与 owner 配对才说明"是我们的号"）').toBe('Y');
      expect(col(httpEvidence(bad as any, port, f.owner, f.mine), 'owner')).not.toBe('-');
    } finally { srv.close(); }
  });

  it('⑥d owner 真的进了指纹串（否则采了也没人看得见）', () => {
    const bare = { status: 404, headers: {}, req: { socket: { remoteAddress: '127.0.0.1', remotePort: 4321 } } };
    expect(col(httpEvidence(bare as any, 4321, '777(node)'), 'owner'), '指纹里必须有 owner= 这一栏').toBe('777(node)');
    expect(col(httpEvidence(bare as any, 4321), 'owner'), '没采样时是 -，不是 undefined/空').toBe('-');
  });

  /* ── ⑦ 修法的**可行性边界**（v3.08 实测）─────────────────────────────────────
   * B128 已实测：supertest 绑的是**通配**（无 host），本机常驻应用绑 `127.0.0.1:P`，
   * 更具体的一方拿走连接 ⇒ 最省力的修法看起来是"让测试也绑 127.0.0.1"。
   * ★ 本批把"在 `net.Server.prototype.listen` 上补 host"这一版补丁装上，`test-setup.ts` 里
   *   零改动、三格 ⑦ 之外没碰任何东西 —— 结果 ①/①b/⑥f 三格当场红成
   *   `TypeError: Cannot read properties of null (reading 'port')`（栈顶 supertest/lib/test.js:67），
   *   ⇒ 补丁已回退。**这条特定实现走不通**，原因是两条契约撞车：
   *     · supertest 是 `test.js:61` 读 `address()`、`:63` `app.listen(0)`、`:67` **同一拍**再读 `address().port`；
   *     · Node 只要收到真值 host 就把绑定**推到 nextTick**（`listen(0,'127.0.0.1')` 同拍 null、
   *       下一个 tick 才有；`listen(0,'localhost')` 更慢；`listen(0,'')` 反而同步 —— 因为判据是 truthy）。
   * ⚠️ 但**"这个方向整体死了"是过度声明**（v3.08 复核 BLOCKER 打破，已实测两条仍然活着）：
   *   (i) Node 的内部同步绑定原语 `server._listen2(address, port, addressType, backlog)` 可以把
   *       `127.0.0.1` 绑成**同拍可见**，端到端验过 supertest 仍 200；代价是用未公开 API。
   *   (ii) supertest `test.js:61-63` 遇到"已经 listen 过的 server"就**不再自己 listen** ⇒ 先把 server
   *        绑到 127.0.0.1、再把 server（而不是 app）交给 request() 也能成；代价是要动调用点或包一层。
   * ⇒ 这三格的定位因此是：**钉住"补 host 的那条最省力路径不成立"以及"什么形状才可能成"**，
   *   不是宣称 B15 无法修。⑦b 同时是一条**会随 Node 行为失效**的钉子（哪天 IP 字面量不再被推到
   *   nextTick，它会红 ⇒ 那时普通 listen 路线可以重开）；标题里写清楚，免得变成莫名红。
   * ⚠️ 一处已知残余风险（复核点出）：⑦b 依赖"对未 listening 的 server 调 close() 会取消那次待绑定"
   *   （实测：无 error 事件、40/80ms 后 address() 仍是 null）⇒ 若哪天 close 不再取消，这格会
   *   **泄漏一个还活着的 127.0.0.1 监听器**，正是 B15 记录的那种隐患 ⇒ 改动此格时要一并检查。
   */
  const bindWith = (listen: any, args: any[]): { addr: string | null; sync: boolean } => {
    const srv = net.createServer(() => { /* 不需要真的应答，本组只看绑定形状 */ });
    try {
      listen.apply(srv, args);
      const a = srv.address();
      return { addr: a === null ? null : typeof a === 'string' ? a : String(a.address), sync: a !== null };
    } finally {
      srv.close();
    }
  };
  /** ⑦a/⑦b 要记的是**操作系统/Node 的原生行为**，与本仓补丁无关 ⇒ 绕开补丁用原始 listen */
  const RAW_LISTEN = (globalThis as any).__b15RawListen;
  const JOURNAL = (globalThis as any).__b15ListenJournal as
    | { loopback: number; passthrough: number; noPrimitive: number; failed: number; last: string[] } | undefined;
  /** 拨一发真请求，只回"谁答的"（拿 `who` 头；连不上回 `ERR:<code>`，不许静默） */
  const whoAnswered = (port: number): Promise<string> => new Promise((res) => {
    http.get({ host: '127.0.0.1', port, path: '/x' }, (r) => {
      r.resume();                                   // 不读完会让 end 不触发
      res(String(r.headers.who ?? '-NO-WHO-HEADER'));
    }).on('error', (e: any) => res(`ERR:${e.code ?? e.message}`));
  });

  it('⑦a 暴露面（Node 原生形状）：无 host 的 listen(0) 同步绑上，但绑的是**通配** ⇒ 可被 127.0.0.1 的具体绑定挤掉', () => {
    const r = bindWith(RAW_LISTEN, [0]);
    expect(r.sync, '原生 listen(0) 之后同一拍必须能读到 address()（supertest 就是这么用的）').toBe(true);
    expect(['::', '0.0.0.0']).toContain(r.addr);
  });

  it('⑦b 死路证明（原生形状）：给 host 的 listen 同一拍读不到地址 ⇒ 修法不能走公开 API（B130）', () => {
    const r = bindWith(RAW_LISTEN, [0, '127.0.0.1']);
    expect(r.addr, '本应 null（Node 把带 host 的绑定推到 nextTick）⇒ 若哪天不再是 null，普通 listen 路线可重开').toBeNull();
    expect(r.sync).toBe(false);
  });

  it('⑦c 活路之一：等 listening 事件之后再取端口，才能安全地绑到 127.0.0.1', async () => {
    const srv = net.createServer(() => { /* 同上 */ });
    try {
      await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));   // ★ 带回调/等事件
      const a = srv.address() as net.AddressInfo;
      expect(a.address).toBe('127.0.0.1');
      expect(typeof a.port).toBe('number');
    } finally {
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });

  /* ── ⑦d/⑦e/⑦f：本批**实际采用的修法**（`test-setup.ts` 末段）自己的钉子 ──────────
   * 形状：无 host 的 `listen(port)` ⇒ 改走 Node 的同步绑定原语
   *   `_listen2('127.0.0.1', port, 4, backlog)` ⇒ **同一拍可读**（不破坏 supertest `:67`）
   *   且**绑在具体回环地址**上（不再吃"通配 vs 具体"的抢占规则）。
   * ★ 牙的验证方式（v3.09：四次突变全部在**最终文件**上重跑过，3 文件合跑共 37 例，每次还原核 shasum）：
   *   M1「接管条件改成恒 false」⇒ **3 failed | 34 passed (37)**，红的**恰好是 ⑦d/⑦e/⑦f 三格**
   *     ⇒ 这三格真在咬补丁；⑦a/⑦b/⑦c/⑦h 不受影响（它们记的是 Node/内核行为，与实现无关 —— 这正是分开写的原因）。
   *   M3「整块补丁不装」（闩条件写死 false）⇒ **7 failed | 30 passed (37)**，红 ⑦a/⑦b/⑦d/⑦e/⑦f/⑦g/⑦h
   *     ⇒ "尺本身没了"也会响（RAW/记账/globalThis 上的标记都不存在了），不会静默变绿。
   *   M2「拆掉幂等闩」⇒ **37 passed (37)、0 红** ⇒ **⑦g 的"防二次包裹"那一半至今没咬过人**，
   *     它是防御性钉子，引用时不许写成"已验证有效"。
   *   M4「把 ⑦h 的 ② 换成具体地址绑定」⇒ **1 failed | 20 passed (21)**（单文件），红 ⑦h、原因
   *     `listen EADDRINUSE: address already in use 127.0.0.1:61150` ⇒ ⑦h 量的确实是"通配 vs 具体"这条轴。
   *   ⚠️ M4 的第一版写法把 `// MUT` 加在了 `new Promise(...)` 的收尾之前 ⇒ 吞掉了 `});` ⇒ 文件**编译不过**，
   *     vitest 报的是 `Failed Suites` + `Tests 16 passed (16)`（看着像"只红了一条/甚至像全绿"）。
   *     这是本项目**第三次**栽在"突变本身坏了" ⇒ 突变脚本现在必须先检 `Transform failed|Failed Suites` 再读数。
   * ⚠️ 依赖未公开 API 这件事登记在 §9 B130；`_listen2` 一旦改名/改签名，⑦f 会红（不会静默失效）。
   */
  it('⑦d 补丁生效形状：无 host 的 listen(0) 同一拍就读到 127.0.0.1（同步 ⇒ 不弄坏 supertest）', () => {
    const r = bindWith((net.Server.prototype as any).listen, [0]);
    expect(r.sync, '补丁必须在保住同步可见的前提下改掉地址，否则 supertest 会红').toBe(true);
    expect(r.addr, '还是通配 ⇒ 补丁没装上，B15 那一族红会继续随机出现').toBe('127.0.0.1');
  });

  it('⑦e 真链路：supertest 自己创建的那个 server 绑在 127.0.0.1，且应答确实出自被测 app', async () => {
    expect(JOURNAL, 'test-setup 的记账没挂上 ⇒ 这一格无从判定（不是"没问题"，是"尺瞎了"）').toBeTruthy();
    const before = JOURNAL!.loopback;
    const t = request(makeApp()).get('/known');
    const res = await t;
    expect(res.status).toBe(200);
    expect((res.headers as Record<string, string | undefined>)[EXPECT_APP_HEADER],
      `身份头缺失 ⇒ 这一枪不是我们自己的 server 答的：${httpEvidence(res, portOfUrl((t as any).url))}`).toBe(APP_TOKEN);
    expect(JOURNAL!.loopback, '这次请求没走被打补丁的绑定路径 ⇒ 钉子抓不到它').toBeGreaterThan(before);
    // ★ **逐 server** 断言（不看全局顺序，防"别的绑定插进来也把 last 变成 127.0.0.1"）：
    //   补丁给每个接管过的 server 盖了 __b15Bound，这里要求它正是**本次这个** server、且号一致。
    const stamped = (t as any)._server?.__b15Bound as string | undefined;
    expect(stamped, '_server 上没有 __b15Bound ⇒ supertest 的 server 没走接管路径').toBeTruthy();
    expect(stamped!.split(':')[0], '绑回通配/别的地址 ⇒ 抢占风险回来了').toBe('127.0.0.1');
    expect(Number(stamped!.split(':')[1]), '盖的号与实际拨出去的号不是同一个').toBe(portOfUrl((t as any).url));
  });

  it('⑦f 三个失效计数器必须为 0：内部 API 变了不许静默退回旧行为', () => {
    expect(JOURNAL, '记账没挂上').toBeTruthy();
    expect(JOURNAL!.noPrimitive, `noPrimitive>0 ⇒ _listen2 不在了（Node 版本变更），修法已**静默失效**（§9 B130）`).toBe(0);
    expect(JOURNAL!.failed, `failed>0 ⇒ 接管过但没真绑上 127.0.0.1，修法不可信`).toBe(0);
    expect(JOURNAL!.loopback, '跑到这里应当已经绑过很多次；0 ⇒ 补丁一次都没生效').toBeGreaterThan(0);
  });

  it('⑦g 幂等闩：一个进程里只许包裹一次，且 __b15RawListen 必须是**未被包裹**的 Node 原生 listen', () => {
    // 为什么需要这格：prototype 是**进程共享**的，而 pool:'forks' 下 setup 文件会随每个测试文件重跑。
    // 不设闩 ⇒ 第二次包裹会把"上一层包裹"当成 RAW 存下来 ⇒ ⑦a/⑦b（记原生行为）从第二个文件起变红
    //          = 亲手再造一枚"按文件顺序抖动"的红，正是本批要消灭的东西。
    expect((globalThis as any).__b15ListenPatched, '补丁没装上').toBe(true);
    // ⚠️ 下面这行**不是**判据（v3.09 复核 MN-4）：双包时 RAW=wrapper#1、prototype.listen=wrapper#2，
    //    两者本来就"不相等" ⇒ 恒绿。真正咬人的是第三行（双包时 RAW 会绑成 127.0.0.1 ⇒ 那行才红）。
    expect(RAW_LISTEN, '这行只是把"RAW 与当前 prototype"的关系写下来备查，双包时它也成立 ⇒ 别引用成本格的判据').not.toBe((net.Server.prototype as any).listen);
    expect(bindWith(RAW_LISTEN, [0]).addr, 'RAW 已经不是原生行为（等于双包）⇒ 闩失效').not.toBe('127.0.0.1');
  });

  /* ── ⑦h：补丁那句因果陈述本身（v3.09 新增，三读缺一不可）────────────────────────
   * 整条修法的依据只有一句：「把监听器从**通配**挪到 **127.0.0.1**，就从"同号绑得上、连接归更具体的
   * 那一方"变成"同号根本绑不上、当场报错"」。此前这句话**只活在一个临时脚本臂里**
   * （`node scripts/b15-port-collision-repro.mjs --preempt`），而门禁不跑它
   *   ⇒ 若哪天内核/Node 改了这条规则，⑦d/⑦e/⑦f 会**照样全绿**（它们只看我们绑成了什么地址），
   *     红却回来了。这一格补的就是这个漏：它钉的是**修法的前提**，不是修法装了没有。
   * 三条读数（同一个号 P、三种绑法）：
   *   ① 补丁那条原语 `_listen2('127.0.0.1', P, 4, 511)` ⇒ 必须 **EADDRINUSE**（撞号是响亮的）；
   *   ② 改前的形状（原生无 host 的 `listen(P)`）压在**同一个号**上 ⇒ 绑得上、但答的是外来者（静默 = 红成因）；
   *   ③ 对照：没人占的号用 ② 同一形状 ⇒ 答的是我们自己（证明 ② 不是这格自己造出来的）。
   * ⚠️ 两条写法纪律（v3.09 复核 MN-1/MN-2 之后改的，别改回去）：
   *   · **不许"绑 0 拿到号 → close → 再拿这个号去 bind"**：那是 TOCTOU，而且赌的恰好就是"本机临时端口
   *     被别的进程抢走"这件事（= B15 本身）。现在 `foreign` 直接 `listen(0,'127.0.0.1')` 并**一直听着**，
   *     P 取的是它自己在听的那个号；对照用的号也一样"就地要、就地用"。
   *   · 三个 server 全在 finally 里收（`closeIfOpen`）⇒ 失败路径上也不许留活监听器，那正是 B15 记过的隐患。
   */
  const closeIfOpen = (s: any): Promise<void> => new Promise((res) => {
    if (!s.listening && !s._handle) return res();          // 从没绑上 ⇒ 没有要收的东西（不算吞异常）
    s.once('error', () => res());                          // 收尾阶段的错误不参与判定
    try { s.close(() => res()); } catch { res(); }
  });

  it('⑦h 修法的前提：具体地址撞号会**响亮报错**，通配同号才会"静默被接走" ⇒ 绑回环是把风险换成错误', async () => {
    const foreign = http.createServer((_q, r) => { r.writeHead(200, { who: 'FOREIGN-on-127.0.0.1' }); r.end('FROM_FOREIGN'); });
    await new Promise<void>((res, rej) => { foreign.once('error', rej); foreign.listen(0, '127.0.0.1', res); });
    const P = (foreign.address() as net.AddressInfo).port;
    const ours = http.createServer((_q, r) => { r.writeHead(200, { who: 'OURS-specific' }); r.end('OURS'); });
    const wild = http.createServer((_q, r) => { r.writeHead(200, { who: 'OURS-wildcard' }); r.end('OURS'); });
    const ctrl = http.createServer((_q, r) => { r.writeHead(200, { who: 'OURS-control' }); r.end('OURS'); });
    try {
      // ① 与补丁逐字同参的原语调用 ⇒ 撞号必须报错
      const code = await new Promise<string>((res) => {
        ours.once('error', (e: any) => res(String(e.code)));
        try { (ours as any)._listen2('127.0.0.1', P, 4, 511); } catch (e: any) { res(String(e.code ?? 'SYNC_THROW')); }
        setTimeout(() => res('NO_ERROR_AT_ALL'), 300);
      });
      expect(code, '①：具体地址撞号必须报错（EADDRINUSE）⇒ 修法把"静默被接走"换成"当场失败"；这条不再成立说明前提变了').toBe('EADDRINUSE');

      // ② 改前的形状：原生无 host 的 listen 压在同一个号 P 上
      await new Promise<void>((res, rej) => { wild.once('error', rej); RAW_LISTEN.call(wild, P, res); });
      expect((wild.address() as net.AddressInfo).address, '②：RAW 无 host 绑出来的应当仍是通配（不是 127.0.0.1）').not.toBe('127.0.0.1');
      expect(await whoAnswered(P), '②：我们绑上了、连接却归更具体的外来者 —— 这正是历批那族随机红的成因').toBe('FOREIGN-on-127.0.0.1');

      // ③ 对照：无人占的号、② 的同一形状 ⇒ 我们自己答
      await new Promise<void>((res, rej) => { ctrl.once('error', rej); RAW_LISTEN.call(ctrl, 0, res); });
      const Q = (ctrl.address() as net.AddressInfo).port;
      expect(await whoAnswered(Q), '③：没有外来持有者时同样的形状由我们自己答 ⇒ 上面那条 ② 不是这格 rigged 出来的').toBe('OURS-control');
    } finally {
      await closeIfOpen(ours); await closeIfOpen(wild); await closeIfOpen(ctrl);
      await closeIfOpen(foreign);
    }
  });
});
