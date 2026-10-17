import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { MistApiError } from './errors';
import { MistPrivateFiles } from './files';
import { MistRepository } from './repository';
import { testContract } from './__tests__/support';

/** 测试合同的模拟命令（notes.add / money.add）不在正式命令联合类型里，统一按测试命令传入。 */
const mock = (type: 'notes.add' | 'money.add', payload: Record<string, unknown>) => ({ type, payload }) as any;

/**
 * 真实 PostgreSQL 负载并发实测（与 workspaceConflictRetry.pg.test.ts 同一开关，只在显式提供独立测试库时运行）：
 *   MIST_PG_CONFLICT_TEST_URL=postgresql://... MIST_PG_LOAD_REPORT=/tmp/mist-pg-load.json \
 *     npx vitest run src/mist/workspaceConcurrencyLoad.pg.test.ts
 * 只用模拟账号（load-user-*）与模拟命令（notes.add / money.add）；用例只清理自己创建的工作区与回执。
 * 延迟、重试次数与失败数全部按本次运行实测记录，写入 MIST_PG_LOAD_REPORT（未设置时只打印）。
 */
const url = process.env.MIST_PG_CONFLICT_TEST_URL;
/** 50 个并发请求需要足够的连接；未显式指定时按 60 个连接运行（低于本地 PostgreSQL 的 max_connections）。 */
const pooled = (raw: string) => { const parsed = new URL(raw); if (!parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', '60'); if (!parsed.searchParams.has('pool_timeout')) parsed.searchParams.set('pool_timeout', '30'); return parsed.toString(); };
const CLIENT_RETRIES = 5;
type Outcome = { kind: 'note' | 'money'; requestId: string; expectedRevision: number; cents?: number; ok: boolean; code?: string; status?: number; clientRetries: number; latencies: number[]; receipt?: any };
const percentile = (values: number[], p: number) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] * 10) / 10; };

describe.skipIf(!url)('真实 PostgreSQL 负载：多人同时提交混合命令', () => {
  let prisma: PrismaClient, root: string, repo: MistRepository, serverRetries = 0, transactions = 0;
  const ids: string[] = [], report: Record<string, unknown> = {};
  const users = new Map<string, { active: boolean; permissions: string[] }>();
  const actor = (id: string): TokenPayload => ({ userId: id, displayName: id, roles: ['owner'], departmentIds: [], permissions: ['products:write', 'finance:write'] });
  const authorize = async (_db: any, prior: TokenPayload, permission?: string | null) => {
    const current = users.get(prior?.userId);
    if (!current?.active) throw new MistApiError('ACCOUNT_DISABLED', '账号已失效', 401);
    if (permission && !current.permissions.includes(permission)) throw new MistApiError('FORBIDDEN', '权限不足', 403);
    return { ...prior, permissions: current.permissions };
  };
  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: pooled(url!) });
    // 只计数：每笔事务若因可串行化失败 / 死锁 / 唯一键竞争被回滚（仓储会自动重试），记一次服务端重试。
    const original = prisma.$transaction.bind(prisma) as any;
    (prisma as any).$transaction = async (...args: any[]) => {
      transactions++;
      try { return await original(...args); }
      catch (error: any) { if (['P2034', 'P2002'].includes(error?.code) || error?.code === 'P2010' && ['40001', '40P01'].includes(error?.meta?.code)) serverRetries++; throw error; }
    };
    root = await mkdtemp(path.join(tmpdir(), 'mist-pg-load-')); repo = new MistRepository(prisma, testContract, new MistPrivateFiles(root), authorize as any);
    users.set('load-owner', { active: true, permissions: ['products:write', 'finance:write'] });
  });
  afterAll(async () => {
    if (ids.length) { await prisma.mistCommandReceipt.deleteMany({ where: { workspaceId: { in: ids } } }); await prisma.mistWorkspace.deleteMany({ where: { id: { in: ids } } }); }
    const out = JSON.stringify({ at: new Date().toISOString(), database: new URL(url!).host + new URL(url!).pathname, ...report }, null, 2);
    if (process.env.MIST_PG_LOAD_REPORT) await writeFile(process.env.MIST_PG_LOAD_REPORT, out + '\n'); console.log(out);
    await prisma?.$disconnect(); await rm(root, { recursive: true, force: true });
  });
  const workspace = async (members: string[]) => {
    const created = await repo.create(actor('load-owner'), { name: 'PG 负载', slug: 'pg-load-' + Math.random().toString(36).slice(2), seed: 'empty' }); ids.push(created.id);
    const row: any = await prisma.mistWorkspace.findUniqueOrThrow({ where: { id: created.id } });
    await prisma.mistWorkspace.update({ where: { id: created.id }, data: { state: { ...row.state, memberIds: members } } });
    return created.id;
  };
  const latestRevision = async (id: string) => (await prisma.mistWorkspace.findUniqueOrThrow({ where: { id }, select: { revision: true } })).revision;
  const roster = (count: number) => Array.from({ length: count }, (_, i) => { const id = `load-user-${count}-${i}`; users.set(id, { active: true, permissions: ['products:write', 'finance:write'] }); return id; });
  /** 一次客户端提交：409 冲突时重新读取最新版本、用新请求编号重试（最多 CLIENT_RETRIES 次）；其他错误直接记失败。 */
  async function submit(id: string, user: string, kind: 'note' | 'money', tag: string, cents: number, startRevision: number): Promise<Outcome> {
    const outcome: Outcome = { kind, requestId: '', expectedRevision: startRevision, ...(kind === 'money' ? { cents } : {}), ok: false, clientRetries: 0, latencies: [] };
    let expectedRevision = startRevision;
    for (let attempt = 0; ; attempt++) {
      const requestId = `${tag}-${attempt}`, command = kind === 'note' ? mock('notes.add', { text: tag }) : mock('money.add', { cents });
      const started = performance.now();
      try {
        const done = await repo.execute(actor(user), id, { requestId, expectedRevision, command });
        outcome.latencies.push(performance.now() - started); Object.assign(outcome, { ok: true, requestId, expectedRevision, receipt: done.receipt, code: undefined, status: undefined }); return outcome;
      } catch (error: any) {
        outcome.latencies.push(performance.now() - started); Object.assign(outcome, { requestId, expectedRevision, code: error?.code ?? 'UNKNOWN', status: error?.status });
        if (error?.code !== 'REVISION_CONFLICT' || attempt >= CLIENT_RETRIES) return outcome;
        outcome.clientRetries++; expectedRevision = await latestRevision(id);
      }
    }
  }
  async function assertLedger(id: string, successes: number) {
    const row: any = await prisma.mistWorkspace.findUniqueOrThrow({ where: { id } });
    const receipts = await prisma.mistCommandReceipt.findMany({ where: { workspaceId: id }, select: { requestId: true, result: true } });
    const markers = receipts.filter(r => r.requestId.startsWith('mist-revision:')).map(r => Number(r.requestId.slice('mist-revision:'.length))).sort((a, b) => a - b);
    const requestRevisions = receipts.filter(r => !r.requestId.startsWith('mist-revision:') && (r.result as any).revision > 0).map(r => (r.result as any).revision).sort((a, b) => a - b);
    // revision 连续：最终版本 = 成功请求数；版本标记 1..N 各一条；每条业务回执占用一个不重复的版本号。
    expect(row.revision).toBe(successes);
    expect(markers).toEqual(Array.from({ length: successes }, (_, i) => i + 1));
    expect(requestRevisions).toEqual(markers);
    return row;
  }

  for (const count of [10, 50]) {
    it(`${count} 个并发用户混合提交（新增记录 + 同一金额字段）并重放：不丢写、版本连续、重放不重复记账、金额合计正确`, async () => {
      const team = roster(count), id = await workspace(team), base = await latestRevision(id), started = performance.now();
      serverRetries = 0; transactions = 0;
      // 每人三条：新增记录、金额累加、再新增记录；都基于自己开始时看到的版本（并发落后）。
      const results = (await Promise.all(team.map(async (user, i) => {
        const rows: Outcome[] = [];
        rows.push(await submit(id, user, 'note', `${count}-${i}-a`, 0, base));
        rows.push(await submit(id, user, 'money', `${count}-${i}-m`, 100 + i, base));
        rows.push(await submit(id, user, 'note', `${count}-${i}-b`, 0, base));
        return rows;
      }))).flat();
      const elapsed = performance.now() - started, ok = results.filter(r => r.ok), failed = results.filter(r => !r.ok);
      // 冲突要么按规则重试成功，要么明确 409，不出现其他错误。
      for (const r of failed) expect(r).toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
      // 同一请求重放（每个成功请求原样再提交一次，并发）：拿到同一回执，不重复记账。
      const replays = await Promise.all(ok.map(async r => {
        const user = team[Number(r.requestId.split('-')[1])];
        const command = r.kind === 'note' ? mock('notes.add', { text: r.requestId.replace(/-\d+$/, '') }) : mock('money.add', { cents: r.cents });
        const begun = performance.now(), again = await repo.execute(actor(user), id, { requestId: r.requestId, expectedRevision: r.expectedRevision, command });
        return { ms: performance.now() - begun, same: isDeepStrictEqual(again.receipt, r.receipt), replayed: again.replayed };
      }));
      expect(replays.every(r => r.replayed && r.same)).toBe(true);
      const row = await assertLedger(id, ok.length);
      // 不丢写：每个成功的新增记录恰好一条；金额 = 所有成功累加之和。
      const notes = ok.filter(r => r.kind === 'note').map(r => r.requestId.replace(/-\d+$/, '')).sort();
      expect(row.state.notes.map((n: any) => n.text).sort()).toEqual(notes);
      expect(row.state.money.cents).toBe(ok.filter(r => r.kind === 'money').reduce((sum, r) => sum + r.cents!, 0));
      const latencies = results.flatMap(r => r.latencies), endToEnd = results.map(r => r.latencies.reduce((a, b) => a + b, 0));
      report[`mixed_${count}`] = {
        users: count, commands: results.length, succeeded: ok.length, failed409: failed.length, otherFailures: 0,
        byKind: { note: { ok: ok.filter(r => r.kind === 'note').length, failed: failed.filter(r => r.kind === 'note').length }, money: { ok: ok.filter(r => r.kind === 'money').length, failed: failed.filter(r => r.kind === 'money').length } },
        clientRetries: results.reduce((sum, r) => sum + r.clientRetries, 0), serverSerializationRetries: serverRetries, transactions,
        requestLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100), samples: latencies.length },
        endToEndLatencyMs: { p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95) },
        replay: { requests: replays.length, allSameReceipt: true, latencyMs: { p50: percentile(replays.map(r => r.ms), 50), p95: percentile(replays.map(r => r.ms), 95) } },
        finalRevision: row.revision, moneyCents: row.state.money.cents, wallClockMs: Math.round(elapsed),
      };
    }, 180_000);

    it(`${count} 个并发用户基于同一版本修改同一金额字段：只成功一个，其余明确 409 且不覆盖`, async () => {
      const team = roster(count), id = await workspace(team);
      serverRetries = 0;
      const timed = await Promise.all(team.map(async (user, i) => { const begun = performance.now(); try { const done = await repo.execute(actor(user), id, { requestId: `same-${count}-${i}`, expectedRevision: 0, command: mock('money.add', { cents: 1000 + i }) }); return { ok: true, cents: 1000 + i, ms: performance.now() - begun, done }; } catch (error: any) { return { ok: false, code: error?.code, status: error?.status, ms: performance.now() - begun }; } }));
      const ok = timed.filter(r => r.ok) as any[], failed = timed.filter(r => !r.ok) as any[];
      expect(ok).toHaveLength(1);
      for (const r of failed) expect(r).toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
      const row = await assertLedger(id, 1); expect(row.state.money.cents).toBe(ok[0].cents);
      report[`sameField_${count}`] = { users: count, succeeded: ok.length, failed409: failed.length, otherFailures: 0, serverSerializationRetries: serverRetries, latencyMs: { p50: percentile(timed.map(r => r.ms), 50), p95: percentile(timed.map(r => r.ms), 95) }, moneyCents: row.state.money.cents };
    }, 120_000);

    it(`同一请求被 ${count} 个连接同时提交：只执行一次，全部拿到同一回执`, async () => {
      const team = roster(count), id = await workspace(team);
      serverRetries = 0;
      const timed = await Promise.all(Array.from({ length: count }, async () => { const begun = performance.now(); const done = await repo.execute(actor('load-owner'), id, { requestId: `replay-${count}`, expectedRevision: 0, command: mock('money.add', { cents: 250 }) }); return { ms: performance.now() - begun, done }; }));
      // jsonb 会重排键顺序：按结构比较回执，而不是按序列化字符串。
      for (const r of timed) expect(r.done.receipt).toEqual(timed[0].done.receipt);
      expect(timed.filter(r => !r.done.replayed)).toHaveLength(1);
      const row = await assertLedger(id, 1); expect(row.state.money.cents).toBe(250);
      expect(await prisma.mistCommandReceipt.count({ where: { workspaceId: id, requestId: `replay-${count}` } })).toBe(1);
      report[`replay_${count}`] = { submissions: count, executed: 1, replayed: count - 1, failures: 0, serverSerializationRetries: serverRetries, latencyMs: { p50: percentile(timed.map(r => r.ms), 50), p95: percentile(timed.map(r => r.ms), 95) }, moneyCents: row.state.money.cents };
    }, 120_000);
  }
});
