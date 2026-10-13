/**
 * B35 采纳进度守卫（**棘轮**，v2.85 · v2.93 换锚）：演练"没接触碰记录壳"的数量**只许下降**。
 *
 * 为什么是棘轮而不是一刀切的"全部必须接壳"：
 *   立账时（v2.85）还剩 4 个未接，写成豁免清单会让"豁免"变成逃避通道，一刀切红又推不动。
 *   棘轮同时满足：① 新增未接壳的演练当场红；② 存量只能随采纳下降（基线是外置常量，调高必须在 diff 里给理由）。
 *
 * ★ v2.93 两处换锚（独立复核抓出来的，两条都成立 —— 都是"判据只做一半"）：
 *   1) **分类只看代码行**：原先 `isAdopted` 吃的是文件原文 ⇒ 注释里写一句
 *      `const prisma = ctx.prisma` 就能被算成"已接壳"（复核实测：/tmp 加一个只把壳写在注释里的
 *      第 13 个文件 ⇒ 读数 `13/13`、全绿）。现在复用基座唯一的 `codeOnly()`，与
 *      `drill-targets-single-source` 同一个剥注释口径（**不再写第三份**）。
 *   2) **分母从"文件名"换成"落点"**：窄尺仍数 `*Drill*` 命名族（基线 0，v2.91 存量清零那句话只对它成立）；
 *      宽尺数"代码行里自造 `TEST_<族>_` 演练标记"的测试文件 —— 那是"这是一份会写库的演练"的**落点**，
 *      改名逃不掉。v2.93 实测：宽尺分母 **25**、其中未接壳 **12**（豁免 1 个 = 壳自己的单测，按文件写死）。
 *      ⇒ 承认窄尺当时的真实覆盖面，并把宽尺存量显式冻成基线，此后只许下降。
 *
 * 不连库：只读源码文本。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, isDrillFileName, containsDrillMarker, isShellAdopted, walkTestFiles, skipCallsInCode,
  injectsStubClient, registersCtxAtTopLevel, ctxCallIsPlainLiteral } from './lib/drill-residue.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = join(REPO, 'server', 'src');
/** 窄尺基线：`*Drill*` 命名族里未接壳的上限。v2.91 清零后为 0。 */
const UNADOPTED_BASELINE = 0;
/**
 * ★ 宽尺基线：以"代码行含 TEST_族 演练标记"为落点口径的未接壳上限（v2.93 冻结在实测值 12）。
 *   v2.96：12 → **10**（接掉 `agentAuditActorB58` + `negativeCreditInvoiceSettle` 两份）。
 *   v2.99：10 → **9**（接掉 `creditNoteInvoiceOffset` —— 接壳当场量出该族在库里漏了
 *          `EntityLink`+`EntityReference` 各 3 行，见 §9 B112 同形状；突变对照：退回"不删不数"只有壳会红）。
 *   v2.99：9 → **3**（同批再接 6 份：`marginCrossCurrency` / `thirdPartyStatementAttribution` /
 *          `directCancelOrder` / `allocationDuplicateGuard` / `shipmentCancelOrderRollback` /
 *          `shipmentDeleteInvoiceLock` ⇒ 已接壳 15 → **21**。过程由壳当场报红量出 **6 处活漏表**（§9 **B118**）。
 *          **剩下的 3 份恰好就是 §12.1 第 27 条那三份** ⇒ 自主可推进的部分到此清零，
 *          形状由下面的 `WIDE_BLOCKED_SET` 按文件钉住（只数个数会被"接一份新的 + 漏一份旧的"蒙过去）。
 *   ⚠️ **不许为降数硬接**：§9 **B111 / B113** 那几份的清理判据落在**服务生成的命名空间**上
 *   （`SHPA__`、生产 `dedupKey` 前缀），接壳必然要收窄删除面 ⇒ 那一步等 Kevin 知悉（§12.1 第 27 条）后再做。
 */
const WIDE_UNADOPTED_BASELINE = 3;
/** ★ 未接壳的那 3 份**按文件名钉死**：它们卡的是删除面，不是"没人想到要接" */
const WIDE_BLOCKED_SET = [
  'server/src/scheduler/__tests__/forwardFxMaturityWatchdog.test.ts',
  'server/src/shipping/__tests__/allocationService.test.ts',
  'server/src/shipping/__tests__/allocationShippedLock.test.ts',
].sort();
/** 按文件豁免（**不是**按名字豁免）：只有这一个文件是"提 TEST_ 字面量但不写真库"的合法例外。 */
const WIDE_EXEMPT = ['server/src/__tests__/drillTouchLog.test.ts'];

/**
 * ★ v2.98：身份尺与接壳判据**不再在本文件里各写一份** —— 与 `drill-cleanup-scope` 共用基座那一份
 *   （同一件事两份实现 = 本仓头号病；宽尺/窄尺/接壳三把尺从此只有一处可改）。
 */
const isAdopted = isShellAdopted;
const isDrillName = isDrillFileName;
const isDrillMarker = containsDrillMarker;

/** 遍历只留一份（基座）；路径统一成"相对仓库根"，豁免表与日志都按这个口径 */
function testFiles(): string[] {
  return walkTestFiles(SERVER_SRC, { readdirSync, statSync }).map((rel) => `server/src/${rel}`);
}

const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const partition = (files: string[]) => ({
  adopted: files.filter((f) => isAdopted(read(f))),
  unadopted: files.filter((f) => !isAdopted(read(f))),
});

/**
 * ★ B116 的姊妹条（v2.97 · **v2.97 复核后重写**）：复算原来**只跑在窄尺分母上**，
 *   只被宽尺（落点口径）收进来的文件从没被机器咬过 ⇒ 提成一份函数、**两个口径都跑**。
 *
 * ⚠️ 复核方把这条第一版的三处缺陷全部实测出来，逐条改在这里（不是措辞修补）：
 *  1) **恒等式**：原先第一条"`ctx` 供 `.prisma` 的行 ≥1"其实被 `isAdopted()` **蕴含**
 *     （`isAdopted` 就要求代码里有 `const prisma = ctx.prisma` 那一行 ⇒ 该行必然同时命中 `ctx` 与 `.prisma`）
 *     ⇒ 这一半永远为真，是 B107 ③ 同型。换成一条 `isAdopted` **不**蕴含的判据：
 *     **必须真的用 run 唯一标记落库/清理**（`ctx.mark` 或 `ctx.id(`）——
 *     接了壳却仍拿写死族前缀当标记，正是 B117（"下一轮删不到上一轮"）的成因，这条抓的就是它。
 *  2) **钉实现字面（B102 同族）**：原先要求源码里出现 `writtenModels().length` 这段字面 ⇒
 *     复核方与我各自实测：把它写成 `const written = ctx.writtenModels(); expect(written.length, …)`
 *     这种**语义等价**的形式，演练照绿、棘轮照红 ⇒ 假红。改成"**要什么 + 不要什么**"两条：
 *     要"断言由壳挂在文件级"（v3.01 起这是基座的事，不再要求每份文件自己抄一遍）；
 *     不要出现"拿 touched 的数量当非空判据"那一族写法。
 *  3) **豁免表随第 2 条一起删掉**：原来要"每份文件自己钉 `writtenModels()`"，才需要给"只删不写"的演练开口子；
 *     断言收进基座之后，文件侧只剩**禁止项** ⇒ 无需要豁免的对象，那条 `length===0` 的钉子也就没有存在意义
 *     （留着会成了一句没有对象的空检查）。B116 的防呆换由 ③' 那条禁止 + 基座的 `autoAssert` 四侧牙齿承担。
 */
/** 拿 touched 的数量当"跑过用例"判据的那一族写法（B116 的原件形状） */
const TOUCHED_AS_NONEMPTY = /expect\(\s*(?:ctx\.)?touched(?:Models\(\))?\.length/;

/* 六条**纯谓词**（不读盘、可被自测直接喂字符串 —— 否则"有没有牙"这件事只能靠运气撞到）
 * ④⑤ 是 v3.00 复核 BLOCKER-1/2 的处置：壳现在自己登记**文件级**断言，但那条登记有两个旁路
 * （注入替身客户端 / 把上下文写进某个 suite 里），不封就等于"称号到手、保证没到手"。 */
const usesRunUniqueMark = (code: string) => /ctx\.mark\b|ctx\.id\(/.test(code);
const buildsOwnClient = (code: string) => /new PrismaClient\(\)/.test(code);
const assertsOnTouchedCount = (code: string) => TOUCHED_AS_NONEMPTY.test(code);

function assertAdoptedByIndependentPredicate(adopted: string[], ruler: string): void {
  expect(adopted.length, `${ruler}：一个"已接壳"都没有 ⇒ 复算在测空气`).toBeGreaterThanOrEqual(1);
  for (const f of adopted) {
    const code = codeOnly(read(f));
    // ① 独立于 isAdopted：必须用 run 唯一标记（isAdopted 不要求这个 ⇒ 不是恒等式）
    expect(usesRunUniqueMark(code),
      `${f} 判为已接壳，却没拿 run 唯一标记落库/清理（\`ctx.mark\` / \`ctx.id(\` 都不见）⇒ 还是"整族兜底"那一代，见 §9 B117`).toBe(true);
    // ② 反绕过：接了壳却自建客户端
    expect(buildsOwnClient(code), `${f} 判为已接壳，却仍在代码里自建客户端 ⇒ 壳被绕过了`).toBe(false);
    // ③' B116（v3.01 换锚）：三句断言已收进基座的 `autoAssert` ⇒ 这里只**禁止**文件把"跑过用例"重新钉回 touched 数量上
    expect(assertsOnTouchedCount(code),
      `${f} 拿 touched 的数量当非空判据 ⇒ B116 的洞回来了（用例全被 skip 也能盖章零残留）。"写过业务数据"这件事现在由壳钉`).toBe(false);
    // ④ B121：壳只在"没有注入客户端"时登记文件级断言 ⇒ 注入替身 = 拿到'已接壳'称号却没有运行时保证
    expect(injectsStubClient(code),
      `${f} 给 createDrillContext 注入了客户端 ⇒ 壳不会为它登记文件级断言（那是替身形状）⇒ 不能算已接壳，见 §9 B121`).toBe(false);
    // ⑥ B121（v3.01 复核）：调用形状必须是"一行字面量、不含 client"——否则壳可能压根没挂断言
    //   （④ 只认 `client:` 冒号形状，`{ prefix, client }` 简写、`createDrillContext(cfg)` 外提、
    //    `{ prefix: mk(), client: stub }` 都能绕过去，而 v3.01 删掉手抄断言后**没有别的判据兜着它**）
    expect(ctxCallIsPlainLiteral(code),
      `${f} 的 createDrillContext 调用形状无法证明壳挂了文件级断言（须是 \`createDrillContext({ prefix: … })\` 一行字面量且不含 client）`).toBe(true);
    // ⑤ B121：登记必须在**第 0 列**，否则钩子作用域是那个 suite 而不是文件
    expect(registersCtxAtTopLevel(code),
      `${f} 的 createDrillContext 不在顶层（第 0 列）⇒ 文件级 afterAll 退化成 suite 级 ⇒ describe.skip 又能溜过去`).toBe(true);
  }
}

describe('B35 采纳棘轮：两个口径都只许下降（v2.85 · v2.93 换锚）', () => {
  it('★ 窄尺（*Drill* 命名）：分母非空、分类不重不漏、且每个"已接壳"都能被独立谓词复算', () => {
    const files = testFiles().filter(isDrillName);
    expect(files.length, '一个 *Drill* 文件都没扫到 ⇒ 这把尺瞎了').toBeGreaterThanOrEqual(12);
    const { adopted, unadopted } = partition(files);
    expect(adopted.length + unadopted.length, '两套分类必须不重不漏').toBe(files.length);
    // ★ 复算走**不同**谓词，且实现只有一份（窄尺与宽尺共用，不各写一遍 = B107 同族）
    assertAdoptedByIndependentPredicate(adopted, '窄尺');
    console.log(`[窄尺 *Drill*] 总数 ${files.length} · 已接壳 ${adopted.length} · 未接壳 ${unadopted.length} · 基线 ${UNADOPTED_BASELINE}`);
    expect(unadopted.length, `未接壳 ${unadopted.length} > 基线 ${UNADOPTED_BASELINE}：${JSON.stringify(unadopted)}`)
      .toBeLessThanOrEqual(UNADOPTED_BASELINE);
  });

  it('★ 宽尺（落点 = 代码行自造 TEST_族 标记）：改名逃不掉，存量冻在基线只许下降', () => {
    const files = testFiles().filter((f) => isDrillName(f) || isDrillMarker(read(f)));
    const wide = files.filter((f) => !WIDE_EXEMPT.includes(f));
    expect(wide.length, '宽尺分母塌了 ⇒ 标记正则或豁免表写错').toBeGreaterThanOrEqual(24);
    const { adopted, unadopted } = partition(wide);
    expect(adopted.length + unadopted.length, '两套分类必须不重不漏').toBe(wide.length);
    expect(WIDE_EXEMPT.length, '豁免表只许按文件写死，且不许悄悄变长').toBe(1);
    // ★ B116 姊妹条：复算**也跑宽尺**（否则只被落点口径收进来的文件，"绕过壳 / 没钉写入断言"没人咬）
    assertAdoptedByIndependentPredicate(adopted, '宽尺');
    console.log(`[宽尺 落点] 候选 ${files.length} · 豁免 ${files.length - wide.length} · 已接壳 ${adopted.length} · 未接壳 ${unadopted.length} · 基线 ${WIDE_UNADOPTED_BASELINE}`);
    expect(unadopted.length, `未接壳 ${unadopted.length} > 基线 ${WIDE_UNADOPTED_BASELINE} ⇒ 新的写库演练必须接壳（或把这一个也接掉）：${JSON.stringify(unadopted)}`)
      .toBeLessThanOrEqual(WIDE_UNADOPTED_BASELINE);
    /**
     * ★ 基线降到 3 之后，"≤3"这句话本身已经不含信息：接掉一份旧的 + 新写一份不接的，读数照样是 3。
     *   ⇒ 剩下这 3 份**按文件名钉死**（它们卡的是 §12.1 第 27 条的删除面，不是"没人想到要接"）。
     *   任何一份被接掉、或冒出新的一份，都必须在这里显式改判据 + 同批改 §9。
     */
    expect(unadopted.slice().sort(), '未接壳集合必须恰好是这三份（多了=新演练没接壳，少了=有人接掉了卡删除面的那三份 ⇒ 要同批改 §12.1 第 27 条）')
      .toEqual(WIDE_BLOCKED_SET);
  });

  /**
   * ★ **B121 第二层**：`describe.skip` 会让 vitest 把**整个文件**记成 skipped、
   *   连壳新挂的**文件级** `afterAll` 都不跑（v3.00 实测：`Test Files 1 skipped (1)` + exit 0）
   *   ⇒ 运行时那层只盖得住"文件里还有活用例"那一档（那一档我另测过：确实会红并点名 B121）。
   *   剩下这一档只能靠文本判据 ⇒ **已接壳的演练文件里不许出现 `.skip` / `.only` / `.todo`**
   *   （`.only` 一起禁，因为它会静默把整个场域缩成一个文件 —— 那是比 skip 更狠的"看着绿其实没跑"）。
   *   ⚠️ 为什么可以钉在 0：本批实测已接壳 21 份里 skip/only 命中 **0 处**（不是"给它开个豁免"）。
   *   真需要条件跳过时要走 §9 记账 + 在这个文件里显式加豁免，不能悄悄改判据。
   */
  it('★ B121 第二层：已接壳的演练文件里不许有 skip / only / todo（整份被 skip 时钩子也不跑）', () => {
    const files = testFiles().filter((f) => isDrillName(f) || isDrillMarker(read(f)));
    const wide = files.filter((f) => !WIDE_EXEMPT.includes(f));
    const adopted = [...new Set([...partition(wide).adopted, ...partition(testFiles().filter(isDrillName)).adopted])];
    expect(adopted.length, '分母塌了 ⇒ 本条会退化成恒真（没有任何文件被检查）').toBeGreaterThanOrEqual(21);
    const hits = adopted.flatMap((f) => skipCallsInCode(read(f)).map((h) => `${f}:${h.line} ${h.text}`));
    console.log(`[B121 skip 尺] 已接壳文件 ${adopted.length} 份 · skip/only 命中 ${hits.length} 处（钉在 0）`);
    expect(hits, `已接壳的演练被整体 skip ⇒ 壳的文件级断言也不会跑：${JSON.stringify(hits)}`).toEqual([]);
  });

  /**
   * ★ 复算的四条谓词**自己**要有牙（v2.97 复核处置：第一版把这三件事全漏了）
   *   不这么写的话，"两个口径都跑复算"这句话只是我的一面之词 —— 它既可能恒真（恒等式），
   *   也可能对合法写法假红（钉实现字面）。两侧都要在这里当场造出来。
   */
  it('★ 复算谓词的牙齿：等价写法不许假红、原件形状必须被抓、且不得被 isAdopted 蕴含', () => {
    const adoptedOnly = [
      "const ctx = createDrillContext({ prefix: 'TEST_X1_' });",
      'const prisma = ctx.prisma;',
    ].join('\n');
    // ① 反恒等式：这段按 isAdopted 判"已接壳"，但**没有** run 唯一标记 ⇒ ①这条必须能单独判红
    expect(isAdopted(adoptedOnly), '对照：这串确实被 isAdopted 认成已接壳').toBe(true);
    expect(usesRunUniqueMark(adoptedOnly),
      '①与 isAdopted 不是同一个谓词的证据：接了壳却仍用写死族前缀 ⇒ 必须被抓（否则①恒真）').toBe(false);
    expect(usesRunUniqueMark(`${adoptedOnly}\nawait prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });`),
      '①正对照：用了 ctx.mark 就放行').toBe(true);
    expect(usesRunUniqueMark(`${adoptedOnly}\nconst id = ctx.id('ORD_1');`), '①正对照：ctx.id( 也放行').toBe(true);
    // ② 反绕过
    expect(buildsOwnClient(`${adoptedOnly}\nconst p2 = new PrismaClient();`), '②自建客户端必须被抓').toBe(true);
    expect(buildsOwnClient(adoptedOnly), '②正对照：只经壳拿客户端 ⇒ 不误伤').toBe(false);
    // ③' v3.01 换锚的两条对照：删掉手抄断言**必须不影响**接壳判定（本批就是靠这条把 21 段删掉的）；
    //     而把"跑过用例"重新钉回 touched 数量上必须被抓（旧形状不得复活）。
    expect(isAdopted(adoptedOnly) && usesRunUniqueMark(`${adoptedOnly}\nawait prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });`)
      && !assertsOnTouchedCount(adoptedOnly),
      '③文件里一份断言都不抄 ⇒ 仍应判为已接壳（保证由壳挂在文件级）').toBe(true);
    const asBackslide = `${adoptedOnly}\nconst touched = ctx.touchedModels();\nexpect(touched.length, 'x').toBeGreaterThan(0);`;
    expect(assertsOnTouchedCount(asBackslide), '③原件形状（拿 touched 数量当非空）必须被抓').toBe(true);
    // ④⑤（v3.00 复核 BLOCKER-1/2）：两个旁路都必须被抓，且正常形状不得假红
    expect(injectsStubClient("const ctx = createDrillContext({ prefix: 'TEST_X_', client: stub as any });"),
      '④注入替身必须被抓（否则"称号到手、保证没到手"）').toBe(true);
    expect(injectsStubClient("const ctx = createDrillContext({ prefix: MARK });"),
      '④正对照：不注入客户端不得假红').toBe(false);
    expect(registersCtxAtTopLevel("describe('d', () => {\n  const ctx = createDrillContext({ prefix: MARK });\n});"),
      '⑤写在 suite 里 ⇒ 钩子降级成 suite 级，必须被抓').toBe(false);
    expect(registersCtxAtTopLevel("const ctx = createDrillContext({ prefix: MARK });"),
      '⑤正对照：顶层登记放行').toBe(true);
    // ⑥（v3.01 复核）：三种"绕过 ④ 的写法"必须都被抓，一行字面量必须放行
    for (const src of ["const ctx = createDrillContext({ prefix: MARK, client });",
      "const ctx = createDrillContext(cfg);",
      "const ctx = createDrillContext({ prefix: mk(), client: stub });"]) {
      expect(ctxCallIsPlainLiteral(src), `⑥这种写法壳可能没挂断言却仍被判已接壳 ⇒ 判据恒真：${src}`).toBe(false);
    }
    expect(ctxCallIsPlainLiteral("const ctx = createDrillContext({ prefix: MARK });"), '⑥正对照：一行字面量放行').toBe(true);
    // ⑥ B121 第二层这把尺自己也要两侧（只验"会红"是半个判据 —— v2.97 的教训）
    for (const src of ["describe.skip('x', () => {});", "it.only('a', () => {});", "it.skipIf(c)('a', () => {});",
      "describe.each(rows).skip('x %s', () => {});", "const url = 'https://x'; it.skip('a', () => {});"]) {
      expect(skipCallsInCode(src).length, `skip/only 形状没被抓到 ⇒ 判据恒真：${src}`).toBe(1);
    }
    for (const src of ["it('a', () => {});", "describe('b', () => {});", "describe.each(rows)('row %s', () => {});",
      "// describe.skip 在这里只是注释说明", "it('x', () => { expect(a.link).toBe('http://a'); });"]) {
      expect(skipCallsInCode(src), `合法形状被判 skip ⇒ 假红：${src}`).toEqual([]);
    }
    expect(assertsOnTouchedCount(`expect(ctx.touchedModels().length, 'x').toBeGreaterThan(0);`),
      '③不存中间变量的原件写法也要被抓').toBe(true);
  });

  it('★ 分类判据自己要有牙（含"只在注释里接壳"必须判未接壳）', () => {
    // 只 import 不用于取客户端
    expect(isAdopted("import { createDrillContext } from 'x';\nconst prisma = new PrismaClient();"),
      '只 import 没接上 ⇒ 未接壳').toBe(false);
    // ★ v2.93 新增反例：代码用裸客户端，**注释**里写满接壳写法 ⇒ 必须判未接壳（旧实现会判已接壳）
    expect(isAdopted([
      'const ctx = createDrillContext({ prefix: "TEST_X1_" });',
      'const prisma = ctx.prisma; // 真代码两处都在 ⇒ 正对照',
    ].join('\n')), '代码里两处都齐 ⇒ 必须判已接壳').toBe(true);
    expect(isAdopted([
      '// const prisma = ctx.prisma;',
      '// const ctx = createDrillContext({ prefix: "TEST_X1_" });',
      'const prisma = new PrismaClient();',
    ].join('\n')), '只在注释里"接壳" ⇒ 必须判未接壳（这是本轮复核抓到的洞）').toBe(false);
    // 形状判据为何不用：注释里的字面会骗 grep
    expect(/new PrismaClient\(\)/.test('// 原来这里是裸 new PrismaClient()'),
      '对照：形状判据会被注释骗到 ⇒ 本守卫按落点分类').toBe(true);
  });
});
