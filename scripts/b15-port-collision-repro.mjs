#!/usr/bin/env node
/**
 * B15 复现器（v3.06，2026-09-23）—— 一条命令证明「全量门禁的随机红」不是本仓代码造成的
 *
 * 做什么：把 `request(app).get('/x')` 这个最小的 supertest 形状跑 N 次。被测 app 只有一个路由、
 * **没有任何鉴权中间件**。然后看有没有"异常应答"：
 *   · 404 空 body / 404 `{"error":"not_found"}` —— 这个 app 根本不可能答出这种话
 *   · 401 `{"error":{"code":"AUTH_REQUIRED",...}}` —— 它没有鉴权层，答不出 401
 *   · `socket hang up` / `Unexpected token 'N', "No mapping"` —— 连响应都不是 HTTP
 * 每抓到一条，就用 `lsof` 问一句「我拨的这个号，此刻是谁在听」。
 *
 * 实测（本机，2026-09-23 22:54，N=6000 一轮 / N=4000 两轮）：
 *   · 异常率约 8–9 / 6000（≈0.15%），与全量门禁"每轮红 1–3 个文件"量级一致；
 *   · **抓到异常应答的 8 条，拨的端口 `lsof` 全部指向别的进程**（`54588/33644/58409/70353/54561(Electron)`、
 *     `58230(Qoder CN)`），**没有一条是本进程**；
 *   · 反过来，正常应答（200 + 我们自己的 body）时不会落在这些号上。
 * ⇒ 结论（★ v3.07 更新：机制已由下面的 `--preempt` 臂**确定性复现**，不再依赖概率）：
 *   ① 这些红**与本仓产品代码、数据库、测试互相污染无关** —— 本脚本连数据库都不连、也没跑套件；
 *   ② 真正原因：supertest 走 `app.listen(0)`（**不带 host ⇒ 通配绑定**，实测 address 是 `::`），
 *      而本机常驻应用绑 `127.0.0.1:P`。BSD/macOS 下**通配与具体不冲突**（同号两边都绑得上），
 *      但**发往 127.0.0.1:P 的连接归更具体的一方** ⇒ 我们 bind 成功、handler 一次都不跑。
 *      ★ 这一条**推翻**本文件 v3.06 版头那句"再绑同号会 EADDRINUSE ⇒ 常驻者接不到我们的请求"：
 *        那次实测的是"我们当第二个**具体**绑定者"，通配绑定并不冲突（`--preempt` 现测可复跑）。
 *   ③ ⇒ 修法（v3.09 已落地在测试基座）：让测试也绑**具体回环地址** ⇒ 通配消失就没得抢。
 *      ⚠️ 但**不是** `listen(port,'127.0.0.1')` —— v3.08 实测那条走不通（Node 把带 host 的绑定推到
 *      nextTick，而 supertest 同一拍就要读 `address().port`）⇒ 真身走内部同步原语
 *      `_listen2('127.0.0.1', 0, 4, backlog)`，见 `server/src/test-setup.ts` 末段与 §9 B130。
 *      旁证：本文件 `--hold` 臂（显式 127.0.0.1）10000 次 **0 异常**，默认臂（通配）10000 次 6 异常。
 *
 * ★ 臂清单（`--patched` 是 v3.09 为 A/B 自己加的）：默认（通配跑 N 次） / `--patched`（复刻基座修法）
 *   / `--preempt`（**确定性**复现抢占，不靠概率） / `--hold`（异常时先不关 server，分离两种排序）
 *   / `--journal`（逐条记账）。
 *
 * ⚠️ 三条使用纪律：
 *   1. **只从仓根跑**（`node scripts/b15-port-collision-repro.mjs 6000`）—— 它 require 的是 `server/node_modules`
 *      里的 express/supertest，脚本本身不读任何业务代码；
 *   2. 它是**诊断器不是门禁**：退出码恒 0（抓到异常也返回 0），免得有人把它挂进门禁后
 *      变成"环境越忙、门禁越红"的第二条 B15；
 *   3. 它证的是"红来自进程外"，**不证**具体哪个进程在抢 —— 别拿它的输出去指认某台应用（v3.05 复核 I-6
 *      那条时序教训在这里同样成立：lsof 读的是**打印那一刻**的归属）。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const require = createRequire(resolve(process.cwd(), 'server/package.json'));
const express = require('express');
const request = require('supertest');

const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? '6000');
const app = express();
// ★ 计数器：证明"这一枪到底有没有进过我们自己的 app"（不靠身份头推断）
let handlerHits = 0;
app.get('/x', (_q, r) => { handlerHits++; r.json({ ok: 1 }); });

/* ────────────────────────────────────────────────────────────────────────────
 * ★ --patched 臂（v3.09）：复刻 `server/src/test-setup.ts` 末段那个修法，再跑默认那一臂
 *   —— 用途是**A/B 自己**：同一台机器、同一形状，三段连着跑（未打 → 打 → **未打作配对对照**）。
 *   ⚠️ v3.09 实跑读数（8000/段）：**11 → 0 → 0** —— 第三段没复现 ⇒ **这一臂给不出效果量**
 *     （对照臂本来就是 0 的时候，"补丁把它降到 0"这句话不可证伪）。它只给两句：
 *     `patchedBinds === N`（接管真的走到了每一次绑定）与 `handlerHits === N`（这一枪真的进了我们的 app）。
 *     机制级的确定性证据在 `--preempt` 臂，以及门禁里的守卫格 ⑦h（`b15EvidenceIdentity.test.ts`）。
 *   ⚠️ 这只是**复刻**，不等于被测基座已生效（基座那份才是真身）；接管条件与基座**逐字同窄**：
 *     只认 `listen(0)` / `{port:0, 且只有 backlog}`、且 server 当下没在听 —— 固定端口一律放过，
 *     否则 `_listen2` 的"号被占是异步报错"会让探针自己造出红（那就是第二条 B15 了）。
 * ──────────────────────────────────────────────────────────────────────────── */
const PATCHED = process.argv.includes('--patched') && !process.argv.includes('--preempt');
let patchedBinds = 0;
if (PATCHED) {
  const rawListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(...args) {
    const first = args[0];
    const takes = (typeof first === 'number' && first === 0 && (args.length === 1 || typeof args[1] === 'function'))
      || (first && typeof first === 'object' && first.port === 0 && Object.keys(first).every((k) => k === 'port' || k === 'backlog'));
    if (!takes || this._handle || this.listening || typeof this._listen2 !== 'function') return rawListen.apply(this, args);
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    try {
      if (cb) this.once('listening', cb);
      this._listen2('127.0.0.1', 0, 4, Number(first && first.backlog) || 511);
      patchedBinds++;
      return this;
    } catch (e) {
      if (cb) this.removeListener('listening', cb);
      return rawListen.apply(this, args);
    }
  };
}

/** 该端口此刻谁在 LISTEN（`pid(命令名)`，多个用 + 连）；'-'=没人，'err'=lsof 不可用 */
function owners(port) {
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
    const rows = [];
    for (const line of out.split('\n').filter(Boolean)) {
      if (line[0] === 'p') rows.push({ pid: line.slice(1), cmd: '?' });
      else if (line[0] === 'c' && rows.length) rows[rows.length - 1].cmd = line.slice(1);
    }
    return rows.map((r) => `${r.pid}(${r.cmd})`).join('+') || '-';
  } catch (e) {
    return e && e.status === 1 ? '-' : 'err';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ★ --journal 模式（v3.07 第二格）：把"我们什么时候绑上、什么时候关掉"记成流水账
 * 为什么要它：默认模式只能在响应**之后**查 lsof，分不清两种排序（B128 的 ①/②）。
 * 但"我们的监听器在响应到达时**还在不在**"这件事，我们自己就知道 —— 只要给
 * `http.createServer(...).listen/close` 打时间戳。于是异常样本可以直接判：
 *   closeAt < respAt  ⇒ ① 我们早就没在听了（这一枪拨向了一个已经不属于自己的号）
 *   closeAt > respAt  ⇒ ② 我们当时**正在听**，应答者却是别人 ⇒ 号被共享/分流，或连接被改写
 * ⚠️ 两条自反提醒（都是这台机器上实测到的，别把探针自己的动静当成 B15）：
 *   · --hold 那一臂在大量迭代后自己造出过 **126 条 `connect EADDRNOTAVAIL`**（临时端口被探针自己的
 *     churn 打满）⇒ 那是**探针造成的**，不是 B15；本模式每轮都 await close，就是为了少制造这种噪声。
 *   · 实测差分：`--hold`（调用方自己 listen 并把 server 交给 supertest）跑 10000 次 **0 条真异常**，
 *     而默认臂（supertest 自己 `app.listen(0)`）10000 次 **6 条、且 6/6 落在外来进程正在听的号上**
 *     ⇒ 触发条件与"谁创建这个监听器"有关，这一格本身就是一条读数。
 * ──────────────────────────────────────────────────────────────────────────── */
if (process.argv.includes('--journal')) {
  const http = require('http');
  const journal = new Map();                 // port -> {bindAt, closeAt}
  const origCreate = http.createServer;
  http.createServer = function patched(...args) {
    const srv = origCreate.apply(this, args);
    const origListen = srv.listen.bind(srv);
    const origClose = srv.close.bind(srv);
    srv.listen = function (...la) {
      const cb = () => {
        const a = srv.address();
        if (a && typeof a.port === 'number') journal.set(a.port, { bindAt: Date.now(), closeAt: 0 });
      };
      srv.once('listening', cb);
      return origListen(...la);
    };
    srv.close = function (...ca) {
      const a = srv.address();
      if (a && typeof a.port === 'number') {
        const j = journal.get(a.port);
        if (j && !j.closeAt) j.closeAt = Date.now();
      }
      return origClose(...ca);
    };
    return srv;
  };

  let jb = 0;
  for (let i = 0; i < N; i++) {
    const hitsBefore = handlerHits;
    const t = request(app).get('/x');
    let res = null; let err = null;
    try { res = await t; } catch (e) { err = e; }
    const at = Date.now();
    const anomaly = err ? true : (res.status !== 200 || !res.body || res.body.ok !== 1);
    if (!anomaly) continue;
    jb++;
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(t.url || '')?.[1] ?? '0');
    const j = journal.get(port);
    console.log(JSON.stringify({
      ev: 'JOURNAL_ANOMALY', i, port,
      weBoundIt: !!j, bindAt: j?.bindAt ?? null, closeAt: j?.closeAt ?? null, anomalySeenAt: at,
      // ★ 两轴判据：③ 这个号从来不是我们的（weBoundIt=false）
      //             ② 号是我们的、我们也在听，但 handler 没收到这一枪（weBoundIt=true 且 handler=false）
      //             ① 号曾经是我们的、请求发出时已 close（handler=false 且 closeAt 早于本次请求）
      verdictAxis: !j ? 'NEVER_OURS(=>③ 号从来不是我们的)'
        : (handlerHits > hitsBefore ? 'OUR_HANDLER_RAN(=> 是我们自己答错的，另案)'
          : 'OURS_BUT_HANDLER_DID_NOT_RUN(=>② 共享/被改写)'),
      ourHandlerSawThisRequest: handlerHits > hitsBefore,
      ownersNow: owners(port),
      status: res?.status ?? null, body: res?.body ?? null, msg: err ? String(err.message).slice(0, 45) : null,
    }));
  }
  console.log(JSON.stringify({
    mode: '--journal', iterations: N, anomalies: jb, handlerHitsTotal: handlerHits,
    // ★ 自检：journal 为空 ⇒ 说明 supertest 早就把 createServer 引用抓走了、我的钩子没生效，
    //   此时所有 weBoundIt=false 都**不能**当成"号不是我们的"的证据（探针瞎了，不是现象）。
    journalEntries: journal.size, hookWorked: journal.size > 0,
    verdict: jb === 0 ? '本轮 0 异常（不代表不存在）' : `看 verdictAxis 一栏即可分离 ①/②/③`,
  }));
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ★ --preempt 臂（v3.07，复核 BLOCKER 之后补的**确定性**证据）
 * 前三臂都要"撞运气"（异常率 ~0.1%），而真正的机制其实不需要运气：
 *   supertest 的 `serverAddress()` 走的是 **`app.listen(0)` —— 不带 host ⇒ 通配绑定**
 *   （`node_modules/supertest/lib/test.js:60-69`，实测拿到的 address 是 IPv6 `::`）。
 *   而本机那些常驻应用（Electron / Qoder / sandbox-cli）绑的是 **`127.0.0.1:P`**。
 *   BSD/macOS 规则：**具体地址的绑定优先于通配**，且两者**不冲突**（通配可以绑上同一个号）。
 *   ⇒ 只要外来进程先在 `127.0.0.1:P` 上听，我们哪怕成功 bind 了 `*:P`，
 *     发往 `127.0.0.1:P` 的连接也**全归它** —— 我们的 handler 一次都不会跑。
 * 这一臂不靠概率：起一个子进程占住 `127.0.0.1:P`，本进程用**和 supertest 一样的方式**绑同号，
 * 然后发一个请求，看谁答。三条读数缺一不可：
 *   parentBindsSamePortOk=true（通配能绑上 ⇒ "bind 会 EADDRINUSE 所以不可能被接走"这条旧推断是错的）
 *   answeredBy=CHILD         （更具体的绑定拿走了连接）
 *   control=CONTROL_PARENT   （对照：没有外来具体绑定时，是我们自己答 ⇒ 上面那条不是脚本 rigged）
 * ⚠️ 这一臂同时给出了**修法**：让测试也绑具体回环地址（`listen(0, '127.0.0.1')`）就不会被抢占。
 * ──────────────────────────────────────────────────────────────────────────── */
if (process.argv.includes('--preempt')) {
  const http = require('http');
  if (process.argv.includes('--as-child')) {
    const p = Number(process.env.PREEMPT_PORT);
    http.createServer((_q, r) => { r.writeHead(200, { who: 'CHILD-on-127.0.0.1' }); r.end('FROM_CHILD'); })
      .listen(p, '127.0.0.1', () => process.send && process.send({ ready: true }));
    setTimeout(() => process.exit(0), 15000);
  } else {
    const { fork } = require('child_process');
    const P = 61234;
    const hit = (port) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/x' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, answeredBy: r.headers.who || '-', body: b.slice(0, 24) }));
      }).on('error', (e) => resolve({ error: e.code || e.message }));
    });
    const child = fork(process.argv[1], ['--preempt', '--as-child'], { silent: true, env: { ...process.env, PREEMPT_PORT: String(P) } });
    await new Promise((r) => child.once('message', r));
    const bind = await new Promise((resolve) => {
      const s = http.createServer((_q, r) => { r.writeHead(200, { who: 'PARENT-wildcard' }); r.end('FROM_PARENT'); });
      s.once('error', (e) => resolve({ ok: false, code: e.code }));
      s.listen(P, () => resolve({ ok: true, address: s.address().address, family: s.address().family })); // ★ 不带 host，与 supertest 同
    });
    const stolen = await hit(P);
    const free = await new Promise((resolve) => {
      const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => resolve(q)); });
    });
    const control = await new Promise((resolve) => {
      const s = http.createServer((_q, r) => { r.writeHead(200, { who: 'CONTROL_PARENT' }); r.end('FROM_PARENT'); });
      s.listen(free, () => hit(free).then((g) => { s.close(); resolve(g); }));
    });
    child.kill();
    console.log(JSON.stringify({
      ev: 'PREEMPT', port: P, foreignHoldsLoopback: true,
      parentBindsSamePortOk: bind.ok, parentBoundAddress: bind.address ?? null, parentFamily: bind.family ?? null,
      requestToLoopback: stolen, control: control,
      verdict: (bind.ok && stolen.answeredBy === 'CHILD-on-127.0.0.1' && control.answeredBy === 'CONTROL_PARENT')
        ? '机制成立：通配绑定与 127.0.0.1 上的具体绑定不冲突，但连接归**更具体**的一方'
          + ' ⇒ 历批"再绑同号会 EADDRINUSE，所以常驻者接不到"这条推断是错的；修法是让测试也绑 127.0.0.1'
        : '未复现 ⇒ 别拿这条当机制结论',
    }));
    process.exit(0);
  }
}

let bad = 0;
let foreignOwned = 0;

/* ────────────────────────────────────────────────────────────────────────────
 * ★ --hold 模式（v3.07，B128 的决定性一格）
 * 默认模式只能在**响应回来之后**查 lsof —— 那时 supertest 已经把我们的监听器 close 了
 * （v3.05 复核 I-6 那条时序教训），所以"号在别人名下"分不清两种排序：
 *   ① 我们关掉之后，对方把这个号抢去（⇒ 该号从来没被对方在响应时刻持有，红是"拨了个已经不属于自己的号"）
 *   ② 该号从一开始就是**共享绑定**（内核在两个监听者之间分流 ⇒ 同一号也能被对方答）
 * 这一模式自己管 server 生命周期：**异常发生时先不关**，立刻查"我们还在不在监听表里"，
 * 并额外问一句"我们自己的 handler 到底有没有收到过这一枪"（handlerHits 计数器）。
 *   · 异常时 lsof 里有本进程 ⇒ 我们确实还在听 ⇒ 应答者却是别人 ⇒ 只能是 ②（共享/分流）
 *   · 异常时 lsof 里没有本进程 ⇒ 我们的 bind 根本没拿到这个号（或已被摘走）
 *   · handlerHits 没涨 ⇒ 这一枪确实没进过我们的 app（正面证据，不靠身份头推断）
 * ⚠️ 关掉的方式与默认模式不同（这里不 await close），所以"能不能撞上异常"本身也是一个读数：
 *   若本模式跑满 N 次 0 异常 ⇒ 说明触发条件与"谁负责关、关的时候等不等待"有关 ⇒ 也是结论。
 * ──────────────────────────────────────────────────────────────────────────── */
if (process.argv.includes('--hold')) {
  let hitsAtStart = 0;
  let held = 0;
  for (let i = 0; i < N; i++) {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    hitsAtStart = handlerHits;
    let res = null; let err = null;
    try { res = await request(srv).get('/x'); } catch (e) { err = e; }
    const anomaly = err ? true : (res.status !== 200 || !res.body || res.body.ok !== 1);
    if (anomaly) {
      bad++;
      const who = owners(port);                       // ★ 此刻**还没有 close**
      const weAreOwner = who.split('+').some((x) => x.startsWith(`${process.pid}(`));
      if (!weAreOwner && who !== '-' && who !== 'err') foreignOwned++;
      console.log(JSON.stringify({
        ev: 'HELD_ANOMALY', i, port, ownersWhileWeAreStillOpen: who,
        weStillListedAsOwner: weAreOwner, coOwnerCount: who.split('+').filter((x) => x !== '-').length,
        ourHandlerSawThisRequest: handlerHits > hitsAtStart,
        status: res ? res.status : null, body: res ? res.body : null,
        msg: err ? String(err.message).slice(0, 50) : null,
      }));
    }
    srv.close();                                      // 与默认模式一样：不 await
    if (anomaly) held++;
  }
  console.log(JSON.stringify({
    mode: '--hold', iterations: N, anomalies: bad, handlerHitsTotal: handlerHits,
    verdict: bad === 0
      ? '0 异常 ⇒ 触发条件与"谁关、关时是否等待"有关（这本身就是排除掉一种说法的证据）'
      : `有 ${bad} 条异常：看 weStillListedAsOwner / ourHandlerSawThisRequest 两栏即可分离 ①/②`,
  }));
  process.exit(0);
}

for (let i = 0; i < N; i++) {

  let url = '';
  try {
    const test = request(app).get('/x');
    const res = await test;
    url = test.url;
    if (res.status !== 200 || !res.body || res.body.ok !== 1) {
      bad++;
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(url)?.[1] ?? '0');
      const who = owners(port);
      const mine = who.split('+').some((x) => x.startsWith(`${process.pid}(`));
      if (!mine && who !== '-' && who !== 'err') foreignOwned++;
      console.log(JSON.stringify({
        ev: 'ANOMALY', i, port, status: res.status, body: res.body ?? null,
        ct: res.headers['content-type'] ?? '-', powered: res.headers['x-powered-by'] ?? '-',
        dialedPortOwner: who, ownerIsThisProcess: mine,
      }));
    }
  } catch (e) {
    bad++;
    console.log(JSON.stringify({ ev: 'NO_RESPONSE', i, msg: String(e.message).slice(0, 60), code: e.code ?? null }));
  }
}

const rate = N > 0 ? ((bad / N) * 100).toFixed(2) : '0';
console.log(JSON.stringify({
  iterations: N, anomalies: bad, anomalyPct: rate,
  anomaliesOnForeignOwnedPort: foreignOwned,
  patched: PATCHED, patchedBinds,          // ★ --patched 自证：接管次数应当 ≈ N
  handlerHits,                             // 每条异常都该等于"少了一次 handler"
  verdict: bad === 0
    ? '本轮没撞上（不代表不存在：本脚本撞上前也是连续两轮各 9/4000）'
    : (PATCHED
      ? `打了修法仍有 ${bad} 条异常 ⇒ 修法没覆盖全部原因，不许写"已修"`
      : `${bad} 条异常里有 ${foreignOwned} 条拨在了别的进程正在听的号上 ⇒ 应答者不是被测 app`),
}));
