/**
 * Phase 4 Track G：Phase 2 八域 Agent 只读查询工具测试
 *
 * 覆盖工具：moq.query_config / order_changes.query / samples.query / qc.query_reports
 *          exceptions.query / credit.query_status / internal_trade.query / payment_requests.query
 *
 * 模式（与 c3TradeTools.test.ts 对齐）：
 *   - 每域至少 1 个正例 + 1 个边界/错误例
 *   - mock service 层（vi.mock 各域 service 模块，importOriginal 保留其余导出），
 *     经 executeTool 真实分发链路（toolRuntime → toolDispatchRegistry → handler）执行
 *   - 登记一致性：P0B 定义（approvalPolicy=never + risk=low）+ manifest 只读安全元数据
 *     + defaults 角色表 + LLM runner 描述符
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────
// Mock service 层（vi.hoisted 保证 mock factory 内可引用）
// ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  moqGetActiveConfig: vi.fn(),
  moqListHistory: vi.fn(),
  ocListChangeRequests: vi.fn(),
  ocGetChangeRequest: vi.fn(),
  fsListOrderSamples: vi.fn(),
  fsComputeShipmentEligibility: vi.fn(),
  epListByOrder: vi.fn(),
  gsListRounds: vi.fn(),
  qcListReportsByOrder: vi.fn(),
  qcCheckShipmentEligibility: vi.fn(),
  sampleFindMany: vi.fn(),
  excListExceptions: vi.fn(),
  excGetExceptionById: vi.fn(),
  creditGetStatus: vi.fn(),
  creditGetHistory: vi.fn(),
  itListInternalTransfers: vi.fn(),
  itGetInternalTransferById: vi.fn(),
  prListPaymentRequests: vi.fn(),
  prGetPaymentRequest: vi.fn(),
  poListPurchaseOrders: vi.fn(),
  poGetPurchaseOrder: vi.fn(),
  bomListBOMs: vi.fn(),
  bomGetBOM: vi.fn(),
  cxListTaxRefunds: vi.fn(),
  cxGetTaxRefund: vi.fn(),
  cxListDeclarations: vi.fn(),
  cxGetDeclaration: vi.fn(),
  finListInvoiceAllocations: vi.fn(),
}));

vi.mock('../../moq/moqConfigService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createMoqConfigService: () => ({
      getActiveConfig: mocks.moqGetActiveConfig,
      listHistory: mocks.moqListHistory,
    }),
  };
});

vi.mock('../../orderChanges/orderChangeRequestService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createOrderChangeRequestService: () => ({
      listChangeRequests: mocks.ocListChangeRequests,
      getChangeRequest: mocks.ocGetChangeRequest,
    }),
  };
});

vi.mock('../../samples/fabricShipmentSampleService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createFabricShipmentSampleService: () => ({
      listOrderSamples: mocks.fsListOrderSamples,
      computeShipmentEligibility: mocks.fsComputeShipmentEligibility,
    }),
  };
});

vi.mock('../../samples/earlyProductionSampleService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createEarlyProductionSampleService: () => ({
      listByOrder: mocks.epListByOrder,
    }),
  };
});

vi.mock('../../samples/garmentSampleGateService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createGarmentSampleGateService: () => ({
      listRounds: mocks.gsListRounds,
    }),
  };
});

vi.mock('../../qc/qcService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createQcService: () => ({
      listReportsByOrder: mocks.qcListReportsByOrder,
      checkShipmentEligibility: mocks.qcCheckShipmentEligibility,
    }),
  };
});

vi.mock('../../exceptions/exceptionService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createExceptionService: () => ({
      listExceptions: mocks.excListExceptions,
      getExceptionById: mocks.excGetExceptionById,
    }),
  };
});

vi.mock('../../credit/creditService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createCreditService: () => ({
      getCreditStatus: mocks.creditGetStatus,
      getCreditHistory: mocks.creditGetHistory,
    }),
  };
});

vi.mock('../../internalTrade/internalTransferService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createInternalTransferService: () => ({
      listInternalTransfers: mocks.itListInternalTransfers,
      getInternalTransferById: mocks.itGetInternalTransferById,
    }),
  };
});

vi.mock('../../paymentRequests/paymentRequestService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createPaymentRequestService: () => ({
      listPaymentRequests: mocks.prListPaymentRequests,
      getPaymentRequest: mocks.prGetPaymentRequest,
    }),
  };
});

// 审批服务仅作为域服务构造参数透传（只读工具绝不触发审批链），stub 掉避免依赖
vi.mock('../../approvals/approvalRoutingService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalRoutingService: () => ({}) };
});
vi.mock('../../approvals/approvalCreateService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalCreateService: () => ({}) };
});

vi.mock('../../procurement/procurementService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createProcurementService: () => ({
      listPurchaseOrders: mocks.poListPurchaseOrders,
      getPurchaseOrder: mocks.poGetPurchaseOrder,
    }),
  };
});

vi.mock('../../bom/bomService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createBOMService: () => ({
      listBOMs: mocks.bomListBOMs,
      getBOM: mocks.bomGetBOM,
    }),
  };
});

vi.mock('../../customs/customsService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createCustomsService: () => ({
      listTaxRefunds: mocks.cxListTaxRefunds,
      getTaxRefund: mocks.cxGetTaxRefund,
      listDeclarations: mocks.cxListDeclarations,
      getDeclaration: mocks.cxGetDeclaration,
    }),
  };
});

vi.mock('../../finance/allocationService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    listInvoiceAllocations: mocks.finListInvoiceAllocations,
  };
});

import { executeTool } from '../toolRuntime';
import { businessError } from '../../shared/errorCodes';
import { getToolManifestSafety } from '../mcp/manifest';
import { DEFAULT_AGENT_TOOLS } from '../defaults';
import { getToolDefinition } from '../toolRegistry';
import { AGENT_LOOP_TOOL_DESCRIPTORS } from '../../ai/runner';

const TRACK_G_TOOL_IDS = [
  'moq.query_config',
  'order_changes.query',
  'samples.query',
  'qc.query_reports',
  'exceptions.query',
  'credit.query_status',
  'internal_trade.query',
  'payment_requests.query',
  'purchase_orders.query',
  'bom.query',
  'customs.query_tax_refunds',
  'customs.query_declarations',
  'finance.query_allocations',
] as const;

const prisma = { sample: { findMany: mocks.sampleFindMany } } as any;
// These six original producer-result controls use a server context and explicit
// loaded storage grants. Service outputs remain substituted, not PG/L2 proof.
const orderLinkedScopes = ['procurement:read', 'bom:read', 'sensitive:cost', 'customs:read'];
const orderLinkedContext: any = { actor: { userId: 'track-g-query-user', roles: ['finance'], departmentIds: [],
  permissionScopes: orderLinkedScopes, permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: [] } };
const orderLinkedPrisma = { ...prisma,
  userAccount: { findFirst: async () => ({ id: 'track-g-query-user', status: 'active', deletedAt: null,
    roles: [{ roleId: 'role-finance', role: { permissions: orderLinkedScopes.map(scope => ({ permission: { scope } })) } }] }) },
  userPermissionOverrides: { findMany: async () => [] },
};
const executeOrderLinkedTool = (call: any) => executeTool(orderLinkedPrisma as any, call, orderLinkedContext);


beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

// ────────────────────────────────────────────────────────────────
// 登记一致性
// ────────────────────────────────────────────────────────────────

describe('Track G 工具登记一致性', () => {
  it('13 个工具均在 P0B ToolDefinition 注册（approvalPolicy=never + risk=low）', () => {
    for (const id of TRACK_G_TOOL_IDS) {
      const def = getToolDefinition(id);
      expect(def, id).toBeDefined();
      expect(def!.approvalPolicy).toBe('never');
      expect(def!.risk).toBe('low');
      expect(def!.description.length).toBeGreaterThan(0);
      expect(def!.inputSchema.type).toBe('object');
    }
  });

  it('13 个工具均在 manifest 注册为只读（免审批、无副作用）', () => {
    for (const id of TRACK_G_TOOL_IDS) {
      expect(getToolManifestSafety(id)).toEqual({ approval: 'never', sideEffects: false });
    }
  });

  it('13 个工具均在 defaults 角色表中且 risk=low', () => {
    const byId = new Map(DEFAULT_AGENT_TOOLS.map(t => [t.id, t]));
    for (const id of TRACK_G_TOOL_IDS) {
      const def = byId.get(id);
      expect(def, id).toBeDefined();
      expect(def!.risk).toBe('low');
      expect(def!.allowedRoles.length).toBeGreaterThan(0);
    }
  });

  it('13 个工具均在 LLM runner 描述符表中（agentLoop 可规划）', () => {
    const byId = new Map(AGENT_LOOP_TOOL_DESCRIPTORS.map(d => [d.id, d]));
    for (const id of TRACK_G_TOOL_IDS) {
      const desc = byId.get(id);
      expect(desc, id).toBeDefined();
      expect(desc!.risk).toBe('low');
      expect(typeof desc!.inputHint).toBe('string');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// moq.query_config
// ────────────────────────────────────────────────────────────────

describe('moq.query_config', () => {
  it('正例：返回生效配置与三档阈值，summary 含数值', async () => {
    mocks.moqGetActiveConfig.mockResolvedValue({
      id: 'moq_1',
      fabricDefaultMoq: 1000,
      garmentDefaultMoq: 300,
      capsuleMoq: 30,
      isActive: true,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      changedBy: 'admin',
    });
    const result: any = await executeTool(prisma, { toolId: 'moq.query_config', input: {} } as any);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('moq_config');
    expect(result.effectiveValues).toEqual({ fabricDefaultMoq: 1000, garmentDefaultMoq: 300, capsuleMoq: 30 });
    expect(result.summary).toContain('1000');
    expect(result.summary).toContain('300');
    expect(result.history).toBeUndefined(); // 默认不带历史
  });

  it('边界：无生效配置时回落兜底常量并标记 source=fallback_constant', async () => {
    mocks.moqGetActiveConfig.mockResolvedValue(null);
    const result: any = await executeTool(prisma, { toolId: 'moq.query_config', input: {} } as any);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('fallback_constant');
    expect(result.effectiveValues).toEqual({ fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20 });
    expect(result.summary).toContain('兜底常量');
  });

  it('includeHistory=true 时附带变更历史', async () => {
    mocks.moqGetActiveConfig.mockResolvedValue(null);
    mocks.moqListHistory.mockResolvedValue([{ id: 'h1', fabricDefaultMoq: 800 }]);
    const result: any = await executeTool(prisma, { toolId: 'moq.query_config', input: { includeHistory: true, historyLimit: 10 } } as any);
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(mocks.moqListHistory).toHaveBeenCalledWith({ limit: 10 });
  });
});

// ────────────────────────────────────────────────────────────────
// order_changes.query
// ────────────────────────────────────────────────────────────────

describe('order_changes.query', () => {
  it('正例：按订单过滤列表，返回条数与最新摘要', async () => {
    mocks.ocListChangeRequests.mockResolvedValue({
      items: [
        { id: 'cr_1', requestNumber: 'OCR-20260816-001', status: 'Pending', orderId: 'ord_1', changeTypes: ['quantity'] },
      ],
    });
    const result: any = await executeTool(prisma, { toolId: 'order_changes.query', input: { orderId: 'ord_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('OCR-20260816-001');
    expect(mocks.ocListChangeRequests).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ord_1', status: undefined, requesterId: undefined }),
    );
  });

  it('正例：id 模式返回单条详情（含关联订单快照）', async () => {
    mocks.ocGetChangeRequest.mockResolvedValue({
      item: { id: 'cr_1', requestNumber: 'OCR-20260816-001', status: 'Approved', orderId: 'ord_1', changeTypes: ['deliveryDate'], order: { poNumber: 'PO-001' } },
    });
    const result: any = await executeTool(prisma, { toolId: 'order_changes.query', input: { id: 'cr_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.requestNumber).toBe('OCR-20260816-001');
    expect(result.summary).toContain('PO-001');
    expect(mocks.ocListChangeRequests).not.toHaveBeenCalled();
  });

  it('边界：id 模式申请不存在 → ok=false NOT_FOUND', async () => {
    mocks.ocGetChangeRequest.mockResolvedValue({ item: null });
    const result: any = await executeTool(prisma, { toolId: 'order_changes.query', input: { id: 'cr_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// samples.query
// ────────────────────────────────────────────────────────────────

describe('samples.query', () => {
  it('正例：fabric_shipment 默认模式返回样品列表，附带发货资格', async () => {
    // DR-054 阶段 G：大货生产样统一 Sample(type=ship/head) 挂 sourceOrderId
    mocks.sampleFindMany.mockResolvedValue([{ id: 's1', code: 'SMP-20260908-001', type: 'ship', sourceOrderId: 'ord_1' }]);
    mocks.qcCheckShipmentEligibility.mockResolvedValue({ eligible: true });
    const result: any = await executeTool(prisma, {
      toolId: 'samples.query',
      input: { orderId: 'ord_1', includeEligibility: true },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.eligibility).toBe(true);
    expect(result.summary).toContain('具备');
  });

  it('正例：garment_rounds 模式按开发案返回多轮样品与封样状态', async () => {
    mocks.gsListRounds.mockResolvedValue({ ok: true, data: { items: [{ round: 1 }], sealedRoundId: 'r1' } });
    const result: any = await executeTool(prisma, {
      toolId: 'samples.query',
      input: { mode: 'garment_rounds', caseId: 'case_1' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.sealedRoundId).toBe('r1');
    expect(result.summary).toContain('已封样');
  });

  it('边界：fabric_shipment 缺 orderId → ok=false MISSING_ORDER_ID（不触达样品查询）', async () => {
    const result: any = await executeTool(prisma, { toolId: 'samples.query', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_ORDER_ID');
    expect(mocks.sampleFindMany).not.toHaveBeenCalled();
  });

  it('边界：garment_rounds 缺 caseId → ok=false MISSING_CASE_ID', async () => {
    const result: any = await executeTool(prisma, { toolId: 'samples.query', input: { mode: 'garment_rounds' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_CASE_ID');
    expect(mocks.gsListRounds).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// qc.query_reports
// ────────────────────────────────────────────────────────────────

describe('qc.query_reports', () => {
  it('正例：按订单返回 QC 报告列表与出运资格', async () => {
    mocks.qcListReportsByOrder.mockResolvedValue({
      items: [{ id: 'qc1', status: 'Approved', conclusion: 'Pass' }],
      total: 1,
    });
    mocks.qcCheckShipmentEligibility.mockResolvedValue({ eligible: false, reasons: ['报告未齐备'] });
    const reportDb = { ...prisma,
      userAccount: { findFirst: async () => ({ id: 'native-qc-reader', status: 'active', deletedAt: null,
        roles: [{ roleId: 'owner', role: { permissions: [{ permission: { scope: 'qc:read' } }] } }] }) },
      userPermissionOverrides: { findMany: async () => [] },
      order: { findFirst: async () => ({ id: 'ord_1', deletedAt: null }) },
    };
    const result: any = await executeTool(reportDb as any, {
      toolId: 'qc.query_reports',
      input: { orderId: 'ord_1', includeEligibility: true },
    } as any, { actor: { userId: 'native-qc-reader', roles: ['owner'], departmentIds: [],
      permissionScopes: ['qc:read'], permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: ['qc'] } });
    expect(result.ok).toBe(true);
    expect(mocks.qcListReportsByOrder).toHaveBeenCalledWith('ord_1', expect.objectContaining({ userId: 'native-qc-reader', authorizationLoaded: true }));
    expect(result.total).toBe(1);
    expect(result.eligibility).toMatchObject({ eligible: false });
    expect(result.summary).toContain('1 份 QC 报告');
    expect(result.summary).toContain('不具备');
  });

  it('边界：缺 orderId → ok=false MISSING_ORDER_ID（不触达 service）', async () => {
    const result: any = await executeTool(prisma, { toolId: 'qc.query_reports', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_ORDER_ID');
    expect(mocks.qcListReportsByOrder).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// exceptions.query
// ────────────────────────────────────────────────────────────────

describe('exceptions.query', () => {
  it('正例：按状态过滤列表，返回条数摘要', async () => {
    mocks.excListExceptions.mockResolvedValue({
      ok: true,
      data: { items: [{ id: 'ex1', requestNumber: 'EXC-001', status: 'ReviewerApproved', exceptionCategory: 'order_ship' }] },
    });
    const result: any = await executeTool(prisma, {
      toolId: 'exceptions.query',
      input: { status: 'ReviewerApproved' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('1 条例外申请');
    expect(mocks.excListExceptions).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ReviewerApproved' }),
    );
  });

  it('正例：id 模式返回单条详情', async () => {
    mocks.excGetExceptionById.mockResolvedValue({
      ok: true,
      data: { exception: { id: 'ex1', requestNumber: 'EXC-001', status: 'Consumed', exceptionCategory: 'moq_exemption' } },
    });
    const result: any = await executeTool(prisma, { toolId: 'exceptions.query', input: { id: 'ex1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('ex1');
    expect(result.summary).toContain('moq_exemption');
  });

  it('边界：service 返回失败（NOT_FOUND）→ 透传 ok=false', async () => {
    mocks.excGetExceptionById.mockResolvedValue({
      ok: false,
      error: { code: 'EXCEPTION_NOT_FOUND', message: '例外申请不存在', statusCode: 404 },
    });
    const result: any = await executeTool(prisma, { toolId: 'exceptions.query', input: { id: 'ex_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('EXCEPTION_NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// credit.query_status
// ────────────────────────────────────────────────────────────────

describe('credit.query_status', () => {
  it('正例：返回额度/占用/剩余/冻结标记，summary 含关键数值', async () => {
    mocks.creditGetStatus.mockResolvedValue({
      relationId: 'rel_1',
      hasCreditLimit: true,
      status: 'Active',
      totalLimit: 100000,
      usedAmount: 40000,
      remaining: 60000,
      currency: 'USD',
      creditFrozen: false,
      maxOverdueDays: 12,
    });
    const result: any = await executeTool(prisma, { toolId: 'credit.query_status', input: { relationId: 'rel_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.status.remaining).toBe(60000);
    expect(result.summary).toContain('100000');
    expect(result.summary).toContain('12');
    expect(result.history).toBeUndefined();
  });

  it('边界：客户不存在（getCreditStatus 返回 null）→ ok=false NOT_FOUND', async () => {
    mocks.creditGetStatus.mockResolvedValue(null);
    const result: any = await executeTool(prisma, { toolId: 'credit.query_status', input: { relationId: 'rel_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });

  it('边界：缺 relationId → ok=false MISSING_RELATION_ID（不触达 service）', async () => {
    const result: any = await executeTool(prisma, { toolId: 'credit.query_status', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_RELATION_ID');
    expect(mocks.creditGetStatus).not.toHaveBeenCalled();
  });

  it('includeHistory=true 时附带信用历史时间线', async () => {
    mocks.creditGetStatus.mockResolvedValue({
      relationId: 'rel_1', hasCreditLimit: false, maxOverdueDays: 0, creditFrozen: false,
    });
    mocks.creditGetHistory.mockResolvedValue({ ok: true, data: { items: [{ id: 'h1' }], total: 1 } });
    const result: any = await executeTool(prisma, {
      toolId: 'credit.query_status',
      input: { relationId: 'rel_1', includeHistory: true },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(result.historyTotal).toBe(1);
    expect(result.summary).toContain('未设置信用额度');
  });
});

// ────────────────────────────────────────────────────────────────
// internal_trade.query
// ────────────────────────────────────────────────────────────────

describe('internal_trade.query', () => {
  it('正例：按部门过滤列表，返回总数与本页条数', async () => {
    mocks.itListInternalTransfers.mockResolvedValue({
      items: [{ id: 'it_1', memo: 'x' }],
      total: 5,
    });
    const result: any = await executeTool(prisma, {
      toolId: 'internal_trade.query',
      input: { departmentId: 'dept_garment' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(1);
    expect(result.summary).toContain('共 5 条');
    expect(mocks.itListInternalTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: 'dept_garment' }),
    );
  });

  it('边界：id 模式供料单不存在 → ok=false NOT_FOUND', async () => {
    mocks.itGetInternalTransferById.mockResolvedValue(null);
    const result: any = await executeTool(prisma, { toolId: 'internal_trade.query', input: { id: 'it_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });

  it('边界：非法 status 枚举值被忽略（透传 undefined 给 service）', async () => {
    mocks.itListInternalTransfers.mockResolvedValue({ items: [], total: 0 });
    const result: any = await executeTool(prisma, {
      toolId: 'internal_trade.query',
      input: { status: 'NotAStatus' },
    } as any);
    expect(result.ok).toBe(true);
    expect(mocks.itListInternalTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// payment_requests.query
// ────────────────────────────────────────────────────────────────

describe('payment_requests.query', () => {
  it('正例：按状态过滤列表，返回条数与最新摘要', async () => {
    mocks.prListPaymentRequests.mockResolvedValue({
      items: [{ id: 'pr_1', requestNumber: 'PR-20260816-001', status: 'Pending', totalAmount: 12000, currency: 'CNY' }],
    });
    const result: any = await executeTool(prisma, {
      toolId: 'payment_requests.query',
      input: { status: 'Pending' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('PR-20260816-001');
    expect(mocks.prListPaymentRequests).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Pending' }),
    );
  });

  it('正例：id 模式返回详情，已生成凭证时 summary 含凭证号', async () => {
    mocks.prGetPaymentRequest.mockResolvedValue({
      item: {
        id: 'pr_1', requestNumber: 'PR-20260816-001', status: 'VoucherIssued',
        totalAmount: 12000, currency: 'CNY',
        paymentVoucher: { voucherNumber: 'PV-20260816-001' },
      },
    });
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.query', input: { id: 'pr_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('pr_1');
    expect(result.summary).toContain('PV-20260816-001');
    expect(mocks.prListPaymentRequests).not.toHaveBeenCalled();
  });

  it('边界：id 模式申请不存在 → ok=false NOT_FOUND', async () => {
    mocks.prGetPaymentRequest.mockResolvedValue({ item: null });
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.query', input: { id: 'pr_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// purchase_orders.query（W4 收尾）
// ────────────────────────────────────────────────────────────────

describe('purchase_orders.query', () => {
  it('正例：按状态+供应商过滤列表，透传过滤参数并返回 total', async () => {
    mocks.poListPurchaseOrders.mockResolvedValue({
      items: [{ id: 'po_1', poNumber: 'PO-20260816-001', status: 'Confirmed', supplierName: '某布行', totalAmount: 50000, currency: 'CNY' }],
      total: 1,
    });
    const result: any = await executeOrderLinkedTool({
      toolId: 'purchase_orders.query',
      input: { status: 'Confirmed', supplierRelationId: 'rel_sup1' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('PO-20260816-001');
    expect(mocks.poListPurchaseOrders).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Confirmed', supplierRelationId: 'rel_sup1' }),
    );
  });

  it('正例：id 模式返回详情，summary 含行数与到货记录数', async () => {
    mocks.poGetPurchaseOrder.mockResolvedValue({
      id: 'po_1', poNumber: 'PO-20260816-001', status: 'PartiallyReceived',
      supplierName: '某布行', totalAmount: 50000, currency: 'CNY',
      lines: [{ id: 'l1' }, { id: 'l2' }], receipts: [{ id: 'r1' }],
    });
    const result: any = await executeOrderLinkedTool({ toolId: 'purchase_orders.query', input: { id: 'po_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('po_1');
    expect(result.summary).toContain('2 行明细');
    expect(result.summary).toContain('1 条到货记录');
    expect(mocks.poListPurchaseOrders).not.toHaveBeenCalled();
  });

  it('边界：id 模式采购单不存在 → ok=false NOT_FOUND', async () => {
    mocks.poGetPurchaseOrder.mockResolvedValue(null);
    const result: any = await executeOrderLinkedTool({ toolId: 'purchase_orders.query', input: { id: 'po_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// bom.query（W4 收尾）
// ────────────────────────────────────────────────────────────────

describe('bom.query', () => {
  it('正例：按订单过滤列表，透传 orderId 并返回 total', async () => {
    mocks.bomListBOMs.mockResolvedValue({
      items: [{ id: 'bom_1', bomNumber: 'BOM-20260816-001', status: 'Confirmed', description: '男款西装', totalCost: 320, currency: 'CNY' }],
      total: 1,
    });
    const result: any = await executeOrderLinkedTool({
      toolId: 'bom.query',
      input: { orderId: 'ord_1' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('BOM-20260816-001');
    expect(mocks.bomListBOMs).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ord_1' }),
    );
  });

  it('正例：id 模式返回详情，summary 含版本/总成本/物料行数', async () => {
    mocks.bomGetBOM.mockResolvedValue({
      id: 'bom_1', bomNumber: 'BOM-20260816-001', version: 2, status: 'Confirmed',
      description: '男款西装外套', totalCost: 320.5, currency: 'CNY',
      lines: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }], costEstimates: [],
    });
    const result: any = await executeOrderLinkedTool({ toolId: 'bom.query', input: { id: 'bom_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('bom_1');
    expect(result.summary).toContain('v2');
    expect(result.summary).toContain('3 行物料');
    expect(mocks.bomListBOMs).not.toHaveBeenCalled();
  });

  it('边界：id 模式 BOM 不存在 → ok=false NOT_FOUND', async () => {
    mocks.bomGetBOM.mockResolvedValue(null);
    const result: any = await executeOrderLinkedTool({ toolId: 'bom.query', input: { id: 'bom_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// customs.query_tax_refunds（W4 收尾）
// ────────────────────────────────────────────────────────────────

describe('customs.query_tax_refunds', () => {
  it('正例：按状态过滤列表，透传 status 并返回 total', async () => {
    mocks.cxListTaxRefunds.mockResolvedValue({
      items: [{ id: 'tr_1', refundNumber: 'TR-20260816-001', status: 'Reviewing', refundAmount: 13000 }],
      total: 1,
    });
    const result: any = await executeTool(prisma, {
      toolId: 'customs.query_tax_refunds',
      input: { status: 'Reviewing' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('TR-20260816-001');
    expect(mocks.cxListTaxRefunds).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Reviewing' }),
    );
  });

  it('正例：id 模式返回详情，summary 含应退金额与退税率', async () => {
    mocks.cxGetTaxRefund.mockResolvedValue({
      id: 'tr_1', refundNumber: 'TR-20260816-001', status: 'Approved',
      refundAmount: 13000, exportAmountFob: 100000, exportAmountFobCurrency: 'USD', refundableRate: 13,
    });
    const result: any = await executeTool(prisma, { toolId: 'customs.query_tax_refunds', input: { id: 'tr_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('tr_1');
    expect(result.summary).toContain('13000');
    expect(result.summary).toContain('13%');
    expect(mocks.cxListTaxRefunds).not.toHaveBeenCalled();
  });

  it('边界：id 模式 service 抛错（不存在）→ ok=false NOT_FOUND', async () => {
    mocks.cxGetTaxRefund.mockRejectedValue(businessError('TAX_REFUND_NOT_FOUND', '退税记录 tr_x 不存在'));
    const result: any = await executeTool(prisma, { toolId: 'customs.query_tax_refunds', input: { id: 'tr_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// customs.query_declarations（W4 收尾）
// ────────────────────────────────────────────────────────────────

describe('customs.query_declarations', () => {
  it('正例：按订单过滤列表，透传 orderId 并返回 total', async () => {
    mocks.cxListDeclarations.mockResolvedValue({
      items: [{ id: 'cd_1', declarationNumber: 'CD-20260816-001', type: 'export', status: 'Released' }],
      total: 1,
    });
    const result: any = await executeOrderLinkedTool({
      toolId: 'customs.query_declarations',
      input: { orderId: 'ord_1' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.summary).toContain('CD-20260816-001');
    expect(mocks.cxListDeclarations).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ord_1' }),
    );
  });

  it('正例：id 模式返回详情，summary 含类型/状态/行数', async () => {
    mocks.cxGetDeclaration.mockResolvedValue({
      id: 'cd_1', declarationNumber: 'CD-20260816-001', type: 'export', status: 'Released',
      lines: [{ id: 'l1' }],
    });
    const result: any = await executeOrderLinkedTool({ toolId: 'customs.query_declarations', input: { id: 'cd_1' } } as any);
    expect(result.ok).toBe(true);
    expect(result.item.id).toBe('cd_1');
    expect(result.summary).toContain('export');
    expect(result.summary).toContain('1 行明细');
    expect(mocks.cxListDeclarations).not.toHaveBeenCalled();
  });

  it('边界：id 模式 service 抛错（不存在）→ ok=false NOT_FOUND', async () => {
    mocks.cxGetDeclaration.mockRejectedValue(businessError('DECLARATION_NOT_FOUND', '报关单 cd_x 不存在'));
    const result: any = await executeOrderLinkedTool({ toolId: 'customs.query_declarations', input: { id: 'cd_x' } } as any);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────────
// finance.query_allocations（W4 收尾）
// ────────────────────────────────────────────────────────────────

describe('finance.query_allocations', () => {
  it('正例：按发票过滤，summary 含笔数与核销金额合计', async () => {
    mocks.finListInvoiceAllocations.mockResolvedValue({
      items: [
        { id: 'ALLOC__inv_1__v_1', invoiceId: 'inv_1', voucherId: 'v_1', appliedAmount: 5000, appliedDate: '2026-08-10' },
        { id: 'ALLOC__inv_1__v_2', invoiceId: 'inv_1', voucherId: 'v_2', appliedAmount: 3000, appliedDate: '2026-08-12' },
      ],
      total: 2,
    });
    const result: any = await executeTool(prisma, {
      toolId: 'finance.query_allocations',
      input: { invoiceId: 'inv_1' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.summary).toContain('2 笔');
    expect(result.summary).toContain('8000.0000');
    expect(mocks.finListInvoiceAllocations).toHaveBeenCalledWith(
      expect.objectContaining({ sample: expect.anything() }),
      expect.objectContaining({ invoiceId: 'inv_1' }),
    );
  });

  it('边界：无核销记录 → ok=true 空列表合计 0', async () => {
    mocks.finListInvoiceAllocations.mockResolvedValue({ items: [], total: 0 });
    const result: any = await executeTool(prisma, {
      toolId: 'finance.query_allocations',
      input: { voucherId: 'v_x' },
    } as any);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(0);
    expect(result.summary).toContain('0 笔');
  });
});


describe('registered sample/tax-refund failure truth preserves original results', () => {
  it.each(['fabric_shipment', 'early_production'])('samples %s real empty remains success while SQL rejection is safe failure', async mode => {
    mocks.sampleFindMany.mockResolvedValue([]);
    const call: any = { toolId: 'samples.query', input: { mode, orderId: 'ord_empty' } };
    const empty: any = await executeTool(prisma, call);
    expect(empty.ok).toBe(true); expect(empty.items).toEqual([]);
    mocks.sampleFindMany.mockRejectedValue(new Error('private SQL table'));
    await expect(executeTool(prisma, call)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' });
  });
  it('garment source or eligibility dependency rejection is not a success observation', async () => {
    mocks.gsListRounds.mockRejectedValue(new Error('private SQL developmentCase'));
    await expect(executeTool(prisma, { toolId: 'samples.query', input: { mode: 'garment_rounds', caseId: 'case' } } as any))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    mocks.sampleFindMany.mockResolvedValue([]);
    mocks.qcCheckShipmentEligibility.mockRejectedValue(businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验权限'));
    await expect(executeTool(prisma, { toolId: 'samples.query', input: { orderId: 'order', includeEligibility: true } } as any))
      .rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE', statusCode: 503 });
  });
  it('tax-refund list actual empty remains success, unexpected detail/list failure never means NOT_FOUND', async () => {
    mocks.cxListTaxRefunds.mockResolvedValue({ items: [], total: 0 });
    const empty: any = await executeTool(prisma, { toolId: 'customs.query_tax_refunds', input: {} } as any);
    expect(empty).toMatchObject({ ok: true, items: [], total: 0 });
    mocks.cxListTaxRefunds.mockRejectedValue(new Error('private SQL taxrefund'));
    await expect(executeTool(prisma, { toolId: 'customs.query_tax_refunds', input: {} } as any)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    mocks.cxGetTaxRefund.mockRejectedValue(new Error('private SQL missing column'));
    await expect(executeTool(prisma, { toolId: 'customs.query_tax_refunds', input: { id: 'tr' } } as any)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
  });
});
