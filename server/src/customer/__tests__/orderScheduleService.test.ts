/**
 * orderScheduleService.test.ts — H16-③ 订单进度对照
 *
 * 钉住的不变量：
 *   1. 交期达成判定四态：on_time / delayed / overdue / pending（+ 无交期 = unknown）
 *   2. **已交付用实际完成日**（ATA 优先，回退 ATD）算偏差；**未交付用今天**判是否逾期
 *   3. 多运单取极值：最早 ETD / 最晚 ATA
 *   4. Cancelled 运单排除
 *   5. 已交付但运单未登记实际日期 → 不猜日期（deviationDays=null），只给结论
 *   6. 数据边界：DTO 不含工厂/成本/内部备注
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildOrderSchedule } from '../orderScheduleService';

function makePrisma(seed: { order?: any; shipments?: any[]; allocations?: any[] } = {}) {
  const order = seed.order === undefined ? { id: 'O1', dueDate: '2026-09-30' } : seed.order;
  return {
    order: { findFirst: async () => order },
    shipmentOrderAllocation: { findMany: async () => seed.allocations ?? [] },
    shipment: { findMany: async () => seed.shipments ?? [] },
  } as any;
}

describe('buildOrderSchedule — 进度对照', () => {
  it('无交期 → unknown', async () => {
    const r = await buildOrderSchedule(makePrisma({ order: { id: 'O1', dueDate: null } }), 'O1');
    expect(r!.status).toBe('unknown');
    expect(r!.deviationDays).toBeNull();
  });

  it('已交付且**早于**交期 → on_time', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Delivered', etd: '2026-09-10', atd: '2026-09-12', eta: '2026-09-25', ata: '2026-09-24' }],
    }), 'O1', '2026-10-05');
    expect(r!.status).toBe('on_time');
    expect(r!.deviationDays).toBe(-6); // 09-24 早于 09-30 六天
    expect(r!.delivered).toBe(true);
    expect(r!.basis).toContain('早于交期');
  });

  it('已交付且**晚于**交期 → delayed（偏差天数为正）', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Delivered', etd: null, atd: '2026-10-02', eta: null, ata: '2026-10-08' }],
    }), 'O1', '2026-10-10');
    expect(r!.status).toBe('delayed');
    expect(r!.deviationDays).toBe(8);
    expect(r!.basis).toContain('晚于交期');
  });

  it('未交付且**已过期** → overdue（用今天判）', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Shipped', etd: '2026-09-20', atd: '2026-09-22', eta: '2026-10-05', ata: null }],
    }), 'O1', '2026-10-04'); // 交期 09-30，今天 10-04
    expect(r!.status).toBe('overdue');
    expect(r!.deviationDays).toBe(4);
    expect(r!.basis).toContain('逾期');
    expect(r!.basis).toContain('已发运');
  });

  it('未交付且**未到期** → pending', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Booked', etd: '2026-09-28', atd: null, eta: null, ata: null }],
    }), 'O1', '2026-09-20');
    expect(r!.status).toBe('pending');
    expect(r!.deviationDays).toBe(-10);
    expect(r!.basis).toContain('还有');
  });

  it('多运单取极值：最早 ETD / 最晚 ATA', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [
        { id: 'S1', status: 'Delivered', etd: '2026-09-10', atd: '2026-09-11', eta: '2026-09-20', ata: '2026-09-19' },
        { id: 'S2', status: 'Delivered', etd: '2026-09-05', atd: '2026-09-06', eta: '2026-09-28', ata: '2026-09-27' },
      ],
    }), 'O1', '2026-10-05');
    expect(r!.plannedEtd).toBe('2026-09-05'); // 最早
    expect(r!.actualAta).toBe('2026-09-27');  // 最晚
    expect(r!.actualAtd).toBe('2026-09-11');
  });

  it('Cancelled 运单排除（不算计划/实际，也不算已交付）', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [
        { id: 'S1', status: 'Cancelled', etd: '2026-01-01', atd: '2026-01-02', eta: '2026-01-03', ata: '2026-01-04' },
        { id: 'S2', status: 'Booked', etd: '2026-09-28', atd: null, eta: null, ata: null },
      ],
    }), 'O1', '2026-09-20');
    expect(r!.plannedEtd).toBe('2026-09-28'); // 不含被取消的 01-01
    expect(r!.actualAta).toBeNull();
    expect(r!.delivered).toBe(false);
    expect(r!.status).toBe('pending');
  });

  it('已交付但运单未登记实际日期 → 不猜日期（deviationDays=null）', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Delivered', etd: null, atd: null, eta: null, ata: null }],
    }), 'O1', '2026-10-05');
    expect(r!.status).toBe('on_time');
    expect(r!.deviationDays).toBeNull();
    expect(r!.basis).toContain('无法计算偏差');
  });

  it('经 DR-016 分配挂上来的运单也计入', async () => {
    const r = await buildOrderSchedule(makePrisma({
      allocations: [{ shipmentId: 'S9' }],
      shipments: [{ id: 'S9', status: 'Delivered', etd: '2026-09-10', atd: '2026-09-11', eta: '2026-09-25', ata: '2026-09-24' }],
    }), 'O1', '2026-10-05');
    expect(r!.delivered).toBe(true);
    expect(r!.actualAta).toBe('2026-09-24');
  });

  it('订单不存在 → null', async () => {
    const prisma: any = { order: { findFirst: async () => null } };
    expect(await buildOrderSchedule(prisma, 'NOPE')).toBeNull();
  });

  it('数据边界：DTO 不含工厂/成本/内部备注字段', async () => {
    const r = await buildOrderSchedule(makePrisma({
      shipments: [{ id: 'S1', status: 'Delivered', etd: null, atd: null, eta: null, ata: null }],
    }), 'O1');
    const keys = Object.keys(r!).sort();
    expect(keys).toEqual([
      'actualAta', 'actualAtd', 'basis', 'delivered', 'deviationDays',
      'dueDate', 'plannedEta', 'plannedEtd', 'status',
    ].sort());
    expect(keys).not.toContain('factory');
    expect(keys).not.toContain('cost');
  });
});
