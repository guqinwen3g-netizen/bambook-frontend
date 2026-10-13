import { describe, expect, it, vi } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildEmailReplySendDraft } from '../emailReplySendFlow';

function makeCommitTx() {
  return {
    email: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id })), findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

describe('task email-reply-send: executeTool commit 路径', () => {
  it('skipApprovalCheck + approved → committed', async () => {
    const draft = buildEmailReplySendDraft({ to: ['a@b.com'], subject: 'S', bodyText: 'B' });
    const tx = makeCommitTx();
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:email.reply_and_send', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.reply_and_send', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.direction).toBe('outbound');
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.reply_and_send', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.reply_and_send', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'email.reply_and_send', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });
});

describe('task email-reply-send: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft', async () => {
    let createdApproval: any = null;
    const prisma = {
      approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }) },
      agentToolRun: { create: vi.fn().mockResolvedValue({}) },
      userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'email.reply_and_send',
      toolInput: { to: ['a@b.com'], subject: 'S', bodyText: 'B' },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect((result.processDraft.subOperations[0].after as any).to).toEqual(['a@b.com']);
    expect(createdApproval.payload.processDraft).toBeTruthy();
  });

  it('首次调用缺 to → preconditions_failed', async () => {
    const prisma = { agentToolRun: { create: vi.fn().mockResolvedValue({}) } } as any;
    const actor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation'], knowledgeScopes: ['company'], departmentIds: [] } as any;
    const result: any = await executeAgentTool({
      prisma, actor, toolId: 'email.reply_and_send',
      toolInput: { subject: 'S', bodyText: 'B' },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('EMAIL_REPLY_SEND_PRECONDITIONS_FAILED');
  });
});
