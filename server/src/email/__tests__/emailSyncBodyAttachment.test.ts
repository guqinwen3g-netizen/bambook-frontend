import { describe, expect, it, vi, beforeEach } from 'vitest';
import { syncEmailsFromImap } from '../emailSyncService';

/**
 * 批次 L（L3/L4）— emailSyncService 正文入库 + 附件记录
 *
 * L4：同步时 simpleParser 解析完整邮件源，bodyText/bodyHtml 落库，snippet 取正文前 200 字。
 * L3：同步时创建 EmailAttachment 记录（元数据入库 + 内容经 saveAttachment 落盘）。
 */

vi.mock('../sync', () => ({ syncEmailReferences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn().mockResolvedValue('alog_test_1') }));
vi.mock('../../notifications/notificationService', () => ({
  createNotificationService: () => ({ broadcastNotification: vi.fn().mockResolvedValue({ count: 1 }) }),
}));

const RAW_MESSAGE = [
  'From: Sender <sender@test.com>',
  'To: me@bambook.com',
  'Subject: Test With Attachment',
  'Date: Mon, 10 Aug 2026 10:00:00 +0000',
  'Message-ID: <att@test.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello this is the quoted body text.',
  '',
  '--BOUND',
  'Content-Type: application/pdf; name="quote.pdf"',
  'Content-Disposition: attachment; filename="quote.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'UE5HL0ZJTEU=',
  '',
  '--BOUND--',
].join('\r\n');

const RAW_MESSAGE_INLINE = [
  'From: Sender <sender@test.com>',
  'To: me@bambook.com',
  'Subject: Inline Image Mail',
  'Date: Mon, 10 Aug 2026 11:00:00 +0000',
  'Message-ID: <inline@test.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND2"',
  '',
  '--BOUND2',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body with inline image.',
  '',
  '--BOUND2',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Id: <logo123>',
  'Content-Transfer-Encoding: base64',
  '',
  'aVBORw0KGgo=',
  '',
  '--BOUND2--',
].join('\r\n');

function makeImapConnect(messages: any[]) {
  const connection = {
    openBox: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue(messages),
    getBoxes: vi.fn().mockResolvedValue({}),
    end: vi.fn().mockResolvedValue({}),
  };
  return vi.fn().mockResolvedValue(connection);
}

function makeMessage(uid: number, raw: unknown, headers: Record<string, any>) {
  return {
    attributes: { uid, date: new Date(), flags: [] },
    parts: [
      { which: '', body: raw },
      {
        which: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)',
        body: headers,
      },
    ],
  };
}

function makePrisma() {
  const emailCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const attachmentCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const txEmail = { findFirst: vi.fn().mockResolvedValue(null), create: emailCreate };
  const tx = {
    email: txEmail,
    emailAttachment: { create: attachmentCreate },
    auditLog: { create: vi.fn() },
    entityReference: { upsert: vi.fn() },
    entityLink: { upsert: vi.fn() },
  };
  const prisma = {
    email: txEmail,
    relation: { findMany: vi.fn().mockResolvedValue([]) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  } as any;
  return { prisma, emailCreate, attachmentCreate };
}

describe('L4：AI 抽取正文入库（bodyText）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('同步时解析完整邮件源 → bodyText/bodyHtml 落库，snippet 取正文前 200 字', async () => {
    const { prisma, emailCreate } = makePrisma();
    const imapConnect = makeImapConnect([
      makeMessage(500, RAW_MESSAGE, {
        'message-id': ['<att@test.com>'], from: ['Sender <sender@test.com>'], to: [['me@bambook.com']],
        subject: ['Test With Attachment'], date: ['2026-08-10T10:00:00Z'],
      }),
    ]);
    const result = await syncEmailsFromImap({
      prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect,
      saveAttachment: () => 'uploads/email-attachments/stub.pdf',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);

    const createData = emailCreate.mock.calls[0][0].data;
    expect(createData.bodyText).toContain('Hello this is the quoted body text.');
    expect(createData.snippet).toContain('Hello this is the quoted body text.');
    // 不再是无正文硬编码
    expect(createData.bodyText).not.toBe('');
  });

  it('完整邮件源不可用（header-only）→ 降级：bodyText 为空、snippet 维持 subject 口径', async () => {
    const { prisma, emailCreate } = makePrisma();
    const imapConnect = makeImapConnect([
      makeMessage(501, {}, {
        'message-id': ['<hdr@test.com>'], from: ['Sender <sender@test.com>'], to: [['me@bambook.com']],
        subject: ['Header Only Subject'], date: ['2026-08-10T10:00:00Z'],
      }),
    ]);
    const result = await syncEmailsFromImap({ prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect });
    expect(result.ok).toBe(true);
    const createData = emailCreate.mock.calls[0][0].data;
    expect(createData.bodyText).toBe('');
    expect(createData.snippet).toBe('Header Only Subject');
    expect(createData.hasAttachments).toBe(false);
    expect(createData.attachmentCount).toBe(0);
  });
});

describe('L3：同步时创建附件记录', () => {
  beforeEach(() => vi.clearAllMocks());

  it('非内嵌附件 → EmailAttachment 记录 + 内容落盘（saveAttachment）+ hasAttachments/attachmentCount', async () => {
    const { prisma, emailCreate, attachmentCreate } = makePrisma();
    const saveAttachment = vi.fn().mockReturnValue('uploads/email-attachments/EML__x_quote.pdf');
    const imapConnect = makeImapConnect([
      makeMessage(500, RAW_MESSAGE, {
        'message-id': ['<att@test.com>'], from: ['Sender <sender@test.com>'], to: [['me@bambook.com']],
        subject: ['Test With Attachment'], date: ['2026-08-10T10:00:00Z'],
      }),
    ]);
    const result = await syncEmailsFromImap({
      prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect, saveAttachment,
    });
    expect(result.ok).toBe(true);

    const createData = emailCreate.mock.calls[0][0].data;
    expect(createData.hasAttachments).toBe(true);
    expect(createData.attachmentCount).toBe(1);

    expect(saveAttachment).toHaveBeenCalledTimes(1);
    expect(saveAttachment.mock.calls[0][1].filename).toBe('quote.pdf');
    expect(Buffer.isBuffer(saveAttachment.mock.calls[0][1].content)).toBe(true);

    expect(attachmentCreate).toHaveBeenCalledTimes(1);
    const attData = attachmentCreate.mock.calls[0][0].data;
    expect(attData.filename).toBe('quote.pdf');
    expect(attData.contentType).toBe('application/pdf');
    expect(attData.filePath).toBe('uploads/email-attachments/EML__x_quote.pdf');
    expect(attData.fileUrl).toContain('/api/v1/email/attachments/');
    expect(attData.isInline).toBe(false);
  });

  it('内嵌图片（inline）→ 记录保留 isInline=true，但不计入 hasAttachments/attachmentCount', async () => {
    const { prisma, emailCreate, attachmentCreate } = makePrisma();
    const saveAttachment = vi.fn().mockReturnValue('uploads/email-attachments/EML__x_logo.png');
    const imapConnect = makeImapConnect([
      makeMessage(502, RAW_MESSAGE_INLINE, {
        'message-id': ['<inline@test.com>'], from: ['Sender <sender@test.com>'], to: [['me@bambook.com']],
        subject: ['Inline Image Mail'], date: ['2026-08-10T11:00:00Z'],
      }),
    ]);
    const result = await syncEmailsFromImap({
      prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect, saveAttachment,
    });
    expect(result.ok).toBe(true);

    const createData = emailCreate.mock.calls[0][0].data;
    expect(createData.hasAttachments).toBe(false);
    expect(createData.attachmentCount).toBe(0);

    expect(attachmentCreate).toHaveBeenCalledTimes(1);
    const attData = attachmentCreate.mock.calls[0][0].data;
    expect(attData.isInline).toBe(true);
    expect(attData.contentId).toBe('logo123');
  });

  it('附件落盘失败（saveAttachment 返回 null）→ 元数据记录保留 filePath=null，同步不中断', async () => {
    const { prisma, attachmentCreate } = makePrisma();
    const saveAttachment = vi.fn().mockReturnValue(null);
    const imapConnect = makeImapConnect([
      makeMessage(500, RAW_MESSAGE, {
        'message-id': ['<att@test.com>'], from: ['Sender <sender@test.com>'], to: [['me@bambook.com']],
        subject: ['Test With Attachment'], date: ['2026-08-10T10:00:00Z'],
      }),
    ]);
    const result = await syncEmailsFromImap({
      prisma, credentials: { user: 'a@b.com', pass: 'x' }, imapConnect, saveAttachment,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.synced).toBe(1);
    expect(attachmentCreate).toHaveBeenCalledTimes(1);
    expect(attachmentCreate.mock.calls[0][0].data.filePath).toBeNull();
  });
});
