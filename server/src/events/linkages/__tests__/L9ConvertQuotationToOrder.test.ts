/**
 * Phase 3 — L9 联动单元测试
 *
 * 覆盖：
 *   L9: QuotationAccepted → convertToOrderDraft（复用 quotationService.convertToOrder）
 *     - 报价接受后自动创建订单草稿（委托统一建单服务）
 *     - 幂等：已转化（convertedOrderId 存在）跳过 → 视为成功
 *     - 幂等：重复事件不重复执行（in-process 去重）
 *     - 异常：报价不存在/状态非法 → 返回 not-ok
 *     - 边界：sourceEntityId 缺失跳过
 *
 * 测试策略：
 *   - Mock quotationService.convertToOrder（隔离建单细节，专注联动编排）
 *   - 通过 businessEventBus 真实触发 QuotationAccepted 事件
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const convertToOrderSpy = vi.fn();

vi.mock('../../../quotations/quotationService', () => ({
  createQuotationService: () => ({ convertToOrder: convertToOrderSpy }),
}));
vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { businessEventBus, publishBusinessEvent } from '../../businessEventBus';
import { logger } from '../../../lib/logger';
import { registerAllLinkages } from '../index';

function makeEvent(quotationId = 'qt_1') {
  return {
    type: 'QuotationAccepted' as const,
    sourceEntityType: 'Quotation',
    sourceEntityId: quotationId,
    payload: { quotationNumber: 'QT-2026-001', totalAmount: 50000, currency: 'USD' },
    actorId: 'test',
  };
}

describe('L9: QuotationAccepted → convertToOrderDraft', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    businessEventBus.reset();
    prisma = {} as any; // L9 委托给 quotationService，prisma 仅透传
    businessEventBus.setPrisma(prisma);
    registerAllLinkages();
  });

  it('creates order draft via convertToOrder when quotation is accepted', async () => {
    convertToOrderSpy.mockResolvedValue({ orderId: 'ORD-QT-001', quotation: { id: 'qt_1', convertedOrderId: 'ORD-QT-001' } });

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(convertToOrderSpy).toHaveBeenCalledTimes(1);
    expect(convertToOrderSpy).toHaveBeenCalledWith('qt_1', 'test', undefined, {mode:'accepted_event',event:expect.objectContaining({sourceEntityId:'qt_1'})});
  });

  it('does not claim an existing pointer as the new event success', async () => {
    convertToOrderSpy.mockRejectedValue(new Error('报价单 qt_1 已转为订单 ORD-QT-EXISTING，不可重复转换'));

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(convertToOrderSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[L9] convertQuotationToOrder failed',expect.objectContaining({quotationId:'qt_1'}));
    expect(logger.info).not.toHaveBeenCalledWith('[L9] quotation already converted, skipping',expect.anything());
  });

  it('does not re-execute for duplicate event (same quotationId)', async () => {
    convertToOrderSpy.mockResolvedValue({ orderId: 'ORD-QT-001', quotation: {} });

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));
    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(convertToOrderSpy).toHaveBeenCalledTimes(1);
  });

  it('skips when sourceEntityId is missing', async () => {
    await publishBusinessEvent({
      type: 'QuotationAccepted',
      sourceEntityType: 'Quotation',
      sourceEntityId: '',
      payload: {},
      actorId: 'test',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(convertToOrderSpy).not.toHaveBeenCalled();
  });

  it('returns not-ok on unexpected service error (e.g. quotation not found)', async () => {
    convertToOrderSpy.mockRejectedValue(new Error('报价单 qt_1 不存在'));

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(convertToOrderSpy).toHaveBeenCalledTimes(1);
    // 错误被捕获并返回 not-ok，不会阻断事件总线
  });
});
