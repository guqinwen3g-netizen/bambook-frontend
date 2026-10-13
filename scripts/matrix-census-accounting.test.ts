/**
 * §11 第 4 条的前置件自查：`docs/变异矩阵-覆盖率普查` 的分档账必须与逐格表一致。
 *
 * 立账现场（v3.198）：同一份文档里三处并存地互相矛盾 ——
 *   逐格表（展开合并行后 42 格）＝ 已覆盖 32 / 未测 4 / 已知缺陷 2 / ◐ 4；
 *   「一、总览」的**结算方式那一行**还写着"未测 4"（那四格 v3.182 已改判 ◐ ⇒ 同一批格被数两次）；
 *   而覆盖率那句还写着"未测 8"（v3.182 之前的口径）。
 * ⇒ 这张表是"每格必须有结论"那条判据的**本体**，它自己对不上账，第 4 条就永远只能靠人肉复查。
 *
 * ★ 本尺只做**结构对账**，不判任何一格的结论对不对（那是取证纪律，见那份文档开头）。
 * ★ 每一格都要能红：维度行的四列相加必须等于它自己标题里的格数（这一条专抓"重复计入"），
 *   合计行的四列必须等于逐格表的机械计数（这一条专抓"口径漂移"）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DOC = readFileSync(new URL('../docs/变异矩阵-覆盖率普查-2026-09-26.md', import.meta.url), 'utf8');
const BUCKETS = ['已覆盖', '未测', '已知缺陷', '◐ 部分覆盖'] as const;

type Cell = { id: number; variant: string; verdict: string };

/** 逐格表：`| # | 变体 | 结论 | … |`，其中 `#` 允许写成合并区间（`21-24` 表示四格同一结论）。 */
function parseCells(): Cell[] {
  const cells: Cell[] = [];
  for (const line of DOC.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const c = line.split('|').map((x) => x.trim().replace(/\*/g, ''));
    if (c.length < 5) continue;
    const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(c[1]);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (a < 1 || a > 42 || b < a) continue;
    for (let id = a; id <= b; id++) cells.push({ id, variant: c[2], verdict: c[3] });
  }
  return cells;
}

function bucketOf(verdict: string): string {
  for (const b of BUCKETS) if (verdict.startsWith(b)) return b;
  return `?无法归档(${verdict.slice(0, 18)})`;
}

/** 维度表那一块：返回 `{ 维度名: [已覆盖, 未测, 已知缺陷, ◐] }`（合计行单列）。 */
function parseDimensions(): { rows: Array<{ name: string; nums: number[]; declared: number | null }>; total: number[] | null } {
  const lines = DOC.split('\n');
  const h = lines.findIndex((l) => /^\| 维度 \| 已覆盖 \| 未测 \| 已知缺陷 \|/.test(l));
  expect(h, '找不到「一、总览」维度表的表头（表形状变了 ⇒ 本尺要先红，不许静默不数）').toBeGreaterThan(-1);
  const rows: Array<{ name: string; nums: number[]; declared: number | null }> = [];
  let total: number[] | null = null;
  for (let i = h + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('| ')) break;
    const c = l.split('|').map((x) => x.trim().replace(/\*/g, ''));
    const name = c[1];
    const declared = /（(\d+)）/.exec(name);
    const nums = c.slice(2, 2 + BUCKETS.length).map((x) => Number(x.replace(/[（(].*/, '').trim()));
    if (!nums.every((n) => Number.isFinite(n))) continue;
    if (/^合计/.test(name)) total = nums;
    else rows.push({ name, nums, declared: declared ? Number(declared[1]) : null });
  }
  return { rows, total };
}

describe('变异矩阵普查 · 分档账与逐格表必须一致（§11 第 4 条前置件）', () => {
  const cells = parseCells();

  it('逐格表展开合并行后正好 42 格、编号 1..42 连续不重', () => {
    expect(cells.length, `实得 ${cells.length} 格`).toBe(42);
    const ids = cells.map((c) => c.id).sort((x, y) => x - y);
    expect(ids, '编号必须连续且无重复（缺号＝有一格没人判，重号＝一格被数两次）').toEqual(
      Array.from({ length: 42 }, (_, i) => i + 1),
    );
  });

  it('每格结论必须落进四档之一（"未测/不适用/已知缺陷"三选一的扩展：◐ 部分覆盖要单独一档，不许混进已覆盖）', () => {
    const bad = cells.filter((c) => bucketOf(c.verdict).startsWith('?'));
    expect(bad, `这些格的结论归档不了：${bad.map((c) => `#${c.id}=${c.verdict.slice(0, 20)}`).join(' · ')}`).toEqual([]);
  });

  it('维度表每一行：四列相加必须等于它标题里声明的格数（专抓"同一批格被记进两档"）', () => {
    const { rows } = parseDimensions();
    expect(rows.length, '维度行数少于 7 ⇒ 表被改坏，本尺就不数了').toBeGreaterThanOrEqual(7);
    for (const r of rows) {
      expect(r.declared, `维度行「${r.name}」标题里没有（N）格数声明 ⇒ 无法验相加`).not.toBeNull();
      const sum = r.nums.reduce((a, b) => a + b, 0);
      expect(sum, `维度行「${r.name}」四列相加 ${sum} ≠ 标题声明 ${r.declared} ⇒ 有格被重复计入或漏计（本仓 v3.198 就抓到过：结算方式那行把已改判 ◐ 的四格还留在"未测"）`).toBe(r.declared);
    }
  });

  it('维度表合计行 = 逐格表机械计数（专抓口径漂移：改了一档忘了另一档）', () => {
    const { total } = parseDimensions();
    expect(total, '找不到合计行').not.toBeNull();
    const tally = BUCKETS.map((b) => cells.filter((c) => bucketOf(c.verdict) === b).length);
    expect(total, `合计行写的是 [${total}]，逐格表机械数是 [${tally}]（顺序：${BUCKETS.join('/')}）`).toEqual(tally);
    expect(total!.reduce((a, b) => a + b, 0), '合计四列相加必须等于 42 格').toBe(42);
  });

  it('覆盖率那句不许再用旧口径（同一份文档里两处结论打架＝第 4 条没法签）', () => {
    const tally = BUCKETS.map((b) => cells.filter((c) => bucketOf(c.verdict) === b).length);
    // 带"就地更正"标记的行是在**引用**旧写法（本仓规矩：收回断言要留在被重述那一行），允许出现旧数字；
    // 没带标记的行就是现行口径，必须与逐格表对上。
    const staleLines = DOC.split('\n').filter((l) => /未测 \d+ \+ 已知缺陷 \d+ = \d+ 格/.test(l));
    const live = staleLines.filter((l) => !l.includes('就地更正'));
    expect(live, `这些行没有"就地更正"标记却写着旧分档：${live.map((l) => l.slice(0, 60)).join(' ｜ ')}`).toEqual([]);
    for (const l of staleLines) {
      const m = /未测 (\d+) \+ 已知缺陷 (\d+) = (\d+) 格/.exec(l)!;
      expect(Number(m[1]), `引用旧口径那行里的数字与逐格表差太远（写错了？）：未测 ${m[1]} vs ${tally[1]}`).toBeLessThanOrEqual(42);
    }
  });

  it('★ 本尺自己也要被证过：42 格里"未测 + ◐ + 已知缺陷"合起来那批无结论格，必须逐格点名（恒有分母）', () => {
    const open = cells.filter((c) => bucketOf(c.verdict) !== '已覆盖');
    expect(open.length, '无结论格数为 0 ⇒ §11 第 4 条的开发侧缺口清了，这条断言要**改写**而不是删掉（删了就没人盯"清零"这一步）').toBeGreaterThan(0);
    const ids = open.map((c) => c.id);
    expect(new Set(ids).size, '同格被点名两次').toBe(ids.length);
  });
});
