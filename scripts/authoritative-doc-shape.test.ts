/**
 * 权威基准文档（`docs/交付目标与验收标准-*.md`）的**表格形状守卫**。
 *
 * ★ 为什么要有它（不是顺手加判据，而是同一族缺陷复发 ≥4 次的收口）：台账 §9.1 是"唯一判据源"，
 *   它整篇是 Markdown 表格。此前反复发生的三件事都靠人眼复核才发现：
 *     ① 格子里写了裸 `|`（尤其 `||`、`a|b` 这种码串）⇒ 一行凭空多出一列，内容串到别人的列里；
 *     ② 一行内容太长被"续到下一物理行"⇒ **表格当场断掉**，后半段变成游离段落（B15 那行曾跨 8 行、
 *        v2.17 跨 5 行 —— 判据文本还在，但已不在表里，检索与引用都会漏）；
 *     ③ 两行挤成一行（B36 与 B37 曾共用一个物理行 ⇒ B37 整行从表里消失）。
 *   这些都发生在**文档**里，代码门禁一条都不管 ⇒ 每批手写台账都在重新引入风险。
 *
 * ★ 判据只有一份实现（本文件的 `auditTables()`），正反用例都喂它 —— 不在测试里另写一遍解析。
 *   （`auditTablesBeforeB75()` 是**反面对照专用的旧实现**：它不参与任何测量、不产出任何账面数字，
 *    存在的唯一理由是"把缺陷放回去必须红"这条可证伪性要求。引用读数一律只认 `auditTables()`。）
 * ★ 短列的行**不算债**：GFM 会自动补空格子，渲染无损；本仓 v2.55 现量 **43 行**是这种"把最后两格并成一格"的写法，
 *   把它们全拆开属于内容改写，不在本判据范围内（第一版按"多数行形状"当判据会把它们全报成债 ⇒ 假阳性同样是判据失真）。
 */
import { describe, expect, it, vi } from 'vitest';
/**
 * B205 那一族的**第四份**（v3.205 补）：本文件自己 spawn 子进程，默认 5s 档在标准命令全量并发下会被负载压过去。
 *   · 实测签名：`testTimeout=1ms` 时本文件 33 条以 `Error: STACK_TRACE_ERROR` 失败 ⇒ 这正是本版 vitest 超时的长相；
 *   · 本批标准命令全量里那条红就是它：耗时 5452ms（隔离单跑 1655ms）⇒ 过了 5s 档。
 * 只给这一族抬到 30s（与 server/vitest.config.ts 同值），**不动根域全局** —— 全局抬会把"真挂住"一起掩护掉。
 * ★ `gate-summary.test.ts` 刻意不加：它最慢单测 135ms，离 5s 差 37 倍，加阈值只会掩护真挂住。
 */
vi.setConfig({ testTimeout: 30_000 });

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');
/**
 * ★ 全 `docs/**` 的跟踪 md 清单（占位符普查的分母）。
 *   `-c core.quotepath=off` 是**必需**的：本仓默认 quotepath=on，中文文件名会被转成 `\346…` 八进制串，
 *   按名字 grep 或拼路径读文件都会静默落空（本仓踩过：普查报"0 命中"其实是"0 个文件被读到"）。
 */
const ALL_DOC_FILES = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--', 'docs'],
  { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n').filter((f) => f.endsWith('.md'));

/** 找最新的权威基准文档（文件名带日期，不能写死） */
function authoritativeDoc(): { file: string; text: string } {
  const names = readdirSync(DOCS_DIR)
    .filter((f) => /^交付目标与验收标准-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  expect(names.length, 'docs/ 下找不到权威基准文档 ⇒ 本守卫在空转').toBeGreaterThan(0);
  const file = join(DOCS_DIR, names[names.length - 1]);
  return { file, text: readFileSync(file, 'utf-8') };
}

const SEP = /^\|[\s:|-]+\|$/;
const splitCells = (l: string) => l.split(/(?<!\\)\|/);
/**
 * ★★ B90：什么算"表行"必须按**渲染器的规则**定义一份，而不是按"我顺手写的判据"定义两份。
 *   GFM 允许块级内容缩进 **0–3 个空格**（4 空格/制表符才是代码块），所以 `  | x | y |` 照样渲染成表行。
 *   修前：尺内块检测（`startsWith('|')`）与尺外那份"朴素计数"用的是**同一个字面谓词**
 *   ⇒ 一条缩进的表行会**同时**对两侧隐身，B82 辛苦建的"行号集合对撞"退化成恒等式，永远抓不到它。
 *   ⇒ 谓词收成一份且按渲染器规则写；"两侧不同实现"这件事改由下面那条**缩进反面对照**来证伪。
 */
const ROW = /^[ ]{0,3}\|/;

/**
 * ★ B75 的修法（v2.50 第一批）：原先**块内找不到分隔行就整块不做列数比较** ⇒ 台账里 7 个"跨空行续写"的块
 *   全在判据之外，而最大的两块正是 §9 缺陷账与附录 A（我改动最频繁的两张表）。本函数现在做两件事：
 *   ① 无分隔行的块**继承上一张表的列数**并照比 ⇒ 续表段的破格行不再隐身；
 *   ② 把这种块本身**报成债**（`headerless`）⇒ 表中间那个空行在 GFM 下会把表截断成一段游离文本，
 *      "它躲过检查"和"它渲染坏掉"是同一件事，所以不许静默存在。
 *   ★ 方向仍与原判据一致：**只判"格子比列数多"**。格子少是 Markdown 合法省略尾格（本仓 v2.55 现量 **43 行**这种写法），
 *     按"不等于"判会误报 43 行（v2.49 那次量到 49，随文档增删在变 ⇒ 引用前重量） —— 这条口径在 v2.49 用现量探针预演过，别在下次"顺手收紧"时改掉。
 */
function auditTables(text: string) {
  const lines = text.split('\n');
  const tables: Array<{ start: number; cols: number }> = [];
  const over: Array<{ line: number; cells: number; cols: number; inherited: boolean }> = [];
  const noTail: number[] = [];
  const orphan: Array<{ line: number; head: string }> = [];
  const headerless: Array<{ start: number; rows: number; inheritedCols: number | null }> = [];
  let lastCols: number | null = null;
  /**
   * ★ B79（v2.51 复核 BLOCK）：这里必须**自己数"这一行到底有没有被比过列数"**，
   *   因为原先那条"分母自检"写成 `blocks === tables + headerless` —— 那是**同一个函数自己算出来的恒等式**，
   *   把整块跳过改回去它也照样绿（复核实测：旧尺跑修前的台账，5 处破格与"分母自检"全部通过）。
   *   所以配数器放在**这条循环里**，而期望值放在**外面用另一段朴素计数算**（见下面那条断言）。
   * ★★ B82 再补一刀（v2.53–v2.55 复核 IMPORTANT 3）：**光有计数不够** ——
   *   `auditedRows += 1` 记的是"走到了这个分支"，不是"这一行真的被比过"。
   *   复核实测：把比较条件换成"跳过 `| **` 开头的行"之后，计数照样对得上、7/7 全绿，
   *   而台账里 **285 行**以 `| **` 开头（占可检行 504 的 57%）⇒ 一半的表行能悄悄逃逸。
   *   ⇒ 现在记的是**逐行身份 + 两侧操作数**，期望值也是**行号集合**（不是总数）：
   *   少比一行 = 集合少一个元素 = 红，与"这一行是什么内容"无关。
   */
  const audited: Array<{ line: number; cells: number; cols: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!ROW.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && ROW.test(lines[j])) j++;
    const rows = lines.slice(i, j);
    const sepIdx = rows.findIndex((r) => SEP.test(r.trim()));
    const inherited = sepIdx < 0;
    const cols = inherited ? lastCols : splitCells(rows[sepIdx]).length;
    if (inherited) headerless.push({ start: i + 1, rows: rows.length, inheritedCols: cols });
    else {
      tables.push({ start: i + 1, cols });
      lastCols = cols;
    }
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      if (sepIdx >= 0 && k === sepIdx) continue;
      if (SEP.test(row.trim())) continue;
      const lineNo = i + k + 1;
      // 收尾管道必须是**未转义**的：以 `\|` 收尾看起来合法、其实那一格没封上（本批自己踩过）
      if (!/[^\\]\|\s*$/.test(row)) {
        noTail.push(lineNo);
        // 尾管道缺失 + 紧跟一条非空、非表格行 = 表格被这一行截断（判据文本掉出表外）
        const nxt = lines[i + k + 1];
        if (nxt && nxt.trim() && !ROW.test(nxt)) orphan.push({ line: lineNo, head: row.slice(0, 40) });
      }
      if (cols !== null) {
        // ★ B82：这里记录的是"**比较真的发生了**"（两个操作数都在手边），不是"走到了这个分支"。
        //   旧版只 `auditedRows += 1` ⇒ 复核实测：把比较条件改成跳过 `| **` 开头的行，
        //   计数仍然对得上、7/7 全绿（而台账里有 **285** 行以 `| **` 开头 = 57% 的表行可以逃逸）。
        //   所以下面存的是**逐行身份 + 两侧操作数**，由外面的朴素计数按"行号集合"对撞。
        const cells = splitCells(row).length;
        audited.push({ line: lineNo, cells, cols });
        if (cells > cols) {
          over.push({ line: lineNo, cells, cols, inherited });
        }
      }
    }
    i = j - 1;
  }
  return { tables: tables.length, over, noTail, orphan, headerless, blocks: tables.length + headerless.length, audited, auditedRows: audited.length };
}

/**
 * ★★ 反面对照专用的**第二种旧实现**（B82：计数与集合都对得上，但比较被悄悄少做）。
 * 它不参判定，只用来证明两件事：
 *   ① "已比行号集合对撞"**拦不住**"把行计入却没比" ⇒ 所以还需要"逐条回到原文重算格子数"那一条；
 *   ② 把这一格用 `| **` 行注入破格时，本变异体漏报、真尺抓到。
 * 变异方式（只动一处）：以 `| **` 开头的行**照常计入 audited**，但 `cells` 直接取 `cols`
 * （= 恒不超标），且不参与 `over` 判定 —— 这正是复核那条"285 行可以逃逸"的形状。
 */
function auditTablesSkipBoldRows(text: string) {
  const lines = text.split('\n');
  const audited: Array<{ line: number; cells: number; cols: number }> = [];
  const over: Array<{ line: number; cells: number; cols: number }> = [];
  let lastCols: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!ROW.test(lines[i])) continue;   // ← 与真尺同谓词：本变异体声明"只动一处"，覆盖面不许顺手漂移
    let j = i;
    while (j < lines.length && ROW.test(lines[j])) j++;
    const rows = lines.slice(i, j);
    const sepIdx = rows.findIndex((r) => SEP.test(r.trim()));
    const cols = sepIdx < 0 ? lastCols : splitCells(rows[sepIdx]).length;
    if (sepIdx >= 0) lastCols = cols;
    for (let k = 0; k < rows.length; k++) {
      if ((sepIdx >= 0 && k === sepIdx) || SEP.test(rows[k].trim())) continue;
      const lineNo = i + k + 1;
      if (cols === null) continue;
      if (rows[k].startsWith('| **')) { audited.push({ line: lineNo, cells: cols, cols }); continue; }  // ← 缺陷：计入却没比，还伪造了 cells
      const c = splitCells(rows[k]).length;
      audited.push({ line: lineNo, cells: c, cols });
      if (c > cols) over.push({ line: lineNo, cells: c, cols });
    }
    i = j - 1;
  }
  return { audited, over, auditedRows: audited.length };
}

/**
 * ★ 反面对照专用的**旧实现**（不是第二把尺：它不参与任何测量与判定，只用来证明"把缺陷放回去一定红"）。
 * 与修法前的 `auditTables` 同逻辑：无分隔行 ⇒ 整块不比列数。
 */
function auditTablesBeforeB75(text: string) {
  const lines = text.split('\n');
  const over: number[] = [];
  let headerless = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    let j = i;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const rows = lines.slice(i, j);
    const sepIdx = rows.findIndex((r) => SEP.test(r.trim()));
    if (sepIdx < 0) headerless++;
    for (let k = 0; k < rows.length; k++) {
      if (sepIdx < 0 || (sepIdx >= 0 && k === sepIdx) || SEP.test(rows[k].trim())) continue;
      if (splitCells(rows[k]).length > splitCells(rows[sepIdx]).length) over.push(i + k + 1);
    }
    i = j - 1;
  }
  return { over: over.length, headerless };
}

describe('权威基准文档表格形状（台账是唯一判据源，破了等于没有）', () => {
  const { file, text } = authoritativeDoc();
  const r = auditTables(text);

  it('★ 分母非空：文档必须是"以表格为主"的判据源（找不到表格 = 本守卫在空转）', () => {
    expect(r.tables).toBeGreaterThanOrEqual(30);
    expect(text.split('\n').length).toBeGreaterThan(500);
  });

  it('★ 没有任何一行比本表列数更多（裸 `|` / `||` 会把内容串进别人的列；续表块按继承列数同样比）', () => {
    expect(r.over, `这些行的格子数超过所在表：${JSON.stringify(r.over)}（${file}）`).toEqual([]);
  });

  it('★ B75：表中间不许有空行 —— 出现"无分隔行的表块"就是表被截断（GFM 下这段不再渲染成表，且原先躲过全部列数检查）', () => {
    expect(
      r.headerless,
      `这些块以 | 开头却没有分隔行 ⇒ 上一行是空行，表在这里被截断。修法：删掉那个空行让行回到表里：` +
        `${JSON.stringify(r.headerless)}（${file}）`,
    ).toEqual([]);
    /**
     * ★★ 分母自检 —— **B79 修正版**（v2.51 复核 BLOCK）
     * 原先这条写成 `blocks === tables + headerless` ⇒ 那是 `auditTables()` 自己算出来的**恒等式**，
     * 把"整块跳过"改回去它照样绿（复核实测：旧尺跑修前台账 ⇒ over=0、headerless=0、自检通过）。
     * 现在期望值由**另一段朴素计数**在尺外面算：`以 | 开头的行数 − 分隔行数` = "应当被比过列数的表行数"，
     * 与尺内部数出来的 `auditedRows` 对撞 ⇒ 只要有任何一个整块没被比，差值就出现。
     */
    const allLines = text.split('\n');
    const pipeLines = allLines.filter((l) => ROW.test(l)).length;
    const sepLines = allLines.filter((l) => ROW.test(l) && SEP.test(l.trim())).length;
    const mustAudit = pipeLines - sepLines;
    expect(
      r.auditedRows,
      `只比了 ${r.auditedRows} 行的列数，但文档里有 ${mustAudit} 行表行（= 渲染器认得的表行 ${pipeLines} 减去分隔行 ${sepLines}）` +
        ` ⇒ 有整块没被检查过。这正是 B75 那类"覆盖面小于写法面"，而旧版自检抓不到它。`,
    ).toBe(mustAudit);
    /**
     * ★★ B82：把"对总数"升级成"对集合"。总数只拦得住"少了一整块"，
     *   拦不住"每一块里各少几行"（复核的 `| **` 变异体就是靠这个钻过去的：
     *   它一行都没比，但把行**算进了已检查数** ⇒ 总数照样相等）。
     *   期望集合在尺外面按"以 | 开头且不是分隔行"朴素算出 ⇒ 少比/假比任意一行都差一个元素。
     */
    const expectedLines = allLines
      .map((l, idx) => ({ l, n: idx + 1 }))
      .filter(({ l }) => ROW.test(l) && !SEP.test(l.trim()))
      .map(({ n }) => n);
    expect(
      r.audited.map((a) => a.line).sort((x, y) => x - y),
      `已比行号集合与"应当被比"的集合不符 ⇒ 有行被跳过或被计入却没比（期望 ${expectedLines.length} 行 / 实报 ${r.audited.length} 行）`,
    ).toEqual([...expectedLines].sort((x, y) => x - y));
    // 每一行都必须真的拿到过两侧操作数（"计了数但 cols 是 null"= 空比，同样是假绿）
    expect(r.audited.filter((a) => typeof a.cols !== 'number' || typeof a.cells !== 'number'), '有行被记成"已检查"却没拿到两侧操作数').toHaveLength(0);
    /**
     * ★★ B82 的第二道：逐条**回到原文重算格子数**。
     *   为什么集合对撞还不够：变异体可以"把行计入、cells 却从 cols 反填"⇒ 行号集合完整、总数也对，
     *   但那一行**从没被真的数过**。只有拿期望侧独立算出的 `splitCells(原文)` 去对，才分得开"比过"与"声称比过"。
     */
    const fabricated = r.audited.filter((a) => {
      const src = allLines[a.line - 1];
      return typeof src !== 'string' || !ROW.test(src) || splitCells(src).length !== a.cells;
    });
    expect(fabricated, `有 ${fabricated.length} 条"已检查"记录的 cells 与原文对不上 ⇒ 是反填出来的，不是数出来的`).toEqual([]);
    expect(r.headerless, '有续表块却没报出来 ⇒ headerless 那条计数被改坏了').toHaveLength(0);
  });

  it('★ 每个表格行都以 `|` 收尾：缺尾管道 ⇒ 表格被后续物理行截断，判据文本掉出表外', () => {
    expect(r.noTail, `这些行不以 | 结尾：${JSON.stringify(r.noTail)}（${file}）`).toEqual([]);
    expect(r.orphan, `这些行既缺尾管道、后面又跟着游离文本：${JSON.stringify(r.orphan)}`).toEqual([]);
  });

  it('★ 正面对照：三种破法各自都要被抓（否则上面三条是恒绿）', () => {
    const badOver = '| A | 说明 | 用 `a | b` 当例子 |\n|---|---|---|\n| x | y | z |\n';
    const badTail = '| A | 说明 |\n|---|---|\n| x | 这行没写完\n<br>还续到了下一行 |\n';
    const clean = '| A | 说明 |\n|---|---|\n| x | 用 `a \\| b` 写例子，且本行以管道收尾 |\n';

    const a = auditTables(badOver);
    expect(a.over.length, '裸管道必须被抓').toBe(1);
    const b = auditTables(badTail);
    expect(b.noTail, '缺尾管道必须被抓').toEqual([3]);
    expect(b.orphan.length, '表格被续行截断必须单独报出来').toBe(1);
    const fakeTail = '| A | 说明 |\n|---|---|\n| x | 这行最后那个是转义管道 \\|\n';
    const f = auditTables(fakeTail);
    expect(f.noTail, '以 `\\|` 收尾 = 假收尾，必须同样被抓').toEqual([3]);
    const c = auditTables(clean);
    expect(c.over, '转义过的写法不许误伤（否则修法会变成"删掉判据"）').toEqual([]);
    expect(c.noTail).toEqual([]);
    expect(c.orphan).toEqual([]);
  });

  it('★ B75 反面对照：把"续表块"放回去，新尺必须抓到，旧尺必须抓不到（证明这条判据不是恒红也不是恒绿）', () => {
    // ① 表被空行截断 + 续写段里有一行破格（这就是 v2.47 的 B73/B74 行的形状）
    const brokenOver = '| A | B |\n|---|---|\n| x | y |\n\n| p | q | 多出来的一格 |\n';
    // ② 表被空行截断，但续写段**没有**破格 —— 旧尺连这种都报不出来，新尺仍要把"表被截断"本身报出来
    const brokenOnly = '| A | B |\n|---|---|\n| x | y |\n\n| p | q |\n';
    // ③ 对照：同一张表没有空行 ⇒ 两条判据都应为零（否则修法会退化成"只要有表就红"）
    const clean = '| A | B |\n|---|---|\n| x | y |\n| p | q |\n';

    const a = auditTables(brokenOver);
    expect(a.headerless, '续表块必须被报成债').toEqual([{ start: 5, rows: 1, inheritedCols: 4 }]);
    expect(a.over.filter((o) => o.inherited), '继承列数后必须抓到续写段的破格行').toEqual([
      { line: 5, cells: 5, cols: 4, inherited: true },
    ]);

    const b = auditTables(brokenOnly);
    expect(b.over, '没有破格就不该报破格（方向不许漂成"格子少也算"）').toEqual([]);
    expect(b.headerless.length, '但"表被空行截断"本身必须报').toBe(1);

    const c = auditTables(clean);
    expect([c.headerless, c.over, c.noTail, c.orphan], '无空行的正常表必须全绿').toEqual([[], [], [], []]);

    // 旧实现：两处续表块的破格都看不见（⇒ 新尺确实在补盲区，而不是换个地方喊）
    const old1 = auditTablesBeforeB75(brokenOver);
    expect(old1.over, '旧尺抓不到续表块的破格 ⇒ 这条修法有牙齿').toBe(0);
    expect(old1.headerless, '旧尺即便数得出无分隔块，也从不断言它').toBe(1);

    /**
     * ★ B79：这条决定"分母自检"是不是真判据。构造一段**开头就是无分隔块**的文档（没有上一张表可继承）
     *   ⇒ 那些行根本没东西可比（cols 为 null）⇒ `auditedRows` 必须小于外面算出来的 `mustAudit`。
     *   同时把 v2.51 那条恒等式在同一个样本上跑一遍：它照样"通过" ⇒ 这就是为什么必须换掉它。
     */
    const orphanBlock = '| x | y |\n| z | w |\n';
    const o = auditTables(orphanBlock);
    const oPipe = orphanBlock.split('\n').filter((l) => ROW.test(l)).length;
    const oSep = orphanBlock.split('\n').filter((l) => ROW.test(l) && SEP.test(l.trim())).length;
    expect(o.auditedRows, '没有表头也没有可继承列数的裸表行：若"全都被比过"，说明 auditedRows 是编出来的').toBeLessThan(oPipe - oSep);
    expect(o.blocks, '恒等式在同一个坏样本上仍然成立 ⇒ 证明它抓不到任何东西（这就是被换掉的理由）').toBe(o.tables + o.headerless.length);
    expect(o.headerless.length, '这个样本必须确实是无分隔块').toBe(1);
  });

  it('★ B82 反面对照："计入却没比"的变异体，总数与行号集合都骗得过，只有"回原文重算"骗不过', () => {
    /**
     * 这就是复核 IMPORTANT 3 的那一击：v2.51 把恒等式换成"数了多少行"之后，
     * 我以为分母自检成立了 —— 但 `auditedRows += 1` 记的是**到达**，不是**比较**。
     * 复核实测该变异体在真台账上 7/7 全绿，而台账里 285 行以 `| **` 开头 = 57% 的表行可逃逸。
     * ⇒ 这里同时证明三件事：① 变异体确实骗得过总数；② 也骗得过行号集合；
     *   ③ 只有"逐条回原文重算格子数 + 注入一行破格的 `| **` 行"能抓住它。
     */
    const boldBad = '| A | B |\n|---|---|\n| **D9** | 少一格 | 多出来的一格 |\n';
    const good = '| A | B |\n|---|---|\n| **D9** | 这行合规 |\n';

    const mb = auditTablesSkipBoldRows(boldBad);
    const rb = auditTables(boldBad);
    expect(rb.over.length, '真尺必须抓到 `| **` 行的破格（否则它跟变异体没区别）').toBe(1);
    expect(mb.over, '变异体看不见 `| **` 行的破格 ⇒ 缺陷形状已被复现').toEqual([]);
    expect(mb.auditedRows, '总数这条对变异体无效：它把每一行都计入了').toBe(auditTables(boldBad).auditedRows);
    expect(
      mb.audited.map((a) => a.line).sort((x, y) => x - y),
      '行号集合这条**也**对变异体无效 ⇒ 所以必须再加"回原文重算"那一条（本条把话说清楚，不许后人以为集合对撞已经够了）',
    ).toEqual(rb.audited.map((a) => a.line).sort((x, y) => x - y));
    // ← 唯一能分开两者的判据：拿原文独立重算
    const lines = boldBad.split('\n');
    const caught = mb.audited.filter((a) => splitCells(lines[a.line - 1]).length !== a.cells);
    expect(caught.map((a) => a.line), '变异体反填的 cells 必须与原文对不上（这就是新增那条断言的牙齿）').toEqual([3]);
    // 方向的另一侧：合规的 `| **` 行不能因为新判据被误伤（否则修法会退化成"删掉判据"）
    const rg = auditTables(good);
    expect([rg.over, rg.noTail, rg.orphan], '合规行必须全绿').toEqual([[], [], []]);
    expect(rg.audited.filter((a) => splitCells(good.split('\n')[a.line - 1]).length !== a.cells), '真尺自己也不许反填 cells').toEqual([]);

    // 真台账上跑同一判据：`| **` 行的数量必须"扫得见"，不能是零命中假象
    const BOLD_ROW = /^[ ]{0,3}\| \*\*/;   // ← 与 ROW 同一档缩进口径（B90：别一边允许缩进一边只认顶格）
    const boldInDoc = text.split('\n').filter((l) => BOLD_ROW.test(l)).length;
    expect(boldInDoc, '台账里 `| **` 开头的表行必须 > 0，否则本条反面对照只是在测空气').toBeGreaterThan(0);
    expect(r.audited.filter((a) => BOLD_ROW.test(text.split('\n')[a.line - 1])).length, '这些行必须全部被真尺计入"已比"').toBe(boldInDoc);
  });

  it('★ B90 反面对照：缩进 1–3 空格的表行在 GFM 下照样是表行 —— 尺与"尺外那份计数"必须同时看得见它', () => {
    /**
     * 起因：v2.53–v2.58 复核指出，B79/B82 那套"尺外面另算一份再对撞"的自检，
     * 两边用的是**同一个字面谓词** `startsWith('|')` ⇒ 谓词本身窄了的时候两侧**一起瞎**，
     * 集合对撞退化成恒等式。本仓文档今天有 **0** 行缩进表行（现量），所以这不是"现在有洞"，
     * 而是"洞造出来没人会红" —— 而这正是本文件其余各条判据存在的同一个理由。
     * ⇒ 谓词按渲染器规则收成一份 `ROW`；下面这一条负责让"把谓词改窄回去"必然被抓。
     */
    const indentedOver = '| A | B |\n|---|---|\n  | x | y | 多出来的一格 |\n';
    const rr = auditTables(indentedOver);
    expect(rr.over.map((o) => o.line), '缩进的破格行必须被抓（真尺认它）').toEqual([3]);
    expect(rr.audited.map((a) => a.line), '缩进行必须进入"已比"集合').toContain(3);
    // 旧字面谓词确实看不见它 ⇒ 证明上面两条不是恒真，而是**只对正确谓词**成立
    expect('  | x | y |'.startsWith('|'), '旧谓词必须确实漏掉缩进行（否则本条对照在测空气）').toBe(false);
    // 另一侧：4 空格是代码块，不许被当成表行（否则谓词会从"漏"翻成"过度认领"，同样是错的）
    const codeBlockRow = '    | x | y | 三格 |\n';
    expect(auditTables('| A | B |\n|---|---|\n' + codeBlockRow).over, '4 空格缩进不是表行，不该由本尺认领').toEqual([]);
    // 真台账现量：修谓词**不改变**任何已发布数字（这条把"这次改尺有没有动数"钉住，防止以后误记成一次收敛）
    const indentedInDoc = text.split('\n').filter((l) => /^[ ]{1,3}\|/.test(l)).length;
    expect(indentedInDoc, '台账里的缩进表行数（本批现量为 0 ⇒ 引用旧数字时不必重算）').toBe(0);
  });


  it('★ 解析器不是摆设：整篇文档喂进去，表格区数量与"表头+分隔行"的实际数量一致', () => {
    const seps = text.split('\n').filter((l) => SEP.test(l.trim())).length;
    expect(r.tables, '每个分隔行都应对应一个被识别的表格区').toBeLessThanOrEqual(seps);
    expect(seps).toBeGreaterThanOrEqual(30);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ★ v3.79 处置复核 #20 的三条（BLOCKER-1 / MAJOR-2 / MAJOR-5）
 *
 * MAJOR-5 的原话是"台账用现在时说'读这两份权威文档的尺'，而这份尺只读其中一份"。
 *   我核对过：本文件此前**每个**取文档的入口都是 `authoritativeDoc()`，它只匹配
 *   `^交付目标与验收标准-…` ⇒ `docs/降范围决策登记-….md` 从来没被 `auditTables()` 喂过。
 *   ⇒ 修法不是给台账加判据，而是把**分母**扩成两份，并且让"只有一份被读到"这件事本身会红
 *     （下面第一条断言 `docs.map(d=>d.role)` 必须等于两项；少一项就是分母空了）。
 *
 * BLOCKER-1 的形状：v3.78 那批我用 python 往台账里填读数，两个 `%d` **一次都没被格式化**就写进了文档
 *   （同一批还有一处 `'…%d…' + '…' % (n,n)` —— `%` 只绑到最后那个片段）。复核当场读出"`%d 行 / %d 字节`"。
 *   ⇒ 这类债只在**正文**里才是债（代码/命令里的 `%h`、`%z` 是语法不是残块），所以谓词先剥
 *     代码围栏与行内码，再在剩下的正文里找未填的转换符。现量：docs/ 下 510 份 md 共 14 处命中，
 *     其中 12 处在另外 4 份文档里、逐条看过全是 `git log --format='%h %s'` / `stat -f%z` 这类命令串
 *     ⇒ 本判据只认领两份权威文档，理由就写在这里，不写成"全仓没有这种写法"。
 *
 * MAJOR-2 的形状：台账 §0.5 那张"权威文档索引"里，降范围表那一格写着 `42 条`，而真表现量 **49 行**。
 *   这条与既有判据不同族：**它跨文档**，任何一份单独看都自洽。⇒ 期望值只能从**被引用那份**机取，
 *   并且引用点要枚举（我现量：全文只有 1 处"条数"载体，另有 30 处"第 N 条"行号引用）。
 * ═══════════════════════════════════════════════════════════════════════════ */

const AUTHORITY: Array<{ role: string; pattern: RegExp }> = [
  { role: '台账', pattern: /^交付目标与验收标准-\d{4}-\d{2}-\d{2}\.md$/ },
  { role: '降范围登记表', pattern: /^降范围决策登记-\d{4}-\d{2}-\d{2}\.md$/ },
];

function authorityDocs(): Array<{ role: string; file: string; text: string }> {
  const names = readdirSync(DOCS_DIR);
  return AUTHORITY.map((a) => {
    const hit = names.filter((f) => a.pattern.test(f)).sort();
    expect(hit.length, `${a.role} 在 docs/ 下没有匹配文件 ⇒ 这一族的分母是空的，本尺会永远绿`).toBeGreaterThan(0);
    const file = join(DOCS_DIR, hit[hit.length - 1]);
    return { role: a.role, file, text: readFileSync(file, 'utf-8') };
  });
}

/**
 * ★ v3.80（复核 #21 MINOR-4）：`authorityDocs()` 挑的是"文件名日期最新"那一份，而台账 §0.5 引用的是**写死的路径**。
 *   两者一旦分叉（出现第二份同族文档、或 §0.5 指向旧日期），就是"尺读的"与"账面引用的"各读各的。
 *   ⇒ 选中的 basename 必须真出现在 §0.5 那张索引表里。
 */
function citedInIndex(ledgerText: string, basename: string): boolean {
  return ledgerText.split('\n').some((l) => l.startsWith('|') && l.includes('docs/') && l.includes(basename));
}

const FENCE_MARK = /^\s*```/;
const INLINE_CODE = /`[^`\n]*`/g;
/**
 * ★ v3.80（复核 #21 MINOR-2）槽位形状扩了两种：`%x`（单字母转换符）之外加
 *   `%(name)s`（**python 命名格式——本批出事链用的就是这个**）与 `@name@`（模板槽，大小写都认）。
 *   ⚠️ 刻意**不认领** `{{name}}`：v3.80 实测 `docs/**` 正文里有 **9 处** 双花括号槽
 *     （`通知邮件季节模型组.md` 4 / `Emails-邮件管理/模块概述.md` 2 / `签名管理.md` 3），
 *     逐条回原文看过，那是本产品**邮件模板自己的 Handlebars 语法**，不是谁忘了填的数
 *     ⇒ 认领它会把产品语法判成债（本仓的老规矩：假阳性同样是判据失真），已登记为降范围第 51 条。
 *   ⚠️ 自躲规矩照旧：这里的每个 token 都是**拼起来**的，否则这把尺会认到自己的源码里。
 */
const UNFILLED = new RegExp([
  '%[a-z](?![a-z])',                       // %d / %s / %z …
  '%\\([A-Za-z_]+\\)[a-zA-Z]',             // %(rows)s —— python 命名格式
  '@[A-Za-z][A-Za-z0-9_]*@',               // @CAPS@ / @caps@ —— 模板槽
].join('|'), 'g');
/** 只普查、不判定的形状（理由见上面那段）。 */
const DOUBLE_BRACE_ONLY = /\{\{[A-Za-z_]+\}\}/g;

/** 不用 String.matchAll：这里要**手动推进游标**，零宽匹配会把循环卡死（本仓踩过同族坑）。 */
function findAll(re: RegExp, s: string): string[][] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: string[][] = [];
  let m = g.exec(s);
  while (m !== null) {
    out.push(Array.from(m));
    if (m.index === g.lastIndex) g.lastIndex += 1;
    m = g.exec(s);
  }
  return out;
}

function unfilledPlaceholders(text: string): Array<{ line: number; token: string }> {
  const out: Array<{ line: number; token: string }> = [];
  let inFence = false;
  text.split('\n').forEach((l, i) => {
    if (FENCE_MARK.test(l)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const m of findAll(UNFILLED, l.replace(INLINE_CODE, ''))) out.push({ line: i + 1, token: m[0] });
  });
  return out;
}

/**
 * ★ v3.80（复核 #21 MINOR-1）：`unfilledPlaceholders` 用"围栏标记取反"来跳过代码块，
 *   而**未闭合的围栏就是一块永久遮罩**——它之后的整份文档都不再被看。
 *   复核实测：`正文 %d 一 / ``` / 正文 %d 二` 只命中第一行；而本仓 `docs/` 里真有这种奇数围栏的文件
 *   （`docs/T3-库存账闭环-完成回报-2026-09-16.md` 有 3 个围栏标记）。
 *   ⇒ 两份权威文档必须先证明"围栏标记成对"，否则上面那把尺的"命中 0"没有意义。
 */
function fenceMarkers(text: string): number {
  return text.split('\n').filter((l) => FENCE_MARK.test(l)).length;
}

/**
 * ★ v3.80（复核 #21 MA-5）：这些"现量"数字必须由**尺自己上屏**，台账只许引用它。
 *   v3.79 我在插入 banner/B197/附录行**之前**量了 768 行/30 处引用，然后把它们抄进 banner；
 *   插入本身又新增了两行表行与三处行号引用 ⇒ 台账里的句子描述的是不再存在的那一版文档。
 */
function shapeReadingLine(docs: Array<{ role: string; text: string }>): string {
  return docs.map((d) => {
    const v = shapeViolations(d);
    return `${d.role} ${v.tables} 张/${v.auditedRows} 行`;
  }).join(' · ');
}

function countReadingLine(regDoc: { text: string }, ledText: string): string {
  const nums = registryNumbers(regDoc.text);
  const head = regDoc.text.split('\n').find((l) => HEADING_CITE.test(l)) || '';
  const carrier = ledText.split('\n').find((l) => COUNT_CITE.test(l)) || '';
  const refs = registryRowRefs(ledText);
  return `真表 ${nums.length} · 表内标题 ${(HEADING_CITE.exec(head) || ['', '?'])[1]} · 台账引用 ${(COUNT_CITE.exec(carrier) || ['', '?'])[1]}`
    + ` · 行号引用 ${refs.length} 处/最大 ${Math.max(0, ...refs.flatMap((x) => x.nums))}`;
}

/**
 * ★ v3.85（B206）：把"随文档集增长的普查分母"从**逐字 pin** 里拿出来，换成**下限**。
 *
 * 现量证据（不是猜测）：`普查 510 份 md` 是 v3.83 写的，v3.84 把它改成 511 并在同一行注明了
 * "既存漂移、不是本批造成的"；而 v3.84 记账之后又有**两份与本尺无关的 md**（一份 handoff、一份战略文档）
 * 进了 `git ls-files docs` ⇒ 本批一开尺就是红的，账面那行的 511 对不上现量 513。
 * 这**不是"忘了回填"**能修好的：回填的责任人得是"改任何一份文档的人"，而那个人不在这个批次的范围里。
 * 换句话说这个数被钉成"相等"的那一刻起，判据就把自己的颜色交给了全仓最常被动的东西。
 *
 * ⇒ 口径改成：账面只钉"至少扫过 N 份"（N＝台账历史里引用过的最大值，单调不降），
 *   现量（以及同样跨全部文档普查的"不剥码""双花括号"两项）**只上屏**，不进逐字对撞。
 *   判住的还是原来那件事，而且是更硬的那件：分母**缩水**（= 尺瞎了、扫到的集合变小）必红；
 *   别人加了一份文档不再让门禁红。
 */
function censusFloorCited(ledText: string): number {
  const hits = findAll(/普查 ≥?(\d+) 份 md/g, ledText);
  const pairs = hits.map((m) => [m[0], Number(m[1])] as const);
  expect(pairs.length, '台账里必须至少有一处普查分母的引用（0 ⇒ 这条对撞在测空气，不是"没有分母"）').toBeGreaterThan(0);
  for (const [raw, n] of pairs) {
    expect(Number.isFinite(n) && n > 0, `普查分母引用解不出正整数：${raw}`).toBe(true);
  }
  return Math.max(...pairs.map(([, n]) => n));
}

/**
 * ★ v3.80（复核 #21 BLOCKER-1）：被本批**证否**的那句"≤120s 的整轴位移检不出"仍留在四处，
 *   其中一处是 §9 唯一出处行（还挂着"不动口径"的说法）。这正是 B197 立账的那族病第 5 次现形。
 *   ⇒ 机判形状：凡以**断言形**写出该结论的行（`…实测为"…检不出"`），同行必须带就地收回标记；
 *   引用形（"那句/抄进三处载体"这类叙述）不算断言，所以谓词只认"实测"紧跟"检不出"这一族。
 */
const REFUTED_ASSERTION = /实测为?"[^"]*检不出"|实测"[^"]*检不出"/g;
const RETRACT_MARKS = ['已作废', '就地作废', '就地收回'];
/**
 * ★ v3.81（复核 #22 BLOCKER-1）：v3.80 那版**计数对撞**（标记数 ≥ 断言数）盖不住"标记离得很远"这一族。
 *   复核实测：§9 的 B187 行有两句断言（偏移 855 / 1680）与两枚标记（划线对 848..895、`已作废` 906），
 *   第二句周围**什么标记都没有**，而按"数一数"它算被盖住 ⇒ 那一句"≤120s 检不出"仍是以断言形活着。
 *   ⇒ 改成**就近配对**：一枚标记最多盖一句，且必须"就地"——
 *     · `~~…~~` 这一对要**包住**那句断言（且这对不能长到 200 字以上，否则随便划一大段就能吞掉别人的断言）；
 *     · 文字标记（`已作废` 等）要与断言**同一格**且首尾间距 ≤ 120 字；
 *   格子边界按未转义的 `|` 切（与形状尺同一口径）：表格行里跨格借标记，等于拿别格的收回替本格说话。
 */
/**
 * ★ v3.81（B201）：**要偏移的场合一律用这个，不要用 `findAll`。**
 *   `findAll` 返回的是 `Array.from(match)` —— 那是捕获组列表，**不含 `match.index`**（index 是属性不是下标），
 *   于是 `mk.s <= a0` 拿到 `undefined` 既不报错也不为真，而"两边都 undefined"却被 `gapOf` 算成间距 0
 *   ⇒ 下面这条配对尺的第一版因此把"标记离得很远"的那两句全放行了（复核 #22 要抓的正是这一族，
 *   结果我的新尺用另一种方式又漏了一遍）。index 缺失就当**故障**抛，不许静默退化成"全都贴着"。
 */
function findOffsets(re: RegExp, s: string): Array<{ at: number; text: string }> {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: Array<{ at: number; text: string }> = [];
  let m = g.exec(s);
  while (m !== null) {
    if (!Number.isInteger(m.index)) throw new Error('正则结果没有整数 index ⇒ 偏移判据无从谈起');
    out.push({ at: m.index, text: m[0] });
    if (m.index === g.lastIndex) g.lastIndex += 1;
    m = g.exec(s);
  }
  return out;
}

const RETRACT_PAIR = /~~([\s\S]{0,200}?)~~/g;
const RETRACT_NEAR = 120;
function unretractedRefutations(text: string): Array<{ line: number; at: number; quote: string; nearestMarkGap: number | null }> {
  const out: Array<{ line: number; at: number; quote: string; nearestMarkGap: number | null }> = [];
  text.split('\n').forEach((l, i) => {
    let base = 0;
    for (const cell of splitCells(l)) {
      const marks: Array<{ s: number; e: number; pair: boolean }> = [];
      for (const m of findOffsets(RETRACT_PAIR, cell)) marks.push({ s: m.at, e: m.at + m.text.length, pair: true });
      for (const k of RETRACT_MARKS) for (const m of findOffsets(new RegExp(k, 'g'), cell)) marks.push({ s: m.at, e: m.at + m.text.length, pair: false });
      const used = new Set<number>();
      const gapOf = (mk: { s: number; e: number }, a0: number, a1: number) =>
        (mk.s >= a1 ? mk.s - a1 : (a0 >= mk.e ? a0 - mk.e : 0));
      for (const m of findOffsets(REFUTED_ASSERTION, cell)) {
        const a0 = m.at; const a1 = m.at + m.text.length;
        // ① 首选"被一对划线整个包住"；② 其次是同一格里离得够近的文字标记。
        //   ★ v3.82（复核 #23 m4）：**删掉了旧的第三支**（"没包住但 ≤120 字的一对划线也算"）——
        //   那一支让"另一条结论被划掉了"这种邻近划线替本格断言背书，而降范围第 52 条写的是"要包住"。
        //   划线对与文字标记的差别不是格式偏好：划线**框住了范围**，文字标记靠距离界定，两者各管一头。
        let hit = marks.findIndex((mk, mi) => !used.has(mi) && mk.pair && mk.s <= a0 && mk.e >= a1);
        if (hit < 0) hit = marks.findIndex((mk, mi) => !used.has(mi) && !mk.pair && gapOf(mk, a0, a1) <= RETRACT_NEAR);
        if (hit < 0) {
          const gaps = marks.map((mk) => gapOf(mk, a0, a1));
          out.push({ line: i + 1, at: base + a0, quote: m.text.slice(0, 24), nearestMarkGap: gaps.length ? Math.min(...gaps) : null });
        } else used.add(hit);
      }
      base += cell.length + 1;
    }
  });
  return out;
}

/** 全 `docs/**` 的占位符普查（台账那句"现量"的出处；口径三个值都给，不靠单一说法）。 */
function placeholderCensus(): { files: number; rawTokens: number; rawLines: number; proseTokens: number; outsideProse: number; doubleBrace: number } {
  const out = { files: 0, rawTokens: 0, rawLines: 0, proseTokens: 0, outsideProse: 0, doubleBrace: 0 };
  for (const f of ALL_DOC_FILES) {
    let t: string;
    try { t = readFileSync(join(REPO_ROOT, f), 'utf-8'); } catch { continue; }
    out.files += 1;
    const auth = AUTHORITY.some((a) => a.pattern.test(f.split('/').pop() || ''));
    out.rawTokens += findAll(UNFILLED, t).length;
    out.rawLines += t.split('\n').filter((l) => findAll(UNFILLED, l).length > 0).length;
    const p = unfilledPlaceholders(t).length;
    out.proseTokens += p;
    if (!auth) out.outsideProse += p;
    out.doubleBrace += findAll(DOUBLE_BRACE_ONLY, t).length;
  }
  return out;
}

/** 一份文档的全部形状违规（判据与台账那几条**同一份实现**，只是这里按文档循环）。 */
function shapeViolations(d: { role: string; text: string }) {
  const a = auditTables(d.text);
  const allLines = d.text.split('\n');
  const mustAudit =
    allLines.filter((l) => ROW.test(l)).length - allLines.filter((l) => ROW.test(l) && SEP.test(l.trim())).length;
  const expected = allLines
    .map((l, idx) => ({ l, n: idx + 1 }))
    .filter(({ l }) => ROW.test(l) && !SEP.test(l.trim()))
    .map(({ n }) => n);
  const bad: string[] = [];
  if (a.over.length) bad.push(`${d.role}:破格 ${a.over.length} 行`);
  if (a.noTail.length) bad.push(`${d.role}:缺尾管道 ${a.noTail.length} 行`);
  if (a.orphan.length) bad.push(`${d.role}:表格被截断 ${a.orphan.length} 处`);
  if (a.headerless.length) bad.push(`${d.role}:表中间空行 ${a.headerless.length} 块`);
  if (a.auditedRows !== mustAudit) bad.push(`${d.role}:已比行数 ${a.auditedRows} ≠ 应当被比 ${mustAudit}`);
  const gotSet = a.audited.map((x) => x.line).sort((x, y) => x - y).join(',');
  if (gotSet !== [...expected].sort((x, y) => x - y).join(',')) bad.push(`${d.role}:已比行号集合不符`);
  const fabricated = a.audited.filter((x) => {
    const src = allLines[x.line - 1];
    return typeof src !== 'string' || !ROW.test(src) || splitCells(src).length !== x.cells;
  });
  if (fabricated.length) bad.push(`${d.role}:${fabricated.length} 条 cells 与原文对不上`);
  return { bad, tables: a.tables, blocks: a.blocks, auditedRows: a.auditedRows, mustAudit };
}

const REG_ROW = /^\|\s*(\d+)\s*\|/;
const COUNT_CITE = /(\d+)\s*条「主动不做/;
const HEADING_CITE = /^## 登记表（(\d+)\s*条/;
const ROW_REF = /第\s*(\d+)(?:\s*\/\s*(\d+))?\s*条/g;
const REG_ANCHOR = '降范围';
const REF_WINDOW = 25;

function registryNumbers(text: string): number[] {
  return text
    .split('\n')
    .filter((l) => REG_ROW.test(l))
    .map((l) => Number((l.match(REG_ROW) as RegExpMatchArray)[1]));
}

/** 台账里"降范围…第 N 条"这类**行号引用**（窗口取 25 字，现量 30 处全部落在这个窗口内）。 */
function registryRowRefs(text: string): Array<{ line: number; nums: number[] }> {
  const out: Array<{ line: number; nums: number[] }> = [];
  text.split('\n').forEach((l, i) => {
    let from = 0;
    for (;;) {
      const k = l.indexOf(REG_ANCHOR, from);
      if (k < 0) break;
      from = k + REG_ANCHOR.length;
      const seg = l.slice(from, from + REF_WINDOW);
      const nums: number[] = [];
      for (const m of findAll(ROW_REF, seg)) nums.push(...m.slice(1).filter((x) => !!x).map((x) => Number(x)));
      if (nums.length) out.push({ line: i + 1, nums });
    }
  });
  return out;
}

describe('★ v3.79 复核 #20：分母扩到两份权威文档 + 正文未填占位符 + 跨文档条数对撞', () => {
  const docs = authorityDocs();
  const ledger = docs.find((d) => d.role === '台账') as { role: string; file: string; text: string };
  const regDoc = docs.find((d) => d.role === '降范围登记表') as { role: string; file: string; text: string };
  const regNums = registryNumbers(regDoc.text);
  const N = regNums.length;

  it('★ MAJOR-5：两份文档都过形状尺（此前降范围表从未被喂进来，而台账用现在时说"读这两份的尺"）', () => {
    expect(docs.map((d) => d.role), '分母必须是这两份；少一份＝这条尺只在测空气').toEqual(['台账', '降范围登记表']);
    const readings: string[] = [];
    for (const d of docs) {
      const v = shapeViolations(d);
      readings.push(`${d.role}：表 ${v.tables} 张/块 ${v.blocks} · 已比 ${v.auditedRows}/${v.mustAudit} 行`);
      expect(v.bad, `${d.role} 形状违规`).toEqual([]);
    }
    console.log(`[双文档形状尺] ${readings.join(' · ')}`);
    expect(N, '降范围表必须真数得到行（0 行 ⇒ 下面所有条数对撞都退化成恒真）').toBeGreaterThan(0);
  });

  it('★ MAJOR-5 正面对照：把两种破法各自放回**第二份**文档，新扩的那一半必须红', () => {
    /**
     * 上面那条循环对第二份文档到底是"真在判"还是"永远绿"，只能靠突变证明。
     * 两种破法各查一类：① 多一格（over）；② 表中间插空行（headerless + 该块继承列数）。
     */
    const lines = regDoc.text.split('\n');
    const rowsIdx = lines.map((l, i) => ({ l, i })).filter(({ l }) => ROW.test(l));
    expect(rowsIdx.length, '降范围表里找不到表行 ⇒ 本条对照在测空气').toBeGreaterThan(3);
    const target = rowsIdx[rowsIdx.length - 1];
    const over = [...lines];
    over[target.i] = `${target.l} 多出来的一格 |`;
    const vOver = shapeViolations({ role: '降范围登记表(突变①)', text: over.join('\n') });
    expect(vOver.bad.filter((b) => /破格/.test(b)).length, '突变①（多一格）必须被抓').toBe(1);

    const splitAt = rowsIdx[Math.floor(rowsIdx.length / 2)].i;
    const withBlank = [...lines.slice(0, splitAt), '', ...lines.slice(splitAt)];
    const vBlank = shapeViolations({ role: '降范围登记表(突变②)', text: withBlank.join('\n') });
    expect(vBlank.bad.filter((b) => /空行|行号集合/.test(b)).length, '突变②（表中间空行）必须被抓').toBeGreaterThan(0);
    // 未突变的原文必须干净 ⇒ 证明上面两处红是突变造成的，不是这条判据本身恒红
    expect(shapeViolations({ role: '降范围登记表(原文)', text: regDoc.text }).bad, '原文必须全干净').toEqual([]);
  });

  it('★ BLOCKER-1：两份权威文档的**正文**里不许留未填占位符（`%d` / `@CAPS@`）', () => {
    for (const d of docs) {
      const hits = unfilledPlaceholders(d.text);
      expect(hits, `${d.role} 正文里的未填占位符（本批 v3.78 那两处 %d 就是这一族）：${JSON.stringify(hits)}`).toEqual([]);
    }
    console.log(`[未填占位尺] 台账 ${ledger.text.split('\n').length} 行 / 降范围表 ${regDoc.text.split('\n').length} 行 · 两侧命中均为 0`);
  });

  it('★ BLOCKER-1 正反对照：残块放回会红，命令串里的 `%h %s` 不许假红', () => {
    // 反面对照用**本批真实踩过的形状**（v3.78 写进台账的那一行的原样），不是随手编的样本
    const residue = '`sha256(16)` `80017d990b1dec9f`、%d 行 / %d 字节，**围栏正文逐字节回读 == 原件**';
    expect(unfilledPlaceholders(residue).map((h) => h.token), '缺陷放回必须抓到两枚').toEqual(['%d', '%d']);
    const atForm = '计数写成了 @CAPS@ 模板槽';
    expect(unfilledPlaceholders(atForm).map((h) => h.token), '@CAPS@ 槽同族，必须一起抓').toEqual(['@CAPS@']);
    // 正面对照一：行内码里的格式串是**命令语法**，不是残块 ⇒ 判据不许把整类 `%x` 当债（那会假红 12 处）
    expect(unfilledPlaceholders('提交信息：`git log --format=\'%h %s\'`'), '行内码里的格式串不该认领').toEqual([]);
    // 正面对照二：代码围栏里的 shell 同理
    const fenced = ['前文', '```bash', 'local_size=$(stat -f%z "$f" || stat -c%s "$f")', 'date +%m%d', '```', '后文'].join('\n');
    expect(unfilledPlaceholders(fenced), '围栏内的命令不该认领').toEqual([]);
    // 围栏状态必须真的在切：围栏**之后**的残块要能被看见（否则"剥围栏"会变成一块永久遮罩）
    expect(unfilledPlaceholders(`${fenced}\n尾部：%d 字节未填`).map((h) => h.token), '围栏外的残块必须仍然看得见').toEqual(['%d']);
  });

  it('★ MAJOR-2：降范围表的条数在两份文档里必须与**真表现量**相等，行号引用不许指空', () => {
    expect(regNums, '编号必须连续 1..N（断号/重号会让"第 N 条"引用失去意义）').toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    const heading = regDoc.text.split('\n').filter((l) => HEADING_CITE.test(l));
    expect(heading.length, '登记表标题里的条数载体必须恰好 1 处（0 处＝这条对撞被删掉了）').toBe(1);
    expect(Number((heading[0].match(HEADING_CITE) as RegExpMatchArray)[1]), '表内自述条数 ≠ 真数出来的行数').toBe(N);

    const carriers = ledger.text.split('\n').filter((l) => COUNT_CITE.test(l));
    expect(carriers.length, '台账里"条数"引用必须恰好 1 处：多出来＝有第二个手抄载体没被登记').toBe(1);
    expect(Number((carriers[0].match(COUNT_CITE) as RegExpMatchArray)[1]), `台账 §0.5 引用的条数 ≠ 真表行数（现量：真表 ${N} 行）`).toBe(N);

    const refs = registryRowRefs(ledger.text);
    expect(refs.length, '台账里的行号引用必须数得到（0 处 ⇒ 下面那条断言是恒真）').toBeGreaterThan(0);
    const dangling = refs.filter((x) => x.nums.some((n) => n < 1 || n > N));
    expect(dangling, `这些"降范围…第 N 条"引用指向不存在的行（N 必须在 1..${N}）：${JSON.stringify(dangling)}`).toEqual([]);
    console.log(`[条数对撞] 真表 ${N} 行 · 表内标题 ${N} · 台账引用 ${Number((carriers[0].match(COUNT_CITE) as RegExpMatchArray)[1])} · 行号引用 ${refs.length} 处/最大 ${Math.max(...refs.flatMap((x) => x.nums))}`);
  });

  it('★ MAJOR-2 正反对照：把陈旧条数与越界行号放回，两条断言必须各自红', () => {
    const staleLedger = ledger.text.replace(COUNT_CITE, `${N - 1} 条「主动不做`);
    const carriers = staleLedger.split('\n').filter((l) => COUNT_CITE.test(l));
    expect(Number((carriers[0].match(COUNT_CITE) as RegExpMatchArray)[1]), '陈旧载体放回必须与真行数不等').not.toBe(N);
    // 删除载体不是"通过"：断言用的是**出现次数 === 1**，0 处同样红（上面那条已钉）
    expect(staleLedger.split('\n').filter((l) => COUNT_CITE.test(l)).length, '突变只改数字、不许顺手改变体数').toBe(1);

    const refs = registryRowRefs(ledger.text);
    const badRef = `${REG_ANCHOR}表第 ${N + 1} 条`;
    const injected = registryRowRefs(badRef);
    expect(injected.length, '对照样本必须真的产出一条引用，否则"越界"断言在测空气').toBe(1);
    expect(injected[0].nums[0] > N, `${badRef} 这种引用必须落在 1..${N} 之外`).toBe(true);
    expect(refs.length, '原文的引用集合非空 ⇒ 突变那条与原文同一把谓词').toBeGreaterThan(0);
  });

  it('★ v3.80（复核 #21 BLOCKER-1）／v3.81（复核 #22 BLOCKER-1）被证否的那句以"断言形"留在台账里 ⇒ 必须**就近**带收回标记', () => {
    /**
     * 本批立的病（B197：读数旁边的话没有尺管着）在我自己交付的同一批里第 5 次现形：
     *   v3.79 只在 v3.78 那一行上划了线，而**同一句话**还留在 v3.77 块、v3.76 结转句、
     *   §9 **B187 行（= 缺陷账唯一出处）** 与附录 v3.77 行上，其中 B187 的追记开头还写着"不动口径"。
     *   第三人只读 §9 就会把这条已被扫出来的结论拿走 ⇒ 所以这条不是排版洁癖，是**唯一出处必须自洽**。
     */
    const hits = unretractedRefutations(ledger.text);
    expect(hits, `这些**断言句**没有被就地收回（就近配对：包住它的划线对 / 同一格 120 字内的标记）：${JSON.stringify(hits)}`).toEqual([]);
    expect(unretractedRefutations(regDoc.text), '降范围表同理').toEqual([]);
    /**
     * ★ v3.81（B200 那一刀的连带处置）：这里原来钉的是「台账里必须**还留着**一句多断言行」——
     *   而我把 §9 B187 行那句残留断言就地改写掉之后，"多句行"当场归零，这条**下限被自己的改进消灭了**
     *   （本仓老规矩：棘轮下限不许钉在"我还没修"的那个量上 ⇒ 红了要换锚，不是把数字改小）。
     *   ⇒ 换锚：分母只**打印**不钉死；配对规则本身的牙交给下面那三格合成证人（它们与文档当前内容无关，
     *     我把收回全部撤掉也会红、把收回写规范也不会假红）。
     */
    // 分母（"断言形还有几处"）不在这里打印：它和未收回数一起进 `[V80-READINGS]` 现量行（那里是唯一载体），
    // 这一格只管两件事——**未收回必须为 0**，以及下面那三格合成证人证明配对规则有牙。
    // 正面对照：把收回标记逐个摘掉 ⇒ 同一条必须红（证明"标记"这件事有牙，不是靠运气）
    for (const mark of RETRACT_MARKS) {
      const withMark = `前文 ⇒ 本对照的分辨率实测为"≤120s 的整轴位移检不出"（降范围第 48 条）${mark} 已作废 ${mark}`;
      expect(unretractedRefutations(withMark), `带 ${mark} 的行不该被报`).toEqual([]);
      // ★ 这一支是本格第二次自纠：一句断言配一个标记才放行，两句断言只有一个标记必须红
      expect(unretractedRefutations(`前文 分辨率实测"A 检不出" ${mark} 分辨率实测"B 检不出"`),
        `一个 ${mark} 盖不住两句断言`).toHaveLength(1);
      const bare = `前文 ⇒ 本对照的分辨率实测为"≤120s 的整轴位移检不出"（降范围第 48 条）`;
      expect(unretractedRefutations(bare).length, `摘掉标记后必须被抓（${mark} 那一族）`).toBe(1);
    }
    /**
     * ★ v3.81（复核 #22 BLOCKER-1）三格新证人：v3.80 那版只**数**标记，所以"标记离得远"能过关。
     *   复核在真实 §9 B187 行上量到的正是这一族（两句断言 / 两枚标记 / 第二句附近什么都没有）。
     */
    const A = '分辨率实测"≤120s 的整轴位移检不出"';
    // ① 远侧：两枚标记都贴着第一句 ⇒ 第二句必须被点名（这就是复核 #22 的形状，标记数=断言数）
    const far = `前文 ${A} 已作废 已作废 ${' filler '.repeat(60)} ${A}`;
    expect(unretractedRefutations(far).map((h) => h.at), '标记数与断言数相等、但第二句附近没有标记 ⇒ 必须红')
      .toHaveLength(1);
    expect(unretractedRefutations(far)[0].nearestMarkGap, '报出来的必须是"离得最近的那枚也有多远"').toBeGreaterThan(RETRACT_NEAR);
    // ② 跨格：标记在隔壁那一格 ⇒ 借来的收回不算（表格行里最常见）
    expect(unretractedRefutations(`| ${A} | 已作废 已作废 |`).length, '跨格借标记不许放行').toBe(1);
    // ③ 超大划线：把两句一起划进去也不许算"就地"（否则一条长划线就是万能通行证）
    const swallow = `~~${A}${' x'.repeat(120)}${A}~~`;
    expect(unretractedRefutations(swallow).length, '超过 200 字的划线对不构成本批要的"就地"').toBe(2);
    // ④ ★ v3.82（复核 #23 m4）：邻近但**没框住**的一句划线不许替本格断言背书
    //    （复核给的形状：划线划的是"另一条旧结论"，我这把尺当时会因为"距离够近"就放行）
    const nearby = `~~这句话是另一条旧结论被划掉了~~ 分辨率实测"≤120s 的整轴位移检不出"`;
    expect(unretractedRefutations(nearby).length, '划线没框住这句 ⇒ 这句仍然没收回（第 52 条写的就是"要包住"）').toBe(1);
    // 反面对照（同尺不许永远红）：正常包住一句的划线 ⇒ 放行
    expect(unretractedRefutations(`前文 ~~${A}~~（已作废）`), '包住断言的划线必须算收回').toEqual([]);
    // 反面对照：引用形（叙述"那句被我抄错"）不许被当成断言 ⇒ 否则改口本身会逼我再改口
    expect(unretractedRefutations('★ 改口：v3.78 那句"≤120s 的整轴位移检不出"是单侧结论写成双侧'), '引用形不该报').toEqual([]);
  });

  it('★ v3.80（复核 #21 MINOR-1）未闭合的代码围栏＝永久遮罩 ⇒ 两份权威文档必须先证明围栏成对', () => {
    for (const d of docs) {
      const n = fenceMarkers(d.text);
      expect(n % 2, `${d.role} 的代码围栏标记有 ${n} 个（奇数）⇒ "剥围栏"会把后半篇一起遮掉，本尺的"命中 0"就没意义了`).toBe(0);
    }
    // 正面对照：奇数围栏确实会遮掉后面的残块（这条把"遮罩"这件事钉成可复现的形状）
    const masked = ['正文 %d 一', '```', '正文 %d 二'].join('\n');
    expect(unfilledPlaceholders(masked).map((h) => h.line), '第二个 %d 被未闭合围栏遮掉 ⇒ 这正是本条要防的').toEqual([1]);
    expect(fenceMarkers(masked) % 2, '对照样本自己必须是奇数围栏（否则上面那条断言在测空气）').toBe(1);
  });

  it('★ v3.80（复核 #21 MINOR-2）槽位形状：`%(name)s` 与 `@slot@` 认领，`{{}}` 刻意不认领（实测是产品语法）', () => {
    for (const s of ['%(rows)s', '%(n)d', '@rows@', '@ROWS@', '%d']) {
      expect(findAll(UNFILLED, s).length, `形状 ${s} 必须被认成未填槽`).toBe(1);
    }
    // 反面对照：合法写法不许假红（百分号后跟中文/结尾、单个 @ 的邮箱、Handlebars 模板槽、Prisma 的 count({OR})）
    for (const benign of ['完成率 % 提升', '100%', 'a@b.com', '{{variable}}', 'count({OR})', '{N}']) {
      expect(findAll(UNFILLED, benign).length, `不该认领：${benign}`).toBe(0);
    }
    // 两份权威文档在扩形状之后仍然 0 命中（否则这次扩形状就是把别人的命令串判成债）
    for (const d of docs) expect(unfilledPlaceholders(d.text), d.role).toEqual([]);
    // 双花括号那一族只普查、不判定：现量必须报得出来，它就是"不认领"那条决策的分母
    const cb = placeholderCensus();
    expect(cb.doubleBrace, '双花括号槽若为 0，那"刻意不认领"就没有对象，这条决策是空的').toBeGreaterThan(0);
    console.log(`[双花括号普查] ${cb.doubleBrace} 处 · 只报不判（理由见降范围第 51 条）`);
  });

  it('★ v3.80（复核 #21 MINOR-4）分母"日期最新"必须等于 §0.5 引用的那条路径', () => {
    for (const d of docs) {
      const base = d.file.split('/').pop() as string;
      expect(citedInIndex(ledger.text, base), `${d.role} 选中的 ${base} 没出现在 §0.5 索引表里 ⇒ 尺读的与账面引用的不是一份`).toBe(true);
    }
    // 反面对照：换一个不存在的 basename ⇒ 必须认不出来（证明上面那条不是恒真）
    expect(citedInIndex(ledger.text, '交付目标与验收标准-1970-01-01.md'), '假名字必须不被引用').toBe(false);
  });

  it('★ v3.80（复核 #21 MA-5）台账引用的每个数都必须等于尺当场打印的数（双向对撞）', () => {
    const shape = shapeReadingLine(docs);
    const count = countReadingLine(regDoc, ledger.text);
    const cen = placeholderCensus();
    // ★ v3.85（B206）：这里**不再钉** `普查 ${cen.files} 份 md` 那个现量。理由与现量都在
    //   `censusFloorCited` 的注释里（一句话：v3.84 回填的 511 被本批之外的两次提交推到了 513，
    //   于是"账面逐字等于尺的打印"这件事由全仓最常被动的东西决定颜色）。
    //   现在钉的是**下限**，而"缩水必红"这条比原来的相等更强：它不看别人加了几个文件，只看扫到的集合有没有变小。
    const floor = censusFloorCited(ledger.text);
    const slot = `普查 ≥${floor} 份 md（下限＝台账历史引用最大值，非现量） · 正文 ${cen.proseTokens} · 两份之外正文 ${cen.outsideProse}`
      // ★ v3.81：这三个数原来是手抄的（v3.79 抄的 510/18/6 插完 banner 就漂），今天再把**收回配对那一族**与
      //   双花括号普查一起并进来 ⇒ 锚点行的**名字**带着它诞生那一批的版本号（V80），**内容**随批次增长。
      //   为什么不改名字：历史行里引用过 `[V80-READINGS]` 的载体有 5 处，改名会把历史改成假的。
      + ` || 断言形 ${findAll(REFUTED_ASSERTION, ledger.text).length} 处/未收回 ${unretractedRefutations(ledger.text).length + unretractedRefutations(regDoc.text).length} 处`;
    // ★ 三项"跨全部文档普查、不判定"的数（现量份数 / 不剥码命中 / 双花括号处数）从 v3.85 起**只上屏**：
    //   它们既不是判据要的相等关系、又会被任何一份 md 的增删挪动 ⇒ 钉进逐字对撞等于给自己造一台假红发生器。
    console.log(`[现量上屏] ${shape} || ${count} || ${slot}`
      + ` 〔只上屏不入库：现量份数 ${cen.files} · 不剥码 ${cen.rawTokens} token/${cen.rawLines} 行 · 双花括号 ${cen.doubleBrace} 处〕`);
    // 台账必须**逐字**带上这三行现量（带锚点 [V80-READINGS]）；不带上就是"手抄一份数字进散文"那一族
    expect(ledger.text.includes(`[V80-READINGS] ${shape} || ${count} || ${slot}`),
      '台账里没有本尺当场打印的现量行 ⇒ 账面数字与尺脱钩（v3.79 的 768/30/49 就是这么漂的）').toBe(true);
    // 分母非空 + 现量本身自洽：两侧 bad 必须为 0，否则这条对撞是在为一份坏文档背书
    for (const d of docs) expect(shapeViolations(d).bad, d.role).toEqual([]);
    expect(cen.proseTokens, '扩形状之后两份之外的正文命中也必须为 0').toBe(0);
    // ★ 下限这一支要有牙：现量**低于**账面引用的下限就红（＝尺扫到的集合变小 = 尺瞎了），
    //   而这正是原来那个"相等"pin 里唯一真正想判的那一半。
    expect(cen.files, `普查扫到的 md 份数低于台账引用的下限 ${floor} ⇒ 尺的分母缩水（先疑尺，别先疑文档）`)
      .toBeGreaterThanOrEqual(floor);
    // 正面对照（证明上面那条不是摆设）：把下限抬到现量之上 ⇒ 同一条判据必须判它不合格
    expect(cen.files >= censusFloorCited('假台账：普查 ≥999999 份 md'), '分母缩水的形状必须能被这条判据表达')
      .toBe(false);
    // 反面对照：台账里一处引用都没有 ⇒ 不许静默按 0 放过（那是"没有分母"顶掉指控那一族）
    expect(() => censusFloorCited('一份引用都没有'), '零引用必须当场炸').toThrow();
  });
});
