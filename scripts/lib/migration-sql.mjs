/**
 * migration-sql.mjs —— 「迁移语句怎么分类、怎么反向」的**唯一一份**实现
 *
 * 为什么要从 `scripts/migration-reversibility-census.mjs` 里抽出来：
 *   回滚演练件（`drill-migration-roundtrip.mjs`）要生成同一套反向 DDL ——
 *   两处各写一份的话，"普查说可逆 203 句"和"演练实际执行的语句"就可能不是同一批形状
 *   （本仓反复吃过的那族"一族多份并行实现"）。抽出来之后普查与演练**共用规则表**。
 *
 * 口径（与 census 原话一致）：
 *   · 「可逆」= 能用一句反向 DDL 退回去，**不代表退回去数据还是迁移前那份**；
 *   · 认不出的形状**不猜**，一律按「要人看」处理，且 `reverseOf` 返回 null（不生成）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = [
  { kind: '数据丢失', re: /^ALTER\s+TABLE\s+.*\bDROP\s+COLUMN\b/i, note: '丢该列全部数据 ⇒ 回退只能靠备份' },
  { kind: '数据丢失', re: /^DROP\s+TABLE\b/i, note: '整表连同数据一起没了 ⇒ 回退只能靠备份' },
  { kind: '改数据', re: /^(UPDATE|DELETE)\b/i, note: '反向写不唯一（取决于业务语义）⇒ 回退只能靠备份' },
  { kind: '改数据', re: /^INSERT\b/i, note: '插入行可在反向 DDL 里删掉，但"哪些是迁移插的"要靠备份定 ⇒ 也按备份口径走' },
  { kind: '可逆', re: /^CREATE\s+TABLE\b/i, note: '回退 = DROP TABLE（会连带丢掉迁移后写入的行 ⇒ 只有空表才无损）' },
  { kind: '可逆', re: /^ALTER\s+TABLE\s+.*\bADD\s+COLUMN\b/i, note: '回退 = DROP COLUMN（列数据会丢 ⇒ 只有该列没人写过才无损）' },
  { kind: '可逆', re: /^CREATE\s+(UNIQUE\s+)?INDEX\b/i, note: '回退 = DROP INDEX' },
  { kind: '可逆', re: /^DROP\s+INDEX\b/i, note: '回退 = 按被删那条迁移里的定义重建索引（定义在 git 历史里）' },
  { kind: '可逆', re: /^ALTER\s+TABLE\s+.*\bADD\s+CONSTRAINT\b/i, note: '回退 = DROP CONSTRAINT' },
  { kind: '可逆', re: /^ALTER\s+TABLE\s+.*\bDROP\s+CONSTRAINT\b/i, note: '回退 = 重建该约束（定义在本文件里）' },
  { kind: '可逆', re: /^ALTER\s+TABLE\s+.*\bRENAME\b/i, note: '回退 = 改回原名' },
  { kind: '要人看', re: /^ALTER\s+TABLE\s+.*\b(ALTER\s+COLUMN|SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL|SET\s+DEFAULT|DROP\s+DEFAULT|SET\s+NULLABLE)\b/i, note: '类型/空值/默认值的改动 ⇒ 反向要旧定义，本表不猜' },
  { kind: '要人看', re: /^(CREATE|ALTER)\s+(TYPE|EXTENSION|FUNCTION|TRIGGER|VIEW|SCHEMA)\b/i, note: 'Postgres 扩展对象，回退要旧定义 ⇒ 需人工确认' },
];

export const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** 语句里带引号/带换行，简单按 `;` 切开就够（这些迁移里没有函数体里的分号）。 */
export const splitStatements = (sql) => stripComments(sql).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const unq = (s) => (s.startsWith('"') ? s.slice(1, -1) : s);
export const qi = (name) => `"${name.replace(/"/g, '""')}"`;

/** 认得出形状才生成反向；认不出返回 null（**不猜**） */
export function reverseOf(stmt) {
  let m;
  if ((m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/i.exec(stmt))) {
    return `DROP TABLE IF EXISTS ${qi(unq(m[1]))};`;
  }
  if ((m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/i.exec(stmt))) {
    return `DROP INDEX IF EXISTS ${qi(unq(m[1]))};`;
  }
  if ((m = /^ALTER\s+TABLE\s+("?[\w]+"?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/i.exec(stmt))) {
    return `ALTER TABLE ${qi(unq(m[1]))} DROP COLUMN IF EXISTS ${qi(unq(m[2]))};`;
  }
  if ((m = /^ALTER\s+TABLE\s+("?[\w]+"?)\s+ADD\s+CONSTRAINT\s+("?[\w]+"?)/i.exec(stmt))) {
    return `ALTER TABLE ${qi(unq(m[1]))} DROP CONSTRAINT IF EXISTS ${qi(unq(m[2]))};`;
  }
  return null;
}

export const migrationsDirOf = (root) => join(root, 'server', 'prisma', 'migrations');

/**
 * 逐条迁移的语句分类 + 反向 DDL 计划（**内存里生成，不落盘**：存一份 down.sql 会跟着主线腐烂）。
 * @param root 仓根；@param since 基线（"生产最后一条已应用"），只统计 `name.slice(0,14) > since` 的
 */
export function censusMigrations(root, since) {
  const dir = migrationsDirOf(root);
  if (!existsSync(dir)) throw new Error(`找不到迁移目录：${dir}（请在仓根跑）`);
  const all = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const pending = all.filter((name) => name.slice(0, 14) > since);
  const perMigration = [];
  const notNullNoDefault = [];
  const ungenerated = [];
  for (const name of pending) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) {
      perMigration.push({ name, statements: 0, buckets: { '缺文件': 1 }, risky: [{ kind: '缺文件', stmt: '(migration.sql 不存在)', note: '目录存在但 SQL 缺失 ⇒ 部署会失败' }], reverse: [] });
      continue;
    }
    const stmts = splitStatements(readFileSync(file, 'utf8'));
    const buckets = {};
    const risky = [];
    const reverse = [];
    const pairs = [];
    for (const stmt of stmts) {
      const hit = RULES.find((r) => r.re.test(stmt));
      const kind = hit ? hit.kind : '要人看';
      const note = hit ? hit.note : '不在已知形状里 ⇒ 按"要人看"处理，别当可逆';
      buckets[kind] = (buckets[kind] || 0) + 1;
      if (kind !== '可逆') risky.push({ kind, stmt: stmt.length > 160 ? `${stmt.slice(0, 160)}…` : stmt, note });
      const rev = reverseOf(stmt);
      pairs.push({ stmt, rev });
      if (rev) reverse.push(rev);
      else ungenerated.push({ name, stmt: stmt.length > 140 ? `${stmt.slice(0, 140)}…` : stmt });
      if (/^ALTER\s+TABLE\s+.*\bADD\s+COLUMN\b/i.test(stmt) && /\bNOT\s+NULL\b/i.test(stmt) && !/\bDEFAULT\b/i.test(stmt)) {
        notNullNoDefault.push({ name, stmt: stmt.length > 160 ? `${stmt.slice(0, 160)}…` : stmt });
      }
    }
    perMigration.push({ name, statements: stmts.length, buckets, risky, reverse, pairs });
  }
  const totals = {};
  for (const m of perMigration) for (const [k, v] of Object.entries(m.buckets)) totals[k] = (totals[k] || 0) + v;
  return { dir, all, pending, perMigration, notNullNoDefault, ungenerated, totals };
}

/**
 * 倒序退回去的 SQL（迁移倒序 + 语句倒序），并把台账里那几条的记录撤掉
 * （否则 `migrate deploy` 认为已应用、不会重新跑 ⇒ "前滚"就成了假的前滚）。
 */
export function buildDownSql(perMigration, header = []) {
  const out = [...header];
  for (const m of [...perMigration].reverse()) {
    out.push(`\n-- ── ${m.name} ──`);
    for (const rev of [...m.reverse].reverse()) out.push(rev);
    out.push(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${m.name}';`);
  }
  return out.join('\n');
}
