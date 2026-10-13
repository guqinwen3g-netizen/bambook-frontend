/**
 * drill-db.mjs —— 一次性演练库的**唯一一份**安全闸 + libpq 调用口
 *
 * 为什么两份演练件（`drill-backup-restore.mjs` / `drill-migration-roundtrip.mjs`）要共用它：
 * 这两件都会 `createdb` / `dropdb`。"只删自己建的那一个"这句承诺如果各写一份，
 * 一处收紧、一处放松，另一处就会悄悄变成"敢删业务库"（本仓那一族并行实现的病）。
 *
 * 三条硬闸（任何一条不过 ⇒ 立刻退出，不做任何写动作）：
 *   ① 演练库名必须匹配 `^bambook_drill_[0-9a-z_]{2,24}$`；
 *   ② 不得等于源库名，也不得等于已知业务库名（`panda_hub_local`）；
 *   ③ 跑前必须不存在（存在就拒，避免踩到别人正在用的库，也避免"删掉一份不是我建的库"）。
 */
import { spawnSync } from 'node:child_process';

export const BUSINESS_DB_NAMES = ['panda_hub_local', 'pandahub'];

export function parseDatabaseUrl(raw) {
  const m = String(raw ?? '').match(/^(?:postgres(?:ql)?:\/\/)([^:]+):([^@]*)@([^:/]+):?(\d*)\/([^?]+)/);
  if (!m) return null;
  const [, user, password, host, port, db] = m;
  return { user, password, host, port: port || '5432', db };
}

export function assertDrillName(name, srcDb) {
  if (!/^bambook_drill_[0-9a-z_]{2,24}$/.test(name)) {
    return `演练库名必须形如 bambook_drill_xxxx（拿到的是「${name}」）⇒ 拒绝跑，绝不碰别的库`;
  }
  if (name === srcDb) return `演练库名与源库同名（${name}）⇒ 拒绝（那等于要删业务库）`;
  if (BUSINESS_DB_NAMES.includes(name)) return `演练库名命中已知业务库（${name}）⇒ 拒绝`;
  return null;
}

/** libpq 工具调用口：连接信息只进 env，**不进命令行**（命令行会进日志/进程表） */
export function makePg(src) {
  const env = { ...process.env, PGHOST: src.host, PGPORT: src.port, PGUSER: src.user, PGPASSWORD: src.password };
  const pg = (bin, args, opt = {}) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, ...opt });
    if (r.status !== 0) {
      // 只打 stderr 前几行，绝不打命令或 env ⇒ 不带出凭据
      const msg = String(r.stderr || r.stdout || '').split('\n').slice(0, 3).join(' | ').slice(0, 300);
      const e = new Error(`${bin} 失败 rc=${r.status}：${msg}`);
      e.bin = bin;
      throw e;
    }
    return String(r.stdout || '').trim();
  };
  const q = (db, sql) => pg('psql', ['-X', '-q', '-At', '-d', db, '-c', sql]);
  return { env, pg, q };
}

/** 结构快照（★ 与 census 的 `--emit-inventory` 同一份 SQL，不另写一遍） */
export const INVENTORY_SQL = `select 'TBL '||table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'
union all select 'COL '||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'-')
  from information_schema.columns where table_schema='public'
union all select 'IDX '||indexname from pg_indexes where schemaname='public'
union all select 'CON '||conrelid::regclass::text||'.'||conname||' :: '||pg_get_constraintdef(oid)
  from pg_constraint where connamespace='public'::regnamespace
union all select 'SEQ '||sequence_name from information_schema.sequences where sequence_schema='public'
order by 1;`;

export const COUNTS = {
  tables: "select count(*) from information_schema.tables where table_schema='public' and table_name <> '_prisma_migrations'",
  columns: "select count(*) from information_schema.columns where table_schema='public'",
  indexes: "select count(distinct indexname) from pg_indexes where schemaname='public'",
  constraints: "select count(*) from information_schema.table_constraints where table_schema='public'",
  migrations: 'select count(*) from _prisma_migrations',
  migrationsDone: 'select count(*) from _prisma_migrations where finished_at is not null',
};

export function dbCounts(q, db) {
  const out = {};
  for (const [k, sql] of Object.entries(COUNTS)) out[k] = q(db, sql);
  return out;
}

export function inventoryLines(pg, db) {
  return pg('psql', ['-X', '-q', '-At', '-d', db, '-c', INVENTORY_SQL]).split('\n').filter(Boolean).sort();
}

/** 两份清单的差集（逐行，不折叠） */
export function diffLines(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) };
}

export const dbExists = (q, name) => q('postgres', `select count(*) from pg_database where datname='${name}'`) === '1';
export const seconds = (ms) => (Math.round((ms / 1000) * 10) / 10).toFixed(1);
