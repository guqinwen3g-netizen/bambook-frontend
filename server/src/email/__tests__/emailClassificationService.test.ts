import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyEmailByRules,
  labelsFromExtraction,
  computeEmailLabels,
  applyEmailClassification,
  backfillEmailClassification,
} from '../emailClassificationService';

// ─── 纯函数：规则分类 ─────────────────────────────────────────────

describe('C8 · classifyEmailByRules 规则层', () => {
  const base = { direction: 'inbound', fromAddress: 'buyer@acme.com', subject: '', snippet: null, relationId: null };

  it('noreply/营销发件人 → bulk', () => {
    expect(classifyEmailByRules({ ...base, fromAddress: 'noreply@news.example.com' })).toContain('bulk');
    expect(classifyEmailByRules({ ...base, fromAddress: 'newsletter@shop.com' })).toContain('bulk');
    expect(classifyEmailByRules({ ...base, subject: 'Weekly newsletter - unsubscribe' })).toContain('bulk');
  });

  it('主题关键词双语命中：invoice/发票/付款、报价、订单、出运、投诉', () => {
    expect(classifyEmailByRules({ ...base, subject: 'Invoice INV-2026-001 payment' })).toContain('invoice');
    expect(classifyEmailByRules({ ...base, subject: '请查收8月对账单' })).toContain('invoice');
    expect(classifyEmailByRules({ ...base, subject: 'Quotation for cotton fabric' })).toContain('quotation');
    expect(classifyEmailByRules({ ...base, subject: '询盘：全棉斜纹布' })).toContain('inquiry');
    expect(classifyEmailByRules({ ...base, subject: 'PO#4582 order confirmation' })).toContain('order');
    expect(classifyEmailByRules({ ...base, subject: '发货通知 Shipment advice' })).toContain('shipment_notice');
    expect(classifyEmailByRules({ ...base, subject: 'Quality complaint on lot 331' })).toContain('complaint');
  });

  it('已归档客户 → customer 标签', () => {
    expect(classifyEmailByRules({ ...base, relationId: 'REL_1' })).toContain('customer');
  });

  it('普通商务邮件 → 空标签', () => {
    expect(classifyEmailByRules({ ...base, subject: 'Hello' })).toEqual([]);
  });
});

describe('C8 · labelsFromExtraction AI 增强层', () => {
  it('intent 非 other → 对应标签；urgent/risk 信号 → 升级标签', () => {
    expect(labelsFromExtraction({ intent: 'inquiry', customerSignal: 'neutral' } as any)).toEqual(['inquiry']);
    const labels = labelsFromExtraction({ intent: 'complaint', customerSignal: 'urgent' } as any);
    expect(labels).toContain('complaint');
    expect(labels).toContain('urgent');
    expect(labelsFromExtraction({ intent: 'other', customerSignal: 'risk' } as any)).toEqual(['risk']);
  });

  it('空抽取 → 空数组', () => {
    expect(labelsFromExtraction(null)).toEqual([]);
    expect(labelsFromExtraction(undefined)).toEqual([]);
  });
});

describe('C8 · computeEmailLabels 并集语义', () => {
  it('只增不删：用户已有标签保留，候选去重', () => {
    const { add, all } = computeEmailLabels({
      direction: 'inbound', fromAddress: 'a@b.com', subject: 'Complaint: defective fabric', snippet: null,
      relationId: 'REL_1', labels: ['vip', 'complaint'],
    });
    expect(add).not.toContain('complaint'); // 已有不重复
    expect(add).toContain('urgent'); // complaint 升级
    expect(add).toContain('customer');
    expect(all).toContain('vip'); // 用户标签保留
  });
});

// ─── 服务层：应用与批量（mock prisma） ────────────────────────────

function makeMockPrisma(rows: any[] = []) {
  const store = rows.map(r => ({ deletedAt: null, labels: [], ...r }));
  const auditLogs: any[] = [];
  const prisma: any = {
    email: {
      findUnique: async ({ where }: any) => store.find(r => r.id === where.id) || null,
      findMany: async ({ where, take }: any = {}) => {
        let out = store.filter(r => r.deletedAt === null);
        if (where?.labels?.isEmpty) out = out.filter(r => !r.labels || r.labels.length === 0);
        if (where?.mailbox) out = out.filter(r => r.mailbox === where.mailbox);
        return out.slice(0, take ?? 50);
      },
      update: async ({ where, data }: any) => {
        const row = store.find(r => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => { auditLogs.push(data); return { id: data.id }; },
    },
    _store: store,
    _auditLogs: auditLogs,
  };
  return prisma;
}

describe('C8 · applyEmailClassification', () => {
  it('规则命中 → 写 labels + 审计；二次调用幂等无写', async () => {
    const prisma = makeMockPrisma([
      { id: 'EML__1', fromAddress: 'buyer@acme.com', subject: 'Complaint about lot 9', relationId: 'REL_1', aiExtractedJson: null },
    ]);
    const r1 = await applyEmailClassification(prisma, 'EML__1', { actorId: 'u1', source: 'test', withAi: false });
    expect('error' in r1).toBe(false);
    if ('error' in r1) return;
    expect(r1.changed).toBe(true);
    expect(r1.labels).toContain('complaint');
    expect(r1.labels).toContain('urgent');
    expect(r1.labels).toContain('customer');
    expect(prisma._auditLogs).toHaveLength(1);

    const r2 = await applyEmailClassification(prisma, 'EML__1', { actorId: 'u1', source: 'test', withAi: false });
    if ('error' in r2) throw new Error('unexpected');
    expect(r2.changed).toBe(false);
    expect(prisma._auditLogs).toHaveLength(1); // 无新审计
  });

  it('保留用户手工标签（并集）', async () => {
    const prisma = makeMockPrisma([
      { id: 'EML__2', fromAddress: 'a@b.com', subject: 'Invoice due', labels: ['important-client'], relationId: null },
    ]);
    const r = await applyEmailClassification(prisma, 'EML__2', { actorId: 'u1', source: 'test', withAi: false });
    if ('error' in r) throw new Error('unexpected');
    expect(r.labels).toContain('important-client');
    expect(r.labels).toContain('invoice');
  });

  it('withAi=true 且未抽取 → 先 AI 抽取再分类（mock LLM）', async () => {
    const prisma = makeMockPrisma([
      { id: 'EML__3', fromAddress: 'buyer@acme.com', subject: 'Hello', bodyText: 'We need 500m cotton', relationId: 'REL_1', aiExtractedJson: null },
    ]);
    const llm = async () => JSON.stringify({ intent: 'inquiry', customerSignal: 'positive', summary: '询价 500m' });
    const r = await applyEmailClassification(prisma, 'EML__3', { actorId: 'u1', source: 'test', withAi: true, llm });
    if ('error' in r) throw new Error('unexpected');
    expect(r.labels).toContain('inquiry');
    expect(r.labels).toContain('customer');
    const row = prisma._store.find((x: any) => x.id === 'EML__3');
    expect(row.aiExtractedJson.intent).toBe('inquiry');
  });

  it('邮件不存在 → NOT_FOUND', async () => {
    const prisma = makeMockPrisma([]);
    const r = await applyEmailClassification(prisma, 'EML__X', { actorId: 'u1', source: 'test', withAi: false });
    expect(r).toEqual({ error: 'NOT_FOUND' });
  });
});

describe('C8 · backfillEmailClassification', () => {
  it('仅扫描空标签邮件；投诉+客户链接进入 followUpEmails', async () => {
    const prisma = makeMockPrisma([
      { id: 'EML__A', fromAddress: 'x@y.com', subject: 'Complaint!', relationId: 'REL_1' },
      { id: 'EML__B', fromAddress: 'x@y.com', subject: 'Invoice 123', relationId: null },
      { id: 'EML__C', fromAddress: 'x@y.com', subject: 'Hi', labels: ['done'] }, // 已有标签跳过
    ]);
    const r = await backfillEmailClassification(prisma, { actorId: 'u1' });
    expect(r.scanned).toBe(2);
    expect(r.classified).toBe(2);
    expect(r.followUpEmails).toEqual(['EML__A']);
  });
});
