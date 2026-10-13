import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * 调度接入集成测试（Track F）：
 *   receivableOverdueDetector 接入信用自动冻结/解冻扫描
 *   - detectCreditFreezeAndThaw：Net61+ 客户自动冻结 / 全额核销后自动解冻
 *   - 任务 run()：通知扫描 + 信用扫描双段均执行（互不阻塞）
 */

const mockBroadcast = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: vi.fn(() => ({
    broadcastNotification: mockBroadcast,
  })),
}));

import {
  detectCreditFreezeAndThaw,
  createReceivableOverdueDetectorTask,
} from '../../scheduler/tasks/receivableOverdueDetector';
import { SYSTEM_CREDIT_ACTOR } from '../creditService';

const TODAY = new Date(2026, 7, 10); // 2026-08-10

function makePrisma(opts: { invoices?: any[]; creditLimits?: any[] } = {}) {
  const invoices = opts.invoices ?? [];
  const creditLimits = opts.creditLimits ?? [];

  const calls = {
    clUpdate: vi.fn(async ({ where, data }: any) => ({ ...creditLimits.find((c) => c.id === where.id), ...data })),
    clUpdateMany: vi.fn(async () => ({ count: creditLimits.length })),
    historyCreate: vi.fn(async ({ data }: any) => data),
    auditCreate: vi.fn(async () => ({ id: 'AL-1' })),
  };

  const matchWhere = (cl: any, where: any) => {
    if (where?.relationId && cl.relationId !== where.relationId) return false;
    if (where?.status && cl.status !== where.status) return false;
    if (where?.frozenBy && cl.frozenBy !== where.frozenBy) return false;
    if (where && 'deletedAt' in where && where.deletedAt === null && cl.deletedAt !== null) return false;
    return true;
  };

  const prisma: any = {
    invoice: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        if (where?.customerRelationId) return invoices.filter((i) => i.customerRelationId === where.customerRelationId);
        return invoices;
      }),
    },
    notification: { findFirst: vi.fn(async () => null) },
    creditLimit: {
      findMany: vi.fn(async ({ where, select }: any = {}) => {
        const rows = creditLimits.filter((cl) => matchWhere(cl, where));
        if (select) return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, (r as any)[k]])));
        return rows;
      }),
      findFirst: vi.fn(async ({ where }: any) => creditLimits.find((cl) => matchWhere(cl, where)) ?? null),
      update: calls.clUpdate,
      updateMany: calls.clUpdateMany,
    },
    creditLimitHistory: { create: calls.historyCreate },
    auditLog: { create: calls.auditCreate },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls };
}

beforeEach(() => vi.clearAllMocks());

describe('detectCreditFreezeAndThaw 调度接入', () => {
  it('Net61+ 逾期客户 → 自动冻结（frozenCount=1 + Active→Frozen + 系统身份留痕）', async () => {
    const { prisma, calls } = makePrisma({
      invoices: [{
        id: 'INV_1', invoiceNumber: 'INV-2026-001', amount: '180000', currency: 'USD',
        customerRelationId: 'REL_A', customerName: 'ACME',
        issueDate: '2026-05-01', dueDate: '2026-06-06', status: 'Issued', orderId: 'ORD_1',
      }],
      creditLimits: [{
        id: 'CL_1', relationId: 'REL_A', status: 'Active', usedAmount: 120000, totalLimit: 800000,
        frozenBy: null, frozenAt: null, thawedReason: null, lastAutoScanDate: null, deletedAt: null, createdAt: BigInt(1),
      }],
    });
    const res = await detectCreditFreezeAndThaw(prisma, TODAY);
    expect(res.frozenCount).toBe(1);
    expect(res.thawedCount).toBe(0);
    expect(calls.clUpdate.mock.calls[0][0].data.status).toBe('Frozen');
    expect(calls.clUpdate.mock.calls[0][0].data.frozenBy).toBe(SYSTEM_CREDIT_ACTOR);
    expect(calls.historyCreate.mock.calls[0][0].data.triggerType).toBe('credit_freeze');
  });

  it('幂等：二次运行（已 Frozen）→ frozenCount=0 不重复留痕', async () => {
    const base = {
      invoices: [{
        id: 'INV_1', invoiceNumber: 'INV-2026-001', amount: '180000', currency: 'USD',
        customerRelationId: 'REL_A', customerName: 'ACME',
        issueDate: '2026-05-01', dueDate: '2026-06-06', status: 'Issued', orderId: 'ORD_1',
      }],
    };
    const frozen = makePrisma({
      ...base,
      creditLimits: [{
        id: 'CL_1', relationId: 'REL_A', status: 'Frozen', usedAmount: 120000, totalLimit: 800000,
        frozenBy: SYSTEM_CREDIT_ACTOR, frozenAt: new Date(2026, 7, 9), thawedReason: null,
        lastAutoScanDate: new Date(2026, 7, 9), deletedAt: null, createdAt: BigInt(1),
      }],
    });
    const res = await detectCreditFreezeAndThaw(frozen.prisma, TODAY);
    expect(res.frozenCount).toBe(0);
    expect(frozen.calls.historyCreate).not.toHaveBeenCalled();
  });

  it('逾期款全额核销（无 open 发票）→ 系统自动冻结额度被兜底自动解冻', async () => {
    const { prisma, calls } = makePrisma({
      invoices: [],
      creditLimits: [{
        id: 'CL_1', relationId: 'REL_A', status: 'Frozen', usedAmount: 0, totalLimit: 800000,
        frozenBy: SYSTEM_CREDIT_ACTOR, frozenAt: new Date(2026, 7, 1), thawedReason: null,
        lastAutoScanDate: new Date(2026, 7, 1), deletedAt: null, createdAt: BigInt(1),
      }],
    });
    const res = await detectCreditFreezeAndThaw(prisma, TODAY);
    expect(res.thawedCount).toBe(1);
    expect(calls.clUpdate.mock.calls[0][0].data.status).toBe('Active');
    expect(calls.clUpdate.mock.calls[0][0].data.thawedReason).toContain('全额核销');
    expect(calls.historyCreate.mock.calls[0][0].data.triggerType).toBe('credit_thaw');
  });

  it('任务 run()：通知扫描与信用扫描双段均执行（Net61+ → 逾期通知 + 自动冻结）', async () => {
    const { prisma, calls } = makePrisma({
      invoices: [{
        id: 'INV_1', invoiceNumber: 'INV-2026-001', amount: '180000', currency: 'USD',
        customerRelationId: 'REL_A', customerName: 'ACME',
        issueDate: '2026-05-01', dueDate: '2026-06-06', status: 'Issued', orderId: 'ORD_1',
      }],
      creditLimits: [{
        id: 'CL_1', relationId: 'REL_A', status: 'Active', usedAmount: 120000, totalLimit: 800000,
        frozenBy: null, frozenAt: null, thawedReason: null, lastAutoScanDate: null, deletedAt: null, createdAt: BigInt(1),
      }],
    });
    const task = createReceivableOverdueDetectorTask();
    await task.run(prisma);
    // 段 1：逾期通知（65 天 → critical）
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('critical');
    // 段 2：信用自动冻结
    expect(calls.clUpdate.mock.calls[0][0].data.status).toBe('Frozen');
    expect(calls.auditCreate.mock.calls[0][0].data.action).toBe('credit:60d-overdue-freeze');
  });
});
