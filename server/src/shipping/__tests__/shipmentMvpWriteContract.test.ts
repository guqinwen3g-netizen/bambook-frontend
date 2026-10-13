import { describe, expect, it, vi } from 'vitest';
import { createShipment, updateShipment, validateShipmentActualDeparture } from '../shipmentMutationService';

describe('MVP 出运写入边界', () => {
  it('实际出运日必须是有效 ATD 日期；ETD 不能替代实际离港事实', async () => {
    expect(validateShipmentActualDeparture('2026-10-07')).toBeNull();
    expect(validateShipmentActualDeparture('2026-02-29')).toContain('ATD');
    expect(validateShipmentActualDeparture('')).toContain('ATD');

    const transaction = vi.fn();
    const result = await createShipment({
      prisma: { $transaction: transaction } as any,
      actorId: 'actor-test',
      input: { type: 'Export', shippingMethod: 'Sea', status: 'Shipped', etd: '2026-10-07' } as any,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('实际离港/起飞');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('即使带有效 ATD，Export 也不能通过旧创建接口直接创建为 Shipped', async () => {
    const transaction = vi.fn();
    const result = await createShipment({
      prisma: { $transaction: transaction } as any,
      actorId: 'actor-test',
      input: { type: 'Export', shippingMethod: 'Sea', status: 'Shipped', atd: '2026-10-07' } as any,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GATE_BLOCKED');
    expect(result.error?.message).toContain('草稿');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('普通出运创建拒绝陆运、铁路、快递和自提，且在打开事务前拒绝', async () => {
    const transaction = vi.fn();
    for (const shippingMethod of ['Land', 'Rail', 'Courier', 'Pickup']) {
      const result = await createShipment({
        prisma: { $transaction: transaction } as any,
        actorId: 'actor-test',
        input: { type: 'Export', shippingMethod } as any,
      });
      expect(result.ok, shippingMethod).toBe(false);
      expect(result.error?.code, shippingMethod).toBe('INVALID_SHIPPING_METHOD');
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('创建和修改都拒绝预计/实际到港字段，不把目的地阶段写入运单', async () => {
    const transaction = vi.fn();
    const create = await createShipment({
      prisma: { $transaction: transaction } as any,
      actorId: 'actor-test',
      input: { type: 'Export', shippingMethod: 'Sea', eta: '2026-10-20' } as any,
    });
    expect(create.ok).toBe(false);
    expect(create.error?.code).toBe('VALIDATION_ERROR');
    expect(create.error?.message).toContain('不记录目的地预计/实际到港时间');

    const update = await updateShipment({
      prisma: {} as any,
      shipmentId: 'shipment-test',
      patch: { ata: '2026-10-20' } as any,
      hasStatus: false,
      actorId: 'actor-test',
    });
    expect(update.ok).toBe(false);
    expect(update.error?.code).toBe('VALIDATION_ERROR');
    expect(update.error?.message).toContain('不记录目的地预计/实际到港时间');
  });

  it('创建和修改都拒绝独立保险字段，且在打开事务前拒绝', async () => {
    const transaction = vi.fn();
    const create = await createShipment({
      prisma: { $transaction: transaction } as any,
      actorId: 'actor-test',
      input: { type: 'Export', shippingMethod: 'Sea', insuranceAmount: null } as any,
    });
    expect(create.ok).toBe(false);
    expect(create.error?.code).toBe('VALIDATION_ERROR');
    expect(create.error?.message).toContain('不登记独立保险字段');

    const update = await updateShipment({
      prisma: {} as any,
      shipmentId: 'shipment-test',
      patch: { insuranceCurrency: 'USD' } as any,
      hasStatus: false,
      actorId: 'actor-test',
    });
    expect(update.ok).toBe(false);
    expect(update.error?.code).toBe('VALIDATION_ERROR');
    expect(update.error?.message).toContain('不登记独立保险字段');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('修改运单时也拒绝将历史自提方式作为当前 MVP 的新值保存', async () => {
    const result = await updateShipment({
      prisma: {} as any,
      shipmentId: 'shipment-test',
      patch: { shippingMethod: 'Pickup' } as any,
      hasStatus: false,
      actorId: 'actor-test',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_SHIPPING_METHOD');
  });
});
