/**
 * G-4 批：L/C 三道门禁的**接线**守卫（矩阵 :136-141「订单确认 / 装运前 / 不符点阻断发运」+ 开票）。
 * ★ B50-1b 扩清单：接入点从 4 个文件到 **6 个**（新增 agent 面两条审批提交路，见文末那组）。
 *
 * 判 `lcGate.test.ts` 判不到的那一半：**门禁存在，但没人调用**。
 * 本仓最贵的错误形状就是"代码在、测试绿、线上不生效" ⇒ 这里钉三件事：
 *  ① 三个接入点各自**确实调了** evaluate*Gate（剥注释后源码里要有调用，注释里的不算）；
 *  ② 确认侧的 `select` 必须带上 `paymentInstrument` —— 少了它，`order.paymentInstrument` 恒为 undefined
 *     ⇒ 门禁**永不触发**且所有测试照样绿（矩阵写的字段名 `paymentMethod` 在 Order 上根本不存在，
 *     这是本批最容易踩的静默 fail-open）；
 *  ③ 行为端到端（mock prisma）：L/C 订单被阻断、T/T 订单放行（正向对照，防判据恒阻断）。
 */
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { evaluateShipmentReleaseGate } from '../../shipping/shipmentEligibilityGate';
import { createInvoice } from '../../finance/invoiceMutationService';
import { createProformaInvoiceService } from '../../finance/proformaInvoiceService';
import { createFinanceRouter } from '../../finance/route';
import { authHeader } from '../../__tests__/authTestHelper';
import { ORDER_LIFECYCLE_ERROR_HTTP_STATUS } from '../../orders/orderLifecycleService';
import { lookupErrorCode } from '../../shared/errorCodes';

/** 与 shipmentLandTransport.test.ts:17 同一手法：剥掉注释，**注释里写"已接"不算数** */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('L/C 门禁 · 三个接入点确实被接线（剥注释后源码里有调用）', () => {
  it('① 订单确认侧：调用 evaluateLcGateForOrder 且 stage=order:confirm', () => {
    const src = read('../../orders/orderLifecycleService.ts');
    expect(src).toMatch(/decideLcGate\(/);
    expect(src).toMatch(/stage:\s*'order:confirm'/);
    expect(src).toContain('LC_GATE_BLOCKED');
  });

  it('★ 确认侧的 select 必须带 paymentInstrument：漏了 = 门禁恒不触发 = 静默 fail-open', () => {
    const src = read('../../orders/orderLifecycleService.ts');
    const sel = src.match(/const gateOrder = await[\s\S]*?\}\);/);
    expect(sel, '找不到确认门禁那次 order.findUnique（结构变了要同步这条钉）').toBeTruthy();
    expect(sel![0]).toContain('paymentInstrument');
  });

  it('② 发运侧：合并进既有出运放行门禁，且**复用 shipment:release 例外**（矩阵：不另造例外机制）', () => {
    const src = read('../../shipping/shipmentEligibilityGate.ts');
    expect(src).toMatch(/evaluateLcGateForOrder\(/);
    expect(src).toMatch(/stage:\s*'shipment:release'/);
    // 反向钉：不许给 LC 另开一个出运例外 action（那样一条例外只管一半，另一条只管另一半 ⇒ 漏口）
    expect(src).not.toMatch(/exceptionAction:\s*'lc:/);
  });

  it('③ 开票侧：调用门禁、stage=invoice:issue，且有 LC 专属 action', () => {
    const src = read('../../finance/invoiceMutationService.ts');
    expect(src).toMatch(/decideLcGate\(/);
    expect(src).toMatch(/stage:\s*'invoice:issue'/);
    expect(src).toMatch(/exceptionAction:\s*LC_INVOICE_ISSUE_ACTION/);
  });

  it('④ PI 转正侧（复核补的第 4 个接入点）：不走 createInvoice 也必须调门禁', () => {
    const src = read('../../finance/proformaInvoiceService.ts');
    expect(src).toMatch(/decideLcGate\(/);
    expect(src).toMatch(/stage:\s*'invoice:issue'/);
    // 反向钉：不许在这里自己拼一套豁免判定（例外只有 DR-013 一份真源）
    expect(src).not.toMatch(/hasActiveException/);
  });
});

/**
 * ★ B50-1b：agent 面两条审批提交路（`order.confirm` / `invoice.issue`）此前**完全不在**接入点清单里
 *   —— 它们在自己的 `$transaction` 里直接 `order.update` / `invoice.create`，
 *   所以 G-4 那批"三个接入点都接上了"的结论对它们不成立（同一根因第 N 次现形）。
 *   这里把清单从 4 个文件扩到 6 个，并按 G-4 的教训给每个文件配一条
 *   **"接错就永不触发"的反例钉**（不是只钉"出现过 decideLcGate 这个单词"）。
 */
describe('B50-1b · agent 面两条提交路径也在接入点清单里（6 文件）', () => {
  it('⑤ order.confirm 提交侧：确认腿调**抽出来的那份判定**、开票腿调 decideLcGate', () => {
    const src = read('../../agent/commitTransaction.ts');
    // 确认腿：必须是共用的 `evaluateOrderConfirmGates(`，不是在本文件里重写一份信用/MOQ 判定
    expect(src).toMatch(/evaluateOrderConfirmGates\(\{/);
    // 开票腿：同一个函数、同一个 stage、同一个 action 常量（不许在这里另造 LC 例外机制）
    expect(src).toMatch(/decideLcGate\(\{/);
    expect(src).toMatch(/stage:\s*'invoice:issue'/);
    expect(src).toMatch(/exceptionAction:\s*LC_INVOICE_ISSUE_ACTION/);
    // 反向钉 1：不许自己查信用证表 / 例外表（那会变成第二份条款判定真源）
    expect(src).not.toMatch(/letterOfCredit\.findMany/);
    expect(src).not.toMatch(/hasActiveException/);
    // 反向钉 2（★ 一个字母的 fail-open）：`order: null` 在 decideLcGate 契约里 = "调用方已确认订单不存在
    //   ⇒ 本门禁不适用" ⇒ 传了就等于放行。这两处都必须让门禁自己按 orderId 查。
    expect(src, '传 order:null 会被门禁当成"订单不存在 ⇒ 不适用"，等于把这道门拆了').not.toMatch(/order:\s*null/);
  });

  it('⑥ invoice.issue 提交侧：不走 createInvoice 的第二条开票路也接了同一道门', () => {
    const src = read('../../agent/invoiceIssueFlow.ts');
    expect(src).toMatch(/decideLcGate\(\{/);
    expect(src).toMatch(/stage:\s*'invoice:issue'/);
    expect(src).toMatch(/exceptionAction:\s*LC_INVOICE_ISSUE_ACTION/);
    expect(src).not.toMatch(/letterOfCredit\.findMany/);
    expect(src).not.toMatch(/hasActiveException/);
    expect(src, '同上：order:null 会把门禁变成放行').not.toMatch(/order:\s*null/);
  });

  it('★ 反向钉：确认门禁的字段读数只剩一份（抽函数之后不许在调用方另选一遍）', () => {
    // `paymentInstrument` 一旦被哪个调用方自己 select 并漏掉，门禁就恒不触发且全绿（G-4 的同一形状）。
    // 抽成 evaluateOrderConfirmGates 之后，门禁读的字段集合应当**只在服务里出现一次**。
    const svc = read('../../orders/orderLifecycleService.ts');
    expect((svc.match(/paymentInstrument: true/g) ?? []).length, 'select 出现两份 = 两处会各自漂移').toBe(1);
    expect(svc).toMatch(/export async function evaluateOrderConfirmGates/);
    // agent 两处不许自带订单行读数（锚点只取 id/deletedAt，付款方式由门禁自己查）
    const commit = read('../../agent/commitTransaction.ts');
    expect(commit).not.toMatch(/select:\s*\{[^}]*paymentInstrument/);
    const issue = read('../../agent/invoiceIssueFlow.ts');
    expect(issue).not.toMatch(/select:\s*\{[^}]*paymentInstrument/);
  });
});

describe('L/C 门禁 · 发运侧行为（mock prisma 端到端）', () => {
  const order = (over: any) => ({
    id: 'O1', status: 'Confirmed', deletedAt: null, type: 'Other', businessLine: 'Other',
    paymentInstrument: 'L/C', ...over,
  });
  const prismaWith = (o: any, lcs: any[]) => ({
    order: { findUnique: async () => o },
    letterOfCredit: { findMany: async () => lcs },
    // 'Other' 链不查 QC ⇒ 不需要其余 delegate
  });

  it('L/C 订单、库里没有信用证 ⇒ 阻断，原因含 LC_NOT_REGISTERED', async () => {
    const r = await evaluateShipmentReleaseGate({ prisma: prismaWith(order(), []) as any, orderIds: ['O1'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const reasons = (r.error as any).blockingReasons.join(' ');
      expect(reasons).toContain('LC_NOT_REGISTERED');
    }
  });

  it('★ 正向对照：同样没有信用证，但订单是 T/T ⇒ 放行（防判据退化成"所有出运都阻断"）', async () => {
    const r = await evaluateShipmentReleaseGate({
      prisma: prismaWith(order({ paymentInstrument: 'T/T' }), []) as any, orderIds: ['O1'],
    });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
  });

  it('L/C 订单、证已过期 ⇒ 阻断且带证号（要能定位是哪张证）', async () => {
    const r = await evaluateShipmentReleaseGate({
      prisma: prismaWith(order(), [{ id: 'LC1', lcNumber: 'LC2026X', status: 'Issued', expiryDate: '2020-01-01', shipmentDeadline: '2030-01-01' }]) as any,
      orderIds: ['O1'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain('LC_EXPIRED');
  });
});

describe('L/C 门禁 · 开票侧行为（门禁在事务内：判完即写不留竞态，抛出即回滚不留半张票）', () => {
  const txFor = (instrument: string | null, lcs: any[] = [], withExc = true) => {
    const created: any[] = [];
    const tx: any = {
      order: { findUnique: async () => (instrument == null ? null : { id: 'O1', paymentInstrument: instrument, paymentTerms: null }) },
      letterOfCredit: { findMany: async () => lcs },
      invoice: { findFirst: async () => null, create: async ({ data }: any) => { created.push(data); return { id: 'INV__1', ...data }; } },
      invoiceOrderAllocation: { create: async () => ({}), findMany: async () => [] },
      invoiceAllocation: { findMany: async () => [], count: async () => 0 },
      paymentVoucher: { findMany: async () => [] },
      entityLink: { upsert: async () => ({}) }, entityReference: { upsert: async () => ({}) },
      auditLog: { create: async () => ({ id: 'AL-1' }) },
      systemConfig: { findUnique: async () => null },
      relation: { findUnique: async () => null },
    };
    if (withExc) tx.dr013ExceptionRequest = { findMany: async () => [] };
    return { tx, created };
  };
  const prismaFor = (tx: any) => ({ $transaction: async (fn: any) => fn(tx) }) as any;
  const input = { type: 'Receivable', orderId: 'O1', amount: 1000, currency: 'USD', issueDate: '2026-09-21', dueDate: '2026-10-21', customerRelationId: 'R1', customerName: 'C' };

  it('L/C 订单、库里没有信用证 ⇒ LC_GATE_BLOCKED，且**一张票都没写进去**', async () => {
    const { tx, created } = txFor('L/C');
    const r = await createInvoice({ prisma: prismaFor(tx), input, actorId: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('LC_GATE_BLOCKED');
    expect(r.error?.message, '消息必须给出下一步（去登记信用证），不许只说不允许').toContain('登记');
    expect(created, '被阻断的请求不许留下任何一张票').toHaveLength(0);
  });

  it('★ 例外状态查不出来 ⇒ 单独的码 LC_EXCEPTION_CHECK_FAILED（下一步是排障，不是补证 ⇒ 不许混报）', async () => {
    const { tx, created } = txFor('L/C', [], false);
    const r = await createInvoice({ prisma: prismaFor(tx), input, actorId: 'u1' });
    expect(r.error?.code).toBe('LC_EXCEPTION_CHECK_FAILED');
    expect(r.error?.message).toContain('无法确认');
    expect(created).toHaveLength(0);
  });

  it('★ 正向对照：T/T 订单正常开票，且**根本不该查信用证表**（非信用证路径零成本零变化）', async () => {
    const { tx, created } = txFor('T/T');
    tx.letterOfCredit = { findMany: async () => { throw new Error('T/T 订单不该查信用证'); } };
    const r = await createInvoice({ prisma: prismaFor(tx), input, actorId: 'u1' });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe('L/C 门禁 · 路由层 HTTP 档位（被信用证挡住不许答成"服务器错误"）', () => {
  const prismaForRoute = (instrument: string, withExc: boolean) => {
    const create = vi.fn();
    const tx: any = {
      order: { findUnique: async () => ({ id: 'O1', paymentInstrument: instrument, paymentTerms: null }) },
      letterOfCredit: { findMany: async () => [] },
      // 门禁若被绕过，这张票就会被真写出去 ⇒ 下面逐例断言 create 没被调用（不许只靠状态码推断）
      invoice: { findFirst: async () => null, create },
    };
    const storedUser = { id: 'u_owner', status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ roleId: 'owner', departmentId: null, role: { id: 'owner',
        permissions: ['invoices:read', 'invoices:write', 'orders:read'].map(scope => ({ permission: { scope } })) } }] };
    const readUser = vi.fn(async ({ where }: any) => where.id === storedUser.id ? storedUser : null);
    tx.userAccount = { findFirst: readUser, findUnique: readUser };
    tx.userPermissionOverrides = { findMany: vi.fn(async () => []) };
    tx.order.findFirst = vi.fn(async ({ where }: any) => where.id === 'O1' ? { id: 'O1', deletedAt: null, paymentInstrument: instrument, paymentTerms: null } : null);
    tx.orderLine = { findMany: vi.fn(async () => []) };
    tx.sample = { findMany: vi.fn(async () => []) };
    tx.releaseScope = { findMany: vi.fn(async () => []) };
    tx.$queryRaw = vi.fn(async () => []);
    if (withExc) tx.dr013ExceptionRequest = { findMany: async () => [] };
    return { prisma: { $transaction: async (fn: any) => fn(tx) } as any, create };
  };
  const postInvoice = async (prisma: any) => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
    return request(app).post('/api/v1/finance').set(authHeader()).send({
      invoiceNumber: 'INV-LC-G4', type: 'Receivable', amount: '1000', currency: 'USD',
      issueDate: '2026-09-21', dueDate: '2026-10-21', status: 'Draft',
      customerRelationId: 'R1', customerName: 'C', orderId: 'O1',
    });
  };

  it('L/C 订单无证 ⇒ 403 + LC_GATE_BLOCKED（不是 500 —— 500 会让前端只显示"服务器错误"，业务员会一直重试）', async () => {
    const { prisma, create } = prismaForRoute('L/C', true);
    const res = await postInvoice(prisma);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('LC_GATE_BLOCKED');
    expect(res.body.error.message).toContain('登记');
    expect(create, '被挡住的那次请求不许把票写出去').not.toHaveBeenCalled();
  });

  it('例外查不出来 ⇒ 500 + LC_EXCEPTION_CHECK_FAILED（这一步确实是服务端故障，不许伪装成 4xx 业务拒绝）', async () => {
    const { prisma, create } = prismaForRoute('L/C', false);
    const res = await postInvoice(prisma);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('LC_EXCEPTION_CHECK_FAILED');
    expect(create).not.toHaveBeenCalled();
  });

  it('★ 反向对照：档位来自注册表真源，且与订单确认侧那份映射**不许各说各话**', () => {
    // 同一枚码在两道门禁（确认 / 开票）必须同档，否则前端按码分支会拿到两个语义。
    for (const code of ['LC_GATE_BLOCKED', 'LC_EXCEPTION_CHECK_FAILED'] as const) {
      expect(lookupErrorCode(code)!.status, `${code} 未登记进真源 = 开票路由会兜成 500`).toBe(
        ORDER_LIFECYCLE_ERROR_HTTP_STATUS[code],
      );
    }
  });
});

describe('L/C 门禁 · 第二条开票路径：PI 转正（不走 createInvoice，直接 db.invoice.create）', () => {
  // 复核抓到的事实：POST /api/v2/finance/invoices/:id/convert-to-receivable 会直接落一张
  // status='Issued' 的应收票，**完全绕过 createInvoice 里的开票门禁** ⇒ 门禁必须在这条路上也接。
  const piRow = {
    id: 'INV__PI', invoiceNumber: 'PI-2026-001', type: 'Proforma', status: 'Draft',
    amount: { toString: () => '1000.0000' }, exchangeRate: null, currency: 'USD', baseCurrency: 'CNY',
    issueDate: '2026-09-01', dueDate: '2026-10-01', orderId: 'O1',
    customerRelationId: null, customerName: 'C', ownerId: null, departmentId: null,
    notes: '', attachments: {}, deletedAt: null,
  };
  const proformaPrisma = (instrument: string) => {
    const create = vi.fn();
    const update = vi.fn();
    const prisma: any = {
      // Current actor and grants are explicit stored fixtures. These do not
      // prove company accounts or actual PostgreSQL permission enforcement.
      userAccount: { findUnique: async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null, primaryDeptId: null,
        roles: [{ departmentId: null, role: { id: 'role-admin', permissions: [{ permission: { scope: 'invoices:write' } }] } }] }) },
      userPermissionOverrides: { findMany: async () => [] },
      invoiceOrderAllocation: { findMany: async () => [] },
      // Technical source-lock seam; native SQL locking is covered by isolated PG.
      $queryRaw: async (sql: any) => [{ id: sql.values[0] }],
      invoice: {
        findFirst: async (a: any) => (String(a?.where?.id ?? '').startsWith('INV__') ? piRow : null),
        findUnique: async () => piRow,
        create, update,
      },
      order: {
        findUnique: async (a: any) => ({ id: a.where.id, paymentInstrument: instrument }),
        findFirst: async (a: any) => ({ id: a.where.id, deletedAt: null, ownerId: 'user_1', customerRelationId: null, paymentInstrument: instrument }),
      },
      letterOfCredit: { findMany: async () => [] },
      dr013ExceptionRequest: { findMany: async () => [] },
      $transaction: async (fn: any) => fn(prisma),
    };
    return { prisma, create, update };
  };

  it('L/C 订单的 PI 转正 ⇒ LC_GATE_BLOCKED，且**没建票、没把原 PI 作废、没烧单据编号**', async () => {
    const { prisma, create, update } = proformaPrisma('L/C');
    const svc = createProformaInvoiceService(prisma as any);
    const r = await svc.convertToReceivable('INV__PI', {}, 'user_1');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('LC_GATE_BLOCKED');
    expect(r.error?.message).toContain('LC_NOT_REGISTERED');
    expect(create, '转正被挡住时不许已经建出那张 Issued 应收票').not.toHaveBeenCalled();
    expect(update, '也不许顺手把原 PI 置成 Cancelled（否则票没开成、PI 也丢了）').not.toHaveBeenCalled();
  });

  it('★ 正向对照：T/T 订单的 PI 转正**不被 LC 门禁拦**（防判据把非信用证路径一起锁死）', async () => {
    const { prisma } = proformaPrisma('T/T');
    const svc = createProformaInvoiceService(prisma as any);
    const r = await svc.convertToReceivable('INV__PI', {}, 'user_1');
    // 只断言"不是 LC 门禁的码"：mock 没提供编号序列表，走通到最后一步不是本例的职责，
    // 但 LC 码一旦出现就说明门禁误伤了非信用证订单。
    expect(r.ok ? 'ok' : r.error?.code).not.toBe('LC_GATE_BLOCKED');
  });
});
