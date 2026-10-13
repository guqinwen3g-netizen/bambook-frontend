/**
 * 「未结清应收」判据回归守卫（2026-09-17）
 *
 * 病灶：原先 6 个消费点各自手写 `type='Receivable' && status ∈ {Issued, PartiallyPaid}`，
 *   **不看金额**。而 `amount` 的符号守卫只禁负数、放行 0 →
 *   一张 **0 元应收票**（真 API 可建）被当成未结清逾期应收 →
 *   虚增 maxOverdueDays → `checkCreditAvailable` 返回 blocked/OVERDUE_60_DAYS →
 *   客户被永久挡单（该票永远无法 Paid，故无任何自动解冻路径）。
 *   真库证据：`scripts/acceptance-zero-amount-invoice-credit-gate.ts`
 *   （S2: 被测客户只有 1 张 0 元票 → maxOverdueDays=65；S3: blocked=true/OVERDUE_60_DAYS）。
 *
 * 本文件钉三件事：
 *   1. 真源 `openReceivableWhere()` 的形状（含 amount>0，且 extra 不能覆盖守卫）
 *   2. `hasOpenAmount()` 的边界（0 / 负数 / 字符串 / NaN）
 *   3. **结构守卫**：4 个消费点必须从 `shared/openReceivable` 取判据，
 *      且不再出现手写的 `status: { in: ['Issued', 'PartiallyPaid'] }`
 *
 * ⚠️ 注意区分两类用法（别把守卫装到不该装的地方）：
 *   · 「是否逾期/是否需催收」的**判定** → 必须用 openReceivableWhere（排除 0/负额）
 *   · 「应收净额汇总/账龄」的**聚合** → **不能**用（负额贷项必须计入，否则净额虚高）
 *     例：financeServiceV2 的应收/应付汇总、reportService 的账龄、computeNetOpenReceivables
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReceivableWhere, hasOpenAmount, RECEIVABLE_OPEN_STATUSES } from '../shared/openReceivable';
import { createCreditService } from '../credit/creditService';
import { resolveTargetInvoiceId } from '../events/linkages/L5AutoAllocate';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/__tests__
const SRC = path.resolve(HERE, '..'); // server/src

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * ★ 内联字面量判据的**两种**写法 —— 结构守卫必须**都**覆盖。
 * 只覆盖一种 = 另一种写法可以一直留在代码里而守卫「通过」（空过的验证器，2026-09-17 实证）。
 */
const INLINE_LITERAL_PATTERNS: RegExp[] = [
  // ① where 片段：status: { in: ['Issued', 'PartiallyPaid'] }
  /status:\s*\{\s*in:\s*\[\s*'Issued'\s*,\s*'PartiallyPaid'\s*\]/,
  // ② 内存判定：['Issued', 'PartiallyPaid'].includes(x)
  /\[\s*'Issued'\s*,\s*'PartiallyPaid'\s*\]\s*\.includes\(/,
];

describe('shared/openReceivable · 判据真源', () => {
  it('openReceivableWhere() 含四要素：type / status / deletedAt / **amount>0**', () => {
    const w = openReceivableWhere();
    expect(w.type).toBe('Receivable');
    expect(w.status).toEqual({ in: [...RECEIVABLE_OPEN_STATUSES] });
    expect(w.deletedAt).toBeNull();
    expect(w.amount).toEqual({ gt: 0 }); // ★ 本文件存在的理由
  });

  it('extra 可叠加业务过滤（customerRelationId 等）', () => {
    const w = openReceivableWhere({ customerRelationId: 'REL_1' });
    expect(w.customerRelationId).toBe('REL_1');
    expect(w.amount).toEqual({ gt: 0 });
  });

  it('★ extra **不能**覆盖核心判据（传同名字段也覆盖不掉守卫）', () => {
    const w = openReceivableWhere({ amount: { lt: 0 }, type: 'Payable', status: { in: ['Paid'] } } as any);
    expect(w.amount).toEqual({ gt: 0 });
    expect(w.type).toBe('Receivable');
    expect(w.status).toEqual({ in: [...RECEIVABLE_OPEN_STATUSES] });
  });

  it('hasOpenAmount 边界：0 / 负数 / 空 / NaN 一律 false；正数（含字符串）true', () => {
    expect(hasOpenAmount(0)).toBe(false);
    expect(hasOpenAmount('0')).toBe(false);
    expect(hasOpenAmount('0.0000')).toBe(false);
    expect(hasOpenAmount(-1)).toBe(false);
    expect(hasOpenAmount('-500.25')).toBe(false);
    expect(hasOpenAmount(null)).toBe(false);
    expect(hasOpenAmount(undefined)).toBe(false);
    expect(hasOpenAmount('abc')).toBe(false);
    expect(hasOpenAmount(NaN)).toBe(false);
    expect(hasOpenAmount(0.01)).toBe(true);
    expect(hasOpenAmount('12000')).toBe(true);
  });
});

describe('★ 结构守卫：判据消费点必须用真源', () => {
  const CONSUMERS = [
    'credit/creditService.ts',
    'scheduler/tasks/receivableOverdueDetector.ts',
    'risk/riskService.ts',
    'customer/route.ts',
    // L5 自动核销：候选发票按 issueDate 升序只取第一条，0 元/负额票会「占位」
    // → 下游 remaining ≤ 0 静默 return，整笔收款不核销（钱收了不上账）。
    'events/linkages/L5AutoAllocate.ts',
  ];

  it.each(CONSUMERS)('%s 从 shared/openReceivable 取判据', (rel) => {
    expect(readSrc(rel)).toMatch(/from '[^']*shared\/openReceivable'/);
  });

  it.each(CONSUMERS)('%s 不再手写内联字面量判据（★ 两种写法都禁）', (rel) => {
    const src = readSrc(rel);
    // 允许出现常量名，但**不允许**再出现内联字面量判据
    for (const re of INLINE_LITERAL_PATTERNS) {
      expect(src, `${rel} 命中内联字面量判据：${re}`).not.toMatch(re);
    }
  });

  /**
   * ★ 守卫自检 —— 2026-09-17 补。
   * 病灶：本断言原先**只有一种正则**（`status: { in: [...] }`），
   * 而 `L5AutoAllocate.ts` 用的是另一种写法 `['Issued','PartiallyPaid'].includes(...)`
   * → 该文件在 CONSUMERS 里、断言也「通过」了，**却什么都没守住**（空过的验证器）。
   * 这里把「正则确实能咬住旧写法样本」也钉成断言，防止将来正则被改坏成恒不匹配。
   */
  it('★ 守卫自检：两条正则确实能咬住「旧写法」样本（防止正则退化成恒不匹配）', () => {
    const SAMPLES = [
      "status: { in: ['Issued', 'PartiallyPaid'] },",
      "status:{in:['Issued','PartiallyPaid']}",
      "if (!['Issued', 'PartiallyPaid'].includes(invoice.status)) {",
      "const ok = ['Issued','PartiallyPaid'].includes(s);",
    ];
    for (const s of SAMPLES) {
      expect(
        INLINE_LITERAL_PATTERNS.some((re) => re.test(s)),
        `正则漏掉了旧写法样本：${s}`,
      ).toBe(true);
    }
    // 反向：常量名写法**不该**被误伤
    expect(INLINE_LITERAL_PATTERNS.some((re) => re.test('status: { in: [...RECEIVABLE_OPEN_STATUSES] }'))).toBe(false);
    expect(INLINE_LITERAL_PATTERNS.some((re) => re.test('(RECEIVABLE_OPEN_STATUSES as readonly string[]).includes(s)'))).toBe(false);
  });
});

describe('★ 行为守卫：0 元 / 负额票不产生虚假逾期', () => {
  /** 只有一张票的客户；creditLimit 查不到（只验 maxOverdueDays） */
  function makePrisma(invoices: any[]) {
    return {
      invoice: { findMany: vi.fn().mockResolvedValue(invoices) },
      creditLimit: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;
  }
  const OLD = '2026-06-01'; // 今天 2026-09-17 → 推定到期 2026-07-01 → 逾期 78 天

  it('maxOverdueDays 的查询带 amount>0，且循环内对内存行兜底', async () => {
    const prisma = makePrisma([]);
    const svc = createCreditService({ prisma });
    await svc.getCreditStatus('REL_1', new Date(2026, 8, 17));
    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.amount).toEqual({ gt: 0 });
    expect(where.type).toBe('Receivable');
  });

  it('★ 只有一张 0 元逾期票 → maxOverdueDays = 0（修前为 78）', async () => {
    const prisma = makePrisma([
      { id: 'INV_Z', dueDate: null, issueDate: OLD, amount: '0' },
    ]);
    const svc = createCreditService({ prisma });
    const st: any = await svc.getCreditStatus('REL_1', new Date(2026, 8, 17));
    expect(st.maxOverdueDays).toBe(0);
  });

  it('★ 只有一张负额贷项逾期票 → maxOverdueDays = 0（修前为 78）', async () => {
    const prisma = makePrisma([
      { id: 'INV_C', dueDate: null, issueDate: OLD, amount: '-500' },
    ]);
    const svc = createCreditService({ prisma });
    const st: any = await svc.getCreditStatus('REL_1', new Date(2026, 8, 17));
    expect(st.maxOverdueDays).toBe(0);
  });

  it('阳性对照：一张正额逾期票 → maxOverdueDays = 78（证明机制没被改坏）', async () => {
    const prisma = makePrisma([
      { id: 'INV_P', dueDate: null, issueDate: OLD, amount: '1000' },
    ]);
    const svc = createCreditService({ prisma });
    const st: any = await svc.getCreditStatus('REL_1', new Date(2026, 8, 17));
    expect(st.maxOverdueDays).toBe(78);
  });
});

describe('★ 行为守卫：L5 自动核销不被 0 元 / 负额票「占位」', () => {
  /**
   * 极小内存匹配器：只实现本判据用到的算子（status.in / amount.gt / 等值），
   * 并按 issueDate 升序取第一条——够钉住「最老的票占位」这个回归即可。
   */
  function makePrisma(rows: any[]) {
    const match = (row: any, where: any) =>
      Object.entries(where).every(([k, v]: any) => {
        if (k === 'status') return v.in.includes(row.status);
        if (k === 'amount') return Number(row.amount) > v.gt;
        if (k === 'deletedAt') return row.deletedAt === v;
        return row[k] === v;
      });
    return {
      invoice: {
        findFirst: vi.fn(async ({ where }: any) => {
          const hits = rows.filter((r) => match(r, where)).sort((a: any, b: any) => a.issueDate.localeCompare(b.issueDate));
          return hits[0] ? { id: hits[0].id } : null;
        }),
      },
    } as any;
  }

  const ROWS = [
    { id: 'INV_ZERO', type: 'Receivable', status: 'Issued', deletedAt: null, amount: '0', issueDate: '2026-05-01', orderId: 'ORD_1', customerRelationId: 'REL_1' },
    { id: 'INV_NEG', type: 'Receivable', status: 'Issued', deletedAt: null, amount: '-800', issueDate: '2026-05-15', orderId: 'ORD_1', customerRelationId: 'REL_1' },
    { id: 'INV_REAL', type: 'Receivable', status: 'Issued', deletedAt: null, amount: '12000', issueDate: '2026-06-01', orderId: 'ORD_1', customerRelationId: 'REL_1' },
  ];

  it('★ 订单下最老的是 0 元票 → 仍选中后面的正额票（修前选中 0 元票 → 静默不核销）', async () => {
    const prisma = makePrisma(ROWS);
    const id = await resolveTargetInvoiceId(prisma, { invoiceId: null, orderId: 'ORD_1', customerRelationId: 'REL_1' }, {});
    expect(id).toBe('INV_REAL');
  });

  it('★ 客户维度同理不被占位', async () => {
    const prisma = makePrisma(ROWS);
    const id = await resolveTargetInvoiceId(prisma, { invoiceId: null, orderId: null, customerRelationId: 'REL_1' }, {});
    expect(id).toBe('INV_REAL');
  });

  it('候选查询确实带 amount>0（接线断言）', async () => {
    const prisma = makePrisma(ROWS);
    await resolveTargetInvoiceId(prisma, { invoiceId: null, orderId: 'ORD_1', customerRelationId: 'REL_1' }, {});
    const where = prisma.invoice.findFirst.mock.calls[0][0].where;
    expect(where.amount).toEqual({ gt: 0 });
    expect(where.type).toBe('Receivable');
    expect(where.orderId).toBe('ORD_1'); // extra 叠加仍然生效
  });

  it('★ 只有负额贷项票 → 返回 null（贷项不收钱，不该被自动核销）', async () => {
    const prisma = makePrisma([ROWS[1]]);
    const id = await resolveTargetInvoiceId(prisma, { invoiceId: null, orderId: 'ORD_1', customerRelationId: 'REL_1' }, {});
    expect(id).toBeNull();
  });
});
