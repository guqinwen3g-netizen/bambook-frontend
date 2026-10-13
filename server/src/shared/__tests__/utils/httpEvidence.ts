/**
 * §9 **B15** 取证工具 —— HTTP 失败响应的「应答指纹」（**判据/工具只此一份**，R2）
 *
 * 为什么要有这个文件：B15（全量套件随机红）从 2026-09-17 记到 2026-09-21，**连续 7 个全量单轮全红、
 * 红集合两两不相交**，而"谁答的那个 404"一直无证据。7f 批第一次有埋点把它打成字面证据：
 *
 * ```
 * B15 取证 DELETE：body={} ct=text/plain; charset=utf-8 server=- allow=- text=Not Found
 * ```
 *
 * 那次埋点写在 `system-assets/__tests__/route.test.ts` **一个文件里**（属"判据活两处"的同型问题）⇒
 * 本文件把它**收成共用一份**，供所有路由类测试 import。
 *
 * ## 已实测排除的候选（2026-09-21 00:4x，逐条有命令）
 * | 候选 | 实测结果 | 结论 |
 * |---|---|---|
 * | **裸 Express 4.22.1 的默认 404** | `ct=text/html` + `<!DOCTYPE html>…<title>Error</title>` | ❌ **不是它**（本仓用 Express 4） |
 * | **沙箱代理 `127.0.0.1:62177`**（环境里设了 `HTTP_PROXY`/`http_proxy`） | 对不可达上游返回 **502** + `upstream connect failed: Connection refused` | ❌ 不是它 |
 * | `127.0.0.1:3210` 的 404 | `ct=text/html` + `X-Powered-By: Express` | ❌ 不是它 |
 * | `127.0.0.1:3211` 的 404 | `ct=application/json` | ❌ 不是它 |
 * | `127.0.0.1:5173` / `:3000`（Vite / dev server） | 未知路径 **200 + text/html**（SPA 回退） | ❌ 不是它 |
 * | `127.0.0.1:1082`（MacPacket 代理） | **405** + `text/html` | ❌ 不是它 |
 * | **本仓 `server/src` 全部代码** | 无任何 `Not Found` 字面量 / 无 `res.type('text/plain')` / 无 `sendStatus(404)` | ❌ 不是它 |
 * | **常驻开发服务 `:8081`**（PID 68014，2026-09-22 v2.46 复量） | 未知写路径 = `404` + `ct=text/html; charset=utf-8` + `powered=Express` + body `Cannot POST /api/…` | ❌ 不是它（也与"测试打到了 :8081"这条假设不符） |
 * | **进程内 Express 对未知写路径**（同版本、同 `express.json()`，2026-09-22 现测） | `404` + `ct=text/html; charset=utf-8` + `powered=Express` + HTML body | ❌ 不是它 ⇒ ★ 这条是**正面对照**：被测应用自己答 404 时**必然**带 `powered=Express`（本仓无人 `disable('x-powered-by')`） |
 *
 * ★★ 由最后一条正面对照得到的**收窄结论**（v2.46，B15 第 25 组）：本轮红点的指纹是
 *   `POST /api/v1/seasons :: status=404 ct=- powered=- text="Not Found"` ——
 *   **三项全不同于"被测应用答的 404"** ⇒ 该 404 **不是**测试里 `makeApp()` 那个实例发的。
 *   ⇒ B15 的方向从"产品代码里某处随机 404"**收窄为**"测试进程的 HTTP 请求被进程外的某个应答者接走"。
 *   ⚠️ 仍然**不是机制结论**：还不知道是谁接走、经由什么路径（本机 socket 层 / 某 agent / 端口复用），
 *   也不解释第 22 组那种"文件级连不上库"。⚠️ 当时写的下一步"给测试 app 打 `X-App-Seen`"**已于 v3.04 作废**（本文件 `:71` 起改由 `test-setup.ts` 统一注入 ⇒ 手写那条路不再需要）；
 *   而**旧日志里的 `seenBy=-` 一律不构成证据**（那一栏当时根本没装）。本文件上面那张"已排除"表是判据的唯一家，别再抄一份。
 *
 * ★★★ 2026-09-22 同日复跑轮（B15 **第四种形状 = 传输层**）：红样不是断言不等，而是
 *   `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/`（`code = HPE_INVALID_CONSTANT`），
 *   抛错方是 **Node 的 HTTP 客户端解析器**。当场做了可复现的等价实验（无库、无外网、几行 node）：
 *   在 ephemeral 端口起 `net.Server` 只回 5 个非 HTTP 字节 `16 03 01 00 10`，同进程 `http.request` 打它
 *   ⇒ 得到**同一句**错误 ⇒ "这条 socket 上收到的字节不是 HTTP 响应"就足以产出该形状。
 *   ⇒ 与第 25 组合读：**两种 HTTP 侧形状都不指向产品代码**；并且"应答者是另一个 Express 应用"这条旧推断
 *   **覆盖不了本形状**（另一个 Express 至少会说 HTTP）。未验证的候选：本机网络扩展/透明代理劫持 loopback、
 *   ephemeral 端口被外部进程连入。★ 本工具能帮上忙的方式不变：**看 `powered` / `seenBy` 两栏 + 落盘整份日志**。
 *
 * ★★★★ 2026-09-22 v2.47 批（B15 **第 27 组**）：**"隔离复跑全绿"这条判别位失效**，两处旧结论就地降级。
 *   现场：全量门禁唯一红是 `seasonRoute.test.ts > 线索转化…`，形状 `Error: Parse Error: Expected HTTP/…`（第四种形状）；
 *   随后**只跑这一个文件**连跑 13 次 ⇒ **2 次红**（另 11 次全绿），红样是
 *   `趋势 CRUD… expected 404 to be 201`（= 第 25 组那个 HTTP 侧形状，不是断言写错）。
 *   ⇒ ① **B15 不再等于"全量偶发、隔离必绿"**：单进程、单文件、无任何并发也能复现 ⇒
 *      此前用"隔离复跑全绿"把红归成抖动的做法，**在这条上不再成立**（今后要写"复跑 N 次中红 M 次"，M>0 就不许称抖动已排除）。
 *   ⇒ ② **"负载已排除"这句要撤回一半**：红的两次分别在 load 14.16 / ≈6.9，绿的 11 次在 5.56–14.16 之间都有
 *      ⇒ 方向不一致，**既不能证实也不能排除**（更早那组"红 3.08 / 全绿 5.18"本来就是两点样本）。
 *      本文件上面那张表里**没有"负载"这一行** ⇒ 它从未是实测排除项，只是叙述里被当成了排除项。
 *   ⇒ ③ ⚠️ **本条已被本文件顶部那条更正作废（2026-09-23 v3.04 自查）**：当年写的"最便宜的下一步 = 给
 *      `seasonRoute.test.ts` 接上本工具"**方向是错的** —— 埋点自 09-21 起就在 `test-setup.ts` 里做成**全局**
 *      （patch `supertest.Test.prototype.end`，失败时自动打印最近 8 次响应）⇒ 红样**从来都会**留下指纹，
 *      缺的**不是接线而是身份列**：`seenBy` 那栏因为"每个 app 工厂自己手写一行"从没被执行而恒为 `-`。
 *      ⇒ 本批（v3.04）把这枚 token 改成由 `test-setup.ts` 统一打，并新增 `port=` / `bare=` 两列。
 */

import { expect } from 'vitest';
import { execFileSync } from 'child_process';

/**
 * 被测应用应当给每个响应打上的头。
 * ★ **2026-09-23 v3.04 起由 `server/src/test-setup.ts` 统一打**（不再要求每个 app 工厂手写一行 ——
 *   那条推广方式挂了两天从没被执行，`seenBy` 一直是 `-` = 这一栏等于没有）。
 *   ⇒ 判据：**失败响应的 `seenBy` 缺这枚 token ⇒ 该响应不是被测应用实例发的**（B15 的直接判据）。
 *   ⚠️ 只在测试进程内生效（`test-setup.ts` 是 vitest 的 setupFile，不进生产构建）。
 */
export const EXPECT_APP_HEADER = 'x-app-seen';

/**
 * ★★ 本进程所有测试 app 的身份值（v3.04 起由 `test-setup.ts` 统一注入，不再要求 app 工厂手写）。
 *   ⇒ **v3.04 之前**的旧日志里 `seenBy=-` 一律不构成证据（那一栏当时根本没装）。
 */
export const APP_TOKEN = `b15-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 本进程 pid：与 `owner` 配对看即可判断「端口主人是不是我们」。 */
export const OWN_PID = process.pid;

/** 指纹能读到的最小结构（不收 supertest 的窄签名：守卫要能喂手写响应与真响应两种，不用 as never 绕）。 */
export type EvidenceLike = {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string | string[] | undefined>;
  req?: { socket?: { remoteAddress?: string; remotePort?: number } };
};

/**
 * 这个端口**在打印那一刻**的 LISTEN 持有者，形如 `pid(命令名)`，多个持有者用 `+` 连接。
 *
 * ⚠️ 三条能力边界（写在这里，别让它进任何"已排除"清单）：
 *   1. **时序**：supertest 在响应回来后**先 `server.close()` 再回调**（`node_modules/supertest/lib/test.js`），
 *      所以被测 app 自己的监听器在这一刻**已经不在 LISTEN 了** ⇒ 本栏记录的不是"那一秒"，而是"打印这一刻"；
 *      它的价值是**自动落盘、不必复现**，不是时间上更准。端口若在我们 close 之后被别的进程拿去，
 *      本栏会指认一个**无辜旁观者** ⇒ 只能当线索，不能当定罪。
 *   2. **三态**：`-` = 没有 LISTEN 持有者（正常空态，lsof 退出码 1）；`err` = lsof 不可用/超时（**这一轮这栏是瞎的**）；
 *      真值 = `pid(命令名)`。★ 拿不到时**不许**读成"没人持有"（root 持有的监听者本来就不出现在非 root 的 lsof 输出里）。
 *   3. **覆盖族**：只对"有人在那个号上 LISTEN"这一族有效。`Parse Error: Expected HTTP/…`、
 *      `socket hang up`（根本没有响应 ⇒ 根本不采样）与"透明代理/内核级劫持"三族**恒为 `-** ⇒ 不构成排除。
 */
export function portOwner(port: number | undefined): string {
  if (!port) return '-';
  let out: string;
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf-8', timeout: 1500 });
  } catch (e) {
    // ★ lsof 的「没有匹配」也是非 0 退出（execFileSync 会抛）⇒ 只能靠退出码分态，
    //   否则"空态"会被读成"工具瞎了"（本批 ⑥e 就是这么红的：关掉的号返回了 err）。
    if ((e as { status?: number })?.status === 1) return '-';
    return 'err';
  }
  const pairs: string[] = [];
  let curPid: string | null = null;
  let curCmd = '-';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {                      // 新进程开始：先把上一条落地
      if (curPid) pairs.push(`${curPid}(${curCmd})`);
      curPid = line.slice(1); curCmd = '-';
    } else if (line.startsWith('c')) {
      curCmd = line.slice(1) || curCmd;               // ★ 与**当前** pid 配对，不各取第一个
    }
  }
  if (curPid) pairs.push(`${curPid}(${curCmd})`);
  return pairs.length ? [...new Set(pairs)].join('+') : '-';
}

/**
 * ★ 本进程**此刻**是否在听这个号：`Y` / `N` / `-`（一个都没数到 ⇒ 工具没读到，不下结论）。
 *   为什么需要它：第 49 组红样 `want=peer=57623` 且 `match=Y`，看着像"我连的就是我拨的号"，
 *   但 `lsof` 说那个号被别的进程**独占**（本进程 `exclusive` 绑同号得 `EADDRINUSE`）
 *   ⇒ `match` 证明不了"那个号当时是我的"，这一列补的正是这一句。
 */
export function doWeListen(port: number | undefined): string {
  if (!port) return '-';
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(process.pid), '-F', 'n'],
      { encoding: 'utf-8', timeout: 1500 });
    const socks = out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
    if (!socks.length) return '-';
    return socks.some((n) => n.endsWith(`:${port}`)) ? 'Y' : 'N';
  } catch (e) {
    if ((e as { status?: number })?.status === 1) return 'N';   // 本进程一个 LISTEN 都没有 ⇒ 该号自然不是我们的
    return 'err';
  }
}

/** 纯函数：这一条响应值不值得去现场采样（缺身份头 + 失败档位）。守卫 ⑥c 给两侧对照。 */
export function needsOwner(res: EvidenceLike): boolean {
  const h = (res.headers ?? {}) as Record<string, string | undefined>;
  return res.status >= 400 && h[EXPECT_APP_HEADER] === undefined;
}

/**
 * ★ 采样入口（**接线只此一处**，守卫 ⑥f 用真响应测它 ⇒ test-setup 那边只需调一次，不再钉局部变量名）。
 *   一次失败打印里**按端口去重**，最坏一次外部调用而不是 8 次（复核 I-1：同步阻塞 × 8 会顶穿 vitest 默认
 *   hookTimeout=10s，`afterEach` 自己超时 ⇒ 新增一种"看着像 B15 但不是"的红，而且 8 行证据全丢）。
 */
export function ownerFields(res: EvidenceLike, wantPort?: number, seen?: Set<number>): { owner?: string; mine?: string } {
  if (!needsOwner(res)) return {};
  const peerPort = res.req?.socket?.remotePort;
  /**
   * ★ 查号以 **`want` 优先**、`peer` 只兜底 —— 不是风格选择：⑥f 用真响应实测
   *   `res.req.socket` 在响应完成后已被释放（`peer` 与 `peerPort` 双双变 `-`），
   *   若拿 `peerPort` 去查，`owner` 会**静默恒为 -**（又一条"名字像有货、其实常年空"的死列）。
   *   两者本就是同一个号（`match=Y` 时），但只有 `want` 稳定可得（来自 Test 的 url）。
   */
  const key = wantPort ?? peerPort;
  if (key !== undefined) {
    if (seen?.has(key)) return { owner: '(dup)', mine: '(dup)' };
    seen?.add(key);
  }
  return { owner: portOwner(key), mine: doWeListen(key) };
}

/** 从 supertest 的 `test.url`（拨号用的完整 URL）里取端口 —— ★ 不能用 `test.server.address()`：响应后已被 close 成 null（实测）。 */
export function portOfUrl(url: unknown): number | undefined {
  const m = typeof url === 'string' ? /https?:\/\/[^/]*?:(\d{2,5})(?:\/|\?|$)/.exec(url) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * 应答指纹：一次失败断言里能拿到的全部"谁答的"线索（单行，便于 grep 日志）。
 *
 * ★★ 三列身份相关的口径（2026-09-23 v3.04 复核 BL-1 后重做 —— 上一版的 `port=` 打的是**本端**临时端口，
 *    名字像身份、值却是客户端自己的端口 ⇒ 会被读成"应答者端口"从而做出**假排除**；那条已删）：
 *    - `peer=<addr:port>`：客户端 socket 的**对端**地址与端口 ⇒ **就是真正回答我们的那个进程监听的端口**，
 *      红样里拿它去 `lsof -i :<port>` 可以直接指认进程（这是 46 组来第一次做得到这件事）。
 *    - `want=<port>`：supertest **打算**连的端口（`test.url` 里那个）。
 *    - `match=Y|N|-`：两者是否一致。★ **能力边界（v3.04 第一批红样实测后更正）**：第 47 组三条红都是
 *      `seenBy=-` 但 `match=Y` ⇒ 说明 `match` 只反映"我连上了我刚拨的那个号"，**证明不了"是应用答的"**；
 *      真正的应用侧判据是 `seenBy`，而"端口主人是谁"要靠 `pid` 与 `lsof` 对撞。`N` 才有独立含义（说明连的不是那个号）。
 * ⚠️ `noct=Y` **只**覆盖"4xx/5xx 且完全没有 content-type"那一种形状（第 45 组的 `ct=- text=""`）。
 *    更常见的那族是 `ct=text/plain text="Not Found"` ⇒ 它 **`noct=-`** ⇒ 主判据是 `seenBy` 与 `peer/match`，
 *    **不许**用"noct 全为 -"来推断"都是应用答的"（复核 IM-4）。
 */
export function httpEvidence(res: EvidenceLike, wantPort?: number, owner?: string, mine?: string): string {
  const h = (res.headers ?? {}) as Record<string, string | undefined>;
  const sk = res.req?.socket;
  const peer = sk?.remotePort === undefined ? '-' : `${sk.remoteAddress}:${sk.remotePort}`;
  const match = wantPort === undefined || sk?.remotePort === undefined ? '-' : (wantPort === sk.remotePort ? 'Y' : 'N');
  const noct = res.status >= 400 && h['content-type'] === undefined ? 'Y' : '-';
  return `status=${res.status}`
    + ` body=${(JSON.stringify(res.body) ?? 'undefined').slice(0, 200)} ct=${h['content-type'] ?? '-'}`
    + ` server=${h.server ?? '-'} allow=${h.allow ?? '-'}`
    + ` powered=${h['x-powered-by'] ?? '-'} seenBy=${h[EXPECT_APP_HEADER] ?? '-'}`
    + ` peer=${peer} want=${wantPort ?? '-'} match=${match} mine=${mine ?? '-'} pid=${OWN_PID} owner=${owner ?? '-'}`
    + ` noct=${noct}`
    + ` text=${(res.text ?? '').slice(0, 80)}`;
}

/**
 * ★ 复核 IM-5：另一条形状**根本没有响应**（`Error: socket hang up`、`Parse Error: Expected HTTP/…`）。
 *   那一档如果只记"有响应的"，`[B15 取证]` 打出来的就全是同用例更早的**成功**响应
 *   ⇒ 读起来像"本轮拿到了指纹"，其实指纹与这次失败无关。所以错误也要占一行。
 */
export function httpErrEvidence(err: unknown): string {
  const e = err as { code?: string; message?: string } | undefined;
  return `noResponse=${e?.code ?? e?.message ?? String(err)}`;
}

/**
 * 断言状态码，并把**应答指纹**写进断言消息 ⇒ 失败时 vitest 输出（进而**落盘的全量日志**）里
 * 直接带"谁答的"，不必再靠事后猜。
 *
 * 用法：把 `expect(res.status).toBe(200)` 换成 `expectStatus(res, 200, 'DELETE /:id')`。
 * ⚠️ 这条路径上**不采** owner/mine（复核 M-3 只补了 want）⇒ 从这行消息里读到 `owner=-`**不等于**「没人持有这个端口」，只等于「这里没采」。
 * ⚠️ v3.04 起**全仓只此一份** `expectStatus`（另有两个同名本地助手不带指纹 ⇒ 已改为 import 本函数）。
 */
export function expectStatus(res: EvidenceLike, expected: number, label = '', wantPort?: number): void {
  expect(
    res.status,
    `${label ? `${label} → ` : ''}expected ${expected}, got ${res.status}`
    + `；body=${JSON.stringify(res.body ?? {}).slice(0, 200)}`
    + `｜B15 取证：${httpEvidence(res, wantPort)}`,
  ).toBe(expected);
}
