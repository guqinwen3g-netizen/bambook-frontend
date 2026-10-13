import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool, executeAgentTool } from '../toolRuntime';
import { buildDevCreateDraft } from '../developmentCreateFlow';
import { buildStatementSendDraft } from '../statementSendFlow';
import type { CustomerStatement } from '../../finance/reportService';
import type { ActorContext } from '../types';

vi.mock('../../development/developmentCaseMutationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../development/developmentCaseMutationService')>();
  return { ...actual, createDevelopmentCase: vi.fn() };
});
import { createDevelopmentCase } from '../../development/developmentCaseMutationService';

const ADMIN_ACTOR = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['finance', 'orders', 'shipping', 'relations', 'automation', 'development'], knowledgeScopes: ['company'], departmentIds: [] } as any;
const DEV_EXECUTOR: ActorContext = { userId: 'actual-dev-executor', roles: [], departmentIds: [], toolScopes: ['development'],
  permissionScopes: ['products:read', 'products:write'], permissionCeiling: ['products:read', 'products:write'],
  permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: ['company'] };

function makeDraftPrisma() {
  return {
    approvalRequest: { create: vi.fn().mockImplementation(async ({ data }: any) => data) },
    agentToolRun: { create: vi.fn().mockResolvedValue({}) },
    userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
    department: { findUnique: vi.fn().mockResolvedValue(null) },
    userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
  } as any;
}

// ────────────────────────────────────────────────────────────────
// development.create
// ────────────────────────────────────────────────────────────────
const DEV_CREATE_INPUT = {
  code: 'DEV-2608-001', name: '全棉斜纹手刮样', type: 'fabric',
  customerName: 'Peerless', sampleType: '手刮样', sampleQuantity: 5, sampleUnit: 'meter', targetDate: '2026-08-20',
};

describe('task dev-create-flow: executeTool commit 路径', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skipApprovalCheck + approved → committed', async () => {
    const draft = buildDevCreateDraft(DEV_CREATE_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: true, data: { case: { id: 'DEV__1', code: 'DEV-2608-001' }, auditId: 'a1' } });
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:development.create', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'development.create', input: {}, approvalId: 'AP1' } as any, { actor: DEV_EXECUTOR });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.caseId).toBe('DEV__1');
    expect(result.code).toBe('DEV-2608-001');
    expect(createDevelopmentCase).toHaveBeenCalledWith(expect.objectContaining({ actorId: DEV_EXECUTOR.userId,
      trustedActor: expect.objectContaining({ userId: DEV_EXECUTOR.userId, permissionCeiling: DEV_EXECUTOR.permissionCeiling }) }));
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'development.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval modified → APPROVAL_MODIFIED_UNSUPPORTED', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'development.create', input: {}, approvalId: 'AP1' } as any, { actor: DEV_EXECUTOR });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'development.create', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });

  it('service 失败（DUPLICATE_CODE）→ failed（不伪 committed）', async () => {
    const draft = buildDevCreateDraft(DEV_CREATE_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: false, error: { code: 'DUPLICATE_CODE', message: 'dup' } });
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:development.create', payload: { processDraft: draft } }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'development.create', input: {}, approvalId: 'AP1' } as any, { actor: DEV_EXECUTOR });
    expect(result.ok).toBe(false);
    expect((result as any).error?.code || (result as any).errorFeedback?.code).toBe('DUPLICATE_CODE');
  });

  it('approved development creation without a real executor fails closed before the shared writer', async () => {
    const draft = buildDevCreateDraft(DEV_CREATE_INPUT);
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved',
      requesterId: 'approval-requester', actionType: 'tool:development.create', payload: { processDraft: draft } }) } } as never;
    const call = { toolId: 'development.create', input: {}, approvalId: 'AP1', reason: 'approved creation still needs a real executor' };
    const result = await executeTool(prisma, call);
    expect(result).toMatchObject({ ok: false, errorFeedback: { code: 'UNAUTHORIZED' } });
    expect(createDevelopmentCase).not.toHaveBeenCalled();
  });
});

describe('task dev-create-flow: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + payload 含 processDraft（样品字段完整）', async () => {
    let createdApproval: any = null;
    const prisma = makeDraftPrisma();
    prisma.approvalRequest.create.mockImplementation(async ({ data }: any) => { createdApproval = data; return data; });
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'development.create',
      toolInput: DEV_CREATE_INPUT,
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    const after = result.processDraft.subOperations[0].after as any;
    expect(after.code).toBe('DEV-2608-001');
    expect(after.customerName).toBe('Peerless');
    expect(after.sampleType).toBe('手刮样');
    expect(createdApproval.payload.processDraft).toBeTruthy();
  });

  it('缺 code/name/type → preconditions_failed', async () => {
    const prisma = makeDraftPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'development.create',
      toolInput: { name: '只有名字' },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('DEV_CREATE_PRECONDITIONS_FAILED');
  });

  it('缺客户归属 → preconditions_failed（CUSTOMER_REQUIRED）', async () => {
    const prisma = makeDraftPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'development.create',
      toolInput: { code: 'DEV-2608-002', name: '无客户样品', type: 'fabric' },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('DEV_CREATE_DRAFT_INVALID');
    expect(result.errors).toContain('CUSTOMER_REQUIRED');
  });
});

// ────────────────────────────────────────────────────────────────
// finance.get_statement（只读）
// ────────────────────────────────────────────────────────────────
describe('task statement: finance.get_statement 只读分发', () => {
  it('聚合发票+凭证 → statement sections', async () => {
    const prisma = {
      // A2（2026-09-18）：对账单收款改按「核销了谁的票」归属 ⇒ fixture 必须带 id +
      // customerRelationId（真实库同样如此；缺了就无处可挂，会被真源正确地丢弃）
      invoice: { findMany: vi.fn().mockResolvedValue([
        { id: 'INV-1', invoiceNumber: 'INV-1', amount: 800, currency: 'USD', issueDate: '2026-08-05', customerName: 'Peerless', customerRelationId: 'R1' },
      ]) },
      paymentVoucher: { findMany: vi.fn().mockResolvedValue([
        { id: 'PAY-1', voucherNumber: 'PAY-1', amount: 300, currency: 'USD', paymentDate: '2026-08-12', customerName: 'Peerless', customerRelationId: 'R1' },
      ]) },
      // A2（2026-09-18）：对账单收款改按「核销了谁的票」归属，需读 InvoiceAllocation
      invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      // B269：档案回读改为**无条件**（对外件那一格要业务编码）⇒ 这份内联桩也得有 relation 这张表
      relation: { findUnique: vi.fn().mockResolvedValue({ name: 'R1 Trading Ltd', chineseName: null, code: 'CUS-9001' }) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'finance.get_statement', input: { customerRelationId: 'R1', from: '2026-08-01', to: '2026-08-31' } } as any);
    expect(result.ok).toBe(true);
    expect(result.statement.customerName).toBe('Peerless');
    expect(result.statement.customerCode).toBe('CUS-9001');
    expect(result.statement.sections).toHaveLength(1);
    expect(result.statement.sections[0].currency).toBe('USD');
    expect(result.statement.sections[0].transactions).toHaveLength(2);
    expect(result.statement.sections[0].closingBalance).toBe(500);
  });

  it('缺 customerRelationId → ok:false', async () => {
    const prisma = { invoice: { findMany: vi.fn() }, paymentVoucher: { findMany: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'finance.get_statement', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('customerRelationId');
  });
});

// ────────────────────────────────────────────────────────────────
// statement.send
// ────────────────────────────────────────────────────────────────
// A2：同上，fixture 需带 id + customerRelationId
const STMT_INVOICES = [
  { id: 'INV-1', invoiceNumber: 'INV-1', amount: 800, currency: 'USD', issueDate: '2026-08-05', customerName: 'Peerless', customerRelationId: 'R1' },
];
const STMT_VOUCHERS = [
  { id: 'PAY-1', voucherNumber: 'PAY-1', amount: 300, currency: 'USD', paymentDate: '2026-08-12', customerName: 'Peerless', customerRelationId: 'R1' },
];

function makeStatementDraftPrisma(invoices: any[] = STMT_INVOICES, vouchers: any[] = STMT_VOUCHERS) {
  const prisma = makeDraftPrisma();
  (prisma as any).invoice = { findMany: vi.fn().mockResolvedValue(invoices) };
  (prisma as any).paymentVoucher = { findMany: vi.fn().mockResolvedValue(vouchers) };
  // A2（2026-09-18）：收款归属真源需要 InvoiceAllocation（无核销 ⇒ 全额留在打款人名下）
  (prisma as any).invoiceAllocation = { findMany: vi.fn().mockResolvedValue([]) };
  // B266 连带（B269 起改为无条件回读）：对账单服务要读档案拿名字/编码 ⇒ 工厂桩必须有 relation 这张表。
  //   默认查不到档案 ⇒ 这些用例的旧世界（名字为 null、走 STATEMENT_EMPTY）逐字不变。
  (prisma as any).relation = { findUnique: vi.fn().mockResolvedValue(null) };
  return prisma;
}

describe('task statement-send-flow: executeAgentTool draft→approval', () => {
  it('首次调用 → approval_required + draft 内含完整对账单快照（审批即所得）', async () => {
    const prisma = makeStatementDraftPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'statement.send',
      toolInput: {
        customerRelationId: 'R1', from: '2026-08-01', to: '2026-08-31',
        email: { to: ['finance@peerless.com'], subject: 'Statement of Account 2026-08' },
      },
      sessionId: 's1',
    });
    expect(result.status).toBe('approval_required');
    const after = result.processDraft.subOperations[0].after as any;
    expect(after.customerRelationId).toBe('R1');
    expect(after.statementSnapshot.sections[0].closingBalance).toBe(500);
    expect(after.statementSnapshot.sections[0].transactions).toHaveLength(2);
    expect(after.email.to).toEqual(['finance@peerless.com']);
  });

  it('期间无往来 → preconditions_failed（STATEMENT_EMPTY），不创建 approval', async () => {
    const prisma = makeStatementDraftPrisma([], []);
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'statement.send',
      toolInput: {
        customerRelationId: 'R1',
        email: { to: ['finance@peerless.com'], subject: 'S' },
      },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('STATEMENT_SEND_PRECONDITIONS_FAILED');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('缺 email.to → preconditions_failed', async () => {
    const prisma = makeStatementDraftPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: ADMIN_ACTOR, toolId: 'statement.send',
      toolInput: { customerRelationId: 'R1', email: { to: [], subject: 'S' } },
      sessionId: 's1',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(result.message).toContain('STATEMENT_SEND_PRECONDITIONS_FAILED');
  });
});

describe('task statement-send-flow: executeTool commit 路径', () => {
  const SNAPSHOT: CustomerStatement = {
    customerCode: null,
    customerRelationId: 'R1', customerName: 'Peerless', from: '2026-08-01', to: '2026-08-31',
    sections: [{
      currency: 'USD', openingBalance: 0, closingBalance: 500,
      transactions: [
        { date: '2026-08-05', kind: 'invoice', number: 'INV-1', debit: 800, credit: 0, balance: 800 },
        { date: '2026-08-12', kind: 'receipt', number: 'PAY-1', debit: 0, credit: 300, balance: 500 },
      ],
    }],
  };

  function makeCommitPrisma() {
    const emailCreate = vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id }));
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = { email: { create: emailCreate }, auditLog: { create: auditCreate } };
    return { tx, emailCreate, auditCreate };
  }

  it('approved → committed：写 outbound/Outbox 邮件（正文=快照渲染，零重算）', async () => {
    const draft = buildStatementSendDraft({
      customerRelationId: 'R1', customerName: 'Peerless', from: '2026-08-01', to: '2026-08-31',
      email: { to: ['finance@peerless.com'], subject: 'Statement of Account 2026-08' },
      statementSnapshot: SNAPSHOT,
    });
    const { tx, emailCreate } = makeCommitPrisma();
    const prisma = {
      approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'approved', actionType: 'tool:statement.send', payload: { processDraft: draft } }) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      // 防重算断言：commit 不得再查 invoice/paymentVoucher
      invoice: { findMany: vi.fn().mockRejectedValue(new Error('MUST_NOT_REQUERY')) },
      paymentVoucher: { findMany: vi.fn().mockRejectedValue(new Error('MUST_NOT_REQUERY')) },
    } as any;
    const result: any = await executeTool(prisma, { toolId: 'statement.send', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.emailId).toMatch(/^EML__/);
    expect(emailCreate).toHaveBeenCalledTimes(1);
    expect(emailCreate.mock.calls[0][0].data.bodyText).toContain('INV-1');
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.paymentVoucher.findMany).not.toHaveBeenCalled();
  });

  it('无 approvalId → APPROVAL_ID_MISSING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn() } } as any;
    const result: any = await executeTool(prisma, { toolId: 'statement.send', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
  });

  it('approval pending → APPROVAL_PENDING', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'statement.send', input: {}, approvalId: 'AP1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
  });
});
