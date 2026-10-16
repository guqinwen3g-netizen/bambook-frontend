import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { MistPrivateFiles } from './files';
import { MistRepository } from './repository';
import { testActor, testAuthority, testContract } from './__tests__/support';

/**
 * 真实 PostgreSQL 并发回归：只在显式提供独立测试库时运行，避免误连共享或生产库。
 *   MIST_PG_CONFLICT_TEST_URL=postgresql://... npx vitest run src/mist/workspaceConflictRetry.pg.test.ts
 * 库结构需与 prisma/schema.prisma 一致；用例只清理自己创建的工作区与回执。
 */
const url = process.env.MIST_PG_CONFLICT_TEST_URL;
describe.skipIf(!url)('真实 PostgreSQL：多人同时保存自动重试', () => {
  let prisma: PrismaClient, root: string, repo: MistRepository, files: MistPrivateFiles;
  const owner = testActor('owner'), ids: string[] = [];
  beforeAll(async () => { prisma = new PrismaClient({ datasourceUrl: url }); root = await mkdtemp(path.join(tmpdir(), 'mist-pg-retry-')); files = new MistPrivateFiles(root); repo = new MistRepository(prisma, testContract, files, testAuthority().authorize); });
  afterAll(async () => {
    if (ids.length) { await prisma.mistCommandReceipt.deleteMany({ where: { workspaceId: { in: ids } } }); await prisma.mistWorkspace.deleteMany({ where: { id: { in: ids } } }); }
    await prisma?.$disconnect(); await rm(root, { recursive: true, force: true });
  });
  const workspace = async () => { const created = await repo.create(owner, { name: 'PG 并发', slug: 'pg-retry-' + Math.random().toString(36).slice(2), seed: 'empty' }); ids.push(created.id); return created.id; };
  const note = (requestId: string, text = requestId) => ({ requestId, expectedRevision: 0, command: { type: 'notes.add', payload: { text } } });
  const row = (id: string) => prisma.mistWorkspace.findUniqueOrThrow({ where: { id } }) as any;
  const requests = (id: string) => prisma.mistCommandReceipt.count({ where: { workspaceId: id, NOT: { requestId: { startsWith: 'mist-revision:' } } } });

  it('两人基于同一版本同时保存不同记录：两条都保留', async () => {
    const id = await workspace();
    await prisma.mistWorkspace.update({ where: { id }, data: { state: { ...(await row(id)).state, memberIds: ['other'] } } });
    const [a, b] = await Promise.all([repo.execute(owner, id, note('甲')), repo.execute(testActor('other'), id, note('乙'))]);
    expect([a.receipt.revision, b.receipt.revision].sort()).toEqual([1, 2]);
    const saved = await row(id); expect(saved.revision).toBe(2); expect(saved.state.notes.map((n: any) => n.text).sort()).toEqual(['乙', '甲'].sort());
  });

  it('同一版本上同时新增不同记录：全部保留或明确冲突，不丢失已确认的保存', async () => {
    const id = await workspace();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => repo.execute(owner, id, note('n' + i))));
    const ok = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
    const saved = await row(id);
    expect(ok.length).toBeGreaterThanOrEqual(2);
    expect(saved.revision).toBe(ok.length);
    expect(saved.state.notes.map((n: any) => n.text).sort()).toEqual(ok.map(r => r.value.receipt.requestId).sort());
    expect(await requests(id)).toBe(ok.length + 1);
  });

  it('同时修改同一字段：只有一个成功，另一个明确冲突且不覆盖', async () => {
    const id = await workspace();
    const results = await Promise.allSettled([5, 7].map(cents => repo.execute(owner, id, { requestId: 'm' + cents, expectedRevision: 0, command: { type: 'money.add', payload: { cents } } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'REVISION_CONFLICT' });
    const saved = await row(id); expect(saved.revision).toBe(1); expect([5, 7]).toContain(saved.state.money.cents);
  });

  it('同一请求同时提交两次：只执行一次，两次都拿到同一回执', async () => {
    const id = await workspace();
    const [a, b] = await Promise.all([repo.execute(owner, id, note('same')), repo.execute(owner, id, note('same'))]);
    expect(a.receipt).toEqual(b.receipt); expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await row(id)).state.notes).toHaveLength(1); expect(await requests(id)).toBe(2);
  });

  it('附件同时上传：每个成功请求恰好一个文件，失败的不残留', async () => {
    const id = await workspace();
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => repo.upload(owner, id, { requestId: 'f' + i, expectedRevision: 0 }, { name: `f${i}.txt`, mimeType: 'text/plain', bytes: Buffer.from('x' + i) })));
    const ok = results.filter(r => r.status === 'fulfilled').length, saved = await row(id);
    expect(saved.state.files).toHaveLength(ok); expect(await readdir(path.join(root, id)).catch(() => [])).toHaveLength(ok);
  });
});
