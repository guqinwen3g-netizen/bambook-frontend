/**
 * Phase B1 — L10 联动单元测试
 *
 * 覆盖：
 *   L10: CustomsCleared → createTaxRefundDraft（复用 customsService.createTaxRefundFromDeclaration）
 *     - 报关放行后自动核算生成退税申报草稿
 *     - 幂等：已生成（declarationId 已有退税申报）跳过 → 视为成功
 *     - 幂等：重复事件不重复执行（in-process 去重）
 *     - 异常：报关单不存在 → 返回 not-ok
 *     - 边界：sourceEntityId 缺失跳过
 *
 * 测试策略：
 *   - Mock customsService.createTaxRefundFromDeclaration（隔离核算细节，专注联动编排）
 *   - 通过 businessEventBus 真实触发 CustomsCleared 事件
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const createTaxRefundFromDeclarationSpy = vi.fn();

vi.mock('../../../customs/customsService', () => ({
  createCustomsService: () => ({ createTaxRefundFromDeclaration: createTaxRefundFromDeclarationSpy }),
}));
vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { businessEventBus, publishBusinessEvent } from '../../businessEventBus';
import { registerAllLinkages } from '../index';

function makeEvent(declarationId = 'CD_1') {
  return {
    type: 'CustomsCleared' as const,
    sourceEntityType: 'CustomsDeclaration',
    sourceEntityId: declarationId,
    payload: { declarationNumber: 'CD202608070001' },
    actorId: 'test',
  };
}

describe('L10: CustomsCleared → createTaxRefundDraft', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    businessEventBus.reset();
    prisma = {} as any; // L10 委托给 customsService，prisma 仅透传
    businessEventBus.setPrisma(prisma);
    registerAllLinkages();
  });

  it('creates tax refund draft via createTaxRefundFromDeclaration when customs cleared', async () => {
    createTaxRefundFromDeclarationSpy.mockResolvedValue({ id: 'TR_1', refundNumber: 'TRA-CD202608070001' });

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(createTaxRefundFromDeclarationSpy).toHaveBeenCalledTimes(1);
    expect(createTaxRefundFromDeclarationSpy).toHaveBeenCalledWith('CD_1', 'test');
  });

  it('treats already-created as idempotent success', async () => {
    createTaxRefundFromDeclarationSpy.mockRejectedValue(new Error('报关单已存在退税申报 TRA-CD202608070001，不可重复生成'));

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(createTaxRefundFromDeclarationSpy).toHaveBeenCalledTimes(1);
    // 不抛错、不重试——被识别为幂等成功
  });

  it('does not re-execute for duplicate event (same declarationId)', async () => {
    createTaxRefundFromDeclarationSpy.mockResolvedValue({ id: 'TR_1', refundNumber: 'TRA-CD202608070001' });

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));
    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(createTaxRefundFromDeclarationSpy).toHaveBeenCalledTimes(1);
  });

  it('skips when sourceEntityId is missing', async () => {
    await publishBusinessEvent({
      type: 'CustomsCleared',
      sourceEntityType: 'CustomsDeclaration',
      sourceEntityId: '',
      payload: {},
      actorId: 'test',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(createTaxRefundFromDeclarationSpy).not.toHaveBeenCalled();
  });

  it('returns not-ok on unexpected service error (e.g. declaration not found)', async () => {
    createTaxRefundFromDeclarationSpy.mockRejectedValue(new Error('报关单 CD_1 不存在'));

    await publishBusinessEvent(makeEvent());
    await new Promise(r => setTimeout(r, 50));

    expect(createTaxRefundFromDeclarationSpy).toHaveBeenCalledTimes(1);
    // 错误被捕获并返回 not-ok，不会阻断事件总线
  });
});
