import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nextBusinessNumber } from '../businessNumberService';

/**
 * 取号「占用追平」的软删语义 —— 跨模块不变量门禁
 *
 * 背景（2026-09-17 真库实测踩到）：
 *   真库 `panda_hub_local` 里有 1 张**软删**的 `CD-2026-0001`，序列停在 0。
 *   `createDeclaration` 的 occupied 回调带了 `deletedAt: null` → 判「未占用」→
 *   生成 `CD-2026-0001` → **DB 唯一约束不排除软删行** → P2002 → 整个事务回滚
 *   → 用户**建不了报关单**（HTTP 400，报的还是原始 Prisma 错误）。
 *
 * 为什么这类 bug 特别值得一条门禁：
 *   `nextBusinessNumber` 的文档注释明写「校验目标表（**含软删行**）实际占用」，
 *   但**注释管不住调用方**。仓里 10 处 `occupied:` 回调中，只有 customsService 的
 *   3 处（报关单/信用证/退税单）自作主张加了 `deletedAt: null`，其余 7 处都对。
 *   这种「一处写错、注释说对」的偏差，只有把不变量变成会失败的测试才拦得住。
 */
vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** 内存序列（upsert + 原子 increment，语义对齐 Prisma/Postgres） */
function makePrismaWithSequences() {
  const store = new Map<string, { id: string; prefix: string; year: number; seq: number }>();
  const businessSequence = {
    upsert: vi.fn(async ({ where, create }: any) => {
      let row = store.get(where.id);
      if (!row) { row = { ...create }; store.set(where.id, row); }
      return { seq: row.seq };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.id);
      if (!row) throw new Error(`行不存在: ${where.id}`);
      if (data.seq?.increment) row.seq += data.seq.increment;
      return { seq: row.seq };
    }),
    findUnique: vi.fn(async ({ where }: any) => (store.get(where.id) ?? null)),
    deleteMany: vi.fn(async ({ where }: any) => ({ count: store.delete(where.id) ? 1 : 0 })),
  };
  return { prisma: { businessSequence } as any, store };
}

/** 模拟 Prisma/Postgres 的唯一约束：**软删行同样占号**（这是 bug 的根源） */
function makeBusinessTable(seed: Array<{ number: string; deletedAt: bigint | null }>) {
  const rows = [...seed];
  return {
    rows,
    create(number: string) {
      if (rows.some((r) => r.number === number)) {
        throw Object.assign(
          new Error('Unique constraint failed on the fields: (`declarationNumber`)'),
          { code: 'P2002' },
        );
      }
      rows.push({ number, deletedAt: null });
      return number;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('取号占用：软删行必须算「已占用」', () => {
  it('★ 复现真库故障：occupied 带 deletedAt:null → 生成撞号，创建直接 P2002', async () => {
    const { prisma } = makePrismaWithSequences();
    const table = makeBusinessTable([{ number: 'CD-2026-0001', deletedAt: 123n }]);

    // 错误实现：把软删行排除在「已占用」之外
    const occupiedIgnoringSoftDeleted = async (num: string) =>
      table.rows.some((r) => r.number === num && r.deletedAt == null);

    const num = await nextBusinessNumber(prisma, 'CD', 2026, { occupied: occupiedIgnoringSoftDeleted });
    expect(num).toBe('CD-2026-0001');                        // 判成「未占用」→ 发放了这个号
    expect(() => table.create(num)).toThrow(/Unique constraint/); // → 撞唯一键，事务回滚
  });

  it('★ 正确实现：occupied 含软删行 → 自动跳过 0001 发放 0002', async () => {
    const { prisma } = makePrismaWithSequences();
    const table = makeBusinessTable([{ number: 'CD-2026-0001', deletedAt: 123n }]);

    const occupiedIncludingSoftDeleted = async (num: string) =>
      table.rows.some((r) => r.number === num);

    const num = await nextBusinessNumber(prisma, 'CD', 2026, { occupied: occupiedIncludingSoftDeleted });
    expect(num).toBe('CD-2026-0002');
    expect(() => table.create(num)).not.toThrow();
  });

  it('连续多个软删占号 → 一路追平到首个真正空号', async () => {
    const { prisma } = makePrismaWithSequences();
    const table = makeBusinessTable([
      { number: 'CD-2027-0001', deletedAt: 1n },
      { number: 'CD-2027-0002', deletedAt: 2n },
      { number: 'CD-2027-0003', deletedAt: null }, // 活单也占号
    ]);
    const num = await nextBusinessNumber(prisma, 'CD', 2027, {
      occupied: async (n: string) => table.rows.some((r) => r.number === n),
    });
    expect(num).toBe('CD-2027-0004');
  });
});

// ════════════════════════════════════════════════════════════════════
// 跨模块不变量：所有 occupied 回调都不得过滤软删行
// ════════════════════════════════════════════════════════════════════

const SRC_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** 去掉注释：否则「解释为什么不能加 deletedAt」的注释本身会被当成违规（假阳性） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/**
 * 抽出每个 `occupied:` **回调**（只认 `occupied: async (` —— 排除 factoryService 里
 * 同名的 `occupied: Record<string, number>` 之类普通属性，那与取号无关）。
 */
function collectOccupiedCallbacks(): Array<{ file: string; snippet: string }> {
  const found: Array<{ file: string; snippet: string }> = [];
  for (const file of walk(SRC_ROOT)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const re = /occupied\s*:\s*async\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.push({ file: file.replace(SRC_ROOT, ''), snippet: src.slice(m.index, m.index + 260) });
    }
  }
  return found;
}

describe('occupied 回调软删语义（跨模块）', () => {
  it('仓里确实有多处 occupied 回调（守卫不是空集）', () => {
    const cbs = collectOccupiedCallbacks();
    expect(cbs.length).toBeGreaterThanOrEqual(5);
  });

  it('★ 没有任何 occupied 回调过滤 deletedAt（过滤即撞号）', () => {
    const bad = collectOccupiedCallbacks().filter(({ snippet }) => /deletedAt/.test(snippet));
    if (bad.length > 0) {
      throw new Error(
        `以下 occupied 回调带了 deletedAt 过滤 —— 软删行会被判为未占用，生成撞号（P2002）后整单创建失败：\n` +
        bad.map((b) => `  ${b.file}\n       ${b.snippet.split('\n').find((l) => l.includes('deletedAt'))?.trim()}`).join('\n') +
        `\n  修法：去掉 deletedAt 过滤（唯一约束在 DB 层不排除软删行）。`,
      );
    }
    expect(bad).toHaveLength(0);
  });
});
