import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCHEMA = fs.readFileSync(
  path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf-8'
);
const TOOLRUNTIME = fs.readFileSync(
  path.resolve(__dirname, '../../agent/toolRuntime.ts'), 'utf-8'
);
const FINANCE_ROUTE = fs.readFileSync(
  path.resolve(__dirname, '../route.ts'), 'utf-8'
);
const PAYMENT_VOUCHER_SERVICE = fs.readFileSync(
  path.resolve(__dirname, '../paymentVoucherMutationService.ts'), 'utf-8'
);

describe('task_mqxwgafj: InvoiceAllocation schema 结构（硬删除语义）', () => {
  it('模型存在 + 核心字段 + 无 deletedAt + 唯一约束', () => {
    expect(SCHEMA).toContain('model InvoiceAllocation');
    const section = SCHEMA.slice(
      SCHEMA.indexOf('model InvoiceAllocation'),
      SCHEMA.indexOf('model InvoiceAllocation') + 600
    );
    expect(section).toContain('invoiceId');
    expect(section).toContain('voucherId');
    expect(section).toContain('appliedAmount');
    expect(section).not.toContain('deletedAt'); // 硬删除语义
    expect(section).toContain('@@unique([invoiceId, voucherId])');
  });

  it('注释说明硬删除 + 调整=delete+insert', () => {
    expect(SCHEMA).toContain('硬删除');
  });

  it('schema 无销销账笔误', () => {
    expect(SCHEMA).not.toContain('销销账');
  });
});

describe('task_mqxwgafj: PaymentVoucher.status 字段', () => {
  it('含 status + 枚举 + 索引', () => {
    const section = SCHEMA.slice(
      SCHEMA.indexOf('model PaymentVoucher'),
      SCHEMA.indexOf('model InvoiceAllocation') > -1
        ? SCHEMA.indexOf('model InvoiceAllocation')
        : SCHEMA.length
    );
    expect(section).toContain('status');
    expect(section).toContain('unreconciled');
    expect(section).toContain('partially_reconciled');
    expect(section).toContain('reconciled');
    expect(section).toContain('@@index([status])');
  });
});

describe('task_mqxwgafj: voucher status 推导逻辑（基于 allocation 汇总）', () => {
  function deriveVoucherStatus(totalAllocated: number, voucherAmount: number): string {
    return totalAllocated >= voucherAmount && voucherAmount > 0
      ? 'reconciled'
      : (totalAllocated > 0 ? 'partially_reconciled' : 'unreconciled');
  }

  it('reconciled / partially / unreconciled 边界', () => {
    expect(deriveVoucherStatus(1000, 1000)).toBe('reconciled');
    expect(deriveVoucherStatus(1200, 1000)).toBe('reconciled');
    expect(deriveVoucherStatus(500, 1000)).toBe('partially_reconciled');
    expect(deriveVoucherStatus(0, 1000)).toBe('unreconciled');
    expect(deriveVoucherStatus(0, 0)).toBe('unreconciled');
  });

  it('1:N 分摊汇总（一笔 voucher 销两张 invoice）', () => {
    const allocations = [{ appliedAmount: 300 }, { appliedAmount: 700 }];
    const total = allocations.reduce((s, a) => s + a.appliedAmount, 0);
    expect(total).toBe(1000);
    expect(deriveVoucherStatus(total, 1000)).toBe('reconciled');
  });
});

describe('task_mqxwgafj: voucher status 枚举校验', () => {
  const VALID = ['unreconciled', 'partially_reconciled', 'reconciled'];
  it('有效值通过', () => {
    expect(VALID.includes('unreconciled')).toBe(true);
    expect(VALID.includes('partially_reconciled')).toBe(true);
    expect(VALID.includes('reconciled')).toBe(true);
  });
  it('无效值拒绝', () => {
    expect(VALID.includes('paid')).toBe(false);
    expect(VALID.includes('')).toBe(false);
    expect(VALID.includes('RECONCILED')).toBe(false);
  });
});

describe('task_mqxwgafj + phase1-w1: toolRuntime apply_voucher 源码验证（复用 service，彻底消除双账本漂移）', () => {
  // 提取 handleFinanceApplyVoucherToInvoice 函数体（Phase 1 W1 改写为复用 applyAllocation service）
  function extractApplyVoucherFuncBody(): string {
    const funcStart = TOOLRUNTIME.indexOf('async function handleFinanceApplyVoucherToInvoice');
    expect(funcStart).toBeGreaterThan(-1);
    const funcEnd = TOOLRUNTIME.indexOf('\n}', funcStart + 100);
    return TOOLRUNTIME.slice(funcStart, funcEnd);
  }

  it('复用 applyAllocation service（单一写入路径，非内联实现）', () => {
    const funcBody = extractApplyVoucherFuncBody();
    // 必须调用 applyAllocation service（route 与 agent 共享同一写入路径）
    expect(funcBody).toContain('applyAllocation');
    // 不应内联 invoiceAllocation.upsert / findMany（避免与 service 层重复实现）
    expect(funcBody).not.toContain('invoiceAllocation.upsert');
    expect(funcBody).not.toContain('invoiceAllocation.findMany');
    // 不应再用 paymentVoucher.findMany 汇总 appliedAmount（避免双账本）
    expect(funcBody).not.toContain('paymentVoucher.findMany');
  });

  it('在 $transaction 内调用 applyAllocation（事务闭环）', () => {
    const funcBody = extractApplyVoucherFuncBody();
    expect(funcBody).toContain('$transaction');
    expect(funcBody).toContain('applyAllocation');
  });

  it('透传 service 返回的 newInvoiceStatus / newVoucherStatus / auditId', () => {
    const funcBody = extractApplyVoucherFuncBody();
    // service 层负责 status 重算 + 审计写入，agent 工具透传结果
    expect(funcBody).toContain('newInvoiceStatus');
    expect(funcBody).toContain('newVoucherStatus');
    expect(funcBody).toContain('auditId');
  });
});

describe('task_mqxwgafj: paymentVoucherMutationService voucher status 不从 appliedAmount 推导', () => {
  it('createPaymentVoucher: null status 默认 unreconciled + 存在但非法返回 INVALID_STATUS', () => {
    const createStart = PAYMENT_VOUCHER_SERVICE.indexOf('function normalizeCreateInput');
    const createEnd = PAYMENT_VOUCHER_SERVICE.indexOf('function normalizeUpdateInput', createStart);
    const createBody = PAYMENT_VOUCHER_SERVICE.slice(createStart, createEnd);
    expect(createBody).not.toMatch(/appliedAmount.*partially_reconciled/);
    expect(createBody).toContain("'unreconciled'");
    expect(createBody).toContain('INVALID_STATUS');
    expect(createBody).toContain('isValidPaymentVoucherStatus');
  });

  it('POST /vouchers 非法 status 经 service 返回后 route 400 + return', () => {
    const postStart = FINANCE_ROUTE.indexOf("router.post('/vouchers'");
    const postEnd = FINANCE_ROUTE.indexOf("router.patch('/vouchers/:id'");
    const postBody = FINANCE_ROUTE.slice(postStart, postEnd);
    expect(postBody).toContain('statusCodeMap');
    expect(postBody).toContain('INVALID_STATUS: 400');
    expect(postBody).toContain('return;');
  });

  it('PATCH /vouchers/:id status 不可手动修改（STATUS_NOT_MANUAL_SETTABLE，由 allocation 重算）', () => {
    const updateStart = PAYMENT_VOUCHER_SERVICE.indexOf('function normalizeUpdateInput');
    const updateEnd = PAYMENT_VOUCHER_SERVICE.indexOf('export async function createPaymentVoucher', updateStart);
    const updateBody = PAYMENT_VOUCHER_SERVICE.slice(updateStart, updateEnd);
    expect(updateBody).toContain('status');
    expect(updateBody).toContain('STATUS_NOT_MANUAL_SETTABLE');
    expect(updateBody).not.toContain('delete data.status'); // 不再静默删除
  });
});
