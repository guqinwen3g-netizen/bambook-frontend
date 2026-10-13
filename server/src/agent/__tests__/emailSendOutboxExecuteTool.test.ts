import { approvalContext, emailActor } from './emailOutboxApprovalFixture';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildEmailSendOutboxDraft } from '../emailSendOutboxFlow';
import { clearEmailCredentials } from '../emailCredentialStore';

vi.mock('../../email/outboxSend', () => ({
  sendOutboxEmail: vi.fn(),
}));
import { sendOutboxEmail } from '../../email/outboxSend';

vi.mock('../../email/outboxSendAttemptService', () => ({ readDurableOutboxContext: vi.fn(async () => ({ ok: true, data: approvalContext })) }));

describe('task email-send-outbox: executeTool commit 路径', () => {
  it('skipApprovalCheck + approved → committed', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: true, data: { emailId: 'EML__1', messageId: '<m@x>', sentAt: '2026-06-29 12:00:00', auditId: 'a1' } });
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:email.send', payload: { processDraft: draft, credentialsPassword: 'p' } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {}, approvalId: 'AP1' } as any, { actor: emailActor });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.messageId).toBe('<m@x>');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) }, approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {} } as any, { actor: emailActor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) }, approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {}, approvalId: 'AP1' } as any, { actor: emailActor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) }, approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {}, approvalId: 'AP1' } as any, { actor: emailActor });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('sendOutboxEmail SMTP_SEND_FAILED → failed（不伪 committed）', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    (sendOutboxEmail as any).mockResolvedValue({ ok: false, error: { code: 'SMTP_SEND_FAILED', message: 'conn refused', statusCode: 502 } });
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:email.send', payload: { processDraft: draft, credentialsPassword: 'p' } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {}, approvalId: 'AP1' } as any, { actor: emailActor });
    expect(result.ok).toBe(false);
    expect((result as any).error?.code || (result as any).errorFeedback?.code).toBe('SMTP_SEND_FAILED');
  });
});

describe('task email-send-outbox: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft', async () => {
    let createdApproval: any = null;
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'email.send',
      toolInput: { emailId: 'EML__1', credentials: { user: 'a@b.com', pass: 'p' } },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect((result.processDraft.subOperations[0].after as any).emailId).toBe('EML__1');
    expect(createdApproval.payload.processDraft).toBeTruthy();
  });

  it('首次调用缺 emailId → preconditions_failed', async () => {
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) }, agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'email.send',
      toolInput: { credentials: { user: 'a@b.com', pass: 'p' } },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('EMAIL_SEND_PRECONDITIONS_FAILED');
  });
});


describe('task email-send-outbox review-fix: 真实 approval 恢复链路（password 不丢）', () => {
  beforeEach(() => { vi.clearAllMocks(); clearEmailCredentials(); });
  it('executeAgentTool draft → approval payload 不含真实 pass（只存 credentialRef）→ executeTool commit 用 credentialRef 恢复 pass 调 sendOutboxEmail', async () => {
    // 1. executeAgentTool draft 阶段
    let createdApproval: any = null;
    const draftPrisma = {
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'u1' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const draftResult: any = await executeAgentTool({
      prisma: draftPrisma, actor, toolId: 'email.send',
      toolInput: { emailId: 'EML__1', credentials: { user: 'a@b.com', pass: 'real-password-123' } },
      sessionId: 's1',
    });
    expect(draftResult.status).toBe('approval_required');
    // approval payload 全量 JSON 不含真实 pass（安全：admin /approvals 不暴露明文）
    const payloadStr = JSON.stringify(createdApproval.payload);
    expect(payloadStr).not.toContain('real-password-123');
    // payload 只存 credentialRef（非明文）
    expect(createdApproval.payload.input.credentials.credentialRef).toBeTruthy();
    expect(createdApproval.payload.input.credentials.pass).toBe('');

    // 2. executeTool commit 阶段：credentialRef 恢复 pass
    createdApproval.status = 'approved';
    (sendOutboxEmail as any).mockResolvedValue({ ok: true, data: { emailId: 'EML__1', messageId: '<msg@x>', sentAt: '2026-06-29 12:00:00', auditId: 'a1' } });
    const commitPrisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      approvalRequest: { findUnique: vi.fn().mockResolvedValue(createdApproval) },
    } as any;
    const commitResult: any = await executeTool(commitPrisma, { toolId: 'email.send', input: {}, approvalId: createdApproval.id } as any, { actor: emailActor });
    expect(commitResult.ok).toBe(true);
    expect(sendOutboxEmail).toHaveBeenCalledTimes(1);
    const callArgs = (sendOutboxEmail as any).mock.calls[0][0];
    expect(callArgs.actorId).toBe('u1');
    expect(callArgs.actor.userId).toBe('u1');
    expect(callArgs.expectedContentHash).toBe(approvalContext.contentHash);
    expect(callArgs.credentials.pass).toBe('real-password-123'); // credentialRef 恢复的真实 pass
  });

  it('credential missing（credentialRef 无效/过期）→ producer 验证空凭据，不伪 committed', async () => {
    const draft = buildEmailSendOutboxDraft({ emailId: 'EML__1', sendContext: approvalContext, credentials: { user: 'a@b.com', pass: 'p' } });
    // approval payload 含 credentialRef 但 secret context 已清空（模拟过期/进程重启）
    const approval = { id: 'AP1', status: 'approved', actionType: 'tool:email.send', payload: { processDraft: draft, input: { credentials: { credentialRef: 'ecred_expired', pass: '' } } } };
    (sendOutboxEmail as any).mockResolvedValue({ ok: false, error: { code: 'MISSING_CREDENTIALS', message: 'pass empty', statusCode: 400 } });
    const prisma = { agentCommitReceipt: { findUnique: vi.fn().mockResolvedValue(null) }, emailSendAttempt: { findUnique: vi.fn().mockResolvedValue(null) }, approvalRequest: { findUnique: vi.fn().mockResolvedValue(approval) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.send', input: {}, approvalId: 'AP1' } as any, { actor: emailActor });
    expect(result.ok).toBe(false);
    // sendOutboxEmail 被调用但 pass 空（credentialRef 恢复失败）→ MISSING_CREDENTIALS
    expect(sendOutboxEmail).toHaveBeenCalledTimes(1);
    const callArgs = (sendOutboxEmail as any).mock.calls[0][0];
    expect(callArgs.credentials.pass).toBe('');
  });
});

describe('task email-send-outbox review-fix: composedOf 防回退', () => {
  it('email.send processSpec.composedOf 含 email.outbox_send（非 email.reply_and_send）', () => {
    const fs = require('fs');
    const path = require('path');
    const reg = fs.readFileSync(path.resolve(__dirname, '../../agent/toolRegistry.ts'), 'utf-8');
    const idx = reg.indexOf("id: 'email.send'");
    expect(idx).toBeGreaterThan(-1);
    const section = reg.slice(idx, idx + 1200);
    expect(section).toContain("composedOf: ['email.outbox_send']");
    expect(section).not.toContain("composedOf: ['email.reply_and_send']");
  });
});
