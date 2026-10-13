import { describe, expect, it } from 'vitest';
import {
  createFollowUpFromEmail,
  autoFollowUpForClassifiedEmail,
  earliestDeadline,
  emailFollowUpMarker,
} from '../emailFollowUpService';

function makeMockPrisma(emailRows: any[] = []) {
  const emails = emailRows.map(r => ({ deletedAt: null, labels: [], ...r }));
  const followUps: any[] = [];
  const auditLogs: any[] = [];
  let seq = 0;
  const prisma: any = {
    email: {
      findUnique: async ({ where }: any) => emails.find(r => r.id === where.id) || null,
    },
    followUpRecord: {
      findFirst: async ({ where }: any) =>
        followUps.find(r =>
          r.deletedAt === null &&
          (!where?.notes?.contains || String(r.notes || '').includes(where.notes.contains)),
        ) || null,
      create: async ({ data }: any) => {
        const row = { deletedAt: null, ...data, id: data.id || `FU_T${++seq}` };
        followUps.push(row);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => { auditLogs.push(data); return { id: data.id }; },
    },
    _followUps: followUps,
    _auditLogs: auditLogs,
  };
  return prisma;
}

describe('C8 · earliestDeadline', () => {
  it('取最早合法日期，过滤非法格式', () => {
    expect(earliestDeadline({ deadlines: [
      { purpose: 'x', date: '2026-09-01' },
      { purpose: 'y', date: 'next week' },
      { purpose: 'z', date: '2026-08-15' },
    ] } as any)).toBe('2026-08-15');
    expect(earliestDeadline({ deadlines: [] } as any)).toBeNull();
    expect(earliestDeadline(null)).toBeNull();
  });
});

describe('C8 · createFollowUpFromEmail', () => {
  const emailBase = {
    id: 'EML__1', subject: 'Complaint: fabric defects', relationId: 'REL_1', orderId: 'ORD_1',
    aiExtractedJson: {
      intent: 'complaint', customerSignal: 'urgent', summary: '客户投诉面料疵点，要求周五前答复',
      deadlines: [{ purpose: '答复', date: '2026-08-14' }], actionItems: ['安排验货并回复客户'],
    },
  };

  it('从邮件创建跟进：AI 摘要/最早 deadline/行动项自动带入', async () => {
    const prisma = makeMockPrisma([emailBase]);
    const r = await createFollowUpFromEmail(prisma, 'EML__1', { actorId: 'u1', source: 'test' });
    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.nextFollowUpAt).toBe('2026-08-14');
    const fu = prisma._followUps[0];
    expect(fu.relationId).toBe('REL_1');
    expect(fu.orderId).toBe('ORD_1');
    expect(fu.type).toBe('Email');
    expect(fu.content).toBe('客户投诉面料疵点，要求周五前答复');
    expect(fu.nextFollowUpTopic).toBe('安排验货并回复客户');
    expect(fu.notes).toContain(emailFollowUpMarker('EML__1'));
    expect(prisma._auditLogs).toHaveLength(1);
  });

  it('幂等：同邮件二次调用复用已建记录，不重复创建', async () => {
    const prisma = makeMockPrisma([emailBase]);
    const r1 = await createFollowUpFromEmail(prisma, 'EML__1', { actorId: 'u1', source: 'test' });
    const r2 = await createFollowUpFromEmail(prisma, 'EML__1', { actorId: 'u1', source: 'test' });
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(true);
    expect(r2.followUpId).toBe(r1.followUpId);
    expect(prisma._followUps).toHaveLength(1);
    expect(prisma._auditLogs).toHaveLength(1); // 复用不写审计
  });

  it('无客户链接 → NO_RELATION；邮件不存在 → NOT_FOUND', async () => {
    const prisma = makeMockPrisma([{ id: 'EML__2', subject: 'Hi', relationId: null }]);
    const noRel = await createFollowUpFromEmail(prisma, 'EML__2', { actorId: 'u1', source: 'test' });
    expect(noRel).toMatchObject({ ok: false, error: 'NO_RELATION' });
    const notFound = await createFollowUpFromEmail(prisma, 'EML__X', { actorId: 'u1', source: 'test' });
    expect(notFound).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  it('overrides 优先于 AI 推导；无 AI 时默认明天跟进', async () => {
    const prisma = makeMockPrisma([{ id: 'EML__3', subject: 'Re: price', relationId: 'REL_2', aiExtractedJson: null }]);
    const r = await createFollowUpFromEmail(prisma, 'EML__3', {
      actorId: 'u1', source: 'test',
      overrides: { content: '手动内容', nextFollowUpAt: '2026-08-20', nextFollowUpTopic: '确认报价' },
    });
    expect(r.ok).toBe(true);
    const fu = prisma._followUps[0];
    expect(fu.content).toBe('手动内容');
    expect(fu.nextFollowUpAt).toBe('2026-08-20');
    expect(fu.nextFollowUpTopic).toBe('确认报价');

    const prisma2 = makeMockPrisma([{ id: 'EML__4', subject: 'Re: price', relationId: 'REL_2', aiExtractedJson: null }]);
    const r2 = await createFollowUpFromEmail(prisma2, 'EML__4', { actorId: 'u1', source: 'test' });
    expect(r2.ok).toBe(true);
    expect(r2.nextFollowUpAt).toMatch(/^\d{4}-\d{2}-\d{2}$/); // 默认明天
  });
});

describe('C8 · autoFollowUpForClassifiedEmail 分类联动', () => {
  const email = { id: 'EML__9', subject: 'Complaint', relationId: 'REL_1', aiExtractedJson: null };

  it('complaint/urgent 标签触发；其他标签不触发', async () => {
    const prisma = makeMockPrisma([email]);
    const hit = await autoFollowUpForClassifiedEmail(prisma, 'EML__9', ['complaint', 'urgent'], { actorId: 'u1', source: 'test' });
    expect(hit.created).toBe(true);
    // 幂等：再次触发不重复建
    const again = await autoFollowUpForClassifiedEmail(prisma, 'EML__9', ['urgent'], { actorId: 'u1', source: 'test' });
    expect(again.created).toBe(false);

    const prisma2 = makeMockPrisma([email]);
    const miss = await autoFollowUpForClassifiedEmail(prisma2, 'EML__9', ['inquiry'], { actorId: 'u1', source: 'test' });
    expect(miss.created).toBe(false);
    expect(prisma2._followUps).toHaveLength(0);
  });
});
