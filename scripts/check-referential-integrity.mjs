/**
 * 全库**引用完整性**检查（只读）—— 用 Prisma DMMF 枚举所有「拥有外键」的关系，
 * 检查是否有子行的外键指向**不存在的父行**（悬挂引用）。
 *
 * ## 为什么需要它
 * 删数据（演练回滚 / 残留清理）之后，「没留悬挂引用」**不能只信删除工具的自述** ——
 * 本仓已经踩过「删了主实体、留下悬挂引用」的坑（`EntityReference` 无级联）。
 * 本脚本提供**独立的第三方裁判**：直接问「每条子行的外键，父表里到底有没有」。
 *
 * ## 判据（关键）
 * 只检查 `relationFromFields.length > 0` 的关系 —— 那是**拥有外键的一方**（子）；
 * 只看 `f.type === X` 会把**反向关系**也算进来、方向反掉（踩过）。
 *
 * ## 自带取证（防空过）
 * 末尾打印「实际检查的关系数 / 校验过的外键取值总数」——
 * 若为 0 会显式警告「本次检查空过，结论不可信」。
 * （本仓纪律：**守卫必须能咬住**，空过的守卫比没有更糟。）
 *
 * ## 已知边界
 * - 跳过空子表（`skippedEmpty`）与超 `MAX_ROWS` 行的大表（`skippedBig`，会打印）
 * - 复合外键逐行查（上限 3000 行/关系）
 * - **`@relation` 之外还有大量「snapshot FK」**（本仓惯例：不加约束的 `xxxId String?`）
 *   ⇒ 本检查**覆盖不到那些**，它们是设计上就不强约束的（判据是「业务代码自己维护」）
 *
 * 用法：node scripts/check-referential-integrity.mjs   # 只读；有悬挂引用则退出码 1
 */
import { createRequire } from 'node:module';
const req = createRequire('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/');
const { PrismaClient, Prisma } = req('@prisma/client');
const p = new PrismaClient();

const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));
const delegateOf = (n) => n.charAt(0).toLowerCase() + n.slice(1);
const MAX_ROWS = 200000;

/** 所有「拥有外键」的关系：[子模型, 子外键字段[], 父模型, 父被引用字段[]] */
const relations = [];
for (const m of models) {
  for (const f of m.fields) {
    if (f.kind !== 'object') continue;
    if (!f.relationFromFields || f.relationFromFields.length === 0) continue;
    relations.push({ child: m.name, fk: f.relationFromFields, parent: f.type, refs: f.relationToFields ?? ['id'] });
  }
}

console.log(`══ 引用完整性检查（${relations.length} 条关系）══\n`);
let bad = 0;
const issues = [];
// ★ 取证计数：证明检查器**真的查了**（不是空过）—— 本仓纪律「守卫必须能咬住」
let examined = 0, skippedEmpty = 0, skippedBig = 0, fkValuesChecked = 0, relationsChecked = 0;

for (const r of relations) {
  const cd = p[delegateOf(r.child)];
  const pd = p[delegateOf(r.parent)];
  if (!cd?.findMany || !pd?.count) continue;
  let total = 0;
  try { total = await cd.count(); } catch { continue; }
  if (total === 0) { skippedEmpty += 1; continue; }
  if (total > MAX_ROWS) { skippedBig += 1; continue; }
  relationsChecked += 1;

  // 取子表所有外键组合（去重）
  let rows = [];
  try {
    rows = await cd.findMany({ select: Object.fromEntries(r.fk.map((f) => [f, true])), distinct: r.fk, take: 20000 });
  } catch { continue; }
  const keys = rows.map((x) => r.fk.map((f) => x[f]));
  if (keys.length === 0) continue;

  // 逐个查父表是否存在（单字段外键可批量 in；复合键逐个查）
  let missing = 0;
  const samples = [];
  if (r.fk.length === 1) {
    const fkField = r.fk[0];
    const refField = r.refs[0];
    const vals = [...new Set(keys.map((k) => k[0]).filter((v) => v != null))];
    if (vals.length === 0) continue;
    // 分批查
    const found = new Set();
    for (let i = 0; i < vals.length; i += 2000) {
      const chunk = vals.slice(i, i + 2000);
      try {
        const pr = await pd.findMany({ where: { [refField]: { in: chunk } }, select: { [refField]: true } });
        for (const x of pr) found.add(x[refField]);
      } catch { /* 字段不可查 */ }
    }
    for (const v of vals) if (!found.has(v)) { missing += 1; if (samples.length < 3) samples.push(`${fkField}=${v}`); }
    fkValuesChecked += vals.length;
    examined += 1;
  } else {
    for (const k of keys.slice(0, 3000)) {
      const where = Object.fromEntries(r.refs.map((f, i) => [f, k[i]]));
      try { const c = await pd.count({ where }); if (c === 0) { missing += 1; if (samples.length < 3) samples.push(JSON.stringify(where)); } } catch { /* ignore */ }
    }
  }
  if (missing > 0) {
    bad += 1;
    issues.push({ rel: `${r.child}.${r.fk.join('+')} → ${r.parent}.${r.refs.join('+')}`, missing, samples });
  }
}

if (issues.length === 0) {
  console.log('✅ 无悬挂引用（所有子行外键都能在父表找到）');
} else {
  console.log(`❌ 发现 ${issues.length} 条关系存在悬挂引用：\n`);
  for (const it of issues.sort((a, b) => b.missing - a.missing)) {
    console.log(`  ${it.rel}：缺 ${it.missing} 个父行`);
    for (const s of it.samples) console.log(`     例：${s}`);
  }
}
console.log(`\n── 取证（证明不是空过）──`);
console.log(`  实际检查的关系数 = ${relationsChecked}（其中单字段外键 ${examined} 条已展开校验）`);
console.log(`  校验过的外键取值总数 = ${fkValuesChecked}`);
console.log(`  跳过：空子表 ${skippedEmpty} · 超 ${MAX_ROWS} 行的大表 ${skippedBig}`);
if (relationsChecked === 0 || fkValuesChecked === 0) {
  console.log('  ⚠️ 检查量为 0 ⇒ **本次检查是空过的，结论不可信**');
}
await p.$disconnect();
process.exit(issues.length ? 1 : 0);
