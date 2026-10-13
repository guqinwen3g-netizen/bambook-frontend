import { describe, expect, it, vi } from 'vitest';
import { sendOutboxEmail, buildOutboxSendError } from '../outboxSend';
import { logger } from '../../lib/logger';
import { durableFixture } from './outboxDurableFixture';

// mock transporter 工厂（注入 createTransporter）
function makeTransporter(opts: { sendFail?: boolean; messageId?: string | null } = {}) {
  return vi.fn().mockImplementation((config: any) => ({
    sendMail: opts.sendFail
      ? vi.fn().mockRejectedValue(new Error('SMTP_CONNECTION_REFUSED'))
      : vi.fn().mockResolvedValue({ messageId: opts.messageId === undefined ? '<test-msg-id@bambook.local>' : opts.messageId, accepted: ['customer@example.com'], rejected: [], pending: [] }),
  }));
}

function makeEmailRow(overrides: any = {}) {
  return {
    id: 'EML__1',
    direction: 'outbound',
    mailbox: 'Outbox',
    fromAddress: 'agent@bambook.local',
    fromName: 'Bambook Agent',
    toAddresses: JSON.stringify(['customer@example.com']),
    ccAddresses: null,
    subject: 'Test Subject',
    bodyText: 'Test body',
    bodyHtml: null,
    messageId: null,
    sentAt: null,
    ...overrides,
  };
}

function makePrisma(emailRow: any, opts: { updateFail?: boolean; readFail?: boolean } = {}) {
  return durableFixture(emailRow, { actorId: 'u1', updateFail: opts.updateFail, readFail: opts.readFail ? READ_FAIL_SENTINEL : undefined }).prisma;
}

const CREDENTIALS = { user: 'test@bambook.com', pass: 'pass123' };
const READ_FAIL_SENTINEL = 'PrismaClientKnownRequestError: connection terminated while reading Email EO__1 from pool#41';

describe('task ERP-P1 outbox-send: buildOutboxSendError（稳定 error code）', () => {
  it('原有及持久回执 code 均有 statusCode', () => {
    const codes = ['EMAIL_NOT_FOUND', 'EMAIL_READ_FAILED', 'EMAIL_NOT_OUTBOUND', 'EMAIL_NOT_OUTBOX', 'EMAIL_ALREADY_SENT', 'MISSING_RECIPIENT', 'MISSING_CREDENTIALS', 'SMTP_SEND_FAILED', 'SMTP_MESSAGE_ID_MISSING', 'DB_UPDATE_FAILED', 'UNKNOWN_ERROR', 'SEND_LEDGER_UNAVAILABLE', 'SEND_IN_PROGRESS', 'SEND_RESULT_UNCERTAIN', 'SEND_CONTENT_CHANGED', 'SEND_RECEIPT_INVALID', 'SEND_ACTOR_REQUIRED', 'SEND_PERMISSION_DENIED', 'ATTACHMENT_NOT_READY'] as const;
    for (const code of codes) {
      const e = buildOutboxSendError(code, 'test');
      expect(e.code).toBe(code);
      expect(e.statusCode).toBeGreaterThan(0);
    }
  });
});

describe('B67 · 读这封邮件失败 ≠ 这封邮件不存在', () => {
  /**
   * 旧行为：findUnique 挂了 `.catch(() => null)` ⇒ 连接/查询故障被折成 `null`，
   * 端点回 **404 EMAIL_NOT_FOUND「Email X not found」** —— 一件不存在的事（邮件在发件箱里），
   * 而且 SMTP 与事务都不会跑（fail closed 是对的），但**排障方向被假陈述带偏**。
   * 反面对照：把 try/catch 改回 `.catch(() => null)` ⇒ 本组三条断言全红（码、档位、原文）。
   */
  it('读失败 → EMAIL_READ_FAILED + 500（不是 404 NOT_FOUND），且不碰 SMTP、不写库', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const prisma = makePrisma(makeEmailRow(), { readFail: true });
    const tp = makeTransporter();
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS, createTransporter: tp as any });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('EMAIL_READ_FAILED');
    expect(r.error!.statusCode, '档位必须留在 5xx：说成 400/404 就等于把系统故障推给调用方').toBe(500);
    expect(tp).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('connection terminated');   // 原文不许上屏
    expect(JSON.stringify(spy.mock.calls)).toContain('connection terminated'); // 但日志里必须在（D51）
    spy.mockRestore();
  });

  it('邮件确实不存在（读成功但返回 null）→ 仍是 404 EMAIL_NOT_FOUND，两码不许互相盖掉', async () => {
    const r = await sendOutboxEmail({
      prisma: makePrisma(null), actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter() as any,
    });
    expect(r.error!.code).toBe('EMAIL_NOT_FOUND');
    expect(r.error!.statusCode).toBe(404);
  });
});

describe('task ERP-P1 outbox-send: 成功路径', () => {
  it('Outbox outbound 邮件 SMTP 成功 → 更新 Sent + sentAt + messageId + audit', async () => {
    const prisma = makePrisma(makeEmailRow());
    const result = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ messageId: '<real-msg@x>' }) as any,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data!.messageId).toBe('<real-msg@x>');
      expect(result.data!.sentAt).toBeTruthy();
      expect(result.data!.auditId).toBeDefined();
    }
  });
});

describe('task ERP-P1 outbox-send: fail closed（非法状态）', () => {
  it('EMAIL_NOT_FOUND（email 不存在）', async () => {
    const prisma = makePrisma(null);
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'NOPE', credentials: CREDENTIALS });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('EMAIL_NOT_FOUND');
    expect(r.error!.statusCode).toBe(404);
  });

  it('EMAIL_NOT_OUTBOUND（direction=inbound）', async () => {
    const prisma = makePrisma(makeEmailRow({ direction: 'inbound' }));
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('EMAIL_NOT_OUTBOUND');
  });

  it('EMAIL_NOT_OUTBOX（mailbox=Drafts）', async () => {
    const prisma = makePrisma(makeEmailRow({ mailbox: 'Drafts' }));
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('EMAIL_NOT_OUTBOX');
  });

  it('EMAIL_ALREADY_SENT（已有 messageId）', async () => {
    const prisma = makePrisma(makeEmailRow({ messageId: '<existing@x>', sentAt: '2026-06-29 12:00:00' }));
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('EMAIL_ALREADY_SENT');
  });

  it('MISSING_RECIPIENT（toAddresses 空）', async () => {
    const prisma = makePrisma(makeEmailRow({ toAddresses: '[]' }));
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('MISSING_RECIPIENT');
  });
});

describe('task ERP-P1 outbox-send: 凭据缺失', () => {
  it('MISSING_CREDENTIALS（无 user/pass）', async () => {
    const prisma = makePrisma(makeEmailRow());
    const r = await sendOutboxEmail({ prisma, actorId: 'u1', emailId: 'EML__1', credentials: { user: '', pass: '' } });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('MISSING_CREDENTIALS');
  });
});

describe('task ERP-P1 outbox-send: SMTP 失败保持 Outbox', () => {
  it('SMTP 异常保留未知结果占位，不写 Sent、不承诺安全重发', async () => {
    const prisma = makePrisma(makeEmailRow());
    const r = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ sendFail: true }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('SEND_RESULT_UNCERTAIN');
    expect(r.error!.statusCode).toBe(409);
    expect(prisma.email.update).not.toHaveBeenCalled();
    expect((await prisma.emailSendAttempt.findUnique({ where: { emailId: 'EML__1' } })).status).toBe('unknown');
  });
});

describe('SMTP 缺少 messageId 保留未知结果占位', () => {
  it('sendMail resolved 但 messageId 空 → SMTP_MESSAGE_ID_MISSING，保留未知结果占位，不改原生 Sent', async () => {
    const prisma = makePrisma(makeEmailRow());
    const r = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ messageId: '' }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('SEND_RESULT_UNCERTAIN');
    expect(prisma.email.update).not.toHaveBeenCalled();
    expect((await prisma.emailSendAttempt.findUnique({ where: { emailId: 'EML__1' } })).status).toBe('unknown');
  });
});

describe('task ERP-P1 outbox-send: DB 更新失败不静默成功', () => {
  it('DB_UPDATE_FAILED（SMTP 已发但 DB update 失败）', async () => {
    const prisma = makePrisma(makeEmailRow(), { updateFail: true });
    const r = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ messageId: '<sent-but-db-fail@x>' }) as any,
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('DB_UPDATE_FAILED');
    expect(r.error!.message).toContain('<sent-but-db-fail@x>'); // 提示已发但 DB 没记录（回执号留给操作员对账）
    expect(r.error!.message).not.toContain('DB_LOCK');          // ★ 异常原文不许进对外文案
    expect(JSON.stringify(r)).not.toContain('pass123');
  });
});

describe('B42 A1（S0-A2 第 10 批·复核处置）· service 外发文案不带异常原文', () => {
  /**
   * ★ 为什么判据要落在 service 而不是路由：`sendOutboxEmail` 从不抛错，
   *   路由 `if (!result.ok) res.json({ error: result.error })` 是**原样转发**，
   *   所以路由那一层的 safeRouteError 对本域这两处是死代码。
   *   反面对照：把 'DB_LOCK' / 'SMTP_CONNECTION_REFUSED' 拼回对外文案 ⇒ 本组红。
   */
  it('SMTP 失败：原文只进日志，不进对外文案（不带发件邮箱与主机名）', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const prisma = makePrisma(makeEmailRow());
    const r = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ sendFail: true }) as any,
    });
    expect(r.error!.code).toBe('SEND_RESULT_UNCERTAIN');
    const out = JSON.stringify(r);
    expect(out).not.toContain('SMTP_CONNECTION_REFUSED');
    expect(out).not.toContain('test@bambook.com');   // 发件邮箱地址不许出现在响应里
    expect(out).not.toContain('pass123');            // 授权码更不许
    // 原文必须在日志里（D51：换文案的前提是先确认有日志可查）
    expect(JSON.stringify(spy.mock.calls)).toContain('SMTP_CONNECTION_REFUSED');
    spy.mockRestore();
  });

  it('DB 写入失败：原文进日志，对外只留回执号', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const prisma = makePrisma(makeEmailRow(), { updateFail: true });
    const r = await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter({ messageId: '<db-copy@x>' }) as any,
    });
    expect(r.error!.code).toBe('DB_UPDATE_FAILED');
    expect(JSON.stringify(r)).not.toContain('DB_LOCK');
    expect(JSON.stringify(r)).toContain('<db-copy@x>');
    expect(JSON.stringify(spy.mock.calls)).toContain('DB_LOCK');
    spy.mockRestore();
  });
});

describe('task ERP-P1 outbox-send: AuditLog 行为', () => {
  it('成功发送 → audit 写 send attempt/result（before Outbox → after Sent）', async () => {
    const prisma = makePrisma(makeEmailRow());
    await sendOutboxEmail({
      prisma, actorId: 'u1', emailId: 'EML__1', credentials: CREDENTIALS,
      createTransporter: makeTransporter() as any,
    });
    // 分别核对持久占位、原生审计和最终 sent 状态，不靠事务调用次数猜测业务通过
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.emailSendAttempt.create).toHaveBeenCalledTimes(1);
    expect((await prisma.emailSendAttempt.findUnique({ where: { emailId: 'EML__1' } })).status).toBe('sent');
  });
});
