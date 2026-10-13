/**
 * reconciliationAckService.test.ts — H16-② 客户对账确认回执
 *
 * 口径（业务方授权按专业判断）钉住的不变量：
 *   1. 对账单**按币种分组**（跨币种不合并 —— T7-① 口径）
 *   2. 期末余额 = 期初 + 本期开票 − 本期收款
 *   3. 异议必须填说明（fail-closed）
 *   4. **同一期间只允许一条回执**（已存在 → 409，防反复提交）
 *   5. 快照在提交时**冻结**（回执代表客户那一刻确认的数字）
 *   6. 通知失败**不阻断**回执落库（回执本身是客户的凭证）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const notifyCalls: any[] = [];
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createCustomerReconciliationAckService, listReconciliationAcks } from '../reconciliationAckService';

function makePrisma(seed: {
  invoices?: any[];
  vouchers?: any[];
  existingAck?: any;
  users?: any[];
  notifyThrows?: boolean;
} = {}) {
  const invoices = seed.invoices ?? [];
  const vouchers = seed.vouchers ?? [];
  const created: any[] = [];
  const filterBy = (rows: any[], where: any, dateField: string) => rows.filter(r => {
    if (where.customerRelationId && r.customerRelationId !== where.customerRelationId) return false;
    const d = r[dateField];
    const cond = where[dateField];
    if (!cond) return true;
    if (cond.lt && !(d < cond.lt)) return false;
    if (cond.gte && !(d >= cond.gte)) return false;
    if (cond.lte && !(d <= cond.lte)) return false;
    return true;
  });
  const db: any = {
    invoice: { findMany: async ({ where }: any) => filterBy(invoices, where, 'issueDate') },
    paymentVoucher: { findMany: async ({ where }: any) => filterBy(vouchers, where, 'paymentDate') },
    customerReconciliationAck: {
      findFirst: async () => seed.existingAck ?? null,
      findMany: async () => (seed.existingAck ? [seed.existingAck] : []),
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    userAccount: { findMany: async () => seed.users ?? [{ id: 'u1' }, { id: 'u2' }] },
    notification: {
      createMany: async ({ data }: any) => {
        if (seed.notifyThrows) throw new Error('NOTIFY_BOOM');
        notifyCalls.push(...data);
        return { count: data.length };
      },
    },
  };
  return { prisma: db as any, created };
}

beforeEach(() => { notifyCalls.length = 0; });

describe('computePeriodStatement — 对账单（按期间）', () => {
  const seed = {
    invoices: [
      { customerRelationId: 'R1', issueDate: '2026-08-15', amount: '1000', currency: 'USD' }, // 期初
      { customerRelationId: 'R1', issueDate: '2026-09-10', amount: '2000', currency: 'USD' }, // 本期
      { customerRelationId: 'R1', issueDate: '2026-09-20', amount: '5000', currency: 'CNY' }, // 本期（另一币种）
      { customerRelationId: 'R2', issueDate: '2026-09-10', amount: '9999', currency: 'USD' }, // 他客户
    ],
    vouchers: [
      { customerRelationId: 'R1', paymentDate: '2026-08-20', amount: '400', currency: 'USD' }, // 期初
      { customerRelationId: 'R1', paymentDate: '2026-09-15', amount: '600', currency: 'USD' }, // 本期
    ],
  };

  it('期初 / 本期开票 / 本期收款 / 期末余额（按币种）', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.computePeriodStatement('R1', '2026-09-01', '2026-09-30');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const usd = r.data.byCurrency.find(x => x.currency === 'USD')!;
    expect(usd.openingBalance).toBe(600);   // 1000 − 400
    expect(usd.invoiced).toBe(2000);
    expect(usd.received).toBe(600);
    expect(usd.closingBalance).toBe(2000);  // 600 + 2000 − 600
    const cny = r.data.byCurrency.find(x => x.currency === 'CNY')!;
    expect(cny.openingBalance).toBe(0);
    expect(cny.invoiced).toBe(5000);
    expect(cny.closingBalance).toBe(5000);
  });

  it('**按币种分组**（跨币种不合并 —— T7-① 口径）', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.computePeriodStatement('R1', '2026-09-01', '2026-09-30');
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.byCurrency.map(x => x.currency)).toEqual(['CNY', 'USD']);
  });

  it('他客户的数据不混入（归属隔离）', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.computePeriodStatement('R1', '2026-09-01', '2026-09-30');
    if (!r.ok) throw new Error('expected ok');
    const usd = r.data.byCurrency.find(x => x.currency === 'USD')!;
    expect(usd.invoiced).toBe(2000); // 不含 R2 的 9999
  });

  it('期间格式非法 / start > end → 400', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const bad1 = await svc.computePeriodStatement('R1', '2026/09/01', '2026-09-30');
    expect(bad1.ok).toBe(false);
    const bad2 = await svc.computePeriodStatement('R1', '2026-09-30', '2026-09-01');
    expect(bad2.ok).toBe(false);
  });
});

describe('submitAck — 提交回执', () => {
  const seed = {
    invoices: [{ customerRelationId: 'R1', issueDate: '2026-09-10', amount: '2000', currency: 'USD' }],
    vouchers: [],
  };

  it('确认无异议 → 落库 + 冻结快照 + 通知内部', async () => {
    const { prisma, created } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.submitAck({
      relationId: 'R1', customerUserId: 'cu1', customerUserName: 'ACME',
      periodStart: '2026-09-01', periodEnd: '2026-09-30', decision: 'confirmed',
    });
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('confirmed');
    // 快照冻结
    expect(created[0].snapshot.byCurrency).toBeDefined();
    expect(created[0].snapshot.capturedAt).toBeTruthy();
    expect(created[0].disputeNote).toBeNull();
    // 通知内部（每个 active 用户一条）
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[0].type).toBe('customer_reconciliation_ack');
    expect(notifyCalls[0].level).toBe('info');
  });

  it('提异议 → 必须填说明；缺说明 → 400', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const bad = await svc.submitAck({
      relationId: 'R1', periodStart: '2026-09-01', periodEnd: '2026-09-30', decision: 'disputed',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('DISPUTE_NOTE_REQUIRED');

    const good = await svc.submitAck({
      relationId: 'R1', periodStart: '2026-09-01', periodEnd: '2026-09-30',
      decision: 'disputed', disputeNote: '9 月 12 日那笔收款未显示',
    });
    expect(good.ok).toBe(true);
  });

  it('非法 decision → 400', async () => {
    const { prisma } = makePrisma(seed);
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.submitAck({
      relationId: 'R1', periodStart: '2026-09-01', periodEnd: '2026-09-30', decision: 'whatever',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DECISION');
  });

  it('**同期间已有回执 → 409**（防反复提交）', async () => {
    const { prisma, created } = makePrisma({ ...seed, existingAck: { id: 'CRA1', status: 'confirmed', createdAt: BigInt(1) } });
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.submitAck({
      relationId: 'R1', periodStart: '2026-09-01', periodEnd: '2026-09-30', decision: 'confirmed',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ACK_ALREADY_EXISTS');
      expect(r.error.status).toBe(409);
    }
    expect(created).toHaveLength(0);
  });

  it('通知失败**不阻断**回执落库（回执本身是客户的凭证）', async () => {
    const { prisma, created } = makePrisma({ ...seed, notifyThrows: true });
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.submitAck({
      relationId: 'R1', periodStart: '2026-09-01', periodEnd: '2026-09-30', decision: 'confirmed',
    });
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe('listAcks — 历史回执', () => {
  it('返回该客户的回执列表', async () => {
    const { prisma } = makePrisma({ existingAck: { id: 'CRA1', status: 'disputed', createdAt: BigInt(1) } });
    const svc = createCustomerReconciliationAckService(prisma);
    const r = await svc.listAcks('R1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.acks).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 内部侧：跨客户回执列表（H16-② 配套）
// ─────────────────────────────────────────────────────────────────────────

/** 支持 where 匹配的 mock（含 AND 嵌套）—— 否则筛选类断言会**空过** */
function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    const v = where[k];
    if (k === 'AND') { if (!v.every((c: any) => matchWhere(row, c))) return false; continue; }
    if (k === 'OR') { if (!v.some((c: any) => matchWhere(row, c))) return false; continue; }
    if (v === null) { if (row[k] !== null && row[k] !== undefined) return false; continue; }
    if (typeof v === 'object') {
      if ('lte' in v && !(row[k] <= v.lte)) return false;
      if ('gte' in v && !(row[k] >= v.gte)) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function makeAckPrisma(seed: { acks?: any[]; relations?: any[]; relationThrows?: boolean } = {}) {
  const acks = seed.acks ?? [];
  const relations = seed.relations ?? [];
  const db: any = {
    customerReconciliationAck: {
      findMany: async ({ where, orderBy, skip, take }: any = {}) => {
        let rows = acks.filter(a => matchWhere(a, where));
        if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length));
      },
      count: async ({ where }: any = {}) => acks.filter(a => matchWhere(a, where)).length,
    },
    relation: {
      findMany: async ({ where }: any = {}) => {
        if (seed.relationThrows) throw new Error('RELATION_BOOM');
        return relations.filter(r => where?.id?.in?.includes(r.id));
      },
    },
  };
  return db as any;
}

const ACK = (over: any = {}) => ({
  id: 'CRA1', customerRelationId: 'R1', customerUserName: '张三',
  periodStart: '2026-09-01', periodEnd: '2026-09-30', status: 'confirmed',
  snapshot: { byCurrency: [{ currency: 'USD', closingBalance: 100 }] },
  disputeNote: null, ip: '1.2.3.4', createdAt: BigInt(1000), deletedAt: null, ...over,
});

describe('listReconciliationAcks — 内部侧跨客户回执列表', () => {
  it('默认返回全部未软删，按 createdAt 倒序，summary 计数正确', async () => {
    const prisma = makeAckPrisma({
      acks: [
        ACK({ id: 'A1', createdAt: BigInt(1000), status: 'confirmed' }),
        ACK({ id: 'A2', createdAt: BigInt(3000), status: 'disputed', disputeNote: '金额不符' }),
        ACK({ id: 'A3', createdAt: BigInt(2000), status: 'confirmed' }),
        ACK({ id: 'A9', createdAt: BigInt(9000), deletedAt: BigInt(1) }), // 软删
      ],
    });
    const r = await listReconciliationAcks(prisma);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items.map(i => i.id)).toEqual(['A2', 'A3', 'A1']); // 倒序 + 排除软删
    expect(r.data.total).toBe(3);
    expect(r.data.summary).toEqual({ confirmed: 2, disputed: 1, total: 3 });
  });

  it('status=disputed 筛选 items，但 **summary 仍给出 confirmed 数**（不受 status 影响）', async () => {
    const prisma = makeAckPrisma({
      acks: [
        ACK({ id: 'A1', status: 'confirmed' }),
        ACK({ id: 'A2', status: 'confirmed' }),
        ACK({ id: 'A3', status: 'disputed', disputeNote: 'x' }),
      ],
    });
    const r = await listReconciliationAcks(prisma, { status: 'disputed' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items.map(i => i.id)).toEqual(['A3']);
    expect(r.data.total).toBe(1);                       // total 跟 status 走
    expect(r.data.summary.confirmed).toBe(2);           // ← 关键：summary 不跟 status 走
    expect(r.data.summary.disputed).toBe(1);
  });

  it('期间筛选是**区间相交**（不是严格包含）：9 月单用 09-15 起筛仍命中', async () => {
    const prisma = makeAckPrisma({ acks: [ACK({ id: 'SEP', periodStart: '2026-09-01', periodEnd: '2026-09-30' })] });
    const hit = await listReconciliationAcks(prisma, { periodFrom: '2026-09-15' });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.data.items.map(i => i.id)).toEqual(['SEP']);

    const miss = await listReconciliationAcks(prisma, { periodFrom: '2026-10-01' });
    expect(miss.ok).toBe(true);
    if (miss.ok) expect(miss.data.items).toEqual([]);
  });

  it('期间上界相交：用 periodTo 早于期间起 → 不命中', async () => {
    const prisma = makeAckPrisma({ acks: [ACK({ id: 'SEP', periodStart: '2026-09-01', periodEnd: '2026-09-30' })] });
    const r = await listReconciliationAcks(prisma, { periodTo: '2026-08-31' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.items).toEqual([]);
  });

  it('非法 status → 400 INVALID_STATUS', async () => {
    const r = await listReconciliationAcks(makeAckPrisma(), { status: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('INVALID_STATUS'); expect(r.error.status).toBe(400); }
  });

  it('非法日期 / 起晚于止 → 400 INVALID_PERIOD', async () => {
    const bad = await listReconciliationAcks(makeAckPrisma(), { periodFrom: '2026/09/01' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_PERIOD');

    const rev = await listReconciliationAcks(makeAckPrisma(), { periodFrom: '2026-09-30', periodTo: '2026-09-01' });
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.error.code).toBe('INVALID_PERIOD');
  });

  it('补客户名（Relation）；Relation 缺失 → null 不阻断', async () => {
    const prisma = makeAckPrisma({
      acks: [ACK({ id: 'A1', customerRelationId: 'R1' }), ACK({ id: 'A2', customerRelationId: 'R_NO_REL' })],
      relations: [{ id: 'R1', name: 'Acme Trading' }],
    });
    const r = await listReconciliationAcks(prisma);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = Object.fromEntries(r.data.items.map(i => [i.id, i]));
    expect(byId.A1.customerName).toBe('Acme Trading');
    expect(byId.A2.customerName).toBeNull();
  });

  it('Relation 查询抛错 → 列表仍返回（不阻断），客户名为 null', async () => {
    const prisma = makeAckPrisma({ acks: [ACK({ id: 'A1' })], relationThrows: true });
    const r = await listReconciliationAcks(prisma);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.items).toHaveLength(1); expect(r.data.items[0].customerName).toBeNull(); }
  });

  it('分页：offset/limit → page 由 offset 反推；limit 上限 200', async () => {
    const acks = Array.from({ length: 5 }, (_, i) => ACK({ id: `A${i}`, createdAt: BigInt(1000 + i) }));
    const prisma = makeAckPrisma({ acks });
    const r = await listReconciliationAcks(prisma, { limit: 2, offset: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pageSize).toBe(2);
    expect(r.data.page).toBe(2);
    expect(r.data.items.map(i => i.id)).toEqual(['A2', 'A1']); // 倒序后第 3、4 条
    expect(r.data.total).toBe(5);
  });
});
