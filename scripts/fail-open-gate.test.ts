/**
 * G3 fail-open 判据 **接进门禁**（v2.53 批 · 台账 D94）
 *
 * ★ 为什么必须有这个文件（不是"顺手加判据"）：`scripts/check-fail-open-inventory.mjs` 写好后
 *   **全仓没有任何调用方**（`grep -rln check-fail-open-inventory` 只命中它自己）⇒
 *   一把没人跑的尺可以静默瞎掉，而 G3 的"L-A 零容忍"在账面上一句话都拦不住回退。
 *
 * ★ 判据与棘轮**分开**（这是本批唯一的口径决定，理由见脚本 BASELINE 注释与 D94）：
 *   - 判据：`TARGET.la = 0`（G3 原文"必须为 0"）—— 现存 191 处 ⇒ **未达标**，本文件断言"未达标"必须被说出来；
 *   - 棘轮：`BASELINE.la/la=191、lb=171`，只允许下降 ⇒ 新增一处当场红。
 *   ⇒ 把判据本身当退出码 = 永久红 = 没有门禁；但**不降格判据**，它留在账面与打印里。
 *
 * ★ 反面对照（S1：判据不许恒真）：把两条棘轮各下调 1，脚本必须红。
 *   没有这一段，"门禁绿"就无法区分"确实没回退"与"比较根本没跑"。
 */
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ★ B205（v3.102 修）：本文件每条用例都 spawn 子进程（`check-fail-open-inventory.mjs`），满并发 + 机器负载下
 *  单测实测可到 5212ms ⇒ 撞根域默认 5s 档（v3.102 标准命令复现：`Test timed out in 5000ms.`）。
 *  只给这一族抬阈值（30s，与 server/vitest.config.ts 同值），不动根域全局 —— 全局抬会把"真挂住"一起掩护掉。
 */
vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = join(ROOT, 'scripts/check-fail-open-inventory.mjs');

/** 一次扫描 ≈ 4s ⇒ 本文件共跑 4 次（其中两次是反面对照）；结果一律落盘可读，不靠记忆 */
const run = (args: string[]) => {
  const r = spawnSync('node', [SCANNER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  expect(r.error, `跑不动 ${args.join(' ')}：${r.error?.message}`).toBeUndefined();
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const json = (args: string[]) => {
  const r = run(args);
  // --json 的 stdout 必须是**纯** JSON（诊断走 stderr）⇒ 下游可以直接管道，不需要人眼
  expect(() => JSON.parse(r.out), `--json 的 stdout 混进了诊断信息：${r.out.slice(0, 160)}`).not.toThrow();
  return { ...r, j: JSON.parse(r.out) };
};

describe('G3 fail-open 判据的门禁化：尺要有人跑、棘轮要有牙齿、分母要非空', () => {
  const measured = json(['--json', '--baseline']);

  it('★ 分母自检：扫描面不许是空的（"0 命中"必须先区分"没毛病"与"没遍历"）', () => {
    expect(measured.j.filesScanned, `只扫到 ${measured.j.filesScanned} 个文件 ⇒ 枚举器八成瞎了，此时任何"零命中"都不作数`).toBeGreaterThanOrEqual(700);
    expect(measured.j.missing, `有分组没被覆盖：${JSON.stringify(measured.j.missing)}`).toEqual([]);
    /**
     * ★★ v2.57 修 BLOCK（独立复核抓出来的）：原来这三个断言写的是
     *   `expect(measured.j.byGroup[g]).toBeTruthy()` —— 而 `byGroup` 是脚本里
     *   `Object.fromEntries(['server','frontend','portal'].map(...))` **无条件造出来的空壳**，
     *   对象恒为真 ⇒ 断言恒绿。复核实测：把 portal 组改成只看 `.jsx`（贡献 0 个文件），
     *   filesScanned 仍 772、missing 仍 []、byGroup.portal 仍 `{L-A:0,…}` 仍 truthy、退出码仍 0。
     *   ⇒ 换成**每组实际扫到的文件数**（`scanned`，脚本本来就在统计），并加一条"加得回总数"：
     *   任何一组被静默剪掉 ⇒ scanned 之和 ≠ filesScanned ⇒ 红。
     */
    for (const g of ['server', 'frontend', 'portal']) {
      expect(measured.j.scanned[g], `分组 ${g} 一个文件都没扫到 ⇒ 该组的"零命中"不作数（枚举器瞎了）`).toBeGreaterThanOrEqual(1);
    }
    const sumScanned = ['server', 'frontend', 'portal'].reduce((s: number, g) => s + measured.j.scanned[g], 0);
    expect(sumScanned, `分组文件数加不回 filesScanned（${sumScanned} vs ${measured.j.filesScanned}）⇒ 有文件不属于任何分组，或被数了两次`).toBe(measured.j.filesScanned);
  });

  it('★ 分桶必须加得回总数（D89 定的规矩：加不回去就直接红，不许"总数另有来源"）', () => {
    const t = measured.j.totals;
    expect(t['L-A'] + t['L-B'] + t['待核实'], `分桶 ${JSON.stringify(t)} 加不回总数`).toBe(t.all);
    expect(measured.j.hits.length, `hits 明细 ${measured.j.hits.length} 条与 totals.all ${t.all} 不一致`).toBe(t.all);
    /**
     * ★ v2.57 改口径（复核 MINOR 第 4 条）：原来写 `expect(t['L-A']).toBe(191)` ——
     *   那等于**清掉一处 L-A 也红**（改进被当成漂移）。棘轮的"上界"已经由
     *   `--baseline` 的退出码 + 下面那条 git 历史断言负责，这里只钉"账面与尺没漂移"：
     *   读数必须 ≤ 冻结值，且必须与冻结值同源（不一致 = 文档里那个数不再是现量）。
     */
    expect(t['L-A'], `现存 L-A ${t['L-A']} 高于冻结基线 ${measured.j.baseline.la} ⇒ 回退了（这一条本该由退出码拦住，双写是为了把话说在断言里）`).toBeLessThanOrEqual(measured.j.baseline.la);
    expect(t['L-B'], `现存 L-B ${t['L-B']} 高于冻结基线 ${measured.j.baseline.lb}`).toBeLessThanOrEqual(measured.j.baseline.lb);
    // ★ v3.14 删掉了这里原本的 `expect(t['L-A']).toBeLessThanOrEqual(191)`：基线只能降 ⇒ 上一条（≤178）
    //   恒比这条（≤191）严 ⇒ 它是一个**永远咬不到人的第二处数字真源**（B77 那一族），留着只会让人以为 191 还有用。
  });

  /**
   * ★★ v3.14 复核 I-1：§2 那一行一直写着「钉住 191/171 这两个数（账面与尺一漂移就红）」，
   *   而实际钉的是**基线 vs 尺**；**台账里那个数没有任何断言在看**。复核实测：
   *   把账面 178 改成 165（五处）⇒ `authoritative-doc-shape` / `error-tier-hardcodes` / 本文件全绿。
   *   ⇒ 那句话此前是账面自我声明。现在补机器锚（仓内已有同款技术：B126 的 `[B126-COUNT]`）：
   *   §2 的两行必须各带一个锚，锚里的数必须等于尺**当场**读数。
   */
  it('★ 账面与尺相等对撞（I-1）：§2 的 L-A / L-B 两行必须带 [G3-LA] / [G3-LB] 锚，且锚里的数 = 尺当场读数', () => {
    const doc = fs.readFileSync(join(ROOT, 'docs', '交付目标与验收标准-2026-09-20.md'), 'utf8');
    const t = measured.j.totals;
    const cases: Array<[string, RegExp, number, string]> = [
      ['| **L-A 零容忍**', /\[G3-LA\]现存\*\*(\d+)\*\*/, t['L-A'], 'L-A'],
      ['| **L-B 基线化**', /\[G3-LB\]现存\*\*(\d+)\*\*/, t['L-B'], 'L-B'],
    ];
    for (const [prefix, anchor, live, name] of cases) {
      const row = doc.split('\n').find((l) => l.startsWith(prefix));
      expect(row, `§2 里找不到 ${prefix} 那一行 ⇒ 这条判据在权威基准上成了无主读数`).toBeTruthy();
      /**
       * ★ 唯一性先于相等性：锚只在一行上相等，全文却可能另有第二个同键锚。
       * v3.15 实测到活例：附录 v3.14 那行留着 `[G3-LA]现存**178**`（上一批的时点值），
       * 而下面这条只读 §2 那行 ⇒ "同一个机器键两个值、其中一个已过期"照样全绿。
       * 相等对撞只有在"这个键只有一个实例"时才是对撞，否则只是碰巧比中了新的那个。
       */
      const all = doc.match(new RegExp(anchor.source, 'g')) ?? [];
      expect(all.length, `${name} 的机器锚在全文出现 ${all.length} 次 ⇒ 至少一处是过期时点值，账面出现两个"唯一出处"（锚只能住在 §2 那行）`).toBe(1);
      const hit = anchor.exec(row!);
      expect(hit, `${name} 那行没有 ${String(anchor)} 这个机器锚 ⇒ 账面上的数无人对撞（复核就是在这看见"改成 165 全绿"的）`).toBeTruthy();
      expect(Number(hit![1]), `台账写的 ${name} 现存 ${hit![1]} ≠ 尺当场读数 ${live} ⇒ 要么文档过期，要么尺变了没人说`).toBe(live);
    }
  });

  it('★ 棘轮：--baseline 今天必须绿，且基线不许被置空来变绿；判据仍写明"未达标"', () => {
    expect(measured.code, `棘轮比较结果非 0（回退了？）：${measured.err.slice(-400)}`).toBe(0);
    expect(measured.j.baseline.la, '把 L-A 棘轮设成 null 等于关掉判据 ⇒ 不接受').not.toBeNull();
    expect(measured.j.baseline.lb, '把 L-B 棘轮设成 null 等于关掉判据 ⇒ 不接受').not.toBeNull();
    expect(measured.j.target.la, 'G3 的 L-A 判据是"必须为 0"，改这个数 = 放宽判据（§0.1 禁止）').toBe(0);
    // 未达标这句话必须由脚本说出来：不许用"删掉打印"来制造绿色
    expect(measured.err + measured.out, 'L-A 未达标却没在输出里被说出来 ⇒ 这条判据会被读成"已达标"').toContain('G3 判据未达标');
  });

  it('★ 反面对照（这条决定上面三条是不是恒绿）：任一回退都必须咬到', () => {
    // 分类器还能分出声：两种形状各自至少一条 ⇒ 若枚举/掩码坏了，这里先红
    const shapes = new Set(measured.j.hits.map((h: { shape: string }) => h.shape));
    expect(shapes.has('catch'), '一把连 catch→0 都分不出来的尺不可能抓得住回退').toBe(true);
    expect(shapes.has('nullish'), '一把连 ?? 0 都分不出来的尺不可能抓得住回退').toBe(true);

    // 棘轮有牙齿：基线各下调 1 ⇒ 今天这两个数就是"新增一处"的等价物 ⇒ 必须红
    const laTight = run(['--json', '--baseline', `--la=${measured.j.totals['L-A'] - 1}`]);
    expect(laTight.code, 'L-A 棘轮下调一格仍然绿 ⇒ 比较根本没生效（恒绿的假门禁）').toBe(1);
    const lbTight = run(['--json', '--baseline', `--lb=${measured.j.totals['L-B'] - 1}`]);
    expect(lbTight.code, 'L-B 棘轮下调一格仍然绿 ⇒ 比较根本没生效（恒绿的假门禁）').toBe(1);
    // 自测（故意放错的形状必须撞对分类器）：跑不动或红都算这条判据失效
    const sc = run(['--selfcheck']);
    expect(sc.code, `--selfcheck 非 0：${sc.out.slice(-400)}${sc.err.slice(-400)}`).toBe(0);
  });

  it('★ 反面对照要覆盖"失败出口"本身：--la/--lb 写错字不能变成"绿着关掉棘轮"', () => {
    /**
     * 为什么要单独一条：`Number('abc')` = NaN，而 `191 > NaN` 是 **false** ⇒
     * 在 v2.57 之前 `--la=abc` 会**悄悄把 L-A 棘轮关掉并退出 0**。
     * 更糟的是：修它的那条分支用的是本函数 1100 行之后才 const 出来的 `diag()`
     * ⇒ 一旦真触发就抛 ReferenceError（TDZ）而不是红着退出。
     * ⇒ 这条断言把"失败出口"变成活路径（S1：不许只测 happy path 就说"有守卫"）。
     */
    for (const bad of ['abc', '-1', '1.5', '']) {
      const r = run(['--json', '--baseline', `--la=${bad}`]);
      expect(r.code, `--la=${JSON.stringify(bad)} 竟然退出了 ${r.code} ⇒ NaN/负数会把棘轮关掉`).not.toBe(0);
      expect(r.err, `--la=${JSON.stringify(bad)} 没说是因为参数非法（怕被读成"扫描失败"）`).toContain('才合法');
    }
  });
});

/**
 * ## ★★ 棘轮的"牙齿"到底存不存在（v2.57 新增，起因是复核的 IMPORTANT 第 5 条）
 *
 * 复核实测：把脚本里的 `BASELINE.la` 从 191 改成 **300**，退出码仍 0、四条守卫断言**全绿**
 * —— 因为基线与读数都在同一个文件里、"只允许下降"只是**注释**。
 * 也就是说 D94 里那句"棘轮换来的是从今天的读数起不许变多"当时**只做到了"不许 > 自己写的数"**，
 * 而那个数本身没人守。⇒ 两处改动：
 *   ① 冻结值搬进 `scripts/baselines/g3-fail-open.json`（脚本读不到就红，不退回内置默认）；
 *   ② 本条对**该文件的 git 历史**断言"序列非递增" ⇒ 上调基线这件事会在历史里留一条上升记录 = 红。
 *
 * ⚠️ 诚实边界：本文件**首次**入库时历史长度 = 1，所以今天只能证明"机制已接上、谓词本身不是恒真"，
 *    不能证明"它咬过人"。谓词的判别力用下面的反面对照钉（含一条恒真版本）。
 */
const BASELINE_FILE = join(ROOT, 'scripts', 'baselines', 'g3-fail-open.json');
const BASELINE_REL = 'scripts/baselines/g3-fail-open.json';

/** 纯谓词：非递增（相等允许 = 重跑没变化；出现任何一次上升 = 放宽） */
const isNonIncreasing = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] >= v);

describe('G3 棘轮的冻结值文件与它的 git 历史（"只允许下降"必须是判据，不是注释）', () => {
  it('★ 冻结值确实住在基线文件里，脚本读它、不再自带默认值', () => {
    const j = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    expect(typeof j.la).toBe('number');
    expect(typeof j.lb).toBe('number');
    // 与尺的实际输出同源：基线文件里的数 ≠ 脚本报告用的数 ⇒ 说明脚本里还留着第二份（并行真源）
    const measured = json(['--json', '--baseline']);
    expect(measured.j.baseline.la, '脚本用的 L-A 基线与基线文件不符 ⇒ 存在第二处真源').toBe(j.la);
    expect(measured.j.baseline.lb, '脚本用的 L-B 基线与基线文件不符 ⇒ 存在第二处真源').toBe(j.lb);
    // 判据本身不在这个文件里：把 TARGET.la=0 搬进来 = 给"放宽判据"留了个改一个数就行的口子
    expect('target' in j || 'targetLa' in j, 'TARGET（L-A 必须为 0）不许进基线文件 —— 判据不接受基线').toBe(false);
  });

  it('★ git 历史里 la/lb 必须非递增；历史只有一条时如实说明"还没咬过人"', () => {
    const revs = spawnSync('git', ['log', '--format=%H', '--', BASELINE_REL], { cwd: ROOT, encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean).reverse();   // 最旧 → 最新
    const series = revs.map((rev) => {
      const raw = spawnSync('git', ['show', `${rev}:${BASELINE_REL}`], { cwd: ROOT, encoding: 'utf8' }).stdout;
      return { la: JSON.parse(raw).la as number, lb: JSON.parse(raw).lb as number };
    });
    expect(series.length, '基线文件不在 git 历史里 ⇒ 未跟踪，"历史非递增"这条守卫对它无效（先提交再说）').toBeGreaterThanOrEqual(1);
    expect(isNonIncreasing(series.map((s) => s.la)), `L-A 基线在历史里被上调过：${series.map((s) => s.la).join(' → ')}`).toBe(true);
    expect(isNonIncreasing(series.map((s) => s.lb)), `L-B 基线在历史里被上调过：${series.map((s) => s.lb).join(' → ')}`).toBe(true);
    if (series.length === 1) {
      // 不假装：把"当前只能证明到什么程度"打在输出里，免得后人把这条读成"棘轮已经验证过"
      console.log(`      ℹ️  基线历史长度 1 ⇒ 本条今天只证明"机制已接上"，未证明"能咬住上调"（咬合力见下一条的反面对照）`);
    }
  });

  it('★ 反面对照：谓词对"上升"必须敏感，恒真版本要被排除', () => {
    expect(isNonIncreasing([191, 191]), '相等必须放行（重跑不改数不算放宽）').toBe(true);
    expect(isNonIncreasing([191, 190]), '下降必须放行（清了一处）').toBe(true);
    expect(isNonIncreasing([190, 191]), '上升必须被抓 —— 这就是"上调基线"的形状').toBe(false);
    expect(isNonIncreasing([171, 160, 165]), '中间降了再升也必须被抓（只看首尾的写法会漏）').toBe(false);
    // 复核 B79 同一种病：把判据写成"自己比自己"的恒真式，绿的没有任何含义
    const naive = (xs: number[]) => xs.every((v, i) => i === 0 || v <= v);
    expect(naive([1, 999]), '恒真版本（自身比较）能放过上调 ⇒ 证明上面四条不是靠恒真过的').toBe(true);
  });
});

