/**
 * gate-pairing-check 的证人（v3.76 · B192）
 *
 * 为什么这个文件必须存在：B192 判的就是"台账写了一道仓内不存在的守卫"。
 * 把谓词落进仓内只是第一步——**没有证人的守卫和没有守卫一样**（复核 #17 I-1 判过 gate-summary 这一次）。
 * 所以本文件的重点不是"函数返回对不对"，而是：**每一种缺陷都被它对应的那条通道抓住，
 * 且干净仓与历史 ignored 件都不会被误拦**（后者防的是这把刀永远红、下一批被人删掉）。
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, symlinkSync, rmSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { selfTest, checkPre, checkPost, unstagedChanges, stagedSet, isIgnored, untrackedAdvisory, indexFlagAnomalies, makeRepo } from './gate-pairing-check.mjs';

/**
 * ★ B205（v3.102 修）：本文件每条用例都 spawn 子进程 / 建临时 git 仓，满并发 + 机器负载下单测实测可到 8176ms
 *  ⇒ 撞根域默认 5s 档（v3.102 标准命令复现：4 条 `Test timed out in 5000ms.`）。
 *  只给这一族抬阈值（30s，与 server/vitest.config.ts 同值），不动根域全局 —— 全局抬会把"真挂住"一起掩护掉。
 */
vi.setConfig({ testTimeout: 30_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'gate-pairing-check.mjs');
/** 真跑 CLI 子进程：退出码与输出**都**要拿到（复核 #19 BLOCKER-2：证人只 import 函数，出口层零证人）。
 *  `entry` 默认是仓内那个真实路径；符号链接那一格必须传**链接路径**，
 *  否则就是在拿真实路径验"符号链接会不会坏"（本批被 g5 突变当场证伪：那样是恒绿证人）。 */
const cli = (args: string[], cwd: string, entry: string = TOOL) => {
  try {
    // ★ B205 复核 #25：原先没有 timeout ⇒ 子进程吊住时用例会**无限等**（同步体不受 testTimeout 约束）。
    //   20s 上限 ≈ 实测最慢单次 spawn 的 10 倍；超时抛错后走下面的 catch 折成 code=-1 ⇒ 断言当场红，而不是挂死。
    const out = execFileSync('node', [entry, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : -1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

describe('gate-pairing-check · B192：台账写的守卫必须在仓内、且真的会拦', () => {
  it('★ --self-test 的每一种缺陷都被抓住，且基线不误拦（这是 B192 的活路径证据）', () => {
    const rs = selfTest();
    expect(rs.length, '自检项数固定为 10：基线 + ① + ②两个方向 + ③两个方向 + ④ + ⑥旗标 + 中文名反面对照 + advisory 不越界').toBe(10);
    const failed = rs.filter((r) => !r.ok).map((r) => `${r.name} ⇒ ${r.detail}`);
    expect(failed, '有通道抓不住它的反例（或永远红）：\n' + failed.join('\n')).toEqual([]);
    expect(rs[0].detail, '第一项必须是"不误拦"的基线，而不是某条拦截').toMatch(/放行/);
    // ★ 中文名那一格是 v3.76 现量出来的坑：git 默认 quotepath 会把中文路径转义，
    //   expect/cite 两侧就对不上 ⇒ 合法的一批被自己的前置挡在门外（本仓两份权威文档正是中文名）
    const cn = rs.find((r) => r.name.startsWith('中文名'));
    expect(cn, '自检里必须有"中文名不许误判"这一格').toBeTruthy();
    expect(cn.detail, cn.detail).toMatch(/放行/);
  });

  it('★ 复核给的那一刀（pathspec 只提交一半）：pre 允许瞎，post 必须点出 b.ts', () => {
    const rs = selfTest();
    const fourth = rs.find((r) => r.name.startsWith('缺陷④'));
    expect(fourth, '自检里没有缺陷④这一项').toBeTruthy();
    expect(fourth.detail, '这一项必须同时记下"pre 沉默"与"post 抓到"，否则等于没复核到那个反例').toMatch(/pre 在这一刀下确实沉默/);
    expect(fourth.detail).toMatch(/post 抓到 b\.ts=是/);
    expect(fourth.ok).toBe(true);
  });

  it('★ 被 add -f 强塞进索引的 ignore 件也要问出来（check-ignore 不带 --no-index 时会放过它）', () => {
    const rs = selfTest();
    const third = rs.find((r) => r.name.includes('add -f'));
    expect(third.ok, third.detail).toBe(true);
    expect(third.detail).toMatch(/\.gitignore 命中/);
  });

  it('★ advisory 那一族不许升级成拦截：历史 ignored scratch 不该挡下本批提交', () => {
    const rs = selfTest();
    const adv = rs.find((r) => r.name.startsWith('advisory'));
    expect(adv.ok, adv.detail).toBe(true);
    expect(adv.detail).toMatch(/pre 拦截=0 项/);
    expect(adv.detail, 'advisory 必须真的看见东西，否则这一格是在空转').toMatch(/advisory 列出 [2-9] 项/);
  });

  it('被 import 时不得有副作用（否则测试一 import 就被 process.exit 打死）', () => {
    const src = readFileSync(join(HERE, 'gate-pairing-check.mjs'), 'utf8');
    // ★ v3.77：守卫换成共用的 `isCliEntry`（两侧 realpath）。这里钉的是"走的是那份唯一实现"，
    //   "经符号链接也真跑得起来"由下面那格**真 spawn** 作证 —— 只钉字符串就是形状已钉、行为未证。
    expect(src).toMatch(/const RUNNER = isCliEntry\(import\.meta\.url\);/);
    expect(src.match(/^if \(RUNNER\) \{/m), 'CLI 段必须整块包在 RUNNER 守卫里').toBeTruthy();
    // 反向：守卫之外不许有 process.exit（B178 那批的"死代码分支"教训：写在守卫里才算被 import 安全）
    //   ★ 用**本文件内**的窄剥离器，不 import 仓内那个共用 stripComments（B76：它曾让 1183 行代码对九条尺隐形）
    const outside = src.slice(0, src.indexOf('if (RUNNER) {'))
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（文件头那段就把 "process.exit" 写在散文里）
      .replace(/\/\/[^\n]*/g, '');            // 行注释
    expect(outside.includes('process.exit'), '守卫之前出现 process.exit ⇒ import 即退出').toBe(false);
    expect(outside.includes('console.log'), '守卫之前也不许打印 ⇒ import 就脏了输出').toBe(false);
  });

  it('★ 分隔符用错要被挑明（我自己就踩过：把空格当分隔符传 --cite，工具只会说"未跟踪"，白跑一次全量）', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const p = checkPre(dir, { expect: [], cite: ['docs/甲.md docs/乙.md'] });
    const hit = p.find((x) => x.ch.includes('分隔符'));
    expect(hit, '含空格的引用项必须单独报"分隔符用错"，不许混在"未跟踪"里').toBeTruthy();
    expect(hit.items[0]).toMatch(/docs\/甲\.md docs\/乙\.md/);
    // 反向：正确用逗号时不许出现这一条
    const q = checkPre(dir, { expect: [], cite: ['scripts/gate-pairing-check.mjs'] });
    expect(q.some((x) => x.ch.includes('分隔符')), '正常清单不许被误报').toBe(false);
  });

  it('导出的四条谓词都可用（防止以后把某个通道改成死值却没人发现）', () => {
    for (const fn of [checkPre, checkPost, unstagedChanges, stagedSet, isIgnored, untrackedAdvisory, indexFlagAnomalies, selfTest]) {
      expect(typeof fn).toBe('function');
    }
    // 在一个空目录（不是 git 仓）里调用：必须"报告失败"而不是抛异常或假装干净
    const dir = dirname(fileURLToPath(import.meta.url));
    const bad = checkPost(dir, { cite: ['scripts/__definitely_not_cited_76__.ts'] });
    expect(bad.length, '引用了一个不存在的落点，必须出声').toBeGreaterThan(0);
    expect(bad.some((x) => x.items.some((i) => i.includes('__definitely_not_cited_76__')))).toBe(true);
  });

  it('★ 复核 #19：②的"漏塞"与③的"不在跟踪集"两个方向现在各自有名有姓（原先两向都零证人）', () => {
    const rs = selfTest();
    const miss = rs.find((r) => r.name.includes('漏塞'));
    expect(miss, '自检里没有"漏塞"这一项 ⇒ ②只验了"多塞"，台账那句"管漏塞/多塞"仍是半证').toBeTruthy();
    expect(miss.ok, miss.detail).toBe(true);
    expect(miss.detail).toMatch(/docs\/never-written\.md/);
    const untracked = rs.find((r) => r.name.includes('不在跟踪集'));
    expect(untracked, '自检里没有"不在跟踪集"这一项 ⇒ ③只验了 ignore 那一向').toBeTruthy();
    expect(untracked.ok, untracked.detail).toBe(true);
    // 两个子形状都要在：盘上有文件但没 add / 连文件都没有
    expect(untracked.detail).toMatch(/文件在盘上/);
    expect(untracked.detail).toMatch(/连文件都没有/);
  });

  it('★ 复核 #19 BLOCKER-2：CLI 的**出口层**要真跑 —— 脏仓退 1、干净退 0、pre 不带清单退 2', () => {
    const dir = makeRepo();
    try {
      // (1) 干净仓 + 清单对得上 ⇒ 0
      const clean = cli(['pre', '--expect=', '--cite=docs/base.md'], dir);
      expect(clean.code, clean.out).toBe(0);
      expect(clean.out).toMatch(/OK pre：硬通道全干净（跑过的通道=①②③⑥）/);
      // (2) 改了没暂存 ⇒ 拦下，且退出码真的非 0（突变掉 process.exit(1) 时这一格就是唯一会红的证人）
      appendFileSync(join(dir, 'docs', 'base.md'), '偷改\n');
      const dirty = cli(['pre', '--expect='], dir);
      expect(dirty.code, '非 0 才是"拦下了"；只打印不退出＝没有牙齿').not.toBe(0);
      expect(dirty.out).toMatch(/①改了但没暂存/);
      expect(dirty.out).toMatch(/拒绝提交/);
      // (3) pre 不带 --expect ⇒ 用法错（②整条被静默关掉这一族）
      const noExpect = cli(['pre'], dir);
      expect(noExpect.code).toBe(2);
      expect(noExpect.out).toMatch(/不传等于把②整条关掉/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('★ 复核 #19 BLOCKER-1：经符号链接调用不许静默退 0（修复前实测输出 0 字节、rc=0）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpc-link-'));
    try {
      const link = join(dir, 'gpc.mjs');
      symlinkSync(TOOL, link);
      // 前置断言：链接路径与真实路径必须**不相等**，否则这一格退化成"拿真实路径去验符号链接"
      //（＝恒绿证人；本批第一版就是这么写的，被突变 g5 当场证伪——摘掉守卫它照样绿）。
      expect(realpathSync(link)).not.toBe(link);
      expect(realpathSync(link)).toBe(TOOL);
      const r = cli(['--self-test'], dir, link);
      expect(r.out.length, '输出 0 字节＝CLI 整块没跑（守卫把符号链接路径误判成"被 import"）').toBeGreaterThan(0);
      expect(r.code, r.out.slice(-200)).toBe(0);
      expect(r.out).toMatch(/自检小结：10 项，未通过 0 项/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⑥ 索引旗标这一维在真仓的现量读数（0 异常不等于这条永远不咬人：反例由自检那格作证）', () => {
    const root = dirname(HERE);
    const r = indexFlagAnomalies(root);
    expect(r.err, r.err || '').toBe(null);
    expect(r.total, '分母塌了（没数到索引项）时下面那句 0 毫无意义').toBeGreaterThan(1000);
    expect(r.items, '本仓今日应当 0 个异常旗标；非 0 就说明有人在拿 assume-unchanged 藏改动').toEqual([]);
  });
});
