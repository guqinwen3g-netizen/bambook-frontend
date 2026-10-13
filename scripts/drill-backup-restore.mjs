#!/usr/bin/env node
/**
 * drill-backup-restore.mjs —— ④ 交付能力件：**可重跑**的「备份 → 恢复到新库 → 逐项对撞」演练（B264）
 *
 * 为什么要写这一份：那条路此前**只活在 2026-09-25 的一串手工命令里**，
 * 于是台账/部署件里那些读数（0.46s / 2.5s / 表 226 · 列 3476 · 索引 1019 · 约束 2013 · 台账 71）
 * 既不可复现、也随迁移集增长而腐烂（本批现读：目录 72 条、台账 73 行）。
 * ⇒ §11 第 7 条要的是"恢复**必须实测**"，那实测得有一个能被下一个人重跑的入口。
 *
 * 边界（先说死，免得被读大）：
 *   · **只读源库**：对源库只跑 `pg_dump` 与 `SELECT count(*)`，不写一行。
 *   · **只删自己建的东西**：目标库名必须匹配 `^bambook_drill_`、必须与源库不同名、且**跑前不存在**；
 *     结束时 `dropdb` 掉的也只有这一个名字（见 assertDrillName）。
 *   · **dump 落临时目录，绝不落 `/Users/Shared/BambookBackups`**：那是定时备份的目录，
 *     往里塞一份演练文件会污染冒烟第 8 条（"最新 dump 有多旧"）与保留策略 —— 那是**新写面**。
 *   · ★ 本机形状上"恢复要 2.5 秒"**不等于生产 RTO ≤ 4h 达标**（判据要的是生产硬件）；
 *     本件的产出是"这条路随时可复跑 + 当天的数"，勾选权在使用方。
 *
 * 用法（在**有仓库**的机器上，env 必须先注入）：
 *   node scripts/drill-backup-restore.mjs [--db=bambook_drill_0927] [--keep] [--control]
 *     --control  恢复完之后，在演练库里 DROP 掉一张表再比一次 ⇒ 必须报不等（证明判据有牙，不是恒绿）
 *     --keep     跑完保留演练库（默认删；保留时要把名字记下来自己清）
 */
// ★ v3.212：安全闸 / libpq 调用口 / 结构清单全部走 `lib/drill-db.mjs`，
//   与 `drill-migration-roundtrip.mjs` 共用同一份 —— "只删自己建的那一个库"这句承诺不许有两份实现。
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { parseDatabaseUrl, assertDrillName, makePg, dbCounts, inventoryLines, diffLines, dbExists, seconds } from './lib/drill-db.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
loadEnvForScript(REPO);

const src = parseDatabaseUrl(process.env.DATABASE_URL);
if (!src) { console.log('✗ DATABASE_URL 解析不了（scheme/user/host/db 必须齐全）⇒ 拒绝跑'); process.exit(1); }
const argOf = (p, d) => (process.argv.find((a) => a.startsWith(p + '=')) || '').split('=')[1] || d;
const has = (n) => process.argv.includes(n);
const { pg, q } = makePg(src);
// 毫秒→秒只在 lib 里有一份（这一件曾把毫秒当秒打过 1000 倍的错，见 v3.210 台账）
const sec = (t0) => seconds(Date.now() - t0);
const fails = [];
const say = (x) => console.log(x);
const ok = (n, d = '') => say(`  ✓ ${n}${d ? ' — ' + d : ''}`);
const bad = (n, d = '') => { fails.push(n); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const DRILL = argOf('--db', 'bambook_drill_tmp');
const gateErr = assertDrillName(DRILL, src.db);
if (gateErr) { console.log('✗ ' + gateErr); process.exit(1); }

say('════════ 备份→恢复→逐项对撞 演练（源库全程只读）════════');
say(`源库=<本地测试库:${src.db}> 演练库=${DRILL} 主机=${src.host}:${src.port}`);

// 0) 演练库必须不存在（避免踩到别人正在用的库）
if (dbExists(q, DRILL)) { say(`✗ 演练库 ${DRILL} 已存在 ⇒ 拒绝跑（要么换名，要么先由你确认它是我上次留下的）`); process.exit(1); }

// 1) dump 到临时目录（★ 断言不落定时备份目录）
const DIR = mkdtempSync(join(tmpdir(), 'bambook-drill-'));
if (DIR.startsWith('/Users/Shared')) { say('✗ 临时目录落在了定时备份区 ⇒ 拒绝'); process.exit(1); }
const DUMP = join(DIR, 'drill.dump');
let t = Date.now();
pg('pg_dump', ['-Fc', '-f', DUMP, '-d', src.db]);
const dumpS = sec(t);
const bytes = statSync(DUMP).size;
ok('备份（pg_dump -Fc）', `${dumpS}s · ${(bytes / 1024 / 1024).toFixed(2)} MB`);

// 2) 建库 + 恢复
pg('createdb', ['-T', 'template0', '-E', 'UTF8', DRILL]);
let created = true;
t = Date.now();
pg('pg_restore', ['-d', DRILL, '--no-owner', '--no-privileges', DUMP]);
const restoreS = sec(t);
ok('恢复到全新库', `${restoreS}s（这就是"恢复耗时"在本机形状上的实测值）`);

// 3) 逐项对撞
const a = dbCounts(q, src.db);
const b = dbCounts(q, DRILL);
say('\n【结构逐项对撞】源库 vs 演练库');
for (const k of Object.keys(a)) {
  if (a[k] === b[k]) ok(k, `${a[k]}`);
  else bad(k, `源 ${a[k]} ≠ 演练 ${b[k]}`);
}
// 对象全名逐行 diff（数量相等不代表名字集合相同）
const oa = inventoryLines(pg, src.db);
const ob = inventoryLines(pg, DRILL);
const d2 = diffLines(oa, ob);
const diff = d2.onlyA.concat(d2.onlyB);
if (diff.length === 0) ok('列级对象清单逐行相同', `${oa.length} 行`);
else bad('列级对象清单逐行相同', `差 ${diff.length} 行：${diff.slice(0, 3).join(' / ')}`);

// 抽 5 张表比行数（结构相等不代表数据搬全了）
const tabs = q(src.db, "select table_name from information_schema.tables where table_schema='public' and table_name <> '_prisma_migrations' order by random() limit 5").split('\n').filter(Boolean);
say(`\n【随机 5 张表行数对撞】${tabs.join(', ')}`);
for (const tb of tabs) {
  const x = q(src.db, `select count(*) from "${tb}"`);
  const y = q(DRILL, `select count(*) from "${tb}"`);
  if (x === y) ok(tb, `${x} 行`);
  else bad(tb, `源 ${x} ≠ 演练 ${y}`);
}

// 4) 阳性对照：改坏演练库一张表 ⇒ 上面那把尺必须报不等
if (has('--control')) {
  say('\n【阳性对照】在演练库里 DROP 掉一张表 ⇒ 逐项对撞必须红（否则这尺是恒绿的）');
  const victim = tabs[0];
  pg('psql', ['-X', '-q', '-d', DRILL, '-c', `drop table if exists "${victim}" cascade`]);
  const b2 = dbCounts(q, DRILL);
  if (b2.tables !== a.tables) ok('对照 表计数', `${a.tables} → ${b2.tables}（抓到了）`);
  else bad('对照 表计数', '删了一张表却仍相等 ⇒ 这一格没牙');
  if (q(DRILL, 'select count(*) from information_schema.tables where table_schema=\'public\' and table_name <> \'_prisma_migrations\'') !== q(src.db, 'select count(*) from information_schema.tables where table_schema=\'public\' and table_name <> \'_prisma_migrations\'')) ok('对照 可复现', '第二次读数仍报差');
}

// 5) 清理（只删我自己建的那一个）
if (!has('--keep')) {
  if (created) pg('dropdb', ['--if-exists', DRILL]);
  const still = dbExists(q, DRILL);
  if (!still) ok('清理演练库', `${DRILL} 已删，源库未动`);
  else bad('清理演练库', `${DRILL} 还在 ⇒ 需要人工确认后再删`);
} else say('\n  ⚠ --keep：演练库留着，请自己 dropdb ' + DRILL);
rmSync(DIR, { recursive: true, force: true });

say('\n════════ 结论 ════════');
say(` 备份 ${dumpS}s · 恢复 ${restoreS}s · 失败 ${fails.length} 项`);
if (fails.length) { say(' ✗ 本轮演练**不成立**：' + fails.join(' / ')); process.exit(1); }
say(' ✓ 本机形状上「备份→恢复到全新库→逐项相等」这条路**当场可复跑**');
say(' ⚠️ 这不等于 §11 第 7 条（生产硬件 RTO ≤ 4h）达标 —— 那要部署到现场才量得到；勾选权在使用方');
process.exit(0);
