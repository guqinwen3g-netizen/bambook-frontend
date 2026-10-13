import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  nextBusinessNumber,
  peekNextBusinessNumber,
  resetBusinessSequenceForTest,
  isBusinessPrefix,
  type BusinessPrefix,
} from '../businessNumberService';
import { logger } from '../../lib/logger';

/**
 * S-QA businessNumberService 回归测试（新增独立文件，禁止修改既有文件）
 *
 * 覆盖点（增量于既有 server/src/__tests__/businessNumberService.test.ts）：
 *   既有测试为真实 Prisma 集成测试，本文件为纯 mock 单测，聚焦契约与边界：
 *   1. 编号格式契约：前缀/日期段/4 位补零；seq 超过 9999 后自然扩展不截断
 *   2. 序列存储键约定：SEQ_{prefix}_{year}（upsert/update/findUnique/deleteMany 均按此键）
 *   3. 原子性契约：取号只通过 DB 侧 `{ increment: 1 }` 递增（应用层不做 read-modify-write）
 *   4. 并发取号唯一性：Promise.all 50 并发，断言无重号且序号连续闭合
 *   5. 冲突路径：首次 upsert 冲突（模拟 P2002）→ QA-SEC-4A 限定重试后恢复；持续冲突超上限 → fail-closed 抛错
 *   6. 前缀隔离矩阵：21 个合法前缀各自独立从 0001 起号；交错取号互不影响
 *   7. 边界输入：非法/空/小写/null/undefined 前缀 → fail-closed 抛错且不触库
 *   8. 降级路径：db 无 businessSequence 模型 → 测试环境 next 走时间戳随机后缀（warn 留痕），peek 恒回 0001；
 *      生产环境（NODE_ENV≠test）→ QA-SEC-4B 直接 throw，禁止格式外编号
 *   9. peek 不消费序号（不触发任何写操作）
 *  10. reset 删除对应序列行后重新从 0001 起号
 *
 * 2026-08-17 总控仲裁（纪律文档 §6.1）：QA-SEC-4 修复后，P2002 与降级路径 2 项期望值由旧行为
 * 更新为新契约，由总控直接修订并复核。
 */

vi.mock('../../lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const CURRENT_YEAR = new Date().getFullYear();

/** 模拟 BusinessSequence 表的内存实现（upsert + 原子 increment 语义与 Prisma/Postgres 对齐） */
function makePrismaWithSequences() {
  const store = new Map<string, { id: string; prefix: string; year: number; seq: number }>();

  const businessSequence = {
    upsert: vi.fn(async ({ where, create }: any) => {
      let row = store.get(where.id);
      if (!row) {
        row = { ...create };
        store.set(where.id, row);
      }
      return { seq: row.seq };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.id);
      if (!row) throw new Error(`行不存在: ${where.id}`);
      if (data.seq?.increment) row.seq += data.seq.increment;
      return { seq: row.seq };
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = store.get(where.id);
      return row ? { seq: row.seq } : null;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const existed = store.delete(where.id);
      return { count: existed ? 1 : 0 };
    }),
  };

  const prisma: any = { businessSequence };
  return { prisma, store, businessSequence };
}

const ALL_PREFIXES: BusinessPrefix[] = [
  'QT', 'ORD', 'PO', 'INV', 'SH', 'CD', 'PV', 'IR', 'SM', 'BOM',
  'LC', 'TR', 'CI', 'PL', 'CO', 'BL', 'AWB', 'INS', 'IC', 'PC', 'EDP', 'SI', 'DOC',
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('businessNumberService 回归', () => {
  // ═══════════════════════════════════════════════════════════════
  // 编号格式契约
  // ═══════════════════════════════════════════════════════════════
  describe('编号格式契约', () => {
    it('首号 4 位补零：{PREFIX}-{YYYY}-0001', async () => {
      const { prisma } = makePrismaWithSequences();
      const num = await nextBusinessNumber(prisma, 'QT', 2030);
      expect(num).toBe('QT-2030-0001');
      expect(num).toMatch(/^QT-\d{4}-\d{4}$/);
    });

    it('序号达到 9999 后自然扩展为 5 位（10000），不截断不回绕', async () => {
      const { prisma, store } = makePrismaWithSequences();
      // 预置 seq=9998，验证跨位边界
      store.set('SEQ_QT_2030', { id: 'SEQ_QT_2030', prefix: 'QT', year: 2030, seq: 9998 });

      const n9999 = await nextBusinessNumber(prisma, 'QT', 2030);
      const n10000 = await nextBusinessNumber(prisma, 'QT', 2030);

      expect(n9999).toBe('QT-2030-9999');
      expect(n10000).toBe('QT-2030-10000');
    });

    it('三段结构完整：前缀、年份、序号各自解析正确', async () => {
      const { prisma } = makePrismaWithSequences();
      for (let i = 0; i < 3; i++) await nextBusinessNumber(prisma, 'INV', 2031);
      const num = await nextBusinessNumber(prisma, 'INV', 2031);
      const [prefix, year, seq] = num.split('-');
      expect(prefix).toBe('INV');
      expect(year).toBe('2031');
      expect(seq).toBe('0004');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 存储键与原子性契约
  // ═══════════════════════════════════════════════════════════════
  describe('存储键与原子性契约', () => {
    it('序列行 id 固定为 SEQ_{prefix}_{year}（upsert/update 使用同一键）', async () => {
      const { prisma, businessSequence, store } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'BOM', 2032);

      expect(businessSequence.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'SEQ_BOM_2032' } }),
      );
      expect(businessSequence.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'SEQ_BOM_2032' } }),
      );
      expect(store.has('SEQ_BOM_2032')).toBe(true);
    });

    it('递增只通过 DB 侧 { increment: 1 } 完成，应用层不回写 seq 绝对值', async () => {
      const { prisma, businessSequence } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'PO', 2033);

      const updateArg = businessSequence.update.mock.calls[0][0];
      expect(updateArg.data.seq).toEqual({ increment: 1 });
      // upsert 的 update 分支必须为空对象（占位，不做应用层修改）
      const upsertArg = businessSequence.upsert.mock.calls[0][0];
      expect(upsertArg.update).toEqual({ updatedAt: expect.any(BigInt) });
      // 首次创建从 seq=0 起，由 increment 推到 1
      expect(upsertArg.create.seq).toBe(0);
    });

    it('默认年份取当前系统年份', async () => {
      const { prisma, store } = makePrismaWithSequences();
      const num = await nextBusinessNumber(prisma, 'SH');
      expect(num).toBe(`SH-${CURRENT_YEAR}-0001`);
      expect(store.has(`SEQ_SH_${CURRENT_YEAR}`)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 序列自增语义
  // ═══════════════════════════════════════════════════════════════
  describe('序列自增语义', () => {
    it('同前缀同年连续取号严格递增且无跳号', async () => {
      const { prisma } = makePrismaWithSequences();
      const nums: string[] = [];
      for (let i = 0; i < 5; i++) nums.push(await nextBusinessNumber(prisma, 'ORD', 2034));
      expect(nums).toEqual([
        'ORD-2034-0001', 'ORD-2034-0002', 'ORD-2034-0003', 'ORD-2034-0004', 'ORD-2034-0005',
      ]);
    });

    it('同前缀不同年份各自从 0001 起号（跨年隔离）', async () => {
      const { prisma } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'CD', 2034);
      await nextBusinessNumber(prisma, 'CD', 2034);
      const num2034 = await nextBusinessNumber(prisma, 'CD', 2034);
      const num2035 = await nextBusinessNumber(prisma, 'CD', 2035);
      expect(num2034).toBe('CD-2034-0003');
      expect(num2035).toBe('CD-2035-0001');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 并发取号唯一性
  // ═══════════════════════════════════════════════════════════════
  describe('并发取号唯一性', () => {
    it('50 并发同前缀取号：无重号且序号闭合于 1..50', async () => {
      const { prisma } = makePrismaWithSequences();
      const numbers = await Promise.all(
        Array.from({ length: 50 }, () => nextBusinessNumber(prisma, 'TR', 2036)),
      );

      expect(new Set(numbers).size).toBe(50);
      const seqs = numbers.map((n) => parseInt(n.split('-')[2], 10)).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    });

    it('多前缀混合并发：各前缀各自闭合且互不重号', async () => {
      const { prisma } = makePrismaWithSequences();
      const jobs: Promise<string>[] = [];
      for (let i = 0; i < 20; i++) {
        jobs.push(nextBusinessNumber(prisma, 'QT', 2036));
        jobs.push(nextBusinessNumber(prisma, 'INV', 2036));
      }
      const numbers = await Promise.all(jobs);

      expect(new Set(numbers).size).toBe(40);
      const qtSeqs = numbers.filter((n) => n.startsWith('QT-'))
        .map((n) => parseInt(n.split('-')[2], 10)).sort((a, b) => a - b);
      const invSeqs = numbers.filter((n) => n.startsWith('INV-'))
        .map((n) => parseInt(n.split('-')[2], 10)).sort((a, b) => a - b);
      expect(qtSeqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(invSeqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it('首次 upsert 冲突（模拟 P2002 并发首插竞争）→ QA-SEC-4A 限定重试后恢复；持续冲突 → fail-closed 抛错', async () => {
      const { prisma, businessSequence } = makePrismaWithSequences();
      businessSequence.upsert.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      // 单次 P2002 → 自动重试（最多 3 次）并成功起号
      const num = await nextBusinessNumber(prisma, 'LC', 2037);
      expect(num).toBe('LC-2037-0001');
      expect(logger.warn).toHaveBeenCalledWith(
        '[BusinessNumber] upsert P2002, retrying',
        expect.objectContaining({ prefix: 'LC', year: 2037, attempt: 1 }),
      );

      // 持续 P2002（超过重试上限）→ 抛错，不发放任何编号
      businessSequence.upsert.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      await expect(nextBusinessNumber(prisma, 'TR', 2037)).rejects.toThrow('Unique constraint failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 前缀隔离矩阵
  // ═══════════════════════════════════════════════════════════════
  describe('前缀隔离矩阵', () => {
    it('全部 21 个合法前缀各自独立从 0001 起号', async () => {
      const { prisma } = makePrismaWithSequences();
      for (const prefix of ALL_PREFIXES) {
        const num = await nextBusinessNumber(prisma, prefix, 2038);
        expect(num).toBe(`${prefix}-2038-0001`);
      }
    });

    it('交错取号互不影响（QT/ORD/INV/BOM/DOC 轮换）', async () => {
      const { prisma } = makePrismaWithSequences();
      const round = async () => {
        const results: Record<string, string> = {};
        for (const p of ['QT', 'ORD', 'INV', 'BOM', 'DOC'] as BusinessPrefix[]) {
          results[p] = await nextBusinessNumber(prisma, p, 2039);
        }
        return results;
      };

      const r1 = await round();
      const r2 = await round();
      expect(r1).toEqual({
        QT: 'QT-2039-0001', ORD: 'ORD-2039-0001', INV: 'INV-2039-0001',
        BOM: 'BOM-2039-0001', DOC: 'DOC-2039-0001',
      });
      expect(r2).toEqual({
        QT: 'QT-2039-0002', ORD: 'ORD-2039-0002', INV: 'INV-2039-0002',
        BOM: 'BOM-2039-0002', DOC: 'DOC-2039-0002',
      });
    });

    it('isBusinessPrefix 接受基础单据和真实外部清关凭证的 23 个回归前缀', () => {
      const accepted = ALL_PREFIXES.filter((p) => isBusinessPrefix(p));
      expect(accepted).toHaveLength(23);
      expect(accepted.sort()).toEqual([...ALL_PREFIXES].sort());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 边界输入（fail-closed）
  // ═══════════════════════════════════════════════════════════════
  describe('边界输入 fail-closed', () => {
    it.each([
      ['未知前缀 XX', 'XX'],
      ['空前缀', ''],
      ['小写前缀 qt（大小写敏感）', 'qt'],
      ['含空格前缀', ' QT'],
      ['null', null],
      ['undefined', undefined],
    ])('nextBusinessNumber 拒绝%s → 抛错且不触库', async (_label, bad) => {
      const { prisma, businessSequence } = makePrismaWithSequences();
      await expect(nextBusinessNumber(prisma, bad as any, 2040)).rejects.toThrow('非法业务编号前缀');
      expect(businessSequence.upsert).not.toHaveBeenCalled();
      expect(businessSequence.update).not.toHaveBeenCalled();
    });

    it.each([
      ['未知前缀 ZZ', 'ZZ'],
      ['空前缀', ''],
    ])('peekNextBusinessNumber 拒绝%s → 抛错且不触库', async (_label, bad) => {
      const { prisma, businessSequence } = makePrismaWithSequences();
      await expect(peekNextBusinessNumber(prisma, bad as any, 2040)).rejects.toThrow('非法业务编号前缀');
      expect(businessSequence.findUnique).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 降级路径（db 无 businessSequence 模型）
  // ═══════════════════════════════════════════════════════════════
  describe('降级路径（无 businessSequence 模型）', () => {
    it('next 降级为时间戳随机后缀（仅测试环境）：格式 {PREFIX}-{YYYY}-{6位时间戳}{4位随机}，且 warn 留痕', async () => {
      const num = await nextBusinessNumber({} as any, 'QT', 2041);
      expect(num).toMatch(/^QT-2041-\d{6}[0-9a-z]{4}$/);
      // QA-SEC-4B：降级仅限测试注入，warn 文案如实标注 test-only
      expect(logger.warn).toHaveBeenCalledWith(
        '[BusinessNumber] fallback to timestamp (test-only injection)',
        expect.objectContaining({ prefix: 'QT', year: 2041 }),
      );
    });

    it('降级路径两次取号不重复（时间戳+随机组合）', async () => {
      const nums = await Promise.all(
        Array.from({ length: 20 }, () => nextBusinessNumber({} as any, 'SM', 2041)),
      );
      expect(new Set(nums).size).toBe(20);
    });

    it('peek 降级恒回 0001 且不告警（纯展示无副作用）', async () => {
      const peek = await peekNextBusinessNumber({} as any, 'QT', 2041);
      expect(peek).toBe('QT-2041-0001');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // peek 预览语义
  // ═══════════════════════════════════════════════════════════════
  describe('peek 预览语义', () => {
    it('空序列预览 0001，且全程不触发任何写操作', async () => {
      const { prisma, businessSequence } = makePrismaWithSequences();
      const peek = await peekNextBusinessNumber(prisma, 'AWB', 2042);
      expect(peek).toBe('AWB-2042-0001');
      expect(businessSequence.upsert).not.toHaveBeenCalled();
      expect(businessSequence.update).not.toHaveBeenCalled();
      expect(businessSequence.deleteMany).not.toHaveBeenCalled();
    });

    it('已分配 N 个后预览 N+1，预览本身不推进序列', async () => {
      const { prisma, store } = makePrismaWithSequences();
      store.set('SEQ_INS_2042', { id: 'SEQ_INS_2042', prefix: 'INS', year: 2042, seq: 7 });

      expect(await peekNextBusinessNumber(prisma, 'INS', 2042)).toBe('INS-2042-0008');
      expect(await peekNextBusinessNumber(prisma, 'INS', 2042)).toBe('INS-2042-0008');
      expect(store.get('SEQ_INS_2042')!.seq).toBe(7);
    });

    it('peek 后真实取号与预览值一致（预览口径可信）', async () => {
      const { prisma } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'PC', 2043);
      const peek = await peekNextBusinessNumber(prisma, 'PC', 2043);
      const actual = await nextBusinessNumber(prisma, 'PC', 2043);
      expect(peek).toBe('PC-2043-0002');
      expect(actual).toBe(peek);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // reset 语义（仅测试补偿用）
  // ═══════════════════════════════════════════════════════════════
  describe('reset 语义', () => {
    it('reset 删除对应 prefix+year 的序列行（按 SEQ_{prefix}_{year} 键）并 warn 留痕', async () => {
      const { prisma, businessSequence, store } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'CI', 2044);
      expect(store.has('SEQ_CI_2044')).toBe(true);

      await resetBusinessSequenceForTest(prisma, 'CI', 2044);
      expect(businessSequence.deleteMany).toHaveBeenCalledWith({ where: { id: 'SEQ_CI_2044' } });
      expect(store.has('SEQ_CI_2044')).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        '[BusinessNumber] sequence reset (test only)',
        expect.objectContaining({ prefix: 'CI', year: 2044 }),
      );
    });

    it('reset 只影响目标 prefix+year，其他年份/前缀序列保留', async () => {
      const { prisma, store } = makePrismaWithSequences();
      await nextBusinessNumber(prisma, 'CO', 2044);
      await nextBusinessNumber(prisma, 'CO', 2045);
      await nextBusinessNumber(prisma, 'BL', 2044);

      await resetBusinessSequenceForTest(prisma, 'CO', 2044);

      expect(store.has('SEQ_CO_2044')).toBe(false);
      expect(store.has('SEQ_CO_2045')).toBe(true);
      expect(store.has('SEQ_BL_2044')).toBe(true);

      // 被 reset 的重新从 0001 起号，未 reset 的继续递增
      expect(await nextBusinessNumber(prisma, 'CO', 2044)).toBe('CO-2044-0001');
      expect(await nextBusinessNumber(prisma, 'BL', 2044)).toBe('BL-2044-0002');
    });

    it('reset 对无 businessSequence 模型的 db 静默通过（不抛错）', async () => {
      await expect(resetBusinessSequenceForTest({} as any, 'CO', 2044)).resolves.toBeUndefined();
    });
  });
});
