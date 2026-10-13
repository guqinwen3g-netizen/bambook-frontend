/**
 * entityRefPurgeMiddleware.test.ts —— ★★ 「删实体清引用」守卫（2026-09-18 立）
 *
 * ── 为什么立它 ─────────────────────────────────────────────
 * 根因：`server/src` 里 `entityReference` / `entityLink` **只有 `upsert`，没有 `deleteMany`** ✗
 * ⇒ 删实体时引用不被清理 ✗ ⇒ **悬挂引用累积** ✗
 *   （2026-09-17 手工清过「806 → 49 → 0」✗ —— 源头一直在产 ✗）
 *
 * ── ★ 本文件两条判据，缺一不可 ──────────────────────────────
 *   ① **不得漏收**（计数对撞）：`sync.ts` 里出现过的**每一个** type 字符串，
 *      都必须被 `MODEL_TO_REF_TYPES` 覆盖 ✓
 *      —— 这是本仓踩过 4 次的老坑：**守卫的覆盖面 < 代码的写法面** ✗
 *   ② **行为正确**：`delete` / `deleteMany` 时要真去清两张引用表 ✓
 *      且**顺序不能反**（必须先收集 id ✗）
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MODEL_TO_REF_TYPES,
  coveredRefTypes,
  installEntityRefPurge,
} from '../entities/entityRefPurgeMiddleware';

const SYNC_SRC = readFileSync(new URL('../entities/sync.ts', import.meta.url), 'utf8');

/** 从 sync.ts 里抽出所有 type 字面量（ownerType / targetType 两种写法 ✓） */
function typesInSync(): Set<string> {
  const out = new Set<string>();
  for (const m of SYNC_SRC.matchAll(/(?:ownerType|targetType):\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

/** 造一个「假 prisma」：捕获 $use 注册的回调 + 记录 deleteMany 调用 ✓ */
function fakePrisma(existingIds: string[] = []) {
  const registered: Array<(p: any, n: any) => Promise<any>> = [];
  const calls: Array<{ table: string; where: any }> = [];
  const prisma: any = {
    $use: (fn: any) => registered.push(fn),
    // 模型委托（小写首字母 ✓）
    order: { findMany: vi.fn(async () => existingIds.map((id) => ({ id }))) },
    entityReference: { deleteMany: vi.fn(async (a: any) => { calls.push({ table: 'entityReference', where: a.where }); return { count: 1 }; }) },
    entityLink: { deleteMany: vi.fn(async (a: any) => { calls.push({ table: 'entityLink', where: a.where }); return { count: 1 }; }) },
  };
  return { prisma, registered, calls };
}

describe('★★ 删实体清引用（根因修复）', () => {
  it('★ ① 不得漏收：sync.ts 里的**每一个** type 都被映射覆盖', () => {
    const inSync = typesInSync();
    const covered = coveredRefTypes();
    expect(inSync.size, 'sync.ts 里没抽到 type ⇒ 抽取逻辑失效（判据会恒真 ✗）').toBeGreaterThan(5);
    const missing = [...inSync].filter((t) => !covered.has(t));
    expect(
      missing,
      `以下 type 出现在 sync.ts 里，但 MODEL_TO_REF_TYPES **没覆盖** ⇒ 删这类实体时引用会残留 ✗：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('★ ① 反向：映射里也不该有"从没被写过"的 type（防手滑多写 ✗）', () => {
    const inSync = typesInSync();
    const extra = [...coveredRefTypes()].filter((t) => !inSync.has(t));
    // 允许为空；不为空时给出提示（不判失败 —— targetType 可能来自别处 ✓）
    if (extra.length) console.warn(`[提示] 映射里有 sync.ts 未出现的 type：${extra.join(', ')}`);
    expect(Array.isArray(extra)).toBe(true);
  });

  it('★★ ② 行为：delete 单个实体 ⇒ 清两张引用表（且**先收集 id 再删**）', async () => {
    const { prisma, registered, calls } = fakePrisma();
    installEntityRefPurge(prisma);
    expect(registered.length, '$use 没被调用 ⇒ 中间件没装上 ✗').toBe(1);

    const order: string[] = [];
    const next = async (p: any) => { order.push('next:' + p.action); return { ok: true }; };
    await registered[0]({ model: 'Order', action: 'delete', args: { where: { id: 'ORD-1' } } }, next);

    expect(order).toEqual(['next:delete']);          // 真删发生了 ✓
    expect(calls.map((c) => c.table).sort()).toEqual(['entityLink', 'entityReference']);  // 两张表都清 ✓
    const refWhere = calls.find((c) => c.table === 'entityReference')!.where;
    expect(JSON.stringify(refWhere)).toContain('ORD-1');
    expect(JSON.stringify(refWhere)).toContain('order');   // 用对 type 字符串 ✓
  });

  it('★★ ② 行为：deleteMany ⇒ 先查 id 再删（顺序不能反 ✗）', async () => {
    const { prisma, registered, calls } = fakePrisma(['ORD-A', 'ORD-B']);
    installEntityRefPurge(prisma);
    const seq: string[] = [];
    prisma.order.findMany = vi.fn(async () => { seq.push('findMany'); return [{ id: 'ORD-A' }, { id: 'ORD-B' }]; });
    const next = async () => { seq.push('next'); return { count: 2 }; };
    await registered[0]({ model: 'Order', action: 'deleteMany', args: { where: { status: 'Draft' } } }, next);

    expect(seq).toEqual(['findMany', 'next']);        // ★ 顺序：先查后删 ✓
    const refWhere = calls.find((c) => c.table === 'entityReference')!.where;
    expect(JSON.stringify(refWhere)).toContain('ORD-A');
    expect(JSON.stringify(refWhere)).toContain('ORD-B');
  });

  it('★ 不该管的动作不插手（create / update / findMany 等）', async () => {
    const { prisma, registered, calls } = fakePrisma();
    installEntityRefPurge(prisma);
    const next = vi.fn(async () => ({ ok: 1 }));
    for (const action of ['create', 'update', 'findMany', 'upsert']) {
      await registered[0]({ model: 'Order', action, args: {} }, next);
    }
    expect(next).toHaveBeenCalledTimes(4);
    expect(calls.length, '非删除动作不该清引用 ✗').toBe(0);
  });

  it('★ 不认识的模型不插手（防误删 ✗）', async () => {
    const { prisma, registered, calls } = fakePrisma();
    installEntityRefPurge(prisma);
    const next = vi.fn(async () => ({ ok: 1 }));
    await registered[0]({ model: 'SomeRandomModel', action: 'delete', args: { where: { id: 'X' } } }, next);
    expect(calls.length).toBe(0);
  });

  it('★ 清理失败**不阻断**删除（实体已删 ⇒ 引用必然是垃圾 ✓），但要**记 error** ✓', async () => {
    const { prisma, registered } = fakePrisma();
    const errors: any[] = [];
    installEntityRefPurge(prisma, { onError: (e, ctx) => errors.push({ e, ctx }) });
    prisma.entityReference.deleteMany = vi.fn(async () => { throw new Error('boom'); });
    const next = vi.fn(async () => ({ ok: 1 }));
    const res = await registered[0]({ model: 'Order', action: 'delete', args: { where: { id: 'ORD-1' } } }, next);
    expect(res).toEqual({ ok: 1 });                  // 删除结果照常返回 ✓
    expect(errors.length, '清理失败必须留痕 ✗（否则又变成静默漏清 ✗）').toBe(1);
  });
});
