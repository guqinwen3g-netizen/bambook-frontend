/**
 * L2 高危 3 号「第三方代付」——**留痕接线**测试（允许 + 留痕；Kevin 2026-09-17 口径）。
 *
 * 修前状态：`voucher.customerRelationId`（= 实际打款人，DR-016）与
 *   `invoice.customerRelationId`（= 合同客户）不一致时，
 *   · 业务员认领通道**硬拒** `CUSTOMER_MISMATCH`（把真实业务卡死）
 *   · 财务核销通道**放行但零留痕**（A 替 B 付，账上完全看不见）
 * 修后：两条通道都**放行**，且核销内核在同一事务写审计行
 *   （`third_party_payment_detected`）。
 *
 * 本套守护三件事：
 *   ① **留痕落在内核**（applyAllocation）—— route / Agent reconcileFlow / toolRuntime
 *      三条通道共用它。挂在调用方外层就会重演「收口点错位」（另两条通道静默少做一步），
 *      所以这里**直接调 applyAllocation** 断言（模拟 Agent 通道），不经过 route。
 *   ② **不阻断**——判定为代付时核销照样成功落库。
 *   ③ **不误报**——同客户核销绝不写代付审计行。
 *
 * 证伪方式（改完手跑一遍，确认会红）：
 *   A 注释掉 allocationService.ts step 5b 的 `detectThirdPartyPayment` 调用 → ①② 转红
 *   B 把 thirdPartyPaymentGuard 的 relationId 分支改成恒 `return null` → 纯函数套 + 本套 ①② 转红
 *   C 把 receiptClaimService 里的检测换成 `null` → receiptClaimService.test.ts 的「点名代付」转红
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { applyAllocation } from '../allocationService';
import { createAllocation } from '../allocationMutationService';
import { publishBusinessEvent } from '../../events/businessEventBus';

const dec = (v: number | string) => new Prisma.Decimal(v);

/**
 * ★ mock 必须**尊重 `select`**：按 select 投影，漏选的字段变成 undefined。
 *
 * 为什么非这样不可：默认 mock（无视 select 直接返回整行）会让「**接线漏字段**」这类
 * bug **永远测不出** —— 真源纯函数单测传的是完整对象（绿），mock 也返回完整对象（绿），
 * 只有真库里那行被 select 削过的数据才会暴露。2026-09-17 真库演练 T7 正是踩到：
 * `applyAllocation` 的 invoice select 少了 `customerName` → 「名称兜底判定」分支
 * 在生产里恒不触发，而两套单测全绿。加了投影后，同一条测试立刻会红。
 */
function project(row: any, select?: Record<string, any>): any {
  if (!select || !row) return row;
  const out: Record<string, any> = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
  return out;
}

/**
 * 事务 client mock（沿用 creditRecalcAndInputGate.test.ts 的形态）：
 * 覆盖 applyAllocation 的全部依赖 —— 状态重算、引用同步、审计、信用重算、批次重算。
 */
function makeTx(opts: { invoice?: any; voucher?: any } = {}) {
  const invoiceDefault = {
    id: 'INV__1', invoiceNumber: 'INV-1', type: 'Receivable', status: 'Issued',
    amount: dec('1000'), currency: 'USD', orderId: null,
    customerRelationId: 'REL_CUST', customerName: 'ACME', deletedAt: null,
    ...opts.invoice,
  };
  const voucherDefault = {
    id: 'PAY__1', voucherNumber: 'PAY-1', type: 'Receipt', status: 'unreconciled',
    currency: 'USD', amount: dec('500'), customerRelationId: 'REL_CUST', customerName: 'ACME',
    deletedAt: null,
    ...opts.voucher,
  };
  const allocations: any[] = [];
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []), // No supplier-claim source; mock locks are interface evidence only.
    creditNoteAllocation: { findMany: vi.fn(async () => []) }, // No CN offsets.
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, // No actual bank-return Receipt FK.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Third-party customer receipt, no cash-refund link.
    invoice: {
      findUnique: vi.fn(async ({ select }: any = {}) => project(invoiceDefault, select)),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ where, data }: any) => ({ ...invoiceDefault, ...data, id: where.id })),
    },
    paymentVoucher: {
      findUnique: vi.fn(async ({ select }: any = {}) => project(voucherDefault, select)),
      update: vi.fn(async ({ where, data }: any) => ({ ...voucherDefault, ...data, id: where.id })),
    },
    invoiceAllocation: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async ({ where }: any) => allocations.filter(row =>
        (!where?.invoiceId || row.invoiceId === where.invoiceId) && (!where?.voucherId || row.voucherId === where.voucherId))),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const index = allocations.findIndex(row => row.invoiceId === where.invoiceId_voucherId.invoiceId && row.voucherId === where.invoiceId_voucherId.voucherId);
        if (index < 0) { allocations.push(create); return create; }
        allocations[index] = { ...allocations[index], ...update }; return allocations[index];
      }),
      delete: vi.fn(async () => ({})),
    },
    invoiceOrderAllocation: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    order: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    creditLimit: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    creditLimitHistory: { create: vi.fn(async () => ({})) },
    orderShipmentBatch: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
    invoiceOrderAllocation_: {},
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  return { tx, prisma };
}

/** 取出本次事务里所有 `third_party_payment_detected` 审计行 */
const thirdPartyAudits = (tx: any) =>
  (tx.auditLog.create.mock.calls as any[])
    .map(c => c[0]?.data)
    .filter(d => d?.action === 'third_party_payment_detected');

beforeEach(() => { vi.clearAllMocks(); });

describe('★① 留痕落在内核 applyAllocation（三通道共用点）', () => {
  it('Agent 通道直调（source=agent:receive_and_reconcile）：跨客户 → 核销成功 + 写代付审计行', async () => {
    const { tx, prisma } = makeTx({
      invoice: { customerRelationId: 'REL_CUST', customerName: 'ACME' },
      voucher: { customerRelationId: 'REL_PAYER', customerName: 'PARENT CO' },
    });
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'agent', source: 'agent:receive_and_reconcile',
    });

    // ② 不阻断：核销照常落库
    expect(r.allocationId).toBe('ALLOC__INV__1__PAY__1');
    expect(tx.invoiceAllocation.upsert).toHaveBeenCalledTimes(1);

    // ① 留痕：同事务写审计行（不依赖任何调用方）
    const audits = thirdPartyAudits(tx);
    expect(audits).toHaveLength(1);
    const detail = audits[0].detail as any;
    expect(audits[0].targetType).toBe('InvoiceAllocation');
    expect(audits[0].targetId).toBe('ALLOC__INV__1__PAY__1');
    expect(detail.source).toBe('agent:receive_and_reconcile');
    expect(detail.after.thirdPartyPayment).toBe(true);
    expect(detail.after.thirdPartyPaymentBasis).toBe('relationId');
    expect(detail.after.payerRelationId).toBe('REL_PAYER');
    expect(detail.after.payerName).toBe('PARENT CO');
    expect(detail.after.invoiceCustomerRelationId).toBe('REL_CUST');
    expect(detail.after.invoiceCustomerName).toBe('ACME');
    expect(String(detail.after.thirdPartyPaymentNote)).toContain('第三方代付');

    // 返回值也带上判定（供调用方提交后发事件）
    expect(r.thirdPartyPayment?.basis).toBe('relationId');
  });

  it('③ 不误报：同客户核销 → 核销成功但**不写**代付审计行', async () => {
    const { tx, prisma } = makeTx();
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'u', source: 'route:allocation:create',
    });
    expect(r.allocationId).toBe('ALLOC__INV__1__PAY__1');
    expect(r.thirdPartyPayment).toBeNull();
    expect(thirdPartyAudits(tx)).toHaveLength(0);
    // 常规核销审计仍在（没有把原有留痕挤掉）
    const allocAudits = (tx.auditLog.create.mock.calls as any[])
      .map(c => c[0]?.data).filter(d => d?.action === 'create_allocation');
    expect(allocAudits).toHaveLength(1);
  });

  it('③ 不误报：票头无客户档案（判不了）→ 不写代付审计行', async () => {
    const { tx, prisma } = makeTx({
      invoice: { customerRelationId: null, customerName: null },
      voucher: { customerRelationId: null, customerName: null },
    });
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'u', source: 'agent:tool_runtime',
    });
    expect(r.thirdPartyPayment).toBeNull();
    expect(thirdPartyAudits(tx)).toHaveLength(0);
  });

  it('★ 名称兜底：双方都无客户档案、名称不同 → 留痕 basis=name（修前 select 缺 customerName，恒不判）', async () => {
    const { tx, prisma } = makeTx({
      invoice: { customerRelationId: null, customerName: 'DRILL-INV-CO' },
      voucher: { customerRelationId: null, customerName: 'DRILL-VOU-CO' },
    });
    const r = await applyAllocation(prisma, tx, {
      invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: '400',
      actorId: 'u', source: 'route:allocation:create',
    });
    // 这一条钉的是「接线把 customerName 带进来了」——mock 尊重 select 后，
    // 一旦 select 少了 customerName，r.thirdPartyPayment 会变 null，本测试即红。
    expect(r.thirdPartyPayment?.basis).toBe('name');
    const audits = thirdPartyAudits(tx);
    expect(audits).toHaveLength(1);
    const after = (audits[0].detail as any).after;
    expect(after.thirdPartyPaymentBasis).toBe('name');
    expect(after.payerName).toBe('DRILL-VOU-CO');
    expect(after.invoiceCustomerName).toBe('DRILL-INV-CO');
  });
});

describe('★⑤ route 通道：提交后发 ThirdPartyPaymentDetected 事件', () => {
  it('跨客户核销 → createAllocation 回传判定 + 发事件（含付款方/合同客户）', async () => {
    const { prisma } = makeTx({
      invoice: { customerRelationId: 'REL_CUST', customerName: 'ACME' },
      voucher: { customerRelationId: 'REL_PAYER', customerName: 'PARENT CO' },
    });
    const res = await createAllocation({
      prisma, input: { invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: 400 }, actorId: 'u_fin',
    });
    expect(res.ok).toBe(true);
    expect(res.data!.thirdPartyPayment?.basis).toBe('relationId');

    // 事件是 fire-and-forget（不 await），轮询等待
    await vi.waitFor(() => {
      expect(publishBusinessEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ThirdPartyPaymentDetected' }),
      );
    });
    const evt = (publishBusinessEvent as any).mock.calls
      .map((c: any[]) => c[0]).find((e: any) => e.type === 'ThirdPartyPaymentDetected');
    expect(evt.sourceEntityType).toBe('InvoiceAllocation');
    expect(evt.payload.payerName).toBe('PARENT CO');
    expect(evt.payload.invoiceCustomerName).toBe('ACME');
    expect(evt.payload.basis).toBe('relationId');
  });

  it('同客户核销 → 不发代付事件', async () => {
    const { prisma } = makeTx();
    const res = await createAllocation({
      prisma, input: { invoiceId: 'INV__1', voucherId: 'PAY__1', appliedAmount: 400 }, actorId: 'u_fin',
    });
    expect(res.ok).toBe(true);
    expect(res.data!.thirdPartyPayment).toBeNull();
    await new Promise(r => setTimeout(r, 20)); // 给 fire-and-forget 一点时间
    const types = (publishBusinessEvent as any).mock.calls.map((c: any[]) => c[0]?.type);
    expect(types).not.toContain('ThirdPartyPaymentDetected');
  });
});
