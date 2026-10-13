import { enumerateTierLandingPoints, enumerateWide, summarize, tierSiteKey, tierSiteSignature } from './lib/errorTierHardcodes.mjs';
import { reconcileSiteLists } from './lib/writeRouteSurface.mjs';
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, statSync, readlinkSync } from 'node:fs'; // ★ B150：审悬空链接要用 readlinkSync
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path'; // ★ B149：删掉从未被用到的 basename（复核 MINOR）
import { fileURLToPath } from 'node:url';
/**
 * ★★ B147（v3.20，v3.19 复核抓到的 BLOCKER，两条都在我这边实测复现）：**这台写手过去把所有路径都挂在 cwd 上**，
 *   而"挂在 cwd 上"不是"不便利"，是**一道静默解除防线的开关** —— 从 `server/` 里跑：
 *   ① `BASELINE_REL` 指到一个不存在的位置 ⇒ 读旧基线失败 ⇒ B134 签名闸门自报"首冻"而**静默失效**；
 *   ② 落点守卫比的也是那个不存在的路径 ⇒ `--out=../scripts/baselines/error-tier-hardcodes.json` 一路放行；
 *   ③ "写完实测真源字节"量的还是那个不存在的路径 ⇒ 打印"真源字节已实测未变"，而真基线已从 538 条落点被写成 `落点 0 / filesScanned 0`。
 *   实测命令（复核给的形状，我自己重跑确认）：`cd server && node ../scripts/freeze-error-tier-baseline.mjs --out=../scripts/baselines/error-tier-hardcodes.json`
 *   ⇒ exit 0、真源被替换成空文档。**同一族还有第二条**：大小写变体的目录名（macOS 卷大小写不敏感，`realpath` 不把最后一段折回规范大小写）
 *   ⇒ `--out=scripts/BASELINES/g3-fail-open.json` 绕过前缀比较，把**隔壁闸门**的基线盖成 35KB 的错文档，且②③都不看隔壁。
 *   ⇒ 修法：**"树"必须被显式验证**，然后让扫描根 / 旧基线 / 落点守卫 / 整目录快照四件事都拼在同一棵验证过的树上；
 *      再加"分母塌了不许写"与"整目录（不只是本份）快照实测"两道兜底。
 *   ⚠️ 我先写成"根目录跟着**脚本位置**走"，随即自己否掉了：本文件的子进程测试是把写手指到 /tmp 的临时仓跑的，
 *      脚本位置推导会把它们变成"读写真仓真基线"——**修一个越界写，造一个更大的越界写**。正确的不变量是"树被验过"，不是"树在脚本旁边"。
 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));          // <root>/scripts（只用于"我是不是被从别处调用"的说明）
/**
 * ★★ 树 = cwd，但**当场验它像不像仓根**（v3.20 定稿；我先写成"根跟着脚本走"，随即发现那是错的：
 *   本文件的整套子进程测试是把写手的 cwd 指到 /tmp 的临时仓来跑的，若 ROOT 由脚本位置推导，
 *   那些用例要么全红（cwd 检查挡住），要么更糟 —— 拿着真仓的 ROOT 去读写**真基线**，隔离当场失效。
 *   ⇒ 正确的不变量不是"只能在仓根跑"，而是"**扫描根、旧基线、落点守卫、整目录快照四件事必须落在同一棵被验证过的树上**"。）
 */
const ROOT = resolve(process.cwd());
if (!existsSync(join(ROOT, 'server', 'src')) || !existsSync(join(ROOT, 'scripts', 'baselines'))) {
  sysAbort(`ABORT: 当前目录不像本仓仓根（cwd=${ROOT}；要求同时存在 server/src 与 scripts/baselines）。\n`
    + `   脚本自身在 ${SELF_DIR} —— 如果你确实是从仓根跑的，那就是树被挪动/删过了。\n`
    + `   为什么这条要当场炸（B147 实测）：从 server/ 里跑过 ` + '`--out=../scripts/baselines/<真源>`' + ` ⇒\n`
    + '   旧基线读不到 ⇒ 签名闸门自报"首冻"、守卫与证人一起指向不存在的路径、扫描出 filesScanned=0，'
    + '最后真基线被写成空文档而输出还说"真源未变"。缺"树对不对"这一条，上面三道防线会**一起静默失效**。');
}
function sysAbort(msg) { console.error(msg); process.exit(1); }
/**
 * ★ B150（v3.24 复核 B-2，我自己复现成立）：`git()` 原来直接继承 process.env ⇒
 *   `GIT_DIR=<另一棵树>/.git GIT_WORK_TREE=<那棵树> node … --write` 让 `fromCommit` 写成**那棵树**的 HEAD
 *   （实测：本树 HEAD=5a3ad0c7、基线却写 e5d695b0，exit 0）—— v3.22 只删了 `SHORT_SHA` 这个入口，
 *   漏了 git 自己的那一批环境变量，于是"出处不接受调用者提供"这句话又说满了（同族第三次）。
 *   ⇒ 两处一起：① 剥掉所有 `GIT_*`（不预设 GIT_DIR：链接工作树的 `.git` 是文件，硬指会自伤）；
 *     ② 剥完之后还要问 git 本人「你说的 toplevel 是不是这棵树」—— 防的是我漏列举的那一个。
 */
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: GIT_ENV }); }
  catch (e) { sysAbort('ABORT: `git ' + args.join(' ') + '` 失败 ⇒ 别冻结一份没有出处的基线（' + e.message + '）'); }
}
{
  const top = (git(['rev-parse', '--show-toplevel']).trim() || '').replace(/\/+$/, '');
  if (!top) sysAbort('ABORT: `git rev-parse --show-toplevel` 给不出树 ⇒ 不知道在量哪一份树，拒写。');
  if (realpathSync(top) !== realpathSync(ROOT)) {
    sysAbort(`ABORT: 这条 git 说的树是 ${top}，与扫描根 ${ROOT} 不是同一棵 ⇒ 拒写。\n`
      + '   出处（fromCommit / worktreeDirtyFiles / worktreeDiffSha）必须由"被量的那一份树"给出，否则基线认不出自己量的谁。');
  }
}
/**
 * ★ 出处（`fromCommit`）拿不到就**中止**，不许悄悄写 'unknown'（v3.12 实测到这里已经躺过一个 `unknown`）。
 * ★★ 只记 HEAD 短码是**假的出处**（复核 B-2 点破，我自己复量确认）：本仓的常态是"改完代码、还没提交就重冻结"，
 *   于是 `fromCommit` 指向的那份树**不是被量的那一份** —— 实测 HEAD=14d4e0c2 而工作树 14 个文件未提交，
 *   同一把尺扫 HEAD 读出 `codeKey 24`，基线却写 `20`。⇒ 出处必须连"工作树偏离 HEAD 多远"一起记：
 *   `worktreeDirtyFiles` + `worktreeDiffSha`（未提交 diff 的摘要）。事后不能精确复现，但至少认得出量的哪一份树，
 *   不再复现 B77（数没有唯一读数出口 ⇒ 事后无法复现）。
 *   ⚠️ B147 之后这几条 git 调用全部钉在 `ROOT` 上（不再跟 cwd）⇒ "量的哪一份树"与"写进哪棵树"不可能再分叉。
 */
// ★ B149（复核 MINOR）：原来写的是 `process.env.SHORT_SHA || git(...)` —— 一个环境变量就能伪造出处
//   （格子只验形状 `/^[0-9a-f]{7,8}$/`，`SHORT_SHA=deadbeef` 就能落一份"有出处"的基线）。
//   出处是这份基线唯一的可追溯锚，不接受调用者提供 ⇒ 取消该环境变量，只认 `git rev-parse`。
const shortSha = git(['rev-parse', 'HEAD']).trim().slice(0, 8);
if (!/^[0-9a-f]{7,8}$/.test(shortSha)) sysAbort('ABORT: 出处不像提交短码 ⇒ ' + JSON.stringify(shortSha));
const worktreeDirtyFiles = git(['status', '--porcelain']).split('\n').filter((l) => l.trim() !== '').length;
const worktreeDiffSha = 'sha256:' + createHash('sha256').update(git(['diff', 'HEAD'])).digest('hex').slice(0, 12);
const { files, points } = enumerateTierLandingPoints(ROOT);
const sum = summarize(points);
const key = tierSiteKey; // ★ 键只此一份（原先这里和守卫各抄一遍字面量）
const sitesNow = points.map(key).sort();
const rulerSitesNow = points.filter((p) => p.kind === 'rulerFallback').map(key).sort();
/**
 * ★★ B147 兜底二：**分母塌了不许往下走**。`files.length===0` 只可能来自"扫错了树"（真树不可能零文件），
 *   而它一旦成立，后面每道闸门都会朝"放行"的方向漂（零落点 ⇒ 与旧基线对撞成"全消失"、守卫看不到任何站点）。
 *   所以这里当场炸，而不是把 0 写成基线。
 */
if (!files.length) sysAbort(`ABORT: 扫描根 ${ROOT} 下文件数 = 0 ⇒ 尺在空转，这种树冻出来的基线只会把防线全部对齐到"没有落点"`);

/**
 * ★★ v3.14（B134）：写盘前先与**旧基线**按签名对撞。这道闸门 G4.1 的写手从 v3.12（B132）就有了，
 *   这一份一直缺席 —— 本批就是活案例：claims 域只改了 catch 上方的 4 行注释，两条 `literalStatus`
 *   行号 +2，守卫报"新增了手写档位的落点"，而处置动作（`--write`）与"真的新写了一处手写档位"**长得一模一样**。
 *   没有闸门时，"红的原因看没看懂"只存在于操作者的自我声明里 —— 正是 §2 G3 给这类病起的名字。
 *   ⇒ 签名（文件 + 桶）没变 ⇒ 只是行号搬家，自动重冻结；
 *   ⇒ 签名变了 ⇒ 必须 `--allow-set-change="一句话理由"`，理由连同 added/removed 进 `_setChangeLog`。
 *   ⚠️ 咬得住"别处新写一处"，**咬不住**"同一文件同一桶里换了一处"（那种搬家不可区分）⇒ 写进 knownBlindSpots。
 */
const BASELINE_REL = 'scripts/baselines/error-tier-hardcodes.json';
/** ★ B147：真源路径一律**显式**拼在（已被验证过的）ROOT 上，不写"相对 cwd 的字面量"——两者今天等价，
 *   但"等价"是靠上面那道树检查撑着的；写显式是为了下一个改这里的人不会把树检查删掉而不被立刻发现。 */
const BASELINE_PATH = join(ROOT, BASELINE_REL);
const BASE_DIR = join(ROOT, dirname(BASELINE_REL));
/**
 * ★★ B149（v3.22；v3.21 复核抓到 BLOCKER-1，我自己在 /tmp 三棵临时树里复现）：`--out` 取消之后，
 *   "写到哪"仍然有**两条不经参数**的通道，而其中一条是真绕得过的：
 *   - **符号链接**：`ln -s <B>/scripts/baselines <C>/scripts/baselines; cd <C> && --write` ⇒ exit 0、
 *     文件落进 **B 树**，而 C 树照旧打印「受保护真源…逐份未动」（v3.21 删 `--out` 时把 `realpathSync`
 *     的用法一起删了，只剩一个没用的 import ⇒ 树检查从此不做归一）。⇒ 本段这一条就是补它。
 *   - **cwd 指到别的 checkout/工作树**：**这条不拦**，因为拦不起也不该拦 —— 本文件那 27 格子进程判据
 *     全部靠「真仓脚本 + 临时仓 cwd」跑（`error-tier-hardcodes.test.ts` 的 `runFreeze` 就是 spawnSync 传 cwd），
 *     加"cwd 必须等于脚本自己那棵树"会整套作废；而 `--write` 的落点仍是**当前那棵树里的固定相对路径**、
 *     `fromCommit` 也取当前树的 HEAD ⇒ 语义自洽。台账里那句"只改本仓那一份"要按这个口径改口（见 B149）。
 *   ⇒ 判据只做一件事：拿两个**已经求过值**的路径比 —— 落点的最近存在祖先 realpath 必须在 realpath(ROOT) 之内。
 *     这不是"枚举哪些路径危险"（那一路我连输四次），是"落点是不是还在这棵被验过的树上"。
 */
function nearestExistingAncestor(p) {
  let cur = resolve(p);
  for (;;) {
    if (existsSync(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
{
  const rootReal = realpathSync(ROOT);
  const anchor = nearestExistingAncestor(BASE_DIR);
  if (!anchor) {
    sysAbort(`ABORT: 落点目录 ${BASELINE_REL} 连一个已存在的祖先都找不到 ⇒ 无法判定它会落在哪棵树，拒写。`);
  }
  // ★ B150（v3.24 复核 B-1，我自己复现成立）：v3.22 只对**目录**取 realpath ⇒ 把
  //   `error-tier-hardcodes.json` **这一个文件**做成指向别处的符号链接，整条绕通：
  //   从 T 树跑 --write，U 树那份被凭空写出（`<无>` → a5273d50d3）、exit 0。
  //   ★ 而"存在就取它"还不够：指向**尚未存在**的目标是**悬空链接**，`existsSync` 与
  //   `realpathSync` 都会说不存在/直接抛（v3.24 第二版实测仍绕通，就是栽在这儿）⇒
  //   必须再用 `readlinkSync` 把链接**声明的目标**审一遍。落点本身是普通文件/还不存在时，
  //   退回最近存在祖先（那是首冻的正常形状）。
  const probe = (() => {
    try { return realpathSync(BASELINE_PATH); } catch { /* 不存在或悬空 */ }
    try { return resolve(dirname(BASELINE_PATH), readlinkSync(BASELINE_PATH)); } catch { /* 不是链接 */ }
    return anchor;
  })();
  const anchorReal = realpathSync(nearestExistingAncestor(probe) || anchor);
  if (anchorReal !== rootReal && !anchorReal.startsWith(rootReal + sep)) {
    sysAbort(`ABORT: 落点 ${BASELINE_REL} 经 realpath 归一后落在 ${anchorReal}，**不在**当前树 ${rootReal} 之内\n`
      + `   ⇒ 这是符号链接（或 mount）把唯一的写盘动作搬出本树（B149 实测形状：exit 0 却改了另一棵树的真源，\n`
      + `      而"受保护真源逐份未动"那句话只对链接所在的这棵树成立）。\n`
      + `   要写另一棵树请真的 cd 过去跑那棵树自己的写手；这台工具的承诺只有"只写本树这一份基线"。`);
  }
}
let prev = null;
if (existsSync(BASELINE_PATH)) {
  try { prev = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); }
  catch (e) { sysAbort(`ABORT: 旧基线读不出 JSON（${e.message}）⇒ 宁可不动，也不要"读不到 ⇒ 当首冻 ⇒ 无条件放行"`); }
} else if (git(['ls-files', BASELINE_REL]).trim() !== '') {
  // ★ 被 git 跟踪却不在磁盘上 ⇒ 那不是"首冻"，是**文件被删/树不对**（用 plain ls-files：它在"未跟踪"时退出码仍是 0，
  //   而 `--error-unmatch` 会被本文件的 git() 包装成 sysAbort ⇒ 会把"真·首冻"这条合法路径一起炸掉 —— 写完当场实测到）
  sysAbort(`ABORT: ${BASELINE_REL} 被 git 跟踪但磁盘上不存在 ⇒ 这不是首冻（首冻 = 从未有过这份文件）。`
    + '先确认工作树对不对：被删的跟踪文件会让签名闸门自报"首冻"、从此无条件放行（B147 实测形状）');
} else {
  console.log('ℹ️ 读不到旧基线，且它也不在 git 索引里 ⇒ 本次是真·首冻，无从对账（下面这道闸门从下一次起才有效）');
}
const drift = prev
  ? reconcileSiteLists(
      { sites: prev.sites ?? [], rulerSites: prev.rulerSites ?? [] },
      { sites: sitesNow, rulerSites: rulerSitesNow },
      tierSiteSignature,
    )
  : {};
const changed = Object.keys(drift);
/*
 * ★ B144（v3.18）：这台写手**过去没有写盘开关** —— 签名闸门一过就直接 writeFileSync，
 *   于是"先看一眼会怎样"这个动作本身就把基线改了（v3.16/v3.17 各踩一次，两次都是我以为在跑探针）。
 *   同族的 G4.1 那份（`g41-derive-surface.mjs:24`）从 v3.12 起就是 `if (argv.includes('--write'))` 才动盘
 *   ⇒ 这次不是新发明一套约定，是把这个缺口的实现对齐到已有那一份。
 *   现在：默认**预演**（只报对账结论与将要写进去的数）；`--write` 才改基线；`--out=<路径>` 把副本写到别处。
 *
 * ★★ B145（v3.19）把 `--out` 记成"永不动唯一真源"是过度声明；v3.19 补的两层被 v3.19 复核实测出两条绕过（⇒ B147，v3.20 修）；
 *   而 v3.20 补的**四层**又被 v3.20 复核实测出**同族第三次绕过**（⇒ B148，本批修；我在 /tmp 双树副本自己复现了两条）：
 *   · 从 A 树跑 `--out=/tmp/B/scripts/baselines/g3-fail-open.json` ⇒ exit 0，B 树那份基线 **2203B → 35759B** 错文档，
 *     同时打印「受保护真源 5 份已实测逐份未变」—— 那句话对我们这棵树是真的，对 B 树毫无意义 ⇒ 一句话第三次把事实说反；
 *   · `--out=docs/交付目标与验收标准-2026-09-20.md` ⇒ exit 0，**权威基准从 1014341B 被截成 35759B**。
 *   ⇒ 根因不是"又一条没想到的拼法"，而是**这类工具根本不该持有"写到任意路径"这个能力**：
 *     一台机器上可以有 N 棵树（本仓现在就有主 checkout + 工作树 + 归档解包），真源也不只有 `*.json`
 *     —— 最硬的那份真源是一份 .md。任何"按前缀/按清单判哪些路径危险"的守卫都是在**追着枚举**，我已经连着输三次。
 *   ⇒ 本批不加第四层守卫，改成**删掉这条写路径**：
 *     ① `--out` 取消，带写目标的参数与位置参数一律 ABORT（连 `--dump=` 都拒 ⇒ 报错要说清"拒的是什么"）；
 *     ② 只保留 `--dump`：把将要写进去的 JSON 打到 **stdout**，落不落盘、落到哪是操作者在 shell 里的事，
 *        工具不再声称"那个位置安全"（它无从判断）；
 *     ③ `--write` 仍在，并保留**同树兄弟基线逐份实测**（它防的是"这台工具自己顺手改到隔壁"，那是它自己做得到的判断）；
 *     ④ 树标志物检查 + 分母哨兵保留（v3.20 的 M2b 实测到：删掉树检查，分母哨兵还能独立接住错树那一跑）。
 */
const WRITE = process.argv.includes('--write');
const DUMP = process.argv.includes('--dump');
/**
 * ★ B148：**结构性**拒绝"把副本写到某个位置"这件事 —— 不枚举危险路径，而是根本没有这个参数。
 *   报错必须点名"以前那个 flag 取消了、为什么"，否则下一个人还会去试（v3.14 的台账就写过一个不存在的 flag）。
 */
for (const a of process.argv.slice(2)) {
  if (/^--(out|output|dump)=/i.test(a) || /^--(out|output)$/i.test(a)) {
    sysAbort(`ABORT: 这台写手**不接受任何写目标参数**（收到 ${a}）。
`
      + `   · 想看将要写进去的内容 ⇒ 用 --dump（只打到 stdout，不产生任何文件写入）；
`
      + `   · 真的要改基线 ⇒ 用 --write（只改本仓这一份，改之前先实测同树的兄弟基线没被牵连）。
`
      + `   为什么取消 --out（B148 实测）：路径守卫覆盖不到"一台机器上还有别的 checkout/工作树/解包归档"，
`
      + `   也覆盖不到"真源不止 JSON"—— 权威基准本身就是被同一个 flag 截断过的对象。`);
  }
  if (!/^--(write|dump|allow-set-change(?:=.*)?|help)$/.test(a)) {  // ★ B149：删掉从未实现的 --json
    sysAbort(`ABORT: 不认识的参数 ${a} ⇒ 这台写手只认 --write / --dump / --allow-set-change=「理由」（--json 从未实现 ⇒ 也不再接受）。
`
      + '   位置参数与任何写目标参数一律拒绝（这一族事故的入口就是"工具肯接受一个自定义的落点"）。');
  }
}
if (WRITE && DUMP) sysAbort('ABORT: `--write` 与 `--dump` 互斥（一个落盘、一个只打印）⇒ 同时给说明调用者没想清楚要哪个');
/**
 * ★ `--dump` 的 stdout **只能是那份 JSON** —— 否则 `--dump > x.json` 会得到一个混了进度行的废文件
 *   （v3.21 自己踩到：`签名层对账通过…` 也走 console.log ⇒ 下游 JSON.parse 当场炸）。
 *   ⇒ 这一模式下把所有人类可读输出改道 stderr；stdout 只留 `process.stdout.write(serialized)` 一处。
 */
if (DUMP) console.log = (...a) => console.error(...a);
/**
 * ★ 受保护真源清单：v3.21 起**只喂证人**（`--write` 前后逐份实测），不再喂守卫 —— 守卫随 `--out` 一起取消了。
 *   ⚠️ 它仍是手工清单，"新基线漏进清单"要靠 task #33 那条与 git 跟踪集双向对撞的判据，不是靠这里。
 */
const EXTRA_TRUTH_SOURCES = ['scripts/os-vnext-audit-baseline.json'];
function snapshotKeyOf(p) { return relative(ROOT, p).split(sep).join('/'); }
if (!WRITE && !DUMP) {
  // 只把"没给开关"这件事说在前面，避免有人把预演当成已经改好
  console.log('ℹ️ 未给 --write 也没给 --dump ⇒ 本次只预演，基线不会被改（要真重冻结请加 --write；只想看内容请加 --dump）');
}
const allowArgs = process.argv.filter((a) => /^--allow-set-change(?:=|$)/.test(a));
if (allowArgs.length > 1) sysAbort('ABORT: --allow-set-change 只能给一次，拒绝含混的放行理由');
const allowArg = allowArgs[0];
const reason = allowArg?.startsWith('--allow-set-change=') ? allowArg.slice('--allow-set-change='.length).trim() : '';
// ★ B149（复核 MINOR）：实测 `--allow-set-change=<一个路径>` 会 exit 0，而这一族事故的入口正是
//   「工具肯接受一个看起来像落点的东西」⇒ 理由像路径就拒（不给它一个隐式的第二个用途）。
// ★ B150（v3.24 复核 MINOR-1，我复现了它的误杀）：v3.22 那条正则既**拦不住**想塞落点的写法
//   （散文里带一个路径照样放行），又会**误杀**正当写法（`为新增基线 scripts/baselines/g9-x.json 落账` ⇒ exit 1）。
//   一条"两侧都要靠猜"的防线比没有更难查 ⇒ 换成一条**说得清边界**的规则：
//   「整串不含空白、且含路径分隔符」才当成路径拒掉；带空格的散文一律放过（散文里提到某个文件是正当写法）。
if (allowArg && reason && !/\s/.test(reason) && /[\\/]/.test(reason)) {
  sysAbort(`ABORT: --allow-set-change 要的是「一句话理由」，收到的一串不含空格还带路径分隔符 ⇒ 它看起来就是一个路径：${JSON.stringify(reason.slice(0, 80))}。\n`
    + '   这台工具没有「把签名放行到别处」的通道（B148/B149）；要重冻结就写清「为什么这个集合变了是预期的」。\n'
    + '   （★ v3.24 收窄：只有"整串不含空白且含 / 或 \\" 才拒；散文里提到某个路径是正当写法，不再猜。）');
}
if (allowArg && !reason) sysAbort('★ `--allow-set-change` 必须带理由（`--allow-set-change="为什么放行这次集合变化"`）⇒ 理由会进基线的 _setChangeLog，放行这件事本身要留下可审的痕迹。');
if (changed.length && !allowArg) {
  console.error('★ 签名层（文件 + 桶）发生了变化 ⇒ 这不是"行号搬家"，是集合真的变了。中止写盘（基线一个字节都没动）：');
  for (const name of changed) console.error(`   ${name}: 新增 ${JSON.stringify(drift[name].added)} 消失 ${JSON.stringify(drift[name].removed)}`);
  console.error('   先回答"这些签名是谁收口的、有没有当场红过的测试指着它"；确认了再补 `--allow-set-change="一句话理由"` 重跑。');
  process.exit(1);
}
console.log(changed.length
  // ★ B145（v3.19，复核 MINOR-5）：这一句过去在**预演**里也打印"已放行"，而 `_setChangeLog` 根本不落盘
  //   ⇒ 放行痕迹会被丢弃，看输出的人却以为留下了。现在把"放行"与"落盘"两件事分开说。
  ? `⚠️ 签名层变化${WRITE ? '已放行' : '本可放行（但没给 --write ⇒ 只打印，不落盘，_setChangeLog 不会进基线）'}（理由：${reason}）：${JSON.stringify(drift)}`
  : `签名层对账通过（sites ${sitesNow.length} · rulerSites ${rulerSitesNow.length}，只有行号搬家或缺省）⇒ ${WRITE ? '允许写盘' : '本次预演，不写盘'}`);
const wide = enumerateWide(ROOT);   // ★ B147：宽尺也跟着树走（过去同样是 cwd ⇒ 从子目录跑会读出 wide 0 而不报错）
const debtKinds = ['literalStatus', 'tierArg', 'keywordCopy', 'codeKey', 'passthroughStatusCode', 'otherTernary', 'unclassified', 'tierViaVariable',
  // ★ 接尺但**不给兜底档**：默认档是 400（`bizStatus.ts:68`）⇒ 我们自己抛的 TypeError 会被答成"客户端错"，
  //   这一族按债计（复核 B-1 顺带抓出来的新发现，登记为 B131），不许无限增。
  'rulerNoFallback'];
// 集合放行不等于提高债务上限。历史 cap 即使低于本次读数也必须留下，随后棘轮仍会报红。
const caps = Object.fromEntries(debtKinds.map((kind) => {
  const prior = prev?.ratchet?.caps?.[kind];
  if (prior !== undefined && (!Number.isInteger(prior) || prior < 0)) sysAbort(`ABORT: 旧 ${kind} cap 非法，拒绝重建历史判据`);
  return [kind, prior === undefined ? (sum.byKind[kind] || 0) : Math.min(prior, sum.byKind[kind] || 0)];
}));
const floorRetirements = [];
const floors = Object.fromEntries(['rulerFallback', 'rulerConsumer'].map((kind) => {
  const current = sum.byKind[kind] || 0;
  const prior = prev?.ratchet?.floors?.[kind];
  if (prior !== undefined && (!Number.isInteger(prior) || prior < 0)) sysAbort(`ABORT: 旧 ${kind} floor 非法，拒绝重建历史判据`);
  if (prior === undefined || current >= prior) return [kind, current];
  // 已迁到 typed/中央码出口的调用会真实退休。下降须按文件+桶多重集归属，并留下理由和旧判据；不造假调用。
  const oldSites = (prev.sites || []).filter((site) => site.endsWith(`#${kind}`));
  const counts = (sites) => {
    const out = new Map();
    for (const site of sites) out.set(tierSiteSignature(site), (out.get(tierSiteSignature(site)) || 0) + 1);
    return out;
  };
  const before = counts(oldSites);
  const after = counts(sitesNow.filter((site) => site.endsWith(`#${kind}`)));
  const retired = [...before].filter(([signature, count]) => count > (after.get(signature) || 0))
    .map(([signature, count]) => ({ signature, count: count - (after.get(signature) || 0), priorSites: oldSites.filter((site) => tierSiteSignature(site) === signature) }));
  if (!reason || retired.reduce((n, site) => n + site.count, 0) < prior - current) {
    sysAbort(`ABORT: ${kind} floor ${prior} → ${current} 必须有显式理由及足量逐站退休记录；集合放行不能静默降低 floor`);
  }
  floorRetirements.push({ kind, before: prior, after: current, reason, retired });
  return [kind, current];
}));
const json = {
  _readme: [
    'B126 普查尺的冻结基线（v3.10）。判据实现只有一份：scripts/lib/errorTierHardcodes.mjs。',
    '单位口径：points = "catch 块内一条决定 HTTP 档位的语句"（落点）；wide = catch 之外的**片段**级读数，两者口径不同、不许互相加减。',
    'debt 桶（cap）只许下降；ruler 桶（floor）只许上升，已独立核定的来源退休须显式理由、逐站退休记录及旧判据。sites 集合与基线**逐条相等**：新增 ⇒ 红，消失 ⇒ 必须同批来重冻结并说明是哪一族的收口。',
    '这把尺**不判对错**：catch 里写 401 可能完全正确。它只回答"这个档位是谁定的"。',
  ],
  generated: {
    at: new Date().toISOString(), fromCommit: shortSha, filesScanned: files.length, // ★ B150：完整时刻；★ filesScanned 是 v3.24 补丁被我弄丢又由 写手④ 抓回来的那一个（见该行注释） filesScanned: files.length,
    worktreeDirtyFiles, worktreeDiffSha,
  },
  totals: { landingPoints: sum.total, filesWithLandingPoints: sum.files, wideFragments: wide.length },
  byKind: sum.byKind,
  ratchet: {
    caps,
    floors,
    unclassifiedMustBe: 0,
    wideFragmentsMustEqual: wide.length,
  },
  sites: sitesNow,
  rulerSites: rulerSitesNow,
  knownBlindSpots: [
    '档位经常量/间接映射（如 DIRECT_CANCEL_ERROR_HTTP_STATUS[code] ?? 500）时，只有含字面量的那一片段被记到，映射表本身不算落点',
    '字符串里拼出来的 status（模板 `${x ? 404 : 500}` 之外的动态构造）扫不到；本尺只在源码里能看到 3 位字面量时才出声',
    '测试文件（含与源码并排的 route.test.ts）已排除 ⇒ 尺数的是产品代码的债，不含断言里的期望码',
    'wide 口径是"片段"，同一条 `res.status(...)` 在宽尺里可能被切得更碎 ⇒ 只用它做"别挪出 catch 躲尺"的相等校验，不当落点数用',
    '绑定转发只认可实际 public status 参数与闭合 caller 来源；未知参数、动态映射、逃逸和间接常量仍不可证明。主尺 unclassified=0 不代表宽尺未分类片段为 0，也不证明具体 HTTP 值或业务行为正确。',
    // ★ v3.14（B134）：这道新闸门的**边界**也写进来，免得后人把它读成"重冻结不可能出错"
    '签名对撞的粒度是"文件 + 桶"（不含行号）⇒ 拦住"别处新写一处手写档位"，**拦不住**"同一文件同一桶里把一处换成另一处"（那种变化与行号搬家在键上不可区分）。',
    // ★★ v3.14 复核 B-1（实测，不是我推的）：本基线**不存档位值** ⇒ "值被答错"这一族整把尺都看不见。
    //    取证：把 `admin/route.ts:49` 的 `res.status(500)` 改成 `res.status(400)` ⇒ error-tier + g41 两个守卫文件 **38 passed** 全绿。
    //    ⇒ 别把守卫 ④ 当"值"的证人：它只回答"这个档位是谁定的"，不回答"定成了几"（`_readme` 第 4 行那句"本尺不判对错"就是这个意思）。
    //    值这一族的证人分散在各站点的行为测试里（B124 / B129 / B131），不在本尺能力范围内 —— 要收值得另立一把尺，别在键上偷偷加"看起来覆盖了"的措辞。
    '本尺的键是 `文件:行号#桶`，**不含档位值** ⇒ 已登记站点把 500 改成 400 对整把尺与签名闸门都隐形；这不是"搬家不可区分"那个弱一号的盲区，是**另一个维度**的盲区（值 vs 位置）。',
    // ★ v3.19（B145）：`--out` 落点守卫的边界也要写进来，免得后人把它读成"副本不可能碰到真源"
    '**`--out` 那一族：四条实测绕行 + 现在的防线与四条边界（v3.18→v3.22）**：守卫曾有三层（realpath 归一 / 大小写归一 / 受保护真源清单），先后被四条日常拼法绕掉 —— 大小写变体目录名、cwd 不在仓根、跨树绝对路径、以及「真源不只有 JSON」（同一条 flag 把权威基准 .md 从 1014341B 截成 35759B；另一次把隔壁基线从 2203B 盖成 35759B。★ 这两个字节数是**不同版本产物**：35345B 是 v3.20 那一跑的序列化尺寸、35759B 是 v3.21 的，别当同一个量引用）⇒ **v3.21 不再加第四层守卫，整条取消写目标参数**（`--out`/`--output`/`--dump=`/位置参数一律 exit 1）。**v3.22（B149）补回取消时漏掉的一条通道**：把 `scripts/baselines` 做成符号链接 ⇒ `--write` 照样 exit 0 把文件写进另一棵树，而本树打印「逐份未动」（v3.21 删 `--out` 时把 realpath 的用法一起删了，只剩一个没用的 import）⇒ 要求 realpath(落点目录) 仍在 realpath(ROOT) 之内。**v3.24（B150）又补两条同族通道**（都是复核实测成立、我自己重跑确认）：① 只审父目录不够 —— 把基线**这一个文件**做成指向别处的符号链接就绕通，而目标**尚不存在**（悬空链接）时 `existsSync`/`realpathSync` 都说"没有这个文件"，第二版实测仍放行 ⇒ 现在审"落点本身"，realpath 抛错就退回 `readlinkSync` 声明的目标再判；② `git()` 继承全部环境变量 ⇒ `GIT_DIR`/`GIT_WORK_TREE` 指到别的树就能把 `fromCommit` 写成那棵树的 HEAD（实测本树 5a3ad0c7 被记成 e5d695b0、exit 0）⇒ 现在剥掉所有 `GIT_*` 让 git 自己发现树，再复核 `--show-toplevel` 是否就是扫描根。★ 一条通用口径：能影响"写到哪"的通道共四类（**命令行参数 / 工作目录 / 文件系统间接层 / 环境变量**），删掉其中一类不等于删掉这一族 ⇒ 每次收口都要把四类各自问一遍。<br>仍存的边界（别把这些读成「已封死」）：（别把这些读成「已封死」）：① 受保护真源清单自身没有与 git 跟踪集**双向对撞**的判据（新增基线漏进清单 ⇒ 证人看不见它）；② **落点仍由 cwd 决定** —— 从别的 checkout/工作树跑这个脚本，写的就是那棵树的同名基线（`fromCommit` 也取那棵树的 HEAD ⇒ 出处自洽，但尺实现与目标树可能不同版本）；这一条**刻意不拦**：本文件整套子进程判据依赖「真仓脚本 + 临时仓 cwd」这个形状，拦了等于拆掉隔离测试本身 ⇒ 任何文档不许把它写成「只能写本仓那一份基线」；③ 硬链接（同一 inode 两个路径）认不出，只能靠写完后的逐份实测**事后报**；④ 证人为 0 份时不构成对隔壁的证明（v3.22 起改打 ⚠️ 自限句）。',
  ],
};
// 无变化重冻也必须保留历史，不能把既往签字和判据抹掉。
if (prev?._setChangeLog) json._setChangeLog = prev._setChangeLog;
if (prev?._baselineHistory) json._baselineHistory = prev._baselineHistory;
if (prev?._floorRetirements) json._floorRetirements = prev._floorRetirements;
if (prev && changed.length) json._baselineHistory = [...(prev._baselineHistory || []), {
  generated: prev.generated, totals: prev.totals, byKind: prev.byKind, ratchet: prev.ratchet,
  sha256: createHash('sha256').update(readFileSync(BASELINE_PATH)).digest('hex'),
  reason,
}];
if (floorRetirements.length) json._floorRetirements = [...(prev?._floorRetirements || []), {
  at: json.generated.at, fromCommit: json.generated.fromCommit, retirements: floorRetirements,
}];
json.knownBlindSpots = [...new Set([...(prev?.knownBlindSpots || []), ...json.knownBlindSpots])];
/**
 * ★ 与 G4.1 同一个约定（v3.12/B132 起）：放行集合变化必须留痕。
 *   ⚠️ 留的这个 `landingPointsAfter` **今天还没有守卫在真基线上回撞它**：现量（2026-09-23）本份基线里
 *   `_setChangeLog` 尚不存在（本批两次重冻结都只搬行号）⇒ 写了也是没有对象的条件断言（B116 那一课）。
 *   "手改清单会当场红"目前**只对 G4.1 那份成立**（那边有 `nakedCountAfter` 断言），这边是"机制已备好、还没咬过人"。
 *   临时仓测试 ③ 钉的是"放行会留下这个数、且它等于放行后的实际落点数"。所有历史判据与放行记录保留，不截断早期依据。
 */
if (changed.length) {
  json._setChangeLog = [...(prev?._setChangeLog ?? []), {
    at: json.generated.at, reason, fromCommit: json.generated.fromCommit,
    added: Object.fromEntries(changed.map((n) => [n, drift[n].added])),
    removed: Object.fromEntries(changed.map((n) => [n, drift[n].removed])),
    landingPointsAfter: sum.total,
  }];
}
const serialized = JSON.stringify(json, null, 1) + '\n';
/**
 * ★★ 受保护真源的**逐份实测**（v3.21 起只服务 `--write` 这一条路）。
 *   清单 = `scripts/baselines/` 整目录（★ 递归，v3.20 复核 I-3：过去只列一层，嵌套子目录里的 json 证人看不见）
 *          + 住在目录外的已知基线（`scripts/os-vnext-audit-baseline.json`）。
 *   ⚠️ 这条证人**只**能证"这台工具自己有没有顺手改到隔壁"（同一个进程内的行为，判得住）；
 *      它**不能**证明"某个外部路径是不是真源" —— 那正是 B148 把 `--out` 整条取消的原因。
 *   ⚠️ 手工清单仍可能漏（task #33 是给这份清单立双向对撞判据的账）。
 */
function walkTruthSources(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkTruthSources(p, `${prefix}${f}/`));
    else if (st.isFile()) out.push(snapshotKeyOf(p));
  }
  return out;
}
/**
 * ★ B149（复核 BLOCKER-2，我在 /tmp 空 baselines 树里复现）：原来无论几份都打印「其余受保护真源 N 份
 *   已实测逐份未动」，N=0 也照打、且筛它的正则写的是 \\d+（含 0）⇒ 一句成就话可以什么都不证明。
 *   不能改成「0 份就中止」：夹具首冻时那个目录本来就是空的，中止会废掉整套子进程判据
 *   ⇒ 改成**自限句**：0 份时明确说「不构成对隔壁的证人」。
 */
/**
 * ★★ 计数只许数**真实存在**的那些（v3.22 自己踩出来的第二条）：`truthShas()` 会把清单里"此刻不存在"的
 *   条目也塞一个 `<不存在>` 的哨兵值进去 —— 实测在一棵"除自己以外没有别的基线"的临时树里，
 *   成就句仍然打印「其余受保护真源 **1** 份已实测逐份未动」，而那 1 份是一份**根本不在盘上**的 os-vnext 基线。
 *   ⇒ 一句"N 份已实测"里的 N 必须是"我手里真有 sha 的那几份"，否则 0 份的树可以靠清单刷出 1 份的门面。
 *   缺失的份数不藏起来：另外点名（"另有 M 份此刻不存在，未计入"）。
 */
function witnessPhrase(shas) {
  const self = snapshotKeyOf(BASELINE_PATH);
  const others = [...shas.entries()].filter(([k]) => k !== self);
  const real = others.filter(([, v]) => !String(v).startsWith('<'));
  const ghost = others.length - real.length;
  const tail = ghost > 0 ? `（清单里另有 ${ghost} 份此刻不存在，未计入）` : '';
  return real.length > 0
    ? `其余受保护真源 ${real.length} 份已实测逐份未动${tail}`
    : `⚠️ 本树除自己外没有第二份**真实存在**的受保护真源（0 份）⇒ 这一跑只证明「没写坏自己」，不构成对隔壁基线的证人${tail}`;
}
function truthShas() {
  const m = new Map();
  for (const rel of walkTruthSources(BASE_DIR)) {
    try { m.set(rel, createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex').slice(0, 16)); }
    catch { m.set(rel, '<读不到>'); }
  }
  for (const rel of EXTRA_TRUTH_SOURCES) {
    const p = join(ROOT, rel);
    m.set(rel, existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '<不存在>');
  }
  return m;
}
const diffOfTruthSources = (before, after) => [...new Set([...before.keys(), ...after.keys()])]
  .filter((f) => before.get(f) !== after.get(f))
  .map((f) => `${f}（${before.get(f) ?? '原本不存在'} ⇒ ${after.get(f) ?? '现在不存在'}）`);
/**
 * ★ 还原提示：`git show` 用 `-C ROOT` 取对象没错，但**重定向的目标**也必须落到那棵树里 ——
 *   v3.20 复核 MINOR 抓的就是"提示本身又假设了 cwd"。⇒ 目标写成绝对路径。
 */
const restoreHint = (files) => files.map((f) => `git -C ${ROOT} show HEAD:${f.split('（')[0]} > ${join(ROOT, f.split('（')[0])}`);
if (DUMP) {
  // ★ B148：唯一的"看内容"通道，只打到 stdout。不构造任何路径、不调用 writeFileSync ⇒ 探针类误写整族消失。
  const beforeShas = truthShas();
  process.stdout.write(serialized);
  const damaged = diffOfTruthSources(beforeShas, truthShas());
  if (damaged.length) {
    sysAbort(`ABORT: --dump 只该往 stdout 打印，却实测到受保护真源被改：\n   ${damaged.join('\n   ')}\n`
      + `   ⇒ 说明有人在 --dump 路径上加了写盘动作（这一条的存在就是为了当场抓住"回到旧路"）。\n`
      + `   还原（逐份、绝对路径，不要用 git checkout -- 连本批改动一起抹）：\n   ${restoreHint(damaged).join('\n   ')}`);
  }
  console.error(`[dump] 只打印到 stdout；` + witnessPhrase(beforeShas));
  process.exit(0);
}
if (!WRITE) {
  console.log('预演（未写盘）：落点', json.totals.landingPoints, '| 桶', JSON.stringify(json.byKind),
    '| wide', json.totals.wideFragments, '⇒ 要真重冻结请加 --write；只想看内容请加 --dump');
} else {
  const beforeShas = truthShas();
  try { writeFileSync(BASELINE_PATH, serialized); }
  catch (e) { sysAbort(`ABORT: --write 落盘失败（${e.code || e.message}）⇒ 基线没改成，别按已重冻结继续走`); }
  // 本份基线**本来就该**变；证人盯的是"别的真源有没有被牵连"
  const dragged = diffOfTruthSources(beforeShas, truthShas()).filter((s) => !s.startsWith(snapshotKeyOf(BASELINE_PATH)));
  if (dragged.length) {
    sysAbort(`ABORT: --write 之后实测到**其他**受保护真源被改：\n   ${dragged.join('\n   ')}\n`
      + `   这台写手只该改 ${BASELINE_REL}。逐份还原（绝对路径，不要用 git checkout --）：\n   ${restoreHint(dragged).join('\n   ')}`);
  }
  console.log('基线已写：落点', json.totals.landingPoints, '| 桶', JSON.stringify(json.byKind),
    '| wide', json.totals.wideFragments, '| ' + witnessPhrase(beforeShas));
}
