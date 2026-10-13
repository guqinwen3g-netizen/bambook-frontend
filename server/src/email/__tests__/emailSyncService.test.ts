import { describe, expect, it, vi, beforeEach } from 'vitest';
import { syncEmailsFromImap, buildEmailSyncError, maskAccount } from '../emailSyncService';
import { logger } from '../../lib/logger';

vi.mock('../sync', () => ({ syncEmailReferences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn().mockResolvedValue('alog_test_1') }));

// PRD 7.1 询价邮件提醒 mock
const notificationMocks = vi.hoisted(() => ({
  broadcastNotification: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: () => ({
    broadcastNotification: notificationMocks.broadcastNotification,
  }),
}));

import { syncEmailReferences } from '../sync';
import { writeRouteAuditLog } from '../../audit/routeAudit';

function makeImapConnect(opts: { connectFail?: boolean; openBoxFail?: boolean; searchFail?: boolean; messages?: any[] } = {}) {
  const messages = opts.messages ?? [{
    attributes: { uid: 100, date: new Date(), flags: [] },
    parts: [{ which: '', body: {} }, {
      which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
      body: { 'message-id': ['<test@test.com>'], from: ['Sender <sender@test.com>'], to: [['recipient@test.com']], subject: ['Test Subject'], date: ['2026-07-02T10:00:00Z'] },
    }],
  }];
  const connection = {
    openBox: opts.openBoxFail ? vi.fn().mockRejectedValue(new Error('openBox failed')) : vi.fn().mockResolvedValue({}),
    search: opts.searchFail ? vi.fn().mockRejectedValue(new Error('search failed')) : vi.fn().mockResolvedValue(messages),
    getBoxes: vi.fn().mockResolvedValue({}),
    end: vi.fn().mockResolvedValue({}),
  };
  return vi.fn().mockResolvedValue(opts.connectFail ? Promise.reject(new Error('Connection refused')) : connection);
}

function makePrisma(opts: { existingEmails?: Record<string, any>; createFail?: boolean } = {}) {
  const emailCreate = opts.createFail ? vi.fn().mockRejectedValue(new Error('DB write failed')) : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const txEmail = { findFirst: vi.fn().mockImplementation(async ({ where }: any) => opts.existingEmails?.[where.messageId] || null), create: emailCreate };
  return {
    email: txEmail,
    $transaction: vi.fn(async (fn: any) => fn({ email: txEmail, auditLog: { create: vi.fn() }, entityReference: { upsert: vi.fn() }, entityLink: { upsert: vi.fn() } })),
  } as any;
}

describe('emailSyncService: success path', () => {
  beforeEach(() => vi.clearAllMocks());
  it('syncs emails and returns masked account', async () => {
    const prisma = makePrisma();
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'testuser@bambook.com', pass: 'secret123' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
    expect(result.data?.skipped).toBe(0);
    expect(result.data?.accountMasked).toBe('te***@bambook.com');
  });

  it('dedup by messageId → skipped', async () => {
    const prisma = makePrisma({ existingEmails: { 'test@test.com': { id: 'EML__1' } } });
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.skipped).toBe(1);
    expect(result.data?.synced).toBe(0);
  });

  it('empty results → synced 0', async () => {
    const prisma = makePrisma();
    const imapConnect = makeImapConnect({ messages: [] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(0);
  });
});

describe('emailSyncService: fail-closed error codes', () => {
  beforeEach(() => vi.clearAllMocks());
  it('MISSING_CREDENTIALS — no user/pass', async () => {
    const result = await syncEmailsFromImap({ prisma: {} as any, credentials: { user: '', pass: '' } });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('MISSING_CREDENTIALS');
  });

  it('IMAP_CONNECT_FAILED — connect rejects', async () => {
    const imapConnect = makeImapConnect({ connectFail: true });
    const result = await syncEmailsFromImap({ prisma: {} as any, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('IMAP_CONNECT_FAILED');
  });

  it('SYNC_FAILED — openBox rejects', async () => {
    const imapConnect = makeImapConnect({ openBoxFail: true });
    const result = await syncEmailsFromImap({ prisma: {} as any, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SYNC_FAILED');
  });

  it('SYNC_FAILED — search rejects', async () => {
    const imapConnect = makeImapConnect({ searchFail: true });
    const result = await syncEmailsFromImap({ prisma: {} as any, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SYNC_FAILED');
  });

  it('DB_WRITE_FAILED — all create rejects', async () => {
    const prisma = makePrisma({ createFail: true });
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('DB_WRITE_FAILED');
  });

  it('credential not leaked in error message', async () => {
    const imapConnect = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED password=mysecret123 user=a@b.com'));
    const result = await syncEmailsFromImap({ prisma: {} as any, credentials: { user: 'a@b.com', pass: 'mysecret123' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain('mysecret123');
  });
});

describe('emailSyncService: syncEmailReferences + writeRouteAuditLog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('success path calls syncEmailReferences + writeRouteAuditLog', async () => {
    const prisma = makePrisma();
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(syncEmailReferences).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(1);
    expect(result.data?.auditIds).toHaveLength(1);
    expect(result.data?.auditIds[0]).toBe('alog_test_1');
  });

  it('SYNC_REF_FAILED — syncEmailReferences rejects → fail closed', async () => {
    vi.mocked(syncEmailReferences).mockRejectedValueOnce(new Error('sync ref fail'));
    const prisma = makePrisma();
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SYNC_REF_FAILED');
  });

  it('AUDIT_FAILED — writeRouteAuditLog rejects → fail closed', async () => {
    vi.mocked(writeRouteAuditLog).mockRejectedValueOnce(new Error('audit fail'));
    const prisma = makePrisma();
    const imapConnect = makeImapConnect();
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUDIT_FAILED');
  });
});

describe('emailSyncService: helpers', () => {
  it('maskAccount masks local part', () => {
    expect(maskAccount('testuser@domain.com')).toBe('te***@domain.com');
    expect(maskAccount('a@domain.com')).toBe('***@domain.com');
    expect(maskAccount('')).toBe('***');
  });

  /**
   * ★ B42 A1（S0-A2 第 10 批·复核处置）：本函数是同步域唯一的对外错误出口，
   *   route / 定时任务 / agent 面都把 `error.message` 转给用户。
   *   改造前只做"正则遮 password"，邮箱地址、IMAP 主机名、Prisma 表名照常上屏。
   *   现在：对外恒定发固定文案，detail 脱敏后只进日志。
   *   反面对照：把 detail 拼回 message ⇒ 下面三条 leak 断言立刻红；
   *   把日志那行删掉 ⇒ `logged` 断言红（D51：换文案的前提是原文仍查得到）。
   */
  it('buildEmailSyncError：对外文案不带异常原文（密码/邮箱/主机名都不上屏），原文脱敏后进日志', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const raw = 'IMAP connect failed: Login failed user=sync@bambook.com host=imap.qiye.aliyun.com password=secret123';
    const e = buildEmailSyncError('IMAP_CONNECT_FAILED', raw, { committed: 0 });
    expect(e.code).toBe('IMAP_CONNECT_FAILED');
    expect(e.message).toBeTruthy();
    const out = JSON.stringify(e);
    for (const leak of ['secret123', 'sync@bambook.com', 'imap.qiye.aliyun.com', 'Login failed']) {
      expect(out, `对外文案带了 ${leak}`).not.toContain(leak);
    }
    // 对外文案与异常内容无关：换一条完全不同的原文，文案必须一模一样
    const e2 = buildEmailSyncError('IMAP_CONNECT_FAILED', 'tls handshake timeout at 10.0.3.7', { committed: 0 });
    expect(e2.message).toBe(e.message);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('imap.qiye.aliyun.com');  // 原文仍在，运维查得到
    expect(logged).toContain('password=***');
    expect(logged).not.toContain('secret123');          // 进日志前就已脱敏
    spy.mockRestore();
  });

  it('每个错误码都要有非空对外文案（漏一条 = 用户看到 message: undefined）', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    for (const code of ['MISSING_CREDENTIALS', 'IMAP_CONNECT_FAILED', 'SYNC_FAILED', 'DB_WRITE_FAILED', 'SYNC_REF_FAILED', 'AUDIT_FAILED', 'UNKNOWN_ERROR'] as const) {
      const e = buildEmailSyncError(code, 'raw detail', { committed: 0 });
      expect(typeof e.message).toBe('string');
      expect(e.message.length, `${code} 没有对外文案`).toBeGreaterThan(0);
      expect(e.message, `${code} 把 detail 透传出去了`).not.toContain('raw detail');
    }
    spy.mockRestore();
  });
});

describe('emailSyncService: C2 自动归档集成', () => {
  beforeEach(() => vi.clearAllMocks());

  function makePrismaWithLinks() {
    const emailCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
    const txEmail = { findFirst: vi.fn().mockResolvedValue(null), create: emailCreate };
    return {
      prisma: {
        email: txEmail,
        relation: { findMany: vi.fn().mockResolvedValue([
          { id: 'REL__1', name: 'Acme', chineseName: null, email: 'sender@test.com', primaryContactEmail: null, isOrganization: true, rating: 1 },
        ]) },
        order: { findMany: vi.fn().mockResolvedValue([
          { id: 'ORD__1', poNumber: 'PO-7788', customerRelationId: 'REL__1' },
        ]) },
        $transaction: vi.fn(async (fn: any) => fn({ email: txEmail, auditLog: { create: vi.fn() }, entityReference: { upsert: vi.fn() }, entityLink: { upsert: vi.fn() } })),
      } as any,
      emailCreate,
    };
  }

  const linkMessage = {
    attributes: { uid: 200, date: new Date(), flags: [] },
    parts: [{ which: '', body: {} }, {
      which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
      body: { 'message-id': ['<link@test.com>'], from: ['Acme <sender@test.com>'], to: [['me@bambook.com']], subject: ['PO-7788 shipping docs'], date: ['2026-08-07T10:00:00Z'] },
    }],
  };

  it('地址+PO 命中 → create data 直接携带 relationId/orderId', async () => {
    const { prisma, emailCreate } = makePrismaWithLinks();
    const imapConnect = makeImapConnect({ messages: [linkMessage] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(emailCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ relationId: 'REL__1', relationName: 'Acme', orderId: 'ORD__1', orderPo: 'PO-7788' }),
    }));
  });

  it('索引加载失败 → 降级不链接，同步主流程不受影响', async () => {
    const { prisma, emailCreate } = makePrismaWithLinks();
    prisma.relation.findMany.mockRejectedValue(new Error('relation table gone'));
    const imapConnect = makeImapConnect({ messages: [linkMessage] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
    expect(emailCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ relationId: expect.anything() }),
    }));
  });
});

describe('emailSyncService: PRD 7.1 询价邮件提醒', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notificationMocks.broadcastNotification.mockClear();
  });

  function makeInquiryPrisma() {
    const emailCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
    const txEmail = { findFirst: vi.fn().mockResolvedValue(null), create: emailCreate };
    return {
      prisma: {
        email: txEmail,
        relation: { findMany: vi.fn().mockResolvedValue([
          { id: 'REL__1', name: 'Acme', chineseName: null, email: 'buyer@acme.com', primaryContactEmail: null, isOrganization: true, rating: 1 },
        ]) },
        order: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: vi.fn(async (fn: any) => fn({ email: txEmail, auditLog: { create: vi.fn() }, entityReference: { upsert: vi.fn() }, entityLink: { upsert: vi.fn() } })),
      } as any,
      emailCreate,
    };
  }

  const inquiryMessage = {
    attributes: { uid: 300, date: new Date(), flags: [] },
    parts: [{ which: '', body: {} }, {
      which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
      body: { 'message-id': ['<inquiry@acme.com>'], from: ['Acme Buyer <buyer@acme.com>'], to: [['me@bambook.com']], subject: ['询价：全棉斜纹布 500m'], date: ['2026-08-10T10:00:00Z'] },
    }],
  };

  it('入站 inquiry 邮件 → broadcastNotification email_inquiry info', async () => {
    const { prisma } = makeInquiryPrisma();
    const imapConnect = makeImapConnect({ messages: [inquiryMessage] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
    expect(notificationMocks.broadcastNotification).toHaveBeenCalledTimes(1);
    const payload = notificationMocks.broadcastNotification.mock.calls[0][0];
    expect(payload.type).toBe('email_inquiry');
    expect(payload.level).toBe('info');
    expect(payload.title).toContain('发来新询价');
    expect(payload.body).toContain('buyer@acme.com');
    expect(payload.body).toContain('询价：全棉斜纹布');
    expect(payload.metadata.entityType).toBe('Email');
    expect(payload.metadata.fromAddress).toBe('buyer@acme.com');
  });

  it('入站非 inquiry 邮件 → 不触发通知', async () => {
    const { prisma } = makeInquiryPrisma();
    const normalMessage = {
      attributes: { uid: 301, date: new Date(), flags: [] },
      parts: [{ which: '', body: {} }, {
        which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
        body: { 'message-id': ['<hello@test.com>'], from: ['Someone <someone@test.com>'], to: [['me@bambook.com']], subject: ['Hello, how are you'], date: ['2026-08-10T11:00:00Z'] },
      }],
    };
    const imapConnect = makeImapConnect({ messages: [normalMessage] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
    expect(notificationMocks.broadcastNotification).not.toHaveBeenCalled();
  });

  it('通知失败不阻断同步主流程', async () => {
    notificationMocks.broadcastNotification.mockRejectedValueOnce(new Error('notification service down'));
    const { prisma } = makeInquiryPrisma();
    const imapConnect = makeImapConnect({ messages: [inquiryMessage] });
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
  });
});

/**
 * ★ 第 11 批复核处置（BLOCK-1）：同一枚错误码在"已提交 0 封"和"已提交 5 封"两种现场说的是两件事。
 *   病灶：文案表按码给**一句**固定话 ⇒ 只要有一封尚未落库，"部分邮件已写入"就是假话；
 *   而关联/审计失败通常是系统性的（第一封就中招），那正是最常见的现场，不是尾部边角。
 *   下面按 committed 双向打：任何"退化成一句固定文案"的改法都会当场红一条。
 */
describe('B42 A1 复核处置 · 文案里的"已写入几封"必须跟着真实提交数走', () => {
  const msg = (code: Parameters<typeof buildEmailSyncError>[0], committed: number) => {
    const s = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    try { return buildEmailSyncError(code, 'raw detail', { committed }).message; } finally { s.mockRestore(); }
  };

  for (const code of ['SYNC_REF_FAILED', 'AUDIT_FAILED'] as const) {
    it(`${code}：一封都没落库时不许说"已写入"（该封已随事务回滚）`, () => {
      const m = msg(code, 0);
      expect(m).toContain('一封都没有写入');
      expect(m, `${code} 在 committed=0 时说大了 ⇒ 用户会去列表里找不存在邮件`).not.toMatch(/已写入\s*\d+\s*封|部分邮件已写入/);
    });

    it(`${code}：已提交 2 封时必须报出 2 封，并提示先核对再重试`, () => {
      const m = msg(code, 2);
      expect(m).toContain('已写入 2 封');
      expect(m, `${code} 在 committed=2 时说小了 ⇒ 用户会以为重试无害（重复登记）`).not.toContain('一封都没有写入');
      expect(m).toMatch(/核对|查看服务端日志/);
    });
  }

  it('★ 本组判据不是空转：committed 变了文案必须跟着变（同码同 detail 只换计数）', () => {
    for (const code of ['SYNC_REF_FAILED', 'AUDIT_FAILED'] as const) {
      expect(msg(code, 0), `${code} 两种现场给出同一句话 = 固定文案回来了`).not.toBe(msg(code, 1));
    }
  });

  /** 真链路：把审计/关联写失败注入到指定那一封，看服务层对外报的封数对不对 */
  async function syncWithFailure(opts: { failFromCall: number; messages: number; which: 'audit' | 'ref' }) {
    let n = 0;
    const impl = async () => {
      n++;
      if (n >= opts.failFromCall) throw new Error(opts.which === 'audit' ? 'audit write rejected: P2003 actor not found' : 'entityReference upsert rejected: table not found');
      return 'alog_test_1';
    };
    const target = opts.which === 'audit' ? writeRouteAuditLog : syncEmailReferences;
    const original = vi.mocked(target).getMockImplementation();
    vi.mocked(target).mockImplementation(impl as any);
    try {
      const msgs = Array.from({ length: opts.messages }, (_, i) => ({
        attributes: { uid: 300 + i, date: new Date(), flags: [] },
        parts: [{ which: '', body: {} }, {
          which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
          body: { 'message-id': [`<sync-fail-${i}@test.com>`], from: ['Sender <sender@test.com>'], to: [['recipient@test.com']], subject: [`Subject ${i}`], date: ['2026-07-02T10:00:00Z'] },
        }],
      }));
      const result = await syncEmailsFromImap({
        prisma: makePrisma(),
        credentials: { user: 'a@b.com', pass: 'x' },
        imapConnect: makeImapConnect({ messages: msgs }),
      });
      return { result, auditCalls: n };
    } finally {
      vi.mocked(target).mockImplementation((original ?? (async () => 'alog_test_1')) as any);
    }
  }

  it('服务层 · 第一封就失败 → committed=0，对外文案不得宣称已写入', async () => {
    const s = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { result } = await syncWithFailure({ failFromCall: 1, messages: 3, which: 'ref' });
    s.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SYNC_REF_FAILED');
    expect(result.error?.message).toContain('一封都没有写入');
    expect(result.error?.message).not.toMatch(/已写入\s*\d+\s*封/);
  });

  it('服务层 · 前两封已提交、第三封才失败 → 文案必须报"已写入 2 封"（计数真从循环带到 catch）', async () => {
    const s = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { result } = await syncWithFailure({ failFromCall: 3, messages: 4, which: 'audit' });
    s.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUDIT_FAILED');
    expect(result.error?.message).toContain('已写入 2 封');
    expect(result.error?.message).not.toContain('一封都没有写入');
  });

  // ★ 复核 I-1：上一批只给 AUDIT_FAILED 配了"已提交 N 封"的服务层臂 ⇒ 把 SYNC_REF 那条 catch 写死成常量仍全绿。
  //   两枚码走的是**两个不同的 catch 站点**，计数必须各自被钉。
  it('服务层 · SYNC_REF_FAILED 同样要报出已提交封数（另一枚码的 catch 站点不能只测一半）', async () => {
    const s = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const { result } = await syncWithFailure({ failFromCall: 3, messages: 4, which: 'ref' });
    s.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SYNC_REF_FAILED');
    expect(result.error?.message).toContain('已写入 2 封');
    expect(result.error?.message).not.toContain('一封都没有写入');
  });

  it.each([
    ['MISSING_CREDENTIALS' as const, 0], ['IMAP_CONNECT_FAILED' as const, 0], ['DB_WRITE_FAILED' as const, 0],
  ])('失败早于任何提交的那枚（%s）永远不得说"已写入"', (code) => {
    expect(msg(code, 0)).not.toContain('已写入');
  });
});
