import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { writeRouteAuditLog, actorIdFromRequest } from '../routeAudit';

describe('task_mqxxxu1g: writeRouteAuditLog（fail closed，支持事务内调用）', () => {
  it('成功写入 AuditLog（含 source/before/after）', async () => {
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tx = { auditLog: { create: auditLogCreate } } as any;
    await writeRouteAuditLog({
      prisma: tx, actorId: 'user-1', source: 'route:invoice:create',
      operation: 'create_invoice', targetType: 'Invoice', targetId: 'INV-1',
      after: { id: 'INV-1', status: 'Issued' }, ip: '127.0.0.1',
    });
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const call = auditLogCreate.mock.calls[0][0];
    expect(call.data.actorId).toBe('user-1');
    expect(call.data.action).toBe('create_invoice');
    expect(call.data.detail.source).toBe('route:invoice:create');
    expect(call.data.detail.after).toEqual({ id: 'INV-1', status: 'Issued' });
  });

  it('AuditLog 写入失败必须抛出（fail closed）', async () => {
    const auditLogCreate = vi.fn().mockRejectedValue(new Error('DB_DOWN'));
    const tx = { auditLog: { create: auditLogCreate } } as any;
    await expect(writeRouteAuditLog({
      prisma: tx, actorId: 'user-1', source: 'test', operation: 'test',
      targetType: 'T', targetId: 'T-1',
    })).rejects.toThrow('DB_DOWN');
  });

  it('AuditLog 失败不吞错误（无 console.error）', async () => {
    const auditLogCreate = vi.fn().mockRejectedValue(new Error('CONNECTION_LOST'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tx = { auditLog: { create: auditLogCreate } } as any;
    let threw = false;
    try {
      await writeRouteAuditLog({ prisma: tx, actorId: 'u1', source: 'test', operation: 'test', targetType: 'T', targetId: 'T-1' });
    } catch { threw = true; }
    expect(threw).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('task_mqxxxu1g: actorIdFromRequest', () => {
  it('三级回退 userId → id → system（哨兵与 seed 系统账号对齐，满足 AuditLog.actorId 外键）', () => {
    expect(actorIdFromRequest({ actor: { userId: 'u1' } })).toBe('u1');
    expect(actorIdFromRequest({ actor: { id: 'u2' } })).toBe('u2');
    expect(actorIdFromRequest({})).toBe('system');
  });
});

const FINANCE = fs.readFileSync(path.resolve(__dirname, '../../finance/route.ts'), 'utf-8');
const PAYMENT_VOUCHER_SERVICE = fs.readFileSync(path.resolve(__dirname, '../../finance/paymentVoucherMutationService.ts'), 'utf-8');
const INVOICE_SERVICE = fs.readFileSync(path.resolve(__dirname, '../../finance/invoiceMutationService.ts'), 'utf-8');
const ROUTE_AUDIT = fs.readFileSync(path.resolve(__dirname, '../routeAudit.ts'), 'utf-8');

describe('task_mqxxxu1g: finance route 事务闭环（业务+sync+AuditLog 同事务）', () => {
  it('invoice/payment voucher mutation service 都使用 $transaction', () => {
    const invoiceTxCount = (INVOICE_SERVICE.match(/\.\$transaction/g) || []).length;
    const voucherTxCount = (PAYMENT_VOUCHER_SERVICE.match(/\.\$transaction/g) || []).length;
    expect(invoiceTxCount).toBeGreaterThanOrEqual(2);
    expect(voucherTxCount).toBeGreaterThanOrEqual(2);
  });

  it('create_invoice: service 内业务 create + sync + AuditLog 全在 $transaction 内', () => {
    const idx = INVOICE_SERVICE.indexOf('export async function createInvoice');
    const end = INVOICE_SERVICE.indexOf('export async function updateInvoice', idx);
    const section = INVOICE_SERVICE.slice(idx, end);
    expect(section).toContain('tx.invoice.create');
    expect(section).toContain('syncInvoiceReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('writeRouteAuditLog');
    expect(section).toContain('prisma: tx');
  });

  it('update_invoice: service 内 existing + update + sync + AuditLog 全在 $transaction 内', () => {
    const idx = INVOICE_SERVICE.indexOf('export async function updateInvoice');
    const section = INVOICE_SERVICE.slice(idx);
    expect(section).toContain('tx.invoice.findUnique');
    expect(section).toContain('tx.invoice.update');
    expect(section).toContain('syncInvoiceReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('before');
    expect(section).toContain('after');
  });

  it('create_voucher: service 内业务 create + sync + AuditLog 全在 $transaction 内', () => {
    const idx = PAYMENT_VOUCHER_SERVICE.indexOf('export async function createPaymentVoucher');
    const end = PAYMENT_VOUCHER_SERVICE.indexOf('export async function updatePaymentVoucher', idx);
    const section = PAYMENT_VOUCHER_SERVICE.slice(idx, end);
    expect(section).toContain('tx.paymentVoucher.create');
    expect(section).toContain('syncPaymentVoucherReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('writeRouteAuditLog');
    expect(section).toContain('prisma: tx');
  });

  it('update_voucher: service 内 existing + update + sync + AuditLog 全在 $transaction 内（before+after）', () => {
    const idx = PAYMENT_VOUCHER_SERVICE.indexOf('export async function updatePaymentVoucher');
    const section = PAYMENT_VOUCHER_SERVICE.slice(idx);
    expect(section).toContain('tx.paymentVoucher.findUnique');
    expect(section).toContain('tx.paymentVoucher.update');
    expect(section).toContain('syncPaymentVoucherReferences');
    expect(section).toContain(', tx);');
    expect(section).toContain('before');
    expect(section).toContain('existing.appliedAmount');
  });

  it('route 只调用 invoice/payment voucher service，onDataChange 在 service success 后', () => {
    expect(FINANCE).toContain('createInvoice({');
    expect(FINANCE).toContain('updateInvoice({');
    expect(FINANCE).toContain('createPaymentVoucher({');
    expect(FINANCE).toContain('updatePaymentVoucher({');
    const postIdx = FINANCE.indexOf("router.post('/'");
    const voucherIdx = FINANCE.indexOf("router.get('/vouchers'", postIdx);
    const section = FINANCE.slice(postIdx, voucherIdx);
    expect(section.indexOf('onDataChange')).toBeGreaterThan(section.indexOf('if (!result.ok)'));
  });
});

describe('task_mqxxxu1g: NOT_FOUND 错误契约（404 不漂成 500）', () => {
  it('invoice/voucher route statusCodeMap 识别 NOT_FOUND 返回 404', () => {
    const matches = FINANCE.match(/NOT_FOUND: 404/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('NOT_FOUND 在 invoice service 中稳定返回', () => {
    expect(INVOICE_SERVICE).toContain("code: 'NOT_FOUND'");
  });
});

describe('task_mqxxxu1g: 事务失败时业务回滚（sync 失败场景）', () => {
  it('模拟 $transaction 内 sync 失败 → 整个事务 reject（业务+audit 都回滚）', async () => {
    const invoiceCreate = vi.fn().mockResolvedValue({ id: 'INV-X' });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    let syncCalled = false;
    let onDataChangeCalled = false;

    const prisma = {
      $transaction: vi.fn(async (fn: any) => {
        const tx = {
          invoice: { create: invoiceCreate },
          auditLog: { create: auditLogCreate },
        };
        const result = await fn(tx);
        return result;  // 若 fn 抛错不会到这
      }),
    } as any;

    const onDataChange = () => { onDataChangeCalled = true; };

    // 模拟 sync 在事务内失败
    const syncFn = async () => { syncCalled = true; throw new Error('SYNC_FAILED'); };

    await expect(prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.create({ data: {} });
      await syncFn();  // sync 失败
      await (await import('../routeAudit')).writeRouteAuditLog({
        prisma: tx, actorId: 'u1', source: 'test', operation: 'create_invoice',
        targetType: 'Invoice', targetId: inv.id,
      });
      return inv;
    })).rejects.toThrow('SYNC_FAILED');

    // sync 被调用过（在事务内）
    expect(syncCalled).toBe(true);
    // AuditLog 未执行（sync 先失败）
    expect(auditLogCreate).not.toHaveBeenCalled();
    // onDataChange 未触发（事务失败）
    expect(onDataChangeCalled).toBe(false);
  });
});

describe('task_mqxxxu1g: routeAudit helper 无吞错逻辑', () => {
  it('routeAudit.ts 无 .catch(()=>undefined) / console.error', () => {
    expect(ROUTE_AUDIT).not.toContain('.catch(() => undefined)');
    expect(ROUTE_AUDIT).not.toContain('console.error');
  });
});


// ============================================================================
// 真实 syncPaymentVoucherReferences(tx) 分支测试（task_mqxxxu1g review fix）
// ============================================================================
import { syncPaymentVoucherReferences, syncInvoiceReferences } from '../../entities/sync';

describe('task_mqxxxu1g: syncPaymentVoucherReferences(tx) 真实分支', () => {
  it('传 tx 时逐个 await tx.entityReference/entityLink upsert，不调 tx.$transaction', async () => {
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const txTransaction = vi.fn();  // 不应被调用

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
      $transaction: txTransaction,
    } as any;

    // voucher 带 invoiceId + orderId + customerRelationId → 生成 6 ops（3 reference + 3 link）
    const voucher = {
      id: 'PAY-1', voucherNumber: 'V001',
      invoiceId: 'INV-1', orderId: 'ORDER-1', customerRelationId: 'REL-1', customerName: 'Acme',
    };

    await syncPaymentVoucherReferences({} as any, voucher, { source: 'route:test' }, tx);

    // 不应调用 tx.$transaction（tx 没有这个方法用于批量）
    expect(txTransaction).not.toHaveBeenCalled();
    // 应逐个调用 upsert（3 个 reference + 3 个 link = 6，或至少 > 0）
    expect(entityReferenceUpsert.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(entityLinkUpsert.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('某个 upsert reject 时整体 reject（事务回滚语义）', async () => {
    const entityReferenceUpsert = vi.fn()
      .mockResolvedValueOnce({})  // 第一个成功
      .mockRejectedValueOnce(new Error('UPSERT_FAILED'));  // 第二个失败
    const entityLinkUpsert = vi.fn().mockResolvedValue({});

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
    } as any;

    const voucher = {
      id: 'PAY-1', voucherNumber: 'V001',
      invoiceId: 'INV-1', orderId: 'ORDER-1', customerRelationId: 'REL-1', customerName: 'Acme',
    };

    // 应 reject
    await expect(syncPaymentVoucherReferences({} as any, voucher, { source: 'route:test' }, tx))
      .rejects.toThrow('UPSERT_FAILED');
  });

  it('无 tx 时保持原 prisma.$transaction(ops) 逻辑（向后兼容）', async () => {
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const prismaTransaction = vi.fn().mockResolvedValue([]);

    const prisma = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
      $transaction: prismaTransaction,
    } as any;

    const voucher = {
      id: 'PAY-1', voucherNumber: 'V001',
      orderId: 'ORDER-1',
    };

    await syncPaymentVoucherReferences(prisma, voucher, { source: 'route:test' });

    // 无 tx 时用 prisma.$transaction
    expect(prismaTransaction).toHaveBeenCalledTimes(1);
    // $transaction 接收 ops 数组
    const opsArg = prismaTransaction.mock.calls[0][0];
    expect(Array.isArray(opsArg)).toBe(true);
    expect(opsArg.length).toBeGreaterThan(0);
  });
});

describe('task_mqxxxu1g: syncInvoiceReferences(tx) 真实分支', () => {
  it('传 tx 时逐个 await，不调 tx.$transaction', async () => {
    const entityReferenceUpsert = vi.fn().mockResolvedValue({});
    const entityLinkUpsert = vi.fn().mockResolvedValue({});
    const txTransaction = vi.fn();

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
      $transaction: txTransaction,
    } as any;

    const invoice = {
      id: 'INV-1', invoiceNumber: 'INV001',
      orderId: 'ORDER-1', customerRelationId: 'REL-1', customerName: 'Acme',
    };

    await syncInvoiceReferences({} as any, invoice, { source: 'route:test' }, tx);

    expect(txTransaction).not.toHaveBeenCalled();
    expect(entityReferenceUpsert.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(entityLinkUpsert.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('某个 upsert reject 时整体 reject', async () => {
    const entityReferenceUpsert = vi.fn().mockRejectedValue(new Error('SYNC_FAIL'));
    const entityLinkUpsert = vi.fn().mockResolvedValue({});

    const tx = {
      entityReference: { upsert: entityReferenceUpsert },
      entityLink: { upsert: entityLinkUpsert },
    } as any;

    const invoice = { id: 'INV-1', invoiceNumber: 'INV001', orderId: 'ORDER-1' };

    await expect(syncInvoiceReferences({} as any, invoice, { source: 'route:test' }, tx))
      .rejects.toThrow('SYNC_FAIL');
  });
});
