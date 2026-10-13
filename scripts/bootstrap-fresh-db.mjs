#!/usr/bin/env node
/**
 * 从零 bootstrap 一个**全新空库**到"可部署状态"（④ 能交付 · 闭 B212 的可执行出口）
 *
 * ★ 为什么需要它：`prisma migrate deploy` 在**全新空库**上建不出库（B212）——
 *   `FabricProfile` 的 `CREATE TABLE` 在**任何一条迁移里都不存在**（全仓 grep 零命中），
 *   它是当年 `db push` 直接建出来的 ⇒ 迁移历史天生不完整，第 N 条 ALTER 就撞缺表。
 *   这不是"补一条迁移"能救的（补了也会和既有历史打架），业界标准做法是**基线（baseline）**：
 *   空库先按 schema 建出来，再把既有迁移**逐条标记为已应用**，从此以后 `migrate deploy` 正常可用。
 *
 * ★ 适用范围要说死：**只用于全新空库**（新环境、CI、克隆演练）。
 *   已有数据的生产/测试库**不许跑它** —— 脚本自带硬闸：目标库里只要有一张表就立刻退出。
 *
 * 用法：node scripts/bootstrap-fresh-db.mjs --dbname <新库名> [--seed] [--keep]
 *   --seed 会接着跑 `seed:base` + `seed-company-sim`（复现路径见 docs/模拟数据构造说明-2026-09-27.md）
 *   默认跑完顺手 `dropdb`（演练用）；要留着看就加 --keep
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const has = (name) => argv.includes(`--${name}`);

const dbName = flag('dbname');
if (!dbName || !/^[a-z0-9_]+$/i.test(dbName)) {
  console.error('ABORT: --dbname <新库名> 必填（只允许字母数字下划线）');
  process.exit(2);
}

const env = loadEnvForScript(R);
const url = env.url || env.DATABASE_URL || '';  // loadEnvForScript 返回的是 { url, … }
const m = url.match(/^(postgres(?:ql)?:\/\/[^@]+@[^/]+\/)([^?]+)(\?.*)?$/);
if (!m) { console.error('ABORT: DATABASE_URL 解析失败（只打印形状，不打印值）'); process.exit(2); }
const targetUrl = `${m[1]}${dbName}${m[3] || ''}`;
const adminUrl = url.split('?')[0];
// ★ psql 不认 `?schema=`（Prisma 才用它）⇒ 连 psql 一律剥掉 query（v3.162 踩过同一坑）
const targetPsql = targetUrl.split('?')[0];

const psql = (db, sql) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-d', db, '-c', sql],
  { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db } }).trim();
const psqlVal = (sql) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-d', adminUrl, '-c', sql],
  { encoding: 'utf8', env: { ...process.env } }).trim();
const prisma = (args) => execFileSync('npx', ['prisma', ...args], {
  cwd: join(R, 'server'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DATABASE_URL: targetUrl },
});

function step(msg) { console.log(`  · ${msg}`); }

async function main() {
  // ---- 0) 硬闸：目标必须是"不存在或全空"的库 ----
  const exists = psqlVal(`select count(*) from pg_database where datname='${dbName}'`) === '1';
  if (exists) {
    const n = psql(targetPsql, `select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not like '\\_prisma%'`);
    if (Number(n) > 0) { console.error(`ABORT: 目标库 ${dbName} 已有 ${n} 张表 ⇒ 本脚本只服务全新空库（生产/在用的库不许跑）`); process.exit(2); }
    step(`目标库存在且无产品表 ⇒ 继续（${dbName}）`);
  } else {
    // ★ owner 必须是应用角色，否则 PG15 下应用用户建不了表（v3.161 实测踩过：permission denied for schema public）
    const role = m[1].split('//')[1].split(':')[0];
    execFileSync('createdb', ['-O', role, dbName], { env: { ...process.env, PGDATABASE: adminUrl } });
    step(`已建空库 ${dbName}（owner=${role}）`);
  }
  const who = psql(targetPsql, 'select current_database()');
  if (who !== dbName) { console.error(`ABORT: 连到的库是 ${who}，不是 ${dbName}`); process.exit(2); }

  // ---- 1) 按 schema 建表（v3.161 已证：修完两个索引后与现库产品对象差 0）----
  const pushOut = prisma(['db', 'push', '--skip-generate', '--accept-data-loss']);
  const tables = Number(psql(targetPsql, `select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not like '\\_prisma%'`));
  step(`db push 完成 ⇒ 产品表 ${tables} 张${pushOut.includes('already in sync') ? '（already in sync）' : ''}`);
  if (tables < 200) { console.error(`ABORT: 只建出 ${tables} 张表，不像完整 schema`); process.exit(1); }

  // ---- 2) 把既有迁移逐条标记为已应用（= 基线）----
  const dir = join(R, 'server', 'prisma', 'migrations');
  const names = readdirSync(dir).filter((d) => /^\d{8,14}_./.test(d) && existsSync(join(dir, d, 'migration.sql'))).sort();
  // ★ `db push` 建出来的库**没有迁移簿记表**（它是 migrate 的账本）⇒ 先探再读，别假设它在
  const hasLedger = psql(targetPsql, "select count(*) from information_schema.tables where table_schema='public' and table_name='_prisma_migrations'") === '1';
  const already = new Set(hasLedger ? psql(targetPsql, 'select migration_name from "_prisma_migrations"').split('\n').filter(Boolean) : []);
  step(`迁移簿记表${hasLedger ? '已存在' : '不存在（db push 不建它）'} ⇒ 已应用 ${already.size} 条`)
  let marked = 0;
  for (const n of names) {
    if (already.has(n)) continue;
    try { prisma(['migrate', 'resolve', '--applied', n]); marked += 1; }
    catch (e) { console.error(`ABORT: 标记 ${n} 失败：${String(e.stdout || e.message).slice(0, 200)}`); process.exit(1); }
  }
  step(`标记 ${marked} 条迁移为已应用（历史共 ${names.length} 条）`);

  // ---- 3) 判决：直接跑一次 `migrate deploy`（那才是部署真正做的事），并回读簿记表 ----
  const dep = prisma(['migrate', 'deploy']);
  const applied = Number(psql(targetPsql, 'select count(*) from "_prisma_migrations"'));
  const clean = /No pending migrations to apply|already in sync/i.test(dep);
  console.log('\n──────── 判决 ────────');
  console.log(`migrate deploy：${dep.split('\n').filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 240)}`);
  console.log(`簿记表已应用行数 = ${applied} / 历史迁移 ${names.length} 条`);
  const ok = clean && applied === names.length;
  console.log(ok
    ? `✓ B212 的出口成立：新库经 bootstrap 后 \`migrate deploy\` 报"无待应用"，且 ${applied} 条迁移都在账 ⇒ 后续升级可正常走迁移`
    : `✗ 判决不成立（clean=${clean} applied=${applied} vs ${names.length}）⇒ B212 不算闭`);

  // ---- 4) 可选：接着铺走查数据集（v3.162 已证这条路跑得通）----
  if (ok && has('seed')) {
    execFileSync('npm', ['run', 'seed:base'], { cwd: join(R, 'server'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: targetUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    step('seed:base 完成');
    execFileSync('npx', ['tsx', 'scripts/seed-company-sim.ts'], { cwd: join(R, 'server'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: targetUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    step('seed-company-sim 完成');
    const sim = Number(psql(targetPsql, `select count(*) from "Order" where id like 'SIM-%'`));
    console.log(`✓ 演示集已铺：SIM 订单 ${sim} 张`);
  }

  if (!has('keep')) {
    execFileSync('dropdb', [dbName], { env: { ...process.env } });
    console.log(`\n· 演练库 ${dbName} 已 dropdb 回收；现库 ${m[2]} 未被连接（每步都断言了 current_database）`);
  } else {
    console.log(`\n· 保留 ${dbName}（--keep）`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('ABORT:', e && e.message ? e.message.slice(0, 300) : e); process.exit(1); });
