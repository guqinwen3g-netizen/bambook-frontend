#!/usr/bin/env node
/**
 * migration-reversibility-census.mjs —— 只读普查：待迁移的每一句 DDL 能不能反向执行
 *
 * 为什么需要：
 *   部署清单 §四（回退）原来挂着一条「31/32 条待迁移的可逆性**没有逐条核**」——
 *   那意味着"出事能不能退回去"这件事当时没有分母。本脚本把分母做出来：
 *   逐文件、逐**语句**分类，并单独点名**会造成数据丢失**的那些（回退只能靠备份）。
 *
 * ★ v3.212 起：分类规则与反向 DDL 生成**抽进 `scripts/lib/migration-sql.mjs`**，
 *   与本仓那份回滚演练件（`drill-migration-roundtrip.mjs`）**共用同一份实现**。
 *   原来两处各写一份的话，"普查说可逆 N 句"与"演练真正执行的语句"就可能不是同一批形状。
 *   ⇒ 本脚本的输出与抽库前**逐字相同**（`--json` 里也保持原字段集，不多印 `pairs`/`reverse`）。
 *
 * 口径（写清楚，免得被读成"可逆 = 万事大吉"）：
 *   · 「可逆」= 能用一句反向 DDL 退回去；**不代表退回去之后数据还是迁移前那份**
 *     （迁移中间写入的业务行不在任何反向 DDL 里）。
 *   · 「需备份」= 该句本身就会丢数据（DROP COLUMN / DROP TABLE）或改数据（UPDATE/INSERT/DELETE），
 *     反向 DDL 复现不出来 ⇒ 回退必须走备份。
 *   · 本脚本**只读**，不连库、不执行任何 SQL。
 *
 * 用法：node scripts/migration-reversibility-census.mjs [--since=20260901000000] [--json]
 *   默认 --since 取生产 2026-09-18 远程实测的「最后一条已应用」：20260901000000
 */
import { censusMigrations } from './lib/migration-sql.mjs';
import { INVENTORY_SQL } from './lib/drill-db.mjs';

const SINCE = (process.argv.find((a) => a.startsWith('--since=')) || '--since=20260901000000').split('=')[1];
const AS_JSON = process.argv.includes('--json');
const ROOT = process.cwd();

const { all, perMigration, notNullNoDefault, ungenerated, totals } = censusMigrations(ROOT, SINCE);
const pending = all.filter((name) => name.slice(0, 14) > SINCE);
const lossMigs = perMigration.filter((m) => m.risky.some((r) => r.kind === '数据丢失' || r.kind === '改数据' || r.kind === '缺文件'));

/* ── 反向 DDL 生成（--emit-reverse）────────────────────────────────────────────
 * 为什么是"当场生成"而不是仓里存一份 down.sql：存一份会跟着主线腐烂（迁移天天在加）。
 * 生成规则只认能确定的形状，认不出的**不猜**——直接以注释形式打出来，让人看到"这里没生成"。
 * 顺序：迁移倒序 + 迁移内语句倒序（后面的对象先删，依赖才不会挡着）。
 * ⚠️ 不生成 `UPDATE` 的反向（回填改的是新建列，随 DROP 一起走；真要还原得靠备份）。
 */
if (process.argv.includes('--emit-reverse')) {
  const out = ['-- 反向 DDL（由 scripts/migration-reversibility-census.mjs --emit-reverse 当场生成，不落盘）',
    `-- 覆盖：--since=${SINCE} 之后的 ${pending.length} 条迁移；**按迁移倒序 / 语句倒序**执行`,
    '-- 用法：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <本文件>',
    '-- ⚠️ 认不出的语句不会出现在这里（只以注释点名）——那几处要人看。'];
  for (const m of [...perMigration].reverse()) {
    if (!m.pairs) continue;
    out.push(`\n-- ── ${m.name} ──`);
    for (const p of [...m.pairs].reverse()) {
      if (p.rev) out.push(p.rev);
      else out.push(`-- ⚠️ 未生成反向（形状不认或本就不该反向）：${p.stmt.length > 110 ? `${p.stmt.slice(0, 110)}…` : p.stmt}`);
    }
    // 台账同步：这条迁移的记录也要撤掉，否则 migrate deploy 认为它已应用
    out.push(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${m.name}';`);
  }
  console.log(out.join('\n'));
  process.exit(0);
}

/* ── 结构快照 SQL（--emit-inventory）──────────────────────────────────────────
 * 用途：回滚演练里做"退前 / 退后 / 再前滚"三态对撞——把对象清单**排序后**打印成行，两边 diff 即可。
 * 为什么放进本脚本：取证用的 SQL 不能只躺在 /tmp（本仓 B194 那类债）；放这儿第三人能复跑。
 * ★ v3.212：那份 SQL 的真源在 `lib/drill-db.mjs`（演练件用的就是它），这里只是换个出口印出来。
 * 只在 public schema 上取：表 / 列（含类型·可空·默认）/ 索引 / 约束定义 / 序列。
 */
if (process.argv.includes('--emit-inventory')) {
  console.log(INVENTORY_SQL);
  process.exit(0);
}

if (AS_JSON) {
  const lean = perMigration.map((m) => ({ name: m.name, statements: m.statements, buckets: m.buckets, risky: m.risky }));
  console.log(JSON.stringify({ since: SINCE, pending: perMigration.length, totals, lossMigs: lossMigs.map((m) => m.name), notNullNoDefault, perMigration: lean }, null, 2));
} else {
  console.log(`\n=== 待迁移可逆性普查（只读；--since=${SINCE}）===`);
  console.log(`待迁移 ${perMigration.length} 条 · 语句分类合计：${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log('\n仅靠反向 DDL 退不回去（必须走备份）的迁移：');
  if (!lossMigs.length) console.log('  （无）');
  for (const m of lossMigs) {
    console.log(`  ⚠️ ${m.name}`);
    for (const r of m.risky.filter((x) => x.kind === '数据丢失' || x.kind === '改数据' || x.kind === '缺文件')) {
      console.log(`     [${r.kind}] ${r.stmt}`);
    }
  }
  const human = perMigration.filter((m) => m.risky.some((r) => r.kind === '要人看'));
  console.log('\n要人看（不在已知形状里或改类型/空值/默认值）：');
  if (!human.length) console.log('  （无）');
  for (const m of human) {
    console.log(`  · ${m.name}`);
    for (const r of m.risky.filter((x) => x.kind === '要人看')) console.log(`     ${r.stmt}`);
  }
  console.log('\n加非空列且无默认值（目标表非空 ⇒ 这句会直接失败；与可逆性无关，是能不能跑通）：');
  if (!notNullNoDefault.length) console.log('  （无）');
  for (const r of notNullNoDefault) console.log(`  ⚠️ ${r.name}\n     ${r.stmt}`);
  console.log('\n逐条（分类计数）：');
  for (const m of perMigration) {
    console.log(`  ${m.name} — ${m.statements} 句：${Object.entries(m.buckets).map(([k, v]) => `${k}×${v}`).join(' ')}`);
  }
}
