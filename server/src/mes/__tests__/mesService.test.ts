/**
 * MES 服务单元测试 — Phase 3 C2
 *
 * 覆盖：
 *   - WorkStation：CRUD + 软删除 + 重复编码校验 + 利用率
 *   - ProductionPlan：CRUD + 状态机（Draft→Confirmed→InProgress→Completed）+ 进度更新
 *   - WorkHour：CRUD + 汇总
 *   - PieceRateRule：CRUD + 软删除 + 重复编码校验
 *   - PieceRateRecord：自动金额计算 + 状态机（Pending→Confirmed→Paid）+ 汇总
 *   - OutsourcingOrder：CRUD + 状态机 + 自动 totalAmount + 到货验收
 *
 * 设计：
 *   - $transaction: (fn) => fn(tx) 透明穿透
 *   - 事件发布 fire-and-forget
 *   - 状态转换非法时 fail-closed
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMesService } from '../mesService';
import { businessEventBus } from '../../events/businessEventBus';

// ── Mock businessEventBus.publish ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── Mock logger ──
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(overrides: Record<string, any> = {}) {
  const auditLogCreate = vi.fn().mockResolvedValue({});
  let lastCreatedOSO: any = null;

  const tx = {
    workStation: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.wsFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    productionPlan: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.planFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    workHour: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue({}),
    },
    pieceRateRule: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.ruleFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    pieceRateRecord: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue({}),
    },
    outsourcingOrder: {
      // create 保存最近一次创建的数据，findUnique 回放该数据（模拟 Prisma 真实行为）
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        lastCreatedOSO = { ...data, deletedAt: null, lines: [] };
        return lastCreatedOSO;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, lines: [] })),
      findFirst: overrides.osoFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockImplementation(async () => lastCreatedOSO ?? { id: 'oso_1', orderNumber: 'OSO-001', lines: [] }),
    },
    outsourcingLine: {
      create: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: auditLogCreate },
    // EntityLink 图谱双写（阶段 D / D5 syncOutsourcingOrderReferences 事务内调用）
    entityReference: { upsert: vi.fn().mockResolvedValue({}) },
    entityLink: { upsert: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    ...tx,
    $transaction: overrides.transactionFail
      ? vi.fn().mockRejectedValue(new Error('TX_BOOM'))
      : vi.fn(async (fn: any) => fn(tx)),
    workStation: {
      ...tx.workStation,
      findFirst: overrides.wsFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.workStation.update,
    },
    productionPlan: {
      ...tx.productionPlan,
      findFirst: overrides.planFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.productionPlan.update,
    },
    workHour: {
      ...tx.workHour,
      findMany: vi.fn().mockResolvedValue([]),
    },
    pieceRateRule: {
      ...tx.pieceRateRule,
      findFirst: overrides.ruleFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.pieceRateRule.update,
    },
    pieceRateRecord: {
      ...tx.pieceRateRecord,
      findMany: vi.fn().mockResolvedValue([]),
    },
    outsourcingOrder: {
      ...tx.outsourcingOrder,
      findFirst: overrides.osoFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.outsourcingOrder.update,
      findUnique: tx.outsourcingOrder.findUnique,
    },
  };

  return prisma as any;
}

describe('MesService', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = makePrisma();
    publishSpy.mockClear();
  });

  // ══════════════════════════════════════════════════════════════
  // WorkStation
  // ══════════════════════════════════════════════════════════════
  describe('WorkStation', () => {
    it('creates a work station', async () => {
      const service = createMesService(prisma);
      const ws = await service.createWorkStation({
        code: 'WS-001', name: '缝纫线A', type: 'Sewing',
        capacityPerDay: 500, capacityUnit: 'PC',
      }, 'user_1');

      expect(ws.code).toBe('WS-001');
      expect(ws.type).toBe('Sewing');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws on duplicate code', async () => {
      prisma.workStation.findFirst
        .mockResolvedValueOnce({ id: 'ws_existing' }) // duplicate check
        .mockResolvedValueOnce(null); // findFirst for other uses
      const service = createMesService(prisma);
      await expect(
        service.createWorkStation({ code: 'WS-001', name: '缝纫线A', type: 'Sewing' }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('throws on invalid type', async () => {
      const service = createMesService(prisma);
      await expect(
        service.createWorkStation({ code: 'WS-002', name: '测试', type: 'Invalid' as any }, 'user_1'),
      ).rejects.toThrow('非法工位类型');
    });

    it('updates a work station', async () => {
      prisma.workStation.findFirst.mockResolvedValue({ id: 'ws_1', code: 'WS-001', type: 'Sewing' });
      const service = createMesService(prisma);
      const updated = await service.updateWorkStation('ws_1', { name: '缝纫线B', capacityPerDay: 600 }, 'user_1');
      expect(updated.name).toBe('缝纫线B');
    });

    it('soft-deletes a work station', async () => {
      prisma.workStation.findFirst.mockResolvedValue({ id: 'ws_1', deletedAt: null });
      const service = createMesService(prisma);
      await service.deleteWorkStation('ws_1', 'user_1');
      expect(prisma.workStation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws_1' },
          data: expect.objectContaining({ deletedAt: expect.any(BigInt) }),
        }),
      );
    });

    it('lists work stations by type', async () => {
      prisma.workStation.findMany.mockResolvedValue([{ id: 'ws_1', type: 'Sewing' }]);
      prisma.workStation.count.mockResolvedValue(1);
      const service = createMesService(prisma);
      const { items, total } = await service.listWorkStations({ type: 'Sewing' });
      expect(items).toHaveLength(1);
      expect(total).toBe(1);
      // 缺省不传 limit → 不分页（向后兼容全量返回）
      expect(prisma.workStation.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.any(Number) }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // ProductionPlan
  // ══════════════════════════════════════════════════════════════
  describe('ProductionPlan', () => {
    it('creates a production plan', async () => {
      prisma.workStation.findFirst.mockResolvedValue({ id: 'ws_1', deletedAt: null });
      const service = createMesService(prisma);
      const plan = await service.createProductionPlan({
        planNumber: 'PP-001', workStationId: 'ws_1',
        processType: 'Sewing', plannedQuantity: 1000, unit: 'PC',
        plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-15',
      }, 'user_1');

      expect(plan.planNumber).toBe('PP-001');
      expect(plan.status).toBe('Draft');
    });

    it('throws when work station not found', async () => {
      prisma.workStation.findFirst.mockResolvedValue(null);
      const service = createMesService(prisma);
      await expect(
        service.createProductionPlan({
          planNumber: 'PP-002', workStationId: 'ws_missing',
          processType: 'Sewing', plannedQuantity: 100, unit: 'PC',
          plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-15',
        }, 'user_1'),
      ).rejects.toThrow('工位');
    });

    it('throws on duplicate plan number', async () => {
      prisma.workStation.findFirst.mockResolvedValue({ id: 'ws_1' });
      prisma.productionPlan.findFirst.mockResolvedValueOnce({ id: 'pp_existing' });
      const service = createMesService(prisma);
      await expect(
        service.createProductionPlan({
          planNumber: 'PP-001', workStationId: 'ws_1',
          processType: 'Sewing', plannedQuantity: 100, unit: 'PC',
          plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-15',
        }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('transitions Draft → Confirmed → InProgress → Completed', async () => {
      // 模拟状态流转：每次 findFirst 返回当前状态
      const statusSequence = ['Draft', 'Confirmed', 'InProgress'];
      let callIndex = 0;
      prisma.productionPlan.findFirst.mockImplementation(() => {
        const status = statusSequence[callIndex] ?? 'Completed';
        callIndex++;
        return Promise.resolve({
          id: 'pp_1', status, planNumber: 'PP-001',
          workStationId: 'ws_1', orderId: 'ord_1',
          actualStartDate: status === 'InProgress' ? '2026-08-08' : null,
        });
      });

      const service = createMesService(prisma);
      await service.transitionPlanStatus('pp_1', 'Confirmed', 'user_1');
      await service.transitionPlanStatus('pp_1', 'InProgress', 'user_1');
      await service.transitionPlanStatus('pp_1', 'Completed', 'user_1');

      const events = publishSpy.mock.calls.map((c) => c[0].type);
      expect(events).toContain('ProductionPlanConfirmed');
      expect(events).toContain('ProductionPlanStarted');
      expect(events).toContain('ProductionPlanCompleted');
    });

    it('throws on illegal transition (Completed → InProgress)', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue({ id: 'pp_1', status: 'Completed' });
      const service = createMesService(prisma);
      await expect(
        service.transitionPlanStatus('pp_1', 'InProgress', 'user_1'),
      ).rejects.toThrow('非法状态转换');
    });

    it('updates progress only when InProgress', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue({ id: 'pp_1', status: 'InProgress', plannedQuantity: 1000 });
      const service = createMesService(prisma);
      const updated = await service.updatePlanProgress('pp_1', 500, 'user_1');
      expect(updated.actualQuantity).toBe(500);
    });

    it('throws when updating progress in non-InProgress status', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue({ id: 'pp_1', status: 'Draft' });
      const service = createMesService(prisma);
      await expect(
        service.updatePlanProgress('pp_1', 500, 'user_1'),
      ).rejects.toThrow('仅 InProgress');
    });

    it.each([
      { qualityAcceptedQty: -1, qualityRejectedQty: 1001 },
      { qualityAcceptedQty: Number.NaN },
      { qualityAcceptedQty: Infinity },
      { qualityAcceptedQty: 1000, qualityRejectedQty: -1 },
      { qualityAcceptedQty: 0, qualityRejectedQty: 0 },
      { qualityAcceptedQty: 400, qualityRejectedQty: 0 },
      { qualityAcceptedQty: 999.99999, qualityRejectedQty: 0.00001 },
    ])('rejects invalid or partial whole-order receipt without mutation: %j', async input => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({id:'oso_1',status:'InProduction',quantity:'1000'});
      const service=createMesService(prisma);
      await expect(service.receiveOutsourcing('oso_1',input,'user_1')).rejects.toThrow();
      expect(prisma.outsourcingOrder.update).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('only allows editing in Draft status', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue({ id: 'pp_1', status: 'Confirmed' });
      const service = createMesService(prisma);
      await expect(
        service.updateProductionPlan('pp_1', { plannedQuantity: 2000 }, 'user_1'),
      ).rejects.toThrow('仅 Draft 可编辑');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // WorkHour
  // ══════════════════════════════════════════════════════════════
  describe('WorkHour', () => {
    it('creates a work hour record', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue({ id: 'pp_1' });
      const service = createMesService(prisma);
      const wh = await service.createWorkHour({
        productionPlanId: 'pp_1', employeeId: 'emp_1', employeeName: '张三',
        workDate: '2026-08-07', hours: 8, overtimeHours: 2,
      }, 'user_1');

      expect(wh.hours).toBe(8);
      expect(wh.overtimeHours).toBe(2);
    });

    it('throws when plan not found', async () => {
      prisma.productionPlan.findFirst.mockResolvedValue(null);
      const service = createMesService(prisma);
      await expect(
        service.createWorkHour({ productionPlanId: 'pp_missing', workDate: '2026-08-07', hours: 8 }, 'user_1'),
      ).rejects.toThrow('排产单');
    });

    it('summarizes work hours by employee', async () => {
      prisma.workHour.findMany.mockResolvedValue([
        { employeeId: 'emp_1', employeeName: '张三', hours: '8', overtimeHours: '2' },
        { employeeId: 'emp_1', employeeName: '张三', hours: '7', overtimeHours: '1' },
        { employeeId: 'emp_2', employeeName: '李四', hours: '8', overtimeHours: '0' },
      ]);
      const service = createMesService(prisma);
      const summary = await service.getWorkHourSummary();
      expect(summary).toHaveLength(2);
      const zhangsan = summary.find((s: any) => s.employeeId === 'emp_1');
      expect(zhangsan.totalHours).toBe(15);
      expect(zhangsan.totalOvertime).toBe(3);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // PieceRateRule
  // ══════════════════════════════════════════════════════════════
  describe('PieceRateRule', () => {
    it('creates a piece rate rule', async () => {
      const service = createMesService(prisma);
      const rule = await service.createPieceRateRule({
        code: 'PRR-001', name: '缝纫计件', processType: 'Sewing',
        unit: 'PC', ratePerUnit: 2.5, effectiveFrom: '2026-08-07',
      }, 'user_1');

      expect(rule.code).toBe('PRR-001');
      expect(rule.ratePerUnit).toBe(2.5);
    });

    it('throws on duplicate code', async () => {
      prisma.pieceRateRule.findFirst.mockResolvedValueOnce({ id: 'prr_existing' });
      const service = createMesService(prisma);
      await expect(
        service.createPieceRateRule({
          code: 'PRR-001', name: '缝纫计件', processType: 'Sewing',
          unit: 'PC', ratePerUnit: 2.5, effectiveFrom: '2026-08-07',
        }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('soft-deletes and deactivates', async () => {
      prisma.pieceRateRule.findFirst.mockResolvedValue({ id: 'prr_1', deletedAt: null });
      const service = createMesService(prisma);
      await service.deletePieceRateRule('prr_1', 'user_1');
      expect(prisma.pieceRateRule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(BigInt), isActive: false }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // PieceRateRecord
  // ══════════════════════════════════════════════════════════════
  describe('PieceRateRecord', () => {
    it('auto-calculates amount from quantity × ratePerUnit', async () => {
      prisma.pieceRateRule.findFirst.mockResolvedValue({
        id: 'prr_1', ratePerUnit: '2.5', isActive: true, deletedAt: null,
      });
      const service = createMesService(prisma);
      const record = await service.createPieceRateRecord({
        pieceRateRuleId: 'prr_1', employeeId: 'emp_1', employeeName: '张三',
        workDate: '2026-08-07', quantity: 100, unit: 'PC',
      }, 'user_1');

      expect(record.quantity).toBe(100);
      expect(record.ratePerUnit).toBe(2.5);
      expect(record.amount).toBe(250); // 100 × 2.5
    });

    it('throws when rule not found or inactive', async () => {
      prisma.pieceRateRule.findFirst.mockResolvedValue(null);
      const service = createMesService(prisma);
      await expect(
        service.createPieceRateRecord({
          pieceRateRuleId: 'prr_missing', workDate: '2026-08-07', quantity: 100, unit: 'PC',
        }, 'user_1'),
      ).rejects.toThrow('不存在或已停用');
    });

    it('transitions Pending → Confirmed → Paid', async () => {
      const statusSequence = ['Pending', 'Confirmed'];
      let idx = 0;
      prisma.pieceRateRecord.findFirst.mockImplementation(() => {
        const status = statusSequence[idx] ?? 'Paid';
        idx++;
        return Promise.resolve({ id: 'prc_1', status });
      });

      const service = createMesService(prisma);
      await service.transitionPieceRateStatus('prc_1', 'Confirmed', 'user_1');
      await service.transitionPieceRateStatus('prc_1', 'Paid', 'user_1');
    });

    it('throws on illegal transition (Paid → Confirmed)', async () => {
      prisma.pieceRateRecord.findFirst.mockResolvedValue({ id: 'prc_1', status: 'Paid' });
      const service = createMesService(prisma);
      await expect(
        service.transitionPieceRateStatus('prc_1', 'Confirmed', 'user_1'),
      ).rejects.toThrow('非法状态转换');
    });

    it('summarizes amounts by employee', async () => {
      prisma.pieceRateRecord.findMany.mockResolvedValue([
        { employeeId: 'emp_1', employeeName: '张三', amount: '250', status: 'Confirmed' },
        { employeeId: 'emp_1', employeeName: '张三', amount: '100', status: 'Paid' },
        { employeeId: 'emp_2', employeeName: '李四', amount: '500', status: 'Pending' },
      ]);
      const service = createMesService(prisma);
      const summary = await service.getPiceRateSummary();
      expect(summary).toHaveLength(2);
      const zhangsan = summary.find((s: any) => s.employeeId === 'emp_1');
      expect(zhangsan.totalAmount).toBe(350);
      expect(zhangsan.confirmedAmount).toBe(250);
      expect(zhangsan.paidAmount).toBe(100);
    });

    it('prevents deleting paid records', async () => {
      prisma.pieceRateRecord.findFirst.mockResolvedValue({ id: 'prc_1', status: 'Paid' });
      const service = createMesService(prisma);
      await expect(
        service.deletePieceRateRecord('prc_1', 'user_1'),
      ).rejects.toThrow('已支付');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // OutsourcingOrder
  // ══════════════════════════════════════════════════════════════
  describe('OutsourcingOrder', () => {
    it('creates with auto-calculated totalAmount and lines', async () => {
      const service = createMesService(prisma);
      const order = await service.createOutsourcingOrder({
        orderNumber: 'OSO-001', supplierId: 'rel_1', orderId: 'ord_1',
        processType: 'Sewing', quantity: 1000, unit: 'PC',
        unitPrice: 5.5, currency: 'CNY',
        lines: [
          { processType: 'Sewing', description: '缝纫工序', quantity: 1000, unit: 'PC', unitPrice: 5.5 },
        ],
      }, 'user_1');

      expect(order.orderNumber).toBe('OSO-001');
      expect(order.totalAmount).toBe(5500); // 1000 × 5.5
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws on duplicate order number', async () => {
      prisma.outsourcingOrder.findFirst.mockResolvedValueOnce({ id: 'oso_existing' });
      const service = createMesService(prisma);
      await expect(
        service.createOutsourcingOrder({
          orderNumber: 'OSO-001', processType: 'Sewing',
          quantity: 100, unit: 'PC', unitPrice: 5,
        }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('transitions Draft → Sent → Confirmed → InProduction → Received', async () => {
      const statusSequence = ['Draft', 'Sent', 'Confirmed', 'InProduction'];
      let idx = 0;
      prisma.outsourcingOrder.findFirst.mockImplementation(() => {
        const status = statusSequence[idx] ?? 'Received';
        idx++;
        return Promise.resolve({
          id: 'oso_1', status, orderNumber: 'OSO-001',
          supplierId: 'rel_1', orderId: 'ord_1', quantity: '1000',
        });
      });

      const service = createMesService(prisma);
      await service.transitionOutsourcingStatus('oso_1', 'Sent', 'user_1');
      await service.transitionOutsourcingStatus('oso_1', 'Confirmed', 'user_1');
      await service.transitionOutsourcingStatus('oso_1', 'InProduction', 'user_1');
      await expect(service.transitionOutsourcingStatus('oso_1', 'Received', 'user_1')).rejects.toThrow('到货验收');

      const events = publishSpy.mock.calls.map((c) => c[0].type);
      expect(events).toContain('OutsourcingSent');
      expect(events).toContain('OutsourcingConfirmed');
      expect(events).not.toContain('OutsourcingReceived');
    });

    it('throws on illegal transition (Received → Sent)', async () => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({ id: 'oso_1', status: 'Received' });
      const service = createMesService(prisma);
      await expect(
        service.transitionOutsourcingStatus('oso_1', 'Sent', 'user_1'),
      ).rejects.toThrow('非法状态转换');
    });

    it('receives with quality acceptance', async () => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({
        id: 'oso_1', status: 'InProduction', quantity: '1000',
      });
      const service = createMesService(prisma);
      const updated = await service.receiveOutsourcing('oso_1', {
        qualityAcceptedQty: 980, qualityRejectedQty: 20,
      }, 'user_1');

      expect(updated.status).toBe('Received');
      expect(updated.qualityAcceptedQty).toBe(980);
      expect(updated.qualityRejectedQty).toBe(20);
    });

    it('throws when received qty exceeds ordered qty', async () => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({
        id: 'oso_1', status: 'InProduction', quantity: '1000',
      });
      const service = createMesService(prisma);
      await expect(
        service.receiveOutsourcing('oso_1', { qualityAcceptedQty: 1000, qualityRejectedQty: 100 }, 'user_1'),
      ).rejects.toThrow('超过');
    });

    it.each([
      { qualityAcceptedQty: -1, qualityRejectedQty: 1001 },
      { qualityAcceptedQty: Number.NaN },
      { qualityAcceptedQty: Infinity },
      { qualityAcceptedQty: 1000, qualityRejectedQty: -1 },
      { qualityAcceptedQty: 0, qualityRejectedQty: 0 },
      { qualityAcceptedQty: 400, qualityRejectedQty: 0 },
      { qualityAcceptedQty: 999.99999, qualityRejectedQty: 0.00001 },
    ])('rejects invalid or partial whole-order receipt without mutation: %j', async input => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({id:'oso_1',status:'InProduction',quantity:'1000'});
      const service=createMesService(prisma);
      await expect(service.receiveOutsourcing('oso_1',input,'user_1')).rejects.toThrow();
      expect(prisma.outsourcingOrder.update).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('only allows editing in Draft status', async () => {
      prisma.outsourcingOrder.findFirst.mockResolvedValue({ id: 'oso_1', status: 'Sent' });
      const service = createMesService(prisma);
      await expect(
        service.updateOutsourcingOrder('oso_1', { quantity: 2000 }, 'user_1'),
      ).rejects.toThrow('仅 Draft 可编辑');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // R678 列表分页（limit/offset → take/skip + total 真实计数）
  // ══════════════════════════════════════════════════════════════
  describe('列表分页 limit/offset', () => {
    it('limit/offset 透传为 take/skip，total 来自 count（排产）', async () => {
      prisma.productionPlan.findMany.mockResolvedValue([{ id: 'pp_1' }]);
      prisma.productionPlan.count.mockResolvedValue(42);
      const service = createMesService(prisma);
      const { items, total } = await service.listProductionPlans({ status: 'Draft', limit: 20, offset: 40 });
      expect(items).toHaveLength(1);
      expect(total).toBe(42);
      expect(prisma.productionPlan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 40 }),
      );
      expect(prisma.productionPlan.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: 'Draft' }),
      });
    });

    it('limit 越界收敛到 [1,500]；offset 负数归零（工时）', async () => {
      const service = createMesService(prisma);
      await service.listWorkHours({ limit: 9999, offset: -5 });
      expect(prisma.workHour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500, skip: 0 }),
      );
      await service.listWorkHours({ limit: 0 });
      expect(prisma.workHour.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1, skip: 0 }),
      );
    });

    it('缺省 limit → 不带 take/skip（工位/计件规则/计件记录/外协 全量返回兼容）', async () => {
      const service = createMesService(prisma);
      await service.listWorkStations();
      expect(prisma.workStation.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.any(Number) }),
      );
      await service.listPieceRateRules();
      expect(prisma.pieceRateRule.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.any(Number) }),
      );
      await service.listPieceRateRecords();
      expect(prisma.pieceRateRecord.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.any(Number) }),
      );
      await service.listOutsourcingOrders();
      expect(prisma.outsourcingOrder.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.any(Number) }),
      );
    });

    it('外协 limit/offset 透传 + total 来自 count', async () => {
      prisma.outsourcingOrder.findMany.mockResolvedValue([{ id: 'oso_1' }]);
      prisma.outsourcingOrder.count.mockResolvedValue(7);
      const service = createMesService(prisma);
      const { items, total } = await service.listOutsourcingOrders({ supplierId: 'rel_1', limit: 3, offset: 6 });
      expect(items).toHaveLength(1);
      expect(total).toBe(7);
      expect(prisma.outsourcingOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3, skip: 6 }),
      );
      expect(prisma.outsourcingOrder.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ supplierId: 'rel_1', deletedAt: null }),
      });
    });
  });
});
