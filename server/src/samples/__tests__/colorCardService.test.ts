/**
 * REQ2-09 Pantone 色号库回归测试（设计文档 §7 验收锚点）
 *
 * 覆盖：
 *   1. 列表/搜索（code/name 模糊 + family 筛选）
 *   2. 详情 + nearest（Lab ΔE 升序——蓝的最近邻是蓝不是橙，感知合理性锚点）
 *   3. 新增（重复 409 / 软删孪生复活 / RGB 0-255 校验）
 *   4. 维护（code 不可改 / rgb 更新）
 *   5. 软删 + 打色批次 code 快照不失真
 *   6. 相近历史打色（exact + includeNearby ΔE≤15 并集）
 *   7. seed 幂等（重复执行全 skip）
 *   8. createColorBatch colorCardId 解析落快照 + 不存在 400
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createColorCardService, deltaE76, NEARBY_DELTA_E } from '../colorCardService';
import { createColorBatchService } from '../colorBatchService';
import { PANTONE_TCX_SEED } from '../colorCardSeedData';

function makeCard(o: any = {}) {
  return { id: 'CLR__X1', code: '19-4052 TCX', name: 'Classic Blue', family: 'Blue', r: 0, g: 73, b: 144, source: 'seed', deletedAt: null, createdAt: BigInt(1), updatedAt: BigInt(1), ...o };
}

function makePrisma(overrides: { cards?: any[]; batches?: any[] } = {}) {
  const cards = overrides.cards ?? [];
  const batches = overrides.batches ?? [];
  const state = { cards: [...cards], batches: [...batches] };
  const prisma = {
    colorCard: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return state.cards.find((c: any) =>
          (w.id ? c.id === w.id : true)
          && (w.code ? c.code === w.code : true)
          && (w.deletedAt === null ? c.deletedAt == null : true)
          && (w.id?.not ? c.id !== w.id.not : true)
          && (w.code?.in ? w.code.in.includes(c.code) : true)
        ) ?? null;
      }),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        let out = state.cards.filter((c: any) => {
          if (w.deletedAt === null && c.deletedAt != null) return false;
          if (w.id?.not && c.id === w.id.not) return false;
          if (w.code?.in && !w.code.in.includes(c.code)) return false;
          if (w.family && c.family !== w.family) return false;
          return true;
        });
        if (w.OR) {
          const q = String(w.OR[0]?.code?.contains ?? '').toLowerCase();
          out = state.cards.filter((c: any) =>
            c.deletedAt == null && (
              c.code.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q)
            ));
        }
        return out;
      }),
      count: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        if (w.OR) {
          const q = String(w.OR[0]?.code?.contains ?? '').toLowerCase();
          return state.cards.filter((c: any) => c.deletedAt == null && (c.code.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))).length;
        }
        return state.cards.filter((c: any) => c.deletedAt == null && (!w.family || c.family === w.family)).length;
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => { state.cards.push(data); return data; }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const c = state.cards.find((x: any) => x.id === where.id);
        if (!c) throw new Error('not found');
        Object.assign(c, data);
        return c;
      }),
    },
    sampleColorBatch: {
      findMany: vi.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return state.batches.filter((b: any) =>
          b.deletedAt == null && (w.colorCode?.in ? w.colorCode.in.includes(b.colorCode) : true)
        );
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => { state.batches.push({ id: 'SCB__NEW', ...data }); return { id: 'SCB__NEW', ...data }; }),
      count: vi.fn().mockResolvedValue(0),
    },
    developmentCase: { findFirst: vi.fn().mockResolvedValue({ id: 'DEV-1', currentRound: 1, deletedAt: null }) },
    order: { findFirst: vi.fn().mockResolvedValue({ id: 'PO-1', deletedAt: null }) },
    relation: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { prisma: prisma as any, state };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('色彩科学：Lab ΔE76', () => {
  it('同色 ΔE=0；近似色 ΔE 小；互补色 ΔE 大（感知合理性锚点）', () => {
    const classicBlue = { r: 0, g: 73, b: 144 };
    const darkDenim = { r: 0, g: 65, b: 108 };   // 深牛仔蓝（近似）
    const orange = { r: 227, g: 88, b: 47 };      // 橙（互补）
    expect(deltaE76(classicBlue, classicBlue)).toBe(0);
    expect(deltaE76(classicBlue, darkDenim)).toBeLessThan(20);
    expect(deltaE76(classicBlue, orange)).toBeGreaterThan(60);
  });
});

describe('列表 / 搜索 / 详情', () => {
  it('code 与 name 模糊搜索 + total', async () => {
    const { prisma } = makePrisma({ cards: [
      makeCard(),
      makeCard({ id: 'CLR__X2', code: '19-0303 TCX', name: 'Jet Black', family: 'Black', r: 30, g: 30, b: 34 }),
      makeCard({ id: 'CLR__X3', code: '16-1546 TCX', name: 'Living Coral', family: 'Red', r: 255, g: 111, b: 97 }),
    ] });
    const svc = createColorCardService(prisma);
    const byCode = await svc.listColors({ search: '19-4052' });
    expect((byCode as any).data.items).toHaveLength(1);
    const byName = await svc.listColors({ search: 'coral' });
    expect((byName as any).data.items).toHaveLength(1);
    expect((byName as any).data.total).toBe(1);
  });

  it('nearest 按 ΔE 升序：Classic Blue 的最近邻是蓝系（非橙）', async () => {
    const { prisma } = makePrisma({ cards: [
      makeCard(),
      makeCard({ id: 'CLR__X2', code: '19-4024 TCX', name: 'Dark Denim', family: 'Blue', r: 0, g: 65, b: 108 }),
      makeCard({ id: 'CLR__X3', code: '18-4045 TCX', name: 'Deep Water', family: 'Blue', r: 28, g: 98, b: 145 }),
      makeCard({ id: 'CLR__X4', code: '16-1544 TCX', name: 'Tangerine Tango', family: 'Orange', r: 227, g: 88, b: 47 }),
    ] });
    const svc = createColorCardService(prisma);
    const r = await svc.getColorByCode('19-4052 TCX');
    expect(r.ok).toBe(true);
    const nearest = (r as any).data.nearest;
    expect(nearest).toHaveLength(3);
    // 前二为蓝系（ΔE 小），橙排最后（ΔE 大）
    expect(nearest[0].family).toBe('Blue');
    expect(nearest[1].family).toBe('Blue');
    expect(nearest[2].family).toBe('Orange');
    expect(nearest[0].deltaE).toBeLessThan(nearest[2].deltaE);
  });

  it('不存在的色号 → 404', async () => {
    const { prisma } = makePrisma();
    const svc = createColorCardService(prisma);
    expect(((await svc.getColorByCode('NOPE')) as any).error.status).toBe(404);
  });
});

describe('新增 / 维护 / 软删', () => {
  it('新增自定义色卡；重复 code → 409；RGB 越界 → 400', async () => {
    const { prisma } = makePrisma({ cards: [makeCard()] });
    const svc = createColorCardService(prisma);
    const ok = await svc.createColor({ code: 'CUST-NAVY-01', name: '客户藏青', family: 'Blue', r: 20, g: 40, b: 80 });
    expect(ok.ok).toBe(true);
    const dup = await svc.createColor({ code: '19-4052 TCX', r: 1, g: 1, b: 1 });
    expect(((dup as any).error.code)).toBe('CODE_DUPLICATED');
    const bad = await svc.createColor({ code: 'CUST-BAD', r: 300, g: 0, b: 0 });
    expect(((bad as any).error.code)).toBe('INVALID_RGB');
  });

  it('软删同码复活（唯一键不被死行占用）；code 不可改；rgb 可更新', async () => {
    const { prisma } = makePrisma({ cards: [makeCard({ deletedAt: BigInt(9) })] });
    const svc = createColorCardService(prisma);
    const revived = await svc.createColor({ code: '19-4052 TCX', name: 'Classic Blue', family: 'Blue', r: 0, g: 73, b: 144 });
    expect(revived.ok).toBe(true);
    expect((revived as any).data.revived).toBe(true);

    const live = makePrisma({ cards: [makeCard()] });
    const svc2 = createColorCardService(live.prisma);
    const imm = await svc2.updateColor('CLR__X1', { code: 'XX' });
    expect(((imm as any).error.code)).toBe('CODE_IMMUTABLE');
    const upd = await svc2.updateColor('CLR__X1', { r: 1, g: 74, b: 145 });
    expect((upd as any).data.color.r).toBe(1);

    const del = await svc2.deleteColor('CLR__X1');
    expect(del.ok).toBe(true);
  });
});

describe('相近历史打色（验收锚点）', () => {
  it('exact 命中同色号；includeNearby 并集 ΔE≤15 相近色打色', async () => {
    // 近似色 (4, 70, 140)：与 Classic Blue (0,73,144) ΔE < 5（真正视觉相近）
    const nearCard = makeCard({ id: 'CLR__X2', code: 'NEAR-BLUE', name: 'Near Blue', family: 'Blue', r: 4, g: 70, b: 140 });
    expect(deltaE76(makeCard(), nearCard)).toBeLessThanOrEqual(NEARBY_DELTA_E);
    const { prisma } = makePrisma({
      cards: [
        makeCard(),
        nearCard,
        makeCard({ id: 'CLR__X3', code: '16-1544 TCX', name: 'Tangerine', family: 'Orange', r: 227, g: 88, b: 47 }), // ΔE > 15 远色
      ],
      batches: [
        { id: 'B1', batchCode: 'SCB-1', stage: 'lab_dip', colorCode: '19-4052 TCX', dyeLotNo: '缸A', colorRating: 4, defectCauses: [], customerStatus: 'approved', supplierName: '染厂甲', createdAt: BigInt(3), deletedAt: null },
        { id: 'B2', batchCode: 'SCB-2', stage: 'lab_dip', colorCode: 'NEAR-BLUE', dyeLotNo: '缸B', colorRating: 3, defectCauses: ['blue_cast'], customerStatus: 'rejected', supplierName: '染厂乙', createdAt: BigInt(2), deletedAt: null },
        { id: 'B3', batchCode: 'SCB-3', stage: 'lab_dip', colorCode: '16-1544 TCX', dyeLotNo: '缸C', colorRating: 5, defectCauses: [], customerStatus: 'pending', supplierName: '染厂丙', createdAt: BigInt(1), deletedAt: null },
      ],
    });
    const svc = createColorCardService(prisma);
    const exact = await svc.listColorBatchesForColor('19-4052 TCX', false);
    expect((exact as any).data.batches).toHaveLength(1);
    expect((exact as any).data.batches[0].dyeLotNo).toBe('缸A');

    const nearby = await svc.listColorBatchesForColor('19-4052 TCX', true);
    const lots = (nearby as any).data.batches.map((b: any) => b.dyeLotNo);
    expect(lots).toContain('缸B');   // 近似色打色并入
    expect(lots).not.toContain('缸C'); // 远色排除
  });
});

describe('seed 幂等', () => {
  it('首跑全插；二跑全 skip（重复执行零副作用）', async () => {
    const { prisma, state } = makePrisma();
    const svc = createColorCardService(prisma);
    const r1 = await svc.seedPantoneTcx();
    expect(r1.inserted).toBe(PANTONE_TCX_SEED.length);
    expect(state.cards).toHaveLength(PANTONE_TCX_SEED.length);
    const r2 = await svc.seedPantoneTcx();
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(PANTONE_TCX_SEED.length);
    expect(state.cards).toHaveLength(PANTONE_TCX_SEED.length);
  });
});

describe('打色批次挂色号（DR-051-③）', () => {
  it('colorCardId 解析落 colorCode 快照；不存在 → 400', async () => {
    const { prisma } = makePrisma({ cards: [makeCard()] });
    const svc = createColorBatchService(prisma);
    const ok = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: '缸Z', colorRating: 4, colorCardId: 'CLR__X1' }, 'user');
    expect(ok.ok).toBe(true);
    expect((ok as any).data.batch.colorCardId).toBe('CLR__X1');
    expect((ok as any).data.batch.colorCode).toBe('19-4052 TCX');

    const bad = await svc.createColorBatch({ stage: 'lab_dip', developmentCaseId: 'DEV-1', dyeLotNo: '缸Z2', colorRating: 4, colorCardId: 'CLR__NOPE' }, 'user');
    expect(((bad as any).error.code)).toBe('COLOR_CARD_NOT_FOUND');
  });
});
