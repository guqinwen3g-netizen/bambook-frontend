/**
 * B114（v2.98）：**"演练的删除判据落在谁的命名空间"这件事只有基座一份实现，且它必须过门禁。**
 *
 * 为什么要立这道守卫（起因不是设想，是我自己错了一次）：
 *   v2.95 立 B111 时写下"普查按落点不按形状"，但那把普查尺**只看单行**
 *   ⇒ 跨行 `OR: [ { id: { startsWith: 'SHPA__' } }, … ]` 里的判据它看不见 —— 而 B111 那一处**恰好就是跨行的**。
 *   v2.96 重建后又发现第二个盲区：**一行只取第一个 match**。
 *   v2.98 复核又抓出第三个：**同文件常量转手**（`const NS = 'SHPA__'` ⇒ 尺看不见）与**块内注释能凭空造出"越界"**。
 *   ⇒ 结论：**人肉普查不构成读数**（`/tmp` 脚本按本仓规矩不许当可复现基线），判据得进门禁。
 *
 * 口径（两个名字严格分开，**不许共用"落点"这一个词**）：
 *   · `删除调用`   = `countDeleteCalls()` —— 代码行里 `.delete(` / `.deleteMany(` 出现的次数（全部）；
 *   · `前缀谓词`   = `deletePrefixPredicates().length` —— 其中带 `startsWith` 的那些（是上一个的子集）；
 *   · `越界`       = 前缀谓词里"还原成字面量之后不以 `TEST` 开头"的 ⇒ 判据指向别人/服务的命名空间（B111/B113 那一族）。
 *   分母 = 两把身份尺（`isDrillFileName` ∪ `containsDrillMarker`）的并集 − 按文件豁免。
 *   路径口径与棘轮 / §9.1 **一致**：一律"相对仓库根"（v2.98 复核 B 条：两种拼法会静默漂）。
 *
 * ⚠️ 这把尺的**下界**（守卫自陈，别把"越界 0"读成"删除面都干净"）：
 *   ① 等值 / `in` / `contains` 式删除判据不覆盖；② `const where = {…}` 外提后再传进 `deleteMany` 不覆盖；
 *   ③ **跨文件**持有的常量不覆盖（只还原同文件一层常量）；④ 服务层内部的删除不覆盖（本尺只读 `*.test.ts`）。
 *   每一条都在下面"尺自己的牙齿"里有用例钉住"确实看不见"⇒ 它是**声明的边界**，不是静默的漏。
 * 不连库：只读源码文本。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDrillFileName, containsDrillMarker, walkTestFiles, deletePrefixPredicates, countDeleteCalls,
} from './lib/drill-residue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = join(REPO, 'server', 'src');
const FS = { readdirSync, statSync };
/** 按文件豁免（不是按名字）。路径按"相对仓库根"写，与棘轮的 `WIDE_EXEMPT` 同一口径 */
const EXEMPT = ['server/src/__tests__/drillTouchLog.test.ts'];

/**
 * ★ 已登记的越界命名空间（**只许下降**）。每条必须有理由，且 `defect` 要写清它到底算不算缺陷 ——
 *   算不算决定它占不占"缺陷基线"那一格（否则"登记了"会被读成"都是待修的洞"）。
 */
const KNOWN_FOREIGN_NAMESPACES: Array<{ file: string; value: string; defect: boolean; why: string }> = [
  { file: 'server/src/shipping/__tests__/allocationService.test.ts', value: 'SHPA__', defect: true, why: 'B111：服务生成的合票分配行 id 前缀 ⇒ 清理范围大于自己的写入范围' },
  { file: 'server/src/shipping/__tests__/allocationShippedLock.test.ts', value: 'SHPA__', defect: true, why: 'B111：同一命名空间的第二处落点' },
  { file: 'server/src/scheduler/__tests__/forwardFxMaturityWatchdog.test.ts', value: 'forward_fx_maturity:', defect: true, why: 'B113：调度任务写在生产 RiskAlert 上的 dedupKey 前缀（该测试还直驱一个不筛标记的扫描）' },
  { file: 'server/src/dashboard/__tests__/marginCrossCurrency.test.ts', value: 'MCCTEST', defect: false, why: 'B114 判定：该演练自造的独立币种（全库只有它写这个值）⇒ 属"本族跨 run"的既有认领口径，**登记但不算缺陷**' },
];
/** 棘轮基线：越界**判据**总数（登记即占格，只许下降） */
const FOREIGN_BASELINE = 4;
/** 缺陷基线：其中真被判成缺陷的（只许下降；修好一处要同时删登记行与这里的数字） */
const DEFECT_BASELINE = 3;

const readRepo = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

function census() {
  const all = walkTestFiles(SERVER_SRC, FS).map((rel) => `server/src/${rel}`);
  const narrow = all.filter(isDrillFileName);
  const wide = all.filter((f) => containsDrillMarker(readRepo(f)));
  const candidates = [...new Set([...narrow, ...wide])].filter((f) => !EXEMPT.includes(f));
  let deleteCalls = 0;
  let preds = 0;
  let resolvedViaConst = 0;
  const foreign: Array<{ file: string; line: number; field: string; value: string; viaConst: boolean }> = [];
  for (const f of candidates) {
    const src = readRepo(f);
    deleteCalls += countDeleteCalls(src);
    const ps = deletePrefixPredicates(src);
    preds += ps.length;
    for (const p of ps) {
      if (p.resolvedFrom) resolvedViaConst += 1;
      if (p.foreign) foreign.push({ file: f, line: p.line, field: p.field, value: p.value, viaConst: !!p.resolvedFrom });
    }
  }
  return { all, narrow, wide, candidates, deleteCalls, preds, resolvedViaConst, foreign };
}

describe('B114：演练删除判据不许落在非 TEST 命名空间（v2.98 起进门禁）', () => {
  it('★ 分母与两条身份尺都要自证不瞎（任一写错，下面的"零越界"就是空断言）', () => {
    const c = census();
    expect(c.all.length, '一份 *.test.ts 都没扫到 ⇒ 扫描根写错了').toBeGreaterThan(400);
    expect(c.narrow.length, '窄尺（*Drill* 命名族）瞎了').toBeGreaterThanOrEqual(12);
    expect(c.wide.length, '宽尺（代码行自造 TEST_族 标记）瞎了 ⇒ 分母会塌成窄尺那一小撮').toBeGreaterThanOrEqual(20);
    expect(c.candidates.length, '分母塌了（豁免表或身份尺写错）').toBeGreaterThanOrEqual(23);
    expect(c.preds, '一个 startsWith 谓词都没取到 ⇒ 谓词正则瞎了，"零越界"是假的').toBeGreaterThan(30);
    expect(c.preds, '前缀谓词必须不多于删除调用总数（两个名字的包含关系，防止有人把口径调反）')
      .toBeLessThanOrEqual(c.deleteCalls);
    console.log(`[B114 普查] 分母 ${c.candidates.length}（窄 ${c.narrow.length} ∪ 宽 ${c.wide.length}，豁免 ${EXEMPT.length}）`
      + ` · 删除调用 ${c.deleteCalls} · 其中带 startsWith 的前缀谓词 ${c.preds}（经同文件常量还原 ${c.resolvedViaConst}）`
      + ` · 越界命名空间 ${c.foreign.length}（基线 ${FOREIGN_BASELINE}，其中缺陷基线 ${DEFECT_BASELINE}）`);
    for (const x of c.foreign) console.log(`   ★ ${x.file}:${x.line}  ${x.field} startsWith '${x.value}'${x.viaConst ? '（常量还原）' : ''}`);
  });

  it('★ 主判据（棘轮）：每处越界都必须已登记；总数与缺陷数都只许下降；登记表也不许比现实长', () => {
    const c = census();
    const keys = new Set(c.foreign.map((x) => `${x.file}#${x.value}`));
    const registered = new Set(KNOWN_FOREIGN_NAMESPACES.map((x) => `${x.file}#${x.value}`));
    expect([...keys].filter((k) => !registered.has(k)),
      '出现**未登记**的越界删除判据 ⇒ 新演练拿服务/别人的命名空间当删除条件（B111/B113 那一族）：改判据，或在此登记并同批改 §9')
      .toEqual([]);
    expect(c.foreign.length, `越界判据 ${c.foreign.length} > 基线 ${FOREIGN_BASELINE}：只许下降，调高必须在 diff 里给理由`)
      .toBeLessThanOrEqual(FOREIGN_BASELINE);
    const defects = c.foreign.filter((x) => registered.has(`${x.file}#${x.value}`)
      && KNOWN_FOREIGN_NAMESPACES.find((r) => `${r.file}#${r.value}` === `${x.file}#${x.value}`)?.defect);
    expect(defects.length, `真缺陷 ${defects.length} > 缺陷基线 ${DEFECT_BASELINE}：只许下降`)
      .toBeLessThanOrEqual(DEFECT_BASELINE);
    // 登记表不许比现实长：修好一处必须同批删登记行（留着就是假账）
    expect([...registered].filter((k) => !keys.has(k)),
      '登记表里有**已不存在**的条目 ⇒ 那处已修好，把登记行与两个基线数字一起改小').toEqual([]);
    for (const x of KNOWN_FOREIGN_NAMESPACES) expect(x.why.length, `${x.file} 的登记缺理由`).toBeGreaterThan(10);
  });

  it('★ 豁免表按文件写死、长度钉住，且路径口径与棘轮一致', () => {
    expect(EXEMPT.length, '豁免只许按文件写死；要加就在 diff 里看得见（同批改 §9）').toBe(1);
    for (const e of EXEMPT) {
      expect(e, '豁免路径必须是"相对仓库根"（与 drill-adoption-ratchet 的 WIDE_EXEMPT 同口径，两种拼法会静默漂）')
        .toMatch(/^server\/src\//);
      expect(readFileSync(join(REPO, e), 'utf8').length, '豁免表里的文件必须真实存在（拼错=静默扩大分母）').toBeGreaterThan(0);
    }
    // 反向：把豁免拼成另一种口径（相对 server/src）必须被上面那条抓住
    expect('server/src/__tests__/drillTouchLog.test.ts'.startsWith('server/src/'), '正确口径的对照').toBe(true);
    expect('__tests__/drillTouchLog.test.ts'.startsWith('server/src/'), '对照：相对 server/src 的拼法必须被判不合格').toBe(false);
  });

  it('★ 尺自己的牙齿：两侧都要（越界必被抓 / 合法等价写法不得假红），边界也要钉住"确实看不见"', () => {
    /* ── 必抓：四种"想藏起来"的形状 ── */
    const crossLineOr = [
      'async function cleanup() {',
      '  await prisma.shipmentOrderAllocation.deleteMany({',
      '    where: {',
      '      OR: [',
      '        { id: { startsWith: TEST_PREFIX } },',
      "        { id: { startsWith: 'SHPA__' } }, // 清理服务生成的分配记录",
      '      ],',
      '    },',
      '  });',
      '}',
    ].join('\n');
    const hits = deletePrefixPredicates(crossLineOr);
    expect(hits.filter((h) => h.foreign).map((h) => h.value), '跨行 `OR` 块里的越界字面量必须抓到（v2.95 那把单行尺正是瞎在这）')
      .toEqual(['SHPA__']);
    expect(hits.length, '同块内两个谓词都要计入分母（变量那个不算越界，但要数得到）').toBe(2);
    expect(deletePrefixPredicates(
      "  await prisma.x.deleteMany({ where: { OR: [{ id: { startsWith: 'SHPA__' } }, { toId: { startsWith: 'BRR__' } }] } });",
    ).filter((h) => h.foreign).map((h) => h.value), '同一行两个越界不许只算第一个（v2.96 第二版仍漏在这里）')
      .toEqual(['SHPA__', 'BRR__']);
    expect(deletePrefixPredicates(
      "const NS = 'SHPA__';\nawait p.x.deleteMany({ where: { id: { startsWith: NS } } });",
    ).filter((h) => h.foreign).map((h) => `${h.value}|${h.resolvedFrom}`),
      '★ 同文件常量转手必须还原（v2.98 复核 A①：这是**未声明**的漏洞，不是下界）').toEqual(['SHPA__|NS']);
    expect(deletePrefixPredicates(
      "await p.x.deleteMany({\n  where: {\n    id: {\n      startsWith: 'BRR__',\n    },\n  },\n});",
    ).filter((h) => h.foreign).map((h) => h.value), '谓词自己跨三行也要抓到').toEqual(['BRR__']);

    /* ── 不得假红：四种合法写法（v2.97 的教训：只验"会红"是半个判据） ── */
    for (const src of [
      'await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });',
      'await prisma.order.deleteMany({ where: { id: { startsWith: MARK } } });',
      "await prisma.order.deleteMany({ where: { id: { startsWith: 'TEST_ALLOC_' } } });",
      "const P = 'TEST_NCI_';\nawait prisma.order.deleteMany({ where: { id: { startsWith: P } } });",
      'await prisma.entityLink.deleteMany({ where: { OR: [{ id: { contains: ctx.mark } }, { toId: { contains: ctx.mark } }] } });',
    ]) {
      expect(deletePrefixPredicates(src).filter((h) => h.foreign), `合法写法被判越界 ⇒ 假红：${src}`).toEqual([]);
    }
    /* ── 不得假红：块内注释、读操作、注释掉的删除 ── */
    expect(deletePrefixPredicates("await p.x.deleteMany({\n  // where: { id: { startsWith: 'SHPA__' } },\n  where: { id: { startsWith: ctx.mark } },\n});")
      .filter((h) => h.foreign), '块内注释行不得凭空造出一条"必须登记的越界"').toEqual([]);
    expect(deletePrefixPredicates("const n = await prisma.order.count({ where: { id: { startsWith: 'SHPA__' } } });"),
      'count/find 里的同款前缀不是删除判据 ⇒ 不进分母').toEqual([]);
    expect(deletePrefixPredicates("// await p.x.deleteMany({ where: { id: { startsWith: 'SHPA__' } } });"),
      '整行注释不是落点（B107 ① 同型）').toEqual([]);

    /* ── 边界要钉住"确实看不见"（声明为下界，而不是假装没有） ── */
    expect(deletePrefixPredicates("const w = { id: { startsWith: 'SHPA__' } };\nawait p.x.deleteMany({ where: w });").filter((h) => h.foreign),
      '边界①：where 对象外提 ⇒ 本尺看不见 ⇒ 所以"越界=0"读不成"删除面都干净"').toEqual([]);
    expect(deletePrefixPredicates("import { NS } from './x';\nawait p.x.deleteMany({ where: { id: { startsWith: NS } } });").filter((h) => h.foreign),
      '边界②：跨文件常量不还原 ⇒ 看不见').toEqual([]);
    expect(deletePrefixPredicates("await p.x.deleteMany({ where: { id: 'SHPA__1' } });").length,
      '边界③：等值式删除不产出前缀谓词 ⇒ 读数是下界').toBe(0);
    expect(deletePrefixPredicates("await p.x.deleteMany({ where: { note: { contains: 'SHPA__' } } });").length,
      '边界③续：contains 式同上').toBe(0);
    expect(countDeleteCalls("await p.x.deleteMany({ where: w });"), '边界①的量：删除调用数得到（1）但谓词数不到（0）')
      .toBe(1);

    /* ── 真文件级突变（在内存里改，不动仓库）：新演练塞一条未登记越界，尺必须立刻报出来 ── */
    const realFile = readRepo('server/src/finance/__tests__/thirdPartyStatementAttribution.test.ts');
    const planted = realFile.replace(
      'async function cleanup() {',
      "async function cleanup() {\n  await prisma.invoice.deleteMany({ where: { id: { startsWith: 'ZZOFF__' } } });",
    );
    expect(planted, '突变没落上（该文件结构变了，本用例要跟着换）').not.toBe(realFile);
    expect(deletePrefixPredicates(planted).filter((h) => h.foreign).map((h) => h.value),
      '往真演练文件里种一条未登记越界 ⇒ 必须被报出来（否则守卫的"必抓"只对合成为真）').toContain('ZZOFF__');
  });
});
