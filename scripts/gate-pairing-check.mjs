#!/usr/bin/env node
/**
 * 提交成对性前置（v3.76 · B192 的处置）
 *
 * 病（复核 #18 两条独立 BLOCKER，我当场复现成立）：
 *   v3.75 的台账写着"链新增硬前置：`git add` 之后 `git diff --name-only` 与
 *   `git ls-files --others --exclude-standard` 都必须为空，非空即停"——可那两条谓词**只活在 /tmp
 *   的一次性脚本里**，仓内没有任何被跟踪文件实现它们。于是"修 B191（说过却没提交）的那一批，
 *   用同一个形态又犯了一次"：台账描述的守卫没有活路径。
 *   复核还给了一个我的谓词抓不住的反例：`git add a b` 之后用 pathspec 只提交 a ——
 *   ①② 在这一刀下**双双沉默**（下面 selfTest 的第 ④ 项实测就是"pre 确实沉默"），
 *   只有"提交之后还得干净"这条抓得到。
 * ⇒ 本文件是那道前置的**活路径**：谓词在仓内，证人（`gate-pairing-check.test.ts`）也在仓内。
 *
 * 通道（★ 先量过影响面：本仓 docs/scripts 下有 9 个被 .gitignore 命中的历史 scratch 件；
 *   若把"任何 ignored 文件"设成硬拦截，每一批都会被与本批无关的文件挡死 ⇒ 那把刀迟早被人删掉）：
 *   ① 工作树 vs 索引 必须无差异                     —— 管"改了没暂存"（v3.74 事故的本态）**硬**
 *   ② 暂存集必须恰好等于本批清单                     —— 管"漏塞 / 多塞"**硬**（`pre` 必须带 `--expect`，不带就退 2）
 *   ③ 台账引用的落点必须已被跟踪且未被 ignore         —— 管"取证件被 ignore 静默吞掉"（本仓 `*.log` 前科）**硬**
 *   ④ 提交之后 `git status --porcelain` 必须为空     —— 管 pathspec 半提交那一刀**硬**
 *   ⑥ 索引位标志必须正常（无 assume-unchanged/skip-worktree）—— 管复核 #19 的新逃逸：这两面旗会让 ①②③④ **全瞎** **硬**
 *   ⑤ 其余 ignored/未跟踪件：只打印，不拦            —— 这笔债在本批之外：登记，不假装清零（advisory）
 *
 * 用法：
 *   node scripts/gate-pairing-check.mjs pre  --expect=f1,f2 [--cite=f1,f2] [--roots=docs,scripts]
 *   node scripts/gate-pairing-check.mjs post [--cite=f1,f2]
 *   node scripts/gate-pairing-check.mjs --self-test
 * 退出码：0 通过；1 拦下（逐条打出逃逸落点）；2 用法/环境错（含 `pre` 没带 `--expect`）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

const argv = process.argv.slice(2);
const SELF = argv.includes('--self-test');
const MODE = argv.find((a) => a === 'pre' || a === 'post');
const listArg = (flag) => {
  const a = argv.find((x) => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1).split(',').map((s) => s.trim()).filter(Boolean) : null;
};
const EXPECT = listArg('--expect');
const CITE = listArg('--cite');
const ADVISORY_ROOTS = listArg('--roots') || ['docs', 'scripts', 'components', 'lib', 'services', 'server'];

const git = (args, cwd) => {
  try {
    // ★ 一律带 -c core.quotepath=off：git 默认把非 ASCII 路径**转义**输出，
    //   而本仓两份权威文档就叫中文名 ⇒ 不加这一条，②会把"中文名文件没暂存"误报成"漏塞 + 多塞"，
    //   把合法的一批挡在门外（自检第⑥格专门钉这一点）。
    // ★ B205 复核 #25：加 20s 上限 —— git 挂住时这个工具（提交钩子会调它）会**无限等**；
    //   超时抛错后照样走下面的 catch ⇒ 报 git 错，而不是把提交卡死。
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
  } catch (e) {
    return { __err: true, code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};
const rows = (x) => (typeof x === 'string' ? x.split('\n').map((s) => s.trim()).filter(Boolean) : null);

/** ① 工作树 vs 索引（含"暂存之后又改/又删"） */
export function unstagedChanges(cwd) {
  return rows(git(['diff', '--name-only'], cwd)) || ['<git diff 失败>'];
}

/** ② 索引 vs HEAD 的暂存集 */
export function stagedSet(cwd) {
  return rows(git(['diff', '--cached', '--name-only'], cwd)) || ['<git diff --cached 失败>'];
}

/** ③ 该落点是否被 .gitignore 命中（注意：check-ignore 只看规则，不看索引 ⇒ 连 `add -f` 进来的也照样问得出） */
export function isIgnored(cwd, p) {
  const r = git(['check-ignore', '-q', '--no-index', '--', p], cwd);   // ★ 不带 --no-index 会跳过索引里的路径 ⇒ add -f 塞进来的 ignore 件抓不到（自检第③项第一次就说它沉默）
  return !(r && r.__err);
}

/** ⑤ advisory：roots 下的未跟踪 / 被 ignore 文件（两条通道取并集；只列，不拦） */
export function untrackedAdvisory(cwd, roots) {
  const plain = rows(git(['ls-files', '--others', '--exclude-standard'], cwd));
  const ignored = rows(git(['ls-files', '--others', '--ignored', '--exclude-standard'], cwd));
  if (plain === null || ignored === null) return { err: 'git ls-files 失败', files: [] };
  const pref = roots.map((r) => (r.endsWith('/') ? r : r + '/'));
  const hit = (p) => p !== '.gitignore' && pref.some((x) => p.startsWith(x));
  return { err: null, files: [...new Set([...plain, ...ignored].filter(hit))].sort() };
}

/**
 * ⑥ 索引位标志异常（复核 #19 的新逃逸）：
 *   `git update-index --assume-unchanged <p>`（小写旗标）与 `--skip-worktree`（`S`）都让
 *   **工作树与索引的差异从 `git diff` 里消失**，同时 `git status --porcelain` 也不报 ⇒
 *   ①②③④ 四条通道结构性失明（实测：改内容后 pre/post 双双 RC=0）。
 *   本仓今日现量：3623 个索引项**全是 `H`**，零异常 ⇒ 这一条不会把合法批次挡在门外（先量再拦）。
 *   ⚠️ 已知边界：`S` 在开了 sparse-checkout 的仓里是正常状态，那时这一条会误拦 ⇒ 本仓未开
 *   （`git config core.sparseCheckout` 取不到值），若将来开了，要按 sparse 目录收窄而不是删掉整条。
 */
export function indexFlagAnomalies(cwd) {
  const raw = git(['ls-files', '-v'], cwd);
  if (typeof raw !== 'string') return { err: 'git ls-files -v 失败', items: [], total: 0 };
  const items = [];
  let total = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    const flag = line.slice(0, 1);
    const p = line.slice(2).trim();
    if (/^[a-z]/.test(flag) || flag === 'S') items.push(`${p}(flag=${flag})`);
  }
  return { err: null, items, total };
}

/** 提交前的硬通道（①②③⑥） */
export function checkPre(cwd, { expect = null, cite = null } = {}) {
  const problems = [];
  const u = rows(git(['diff', '--name-only'], cwd));
  if (u === null) problems.push({ ch: '①git diff 失败', items: ['<无法读取>'] });
  else if (u.length) problems.push({ ch: '①改了但没暂存', items: u });

  if (Array.isArray(expect)) {
    const st = rows(git(['diff', '--cached', '--name-only'], cwd)) || [];
    const exp = [...expect].sort();
    const missing = exp.filter((f) => !st.includes(f));
    const extra = st.filter((f) => !exp.includes(f));
    if (missing.length) problems.push({ ch: '②本批清单没全进暂存区', items: missing });
    if (extra.length) problems.push({ ch: '②暂存区里多塞了（不属于本批）', items: extra });
  }

  for (const p of cite || []) {
    // ★ 调用方如果把空格当分隔符传进来（我这批就真发生过），整串会变成一个"不存在的路径"，
    //   报出来的是"未跟踪"而不是"你分隔符用错了"⇒ 白跑一次全量。这里把它挑明。
    if (/\s/.test(p)) {
      problems.push({ ch: '③引用清单里有含空格的一项（多半是分隔符用错：本工具只认逗号）', items: [p] });
      continue;
    }
    const tracked = String(git(['ls-files', '--', p], cwd) || '').length > 0;
    if (!tracked) {
      problems.push({ ch: '③台账引用了它，但它不在索引/跟踪集里', items: [p + (existsSync(join(cwd, p)) ? '（文件在盘上）' : '（连文件都没有）')] });
    } else if (isIgnored(cwd, p)) {
      problems.push({ ch: '③台账引用了它，却被 .gitignore 命中（本仓 *.log 那一族）', items: [p] });
    }
  }
  const fl = indexFlagAnomalies(cwd);
  if (fl.err) problems.push({ ch: '⑥git ls-files -v 失败 ⇒ 索引位标志这一维没读数', items: [fl.err] });
  else if (fl.items.length) problems.push({ ch: '⑥索引被打了 assume-unchanged/skip-worktree 旗标 ⇒ ①②③④ 对这一族结构性失明', items: fl.items });
  return problems;
}

/** 提交后的硬通道（③④⑥） */
export function checkPost(cwd, { cite = null } = {}) {
  const problems = [];
  const res = rows(git(['status', '--porcelain'], cwd));
  if (res === null) problems.push({ ch: '④git status 失败', items: ['<无法读取>'] });
  else if (res.length) problems.push({ ch: '④提交后仍有残留（含 pathspec 半提交这一刀）', items: res });
  for (const p of cite || []) {
    if (git(['cat-file', '-e', `HEAD:${p}`], cwd).__err) problems.push({ ch: '③台账引用了它，但它不在 HEAD 里', items: [p] });
  }
  const fl = indexFlagAnomalies(cwd);
  if (fl.err) problems.push({ ch: '⑥git ls-files -v 失败 ⇒ 索引位标志这一维没读数', items: [fl.err] });
  else if (fl.items.length) problems.push({ ch: '⑥索引被打了 assume-unchanged/skip-worktree 旗标 ⇒ ①②③④ 对这一族结构性失明', items: fl.items });
  return problems;
}

// ─────────────── 自检：每种缺陷必须被它对应的那条通道抓住，且干净仓不误拦 ───────────────
/** 建一枚一次性临时 git 仓（**也是证人用的夹具** ⇒ 导出，免得测试那边手抄第二份建法）。 */
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-'));
  const g = (a) => {
    const r = git(a, dir);
    if (r && r.__err) throw new Error('git ' + a.join(' ') + ' 失败：' + r.err);
  };
  g(['init', '-q']);
  g(['config', 'user.email', 'gate@local']);
  g(['config', 'user.name', 'gate']);
  writeFileSync(join(dir, '.gitignore'), '*.log\nscripts/tmp-*.py\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'base.md'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  return dir;
}

export function selfTest() {
  const results = [];
  const run = (name, fn) => {
    const dir = makeRepo();
    try {
      const { escaped, detail } = fn(dir);
      results.push({ name, ok: escaped === false, detail });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  { // 基线：干净仓不许被拦（否则这四条是"永远红"的死尺，等于没有尺）
    const dir = makeRepo();
    const p = checkPre(dir, { expect: [], cite: ['docs/base.md'] });
    const adv = untrackedAdvisory(dir, ['docs', 'scripts']);
    rmSync(dir, { recursive: true, force: true });
    results.push({
      name: '基线·干净仓不该拦（证明这些通道不是永远红）',
      ok: p.length === 0 && adv.err === null,
      detail: p.length ? '误拦 ' + p.map((x) => x.ch).join('|') : '放行（advisory ' + adv.files.length + ' 项）',
    });
  }

  run('缺陷①改了没暂存（v3.74 事故的本态）', (dir) => {
    appendFileSync(join(dir, 'docs', 'base.md'), 'dirty\n');
    const p = checkPre(dir, { expect: [] });
    return { escaped: !p.some((x) => x.ch.startsWith('①')), detail: p.map((x) => x.ch).join('|') || '沉默' };
  });

  run('缺陷②暂存了不属于本批的文件（"多塞"也是脱钩）', (dir) => {
    writeFileSync(join(dir, 'scripts', 'a.ts'), 'a\n');
    writeFileSync(join(dir, 'scripts', 'stray.ts'), 'stray\n');
    git(['add', 'scripts/a.ts', 'scripts/stray.ts'], dir);
    const p = checkPre(dir, { expect: ['scripts/a.ts'] });
    const extra = p.find((x) => x.ch.startsWith('②'));
    return { escaped: !(extra && extra.items.some((i) => i.includes('stray.ts'))), detail: extra ? extra.items.join(',') : '沉默' };
  });

  run('缺陷②清单里的落点根本没进暂存区（"漏塞"这一向，复核 #19 判它原先零证人）', (dir) => {
    writeFileSync(join(dir, 'scripts', 'a.ts'), 'a\n');
    git(['add', 'scripts/a.ts'], dir);
    const p = checkPre(dir, { expect: ['scripts/a.ts', 'docs/never-written.md'] });
    const hit = p.find((x) => x.ch.startsWith('②本批清单没全进暂存区'));
    return { escaped: !(hit && hit.items.some((i) => i === 'docs/never-written.md')), detail: hit ? hit.items.join(',') : '沉默' };
  });

  run('缺陷③a 台账引用的落点没被 add（"不在跟踪集"这一向；盘上有文件也不许放行）', (dir) => {
    writeFileSync(join(dir, 'docs', 'cited.md'), '被台账引用了，但从未 add\n');
    const p = checkPre(dir, { expect: [], cite: ['docs/cited.md', 'docs/ghost.md'] });
    const hits = p.filter((x) => x.ch.startsWith('③台账引用了它，但它不在索引/跟踪集里'));
    const all = hits.flatMap((x) => x.items);   // ③ 是"每个落点一条"，不是"一条里列全"⇒ 取并集
    return {
      escaped: !(all.length === 2 && all.some((i) => i.includes('文件在盘上')) && all.some((i) => i.includes('连文件都没有'))),
      detail: hits.length ? `${hits.length} 条 · ${all.join(' | ')}` : '沉默',
    };
  });

  run('缺陷③b 台账引用的取证件被 .gitignore 吞掉（本仓 *.log 前科；连 add -f 也照样问出来）', (dir) => {
    writeFileSync(join(dir, 'docs', 'evidence.log'), 'proof\n');
    git(['add', '-f', 'docs/evidence.log'], dir);
    const p = checkPre(dir, { expect: ['docs/evidence.log'], cite: ['docs/evidence.log'] });
    const hit = p.find((x) => x.ch.startsWith('③'));
    return { escaped: !(hit && hit.items.some((i) => i.includes('evidence.log'))), detail: hit ? hit.ch : '沉默' };
  });

  run('缺陷④暂存 A 与 B、只用 pathspec 提交 A ⇒ pre 允许瞎，post 必须抓（复核给的反例）', (dir) => {
    writeFileSync(join(dir, 'scripts', 'a.ts'), 'a\n');
    writeFileSync(join(dir, 'scripts', 'b.ts'), 'b\n');
    git(['add', 'scripts/a.ts', 'scripts/b.ts'], dir);
    const preBlind = checkPre(dir, { expect: ['scripts/a.ts', 'scripts/b.ts'] }).length === 0;
    const c = git(['commit', '-q', '-m', 'only-a', '--', 'scripts/a.ts'], dir);
    if (c && c.__err) return { escaped: true, detail: 'git commit 失败：' + c.err.slice(0, 80) };
    const post = checkPost(dir);
    const caught = post.some((x) => x.items.some((i) => i.includes('b.ts')));
    return {
      escaped: !caught,
      detail: `pre 在这一刀下${preBlind ? '确实沉默（所以 post 不是装饰）' : '也抓到了'}；post 抓到 b.ts=${caught ? '是' : '否'}`,
    };
  });

  run('缺陷⑥索引旗标（assume-unchanged + skip-worktree）：①④ 实测双双失明，只有⑥抓得住（复核 #19 的逃逸）', (dir) => {
    git(['update-index', '--assume-unchanged', 'docs/base.md'], dir);
    appendFileSync(join(dir, 'docs', 'base.md'), '偷偷改的内容\n');
    const sw = join(dir, 'scripts', 'sw.ts');
    writeFileSync(sw, 'sw\n');
    git(['add', 'scripts/sw.ts'], dir);
    git(['commit', '-q', '-m', 'sw'], dir);
    git(['update-index', '--skip-worktree', 'scripts/sw.ts'], dir);
    appendFileSync(sw, '又偷偷改的\n');
    const blind1 = unstagedChanges(dir).length === 0;
    const blind4 = (rows(git(['status', '--porcelain'], dir)) || []).length === 0;
    const hit = checkPre(dir, { expect: [] }).find((x) => x.ch.startsWith('⑥'));
    return {
      escaped: !(blind1 && blind4 && hit && hit.items.some((i) => i.includes('docs/base.md')) && hit.items.some((i) => i.includes('scripts/sw.ts'))),
      detail: `①沉默=${blind1 ? '是' : '否'} ④沉默=${blind4 ? '是' : '否'}（两个方向都要"是"才证明这一族确实只有⑥看得见）`
        + ` ⇒ ⑥点名：${hit ? hit.items.join(' ') : '（没抓到）'}`,
    };
  });

  run('中文名落点不许被误判（本仓两份权威文档就是中文名；quotepath 会把它们转义成 \"\\346...\")', (dir) => {
    const cn = 'docs/\u4e2d\u6587\u6863\u6848.md';
    writeFileSync(join(dir, cn), '\u4e2d\u6587\u5185\u5bb9\n');
    git(['add', cn], dir);
    const p = checkPre(dir, { expect: [cn], cite: [cn] });
    return { escaped: p.length !== 0, detail: p.length ? '误拦：' + p.map((x) => x.ch + '\uff08' + x.items.join(',') + '\uff09').join(' | ') : '放行（中文名在 expect/cite 两侧都对得上）' };
  });

  run('advisory 不许越界成拦截：仓里有一堆历史 ignored scratch 时 pre 仍应放行', (dir) => {
    writeFileSync(join(dir, 'scripts', 'tmp-old-tool.py'), '# 上一批留下的，不属于本批\n');
    writeFileSync(join(dir, 'scripts', 'run.log'), 'noise\n');
    const p = checkPre(dir, { expect: [], cite: ['docs/base.md'] });
    const adv = untrackedAdvisory(dir, ['docs', 'scripts']);
    return {
      escaped: p.length !== 0 || adv.files.length < 2,
      detail: `pre 拦截=${p.length} 项（应为 0）；advisory 列出 ${adv.files.length} 项：${adv.files.join(', ')}`,
    };
  });

  return results;
}

/** 只有**直接执行**时才跑 CLI；被 import（`gate-pairing-check.test.ts`）时不得有副作用——
 *  否则测试一 import 就被 process.exit 打死（mutation-battery.mjs 里同一道守卫）。
 *  ★ v3.77（复核 #19 BLOCKER-1）：比较换成共用的 `isCliEntry`。原先这行自己比字符串，
 *    而 Node 加载 ESM 入口会 realpath ⇒ **任何经过符号链接的调用路径**都会判成"被 import"
 *    ⇒ 整块 CLI 静默跳过、退 0（实测输出 0 字节）。对门禁工具来说那就是一次假绿。 */
const RUNNER = isCliEntry(import.meta.url);
if (RUNNER) {
  const CWD = process.cwd();
  if (SELF) {
    const rs = selfTest();
    for (const r of rs) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} ⇒ ${r.detail}`);
    const bad = rs.filter((r) => !r.ok);
    console.log(`自检小结：${rs.length} 项，未通过 ${bad.length} 项`);
    if (bad.length) { console.log('!! 有通道抓不住它的反例（或有通道永远红）⇒ 这道前置不算立起来'); process.exit(1); }
    process.exit(0);
  }
  if (MODE !== 'pre' && MODE !== 'post') {
    console.error('用法：gate-pairing-check.mjs pre --expect=a,b [--cite=a,b] | post [--cite=a,b] | --self-test');
    process.exit(2);
  }
  // ★ v3.77（复核 #19）：`pre` 不带 `--expect` 时，②整条 `if (Array.isArray(expect))` 不进 ⇒
  //   "漏塞/多塞"一个字都没验，而输出仍是一句 `OK pre：硬通道全干净`（实测 RC=0）。
  //   ⇒ 缺清单就是用法错，不许降级成"少一条通道"继续放行。
  if (MODE === 'pre' && !Array.isArray(EXPECT)) {
    console.error('!! pre 必须带 --expect=…（逗号分隔）⇒ 不传等于把②整条关掉，"漏塞/多塞"这一维没有读数');
    process.exit(2);
  }
  const problems = MODE === 'pre' ? checkPre(CWD, { expect: EXPECT, cite: CITE }) : checkPost(CWD, { cite: CITE });
  for (const p of problems) console.log(`!! ${p.ch}：${p.items.slice(0, 12).join('  ') || '(空)'}`);
  if (MODE === 'pre') {
    const adv = untrackedAdvisory(CWD, ADVISORY_ROOTS);
    if (adv.files.length) {
      console.log(`   （advisory，不拦）roots 下还有 ${adv.files.length} 个未跟踪/被 ignore 的落点：${adv.files.slice(0, 10).join(', ')}${adv.files.length > 10 ? ' …' : ''}`);
    }
  }
  if (problems.length) {
    console.log(`⇒ B191/B192 那一族：本批有 ${problems.length} 类落点没和台账进同一枚提交 ⇒ 拒绝提交`);
    process.exit(1);
  }
  console.log(`OK ${MODE}：硬通道全干净（跑过的通道=${MODE === 'pre' ? '①②③⑥' : '③④⑥'}）`
    + (MODE === 'pre' ? `·暂存集恰好 = 本批 ${EXPECT.length} 个文件` : '')
    + (CITE ? `·引用 ${CITE.length} 个落点已进${MODE === 'pre' ? '跟踪集' : ' HEAD'}` : ''));
  process.exit(0);
}
