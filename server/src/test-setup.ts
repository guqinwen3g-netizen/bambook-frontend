// Vitest global setup: load env so Prisma sees DATABASE_URL the same way the
// dev server does — .env.local first (local Postgres), .env second (cloud).
import dotenv from 'dotenv';
import path from 'path';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

/* ────────────────────────────────────────────────────────────────────────────
 * §9 **B15** 全局取证：失败时自动打印「本用例最近几次 HTTP 往来的应答指纹」
 *
 * 为什么放全局（2026-09-21，7h 批）：B15 从 2026-09-17 记到 2026-09-21，
 * **连续 7 个全量单轮全红、红集合两两不相交**，而"谁答的那个 404"一直无证据 ——
 * 因为埋点此前只写在 `system-assets/__tests__/route.test.ts` **一个文件里**。
 * 本文件把它做成**全局**：任何测试失败时，自动把该用例最近的 HTTP 往来打出来
 * （vitest 的 stdout 会随全量日志一起**落盘** ⇒ 下次红不必再靠事后猜）。
 *
 * ★ v3.04 补上一直缺的**身份列**（下面 `markApp`）：以前 `seenBy` 恒为 `-`，
 *   因为设计上要求"每个 app 工厂自己写一行 setHeader"，而那一件事从没被执行过。
 *   ⇒ 凡读 **v3.04 之前**的旧日志，`seenBy=-` 都不构成任何证据（那一栏当时根本没装）。
 *
 * ⚠️ 三条纪律：
 *   ① **绝不改变任何测试行为**（只记录，不吞异常、不重试、不改状态码；只多设一个响应头）；
 *   ② 全部包在 try/catch 里 —— 取证工具自己坏了**不许把测试带红**；
 *   ③ 只在**失败**时打印（否则 7000+ 个用例的日志会被淹没）。
 * ──────────────────────────────────────────────────────────────────────────── */
import { afterEach, beforeEach } from 'vitest';
import supertest from 'supertest';
/**
 * ★ 指纹的实现**只有一份**：本文件原先自带一份 `fingerprint()`，与工具里那份同口径不同源
 *   （本项目头号病"多套并行真源"）⇒ v3.04 起 import 共用那份。
 *   守卫 `__tests__/b15EvidenceIdentity.test.ts` 里有一钉扫全仓"本地定义"，防它再长回来。
 */
import {
  APP_TOKEN, EXPECT_APP_HEADER, httpEvidence, httpErrEvidence, ownerFields, portOfUrl,
} from './shared/__tests__/utils/httpEvidence';

const MAX_RECENT = 8;
/** `res` 有值 = 拿到了响应；只有 `err` = **根本没拿到响应**（`socket hang up` / `Parse Error` 那一档） */
type Rec = { method: string; url: string; res?: any; want?: number; err?: unknown };
const recent: Rec[] = [];

/** supertest 传进来的可能是 app 本身，也可能是它包装出的 `http.Server` ⇒ 两种都认，认不出返回 null（不误包）。 */
function asExpressApp(candidate: any): any {
  if (!candidate) return null;
  if (typeof candidate.handle === 'function') return candidate;              // 直接拿到 app
  const listeners = typeof candidate.listeners === 'function' ? candidate.listeners('request') : [];
  for (const l of listeners) {
    if (typeof l === 'function' && typeof l.handle === 'function') return l; // createServer(app) 的 listener 就是 app
  }
  return null;
}

/**
 * ★★ 给被测 app 打身份头（B15 的直接判据：红样缺这枚 token ⇒ 不是这个 app 答的）。
 *
 * ⚠️ **第一次装错、被自己的正面对照抓出来**（`seenBy=-` 连 200 都拿不到）：
 *   supertest 的 `Test` 构造函数里就把 express app 变成了 `http.createServer(app)`
 *   ⇒ `this.app` 是 **`http.Server`**，身上没有 `.handle`；真正的 app 挂在它的 `request` 监听器上
 *   ⇒ 必须先 `asExpressApp` 解包再包 `handle`（这一钉也写进守卫，不许被"简化"掉）。
 *
 * 为什么包 `app.handle` 而不是 `app.use(...)`：`app.use` 是**追加**到路由之后，
 * 已匹配的路由走不到它 ⇒ 只有 404 尾巴带得到头，200/403 一律不带 = 判据只覆盖一半。
 * `app.handle` 是 Express 所有请求的唯一入口 ⇒ 保证"凡经这个实例出去的响应都带身份"。
 *
 * ⚠️ 影响面已量（2026-09-23，独立复核亦复量为 0）：全仓 server 测试对 `res.headers` 做**整体等值**断言 **0 处**。
 */
function markApp(holder: any): void {
  try {
    const app = asExpressApp(holder);
    if (!app || app.__b15marked) return;
    app.__b15marked = true;
    const orig = app.handle.bind(app);
    app.handle = function (req: any, res: any, next: any) {
      try {
        if (res && !res.headersSent) res.setHeader(EXPECT_APP_HEADER, APP_TOKEN);
      } catch { /* 取证不许改变行为 */ }
      return orig(req, res, next);
    };
  } catch { /* 不可用时不阻断 */ }
}

try {
  const Test = (supertest as any).Test;
  const origEnd = Test?.prototype?.end;
  if (typeof origEnd === 'function') {
    Test.prototype.end = function patchedEnd(this: any, fn?: any) {
      markApp(this?.app);
      const self = this;
      const wrapped = typeof fn === 'function'
        ? function (this: any, err: any, res: any) {
            try {
              const r = res ?? this?.res;
              const req = r?.req ?? {};
              const entry: Rec = {
                method: String(req.method ?? '?').toUpperCase(),
                // want = supertest **打算**连的端口；不能用 self.server.address()（响应后已 close 成 null，实测）
                url: String(req.path ?? self?.url ?? '?'),
                want: portOfUrl(self?.url),
              };
              if (r && typeof r.status === 'number') entry.res = r;
              else if (err) entry.err = err;                       // ★ 没有响应的失败也占一行
              if (entry.res || entry.err) {
                recent.push(entry);
                if (recent.length > MAX_RECENT) recent.shift();
              }
            } catch { /* 取证失败不影响测试 */ }
            return fn.call(this, err, res);
          }
        : fn;
      return origEnd.call(this, wrapped);
    };
  }
} catch { /* 取证不可用时不阻断 */ }

beforeEach(() => { recent.length = 0; });

afterEach((ctx: any) => {
  try {
    const state = ctx?.task?.result?.state;
    if (state !== 'fail' || recent.length === 0) return;
    const seen = new Set<number>();   // ★ 一次打印内按端口去重：外部命令最多跑一次（复核 I-1：同步阻塞 ×8 会顶穿 hookTimeout）
    // M-4：逐条包 try/catch —— 一条坏不许把同批 8 行证据一起吞掉（那正是本批命名的「静默丢证据」）
    const lines = recent.map((r, i) => {
      // ★ 现场采样（只在「缺身份头的失败档位」这条罕见路径上调）：临时端口跑完就没了，事后补不回来。
      //   ⚠️ `owner` 只说明"这一秒谁持有该端口"，不等于"它就是答我的那个"——定罪要另外的证据。
      // 采样统一走 `ownerFields`（守卫 ⑥f 用**真响应**测它）；seen 让一次打印里同一个号只查一次外部命令。
      const f = r.res ? ownerFields(r.res, r.want, seen) : {};
      return `  [${i}] ${r.method} ${r.url} :: `
        + (r.res ? httpEvidence(r.res, r.want, f.owner, f.mine) : `${httpErrEvidence(r.err)} —— 这一条**没有响应**，不是应答指纹，别当判据用`);
    });
    // 打到 stdout ⇒ 随全量日志落盘（D48）
    console.log(`\n[B15 取证] 本用例最近 ${recent.length} 次 HTTP 往来（谁答的？① seenBy 是否等于 ${APP_TOKEN}（缺 = 不是被测应用答的）② mine（本进程此刻是否真的在听这个号）③ owner（打印那一刻该号 LISTEN 持有者；短横 = 没人听、err = lsof 不可用，两者都不许当排除））：\n${lines.join('\n')}\n`);
  } catch (e) { /* 取证失败不影响测试，但**要说得出它失败了** */
    try { console.log(`\n[B15 取证] 打印取证行时自身抛错（取证瞎了，不等于本轮没问题）：${(e as Error)?.message}`); } catch { /* 尽力 */ }
  }
});


/* ────────────────────────────────────────────────────────────────────────────
 * B15 **消因**（v3.09）：测试的监听器绑**具体回环地址**，且保住 supertest 依赖的"同一拍可读"
 *
 * 机制（§9 B128；一条命令可重跑：`node scripts/b15-port-collision-repro.mjs --preempt`）：
 *   supertest `lib/test.js:61/63/67` 是 `app.listen(0)`（**不带 host**）之后**同一拍**读
 *   `address().port`。不带 host ⇒ 绑**通配**（实测 `address:"::"`）。本机常驻应用（Electron /
 *   Qoder CN / sandbox-cli）绑 `127.0.0.1:P`。BSD/macOS：**通配与具体不冲突**（同号两边都绑得上），
 *   但**发往 127.0.0.1:P 的连接归更具体的一方** ⇒ 我们 bind 成功、handler 一次都不跑
 *   ⇒ 历批那族 `404 空 body` / `401 AUTH_REQUIRED` / `No mapping` / `ECONNRESET` 随机红（编号 44–54）。
 *
 * 公开 API 走不通（v3.08 实测）：`listen(port,'127.0.0.1')` 被 Node 推到 nextTick ⇒ 同一拍读到 null
 *   ⇒ supertest 全线 `Cannot read properties of null`。故这里用 Node 自己的**同步绑定原语**
 *   `_listen2(address, port, addressType, backlog)`（实测：同拍可读、`listening` 照发、`close()` 照常）。
 *
 * ⚠️ 六条纪律（都是复核打破之后加回来的，别"顺手简化"掉任何一条）：
 *   1. **只接管 `port === 0` 且没给 host、且这个 server 当下没在听** 的调用（= supertest 的唯一形状）。
 *      固定端口的 listen 一律放过：`_listen2` 对"端口被占"是**异步**报 error（现测：同步不抛、随后
 *      `UNCAUGHT_EXCEPTION: EADDRINUSE`），而 port 0 由内核挑空闲号、实测 400 次接管 0 次撞号
 *      ⇒ 把接管面限定在 0，就把这条风险整个摘掉。
 *   1b. **已在听的 server 原样放过**（v3.09 复核 MINOR-3）：`ERR_SERVER_ALREADY_LISTEN` 这个**同步响亮**
 *      的检查在公开的 `listen()` 里、不在 `_listen2` 里（现测：原生再 listen 一次抛
 *      `ERR_SERVER_ALREADY_LISTEN`，直接调 `_listen2` **不抛**、端口还是原来那个）
 *      ⇒ 不放过就等于把"重复 listen"这条真 bug 从当场报错改成静默吞掉。
 *   2. **幂等**：`net.Server.prototype` 是**进程共享**的，而 `pool:'forks'` 下 setup 文件会随每个测试文件
 *      重跑 ⇒ 不设闩就会二次包裹，`__b15RawListen` 变成"上一层包裹"而非 Node 原生 ⇒
 *      ⑦a/⑦b（记原生行为的那两格）会在"第二个文件起"变红 = **亲手再造一枚按文件顺序抖动的红**。
 *   3. 对象形状用**白名单**（只认 `port`/`backlog`）而不是黑名单：显式给了 host/path/handle/fd/signal/
 *      exclusive/ipv6Only 的放过只是基本盘，**哪天 Node 新增一个 option，白名单是"放过"、黑名单是"静默吞掉"**
 *      （`_listen2` 的真实签名第 6 参是 flags 不是 signal，硬套就会把 AbortSignal/exclusive 吞掉）。
 *   4. **失效必响**：`loopback / noPrimitive / failed` 三个计数交给 ⑦f 断言 ——
 *      `_listen2` 哪天改名或改签名，这格会红，不会让我们以为"还修着"。
 *   5. 这**不是**门禁容错：不改断言、不吞异常、不重试请求 —— 只是别再把请求发到一个我们并不独占的地址。
 * ──────────────────────────────────────────────────────────────────────────── */
import net from 'node:net';

type B15ListenJournal = {
  loopback: number; passthrough: number; noPrimitive: number; failed: number; last: string[];
};

if (!(globalThis as any).__b15ListenPatched) {
  const JOURNAL: B15ListenJournal = { loopback: 0, passthrough: 0, noPrimitive: 0, failed: 0, last: [] };
  (globalThis as any).__b15ListenJournal = JOURNAL;

  const RAW_LISTEN = (net.Server.prototype as any).listen;
  (globalThis as any).__b15RawListen = RAW_LISTEN;      // ⑦a/⑦b 用它记 Node 原生行为，必须是**未被包裹**的那一个

  /** 只接管"port 是 0、形状干净"这一种（= supertest 用的那个）；其余一律放过（纪律 1 与 3） */
  function b15TakesOver(args: unknown[]): boolean {
    const first = args[0];
    if (typeof first === 'number') {
      return first === 0 && (args.length === 1 || (args.length === 2 && typeof args[1] === 'function'));
    }
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const o = first as Record<string, unknown>;
      // ★ 白名单（纪律 3）：Node 哪天给 listen options 加新字段，这里默认是**放过**而不是静默吞掉
      const ALLOWED = new Set(['port', 'backlog']);
      return o.port === 0 && Object.keys(o).every((k) => ALLOWED.has(k));
    }
    return false;
  }

  try {
    (net.Server.prototype as any).listen = function b15LoopbackListen(this: any, ...args: any[]) {
      // 纪律 1b：已在听的 server 原样交给原生 listen ⇒ 保住 ERR_SERVER_ALREADY_LISTEN 那次响亮报错
      if (this._handle || this.listening || !b15TakesOver(args)) {
        JOURNAL.passthrough++;
        return RAW_LISTEN.apply(this, args);
      }
      if (typeof this._listen2 !== 'function') {
        JOURNAL.noPrimitive++;                                // 内部 API 变了 ⇒ 退回原行为，但⑦f 会红
        return RAW_LISTEN.apply(this, args);
      }
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
      const opts = typeof args[0] === 'number' ? {} : { ...(args[0] as object) };
      if (cb) this.once('listening', cb);
      try {
        this._listen2('127.0.0.1', 0, 4, Number((opts as any).backlog) || 511);
      } catch (e) {
        if (cb) this.removeListener('listening', cb);         // 退回时别让 cb 挂两次
        JOURNAL.failed++;
        return RAW_LISTEN.apply(this, args);
      }
      const a = this.address();
      if (!a || a.address !== '127.0.0.1') {                  // 纪律 4：没真绑上就不许记成"已修"
        JOURNAL.failed++;
        return this;
      }
      JOURNAL.loopback++;
      this.__b15Bound = '127.0.0.1:' + a.port;                // ⑦e 用它做**逐 server**断言（不看全局顺序）
      if (JOURNAL.last.length >= 20) JOURNAL.last.shift();
      JOURNAL.last.push(this.__b15Bound);
      return this;
    };
    (globalThis as any).__b15ListenPatched = true;            // 纪律 2 的闩
  } catch {
    (globalThis as any).__b15ListenPatched = 'broken';        // 连 prototype 都拿不到 ⇒ ⑦f 会红
  }
}
