import { describe, it, expect } from 'vitest';
import {
  P0B_TOOL_DEFINITIONS,
  getToolDefinition,
  evaluateApprovalPolicy,
  buildOrderConfirmProcessDraft,
  validateProcessDraft,
  loadOrderSnapshot,
  validateOrderSnapshot,
  type ToolDefinition,
  type ApprovalPolicy,
} from '../toolRegistry';

function makeValidSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order_real_id',
    poNumber: 'PO-001',
    status: 'Pending',
    amount: 12000,
    currency: 'USD',
    customerRelationId: 'rel_cust_1',
    customerName: 'ACME',
    lineCount: 3,
    ...overrides,
  };
}

describe('P0-B Tool Registry Schema', () => {
  describe('§2 ToolDefinition 字段完整性', () => {
    it('四切片全部含必需字段 id/name/scope/risk/description/inputSchema/outputSchema/approvalPolicy', () => {
      const required: (keyof ToolDefinition)[] = [
        'id', 'name', 'scope', 'risk', 'description',
        'inputSchema', 'outputSchema', 'approvalPolicy',
      ];
      for (const def of P0B_TOOL_DEFINITIONS) {
        for (const key of required) {
          expect(def[key], `${def.id} 缺字段 ${key}`).toBeDefined();
        }
      }
    });

    it('四切片 id 唯一且符合点分命名', () => {
      const ids = P0B_TOOL_DEFINITIONS.map(d => d.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    });

    it('inputSchema/outputSchema 是 JSON Schema 对象（含 type:object）', () => {
      for (const def of P0B_TOOL_DEFINITIONS) {
        expect(def.inputSchema.type).toBe('object');
        expect(def.outputSchema.type).toBe('object');
      }
    });
  });

  describe('§3 approvalPolicy 三值映射', () => {
    it('products.search = never', () => {
      expect(getToolDefinition('products.search')?.approvalPolicy).toBe('never');
    });
    it('knowledge.ingest = always (real flow)', () => {
      expect(getToolDefinition('knowledge.ingest')?.approvalPolicy).toBe('always');
    });
    it('orders.update_status = always', () => {
      expect(getToolDefinition('orders.update_status')?.approvalPolicy).toBe('always');
    });
    it('order.confirm = always (flow API 含 high-risk)', () => {
      expect(getToolDefinition('order.confirm')?.approvalPolicy).toBe('always');
    });
    it('Phase 4 Track G 八域只读查询工具 = never（risk=low，无写库）', () => {
      const trackGIds = [
        'moq.query_config',
        'order_changes.query',
        'samples.query',
        'qc.query_reports',
        'exceptions.query',
        'credit.query_status',
        'internal_trade.query',
        'payment_requests.query',
      ];
      for (const id of trackGIds) {
        const def = getToolDefinition(id);
        expect(def, id).toBeDefined();
        expect(def!.approvalPolicy, id).toBe('never');
        expect(def!.risk, id).toBe('low');
      }
    });
  });

  describe('§3 approvalPolicy 评估逻辑', () => {
    const cases: Array<{ policy: ApprovalPolicy; risk: 'low'|'medium'|'high'; exp: { needsApproval: boolean; recordAudit: boolean } }> = [
      // never：全跳过
      { policy: 'never', risk: 'low', exp: { needsApproval: false, recordAudit: false } },
      { policy: 'never', risk: 'high', exp: { needsApproval: false, recordAudit: false } },
      // auto：low 跳过，medium 记 audit 不审批，high 升级审批
      { policy: 'auto', risk: 'low', exp: { needsApproval: false, recordAudit: false } },
      { policy: 'auto', risk: 'medium', exp: { needsApproval: false, recordAudit: true } },
      { policy: 'auto', risk: 'high', exp: { needsApproval: true, recordAudit: true } },
      // always：无条件审批
      { policy: 'always', risk: 'low', exp: { needsApproval: true, recordAudit: true } },
      { policy: 'always', risk: 'high', exp: { needsApproval: true, recordAudit: true } },
    ];
    for (const { policy, risk, exp } of cases) {
      it(`policy=${policy} risk=${risk} -> needsApproval=${exp.needsApproval} recordAudit=${exp.recordAudit}`, () => {
        expect(evaluateApprovalPolicy(policy, risk)).toEqual(exp);
      });
    }
  });

  describe('§4 ProcessDraft 完整性（六字段）', () => {
    it('buildOrderConfirmProcessDraft 输出六字段全部非空', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      const validation = validateProcessDraft(draft);
      expect(validation.ok).toBe(true);
      expect(validation.missing).toEqual([]);
    });

    it('subOperations 含两步：update_status + finance.create_invoice（P1-A scope 去 email）', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      const toolIds = draft.subOperations.map(s => s.toolId);
      expect(toolIds).toContain('orders.update_status');
      expect(toolIds).toContain('finance.create_invoice');
      expect(toolIds).not.toContain('email.send'); // P1-A scope 排除 email
    });

    it('beforeAfterDiff 含 status 字段变更', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft.beforeAfterDiff).toContainEqual({
        entity: 'Order',
        entityId: 'PO-001',
        field: 'status',
        before: 'Pending',
        after: 'Confirmed',
      });
    });

    it('impactScope 含 orders/invoices（P1-A scope 去 email，复数 invoices）', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft.impactScope).toContain('orders');
      expect(draft.impactScope).toContain('invoices'); // 复数（设计文档/前端语义）
      expect(draft.impactScope).not.toContain('email');
    });

    it('irreversible = true（订单确认不可回滚）', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft.irreversible).toBe(true);
    });

    it('postCommitHooks 为空（P1-A scope 排除 email/EmailQueue）', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft.postCommitHooks.length).toBe(0);
    });

    it('idempotencyKey 含 poNumber + canonical hash（pd: 前缀）防重复', () => {
      const draft = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001',
        previousStatus: 'Pending',
        newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft.idempotencyKey).toContain('PO-001');
      expect(draft.idempotencyKey).toMatch(/^order\.confirm:PO-001:pd:[0-9a-f]+$/);
    });

    it('validateProcessDraft 拒绝缺字段 draft', () => {
      const bad = { subOperations: [], beforeAfterDiff: [], impactScope: [], irreversible: true, postCommitHooks: [] } as any;
      const validation = validateProcessDraft(bad);
      expect(validation.ok).toBe(false);
      expect(validation.missing).toContain('idempotencyKey');
    });
  });

  describe('§5 order.confirm ProcessSpec（flow API）', () => {
    it('order.confirm 含 processSpec，composedOf 两步（P1-A scope）', () => {
      const def = getToolDefinition('order.confirm');
      expect(def?.processSpec).toBeDefined();
      expect(def?.processSpec?.composedOf).toEqual([
        'orders.update_status', 'finance.create_invoice',
      ]);
    });

    it('draftPhase produces ProcessDraft', () => {
      const def = getToolDefinition('order.confirm');
      expect(def?.processSpec?.draftPhase.produces).toBe('ProcessDraft');
    });

    it('partialFailurePolicy: draftFail=abort, transactionFail=rollback, postCommitFail=queue_retry', () => {
      const def = getToolDefinition('order.confirm');
      const pfp = def?.processSpec?.partialFailurePolicy;
      expect(pfp?.draftFail).toBe('abort_no_approval');
      expect(pfp?.transactionFail).toBe('rollback');
      expect(pfp?.postCommitFail).toBe('queue_retry');
    });

    it('其他三切片无 processSpec（纯原子工具）', () => {
      expect(getToolDefinition('products.search')?.processSpec).toBeUndefined();
      expect(getToolDefinition('knowledge.ingest')?.processSpec).toBeDefined(); // upgraded to real flow
      expect(getToolDefinition('orders.update_status')?.processSpec).toBeUndefined();
    });
  });
});

import {
  computeProcessDraftHash,
  toToolDescriptor,
  toDefaultToolDefinition,
} from '../toolRegistry';

describe('P0-B review 修复：canonical hash + 适配器消费', () => {
  describe('idempotencyKey canonical hash', () => {
    it('相同 ProcessDraft 内容产生相同 hash', () => {
      const draft1 = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      const draft2 = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      expect(draft1.idempotencyKey).toBe(draft2.idempotencyKey);
    });

    it('ProcessDraft 任何字段变化产生不同 hash（保证审批=提交）', () => {
      const d1 = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed',
        snapshot: makeValidSnapshot(),
      });
      const d2 = buildOrderConfirmProcessDraft({
        poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Cancelled',
        snapshot: makeValidSnapshot(),
      });
      expect(d1.idempotencyKey).not.toBe(d2.idempotencyKey);
    });

    it('computeProcessDraftHash 纯函数稳定（不含 idempotencyKey 自身）', () => {
      const content = {
        subOperations: [{ toolId: 't', entityId: 'e', action: 'a', before: {}, after: {} }],
        beforeAfterDiff: [],
        impactScope: ['x'],
        irreversible: true,
        postCommitHooks: [],
      };
      const h1 = computeProcessDraftHash(content);
      const h2 = computeProcessDraftHash(content);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^pd:[0-9a-f]+$/);
    });
  });

  describe('适配器：演进现有体系（非平行 schema island）', () => {
    it('toToolDescriptor: ToolDefinition -> agentLoopTypes.ToolDescriptor', () => {
      const def = getToolDefinition('products.search')!;
      const desc = toToolDescriptor(def);
      expect(desc.id).toBe('products.search');
      expect(desc.name).toBe('Search Products');
      expect(desc.scope).toBe('products');
      expect(desc.risk).toBe('low');
      expect(desc.inputHint).toContain('query');
    });

    it('toDefaultToolDefinition: ToolDefinition -> defaults.DefaultToolDefinition', () => {
      const def = getToolDefinition('orders.update_status')!;
      const dft = toDefaultToolDefinition(def);
      expect(dft.id).toBe('orders.update_status');
      expect(dft.risk).toBe('high');
      expect(dft.allowedRoles).toContain('owner');
    });

    it('四切片全部可适配为现有 ToolDescriptor（无字段丢失）', () => {
      for (const def of P0B_TOOL_DEFINITIONS) {
        const desc = toToolDescriptor(def);
        expect(desc.id).toBe(def.id);
        expect(desc.name).toBe(def.name);
        expect(desc.risk).toBe(def.risk);
        expect(typeof desc.inputHint).toBe('string');
      }
    });
  });

  describe('toolRuntime 消费 approvalPolicy（集成验证）', () => {
    it('toolRuntime import toolRegistry 成功（非平行 island）', async () => {
      // 动态 import 验证 toolRuntime 模块能加载 toolRegistry 依赖
      const mod = await import('../toolRuntime');
      expect(typeof mod).toBe('object');
    });

    it('P0-B 四切片在 toolRuntime 可查到（getToolDefinition）', () => {
      // toolRuntime 内部调 getToolDefinition，这里验证注册表可见
      expect(getToolDefinition('products.search')).toBeDefined();
      expect(getToolDefinition('knowledge.ingest')).toBeDefined();
      expect(getToolDefinition('orders.update_status')).toBeDefined();
      expect(getToolDefinition('order.confirm')).toBeDefined();
    });

    it('approvalPolicy always 的工具 evaluateApprovalPolicy 返回 needsApproval=true', () => {
      const evalResult = evaluateApprovalPolicy('always', 'high');
      expect(evalResult.needsApproval).toBe(true);
    });
  });
});

import { resolveApprovalDecision } from '../toolRegistry';

describe('P0-B review 第二轮：resolveApprovalDecision 四切片审批语义', () => {
  // 模拟 toolRuntime 的 manifestRequiresApproval：未注册工具 manifest fail-closed = true
  const manifestFailClosed = true;

  it('products.search (never) 不审批、不审计', () => {
    const r = resolveApprovalDecision({
      toolId: 'products.search',
      riskLevel: 'low',
      manifestRequiresApproval: manifestFailClosed,
    });
    expect(r.requiresApproval).toBe(false);
    expect(r.recordAudit).toBe(false);
    expect(r.source).toBe('p0b');
  });

  it('knowledge.ingest (always/medium) 现在走审批（升级为 real flow）', () => {
    const r = resolveApprovalDecision({
      toolId: 'knowledge.ingest',
      riskLevel: 'medium',
      manifestRequiresApproval: manifestFailClosed,
    });
    // upgraded to approvalPolicy=always → requires approval now
    expect(r.requiresApproval).toBe(true);
    expect(r.recordAudit).toBe(true);
  });

  it('orders.update_status (always) 审批', () => {
    const r = resolveApprovalDecision({
      toolId: 'orders.update_status',
      riskLevel: 'high',
      manifestRequiresApproval: manifestFailClosed,
    });
    expect(r.requiresApproval).toBe(true);
    expect(r.source).toBe('p0b');
  });

  it('order.confirm (always/flow) 审批', () => {
    const r = resolveApprovalDecision({
      toolId: 'order.confirm',
      riskLevel: 'high',
      manifestRequiresApproval: manifestFailClosed,
    });
    expect(r.requiresApproval).toBe(true);
    expect(r.source).toBe('p0b');
  });

  it('未注册工具 fail-closed（manifest always）', () => {
    const r = resolveApprovalDecision({
      toolId: 'unknown.tool',
      riskLevel: 'low',
      manifestRequiresApproval: manifestFailClosed,
    });
    expect(r.requiresApproval).toBe(true);
    expect(r.source).toBe('manifest');
  });

  it('P0-B 注册工具优先于 manifest fail-closed（products.search 即使 manifest=true 也不审批）', () => {
    // 关键：manifest fail-closed true，但 P0-B 注册的 products.search 是 never
    const r = resolveApprovalDecision({
      toolId: 'products.search',
      riskLevel: 'low',
      manifestRequiresApproval: true,
    });
    expect(r.requiresApproval).toBe(false);
    expect(r.source).toBe('p0b');
  });
});

import { vi } from 'vitest';
import { executeAgentTool } from '../toolRuntime';
import type { ActorContext } from '../types';

describe('P0-B review 第三轮：executeAgentTool (agentLoop 真实路径) 四切片审批语义', () => {
  // 最小 mock prisma：审批落库 + toolRun 记录 + actor 解析 + order 快照读取
  function makeMockPrisma() {
    const approvalCreates: any[] = [];
    return {
      _approvalCreates: approvalCreates,
      approvalRequest: {
        create: vi.fn(async (args: any) => {
          approvalCreates.push(args);
          return { id: `test_appr_${approvalCreates.length}` };
        }),
        findUnique: vi.fn(async () => null),
      },
      agentTool: { upsert: vi.fn(async () => ({})) },
      userAccount: {
        findFirst: vi.fn(async () => ({ id: 'ua_test', userId: 'u1', displayName: 'Tester' })),
        create: vi.fn(async () => ({ id: 'ua_test', userId: 'u1', displayName: 'Tester' })),
      },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn(async () => null) },
      userRole: { findMany: vi.fn(async () => [{ userId: 'ua_admin' }]) },
      // P1-A: loadOrderSnapshot 读取订单快照
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          quoteAmount: 12000, totalNet: null, totalActual: null,
          currency: 'USD', salesCurrency: null,
          customer: 'ACME', customerRelationId: 'rel_cust_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;
  }

  const ownerActor: ActorContext = {
    userId: 'u1',
    displayName: 'Tester',
    roles: ['owner'],
    departmentIds: ['company'],
    memoryScopes: ['personal:u1'],
    toolScopes: ['products', 'orders', 'relations', 'knowledge', 'finance', 'email', 'entities', 'development', 'templates'],
  } as any;

  it('products.search (never): 不进审批分支（approvalRequest.create 不被调用）', async () => {
    const prisma = makeMockPrisma();
    try {
      await executeAgentTool({
        prisma, actor: ownerActor,
        toolId: 'products.search',
        toolInput: { query: 'test', limit: 3 },
        sessionId: 'sess_test',
      });
    } catch (e: any) {
      // 可能因远程 API 不通而失败，但关键是不应返回 approval_required 或 APPROVAL_REQUIRED
      expect(String(e?.message || '')).not.toContain('APPROVAL_REQUIRED');
    }
    expect(prisma._approvalCreates.length).toBe(0);
  });

  it('knowledge.ingest (always/medium): real flow — 进审批分支，创建 approval', async () => {
    const prisma = makeMockPrisma();
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'knowledge.ingest',
      toolInput: { title: '测试文档', text: '内容' },
      sessionId: 'sess_test',
    }) as any;
    // 升级后进审批分支
    expect(prisma._approvalCreates.length).toBe(1);
    expect(result?.status).toBe('approval_required');
    expect(result?.processDraft).toBeTruthy();
  });

  it('orders.update_status (always): 进审批分支，返回 approval_required', async () => {
    const prisma = makeMockPrisma();
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'orders.update_status',
      toolInput: { poNumber: 'PO-001', newStatus: 'Confirmed' },
      sessionId: 'sess_test',
    }) as any;
    expect(prisma._approvalCreates.length).toBe(1);
    expect(result?.status).toBe('approval_required');
    expect(result?.approvalId).toBeDefined();
  });

  it('order.confirm (always/flow): 审批拦截时已附带 ProcessDraft（draft 在 approval 前）', async () => {
    const prisma = makeMockPrisma();
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001' },
      sessionId: 'sess_test',
    }) as any;
    expect(prisma._approvalCreates.length).toBe(1);
    expect(result?.status).toBe('approval_required');
    // draft-first 语义：ProcessDraft 在审批前已生成（draft -> approval -> commit）
    expect(result?.processDraft).toBeDefined();
    expect(result?.processDraft?.subOperations).toHaveLength(2); // P1-A: status + invoice
    expect(result?.processDraft?.idempotencyKey).toMatch(/^order\.confirm:PO-001:pd:/);
  });

  it('order.confirm P1-A: skipApprovalCheck 无 approvalId -> fail closed (契约要求 approvalId)', async () => {
    const prisma = makeMockPrisma();
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001', previousStatus: 'Pending' },
      sessionId: 'sess_test',
      skipApprovalCheck: true,
      // P1-A: 不传 approvalId -> fail closed（不再返回假 draft-only）
    }) as any;
    expect(result?.ok).toBe(false);
    expect(result?.committed).toBe(false);
    expect(result?.error).toContain('approvalId not provided');
  });

  it('order.confirm P1-A: skipApprovalCheck + approvalId 但无已审批 draft -> fail closed', async () => {
    const prisma = makeMockPrisma();
    prisma.approvalRequest.findUnique = vi.fn(async () => null);
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001', previousStatus: 'Pending' },
      sessionId: 'sess_test',
      skipApprovalCheck: true,
      approvalId: 'ar_nonexistent',
    }) as any;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('not found or not approved');
  });

  it('未注册工具 fail-closed：仍进审批分支', async () => {
    const prisma = makeMockPrisma();
    // relations.create 是 high-risk，在 DEFAULT_AGENT_TOOLS 但不在 P0-B 四切片
    const result = await executeAgentTool({
      prisma, actor: ownerActor,
      toolId: 'relations.create',
      toolInput: { id: 'ORG-X', name: 'Test', category: 'Customer' },
      sessionId: 'sess_test',
    }) as any;
    expect(prisma._approvalCreates.length).toBe(1);
    expect(result?.status).toBe('approval_required');
  });
});

describe('P1-A review: order.confirm modified approval fail-closed', () => {
  function makeLocalMockPrisma() {
    const approvalCreates: any[] = [];
    return {
      _approvalCreates: approvalCreates,
      approvalRequest: {
        create: vi.fn(async (args: any) => { approvalCreates.push(args); return { id: 'ar_1' }; }),
        findUnique: vi.fn(async () => null),
      },
      agentTool: { upsert: vi.fn(async () => ({})) },
      userAccount: {
        findFirst: vi.fn(async () => ({ id: 'ua_test', userId: 'u1', displayName: 'Tester' })),
        create: vi.fn(async () => ({ id: 'ua_test', userId: 'u1', displayName: 'Tester' })),
      },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn(async () => null) },
      userRole: { findMany: vi.fn(async () => [{ userId: 'ua_admin' }]) },
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          quoteAmount: 12000, totalNet: null, totalActual: null,
          currency: 'USD', salesCurrency: null,
          customer: 'ACME', customerRelationId: 'rel_cust_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;
  }
  const localOwnerActor: ActorContext = {
    userId: 'u1', displayName: 'Tester', roles: ['owner'], departmentIds: ['company'],
    memoryScopes: ['personal:u1'],
    toolScopes: ['products', 'orders', 'relations', 'knowledge', 'finance', 'email', 'entities', 'development', 'templates'],
  } as any;

  it('modified status -> fail closed（order.confirm 不支持 modified，需重新审批）', async () => {
    const prisma = makeLocalMockPrisma();
    prisma.approvalRequest.findUnique = vi.fn(async () => ({
      id: 'ar_test',
      status: 'modified',
      requesterId: 'usr_tester',
      payload: { processDraft: buildOrderConfirmProcessDraft({ poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: { orderId: 'order_real_id', poNumber: 'PO-001', status: 'Pending', amount: 12000, currency: 'USD', customerRelationId: 'rel_cust_1', customerName: 'ACME', lineCount: 3 } }) },
    }));
    const result = await executeAgentTool({
      prisma, actor: localOwnerActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001', previousStatus: 'Pending' },
      sessionId: 'sess_test',
      skipApprovalCheck: true,
      approvalId: 'ar_test',
    }) as any;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('does not support modified');
  });

  it('rejected status -> fail closed', async () => {
    const prisma = makeLocalMockPrisma();
    prisma.approvalRequest.findUnique = vi.fn(async () => ({
      id: 'ar_test',
      status: 'rejected',
      requesterId: 'usr_tester',
    }));
    const result = await executeAgentTool({
      prisma, actor: localOwnerActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001', previousStatus: 'Pending' },
      sessionId: 'sess_test',
      skipApprovalCheck: true,
      approvalId: 'ar_test',
    }) as any;
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('not approved');
  });

  it('approved status + 完整 payload -> 进入 commitTransaction 路径', async () => {
    const prisma = makeLocalMockPrisma();
    const draft = buildOrderConfirmProcessDraft({ poNumber: 'PO-001', previousStatus: 'Pending', newStatus: 'Confirmed', snapshot: { orderId: 'order_real_id', poNumber: 'PO-001', status: 'Pending', amount: 12000, currency: 'USD', customerRelationId: 'rel_cust_1', customerName: 'ACME', lineCount: 3 } });
    prisma.approvalRequest.findUnique = vi.fn(async () => ({
      id: 'ar_test',
      status: 'approved',
      requesterId: 'usr_tester',
      payload: { processDraft: draft },
    }));
    // mock commitOrderConfirm 的 $transaction（order 存在）
    (prisma as any).$transaction = vi.fn(async (fn: any) => fn({
      order: { findFirst: vi.fn(async () => ({ id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null })), update: vi.fn(async () => ({})) },
      orderStatusTransition: { create: vi.fn(async () => ({})) },
      invoice: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
    }));
    // 不验证完整成功（$transaction mock 有限），只验证不因 modified/rejected fail
    try {
      const result = await executeAgentTool({
        prisma, actor: localOwnerActor,
        toolId: 'order.confirm',
        toolInput: { poNumber: 'PO-001', previousStatus: 'Pending' },
        sessionId: 'sess_test',
        skipApprovalCheck: true,
        approvalId: 'ar_test',
      }) as any;
      // approved 路径不返回 modified/rejected 错误
      expect(result?.error || '').not.toContain('does not support modified');
      expect(result?.error || '').not.toContain('not approved');
    } catch (e: any) {
      // commit 内部失败（mock 不全）可接受，但不应该是 modified/rejected 错误
      expect(String(e?.message || '')).not.toContain('does not support modified');
    }
  });
});

describe('P1-B: ApprovalRequest.payload 携带 ProcessDraft（验收第1点）', () => {
  function makeP1BMockPrisma() {
    const approvalCreates: any[] = [];
    return {
      _approvalCreates: approvalCreates,
      approvalRequest: {
        create: vi.fn(async (args: any) => { approvalCreates.push(args); return { id: 'ar_1' }; }),
        findUnique: vi.fn(async () => null),
      },
      agentTool: { upsert: vi.fn(async () => ({})) },
      userAccount: {
        findFirst: vi.fn(async () => ({ id: 'usr_owner_default', userId: 'u1', displayName: 'Tester' })),
        create: vi.fn(async () => ({ id: 'usr_owner_default', userId: 'u1', displayName: 'Tester' })),
      },
      // DR-007 routing 查询面：requester 无部门 → FALLBACK_ADMIN 命中 ua_admin
      department: { findUnique: vi.fn(async () => null) },
      userRole: { findMany: vi.fn(async () => [{ userId: 'ua_admin' }]) },
      order: {
        findFirst: vi.fn(async () => ({
          id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
          quoteAmount: 12000, totalNet: null, totalActual: null,
          currency: 'USD', salesCurrency: null,
          customer: 'ACME', customerRelationId: 'rel_cust_1',
          billToName: null, billToRelationId: null,
        })),
      },
      orderLine: { count: vi.fn(async () => 3) },
    } as any;
  }
  const p1bActor: ActorContext = {
    userId: 'u1', displayName: 'Tester', roles: ['owner'], departmentIds: ['company'],
    memoryScopes: ['personal:u1'],
    toolScopes: ['products', 'orders', 'relations', 'knowledge', 'finance', 'email', 'entities', 'development', 'templates'],
  } as any;

  it('executeAgentTool 审批拦截时，ApprovalRequest.payload.processDraft 完整写入', async () => {
    const prisma = makeP1BMockPrisma();
    const result = await executeAgentTool({
      prisma, actor: p1bActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001' },
      sessionId: 'sess_test',
    }) as any;

    expect(result?.status).toBe('approval_required');
    // 验证 createPendingApprovalRequest 调用时 payload 含 processDraft
    expect(prisma._approvalCreates.length).toBe(1);
    const approvalData = prisma._approvalCreates[0];
    expect(approvalData.data.payload).toBeDefined();
    expect(approvalData.data.payload.processDraft).toBeDefined();
    expect(approvalData.data.payload.processDraft.subOperations).toHaveLength(2);
    expect(approvalData.data.payload.processDraft.idempotencyKey).toMatch(/^order\.confirm:PO-001:pd:/);
    // payload.processDraft 与返回给 agentLoop 的 result.processDraft 是同一个
    expect(approvalData.data.payload.processDraft.idempotencyKey).toBe(result?.processDraft?.idempotencyKey);
  });

  it('preconditions 失败（订单无 customer relation）-> 不进审批流程', async () => {
    const prisma = makeP1BMockPrisma();
    // 覆盖 order mock：无 customerRelationId/billToRelationId
    prisma.order.findFirst = vi.fn(async () => ({
      id: 'order_real_id', poNumber: 'PO-001', status: 'Pending', deletedAt: null,
      quoteAmount: 12000, totalNet: null, totalActual: null,
      currency: 'USD', salesCurrency: null,
      customer: 'ACME', customerRelationId: null, // 缺 relation
      billToName: null, billToRelationId: null,
    })) as any;

    const result = await executeAgentTool({
      prisma, actor: p1bActor,
      toolId: 'order.confirm',
      toolInput: { poNumber: 'PO-001' },
      sessionId: 'sess_test',
    }) as any;

    // preconditions fail closed：不进审批，不创建 ApprovalRequest
    expect(result?.status).toBe('preconditions_failed');
    expect(result?.errors).toContain('MISSING_CUSTOMER_RELATION');
    expect(prisma._approvalCreates.length).toBe(0); // 没创建审批请求
  });
});
