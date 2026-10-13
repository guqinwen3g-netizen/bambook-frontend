import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { executeAgentTool } from '../toolRuntime';
import { getMcpManifest } from '../mcp/manifest';

// ============================================================================
// Agent-P1-open-ended-business-scenario-eval
// 多工具自然语言场景评估：验证 toolRuntime fail closed、RBAC 拒绝、credential-safe、service reuse。
// 覆盖 Finance/Orders/Shipping/Email/Knowledge/Relations 六类能力。
// ============================================================================

const MANIFEST_SRC = fs.readFileSync(path.resolve(__dirname, '../mcp/manifest.ts'), 'utf-8');
const REGISTRY_SRC = fs.readFileSync(path.resolve(__dirname, '../toolRegistry.ts'), 'utf-8');
const RUNTIME_SRC = fs.readFileSync(path.resolve(__dirname, '../toolRuntime.ts'), 'utf-8');

function makeApprovalPrisma() {
  let createdApproval: any = null;
  return {
    approvalRequest: {
      create: vi.fn().mockImplementation(async ({ data }: any) => { createdApproval = data; return data; }),
    },
    agentToolRun: { create: vi.fn().mockResolvedValue({}) },
    userAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    actorAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'usr_owner_default' }) },
    // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
    department: { findUnique: vi.fn().mockResolvedValue(null) },
    userRole: { findMany: vi.fn().mockResolvedValue([{ userId: 'ua_admin' }]) },
    order: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    invoice: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    relation: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    developmentCase: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    garmentOrder: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
  } as any;
}

const fullScopeActor = { userId: 'u1', role: 'admin', id: 'u1', roles: ['admin'], toolScopes: ['products', 'orders', 'relations', 'knowledge', 'finance', 'email', 'entities', 'development', 'automation', 'shipping'], knowledgeScopes: ['company'], departmentIds: [] } as any;
const viewerActor = { userId: 'v1', role: 'viewer', id: 'v1', roles: ['viewer'], toolScopes: ['read', 'products'], knowledgeScopes: ['company'], departmentIds: [] } as any;

// ============================================================================
// [source-level] 工具注册事实（诚实标注 manifest vs toolRegistry）
// ============================================================================
describe('[source-level] 工具注册事实（诚实分层）', () => {
  const MANIFEST_ONLY_TOOLS = ['finance.list_invoices', 'orders.get', 'knowledge.search', 'relations.query'];
  const TOOL_REGISTRY_FLOW_TOOLS = ['invoice.create', 'order.confirm', 'order.ship', 'email.sync', 'knowledge.ingest', 'relation.onboard'];

  it('只读查询工具在 manifest 注册', () => {
    for (const id of MANIFEST_ONLY_TOOLS) {
      expect(MANIFEST_SRC).toContain(`id: '${id}'`);
    }
  });

  it('Flow API 写工具在 toolRegistry 注册', () => {
    for (const id of TOOL_REGISTRY_FLOW_TOOLS) {
      expect(REGISTRY_SRC).toContain(`id: '${id}'`);
    }
  });

  it('order.confirm 在 toolRegistry 注册（诚实：不在 manifest 的查询工具中）', () => {
    expect(REGISTRY_SRC).toContain("id: 'order.confirm'");
  });

  it('email.sync / knowledge.ingest 在 manifest 和 toolRegistry 双重注册', () => {
    for (const id of ['email.sync', 'knowledge.ingest']) {
      expect(MANIFEST_SRC).toContain(`id: '${id}'`);
      expect(REGISTRY_SRC).toContain(`id: '${id}'`);
    }
  });
});

// ============================================================================
// [execution] approval-required fail closed（精确断言）
// ============================================================================
describe('[execution] email.sync/knowledge.ingest → approval_required（精确）', () => {
  it('email.sync → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'email.sync',
      toolInput: { credentials: { user: 'a@b.com', pass: 'secret' } },
      sessionId: 'sess_eval',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('knowledge.ingest → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'knowledge.ingest',
      toolInput: { title: '产品规格', text: '内容' },
      sessionId: 'sess_eval',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });
});

describe('[execution] invoice.create/order.confirm 缺前置数据 → preconditions_failed（精确）', () => {
  it('invoice.create 缺订单数据 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'invoice.create',
      toolInput: { orderId: 'PO-001', invoiceNumber: 'INV-001', currency: 'USD', lines: [] },
      sessionId: 'sess_eval',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('order.confirm 缺订单数据 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001' },
      sessionId: 'sess_eval',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// [execution] credential-safe
// ============================================================================
describe('[execution] credential-safe', () => {
  it('email.sync approval payload 不含明文 password', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'email.sync',
      toolInput: { credentials: { user: 'a@b.com', pass: 'supersecret123' } },
      sessionId: 'sess_cred',
    });
    expect(result.status).toBe('approval_required');
    const createdData = prisma.approvalRequest.create.mock.calls[0][0].data;
    const payloadStr = JSON.stringify(createdData, (_, v) => typeof v === 'bigint' ? String(v) : v);
    expect(payloadStr).not.toContain('supersecret123');
    expect(createdData.payload.input.credentials.pass).toBe('');
    expect(createdData.payload.input.credentials.credentialRef).toMatch(/^ecred_/);
  });
});

// ============================================================================
// [execution] RBAC scope gating: viewer 被拒
// ============================================================================
describe('[execution] RBAC: viewer scope 被拒', () => {
  it('viewer 访问 invoice.create → TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: viewerActor, toolId: 'invoice.create', toolInput: { orderId: 'PO-1' }, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
  });

  it('viewer 访问 email.sync → TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: viewerActor, toolId: 'email.sync', toolInput: { credentials: { user: 'a@b.com', pass: 'x' } }, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
  });

  it('viewer 访问 knowledge.ingest → TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: viewerActor, toolId: 'knowledge.ingest', toolInput: { title: 't', text: 'c' }, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
  });
});

// ============================================================================
// [source-level] service reuse no-bypass
// ============================================================================
describe('[source-level] service reuse no-bypass', () => {
  it('email.sync commit → commitEmailSync（复用 syncEmailsFromImap）', () => {
    expect(RUNTIME_SRC).toContain('commitEmailSync');
  });
  it('knowledge.ingest flow → ingestKnowledgeDocument', () => {
    const flowSrc = fs.readFileSync(path.resolve(__dirname, '../knowledgeIngestFlow.ts'), 'utf-8');
    expect(flowSrc).toContain('ingestKnowledgeDocument');
  });
  it('order.confirm commit → commitOrderConfirm', () => {
    expect(RUNTIME_SRC).toContain('commitOrderConfirm');
  });
});

// ============================================================================
// [execution] preconditions failed（精确断言）
// ============================================================================
describe('[execution] preconditions failed（精确）', () => {
  it('email.sync 缺 credentials.user → preconditions_failed，不创建 approval', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'email.sync',
      toolInput: { credentials: {} },
      sessionId: 's',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('knowledge.ingest 缺 text → preconditions_failed，不创建 approval', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'knowledge.ingest',
      toolInput: { title: 't' },
      sessionId: 's',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase 2 · 2.3: 多场景评估补强——幻觉工具 fail-closed / 跨 scope RBAC / 拒绝可审计
// 评估原则：跨工具路径、边界情况、失败状态、权限上下文，不以单个成功示例评判
// ============================================================================

describe('[execution] LLM 幻觉 toolId fail-closed（TOOL_NOT_REGISTERED）', () => {
  it('未注册 toolId → throw TOOL_NOT_REGISTERED，不创建 approval、不写 tool run', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({
        prisma, actor: fullScopeActor,
        toolId: 'finance.delete_all_invoices', // LLM 幻觉出的危险工具——必须 fail closed
        toolInput: {},
        sessionId: 'sess_halluc',
      })
    ).rejects.toThrow(/TOOL_NOT_REGISTERED/);
    // 幻觉工具不得产生任何副作用
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
    expect(prisma.agentToolRun.create).not.toHaveBeenCalled();
  });

  it('空 toolId / 畸形 toolId → TOOL_NOT_REGISTERED（不 fallback 到任何 handler）', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: fullScopeActor, toolId: '', toolInput: {}, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_REGISTERED/);
    await expect(
      executeAgentTool({ prisma, actor: fullScopeActor, toolId: 'orders.query; DROP TABLE orders;--', toolInput: {}, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_REGISTERED/);
  });
});

describe('[execution] 跨 scope RBAC 矩阵（非 viewer 的细粒度权限上下文）', () => {
  const financeActor = { userId: 'f1', role: 'operator', id: 'f1', roles: ['operator'], toolScopes: ['finance'], knowledgeScopes: ['company'], departmentIds: [] } as any;
  const ordersActor = { userId: 'o1', role: 'operator', id: 'o1', roles: ['operator'], toolScopes: ['orders'], knowledgeScopes: ['company'], departmentIds: [] } as any;
  const knowledgeActor = { userId: 'k1', role: 'operator', id: 'k1', roles: ['operator'], toolScopes: ['knowledge'], knowledgeScopes: ['company'], departmentIds: [] } as any;

  it('finance scope actor 调 order.confirm（scope=orders）→ TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: financeActor, toolId: 'order.confirm', toolInput: { poNumber: 'PO-1' }, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('orders scope actor 调 invoice.create（scope=finance）→ TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: ordersActor, toolId: 'invoice.create', toolInput: { orderId: 'PO-1' }, sessionId: 's' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
  });

  it('knowledge scope actor 调 payment.receive_and_reconcile（scope=finance 高危）→ TOOL_NOT_ALLOWED', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({
        prisma, actor: knowledgeActor,
        toolId: 'payment.receive_and_reconcile',
        toolInput: { voucherId: 'V1', voucherAmount: 100, currency: 'USD', allocations: [{ invoiceId: 'I1', appliedAmount: 100 }] },
        sessionId: 's',
      })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

describe('[execution] RBAC 拒绝可审计（权限链留痕）', () => {
  it('policy 拒绝时写 agentToolRun(status=failed, error=TOOL_NOT_ALLOWED)', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({ prisma, actor: viewerActor, toolId: 'invoice.create', toolInput: { orderId: 'PO-1' }, sessionId: 'sess_audit' })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
    // 拒绝必须留痕：权限链可审计（谁、何时、哪个工具、为何被拒）
    expect(prisma.agentToolRun.create).toHaveBeenCalledTimes(1);
    const runData = prisma.agentToolRun.create.mock.calls[0][0].data;
    expect(runData.status).toBe('failed');
    expect(String(runData.error)).toMatch(/TOOL_NOT_ALLOWED|role_not_allowed/i);
  });

  it('policy 放行但 preconditions 失败 → 不产生 approval（权限正确≠业务可执行）', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-NONEXISTENT' },
      sessionId: 'sess_pre',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase 4 · Track H: 自然语言业务场景评估扩展（≥20 条）
// 覆盖：只读查询 / 高风险写需审批 / 直写路径同闸 / 非法参数 / 不存在实体 /
//       权限上下文（manager/owner/sales） / service 层错误透出 / draft 快照真实性
// 评估原则：断言 Agent 任务理解→工具选择→审批链触发行为；真实执行 executeAgentTool，
//           不 mock LLM、不写死答案。
// ============================================================================

/** 场景级 prisma mock：在审批 mock 基础上按场景覆盖模型行为 */
function makeScenarioPrisma(overrides: Record<string, unknown> = {}) {
  const base = makeApprovalPrisma();
  return { ...base, ...overrides } as any;
}

// ── A. 只读查询路径：不触发审批、不创建 approval、直接执行 ──────────────────
describe('[execution] A. 只读查询路径不触发审批', () => {
  it('「查一下 RWS 认证的面料」products.search → 直接执行不审批', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'products.search',
      toolInput: { query: 'RWS 羊毛', limit: 5 },
      sessionId: 'sess_nl_01',
    });
    // 只读工具：返回查询结果（mock 下为空集合），绝不进入审批
    expect(result.status).not.toBe('approval_required');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「检索知识库的样品发票规则」knowledge.search → 直接执行不审批', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'knowledge.search',
      toolInput: { query: '样品发票规则', limit: 8 },
      sessionId: 'sess_nl_02',
    });
    expect(result.status).not.toBe('approval_required');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「查一下下周到期的订单」orders.query → 直接执行不审批', async () => {
    const prisma = makeScenarioPrisma({
      order: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'orders.query',
      toolInput: { filters: { dueDateTo: '2026-08-23' }, limit: 20 },
      sessionId: 'sess_nl_03',
    });
    expect(result.status).not.toBe('approval_required');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ── B. 高风险写（Flow API）：draft→approval 拦截，ProcessDraft 随审批挂单 ──
describe('[execution] B. 高风险写 Flow API → approval_required + ProcessDraft', () => {
  it('「把订单 PO-001 发货」order.ship → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'order.ship',
      toolInput: { orderId: 'ORD__PO-001', shipment: { shipmentNumber: 'SHIP-001', shippingMethod: 'FCL' } },
      sessionId: 'sess_nl_04',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「回复客户邮件确认订单已发货」email.reply_and_send → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'email.reply_and_send',
      toolInput: { to: ['customer@example.com'], subject: 'Re: 订单 PO-001', bodyText: '已发货，运单号 SHIP-001。' },
      sessionId: 'sess_nl_05',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「新建客户档案：江苏测试纺织」relation.onboard → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'relation.onboard',
      toolInput: { organization: { id: 'ORG-JS-TEX', name: '江苏测试纺织有限公司', category: 'Customer' } },
      sessionId: 'sess_nl_06',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「开具发票 INV-001 并通知客户」invoice.issue → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'invoice.issue',
      toolInput: { invoiceNumber: 'INV-001', amount: 10000, currency: 'USD' },
      sessionId: 'sess_nl_07',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「为订单创建一张应收发票」invoice.create（合法入参）→ approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'invoice.create',
      toolInput: { input: { invoiceNumber: 'INV-20260816-001', type: 'Receivable', amount: '50000.0000', currency: 'USD', issueDate: '2026-08-16' } },
      sessionId: 'sess_nl_08',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「收到客户一笔 TT 收款创建凭证」payment_voucher.create → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'payment_voucher.create',
      toolInput: { input: { voucherNumber: 'PAY-20260816-001', type: 'Receipt', amount: '30000.0000', currency: 'USD', paymentDate: '2026-08-16', paymentMethod: 'TT' } },
      sessionId: 'sess_nl_09',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「创建面料数字档案」product_asset.create → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'product_asset.create',
      toolInput: { body: { sku: 'FAB-001', name: '全棉斜纹', mainCategory: 'Fabric' } },
      sessionId: 'sess_nl_10',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「给客户 Peerless 下一单样品单」development.create → approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'development.create',
      toolInput: { code: 'DEV-2608-001', name: '全棉斜纹手刮样', type: 'fabric', customerName: 'Peerless' },
      sessionId: 'sess_nl_11',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });
});

// ── C. 直写路径（registerTool）：与 Flow API 同一道审批闸 ──────────────────
describe('[execution] C. 直写路径同样强制审批（无绕过）', () => {
  it('「把订单标记为生产中」orders.update_status（直写）→ approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'orders.update_status',
      toolInput: { poNumber: 'PO-001', newStatus: 'Production' },
      sessionId: 'sess_nl_12',
    });
    expect(result.status).toBe('approval_required');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「新建一个供应商档案」relations.create（直写）→ approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'relations.create',
      toolInput: { id: 'ORG-SUP-001', name: '苏州供应商有限公司', category: 'Supplier' },
      sessionId: 'sess_nl_13',
    });
    expect(result.status).toBe('approval_required');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「将开发单标记为待寄样阶段」development.update_stage（直写）→ approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'development.update_stage',
      toolInput: { id: 'DEV-2601-001', stage: 'shipping', nextAction: '寄出 S2 色样' },
      sessionId: 'sess_nl_14',
    });
    expect(result.status).toBe('approval_required');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });
});

// ── D. 边界情况：非法参数 → preconditions_failed，不创建 approval ──────────
describe('[execution] D. 非法参数边界（fail before approval）', () => {
  it('「发货但缺运单号」order.ship 缺 shipment.shipmentNumber → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'order.ship',
      toolInput: { orderId: 'ORD__PO-001', shipment: { shippingMethod: 'FCL' } },
      sessionId: 'sess_nl_15',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「创建凭证但金额非法」payment_voucher.create amount 非数字 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'payment_voucher.create',
      toolInput: { input: { voucherNumber: 'PAY-001', type: 'Receipt', amount: 'not-a-number', currency: 'USD', paymentDate: '2026-08-16', paymentMethod: 'TT' } },
      sessionId: 'sess_nl_16',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(String(result.message)).toMatch(/PRECONDITIONS_FAILED/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「更新客户资料含不可写字段」relation.update patch 含非法字段 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'relation.update',
      toolInput: { relationId: 'ORG-JS-TEX', patch: { internalPasswordHash: 'x' } },
      sessionId: 'sess_nl_17',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(String(result.message)).toMatch(/non-writable fields/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ── E. 边界情况：不存在实体 → preconditions_failed，不为必然失败的写创建审批 ──
describe('[execution] E. 不存在实体边界（fail closed）', () => {
  it('「更新不存在的客户资料」relation.update relationId 不存在 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma(); // relation.findUnique → null
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'relation.update',
      toolInput: { relationId: 'ORG-NONEXISTENT', patch: { paymentTerms: 'TT60' } },
      sessionId: 'sess_nl_18',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(String(result.message)).toMatch(/not found/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「作废不存在的发票」invoice.cancel invoiceId 不存在 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma(); // invoice.findUnique → null
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'invoice.cancel',
      toolInput: { invoiceId: 'INV__NONEXISTENT', reason: '客户退货' },
      sessionId: 'sess_nl_19',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「删除不存在的订单」order.delete orderId 不存在 → preconditions_failed', async () => {
    const prisma = makeApprovalPrisma(); // order.findUnique → null
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'order.delete',
      toolInput: { orderId: 'ORD__NONEXISTENT' },
      sessionId: 'sess_nl_20',
    });
    expect(result.status).toBe('preconditions_failed');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ── F. 权限上下文：审批内核对审批人角色同样无条件触发；跨 scope 拒绝 ──────
describe('[execution] F. 权限上下文（角色矩阵）', () => {
  const managerActor = { userId: 'm1', role: 'manager', id: 'm1', roles: ['manager'], toolScopes: ['shipping', 'orders'], knowledgeScopes: ['company'], departmentIds: [] } as any;
  const ownerActor = { userId: 'own1', role: 'owner', id: 'own1', roles: ['owner'], toolScopes: ['finance'], knowledgeScopes: ['company'], departmentIds: [] } as any;
  const salesActor = { userId: 's1', role: 'sales', id: 's1', roles: ['sales'], toolScopes: ['relations', 'orders'], knowledgeScopes: ['company'], departmentIds: [] } as any;

  it('「manager 发货订单」order.ship：审批链对审批人角色同样触发（human-in-the-loop 不可自批绕过）', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: managerActor,
      toolId: 'order.ship',
      toolInput: { orderId: 'ORD__PO-001', shipment: { shipmentNumber: 'SHIP-001', shippingMethod: 'FCL' } },
      sessionId: 'sess_nl_21',
    });
    // approvalPolicy=always 无条件审批：即使 manager 在 HIGH_RISK_APPROVERS 中，仍须过审批内核
    expect(result.status).toBe('approval_required');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「owner 创建收款凭证」payment_voucher.create：owner 角色同样 approval_required', async () => {
    const prisma = makeApprovalPrisma();
    const result: any = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'payment_voucher.create',
      toolInput: { input: { voucherNumber: 'PAY-001', type: 'Receipt', amount: '30000.0000', currency: 'USD', paymentDate: '2026-08-16', paymentMethod: 'TT' } },
      sessionId: 'sess_nl_22',
    });
    expect(result.status).toBe('approval_required');
    expect(prisma.approvalRequest.create).toHaveBeenCalledTimes(1);
  });

  it('「sales 开具发票」invoice.issue：无 finance scope → TOOL_NOT_ALLOWED，不创建 approval', async () => {
    const prisma = makeApprovalPrisma();
    await expect(
      executeAgentTool({
        prisma, actor: salesActor,
        toolId: 'invoice.issue',
        toolInput: { invoiceNumber: 'INV-001', amount: 100 },
        sessionId: 'sess_nl_23',
      })
    ).rejects.toThrow(/TOOL_NOT_ALLOWED|ROLE_NOT_ALLOWED/);
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });
});

// ── G. 失败状态：service 层错误透出 + draft 快照真实性 ─────────────────────
describe('[execution] G. 失败状态与快照真实性', () => {
  it('「查订单时 DB 异常」orders.query service 层错误透出并留痕（status=failed）', async () => {
    const prisma = makeScenarioPrisma({
      order: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockRejectedValue(new Error('DB_CONNECTION_TIMEOUT')),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    await expect(
      executeAgentTool({
        prisma, actor: fullScopeActor,
        toolId: 'orders.query',
        toolInput: { filters: {}, limit: 5 },
        sessionId: 'sess_nl_24',
      })
    ).rejects.toThrow(/DB_CONNECTION_TIMEOUT/);
    // service 层错误必须留痕：failed toolRun 携带原始错误信息；只读工具不产生 approval
    expect(prisma.agentToolRun.create).toHaveBeenCalledTimes(1);
    const runData = prisma.agentToolRun.create.mock.calls[0][0].data;
    expect(runData.status).toBe('failed');
    expect(String(runData.error)).toContain('DB_CONNECTION_TIMEOUT');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  it('「更新存在的客户付款条款」relation.update：审批卡携带真实 before 快照（审批即所得）', async () => {
    const prisma = makeScenarioPrisma({
      relation: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ id: 'ORG-JS-TEX', paymentTerms: 'TT30', deletedAt: null }),
      },
    });
    const result: any = await executeAgentTool({
      prisma, actor: fullScopeActor,
      toolId: 'relation.update',
      toolInput: { relationId: 'ORG-JS-TEX', patch: { paymentTerms: 'TT60' } },
      sessionId: 'sess_nl_25',
    });
    expect(result.status).toBe('approval_required');
    expect(result.processDraft).toBeTruthy();
    // draft 的 beforeAfterDiff 必须来自 DB 真实快照（before=TT30），而非 LLM 臆造
    const diff = result.processDraft.beforeAfterDiff.find((d: any) => d.field === 'paymentTerms');
    expect(diff).toBeTruthy();
    expect(diff.before).toBe('TT30');
    expect(diff.after).toBe('TT60');
    // 审批落库 payload 必须携带同一 processDraft（what-you-approve-is-what-you-commit）
    const createdData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(createdData.payload.processDraft).toBeTruthy();
    expect(createdData.payload.processDraft.idempotencyKey).toBe(result.processDraft.idempotencyKey);
  });
});
