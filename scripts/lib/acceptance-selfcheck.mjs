#!/usr/bin/env node
/**
 * acceptance-selfcheck.mjs —— ★ 验收读数的**自证**（G-3 批，B35/B48 的取证层）
 *
 * 为什么需要它（两件本批实测出来的事，都不是猜测）：
 *  ① 本仓曾把仓库根**硬编码**成 `/Users/.../apps/Bambook`（主 checkout）。
 *     ⇒ 在 worktree（如 `apps/bambook-s0a`）里跑 `run-all-acceptance.mjs`，枚举与执行的是**主目录那份脚本**；
 *       同一条 `--list` 实测：改前 77 条（= 主目录实数）、改后 79 条（= 本 worktree 实数）。
 *  ② 验收脚本打的是 `http://127.0.0.1:8081`，而**谁在听这个端口就测谁**
 *     （实测 PID 68014 的 cwd = `apps/Bambook/server`，分支 main）。
 *
 * ⇒ 不写明"测的是哪个 checkout / 哪个 HEAD / 哪个库 / 哪个端口"的验收数，没有资格署本分支的名。
 *
 * ★★ 2026-09-21 复核后的四处自我更正（都写在这里，免得下一批又犯）：
 *  1. **删掉了 `ACC_BASE_URL` 入参**。原先只有本模块认这个变量，而 76 个脚本把 8081 写死
 *     ⇒ 把端口改成别的就能拿到一枚"✓ 可署名"，而真实请求仍进 main ⇒ **判据与被测对象可以指向不同东西**。
 *     现改为：**扫脚本里真实出现的端口集合**，逐个取证；有端口没被取证 ⇒ 判 `PORT_COVERAGE_GAP`。
 *  2. **`BRANCH_DRIFT` 原先不可达**：同一 worktree 目录下 `git rev-parse` 必然同名 ⇒ 那条分支比较永不触发。
 *     换成可达且更常见的 **`BACKEND_STALE`**（同 root 但后端进程的 HEAD ≠ 脚本的 HEAD ⇒ 服务没重启，
 *     测的是旧代码；detached HEAD 时 `--abbrev-ref` 两边都返回字面量 `HEAD`，故比较**完整 sha**）。
 *  3. **`sc.dirty` 原先算了却从不参与判定** ⇒ 现在 `DIRTY_WORKTREE` 是一条拒因：
 *     未提交改动不属于任何 commit，读数无法署给 `HEAD`。
 *  4. 取**全部** LISTEN pid（不只第一个）；root 比较前先 `realpathSync`（符号链接会让字符串比较误判为同/异）。
 *     env 解析同时吃**单引号与双引号**（只吃双引号会把引号读进 URL ⇒ `new URL` 抛 ⇒ 误判 ENV_MISSING）。
 *
 * 用法：
 *   import { selfCheck, formatBanner, isTrustworthy } from './lib/acceptance-selfcheck.mjs';
 *   const sc = selfCheck(); console.log(formatBanner(sc)); if (!isTrustworthy(sc).ok) …
 * 命令行：node scripts/lib/acceptance-selfcheck.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本模块所在仓库根：scripts/lib/x.mjs → 上三层。**不许硬编码绝对路径**（那是本批要修的病）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 本仓 `server/` 目录 —— 由**本模块自己的位置**解析，因此脚本引它就不会指到别的 checkout。
 * ★ 21 个验收/e2e 脚本此前把主 checkout 的绝对路径写死在 `createRequire(...)` 与
 *   `dotenv.config({path})` 里（B48）：在 worktree 跑 ⇒ 加载的是主目录的 `@prisma/client`
 *   和主目录的 `.env.local` ⇒ 那份读数根本没有资格署本分支的名。
 */
export const SERVER_DIR = path.join(REPO_ROOT, 'server');

const real = (p) => { try { return realpathSync(p); } catch { return p == null ? p : path.resolve(p); } };

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
};

function execRead(cmd) {
  try { return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/**
 * 从本仓 env 文件取 DATABASE_URL。
 * **取不到就返回 null，绝不回退去借别的 worktree 的** —— 那正是 B35/B48 的放大器。
 */
export function readDbTarget(root = REPO_ROOT) {
  const candidates = ['server/.env.local', 'server/.env', '.env.local'].map((p) => path.join(root, p));
  const envFile = candidates.find((p) => existsSync(p)) ?? null;
  // ★ 调用方显式给的 URL 优先（`DATABASE_URL=… node scripts/probe-….mjs`）。
  //   为什么开这一支而不是"去借别的 worktree 的 env"：显式传参把"连的是哪个库"从**文件位置**
  //   变成**这一条命令自己说出来的**，横幅里照样打得出来 ⇒ 自证强度不降反升。
  const inlineUrl = (process.env.DATABASE_URL ?? '').trim() || null;
  let url = inlineUrl;
  let urlSource = inlineUrl ? 'process.env.DATABASE_URL' : null;
  if (!url && envFile) {
    const txt = readFileSync(envFile, 'utf8');
    // 双引号 / 单引号 / 不加引号三种写法都吃（只吃双引号会把 `'` 读进 URL ⇒ new URL 抛 ⇒ 误判）
    const m = txt.match(/^\s*DATABASE_URL\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
    url = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim() || null;
  }
  let name = null, host = null, port = null;
  if (url) {
    try {
      const u = new URL(url);
      name = decodeURIComponent(u.pathname.replace(/^\//, '')) || null;
      host = u.hostname || null;
      port = u.port || '5432';
    } catch { /* 保持 null，由判定产出 DB_URL_UNPARSEABLE */ }
  }
  if (url && !urlSource) urlSource = envFile ? path.relative(root, envFile) : null;
  return { envFile, url, urlSource, name, host, port, unparseable: !!(url && !name) };
}

/**
 * ★ 统一的"取本仓 env → 连本机演练库"入口（G-3b：把 `db-rowcount.mjs` / `clean-drill-residue.mjs`
 *   这类**残留对撞与清扫的子步骤**也从硬编码主目录迁过来）。
 *   为什么值得统一：这两个都是**会动数据**的（后者 `--apply` 直接 deleteMany），
 *   而它们此前会静默连到"另一个 checkout 的 env 所指的那个库" ⇒ 破坏性脚本的目标库不由调用者决定。
 *   fail-closed：本仓没有 env / 库名不像演练库 ⇒ **抛错**，不猜、不回退。
 */
export function openLocalPrisma(root = REPO_ROOT) {
  const db = readDbTarget(root);
  if (!db.url) throw new Error(`ENV_MISSING：${root} 下找不到 server/.env.local 或 server/.env，也没收到显式 DATABASE_URL ⇒ 拒绝连接（更不许回退去借别的 worktree）`);
  if (!db.name) throw new Error(`DB_URL_UNPARSEABLE：${db.urlSource ?? '?'} 里的 URL 解析不出库名`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(db.host ?? '')) throw new Error(`REMOTE_DB_FORBIDDEN：host=${db.host} 非本机`);
  if (!/(local|dev|test)/i.test(db.name)) throw new Error(`PRODUCTION_DB_SUSPECT：库名 ${db.name} 不像演练库 ⇒ 拒绝`);
  const req = createRequire(path.join(root, 'server', 'noop.js'));
  if (db.envFile && db.urlSource !== 'process.env.DATABASE_URL') req('dotenv').config({ path: db.envFile, override: true });
  const mod = req('@prisma/client');
  return { PrismaClient: mod.PrismaClient, Prisma: mod.Prisma, prisma: new mod.PrismaClient(), db };
}

/**
 * ★ v3.77（复核 #19 BLOCKER-1）"只有直接执行才跑 CLI"这一族原先有 **8 个手抄落点**
 *   （分母＝跟踪的 .mjs/.js/.ts 共 1538 个；落点＝同一行同时出现 argv 的下标与本模块 URL 的那个属性），
 *   写法都是把解析后的 `argv[1]` 与 `fileURLToPath` 的结果**直接比字符串**。
 *   Node 加载 ESM 入口时会先 **realpath**，macOS 上 `/tmp` 是 `/private/tmp` 的符号链接
 *   ⇒ 只要调用路径经过任何符号链接，两边就不相等 ⇒ 守卫判成"被 import" ⇒ **整个 CLI 静默不跑、退 0**。
 *   本批实测：把 `gate-pairing-check.mjs` 拷到 `/tmp/x/` 后 `node /tmp/x/gpc.mjs --self-test`
 *   ＝ 输出 0 字节、rc=0（"经过符号链接"与"直连"两种写法**都**静默，比复核给的描述更宽）。
 *   ⇒ 对门禁/电池这类工具，这不是"少打印了点东西"，而是**一次假绿**：读的人以为它跑了。
 *   本函数是这一族**唯一**的比较实现：两侧都先 realpath，任一侧取不到真实路径时退回原样比较。
 *   （`server/scripts/cleanup-test-residue.mjs` 早为同一件事写过 realpath 版，注明"软链路径进来也要认得出"
 *    ——本批把它一起并过来，免得这里成了第二套真源。）
 * @param {string} metaUrl 调用方自己的模块 URL（不能用本函数的默认值 ⇒ 那是 lib 自己的路径）
 * @param {string} [argv1]
 */
export function isCliEntry(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl || !String(metaUrl).startsWith('file:')) return false;
  const rp = (p) => { try { return realpathSync(p); } catch { return p; } };
  return rp(path.resolve(String(argv1))) === rp(fileURLToPath(String(metaUrl)));
}

/**
 * 普查尺：找出还在**手抄**那串比较的落点（一族按落点数，不按措辞）。
 * 命中形状有**两种**（v3.79 按复核 #20 MAJOR-3 补第二种）：
 *   形状 A · 同一行里同时出现 argv 的下标 `1` 与本模块 URL 的那个属性 ⇒ 在自己比路径；
 *   形状 B · 同一行里 argv 的下标 `1` 与"取子串"的谓词同现（inclu de / endsWi t h / inde xOf / ma t ch 四种，
 *            去掉空格即真实谓词）⇒ 这是**方向相反而更坏**的一种：路径里含某个词就会执行，
 *            被 import 时也可能执行（本仓的实例曾是一个会清业务数据的脚本）。
 * `require.main === module` 不在此列：那是模块对象同一性，免疫符号链接与子串。
 * ★ 所有记号都拆成片段拼出来，**否则这把尺的源码会落进它自己的分母**
 *   （v3.77 现量：整句写全时本文件被自己命中 3 行，而其中两行只是注释里的散文）。
 * 单独导出成纯函数（只吃一段源码），是为了让证人能拿"缺陷原样"当**正面对照**：
 * 光说"全仓 0 处"而不证明这把尺抓得住一处，就等于没有尺（B192 判的就是这类"只有散文没有活路径"）。
 */
export function findRawCliEntryGuards(text) {
  const A = 'process.argv' + '[1]';
  const B = 'import.meta' + '.url';
  const SUB = ['.incl' + 'udes(', '.ends' + 'With(', '.index' + 'Of(', '.ma' + 'tch('];
  const hits = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (!line.includes(A)) return;
    if (line.includes(B) || SUB.some((s) => line.includes(s))) hits.push(i + 1);
  });
  return hits;
}

/**
 * 验收脚本清单：**唯一**一份枚举实现。批量执行器（run-all-acceptance）和 env 纪律普查都从这里取分母。
 * 两边各写一遍 `readdirSync + 正则` = 两份真源 ⇒ 一边扩了另一边不知道，"普查 100% 过 env"的分母会悄悄缩水
 * （复核 MINOR-7 量的正是这个：执行器认 `^acceptance-` 78 个、普查认 `^(acceptance|e2e)-` 80 个）。
 * @param {string} root 仓库根
 * @param {{ includeE2E?: boolean }} opts includeE2E=true 时把 e2e-* 一并计入（普查按更宽的分母）
 */
export function acceptanceScriptFiles(root = REPO_ROOT, opts = {}) {
  const re = opts.includeE2E ? /^(acceptance|e2e)-.*\.(mjs|ts)$/ : /^acceptance-.*\.(mjs|ts)$/;
  let names = [];
  try { names = readdirSync(path.join(root, 'scripts')); } catch { return []; }
  return names.filter((n) => re.test(n) && !n.endsWith('.test.ts')).sort();
}

/**
 * 给"自己 new PrismaClient()"的老脚本用的**唯一** env 装载入口（G-3c）。
 * ★ 为什么要它：脚本此前直接 `dotenv.config({ path: '<主 checkout>/server/.env.local' })`
 *   ⇒ 在本 worktree 里跑，连的却是主 checkout 的库配置，而读数署在本分支名下（B35/B48 的病灶）。
 *   现统一走 `readDbTarget`：**取不到就抛**，绝不回退去借别的 worktree —— 与 `openLocalPrisma` 同一条政策，
 *   两处共用一份判断（不在脚本里重抄"哪个 env 算本仓的"）。
 */
export function loadEnvForScript(root = REPO_ROOT) {
  const db = readDbTarget(root);
  if (!db.url) {
    throw new Error(`ENV_MISSING：${root} 下没有 server/.env.local 或 server/.env，也没收到显式 DATABASE_URL`
      + ` ⇒ 拒绝装载 env（回退去借别的 worktree 正是 B35 要消灭的事）`);
  }
  if (db.envFile && db.urlSource !== 'process.env.DATABASE_URL') {
    createRequire(path.join(root, 'server', 'noop.js'))('dotenv').config({ path: db.envFile, override: true });
  }
  return db;
}
/**
 * 脚本里**真实写死**的后端端口集合（判据必须覆盖它们，否则就是自娱自乐的口径）。
 * 分母取自 acceptanceScriptFiles —— 这里原先是第三份 `readdirSync + 正则`，与执行器/普查各写一遍。
 */
export function scriptPorts(root = REPO_ROOT) {
  const ports = new Set();
  for (const n of acceptanceScriptFiles(root)) {
    const txt = (() => { try { return readFileSync(path.join(root, 'scripts', n), 'utf8'); } catch { return ''; } })();
    for (const m of txt.matchAll(/127\.0\.0\.1:(\d{2,5})|localhost:(\d{2,5})/g)) ports.add(m[1] ?? m[2]);
  }
  return [...ports].sort();
}

/**
 * 由进程 cwd 反推它属于哪个 checkout。
 * ★ 原先是 `path.resolve(cwd, '..')`（假设 cwd 就是 `<repo>/server`）—— 复核实测立刻被抓：
 *   某个 vite 进程的 cwd 在 `<repo>` 或更深一层时，会推出一个**根本不存在的"仓库根"**
 *   （实测出现过 `/Users/.../apps`）⇒ 结论可能碰巧对，但推导是错的。
 *   现直接问 git：`rev-parse --show-toplevel` 对 worktree 也返回该 worktree 的根。
 */
function rootOfCwd(cwd) {
  if (!cwd) return null;
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  return top ? real(top) : null;
}

/** 谁在听这个端口（**全部** pid，不只第一个；多进程同时听 ⇒ 读数落到哪个不确定，必须暴露）。只读 lsof。 */
export function listeningOn(port, root = REPO_ROOT) {
  const out = [];
  const pids = execRead(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  for (const pid of (pids ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const cwdRaw = execRead(`lsof -a -p ${pid} -d cwd -Fn`);
    const cwd = cwdRaw ? cwdRaw.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))[0] : null;
    const started = execRead(`ps -o lstart= -p ${pid}`);
    out.push({
      pid,
      cwd: cwd ?? null,
      root: rootOfCwd(cwd),
      branch: cwd ? git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) : null,
      head: cwd ? git(['rev-parse', 'HEAD'], cwd) : null,   // 完整 sha：detached HEAD 下 --abbrev-ref 恒为 "HEAD"，不可比较
      startedAt: started ?? null,
    });
  }
  return out;
}

export function selfCheck({ targetPorts = null } = {}) {
  // ★ v3.47（第一次真跑逼出来的）：取证范围必须等于**这次真的在打的那个端口**。
  //   原先取的是"任何 acceptance 脚本里出现过的端口"（3000/8081…）⇒
  //   ① 别人 checkout 的后端只要占着某个**被提到过**的端口，就把一次完全合规的真跑拒之门外；
  //   ② 反过来，若 CHAIN_BASE 指向一个不在名单里的端口上的**外来服务**，这道闸看不见它。
  //   ⇒ 两个方向都错：证人与被测对象不是同一件事。现在由调用方把真实目标端口传进来。
  const ports = (targetPorts && targetPorts.length) ? targetPorts.map(String) : scriptPorts();
  const db = readDbTarget();
  const listeners = {};
  for (const p of (ports.length ? ports : ['8081'])) listeners[p] = listeningOn(p);
  return {
    repoRoot: real(REPO_ROOT),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
    head: git(['rev-parse', 'HEAD'], REPO_ROOT),
    dirtyPaths: (git(['status', '--porcelain'], REPO_ROOT) || '').split('\n').filter(Boolean),
    db,
    ports: ports.length ? ports : ['8081'],
    portsFromScripts: ports.length > 0,
    portsAreTarget: !!(targetPorts && targetPorts.length),
    listeners,
  };
}

/**
 * 判"这份验收数能不能署在本分支这个 commit 上"。
 * ★ fail-closed：取证不到即判不可信（§0.4 禁止"以没测出问题推定专业"，G3 禁止把"未知"当"通过"）。
 */
export const dbTarget = (sc) => sc?.db ?? {};
export function dbTargetReasons(sc) {
  const db = dbTarget(sc);
  const reasons = [];
  const where = db.urlSource ?? (db.envFile ? path.relative(sc.repoRoot, db.envFile) : '本仓 env 文件（找不到）');
  // 库：必须知道连的是哪个库，且它像演练库
  if (!db.envFile && !db.url) reasons.push(`ENV_MISSING：本仓找不到 env 文件、也没收到显式 DATABASE_URL（找过 server/.env.local、server/.env）⇒ 不知道连的是哪个库。★ 刻意不回退去读别的 worktree 的 env`);
  else if (!db.url) reasons.push(`DB_URL_MISSING：${where} 里没有 DATABASE_URL`);
  else if (db.unparseable || !db.name) reasons.push(`DB_URL_UNPARSEABLE：${where} 里的 URL 解析不出库名`);
  else {
    if (!['127.0.0.1', 'localhost', '::1'].includes(db.host ?? '')) reasons.push(`REMOTE_DB_FORBIDDEN：host=${db.host} 非本机 ⇒ 验收不许碰远端/生产库`);
    if (!/(local|dev|test)/i.test(db.name)) reasons.push(`PRODUCTION_DB_SUSPECT：库名 ${db.name} 不像演练库 ⇒ 拒绝署名`);
  }
  return reasons;
}

export function isTrustworthy(sc) {
  const reasons = [];
  // ① 库（判据只有一份：dbTargetReasons —— 只读探针也复用同一份，不许两处各写一遍）
  reasons.push(...dbTargetReasons(sc));
  // ② 工作树：未提交改动不属于任何 commit ⇒ 读数不能署给 HEAD
  if (sc.dirtyPaths?.length) {
    reasons.push(`DIRTY_WORKTREE：工作树有 ${sc.dirtyPaths.length} 处未提交改动（HEAD=${sc.head?.slice(0, 7)}）⇒ 这份读数属于"某个未命名状态"，不属于任何 commit`);
  }
  // ③ 端口覆盖：脚本真实用到的端口必须逐个取证，否则判据与被测对象不是一回事
  if (!sc.portsFromScripts) reasons.push('PORT_SET_UNKNOWN：扫不到任何 acceptance 脚本里的端口 ⇒ 无法确定该取证哪个后端');
  for (const p of sc.ports ?? []) {
    const list = sc.listeners?.[p] ?? [];
    if (list.length === 0) { reasons.push(`NO_BACKEND：端口 ${p} 无监听 ⇒ 验收打不到后端，读数不存在`); continue; }
    if (list.length > 1) reasons.push(`MULTIPLE_BACKENDS：端口 ${p} 有 ${list.length} 个进程在听（pid ${list.map((x) => x.pid).join('/')}）⇒ 读数落到哪个不确定`);
    for (const b of list) {
      if (!b.root) { reasons.push(`LSOF_FAILED：pid ${b.pid} 取不到 cwd ⇒ 无法证明测的是哪个 checkout`); continue; }
      if (b.root !== sc.repoRoot) {
        reasons.push(`ARTIFACT_MISMATCH：pid ${b.pid} 跑在另一个 checkout（${b.root}，分支 ${b.branch ?? '?'}）≠ 本脚本（${sc.repoRoot}，分支 ${sc.branch ?? '?'}）⇒ 这份读数属于那个分支`);
      } else if (b.head && sc.head && b.head !== sc.head) {
        reasons.push(`BACKEND_STALE：同 checkout，但后端进程 HEAD=${b.head.slice(0, 7)} ≠ 脚本 HEAD=${sc.head.slice(0, 7)} ⇒ 服务没重启，测的是旧代码（进程起于 ${b.startedAt ?? '?'}）`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * ★ v3.41（B165 第二刀，复核 #10 三条 BLOCKER 的正面回答）：
 *  - 标签集是**一份常量**，`residueCanonicalLabels()` 只能等于它的三个值 ⇒ 白名单不再有注入口，
 *    也不再能悄悄长出第四种措辞（复核：往数组里加第 4 条全绿）。
 *  - `clean` 那一支的前提从 1 个变成 6 个：**同库证明 + 数过表 + 分母对齐 + 无不可读表 +
 *    普查自报所用标识 + 标识里含本次自造的那几个**。缺任何一个 ⇒ 走 unproven（不许读成干净）。
 *    理由：复核 #10 实测「把 markers 换成一个永不自匹配的串」⇒ hits=[] ⇒ 打 ✓ 零残留 且退 0；
 *    而不传 `unreadableOut` 时"逐表抛错"也返回 0 ⇒ "一行都没数"与"数了且干净"同值。
 */
const RESIDUE_LABELS = {
  clean: '零残留复核（**全模型**扫描）',
  residue: '零残留复核（**全模型**扫描）⇒ 有残留',
  unproven: '零残留复核（**全模型**扫描）⇒ 不可采信',
};

export function residueVerdict(r) {
  const proven = !!(r && r.proven);
  const allHits = (r && r.hits) || [];
  // ★ v3.48（第一次真跑抓出来的反向错）：sweepResidue 返回的 hits **含着 count=0 的行**（13 条全 0 也照样返回），
  //   而本函数用 `hits.length > 0` 判残留 ⇒ 真跑当场报 "有残留 — UserAccount=0 · EntityReference=0 …"、
  //   退 1 ⇒ 我把"没数到东西"读成了"数到了脏东西"。方向与 B151 那条同族（失效时看起来更严重，所以没人去查），
  //   只是这次是反的：**误报脏**。判"有没有残留"必须看**计数**，不是看数组长度。
  const hits = allHits.filter((h) => Number(h && h.count) > 0);
  const unreadable = (r && r.unreadable) || [];
  const scanned = r && typeof r.scanned === 'number' ? r.scanned : null;
  const scannable = r && typeof r.scannable === 'number' ? r.scannable : null;
  // ★ v3.43（复核我自己跑出来的那条）：原写法 `want.filter(...)` 假定它是数组 ——
  //   而链上一版真的传了个字符串进去 ⇒ 真跑路径 TypeError。契约收在 lib：非数组**不猜**，按前提不成立处理
  //   （fail-closed 成一个诚实的 unproven，而不是崩在收尾那一行）。
  const used = Array.isArray(r && r.markersUsed) ? r.markersUsed : (r && r.markersUsed ? null : null);
  const want = Array.isArray(r && r.markersExpected) ? r.markersExpected : null;
  const usedBad = !Array.isArray(r && r.markersUsed) && !!(r && r.markersUsed);
  if (hits.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: hits.map((h) => `${h.model}=${h.count}`).join(' · ') };
  }
  const grew = (r && r.unmarkedGrowth) || [];
  const below = (r && r.deletedBelowBaseline) || [];
  const blind = (r && r.countBlind) || [];
  // ★ 洞③：跑后快照原先取在 settleAndClean **删除之后** ⇒ 真正的"删多了"表现为**变少**，
  //   而变少这一支按设计不算脏（它确实不算残留）⇒ 必须有另一条前提专门盯"低于基线的消失"。
  const winRes = (r && r.windowResidue) || [];
  const overDel = (r && r.overDeleted) || [];
  const attrBlind = (r && r.attributionBlind) || [];
  const instrSus = (r && r.instrumentSuspect) || [];
  // ★ v3.64（B170）主键集合那一层的三条读数（`snapshotIdSets` + `pkDiff` 出）。
  //   `pkResidue`＝post∖pre＝本次新增且清理后仍活着 ⇒ 与 `windowResidue` 同级（残留类）。
  //   `pkVanished`＝pre∖post＝基线行不见了 ⇒ **只判 unproven，永不进 overDeleted**（共享库里别人也在删）。
  //   `pkSkipped`＝两侧不对称（缺跑前快照等）⇒ unproven，不许塌成"没有新增"。
  // ★ v3.70（B178）逐主键守恒的两条读数（`deletedRowAttribution` 出）：
  //   `deletedPreexisting` = 我删掉且**跑前就在**的行（逐行点名，最强的删除面指控）；
  //   `deletedUnknown`     = 预读没接上/没对齐、既无 createdAt 也无跑前快照的行 ⇒ **判不了**，
  //                          不许塌成"都是我造的"（那等于把量具失败写成放行）。
  const delPre = (r && r.deletedPreexisting) || [];
  const delUnk = (r && r.deletedUnknown) || [];
  // ★ v3.74（复核 #17 B-2）：两条删除通道**对不上账**的表（有台账没自报数、或反之、或键口径不一致被归一丢掉）。
  //   这一维必须在读数里单独占一格：它曾经把"3 行真·跑前行被静默放行"演成"判不了=0"，看着像棘轮达成了。
  const delUnrec = (r && r.deletedUnreconciled) || [];
  // ★ v3.77（B187）指控轴的正对照。为什么这条必须参与判决：
  //   `删的跑前行=0` 有两种成因，而它们在日志里**形状完全相同**——
  //     (a) 本次确实没删任何跑前就在的行；(b) 整根时间轴前移了（时区/naive DATETIME/秒毫秒差一档），
  //   于是每一行都"在 runStart 之后"，`preexisting` 恒空 ⇒ 这根指控**永远哑**，
  //   而它哑的时候看起来正好是最干净的样子。窗口层与它**共轴**（同一个 runStart、同一条 toMs），
  //   所以那一侧不构成第二证人 ⇒ 唯一的证人是"真的埋一行跑前/跑后的行、读回来，看它分不分得开两档"。
  //   ⇒ 只要调用方报出了逐行守恒的读数，就必须同时交出那次往返的结果；交不出 ⇒ unproven。
  //   （v3.77 第一版按两个具名键判"这一层被声明了"⇒ 复核 #20 MINOR-8 实测：只报 `deletedUnknownRows` 也能
  //    打上 `删的跑前行=0` 而判决仍 clean。⇒ 放宽到"逐行守恒那一层的任意一格"。
  //    ★ 但仍要**按层**而不是按前缀：`deletedBelowBaseline`（行数对撞的标量差）与 `deletedUnreconciled`
  //    （两通道台账）不是这一层的分类读数 —— v3.79 一上来用 `startsWith('deleted')` 就把它们也算进去，
  //    当场把两格既有证人翻红（那是我的谓词过宽，不是它们有问题）。）
  const delLayerClaimed = !!r && (Object.keys(r).some((k) => /^deleted(Preexisting|Unknown)/.test(k)) || r.axisControl !== undefined);
  const ax = r && r.axisControl;
  const numAx = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '未接');
  // ★★ v3.79（复核 #20 MINOR-9）：**不许只信 `ok` 这个自述字段**。
  //   实跑证据：`{ran:true, ok:true, leftover:5, reasons:['坏']}` 在 v3.77 那版直接判 clean。
  //   ⇒ 判决要自己把内容重算一遍（本仓反复立的规矩：别拿"工具自己说 OK"当证人，要拿它算出来的量重算）：
  //     跑过 · 无遗留 reasons · 持久残留必须 0 · 埋了东西 · **两个方向各自真的分开了** · 报得出分辨率。
  // ★★ v3.80（复核 #21 MA-3）：上面那版"重算"只做到**字段级非零自检**——复核实测
  //   「不带网格 / grid.ok=false / grid 是空壳 / rolledBack=false / 完全手抄（没有 createdRows·rolledBack·grid）/ planted 谎报 99」
  //   六种 axisControl **全都判 clean**（只有覆盖行那一格会打"未量"）⇒ 那句"不许只信 ok"只兑了一半。
  //   ⇒ 现在要的是**可重算的证据**：调用方必须把喂给 `axisControlVerdict` 的那组输入原样交出来
  //   （offsetsSec/runStartMs/pairs/attribution/leftover），判决自己重跑一遍判据，再拿重算结果对撞自述字段；
  //   并补三项以前没人查的：网格必须真扫出边界、必须到达回滚点、事务内写入行数必须等于计划落点数。
  //   ⚠️ 这一道拦的是"只交汇总字段"与"汇总与自己的输入不一致"；**它拦不住"把 pairs/attribution 一起编造"**——
  //     能编出一致输入的人已经有了库侧写入能力，那一层的证人是真跑（第十六程）与独立 CLI，不是这里。
  const axBad = [];
  if (!ax || ax.ran !== true) axBad.push('没跑');
  else {
    if (ax.ok !== true) axBad.push('ok 不为 true');
    if (!Array.isArray(ax.reasons) || ax.reasons.length !== 0) axBad.push(`reasons=${Array.isArray(ax.reasons) ? ax.reasons.length : '非数组'}`);
    if (ax.leftover !== 0) axBad.push(`持久残留=${numAx(ax.leftover)}`);
    if (!(Number(ax.planted) > 0)) axBad.push(`落点数=${numAx(ax.planted)}`);
    if (!(Number(ax.preexistingMine) > 0)) axBad.push('跑前那侧一行都没被点名（＝指控没响）');
    if (!(Number(ax.nonPreMine) > 0)) axBad.push('跑后那侧一行都没被放行（＝两向塌成一档）');
    if (!(Number(ax.resolutionSec) > 0)) axBad.push('分辨率未报（＝不知道这把尺能检多大的位移）');
    if (!Array.isArray(ax.offsetsSec) || ax.offsetsSec.length < 2) axBad.push('档位不足两档');
    if (ax.rolledBack !== true) axBad.push(`到达回滚点=${ax.rolledBack === false ? '否' : '未报'}（＝"零持久写入"这句没被走到过）`);
    if (ax.createdRows !== ax.planted) {
      axBad.push(`事务内写入=${numAx(ax.createdRows)} 而计划落点=${numAx(ax.planted)} ⇒ 有一臂没真埋进去（最坏是那臂 silently 缺席，正对照自欺）`);
    }
    if (!ax.grid || ax.grid.ok !== true) {
      axBad.push(`网格${ax && ax.grid ? '没扫出边界' : '未交'}（${(ax && ax.grid && ax.grid.reason) || '没有 axisResolutionGrid 的产物'}）`
        + ' ⇒ 分辨率边界没量过，这一程不许引用任何"能检多大"的说法');
    }
    const ev = ax.evidence;
    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.pairs) || !ev.attribution || typeof ev.attribution !== 'object') {
      axBad.push('只交了汇总字段、没交可重算的证据（pairs/attribution/offsetsSec/runStartMs）⇒ 判决无从重算');
    } else {
      const rc = axisControlVerdict({ offsetsSec: ev.offsetsSec, runStartMs: ev.runStartMs,
        pairs: ev.pairs, attribution: ev.attribution, leftover: ev.leftover });
      if (rc.ok !== ax.ok) axBad.push(`重算 ok=${rc.ok} 与自述 ok=${ax.ok} 不一致`);
      if ((rc.reasons || []).length !== (ax.reasons || []).length) {
        axBad.push(`重算 reasons=${(rc.reasons || []).length} 条 vs 自述 ${(ax.reasons || []).length} 条`);
      }
      for (const k of ['planted', 'preexistingMine', 'nonPreMine', 'unknownMine', 'leftover']) {
        if (rc[k] !== ax[k]) axBad.push(`${k} 自述=${numAx(ax[k])} 重算=${numAx(rc[k])}`);
      }
      if (Array.isArray(ev.offsetsSec) && Array.isArray(ax.offsetsSec) && ev.offsetsSec.join(',') !== ax.offsetsSec.join(',')) {
        axBad.push(`档位自述=[${ax.offsetsSec}] 与证据=[${ev.offsetsSec}] 不同源`);
      }
      // ★★ v3.81（复核 #22 BL-1/MA-1）：v3.80 的"重算"只重算了**判据本体**，
      //   而 `grid`、`resolutionSec`、`defaultedDevMs` 这三项**同样能从已交证据算出来**却没算 ⇒
      //   复核实测 `{grid:{ok:true}}` 空壳、边界全 null、`resolutionSec:1000000`、`defaultedDevMs:999999` 全都照样 clean。
      //   ⇒ 现在一并重算：这三项以后要谎报，必须连证据一起改成自洽的假形状（成本高一个量级）。
      if (ax.resolutionSec !== rc.resolutionSec) {
        axBad.push(`分辨率自述=${numAx(ax.resolutionSec)} 重算=${numAx(rc.resolutionSec)}`);
      }
      const g2 = axisResolutionGrid({ offsetsSec: ev.offsetsSec });
      if (!ax.grid || typeof ax.grid !== 'object') {
        axBad.push('网格未交（判决自己重算了一份，对不上＝没量过）');
      } else {
        for (const k of ['ok', 'minTierSec', 'scannedSec', 'caughtAtOrAfterNegSec', 'silentNegSec', 'caughtAtOrAfterPosSec', 'zeroOk']) {
          if (ax.grid[k] !== g2[k]) axBad.push(`网格.${k} 自述=${JSON.stringify(ax.grid[k])} 重算=${JSON.stringify(g2[k])}`);
        }
      }
      const dRow = ev.pairs.find((p) => p && p.role === 'defaulted');
      const dGot = dRow && Number.isFinite(dRow.gotMs) ? dRow.gotMs : null;
      const dDev = dGot !== null && ev.runStartMs != null ? dGot - ev.runStartMs : null;
      if (ax.defaultedDevMs !== dDev) {
        axBad.push(`时刻差自述=${numAx(ax.defaultedDevMs)} 重算=${numAx(dDev)}（Δ 由证据里那一行的时刻减锚点算，不是自报）`);
      }
      // ★ v3.81（B200）：耗时与时钟偏差这两个新量**同样由证据算得出** ⇒ 一起重算，不留"自报通道"。
      const dA0 = dRow && Number.isFinite(dRow.anchorMs) ? dRow.anchorMs : null;
      const dA1 = dRow && Number.isFinite(dRow.anchorNotAfterMs) ? dRow.anchorNotAfterMs : dA0;
      const dElapsed = dA0 !== null && dRow && Number.isFinite(dRow.anchorNotAfterMs) ? dRow.anchorNotAfterMs - dA0 : null;
      const dClock = dGot !== null && dA0 !== null
        ? (dGot < dA0 ? dGot - dA0 : (dGot > dA1 ? dGot - dA1 : 0)) : null;
      if (ax.defaultedElapsedMs !== dElapsed) {
        axBad.push(`区间宽自述=${numAx(ax.defaultedElapsedMs)} 重算=${numAx(dElapsed)}（由证据里两个本机锚点相减；v3.81~v3.83 这一维被误命名为"演练耗时"）`);
      }
      if (ax.defaultedClockDevMs !== dClock) {
        axBad.push(`时钟偏差自述=${numAx(ax.defaultedClockDevMs)} 重算=${numAx(dClock)}（＝库给的时刻到本机区间外侧的距离，区间内为 0）`);
      }
      const dLead = dA0 !== null && ev.runStartMs != null ? dA0 - ev.runStartMs : null;
      const dInTx = dGot !== null && dA0 !== null ? dGot - dA0 : null;
      if (ax.defaultedLeadMs !== dLead) {
        axBad.push(`起跑耗时自述=${numAx(ax.defaultedLeadMs)} 重算=${numAx(dLead)}（＝发起那次事务之前的本机耗时，B204）`);
      }
      if (ax.defaultedInTxMs !== dInTx) {
        axBad.push(`事务内偏移自述=${numAx(ax.defaultedInTxMs)} 重算=${numAx(dInTx)}`);
      }
      // ★ B204 的正主：**恒等式**，但它必须对撞"自报的那三个数"。
      //   写成 `dDev === dLead + dInTx` 是**恒真**的——那三个重算值同源于 `gotMs / a0 / runStartMs`，
      //   由构造就满足（本仓那条老规矩：与尺共用谓词的对撞没有牙）。
      //   覆盖行与 CLI 打印的是**自报值**，所以要对撞的就是自报值之间是不是拆解关系。
      const selfTriple = [ax.defaultedDevMs, ax.defaultedLeadMs, ax.defaultedInTxMs];
      if (selfTriple.every((x) => Number.isFinite(x)) && ax.defaultedDevMs !== ax.defaultedLeadMs + ax.defaultedInTxMs) {
        axBad.push(`恒等式不成立：自报 落点间距=${numAx(ax.defaultedDevMs)} 而 起跑+事务内=`
          + `${numAx(ax.defaultedLeadMs)}+${numAx(ax.defaultedInTxMs)}`);
      }
      // ★ 证据必须落在**驱动自己的命名空间**里：真跑的 id 都带本次 marker（`AXISCTRL_*_<rnd>`），
      //   编一组自洽的 pairs/attribution 不难，难的是连命名律一起对上（复核 #22 MA-1 的"抬高编造成本"）。
      const marker = typeof ax.marker === 'string' ? ax.marker : '';
      if (marker.length < 4) axBad.push(`marker=${JSON.stringify(ax.marker)} 不是一个本次运行的命名空间（真驱动一定会带）`);
      else {
        const badIds = ev.pairs.filter((p) => !String(p && p.id || '').includes(marker)).map((p) => String(p && p.id).slice(0, 24));
        if (badIds.length) axBad.push(`证据里有 ${badIds.length} 行的 id 不带本次 marker ⇒ 不像这一程埋的：${badIds.slice(0, 3).join(', ')}`);
      }
      // ★ 界要说白：以上只保证"自述 == f(自陈输入)"。`createdRows / rolledBack / marker` 这三项
      //   **只能由真跑证明**（写入是否发生、是否到达回滚点、行名属不属于本程）⇒ 库侧证人仍是真跑与独立 CLI。
    }
  }
  const axisOk = axBad.length === 0;
  const axisWhy = axBad.join('、') || '齐';
  // ★ 正对照管的是**那一格 0**，不是已响的指控：
  //   `delPre>0` 是逐行点名的实证，把它降级成"不可采信"就等于把一条真指控洗软（v3.70 排它排在标量守恒之前，
  //   这条优先序不许被新前置打断）⇒ 这种情况仍判 residue，只在明细里加一句"轴未经对照 ⇒ 也可能是轴位移造的伪指控"。
  //   反之 `delPre=0` 时，没有正对照就分不清"真没多删"与"这根轴永远哑" ⇒ 判 unproven。
  const axisBad = delLayerClaimed && !axisOk && delPre.length === 0;
  const pkRes = (r && r.pkResidue) || [];
  const pkVan = (r && r.pkVanished) || [];
  const pkSkip = (r && r.pkSkipped) || [];
  // ★ v3.55：归因层自己的分母。缺它时 `counts` 是空对象 ⇒ 每张被 cleanup 报过数的表都会
  //   算成"删了本次没造过的行"⇒ 把我读不到行数写成针对删除面的**指控**（v3.53 刚为同族道过歉）。
  //   所以这条必须排在 overDeleted / windowResidue 之前；只在归因层"被声明参与"时生效，
  //   否则那些尚未接归因层的脚本会被无端翻红（它们仍走旧语义，登记在降范围第 44 条）。
  const attrRaw = r ? r.attributionEnumerated : undefined;
  const attrNum = typeof attrRaw === 'number' ? attrRaw : null;
  const attrClaimed = (attrRaw !== undefined && attrRaw !== null)
    || attrBlind.length > 0 || winRes.length > 0 || overDel.length > 0 || instrSus.length > 0
    || pkRes.length > 0 || pkVan.length > 0 || pkSkip.length > 0
    || delPre.length > 0 || delUnk.length > 0 || delUnrec.length > 0;
  if (attrClaimed && !(attrNum > 0 && Number.isFinite(attrNum))) {
    return { kind: 'unproven', ok: false, label: RESIDUE_LABELS.unproven,
      detail: `归因层没有分母（DMMF 枚举到 ${attrRaw === undefined ? '未提供' : String(attrRaw)} 个模型）`
        + ' ⇒ 窗口计数为空是"没数到"，既不能读成残留、也不能读成干净'
        // ★ 复核 #16 IMPORTANT-4：这条提前 return 当初的理由是"空 counts 会把 overDeleted 造成伪指控"，
        //   但它顺手把**与窗口无关**的三样也一起吞了（实测：`归因分母=0` 且主键层报出 3 行残留时，
        //   明细里 BusinessSequence 一句不出）。⇒ 这里只该扣掉窗口那一层派生的两条指控，
        //   主键集合的读数与标识外增长照旧出声（它们各自有独立的数据来源，不共用这把坏尺）。
        + (pkRes.length > 0 ? ` · ★ 同时已看到主键集合残留 ${pkRes.length} 处：`
          + pkRes.map((x) => `${x.model}=${x.n}${x.ids && x.ids.length ? `[${x.ids.join(', ')}]` : ''}`).join(', ') : '')
        + (pkVan.length > 0 ? ` · 主键集合基线行消失 ${pkVan.length} 张（只登记不指控）：${pkVan.map((x) => x.model).join(', ')}` : '')
        + (pkSkip.length > 0 ? ` · 主键层未覆盖 ${pkSkip.length} 张（点名）：${pkSkip.map((x) => x.model || String(x)).join(', ')}` : '')
        + (grew.length > 0 ? ` · 已看到的标识外增长 ${grew.length} 处：${grew.map((g) => `${g.model}(+${g.delta})`).join(', ')}` : '')
        // ★ v3.79（复核 #20 MINOR-11）：这条**提前 return** 原先把"轴没有正对照"那一句整个吞掉
        //   （与 v3.64 那次"提前 return 顺手吃掉三样"同族）⇒ 仍不改判据、仍 unproven，
        //   但这一层的 0 没有正对照这件事必须一起出声，不许因为排在后面就隐身。
        + (delLayerClaimed && !axisOk
          ? ` · ★ 同时：逐行守恒那一层没有可信的指控轴正对照（${axisWhy}）⇒ 它的"删的跑前行=0"两样都读不出`
          : '') };
  }
  // ★ v3.65（B174）：主键集合那一层有**自己的**分母，它不是上面那个的另一种写法。
  //   窗口层数的是"有可用 createdAt"的那一族，主键层数的是"没有可用 createdAt"的那一族（现量 33 张，A1 前为 35）
  //   ⇒ 拿 `attributionEnumerated` 给主键层作证是**跨层借用**：前者 >0 完全不妨碍后者为空。
  //   缺这个分母时 `pkResidue`/`pkVanished`/`pkSkipped` 三条读数会一起是 0，而 0 在覆盖行上读起来
  //   与"比对了 33 张且都干净"一模一样 —— 这正是 B170 判据里"OrderLine/Relation 在 pk 层拿到判定"
  //   今天**证不出来**的那一格（缺席不是读数）。
  //   ★ A1（2026-09-25 给这两张补了 createdAt）后，它们**已离开 pk 层**、改由窗口层直接归因
  //     ⇒ 上面那句现在只剩"形状说明"的历史意义；pk 层现量 33 张里不再含这两张。
  // ★ 复核 #16 BLOCKER-1：v3.65 那版只要求"两个分母都存在且 > 0"，于是
  //   `已比对 1 / 枚举 35` 与 `已比对 99999 / 枚举 35` 双双判 clean（实测），而 `pkCompared:12`
  //   还被我自己钉成了正面期望 ⇒ 前提写窄了并且**被测试锁死**。⇒ 光有分母不够，要的是**覆盖对账**：
  //   `已比对 + 点名的未覆盖 + 枚举漂移槽 == 枚举`。三个数各自还能各错各的，所以三样都要读。
  const pkEnumRaw = r ? r.pkEnumerated : undefined;
  const pkCompRaw = r ? r.pkCompared : undefined;
  const pkDriftRaw = r ? r.pkDrift : 0;
  const pkNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pkEnumNum = pkNum(pkEnumRaw);
  const pkCompNum = pkNum(pkCompRaw);
  const pkDriftNum = pkNum(pkDriftRaw);
  const pkSkipNamed = pkSkip.filter((x) => x && typeof x === 'object' && typeof x.model === 'string' && x.model.length > 0);
  const pkClaimed = (pkEnumRaw !== undefined && pkEnumRaw !== null)
    || (pkCompRaw !== undefined && pkCompRaw !== null)
    || pkRes.length > 0 || pkVan.length > 0 || pkSkip.length > 0;
  // ★ 电池 m27 第一次报惰性逼出来的更正：漂移**不进**对账求和。进了之后 `35/35 + 漂移 1` 会靠
  //   求和把它顶掉，那条独立否决权就成了永远不可能单独生效的死条件（与 v3.64 那次同族）。
  //   现在两件事各管各的：等式只管"每张都有下落"，漂移单独一票否决（分母自己在动 ⇒ 这程不作数）。
  const pkAccounted = (pkCompNum ?? 0) + pkSkipNamed.length;
  const pkNoDenom = pkClaimed && (
    !(pkEnumNum > 0) || !(pkCompNum > 0)
    || (pkDriftNum ?? 0) > 0                       // 两侧 DMMF 枚举不等 ⇒ 分母自己就在动，"整族比过了"不成立
    || pkSkipNamed.length !== pkSkip.length        // 有未覆盖的表却没点出名字 ⇒ 对账无从谈起
    || pkAccounted !== pkEnumNum                   // ★ 覆盖对账：差额必须逐张有名有姓
  );
  const pkNoDenomWhy = pkNoDenom
    ? [
      !(pkEnumNum > 0) ? `枚举到 ${pkEnumRaw === undefined ? '未提供' : String(pkEnumRaw)} 张"无可用 createdAt"的模型` : '',
      !(pkCompNum > 0) ? `两侧都拿到快照、真比了 ${pkCompRaw === undefined ? '未提供' : String(pkCompRaw)} 张` : '',
      (pkDriftNum ?? 0) > 0 ? `两侧枚举漂移 ${pkDriftNum} 张` : '',
      pkSkip.length !== pkSkipNamed.length ? `未覆盖 ${pkSkip.length} 条里有 ${pkSkip.length - pkSkipNamed.length} 条没点名是哪张表` : '',
      pkSkipNamed.length === pkSkip.length && pkEnumNum > 0 && pkAccounted !== pkEnumNum
        ? `覆盖对账不平：已比对 ${pkCompNum} + 点名的未覆盖 ${pkSkipNamed.length} = ${pkAccounted} ≠ 枚举 ${pkEnumNum}` : '',
    ].filter(Boolean).join('、') : '';
  const unattrDel = (r && r.unattributedDeleted) || [];
  // ★ 复核 #15 BLOCKER-2：原先这条挂着 `blind.length === 0` 的前提，等于"行数对撞一旦也没分母，
  //   归因那两张表就从输出里消失"——v3.56 刚说完"排序不许把已知信息吃掉"，自己就在另一条排序上吃掉了。
  //   ⇒ 现在四条读数（归因盲区 / 没数过的删除 / 行数分母缺失 / 标识外增长）**合并成一条明细**，一条都不少。
  // ★ v3.65（B174）：`pkNoDenom` 走的是这条**合并分支**而不是像上面那条归因分母那样提前 return。
  //   区别是有理由的：窗口层没分母时 `overDeleted` 本身就是空 counts 造出来的**伪指控**（v3.53 那道歉），
  //   而主键层只要报出过任何一条读数，那条读数就是两侧集合真差出来的（空集合差不出东西）⇒
  //   提前 return 会把真看到的脏吞掉，正是 v3.59/复核 #15 抓过的"排序吃掉已知信息"。
  if (attrBlind.length > 0 || unattrDel.length > 0 || instrSus.length > 0 || pkVan.length > 0 || pkSkip.length > 0 || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {
    const parts = [];
    if (instrSus.length > 0) {
      parts.push(`量具不可信：${instrSus.length} 张表我**按自己拿到的 id 删过行**、窗口却说"本次造了 0 行"`
        + `（${instrSus.slice(0, 8).map((x) => `${x.model} 删${x.deleted}`).join(', ')}${instrSus.length > 8 ? ' …' : ''}）`
        + ' ⇒ 坏的是时间窗（时区/naive timestamp/秒与毫秒一类），**不是删除面**；这一程不许据它指控删多了');
    }
    if (attrBlind.length > 0) {
      parts.push(`${attrBlind.length} 张没有可用 createdAt 或取不到窗口计数 ⇒ 无法按行归因：${attrBlind.slice(0, 8).join(', ')}${attrBlind.length > 8 ? ' …' : ''}`);
    }
    if (pkNoDenom) {
      parts.push(`主键集合那一层没有分母（${pkNoDenomWhy}）⇒ 它的三条读数分不清`
        + '"把这一族都比对过且干净"与"一张都没比对"，这一程不许据它读成已归因');
    }
    if (unattrDel.length > 0) {
      parts.push(`${unattrDel.length} 张被删但我这一程没数过它的窗口 ⇒ 不许指控也不许读成干净：${unattrDel.slice(0, 8).map((x) => `${x.model}(删${x.deleted})`).join(', ')}`);
    }
    if (blind.length > 0) parts.push(`（同时：行数对撞也有 ${blind.length} 张取不到行数）`);
    // ★ v3.59：判决仍是 unproven（核不了），但**已经看到的脏**必须一起说出来——
    //   否则"某张表核不了"会把"另一张表确实删多了" launder 成一句无法判定。
    if (overDel.length > 0) {
      parts.push(`★ 同时已看到守恒失败 ${overDel.length} 处：${overDel.map((x) => `${x.model} 删${x.deleted}/可归因${x.attributable}`).join(', ')}`);
    }
    if (winRes.length > 0) {
      parts.push(`★ 同时已看到本次窗口创建的行仍活着 ${winRes.length} 处：${winRes.map((x) => `${x.model}=${x.rows}`).join(', ')}`);
    }
    // ★ v3.64（B170）：主键集合那三条也要在这条**合并明细**里出声——排序不许把已知信息吃掉
    if (pkRes.length > 0) {
      parts.push(`★ 同时已看到主键集合残留（本次新增且清理后仍活着）${pkRes.length} 处：`
        + pkRes.map((x) => `${x.model}=${x.n}${x.ids && x.ids.length ? `[${x.ids.join(', ')}]` : ''}`).join(', '));
    }
    if (pkVan.length > 0) {
      parts.push(`基线行消失 ${pkVan.length} 张（pre∖post）⇒ **只登记不指控**：本机库与主 checkout 常驻服务共享，`
        + '删账号/过期清扫也会落在这里，真指控只走守恒式：'
        + pkVan.map((x) => `${x.model}(-${x.n})`).join(', '));
    }
    if (delUnrec.length > 0) {
      parts.push(`两通道对不上账 ${delUnrec.length} 张（有台账没自报数、或反之、或命名口径不一致）：`
        + `${delUnrec.slice(0, 8).map((x) => (typeof x === 'string' ? x : `${x.model}=${x.n}`)).join(', ')}${delUnrec.length > 8 ? ' …' : ''}`
        + ' ⇒ 这些删除**一行都不许读成已核**，也不许读成 0 行判不了');
    }
    if (axisBad) {
      parts.push(`指控轴没有正对照${ax ? `（重算不过：${axisWhy}；${(ax.reasons || []).join('；').slice(0, 260) || 'ok 自称通过但没有一条内容可核对'}`
        + `；档=${(ax.offsetsSec || []).join('/')}s·事务内落点 ${numAx(ax.planted)} 个·持久残留 ${numAx(ax.leftover)} 行）`
        : '（这一程根本没跑：调用方没交出那次往返的结果）'}`
        + ' ⇒ "删的跑前行=0"这一格分不清"真没多删"与"这根轴永远哑"，**不许读成没多删**'
        + `；${axisResolutionCaveat(ax && ax.grid, { defaultedDevMs: ax && ax.defaultedDevMs,
          defaultedElapsedMs: ax && ax.defaultedElapsedMs, defaultedClockDevMs: ax && ax.defaultedClockDevMs,
          defaultedLeadMs: ax && ax.defaultedLeadMs, defaultedInTxMs: ax && ax.defaultedInTxMs })}`);
    }
    if (delUnk.length > 0) {
      parts.push(`逐主键守恒判不了 ${delUnk.length} 行（预读未接 / 预读与实删不等 / 无 createdAt 又无跑前快照）`
        + ` ⇒ 这些删除**既没被指控也没被放行**：${(r.deletedUnknownBrief || []).join(', ') || delUnk.slice(0, 6).map((x) => `${x.model}=${x.id}`).join(', ')}`);
    }
    if (delPre.length > 0) {
      parts.push(`★ 同时已看到"删掉跑前就在的行" ${delPre.length} 行（逐行点名）：`
        + `${(r.deletedPreexistingBrief || []).join(', ') || delPre.slice(0, 6).map((x) => `${x.model}=${x.id}`).join(', ')}`);
    }
    if (pkSkip.length > 0) {
      parts.push(`主键层未覆盖 ${pkSkip.length} 张 ⇒ 不许读成"没有新增"：`
        + pkSkip.slice(0, 6).map((x) => (x && typeof x === 'object' ? `${x.model}（${x.why}）` : String(x))).join(' / ')
        + (pkSkip.length > 6 ? ` …共 ${pkSkip.length} 张` : ''));
    }
    if ((pkDriftNum ?? 0) > 0) {
      parts.push(`主键层两侧枚举漂移 ${pkDriftNum} 张 ⇒ "整族都比对过"这一程不成立`
        + '（是 DMMF 枚举自己在动，不是我没去数 ⇒ 归因的分母要重取）');
    }
    return { kind: 'unproven', ok: false, label: RESIDUE_LABELS.unproven,
      detail: parts.join(' · ')
        + '（无标识的成对误差这类情形就落在这些表上，不许当成"已核对干净"）'
        + (grew.length ? ` · 已看到的标识外增长 ${grew.length} 处：${grew.map((g) => `${g.model}(+${g.delta})`).join(', ')}` : '') };
  }
  // ★ v3.70（B178）：逐行点名"我删了跑前就在的行"排在标量守恒**之前** ——
  //   它不需要窗口计数当中间人，因此窗口少数一行时它不会跟着说谎（复核 #16 IMPORTANT-5 的那个形状）。
  if (delPre.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: `逐主键守恒：本次删掉了 ${delPre.length} 行**跑前就在**的行（逐行点名）：`
        + `${(r.deletedPreexistingBrief || []).join(', ') || delPre.slice(0, 8).map((x) => `${x.model}=${x.id}`).join(', ')}`
        + ' ⇒ 不依赖窗口计数，所以这不可能是"数错行数"造出来的（第四程那 24 条伪指控的形状在这一路不成立）'
        + ' ⇒ 删面宽于本次写入，按 §12.1 第 26/27 条属人判读地界'
        // ★ v3.77（B187）：指控仍判 residue（不降级），但把"轴有没有被验过"一起说出来——
        //   没有正对照时，这条指控**也可能**是整轴位移造出来的，人判读要连这一句一起读。
        + (axisOk ? ' ·（指控轴正对照本程跑过 ⇒ 这条不是轴位移造出来的）'
          : ' ·★ 指控轴没有本程正对照 ⇒ 这条也可能是整轴位移造出来的伪指控，两件事都要人判读，不许只挑一条信') };
  }
  // 归因结论排在标量差之前：它不看总行数，因此是唯一能抓住"留一行 + 多删一行"的一对
  if (overDel.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: '守恒校验失败（清理删掉了本次没创建过的行）：'
        + overDel.map((x) => `${x.model} 删${x.deleted}行/本次仅造${x.attributable}行可删`).join(' · ')
        + ' ⇒ 删面宽于本次写入，按 §12.1 第 26/27 条属人判读地界' };
  }
  if (winRes.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: '本次窗口内创建的行仍然活着（与标识无关的残留）：'
        + winRes.map((x) => `${x.model}=${x.rows}`).join(' · ')
        + ' ⇒ 总行数差把它抵消掉了，只有按行归因看得见' };
  }
  // ★ v3.64（B170）：没有 createdAt 的那一族，改由**主键集合差**逐行点名（比标量强，且能给出 id）
  if (pkRes.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: '主键集合差分：本次新增且清理后仍活着的行（逐行点名）：'
        + pkRes.map((x) => `${x.model}=${x.n}${x.ids && x.ids.length ? `[${x.ids.join(', ')}]` : ''}`).join(' · ')
        + ' ⇒ 这些表没有 createdAt，按时间窗数不出来，只有前后主键集合看得见' };
  }
  // ★ v3.64 自曝（电池 m19 第一次报的惰性）：这里原先另有一条 `pkVan/pkSkip ⇒ unproven` 的独立分支——
  //   而上面那条合并分支的条件已含 `pkVan.length > 0 || pkSkip.length > 0`，任何带消失/不对称的输入
  //   都会在合并分支先返回 ⇒ 那条独立分支**永远不可达**＝死代码（"修复必须落在活路径"那条的同族，
  //   这次是我自己刚写的）。⇒ 删掉它；消失/不对称的语义由合并分支承担（测试各钉一格）。
  if (blind.length > 0) {
    return { kind: 'unproven', ok: false, label: RESIDUE_LABELS.unproven,
      detail: `第二证人没有分母：${blind.length} 张表连行数都取不到（${blind.slice(0, 6).join(', ')}${blind.length > 6 ? ' …' : ''}）`
        + ' ⇒ 对撞集合不完整，"没有增长"这个读数不成立' };
  }
  if (below.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      // ★ 复核 #14 I-3：明细要按**人读的方向**写（基线 8 行 → 清理后 3 行 ＝ -5），
      //   原先顺着 rowDelta 的参数序打 3→8 (+5)，把"消失"印成"增长"，而旧判据还把错方向钉死了。
      detail: '低于本次基线的消失（清理删掉了基线里就存在的行）：'
        + below.map((g) => `${g.model} ${g.to}→${g.from} (-${g.delta})`).join(' · ')
        + ' ⇒ 这不是"没扫到残留"，是删面宽于本次写入 ⇒ 按 §12.1 第 26/27 条属人判读地界，绝不许读成干净' };
  }
  if (grew.length > 0) {
    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,
      detail: '标识扫不到但行数增长了（与标识无关的第二证人）：'
        + grew.map((g) => `${g.model} ${g.from}→${g.to} (+${g.delta})`).join(' · ')
        + ' ⇒ 本表内的行不带演练标识 ⇒ 按标识扫结构上看不见，不许读成干净' };
  }
  const miss = [];
  if (!proven) miss.push('同库证明从未拿到（建单未 200 / 回读未执行 ⇒ 证明对象没被置真）');
  if (scanned === null || scannable === null) miss.push('普查没有自报"数了几张表" ⇒ 无法区分"没数"与"数了且干净"');
  else if (scannable === 0) miss.push('可扫表数为 0 ⇒ 分母塌了');
  else if (scanned === 0) miss.push(`扫了 0 张表（可扫 ${scannable}）`);
  else if (scanned < scannable) miss.push(`只扫了 ${scanned}/${scannable} 张表 ⇒ 其余表的"零"不存在`);
  if (unreadable.length > 0) miss.push(`${unreadable.length} 张表数不了（${unreadable.map((u) => u.model).join(',')}）⇒ 它们的"零"不可信`);
  if (usedBad) miss.push('markersUsed 不是数组 ⇒ 无法核对标识集合');
  if (!want || want.length === 0) miss.push('本次自造标识为空 ⇒ 任何计数都恒为 0，这是恒绿判据');
  else if (!used) miss.push('普查没有自报它用了哪些标识 ⇒ 无法证明数的是本次的数（或自报的形状不对）');
  else {
    const gone = want.filter((m) => !used.includes(m));
    if (gone.length > 0) miss.push(`普查用的标识里缺了本次自造的 ${gone.join(',')} ⇒ 扫的不是本次写入，"零"与本次无关`);
  }
  if (miss.length > 0) {
    return { kind: 'unproven', ok: false, label: RESIDUE_LABELS.unproven,
      detail: miss.join('；') + ' ⇒ 扫到 0 行只说明"我连的库里没有"，不说明"服务写过的库没有"' };
  }
  return { kind: 'clean', ok: true, label: RESIDUE_LABELS.clean,
    detail: `演练标识命中 0（数过 ${scanned}/${scannable} 张表、无不可读表、标识含本次自造的 ${want.length} 枚）` };
}

/**
 * ★ v3.63（复核 #15 I-1）：**"没出现"不许被读成"通过"**。
 *   判决行原先只打印"这一支决定要说的那几句" ⇒ `overDeleted` 归零到底是
 *   ① 被问过且守恒通过、② 被更前面的 hits 分支顶掉、③ 被"归因层没有分母"顶掉，**日志里查不出来**。
 *   第四程 24 处指控被 v3.61 修好之后，第五程那句"守恒失败 0"就只剩读者做缺席反推
 *   —— 而我连"每个非空桶都会打印"这条前提都没有证人。⇒ 反推不许当读数用。
 *   现在每次判决**额外**发一条与分支无关的覆盖行：八条前提各自的条数（含 0）+ 删除面逐表落点。
 *   ⚠️ 它**只加读数、不参与判决**（`residueVerdict` 的分支与判据一个字未改）⇒ 不存在"借它放宽判据"这条路。
 */
export function coverageLine(r) {
  const cnt = (k) => {
    const a = (r && r[k]) || [];
    if (!Array.isArray(a)) return 0;
    return a.filter((x) => !(x && typeof x.count === 'number' && x.count <= 0)).length;
  };
  const disp = (r && Array.isArray(r.disposition)) ? r.disposition : [];
  const names = (b) => disp.filter((x) => x.bucket === b).map((x) => x.model);
  const cell = (a) => (a.length === 0 ? '0' : `${a.length}${a.length <= 12 ? '[' + a.join(',') + ']' : '[' + a.slice(0, 12).join(',') + ' …]'}`);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '未接');
  // ★ v3.77（B187）：正对照自己也要占一格 ⇒ "这根轴没响过"与"这根轴被验过、确实没响"在读数里分得开。
  //   ⚠️ 这一格只加读数，不改判据（判据那一条在 `residueVerdict` 里，另有证人）。
  const ax = r && r.axisControl;
  // ★ v3.79（复核 #20 MINOR-7）：这一格从此打**扫出来的两侧边界**；没跑网格就只许说"未量"，
  //   不许回退成旧那句"±120s 以内检不出"（它只在单侧成立，而旧措辞两侧通吃）。
  const g = ax && ax.grid;
  const resCell = g && g.ok === true
    ? `网格边界=${negEdgeTxt(g)}/变晚侧${g.caughtAtOrAfterPosSec === null ? `≤${num(g.scannedSec)}s哑` : `+${num(g.caughtAtOrAfterPosSec)}s响`}`
      + (Number.isFinite(ax.defaultedDevMs)
        // ★ v3.81（B200）：这一格不再把"落点晚于起点多少"写成"时钟差多少"，三个量各归各的名字。
        ? `（本臂实测：落点晚于起点 ${ax.defaultedDevMs}ms ⇒ 正向哑区就是这么大；`
          + `拆开=` + decompositionPhrase({ devMs: ax.defaultedDevMs, leadMs: ax.defaultedLeadMs, inTxMs: ax.defaultedInTxMs })
          + `〔区间宽 ${num(ax.defaultedElapsedMs)}ms、时钟/时区偏差 ${num(ax.defaultedClockDevMs)}ms〕）`
        : '（真实正侧未量）')
      + '·真实分辨率未量'
    : '网格边界=未量（没跑网格 ⇒ 这一格不给任何"能检多大"的数字）';
  const axisCell = ax && ax.ran
    ? `指控轴正对照=${ax.ok ? '两向都对' : '失灵'}`
      + `（档=${(ax.offsetsSec || []).join('/')}s·${resCell}`
      + `·事务内埋${num(ax.createdRows)}·到达回滚点${ax.rolledBack === true ? '是' : ax.rolledBack === false ? '否' : '未接'}/持久残留${num(ax.leftover)}`
      + `·点名${num(ax.preexistingMine)}/放行${num(ax.nonPreMine)}）`
      + (ax.ok ? '' : `：${(ax.reasons || []).join('；').slice(0, 220)}`)
    : '指控轴正对照=未跑（⇒ "删的跑前行=0"只说明这根轴没响过，读不出"没多删"）';
  const counts = `标识命中=${cnt('hits')} 窗口残留=${cnt('windowResidue')} 守恒失败=${cnt('overDeleted')}`
    + ` 未问不可归因=${cnt('unattributedDeleted')} 归因盲区=${cnt('attributionBlind')} 量具可疑=${cnt('instrumentSuspect')}`
    + ` 标识外增长=${cnt('unmarkedGrowth')} 低于基线=${cnt('deletedBelowBaseline')} 行数取不到=${cnt('countBlind')}`
    // ★ v3.64（B170）：主键集合那一层的三条也进同一条覆盖行 ⇒ "某张表没出现"再多三种成因也不许无人证
    + ` 主键集合残留=${cnt('pkResidue')} 基线行消失=${cnt('pkVanished')} 主键两侧不对称=${cnt('pkSkipped')}`
    // ★ v3.70（B178）：逐主键守恒的两个数也必须同屏 —— "删的跑前行=0" 只有在"判不了=0"时才是好消息，
    //   否则它只是"我看不见"（B176 那条教训：一个数不单独作证，要和它的分母一起看）。
    + ` 删的跑前行=${cnt('deletedPreexisting')}`
    // ★ v3.71（B183）：`unknown` 这个数组里既有"一行"也有"整张表"，光数条数会把 422 行报成 3。
    //   ⇒ 两个单位分开打：行数（删除侧自报的）与整表未读的张数，谁都不许替代谁。
    + ` 判不了行数=${num(r?.deletedUnknownRows)} 整表未读=${num(r?.deletedUnknownWholeTables)} 张`
    + ((r?.deletedUnknownRowsSilent ?? 0) > 0 ? `（其中 ${num(r.deletedUnknownRowsSilent)} 张连行数都没报上来）` : '')
    + ` 对不上账=${cnt('deletedUnreconciled')} 张`
    + ` ${axisCell}`;
  // ★ v3.65（B174）：那一层的**分母**也与三条同屏（"我数过了"式证人，分母必须与读数同行）。
  //   0 也要出声；没接这一层就说没接，不许用空格让人以为"比过、干净"。
  const pkDenom = (typeof r?.pkEnumerated === 'number' && Number.isFinite(r.pkEnumerated))
    || (typeof r?.pkCompared === 'number' && Number.isFinite(r.pkCompared))
    ? `主键层分母=已比对${num(r?.pkCompared)}/枚举${num(r?.pkEnumerated)}`
      + `（点名未覆盖${num(Array.isArray(r?.pkSkipped) ? r.pkSkipped.length : undefined)}`
      + `、枚举漂移${num(r?.pkDrift)}）`
    : '主键层分母=未接（没报已比对/枚举张数 ⇒ 上面那三条 0 读数分不清"比过且干净"与"根本没比"）';
  const landing = disp.length > 0
    ? `逐表落点：守恒通过(删过行)=${cell(names('passedDeleted'))} 守恒恒成立(没删过)=${cell(names('passedIdle'))}`
      + ` 窗口残留=${cell(names('residue'))} 守恒失败=${cell(names('over'))}`
      + ` 没被问过=${cell(names('unasked'))} 量具可疑=${cell(names('suspect'))}`
    : '逐表落点=未接（调用方没喂 disposition ⇒ "某张表没出现"既读不出"守恒通过"也读不出"根本没数它"）';
  return `${counts} · ${pkDenom} · ${landing}`;
}

/**
 * ★ v3.37（复核 #8 I-1）：**发射**也搬进这里，调用点只剩一个表达式。
 *   上一批我把判决抽成纯函数却留着调用点的 if/else ⇒ 复核实测"保留这个调用、把返回值丢掉、
 *   自己再写一段内联 if"四条 pin 全绿（等于退回 v3.35 被否掉的形状）。现在打印这件事本身
 *   就在那一次调用里，丢掉返回值也丢掉了输出，没法"两边都留一点"。
 */
export function emitResidueVerdict(r, out) {
  const v = residueVerdict(r);
  // ★ v3.44（B166）：判决要**落到一个只有本函数会写的槽位**里 —— 之后退出码读那个槽，不读计数。
  //   复核 #11 的 B-2 证明：靠措辞白名单挡假干净是死路（`整个库确认没有任何遗留数据` 不命中那 4 枚 token，
  //   经同一份 reporter 打得出去、还把通过数 +1）。正解不是继续加词，而是让"通过数"根本没有表决权。
  // ★ 复核 #12 的 BLOCKER：原先判"是不是 reporter"用的是 VERDICTS.has(out) —— 而那张表
  //   在写第一笔判决之前本来就是空的 ⇒ 合法的 reporter 也会走进 else 当场抛。
  //   现在用**创建时登记的 WeakSet** 认身份，与"有没有写过判决"无关。
  if (out && REPORTERS.has(out)) {
    if (VERDICTS.get(out)) throw new Error('B166 重复判决：残留判决已被记录过（kind=' + VERDICTS.get(out).kind + '）');
    VERDICTS.set(out, v);
  } else if (out && typeof out.pass === 'function') {
    // `out` 不是 reporter（例如手递一个 { pass, fail } 字面量）时**当场抛**：
    // 原先静默跳过 ⇒ 链上判决槽永远空 ⇒ `判定=无`、退 5、clean 支路恒死（复核 #12 抓到的那条）。
    throw new Error('B166 判决无处安放：emitResidueVerdict 的 out 必须是 createReporter() 返回的 reporter'
      + '（拿到的是普通对象 ⇒ 判决不进槽位，收尾只会报"判定=无"）');
  }
  // ★ v3.63：覆盖行跟着判决一起出去（放在**这一次调用**里，不是调用点 ⇒ 想丢掉覆盖行就得丢掉整个判决）。
  (v.ok ? out.pass : out.fail)(v.label, `${v.detail} · ${coverageLine(r)}`);
  return v.kind;
}


/**
 * ★ v3.50（B167 · 第二次真跑逼出来的第二证人）：**标识扫不到的副作用**。
 *   M3 首跑绿之后我用 `db-rowcount.mjs` 做了与标识无关的对撞 ⇒ 同一程里
 *   `systemConfigHistory 34 → 36 (+2)`，而收尾仍打 `✓ 零残留复核 · 判定=clean`。
 *   ⇒ "演练标识无命中"从来不等于"本次没在库里留下东西"：只要某张表的写入不带标识
 *   （配置审计流水这类是典型），按标识扫**结构上就看不见**它。这正是当年 416 行假绿那一族。
 *   现在把"跑前/跑后全模型行数对撞"接进判决：有任何增长 ⇒ 判 residue（不是 unproven —— 它确实脏）。
 *   ⚠️ 口径：本机业务库可能有别人并发写 ⇒ 会误报增长；方向是 fail-closed（宁可多报脏），
 *   明细里点名"标识看不见"的表，由人判读是不是本次造成的。
 */
export async function countAllModels({ prisma, Prisma, onUnreadable = null }) {
  const models = (Prisma?.dmmf?.datamodel?.models) ?? [];
  const out = {};
  const unreadable = [];
  for (const m of models) {
    const key = m.name.charAt(0).toLowerCase() + m.name.slice(1);
    const d = prisma[key];
    if (!d || typeof d.count !== 'function') { unreadable.push(m.name); continue; }
    try { out[m.name] = await d.count(); }
    catch (e) { unreadable.push(m.name); }
  }
  if (onUnreadable) onUnreadable.push(...unreadable);
  return { counts: out, unreadable };
}

export function rowDelta(base, now) {
  // ★ v3.52（复核 #13 的洞①）：原先只遍历 **base 的键** ⇒ 基线里没有的模型（新表、或基线期 count 抛错缺席）
  //   永远看不见增长，而这正是第二证人存在的理由（标识扫不到的那类增长）。现按**并集**遍历，缺席当 0。
  const grew = [];
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(now ?? {})]);
  for (const m of keys) {
    const a = (base ?? {})[m];
    const b = (now ?? {})[m];
    const from = typeof a === 'number' ? a : 0;
    if (typeof b === 'number' && b > from) grew.push({ model: m, from, to: b, delta: b - from });
  }
  return grew;
}

/**
 * ★ v3.39（B165，复核 #9 的三条绕行逼出来的）：残留结论的"唯一 + 出处"不再靠**读源码**，
 *   改成**运行时不变量**——由共享 reporter 在发射的那一刻判。
 *
 *   为什么必须换：上一批我把打印搬进 lib、把所有源码 pin 改跑在去注释代码上，还跑了 8 条突变自证，
 *   复核实测三条绕行照样全绿 ——
 *     ① `if (false) emitResidueVerdict(...)`（字面还在，结论不再产生）；
 *     ② 在那次调用之后自己再手写一句**换措辞**的"无残留"（不是被钉的那个字面量 ⇒ 逃过负面 pin，
 *        还挤进 results 把通过数 +1，与 lib 自己打的"✗ 有残留"同时出现在终端）；
 *     ③ 把被钉字面塞进字符串里的 ` // ` 之后 ⇒ 行级剥离器先把它剪掉，pin 读到"不存在"。
 *   ⇒ 文本判据的天花板就是"某串字面在不在"，它看不见"那次行为有没有发生"。
 *
 *   现在这两个事实由**执行**产生：
 *   - 任何标签命中残留族词的句子，只能等于 lib 的规范标签（② 的换措辞当场抛）；
 *   - 全 run 只许出现一次（重复抛）；
 *   - 收尾由 finishRun 复核"确实发出过一次"，没有就**不给 0 退出码**（① 的红路）。
 *   ⚠️ 族词的适用面是**量过**的：本仓 M3 主链 69 处结论调用里，命中残留族词的 **0 处**
 *      ⇒ 这道闸今天不误伤任何既有句子（口径见 B165 与 tests 的两侧自证）。
 */
export const RESIDUE_CLOSING_TOKENS = /(残留|无命中|清干净|零剩)/;

/**
 * ★ v3.54（B168 · 复核 #14 的第五条逃逸）：**标量差挡不住成对误差** ——
 *   同一张表"留下 1 行本次新建的未标识行 ＋ 多删 1 行基线里就有的旧行"，
 *   跑前/跑后总行数一模一样 ⇒ 增长=0、消失=0，两条标量前提同时沉默，判 clean。
 *   所以不再加第三条标量前提，改成**按行归因 + 守恒校验**：
 *     createdInWindow(写后) − createdInWindow(清理后) ＝ 本次自己造、且已被清掉的行数
 *     ⇒ 若 cleanup 自报的删除数比这个值还大，多出来的部分**只可能是别人的行**（它没造过它）；
 *     ⇒ 若清理后仍有"本次窗口内创建的行"活着，那就是**与标识无关的残留**。
 *   两条都不看总行数，成对误差无法互相抵消。
 */
/** ★ v3.56：模型名的**唯一规范写法**（首字母大写）。cleanup 的 `byModel` 有两个通道在写：
 *  ① 按标识扫那一路写的是 Prisma 模型名（`EntityReference`），② 级联那一路写的是委托键（`entityReference`）。
 *  两边都进同一个 map ⇒ 同一张表按两种拼法各记一笔。而窗口计数按模型名 keyed ⇒ 若不对齐，
 *  `deletedByModel` 里那条小写记录找不到"本次造了几行"⇒ ownDeleted=0 ⇒ **overDeleted 当场成立**，
 *  把我自己的命名差异报成"它删了没造过的行"（针对删除面的伪指控，§12.1 第 26/27 条地界）。
 */
export function canonModel(name) {
  const s = String(name ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** 按规范名合并（同名两笔要相加，不能互相覆盖 ⇒ 覆盖＝把删除数读少） */
function byCanon(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    const c = canonModel(k);
    out[c] = (out[c] ?? 0) + (Number(v) || 0);
  }
  return out;
}
/** ★ v3.59：把**多条删除通道**的自报数合并成守恒校验的一份输入。
 *  链上的删除面本来就有两处记账：链自己那份手写清单（`del()` 逐表）与 `settleAndClean` 的兜底清扫。
 *  原先只把后者喂给 `conservationCheck` ⇒ "overDeleted"实际只覆盖了清扫那一段，
 *  手写清单删掉的行（Order / Relation / EntityReference …）在它眼里等于没删过 ⇒ **漏报**（不是误报）。
 *  合并必须按规范名**相加**：两条通道都报过同一张表时，覆盖式 spread 会把其中一笔抹掉。
 */
export function mergeDeleted(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m || {})) {
      const c = canonModel(k);
      out[c] = (out[c] ?? 0) + (Number(v) || 0);
    }
  }
  return out;
}
export function conservationCheck({ createdInWindowAtWrite, createdInWindowAtClean, deletedByModel, knownCreatedModels }) {
  const w = byCanon(createdInWindowAtWrite);
  const c = byCanon(createdInWindowAtClean);
  const d = byCanon(deletedByModel);
  // ★ v3.60（第四程真跑逼出来的）：**我知道自己造过行**的表（链是按自己拿到的 id 删的），
  //   若窗口计数说"本次造了 0 行"，那么坏的是**量具**（时区 / naive timestamp / 秒与毫秒），
  //   不是删除面。把这种表报成"删了本次没造过的行"是本系统能产出的最危险的一句假话。
  const knows = new Set(Array.from(knownCreatedModels || [], canonModel));
  const residue = [];
  const overDeleted = [];
  const instrumentSuspect = [];
  const unattributed = [];
  // ★ v3.63（复核 #15 I-1）：**逐表落点**。"这张表没出现在指控里"有三种互不相等的成因
  //   （真的守恒通过 / 被 hits 分支顶掉 / 被"没有分母"顶掉），而调用方以前只能靠缺席反推。
  //   ⇒ 每张被这次守恒校验**看过**的表都记一笔它落在哪一格，读数侧才有地方把"通过"当成一条正读数以打印。
  const disposition = [];
  // ★ 复核 #15 BLOCKER-1：只有**被我问过的那张表**才有资格被指控。原写法只要 `deletedByModel` 里有一笔、
  //   而窗口计数里没有这张表（分母只枚举到 3 个模型、或整段没数过它），`ownDeleted` 就是 0 ⇒
  //   `deleted > 0` 立刻成立 ⇒ 又造出一条"它删了本次没造过的行"的伪指控。前提"分母>0"挡不住这个
  //   （枚举 3 个也算>0），所以判据要收在**覆盖**这一维：没问过 ⇒ 只登记"不可归因"，不指控。
  const asked = new Set([...Object.keys(w), ...Object.keys(c)]);
  for (const m of new Set([...Object.keys(w), ...Object.keys(c), ...Object.keys(d)])) {
    const created = w[m] || 0;
    const alive = c[m] || 0;
    const deleted = d[m] || 0;
    const ownDeleted = Math.max(0, created - alive);
    if (alive > 0) residue.push({ model: m, rows: alive });
    // ★ v3.68（B181）：'passed' 以前把两种成因混在一格 —— ① 这张表本次**删过行**且守恒成立（有信息量），
    //   ② 这张表本次造了行但**一行都没删**（`deleted = ownDeleted = 0`，守恒式两边都是 0 ⇒ 恒成立、零信息）。
    //   第九程 `守恒通过=190` —— 按日志推：报过删除的 26 张（手写清单）+ 兜底清扫 3 张 − 没被问过的 2 张
    //   ⇒ ① 大约只有 27 张，其余是 ②；读者却会把 190 当成"190 张被我核过"。⇒ 这个 27 是**我推的**，
    //   第十程起由这一格自己打印两个数来确认（确认之前它只是口径，不是读数）。
    let bucket = deleted > 0 ? 'passedDeleted' : 'passedIdle';
    if (deleted > 0 && !asked.has(m)) {
      unattributed.push({ model: m, deleted });
      bucket = 'unasked';
    } else if (deleted > 0 && deleted > ownDeleted) {
      if (ownDeleted === 0 && knows.has(m)) {
        instrumentSuspect.push({ model: m, deleted });
        bucket = 'suspect';
      } else {
        overDeleted.push({ model: m, deleted, attributable: ownDeleted });
        bucket = 'over';
      }
    } else if (alive > 0) {
      bucket = 'residue';
    }
    disposition.push({ model: m, bucket, deleted, created, alive });
  }
  return { residue, overDeleted, unattributed, instrumentSuspect, disposition };
}

/**
 * 按 run 时间窗数"本次创建的行"。模型没有 createdAt 列 ⇒ 进 `blind`（**不可归因**，不许静默通过）；
 * count 抛错同样进 `blind`（复核 #14 I-1：不能把测量失败写成"你删多了"的指控）。
 */
export async function countCreatedInWindow({ prisma, Prisma, since }) {
  const models = (Prisma?.dmmf?.datamodel?.models) ?? [];
  const counts = {};
  const blind = [];
  const byType = { DateTime: 0, BigInt: 0, 无createdAt: 0, 取数失败: 0 };
  // ★ 复核 #15：本库 createdAt 有**两种类型**（DateTime 57 个 / BigInt 133 个，实测样本 13 位＝epoch 毫秒）。
  //   原先只认 `type === 'DateTime'` ⇒ 133 张**明明有这列**的表被判成"结构性不可归因"，
  //   既少了一大块可覆盖面，也让台账把"要补列"的范围说大了近四倍。
  const ts = since instanceof Date ? since.getTime() : Number.NaN;
  for (const modelDef of models) {
    const key = modelDef.name.charAt(0).toLowerCase() + modelDef.name.slice(1);
    const delegate = prisma?.[key];
    const cf = (modelDef.fields || []).find((f) => f.name === 'createdAt');
    const kind = cf && (cf.type === 'DateTime' || cf.type === 'BigInt') ? cf.type : null;
    if (!kind || !delegate || typeof delegate.count !== 'function') {
      blind.push(modelDef.name);
      byType[kind ? '取数失败' : '无createdAt'] += 1;
      continue;
    }
    try {
      const bound = kind === 'BigInt' ? BigInt(ts) : since;
      counts[modelDef.name] = await delegate.count({ where: { createdAt: { gte: bound } } });
      byType[kind] += 1;
    } catch { blind.push(modelDef.name); byType['取数失败'] += 1; }
  }
  return { counts, blind, enumerated: models.length, byType };
}

/**
 * ★ v3.64（B170）「比前后主键集合」的归因层 —— v3.51 起名、v3.57 定为唯一剩余出路。
 *   为什么必须有它：`createdAt` 这条路对**没有这一列的模型**结构性不存在，而链按 id 删过行的
 *   `OrderLine` / `Relation` 恰恰在里面 ⇒ 它们今天只是"没被问过"，既不算残留也不算通过。
 *   分母**不写手写清单**：由 DMMF 枚举"无可用 createdAt"的全集（现量 33 张、合计 1381 行、
 *   id ≈40KB ⇒ 前后各取一次 <1s ⇒ 没有任何收窄分母的理由）。
 *   ★ A1（2026-09-25）前这三个数是 35 张 / 1502 行 / ≈42KB —— OrderLine 与 Relation 补列后各降一档（实测）。
 *   ⚠️ 只许在真跑（跑手串行）窗口里调用：门禁套件自己会删 `businessSequence`
 *   （`server/src/__tests__/businessNumberService.test.ts:26,133`）⇒ 塞进门禁就是每轮必红。
 */
export async function snapshotIdSets({ prisma, Prisma }) {
  const models = (Prisma?.dmmf?.datamodel?.models) ?? [];
  const needs = models.filter((m) => {
    const cf = (m.fields || []).find((f) => f.name === 'createdAt');
    return !(cf && (cf.type === 'DateTime' || cf.type === 'BigInt'));
  });
  const sets = {};
  const unreadable = [];
  const badShape = [];
  for (const m of needs) {
    const pks = (m.fields || []).filter((f) => f.isId);
    // 主键形状不合的**不猜**（复合主键 / id 不叫 id / 非 String）：单列现形。现量 0 张，
    // 但"0"必须是量出来的，不能是"我以为不会遇到"。
    if (pks.length !== 1 || pks[0].name !== 'id' || pks[0].type !== 'String') {
      // ★ 复核 #16：形状不合也带表名 —— 覆盖对账要按名计数，字符串那版解析不出是哪张。
      badShape.push({ model: m.name,
        why: pks.length === 1 ? `主键 ${pks[0].name}:${pks[0].type}（不叫 id 或非 String）` : `${pks.length} 个主键（复合主键）` });
      continue;
    }
    const delegate = prisma?.[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
    if (!delegate || typeof delegate.findMany !== 'function') { unreadable.push(m.name); continue; }
    try {
      const rows = await delegate.findMany({ select: { id: true } });
      sets[m.name] = new Set(rows.map((x) => String(x.id)));
    } catch { unreadable.push(m.name); }
  }
  return { sets, unreadable, badShape, enumerated: needs.length };
}

/**
 * 纯函数：pre / post 两份 `Map<model, Set<id>>` 差分。**两条读数方向不同，不许合并**：
 *  - `created`（post∖pre）＝这一程期间出现、清理后仍活着 ⇒ 逐行点名的残留（比标量强）。
 *  - `vanished`（pre∖post）＝基线行不见了 ⇒ **单独一档，绝不并进 overDeleted 指控**：本机库与
 *    主 checkout 的常驻服务共享，删账号（`admin/route.ts:338`）、验证码过期、agent 任务清理
 *    都落在这里 ⇒ 拿它指控"我删多了"就是第四程那 24 条伪指控的重演。
 *  - 只有一侧有这张表 ⇒ 记 `skipped` 并写明原因，**不许塌成"没有新增"**（那等于把测量失败读成干净）。
 */
export function pkDiff({ pre, post, maxIds = 6 } = {}) {
  const created = [];
  const vanished = [];
  const skipped = [];
  let compared = 0;
  const models = new Set([...Object.keys(pre || {}), ...Object.keys(post || {})]);
  for (const m of [...models].sort()) {
    const a = pre?.[m];
    const b = post?.[m];
    if (!a || !b) {
      skipped.push({ model: m,
        why: !a && !b ? '两侧都没有' : !a ? '缺跑前快照 ⇒ 来不及归因，不许 retro 造基线' : '缺跑后快照 ⇒ 读不到' });
      continue;
    }
    const added = [...b].filter((id) => !a.has(id));
    const gone = [...a].filter((id) => !b.has(id));
    compared += 1;
    if (added.length) created.push({ model: m, n: added.length, ids: added.slice(0, maxIds) });
    if (gone.length) vanished.push({ model: m, n: gone.length, ids: gone.slice(0, maxIds) });
  }
  // ★ v3.65（B174）：`compared` 只数**两侧都有快照、真的逐行比过**的那几张。
  //   原先写成 `models.size`（并集）＝把"只有一侧、当场记为不对称"的表也算进分母
  //   ⇒ 分母宽于证据面，而它正是这一层要拿去与 `pkEnumerated` 对撞的那个数。
  // ★ 复核 #16：`skipped` 从字符串改成 `{model, why}` —— 覆盖对账要拿它**按名计数**
  //   （`已比对 + 点名的未覆盖 + 漂移槽 == 枚举`），字符串那版没法安全解析出表名。
  //   原先随 `compared` 一起返回的 `enumeratedUnion` 被删：它没有运行时读者，
  //   而"算了没人读"恰恰是 B174 指控的那件事 ⇒ 不许自己一边指控一边留一份。
  return { created, vanished, skipped, compared };
}

/**
 * ★ v3.70（B178）逐主键守恒 —— 把"我删了哪几行"与"跑前就有哪几行"**直接对撞**，不再经过窗口计数。
 *   为什么必须换：窗口计数那一路只要**少数一行**（造 3 报 2），守恒式就把 4 行删除报成
 *   "删面宽于本次写入"（复核 #16 IMPORTANT-5 实测）⇒ 那是拿一个可错的中间量当证人。
 *   本函数只看两件事：① 这一行的 `createdAt` 早于本次运行起点吗？② 跑前主键快照里有这个 id 吗？
 *   ⇒ 两个问法都**不需要总数**，因此成对误差（留一行 + 多删一行）在这里没有互相抵消的通道。
 * ⚠️ 边界（写进读数，不许悄悄放宽）：
 *  - `ts === null`（没给运行起点）⇒ 一行都不许归类，全部进 `unknown`；
 *  - 预读失败 / 没有 `createdAt` 且该表没有跑前主键快照 ⇒ 进 `unknown`（**不许塌成"都是我造的"**）；
 *  - `id ∉ 跑前快照` 只支持一句弱结论："它不是跑前就在的行" ⇒ 够用来**不指控**，
 *    不足以断言"是我造的"（别人本程造的也算），所以 `mine` 这一档的措辞是"非跑前行"。
 */
export function deletedRowAttribution({ deleted = {}, preIds = {}, runStart = null, maxIds = 5, reportedCounts = {} } = {}) {
  const toMs = (v) => {
    if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
    if (typeof v === 'bigint') { const n = Number(v); return n > 1e12 ? n : n * 1000; }  // 本库 BigInt 的 createdAt 实测是 epoch **毫秒**；秒也接住，方向与下一行一致
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;  // 秒/毫秒都接住，方向不许反
    if (typeof v === 'string' && v.trim() !== '') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    return null;
  };
  const ts = runStart === null || runStart === undefined ? null : toMs(runStart);
  const preexisting = [];
  const nonPre = [];
  const unknown = [];
  for (const model of Object.keys(deleted || {}).sort()) {
    const rows = Array.isArray(deleted[model]) ? deleted[model] : null;
    const raw = preIds?.[model];
    const pre = raw instanceof Set ? raw : (Array.isArray(raw) ? new Set(raw.map(String)) : null);
    if (!rows) {   // 预读整表失败 ⇒ 这一张一行都没看见
      // ★ v3.71（B183）：这里必须带上**行数**。第十一程实测 `逐行判不了=3` 被读成"3 行"，
      //   而那是 3 **张表**（`AgentJob/Notification/ProductionStage`，删除侧自报合计 422 行）
      //   ⇒ 计数单位混了行与表，等于把 422 报成 3，少报两个数量级。
      const n = Number.isFinite(reportedCounts?.[model]) ? reportedCounts[model] : null;
      unknown.push({ model, n, why: '预读没有返回行集合（读失败或未接预读）' });
      continue;
    }
    for (const r of rows) {
      const id = String(r?.id ?? '(无 id)');
      const cts = toMs(r?.createdAt);
      if (ts === null) { unknown.push({ model, id, why: '没有运行起点' }); continue; }
      if (cts !== null) {
        (cts < ts ? preexisting : nonPre).push({ model, id });
        continue;
      }
      if (pre) { (pre.has(id) ? preexisting : nonPre).push({ model, id }); continue; }
      unknown.push({ model, id, why: '无 createdAt 也没有跑前主键快照 ⇒ 判不了' });
    }
  }
  const brief = (list) => {
    const by = {};
    for (const x of list) { (by[x.model] = by[x.model] || []).push(x.id); }
    return Object.keys(by).sort().map((m) => `${m}=${by[m].length}${by[m].length <= maxIds ? '[' + by[m].join(',') + ']' : '[' + by[m].slice(0, maxIds).join(',') + ' …]'}`);
  };
  // ★ B183：把"行"和"张表"分开数，覆盖行才不至于拿 3 冒充 422。
  //   整表未读的那些：`n` 是删除侧自报的行数（拿得到就计行，拿不到就只计张并明说）。
  const unknownWhole = unknown.filter((x) => x.id === undefined);
  const unknownRowsKnown = unknownWhole.reduce((a, x) => a + (Number.isFinite(x.n) ? x.n : 0), 0);
  const unknownRowsSilent = unknownWhole.filter((x) => !Number.isFinite(x.n)).length;
  const unknownPerRow = unknown.length - unknownWhole.length;
  return { preexisting, nonPre, unknown,
    unknownRows: unknownPerRow + unknownRowsKnown, unknownWholeTables: unknownWhole.length, unknownRowsSilent,
    preexistingBrief: brief(preexisting), nonPreBrief: brief(nonPre), unknownBrief: brief(unknown),
    counted: Object.values(deleted || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0) };
}

/**
 * ★ v3.77（B187）指控轴的**纯判据**：把"埋进去的行有没有被分成两档"折成一个会红的读数。
 *
 * 为什么必须补这一层（第十四程那个 `删的跑前行=0` 有两种成因，日志里形状完全相同）：
 *   (a) 本次确实没删任何"跑前就在"的行；
 *   (b) **整根时间轴前移了**（时区 / naive DATETIME / 秒与毫秒换算差一档 ⇒ 每一行读起来都在 `runStart` 之后），
 *       于是 `preexisting` 恒空，这根指控**永远哑** —— 而它哑的时候看起来正好是"最干净"的样子。
 * 窗口层与本层**共轴**（同一个 `runStart`、同一条 `toMs`），所以窗口那一侧不构成第二证人；
 * 能分开 (a)(b) 的唯一办法是真的埋一行"跑前就在"的行再删掉它，看这根轴会不会响 ⇒ 就是本判据要吃的那次埋删。
 *
 * 两向 × 两条通路（少任一个方向就是一个半个证人：只验"能响"会被"恒 preexisting"糊过去，
 * 只验"不乱响"会被"恒 nonPre"糊过去 —— 后者正是 (b) 的形状）：
 *  - `createdAt` 通路：每档埋一对（早 `sec` / 晚 `sec`），分别必须进 `preexisting` / `nonPre`；
 *  - `preId` 通路：把行喂成**没有 createdAt**，只靠"跑前主键快照里有这个 id"分类 ——
 *    那 33 张"没有可用 createdAt"的表走的就是这一条，它同样要"能响"与"不乱响"两个方向（固定一对，`sec=0`）。
 *
 * ⚠️ 分辨率（★ v3.79 起：这句由 `axisResolutionGrid` 逐秒扫出来，不再由散文推断；
 *   ★ v3.81 起：两侧各自报，不再"按保守侧 ±最小档说"那句合并口径——它把已量到的不对称又抹平了）：
 *   · 向"起点变早"推移：要推满一个最小档（现取 120s）才会让显式埋的跑前行不再早于起点 ⇒ 边界 = 最小档，
 *     这一侧的"边界"完全由**我自己选的埋点间距**决定，换个间距就换个数字；
 *   · 向"起点变晚"推移：`defaulted` 那一行被误指控 ⇒ 网格给 +1s，但那是"零耗时"理想形状；
 *     真跑里该臂的落点晚于起点多少毫秒，这一侧的哑区就是多少毫秒（第十六程 = 55882ms，其中绝大部分是演练耗时）。
 *   两句都必须随读数上屏，否则"正对照通过"会被读成"轴在任何尺度上都可信"。
 *
 * @param {object} o
 * @param {number[]} o.offsetsSec `createdAt` 通用的档位（秒），要求 ≥2 个不同正值
 * @param {number|null} o.runStartMs 本次运行起点（epoch ms）
 * @param {Array<{id:string,path:'createdAt'|'preId',role:'past'|'notpast'|'defaulted',sec:number,gotMs?:number|null,anchorMs?:number,anchorNotAfterMs?:number}>} o.pairs 实际埋删的落点
 *        （`defaulted` 那一臂带本机时间区间 `[anchorMs, anchorNotAfterMs]` = "我发起事务之前"到"我插入之前"，见 v3.81/B200）
 * @param {object|null} o.attribution `deletedRowAttribution` 的返回（判据本体，不重写）
 * @param {number|null} o.leftover 清理后仍活着的**自己埋的**行数
 */
export function axisControlVerdict({ offsetsSec = [], runStartMs = null, pairs = [], attribution = null, leftover = null } = {}) {
  const reasons = [];
  const secs = [...new Set((Array.isArray(offsetsSec) ? offsetsSec : [])
    .filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
  if (secs.length < 2) {
    reasons.push(`档位只剩 ${secs.length} 档 ⇒ 一档只能证明"这一次没退化"，证不了这根轴有分辨力（要 ≥2 档撑分辨率）`);
  }
  if (!(Number.isFinite(runStartMs) && runStartMs > 0)) {
    reasons.push('runStart 不是有效时刻 ⇒ "跑前"这个概念无从判定');
  }
  if (!attribution || typeof attribution !== 'object') {
    reasons.push('没有 attribution ⇒ 分类根本没跑过（不许把"没跑"读成"没响"）');
  }
  const list = Array.isArray(pairs) ? pairs : [];
  const need = [];
  for (const sec of secs) for (const role of ['past', 'notpast']) need.push(`createdAt|${sec}|${role}`);
  for (const role of ['past', 'notpast']) need.push(`preId|0|${role}`);
  // ★ v3.79（复核 #20 MAJOR-4）：上面那些行的 `createdAt` 都是我**显式写进去**的 ⇒ 它们证不了
  //   "库自己给的默认时间戳"落在同一根轴上（`DEFAULT CURRENT_TIMESTAMP` + naive `TIMESTAMP(3)` + 会话时区
  //   正是"整根轴平移几小时"最真实的成因）。所以必须再埋一行**不传 createdAt** 的行，读回来比对。
  need.push('createdAt|0|defaulted');
  const keyOf = (p) => `${p.path}|${p.sec}|${p.role}`;
  const seen = new Set();
  for (const p of list) if (p && p.id && need.includes(keyOf(p))) seen.add(keyOf(p));
  const missing = need.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    reasons.push(`埋删计划缺 ${missing.length} 个落点（${missing.slice(0, 6).join(', ')}）⇒ 三个方向没有配齐，这一程不作数`);
  }
  const myIds = new Set(list.map((p) => String(p.id)));
  const inSet = (k) => new Set(((attribution && attribution[k]) || []).map((x) => String(x.id)));
  const pre = inSet('preexisting');
  const non = inSet('nonPre');
  const unk = inSet('unknown');
  const tolMs = (secs.length > 0 ? Math.min(...secs) : 0) * 1000;
  for (const p of list) {
    if (!p || !p.id) continue;
    const id = String(p.id);
    const got = Number.isFinite(p.gotMs) ? p.gotMs : null;
    if (p.path === 'createdAt') {
      // 写入/读回这一路的检查与"判据有没有点名"是**两种失效方式**，必须分开出声：
      // 前者坏了说明埋进去的时间就不是我要的那个时间（时区/精度），后者坏了才是分类器的问题。
      if (got === null) {
        reasons.push(`${p.path}/${p.role}@${p.sec}s 读不回 createdAt ⇒ 埋这一行没成功`);
      } else if (p.role === 'past' && !(got < runStartMs)) {
        reasons.push(`埋进去的"跑前行"读回来落在 runStart **之后** ${((got - runStartMs) / 1000).toFixed(1)}s`
          + ' ⇒ 坏的是写入/读回这一路（时区或精度），还轮不到判据背锅');
      } else if (p.role === 'notpast' && !(got >= runStartMs)) {
        reasons.push(`埋进去的"跑后行"读回来落在 runStart **之前** ${((runStartMs - got) / 1000).toFixed(1)}s`
          + ' ⇒ 同一族：写入/读回这一路把时间挪了档');
      } else if (p.role === 'defaulted') {
        // ★ v3.79（复核 #20 MAJOR-4）：这一行**不传 createdAt**，时间由库的 `DEFAULT CURRENT_TIMESTAMP` 给
        //   ⇒ 它量的是"库给的时刻 vs 本机时刻"（naive `TIMESTAMP(3)` + 会话时区 + 两台机器的时钟偏差都落在这上面）。
        // ★★ v3.81（复核 #22 MJ-2 / B200）：**判定的锚点必须是本机自己给出的时间区间，不能是 `runStart`。**
        //   第十六程真跑量到的 `defaultedDevMs = 55882ms` 不是时钟偏差，而是**演练自己跑到那一臂花了 55.9 秒**
        //   （链内 runStart 是整场演练的起点）。拿它跟 ±最小档（120s）比 ⇒ 演练只要慢过 120 秒，
        //   这一臂就必然为"测试跑得慢"报"整根轴平移"，把整程打成不可采信——那是伪红，与它想防的事毫无关系。
        //   为什么是**区间**而不是一个点：Postgres 的 `CURRENT_TIMESTAMP` = 事务开始时刻，
        //   所以库给的值天然早于"我这行插入前一刻"，早多少取决于这一程在事务里跑了多久 ⇒
        //   下界取"我发起事务之前"、上界取"我插入之前"，库的时刻落在区间内 = 时钟一致（区间宽只说明这一程没白等），
        //   落在区间外才算平移。与 runStart 的差照旧**报出**（它决定正向哑区有多大），但不参与判定。
        const a0 = Number.isFinite(p.anchorMs) ? p.anchorMs : null;
        const a1 = Number.isFinite(p.anchorNotAfterMs) ? p.anchorNotAfterMs : a0;
        const outside = a0 === null ? null : (got < a0 ? a0 - got : (got > a1 ? got - a1 : 0));
        if (a0 !== null && outside !== null && outside > tolMs) {
          reasons.push(`库侧 DEFAULT 给的时刻落在"本机 [事务前, 插入前] 区间"之外 ${(outside / 1000).toFixed(1)}s`
            + `（区间宽 ${((a1 - a0) / 1000).toFixed(1)}s，容差 ±${tolMs / 1000}s）`
            + `；ΔrunStart=${((got - runStartMs) / 1000).toFixed(1)}s（这个差混着**演练跑到那一臂的耗时**，不参与判定）`
            + ' ⇒ 这才是"整根轴平移"的真实形状：显式写时间的那几行看不出来，只有让库自己给时间才现形');
        }
        if (a0 === null) {
          // 缺锚点不许悄悄退回 runStart 判（那正是 B200 那个错的样子）⇒ 明说这一项没按设计量到
          reasons.push('defaulted 那一臂没有插入锚点（anchorMs/anchorNotAfterMs）⇒ 只能对 runStart 算 Δ，'
            + '而那个差混进了演练耗时（B200）：本程这一项**不作时钟一致性的证据**');
        }
      }
    }
    const wantPre = p.role === 'past';
    const label = p.role === 'past' ? '"跑前行"' : (p.role === 'defaulted' ? '"库侧默认时间戳那行"' : '"跑后行"');
    if (unk.has(id)) {
      reasons.push(`${p.path}/${p.role}@${p.sec}s 落进"判不了"⇒ 这条分类通路整条没接上（既没指控也没放行）`);
    } else if (wantPre && !pre.has(id)) {
      reasons.push(`★ 指控哑了：${p.path} 通路埋的${label}（${p.sec ? `早 ${p.sec}s` : 'id 在跑前快照里'}）没进"删的跑前行"`
        + ' ⇒ 这根轴会把"真多删了跑前行的行"读成 0');
    } else if (!wantPre && !non.has(id)) {
      reasons.push(`★ 指控乱响：${p.path} 通路的${label}（${p.sec ? `晚 ${p.sec}s` : 'id 不在跑前快照里'}）被点成"删了跑前就在的行"`);
    }
  }
  if (!(Number.isFinite(leftover) && leftover === 0)) {
    reasons.push(`事务外回读到自己埋的行还剩 ${leftover === null || leftover === undefined ? '未回读（等于不知道）' : leftover} 行`
      + ' ⇒ 回滚没生效，正对照自己成了残留源，这一程不许据它下任何结论');
  }
  const preMine = [...pre].filter((id) => myIds.has(id)).length;
  const nonMine = [...non].filter((id) => myIds.has(id)).length;
  return { ran: true, ok: reasons.length === 0,
    resolutionSec: secs.length > 0 ? Math.min(...secs) : null,
    offsetsSec: secs, reasons,
    planted: list.length, preexistingMine: preMine, nonPreMine: nonMine, unknownMine: [...unk].filter((id) => myIds.has(id)).length,
    leftover: Number.isFinite(leftover) ? leftover : null };
}

/**
 * ★ v3.79（复核 #20 MINOR-7）：这把尺"能检多大的整轴位移"从此是**扫出来的**，不是散文里推的。
 *
 * 为什么要单独扫：v3.78 我在台账、CLI、判决明细三处都写着"±120s 以内的整轴漂移检不出"，
 *   而当时只量过 −60s 与 +120s **两个点**。逐秒扫完才发现两侧**不对称**：
 *     · 向"起点变早"推移：要推满一个最小档，显式埋的"跑前行"才会不再早于起点 ⇒ 边界 = 最小档；
 *     · 向"起点变晚"推移：`defaulted` 那一行的锚点是"库给的本机此刻"，起点一旦晚于它，它立刻被误指控 ⇒ 边界紧贴 0。
 *   ⇒ 那句"检不出"只在单侧成立，而我当时把它写成了双侧。这里把它换成量出来的两个边界。
 *
 * 不连库、不读时钟：行集与 `runAccusationAxisControl` 同形状（每档一对早/晚 + 固定 preId 一对 + 一行库侧 DEFAULT），
 *   位移只施加在 `runStart` 上（"整根轴前移/后移"就是这个形状）；分类交给仓内那一份 `deletedRowAttribution`、
 *   判定交给仓内那一份 `axisControlVerdict` ⇒ 本函数不重写任何判据，只负责推移与找边界。
 *
 * @param {object} o
 * @param {number[]} o.offsetsSec 与那次埋删同一组档位（缺一档都会让网格与实跑不同形）
 * @param {number} [o.maxSteps] 每一侧最多扫多少秒；**扫不到边界就报 null**，不许外推成"更大也不会响"
 */
export function axisResolutionGrid({ offsetsSec = [], maxSteps = null } = {}) {
  const secs = [...new Set((Array.isArray(offsetsSec) ? offsetsSec : [])
    .filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
  if (secs.length < 2) return { ok: false, reason: `档位只有 ${secs.length} 个 ⇒ 网格无从扫（要 ≥2 档）` };
  const minTier = Math.min(...secs);
  const limit = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : minTier * 2;
  const ANCHOR = Date.UTC(2026, 0, 1);   // 固定锚：读时钟会让同一枚提交两次跑出两个边界
  const rows = [];
  for (const sec of secs) {
    rows.push({ id: `P${sec}`, path: 'createdAt', role: 'past', sec, at: ANCHOR - sec * 1000 });
    rows.push({ id: `N${sec}`, path: 'createdAt', role: 'notpast', sec, at: ANCHOR + sec * 1000 });
  }
  rows.push({ id: 'I_P', path: 'preId', role: 'past', sec: 0, at: ANCHOR });
  rows.push({ id: 'I_N', path: 'preId', role: 'notpast', sec: 0, at: ANCHOR });
  rows.push({ id: 'C_D', path: 'createdAt', role: 'defaulted', sec: 0, at: ANCHOR });
  const probe = (skewSec) => {
    const ts = ANCHOR + skewSec * 1000;
    const attr = deletedRowAttribution({
      deleted: { AgentJob: rows.map((r) => ({ id: r.id, createdAt: r.path === 'createdAt' ? new Date(r.at) : undefined })) },
      preIds: { AgentJob: new Set(['I_P']) },
      runStart: new Date(ts),
      reportedCounts: { AgentJob: rows.length },
    });
    return axisControlVerdict({
      offsetsSec: secs, runStartMs: ts,
      pairs: rows.map((r) => ({ id: r.id, path: r.path, role: r.role, sec: r.sec, gotMs: r.at,
        // ★ v3.81（B200）：网格里的 `defaulted` 臂带一个**零宽区间**锚点 —— 它建模的是"演练一上来就跑这一臂"。
        //   真跑的区间宽 = `defaultedElapsedMs`，正向哑区比这里的 +1s 更宽，那一半由实测那一项说。
        anchorMs: r.role === 'defaulted' ? ANCHOR : undefined,
        anchorNotAfterMs: r.role === 'defaulted' ? ANCHOR : undefined })),
      attribution: attr, leftover: 0,
    });
  };
  const findEdge = (sign) => {
    for (let s = 1; s <= limit; s += 1) if (!probe(sign * s).ok) return s;
    return null;
  };
  const neg = findEdge(-1);
  const pos = findEdge(1);
  return {
    ok: true, minTierSec: minTier, scannedSec: limit, probes: limit * 2 + 1,
    caughtAtOrAfterNegSec: neg, silentNegSec: neg === null ? null : neg - 1,
    caughtAtOrAfterPosSec: pos, silentPosSec: pos === null ? null : pos - 1,
    zeroOk: probe(0).ok,
  };
}

/**
 * 边界措辞只留这一份实现（v3.79 之前 CLI 与判决明细各抄了一句，于是"单侧结论"被抄成了两处双侧断言）。
 * 网格缺失时必须承认"没量过"，**不许回退**成旧的"±Ns 以内检不出"——那句是量过之后才成立的，而没量过的时候它比真相说得多。
 */
export function axisResolutionCaveat(grid, o = {}) {
  if (!grid || grid.ok !== true) {
    return `分辨率边界未量${grid && grid.reason ? `（${grid.reason}）` : '（没跑网格）'}`
      + ' ⇒ 这一程不许报出任何"能检多大位移"的数字：v3.78 那句是只量了两个点就写成双侧结论的，从此只许由网格给出';
  }
  const neg = grid.caughtAtOrAfterNegSec;
  const pos = grid.caughtAtOrAfterPosSec;
  const negTxt = neg === null
    ? `扫到 ${grid.scannedSec}s 仍未越界（只说明 ≤${grid.scannedSec}s 全哑，不说明更大处会响）`
    : `到 −${neg}s 才响 ⇒ −${grid.silentNegSec}s 以内哑`;
  const posTxt = pos === null
    ? `扫到 ${grid.scannedSec}s 仍不响`
    : `+${pos}s 就响（defaulted 那一臂钉在本机给出的时间区间内，而网格给的区间是**零宽**）`;
  const dev = Number.isFinite(o.defaultedDevMs) ? o.defaultedDevMs : null;
  const el = Number.isFinite(o.defaultedElapsedMs) ? o.defaultedElapsedMs : null;
  const cd = Number.isFinite(o.defaultedClockDevMs) ? o.defaultedClockDevMs : null;
  const lead = Number.isFinite(o.defaultedLeadMs) ? o.defaultedLeadMs : null;
  const inTx = Number.isFinite(o.defaultedInTxMs) ? o.defaultedInTxMs : null;
  const tolMs = grid.minTierSec * 1000;
  // ★ v3.82（复核 #23 M2）：把"这一臂到底要偏多少才响"说成一个数，而不是留下"±最小档"这个乐观口径。
  //   判据是 `区间外距离 > ±容差`，而区间本身宽 `el`（= 演练跑到那一臂的耗时）⇒ 实际下界 = 容差 + 区间宽。
  const effBandTxt = (dev === null || el === null)
    ? ''
    : ` 本程这一臂的**实际可检下界两侧不对称**：库比本机**慢**那一侧仍是 ±${tolMs / 1000}s`
      + `（该臂排在最前 ⇒ 落点早于区间下界就立刻越界，与区间宽无关）；`
      + `库比本机**快**那一侧是 ±(${tolMs} + 区间宽 ${el})ms = ${tolMs + el}ms`
      + `（要越过区间上界才响 ⇒ 区间越宽这把尺越钝，所以驱动把 defaulted 排在最前）。`
      + (el > tolMs
        ? ` ⇒ ★ 区间宽已超过容差 ⇒ "库比本机快多少才响"这一侧的盲区是秒级以上，不许把 ±${grid.minTierSec}s 当本程分辨率读。`
        : ` ⇒ 这一程区间宽没超过容差，快侧的下界仍由 ±${grid.minTierSec}s 主导。`);
  return `网格边界（★ 这里的自变量是**我自己选的档位与埋点形状**，证的是分类器的边界算符，不是这根轴的真实分辨率）：`
    + `变早一侧 ${negTxt}——这一侧的边界**恒等于最小档 ${grid.minTierSec}s**，把它叫"实测分辨率"就是把我的埋点间距换个写法；`
    + `变晚一侧 ${posTxt}（网格是秒粒度）。`
    + (dev === null
      ? ' 本程没量到"库给的时刻与本机起点"的间距 ⇒ 真实正侧哑区**未量**。'
      // ★ v3.81（B200）：这里从此分多个量报，不再拿"演练耗时"冒充"时钟偏差"；
      //   ★ v3.85（复核 #24）：v3.81 那时是三个，B204 之后是**五个**（落点间距／起跑耗时／事务内偏移／区间宽／时钟偏差）。
      : ` 本程该臂落点晚于本机起点 ${dev}ms `
        // ★ 只在**真的相加等于**时才用等号；不自洽时改成"⇒"，因为那一行不能长得像等式（B204 的形状就是
        //   "看起来像拆解、加起来不等"）——覆盖行与 CLI 走同一份 decompositionPhrase，三处同步。
        + (lead !== null && inTx !== null && dev === lead + inTx ? '= ' : '⇒ ')
        + decompositionPhrase({ devMs: dev, leadMs: lead, inTxMs: inTx })
        + (dev !== null && lead !== null && inTx !== null && lead + inTx === dev
          ? '（起跑耗时＝本程起点 → 我发起那次事务之前；两项相加必须等于上面那个数，判决自己重算这条恒等式）。'
          : '。')
        + ` 其中区间宽 ${el === null ? '未量' : `${el}ms`}、到区间外侧的距离（＝应用与库的时钟/时区偏差）`
        + ` ${cd === null ? '未量' : `${cd}ms`}。`
        + ` ★ v3.82 及更早这里写的是"= 演练耗时 + 时钟偏差"，而那两个数加起来**不等**（第十七程真跑打印过 54634 = 0 + 1 这种式子）`
        + ` ⇒ 见 §9 **B204**；那一句把"区间宽"错叫成"演练耗时"，真正解释间距的起跑耗时当时根本没有字段。`
        + ` 归因用的是严格 createdAt < runStart ⇒ 落点早于起点 1ms 就当场报"指控乱响"；`
        + `而落点要先"早于起点"得吃掉上面那 ${dev}ms ⇒ **这一臂检不出的整轴慢移就是 ${dev}ms**，`
        + `网格那句 +${pos ?? '?'}s 只是零耗时理想形状下的下界，不许拿它当本程的分辨率。`)
    + (cd === null
      ? ' 应用↔库的时钟/会话时区偏移本程没量到（该臂缺本机区间锚点）⇒ 不许据它说偏移有多大或多小。'
      : ` 应用↔库的时钟/会话时区偏移本程量到 ${cd}ms（库给的时刻到本机区间外侧的距离，落在区间内记 0）`
        + `⇒ 它给的是"偏移不超过区间宽"这一侧的上界；要把这个数测准得让库与本机**同刻**读时钟（未做）。`)
    + effBandTxt
    + ' 要量"最小可检偏移"还缺一味药：真实被删行 `createdAt` 与 `runStart` 的实际最近间距（未量）。';
}

/**
 * ★ v3.77（B187）埋与读：**一次回滚事务里的真库往返**，看指控轴分不分得开两档。
 *
 * 判据不重写：分类直接调仓内那一份 `deletedRowAttribution`（同一个实现、同一条 `toMs`），
 * 免得这里成了第二套真源（本仓头号病）。
 *
 * ★★ 为什么是"回滚事务"而不是"造完再删掉"（本批被自己的尺教了一次）：
 *   第一版按显式 id `deleteMany` 收尾，root 门禁的 B120 那把尺当场把它抓住——
 *   `手写 deleteMany 却没被冻结 ⇒ 只许降的基线漏了条目：["scripts/lib/acceptance-selfcheck.mjs"]`。
 *   那条基线的规矩是"**升就是动删除面，先过 §12.1 第 27 条**"，而红线写着"不擅自动删除面"。
 *   ⇒ 正解不是把 216 抬成 218 然后自称"只删了自己的行"，而是**让这一程根本没有持久写入**：
 *   这些落点（v3.79 起是 7 个臂）全部住在同一个 `$transaction` 里，读完就 `throw` 回滚，事务外回读必须为 0 行。
 *   被验的对象没缩水：轴的可疑之处是**写入/读回的时间**（列类型、驱动、会话时区、秒与毫秒），
 *   而这些都在"INSERT 落列 + SELECT 回读"那一步现形，与是否提交无关；
 *   `DELETE` 语句本身是不是删得准，由守恒式与两通道对账管（不是这根尺的职责）。
 * ⚠️ 边界（写进读数，不许悄悄放宽）：本对照**不**验跨连接读取——若同一 client 的连接池给出
 *   不同会话时区，这里看不见（链上取数与回读共用同一个 client，所以本程不构成盲区）。
 *   哨兵 `status`：实测 `agent/jobs.ts:claimNext()` 会领走任何 `status:'queued'` 的行、
 *   `retryLinkages.ts` 会重放 `jobType` 以 `bev:` 开头的 queued 行 ⇒ 未提交行外面看不见，
 *   但我仍然不用 `queued`，免得回滚前那一瞬被常驻服务抢先领走（那是我在制造不可复现的竞态）。
 *
 * @param {object} o
 * @param {object} o.prisma 已连好的 client（演练链自己那份 ⇒ 与判决同一个库）
 * @param {{host?:string|null,name?:string|null}} [o.db] readDbTarget 的读数；给了就**再验一遍**本机红线
 * @param {Date|number} o.runStart 本次运行起点
 * @param {string} [o.model='AgentJob'] 归因输入用的模型名（键）
 * @param {string} [o.delegateKey='agentJob'] client 上的委托名
 * @param {number[]} [o.offsetsSec=[120,86400]] 两档：细档定分辨率、粗档盯量级（秒/毫秒换算、跨日整档）
 */
export async function runAccusationAxisControl({ prisma, db = null, runStart = null, model = 'AgentJob', delegateKey = 'agentJob',
  offsetsSec = [120, 86400], marker = 'AXISCTRL', log = null } = {}) {
  const bail = (why) => ({ ran: false, ok: false, reasons: [why], resolutionSec: null, offsetsSec: [], planted: 0, leftover: null });
  if (!prisma) return bail('没有 prisma client ⇒ 正对照没跑（这一程的"删的跑前行=0"因此不可读成"没多删"）');
  if (typeof prisma.$transaction !== 'function') {
    return bail(`这个 client 没有 \$transaction ⇒ 正对照无法保证"零持久写入"，拒跑`
      + '（要跑它就得动删除面，那属 §12.1 第 27 条的人判读地界，不由我自决）');
  }
  if (!prisma[delegateKey] || typeof prisma[delegateKey].create !== 'function') return bail(`没有可写的委托 prisma.${delegateKey} ⇒ 正对照没跑`);
  const startMs = runStart instanceof Date ? runStart.getTime()
    : (runStart === null || runStart === undefined ? NaN : new Date(runStart).getTime());
  // ★ `Number(null)` 是 0、是"有限数"⇒ 光用 Number.isFinite(Number(runStart)) 会把"没给起点"读成"1970 年"，
  //   于是这根轴拿着一个假起点照样跑绿（v3.77 自己写的证人当场把这一格演红了：null 一路滑到读库才炸）。
  if (!Number.isFinite(startMs)) return bail('runStart 缺失或不是有效时刻 ⇒ 正对照没跑（不猜起点，更不猜 1970）');
  // ★ 起点的**合理性带**：窗口若离现在太远（含 `runStart=0` 那种"1970 年"），埋进去的"跑前行"也会落在
  //   起点之后 ⇒ 这根轴只会给出一种答案（全"非跑前"），而那与"永远哑"**同形**——正是本对照要防的形状，
  //   所以它自己也必须被这条带挡住，否则我造了一把只会点头的尺。
  const DAY = 86400000;
  if (startMs < Date.now() - 400 * DAY || startMs > Date.now() + 400 * DAY) {
    return bail(`runStart=${new Date(startMs).toISOString()} 距现在超过 400 天 ⇒ 拒跑：窗口一坏，这根轴只剩"全非跑前"一种答法，与"永远哑"同形`);
  }
  if (db && (db.host !== undefined || db.name !== undefined)) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(db.host ?? '')) return bail(`host=${db.host} 非本机 ⇒ 拒绝写库（红线：演练只写本机）`);
    if (!/(local|dev|test)/i.test(db.name ?? '')) return bail(`库名 ${db.name} 不像演练库 ⇒ 拒绝写`);
  }
  const runStartMs = startMs;
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  const plan = [];
  // ★ v3.79（复核 #20 MAJOR-4）：**不传 createdAt** 的那一行 ⇒ 时间由库的 DEFAULT 给，读回来与本程起点比
  // ★ v3.82（复核 #23 M2）：这一臂从此**排在最前**。顺序是有牙的：库给的 `CURRENT_TIMESTAMP` 是**事务开始**
  //   时刻，而我给它的上界是"我插入这一行之前"⇒ 区间宽 = 它前面那些插入的耗时。
  //   能检出的时钟偏差 = ±容差 + 区间宽 ⇒ 排在最后等于让演练自己的长度撑大这把尺的盲区
  //   （第十六程那 55.9 秒若落在区间内，就是"声明 ±120s、实际要慢过 176s 才响"）。
  plan.push({ id: `${marker}_D_${rnd}`, path: 'createdAt', role: 'defaulted', sec: 0, createdAt: undefined });
  for (const sec of offsetsSec) {
    plan.push({ id: `${marker}_C_P${sec}_${rnd}`, path: 'createdAt', role: 'past', sec, createdAt: new Date(runStartMs - sec * 1000) });
    plan.push({ id: `${marker}_C_N${sec}_${rnd}`, path: 'createdAt', role: 'notpast', sec, createdAt: new Date(runStartMs + sec * 1000) });
  }
  plan.push({ id: `${marker}_I_P_${rnd}`, path: 'preId', role: 'past', sec: 0, createdAt: new Date(runStartMs) });
  plan.push({ id: `${marker}_I_N_${rnd}`, path: 'preId', role: 'notpast', sec: 0, createdAt: new Date(runStartMs) });
  const ids = plan.map((p) => p.id);

  let createdRows = 0;
  let rolledBack = false;
  let leftover = null;
  let txError = null;
  const readback = new Map();
  const hardStop = [];
  const ROLLBACK = Symbol('accusation-axis-rollback');
  // ★ v3.81（复核 #22 MJ-2 / B200）：`defaulted` 那一臂的**本机时间区间**。
  //   下界 = 我发起事务之前（Prisma 中间可能还要取连接 ⇒ 真实的事务开始只会更晚，这个界是保守的）；
  //   上界 = 我把那一行插进去之前。库的 `CURRENT_TIMESTAMP` = 事务开始时刻 ⇒ 时钟一致时它必然落在两点之间。
  //   为什么要单独记：区间宽 = "这一程在事务里等了多久"，与"库比应用快/慢多少"是**两个不同的量**，
  //   第十六程把前者当成了后者（`defaultedDevMs=55882ms` 被写成时钟偏差）。
  const dAnchor = { ms: null, notAfterMs: null };
  try {
    dAnchor.ms = Date.now();
    await prisma.$transaction(async (tx) => {
      const d = tx[delegateKey] || prisma[delegateKey];
      for (const p of plan) {
        if (p.role === 'defaulted') dAnchor.notAfterMs = Date.now();
        await d.create({ data: { id: p.id, jobType: 'drill-axis-control', status: 'drill_axis_control',
          payload: { [marker]: p.id, path: p.path, role: p.role, sec: p.sec }, createdAt: p.createdAt } });
        createdRows += 1;
      }
      const got = await d.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } });
      for (const r of got) readback.set(String(r.id), r.createdAt);
      if (got.length !== plan.length) hardStop.push(`事务内回读只拿到 ${got.length}/${plan.length} 行 ⇒ 埋这一步就没成，后面的"轴响没响"无从谈起`);
      rolledBack = true;
      throw ROLLBACK;            // ← 故意不回头的提交点：走到这里就是要让这些行**从未存在过**
    });
    hardStop.push(`事务没有按设计回滚（回调没抛出去 ⇒ 这 ${plan.length} 行可能已经提交了）`);
  } catch (e) {
    if (e !== ROLLBACK) {
      txError = e;
      // ★ v3.81（复核 #22 MJ-3）：光抄 message 会把"哪一种坏"洗成同一句话 —— B199 那次我要归因成
      //   "连接层瞬断"，靠的是自己去看 pg 日志；Prisma 的 `cause.code`（`P1001` 连不上 / `P2028` 事务层…）
      //   本来就在异常对象里 ⇒ 从此把它一起打出来，归因由读数给，不由我猜。
      hardStop.push(`事务抛错（不是那个刻意的回滚哨兵）：${errWithCode(e).slice(0, 200)}`);
    }
  }
  // 事务外回读：必须 0 行 ⇒ 这一格是"零持久写入"的证人（比"删干净了"强，因为它连删都不需要）
  try { leftover = Number(await prisma[delegateKey].count({ where: { id: { in: ids } } })); }
  catch (e) { hardStop.push(`事务外回读失败 ⇒ 不知道有没有留下持久行：${errWithCode(e).slice(0, 120)}`); }
  if (createdRows !== plan.length) hardStop.push(`只埋成 ${createdRows}/${plan.length} 行 ⇒ 两档两向没配齐`);

  // 分类走仓内那一份实现（同一个尺，不是第二套真源）
  const rows = plan.map((p) => ({ id: p.id,
    createdAt: p.path === 'createdAt' ? (readback.get(p.id) ?? null) : undefined }));
  const attr = deletedRowAttribution({
    deleted: { [model]: rows },
    // ★ preId 通路的跑前快照：只有"该被认成跑前"的那一个 id 在里面（另一个是我自己造的、跑前快照没有）
    preIds: { [model]: new Set([`${marker}_I_P_${rnd}`]) },
    runStart: new Date(runStartMs),
    reportedCounts: { [model]: plan.length },
  });
  const pairs = plan.map((p) => {
    const v = readback.get(p.id);
    const t = v instanceof Date ? v.getTime() : (v === undefined || v === null ? null : Date.parse(String(v)));
    return { id: p.id, path: p.path, role: p.role, sec: p.sec, gotMs: Number.isFinite(t) ? t : null,
      // ★ v3.81（B200）：只有"库自己给时间"的那一臂带本机区间锚点（其余臂的时间是我显式写的，没有"锚点"可言）
      ...(p.role === 'defaulted' ? { anchorMs: dAnchor.ms, anchorNotAfterMs: dAnchor.notAfterMs } : {}) };
  });
  const v = axisControlVerdict({ offsetsSec, runStartMs, pairs, attribution: attr, leftover });
  // ★ v3.79（复核 #20 MINOR-7）：边界随读数一起产出来，别让"检不出多大"留给散文
  // ★ v3.80（复核 #21 MA-3/MA-4）：再把**这次往返的原始证据**一起交出去（判决要能自己重算），
  //   并把 `defaulted` 那一行的真实时刻差量出来 —— "+1s 就响"这种话不该由模型猜，得有一个实测 Δ。
  // ★ v3.81（复核 #22 MJ-2 / B200）：那个 Δ 从此是**三个**量，别再让一个数兼任两件事：
  //   · `defaultedDevMs`      = 库给的时刻 − 本程起点 ⇒ 混着"演练跑到那一臂花了多久"，只用来量**正向哑区**
  //   · `defaultedElapsedMs`  = 本机区间宽（发起事务前 → 插入前）⇒ 上面那个混入量本身
  //   · `defaultedClockDevMs` = 库给的时刻到本机区间的**外侧距离** ⇒ 这才是应用↔库时钟/会话时区偏差，区间内为 0
  const dRow = pairs.find((p) => p.role === 'defaulted');
  const defaultedDevMs = dRow && Number.isFinite(dRow.gotMs) ? dRow.gotMs - runStartMs : null;
  const defaultedElapsedMs = Number.isFinite(dAnchor.ms) && Number.isFinite(dAnchor.notAfterMs)
    ? dAnchor.notAfterMs - dAnchor.ms : null;
  let defaultedClockDevMs = null;
  if (dRow && Number.isFinite(dRow.gotMs) && Number.isFinite(dAnchor.ms)) {
    const hi = Number.isFinite(dAnchor.notAfterMs) ? dAnchor.notAfterMs : dAnchor.ms;
    defaultedClockDevMs = dRow.gotMs < dAnchor.ms ? dRow.gotMs - dAnchor.ms : (dRow.gotMs > hi ? dRow.gotMs - hi : 0);
  }
  // ★ v3.83（B204）：第十七程真跑当场把一句**加起来不等**的拆解放上了屏幕——
  //   `落点晚于起点 54634ms … 拆开=演练耗时 0ms + 时钟/时区偏差 1ms`（0+1 ≠ 54634）。
  //   根因是我把"区间宽"叫成了"演练耗时"，而真正解释那个间距的**起跑耗时**（本程起点 → 我发起那次事务之前）
  //   从来没有自己的字段。⇒ 从此两个量都单独交出来，并且恒等式 `落点间距 = 起跑耗时 + 事务内偏移` 由判决重算。
  const defaultedLeadMs = Number.isFinite(dAnchor.ms) ? dAnchor.ms - runStartMs : null;
  const defaultedInTxMs = dRow && Number.isFinite(dRow.gotMs) && Number.isFinite(dAnchor.ms)
    ? dRow.gotMs - dAnchor.ms : null;
  Object.assign(v, {
    evidence: { offsetsSec: v.offsetsSec, runStartMs, pairs, attribution: attr, leftover },
    defaultedDevMs,
    defaultedElapsedMs,
    defaultedClockDevMs,
    defaultedLeadMs,
    defaultedInTxMs,
    grid: axisResolutionGrid({ offsetsSec: v.offsetsSec }),
  });
  Object.assign(v, { rolledBack, createdRows, marker, rnd, txError: txError ? String(txError.message || txError).slice(0, 160) : null });
  if (hardStop.length > 0) { v.ok = false; v.reasons = [...hardStop, ...v.reasons]; }
  if (typeof log === 'function') {
    log(`     指控轴正对照：${v.ok ? '两向都分得开' : '失灵'}（档=${v.offsetsSec.join('/')}s · 最小档=${v.resolutionSec ?? '?'}s（这是档位，不是分辨率） · `
      + `事务内埋 ${createdRows}/${plan.length} 行/到达回滚点 ${rolledBack ? '是' : '否'}/事务外持久残留 ${v.leftover ?? '?'} 行 · `
      + `preexisting 点名 ${v.preexistingMine} 非跑前 ${v.nonPreMine} 判不了 ${v.unknownMine}）`
      + `（${axisResolutionCaveat(v.grid, { defaultedDevMs: v.defaultedDevMs,
        defaultedElapsedMs: v.defaultedElapsedMs, defaultedClockDevMs: v.defaultedClockDevMs,
        defaultedLeadMs: v.defaultedLeadMs, defaultedInTxMs: v.defaultedInTxMs })}）`
      + (v.ok ? '' : ` ⇒ ${v.reasons.join('；').slice(0, 400)}`));
  }
  return v;
}

/**
 * ★ v3.85（复核 #24 M-1）：拆解句**只准由这一份函数拼**。
 *   v3.83 我把"加起来不等就不许印"那道守卫只写进了 `axisResolutionCaveat`，而覆盖行与 CLI 各拼各的
 *   ⇒ 提交标题里点名的那一处（覆盖行）恰恰是没守卫的那一处：复核喂一个不自洽的 `axisControl` 就
 *   让覆盖行印出 `拆开=起跑耗时 0ms + 事务内偏移 1ms`。三处共用一份，守卫才真的覆盖面等于三个印点。
 * @param {object} o { devMs, leadMs, inTxMs }（都可为 null/undefined ⇒ 说"未量"，不猜 0）
 */
export function decompositionPhrase(o = {}) {
  const dev = Number.isFinite(o.devMs) ? o.devMs : null;
  const lead = Number.isFinite(o.leadMs) ? o.leadMs : null;
  const inTx = Number.isFinite(o.inTxMs) ? o.inTxMs : null;
  const f = (v) => (v === null ? '未量' : `${v}ms`);
  if (dev === null) return `起跑耗时 ${f(lead)} + 事务内偏移 ${f(inTx)}（落点间距未量 ⇒ 无从判相加，这一句不作数）`;
  if (lead === null || inTx === null) return `起跑耗时 ${f(lead)} + 事务内偏移 ${f(inTx)}（缺任一半 ⇒ 这条拆解不作数）`;
  if (lead + inTx !== dev) {
    return `★ 拆解不成立：自报 起跑 ${lead}ms + 事务内 ${inTx}ms ≠ 落点间距 ${dev}ms`
      + ` ⇒ 本程只按落点间距那一个数读，拆解两项不作数（§9 **B204**）`;
  }
  return `起跑耗时 ${lead}ms + 事务内偏移 ${inTx}ms`;
}

/**
 * ★ v3.81（复核 #22 MJ-3）：异常 → 一句话，但**把库/驱动给的结构化码带上**。
 *   Prisma 的 `PrismaClientKnownRequestError` 把 `P1001`（连不上）这类码放在 `cause.code` 里，
 *   而 message 常常只剩"Can't reach database server"——两种不同的坏法在纯文本上同形。
 */
function errWithCode(e) {
  const msg = String((e && e.message) || e);
  const codes = [];
  for (const k of ['code']) if (e && typeof e[k] === 'string') codes.push(e[k]);
  const c = e && e.cause;
  if (c) { for (const k of ['code', 'errno', 'sqlState']) if (typeof c[k] === 'string' || typeof c[k] === 'number') codes.push(`${k}=${c[k]}`); }
  return codes.length ? `${msg} [${codes.join(' ')}]` : msg;
}

/**
 * ★ v3.81（复核 #22 MINOR-6）：网格在**退化档位**下会给出 `silentNegSec = 0`（最小档=1s 时）或 `null`
 *   （扫程封顶还没越界）。旧措辞一律写成 `≤−<数>s哑` ⇒ 前者打成"≤−0s哑"、后者经 `num()` 打成"≤−未接s哑"，
 *   两样都像尺坏了，而它们说的是两件不同的事。这里按三种形状分开说。
 */
function negEdgeTxt(g) {
  if (!g || g.ok !== true) return '变早侧=未量';
  const s = g.silentNegSec;
  if (s === null || s === undefined) return `变早侧扫到 ${g.scannedSec}s 仍未越界`;
  if (s === 0) return '变早侧 0s 以内哑（＝1s 就响，这一侧没有哑区）';
  return `变早侧≤−${s}s哑`;
}

/** 规范措辞 = 那份常量的三个值（**没有第四种**，也没有注入口）。 */
export function residueCanonicalLabels() {
  return Object.values(RESIDUE_LABELS);
}

const VERDICTS = new WeakMap();
const REPORTERS = new WeakSet();

export function createReporter({ log = console.log } = {}) {
  const api = {};
  const results = [];
  // ★ v3.41：措辞表**不再可由调用方注入**（复核 #10：`createReporter({canonical:[自造措辞]})` 可绕开守卫）
  const canon = residueCanonicalLabels();
  let residueEmitted = 0;
  const emit = (ok, n, d = '') => {
    const name = String(n);
    if (RESIDUE_CLOSING_TOKENS.test(name)) {
      if (!canon.includes(name)) {
        throw new Error(`B165 越界结论：命中残留族词的句子只能由 lib 的 emitResidueVerdict 发出，`
          + `实际拿到「${name}」⇒ 脚本里有人手写了一句"干净/有残留"，它会与 lib 那条并存（两条真源）`);
      }
      residueEmitted += 1;
      if (residueEmitted > 1) {
        throw new Error(`B165 重复结论：残留族结论已是第 ${residueEmitted} 次（同一条结论不许打两遍）`);
      }
    }
    results.push({ ok, n });
    log(ok === true ? `  ✓ ${n}${d ? ' — ' + d : ''}`
      : ok === false ? `  ✗ ${n} — ${d}` : `  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`);
    return ok;
  };
  Object.assign(api, {
    results,
    pass: (n, d) => emit(true, n, d),
    fail: (n, d) => emit(false, n, d),
    gap: (n, d) => emit(null, n, d),
    residueCount: () => residueEmitted,
    // ★ 复核 #12：判决槽**不暴露写入口**（原先 rep.recordVerdict 是公开的 ⇒ 一句
    //   `rep.recordVerdict({kind:'clean'})` 就能零扫描拿到 exit 0）。现在只有 lib 能写，
    //   键是 reporter 实例本身（WeakMap ⇒ 不阻止回收）。
    verdictKind: () => (VERDICTS.get(self) ? VERDICTS.get(self).kind : null),
    verdictDetail: () => (VERDICTS.get(self) ? VERDICTS.get(self).detail : ''),
  });
  const self = api;
  REPORTERS.add(self);
  return self;
}

/**
 * 判决行**只有一份拼装**（★ B165：上一批脚本里 exit-4 的早退路径自己拼了一句同形的汇总
 *   ⇒ 同一句话两处真源，而且我那条"署名 pin"抓的就是这两处里错的那一处）。
 */
export function verdictLine({ results, residueCount, verdictKind = null, attr, waived, retained = null }) {
  const ok = results.filter((r) => r.ok === true).length;
  const bad = results.filter((r) => r.ok === false).length;
  const gaps = results.filter((r) => r.ok === null).length;
  // 署名与"残留结论数"必须进判决行本身（日志常被单独复制，banner 在开头不等于结论带着走）
  return `\n══ 结果：${ok} 通过 / ${bad} 失败 / ${gaps} 缺口（待口径或未覆盖）`
    + ` · 署名=${attributionVerdict(attr, waived)}`
    // ★ B166：判定与通过数**分开署名** ⇒ 有人再手写一句假干净把通过数灌大，在机器输出里也看得见
    + ` 库=${attr?.db ?? '?'} HEAD=${(attr?.head ?? '').slice(0, 7)} 残留结论=${residueCount} 判定=${verdictKind ?? '无'}`
    // ★ v3.87：Kevin 拍定的「承认来源合法的保留行」在这里落成**单列一格**（见 retainedRowsCell 的三条边界）。
    // 只有调用方交得出带机制证据的 arm 时才出现；一个 arm 都没有 ⇒ 不打这一格（缺席 ≠ 0 行）。
    + (Array.isArray(retained) && retained.length ? ` · ${retainedRowsCell({ arms: retained }).text}` : '')
    + ' ══';
}

/**
 * ★★ v3.87（**Kevin 2026-09-25 拍定「承认来源合法的保留行」的落地**）：把"这些行是有来历、被保留的"与
 *   "这些行是我们没收拾干净的"分成**两格**报，而不是让前者把后者顶掉或反过来。
 *
 * 三条边界全部来自他的原话，缺一条这个函数就不许用：
 *   ① **只认有独立机制证据的** —— `arm.evidence` 必须是非空字符串（机制名/出处，例如"company-sim 生成器
 *      `server/scripts/company-sim/*`、按 `SIM_DATASET_MARKERS` 数"）。凭"我觉得它干净"的 arm **不计入**，
 *      并且会出现在 `refused` 里被点名。
 *   ② **不放松残留定义** —— 本格**不参与** 通过/失败/缺口计数、**不参与** `verdictKind`、**不参与**退出码。
 *      它只是把一行事实打出来（"残留定义一个字没动"这句话因此可核对：把本格去掉，判决行其余部分逐字不变）。
 *   ③ **不动删除面** —— 纯函数、纯读：不产生也不授权任何删除。
 *
 * ⚠️ 措辞刻意避开 `RESIDUE_CLOSING_TOKENS`（残留 / 无命中 / 清干净 / 零剩）⇒ 它不是"第二条残留结论"（B165）。
 * @param {{arms?: Array<{label:string, count:number, evidence:string}>}} [o]
 */
export function retainedRowsCell({ arms } = {}) {
  const list = Array.isArray(arms) ? arms : [];
  const hasEvidence = (a) => typeof a?.evidence === 'string' && a.evidence.trim().length > 0;
  const kept = list.filter(hasEvidence);
  const refused = list.filter((a) => !hasEvidence(a));
  const total = kept.reduce((s, a) => s + (Number(a.count) || 0), 0);
  const refusedTxt = refused.length ? `；⚠️ ${refused.length} 个族**因缺机制证据未计入**（${refused.map((a) => a?.label ?? '未具名').join(' · ')}）` : '';
  const text = kept.length === 0
    ? `保留行（来源已证）＝0 行（没有带机制证据的族${refusedTxt ? refusedTxt.replace('；', '，') : ''}）`
    : `保留行（来源已证）＝${total} 行（${kept.map((a) => `${a.label}:${Number(a.count) || 0}`).join(' · ')}${refusedTxt}）`;
  return { total, kept, refused, text };
}

export function gapDetail(results) {
  return '   缺口明细：' + results.filter((r) => r.ok === null).map((r) => r.n).join(' · ');
}

/**
 * ★ BLOCKER-2 的正面回答：`finishRun` 是**一次调用**，而"在它之前插一句裸 `return;`"就能整段跳过它
 *   （`finally` 里的 return 会把退出码吞成 0 —— 复核实证）。所以判决不能只挂在"有没有走到 finishRun"上。
 *   本函数挂在 `main()` **之后**（顶层 `.then`），任何"正常返回"的路径都必经过它 ⇒
 *   收尾结论缺席 ⇒ 退 5。⚠️ 诚实边界：`process.exit()` 抢先结束的路径（exit-4 那条）不经过这里，
 *   那条本来就是非 0 退出、且它自己打了 `残留结论=0`。
 */
export function assertResidueAudited(rep, { log = console.log, exit = process.exit } = {}) {
  const rc = rep.residueCount();
  if (rc !== 1) {
    log(`  ✗ B165 退出前复核：本次运行必须产出**恰好一条**残留结论 ⇒ 实测 ${rc} 条。`
      + `0 条 = 收尾判决从未执行（被 return/异常/删除跳过），此时"没报残留"不等于"没有残留" ⇒ 退 5。`);
    return exit(5);
  }
  return undefined;
}

/**
 * 收尾：三态计数 + 署名 + **残留结论是否真发出过一次** + 退出码。
 * 退出码：0 全通过 / 1 有失败 / 5 收尾结论缺席或重复（★ 这一档不许被算成"跑完了"）。
 * `exit` 与 `log` 注入 ⇒ 这一段可以在不连库的情况下被**执行**（这就是 B165 要的行为证人）。
 */
export function finishRun({ rep, attr, waived, retained = null, log = console.log, exit = process.exit }) {
  const { results } = rep;
  const rc = rep.residueCount();
  log(verdictLine({ results, residueCount: rc, verdictKind: rep.verdictKind(), attr, waived, retained }));
  if (results.some((r) => r.ok === null)) log(gapDetail(results));
  if (rc !== 1 || rep.verdictKind() === null) {
    log(`  ✗ B165 收尾硬前置：全程只许有**一条**残留结论、且必须由 lib 发出 ⇒ 实测 ${rc} 条、判定=${rep.verdictKind() ?? '无'}。`
      + `0 条意味着那次判决从未执行（例如被 if 包住、被搬走、或整段没跑），`
      + `此时"没报残留"不等于"没有残留" ⇒ 退出码 5，不许按通过读。`);
    return exit(5);
  }
  // ★★ B166 的核心：先问"判决说了什么"，再问"有没有失败项"。
  //   判决不是 clean ⇒ 直接非 0，**通过计数根本没有表决权**
  //   ⇒ 复核 #11 那类同义措辞的假干净（不进白名单、只灌通过数）改不动退出码。
  if (rep.verdictKind() !== 'clean') {
    log(`  ✗ B166：残留判决=${rep.verdictKind()} ⇒ 本次不许判为通过（通过数不影响这一判定）：${rep.verdictDetail()}`);
    return exit(1);
  }
  exit(results.filter((r) => r.ok === false).length === 0 ? 0 : 1);
}

/**
 * ★ v3.35（复核 ①）：判决行里「署名=…」这一段原来是内联拼的 ⇒ 没有任何测试能确定性地验它
 *   （本仓环境里"真跑通再留痕"那半边不可达：缺 env、且 8081 上那个别分支的服务不许动）。
 *   抽成纯函数后四格组合都能测；判据仍然只有一份（主链与本函数同源）。
 * @param {{ok?:boolean}} attr gateAttribution()/isTrustworthy() 的结果形状
 * @param {boolean} waived 是否显式用了 --allow-unattributed
 */
export function attributionVerdict(attr, waived = false) {
  if (attr?.ok) return '可署名';
  return waived ? '不可署名(已用 --allow-unattributed 越过)' : '不可署名';
}

/**
 * ★ v3.35（复核 ②）：**闸本身**也要能测。上一批我只测了拼串（四格），复核把
 *   `if (!ALLOW_UNATTRIBUTED)` 改成永不放行 ⇒ 五条断言照样全绿（本仓环境里 waived 那一路走不到判决行）。
 *   把"拒不拒跑"抽成纯决策 ⇒ "可信时必须放行 / 不可信且没给口子时必须拒 / 给了口子必须放行"四格可确定性验。
 * @returns {boolean} true = 拒绝开跑（exit 3）
 */
export function attributionRefuse(attr, waived = false) {
  return !attr?.ok && !waived;
}

export function formatBanner(sc) {
  const t = isTrustworthy(sc);
  const L = [];
  L.push('── 验收自证（acceptance self-check）────────────────────────');
  L.push(`  脚本仓库  ${sc.repoRoot} @ ${sc.branch ?? '?'} (${sc.head?.slice(0, 7) ?? '?'})${sc.dirtyPaths?.length ? ` · ★ ${sc.dirtyPaths.length} 处未提交改动` : ''}`);
  L.push(`  数据库    ${sc.db.name ?? '未知'} @ ${sc.db.host ?? '?'}:${sc.db.port ?? '?'}  ← 来源 ${sc.db.urlSource ?? (sc.db.envFile ? path.relative(sc.repoRoot, sc.db.envFile) : '★ 本仓无 env 文件')}`);
  for (const p of sc.ports ?? []) {
    const list = sc.listeners?.[p] ?? [];
    L.push(`  后端:${p}  ${list.length === 0 ? '★ 无监听' : list.map((b) => `pid=${b.pid} cwd=${b.cwd ?? '?'} 分支=${b.branch ?? '?'} HEAD=${b.head?.slice(0, 7) ?? '?'} 起于=${b.startedAt ?? '?'}`).join(' | ')}`);
  }
  L.push(t.ok
    ? '  ⇒ ✓ 读数可署名本分支本 commit'
    : `  ⇒ ✗ 读数**不可**署名本分支：\n${t.reasons.map((r) => `      · ${r}`).join('\n')}`);
  L.push('────────────────────────────────────────────────────────');
  return L.join('\n');
}

if (isCliEntry(import.meta.url)) {
  const sc = selfCheck();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...sc, trust: isTrustworthy(sc) }, null, 2));
  else { console.log(formatBanner(sc)); if (!isTrustworthy(sc).ok) process.exitCode = 2; }
}
