/**
 * C4 关单闭环 — 报关单 → 运单回流单元测试
 *
 * 覆盖口径：
 *   1. 创建报关单关联 shipmentId → 事务内回填 Shipment.customsDeclarationNumber
 *   2. 未关联运单 / 运单已软删 → 静默跳过（不阻断报关单主流程）
 *   3. 放行（Released）→ 回填报关单号 + customsClearanceDate（当日 YYYY-MM-DD）
 *   4. 非放行流转（Submitted 等）→ 不回填（仅创建与 Released 两个写点）
 */

import { describe, expect, it, vi } from 'vitest';
import { createCustomsService } from '../customsService';
import { businessEventBus } from '../../events/businessEventBus';

vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// EntityLink 图谱同步与关单回流正交，mock 掉避免干扰断言
vi.mock('../../entities/sync', () => ({
  syncCustomsDeclarationReferences: vi.fn().mockResolvedValue(undefined),
  syncLetterOfCreditReferences: vi.fn().mockResolvedValue(undefined),
  syncTaxRefundReferences: vi.fn().mockResolvedValue(undefined),
  deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
}));

function makePrisma({ shipment }: { shipment: any }) {
  const shipmentUpdate = vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  const declStore: any = { id: 'CD1', declarationNumber: '222520260001234567', shipmentId: shipment?.id ?? null, status: 'Draft', deletedAt: null };

  const tx: any = {
    customsDeclaration: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: 'CD1', deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        Object.assign(declStore, data);
        return { ...declStore };
      }),
    },
    customsDeclarationLine: { create: vi.fn().mockResolvedValue({}) },
    shipment: {
      findUnique: vi.fn().mockImplementation(async () => shipment),
      update: shipmentUpdate,
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    customsDeclaration: {
      ...tx.customsDeclaration,
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        // createDeclaration 查重（by declarationNumber）→ null；transition 查 existing（by id）→ declStore
        if (where?.declarationNumber) return null;
        if (where?.id) return { ...declStore };
        return null;
      }),
    },
  };
  return { prisma, shipmentUpdate, declStore };
}

describe('C4 关单闭环 · 创建报关单回填运单', () => {
  it('关联运单时回填 customsDeclarationNumber，不写清关日期', async () => {
    const { prisma, shipmentUpdate } = makePrisma({ shipment: { id: 'SH1', deletedAt: null } });
    const service = createCustomsService(prisma);

    await service.createDeclaration({ declarationNumber: '222520260001234567', type: 'Export', shipmentId: 'SH1' }, 'tester');

    expect(shipmentUpdate).toHaveBeenCalledTimes(1);
    const data = shipmentUpdate.mock.calls[0][0].data;
    expect(data.customsDeclarationNumber).toBe('222520260001234567');
    expect(data.customsClearanceDate).toBeUndefined();
  });

  it('未关联运单 → 不回填；运单已软删 → 静默跳过', async () => {
    const noShipment = makePrisma({ shipment: null });
    const svcA = createCustomsService(noShipment.prisma);
    await svcA.createDeclaration({ declarationNumber: 'D-NOLINK', type: 'Export' }, 'tester');
    expect(noShipment.shipmentUpdate).not.toHaveBeenCalled();

    const deleted = makePrisma({ shipment: { id: 'SH1', deletedAt: BigInt(1) } });
    // 让报关单关联该运单
    deleted.prisma.customsDeclaration.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'CD1', shipmentId: 'SH1', deletedAt: null }));
    const svcB = createCustomsService(deleted.prisma);
    await svcB.createDeclaration({ declarationNumber: 'D-DELETED', type: 'Export', shipmentId: 'SH1' }, 'tester');
    expect(deleted.shipmentUpdate).not.toHaveBeenCalled();
  });
});

describe('C4 关单闭环 · 放行流转回填运单', () => {
  it('Released → 回填报关单号 + 当日清关日期', async () => {
    const { prisma, shipmentUpdate, declStore } = makePrisma({ shipment: { id: 'SH1', deletedAt: null } });
    declStore.status = 'Inspecting'; // Inspecting → Released 合法
    const service = createCustomsService(prisma);

    await service.transitionDeclarationStatus('CD1', 'Released', 'tester');

    expect(shipmentUpdate).toHaveBeenCalledTimes(1);
    const data = shipmentUpdate.mock.calls[0][0].data;
    expect(data.customsDeclarationNumber).toBe('222520260001234567');
    expect(data.customsClearanceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('非放行流转（Draft→Submitted）→ 不回填', async () => {
    const { prisma, shipmentUpdate } = makePrisma({ shipment: { id: 'SH1', deletedAt: null } });
    const service = createCustomsService(prisma);

    await service.transitionDeclarationStatus('CD1', 'Submitted', 'tester');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });

  it('放行但运单已软删 → 静默跳过，流转本身成功', async () => {
    const { prisma, shipmentUpdate, declStore } = makePrisma({ shipment: { id: 'SH1', deletedAt: BigInt(1) } });
    declStore.status = 'Inspecting';
    const service = createCustomsService(prisma);

    const result = await service.transitionDeclarationStatus('CD1', 'Released', 'tester');
    expect(result.status).toBe('Released');
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });
});
