/**
 * seed-backup-verify-mock —— 给隔离 / 开发 PostgreSQL 写入备份恢复核验用的**模拟数据**。
 *
 * 只写模拟账号 mock-backup-verify-owner 与它名下的两个工作空间（演示种子 + 空白），并提交若干条设置命令，
 * 让库里有 revision、事件与命令回执可供比对。重复运行会再追加一轮命令（幂等创建账号与工作空间）。
 * 安全门：只接受本机回环地址，且库名必须含 verify / test / local / dev / sandbox 之一；不读取 .env。
 *   BACKUP_VERIFY_SOURCE_URL=postgresql://postgres@127.0.0.1:55432/bambook_local_verify npx tsx scripts/seed-backup-verify-mock.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const raw = process.env.BACKUP_VERIFY_SOURCE_URL;
if (!raw) { console.error('需要 BACKUP_VERIFY_SOURCE_URL'); process.exit(2); }
const url = new URL(raw), db = decodeURIComponent(url.pathname.slice(1));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { console.error('拒绝：模拟数据只写入本机回环地址上的隔离库'); process.exit(2); }
if (!/(verify|test|local|dev|sandbox)/i.test(db)) { console.error(`拒绝：库名 ${db} 不像隔离 / 开发库`); process.exit(2); }

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const { MistRepository } = await import('../src/mist/repository');
  const { MistPrivateFiles } = await import('../src/mist/files');
  const contract = await import('../src/shared/mistWorkspace');
  const prisma = new PrismaClient({ datasourceUrl: raw });
  try {
    const owner = 'mock-backup-verify-owner';
    await prisma.userAccount.upsert({ where: { id: owner }, update: { status: 'active' }, create: { id: owner, displayName: '模拟·备份核验所有者', email: 'backup-verify-owner@example.invalid', status: 'active' } });
    const repo = new MistRepository(prisma, contract as any, new MistPrivateFiles(mkdtempSync(path.join(tmpdir(), 'mist-backup-verify-files-'))));
    const actor = { userId: owner, displayName: '模拟·备份核验所有者', roles: [], departmentIds: [], permissions: [] } as any;
    const ids: string[] = [];
    for (const [slug, seed] of [['backup-verify-demo', 'demo'], ['backup-verify-empty', 'empty']] as const) {
      const existing = await prisma.mistWorkspace.findUnique({ where: { ownerId_slug: { ownerId: owner, slug } } });
      ids.push(existing ? existing.id : (await repo.create(actor, { name: `模拟·${seed === 'demo' ? '演示' : '空白'}空间`, slug, seed })).id);
    }
    for (const id of ids) for (let i = 0; i < 5; i++) {
      const { revision } = await prisma.mistWorkspace.findUniqueOrThrow({ where: { id }, select: { revision: true } });
      await repo.execute(actor, id, { requestId: 'seed-' + randomUUID(), expectedRevision: revision, command: { type: 'settings.update', payload: { theme: i % 2 ? 'dark' : 'light' } } as any });
    }
    const rows = await prisma.mistWorkspace.findMany({ where: { id: { in: ids } }, select: { id: true, revision: true } });
    console.log(JSON.stringify({ owner, workspaces: rows }, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error('写入模拟数据失败：', error?.message || error); process.exit(1); });
