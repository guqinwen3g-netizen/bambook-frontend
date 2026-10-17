/**
 * verify-backup-restore-check —— 由 verify-backup-restore.sh 调用，不单独连正式库。
 *
 * 比对原库（SOURCE）与恢复库（RESTORED）：
 *   1. 表数量（public schema 的普通表）；
 *   2. 每张表的精确行数（关键表 MistWorkspace / MistCommandReceipt / UserAccount / BusinessSequence / _prisma_migrations 单列）；
 *   3. 每个工作空间的 revision、事件数（state.events）、业务回执数、版本标记数、state 摘要；
 * 再用恢复库启动一次 Mist 服务（真实 createMistServer + Prisma），健康检查必须 ok，
 * 并以工作空间所有者身份读取一个工作空间，与用原库启动的同一服务读取结果逐项一致。
 *
 * 环境变量：BACKUP_VERIFY_SOURCE_URL、BACKUP_VERIFY_RESTORED_URL（必填）、
 *   BACKUP_VERIFY_WORKSPACE_ID（可选，默认取 id 最小的未归档工作空间）、BACKUP_VERIFY_REPORT（可选，JSON 报告路径）。
 * JWT_SECRET 由本脚本为两个临时服务进程内随机生成，只在本次进程内有效；不读取 .env，不签发可用于其他环境的令牌。
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

const source = process.env.BACKUP_VERIFY_SOURCE_URL, restored = process.env.BACKUP_VERIFY_RESTORED_URL;
if (!source || !restored) { console.error('需要 BACKUP_VERIFY_SOURCE_URL 与 BACKUP_VERIFY_RESTORED_URL'); process.exit(2); }
// 在加载鉴权模块前设置：临时随机签名密钥，只给本进程内的两个临时服务使用。
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'development' : (process.env.NODE_ENV || 'development');
delete process.env.MIST_LOCAL_WORKSPACE;

const KEY_TABLES = ['MistWorkspace', 'MistCommandReceipt', 'UserAccount', 'BusinessSequence', '_prisma_migrations'];
type Check = { name: string; ok: boolean; source?: unknown; restored?: unknown; detail?: string };
const checks: Check[] = [];
const check = (name: string, a: unknown, b: unknown, detail?: string) => { const ok = isDeepStrictEqual(a, b); checks.push({ name, ok, ...(ok ? { source: a } : { source: a, restored: b }), ...(detail ? { detail } : {}) }); return ok; };

async function snapshot(prisma: any) {
  const tables: Array<{ table_name: string }> = await prisma.$queryRawUnsafe(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const rows: Record<string, number> = {};
  for (const { table_name } of tables) { const [{ c }] = await prisma.$queryRawUnsafe(`select count(*)::bigint as c from "public"."${table_name.replace(/"/g, '""')}"`); rows[table_name] = Number(c); }
  const workspaces: any[] = await prisma.$queryRawUnsafe(`
    select w.id::text as id, w."ownerId" as "ownerId", w.revision,
      coalesce(jsonb_array_length(case when jsonb_typeof(w.state->'events') = 'array' then w.state->'events' end), 0) as events,
      (select count(*)::int from "MistCommandReceipt" r where r."workspaceId" = w.id and r."requestId" not like 'mist-revision:%') as receipts,
      (select count(*)::int from "MistCommandReceipt" r where r."workspaceId" = w.id and r."requestId" like 'mist-revision:%') as markers,
      md5(w.state::text) as "stateDigest", (w.state ? 'workspaceArchive') as archived
    from "MistWorkspace" w order by w.id`);
  return { tableCount: tables.length, rows, workspaces };
}

async function serve(url: string) {
  const { PrismaClient } = await import('@prisma/client');
  const { createMistServer } = await import('../src/mist/server');
  const prisma = new PrismaClient({ datasourceUrl: url });
  const app = createMistServer(prisma, { host: '127.0.0.1' });
  const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); } };
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const a = new PrismaClient({ datasourceUrl: source }), b = new PrismaClient({ datasourceUrl: restored });
  let left: any, right: any;
  try { left = await snapshot(a); right = await snapshot(b); } finally { await a.$disconnect(); await b.$disconnect(); }
  check('表数量', left.tableCount, right.tableCount);
  for (const table of KEY_TABLES) if (table in left.rows || table in right.rows) check(`关键表行数 ${table}`, left.rows[table], right.rows[table]);
  const differing = Object.keys({ ...left.rows, ...right.rows }).filter(t => left.rows[t] !== right.rows[t]);
  check('全部表行数', differing, [], differing.length ? `不一致：${differing.join(', ')}` : `${Object.keys(left.rows).length} 张表逐表一致`);
  check('工作空间数量', left.workspaces.length, right.workspaces.length);
  const byId = new Map(right.workspaces.map((w: any) => [w.id, w]));
  for (const w of left.workspaces) {
    const r: any = byId.get(w.id) ?? {};
    check(`工作空间 ${w.id}：revision / 事件数 / 回执数 / 版本标记数 / state 摘要`, { revision: w.revision, events: w.events, receipts: w.receipts, markers: w.markers, stateDigest: w.stateDigest }, { revision: r.revision, events: r.events, receipts: r.receipts, markers: r.markers, stateDigest: r.stateDigest });
  }

  // 用恢复库与原库各启动一次同一服务：健康检查 + 以所有者身份读取同一个工作空间。
  const wanted = process.env.BACKUP_VERIFY_WORKSPACE_ID, target = wanted ? left.workspaces.find((w: any) => w.id === wanted) : left.workspaces.find((w: any) => !w.archived);
  const service: Record<string, unknown> = {};
  const restoredServer = await serve(restored!), sourceServer = await serve(source!);
  try {
    const health = async (base: string) => { const res = await fetch(base + '/api/health'); return { status: res.status, body: await res.json() }; };
    const [rh, sh] = [await health(restoredServer.base), await health(sourceServer.base)];
    service.health = { restored: rh, source: sh };
    checks.push({ name: '恢复库服务健康检查', ok: rh.status === 200 && rh.body?.status === 'ok' && rh.body?.database === 'ok', restored: rh });
    if (!target) checks.push({ name: '读取工作空间', ok: false, detail: '原库没有可读取的工作空间（可先运行 seed-backup-verify-mock.ts 写入模拟数据）' });
    else {
      const { createAuthService } = await import('../src/auth/service');
      const token = createAuthService().signToken({ userId: target.ownerId, displayName: 'backup-verify', roles: [], departmentIds: [], permissions: [] } as any);
      const read = async (base: string) => { const res = await fetch(`${base}/api/mist/workspaces/${target.id}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: res.status, body: await res.json() }; };
      const [rr, sr] = [await read(restoredServer.base), await read(sourceServer.base)];
      service.workspace = { id: target.id, restoredStatus: rr.status, sourceStatus: sr.status, revision: rr.body?.workspace?.revision };
      checks.push({ name: `恢复库服务读取工作空间 ${target.id}`, ok: rr.status === 200 && !!rr.body?.workspace, restored: { status: rr.status, revision: rr.body?.workspace?.revision } });
      check(`服务读取结果与原库一致（${target.id}）`, sr.body?.workspace, rr.body?.workspace);
    }
  } finally { await restoredServer.close(); await sourceServer.close(); }

  const ok = checks.every(c => c.ok);
  const report = { ok, at: new Date().toISOString(), tables: left.tableCount, workspaces: left.workspaces.length, keyTables: Object.fromEntries(KEY_TABLES.filter(t => t in left.rows).map(t => [t, { source: left.rows[t], restored: right.rows[t] }])), perWorkspace: left.workspaces.map((w: any) => ({ id: w.id, revision: w.revision, events: w.events, receipts: w.receipts, markers: w.markers })), service, checks };
  if (process.env.BACKUP_VERIFY_REPORT) writeFileSync(process.env.BACKUP_VERIFY_REPORT, JSON.stringify(report, null, 2) + '\n');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `（${c.detail}）` : ''}${c.ok ? '' : `\n      原库：${JSON.stringify(c.source)}\n      恢复库：${JSON.stringify(c.restored)}`}`);
  console.log(ok ? `比对通过：${checks.length} 项` : `比对失败：${checks.filter(c => !c.ok).length} / ${checks.length} 项`);
  process.exit(ok ? 0 : 1);
}
main().catch(error => { console.error('核验脚本出错：', error?.message || error); process.exit(1); });
