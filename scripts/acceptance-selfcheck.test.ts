/**
 * G-3 / G-3b 批：验收自证（`lib/acceptance-selfcheck.mjs`）+ 数据范围（`acceptance-data-scope.mjs`）守卫。
 *
 * ★ 三条设计约束（前两条是本批复核抓出来的，写在这免得再犯）：
 *  1. **必须有正向对照**：fail-closed 判据若退化成"恒拒绝"，只测负例的守卫会全绿通过。
 *  2. **每条臂都要可达**：上一版 `BRANCH_DRIFT` 是"同 root 但分支不同"——真实 `selfCheck()` 造不出这个状态
 *     ⇒ 是一条永不触发的死臂，测试却写着它的名字。现改成可发生的 `BACKEND_STALE`（同 root、HEAD 不同 = 服务没重启）。
 *  3. 断言**具体 tag 串**，不写 `.length > 0` 这种恒真形态。
 */
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
/**
 * B205 那一族的**第四份**（v3.205 补）：本文件自己 spawn 子进程，默认 5s 档在标准命令全量并发下会被负载压过去。
 *   · 实测签名：`testTimeout=1ms` 时本文件 33 条以 `Error: STACK_TRACE_ERROR` 失败 ⇒ 这正是本版 vitest 超时的长相；
 *   · 本批标准命令全量里那条红就是它：耗时 5452ms（隔离单跑 1655ms）⇒ 过了 5s 档。
 * 只给这一族抬到 30s（与 server/vitest.config.ts 同值），**不动根域全局** —— 全局抬会把"真挂住"一起掩护掉。
 * ★ `gate-summary.test.ts` 刻意不加：它最慢单测 135ms，离 5s 差 37 倍，加阈值只会掩护真挂住。
 */
vi.setConfig({ testTimeout: 30_000 });

import { isTrustworthy, readDbTarget, formatBanner, scriptPorts, loadEnvForScript, acceptanceScriptFiles, attributionVerdict, attributionRefuse, residueVerdict, emitResidueVerdict, createReporter, finishRun, assertResidueAudited, verdictLine, residueCanonicalLabels, RESIDUE_CLOSING_TOKENS, selfCheck, countAllModels, rowDelta, conservationCheck, countCreatedInWindow, canonModel, mergeDeleted, coverageLine, snapshotIdSets, pkDiff, deletedRowAttribution, axisControlVerdict, runAccusationAxisControl, isCliEntry, findRawCliEntryGuards, axisResolutionGrid, axisResolutionCaveat, retainedRowsCell } from './lib/acceptance-selfcheck.mjs';
// ★ B160 行为级对照需要跑真脚本（只读端口 1 ⇒ 必然无人监听，不碰库）
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { verdict } from './acceptance-data-scope.mjs';
import { RESIDUE_MARKERS, SIM_DATASET_MARKERS } from './lib/drill-residue.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OK_DB = { envFile: '/x/server/.env.local', url: 'postgresql://p:pw@localhost:5432/panda_hub_local?schema=public', name: 'panda_hub_local', host: 'localhost', port: '5432', unparseable: false };
const listener = (over = {}) => ({ pid: '1', cwd: '/x/server', root: '/x', branch: 's0/test', head: HEAD, startedAt: 'Mon Sep 21 11:00 2026', ...over });
const okCase = {
  repoRoot: '/x', branch: 's0/test', head: HEAD, dirtyPaths: [], db: OK_DB,
  ports: ['8081'], portsFromScripts: true, listeners: { '8081': [listener()] },
};
const R = (sc) => isTrustworthy(sc).reasons.join(' ｜ ');

/**
 * ★ v3.34（复核 ①）：`--allow-unattributed` 的"留痕"此前**只有负面对照** —— 复核把口子改成完全失效
 *   （`if (!ALLOW_UNATTRIBUTED)` → `if (true)`）后五条断言照样全绿，因为"仍写不可署名"那半边是
 *   **拒跑话术**供上的、不是判决行供的。纯函数化之后四格组合可确定性验（本仓环境里"真跑通再留痕"
 *   那半边不可达：既缺 env、8081 上那个别分支的服务又不许动 ⇒ 只能验到会拼出什么串，验不到它真被打印过）。
 */
/**
 * ★ v3.36（复核 #7 第 1、2 条）：
 *  ① "同库证明没拿到 ⇒ 不可能出 clean" 上一批只是脚本里一段内联 if，**删掉它全仓不红**；
 *     现在它是纯函数的性质，三种输入形态各有对照。
 *  ② 上一批那句"末尾判决行确实经 attributionVerdict 拼装"钉错了行——命中的是 exit-4 那条硬编码路径，
 *     把真正的末尾判决行改回字面量不会红（复核实测）。⇒ 两条 pin 现在分开钉，且各自配一次"改坏要红"的自证。
 * ★ v3.37（复核 #8 I-1）：上一批我只把**判决**抽成纯函数，**打印**还留在调用点的 if/else 里 ⇒
 *  复核实测四条攻击全绿：保留调用、把返回值丢掉、自己再内联一段 if（M3_bypass）、
 *  把 pin 那句只写进注释（M7）、注释+挪位（M8）、`let WORLD_PROVEN = true`（M9）、hits 写死空（M10）。
 *  ⇒ 本批两处修法：
 *     (a) 打印搬进 lib 的 emitResidueVerdict ⇒ 想丢掉结论必须丢掉那次调用，而丢掉调用会当场红 pin；
 *     (b) 所有源码 pin 改跑在**去注释后的代码**上 ⇒ "只写在注释里"不再能满足任何一条。
 *  ⚠️ 诚实边界：这些仍是源码形状判据（本工作树连不上库，跑不到真打印）。
 *     真跑一次 M3、看那行结论带着署名打出来，仍记在 #49 之后的首次真跑必查项里，不在这里冒充验过。
 */
const stripComments = (t: string) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
  .join('\n');
const chainCode = () => stripComments(readFileSync(join(SCRIPTS_DIR, 'acceptance-e2e-business-chain.mjs'), 'utf8'));

/* （v3.41）输入侧契约的判据群 */
/** 六个前提全满足的样本：v3.41 之后 clean 是"挣来的"，不是"没命中就送"。 */
const OKR = () => ({ proven: true, hits: [], unreadable: [], scanned: 5, scannable: 5,
  attributionEnumerated: 5,
  markersUsed: ['REL__DRILLCHAIN1', 'PO1'], markersExpected: ['REL__DRILLCHAIN1', 'PO1'] });

describe('residueVerdict · v3.41 的六个前提（B165 第二刀：钉输入侧）', () => {
  it('全满足 ⇒ clean；有残留 ⇒ residue（且优先，不许被前提问题掩盖）', () => {
    expect(residueVerdict(OKR()).kind).toBe('clean');
    expect(residueVerdict({ ...OKR(), hits: [{ model: 'Order', count: 2 }] }).kind).toBe('residue');
    expect(residueVerdict({ ...OKR(), hits: [{ model: 'Order', count: 1 }], markersUsed: ['__NEVER_MATCHS__'] }).kind).toBe('residue');
  });
  const cases: Array<[string, (r: any) => any]> = [
    ['没拿到同库证明', (r) => ({ ...r, proven: false })],
    ['一张表都没数', (r) => ({ ...r, scanned: 0 })],
    ['只数了一部分表', (r) => ({ ...r, scanned: 3, scannable: 5 })],
    ['可扫分母塌成 0', (r) => ({ ...r, scanned: 0, scannable: 0 })],
    ['有表数不了（throw 被吞的那一族）', (r) => ({ ...r, unreadable: [{ model: 'Invoice' }] })],
    ['普查没自报用了哪些标识', (r) => { const x = { ...r }; delete x.markersUsed; return x; }],
    ['★ 复核 #10 的突变：markers 换成永不自匹配的串', (r) => ({ ...r, markersUsed: ['__PROBE_NEVER_MATCHS__'] })],
    ['本次自造标识为空（恒绿判据）', (r) => ({ ...r, markersExpected: [] })],
  ];
  for (const [name, brk] of cases) {
    it(`${name} ⇒ 不可采信（不许读成干净）`, () => {
      const v = residueVerdict(brk(OKR()));
      expect(v.kind).toBe('unproven');
      expect(v.ok, '前提不成立时不许通过').toBe(false);
    });
  }
  it('★ 每条破坏都要在 detail 里点名（否则读者不知道该修哪一个）', () => {
    for (const [, brk] of cases) expect(residueVerdict(brk(OKR())).detail.length).toBeGreaterThan(6);
  });
});

describe('emitResidueVerdict · 收尾那句"零残留"怎么打印（v3.37 补的那半截）', () => {
  /**
   * ★ v3.46：这两格原先自己造 `{ pass, fail }` 收集器 —— 而那正好是复核 #12 抓到的形状
   *   （字面量没有判决槽 ⇒ `emitResidueVerdict` 现在**当场抛**）。改成用真 reporter + 抓日志，
   *   断言的还是原来那三件事：走对通道、恰好一次、明细进结论。
   */
  const collect = () => {
    const lines: string[] = [];
    // ★ 必须返回**同一个被持续填充的数组**：上一版返回 getter，而调用方是 `const { out, calls } = collect()`
    //   ⇒ 解构那一刻就求了一次值 = 拿到发射前的空快照 ⇒ "打印了 0 次"（我的 bug，不是机制的）。
    const calls: Array<['pass' | 'fail' | 'gap', string, string]> = [];
    const rep = createReporter({
      log: (x: string) => {
        lines.push(x);
        const ch = x.startsWith('  ✓') ? 'pass' : x.startsWith('  ✗') ? 'fail' : 'gap';
        const body = x.slice(4);
        const i = body.indexOf(' — ');
        calls.push([ch, i < 0 ? body : body.slice(0, i), i < 0 ? '' : body.slice(i + 3)]);
      },
    });
    return { out: rep, lines, calls };
  };
  it('三种判决各自走对通道，且**恰好打印一次**（一次都不许多 —— "顺手再打一句"就是第二条真源）', () => {
    const H = (n: number) => Array.from({ length: n }, (_, i) => ({ model: `M${i}`, count: 1 }));
    for (const [r, want] of [
      [{ ...OKR(), hits: H(2) }, 'residue'],
      [{ ...OKR(), proven: false }, 'unproven'],
      [OKR(), 'clean'],
    ] as Array<[any, string]>) {
      const { out, calls } = collect();
      expect(emitResidueVerdict(r, out)).toBe(want);
      expect(calls.length, `打印了 ${calls.length} 次 ⇒ 一次调用只许产出一条结论`).toBe(1);
      expect(calls[0][0], `kind=${want} 该走的通道`).toBe(want === 'clean' ? 'pass' : 'fail');
      expect(calls[0][1], '标签必须来自 lib 那份（不许调用点自己另写一句）').toMatch(/零残留复核/);
    }
  });
  it('★ 规范措辞恰好三条且互不相同（白名单不许悄悄长出第四种 —— 复核 #10）', () => {
    const l = residueCanonicalLabels();
    expect(l.length).toBe(3);
    expect(new Set(l).size).toBe(3);
    for (const s of l) expect(RESIDUE_CLOSING_TOKENS.test(s), `规范标签「${s}」竟不被族谓词认出 ⇒ 守卫形同虚设`).toBe(true);
  });
  it('★ 措辞表不可注入（第二份 reporter 也拿不到自造措辞的豁免）', () => {
    // ★ 复核 #12：删掉 `'canonical' in createReporter` 那种**签名探针**（参数无人读时它永远不红 = 假哨兵）。
    //   只留行为对照：照样传 canonical 也必须不生效。
    const injected = createReporter({ log: () => {}, canonical: ['收尾独立复核：本次演练零残留 ⇒ 干净'] } as any);
    expect(() => injected.pass('收尾独立复核：本次演练零残留 ⇒ 干净')).toThrow(/B165 越界结论/);
    const r2 = createReporter({ log: () => {} });
    expect(() => r2.pass('零残留复核 ⇒ 干净（换一份 reporter 也不行）')).toThrow(/B165 越界结论/);
  });
  it('★ 残留那一支必须把**是哪些表**打出来（只说"有残留"= 下次还得人去看日志外部）', () => {
    const { out, calls } = collect();
    emitResidueVerdict({ ...OKR(), hits: [{ model: 'Order', count: 3 }, { model: 'AuditLog', count: 1 }] }, out);
    expect(calls[0][2]).toContain('Order=3');
    expect(calls[0][2]).toContain('AuditLog=1');
  });
  it('★ v3.52 洞①：基线里**没有**的模型增长了也必须看见（rowDelta 按并集遍历）', () => {
    expect(rowDelta({ A: 10 }, { A: 10, BrandNew: 7 }),
      '只遍历基线键 ⇒ 新表/基线缺席者的增长永远看不见（复核 #13 实测）').toEqual([{ model: 'BrandNew', from: 0, to: 7, delta: 7 }]);
    // 反面对照不许恒真：两边都没有增长时必须为空
    expect(rowDelta({ A: 10, B: 3 }, { A: 10, B: 3 })).toEqual([]);
    expect(rowDelta({ Old: 5 }, {})).toEqual([]);            // 消失不是增长（它由 deletedBelowBaseline 那条前提盯）
  });
  it('★ v3.52 洞③：清理删到**低于基线** ⇒ 不许读成干净（变少这一支原来是盲的）', () => {
    // 与链同方向：把「跑后」当基准去比「基线」，消失的那批就表现为增长（链里是 rowDelta(POSTCLEAN, BASE)）
    const vanish = rowDelta({ Order: 3 }, { Order: 8 });
    expect(vanish).toEqual([{ model: 'Order', from: 3, to: 8, delta: 5 }]);
    const v = residueVerdict({ ...OKR(), deletedBelowBaseline: vanish });
    expect(v.kind).toBe('residue');
    expect(v.detail).toMatch(/Order 8→3 \(-5\)/);   // ★ 人读方向：基线 8 行 → 清理后 3 行
    expect(v.detail).toMatch(/删面宽于本次写入/);
  });
  it('★ v3.52 洞②：第二证人没有分母 ⇒ unproven（对撞集合缺谁都不知道，不能说"没有增长"）', () => {
    const v = residueVerdict({ ...OKR(), countBlind: ['WeirdModel'] });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/没有分母/);
    expect(residueVerdict({ ...OKR(), countBlind: [] }).kind).toBe('clean');
  });

  it('★ v3.50（B167）：标识扫不到但行数增长了 ⇒ 必须判残留（第二证人不许被忽略）', () => {
    const grew = [{ model: 'SystemConfigHistory', from: 34, to: 36, delta: 2 }];
    expect(residueVerdict({ ...OKR(), unmarkedGrowth: grew }).kind,
      '行数增长却被判成 clean ⇒ 第二次真跑那 2 行又会被"零残留"吃掉').toBe('residue');
    expect(residueVerdict({ ...OKR(), unmarkedGrowth: grew }).detail).toMatch(/SystemConfigHistory 34→36 \(\+2\)/);
    expect(residueVerdict({ ...OKR(), unmarkedGrowth: [] }).kind).toBe('clean');
    expect(rowDelta({ A: 10, B: 5 }, { A: 12, B: 5 })).toEqual([{ model: 'A', from: 10, to: 12, delta: 2 }]);
    // 反向对照：变少/不变都不算"留下数据"（这一格不许恒红，否则修法会变成"删掉判据"）
    expect(rowDelta({ A: 10 }, { A: 10 })).toEqual([]);
    expect(rowDelta({ A: 10 }, { A: 4 })).toEqual([]);
  });

  it('★ v3.48 真跑形状：hits 数组**全是 count=0** 时不许判残留（第一次真跑就是被这格坑的）', () => {
    const zeroRows = Array.from({ length: 13 }, (_, i) => ({ model: `M${i}`, count: 0 }));
    expect(zeroRows.length, '样本要是空的，这条断言就是恒真').toBe(13);
    expect(residueVerdict({ ...OKR(), hits: zeroRows }).kind,
      '全 0 的 hits 被判成"有残留" ⇒ 把"没数到"读成"数到脏东西"（真跑实测过）').toBe('clean');
    expect(residueVerdict({ ...OKR(), hits: [...zeroRows, { model: 'Order', count: 2 }] }).kind).toBe('residue');
    // 明细里不许混进 0 行（否则读者要在 13 个 0 里找一个真凶）
    const v = residueVerdict({ ...OKR(), hits: [...zeroRows, { model: 'Order', count: 2 }] });
    expect(v.detail).toBe('Order=2');
    expect(v.detail.includes('=0'), '0 行混进结论明细').toBe(false);
  });

  it('★ 核心不变量：proven=false 时**永不可能**拿到 clean，也永不可能走 pass 通道', () => {
    for (const n of [0, 1, 999]) {
      const v = residueVerdict({ ...OKR(), proven: false, hits: Array.from({ length: n }, (_, i) => ({ model: `M${i}`, count: 1 })) });
      expect(v.kind === 'clean', `hits=${n} 且未证明 ⇒ 出了 clean 就是假绿`).toBe(false);
      expect(v.ok, '未证明的收尾不能算通过').toBe(false);
    }
  });
  it('★ 调用点自证（跑在去注释后的代码上）：脚本只留"一次调用"，收尾与退出码都归 lib', () => {
    const src = chainCode();
    expect(src.split('emitResidueVerdict(').length - 1,
      '收尾打印不是那唯一一次调用 ⇒ 又出现第二个打印口（第二处真源）').toBe(1);
    expect(/emitResidueVerdict\(\{\s*proven: WORLD_PROVEN,\s*hits,\s*unreadable,\s*scanned:/.test(src),
      '打印没把六个输入前提原样交给 lib ⇒ 复核 #10 的输入侧洞复发').toBe(true);
    const callStart = src.indexOf('emitResidueVerdict(');
    const call = src.slice(callStart, src.indexOf('}, rep);', callStart) + 8);   // ★ 截到语句尾，不用固定窗口（上一版 400 字元被更长的调用截掉 ⇒ 误判）
    expect(call.includes('}, rep);'), '没截到语句尾 ⇒ 下面的 out 判据会假红').toBe(true);
    for (const f of ['proven', 'hits', 'unreadable', 'scanned', 'scannable', 'markersUsed', 'markersExpected']) {
      expect(new RegExp(`\\b${f}\\b`).test(call), `收尾调用没自报 ${f} ⇒ "没数"与"干净"同值那一格未堵`).toBe(true);
    }
    // ★ 复核 #12 的 BLOCKER：上一版这条钉的是 `{ pass, fail }` 字面量 —— 而那**正是 bug**
    //   （字面量没有判决槽 ⇒ 链上永远"判定=无"）。现在要求把 reporter 本身交出去。
    expect(/\},\s*rep\)/.test(call),
      'emitResidueVerdict 的 out 不是 reporter 本身 ⇒ 判决没地方落，收尾只能报"判定=无"（复核 #12）').toBe(true);
    expect(call.includes('{ pass, fail }'),
      '又回到 { pass, fail } 字面量 ⇒ 判决槽恒空、clean 支路恒死（v3.43 那个病第三次复发）').toBe(false);
    expect(src.includes('unreadableOut:'), 'sweepResidue 没接不可读清单 ⇒ 逐表抛错会被译成"这张表干净"').toBe(true);
    expect(src.includes('scanStatOut:'), 'sweepResidue 没接自报计数 ⇒ 扫了 0 张表也会读成干净').toBe(true);
    // ★ v3.50（B167）：第二证人必须**真的接在链上**（只在 lib 里支持 = 判据形同虚设）
    expect(/const ROWBASE = await countAllModels\(/.test(src),
      '跑前没取全模型行数基线 ⇒ 标识扫不到的副作用（实测 systemConfigHistory +2）依旧看不见').toBe(true);
    // ★ 复核 #14 B-1：上一批我把三个新前提接进了链，却**没有任何判据提到它们的名字** ⇒
    //   十个链侧突变（含整段删参数）全绿。这里至少把"接上了"钉住（仍是形状级，诚实说：不是行为级）。
    for (const f of ['deletedBelowBaseline:', 'countBlind:', 'POSTW', 'POSTCLEAN', 'unmarkedGrowth:']) {
      expect(call.includes(f) || src.includes(f), `链上不再引用 ${f} ⇒ 那条前提被整段绕开（复核 #14 B-1）`).toBe(true);
    }
    expect(src.includes('void POSTW'), 'POSTW 只为消警告而存在 ⇒ 它其实没参与判决').toBe(false);
    // I-4 的名字撞车：HTTP 的 BASE 不能被行数控件遮住
    expect((src.match(/^const BASE = /gm) || []).length, 'BASE 这个名字被两处共用 ⇒ 失败详情会打出 [object Object]').toBe(1);
    expect(src.includes('unmarkedGrowth:'),
      '收尾没把行数对撞喂进判决 ⇒ 基线白取了').toBe(true);
    expect(src.includes('rowDelta(ROWBASE.counts'),   // ★ 名字随 I-4 更名（这条红了正是它在干活：改名会被抓到）,
      '跑前/跑后没对撞 ⇒ 增长算不出来').toBe(true);

    expect(src.includes('await sweepResidue('), 'hits 不是现扫出来的 ⇒ 上面那些"没写死"只是巧合').toBe(true);
    // ★ 复核 #10 的三条 BLOCKER 里有两条的"形状半边"（行为半边见下面 describe 与退出前复核）：
    //  (i) 收尾数的是**哪一组标识**必须与普查真正用的那一组是同一个变量 —— 只钉"有没有 markersUsed"
    //      挡不住"把 sweepResidue 的 markers 换成一个永不自匹配的串"（复核的实测突变）。
    expect(/sweepResidue\(\{[^}]*markers:\s*sweepMarkers/.test(src),
      '普查的 markers 不是 sweepMarkers ⇒ 下面那个"自报标识"的对照就成了解释自己').toBe(true);
    // ★ 复核 #11 B-3：markersExpected 必须是 sweepMarkers **必然包含**的那一枚，否则 clean 支路恒死
    //   （fail-closed 的"永远不干净"同样是一种坏：它让"六个前提被真跑验证过"这句话不可证）。
    expect(src.includes('markersExpected: [RUN_MARK]'),
      '期望标识不是那个必然在场的自造标识 ⇒ 收尾永远只能报 unproven，真跑一程也拿不到 clean').toBe(true);
    // ★ 正面对照：链形状的输入必须真的能拿到 clean（否则"六个前提"只是手喂样本的修辞）；
    //   且**非数组**的自报不许崩（我上一版就是这么写的，是 node 直接 TypeError 抓出来的）。
    const chainShape = { proven: true, hits: [], unreadable: [], scanned: 225, scannable: 225,
      markersUsed: ['DRILL__X', 'ord1'], markersExpected: ['DRILL__X'] };
    expect(residueVerdict(chainShape).kind, '链形状拿不到 clean ⇒ clean 支路恒死（B-3 的形状复发）').toBe('clean');
    expect(() => residueVerdict({ ...chainShape, markersExpected: 'DRILL__X' as never })).not.toThrow();
    expect(residueVerdict({ ...chainShape, markersExpected: 'DRILL__X' as never }).kind).toBe('unproven');
    expect(/const RUN_MARK = MARK/.test(src) && /const sweepMarkers = \[MARK,/.test(src),
      'RUN_MARK 与 sweepMarkers 的头一枚不再同源 ⇒ 上面那条对照退化成恒真').toBe(true);
    expect(/markersExpected:\s*\[\s*RUN_MARK\s*\]/.test(src),
      '期望集合不是那个必然在场的自造标识 ⇒ B-3 复发（要么恒 unproven、要么手喂样本才满足）').toBe(true);
    expect(/markersExpected:\s*\[[^\]]*,/.test(src),
      '期望集合又列了多枚（其中 PO_NO 不在 sweep 的 markers 里 ⇒ clean 支路恒死）').toBe(false);
    expect(/markersUsed:\s*sweepMarkers/.test(src),
      '收尾自报的 markersUsed 与普查实际用的不是同一个变量 ⇒ 输入侧前提可以各说各话').toBe(true);
    //  (ii) 不可读表与自报计数必须**接上**（不传 unreadableOut 时逐表抛错被译成"这张表干净"）
    expect(/sweepResidue\(\{[^}]*unreadableOut:\s*unreadable/.test(src),
      '没把不可读清单接进普查 ⇒ "一行都没数"与"数了且干净"同值（复核 #10 BLOCKER-1 的未突变版）').toBe(true);
    expect(/sweepResidue\(\{[^}]*scanStatOut:\s*scanStat/.test(src),
      '没把自报计数接进普查 ⇒ 扫了 0 张表也会读成干净').toBe(true);
    //  (iii) 唯一性目前是**按实例**的 ⇒ 那么"脚本里只许有一份 reporter"就必须钉住，
    //        否则 `const rep2 = createReporter(...)` + 规范措辞就能在计数器之外再打一条（复核 #10 BLOCKER-3 的变体）
    expect(src.split('createReporter(').length - 1,
      '脚本里出现第二份 reporter ⇒ "每实例一次"就成了"每进程可以 N 条"的空子').toBe(1);
    //  (iv) finally 里不许有裸 return（它会跳过 finishRun 并把退出码吞成 0 —— 复核实证）
    const fin = src.slice(src.lastIndexOf('} finally {'));
    expect(fin.length > 200, '没截到 finally 段 ⇒ 下面那条是空转').toBe(true);
    expect(/\n\s{4,}return;/.test(fin),
      'finally 里有裸 return ⇒ 收尾与退出前复核都可能被跳过，而进程照旧退 0').toBe(false);
    expect(/proven:\s*(true|false)\b/.test(src), '调用点把 proven 写成了字面量 ⇒ 这一格的对照组全在演我').toBe(false);
    expect(/hits:\s*\[\s*\]/.test(src), '调用点把 hits 写死成空 ⇒ "零残留"成了自我实现').toBe(false);
    expect(/\n\s{4}emitResidueVerdict\(/.test(src),
      '收尾不是一条独立语句 ⇒ 可能被 if(false)/短路包住而结论永不产生（A1 的形状半边）').toBe(true);
    expect(src.split('finishRun(').length - 1,
      '收尾不在那唯一一次 finishRun 里 ⇒ 退出码又回到脚本自己手上（可以被 if 包住）').toBe(1);
    // ★ v3.87：原来这里钉的是**整条调用的字面形状**（`finishRun({ rep, attr: ATTR, waived: ALLOW_UNATTRIBUTED })`），
    //   于是"给这次调用再加一个**不参与判定**的实参"（`retained:`）会把这条守卫撞红 —— 那是"钉实现字面"那族
    //   （B102/B105）：它要的其实是**那三样必须在这次调用里**，而不是"这次调用只能有那三样"。
    //   ⇒ 放宽到意图（同一个唯一调用必须带 rep / attr: ATTR / waived: ALLOW_UNATTRIBUTED），并补反面对照证明它还有牙。
    const finCall = src.match(/finishRun\(\{[^}]*\}\)/);
    expect(finCall, '找不到那一次 finishRun 调用 ⇒ 下面那条是空转').not.toBeNull();
    const callTxt = finCall![0];
    expect(/rep\b/.test(callTxt) && /attr:\s*ATTR/.test(callTxt) && /waived:\s*ALLOW_UNATTRIBUTED/.test(callTxt),
      'finishRun 没拿到 rep/ATTR/口子 ⇒ 残留计数与署名都不在它手里，退 5 那条硬前置失效').toBe(true);
    expect(/attr:\s*ATTR/.test('finishRun({ rep, waived: ALLOW_UNATTRIBUTED })'),
      '反面对照：少了 attr: ATTR 的那个样本必须判不合格（否则上面那条是恒真）').toBe(false);
    // ★ 复核 #10 BLOCKER-2：finishRun 之前插一句裸 return; 就跳过它 ⇒ 顶层还要有一道退出前复核
    expect(src.includes('.then(() => assertResidueAudited(rep))'),
      '顶层没有退出前复核 ⇒ 被 return 跳过 finishRun 的那条路会退 0（复核 #10 BLOCKER-2）').toBe(true);
    expect(/const rep = createReporter\(/.test(src),
      'pass/fail 不是 lib 的带闸 reporter ⇒ 手写一句换措辞的"无残留"不会再当场抛（复核 #9 A2）').toBe(true);
    expect(src.includes('零残留复核'),
      '脚本里出现了结论标签字面量 ⇒ 打印被抄回调用点，lib 那份成了装饰').toBe(false);
    expect(src.includes('署名='),
      '判决行拼装回到脚本里了 ⇒ verdictLine 那份成了装饰（exit-4 早退路径同罪）').toBe(false);
    expect(src.includes('bad === 0'),
      '脚本里还留着退出码公式 ⇒ 收尾判决权没交出去（B165 的 A1 形状）').toBe(false);
    expect(src.includes('const ok = results.filter'),
      '脚本里还留着自己数三态的代码 ⇒ 汇总有两份真源').toBe(false);
    expect(/let WORLD_PROVEN = false/.test(src),
      '同库证明的初值不是 false ⇒ 拿到证明与否不再由那次回读决定（M9）').toBe(true);
    expect(src.split('WORLD_PROVEN = true').length - 1,
      '置真点只能有一处，且必须在按自造 id 回读成功之后').toBe(1);
  });
  it('★ 残留族谓词在 M3 主链的影响面：既有结论调用命中 0 处（不误伤），且分母非空', () => {
    const src = chainCode();
    const labels = [...src.matchAll(/\b(?:pass|fail|gap)\(\s*(?:'([^']*)'|`([^`]*)`)/g)].map((m) => m[1] ?? m[2]);
    expect(labels.length, '结论调用数塌了 ⇒ 正则或脚本形状变了，这一格在空转（0 读数要带非零对照）').toBeGreaterThanOrEqual(60);
    const hit = labels.filter((n) => RESIDUE_CLOSING_TOKENS.test(n));
    expect(hit.join(' · '), '既有结论里已有命中族词的句子 ⇒ 这道运行时闸会当场把合法步骤打死').toBe('');
  });
});

/**
 * ★ v3.44（B166）：退出码只由**判决**决定。
 * 这条同时补一笔账：v3.41 我"重写判据"时把 v3.39 那组 `finishRun` 行为判据**整块删掉了**
 * 而 9/9 突变当时照样绿（因为它红的是形状格）⇒ 证人被我自己改没了，没有任何一步否证。
 * 下面这组既恢复那块覆盖，又把它换成更强的口径（不再依赖措辞白名单）。
 */
describe('B166 · 退出码只由残留判决决定（通过计数没有表决权）', () => {
  const runWith = (verdictArgs: any[], extraFakeClean: number, bad: number) => {
    const log: string[] = [];
    const rep = createReporter({ log: (x: string) => log.push(x) });
    rep.pass('S1 建客户档案');
    for (let i = 0; i < bad; i++) rep.fail(`坏${i}`);
    // ★ 复核 #11 的同义措辞（**不命中**那 4 枚 token ⇒ 白名单挡不住）：就是以前能把结果读绿的那一句
    for (let i = 0; i < extraFakeClean; i++) rep.pass('整个库确认没有任何遗留数据', `第${i}句`);
    for (const a of verdictArgs) emitResidueVerdict(a, rep);
    let code = -999;
    finishRun({ rep, attr: { db: 'panda_hub_local', head: 'abc1234567' }, waived: false,
      log: (x: string) => log.push(x), exit: ((c: number) => { code = c; return undefined; }) as never });
    return { code, out: log.join('\n'), passed: rep.results.filter((r) => r.ok === true).length };
  };
  it('★ 判决=有残留 时，再加几句同义假干净也改不动退出码（假干净没有表决权）', () => {
    const residueArgs = [{ ...OKR(), hits: [{ model: 'Order', count: 4 }] }];
    const bare = runWith(residueArgs, 0, 0);
    const faked = runWith(residueArgs, 3, 0);
    expect(bare.code, '判决=有残留 ⇒ 不许为 0').not.toBe(0);
    expect(faked.code, '多灌 3 句"没有任何遗留"后退出码被改动了 ⇒ 通过计数仍在表决').toBe(bare.code);
    expect(faked.passed > bare.passed, '对照不成立：那几句假干净根本没进通过数（这条断言就成了空转）').toBe(true);
    expect(faked.out).toMatch(/残留判决=residue/);
    expect(faked.out).toMatch(/判定=residue/);
  });
  it('★ 判决=不可采信 时同理（且必须点名缺哪个前提）', () => {
    const r = runWith([{ ...OKR(), proven: false }], 2, 0);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/判定=unproven/);
    expect(r.out).toMatch(/同库证明从未拿到/);
  });
  it('★ 判决=clean 才允许退 0；此时假干净只灌大通过数，且**在机器输出里看得见**', () => {
    const r = runWith([OKR()], 2, 0);
    expect(r.code, '判决 clean 且无失败 ⇒ 0').toBe(0);
    expect(r.out).toMatch(/判定=clean/);
    expect(/通过 \/ 0 失败/.test(r.out), '判决行没有把通过数与判定并列 ⇒ 灌大不可见').toBe(true);
    // S1 + 2 句假干净 + **判决自己那一条 clean 也走 pass 通道** = 4（上一版我按 3 写，是自己算错）
    expect(r.out.match(/(\d+) 通过/)?.[1]).toBe('4');
    expect(r.out).toMatch(/判定=clean/);
  });
  it('★ 判决槽也不许多写（第二次记判决要抛）', () => {
    const rep = createReporter({ log: () => {} });
    emitResidueVerdict(OKR(), rep);
    expect(() => emitResidueVerdict(OKR(), rep)).toThrow(/B166 重复判决/);
  });
  it('★ 只 pass 一句规范标签、不记判决 ⇒ 收尾必须退 5（"打印过"不等于"判过"）', () => {
    const log: string[] = [];
    const rep = createReporter({ log: (x: string) => log.push(x) });
    rep.pass(residueCanonicalLabels()[0], '手工打的');
    let code = -999;
    finishRun({ rep, attr: null, waived: false, log: (x: string) => log.push(x),
      exit: ((c: number) => { code = c; return undefined; }) as never });
    expect(code, '有规范措辞但没有判决 ⇒ 不许按通过读').toBe(5);
    expect(log.join('\n')).toMatch(/判定=无/);
  });
});

describe('B166 补：判决槽不可公开写 + 两条被删的行为判据恢复（复核 #12 的丢失清单）', () => {
  it('★ 没有任何公开写入口：拿 rep.recordVerdict 当后门的写法必须当场失败', () => {
    const rep = createReporter({ log: () => {} });
    expect((rep as any).recordVerdict, '判决槽又被暴露成公开方法 ⇒ 一句假 clean 就能零扫描退 0').toBeUndefined();
    expect(() => (rep as any).recordVerdict?.({ kind: 'clean' })).not.toThrow();
    expect(rep.verdictKind(), '绕过成功 ⇒ 这条断言要红').not.toBe('clean');
  });
  it('★ out 不是 reporter ⇒ emitResidueVerdict 必须抛（不许静默不落地）', () => {
    const sunk: string[] = [];
    expect(() => emitResidueVerdict(OKR(), { pass: (a: string) => sunk.push(a), fail: (a: string) => sunk.push(a) }))
      .toThrow(/B166 判决无处安放/);
    expect(sunk.length, '抛之前已经把结论打出去了 ⇒ 收尾会出现"有打印无判决"').toBe(0);
  });
  it('★ 同一条规范结论打两遍要抛（v3.41 重写时被我删掉的那条）', () => {
    const rep = createReporter({ log: () => {} });
    emitResidueVerdict(OKR(), rep);
    expect(() => emitResidueVerdict(OKR(), rep)).toThrow(/B166 重复判决/);
    expect(() => rep.pass(residueCanonicalLabels()[0])).toThrow(/B165 重复结论/);
  });
  it('★ 判决行三态/署名/库/HEAD 缺一不可（verdictLine 那条被我删掉的行为判据）', () => {
    const rep = createReporter({ log: () => {} });
    rep.pass('S1'); rep.fail('S2'); rep.gap('S3');
    emitResidueVerdict({ ...OKR(), proven: false }, rep);
    const line = verdictLine({ results: rep.results, residueCount: rep.residueCount(),
      verdictKind: rep.verdictKind(), attr: { db: 'panda_hub_local', head: 'abcdef1234' }, waived: true });
    expect(line).toMatch(/1 通过 \/ 2 失败 \/ 1 缺口/);
    expect(line).toMatch(/署名=不可署名\(已用 --allow-unattributed 越过\)/);
    expect(line).toMatch(/残留结论=1/);
    expect(line).toMatch(/判定=unproven/);
    expect(line).toMatch(/库=panda_hub_local HEAD=abcdef1/);
  });
  it('★ v3.87（Kevin 拍定·承认「来源合法的保留行」）：单列一格 —— 只认机制证据、不参与判定、不动删除面', () => {
    // ① 有机制证据 ⇒ 计入
    const a = retainedRowsCell({ arms: [{ label: 'SIM-', count: 36842, evidence: '生成器 server/scripts/company-sim/*' }] });
    expect(a.total).toBe(36842);
    expect(a.text).toContain('保留行（来源已证）＝36842 行');
    // ② 没有证据 ⇒ **不计入**并被点名（"只认有独立机制证据的"这一条有牙）；空串 / 纯空白同罪
    const b = retainedRowsCell({ arms: [{ label: '凭感觉干净', count: 5 } as any, { label: 'x', count: 7, evidence: '   ' } as any] });
    expect(b.total).toBe(0);
    expect(b.refused).toHaveLength(2);
    expect(b.text).toContain('因缺机制证据未计入');
    // ③ 不放松残留定义：加不加这一格，判决行其余部分**逐字不变**（三态计数与判定一个字没动）
    const rep = createReporter({ log: () => {} });
    rep.pass('S1'); rep.fail('S2'); rep.gap('S3');
    emitResidueVerdict({ ...OKR(), proven: false }, rep);
    const attr = { db: 'x', head: 'abcdef1234' };
    const base = verdictLine({ results: rep.results, residueCount: rep.residueCount(), verdictKind: rep.verdictKind(), attr, waived: false });
    const cell = retainedRowsCell({ arms: [{ label: 'SIM-', count: 36842, evidence: 'e' }] });
    const withCell = verdictLine({ results: rep.results, residueCount: rep.residueCount(), verdictKind: rep.verdictKind(), attr, waived: false,
      retained: [{ label: 'SIM-', count: 36842, evidence: 'e' }] });
    expect(withCell).toContain('判定=unproven');
    expect(withCell.replace(` · ${cell.text}`, '')).toBe(base);
    // ④ 不交这一格 ⇒ 一个字都不多（缺席 ≠ 0 行）
    expect(base.includes('保留行')).toBe(false);
    // ⑤ 措辞不许与残留族结论撞车（B165：一次运行只许有一条残留结论）
    expect(RESIDUE_CLOSING_TOKENS.test(a.text)).toBe(false);
    // ⑥ 退出码不听它：判定=clean 且无失败 ⇒ 带上这一格仍退 0（注入 exit，不真退）
    let code: number | null = null;
    const rep2 = createReporter({ log: () => {} });
    emitResidueVerdict({ ...OKR(), proven: true }, rep2);
    finishRun({ rep: rep2, attr, waived: false, retained: [{ label: 'SIM-', count: 1, evidence: 'e' }], log: () => {}, exit: ((c: number) => { code = c; return undefined as never; }) as any });
    expect(code).toBe(0);
  });
});

describe('v3.54 B168 · 守恒校验：成对误差（留一行 + 多删一行）唯一能抓住的一层', () => {
  it('★ 复核 #14 的原始反例：总行数一模一样，标量差全 0，但按行归因必须报 residue', () => {
    const cc = conservationCheck({
      createdInWindowAtWrite: { Order: 3 }, createdInWindowAtClean: { Order: 1 }, deletedByModel: { Order: 3 },
    });
    expect(cc.residue).toEqual([{ model: 'Order', rows: 1 }]);
    expect(cc.overDeleted).toEqual([{ model: 'Order', deleted: 3, attributable: 2 }]);
    for (const v of [
      residueVerdict({ ...OKR(), scanned: 225, scannable: 225, windowResidue: cc.residue, overDeleted: [], attributionBlind: [] }),
      residueVerdict({ ...OKR(), scanned: 225, scannable: 225, windowResidue: [], overDeleted: cc.overDeleted, attributionBlind: [] }),
    ]) expect(v.kind, '成对误差被放过 ⇒ 这一层等于没做').toBe('residue');
  });
  it('★ 两侧对照：正常一程（自己造的都清干净、删除数守恒）不许误报；不可归因只限参与过的表', () => {
    const good = conservationCheck({ createdInWindowAtWrite: { Order: 3 }, createdInWindowAtClean: { Order: 0 }, deletedByModel: { Order: 3 } });
    expect(good.residue).toEqual([]);
    expect(good.overDeleted).toEqual([]);
    expect(residueVerdict({ ...OKR(), scanned: 225, scannable: 225, windowResidue: [], overDeleted: [], attributionBlind: [] }).kind).toBe('clean');
    const b = residueVerdict({ ...OKR(), scanned: 225, scannable: 225, attributionBlind: ['NoCreatedAt'] });
    expect(b.kind).toBe('unproven');
    expect(b.detail).toMatch(/没有可用 createdAt|没有 createdAt/);
  });
  it('★ 链上必须真的用时间窗与 cleanup 自报数（不是又一个只吃标量的前提）', () => {
    const src = chainCode();
    for (const f of ['countCreatedInWindow', 'conservationCheck', 'RUN_START', 'windowResidue:', 'overDeleted:', 'attributionBlind:', 'attributionEnumerated:']) {
      expect(src.includes(f), `链上没引用 ${f} ⇒ 归因层在真实路径上又成了空气（复核 #14 B-1 复发）`).toBe(true);
    }
    expect(src.includes('deletedByModel: deletedAll'),
      '守恒校验没接合并后的删除面 ⇒ overDeleted 只看得到清扫那一段').toBe(true);
    expect(src.includes('mergeDeleted(OWN_DELETES, cleaned.byModel)'),
      '只喂 settleAndClean 的 byModel ⇒ 链上手写清单删的行（Order/Relation…）不进守恒（v3.59 的漏报）').toBe(true);
    expect(src.includes('OWN_DELETES[name] = (OWN_DELETES[name] ?? 0) + n'),
      'tryDel 没记账 ⇒ 手写清单这一路对守恒不可见（★ v3.70：变量名从 r.count 变成 n，锚跟着搬，意图未变）').toBe(true);
    // ★ v3.70（B178）：逐行台账也要被钉住 —— 只记 count 不记 id 的话，这条新证人会在真实路径上又成空气
    expect(src.includes('OWN_DELETED_ROWS[name] = OWN_DELETED_ROWS[name] ?? []'),
      'tryDel 没有把预读到的行身份记进逐行台账 ⇒ B178 那条守恒永远拿不到输入').toBe(true);
    expect(src.includes('deletedRowAttribution({ deleted: DEL_ROW_INPUT'),
      '链没有调用逐主键守恒 ⇒ B178 只活在单测里').toBe(true);
    expect(src.includes('deletedPreexisting: DEL_ATTR.preexisting'),
      '逐行守恒的读数没进判决入参').toBe(true);
    expect(/attributionBlind:\s*WIN_W\.blind\.filter/.test(src.replace(/\s+/g, ' ').replace(/attributionBlind: WIN_W . blind.filter/, 'attributionBlind: WIN_W.blind.filter')),
      '不可归因清单没按参与范围收窄 ⇒ 会把 clean 支路永久钉死（v3.43 B-3 那一族）').toBe(true);
  });
});

describe('v3.55 B168 归因层的**行为**证人（★ v3.54 那次"突变自证"作废：判据文件漏 import ⇒ 突变前后红在同一个 ReferenceError 上）', () => {
  const SINCE = new Date('2026-09-24T00:00:00.000Z');
  const mmf = (names: string[], withCreated = true) => ({
    dmmf: {
      datamodel: {
        models: names.map((n) => ({
          name: n,
          fields: withCreated
            ? [{ name: 'id', type: 'String' }, { name: 'createdAt', type: 'DateTime' }]
            : [{ name: 'id', type: 'String' }],
        })),
      },
    },
  });
  const stub = (spec: Record<string, number | Error>) => {
    const seen: Array<{ model: string; args: unknown }> = [];
    const prisma: Record<string, { count: (a: unknown) => Promise<number> }> = {};
    for (const [name, v] of Object.entries(spec)) {
      const key = name.charAt(0).toLowerCase() + name.slice(1);
      prisma[key] = {
        count: async (args: unknown) => {
          seen.push({ model: name, args });
          if (v instanceof Error) throw v;
          return v as number;
        },
      };
    }
    return { prisma, seen };
  };
  it('★ 时间窗真的进了那条查询（丢了 where ＝ 把全部历史行算成"本次造的"，归因当场变成诬告）', async () => {
    const { prisma, seen } = stub({ Order: 2 });
    const r = await countCreatedInWindow({ prisma, Prisma: mmf(['Order']), since: SINCE });
    expect(r.counts).toEqual({ Order: 2 });
    expect(seen.map((s) => s.model)).toEqual(['Order']);
    expect(seen[0].args, '窗口没进查询 ⇒ 数的是全表').toEqual({ where: { createdAt: { gte: SINCE } } });
  });
  it('★ 四种"读不到"都不许塌成计数 0：无 createdAt 列 / 拿不到委托 / count 抛错 / DMMF 空', async () => {
    const a = await countCreatedInWindow({ prisma: {}, Prisma: mmf(['Link'], false), since: SINCE });
    expect(a.blind).toEqual(['Link']);
    expect('Link' in a.counts, '没有 createdAt 列被当成"本次造了 0 行"').toBe(false);
    const b = await countCreatedInWindow({ prisma: {}, Prisma: mmf(['Order']), since: SINCE });
    expect(b.blind).toEqual(['Order']);
    expect(b.enumerated).toBe(1);
    const { prisma: p2 } = stub({ Boom: new Error('db down') });
    const c = await countCreatedInWindow({ prisma: p2, Prisma: mmf(['Boom']), since: SINCE });
    expect(c.blind).toEqual(['Boom']);
    expect('Boom' in c.counts, '测量失败被写成 0 ⇒ 与"确实没造行"同形').toBe(false);
    const d = await countCreatedInWindow({ prisma: {}, Prisma: { dmmf: { datamodel: { models: [] } } }, since: SINCE });
    expect(d.enumerated, 'DMMF 空必须留下可读的分母读数（不是把循环静默跳过）').toBe(0);
    expect(d.blind).toEqual([]);
  });
  it('★ 分母非空对照：每张模型都被问过，counts 键数 + blind 键数 = 枚举数', async () => {
    const { prisma } = stub({ Order: 1, Invoice: 0, Shipment: 4 });
    const r = await countCreatedInWindow({ prisma, Prisma: mmf(['Order', 'Invoice', 'Shipment']), since: SINCE });
    expect(r.enumerated).toBe(3);
    expect(r.blind).toEqual([]);
    expect(r.counts).toEqual({ Order: 1, Invoice: 0, Shipment: 4 });
    const mixed = await countCreatedInWindow({ prisma, Prisma: { dmmf: { datamodel: { models: [
      { name: 'Order', fields: [{ name: 'createdAt', type: 'DateTime' }] },
      { name: 'Link', fields: [{ name: 'id', type: 'String' }] },
    ] } } }, since: SINCE });
    expect(mixed.enumerated).toBe(2);
    expect(Object.keys(mixed.counts).length + mixed.blind.length).toBe(mixed.enumerated);
  });
  it('★ BigInt 型 createdAt 也算可归因（复核 #15：本库 133/225 是 BigInt，旧谓词只认 DateTime ⇒ 白说"不可归因"）', async () => {
    const big = { dmmf: { datamodel: { models: [{ name: 'Email', fields: [{ name: 'createdAt', type: 'BigInt' }] }] } } };
    const { prisma, seen } = stub({ Email: 1 });
    const r = await countCreatedInWindow({ prisma, Prisma: big, since: SINCE });
    expect(r.counts).toEqual({ Email: 1 });
    expect(r.blind, '有 createdAt 却被类型谓词判成盲区').toEqual([]);
    // 界必须换算成毫秒 BigInt；直接塞 Date 会被 Prisma 拒（或更糟：静默比不出的方向）
    expect((seen[0].args as any).where.createdAt.gte).toBe(BigInt(SINCE.getTime()));
    expect(r.byType).toEqual({ DateTime: 0, BigInt: 1, 无createdAt: 0, 取数失败: 0 });
    const both = await countCreatedInWindow({
      prisma: { ...stub({ Order: 0 }).prisma, ...stub({ Email: 0 }).prisma },
      Prisma: { dmmf: { datamodel: { models: [
        { name: 'Order', fields: [{ name: 'createdAt', type: 'DateTime' }] },
        { name: 'Email', fields: [{ name: 'createdAt', type: 'BigInt' }] },
      ] } } }, since: SINCE,
    });
    expect(both.enumerated).toBe(2);
    expect(both.byType.DateTime).toBe(1);
    expect(both.byType.BigInt).toBe(1);
    expect(both.blind).toEqual([]);
  });
  it('★ 归因分母为 0 ⇒ 只能 unproven，而且必须**排在指控之前**（空 counts 会把每次删除都算成"删了没造过的行"）', () => {
    const accused = { ...OKR(), attributionEnumerated: 0, overDeleted: [{ model: 'Order', deleted: 3, attributable: 0 }] };
    const v = residueVerdict(accused);
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/没有分母/);
    expect(v.detail, '把测量失败写成针对删除面的指控（v3.53 同族）').not.toMatch(/删面宽于/);
    expect(residueVerdict({ ...OKR(), attributionEnumerated: 0 }).kind).toBe('unproven');
    expect(residueVerdict({ ...OKR(), attributionEnumerated: 225, overDeleted: [{ model: 'Order', deleted: 3, attributable: 0 }] }).kind)
      .toBe('residue');
  });
  it('★ 没有声明归因层的老脚本不受这条影响（否则 #49 之外的一片会被无端翻红）', () => {
    expect(residueVerdict(OKR()).kind).toBe('clean');
    expect(residueVerdict({ ...OKR(), attributionEnumerated: undefined }).kind).toBe('clean');
  });
});

describe('v3.56 · cleanup 的两种模型命名会在守恒校验里伪造指控（真跑第一程暴露）', () => {
  it('★ 同表两种拼法（级联通道写委托键、标识通道写模型名）必须归一 ⇒ 否则 overDeleted 凭空成立', () => {
    // 这一格钉的就是本次真跑暴露的形状：窗口按 Prisma 模型名 keyed，而 cleanup 的 byModel 里是 entityReference
    const cc = conservationCheck({
      createdInWindowAtWrite: { EntityReference: 16 }, createdInWindowAtClean: { EntityReference: 0 },
      deletedByModel: { entityReference: 16 },
    });
    expect(cc.overDeleted, '命名没对齐 ⇒ 把我自己造的 16 行读成"删了没造过的 16 行"').toEqual([]);
    expect(cc.residue).toEqual([]);
    // 归一之后仍要能抓到真的多删（不能因为合并就把指控抹平）
    const bad = conservationCheck({
      createdInWindowAtWrite: { EntityReference: 15 }, createdInWindowAtClean: { EntityReference: 0 },
      deletedByModel: { entityReference: 16 },
    });
    expect(bad.overDeleted).toEqual([{ model: 'EntityReference', deleted: 16, attributable: 15 }]);
  });
  it('★ 合并必须相加而不是覆盖（覆盖＝把删除数读少，多删就从这一格里溜走）', () => {
    const cc = conservationCheck({
      createdInWindowAtWrite: { Order: 3 }, createdInWindowAtClean: { Order: 0 },
      deletedByModel: { Order: 2, order: 2 },        // 两条通道各记一笔，真删 4 行
    });
    expect(cc.overDeleted).toEqual([{ model: 'Order', deleted: 4, attributable: 3 }]);
    expect(canonModel('order')).toBe('Order');
    expect(canonModel('Order')).toBe('Order');
  });
  it('★ 不可归因那格的明细必须点名表，并带上已看到的标识外增长（排序不许把已知信息吃掉）', () => {
    const v = residueVerdict({
      ...OKR(), scanned: 225, scannable: 225,
      attributionBlind: ['BusinessSequence', 'EntityLink'],
      unmarkedGrowth: [{ model: 'SystemConfigHistory', from: 34, to: 36, delta: 2 }],
    });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/BusinessSequence/);
    expect(v.detail).toMatch(/EntityLink/);
    expect(v.detail, 'blind 排在增长之前 ⇒ 不写进来这一程就再也不报增长').toMatch(/SystemConfigHistory\(\+2\)/);
  });
  it('★ 链上：分母与归因清单都必须现取，不许写死字面量', () => {
    const src = chainCode();
    expect(/attributionEnumerated:\s*Math\.min\(WIN_W\.enumerated,\s*WIN_C\.enumerated\)/.test(src.replace(/\s+/g, ' ')),
      '分母写成字面量 ⇒ "空 DMMF"那一条又成了装饰').toBe(true);
    expect(/attributionEnumerated:\s*\d/.test(src), '链上出现数字字面量当分母').toBe(false);
    expect(src.includes('WIN_W.blind.filter((m) => touched.has(canonModel(m)))'),
      '不可归因清单没按规范名筛 ⇒ 级联那一路的小写键永远配不上').toBe(true);
    expect(src.includes('const touched = new Set([...Object.keys(deletedAll)'),
      'touched 没吃合并后的删除面 ⇒ 参与范围算少，blind 会被漏筛').toBe(true);
  });
});

describe('v3.58 复核 #15 处置 · 分母要**覆盖**到被指控的那张表，不能只">0"', () => {
  it('★ 没被问过的表只登记"不可归因"，不许算成 overDeleted（复核给的反例：枚举 1 个模型 + 删了别的表）', () => {
    const neverAsked = conservationCheck({
      createdInWindowAtWrite: {}, createdInWindowAtClean: {}, deletedByModel: { Order: 3 },
    });
    expect(neverAsked.overDeleted, '整段没数过它 ⇒ ownDeleted=0 ⇒ 原写法凭空指控').toEqual([]);
    expect(neverAsked.unattributed).toEqual([{ model: 'Order', deleted: 3 }]);
    const partial = conservationCheck({
      createdInWindowAtWrite: { Relation: 1 }, createdInWindowAtClean: { Relation: 0 },
      deletedByModel: { Relation: 1, Order: 3 },
    });
    expect(partial.overDeleted).toEqual([]);
    expect(partial.unattributed).toEqual([{ model: 'Order', deleted: 3 }]);
    // ★ 反向对照：真的问过、且删多了，仍然必须指控（否则这条修法是"把指控整体抹平"）
    const real = conservationCheck({
      createdInWindowAtWrite: { Order: 2 }, createdInWindowAtClean: { Order: 0 }, deletedByModel: { Order: 3 },
    });
    expect(real.overDeleted).toEqual([{ model: 'Order', deleted: 3, attributable: 2 }]);
    expect(real.unattributed).toEqual([]);
  });
  it('★ 不可归因 + 行数没分母 同时发生时，两条都要出现在明细里（v3.56 那句"不吃掉已知信息"要覆盖这一路）', () => {
    const v = residueVerdict({
      ...OKR(), scanned: 225, scannable: 225,
      attributionBlind: ['BusinessSequence'], countBlind: ['Weird'],
      unmarkedGrowth: [{ model: 'SystemConfigHistory', from: 1, to: 3, delta: 2 }],
    });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/BusinessSequence/);
    expect(v.detail, 'countBlind 非空就把归因清单挤掉 ⇒ 已知信息又没了').toMatch(/Weird|行数对撞/);
    expect(v.detail).toMatch(/SystemConfigHistory\(\+2\)/);
    const onlyCountBlind = residueVerdict({ ...OKR(), scanned: 225, scannable: 225, countBlind: ['Weird'] });
    expect(onlyCountBlind.kind).toBe('unproven');
    expect(onlyCountBlind.detail).toMatch(/取不到/);
  });
  it('★ 分母读数必须是有限正数：Infinity / NaN / 字符串 / 负数都不算"有分母"', () => {
    for (const bad of [Infinity, NaN, '225', -1, 0, undefined, null]) {
      const v = residueVerdict({ ...OKR(), scanned: 225, scannable: 225, attributionEnumerated: bad as number });
      const want = bad === undefined || bad === null ? 'clean' : 'unproven';
      expect(v.kind, `分母=${String(bad)} 应当读作 ${want}`).toBe(want);
    }
  });
  it('★ 链上要把"没问过的删除"接进判决（不接就等于复核 #15 那条洞还在）', () => {
    const src = chainCode();
    expect(src.includes('unattributedDeleted: cons.unattributed'),
      'conservationCheck 新出的第三条没接 ⇒ 覆盖不足时既不指控也不登记').toBe(true);
  });
});

describe('v3.59 · 删除面有多条通道：合并要相加，且"核不了"不许把已看到的脏 launder 掉', () => {
  it('★ mergeDeleted：两条通道都报过同一张表时相加，不是后者覆盖前者', () => {
    const m = mergeDeleted({ Order: 1, relation: 16 }, { order: 2, Relation: 4 });
    expect(m).toEqual({ Order: 3, Relation: 20 });
    expect(mergeDeleted(null, undefined, { X: 1 })).toEqual({ X: 1 });
    expect(mergeDeleted()).toEqual({});
    // 覆盖式合并（spread）会把真实删除数读少 ⇒ 多删的那几行正好从缝里溜走
    const overwrite = { ...{ Order: 1 }, ...{ Order: 2 } };
    expect(overwrite.Order).toBe(2);
    expect(mergeDeleted({ Order: 1 }, { Order: 2 }).Order).toBe(3);
  });
  it('★ 守恒校验吃合并后的删除面：手写清单删多了也要报出来', () => {
    const merged = mergeDeleted({ Order: 3 }, {});          // 链上自己删的
    const even = conservationCheck({
      createdInWindowAtWrite: merged, createdInWindowAtClean: { Order: 0 }, deletedByModel: merged,
    });
    expect(even.overDeleted, '删的正好等于本次造的 ⇒ 不许指控').toEqual([]);
    expect(even.residue).toEqual([]);
    const over = conservationCheck({
      createdInWindowAtWrite: { Order: 2 }, createdInWindowAtClean: { Order: 0 }, deletedByModel: merged,
    });
    expect(over.overDeleted).toEqual([{ model: 'Order', deleted: 3, attributable: 2 }]);
  });
  it('★ 判决仍是 unproven，但明细要带上已看到的守恒失败与窗口残留（排序不许吞掉脏）', () => {
    const v = residueVerdict({
      ...OKR(), scanned: 225, scannable: 225,
      attributionBlind: ['BusinessSequence'],
      overDeleted: [{ model: 'Order', deleted: 9, attributable: 2 }],
      windowResidue: [{ model: 'AuditLog', rows: 4 }],
    });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/BusinessSequence/);
    expect(v.detail, '脏发现被"核不了"挤掉 ⇒ 等于把它洗成无法判定').toMatch(/守恒失败 1 处/);
    expect(v.detail).toMatch(/Order 删9\/可归因2/);
    expect(v.detail).toMatch(/AuditLog=4/);
    // 没有脏时不许凭空捏造这些字样
    const clean = residueVerdict({ ...OKR(), scanned: 225, scannable: 225, attributionBlind: ['BusinessSequence'] });
    expect(clean.detail).not.toMatch(/守恒失败/);
    expect(clean.detail).not.toMatch(/仍活着/);
  });
});

describe('v3.60 · 第四程真跑报了 24 处伪指控 ⇒ 指控要有"我确实造过行"的正对照', () => {
  it('★ 按自己拿到的 id 删过行的表，窗口却说"本次造了 0 行" ⇒ 报量具不可信，不报删多了', () => {
    const cc = conservationCheck({
      createdInWindowAtWrite: { Order: 0 }, createdInWindowAtClean: { Order: 0 },
      deletedByModel: { Order: 1 }, knownCreatedModels: ['Order'],
    });
    expect(cc.overDeleted, '窗口数不出我明知造过的行 ⇒ 坏的是量具，指控它是假话').toEqual([]);
    expect(cc.instrumentSuspect).toEqual([{ model: 'Order', deleted: 1 }]);
    // 反向：窗口看得见造行、确实删多了 ⇒ 不许被这条新守卫抹平
    const real = conservationCheck({
      createdInWindowAtWrite: { Order: 2 }, createdInWindowAtClean: { Order: 0 },
      deletedByModel: { Order: 3 }, knownCreatedModels: ['Order'],
    });
    expect(real.overDeleted).toEqual([{ model: 'Order', deleted: 3, attributable: 2 }]);
    expect(real.instrumentSuspect).toEqual([]);
  });
  it('★ 判决：量具不可信 ⇒ unproven 且点名，绝不许写成"删面宽于本次写入"', () => {
    const v = residueVerdict({
      ...OKR(), scanned: 225, scannable: 225, attributionEnumerated: 225,
      instrumentSuspect: [{ model: 'EntityReference', deleted: 16 }, { model: 'Invoice', deleted: 2 }],
    });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/量具不可信/);
    expect(v.detail).toMatch(/EntityReference 删16/);
    expect(v.detail).not.toMatch(/删面宽于/);
  });
  it('★ 链上两接：knownCreatedModels 要进守恒、instrumentSuspect 要进判决', () => {
    const src = chainCode();
    for (const f of ['knownCreatedModels: Object.keys(OWN_DELETES)', 'instrumentSuspect: cons.instrumentSuspect']) {
      expect(src.includes(f), `链上少了 ${f} ⇒ 正对照在真实路径上等于没接`).toBe(true);
    }
    // ★ v3.61：B169 的真因就是**快照取晚了**（rollback 先删，WIN_W 后数 ⇒ 本次造的行数成 0）。
    //   顺序判据：窗口快照必须排在最后一个 rollback() 调用之前（去注释后的源码上比位置）。
    const iw = src.indexOf('const WIN_W = await countCreatedInWindow');
    const ir = src.lastIndexOf('await rollback();');
    expect(iw, '链上找不到窗口快照').toBeGreaterThan(-1);
    expect(ir > iw, '归因快照又挪到 rollback 之后 ⇒ 自己删完再数"本次造了几行" ⇒ 24 处伪指控复发').toBe(true);
  });
});

describe('assertResidueAudited · 退出前复核（复核 #10 BLOCKER-2 的行为证人）', () => {
  const mk = () => createReporter({ log: () => {} });
  it('结论缺席 ⇒ 退 5；恰好一条 ⇒ 不改退出码', () => {
    const a = mk();
    let code = -999;
    const ex = (c: number) => { code = c; };
    assertResidueAudited(a, { log: () => {}, exit: ex as never });
    expect(code, '一条结论都没产出还退 -999 ⇒ 这道复核是装饰').toBe(5);
    const b = mk();
    emitResidueVerdict(OKR(), b);
    code = -999;
    assertResidueAudited(b, { log: () => {}, exit: ex as never });
    expect(code, '正常一程不该被改码').toBe(-999);
    expect(code !== 5, '退 5 与不改码必须可区分（否则上面那条断言恒真）').toBe(true);
  });
});

describe('attributionVerdict · 四格组合（署不署名 × 有没有越过的口子）', () => {
  // ★ v3.35（复核 ②）：上一批这四格只测了**拼串**。复核把闸 `if (!ALLOW_UNATTRIBUTED)` 改成永不放行，
  //   五条断言照样全绿（本仓环境里 waived 那一路 exit=2 走不到判决行 ⇒ 拼串根本没被执行）。
  //   ⇒ 闸本身也要有确定性判据：attributionRefuse 同样四格，其中「可信 + 没给口子」必须**不拒**。
  for (const [ok, waived, want] of [
    [true, false, false], [true, true, false],
    [false, false, true], [false, true, false],
  ] as Array<[boolean, boolean, boolean]>) {
    it(`闸：ok=${ok} waived=${waived} ⇒ ${want ? '拒跑 exit 3' : '放行'}`, () => {
      expect(attributionRefuse({ ok }, waived)).toBe(want);
    });
  }
  it('★ 拒跑话术里不许再出现"不可署名"这四个字（否则负面对照会被我自己的文案喂绿）', () => {
    const src = chainCode();   // ★ v3.37：改跑去注释后的代码 —— 原来读原文，注释里写这四个字就能把这条喂绿
    const refusal = src.slice(src.indexOf('attributionRefuse(t, ALLOW_UNATTRIBUTED)'),
      src.indexOf('process.exit(3)'));
    expect(refusal.length > 40, '没截到拒跑那一段 ⇒ 下面那条断言是空转').toBe(true);
    expect(refusal.includes('不可署名'), '拒跑话术含该四字 ⇒ 上一批那条被喂绿的负面对照又会失效').toBe(false);
  });
  for (const [ok, waived, want] of [
    [true, false, '可署名'],
    [true, true, '可署名'],
    [false, false, '不可署名'],
    [false, true, '不可署名(已用 --allow-unattributed 越过)'],
  ] as Array<[boolean, boolean, string]>) {
    it(`ok=${ok} waived=${waived} ⇒「${want}」，且不可署名的两种写法都不许读起来像署过名`, () => {
      const s = attributionVerdict({ ok }, waived);
      expect(s).toBe(want);
      if (!ok) {
        expect(s).toMatch(/不可署名/);
        expect(s === '可署名', '被越过的日志不许等于"可署名"').toBe(false);
      }
    });
  }
});

/**
 * ★ v3.34（复核 ⑨）：上一批我在提交信息里写"少一格由本批列数断言当场抓到"，但那次断言是**提交之后**跑的，
 *   也从没落进任何被提交的测试 ⇒ 同一类错第三次会照旧绿着进历史。这里落成常驻判据。
 *   ⚠️ 不能并进 `authoritative-doc-shape.test.ts`：那个守卫**故意**只认"多一格"（其第 15/53 行写明是设计选择），
 *      所以"少一格"必须另立一格 —— 这正是它连咬两批的原因。
 */
it('★ 台账 §9 每行必须 4 格（5 个未转义管道）——守卫不管"少一格"，这里管', () => {
  const doc = join(SCRIPTS_DIR, '..', 'docs', '交付目标与验收标准-2026-09-20.md');
  const ls = readFileSync(doc, 'utf8').split('\n');
  const isRow = (l: string) => /^\| \*\*B\d{3}\*\*/.test(l);
  const pipes = (l: string) => (l.match(/(?<!\\)\|/g) || []).length;
  const bad = ls.map((l, i) => [i + 1, l] as const).filter(([, l]) => isRow(l) && pipes(l) !== 5)
    .map(([i, l]) => `L${i} ${l.slice(0, 14)} 管道 ${pipes(l)}（应 5）`);
  expect(bad.join('\n'), '有 §9 行少/多列 ⇒ 改表要核列序').toBe('');
  const seen = ls.filter(isRow).length;
  // ★ 分母哨兵当场教我做人：这一格第一次跑，我就把"几十行"当成 80 写进去了，实际**实测 61 行**
  //   ⇒ 哨兵红了、而不是让我蒙过去。口径：全文所有 `^| **B<3 位>**` 开头的表行（§9 与 §9.1/§8 里同形的行都算），
  //   界 55 = 实测 61 留 6 行余量；净删 7 行以上才红，那正是该问一场的量级。
  expect(seen, `§9 类表行只扫到 ${seen} 行 ⇒ 正则或路径变了，这一格在空转（0 读数要带非零对照）`).toBeGreaterThanOrEqual(55);
});

describe('自证判据 · 正向对照（防退化成恒拒绝）', () => {
  it('同 checkout + 同 HEAD + 干净工作树 + 本机演练库 ⇒ 可署名', () => {
    const t = isTrustworthy(okCase);
    expect(t.reasons, `不该有拒因，实际：${R(okCase)}`).toEqual([]);
    expect(formatBanner(okCase)).toContain('✓ 读数可署名本分支本 commit');
  });
});

describe('自证判据 · 每条臂都可发生且各杀各的', () => {
  it('后端属于另一个 checkout ⇒ ARTIFACT_MISMATCH，并把两边根路径都写出来', () => {
    const sc = { ...okCase, listeners: { '8081': [listener({ root: '/other', branch: 'main', pid: '68014' })] } };
    expect(R(sc)).toContain('ARTIFACT_MISMATCH');
    expect(R(sc)).toContain('/other');
    expect(R(sc)).toContain('/x');
  });

  it('★ 同 checkout 但后端 HEAD 落后（服务没重启）⇒ BACKEND_STALE（上一版的 BRANCH_DRIFT 不可达，这条才是真日常）', () => {
    const sc = { ...okCase, listeners: { '8081': [listener({ head: 'bbbb'.padEnd(40, 'b') })] } };
    expect(R(sc)).toContain('BACKEND_STALE');
  });

  it('★ 工作树有未提交改动 ⇒ DIRTY_WORKTREE：读数不能署给任何 commit', () => {
    expect(R({ ...okCase, dirtyPaths: [' M server/src/x.ts'] })).toContain('DIRTY_WORKTREE');
  });

  it('端口无监听 ⇒ NO_BACKEND；同端口两个进程在听 ⇒ MULTIPLE_BACKENDS（本批实测真出现过）', () => {
    expect(R({ ...okCase, listeners: { '8081': [] } })).toContain('NO_BACKEND');
    const two = { ...okCase, listeners: { '8081': [listener(), listener({ pid: '22043' })] } };
    expect(R(two)).toContain('MULTIPLE_BACKENDS');
  });

  it('★ 脚本里出现的端口必须逐个取证：有端口取不到 ⇒ 该端口的 NO_BACKEND 必须冒出来（不许只挑 8081 自证）', () => {
    const sc = { ...okCase, ports: ['3000', '8081'], listeners: { '3000': [], '8081': [listener()] } };
    expect(R(sc)).toContain('端口 3000');
    expect(R(sc)).toContain('NO_BACKEND');
  });

  it('库维度三类都要拒：无 env / 库名不像演练库 / host 非本机', () => {
    expect(R({ ...okCase, db: { envFile: null, url: null, name: null, host: null, port: null, unparseable: false } })).toContain('ENV_MISSING');
    expect(R({ ...okCase, db: { ...OK_DB, name: 'bambook_prod' } })).toContain('PRODUCTION_DB_SUSPECT');
    expect(R({ ...okCase, db: { ...OK_DB, host: '10.0.0.7' } })).toContain('REMOTE_DB_FORBIDDEN');
  });
});

it('★ v3.47 取证范围绑定真实目标：传 targetPorts 就只取那几个，不传才退回"脚本里提到的端口"', () => {
  const withTarget = selfCheck({ targetPorts: ['8123'] });
  expect(withTarget.ports).toEqual(['8123']);
  expect(withTarget.portsAreTarget, '没承认自己是目标口径 ⇒ banner 会把它说成全量取证').toBe(true);
  const fallback = selfCheck();
  expect(fallback.portsAreTarget, '不传时不该谎称是目标口径').toBe(false);
  // 反面对照：外来后端占着"被提到过"的端口，不该再拦住一次指向自家端口的真跑
  expect(withTarget.ports.includes('8081'), '目标端口被脚本名单污染 ⇒ 这次修的洞没堵上').toBe(false);
  void readDbTarget;
});

describe('readDbTarget · env 解析', () => {
  /**
   * ★ v2.93：整组默认隔离 `process.env.DATABASE_URL`。
   *   成因不是抖动（我一度记成"B15 扩到根门禁"，那条**撤回**）：只要外层 shell `set -a; . .env`
   *   导出过 ambient URL，实现里"显式传参优先于文件"那一支就会盖住被测的**文件解析**路径
   *   ⇒ 期望 127.0.0.1 拿到 localhost，**确定性红**；换一条不 source 的命令再跑就绿 ⇒ 看着像串跑抖动。
   *   本组另一条用例早就单独 delete 过（原注释："不删就会把调用方显式传的那条当成仓库的读数"），
   *   但**只补了一个落点** ⇒ 同族三条解析用例一直裸奔（一族多落点要普查，本仓第 N 次）。
   */
  let ambient: string | undefined;
  beforeEach(() => { ambient = process.env.DATABASE_URL; delete process.env.DATABASE_URL; });
  afterEach(() => { if (ambient === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = ambient; });
  const mk = (body) => { const root = mkdtempSync(join(tmpdir(), 'sc-')); mkdirSync(join(root, 'server'), { recursive: true }); writeFileSync(join(root, 'server', '.env.local'), body); return root; };

  it('双引号写法解析出库名/host/port', () => {
    const db = readDbTarget(mk('DATABASE_URL="postgresql://p:pw@127.0.0.1:5432/panda_hub_local?schema=public"\n'));
    expect([db.name, db.host, db.port]).toEqual(['panda_hub_local', '127.0.0.1', '5432']);
  });

  it('★ 单引号写法也要吃下（上一版只吃双引号 ⇒ 引号被读进 URL ⇒ new URL 抛 ⇒ 误判 ENV/UNPARSEABLE）', () => {
    const db = readDbTarget(mk("DATABASE_URL='postgresql://p:pw@127.0.0.1:5432/panda_hub_local'\n"));
    expect(db.name, `单引号解析失败：${JSON.stringify(db)}`).toBe('panda_hub_local');
    expect(db.unparseable).toBe(false);
  });

  it('无引号写法同样可解析', () => {
    expect(readDbTarget(mk('DATABASE_URL=postgresql://p:pw@localhost:5432/panda_hub_local\n')).name).toBe('panda_hub_local');
  });

  it('仓库里没有 env 文件、也没显式给 URL ⇒ envFile=null，**不去猜别处的**', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;   // ← 不删就会把"调用方显式传的那条"当成仓库的读数（假绿）
    try {
      const db = readDbTarget(mkdtempSync(join(tmpdir(), 'sc-none-')));
      expect(db.envFile).toBeNull();
      expect(db.url).toBeNull();
      expect(db.name).toBeNull();
    } finally { if (saved !== undefined) process.env.DATABASE_URL = saved; }
  });

  // ★ 显式传参这一支是 G-4 收尾才开的（s0a 这个 worktree 本来就没有 env 文件 ⇒ 只读探针跑不起来）。
  //   开它的唯一理由是"来源照样打进横幅" ⇒ 那这两件事必须有断言兜着，不能只是注释里说说。
  it('★ 显式 DATABASE_URL 优先于文件，且来源被记下来（横幅要能说出"这条 URL 是谁给的"）', () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://p:pw@localhost:5432/panda_hub_local';
    try {
      const db = readDbTarget(mk('DATABASE_URL="postgresql://p:pw@127.0.0.1:5432/other_db"\n'));
      expect(db.name).toBe('panda_hub_local');
      expect(db.urlSource).toBe('process.env.DATABASE_URL');
      // 远端/生产库走同一条支路也必须被同一份判据拒掉（不许"显式传参"变成绕过红线的后门）
      process.env.DATABASE_URL = 'postgresql://p:pw@db.internal.prod:5432/panda_hub_prod';
      const bad = readDbTarget(mkdtempSync(join(tmpdir(), 'sc-remote-')));
      expect(R({ ...okCase, db: bad })).toContain('REMOTE_DB_FORBIDDEN');
    } finally { if (saved !== undefined) process.env.DATABASE_URL = saved; else delete process.env.DATABASE_URL; }
  });
});

describe('标识集合 · 唯一出处（复核抓到"三套并行真源"后的收口）', () => {
  it('残留族与 SIM 族**必须分开**：SIM- 绝不在可删集合里（它是常驻演示数据集，不是残留）', () => {
    expect(RESIDUE_MARKERS).not.toContain('SIM-');
    expect(SIM_DATASET_MARKERS).toEqual(['SIM-']);
  });

  it('清扫器认的 6 个标识与旧字面量逐字相同 ⇒ 本次收口**没有改变删除行为**', () => {
    expect([...RESIDUE_MARKERS].sort()).toEqual(['DRILL', 'E2E-', 'REQ2-', 'SMOKE', 'kgkgtest', 'testdev'].sort());
  });
});

describe('数据范围判定 · verdict（B35）', () => {
  const base = { total: 1000, residue: 0, sim: 0, attributable: 0, share: 0, markers: { residue: RESIDUE_MARKERS, sim: SIM_DATASET_MARKERS }, rows: [], db: { name: 'x', host: 'localhost', envFile: 'y' }, scopeNote: '' };

  it('一行都归属不到人造集 ⇒ 点名"B35 未清"', () => {
    const v = verdict({ ...base, total: 1812 }).join(' ');
    expect(v).toContain('B35 未清');
    expect(v).toContain('1812');
  });

  it('★ 归属占比过半才给 ✓（正向对照，防恒拒绝）', () => {
    const v = verdict({ ...base, residue: 10, sim: 900, attributable: 910, share: 0.91 }).join(' ');
    expect(v).toContain('✓');
    expect(v).not.toContain('B35 未清');
  });

  it('半半状态不许报喜：占比 <50% ⇒ 明写"以不可归属的存量为主"', () => {
    const v = verdict({ ...base, residue: 3, sim: 69, attributable: 72, share: 0.072 }).join(' ');
    expect(v).toContain('不可归属');
    expect(v).not.toContain('✓');
  });

  it('★ 两族必须分开呈现（合成一个数就会重演"报告说的≠清扫器认的"）', () => {
    const v = verdict({ ...base, residue: 3, sim: 90, attributable: 93, share: 0.93 }).join(' ');
    expect(v).toContain('残留 3');
    expect(v).toContain('SIM 90');
  });
});

describe('端口集合取证 · scriptPorts', () => {
  it('★ 单元测试文件不许被当成业务验收脚本（复核抓到：本批自造的 acceptance-selfcheck.test.ts 会命中 glob ⇒ 每轮多两条假红）', () => {
    const ports = scriptPorts();
    expect(Array.isArray(ports)).toBe(true);
    // 直接验收集口径：仓库里真实写死的端口应包含 8081，且不得因测试文件而被稀释
    expect(ports).toContain('8081');
  });
});

/**
 * ★ G-3c 第 11 批的**复核处置**（两条 BLOCK 之一：`loadEnvForScript` 当时只被 2/21 个脚本调用，
 *   其余脚本直接 `new PrismaClient()` ⇒ Prisma 会去加载**主 checkout** 那份 .env.local，
 *   于是"在本 worktree 里跑、连的却是别人的库、读数还署在本分支名下"）。
 *   现在：① 每个自建 client 的验收脚本都必须先过 `loadEnvForScript()`（取不到 env 就抛 ⇒ 宁可拒跑）；
 *   ② 下面这条**普查守卫**把"忘了接"从"只能靠人复核"变成"门禁当场红"。
 *   判据只有一份实现（本文件的 `acceptanceDiscipline()`），正面对照用同一条实现喂合成样本。
 */
describe('验收脚本 env 纪律普查（G-3c 第 11 批·复核处置）', () => {
  const MAIN = '/Users/qinwengu/WorkBuddy/Claw/apps/Bambook';
  // ★ 判据看的是**实例化**，不是模块加载：Prisma 在 `new PrismaClient()` 时才读 env ⇒
  //   `require('@prisma/client')` 写在 loadEnvForScript 之前并不构成债（第一版按"出现过 client 字样"判，
  //   会把已合规的文件报成债 ⇒ 假阳性同样是判据失真）。
  const NEW_CLIENT = /new\s+[\w$.]*PrismaClient\s*\(/;
  const CLIENT_MENTION = /@prisma\/client/;      // 兜住"import 后换个别名 new"的写法
  const ENV_FUNNEL = /\bloadEnvForScript\s*\(/; // 允许带参：`loadEnvForScript(REPO_ROOT)` 是多数写法

  function acceptanceFiles(root = SCRIPTS_DIR) {
    // 分母取自 lib 的同一份实现（复核 MINOR-7：执行器与普查此前各写一份 glob）
    return acceptanceScriptFiles(join(root, '..'), { includeE2E: true }).map((f) => join(root, f));
  }
  /** 只量**代码行**（注释里提主路径不算债，与台账 B48 的 v2.28 口径一致） */
  const codeLines = (file) => readFileSync(file, 'utf-8').split('\n')
    // ★ 复核 I-4：整行注释过滤掉了，但**行尾注释**里写一句 loadEnvForScript() 同样能骗过"这个文件出现过"的判据
    //   ⇒ 判据之前先把行尾注释切掉（按 ` // ` 切，避免把 http:// 这类字符串里的斜杠剪掉）
    .map((l) => l.split(' // ')[0].trim())
    .filter((t) => t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'));

  function discipline(files) {
    const noEnv = [], lateEnv = [], absPath = [];
    for (const f of files) {
      const lines = codeLines(f);
      const code = lines.join('\n');
      const cIdx = lines.findIndex((l) => NEW_CLIENT.test(l));
      const eIdx = lines.findIndex((l) => ENV_FUNNEL.test(l));
      const touchesClient = cIdx >= 0 || CLIENT_MENTION.test(code);
      if (touchesClient && eIdx < 0) noEnv.push(f);
      else if (cIdx >= 0 && eIdx > cIdx) lateEnv.push(`${f}（env 在第 ${eIdx + 1} 条代码行、client 在第 ${cIdx + 1} 条）`);
      if (code.includes(MAIN)) absPath.push(f);
    }
    return { noEnv, lateEnv, absPath, total: files.length };
  }

  /*
   * ★ 复核 I-5：原先这条写的是"普查分母 ⊇ 执行器分母"，但两个分母出自**同一函数的两支正则**
   *   （`^acceptance-` 天然被 `^(acceptance|e2e)-` 包含）⇒ 那条断言结构上不可能失败，
   *   删掉 18 个脚本让它从 80 掉到 62 依旧全绿。真正有效的地板是**棘轮基线**：
   *   分母只许涨不许跌，要跌必须显式改这两个数（改的时候会被问到为什么）。
   */
  const WIDE_BASELINE = 80;      // 2026-09-21 实测：^(acceptance|e2e)- 且非 .test.ts
  const NARROW_BASELINE = 78;    // 2026-09-21 实测：run-all-acceptance 的 ^acceptance- 口径
  it('★ 分母是**棘轮**（只许涨不许跌），且普查分母覆盖执行器分母', () => {
    const wide = acceptanceFiles();
    const narrow = acceptanceScriptFiles(join(SCRIPTS_DIR, '..'));
    expect(wide.length, `普查分母从基线 ${WIDE_BASELINE} 掉到 ${wide.length} ⇒ 有脚本被删/改名，先说清去哪了`).toBeGreaterThanOrEqual(WIDE_BASELINE);
    expect(narrow.length, `执行器分母从基线 ${NARROW_BASELINE} 掉到 ${narrow.length}`).toBeGreaterThanOrEqual(NARROW_BASELINE);
    for (const f of narrow) expect(wide, `执行器清单里有 ${f}，普查分母却不含`).toContain(join(SCRIPTS_DIR, f));
  });

  it('★ 自建 PrismaClient 的验收脚本，100% 在**构造之前**先过本仓 env 真源（loadEnvForScript）', () => {
    const { noEnv, lateEnv } = discipline(acceptanceFiles());
    expect(noEnv, `这些脚本会让 Prisma 去借主 checkout 的 env：\n${noEnv.join('\n')}`).toEqual([]);
    expect(lateEnv, `这些脚本接了 env 但接在 new PrismaClient() **之后** ⇒ 等于没接：\n${lateEnv.join('\n')}`).toEqual([]);
  });

  it('★ 验收/e2e 子集里不许再出现主 checkout 绝对路径（代码行口径）', () => {
    const { absPath } = discipline(acceptanceFiles());
    expect(absPath, `仍硬编码主 checkout：\n${absPath.join('\n')}`).toEqual([]);
  });

  it('★ 正面对照：三种缺陷形状各自都要被抓（否则上面几条是恒绿）', () => {
    const root = mkdtempSync(join(tmpdir(), 'disc-'));
    const bad1 = join(root, 'acceptance-borrowed-env.mjs');      // ① 完全没过 env 真源
    const bad2 = join(root, 'acceptance-hardcoded-path.mjs');     // ② 连 dotenv 路径都写死主 checkout
    const bad3 = join(root, 'acceptance-late-env.mjs');           // ③ 接了 env，但接在构造之后（复核 BLOCK-2 的现场）
    const bad4 = join(root, 'acceptance-env-and-abs.mjs');         // ④ 已接 env 却仍硬编码主路径 —— 本批真实回归形状
    const good = join(root, 'acceptance-clean.mjs');
    writeFileSync(bad1, "import { createRequire } from 'node:module';\nconst req = createRequire(SERVER_DIR + '/');\nconst { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient();\n");
    writeFileSync(bad2, `const req = createRequire('${MAIN}/server/');\nreq('dotenv').config({ path: '${MAIN}/server/.env.local', override: true });\nconst { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient();\n`);
    writeFileSync(bad3, "const { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient();\nloadEnvForScript();\n");
    writeFileSync(bad4, "loadEnvForScript(SERVER_DIR + '/..');\nconst base = '" + MAIN + "';\nconst { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient();\n");
    writeFileSync(good, "import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';\nloadEnvForScript();\nconst { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient();\n");
    const bad5 = join(root, 'acceptance-comment-only-env.mjs');   // ⑤ 只在**行尾注释**里写了 funnel ⇒ 仍是零装载
    writeFileSync(bad5, "const { PrismaClient } = req('@prisma/client');\nconst prisma = new PrismaClient(); // loadEnvForScript() 忘了接\n");
    const r = discipline([bad1, bad2, bad3, bad4, bad5, good]);
    expect(r.noEnv, '⑤ 行尾注释里的那句必须**不算**已装载 env').toEqual([bad1, bad2, bad5]);
    expect(r.lateEnv.length, '③ 接晚了必须单独成一条债').toBe(1);
    expect(r.lateEnv[0]).toContain(bad3);
    expect(r.absPath).toEqual([bad2, bad4]);   // ④ absPath 臂独立可触发，不与 noEnv 重叠才算真判据
    expect(r.noEnv).not.toContain(good);      // 合规写法不误伤（否则修法会变成"删掉判据"）
    expect(r.lateEnv).not.toContain(good);
    // ★ 棘轮的失效面也要可达：不删真文件，改喂一个 62 条的切片，同一条比较必须判红
    const shrunk = acceptanceFiles().slice(0, 62);
    expect(shrunk.length < WIDE_BASELINE, '分母塌到 62 时棘轮应当报警（不报警 = 基线是装饰品）').toBe(true);
  });

  const REPO2 = fileURLToPath(new URL('..', import.meta.url));
  /**
   * ★ B160 的行为级对照：主链在"打不到本仓后端"时必须**拒跑**，且拒在连库之前（确定性：
   *   本工作树没有 server/.env.local，若身份闸排在 connectPrisma 之后，这条就会被 ENV_MISSING 抢先，
   *   于是"打错服务"这一整类错误永远不会被门禁看见）。
   *   两侧：不给口子 ⇒ exit 3 且不得出现"零残留复核"；给了口子 ⇒ 判决行必须仍写着"不可署名"。
   */
  it('M3 主链的署名硬前置：打不到本仓后端就拒跑（exit 3），且日志里不许出现"零残留复核"', () => {
    const script = join(REPO2, 'scripts/acceptance-e2e-business-chain.mjs');
    const run = (argv: string[]) => {
      try {
        const out = execFileSync(process.execPath, [script, ...argv], {
          cwd: REPO2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CHAIN_BASE: 'http://127.0.0.1:1' },
        });
        return { code: 0, out };
      } catch (e: any) {
        return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const denied = run([]);
    expect(denied.code, `不可署名却放行（exit=${denied.code}）⇒ 整链会在别人的服务上写、在自己的库里数残留：
${denied.out.slice(-600)}`).toBe(3);
    expect(denied.out).toMatch(/不可署名|无监听|B160/);
    // ★ 断的是"有没有产出那条结论"，不是"有没有出现这几个字" —— 拒跑话术本身就写着
    //   『末尾那句"零残留复核"无从署名』，按子串判会把守门员的解释当成违规输出（第一版就是这么红的）。
    expect(/✓ 零残留复核|══ 结果：/.test(denied.out), '拒跑之前不许已经产出残留结论或判决行').toBe(false);
    // ★ v3.35（复核 ②）：原来这两条是 `waived.out` 含"不可署名" + 不含"署名=可署名" ——
    //   我把拒跑话术里那个词去掉之后它立刻红，正好证明**它此前测的是我的文案，不是那道闸**：
    //   waived 那一路 exit=2（缺 env），根本走不到判决行 ⇒ "留痕真被打印过"在本环境**不可验**，
    //   只能验到"闸放行了"与"判决行由那个纯函数拼装"两件事。第三件不假装做到。
    const waived = run(['--allow-unattributed']);
    expect(waived.code, '给了口子还被 exit 3 ⇒ 闸没生效（这正是复核 ② 的攻击形）').not.toBe(3);
    // ★ v3.37 收回一条假判据（复核 #7 早就点过、上一批只在上面补了新 pin，这条却没删）：
    //   原来这里是 `/署名=\$\{attributionVerdict\(/` 对**原始源码**做子串测试，看着像在钉"末尾判决行"，
    //   实际命中的是 exit-4 那条旁路的早退判决行 ⇒ 把真末尾行改回字面量它照样绿。
    //   真 pin 在上面 describe 里（去注释 + 从 `const ok = results.filter` 截到结尾）。
    //   这里只保留本用例**真的**能验的那件事：拒跑发生在产出结论之前（上面那条 /✓ 零残留复核|══ 结果：/ 为空）。
    // ⚠️ 未登记为已验的部分：waived 实际打印出「不可署名(已用 --allow-unattributed 越过)」需要
    //   一个能连库的环境（本工作树没有）⇒ 留作首次真跑 M3 时的必查项，不在这里冒充通过。
  });

  it('★ loadEnvForScript 本身：本仓没有 env ⇒ 抛 ENV_MISSING（不回退借）；有 env ⇒ 返回读数并装载', () => {
    const saved = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const empty = mkdtempSync(join(tmpdir(), 'env-none-'));
      mkdirSync(join(empty, 'server'), { recursive: true });
      expect(() => loadEnvForScript(empty)).toThrow(/ENV_MISSING/);

      // 正向对照半臂：显式 DATABASE_URL 在位 ⇒ 不读任何文件、直接认这条（urlSource 会说出来）
      process.env.DATABASE_URL = 'postgresql://p:pw@127.0.0.1:5432/panda_hub_local?schema=public';
      const db = loadEnvForScript(mkdtempSync(join(tmpdir(), 'env-ok-')));
      expect(db.name).toBe('panda_hub_local');
      expect(db.urlSource).toBe('process.env.DATABASE_URL');
      // ★ 另一条正向对照：文件式 env 的解析由 readDbTarget 那条用例钉（同一条实现）；
      //   这里刻意**不**用临时目录跑 dotenv —— dotenv 只在本仓 node_modules 里可解析，
      //   在 /tmp 下造目录会得到 MODULE_NOT_FOUND，那是测试环境的问题不是判据（复核同款陷阱：替身要忠实真实形状）。
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});

/* ★ v3.63（复核 #15 I-1）：「指控归零」不许靠缺席反推 —— 覆盖行 */
describe('coverageLine · 每次判决都自带"八条前提各自几条 + 删除面逐表落点"', () => {
  const DISP = [
    { model: 'Order', bucket: 'passedDeleted', deleted: 1, created: 1, alive: 0 },
    { model: 'Invoice', bucket: 'passedDeleted', deleted: 2, created: 2, alive: 0 },
    { model: 'Customer', bucket: 'passedIdle', deleted: 0, created: 3, alive: 0 },
    { model: 'SystemConfigHistory', bucket: 'residue', deleted: 0, created: 2, alive: 2 },
    { model: 'AuditLog', bucket: 'over', deleted: 9, created: 2, alive: 0 },
    { model: 'OrderLine', bucket: 'unasked', deleted: 1, created: 0, alive: 0 },
    { model: 'Quotation', bucket: 'suspect', deleted: 1, created: 0, alive: 0 },
  ];
  it('conservationCheck 逐表记落点：连"守恒通过"的表也要点名列出（通过是正读数，不是缺席）', () => {
    const c = conservationCheck({
      createdInWindowAtWrite: { Order: 1, Invoice: 2, SystemConfigHistory: 2, AuditLog: 2, Quotation: 0, Customer: 3 },
      createdInWindowAtClean: { Order: 0, Invoice: 0, SystemConfigHistory: 2, AuditLog: 0, Quotation: 0, Customer: 0 },
      deletedByModel: { Order: 1, Invoice: 2, AuditLog: 9, OrderLine: 1, Quotation: 1 },
      knownCreatedModels: ['Quotation'],
    });
    const by: any = Object.fromEntries(c.disposition.map((x: any) => [x.model, x.bucket]));
    expect(by).toMatchObject({ Order: 'passedDeleted', Invoice: 'passedDeleted', Customer: 'passedIdle',
      SystemConfigHistory: 'residue', AuditLog: 'over', OrderLine: 'unasked', Quotation: 'suspect' });
    // ★ B181：本次造了行却一行都没删 ⇒ 守恒式两边都是 0，那是**恒成立**，不许记成"删过且成立"
    expect(by.Customer, '没删过行的表被记成"删过且守恒成立" ⇒ 190 张里有 163 张就是这么混进来的').toBe('passedIdle');
    // 一张都不许多、一张都不许少：落点集合必须等于"被看过 ∪ 被删过"的并集
    expect(c.disposition.map((x: any) => x.model).sort())
      .toEqual(['AuditLog', 'Customer', 'Invoice', 'Order', 'OrderLine', 'Quotation', 'SystemConfigHistory']);
    // 四张指控桶的数组本身不能被落点表替代（判据未改，覆盖只是加法）
    expect(c.overDeleted).toEqual([{ model: 'AuditLog', deleted: 9, attributable: 2 }]);
    expect(c.instrumentSuspect).toEqual([{ model: 'Quotation', deleted: 1 }]);
  });
  it('六个判决分支各自的输入都拿得到覆盖行；hits 那支必须报出被它顶掉的守恒失败条数', () => {
    const branches: Array<[string, any]> = [
      ['标识命中（最前面的早退，原来会吞掉其余一切）', { ...OKR(), hits: [{ model: 'Order', count: 2 }] }],
      ['归因层没有分母（第二条早退）', { ...OKR(), attributionEnumerated: 0, overDeleted: [{ model: 'AuditLog', deleted: 9, attributable: 2 }] }],
      ['合并盲区', { ...OKR(), attributionBlind: ['OrderLine'], unattributedDeleted: [{ model: 'OrderLine', deleted: 1 }] }],
      ['守恒失败', { ...OKR(), overDeleted: [{ model: 'AuditLog', deleted: 9, attributable: 2 }] }],
      ['窗口残留', { ...OKR(), windowResidue: [{ model: 'SystemConfigHistory', rows: 2 }] }],
      ['干净', OKR()],
    ];
    for (const [name, r] of branches) {
      const line = coverageLine({ ...r, disposition: DISP });
      // 九条前提一条都不许多余地被省掉（分支不同 ⇒ 条数不同，但**标签必须在**）
      for (const k of ['标识命中', '窗口残留', '守恒失败', '未问不可归因', '归因盲区', '量具可疑', '标识外增长', '低于基线', '行数取不到']) {
        expect(line, `${name}：覆盖行少了「${k}」这一条`).toMatch(new RegExp(`${k}=\\d+`));
      }
      expect(line, name).toMatch(/逐表落点：守恒通过\(删过行\)=2\[Order,Invoice\]/);
      expect(line, name).toMatch(/守恒恒成立\(没删过\)=1\[Customer\]/);
      expect(line, name).toMatch(/没被问过=1\[OrderLine\]/);
      expect(line, name).toMatch(/守恒失败=1\[AuditLog\]/);
    }
    // hits 那一支正是原来的吞人处：判决 detail 只讲命中，但被它顶掉的守恒失败必须从覆盖行里看得见条数
    expect(residueVerdict({ ...OKR(), hits: [{ model: 'Order', count: 2 }], overDeleted: [{ model: 'AuditLog', deleted: 9, attributable: 2 }] }).detail)
      .toBe('Order=2');
    expect(coverageLine({ ...OKR(), hits: [{ model: 'Order', count: 2 }], overDeleted: [{ model: 'AuditLog', deleted: 9, attributable: 2 }] }))
      .toMatch(/守恒失败=1/);
    // 判据与措辞一字未动：覆盖行是**加法**，不许反过来成为放宽入口
    expect(residueVerdict({ ...OKR(), hits: [{ model: 'Order', count: 2 }] }).detail).toBe('Order=2');
  });
  it('emitResidueVerdict 真的把覆盖行打出去（算了没上屏＝没有证人）', () => {
    const seen: string[] = [];
    const rep = createReporter({ log: (s: string) => seen.push(s) });
    emitResidueVerdict({ ...OKR(), attributionBlind: ['OrderLine'], unattributedDeleted: [{ model: 'OrderLine', deleted: 1 }],
      windowResidue: [{ model: 'SystemConfigHistory', rows: 2 }], disposition: DISP }, rep);
    const out = seen.join('\n');
    expect(out).toMatch(/守恒通过\(删过行\)=2\[Order,Invoice\]/);
    expect(out).toMatch(/守恒恒成立\(没删过\)=1\[Customer\]/);
    expect(out).toMatch(/量具可疑=0/);
    expect(out).toMatch(/标识命中=0/);
  });
  it('没喂 disposition ⇒ 覆盖行必须明说"未接"，不许拿空集冒充"全部守恒通过"', () => {
    const l = coverageLine(OKR());
    expect(l).toMatch(/逐表落点=未接/);
    expect(l).not.toMatch(/守恒通过\(删过行\)=0/);
    expect(l).not.toMatch(/守恒恒成立\(没删过\)=0/);
  });
  it('★ B181：两档必须各报各的数 —— 全空闲时"删过行=0"要敢打，不许并成一个 190 冒充核过', () => {
    const c = conservationCheck({
      createdInWindowAtWrite: { Customer: 3, Product: 5 },
      createdInWindowAtClean: { Customer: 0, Product: 0 },
      deletedByModel: {},
    });
    const line = coverageLine({ ...OKR(), disposition: c.disposition });
    expect(line).toMatch(/守恒通过\(删过行\)=0 /);
    expect(line).toMatch(/守恒恒成立\(没删过\)=2\[Customer,Product\]/);
    // 反向：删过行且守恒成立的那张要落到第一档，两档之和仍等于被看过的表数（不许漏记）
    const c2 = conservationCheck({
      createdInWindowAtWrite: { Customer: 3, Order: 1 },
      createdInWindowAtClean: { Customer: 0, Order: 0 },
      deletedByModel: { Order: 1 },
    });
    const l2 = coverageLine({ ...OKR(), disposition: c2.disposition });
    expect(l2).toMatch(/守恒通过\(删过行\)=1\[Order\]/);
    expect(l2).toMatch(/守恒恒成立\(没删过\)=1\[Customer\]/);
    expect(c2.disposition.length, '两档之和必须等于被看过的表数 ⇒ 拆档不许顺手丢掉一张').toBe(2);
  });
  it('★ 链上接线：disposition 必须从 conservationCheck 一路进到 emitResidueVerdict 的入参（去注释后的源码）', () => {
    const src = chainCode();
    expect(src, '链没把逐表落点喂进判决 ⇒ 覆盖行永远是"未接"，这条读数就是空的').toMatch(/disposition:\s*cons\.disposition/);
    expect(src, '判决入参被换成手抄的假落点表').not.toMatch(/disposition:\s*\[\s*\]/);
  });
});

/* ★ v3.64（B170）：没有可用 createdAt 的那一族，改由「前后主键集合」归因 */
describe('snapshotIdSets / pkDiff · 主键集合归因层', () => {
  const DMMF = (defs: any[]) => ({ dmmf: { datamodel: { models: defs } } });
  const M = (name: string, createdAt: string | null, pk: any[] = [{ name: 'id', type: 'String' }]) => ({
    name,
    fields: [...pk.map((p) => ({ ...p, isId: true })), ...(createdAt ? [{ name: 'createdAt', type: createdAt }] : [])],
  });
  const stub = (ids: Record<string, string[] | Error>) => {
    const p: any = {};
    for (const [n, v] of Object.entries(ids)) {
      const key = n.charAt(0).toLowerCase() + n.slice(1);
      p[key] = { findMany: async () => { if (v instanceof Error) throw v; return (v as string[]).map((id) => ({ id })); } };
    }
    return p;
  };
  it('分母＝DMMF 里"无可用 createdAt"的全集（DateTime/BigInt 算可用、String 不算）；复合主键那张进 badShape 不静默', async () => {
    const s = await snapshotIdSets({ prisma: stub({ OrderLine: ['x'], Note: ['n'] }), Prisma: DMMF([
      M('Order', 'DateTime'), M('Link', 'BigInt'), M('OrderLine', null), M('Note', 'String'),
      M('Composite', null, [{ name: 'a', type: 'String' }, { name: 'b', type: 'Int' }])]) as any });
    expect(s.enumerated, '分母把有 createdAt 的两张也算进来了').toBe(3);
    expect(Object.keys(s.sets).sort()).toEqual(['Note', 'OrderLine']);
    expect(s.badShape, '复合主键那张不许被当成"已归因"').toEqual([{ model: 'Composite', why: '2 个主键（复合主键）' }]);
  });
  it('主键不叫 id ⇒ 同样进 badShape（现量全库 0 张，但"0"必须是量出来的不是以为的）', async () => {
    const s = await snapshotIdSets({ prisma: stub({ OrderLine: ['x'] }), Prisma: DMMF([
      M('OrderLine', null), M('Weird', null, [{ name: 'key', type: 'String' }])]) as any });
    expect(Object.keys(s.sets)).toEqual(['OrderLine']);
    expect(s.badShape).toEqual([{ model: 'Weird', why: '主键 key:String（不叫 id 或非 String）' }]);
  });
  it('快照读不到 ⇒ 进 unreadable，不许塌成"这张表本次没有新增"', async () => {
    const s = await snapshotIdSets({ prisma: stub({ OrderLine: new Error('db down') }), Prisma: DMMF([M('OrderLine', null)]) as any });
    expect(s.unreadable).toEqual(['OrderLine']);
    expect('OrderLine' in s.sets, '读不到却给了空集合 ⇒ 与"确实没有新增"同形').toBe(false);
  });
  it('pkDiff：post∖pre 逐行点名残留；pre∖post 只登记；单侧缺表记 skipped 而不是一边当空集', () => {
    const d = pkDiff({ pre: { OrderLine: new Set(['a', 'b']) }, post: { OrderLine: new Set(['a', 'c']), Relation: new Set(['r']) } });
    expect(d.created).toEqual([{ model: 'OrderLine', n: 1, ids: ['c'] }]);
    expect(d.vanished).toEqual([{ model: 'OrderLine', n: 1, ids: ['b'] }]);
    expect(d.skipped.length).toBe(1);
    expect(d.skipped[0].model).toBe('Relation');
    expect(d.skipped[0].why).toMatch(/缺跑前快照/);
  });
  it('pkResidue 是残留（residue 类）；pkVanished 只判"核不了"，绝不被写成删除面指控', () => {
    const r = residueVerdict({ ...OKR(), pkEnumerated: 35, pkCompared: 35,
      pkResidue: [{ model: 'OrderLine', n: 1, ids: ['c'] }] });
    expect(r.kind).toBe('residue');
    expect(r.detail).toMatch(/主键集合差分/);
    expect(r.detail).toMatch(/OrderLine=1\[c\]/);
    const v = residueVerdict({ ...OKR(), pkEnumerated: 35, pkCompared: 35,
      pkVanished: [{ model: 'Relation', n: 2, ids: ['r1', 'r2'] }] });
    expect(v.kind).toBe('unproven');
    expect(v.detail, '把"基线行消失"写成针对删除面的指控（第四程那 24 条的同族）').not.toMatch(/删面宽于|守恒校验失败/);
    expect(v.detail).toMatch(/基线行消失/);
  });
  it('★ 排序不许吃脏：合并盲区那条早退必须把 pk 两条一起出声', () => {
    const v = residueVerdict({ ...OKR(), attributionBlind: ['OrderLine'], unattributedDeleted: [{ model: 'OrderLine', deleted: 1 }],
      pkEnumerated: 35, pkCompared: 35,
      pkVanished: [{ model: 'Relation', n: 1, ids: ['r'] }], pkResidue: [{ model: 'Note', n: 1, ids: ['n'] }] });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/主键集合残留（本次新增且清理后仍活着）1 处/);
    expect(v.detail).toMatch(/基线行消失 1 张/);
  });
  it('coverageLine 带上 pk 三条（否则"某张表没出现"又只剩缺席反推）', () => {
    const l = coverageLine({ ...OKR(), pkResidue: [{ model: 'OrderLine', n: 1 }], pkSkipped: [{ model: 'Composite', why: '复合主键' }] });
    expect(l).toMatch(/主键集合残留=1/);
    expect(l).toMatch(/基线行消失=0/);
    expect(l).toMatch(/主键两侧不对称=1/);
  });
  it('★ pkDiff.compared 只数两侧都有快照的那几张（并集当分母＝分母宽于证据面）', () => {
    const d = pkDiff({ pre: { OrderLine: new Set(['a']) }, post: { OrderLine: new Set(['a']), Relation: new Set(['r']) } });
    expect(d.compared, 'Relation 只有跑后一侧，没比过就不许进分母').toBe(1);
    expect(d.skipped.length).toBe(1);
    const e = pkDiff({ pre: {}, post: {} });
    expect(e.compared, '两侧全空 ⇒ compared 必须是 0（这一档要能被判据抓住）').toBe(0);
  });
  it('★ 链上三接：跑前快照在首次写入之前、跑后快照在清扫之后、pk 三条进判决入参（去注释后的源码）', () => {
    const src = chainCode();
    const pre = src.indexOf('PK_PRE = await snapshotIdSets');
    const post = src.indexOf('PK_POST = await snapshotIdSets');
    const firstWrite = src.indexOf("step('S1 客户档案");
    const swept = src.indexOf('settleAndClean(');
    const rolled = src.lastIndexOf('await rollback();');
    expect(pre, '链没取跑前主键快照 ⇒ pk 那一层永远是空').toBeGreaterThan(-1);
    expect(post, '链没取跑后主键快照').toBeGreaterThan(-1);
    expect(firstWrite, '锚位漂了：找不到 S1 首次写入 ⇒ 这条 pin 失去意义，先修尺').toBeGreaterThan(-1);
    expect(swept, '锚位漂了：找不到 settleAndClean').toBeGreaterThan(-1);
    expect(rolled, '锚位漂了：找不到 await rollback();').toBeGreaterThan(-1);
    expect(pre < firstWrite, '跑前快照取在首次写入之后 ⇒ 本次造的行会漏出 pre（B169 同族）').toBe(true);
    expect(post > swept && post > rolled, '跑后快照取在清理之前 ⇒ 残留与"本来就活着"同值').toBe(true);
    expect(src, 'pkResidue 没进判决入参').toMatch(/pkResidue:\s*PK\.created/);
    expect(src, 'pkVanished 没进判决入参').toMatch(/pkVanished:\s*PK\.vanished/);
    expect(src, 'pkSkipped 没进判决入参（分母漂移就读不出来）').toMatch(/pkSkipped:\s*\[/);
  });
});

  it('★ v3.74 B-2：两通道"对不上账"必须单独成一格 —— 键口径一错就会两头都读成 0', () => {
    const base = { ...OKR(), pkEnumerated: 35, pkCompared: 35 };
    // 只有"对不上账"这一维有问题 ⇒ 不许读成 clean（这就是 m34 的受害输入）
    const v = residueVerdict({ ...base, deletedUnreconciled: ['EntityLink'] });
    expect(v.kind, '有台账没自报数（或反之）被读成已核 ⇒ 3 行真·跑前行静默放行').toBe('unproven');
    expect(v.detail).toMatch(/两通道对不上账 1 张（有台账没自报数、或反之、或命名口径不一致）：EntityLink/);
    expect(coverageLine({ ...base, deletedUnreconciled: ['EntityLink'] })).toMatch(/对不上账=1 张/);
    // 不许吃脏：同一程已经看到"删了跑前行"时，两条都要出声
    const w = residueVerdict({ ...base, deletedUnreconciled: ['EntityLink'],
      deletedPreexisting: [{ model: 'Order', id: 'old9' }], deletedPreexistingBrief: ['Order=1[old9]'] });
    expect(w.kind).toBe('unproven');
    expect(w.detail).toMatch(/对不上账 1 张/);
    expect(w.detail, '量具问题把真指控吞掉 ⇒ 又变成"只说核不了"').toMatch(/Order=1\[old9\]/);
    // 反面：账对得上（一格都没有）⇒ 这一条不许无端翻红
    expect(residueVerdict({ ...base, deletedUnreconciled: [] }).kind).toBe('clean');
  });
  it('★ v3.71 B183：判不了的计数单位 —— 3 张整表未读不许冒充 3 行（第十一程就是这么少报两个数量级）', () => {
    const r = deletedRowAttribution({
      runStart: new Date('2026-09-25T00:00:00Z'),
      deleted: { Order: [{ id: 'o1', createdAt: new Date('2020-01-01Z') }], Notification: null, AgentJob: null },
      reportedCounts: { Notification: 400, AgentJob: 12 },
    });
    expect(r.unknown.length, '数组里只有 2 条（两张整表未读）；Order 那行有 createdAt，走的是 preexisting').toBe(2);
    expect(r.unknownWholeTables).toBe(2);
    expect(r.unknownRows, '整表未读的要按删除侧自报的行数计（400 + 12），不是按张数 ⇒ 2 条 = 412 行').toBe(412);
    expect(r.unknownRowsSilent).toBe(0);
    const r2 = deletedRowAttribution({ runStart: new Date(), deleted: { Mystery: null } });
    expect(r2.unknownRows).toBe(0);
    expect(r2.unknownRowsSilent, '连行数都没报上来那张要能被看见，不许当 0 行').toBe(1);
    const line = coverageLine({ ...OKR(), deletedUnknown: r.unknown, deletedUnknownRows: r.unknownRows,
      deletedUnknownWholeTables: r.unknownWholeTables, deletedUnknownRowsSilent: r.unknownRowsSilent });
    expect(line).toMatch(/判不了行数=412 整表未读=2 张/);
    expect(line, '那个会骗人的条目数格子必须已经不在读数里').not.toMatch(/逐行判不了=/);
    expect(coverageLine({ ...OKR(), deletedUnknown: r2.unknown, deletedUnknownRows: 0,
      deletedUnknownWholeTables: 1, deletedUnknownRowsSilent: 1 })).toMatch(/其中 1 张连行数都没报上来/);
  });
  it('★ v3.70 B178：逐主键守恒的分类学 —— 跑前行逐行点名、判不了不许塌成放行、没有起点一票全判不了', () => {
    const S = new Date('2026-09-25T00:00:00.000Z');
    const r = deletedRowAttribution({
      runStart: S,
      deleted: {
        Order: [{ id: 'old1', createdAt: new Date('2026-09-20T00:00:00Z') }, { id: 'new1', createdAt: new Date('2026-09-25T00:30:00Z') }],
        AuditLog: [{ id: 'b1', createdAt: BigInt('1758000000000') }, { id: 'b2', createdAt: 1790500000000 }],
        OrderLine: [{ id: 'l1' }, { id: 'l2' }],
        Relation: [{ id: 'r1' }],
        Notification: null,
      },
      preIds: { OrderLine: new Set(['l1']) },
    });
    expect(r.preexisting.map((x) => `${x.model}:${x.id}`).sort()).toEqual(['AuditLog:b1', 'Order:old1', 'OrderLine:l1']);
    expect(r.nonPre.map((x) => `${x.model}:${x.id}`).sort()).toEqual(['AuditLog:b2', 'Order:new1', 'OrderLine:l2']);
    expect(r.unknown.length, '整张预读失败 + 「无 createdAt 又没有跑前快照」两种落点都要逐行登记').toBe(2);
    expect(r.unknown.map((x) => `${x.model}:${x.id ?? '(整表)'}`).sort()).toEqual(['Notification:(整表)', 'Relation:r1']);
    // Relation 那一行既没被指控也不许被放行（m30 的受害输入：非空桶里凭空多一张"清白"）
    expect(r.nonPre.some((x) => x.model === 'Relation' && x.id === 'r1'), '判不了被写成清白').toBe(false);
    // BigInt 的 createdAt 按**毫秒**解释（与 countCreatedInWindow 的 BigInt(ts) 同一口径）⇒ 方向反了就会漏报
    // 分组点名：每张表各一条，条数与 id 都要在（读者要能拿去库里查）
    expect(r.preexistingBrief.join(' ')).toMatch(/AuditLog=1\[b1\]/);
    // 没有 runStart ⇒ 一行都不许归类（既不清白也不指控）
    const n = deletedRowAttribution({ deleted: { Order: [{ id: 'x', createdAt: new Date() }] } });
    expect(n.preexisting.length).toBe(0); expect(n.nonPre.length).toBe(0); expect(n.unknown.length).toBe(1);
    // 判不了 ⇒ 判决不许是 clean，也不许写成删除面指控
    const v = residueVerdict({ ...OKR(), deletedUnknown: [{ model: 'Notification', n: null }], deletedUnknownBrief: ['Notification=?(预读未接)'] });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/既没被指控也没被放行/);
    expect(v.detail).not.toMatch(/删面宽于本次写入/);
    // 跑前行 ⇒ 逐行点名的指控，且它排在标量守恒之前（不依赖窗口计数）
    const w = residueVerdict({ ...OKR(), deletedPreexisting: [{ model: 'Order', id: 'old1' }], deletedPreexistingBrief: ['Order=1[old1]'], overDeleted: [{ model: 'Order', deleted: 4, attributable: 3 }] });
    expect(w.kind).toBe('residue');
    expect(w.detail).toMatch(/Order=1\[old1\]/);
    expect(w.detail).toMatch(/不依赖窗口计数/);
    // 覆盖行两个数同屏（"删的跑前行=0" 只有配上"判不了=0"才是好消息）
    expect(coverageLine({ ...OKR(), deletedPreexisting: [], deletedUnknown: [{ model: 'N', n: 400 }],
      deletedUnknownRows: 400, deletedUnknownWholeTables: 1 }))
      .toMatch(/删的跑前行=0 判不了行数=400 整表未读=1 张/);
  });

describe('B174 + B176 · 主键层的分母与覆盖对账（v3.66：光有分母不等于对得上账）', () => {
  const P = (over: any = {}) => ({ ...OKR(), pkResidue: [], pkVanished: [], pkSkipped: [], pkDrift: 0, ...over });
  const FULL = { pkEnumerated: 35, pkCompared: 35 };
  it('这一层声明参与却没有枚举分母（0 / 未提供 / NaN / 字符串 / 负数 / Infinity）⇒ unproven 且点名', () => {
    for (const bad of [0, undefined, null, NaN, '35', -1, Infinity]) {
      const v = residueVerdict(P({ ...FULL, pkEnumerated: bad }));
      expect(v.kind, `pkEnumerated=${String(bad)} 被读成了"比对过且干净"`).toBe('unproven');
      expect(v.detail).toMatch(/主键集合那一层没有分母/);
      expect(v.detail).not.toMatch(/演练标识命中 0/);
    }
  });
  it('★ 复核 #16 BLOCKER-1：只有"两个数都 > 0"不算对账 —— 1/35、99999/35、34/35 不点名 都要红', () => {
    const cases: Array<[any, string]> = [
      [{ pkEnumerated: 35, pkCompared: 1 }, '只比了 1 张却报"整族核过"'],
      [{ pkEnumerated: 35, pkCompared: 99999 }, '已比对大到离谱也没人和枚举对撞'],
      [{ pkEnumerated: 35, pkCompared: 34 }, '差 1 张 ⇒ 那 1 张没点名就必须红'],
      [{ pkEnumerated: 35, pkCompared: 0 }, '一张都没比'],
    ];
    for (const [inp, why] of cases) {
      const v = residueVerdict(P(inp));
      expect(v.kind, why).toBe('unproven');
      expect(v.detail, `${JSON.stringify(inp)} 的明细要能自证为什么不行`).toMatch(/没有分母|覆盖对账不平|真比了 0 张/);
    }
  });
  it('★ 差额必须有名有姓：34/35 + 恰好一张点名 ⇒ 对账平了，但"这一张没覆盖"本身仍不许读成已归因', () => {
    const residueInput = P({ pkEnumerated: 35, pkCompared: 34, pkSkipped: [{ model: 'Composite', why: '复合主键' }] });
    const v = residueVerdict(residueInput);
    expect(v.kind, '只有一条未覆盖就放过 ⇒ 这是复核 #16 那枚 x2 突变（`> 1`）的受害输入').toBe('unproven');
    expect(v.detail).toMatch(/主键层未覆盖 1 张/);
    expect(v.detail, '未覆盖那格必须点名到哪张表，否则读者无法做任何事').toMatch(/Composite（复合主键）/);
    expect(coverageLine(residueInput), '账平了这件事本身也要有读数（否则下一批复述"全覆盖"又是反推）')
      .toMatch(/主键层分母=已比对34\/枚举35（点名未覆盖1、枚举漂移0）/);
  });
  it('枚举漂移（两侧 DMMF 不等）⇒ 分母自己在动，这一程不许读成"整族比过了"', () => {
    const v = residueVerdict(P({ pkEnumerated: 35, pkCompared: 35, pkDrift: 1 }));
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/两侧枚举漂移 1 张/);
  });
  it('反面：35/35、零未覆盖、零漂移 ⇒ 这一条不许无端翻红（否则"接了"就等于"必红"）', () => {
    expect(residueVerdict(P(FULL)).kind).toBe('clean');
  });
  it('★ 不许吃脏：没有分母时若已看到主键残留，读数仍要一起出声（v3.59 同族）', () => {
    const v = residueVerdict(P({ pkEnumerated: 0, pkCompared: 0, pkResidue: [{ model: 'BusinessSequence', n: 1, ids: ['SEQ_X'] }] }));
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/没有分母/);
    expect(v.detail, '量具失败把真看到的残留吞掉 ⇒ 只剩一句"核不了"').toMatch(/主键集合残留（本次新增且清理后仍活着）1 处：BusinessSequence=1\[SEQ_X\]/);
  });
  it('★ 复核 #16 IMPORTANT-4：归因层没有分母时提前 return，也不许吞掉**与窗口无关**的主键读数与标识外增长', () => {
    const v = residueVerdict({ ...OKR(), attributionEnumerated: 0, ...FULL,
      pkResidue: [{ model: 'BusinessSequence', n: 3, ids: ['X'] }], unmarkedGrowth: [{ model: 'Note', from: 1, to: 3, delta: 2 }] });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/归因层没有分母/);
    expect(v.detail, '第七程实测：这一格原先只剩"归因层没有分母"，主键那 3 行没了').toMatch(/BusinessSequence=3\[X\]/);
    expect(v.detail).toMatch(/Note\(\+2\)/);
    expect(v.detail, '窗口层派生的指控本来就该扣着（空 counts 造伪指控，v3.53）').not.toMatch(/删面宽于/);
  });
  it('压根没接这一层的脚本（其余 15 份验收脚本的现况）⇒ 不被这条无端翻红', () => {
    expect(residueVerdict(OKR()).kind).toBe('clean');
  });
  it('覆盖行带分母与对账：0 也要出声，未接要明说未接（分母与读数同行）', () => {
    expect(coverageLine(P({ pkEnumerated: 35, pkCompared: 0 }))).toMatch(/主键层分母=已比对0\/枚举35（点名未覆盖0、枚举漂移0）/);
    expect(coverageLine(P({ pkEnumerated: 35, pkCompared: 34, pkSkipped: [{ model: 'C', why: 'w' }] })))
      .toMatch(/主键层分母=已比对34\/枚举35（点名未覆盖1、枚举漂移0）/);
    expect(coverageLine(OKR())).toMatch(/主键层分母=未接/);
  });
  it('★ 复核 #16 x11：覆盖行的计数格只数"真有数"的条目（13 条 count=0 必须打成 0，否则读数自己说谎）', () => {
    const zeros = Array.from({ length: 13 }, (_, i) => ({ model: `M${i}`, count: 0 }));
    expect(coverageLine({ ...OKR(), hits: zeros })).toMatch(/标识命中=0 /);
    expect(coverageLine({ ...OKR(), hits: [...zeros, { model: 'Order', count: 2 }] })).toMatch(/标识命中=1 /);
    expect(coverageLine({ ...OKR(), hits: zeros }).includes('=13')).toBe(false);
  });
  it('★ 覆盖行只加读数、不参与判决：同一条输入两次的判决必须一致', () => {
    const a = P(FULL);
    expect(residueVerdict(a).kind).toBe(residueVerdict({ ...a, disposition: [] }).kind);
  });
  it('★ 链上：这一层的四个数（枚举/已比对/点名未覆盖/漂移）都真的进了判决入参', () => {
    const src = chainCode();
    expect(src, 'pkEnumerated 没接').toMatch(/pkEnumerated:\s*Math\.min\(PK_PRE\.enumerated,\s*PK_POST\.enumerated\)/);
    expect(src, 'pkCompared 没接（pkDiff 的 compared 又变回死值）').toMatch(/pkCompared:\s*PK\.compared/);
    expect(src, 'pkSkipped 没接 ⇒ 未覆盖的表没人点名').toMatch(/pkSkipped:\s*\[\.\.\.unc\]/);
    expect(src, 'pkDrift 没接 ⇒ 两侧枚举漂移读不出来').toMatch(/pkDrift:\s*Math\.abs\(PK_PRE\.enumerated\s*-\s*PK_POST\.enumerated\)/);
    expect(src, '未覆盖清单没按名去重（一侧形状不合、另一侧读不到会数两次）').toMatch(/!unc\.has\(model\)/);
  });
});

/**
 * ★ v3.77（B187）指控轴正对照 —— 要证的命题很窄：**"删了跑前就在的行"这件事真的能响**。
 *
 * 为什么需要这一组（第十四程的 `删的跑前行=0` 有两种成因，日志里形状完全相同）：
 *   (a) 真没多删；(b) 整根时间轴前移（时区 / naive DATETIME / 秒毫秒差一档）⇒ `preexisting` 恒空 ⇒ **永远哑**，
 *   而它哑的时候看起来正好是最干净的样子。窗口层与本层共轴（同一个 runStart、同一条 toMs）⇒ 不构成第二证人。
 * 本组只验**纯判据与判决接线**；"真库里埋一行确实会被点名"那半边由
 *   `scripts/accusation-axis-control.mjs` 的真跑（第十五程）与 ±600s 位移突变作证（形状已钉 ≠ 行为已证）。
 * 每条判据都配**两个方向**的反例：只验"哑"会被"恒点名"糊过去，只验"乱响"会被"恒不点名"糊过去。
 */
describe('axisControlVerdict · v3.77 B187：指控轴的两个方向都要能响', () => {
  const RS = 1_760_000_000_000;   // 固定起点（不取 new Date() ⇒ 读数要可复算）
  const plan = [
    { id: 'C_P120', path: 'createdAt', role: 'past', sec: 120, gotMs: RS - 120_000 },
    { id: 'C_N120', path: 'createdAt', role: 'notpast', sec: 120, gotMs: RS + 120_000 },
    { id: 'C_P86400', path: 'createdAt', role: 'past', sec: 86400, gotMs: RS - 86_400_000 },
    { id: 'C_N86400', path: 'createdAt', role: 'notpast', sec: 86400, gotMs: RS + 86_400_000 },
    { id: 'I_P', path: 'preId', role: 'past', sec: 0, gotMs: RS },
    { id: 'I_N', path: 'preId', role: 'notpast', sec: 0, gotMs: RS },
    // ★ v3.79（复核 #20 MAJOR-4）：这一行**不传 createdAt**，时间由库的 DEFAULT 给 ⇒ 显式写时间看不出的那一族
    //   （应用↔库时钟偏差、naive TIMESTAMP(3) + 会话时区）由它作证。
    // ★ v3.81（B200）：这一臂带**本机时间区间**（我发起事务前 → 我插入前）。库里给的时刻只要落在这个区间内，
    //   就是"时钟一致、只是演练跑了一段"；落出去才是整轴平移。区间宽 = 演练耗时，与偏差是两个量。
    { id: 'C_D', path: 'createdAt', role: 'defaulted', sec: 0, gotMs: RS + 900, anchorMs: RS + 800, anchorNotAfterMs: RS + 1000 },
  ];
  const attr = (pre: string[], non: string[], unk: string[] = []) => ({
    preexisting: pre.map((id) => ({ model: 'AgentJob', id })),
    nonPre: non.map((id) => ({ model: 'AgentJob', id })),
    unknown: unk.map((id) => ({ model: 'AgentJob', id })),
  });
  const GOOD = () => attr(['C_P120', 'C_P86400', 'I_P'], ['C_N120', 'C_N86400', 'I_N', 'C_D']);
  const V = (over: any = {}) => axisControlVerdict({
    offsetsSec: [120, 86400], runStartMs: RS, pairs: plan, attribution: GOOD(), leftover: 0, ...over });

  it('两档 × 两向 × 两条通路都分得开 ⇒ ok；分辨率 = 最小档（这一格是正向对照，防"恒拒绝"）', () => {
    const v = V();
    expect(v.ok, v.reasons.join('；')).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.resolutionSec).toBe(120);
    expect([v.preexistingMine, v.nonPreMine, v.unknownMine]).toEqual([3, 4, 0]);
  });

  it('★ 轴前移的形状（跑前行没被点名）⇒ 报"指控哑了"，且只牵连 120s 那一档（档位是分开判的）', () => {
    const v = V({ attribution: attr(['C_P86400', 'I_P'], ['C_P120', 'C_N120', 'C_N86400', 'I_N', 'C_D']) });
    expect(v.ok).toBe(false);
    expect(v.reasons.length, v.reasons.join('；')).toBe(1);
    expect(v.reasons[0]).toMatch(/指控哑了/);
    expect(v.reasons[0]).toMatch(/早 120s/);
  });

  it('★ 轴后移的形状（跑后行被点成跑前行）⇒ 报"指控乱响"，措辞与"哑"不是同一条', () => {
    const v = V({ attribution: attr(['C_P120', 'C_P86400', 'C_N120', 'I_P'], ['C_N86400', 'I_N', 'C_D']) });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r: string) => /指控乱响/.test(r) && /晚 120s/.test(r))).toBe(true);
    expect(v.reasons.some((r: string) => /指控哑了/.test(r))).toBe(false);
  });

  it('只给一档 ⇒ 不 ok，且这一条在其它格全对时**单独**成立（一档证不了分辨力）', () => {
    const v = axisControlVerdict({ offsetsSec: [120], runStartMs: RS, pairs: plan.filter((p) => p.sec !== 86400),
      attribution: attr(['C_P120', 'I_P'], ['C_N120', 'I_N', 'C_D']), leftover: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons.filter((r: string) => /档位只剩 1 档/.test(r)).length).toBe(1);
  });

  it('preId 通路少一个方向 ⇒ "埋删计划缺落点"（不许读成"这一向本来不用验"）', () => {
    const v = V({ pairs: plan.filter((p) => p.id !== 'I_N'), attribution: attr(['C_P120', 'C_P86400', 'I_P'], ['C_N120', 'C_N86400', 'C_D']) });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r: string) => /埋删计划缺 1 个落点.*preId\|0\|notpast/.test(r))).toBe(true);
  });

  it('★ 写入/读回这一路 与 判据点名 是两种失效方式 ⇒ 前者坏了不许报成后者（分类这边是对的）', () => {
    const v = V({ pairs: plan.map((p) => (p.id === 'C_P120' ? { ...p, gotMs: RS + 1000 } : p)) });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r: string) => /坏的是写入\/读回这一路/.test(r))).toBe(true);
    expect(v.reasons.some((r: string) => /指控哑了/.test(r))).toBe(false);
    expect(v.reasons.length, v.reasons.join('；')).toBe(1);
  });

  it('落进"判不了"是第三种措辞（既没被指控也没被放行），不许塌成前两种', () => {
    const v = V({ attribution: attr(['C_P86400', 'I_P'], ['C_N120', 'C_N86400', 'I_N', 'C_D'], ['C_P120']) });
    expect(v.ok).toBe(false);
    expect(v.reasons.length, v.reasons.join('；')).toBe(1);
    expect(v.reasons[0]).toMatch(/落进"判不了"/);
    expect(v.unknownMine).toBe(1);
  });

  it('残留与"没回读"都不许为真：正对照自己不能成为残留源', () => {
    const a = V({ leftover: 1 });
    expect(a.ok).toBe(false);
    expect(a.reasons[0]).toMatch(/还剩 1 行/);
    const b = V({ leftover: null });
    expect(b.ok).toBe(false);
    expect(b.reasons[0]).toMatch(/未回读（等于不知道）/);
  });

  it('attribution 缺失＝分类根本没跑过，不许读成"没响"', () => {
    const v = V({ attribution: null });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r: string) => /没有 attribution/.test(r))).toBe(true);
  });

  it('★ v3.79（复核 #20 MAJOR-4）库侧 DEFAULT 那一臂：偏差超一档必须报，容差以内不许报', () => {
    const shift = (ms: number) => V({ pairs: plan.map((p) => (p.id === 'C_D' ? { ...p, gotMs: RS + ms } : p)) });
    const off = shift(8 * 3600 * 1000);   // 最真实的形状：会话时区差 8 小时
    expect(off.ok).toBe(false);
    expect(off.reasons.some((r: string) => /区间"之外 28799\.0s/.test(r)), off.reasons.join('；')).toBe(true);
    // 反向：差 60s（在最小档以内）不许报 —— 否则这条是"永远红"的尺，而容差是我自己声明的
    expect(V({ pairs: plan.map((p) => (p.id === 'C_D' ? { ...p, gotMs: RS + 60_000 } : p)) }).ok).toBe(true);
    // 缺这一臂 ⇒ 不许读成"三个方向都验过"
    const noArm = V({ pairs: plan.filter((p) => p.id !== 'C_D'), attribution: attr(['C_P120', 'C_P86400', 'I_P'], ['C_N120', 'C_N86400', 'I_N']) });
    expect(noArm.reasons.some((r: string) => /埋删计划缺 1 个落点.*createdAt\|0\|defaulted/.test(r))).toBe(true);
  });

  it('★ v3.81（B200）"演练跑了多久"与"库和应用差多少"是两个量 ⇒ 前者再大也不许把这一臂判成整轴平移', () => {
    /**
     * 第十六程真跑量到 `defaultedDevMs = 55882ms`，而 v3.79~v3.80 那版判据把它读成"库给的时刻与本机起点差 55.9s"
     * 并拿 ±最小档（120s）比 ⇒ 复核 #22 实测悬崖：Δ=119000 通过 / Δ=121000 判 false。
     * 真实成因是**链跑到那一臂用了 55.9 秒**，与库的时钟无关 ⇒ 判定改走该臂自己的本机区间，ΔrunStart 只报不判。
     */
    const slow = V({ pairs: plan.map((p) => (p.id === 'C_D'
      ? { ...p, gotMs: RS + 500_000, anchorMs: RS + 499_000, anchorNotAfterMs: RS + 500_000 } : p)) });
    expect(slow.ok, `耗时 500s（远超最小档 120s）但库给的时刻落在本机区间内 ⇒ 不许报平移：${slow.reasons.join('；')}`).toBe(true);
    expect(slow.reasons.join('；')).not.toMatch(/区间"之外/);
    // 时钟真的慢 8 小时（区间内没有这个形状）⇒ 必须响，且响的是"区间之外"那一条
    const behind = V({ pairs: plan.map((p) => (p.id === 'C_D'
      ? { ...p, gotMs: RS + 800 - 28_800_000, anchorMs: RS + 800, anchorNotAfterMs: RS + 1000 } : p)) });
    expect(behind.ok).toBe(false);
    const br = behind.reasons.find((r: string) => /区间"之外/.test(r)) || '';
    expect(br, behind.reasons.join('；')).toMatch(/28800\.0s/);
    // ΔrunStart 仍然**报**出来（它决定正向哑区有多大），只是不参与判定
    expect(br).toMatch(/ΔrunStart=-28799\.2s（这个差混着\*\*演练跑到那一臂的耗时\*\*，不参与判定）/);
    // 缺锚点这一支不许悄悄退回"拿 runStart 当时钟锚"（那正是 B200 本来的样子）
    const noAnchor = V({ pairs: plan.map((p) => (p.id === 'C_D'
      ? { id: p.id, path: p.path, role: p.role, sec: p.sec, gotMs: p.gotMs } : p)) });
    expect(noAnchor.ok).toBe(false);
    expect(noAnchor.reasons.some((r: string) => /不作时钟一致性的证据/.test(r)), noAnchor.reasons.join('；')).toBe(true);
    // 上面这些突变都不许波及"诚实那份"：同一组 plan 带锚点必须仍然全绿（否则这是永远红的尺）
    expect(V().ok, V().reasons.join('；')).toBe(true);
  });

  it('★ v3.79（复核 #20 MINOR-7）分辨率的边界是量出来的，而且**不对称**（比较是严格小于）', () => {
    // ★ 这里刻意**不手写桶**：分类交给仓内那份 `deletedRowAttribution`（与真链同一个尺），
    //   我只负责"埋在哪、期望落在哪"。第一版我自己填桶 ⇒ 缺落点也能让断言"红/绿"，
    //   看着像测到了边界，其实测的是我的 fixture（＝空对照，v3.79 当场被这条自己的红抓出来）。
    const rows = [
      { id: 'P120', path: 'createdAt', role: 'past', sec: 120, at: RS - 120_000 },
      { id: 'N120', path: 'createdAt', role: 'notpast', sec: 120, at: RS + 120_000 },
      { id: 'P86400', path: 'createdAt', role: 'past', sec: 86400, at: RS - 86_400_000 },
      { id: 'N86400', path: 'createdAt', role: 'notpast', sec: 86400, at: RS + 86_400_000 },
      { id: 'I_P', path: 'preId', role: 'past', sec: 0, at: RS },
      { id: 'I_N', path: 'preId', role: 'notpast', sec: 0, at: RS },
      // 库侧 DEFAULT 那一行钉在"本机此刻"⇒ 它与起点的差恰好等于我注入的位移，不额外污染这一格
      // ★ v3.81（B200）：锚点给的是**零宽区间**（与 lib 里 `axisResolutionGrid` 同一形状）⇒ 位移全部记到时钟那一侧
      { id: 'C_D', path: 'createdAt', role: 'defaulted', sec: 0, at: RS, anchor: RS },
    ];
    const classify = (skewSec: number) => {
      const ts = new Date(RS + skewSec * 1000);
      const attr2 = deletedRowAttribution({
        deleted: { AgentJob: rows.map((r) => ({ id: r.id, createdAt: r.path === 'createdAt' ? new Date(r.at) : undefined })) },
        preIds: { AgentJob: new Set(['I_P']) }, runStart: ts, reportedCounts: { AgentJob: rows.length },
      });
      return axisControlVerdict({ offsetsSec: [120, 86400], runStartMs: ts.getTime(),
        pairs: rows.map((r) => ({ id: r.id, path: r.path, role: r.role, sec: r.sec, gotMs: r.at,
          anchorMs: (r as any).anchor, anchorNotAfterMs: (r as any).anchor })),
        attribution: attr2, leftover: 0 });
    };
    // 机制（数字一律看下面那条打印出来的网格，不在注释里复述）：
    //  · 起点"变早"这一侧：显式埋的 ±120s 行要靠"跑前行不再早于起点"才露馅 ⇒ 边界在整档处；
    //  · 起点"变晚"这一侧：`defaulted` 那行的锚点是"本机此刻"，起点一旦晚于它就立刻被误指控 ⇒ 边界紧贴 0。
    //  ⇒ 台账里那句分辨率**只能引用网格**（两侧各自报；v3.81 起不再合并成"对外按保守侧 ±最小档说"那一句，
    //    它把已经量到的不对称又抹平了 —— 复核 #22 MINOR-4/MJ-4）。
    expect(classify(-119).ok, '−119s：声明的分辨率以内 ⇒ 抓不住是预期（不许偷偷自称更准）').toBe(true);
    expect(classify(-120).ok, '−120s：跑前那一行刚好不再早于起点 ⇒ 指控哑，必须被抓').toBe(false);
    expect(classify(-120).reasons.some((r: string) => /指控哑了/.test(r))).toBe(true);
    expect(classify(119).ok).toBe(false);
    expect(classify(119).reasons.some((r: string) => /库侧 DEFAULT|指控乱响/.test(r)),
      '向"变晚"这一侧是靠 DEFAULT 那一行抓住的 ⇒ 这一格必须点名它').toBe(true);
    expect(classify(121).reasons.some((r: string) => /指控乱响/.test(r))).toBe(true);
    expect(classify(0).ok, '零位移当然必须全绿（否则这条是永远红的尺）').toBe(true);
    /**
     * ★ 整张网格是**扫**出来的，不是上面这几点拼出来的：v3.78 我把"≤120s 检不出"当结论写进台账，
     *   却只量过 −60/+120 两个点 ⇒ 那句话的适用范围是我自己缩的（复核 #20 MINOR-7）。
     *   这里逐点跑，打印每一档的 ok 与"抓它的理由属于哪一族"，台账只许引用这张打印出来的表。
     */
    const grid = [-600, -121, -120, -119, -60, -1, 0, 1, 60, 119, 120, 121, 600].map((s) => {
      const v = classify(s);
      const tag = v.ok ? '通过' : (v.reasons.some((r: string) => /指控哑了/.test(r)) ? '抓(哑)'
        : v.reasons.some((r: string) => /指控乱响/.test(r)) ? '抓(乱响)' : '抓(其它)');
      return `${s}s=${tag}`;
    });
    console.log(`[分辨率网格·机取] ${grid.join(' · ')}`);
    const passing = [-600, -121, -120, -119, -60, -1, 0, 1, 60, 119, 120, 121, 600].filter((s) => classify(s).ok);
    expect(passing, '放行的只有"变早且不超过一档、且没跨过严格小于那一格"这一段 ⇒ 边界必须与打印一致').toEqual([-119, -60, -1, 0]);
  });

  it('★ v3.80（复核 #21 MA-1 改口）网格与逐点手推只是**同一模型的两套驱动**（抓扫掠循环/算符/档位间距，抓不到分类器本身错）', () => {
    /**
     * 为什么允许"两份实现"：上一批我把分辨率写死成散文，结果单侧结论被当双侧贴进了三处载体。
     * 现在 lib 里有一份会扫的（`axisResolutionGrid`），测试里保留一份**逐点手推**的（上一条 `classify`），
     * 两者同形才说明"扫"这件事本身没被写成第二个真源 ⇒ 一条对不上就是红。
     */
    const g = axisResolutionGrid({ offsetsSec: [120, 86400] });
    expect(g.ok, JSON.stringify(g)).toBe(true);
    expect(g.minTierSec).toBe(120);
    expect([g.caughtAtOrAfterNegSec, g.silentNegSec], '变早一侧：边界必须等于手推圈量到的 −120 才响 / −119 仍哑')
      .toEqual([120, 119]);
    expect(g.caughtAtOrAfterPosSec, '变晚一侧靠 defaulted 那行：+1s 就该响').toBe(1);
    expect(g.zeroOk, '零位移必须放行（否则网格是恒红的尺）').toBe(true);
    expect(g.probes, '扫过的次数＝每侧 2×最小档 ×2 侧 + 零点').toBe(481);
    // 档位不足两档 ⇒ 不许外推出一个"看起来像边界"的东西
    const one = axisResolutionGrid({ offsetsSec: [120] });
    expect(one.ok).toBe(false);
    expect(String(one.reason)).toMatch(/档位只有 1 个/);
    // 扫不到边界那一支：必须说"扫程内没越界"，不许谎称"更大也不会响"
    const capped = axisResolutionGrid({ offsetsSec: [120, 86400], maxSteps: 10 });
    expect([capped.caughtAtOrAfterNegSec, capped.caughtAtOrAfterPosSec, capped.silentNegSec], '10 步以内两侧都不该越界')
      .toEqual([null, 1, null]);
    expect(axisResolutionCaveat(capped)).toMatch(/扫到 10s 仍未越界/);
  });

  it('★ v3.80（复核 #21 MINOR-7）措辞只有一份数值来源：网格缺失时**只许承认未量**，不许回退成旧的断言', () => {
    const g = axisResolutionGrid({ offsetsSec: [120, 86400] });
    const txt = axisResolutionCaveat(g, { defaultedDevMs: 37, defaultedElapsedMs: 20, defaultedClockDevMs: 0,
      defaultedLeadMs: 30, defaultedInTxMs: 7 });
    // 这一句是本批改口的核心：**不许再把"我埋的间距"叫"实测分辨率"**（复核实测：换档位边界就跟着换）
    expect(txt).toMatch(/自变量是\*\*我自己选的档位与埋点形状\*\*/);
    expect(txt).toMatch(/变早一侧 到 −120s 才响 ⇒ −119s 以内哑/);
    expect(txt).toMatch(/这一侧的边界\*\*恒等于最小档 120s\*\*/);
    // ★ v3.81（B200）：那一句旧措辞「本程实测那一行的时刻差 = 37ms ⇒ 真实正侧是**零容差**」把耗时当时钟偏差，
    //   已在 v3.81 就地收回 ⇒ 现在必须把"落点间距 = 耗时 + 偏差"拆开写。
    expect(txt).toMatch(/落点晚于本机起点 37ms = 起跑耗时 30ms \+ 事务内偏移 7ms/);
    expect(txt).toMatch(/区间宽 20ms、到区间外侧的距离（＝应用与库的时钟\/时区偏差） 0ms/);
    /**
     * ★★ B204 的正证：**把打印出来的那个等式解析回来重算**。
     *   第十七程真跑打印过 "54634ms = 演练耗时 0ms + 时钟/时区偏差 1ms"——三个数都"报得出来"，
     *   而它们之间不是拆解关系。字段级对撞（每个自述 == f(证据)）拦不住这种坏法，
     *   因为"拆开=…"这句是**措辞**拼出来的，不是判据算出来的 ⇒ 这里直接读屏幕文本再相加。
     */
    const eq = txt.match(/落点晚于本机起点 (\d+)ms = 起跑耗时 (\d+)ms \+ 事务内偏移 (-?\d+)ms/);
    expect(eq, '打印句子里的等式形状变了 ⇒ 这条对账就瞎了，必须先把形状钉住').not.toBeNull();
    expect(Number(eq[1]), `打印出来的等式加起来不等：${eq[1]} ≠ ${eq[2]} + ${eq[3]}`).toBe(Number(eq[2]) + Number(eq[3]));
    expect(txt).toMatch(/B204/);
    // ★ 打印这一句的那份实现自己也**不许拼出不成立的等式**：数不自洽时要改成明说"对不上"，
    //   而不是照原格式印出 54634 = 0 + 1（那正是第十七程真跑印出来过的东西）。
    const bad3 = axisResolutionCaveat(g, { defaultedDevMs: 54634, defaultedLeadMs: 0, defaultedInTxMs: 1,
      defaultedElapsedMs: 0, defaultedClockDevMs: 1 });
    expect(bad3).toMatch(/拆解不成立：自报 起跑 0ms \+ 事务内 1ms ≠ 落点间距 54634ms/);
    expect(bad3.includes('落点晚于本机起点 54634ms = '), '不自洽时那一行连等号都不许出现（等号本身就是"这是拆解"的承诺）').toBe(false);
    expect(bad3).toMatch(/落点晚于本机起点 54634ms ⇒ /);
    expect(txt).toMatch(/这一臂检不出的整轴慢移就是 37ms/);
    expect(txt).toMatch(/时钟\/会话时区偏移本程量到 0ms/);
    expect(txt.includes('真实正侧是**零容差**'), '旧那句"零容差"已作废，不许再被打印出来').toBe(false);
    // 只给 Δ、没给区间锚点 ⇒ 偏差那一维必须承认没量到，不许拿 Δ 冒充偏差
    const half = axisResolutionCaveat(g, { defaultedDevMs: 37, defaultedElapsedMs: 20 });
    expect(half).toMatch(/时钟\/时区偏差） 未量/);
    expect(half).toMatch(/起跑耗时 未量 \+ 事务内偏移 未量/);
    expect(half).toMatch(/不许据它说偏移有多大或多小/);
    // ★ 复核 #24：原来这条钉的是 '45ms'，而 45 早已不是任何输入 ⇒ 恒真。改成"缺哪一维就不许冒出那一维的数"，
    //   并且**逐维**验（缺时钟偏差、缺区间宽各一格）。
    expect(/时钟\/时区偏差） -?\d+ms/.test(half), '没喂时钟偏差 ⇒ 那一维不许出现任何 ms 数').toBe(false);
    const noWidth = axisResolutionCaveat(g, { defaultedDevMs: 37, defaultedLeadMs: 30, defaultedInTxMs: 7,
      defaultedClockDevMs: 0 });
    expect(noWidth).toMatch(/区间宽 未量/);
    expect(/其中区间宽 -?\d+ms/.test(noWidth), '没喂区间宽 ⇒ 那一维不许出现任何 ms 数').toBe(false);
    // 没量到 Δ 时不许把任何一侧写成实测过
    const noDev = axisResolutionCaveat(g);
    expect(noDev).toMatch(/真实正侧哑区\*\*未量\*\*/);
    expect(noDev.includes('37ms'), '没有 Δ 输入就不许冒出任何 ms 数').toBe(false);
    for (const missing of [null, undefined, {}, { ok: false, reason: '档位只有 1 个' }]) {
      const s = axisResolutionCaveat(missing as never);
      expect(s, JSON.stringify(missing)).toMatch(/分辨率边界未量/);
      // 钉的是"带数字的旧断言"那一族形状（旧句一定是 `±120s 以内检不出` 这种数 + 结论），
      // 而不是"这句话里出现过检不出三个字"——后者会把我自己那句禁令也判成回归。
      expect(s).not.toMatch(/\d+s ?\**以内检不出/);
      expect(s, '未量那一支不许给出任何位移数字').not.toMatch(/\d+(ms|s)\b/);
    }
  });

  it('★ v3.82（复核 #23 M2）这一臂的"实际可检下界"要算成一个数说出来，不许留在"±最小档"那个乐观口径上', () => {
    const g = axisResolutionGrid({ offsetsSec: [120, 86400] });
    const slow = axisResolutionCaveat(g, { defaultedDevMs: 900_000, defaultedElapsedMs: 800_000, defaultedClockDevMs: 0 });
    // 两侧分开报（复核 #24 MINOR：把不对称的东西印成一个 ± 数，等于又造一次"保守侧 ±"那种合并口径）
    expect(slow).toMatch(/实际可检下界两侧不对称\*\*：库比本机\*\*慢\*\*那一侧仍是 ±120s/);
    expect(slow).toMatch(/库比本机\*\*快\*\*那一侧是 ±\(120000 \+ 区间宽 800000\)ms = 920000ms/);
    expect(slow).toMatch(/区间宽已超过容差/);
    expect(slow).toMatch(/不许把 ±120s 当本程分辨率读/);
    const tight = axisResolutionCaveat(g, { defaultedDevMs: 5_000, defaultedElapsedMs: 3_000,
      defaultedClockDevMs: 0, defaultedLeadMs: 4_000, defaultedInTxMs: 1_000 });
    expect(tight).toMatch(/快\*\*那一侧是 ±\(120000 \+ 区间宽 3000\)ms = 123000ms/);
    expect(tight).toMatch(/仍由 ±120s 主导/);
    expect(tight).not.toMatch(/区间宽已超过容差/);
    // 反向：没量到耗时这一维时不许冒出任何"下界"数字（这条是本仓老规矩：缺失只许说未量）
    const none = axisResolutionCaveat(g);
    expect(none.includes('实际可检下界'), '没输入就不许报下界').toBe(false);
  });

  it('★ v3.82（复核 #23 M1）驱动侧必须自己从本机钟取锚点 ⇒ 锚点不许取自库的回读', async () => {
    /**
     * v3.81 那批我把 B200 的判据（`axisControlVerdict` 走区间）配了证人，但**锚点是怎么来的**一格没验：
     *   复核 #23 实测三枚突变都 0 新增红格 —— ① 不采上界、② 不采下界、
     *   ③ `anchorMs` 直接取库回读的那个时刻（⇒ `defaultedClockDevMs` 恒为 0，正是"对撞对象换成自己"）。
     * 这份假 client 演的是**驱动↔判决之间那层契约**：库的 `CURRENT_TIMESTAMP` = 事务开始时刻（Postgres 语义），
     * 每次插入耗一点时间 ⇒ 区间宽就代表"演练跑到那一臂的耗时"，与库钟偏差无关。
     */
    const mk = (dbSkewMs: number) => {
      const store = new Map<string, Date>();
      let txBegin = 0;
      const insert = async (args: any) => {
        await new Promise((r) => setTimeout(r, 12));
        const data = args.data;
        store.set(data.id, data.createdAt === undefined ? new Date(txBegin + dbSkewMs) : new Date(data.createdAt));
        return data;
      };
      const findMany = async ({ where }: any) => where.id.in
        .filter((i: string) => store.has(i))
        .map((i: string) => ({ id: i, createdAt: store.get(i) }));
      const d = { create: insert, findMany };
      return {
        // 真 Prisma 是"回调抛出即回滚"⇒ 这里只 await，不自已抛（自抛会被驱动当成 txError，把两件事混成一格）
        $transaction: async (fn: any) => { txBegin = Date.now(); await fn({ agentJob: d }); },
        agentJob: { create: insert, findMany, count: async () => 0 },
      };
    };
    const NOW = new Date();
    const honest = await runAccusationAxisControl({ prisma: mk(0) as any,
      db: { host: 'localhost', name: 'panda_hub_local' }, runStart: NOW });
    expect(honest.ok, honest.reasons.join('；')).toBe(true);
    const dp = (honest.evidence.pairs as any[]).find((p) => p.role === 'defaulted');
    // ★ B204 的实质：把起点挪到 60 秒之前 ⇒ 那 60 秒**必须**归到"起跑耗时"，而不是归到区间宽或时钟偏差
    const slowStart = await runAccusationAxisControl({ prisma: mk(0) as any,
      db: { host: 'localhost', name: 'panda_hub_local' }, runStart: new Date(NOW.getTime() - 60_000) });
    expect(slowStart.ok, slowStart.reasons.join('；')).toBe(true);
    expect(slowStart.defaultedLeadMs, '起跑耗时必须是那 60 秒那一族（旧写法把它错叫成"区间宽"，于是加起来不等于落点间距）')
      .toBeGreaterThanOrEqual(59_000);
    expect(slowStart.defaultedElapsedMs, '区间宽仍然只由事务内那几次插入决定 ⇒ 与起点无关').toBeLessThan(5_000);
    expect(slowStart.defaultedDevMs).toBe(slowStart.defaultedLeadMs + slowStart.defaultedInTxMs);
    expect(Number.isFinite(dp.anchorMs) && Number.isFinite(dp.anchorNotAfterMs), '两个锚点都必须由驱动采到').toBe(true);
    expect(dp.anchorMs <= dp.anchorNotAfterMs, '区间必须是下界≤上界').toBe(true);
    expect(typeof honest.defaultedElapsedMs, '区间宽这一维必须是量出来的数').toBe('number');
    // ★ 这一格里"必须是数"要**单独断**：只写 `dev === lead + inTx` 挡不住"驱动不交 inTx"——
    //   那一刻 `0 + null` 在 JS 里就是 0，等式照样成立（电池 m77 实测惰性，就是这么漏的）。
    expect(Number.isFinite(honest.defaultedLeadMs), '起跑耗时必须是数（恒等式的一半）').toBe(true);
    expect(Number.isFinite(honest.defaultedInTxMs), '事务内偏移必须是数（恒等式的另一半）').toBe(true);
    expect(honest.defaultedDevMs, '驱动交出来的三个量必须满足恒等式（B204 的根因就是它不等）')
      .toBe(honest.defaultedLeadMs + honest.defaultedInTxMs);
    expect(honest.defaultedLeadMs >= 0, '起跑耗时不许是负的（负数说明锚点顺序反了）').toBe(true);
    expect(honest.defaultedClockDevMs, '库钟一致 ⇒ 偏差记 0（不是"未接"）').toBe(0);
    // ★ 顺序这一维（M2 的实质修法）：defaulted 必须排在最前，否则区间宽＝前面 6 次插入的耗时
    expect((honest.evidence.pairs as any[])[0].role, '复核 #23 M2：这一臂排回最后就会让盲区随演练长度膨胀').toBe('defaulted');
    // ★ 锚点取回本机钟、没取库的回读：库钟慢 8 小时时两者差 ~8h
    const skew = await runAccusationAxisControl({ prisma: mk(-28_800_000) as any,
      db: { host: 'localhost', name: 'panda_hub_local' }, runStart: NOW });
    const sd = (skew.evidence.pairs as any[]).find((p) => p.role === 'defaulted');
    expect(Math.abs(sd.anchorMs - sd.gotMs), '锚点若取自库的回读，这个差就恒为 0 ⇒ 本格就是那一刀的证人')
      .toBeGreaterThan(3_600_000);
    expect(sd.gotMs).toBeLessThan(sd.anchorMs);
    expect(skew.ok, '库钟慢 8 小时 ⇒ 必须响').toBe(false);
    expect(skew.reasons.some((r: string) => /区间"之外 28\d{3}\.\ds/.test(r)), skew.reasons.join('；')).toBe(true);
    // （为什么钉"28xxx.x 秒"这个数量级而不是一个精确小数：那一位取决于本机取时间戳与 `BEGIN` 之间的
    //   几毫秒，钉到 0.1s 就是一枚会随负载自己红的判据 ⇒ 精确值交给 `defaultedClockDevMs` 那条数值断言。）
    expect(skew.defaultedClockDevMs, '报出来的偏差应是"库比本机慢 8 小时"这一族，而不是 0').toBeLessThan(-28_700_000);
    expect(skew.defaultedDevMs, '库钟偏 8 小时时，恒等式仍然要闭合（偏掉的量归到"事务内偏移"那一半）')
      .toBe(skew.defaultedLeadMs + skew.defaultedInTxMs);
    expect(skew.defaultedInTxMs, '库钟慢 8 小时 ⇒ 事务内偏移就是那个负的大数，不许被算丢').toBeLessThan(-28_700_000);
  });

  it('★ v3.85（复核 #24 M-1）拆解句三处共用一份 ⇒ 覆盖行也不许印出加起来不等的等式', () => {
    /**
     * v3.83 我把"加起来不等就不印"那道守卫只写进了判决明细那一份措辞里，而覆盖行与 CLI 各拼各的
     * ⇒ 提交标题里点名的"覆盖行"恰恰是没守卫的那一处（复核喂一个不自洽的 axisControl 就让它印出
     *   `拆开=起跑耗时 0ms + 事务内偏移 1ms`，而判决同时判 unproven —— 屏幕上两句话互相打脸）。
     */
    const bad = { ...AX_OK, defaultedDevMs: 54634, defaultedLeadMs: 0, defaultedInTxMs: 1,
      defaultedElapsedMs: 0, defaultedClockDevMs: 1 };
    const line = coverageLine(LAYER({ axisControl: bad }));
    const seg = (l: string) => (l.match(/网格边界=[^·]*/) || [''])[0];
    expect(seg(line)).toMatch(/★ 拆解不成立：自报 起跑 0ms \+ 事务内 1ms ≠ 落点间距 54634ms/);
    expect(line.includes('拆开=起跑耗时 0ms + 事务内偏移 1ms'), '不许再印那句不成立的等式').toBe(false);
    // 反面对照：自洽那份必须照旧印等式（否则这条守卫是永远哑的替换，不是修）
    const good = coverageLine(LAYER({ axisControl: AX_OK }));
    expect(seg(good)).toMatch(/拆开=起跑耗时 30ms \+ 事务内偏移 7ms/);
    expect(good.includes('拆解不成立'), '自洽那份不许被守卫冤枉').toBe(false);
    // 缺一半时不许把 null 当 0（`0 + null === 0` 这种 JS 语义正是 B204 漏过去的第二条缝）
    const half = coverageLine(LAYER({ axisControl: { ...AX_OK, defaultedInTxMs: null } }));
    expect(seg(half)).toMatch('起跑耗时 30ms \+ 事务内偏移 未量（缺任一半 ⇒ 这条拆解不作数）');
  });

  it('★ v3.81（复核 #22 MINOR-6）退化档位的网格读数不许打成"≤−0s哑"或"≤−未接s哑"', () => {
    /**
     * 旧措辞对**三种**不同的事实只有一种写法：`变早侧≤−${silentNegSec}s哑`。
     *   · 最小档=1s ⇒ 负侧根本没有哑区（`silentNegSec=0`），旧措辞打成"≤−0s哑"，像尺坏了；
     *   · 扫程封顶还没越界 ⇒ `silentNegSec=null`，经 `num()` 打成"≤−未接s哑"，把"没扫到边界"说成"尺没接"；
     *   · 正常形状 ⇒ 仍是"≤−119s哑"（这一支不许被改动碰坏，所以同格里一起验）。
     */
    const deg = axisResolutionGrid({ offsetsSec: [1, 2] });
    expect([deg.caughtAtOrAfterNegSec, deg.silentNegSec], '最小档 1s ⇒ 负侧无哑区（这就是退化形状）').toEqual([1, 0]);
    const l0 = coverageLine(LAYER({ axisControl: { ...AX_OK, grid: deg } }));
    expect(l0).toMatch(/变早侧 0s 以内哑（＝1s 就响，这一侧没有哑区）/);
    expect(l0.includes('≤−0s哑'), '退化那一支不许再冒出"≤−0s哑"这种读起来像坏了的字样').toBe(false);
    const capped = axisResolutionGrid({ offsetsSec: [120, 86400], maxSteps: 10 });
    const lc = coverageLine(LAYER({ axisControl: { ...AX_OK, grid: capped } }));
    // 只对"网格边界="那一段发号施令：整行别处本来就有自己的空格子，拿整行做 not.toMatch 会打到无关格
    const seg = (l: string) => (l.match(/网格边界=[^·]*/) || [''])[0];
    expect(seg(lc)).toMatch(/变早侧扫到 10s 仍未越界/);
    expect(seg(lc).includes('未接'), '扫不到边界≠尺没接上 ⇒ 这一支不许出现"未接"').toBe(false);
    expect(seg(l0).includes('未接'), '退化那一支同理').toBe(false);
    const normal = coverageLine(LAYER({ axisControl: AX_OK }));
    expect(normal, '正常那一支的措辞必须一字不动地保留（否则这条改动是在偷偷改既有读数）').toMatch(/变早侧≤−119s哑/);
  });


  it('★ v3.81（复核 #22 MJ-3）驱动侧的异常要带库给的结构化码 ⇒ "哪一种坏"不许被 message 洗成同形', async () => {
    /**
     * B199 那次我在台账里写"归因＝连接层瞬断"，依据是**我自己去翻了 pg 日志**。
     * 而 Prisma 把 `P1001`（连不上）这类码就放在异常对象上 ⇒ 归因这件事从此由读数给，不由我猜。
     */
    const withCode = { $transaction: async () => {
      const e: any = new Error("Can't reach database server at `localhost:5432`"); e.code = 'P1001'; throw e;
    }, agentJob: { create: async () => ({}), count: async () => 0 } };
    const v = await runAccusationAxisControl({ prisma: withCode as any,
      db: { host: 'localhost', name: 'panda_hub_local' }, runStart: new Date() });
    expect(v.ok).toBe(false);
    const j = v.reasons.join('；');
    expect(j, '错误码必须出现在归因句里').toMatch(/事务抛错.*\[P1001\]/s);
    // 反面对照：普通异常不许凭空造出一截码（否则这条"归因"是我编的）
    const plain = { $transaction: async () => { throw new Error('boom-无码'); }, agentJob: { create: async () => ({}), count: async () => 0 } };
    const v2 = await runAccusationAxisControl({ prisma: plain as any,
      db: { host: 'localhost', name: 'panda_hub_local' }, runStart: new Date() });
    const j2 = v2.reasons.join('；');
    expect(j2).toMatch(/boom-无码/);
    expect(j2.includes('['), '没给码就不许冒出"[]"那一截').toBe(false);
  });

  it('★ v3.79（复核 #20 MINOR-9）判决不许只信 `ok` 这个自述字段 ⇒ 内容要重算', () => {
    const lying = { ...AX_OK, leftover: 5, reasons: ['其实有一条坏'], ok: true, ran: true };
    const v = residueVerdict(LAYER({ axisControl: lying }));
    expect(v.kind, '自述 ok:true 但残留 5 行 ⇒ 不许读成齐').not.toBe('clean');
    expect(v.detail).toMatch(/重算不过/);
    expect(v.detail).toMatch(/持久残留=5/);
    // 三种"各坏一维"的假齐：都必须被重算抓住
    for (const over of [{ preexistingMine: 0 }, { nonPreMine: 0 }, { offsetsSec: [120] }, { resolutionSec: 0 }]) {
      const v2 = residueVerdict(LAYER({ axisControl: { ...AX_OK, ...over } }));
      expect(v2.kind, JSON.stringify(over)).toBe('unproven');
    }
    // 反向：内容齐的那份必须仍然通得过（否则这条重算是永远红的尺）
    expect(residueVerdict(LAYER({ axisControl: AX_OK })).kind).toBe('clean');
  });

  it('★ v3.79（复核 #20 MINOR-8/11）声明这一层的键要更宽，且早退分支不许吞掉轴那一句', () => {
    // 只报 deletedUnknownRows（不给 deletedPreexisting/deletedUnknown 两个具名键）也算"声明了这一层"
    const v = residueVerdict({ ...OKR(), deletedUnknownRows: 0 });
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/指控轴没有正对照/);
    // 早退分支（归因层没有分母）里，轴那一句也必须出现
    const e = residueVerdict({ ...LAYER(), attributionEnumerated: 0 });
    expect(e.kind).toBe('unproven');
    expect(e.detail).toMatch(/归因层没有分母/);
    expect(e.detail).toMatch(/没有可信的指控轴正对照/);
  });

  it('★ 驱动侧的红线闸门不碰库也要能拒（fail-closed 的形状可确定性验）', async () => {
    const NOWX = new Date();   // 桩件都用"现在"：起点合理性带那条另有专门一格，别把两件事混在一格里
    const withTx = (over: any = {}) => ({ $transaction: async () => {}, agentJob: { create: async () => {} }, ...over });
    const noClient = await runAccusationAxisControl({ prisma: null, runStart: NOWX });
    expect(noClient.ran).toBe(false);
    expect(noClient.ok).toBe(false);
    expect(noClient.reasons[0]).toMatch(/没有 prisma client/);
    // ★ 没有 $transaction ⇒ 没法保证"零持久写入"，必须**拒跑**而不是退回"造完再删"
    //   （第一版就是那么写的，被 B120 那把尺当场抓住：新增了一处手写 deleteMany，等于擅自抬删除面基线）
    const noTx = await runAccusationAxisControl({ prisma: { agentJob: { create: async () => {} } }, runStart: NOWX });
    expect(noTx.reasons[0], '没有事务也必须拒跑，且话要说清是为什么').toMatch(/没有 \$transaction ⇒ 正对照无法保证"零持久写入"，拒跑/);
    const remote = await runAccusationAxisControl({ prisma: withTx(),
      runStart: NOWX, db: { host: 'db.internal-prod', name: 'panda_hub' } });
    expect(remote.reasons[0], '非本机 host 必须**先**被拒，一行都不许写').toMatch(/非本机 ⇒ 拒绝写库/);
    const prodName = await runAccusationAxisControl({ prisma: withTx(),
      runStart: NOWX, db: { host: 'localhost', name: 'panda_hub_prod' } });
    expect(prodName.reasons[0]).toMatch(/不像演练库 ⇒ 拒绝写/);
    const noDelegate = await runAccusationAxisControl({ prisma: { $transaction: async () => {} }, runStart: NOWX });
    expect(noDelegate.reasons[0]).toMatch(/没有可写的委托 prisma\.agentJob/);
    const noStart = await runAccusationAxisControl({ prisma: withTx(), db: { host: 'localhost', name: 'panda_hub_local' } });
    expect(noStart.reasons[0], 'runStart 缺省是 null，而 Number(null)=0 ⇒ 曾经被当成"1970 年"照样跑绿').toMatch(/runStart 缺失或不是有效时刻/);
    // ★ 合理性带这一格单独验：`runStart=0` 是"有限数"、技术上合法，但窗口一坏，这根轴只剩一种答法
    const zeroStart = await runAccusationAxisControl({ prisma: withTx(), db: { host: 'localhost', name: 'panda_hub_local' }, runStart: 0 });
    expect(zeroStart.ok).toBe(false);
    expect(zeroStart.reasons[0]).toMatch(/距现在超过 400 天 ⇒ 拒跑/);
    // 反向：一个正常起点不许被这条带挡住（否则这把尺是永远红的）
    const sane = await runAccusationAxisControl({ prisma: withTx(), db: { host: 'localhost', name: 'panda_hub_local' },
      runStart: new Date(Date.now() - 60_000) });
    expect(sane.reasons.some((r: string) => /距现在超过/.test(r)), sane.reasons.join('；')).toBe(false);
  });

  // ★ 判决侧接线：这一层的 0 只有"正对照跑过"才许读成"没多删"
  const LAYER = (over: any = {}) => ({ ...OKR(), attributionBlind: [], deletedPreexisting: [], deletedUnknown: [],
    deletedUnknownRows: 0, deletedUnknownWholeTables: 0, deletedUnknownRowsSilent: 0, deletedUnreconciled: [],
    deletedPreexistingBrief: [], deletedUnknownBrief: [], ...over });
  /**
   * ★ v3.80（复核 #21 MA-3）：替身必须交出**可重算的证据**，而不只是一组汇总字段。
   *   这份 evidence 与 `axisResolutionGrid` 用的是同一组行（两档×两向 + preId 一对 + 库侧 DEFAULT 一行），
   *   起点取固定锚（不读时钟）⇒ 判决自己重算出来的 ok/planted/点名/放行 必须与下面 AX_OK 的自述字段一模一样。
   */
  const AX_ANCHOR = Date.UTC(2026, 0, 1);
  // ★ v3.81（复核 #22 MA-1）：真驱动埋的 id 一律带本次命名空间（`AXISCTRL_<rnd>`）⇒ 替身也必须带，
  //   否则判决里那条"证据得落在驱动自己的命名空间下"的律就是死码（我第一版就是这么漏过去的）。
  const AX_MARKER = 'AXU_FIXTURE';
  const axId = (s: string) => `${AX_MARKER}_${s}`;
  const AX_ROWS = [
    { id: 'P120', path: 'createdAt', role: 'past', sec: 120, at: AX_ANCHOR - 120_000 },
    { id: 'N120', path: 'createdAt', role: 'notpast', sec: 120, at: AX_ANCHOR + 120_000 },
    { id: 'P86400', path: 'createdAt', role: 'past', sec: 86400, at: AX_ANCHOR - 86_400_000 },
    { id: 'N86400', path: 'createdAt', role: 'notpast', sec: 86400, at: AX_ANCHOR + 86_400_000 },
    { id: 'I_P', path: 'preId', role: 'past', sec: 0, at: AX_ANCHOR },
    { id: 'I_N', path: 'preId', role: 'notpast', sec: 0, at: AX_ANCHOR },
    // ★ v3.81（B200）：defaulted 那一臂的 got 是"库给的时刻"，锚点是**我本机的两个时刻**
    //   （发起事务前 +30ms、插入前 +50ms）⇒ 落点 +37ms 在区间内 ⇒ 时钟偏差 0、区间宽 20ms、
    //   与起点间距 37ms = 起跑耗时 30ms + 事务内偏移 7ms（★ v3.85 复核 #24 C4：这两个数原来注释里写的是
    //   "+5/+50 与耗时 45"，与本文件的实际锚点不符；而恒等式 37=30+7 是 v3.83 的教训，替身自己必须先满足它）
    // ★ v3.83（B204）：这组数现在**必须满足恒等式** dev = lead + inTx（37 = 30 + 7），
    //   区间 [30, 50] 包住 got=37 ⇒ 时钟偏差记 0、区间宽 20。旧那组（锚点 5/50、耗时 45）加起来不等于 37，
    //   而没有任何一格去核这个和 ⇒ 判决重算只核"每个字段等于 f(证据)"，恒等式那一层当时没有证人。
    { id: 'C_D', path: 'createdAt', role: 'defaulted', sec: 0, at: AX_ANCHOR + 37, anchorMs: AX_ANCHOR + 30, anchorNotAfterMs: AX_ANCHOR + 50 },
  ];
  const axAttr = (startShiftSec = 0) => deletedRowAttribution({
    deleted: { AgentJob: AX_ROWS.map((r) => ({ id: axId(r.id), createdAt: r.path === 'createdAt' ? new Date(r.at) : undefined })) },
    preIds: { AgentJob: new Set([axId('I_P')]) },
    runStart: new Date(AX_ANCHOR + startShiftSec * 1000),
    reportedCounts: { AgentJob: AX_ROWS.length },
  });
  const AX_EV = {
    offsetsSec: [120, 86400], runStartMs: AX_ANCHOR, leftover: 0,
    pairs: AX_ROWS.map((r) => ({ id: axId(r.id), path: r.path, role: r.role, sec: r.sec, gotMs: r.at,
      anchorMs: (r as any).anchorMs, anchorNotAfterMs: (r as any).anchorNotAfterMs })),
    attribution: axAttr(),
  };
  const AX_OK = { ran: true, ok: true, offsetsSec: [120, 86400], resolutionSec: 120, reasons: [],
    planted: 7, createdRows: 7, rolledBack: true, leftover: 0, preexistingMine: 3, nonPreMine: 4, unknownMine: 0,
    // ★ v3.79：驱动侧现在会把网格挂在结果上（`runAccusationAxisControl` 里那一行）⇒ 替身也得带上，
    //   否则覆盖行会打成"网格边界=未量"，而那正是我想让第三方一眼看见的缺口形状。
    marker: AX_MARKER,
    defaultedDevMs: 37, defaultedElapsedMs: 20, defaultedClockDevMs: 0,
    defaultedLeadMs: 30, defaultedInTxMs: 7,
    evidence: AX_EV, grid: axisResolutionGrid({ offsetsSec: [120, 86400] }) };

  it('★ 报出了逐行守恒却交不出正对照 ⇒ unproven，明细明说这个 0 读不出"没多删"', () => {
    const v = residueVerdict(LAYER());
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/指控轴没有正对照（这一程根本没跑/);
    expect(v.detail).toMatch(/不许读成没多删/);
    expect(coverageLine(LAYER())).toMatch(/指控轴正对照=未跑/);
  });

  it('正对照跑过且 ok ⇒ 这一层不再挡 clean，覆盖行带出**网格边界**并自曝"真实分辨率未量"', () => {
    const v = residueVerdict(LAYER({ axisControl: AX_OK }));
    expect(v.kind, v.detail).toBe('clean');
    expect(v.detail.includes('指控轴')).toBe(false);
    const line = coverageLine(LAYER({ axisControl: AX_OK }));
    expect(line).toMatch(/指控轴正对照=两向都对（档=120\/86400s·网格边界=变早侧≤−119s哑\/变晚侧\+1s响（本臂实测：落点晚于起点 37ms ⇒ 正向哑区就是这么大；拆开=起跑耗时 30ms \+ 事务内偏移 7ms〔区间宽 20ms、时钟\/时区偏差 0ms〕）·真实分辨率未量·事务内埋7·到达回滚点是\/持久残留0·点名3\/放行4）/);
    // ★ v3.79 反面对照：没有网格就不许打"看起来量过"的边界，只能承认未量
    const noGrid = coverageLine(LAYER({ axisControl: { ...AX_OK, grid: undefined } }));
    expect(noGrid, noGrid).toMatch(/网格边界=未量（没跑网格/);
    // 只截"网格边界=…"那一段来判，不对整行发号施令（整行后面本来就有档位、埋点这些数字）
    const resCellOf = (l: string) => (l.match(/网格边界=[^·]*/) || [''])[0];
    expect(resCellOf(noGrid), '未量那一支不许给出任何"能检多大"的数字').not.toMatch(/\d/);
    expect(resCellOf(line), '有网格 ⇒ 两侧边界都要出现在这一格').toMatch(/变早侧≤−119s哑\/变晚侧\+1s响/);
    // ★ v3.80（复核 #21 MA-4）：没量到 Δ 时不许把"零容差"当实测过
    const noDev = resCellOf(coverageLine(LAYER({ axisControl: { ...AX_OK, defaultedDevMs: null } })));
    expect(noDev, noDev).toMatch(/真实正侧未量/);
    expect(noDev.includes('ms'), noDev).toBe(false);
  });

  it('★ v3.80（复核 #21 MA-3）汇总字段齐了也不给过：判决要自己拿证据重算', () => {
    /**
     * 复核 #21 的实跑证据：v3.79 那版"重算"只做到**字段级非零自检**——
     *   「不带网格 / grid.ok=false / grid 是空壳 / rolledBack=false / 完全手抄 / planted 谎报 99」
     *   六种 axisControl 全都照样 `clean`。也就是说"不许只信 ok"这句只兑了一半：
     *   我信的是**它自己填的那几个字段**，而不是它算出来的东西。
     * ⇒ 现在：证据（pairs + attribution + offsetsSec + runStartMs + leftover）必须原样交来，
     *   判决重跑一遍判据，再拿重算结果对撞自述字段；网格、到达回滚点、写入行数=计划落点数也各自要查。
     */
    const breaks: Array<[string, any, RegExp]> = [
      ['只交汇总字段（没交证据）', { evidence: undefined }, /只交了汇总字段、没交可重算的证据/],
      ['证据缺 attribution', { evidence: { ...AX_EV, attribution: null } }, /只交了汇总字段、没交可重算的证据/],
      ['证据的 leftover 与自述不一致', { evidence: { ...AX_EV, leftover: 4 } }, /leftover 自述=0 重算=4/],
      // 把归因换到"起点挪到所有行之前"那份结果上 ⇒ 重算必然报"指控哑了"，而自述仍写 ok:true
      ['自述 ok:true 但证据重算出 false', { evidence: { ...AX_EV, attribution: axAttr(-200_000) } },
        /重算 ok=false 与自述 ok=true 不一致/],
      ['网格未交', { grid: undefined }, /网格未交/],
      ['网格扫不出边界', { grid: { ok: false, reason: '档位只有 1 个' } }, /网格没扫出边界/],
      ['没到达回滚点', { rolledBack: false }, /到达回滚点=否/],
      ['事务内写入比计划落点少（有一臂没埋进去）', { createdRows: 6 }, /写入=6 而计划落点=7/],
      ['planted 谎报', { planted: 99 }, /有一臂没真埋进去|planted 自述=99 重算=7/],
      // ★ v3.81（复核 #22 BL-1/MA-1）：复核实测这六种"汇总字段自洽、派生字段乱报"的形状当时**全都判 clean**
      //   ⇒ 派生量（网格 / 分辨率 / 三个 Δ）也必须由证据重算，不许留自报通道。
      ['网格是空壳（只有 ok:true）', { grid: { ok: true } }, /网格\.minTierSec 自述=undefined 重算=120/],
      ['网格边界全是 null', { grid: { ...AX_OK.grid, caughtAtOrAfterNegSec: null, caughtAtOrAfterPosSec: null, zeroOk: false } }, /网格\.caughtAtOrAfterNegSec 自述=null 重算=120/],
      ['resolutionSec 谎报', { resolutionSec: 1000000 }, /分辨率自述=1000000 重算=120/],
      ['defaultedDevMs 谎报', { defaultedDevMs: 999999 }, /时刻差自述=999999 重算=37/],
      ['区间宽谎报（v3.83 前这一维被误叫成"演练耗时"）', { defaultedElapsedMs: 1 }, /区间宽自述=1 重算=20/],
      ['时钟偏差谎报（明明在区间内，却报成差 8 小时）', { defaultedClockDevMs: 28_800_000 }, /时钟偏差自述=28800000 重算=0/],
      // ★ v3.83（B204）：起跑耗时与事务内偏移这两维也必须重算，且**它们与落点间距之间要成恒等式**
      ['起跑耗时谎报（把 30ms 报成一小时）', { defaultedLeadMs: 3_600_000 }, /起跑耗时自述=3600000 重算=30/],
      ['事务内偏移谎报', { defaultedInTxMs: 999 }, /事务内偏移自述=999 重算=7/],
      ['三元组自相矛盾（每个数都"报得出"，但它们之间不是拆解关系）',
        { defaultedLeadMs: 0, defaultedInTxMs: 1 }, /恒等式不成立：自报 落点间距=37 而 起跑\+事务内=0\+1/],
      ['marker 未交（证据无从归属到本程）', { marker: undefined }, /不是一个本次运行的命名空间/],
      ['证据的 id 不在本次命名空间下（换了别人的行来充当）',
        { evidence: { ...AX_EV, pairs: AX_EV.pairs.map((p: any) => ({ ...p, id: p.id.replace(`${AX_MARKER}_`, '') })) } },
        /不带本次 marker/],
    ];
    for (const [label, over, re] of breaks) {
      const v = residueVerdict(LAYER({ axisControl: { ...AX_OK, ...over } }));
      expect(v.kind, `${label} 仍被判 clean ⇒ 重算又是假的：${v.detail}`).toBe('unproven');
      expect(v.detail, label).toMatch(re);
    }
    // 反面对照（正向）：证据与自述一致的那份必须仍然通得过，否则这条重算是一把恒红的尺
    expect(residueVerdict(LAYER({ axisControl: AX_OK })).kind).toBe('clean');
  });

  it('★ v3.80（复核 #21 MA-1/MA-2）第二证人是**独立推出来的公式**，不是再调一次同一把尺', () => {
    /**
     * v3.79 我写的"两份实现互证"是假的：测试里那个逐点 `classify` 与 lib 的 `axisResolutionGrid`
     *   吃的都是同一对 `deletedRowAttribution` + `axisControlVerdict` ⇒ 分类器算符一旦改错
     *   （`<` 改 `<=`、单位分支写错），两边一起挪，断言照样绿。这正是本仓"对撞的谓词不许与尺共用"那条老规矩。
     * ⇒ 这里改成**从语义直接推**：行埋在 ANCHOR±tier，"跑前"的定义是 `createdAt < runStart`，
     *   起点挪 s 秒 ⇒ 埋 −tier 那行不再算跑前 ⟺ s ≥ −tier+… ⇒ **负侧边界恒等于最小档**；
     *   而 defaulted 那行钉在 ANCHOR，只要 runStart > ANCHOR 就被误指控 ⇒ **正侧边界恒为 +1s**。
     *   边界因此是"我自己选的档位"的函数，不是时钟的属性 ⇒ 这条既证"网格没算错"，也证"它量不到分辨率"。
     */
    const oracle = (tiers: number[]) => ({ neg: Math.min(...tiers), pos: 1 });
    for (const tiers of [[120, 86400], [5, 86400], [3600, 86400]]) {
      const g = axisResolutionGrid({ offsetsSec: tiers });
      const o = oracle(tiers);
      expect([g.caughtAtOrAfterNegSec, g.caughtAtOrAfterPosSec],
        `档位 ${tiers.join('/')} 下网格边界必须等于独立推出来的 (${o.neg}, ${o.pos})；不等就说明两边有一边错了`)
        .toEqual([o.neg, o.pos]);
    }
    // 这条断言的形状本身就是证词：负侧边界跟着档位走 ⇒ "分辨率"是我埋的间距换个写法（复核实测同结论）
    const moves = [[120, 86400], [5, 86400], [3600, 86400]].map((t) => axisResolutionGrid({ offsetsSec: t }).caughtAtOrAfterNegSec);
    expect(new Set(moves).size, '三个档位给出同一个边界才说明网格没跟着自变量走').toBeGreaterThan(1);
  });

  it('对照跑了但失灵（ok:false）⇒ unproven，且它自己的 reasons 必须上屏（不许只留一句"失灵"）', () => {
    const v = residueVerdict(LAYER({ axisControl: { ...AX_OK, ok: false, reasons: ['★ 指控哑了：createdAt 通路埋的"跑前行"没进'] } }));
    expect(v.kind).toBe('unproven');
    expect(v.detail).toMatch(/指控哑了/);
    expect(coverageLine(LAYER({ axisControl: { ...AX_OK, ok: false, reasons: ['档位只剩 1 档'] } }))).toMatch(/失灵（档=.*：档位只剩 1 档/);
  });

  it('★ 已响的指控不许被新前置降级：delPre>0 时仍判 residue，但把"轴没验过"一起说出来', () => {
    const fired = { deletedPreexisting: [{ model: 'Order', id: 'o1' }], deletedPreexistingBrief: ['Order=1[o1]'] };
    const withoutCtl = residueVerdict(LAYER(fired));
    expect(withoutCtl.kind).toBe('residue');
    expect(withoutCtl.detail).toMatch(/删掉了 1 行\*\*跑前就在\*\*的行/);
    expect(withoutCtl.detail).toMatch(/也可能是整轴位移造出来的伪指控/);
    const withCtl = residueVerdict(LAYER({ ...fired, axisControl: AX_OK }));
    expect(withCtl.kind).toBe('residue');
    expect(withCtl.detail).toMatch(/正对照本程跑过 ⇒ 这条不是轴位移造出来的/);
    expect(withCtl.detail.includes('也可能是')).toBe(false);
  });

  it('★ 链上：正对照确实接进了判决入参（形状已钉；行为由第十五程真跑作证）', () => {
    const src = chainCode();
    expect(src, '链没调用正对照 ⇒ 这一程的 0 仍然没有证人').toMatch(/const AXIS = await runAccusationAxisControl\(\{ prisma, db: readDbTarget\(\), runStart: RUN_START/);
    expect(src, '调用了却没进判决入参 ⇒ 等于算了没人读（B174 同族）').toMatch(/axisControl: AXIS,/);
    expect(src, '用的不是本次 RUN_START（换了时刻就不给这一程作证）').toMatch(/runStart: RUN_START/);
  });

  it('★ 复核 #19 BLOCKER-1：CLI 入口守卫不许再各自手抄（一族一份实现）', () => {
    const root = dirname(SCRIPTS_DIR);
    // 分母＝**跟踪集 ∪ 未跟踪件**（两条通道取并集）。只数 `git ls-files` 的话，
    // "本批新写的脚本带着缺陷形状进来"这一族要到下一次提交才被扫到 ⇒ 那一批就是空档（B120 同族）。
    const tracked = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '*.mjs', '*.js', '*.ts'],
      { cwd: root, encoding: 'utf8' }).trim().split('\n');
    const others = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard', '*.mjs', '*.js', '*.ts'],
      { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const files = [...new Set([...tracked, ...others])].filter(Boolean).sort();
    expect(files.length, '分母塌了 ⇒ 下面那句 0 毫无意义').toBeGreaterThan(1000);
    const bad: string[] = [];
    for (const f of files) {
      const hits = findRawCliEntryGuards(readFileSync(join(root, f), 'utf8'));
      if (hits.length) bad.push(`${f}:${hits.join(',')}`);
    }
    expect(bad, '还在自己比 argv[1] 与模块路径 ⇒ 经符号链接调用会静默不跑并退 0：\n' + bad.join('\n')).toEqual([]);
    // 正面对照：这把尺必须抓得住"缺陷原样"，否则上面那句 0 是**尺瞎了**而不是干净。
    //   ★ 两个记号都拼出来写：整句写全就等于把本测试文件送进它自己的分母
    //     （v3.77 现量：第一版就是这一行命中，`scripts/acceptance-selfcheck.test.ts:1658`）。
    const DEFECT = 'const R = !!process.' + 'argv[1] && resolve(a) === fileURLToPath(' + 'import.' + 'meta.url);';
    expect(findRawCliEntryGuards(DEFECT)).toEqual([1]);
    // ★ 形状 B（v3.79 复核 #20 MAJOR-3）：取子串的守卫方向相反——**被 import 也可能执行**，
    //   本仓那处实例是一个会清业务数据的脚本 ⇒ 这把尺必须也抓得住它。记号同样拆开写，避免自命中。
    const SUB = 'if (process.ar' + 'gv[1] && process.argv[1].inc' + 'ludes("x")) {';
    expect(findRawCliEntryGuards(SUB)).toEqual([1]);
    expect(findRawCliEntryGuards('const p = process.ar' + 'gv[1] || \'\';')).toEqual([]);
    // require.main === module 不算缺陷：那是对象同一性，免疫符号链接与子串
    expect(findRawCliEntryGuards('if (require.main === module) main();')).toEqual([]);
    // 反向对照：迁移后的形状不许命中（否则这条是永远红的尺）
    expect(findRawCliEntryGuards('const RUNNER = isCliEntry(import.meta.url);')).toEqual([]);
    expect(typeof isCliEntry).toBe('function');
    expect(isCliEntry('file:///nope.mjs', undefined)).toBe(false);
    // 自己就是直接执行者时两侧 realpath 必然相等 ⇒ 正面对照（不靠符号链接也能验通的那一半）
    const self = join(root, 'scripts', 'gate-pairing-check.mjs');
    expect(isCliEntry(new URL('file://' + self).href, self)).toBe(true);
    expect(isCliEntry(new URL('file://' + self).href, join(root, 'scripts', 'gate-summary.mjs'))).toBe(false);
  });
});
