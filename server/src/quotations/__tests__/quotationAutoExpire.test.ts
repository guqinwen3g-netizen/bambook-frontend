import { describe, expect, it, vi } from 'vitest';
import { createQuotationService } from '../quotationService';

/**
 * C15 报价单自动过期（查询时检查方案，不做定时任务）：
 *   - listQuotations / getQuotation 读取路径发现 validUntil 已过的 Draft/Sent 单 → 当场落库翻转 Expired
 *   - 状态过滤视角下被翻转的行从本次结果剔除，total 相应调整
 *   - 「有效期至」含当日：validUntil === 今天不过期；终态（Accepted/Rejected/Expired）不触碰
 */

const PAST = '2020-01-01';
const FUTURE = '2099-12-31';
const TODAY = new Date().toISOString().slice(0, 10);

function makeListPrisma(items: any[], total = items.length) {
  const quotationFindMany = vi.fn().mockResolvedValue(items);
  const quotationCount = vi.fn().mockResolvedValue(total);
  const quotationUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const prisma: any = {
    quotation: {
      findMany: quotationFindMany,
      count: quotationCount,
      updateMany: quotationUpdateMany,
    },
  };
  return { prisma, quotationFindMany, quotationUpdateMany };
}

function makeDetailPrisma(existing: any) {
  const quotationFindUnique = vi.fn().mockResolvedValue(existing);
  const quotationUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...existing, ...data, id: where.id }));
  const prisma: any = {
    quotation: {
      findUnique: quotationFindUnique,
      update: quotationUpdate,
    },
  };
  return { prisma, quotationUpdate };
}

describe('C15 listQuotations：查询时自动过期', () => {
  it('validUntil 已过的 Draft/Sent 单 → updateMany 翻转 Expired，返回状态已更新', async () => {
    const items = [
      { id: 'QT_1', status: 'Draft', validUntil: PAST },
      { id: 'QT_2', status: 'Sent', validUntil: PAST },
      { id: 'QT_3', status: 'Sent', validUntil: FUTURE },
      { id: 'QT_4', status: 'Accepted', validUntil: PAST }, // 终态不触碰
    ];
    const { prisma, quotationUpdateMany } = makeListPrisma(items);
    const service = createQuotationService(prisma);

    const result = await service.listQuotations({});

    expect(quotationUpdateMany).toHaveBeenCalledTimes(1);
    expect(quotationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['QT_1', 'QT_2'] } },
      data: expect.objectContaining({ status: 'Expired' }),
    }));
    expect(result.items.map((q: any) => q.status)).toEqual(['Expired', 'Expired', 'Sent', 'Accepted']);
    expect(result.total).toBe(4);
  });

  it('status=Draft 过滤视角：被翻转的行从本次结果剔除且 total 相应调整', async () => {
    const items = [
      { id: 'QT_1', status: 'Draft', validUntil: PAST },
      { id: 'QT_2', status: 'Draft', validUntil: FUTURE },
    ];
    const { prisma } = makeListPrisma(items, 2);
    const service = createQuotationService(prisma);

    const result = await service.listQuotations({ status: 'Draft' });

    expect(result.items.map((q: any) => q.id)).toEqual(['QT_2']);
    expect(result.total).toBe(1);
  });

  it('「有效期至」含当日：validUntil === 今天不过期，不触发 updateMany', async () => {
    const items = [{ id: 'QT_1', status: 'Draft', validUntil: TODAY }];
    const { prisma, quotationUpdateMany } = makeListPrisma(items);
    const service = createQuotationService(prisma);

    const result = await service.listQuotations({});

    expect(quotationUpdateMany).not.toHaveBeenCalled();
    expect(result.items[0].status).toBe('Draft');
  });

  it('无 validUntil 或全部未过期 → 不触发 updateMany', async () => {
    const items = [
      { id: 'QT_1', status: 'Draft', validUntil: null },
      { id: 'QT_2', status: 'Sent', validUntil: FUTURE },
    ];
    const { prisma, quotationUpdateMany } = makeListPrisma(items);
    const service = createQuotationService(prisma);

    await service.listQuotations({});

    expect(quotationUpdateMany).not.toHaveBeenCalled();
  });
});

describe('C15 getQuotation：详情读取自动过期', () => {
  it('validUntil 已过的 Draft 单 → update 翻转 Expired 并返回终态', async () => {
    const existing = { id: 'QT_1', status: 'Draft', validUntil: PAST, deletedAt: null, lines: [] };
    const { prisma, quotationUpdate } = makeDetailPrisma(existing);
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('QT_1');

    expect(quotationUpdate).toHaveBeenCalledTimes(1);
    expect(quotationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'QT_1' },
      data: expect.objectContaining({ status: 'Expired' }),
    }));
    expect(result?.status).toBe('Expired');
  });

  it('validUntil 已过的 Accepted 终态单 → 不触碰', async () => {
    const existing = { id: 'QT_1', status: 'Accepted', validUntil: PAST, deletedAt: null, lines: [] };
    const { prisma, quotationUpdate } = makeDetailPrisma(existing);
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('QT_1');

    expect(quotationUpdate).not.toHaveBeenCalled();
    expect(result?.status).toBe('Accepted');
  });

  it('未过期单 → 不触发 update', async () => {
    const existing = { id: 'QT_1', status: 'Sent', validUntil: FUTURE, deletedAt: null, lines: [] };
    const { prisma, quotationUpdate } = makeDetailPrisma(existing);
    const service = createQuotationService(prisma);

    const result = await service.getQuotation('QT_1');

    expect(quotationUpdate).not.toHaveBeenCalled();
    expect(result?.status).toBe('Sent');
  });
});
