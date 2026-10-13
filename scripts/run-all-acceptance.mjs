#!/usr/bin/env node
/**
 * run-all-acceptance.mjs —— 批量跑遍本仓**全部业务程序验收脚本**
 *
 * 为什么需要它：单跑一两条主链**不足以**判断软件可用（业务方明确指出：
 * 「走一条主链这样判断，永远都是很轻易通过的，对实际情况根本没有办法做完整判断」）。
 * 本仓已有 **64 个** acceptance-*.mjs/.ts —— 它们就是**业务程序级**的验收资产。
 * ⇒ 全部跑一遍，产出**通过矩阵**。
 *
 * 用法：node scripts/run-all-acceptance.mjs             # 全部
 *       node scripts/run-all-acceptance.mjs --only=req2 # 只跑匹配的
 *       node scripts/run-all-acceptance.mjs --list      # 只列清单（读每个脚本头部注释）
 *
 * ── ★★ 两个实测踩过的坑（都影响"能不能跑完"）──────────────────
 * ① **别用 `| tail -N` 起后台**：管道会**缓冲**输出 ⇒ 完全看不到进度 ✗
 *    ⇒ 本脚本**自己写实时日志** `scripts/.acceptance-run.log`（tail 它看进度）✓
 * ② **别用 `execFile` 的 `timeout`**：它只杀 **node** 进程，
 *    **杀不掉脚本自己起的 Chromium** ✗ ⇒ 表现为「日志停在某一页十几分钟不动」✗
 *    ⇒ 改用 `spawn(detached: true)` + 超时 `process.kill(-pid, 'SIGKILL')` **杀整个进程组** ✓
 *
 * 说明：
 *  · 逐条**串行**跑（脚本之间共用同一个 Postgres，并行会互相清行 ✗）
 *  · 每条有**超时**（默认 240s，建议 `ACC_TIMEOUT_MS=90000`），超时记为 TIMEOUT
 *  · 退出码只看 fail/timeout（gap 不算失败 —— 本仓约定）
 *  · 结果写 `scripts/.acceptance-matrix.json`，便于对比历次
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfCheck, isTrustworthy, formatBanner, acceptanceScriptFiles } from './lib/acceptance-selfcheck.mjs';

/**
 * ★★ G-3 批改掉的一处**测量完整性**缺陷（B35 家族）：
 *   原先这里是 `const ROOT = '/Users/qinwengu/.../apps/Bambook'`（**硬编码主 checkout**）。
 *   ⇒ 在任何 worktree（如 `apps/bambook-s0a`，分支 `s0/error-truth-foundation`）里跑本脚本，
 *     枚举与执行的都是**主目录那份脚本**，报告却挂在当前分支名下 ⇒ 读数与分支无关。
 *   现改为**由脚本自身位置推导**：谁的文件测谁的代码；同时开跑前打一次自证。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'scripts');
const TIMEOUT_MS = Number(process.env.ACC_TIMEOUT_MS || 240_000);
/** ★ 实时进度日志（后台跑时 tail 它看进度；stdout 会被管道缓冲 ✗） */
const LIVE_LOG = path.join(DIR, '.acceptance-run.log');
const live = (msg) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(line);
  try { appendFileSync(LIVE_LOG, line + '\n'); } catch (e) { console.error('live log fail:', e.message); }
};

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const listOnly = args.includes('--list');

/**
 * ★ G-3：自证。**注意时机**——必须在下面 `writeFileSync(LIVE_LOG,'')` 清空日志**之后**再写，
 *   否则真跑全量时这行会被自己抹掉（复核抓到：只有 `--list` 模式因提前 exit 才侥幸留下）。
 *   自证不过**不等于**不许跑（有时就是要观察别的分支），但它决定这份读数**能不能署在本分支这个 commit 上**。
 */
let SC = selfCheck();
let SCT = isTrustworthy(SC);
const provenanceLine = (tag, sc, t) => `自证${tag ? `(${tag})` : ''}：仓库=${path.basename(sc.repoRoot)} 分支=${sc.branch}@${(sc.head ?? '').slice(0, 7)}${sc.dirtyPaths.length ? ' +未提交' : ''} 库=${sc.db.name ?? '未知'} 端口=${(sc.ports ?? []).join('/')} 后端pid=${(Object.values(sc.listeners ?? {})).flat().map((b) => b.pid).join('/') || '无'} ⇒ ${t.ok ? '✓ 可署名' : '✗ 不可署名 :: ' + t.reasons.join(' ｜ ')}`;

/**
 * ★ 已知会挂的脚本（**不参与批量**）—— 如实登记原因，而不是默默跳过。
 * 保留在仓库里作为探索工具，但它的结论不可采信（见脚本头部注释）。
 */
const SKIP = new Set([
  'acceptance-core-chain-clickable.mjs', // 通用自动点击方案：判据两方向都错过（假 gap / 假通过）
  /**
   * ★ 下面两个**单独跑**，不进批量（实测原因）：
   *   它们都是**多浏览器 context 的长跑 UI 脚本**（deep 自述「单 agent 硬超时 8min」），
   *   在批量里会让整体时长翻几倍，而且**它们是"整站枚举"型**，单独跑更好读结果。
   *   ⇒ 跑法：`node scripts/acceptance-deep.mjs`（见 README/交接文档）
   */
  'acceptance-deep.mjs',
  'acceptance-parallel.mjs',
]);

/**
 * ★ 逐脚本超时覆盖（秒 → 用毫秒）：
 * UI 型脚本设计上就慢（`acceptance-deep.mjs` 自述「单 agent 硬超时 8min」），
 * 用全局 90s 会**误杀**它们 ✗ ⇒ 单独放宽。
 */
const TIMEOUT_OVERRIDE = {
  'acceptance-deep.mjs': 600_000,
  'acceptance-parallel.mjs': 480_000,
};

/**
 * 分母取自 lib 的 `acceptanceScriptFiles`（复核 MINOR-7：执行器与 env 普查此前各写一份 glob ⇒ 一边扩了另一边不知道）。
 * 该实现已显式排除 `.test.ts`（G-3 批复核抓到：判据守卫本身命中 glob 会被当业务脚本跑，每轮多两条与产品无关的红行）。
 */
const files = acceptanceScriptFiles(ROOT)
  .filter((f) => !only || f.includes(only));

/** 从脚本头部注释里抽一行「这是干什么的」 */
function summarize(f) {
  try {
    const head = readFileSync(path.join(DIR, f), 'utf8').split('\n').slice(0, 14);
    const line = head.find((l) => /^\/\/\s*\S/.test(l) && !/^\s*\/\/\s*[─═#\-*]/.test(l));
    return (line || '').replace(/^\/\/\s*/, '').slice(0, 70);
  } catch { return ''; }
}

if (listOnly) {
  console.log(`共 ${files.length} 个业务程序验收脚本（${SKIP.size} 个已知会挂、不参与批量）：\n`);
  for (const f of files) console.log(`  ${f.padEnd(52)} ${SKIP.has(f) ? '[SKIP] ' : ''}${summarize(f)}`);
  process.exit(0);
}

const run = (f) => new Promise((resolve) => {
  const isTs = f.endsWith('.ts');
  const cmd = isTs ? 'npx' : 'node';
  const argv = isTs ? ['tsx', path.join(DIR, f)] : [path.join(DIR, f)];
  const cwd = isTs ? path.join(ROOT, 'server') : ROOT;
  // ★ 逐脚本超时覆盖：UI 型脚本设计上就慢（deep 最多 8min）⇒ 全局 90s 会**误杀**它们 ✗
  const limit = TIMEOUT_OVERRIDE[f] ?? TIMEOUT_MS;
  // ★ detached ⇒ 子进程自成进程组 ⇒ 超时可 kill(-pid) 把它起的浏览器**一起杀** ✓
  const child = spawn(cmd, argv, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let killed = false;
  let settled = false;
  const settle = (r) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(watchdog); resolve(r); } };
  const timer = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }, limit);
  /**
   * ★★ 看门狗（belt & braces）：万一 `exit` 也不触发（残留 fd / 僵尸），
   *   到点**强制收尾** ⇒ 运行器**永远不会无限等** ✓
   */
  const watchdog = setTimeout(() => {
    settle({ file: f, status: 'TIMEOUT', pass: null, fail: null, gap: 0, tail: `看门狗强制收尾（${limit / 1000}s + 15s）` });
  }, limit + 15_000);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('error', () => { clearTimeout(timer); resolve({ file: f, status: 'SPAWN_ERROR', tail: '' }); });
  /**
   * ★★ 必须用 **`exit`** 而不是 **`close`**（实测踩过，会导致整个批量**卡死**）：
   *   `close` 要等 **stdio 全部关闭** ✗ —— 而脚本自己起的 **Chromium 继承了那对管道** ✗
   *   ⇒ 即使 node 被 SIGKILL，**管道仍开着** ⇒ `close` **永不触发** ⇒ 运行器无限等 ✗
   *   `exit` 是「**进程退出即触发**」✓，与管道状态无关 ✓
   */
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    // 显式销毁管道，避免残留 fd 拖住事件循环
    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* ignore */ }
    const tail = out.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 220);
    const m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败(?:\s*\/\s*(\d+)\s*缺口)?/);
    const m2 = out.match(/结果：(\d+)\/(\d+)\s*通过/);
    resolve({
      file: f,
      status: (killed || signal === 'SIGKILL') ? 'TIMEOUT' : (code === 0 ? 'PASS' : 'FAIL'),
      pass: m ? Number(m[1]) : (m2 ? Number(m2[1]) : null),
      fail: m ? Number(m[2]) : (m2 ? Number(m2[2]) - Number(m2[1]) : null),
      gap: m && m[3] ? Number(m[3]) : 0,
      tail,
    });
  });
});

const queue = files.filter((f) => !SKIP.has(f));
writeFileSync(LIVE_LOG, '');
live(provenanceLine('起跑', SC, SCT));
// ★ B160：原写法只在**不可信**时才打 banner ⇒ "日志里没有自证块"这一形态同时意味着
//   ①测过且可信 ②压根没测。两种情形必须可分辨 ⇒ 无条件打。
console.log(formatBanner(SC));
/**
 * ★★ 跑前**先给真库拍行数快照** —— 跑完与它对撞，兜住"任何原因造成的残留" ✗
 *   （为什么不静态扫脚本：见文件末尾的详细说明 —— **静态不可靠** ✗）
 */
try {
  execSync(`node ${path.join(DIR, 'db-rowcount.mjs')} --snapshot`, { encoding: 'utf8', cwd: ROOT });
  live('✓ 已拍真库行数快照（跑完会自动对撞 ✓）');
} catch (e) {
  live(`⚠️ 拍快照失败（不影响跑批，但**跑完无法对撞残留** ✗）：${String(e.message).slice(0, 80)}`);
}

live(`跑 ${queue.length} 个业务程序验收脚本（串行 · 每条超时 ${TIMEOUT_MS / 1000}s · 跳过 ${files.length - queue.length} 个已知会挂的）`);

const rows = [];
for (const [i, f] of queue.entries()) {
  const started = Date.now();
  const r = await run(f);
  r.secs = Number(((Date.now() - started) / 1000).toFixed(0));
  rows.push(r);
  const icon = { PASS: '✅', FAIL: '❌', TIMEOUT: '⏱', SPAWN_ERROR: '💥' }[r.status] || '?';
  const cnt = r.pass != null ? `${r.pass} 通过 / ${r.fail} 失败${r.gap ? ` / ${r.gap} 缺口` : ''}` : '';
  live(`${icon} [${String(i + 1).padStart(2)}/${queue.length}] ${f.padEnd(50)} ${String(r.secs).padStart(4)}s  ${cnt}`);
  if (r.status !== 'PASS' && r.tail) live(`      ↳ ${r.tail}`);
}

const by = (s) => rows.filter((r) => r.status === s).length;
live('');
live('═══ 汇总 ═══');
/**
 * ★ 第 11 批复核处置：这一行此前**无条件**打 ✅，而自证不过的那一轮（ENV_MISSING /
 *   ARTIFACT_MISMATCH(8081 其实是 main)）照样输出「1/75 ✅ 11 通过」⇒ 读数被署到不该署的分支上。
 *   汇总行现在必须先自报自证结论，否则『只看汇总就抄数』这件事没有任何东西挡住。
 */
const trustTag = SCT.ok ? '✓ 可署名' : `✗ 不可署名（${SCT.reasons.join(' ｜ ')}）`;
live(`  自证（开局）= ${trustTag}${SCT.ok ? '' : ' ⇒ 下面所有 ✅ 只代表脚本自报通过，不代表测的是本分支本 commit'}`);
live(`  总 ${rows.length} · ${SCT.ok ? '✅' : '⚠️'} PASS ${by('PASS')} · ❌ FAIL ${by('FAIL')} · ⏱ TIMEOUT ${by('TIMEOUT')} · 💥 SPAWN ${by('SPAWN_ERROR')}`);
const bad = rows.filter((r) => r.status !== 'PASS');
if (bad.length) {
  live('★ 未通过清单：');
  for (const r of bad) live(`  ${r.status}  ${r.file}  ↳ ${r.tail}`);
}
/**
 * ★ 收尾再取证一次：76 条 × 最长 240s 串行，中途完全可能有人重启/换后端。
 *   只跑前证一次 = 证明的是"开局那一刻"，不是这 3 小时。⇒ pid/HEAD 变了就记 BACKEND_CHANGED，
 *   并把结论**写进产物**（不是只打在控制台），否则机读矩阵里查不到自己测的是谁。
 */
const SC2 = selfCheck();
const SCT2 = isTrustworthy(SC2);
const pidOf = (x) => Object.values(x.listeners ?? {}).flat().map((b) => b.pid).join('/');
const backendChanged = pidOf(SC2) !== pidOf(SC) || (SC2.head ?? '') !== (SC.head ?? '');
if (backendChanged) live(`★ BACKEND_CHANGED：起跑 pid=${pidOf(SC) || '无'} HEAD=${(SC.head ?? '').slice(0, 7)} → 收尾 pid=${pidOf(SC2) || '无'} HEAD=${(SC2.head ?? '').slice(0, 7)} ⇒ 本轮读数**跨了两个不同的被测对象**，整轮不可署名`);
live(provenanceLine('收尾', SC2, SCT2));
writeFileSync(path.join(DIR, '.acceptance-matrix.json'), JSON.stringify({
  at: new Date().toISOString(), timeoutMs: TIMEOUT_MS,
  // ★ 溯源（复核抓到：原先 JSON 里零溯源字段 ⇒ "报告带着结论"只是控制台现象）
  provenance: { start: SC, startTrust: SCT, end: SC2, endTrust: SCT2, backendChanged, trustworthy: SCT.ok && SCT2.ok && !backendChanged },
  rows,
}, null, 2));
live(`矩阵已写 scripts/.acceptance-matrix.json（含 provenance：trustworthy=${SCT.ok && SCT2.ok && !backendChanged}）`);

/**
 * ★★ 真库「行数对撞」—— 兜住**任何原因**造成的残留 ✗
 *
 * 为什么不静态扫脚本：**不可靠** ✗（实测）
 *   · 把 `POST /api/auth/login`（每个脚本都有的登录）误判成写 ✗ ⇒ 40 个假阳性
 *   · 修正后只剩 3 个 —— 但**真留下残留的 `req2-*` 不在里面** ✗
 *     （它们的写走 `api('POST', path)` 封装 ⇒ 静态抓不到 ✗）
 * ⇒ **换判据：不看写法，看结果** ✓（跑前数行数 → 跑后数行数 → 涨了就报警 ✗）
 */
try {
  live('');
  const out = execSync(`node ${path.join(DIR, 'db-rowcount.mjs')} --compare`, { encoding: 'utf8', cwd: ROOT });
  out.trim().split('\n').forEach((l) => live(l));
} catch (e) {
  // 退出码 1 = 有增长 ⇒ 正是我们要报警的情况 ✓
  const out = String(e.stdout || e.message || '');
  out.trim().split('\n').forEach((l) => live(l));
  live('★ **本次批量在真库留下了数据** ✗ —— 请查上面「增长」的模型，并按纪律清理（先备份 ✓）');
  // ★ 2026-09-19：给出**可执行**的下一步（原来只说「按纪律清理」，没指工具）。
  //   注意演练的域事件由**服务端异步投递**，脚本退出时的自清**不保证**清干净
  //   ⇒ 专用清扫是权威兜底（默认 dry-run，加 --apply 才删）。
  live('   下一步：node scripts/clean-drill-residue.mjs            # 先看清单（只读）');
  live('           node scripts/clean-drill-residue.mjs --apply    # 确认后清理（会先全量备份）');
}

process.exit(bad.length ? 1 : 0);
