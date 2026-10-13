/**
 * A2 第三方代付归位 —— 报表内核行为守卫 + 结构守卫
 *
 * 为什么两套都要：
 *   · 行为守卫（mock prisma）钉住「对账单把代付的钱记到合同客户头上」——
 *     这是 A2 的**症状层**，改坏了立刻红。
 *   · 结构守卫钉住「不许有人又把收款按打款人过滤回去」——
 *     这是 A2 的**复发层**：真源在，但如果哪天有人图省事在 reportService 里
 *     写回 `where:{ customerRelationId, type:'Receipt' }`，行为守卫可能因为
 *     fixture 恰好同源而仍然绿（假绿）⇒ 必须用源码扫描补一刀。
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getCustomerStatement } from '../reportService';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePrisma(opts: { invoices: any[]; vouchers: any[]; allocations: any[] }) {
  return {
    // B266 连带：这两份桩里没有 relation 这张表 ⇒ 服务层加了"名字兜底回读档案"之后会 TypeError。
    //   默认查不到关系（与这些用例的旧世界一致：票面名都在，兜底不触发）；要给兜底喂数据就传 opts.relations。
    relation: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any = {}) =>
        (opts.relations ?? []).find((r: any) => r.id === where?.id) ?? null),
    },
    invoice: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.invoices;
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.customerRelationId) rows = rows.filter(r => r.customerRelationId === where.customerRelationId);
        if (where?.type) rows = rows.filter(r => r.type == null || r.type === where.type);
        return rows;
      }),
    },
    paymentVoucher: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.vouchers;
        if (where?.id?.in) return rows.filter(r => where.id.in.includes(r.id));
        if (where?.customerRelationId) rows = rows.filter(r => r.customerRelationId === where.customerRelationId);
        if (where?.type) rows = rows.filter(r => r.type == null || r.type === where.type);
        if (Array.isArray(where?.OR)) {
          const hit = new Set<any>();
          for (const cond of where.OR) {
            for (const r of opts.vouchers) {
              if (cond.customerRelationId && r.customerRelationId === cond.customerRelationId) hit.add(r);
              if (cond.id?.in && cond.id.in.includes(r.id)) hit.add(r);
            }
          }
          rows = opts.vouchers.filter(r => hit.has(r));
        }
        return rows;
      }),
    },
    invoiceAllocation: {
      findMany: vi.fn().mockImplementation(async ({ where }: any = {}) => {
        let rows = opts.allocations;
        if (where?.invoiceId?.in) rows = rows.filter(r => where.invoiceId.in.includes(r.invoiceId));
        if (where?.voucherId?.in) rows = rows.filter(r => where.voucherId.in.includes(r.voucherId));
        return rows;
      }),
    },
  } as any;
}

// 场景：REL_B（合同客户 Beta）的票，由 REL_A（Alpha）代付
const INVOICES = [
  { id: 'i1', invoiceNumber: 'INV-B1', type: 'Receivable', amount: 10000, currency: 'USD', issueDate: '2026-05-01', customerRelationId: 'REL_B', customerName: 'Beta' },
];
const VOUCHERS = [
  { id: 'v1', voucherNumber: 'PAY-A1', type: 'Receipt', amount: 10000, currency: 'USD', paymentDate: '2026-06-01', customerRelationId: 'REL_A', customerName: 'Alpha' },
];

describe('A2 第三方代付归位 · 客户对账单', () => {
  it('代付的钱出现在**合同客户**的对账单上（原来永远查不到 → 客户拿水单对不上）', async () => {
    const prisma = makePrisma({
      invoices: INVOICES,
      vouchers: VOUCHERS,
      allocations: [{ voucherId: 'v1', invoiceId: 'i1', appliedAmount: 10000 }],
    });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'REL_B' });

    expect(stmt.customerName).toBe('Beta');
    const usd = stmt.sections.find(s => s.currency === 'USD')!;
    expect(usd).toBeTruthy();
    const receipt = usd.transactions.find(t => t.kind === 'receipt')!;
    expect(receipt).toBeTruthy();
    expect(receipt.credit).toBe(10000);
    expect(receipt.isThirdParty).toBe(true);
    expect(receipt.payerName).toBe('Alpha');
    expect(receipt.note).toContain('第三方代付');
    // 10000 - 10000 = 0 ⇒ 客户已付清
    expect(usd.closingBalance).toBe(0);
  });

  it('同一笔钱**不会**同时出现在代付方的对账单上（原来会让代付方余额变负）', async () => {
    const prisma = makePrisma({
      invoices: INVOICES,
      vouchers: VOUCHERS,
      allocations: [{ voucherId: 'v1', invoiceId: 'i1', appliedAmount: 10000 }],
    });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'REL_A' });
    // Alpha 在这张对账单上没有发票，也没有属于自己的收款 ⇒ 不该有任何流水
    expect(stmt.sections).toHaveLength(0);
  });

  it('代付只核销一部分：合同客户只认核销额，余款留在打款人（预收不凭空归别人）', async () => {
    const prisma = makePrisma({
      invoices: INVOICES,
      vouchers: VOUCHERS,
      allocations: [{ voucherId: 'v1', invoiceId: 'i1', appliedAmount: 6000 }],
    });
    const beta = await getCustomerStatement(prisma, { customerRelationId: 'REL_B' });
    expect(beta.sections[0].transactions.find(t => t.kind === 'receipt')!.credit).toBe(6000);
    expect(beta.sections[0].closingBalance).toBe(4000);

    const alpha = await getCustomerStatement(prisma, { customerRelationId: 'REL_A' });
    const usd = alpha.sections.find(s => s.currency === 'USD')!;
    expect(usd.transactions.find(t => t.kind === 'receipt')!.credit).toBe(4000);
    // 未核销余款属预收 ⇒ Alpha 名下余额为负（公司欠 Alpha），且不打代付标
    expect(usd.transactions.find(t => t.kind === 'receipt')!.isThirdParty).toBe(false);
    expect(usd.closingBalance).toBe(-4000);
  });

  it('自付全额核销：输出与改造前一致（一行全额、无代付标）—— 防回归', async () => {
    const prisma = makePrisma({
      invoices: [{ id: 'i9', invoiceNumber: 'INV-A1', type: 'Receivable', amount: 5000, currency: 'USD', issueDate: '2026-05-01', customerRelationId: 'REL_A', customerName: 'Alpha' }],
      vouchers: [{ id: 'v9', voucherNumber: 'PAY-A9', type: 'Receipt', amount: 5000, currency: 'USD', paymentDate: '2026-06-01', customerRelationId: 'REL_A', customerName: 'Alpha' }],
      allocations: [{ voucherId: 'v9', invoiceId: 'i9', appliedAmount: 5000 }],
    });
    const stmt = await getCustomerStatement(prisma, { customerRelationId: 'REL_A' });
    const usd = stmt.sections[0];
    expect(usd.transactions).toHaveLength(2);
    expect(usd.transactions[1]).toMatchObject({ kind: 'receipt', number: 'PAY-A9', credit: 5000 });
    expect(usd.transactions[1].isThirdParty).toBe(false);
    expect(usd.closingBalance).toBe(0);
  });

  it('未核销的代付款（钱还没落到谁的票上）：留在打款人名下，合同客户对账单不变', async () => {
    const prisma = makePrisma({ invoices: INVOICES, vouchers: VOUCHERS, allocations: [] });
    const beta = await getCustomerStatement(prisma, { customerRelationId: 'REL_B' });
    expect(beta.sections[0].transactions.every(t => t.kind === 'invoice')).toBe(true);
    expect(beta.sections[0].closingBalance).toBe(10000);

    const alpha = await getCustomerStatement(prisma, { customerRelationId: 'REL_A' });
    expect(alpha.sections[0].transactions.find(t => t.kind === 'receipt')!.credit).toBe(10000);
  });
});

describe('A2 结构守卫：对账单收款必须走归属真源', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'src/finance/reportService.ts'), 'utf8');

  it('import 且调用 attributeReceiptsToCustomers（真源被接线，删掉即红）', () => {
    expect(src).toMatch(/from '\.\/receiptAttribution'/);
    expect(src).toMatch(/attributeReceiptsToCustomers\(\{/);
    expect(src).toMatch(/linesForRelation\(/);
  });

  /**
   * ★ 判据说明（我第一版判据写错了，这里记录为什么改成现在这样）：
   *   初版写的是「paymentVoucher 查询里不许同时出现 customerRelationId 与 'Receipt'」，
   *   结果自己红 —— 因为 `type:'Receipt'`（筛收款凭证）本身是**正确的**，
   *   错的是「只用 customerRelationId 当归属」+「拿 voucher.amount 直接当贷方」。
   *   所以判据改成：**收款行只能由归属真源产出** —— 即 getCustomerStatement
   *   自己不碰 paymentVoucher（查询全部委托给 collectAttributedReceipts），
   *   而 collectAttributedReceipts 必须调真源并过滤归属。谁绕过真源补一行，立刻红。
   */
  const slice = (startMarker: string): string => {
    const i = src.indexOf(startMarker);
    expect(i).toBeGreaterThanOrEqual(0);
    const rest = src.slice(i + startMarker.length);
    const j = rest.search(/\n(?:export )?(?:async )?function |\nexport const /);
    return j < 0 ? rest : rest.slice(0, j);
  };

  it('★ getCustomerStatement 不得自己查 paymentVoucher（收款行只能来自归属真源）', () => {
    const body = slice('export async function getCustomerStatement(');
    expect(body.length).toBeGreaterThan(200); // 守卫有效：确实切到了函数体
    expect(body).not.toMatch(/paymentVoucher/);
    expect(body).toMatch(/collectAttributedReceipts\(/);
  });

  it('★ collectAttributedReceipts 必须调用归属真源并只留本客户归属行', () => {
    const body = slice('async function collectAttributedReceipts(');
    expect(body).toMatch(/attributeReceiptsToCustomers\(\{/);
    expect(body).toMatch(/linesForRelation\(lines,/);
  });
});
