/**
 * 应收发票逾期分级预警单元测试（阶段 E / E1）
 *
 * 覆盖：
 *   1. dueDate 口径：逾期 1-14 天 warning；≥15 天 critical；未逾期不通知
 *   2. dueDate 缺失 → Net 30 推定（issueDate + 30d），正文披露推定口径
 *   3. 仅扫 Receivable + Issued/PartiallyPaid（Payable / Paid / Cancelled 不扫）
 *   4. 分级去重：同 tier 当天已有通知 → 跳过；dedupKey 含 tier 与日期
 *   5. PartiallyPaid 正文注明「已部分核销」
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockBroadcast = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('../../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: vi.fn(() => ({
    broadcastNotification: mockBroadcast,
  })),
}));

import { detectAndNotify } from '../tasks/receivableOverdueDetector';

// 固定今天：2026-08-10（本地零点）
const TODAY = new Date(2026, 7, 10);

function makePrisma(invoices: any[] = [], existingNotification: any = null) {
  return {
    invoice: {
      findMany: vi.fn().mockResolvedValue(invoices),
    },
    notification: {
      findFirst: vi.fn().mockResolvedValue(existingNotification),
    },
  } as any;
}

function makeInvoice(overrides: Record<string, any> = {}) {
  return {
    id: 'INV_1',
    invoiceNumber: 'INV-2026-001',
    amount: '12000',
    currency: 'USD',
    issueDate: '2026-07-01',
    dueDate: null,
    status: 'Issued',
    orderId: 'ORD_1',
    customerName: 'ACME',
    ...overrides,
  };
}

describe('receivableOverdueDetector · detectAndNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dueDate 逾期 1 天 → warning', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: '2026-08-09' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.type).toBe('receivable_overdue');
    expect(arg.level).toBe('warning');
    expect(arg.title).toContain('逾期 1 天');
    expect(arg.metadata.daysOverdue).toBe(1);
    expect(arg.metadata.dueDate).toBe('2026-08-09');
    expect(arg.metadata.dueDateEstimated).toBe(false);
  });

  it('dueDate 逾期 14 天 → warning；15 天 → critical', async () => {
    let prisma = makePrisma([makeInvoice({ dueDate: '2026-07-27' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('warning');
    expect(mockBroadcast.mock.calls[0][0].metadata.daysOverdue).toBe(14);

    vi.clearAllMocks();
    prisma = makePrisma([makeInvoice({ dueDate: '2026-07-26' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].level).toBe('critical');
    expect(mockBroadcast.mock.calls[0][0].metadata.daysOverdue).toBe(15);
  });

  it('dueDate 未到期（今天/未来）→ 不通知', async () => {
    let prisma = makePrisma([makeInvoice({ dueDate: '2026-08-10' })]);
    let sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);

    prisma = makePrisma([makeInvoice({ dueDate: '2026-09-01' })]);
    sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dueDate 缺失 → Net 30 推定（issueDate 2026-07-01 + 30d = 2026-07-31，逾期 10 天 warning），正文披露推定', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: null, issueDate: '2026-07-01' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(1);
    const arg = mockBroadcast.mock.calls[0][0];
    expect(arg.level).toBe('warning');
    expect(arg.metadata.dueDate).toBe('2026-07-31');
    expect(arg.metadata.dueDateEstimated).toBe(true);
    expect(arg.metadata.daysOverdue).toBe(10);
    expect(arg.body).toContain('Net 30 推定');
  });

  it('Net 30 推定未逾期 → 不通知（issueDate 2026-07-20 + 30d = 2026-08-19 未来）', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: null, issueDate: '2026-07-20' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });

  it('查询口径：仅 Receivable + Issued/PartiallyPaid + 未删除 + 金额>0', async () => {
    const prisma = makePrisma([]);
    await detectAndNotify(prisma, TODAY);
    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.type).toBe('Receivable');
    expect(where.status.in).toEqual(['Issued', 'PartiallyPaid']);
    expect(where.deletedAt).toBeNull();
    // ★ 金额守卫：0 元/负额应收票不欠钱，不该被催办（真库演练
    //   scripts/acceptance-zero-amount-invoice-credit-gate.ts 实锤过后果）
    expect(where.amount).toEqual({ gt: 0 });
  });

  it('★ 0 元票（amount=0，已逾期 65 天）→ **不通知**', async () => {
    const prisma = makePrisma([makeInvoice({ amount: '0', issueDate: '2026-06-01' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('★ 负额票（贷项，amount=-500，已逾期 65 天）→ **不通知**', async () => {
    const prisma = makePrisma([makeInvoice({ amount: '-500', issueDate: '2026-06-01' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('PartiallyPaid 正文注明「已部分核销」', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: '2026-08-01', status: 'PartiallyPaid' })]);
    await detectAndNotify(prisma, TODAY);
    expect(mockBroadcast.mock.calls[0][0].body).toContain('已部分核销');
  });

  it('去重：同 tier 当天已有通知 → 跳过', async () => {
    const prisma = makePrisma(
      [makeInvoice({ dueDate: '2026-08-05' })],
      { id: 'NTF_existing' },
    );
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('dedupKey 含 tier 与日期（tier 升级会产生新 key）', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: '2026-07-20' })]); // 逾期 21 天 → critical
    await detectAndNotify(prisma, TODAY);
    const meta = mockBroadcast.mock.calls[0][0].metadata;
    expect(meta.dedupKey).toBe('receivable:overdue:INV_1:critical:2026-08-10');
    expect(meta.entityType).toBe('Invoice');
  });

  it('issueDate 非法且 dueDate 缺失 → 跳过（无法推定口径）', async () => {
    const prisma = makePrisma([makeInvoice({ dueDate: null, issueDate: 'not-a-date' })]);
    const sent = await detectAndNotify(prisma, TODAY);
    expect(sent).toBe(0);
  });
});
