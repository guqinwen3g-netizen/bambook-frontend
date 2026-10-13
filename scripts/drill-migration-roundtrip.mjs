#!/usr/bin/env node
/**
 * drill-migration-roundtrip.mjs —— ④ 交付件：**可重跑**的「迁移退回去再上得来」演练（B264 的另外半场）
 *
 * 存在的理由：09-25 那次退-进演练是一串手工命令 ⇒ 读数（退后 表 226→198 / 前滚回 226、
 * 对象清单 5039 行 diff 0、两条回填列 md5 复原）今天既不可复现、分母也烂了
 * ——★ 本批现读待迁移已是 **35 条**（当时 32 条），所以**分母必须由件自己现量，不许沿用旧数**。
 *
 * 它证明什么（也只到这一步，别读大）：
 *   在**本机测试库的一份一次性克隆**上：把基线之后的迁移**逐句反向 DDL 退回去**，
 *   再用 `prisma migrate deploy` **前滚回来**，结构清单能回到退前那份（双向 diff 为 0）、
 *   被回填过的列值也复原 ⇒ "出事能退、退完还能上"这条路随时可复跑。
 * 它**不**证明：
 *   · 生产形状（起点是本地测试库克隆，不是生产快照）；
 *   · 数据类还原的通用性 —— `UPDATE` 语句不生成反向（认不出形状**不猜**），
 *     那几条靠的是"列被 DROP 掉再重建"，所以件**只对由 UPDATE 回填出来的列做 md5 对撞**，其余不承诺。
 *
 * 安全闸见 `scripts/lib/drill-db.mjs`（只读源库、只删自己建的库、跑前目标库必须不存在）。
 * 用法：node scripts/drill-migration-roundtrip.mjs --db=bambook_drill_rt [--since=20260901000000] [--control] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
import { censusMigrations, buildDownSql } from './lib/migration-sql.mjs';
import { parseDatabaseUrl, assertDrillName, makePg, dbCounts, inventoryLines, diffLines, dbExists, seconds } from './lib/drill-db.mjs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
loadEnvForScript(REPO);
const src = parseDatabaseUrl(process.env.DATABASE_URL);
if (!src) { console.log('✗ DATABASE_URL 解析不了 ⇒ 拒绝跑'); process.exit(1); }

const argOf = (p, d) => (process.argv.find((a) => a.startsWith(p + '=')) || '').split('=')[1] || d;
const has = (n) => process.argv.includes(n);
const DRILL = argOf('--db', 'bambook_drill_rt');
const SINCE = argOf('--since', '20260901000000');
const gateErr = assertDrillName(DRILL, src.db);
if (gateErr) { console.log('✗ ' + gateErr); process.exit(1); }

const { env, pg, q } = makePg(src);
/** ★ 任何要上屏的子进程输出都先过这一道：把密码（原样与 URL 编码两种）换成 *** */
const scrub = (t) => String(t).split(src.password).join('***').split(encodeURIComponent(src.password)).join('***');
const DRILL_URL = `postgresql://${src.user}:${encodeURIComponent(src.password)}@${src.host}:${src.port}/${DRILL}`;
const fails = [];
const say = console.log;
const ok = (n, d = '') => say(`  ✓ ${n}${d ? ' — ' + d : ''}`);
const bad = (n, d = '') => { fails.push(n); say(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

const c = censusMigrations(REPO, SINCE);
say('════════ 迁移退-进 演练（源库全程只读 · 目标是一次性克隆库）════════');
say(`源库=<本地测试库:${src.db}> 演练库=${DRILL} 基线 --since=${SINCE}`);
say(`★ 分母**由本件现量**：待迁移 **${c.pending.length}** 条 · 语句合计 可逆 ${c.totals['可逆'] ?? 0} · 改数据 ${c.totals['改数据'] ?? 0} · 要人看 ${c.totals['要人看'] ?? 0} · 数据丢失 ${c.totals['数据丢失'] ?? 0}`);
say(`  未生成反向的语句 **${c.ungenerated.length}** 处（不猜 ⇒ 件不执行它们，逐条点名在最后）`);
if ((c.totals['数据丢失'] ?? 0) > 0) { say('✗ 现量出"数据丢失"类语句 ⇒ 反向 DDL 退不回去，本件拒绝跑（要走备份口径，人工决定）'); process.exit(1); }
if (dbExists(q, DRILL)) { say(`✗ 演练库 ${DRILL} 已存在 ⇒ 拒绝跑（不删不是我建的库）`); process.exit(1); }

const DIR = mkdtempSync(join(tmpdir(), 'bambook-rt-'));
const done = (p) => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 清理失败不改判据 */ } process.exit(p); };

let created = false;
try {
  // 1) 克隆（源库只读）
  const DUMP = join(DIR, 'clone.dump');
  let t = Date.now();
  pg('pg_dump', ['-Fc', '-f', DUMP, '-d', src.db]);
  pg('createdb', [DRILL]); created = true;
  pg('pg_restore', ['-d', DRILL, '--no-owner', '--no-privileges', DUMP]);
  ok('克隆源库到一次性演练库', `${seconds(Date.now() - t)}s`);

  const preCounts = dbCounts(q, DRILL);
  const srcCounts = dbCounts(q, src.db);
  for (const k of Object.keys(preCounts)) {
    if (preCounts[k] === srcCounts[k]) ok(`克隆与源库 ${k} 相等`, preCounts[k]);
    else bad(`克隆与源库 ${k} 相等`, `源 ${srcCounts[k]} ≠ 克隆 ${preCounts[k]}（不等 ⇒ 后面三态对撞没有基准）`);
  }
  const invPre = inventoryLines(pg, DRILL);
  /**
   * 台账基线要先抓住一件事实：**源库的台账本来就不是目录的全集** ——
   * 目录里有条迁移（如 B243 的 `..._backfill_drift_indexes`）按设计"不在本机执行、部署时才生效"，
   * 而台账里还可能留着 `rolled_back` 的历史行。⇒ "前滚后台账行数 = 退前行数"**是个错的不变式**
   * （我第一次就这么写，于是把一条正确的前滚报成了失败）。
   * 正确的不变式两条：① 前滚后**目录里的每一条都在台账里且 done**；
   * ② 台账相对退前**只多出"退前本来就缺的那几条"**，多一条都算红。
   */
  const namesOf = (db) => new Set(q(db, 'select migration_name from _prisma_migrations order by 1').split('\n').filter(Boolean));
  const preNames = namesOf(DRILL);
  const dirNames = new Set(c.all);
  const missingPre = [...dirNames].filter((n) => !preNames.has(n));
  say(`  台账基线：退前 ${preNames.size} 行 · 目录 ${dirNames.size} 条 · 其中退前就缺 **${missingPre.length}** 条（按设计部署时才生效）${missingPre.length ? `：${missingPre.join(', ')}` : ''}`);

  // 2) 退：逐句反向 DDL + 撤台账记录（不撤的话 deploy 不会重跑 ⇒ "前滚"是假的）
  const down = buildDownSql(c.perMigration, [
    `-- 由 scripts/drill-migration-roundtrip.mjs 当场生成，只在演练库上执行；不落盘（存一份 down.sql 会跟着主线腐烂）`,
  ]);
  const DOWNF = join(DIR, 'down.sql');
  writeFileSync(DOWNF, down + '\n');
  t = Date.now();
  pg('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DRILL, '-f', DOWNF]);
  const downS = seconds(Date.now() - t);
  const invDown = inventoryLines(pg, DRILL);
  const cntDown = dbCounts(q, DRILL);
  const moved = diffLines(invPre, invDown);
  if (moved.onlyA.length + moved.onlyB.length > 0) {
    ok('退回去确实动了东西', `仅退前有 ${moved.onlyA.length} 行 / 仅退后有 ${moved.onlyB.length} 行 · ${downS}s`);
  } else bad('退回去确实动了东西', '结构与退前完全一致 ⇒ 这批反向 DDL 是**空转**，演练不成立');
  say(`  退后计数：表 ${cntDown.tables} · 列 ${cntDown.columns} · 索引 ${cntDown.indexes} · 约束 ${cntDown.constraints} · 台账 ${cntDown.migrations}`);

  // 3) 进：prisma migrate deploy（只指向演练库；URL 只进子进程 env，不上屏）
  t = Date.now();
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: join(REPO, 'server'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...env, DATABASE_URL: DRILL_URL },
  });
  const upS = seconds(Date.now() - t);
  const upOut = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) bad('migrate deploy 前滚', `rc=${r.status}：${upOut.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
  else ok('migrate deploy 前滚', `${upS}s`);
  const invUp = inventoryLines(pg, DRILL);
  const cntUp = dbCounts(q, DRILL);

  // 4) 主判据：前滚之后的结构清单必须与退前**双向 diff 为 0**
  const back = diffLines(invPre, invUp);
  if (back.onlyA.length === 0 && back.onlyB.length === 0) ok('结构回到退前那份（双向 diff = 0）', `${invPre.length} 行清单逐行相同`);
  else bad('结构回到退前那份（双向 diff = 0）', `缺 ${back.onlyA.length} 行（例：${back.onlyA.slice(0, 2).join(' / ')}）· 多 ${back.onlyB.length} 行（例：${back.onlyB.slice(0, 2).join(' / ')}）`);
  for (const k of ['tables', 'columns', 'indexes', 'constraints']) {
    if (String(preCounts[k]) === String(cntUp[k])) ok(`计数 ${k} 复原`, cntUp[k]);
    else bad(`计数 ${k} 复原`, `退前 ${preCounts[k]} ≠ 前滚后 ${cntUp[k]}`);
  }
  // 台账两条不变式（见上面那段注释：不比"行数相等"，那个基准是错的）
  const postNames = namesOf(DRILL);
  const notBack = [...dirNames].filter((n) => !postNames.has(n));
  if (notBack.length === 0) ok('前滚后：目录里每一条都在台账里且已应用', `${dirNames.size} 条 / done ${cntUp.migrationsDone}`);
  else bad('前滚后：目录里每一条都在台账里且已应用', `缺 ${notBack.length} 条：${notBack.slice(0, 4).join(', ')}`);
  const added = [...postNames].filter((n) => !preNames.has(n));
  const unexplained = added.filter((n) => !missingPre.includes(n));
  const notReadded = missingPre.filter((n) => !postNames.has(n));
  if (unexplained.length === 0 && notReadded.length === 0) {
    ok('台账只多出"退前本来就缺的那几条"', `+${added.length} = 预期 ${missingPre.length}（${added.join(', ') || '（无）'}）`);
  } else {
    bad('台账只多出"退前本来就缺的那几条"',
      `多出来无法解释的 ${unexplained.length} 条（${unexplained.slice(0, 3).join(', ')}）· 该补却没补的 ${notReadded.length} 条（${notReadded.slice(0, 3).join(', ')}）`);
  }

  // 5) 数据侧：只对"被 UPDATE 回填出来的列"做多重集 md5 对撞（不猜别的）
  const targets = [];
  for (const m of c.perMigration) for (const r2 of m.risky) {
    if (r2.kind !== '改数据') continue;
    const mm = /UPDATE "([\w]+)" SET "([\w]+)"/i.exec(r2.stmt);
    if (mm) targets.push({ table: mm[1], column: mm[2], from: m.name });
  }
  const hashOf = (db, tb, col) => q(db, `select md5(string_agg(v,'|' order by v))||'/'||count(*)||'/'||count(distinct v) from (select "${col}"::text v from "${tb}") t`);
  for (const tg of targets) {
    const existsSrc = q(src.db, `select count(*) from information_schema.columns where table_schema='public' and table_name='${tg.table}' and column_name='${tg.column}'`);
    if (existsSrc !== '1') { say(`  ⏷ ${tg.table}.${tg.column}（由 ${tg.from} 回填）源库里不存在 ⇒ 这一格没法对撞`); continue; }
    const a = hashOf(src.db, tg.table, tg.column);
    const b = hashOf(DRILL, tg.table, tg.column);
    if (a === b) ok(`回填列复原 ${tg.table}.${tg.column}`, `md5/行数/去重数 ${String(a).slice(0, 12)}… (${String(a).split('/')[1]} 行)`);
    else bad(`回填列复原 ${tg.table}.${tg.column}`, `源 ${a} ≠ 演练 ${b}`);
  }
  if (!targets.length) say('  ⚠️ 本轮没有"改数据"类语句 ⇒ 数据侧对撞这一格**跑不到**（不许读成"数据一定复原"）');

  // 6) 阳性对照：手动删一张表 ⇒ diff 必须报出来（证明上面那句"diff = 0"不是尺瞎）
  if (has('--control')) {
    const victim = q(DRILL, "select table_name from information_schema.tables where table_schema='public' and table_name <> '_prisma_migrations' order by table_name limit 1");
    pg('psql', ['-X', '-q', '-d', DRILL, '-c', `drop table if exists "${victim}" cascade`]);
    const ctl = diffLines(invPre, inventoryLines(pg, DRILL));
    if (ctl.onlyB.length === 0 && ctl.onlyA.length > 0) ok('对照：删一张表必须被 diff 抓到', `${victim} · 抓到 ${ctl.onlyA.length} 行`);
    else bad('对照：删一张表必须被 diff 抓到', `onlyA=${ctl.onlyA.length} onlyB=${ctl.onlyB.length} ⇒ 这一格可能没牙`);
  }

  if (c.ungenerated.length) {
    say(`\n【未生成反向的 ${c.ungenerated.length} 处】（件不执行它们 ⇒ 这几处退回去只能靠备份，逐条点名）`);
    for (const u of c.ungenerated.slice(0, 12)) say(`  · ${u.name} :: ${u.stmt}`);
    if (c.ungenerated.length > 12) say(`  …另 ${c.ungenerated.length - 12} 处（全清单见 census --json）`);
  }
} catch (e) {
  bad('异常中止', String(e && e.message ? e.message : e).slice(0, 300));
} finally {
  if (created && !has('--keep')) {
    try {
      pg('dropdb', ['--if-exists', DRILL]);
      if (!dbExists(q, DRILL)) ok('清理演练库', `${DRILL} 已删，源库未动`);
      else bad('清理演练库', `${DRILL} 还在`);
    } catch (e) { bad('清理演练库', String(e.message).slice(0, 160)); }
  } else if (created) say(`  ⚠ --keep：演练库留着，请自己 dropdb ${DRILL}`);
}

say('\n════════ 结论 ════════');
say(` 失败 ${fails.length} 项`);
if (fails.length) { say(' ✗ 本轮退-进演练**不成立**：' + fails.join(' / ')); done(1); }
say(' ✓ 本机形状上「反向 DDL 退回去 → migrate deploy 上得来 → 结构清单回到退前」当场可复跑');
say(' ⚠️ 起点是本地测试库克隆，**不是生产快照** ⇒ "生产上也退得回来"仍要真部署时现量；勾选权在使用方');
done(0);
