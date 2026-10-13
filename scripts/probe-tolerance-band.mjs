// probe-tolerance-band.mjs —— 探针：证明"超短装容差没有按数量分档"
//
// 依据（真实合同，OCR 自 44 份销售/采购合同）：
//   1–999m ±5% · 1000–3000m ±3% · 3001–5000m ±2% · 5001m+ ±1%
//   采购侧另有 ±1%（"允许溢短装 1%"）
//
// 软件侧（`OrderLine.tolerancePercent Decimal @default(5)`）是**一个扁平百分比**。
//
// 本探针**不改库**：只读 `schema.prisma` 与 `allocationService.ts` 的**实际行为**，
// 并用一个"6000m 的单"演示：真实合同该给 ±1%，而系统默认给 ±5%。
//
// 用法：node scripts/probe-tolerance-band.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCHEMA = path.join(ROOT, 'server/prisma/schema.prisma');
const ALLOC = path.join(ROOT, 'server/src/shipping/allocationService.ts');

const results = [];
const ok = (n, c, d = '') => { results.push({ ok: c, n, d }); console.log(`  ${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

console.log('══ 探针：超短装容差是否按数量分档 ══\n');

// ① schema 里 tolerancePercent 的定义
const schema = fs.readFileSync(SCHEMA, 'utf8');
const m = schema.match(/tolerancePercent\s+(\S+)(\s+@default\(([^)]+)\))?/);
ok('OrderLine.tolerancePercent 存在', !!m, m ? `${m[1]} @default(${m[3] ?? '无'})` : '未找到');

// ② 分档表：搜真实规则里的分档数字是否出现在**生产代码**里
const alloc = fs.readFileSync(ALLOC, 'utf8');
const bands = [
  { label: '1–999m → ±5%', pat: /999/ },
  { label: '1000–3000m → ±3%', pat: /3000/ },
  { label: '3001–5000m → ±2%', pat: /5000/ },
  { label: '5001m+ → ±1%', pat: /5001/ },
];
const hits = bands.filter((b) => b.pat.test(alloc));
ok('allocationService 里有"按数量分档"的边界数字', hits.length === bands.length,
  hits.length === 0 ? '一个都没有 ⇒ 无分档逻辑' : `命中 ${hits.map((h) => h.label).join(' / ')}`);

// ③ 全仓搜分档边界（排除测试与本次文档）
const srcFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|__tests__|\.git/.test(p)) walk(p); }
    else if (/\.(ts|mjs)$/.test(e.name)) srcFiles.push(p);
  }
})(path.join(ROOT, 'server/src'));
let bandFiles = 0;
for (const f of srcFiles) {
  const s = fs.readFileSync(f, 'utf8');
  if (/999/.test(s) && /3000/.test(s) && /5000/.test(s) && /5001/.test(s)) { bandFiles++; console.log(`     ← ${path.relative(ROOT, f)}`); }
}
ok('生产代码里存在"按数量分档"的容差表', bandFiles > 0,
  bandFiles === 0 ? '零命中 ⇒ 真实合同的 ±5/3/2/1% 分档在系统里没有对应物' : `${bandFiles} 个文件`);

// ④ 用真实数量演示落差
console.log('\n── 落差演示（真实合同 vs 系统默认）──');
const cases = [
  { qty: 500, should: '±5%' },
  { qty: 2000, should: '±3%' },
  { qty: 4000, should: '±2%' },
  { qty: 6000, should: '±1%' },
];
for (const c of cases) {
  const sys = '±5%（OrderLine.tolerancePercent 默认）';
  const bad = c.should !== '±5%';
  console.log(`  ${c.qty}m：真实合同 ${c.should} · 系统默认 ${sys}${bad ? '  ← ★ 不符' : ''}`);
}
// ★ 不写死结论：按"真实分档"与"系统默认"逐档比较，算出实际不符的档数
const REAL_BANDS = [
  { max: 999, pct: 5 }, { max: 3000, pct: 3 }, { max: 5000, pct: 2 }, { max: Infinity, pct: 1 },
];
const SYS_DEFAULT = m ? Number((m[3] || '0').replace(/[^0-9.]/g, '')) : NaN;
const mismatched = cases.filter((c) => {
  const band = REAL_BANDS.find((b) => c.qty <= b.max);
  return band && band.pct !== SYS_DEFAULT;
});
ok('系统默认容差与真实合同一致（全档）', mismatched.length === 0,
  mismatched.length === 0 ? '全档一致' :
  `${mismatched.length}/${cases.length} 档不符（系统默认 ${SYS_DEFAULT}%）⇒ 例：6000m 的单系统允许 ±${SYS_DEFAULT}%（=±${6000 * SYS_DEFAULT / 100}m），真实合同只允许 ±1%（=±60m）`);

const bad = results.filter((r) => !r.ok).length;
console.log(`\n══ 结果：${results.length - bad} 通过 / ${bad} 失败 ══`);
console.log(bad > 0
  ? '⇒ 结论：**① 类缺口成立**（会让数字错：超容差出运会被放行）'
  : '⇒ 结论：无缺口');
process.exit(bad === 0 ? 0 : 1);
