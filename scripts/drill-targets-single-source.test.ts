/**
 * B35 第二刀（v2.62）守卫：**"哪张表哪个字段带哪个演练前缀"这件事只能有一份**。
 *
 * 为什么要它（起因不是设想，是现量对撞出来的两处不相容）：
 *   · `server/scripts/diag-test-residue.mjs` 看得见 `forwardFxSettlementLink.contractId ~ TEST_D6WD_`，
 *     但 `cleanup-test-residue.mjs` 的清单里没有 ⇒ 清理完还留孤儿关联行，下一次验收读数继续被污染；
 *   · `auditLog.actorId` 诊断只列 7 个演练执行者里的 2 个 ⇒ 诊断说"干净"、删除器看得见 7 个。
 *   ⇒ 同族病：清单是真源，手抄两份必然漂（B35/B75/B76/B79 那一族）。
 *
 * ★ 本测试**不连库**：只读源码文本 + 派生清单的形状。删除动作本身要人跑 `--apply`（且要 Kevin 点头）。
 *
 * ⚠️ **运行范围（v2.63 复核 4 命中，写在这里免得被读成"每道门禁都跑过它"）**：
 *   本文件住在 `scripts/` 下，只有**从仓库根**跑的 `vitest run` 会收它（根 `vite.config.ts` 的 test 块只写 exclude ⇒ 走默认 include）。
 *   `cd server && npx vitest run` 用的是 `server/vitest.config.ts`，它的 include 只有
 *   `src` 与 `ops-panel/src` 两棵子树下的 `*.test.ts` ⇒ **不收 `scripts/`** ⇒ 那半边门禁绿了不代表本守卫跑过。
 *   同族的 `g41-write-surface.test.ts` / `authoritative-doc-shape.test.ts` 是一样的处境（既有事实，不是本批引入）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRILL_TARGETS, DRILL_ACTOR_PREFIX, DRILL_PROBE_FX, drillTargets, drillWhere, derivedLinkTargets, handCopyHits } from './lib/drill-residue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIAG = 'server/scripts/diag-test-residue.mjs';
const CLEAN = 'server/scripts/cleanup-test-residue.mjs';
/** 基座自己是**合法**字面量唯一的家，所以它不在"不许手抄"的扫描面上 —— 但它同时被用作尺的**正面对照**（见第一条测试）。 */
const BASE = 'scripts/lib/drill-residue.mjs';
/** 演练族常量的扫描根：现量（同日 grep）`const MARK = 'TEST…'` **只在 `server/src` 下**，仓库其余目录 0 处。 */
const SCAN_ROOT = join(REPO, 'server', 'src');

/** 只留代码行：注释里讲背景（"列表里全是 TEST_D6FX_…"）不算手抄真源，也不算源码事实。 */
const codeLines = (src: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

/**
 * ★ 源码遍历**只留一份**：v2.63 的 actor 普查与本批的 MARK 普查原本是两份各写各的 walk（同一件事两个实现
 *   = 本仓头号病）。两者共用本函数 ⇒ 扫描根/后缀白名单/忽略目录漂不了。
 */
const walkSource = (onFile: (abs: string, text: string) => void) => {
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e)) onFile(p, readFileSync(p, 'utf8'));
    }
  };
  walk(SCAN_ROOT);
};

/**
 * ★★ v2.68（复核 BLOCK-1 的处置）：**两把尺都必须只看代码行。**
 *   v2.67 那两把是在**原始文本**上 matchAll ⇒ 一条注释就能让死认领复活：
 *   把 `ownershipOurStockDrill.test.ts` 的 `const MARK = 'TEST_C6OWN_'` 改成注释，
 *   全 `server/src` 只剩这一处、且落在 `//` 行 ⇒ 方向一/方向二**全绿**（复核实测）。
 *   同文件的 `codeLines()` 本来就是为"消费者不许手抄"那条写的，却没用在派生侧 ——
 *   这正是 B76 那一族："**报告零命中，读得出零命中、读不出没在看**"。
 */
const LITERAL_RE = /['"`](TEST[_-][A-Z0-9]{2,}[_-])/g;
/**
 * 窄尺认两种声明形状：`const MARK = 'TEST_x_'`（历批演练）与 `prefix: 'TEST_x_'`（★ #32 的壳把族前缀
 *   放在 `createDrillContext({ prefix })` 里 —— 不一起放宽，则壳推广那天 `const MARK` 消失、窄尺读数当场塌，
 *   "源派生"这个名字就名不副实（复核 MINOR-3 的预警）。
 */
const MARK_RE = /(?:const MARK|prefix)\s*[:=]\s*'(TEST[-_][A-Z0-9]+[-_]?)'/g;

/** 纯函数：从**一份文本的代码行**里取族（宽尺）。抽出来是为了能单独自证"注释不算"。 */
function literalFamiliesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of codeLines(text).join('\n').matchAll(LITERAL_RE)) out.add(m[1]);
  return out;
}
/** 纯函数：同上，窄尺（`const MARK` / `prefix:` 两种约定写法） */
function markFamiliesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of codeLines(text).join('\n').matchAll(MARK_RE)) out.add(m[1]);
  return out;
}

function familiesWrittenAsLiteral(): Set<string> {
  const out = new Set<string>();
  walkSource((_, text) => {
    for (const f of literalFamiliesIn(text)) out.add(f);
  });
  return out;
}

function familiesWithMarkConst(): Set<string> {
  const out = new Set<string>();
  walkSource((_, text) => {
    for (const f of markFamiliesIn(text)) out.add(f);
  });
  return out;
}

/**
 * ★★ v2.67 登记的**已知未认领**族（现量，不是设想；每条都是"有一族演练数据没有认领目标"）。
 *   为什么这里是一份清单而不是"零命中"：认领需要知道**这张族的行落在哪张表哪个字段**，
 *   而那是 #32（把"写过哪些表"变成可证伪的 prisma 触碰记录壳）要给的证据 —— 本批不靠猜往里填。
 *   ⚠️ 本清单的口径 = `familiesWithMarkConst()` 那把**窄尺**（`const MARK =` 与 `prefix:` 两种约定形状）的现量 16 族
 *      （v3.13 加的第 14 族是壳自己单测里的替身标记，一行都不进库 ⇒ 只登记、不认领）；
 *      源码里"有字面量但没有 MARK 常量"的族窄尺看不见 ⇒ 见下面"两把尺的差额本身就是账"那条（窄尺是**下界**）。
 */
const UNCLAIMED_MARK_FAMILIES = [
  'TEST_B58ACTOR_', 'TEST_C1CT_', 'TEST_C2SM_', 'TEST_C3QTY_', 'TEST_CNA_', 'TEST_DCNL_', 'TEST_MCC_',
  'TEST_NCI_', 'TEST_SHIPDL_', 'TEST_SHPDUP_', 'TEST_SHPLOCK_', 'TEST_SHPRB_', 'TEST_TPA_',
  // v3.13：壳自己那份单测的新用例（`drillTouchLog.test.ts` 里造"客户端没有委托"这一格）——
  //   它只在**替身客户端**上跑，一行都不进库 ⇒ 认领清单不该为它加删除目标（加了反而是给删除面凭空多一族）。
  'TEST_C8DG_',
  // v3.234：对账单那两份**自清理**的真库测试件（B266 名字兜底 / B269 内部 id 不外泄）——
  //   照 TEST_TPA_ 那条既有先例：它们 afterAll 里按自己写入的前缀删干净并断言残值为 0，
  //   所以认领清单不为它们加删除目标（加了＝给删除面凭空多两族，越 §8.2 那条边界）。
  //   ⚠️ 这一格换来的代价要说清：用例**中途红**时那两族会留残值，而认领尺看不见它——
  //   能看见的是那个文件自己的残值断言（它会一起红），不是 watchdog。
  'TEST_B266_',
  'TEST_B269_',
  // v3.24x（2026-09-29 晚）：**短装门禁**那份真库演练（`server/src/shipping/__tests__/shortShipmentGate.test.ts`）
  //   **已接壳**（`createDrillContext({prefix:'TEST_SHORTSHIP_'})`）：
  //   删/数两侧都走 `ctx.mark`，收尾由 `ctx.residual()` 按**运行时真正写过的表**对撞 ⇒ 自清理自证。
  //   ⚠️ 与 `TEST_TPA_`/`TEST_NCI_` 同一先例：**不为它加删除目标**（加了 = 给删除面凭空多一族）。
  //   ⚠️ 代价照写：用例**中途红**时这族会留残值，能看见它的是**本文件自己的** `ctx.residual()` 断言，
  //      不是 watchdog 那本账。
  'TEST_SHORTSHIP_',
];


describe('B35 第二刀：演练认领目标只有基座一份', () => {
  it('★ 两个消费者都不许再写字面量前缀（v2.67：判据从"一条正则"换成基座派生的家族识别 + 真实文件正面对照）', () => {
    for (const f of [DIAG, CLEAN]) {
      const src = readFileSync(join(REPO, f), 'utf8');
      expect(src, `${f} 必须 import 基座并派生清单`).toContain('drillTargets()');
      const hits = codeLines(src).flatMap((l) => handCopyHits(l));
      expect(hits, `${f} 的代码里不许再出现手抄的演练标识（漂移的源头）`).toEqual([]);
    }
    /**
     * ★★ 正面对照用**真实文件**而不是我自己造的字符串：基座是合法字面量唯一的家，里面必然满是家族形状。
     *   若尺在真代码上一条都不认，上面那两句"零命中"就都是空断言（B76 那把被劫持的尺，失效方向正是"报零"）。
     */
    const baseHits = codeLines(readFileSync(join(REPO, BASE), 'utf8')).flatMap((l) => handCopyHits(l));
    expect(baseHits.length, '尺在真实代码上几乎不认 ⇒ 消费者的"零命中"是瞎出来的，不是干净出来的').toBeGreaterThan(10);
    // 反面对照一：过滤规则不许把代码行也放过（这行不是注释，必须留在扫描面上）
    expect(codeLines("  const n = 'TEST_D6FX_';").length, '非注释行不许被过滤掉').toBe(1);
    /**
     * 反面对照二（v2.63 复核 1 命中的教训往外推）：**兄弟形状**都要抓得住。
     *   旧尺只认 `TEST` 一族 ⇒ 有人把 `DRILL-…`/`REQ2-…`/`SIM-…` 手抄进消费者时它照样报"没有字面量"。
     */
    expect(handCopyHits("const n = 'TEST-C7WO-PAY-1';"), '连字符族').toContain('TEST[-_][A-Z0-9]{2,}[-_]');
    expect(handCopyHits("const n = 'DRILL-AMT-INV-1';"), 'DRILL 族手抄').toHaveLength(1);
    expect(handCopyHits("const n = 'REQ2-DEMO-1';"), 'REQ2 族手抄').toHaveLength(1);
    expect(handCopyHits("const n = 'SIM-DATASET-A';"), 'SIM 数据集族手抄').toHaveLength(1);
    expect(handCopyHits('const id = `TEST_${x}_1`;'), '模板拼接（旧尺同样不认）').toContain('模板拼接');
    /**
     * 反面对照三（v2.63 复核 2 命中）：**不该抓的不许抓**。宽尺的代价不是误报本身，
     *   是人为了让它变绿去改**合法代码**（本仓真实例：`TIMELINE_LATEST_BADGE_CLASS` 里含子串 `TEST_BADGE_`）。
     */
    expect(handCopyHits("const cls = 'TIMELINE_LATEST_BADGE_CLASS';"), '含 TEST_ 子串的普通业务常量不许被抓').toEqual([]);
    expect(handCopyHits("import { DRILL_PROBE_FX } from './lib/drill-residue.mjs';"), '标识符里的 DRILL_ 不是字面量，不许被抓').toEqual([]);
    expect(handCopyHits("const t = 'LATEST_TEST_FLOW';"), '引号后不紧跟家族形状 ⇒ 不算手抄').toEqual([]);
  });

  /**
   * ★ v2.68（复核 BLOCK-1 + IMPORTANT-3 的处置证据）：**尺自己也要有"注释 vs 代码"与"业务词不误伤"的对照。**
   *   缺了这一条，上面所有"零命中"都可能只是"没在看"（B76 那一族的又一格）。
   */
  it('★ 尺的视力自证：注释里的族不算源码事实；业务词不许被抓；拼接形状要抓', () => {
    const code = `const MARK = 'TEST_C6OWN_';\nconst p = 'TEST_XX_';\n`;
    expect([...literalFamiliesIn(code)].sort(), '代码行必须被认出来').toEqual(['TEST_C6OWN_', 'TEST_XX_']);
    expect([...markFamiliesIn(code)], '窄尺只认 const MARK / prefix: 两种约定写法').toEqual(['TEST_C6OWN_']);
    // ★ 复核 BLOCK-1 的原件：把同一行改成注释 ⇒ 两把尺都必须变空（v2.67 的它们是满的）
    const commented = code.replace("const MARK = 'TEST_C6OWN_';", "// const MARK = 'TEST_C6OWN_';");
    expect([...literalFamiliesIn(commented)], '注释里出现的族不许当"源码真写过"').toEqual(['TEST_XX_']);
    expect([...markFamiliesIn(commented)], '注释里的 const MARK 必须不算 ⇒ 否则死认领能从注释这条路复活').toEqual([]);
    // 壳采纳后的新写法：prefix: 'TEST_x_' 也要被窄尺认得（否则壳推广那天窄尺读数当场塌）
    expect([...markFamiliesIn(`const ctx = createDrillContext({ prefix: 'TEST_C4OWN_' });`)], 'prefix 形状必须进窄尺').toEqual(['TEST_C4OWN_']);
    // ★ 误伤面（复核给的例：'SMOKE OIL 90' 是面料业务词）：家族名后面没有分隔符就不算演练标识
    expect(handCopyHits("const spec = 'SMOKE OIL 90 成分';"), '业务词 SMOKE 后面是空格 ⇒ 不许抓（宽尺的代价是人去改合法代码）').toEqual([]);
    expect(handCopyHits("const id = 'SMOKE_TEST_1';").length, 'SMOKE 带分隔符才是演练标识').toBeGreaterThan(0);
    // 拼接形状（复核 IMPORTANT-3 抓到 v2.67 漏的那一类）
    expect(handCopyHits("const p = 'TEST' + '_X_1';").length, "'TEST' + '_X_' 是同一件事换了切法 ⇒ 必须抓").toBeGreaterThan(0);
  });

  /**
   * ★★★ v2.67（复核 4 的根因往外推一层）：**认领清单两头都会错，只查一头等于半个判据。**
   *   · 往外的错：清单写 `TEST_C4_`、源码其实用 `TEST_C4OWN_` ⇒ **死认领**（账面"已覆盖"，实际一行都认领不到）。
   *     这一条 v2.62/v2.63 两批都没抓到，因为我此前的判据全是"清单自身的形状"（非空、前缀长什么样），
   *     **没有任何一条拿源码当对照物** ⇒ 复核 4 是靠人读出来的。本条把它变成机器能抓的。
   *   · 往里的错：演练新起一族 `TEST_MCC_` 而无人认领 ⇒ B35 想要的"写过就看得见"直接落空。
   *   ⇒ 两个方向各钉一条，且各自写清**用的是哪把形状尺**（同一族在源码里有两种写法，两把尺的数不同，见下）。
   */
  it('★ 方向一：认领的每一个前缀必须在源码里真的被写过（抓死认领 / 拼写漂移）', () => {
    const written = familiesWrittenAsLiteral();
    expect(written.size, '源码里一个演练族字面量都扫不到 ⇒ 这把尺瞎了，别把"零命中"当"没问题"').toBeGreaterThan(20);
    const claimed = [...new Set(DRILL_TARGETS.map((t) => t.prefix).filter((p) => p && p !== DRILL_ACTOR_PREFIX))];
    expect(claimed.length, '认领前缀集为空 ⇒ 本条在测空气').toBeGreaterThan(8);
    expect(claimed, 'actor 面走"前缀族 + 源码派生"那条判据（见下面 TEST_ACTOR 一节）；它若不在清单里，方向一的豁免就是漏网')
      .not.toContain(DRILL_ACTOR_PREFIX);
    expect(DRILL_TARGETS.some((t) => t.prefix === DRILL_ACTOR_PREFIX), 'actor 认领条目必须仍在册').toBe(true);
    expect(claimed.filter((p) => !written.has(p)), `这些认领前缀在源码里不存在 ⇒ 死认领（账面"已覆盖"，实际一行都认领不到）`).toEqual([]);
    // 恒真检查（把缺陷放回另一种写法：本批修掉的那条就是它）：`TEST_C4_` 必须**不在**派生集、真族必须在
    expect(written.has('TEST_C4_'), '对照：死认领的拼法不该在源码派生集里（它若在了，上面那条就是恒绿判据）').toBe(false);
    expect(written.has('TEST_C4OWN_'), '对照：源码真实使用的族必须在派生集里（否则"零死认领"是瞎出来的）').toBe(true);
  });

  it('★ 方向二：源派生的 MARK 族与认领清单**双向**对得上，未认领的只能是登记过的那批族', () => {
    const marks = familiesWithMarkConst();
    expect(marks.size, '一个 const MARK 都没扫到 ⇒ 尺瞎了').toBeGreaterThan(15);
    const claimed = new Set(DRILL_TARGETS.map((t) => t.prefix).filter((p) => p && p !== DRILL_ACTOR_PREFIX));
    // 已认领的族必须逐个是 MARK 常量族（比方向一更严：认领不许靠"源码里出现过子串"混进来）
    expect([...claimed].filter((c) => !marks.has(c)), '认领前缀不是任何一处 const MARK 的族 ⇒ 要么死认领，要么该族换了写法').toEqual([]);
    const unclaimed = [...marks].filter((m) => !claimed.has(m)).sort();
    expect(unclaimed, '未认领的 MARK 族与登记清单不一致：新族要认领，或认领掉之后要把清单里那行**删掉**（两者都得在 diff 里看得见）')
      .toEqual([...UNCLAIMED_MARK_FAMILIES].sort());
    // 恒真检查：本条不能是恒等式 —— 源派生必须**严格多于**已认领族，否则"相等"这句没有内容
    expect(marks.size, '源派生族数必须严格多于已认领族数 ⇒ 否则方向二退化成恒等式').toBeGreaterThan(claimed.size);
    // 反向证据：登记清单不是抄来的字符串集，它必须逐条真的能在源码里找到（清单自己也会腐烂）
    for (const f of UNCLAIMED_MARK_FAMILIES) expect(marks.has(f), `登记的未认领族 ${f} 在源码里已找不到 ⇒ 清单过时`).toBe(true);
  });

  /**
   * ★ 两把尺的**差额**本身就是账（v2.67 现量：宽尺 39 族 / 窄尺 23 族 ⇒ 16 族有字面量但没有 `const MARK`）。
   *   为什么要钉这个差额：方向二用的是窄尺，窄尺看不见那 16 族 ⇒ 若不写下来，下一个人会把
   *   "方向二绿了"读成"所有演练族都被认领或登记过了"。**窄尺是下界，不是全集。**
   *   差额里已知含两类：① 已认领族的**连字符兄弟拼写**（`TEST-C7WO-` 等，同一族换形状）；
   *   ② 只在服务测试里出现的 mock 面（`TEST_FILE_` / `TEST_ITEMS_` / `TEST_CUST_` 等，**未逐族核对是否落库**）。
   *   ⇒ 未认领的完整清点归 #32（触碰记录壳那把尺是形状无关的：它看"哪张表被写过"，不看人怎么起名）。
   */
  it('★ 窄尺（MARK）必须是宽尺（字面量）的子集，且差额非空 ⇒ 认领覆盖率只能报下界', () => {
    const wide = familiesWrittenAsLiteral();
    const narrow = familiesWithMarkConst();
    for (const f of narrow) expect(wide.has(f), `窄尺族 ${f} 不在宽尺里 ⇒ 两把尺不是包含关系，差额无法解释（尺本身错了）`).toBe(true);
    const gap = [...wide].filter((w) => !narrow.has(w)).sort();
    expect(gap.length, '差额为 0 ⇒ "窄尺是下界"这句已不成立，本批登记的口径要重新写').toBeGreaterThan(0);
    // 差额里必须至少有一条是"已认领族的另一种拼写"（这正是 B35 头两批反复踩的形状问题）
    const norm = (s: string) => s.replace(/[-_]/g, '');
    const claimedNorms = new Set(DRILL_TARGETS.map((t) => t.prefix).filter(Boolean).map(norm));
    expect(gap.filter((g) => claimedNorms.has(norm(g))).length,
      '抓不到任何"同族换拼写"的差额 ⇒ 形状判据这件事换了写法，上面的解释要跟着换').toBeGreaterThan(0);
    console.log(`[下界自证] 宽尺 ${wide.size} 族 / 窄尺 ${narrow.size} 族 / 差额 ${gap.length} 族（认领覆盖率只能按窄尺报下界）`);
  });


  /**
   * ★ v2.63（复核 1 命中）：B35 重开的那一族必须**在认领清单里**。
   *   `server/src/finance/__tests__/writeOffTailDrill.test.ts` 写的业务号是连字符形（`TEST-C7WO-PAY-…`），
   *   而它的 `id` 是下划线形（`TEST_C7WO_PAY_…`）⇒ **认领必须挂在 `id` 上**：
   *   挂业务号等于把"能不能清理"绑在某个测试文件的拼写习惯上（换个人写就失效）。
   */
  it('★ B35 那一族必须进认领清单：C7WO 两表按 id 认领，且诊断/删除两侧同一份', () => {
    const claim = (model: string) => DRILL_TARGETS.filter((t) => t.model === model && t.prefix === 'TEST_C7WO_');
    for (const model of ['invoice', 'paymentVoucher']) {
      const hit = claim(model);
      expect(hit.length, `${model} 没有 C7WO 认领条目 ⇒ 那批残留依旧"看不见"，脚本报零干净`).toBe(1);
      expect(hit[0].field, '必须按 id 认领（业务号是连字符拼写，不该依赖它）').toBe('id');
      expect(drillWhere(hit[0]), '派生出的 where 必须是 startsWith 形状').toEqual({ id: { startsWith: 'TEST_C7WO_' } });
    }
    // 两侧共用基座 ⇒ 诊断 widened 的同时删除面也必须跟着 widened，不接受"只有诊断看得见"
    const diag = readFileSync(join(REPO, DIAG), 'utf8');
    const clean = readFileSync(join(REPO, CLEAN), 'utf8');
    expect(diag).toContain('drillTargets()');
    expect(clean).toContain('drillTargets()');
    // 恒真检查：若清单里根本没有 paymentVoucher，上面四条会全部空转
    expect(DRILL_TARGETS.some((t) => t.model === 'paymentVoucher'), '清单里没有 paymentVoucher ⇒ 本条在前置就红了').toBe(true);
  });

  /**
   * ★ v2.63（复核 2 命中）：交割关联的 `contractId` 是合同** id **，而 D6FX 那批合同的 id 由服务生成（`FFX__…`）
   *   ⇒ 前缀认领结构上够不到它。这里钉住"反查目标"的三件事：去重、非字符串剔除、**空集合返回空数组**。
   *   最后一条是本族的旧病：`{ in: [] }` 会让"删 0 行"看起来像成功（恒真的清理）。
   */
  it('★ 反查关联目标：纯函数、去重、空 id 集不许变成"删 0 行也算成功"', () => {
    expect(derivedLinkTargets([]), '空集合必须返回空清单（有 `{in:[]}` 就是一次假清理）').toEqual([]);
    expect(derivedLinkTargets(null), '缺参同样返回空清单').toEqual([]);
    expect(derivedLinkTargets(['FFX__A', 'FFX__A', '', null as any, 7 as any]), '去重 + 只留非空字符串').toEqual([
      { label: 'D6 交割关联（按合同 id 反查，1 个 id）', model: 'forwardFxSettlementLink', where: { contractId: { in: ['FFX__A'] } }, sensitive: false },
    ]);
    const two = derivedLinkTargets(['FFX__A', 'FFX__B']);
    expect(two[0].model).toBe('forwardFxSettlementLink');
    expect(two[0].where.contractId.in).toEqual(['FFX__A', 'FFX__B']);
    // 恒真检查：若它把空集合也派生成 `{in:[]}`，第一条断言就会红 —— 反向确认这条断言有牙齿
    expect({ contractId: { in: [] } }, '对照：这才是被禁止的形状').not.toEqual(two[0]?.where ?? {});
  });

  /**
   * ★ v2.63（我自己在这批里犯的形状）：**计数走新清单、删除与复核走旧清单**。
   *   `LIST`（含反查目标）若只在 dry-run 那段用，`--apply` 就会"报得比删得多"，
   *   而复核走 TARGETS ⇒ 关联行残留照样打印"✓ 全部为 0"。 ⇒ 三段必须首尾相衔：
   *   计数 ⊇ 删除，删除与复核**必须同一集合**（复核要验的正是"我刚才那批删净了没有"）。
   */
  it('★ 删除器的三段（计数 / 删除 / 复核）必须接得上同一份派生清单', () => {
    const src = readFileSync(join(REPO, CLEAN), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    const loops = [...code.matchAll(/for \(const t of (\w+)\)/g)].map((m) => m[1]);
    expect(loops.length, '找不到三段循环 ⇒ 删除器换了写法，本判据要跟着一并换（不许删掉本条）').toBeGreaterThanOrEqual(3);
    expect(loops.filter((x) => x === 'TARGETS'), '还有循环直接用未派生的 TARGETS ⇒ 关联行/新增族会"计数看得见、删不掉"').toEqual([]);
    // ★ v2.66：不再钉死「循环集合恰好等于某个集合」——那正是形状判据的脆弱处（本轮我加了待批族一条循环，它就假红）。
    //   只保留**有牙齿的那半**：任何循环都不许遍历未派生的 TARGETS；真正的覆盖面判据在 drill-delete-behavior.test.ts（行为 + 调用点普查）。
    expect(loops, `出现了遍历未派生清单的循环：${JSON.stringify(loops)}`).not.toContain('TARGETS');
    expect(src, '删除段必须从 deletable 排序得来（从 LIST 排 = 把 sensitive 也排进删除面）').toMatch(/const sorted = \[\.\.\.deletable\]/);
    expect(src, '必须 import 反查目标，否则 `targetsWithDerivedLinks` 是 ReferenceError（只在 --apply 时才炸）').toMatch(/import \{[^}]*derivedLinkTargets[^}]*\} from '\.\.\/\.\.\/scripts\/lib\/drill-residue\.mjs'/);
    // 恒真检查：把上面放过的写法（TARGETS 循环 / 从 LIST 排序）造出来，尺必须判红
    expect('for (const t of TARGETS) {', '对照形状必须能被 loops 正则抓出来').toMatch(/for \(const t of (\w+)\)/);
    expect('const sorted = [...TARGETS].sort(x)', '对照写法必须被 sorted 来源断言抓住').not.toMatch(/const sorted = \[\.\.\.deletable\]/);
  });

  it('★ 对照探针也住基座，且不许被顺手变成删除目标', () => {
    const diagSrc = readFileSync(join(REPO, DIAG), 'utf8');
    expect(diagSrc, 'diag 的 id vs contractNumber 对照必须用基座导出的探针').toContain('DRILL_PROBE_FX');
    expect(DRILL_PROBE_FX.prefix, '探针前缀的唯一拼写在基座').toBe('TEST_D6FX_');
    const cleanSrc = readFileSync(join(REPO, CLEAN), 'utf8');
    expect(cleanSrc, '删除侧不许把"对照探针"变成删除目标（它查的是 id 前缀，命中面完全不同）').not.toContain('DRILL_PROBE_FX');
  });

  it('★ 两处已证实的漂移都必须在共享清单里存在（诊断与删除看同一份）', () => {
    const link = DRILL_TARGETS.find((t) => t.model === 'forwardFxSettlementLink');
    expect(link, '复核抓到的漂移①：交割关联从前只有诊断看得见 ⇒ 现在必须在清单里（否则清完留孤儿）').toBeTruthy();
    expect(link?.prefix).toBe('TEST_D6WD_');
    /**
     * ★ v2.63 改判据（复核抓到的漂移②再往下一层）：auditLog 从前按"手写 actor 名单"认领，
     *   而源码里有 18 个 `TEST_ACTOR_*` 字面量、手写名单只有 7 个 ⇒ **枚举本身**才是病，不是"少写了几个"。
     *   所以这里不再断言"名单完整"（那判据只会追着人跑），改断言"认领走前缀族 + 名单这个 export 已经不存在"。
     */
    const audit = DRILL_TARGETS.filter((t) => t.model === 'auditLog');
    expect(audit.length, 'auditLog 只能有一条认领目标（两条 = 又开始各自表述）').toBe(1);
    expect(audit[0].prefix, '认领判据必须是前缀族').toBe(DRILL_ACTOR_PREFIX);
    expect(audit[0].ids, '不许再出现枚举式 ids 认领').toBeUndefined();
    expect(readFileSync(join(REPO, 'scripts/lib/drill-residue.mjs'), 'utf8'), '手写名单这个 export 应已删除（留着就会有人再拿它当判据）')
      .not.toMatch(/export const DRILL_ACTOR_IDS/);
  });

  /**
   * ★ v2.63：从**源码派生**演练 actor 字面量，用来证明"枚举清单必然漏"这件事不是我的感觉。
   *   这条同时是一张**网**：将来有人新写一个 `TEST_ACTOR_XXX`，它自动落进前缀族的认领范围，
   *   不需要任何人来更新清单 ⇒ 这才是 B35 想要的"写过就看得见"。
   *
   * ★ v2.72 改判据（**被自己的改进逼出来的，不是设想**）：这里原来钉的是
   *   `expect(derived).toContain('TEST_ACTOR_C7WO')`。`writeOffTailDrill` 接上触碰记录壳之后，
   *   那个写死字面量**按设计消失了**（执行者改由壳生成 `TEST_ACTOR_<族>_<runId>`）⇒ 根门禁当场红
   *   （`Test Files 1 failed` / `Tests 1 failed | 3694 passed`）。这正是"契约测试钉住实现字面"的形状：
   *   **改进会杀掉判据** ⇒ 换成下面两类不腐烂的钉子（① 尺的正对照；② 认领口径必须覆盖运行时生成形）。
   */
  it('★ 源码派生的 actor 数必须多于任何枚举清单能记住的量（证明"改前缀族"方向对）', () => {
    const found = new Set<string>();
    let scanned = 0;
    walkSource((_, text) => {
      scanned += 1;
      for (const m of text.matchAll(/TEST_ACTOR_[A-Z0-9]+/g)) found.add(m[0]);
    });
    const derived = [...found].sort();
    // 恒真检查：若枚举器找不到任何 actor（路径写错/正则过严），下面三条会一起失去意义
    // ★ v2.93 换锚（复核 BLOCK-2 成立）：原先这里钉 derived.length > 8，与 v2.91 删掉的 > 10 是**同一条**
    //   "源码里还剩几个写死身份"的反向下界（现量 10、余量 2 ⇒ 再接壳必红）。改成钉**扫描面**：
    //   分母 = 走到的文件数（1017 实测），它不随采纳变化 ⇒ 只会因"路径/后缀写错"而红，不会因改进而红。
    expect(scanned, '扫描面塌了（根路径或后缀白名单写错）⇒ 本文件所有派生结论都不成立').toBeGreaterThan(900);
    console.log(`[actor 普查] 扫到 ${scanned} 个文件 · 源里写死的 TEST_ACTOR_* 字面量 ${derived.length} 个（**只作读数，不再当判据**）`);
    /**
     * ★ v2.75（复核 **B-2** 的处置）：**删掉**上一批我自己宣布的"三颗不腐烂的钉子" ——
     *   ① 拿假 actor 字面量喂正则：与仓库无关，把尺换成 `/TEST_ACTORZ_/` 它照样返回同一个数 ⇒ **恒真**；
     *   ③ 家族数去重后与派生数是**单射**（实测 16 = 16）⇒ 与既有 `derived.length > 10` **同值**；
     *   ② 锚在"模板源码文本 + 变量名"上：DRY 写法、改名、`join` 都会**假红**，而注释里留字面 + 代码写死名反而**绿**
     *     ⇒ 和被 B102 判死的 `toContain('TEST_ACTOR_C7WO')` **同形且更脆**。
     *   ⇒ "壳造的 run 唯一执行者必须留在认领前缀族内"这件事的**正确测法是运行时值**，
     *     已经住在 `server/src/__tests__/drillTouchLog.test.ts`（断言 `ctx.actor` 本身），不在这里读源码。
     *   这里只留一条**值判据**：认领用的前缀常量必须还是那个常量（换前缀 ⇒ 账号面与留痕面同时失明，这条就红）。
     *   ★ 按 D49，本批**不新增**任何"读某个文件怎么写"的源码文本判据。
     */
    expect(DRILL_ACTOR_PREFIX, '认领用的前缀常量值（壳的运行时断言与 §9.1 账号面都锚在它上面）').toBe('TEST_ACTOR_');
    /**
     * ★ v2.91：删掉 `expect(derived.length).toBeGreaterThan(10)`（**第三次**被自己的改进杀掉，见 §9 B105）。
     *   它钉的是"源码里还剩多少个写死的 `TEST_ACTOR_*` 字面量"——而采纳壳**按设计**让这些字面量消失
     *   （执行者改由壳生成 `TEST_ACTOR_<族>_<runId>`）⇒ 12/12 接完之后实测 11 → **10**，根门禁当场红。
     *   方向上它还是个**反向棘轮**：越接近"没有写死身份"就越红 ⇒ 不是判据，是阻碍。
     *   "枚举必然落后"这件事的不腐烂证据是另外两处：① 上面那条 `audit[0].prefix === DRILL_ACTOR_PREFIX`
     *   （认领走前缀族、不许枚举 `ids`）；② `server/src/__tests__/drillTouchLog.test.ts` 断言**运行时值**
     *   `ctx.actor` 落在该前缀族内。这里保留的 `> 8` 只是"尺没瞎"的分母校验，不是数量要求。
     */
    /**
     * ★ v2.93 删掉"逐 id startsWith(DRILL_ACTOR_PREFIX)"这条**恒真**检查（复核 IMPORTANT-3 成立）：
     *   期望侧谓词与尺共用同一字面量 —— `derived` 本来就是 `/TEST_ACTOR_[A-Z0-9]+/` 扫出来的，
     *   前缀又被上一行钉成 `TEST_ACTOR_` ⇒ 该循环恒绿，写在注释里当"牙齿"是虚报。
     *   真正有牙的三条不读实现字面：`audit[0].ids` 必须 undefined、`DRILL_ACTOR_IDS` 这个 export 必须不存在、
     *   以及 `drillWhere()` 对枚举式认领直接抛。
     */
  });

  /**
   * ★ v2.63（量出来的新面）：`userAccount` 从前**根本不在清单里** ⇒ 11 个可登录的演练账号行对诊断隐形。
   *   纳进清单是为了"看得见"，但**看得见 ≠ 允许默认删** ⇒ 这条必须带 `sensitive`，且删除器要认这个标记。
   */
  it('★ sensitive 标记必须一路传到删除器：纳进清单不等于授权默认删除', () => {
    const acc = DRILL_TARGETS.find((t) => t.model === 'userAccount');
    expect(acc, '演练账号面必须进清单（否则诊断继续对它隐形）').toBeTruthy();
    expect(acc!.sensitive, '可登录主体必须标 sensitive').toBe(true);
    expect(acc!.prefix, '账号也走前缀族认领').toBe(DRILL_ACTOR_PREFIX);
    const derived = drillTargets().find((t) => t.model === 'userAccount');
    expect(derived?.sensitive, '★ drillTargets() 派生时必须带上 sensitive —— 丢了标记，删除器就拿不到"这条不许默认删"').toBe(true);
    expect(drillTargets().filter((t) => t.sensitive).length, '本批只有账号面是 sensitive；若变成 0 说明派生把它吞了').toBe(1);
    const src = readFileSync(join(REPO, CLEAN), 'utf8');
    expect(src, '删除器必须读 --allow-sensitive').toContain('--allow-sensitive');
    expect(src, '删除器必须按 sensitive 过滤出 deletable 集合（★ v2.65 判据已换成行为断见 drill-delete-behavior.test.ts）').toMatch(/\(t\) => !t\.sensitive \|\| allowSensitive/);
    // 恒真检查：没有标记过滤时，同一个表达式应当放行全部（证明上面那条断言不是恒真）
    expect(DRILL_TARGETS.filter((t) => !t.sensitive || true).length, '对照：过滤条件写成"永真"时必须全量通过').toBe(DRILL_TARGETS.length);
    expect(DRILL_TARGETS.filter((t) => !t.sensitive || false).length, '对照：默认档必须真的把 sensitive 挡在删除面外').toBe(DRILL_TARGETS.length - 1);
  });

  it('★ 派生的 where 形状不许变形：prefix→startsWith、extra 必须合进去，枚举/空前缀必须炸', () => {
    expect(drillWhere({ model: 'order', field: 'id', prefix: 'TEST_D2PC_' })).toEqual({ id: { startsWith: 'TEST_D2PC_' } });
    const inv = drillWhere({ model: 'invoice', field: 'sourceId', prefix: 'TEST_D4CM_', extra: { sourceType: 'CommissionPayable' } });
    expect(inv, '佣金发票若丢了 sourceType 这个固定条件，会误伤同前缀之外的发票 ⇒ 定向删除的"向"就在这里').toEqual({ sourceType: 'CommissionPayable', sourceId: { startsWith: 'TEST_D4CM_' } });
    // ★ v2.63：枚举式认领在**派生阶段**就拒收（不是靠人记住"别写清单"）
    expect(() => drillWhere({ model: 'auditLog', field: 'actorId', ids: ['A', 'B'] }), '枚举形状必须炸：手写名单追不上新场景（实测 7 vs 源码 18）').toThrow(/枚举式认领/);
    expect(() => drillWhere({ model: 'order', field: 'id', prefix: '' }), '空前缀必须炸：{} 会命中全表').toThrow(/prefix/);
    expect(() => drillWhere({ model: 'order', field: 'id' }), '缺 prefix 同样炸').toThrow(/prefix/);
    const t = drillTargets();
    expect(t.length, '清单条数必须与基座一致（派生不吞条目）').toBe(DRILL_TARGETS.length);
    expect(t.every((x) => x.label && x.model && typeof x.where === 'object'), '每条都要有 label/model/where 才能被两个消费者直接吃').toBe(true);
  });

  it('★ 分母非空且方向对：清单只能覆盖演练前缀族，不许混进宽词', () => {
    expect(DRILL_TARGETS.length, '清单为空 ⇒ 本测试在测空气').toBeGreaterThan(10);
    for (const x of DRILL_TARGETS) {
      if (x.prefix) {
        // ★ v2.63：形状判据跟着尺一起放宽（连字符族也允许登记），但仍要求"TEST + 族名 + 分隔符"三段齐全
        expect(/^TEST[-_][A-Z0-9]{2,}[-_]/.test(x.prefix), `${x.label} 的前缀 ${x.prefix} 不符合 TEST<族> 形状 ⇒ 认领可能过宽`).toBe(true);
      }
    }
    // 恒真检查：形状判据不能把"宽词"放过（`TEST_` 这种空族名 = 命中整个 TEST 前缀的一切业务号）
    expect(/^TEST[-_][A-Z0-9]{2,}[-_]/.test('TEST_'), '对照：过宽前缀必须被拒').toBe(false);
    // ⚠️ 这条同时说明本批**没有**把 DELETABLE_MARKER_RES（基座那条 lib 侧 allow-list）打开：
    //    它仍是空表，删除只走 cleanup 的定向目标 —— 打开它是另一件事，别把本批读成"lib 侧删除器已可用"。
  });

  it('★ 删除顺序表必须覆盖清单里每一个 model（漏登记 = 按 undefined 顺序删，FK 会炸）', () => {
    /**
     * `cleanup-test-residue.mjs` 里那张 `ORDER` 是**第三处模型知识**（清单 / 顺序表 / 诊断）。
     * 本批把 `forwardFxSettlementLink` 纳进删除侧后，它必须排在合同**之前** —— 靠 `indexOf` 返回 -1 蒙对不算数，
     * 所以这里断言"每个 model 都在 ORDER 里"，漏一个就红（新加族时必须显式排位置）。
     */
    const src = readFileSync(join(REPO, CLEAN), 'utf8');
    const m = src.match(/const ORDER = \[([^\]]*)\]/);
    expect(m, '没在删除器里找到 ORDER 数组 ⇒ 顺序这件事换了写法，本判据要跟着换（不许直接删掉本条）').toBeTruthy();
    const order = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const models = [...new Set(DRILL_TARGETS.map((t) => t.model))];
    expect(models.filter((x) => !order.includes(x)), '这些 model 没进删除顺序表').toEqual([]);
    expect(order.indexOf('forwardFxSettlementLink'), '交割关联必须先于远期合约删除').toBeLessThan(order.indexOf('forwardFxContract'));
  });

  it('★ 不连库：import 基座不得构造 PrismaClient', () => {
    const lib = readFileSync(join(REPO, 'scripts/lib/drill-residue.mjs'), 'utf8');
    expect(lib, '基座若自己 new PrismaClient()，"只读派生清单"的测试就会连库').not.toMatch(/new\s+PrismaClient\s*\(/);
  });
});
