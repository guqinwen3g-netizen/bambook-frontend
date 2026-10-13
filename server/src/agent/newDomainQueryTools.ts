/**
 * newDomainQueryTools.ts — Phase 4 Track G：Phase 2 八域 Agent 只读查询工具
 *
 * 覆盖域（Phase 2 已落地后端域，与路由同一 service 真源）：
 *   1. MOQ 域            moq.query_config        — 当前生效 MOQ 阈值配置（含兜底常量回落标记）+ 可选变更历史
 *   2. 订单变更域        order_changes.query     — DR-010 变更/取消/暂停申请列表与详情
 *   3. 样品域            samples.query           — 面料寄船样/早期生产样/服装多轮样品（DR-008 双门禁）查询
 *   4. QC 双链域         qc.query_reports        — 订单 QC 报告列表（DR-029 服装链/面料链）+ 可选出运资格
 *   5. 受控例外域        exceptions.query        — DR-013 例外申请列表与详情（可信 Agent 路径纯读审批事实）
 *   6. 信用域            credit.query_status     — 客户信用状态（冻结门禁/最大逾期天数）+ 可选历史时间线
 *   7. 内部交易域        internal_trade.query    — DR-005/033 内部供料单列表与详情
 *   8. 付款申请域        payment_requests.query  — DR-017 付款申请列表与详情
 *
 * W4 收尾补齐（Agent 工具缺口 5 类，与各域路由同一 service 真源）：
 *   9. 采购域            purchase_orders.query        — 采购单列表（状态/供应商/日期窗/搜索）与详情（含行明细+到货记录）
 *  10. BOM 域           bom.query                    — BOM 列表（状态/产品/订单/报价过滤）与详情（含行明细+成本估算）
 *  11. 退税域           customs.query_tax_refunds    — 出口退税记录列表（状态/报关单/订单/客户过滤）与详情
 *  12. 报关单域         customs.query_declarations   — 报关单列表（类型/状态/运单/订单/客户过滤）与详情（含行明细）
 *  13. 核销明细域       finance.query_allocations    — 收付款核销明细列表（按发票/凭证过滤，allocationService 真源）
 *
 * 铁律：
 *   - 全部只读：risk=low + approvalPolicy=never，不触发审批链、不写库
 *   - 直接调用各域 service 层函数（与路由同一真源），禁止绕过 service 直查 prisma
 *   - 返回结构化数据 + 人类可读 summary（供 agentLoop observation 直接展示）
 *   - import 廉价：域 service 工厂在 handler 内惰性加载（本模块被 toolRegistry/toolRuntime
 *     全图引用，顶层不得传递依赖各域 service 的模块层求值，避免与既有测试的模块级
 *     total-mock 产生导入链耦合）；仅 INTERNAL_TRANSFER_STATUSES 例外（其宿主模块顶层
 *     仅依赖 logger/audit/crypto，且 inputSchema 枚举需在定义期取值）
 */

import type { PrismaClient } from '@prisma/client';
import { registerTool } from './toolDispatchRegistry';
import type { ToolDefinition } from './toolRegistry';
import { INTERNAL_TRANSFER_STATUSES } from '../internalTrade/internalTransferService';
import { serializeValue } from '../lib/serializeValue';
import type { ToolExecutionContext } from './toolDispatchRegistry';
import { toolActorToken } from './toolActorContext';
import { localDateKey } from '../shared/localDate';


// ───────────────────────────────────────────────────────────────────
// 通用辅助
// ───────────────────────────────────────────────────────────────────

function numberInput(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function strInput(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/** 依赖 approvalCreateService 的域服务构造（与各域 route 同一线路，仅用于其只读函数；惰性加载） */
async function makeApprovalCreateService(prisma: PrismaClient) {
  const { createApprovalRoutingService } = await import('../approvals/approvalRoutingService');
  const { createApprovalCreateService } = await import('../approvals/approvalCreateService');
  const routingService = createApprovalRoutingService({ prisma });
  return createApprovalCreateService({ prisma, routingService });
}

function failResult(code: string, message: string) {
  return { ok: false, error: message, errorCode: code, summary: message };
}

/** Query failure is not a business empty set or missing record. Preserve
 * native typed service refusals; hide unexpected storage details from Agent. */
async function readQuery<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    const { businessError, isBusinessError, lookupErrorCode } = await import('../shared/errorCodes');
    if (isBusinessError(error)) throw error;
    throw businessError('INTERNAL_ERROR', lookupErrorCode('INTERNAL_ERROR')!.message);
  }
}

// ───────────────────────────────────────────────────────────────────
// P0-B ToolDefinition（risk=low + approvalPolicy=never，只读四切片语义）
// ───────────────────────────────────────────────────────────────────

export const NEW_DOMAIN_QUERY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'moq.query_config',
    name: 'Query MOQ Config',
    scope: 'settings',
    risk: 'low',
    description: '查询当前生效的 MOQ 最小起订量阈值配置（面料/成衣/Capsule 三档），配置缺失时回落兜底常量并标记来源；可选附带阈值变更历史（append-only）。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        includeHistory: { type: 'boolean', description: '是否附带阈值变更历史（默认 false）' },
        historyLimit: { type: 'number', description: '变更历史条数上限（默认 50，最大 200）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        config: { type: ['object', 'null'] },
        effectiveValues: { type: 'object' },
        source: { type: 'string', enum: ['moq_config', 'fallback_constant'] },
        history: { type: 'array' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'order_changes.query',
    name: 'Query Order Change Requests',
    scope: 'orders',
    risk: 'low',
    description: '查询 DR-010 订单变更/取消/暂停申请：按订单、状态、申请人过滤列表，或按申请 ID 读取单条详情（含关联订单与审批单快照）。用于回答某订单有哪些变更记录、某变更申请审批进度等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '变更申请 ID（提供时返回单条详情）' },
        orderId: { type: 'string', description: '按订单 ID 过滤' },
        status: { type: 'string', description: '按状态过滤（Pending/Approved/Applied/Cancelled 等）' },
        requesterId: { type: 'string', description: '按申请人过滤' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'samples.query',
    name: 'Query Samples',
    scope: 'samples',
    risk: 'low',
    description: '查询样品记录：fabric_shipment 模式按订单列出面料寄船样/头缸样（含 Exmill 倒计时，可选发货资格判定）；early_production 模式按订单列出投产后早期生产样轮次；garment_rounds 模式按开发案列出服装多轮样品及封样状态（DR-008 双门禁）。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fabric_shipment', 'early_production', 'garment_rounds'], description: '查询模式（默认 fabric_shipment）' },
        orderId: { type: 'string', description: '订单 ID（fabric_shipment / early_production 模式必填）' },
        caseId: { type: 'string', description: '开发案 ID（garment_rounds 模式必填）' },
        includeEligibility: { type: 'boolean', description: 'fabric_shipment 模式下附带 DR-012 发货资格判定' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        sealedRoundId: { type: ['string', 'null'] },
        eligibility: { type: 'object' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'qc.query_reports',
    name: 'Query QC Reports',
    scope: 'qc',
    risk: 'low',
    description: '按订单查询 QC 报告列表（DR-029 服装链/面料链：报告状态、结论、缺陷统计），可选附带 QC 侧出运资格判定（报告是否齐备/通过）。用于回答某订单验货结果、能否出货等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: '订单 ID（必填）' },
        includeEligibility: { type: 'boolean', description: '附带 QC 出运资格判定（默认 false）' },
      },
      required: ['orderId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        total: { type: 'number' },
        eligibility: { type: 'object' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'exceptions.query',
    name: 'Query Controlled Exceptions',
    scope: 'exceptions',
    risk: 'low',
    description: '查询 DR-013 受控例外申请：按状态、例外类别、申请人过滤列表，或按申请 ID 读取单条详情（惰性对账审批结论后返回）。用于回答某订单是否有生效中的例外放行、某例外申请审批进度等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '例外申请 ID（提供时返回单条详情）' },
        status: { type: 'string', description: '按状态过滤（Pending/ReviewerApproved/BossFinalBypass/Consumed/Expired/Cancelled 等）' },
        exceptionCategory: { type: 'string', description: '按例外类别过滤' },
        requesterId: { type: 'string', description: '按申请人过滤' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'credit.query_status',
    name: 'Query Customer Credit Status',
    scope: 'credit',
    risk: 'low',
    description: '查询客户信用状态：额度总额/已占用/剩余、冻结门禁标记（creditFrozen）、最大逾期天数；可选附带冻结/解冻/占用释放全事件历史时间线（append-only）。用于回答某客户额度还剩多少、是否被冻结、为何冻结等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        relationId: { type: 'string', description: '客户 Relation ID（必填；只有客户名时先 relations.query 解析）' },
        includeHistory: { type: 'boolean', description: '是否附带信用历史时间线（默认 false）' },
        historyLimit: { type: 'number', description: '历史条数上限（默认 100，最大 500）' },
      },
      required: ['relationId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        status: { type: 'object' },
        history: { type: 'array' },
        historyTotal: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'internal_trade.query',
    name: 'Query Internal Transfers',
    scope: 'internal_trade',
    risk: 'low',
    description: '查询 DR-005/033 内部供料单（服装部向面料部的内部交易）：按部门、状态、服装订单、面料订单过滤列表，或按供料单 ID 读取单条详情（master + mirror + 解码载荷）。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '内部供料单 ID（提供时返回单条详情）' },
        departmentId: { type: 'string', description: '按申请部门过滤' },
        status: { type: 'string', enum: [...INTERNAL_TRANSFER_STATUSES], description: '按状态过滤' },
        garmentOrderId: { type: 'string', description: '按服装订单过滤' },
        fabricOrderId: { type: 'string', description: '按面料订单过滤' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
        offset: { type: 'number', description: '列表偏移（默认 0）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'payment_requests.query',
    name: 'Query Payment Requests',
    scope: 'finance',
    risk: 'low',
    description: '查询 DR-017 付款申请（先申请后付款）：按状态、付款性质、申请人过滤列表，或按申请 ID 读取单条详情（含关联审批单与付款凭证快照）。用于回答某供应商付款申请进度、是否已生成付款凭证等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '付款申请 ID（提供时返回单条详情）' },
        status: { type: 'string', description: '按状态过滤（Draft/Pending/Approved/Rejected/VoucherIssued/Cancelled）' },
        paymentCategory: { type: 'string', description: '按付款性质过滤（normal/advance/deposit/三类费用）' },
        applicantId: { type: 'string', description: '按申请人过滤' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  // ── W4 收尾：Agent 工具缺口 5 类 ──
  {
    id: 'purchase_orders.query',
    name: 'Query Purchase Orders',
    scope: 'procurement',
    risk: 'low',
    description: '查询采购单：按状态、供应商、下单日期窗、单号/供应商名搜索过滤列表，或按采购单 ID 读取单条详情（含行明细与到货记录）。用于回答某订单的采购执行情况、某供应商有哪些在途采购单等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '采购单 ID（提供时返回单条详情）' },
        status: { type: 'string', description: '按状态过滤（Draft/Sent/Confirmed/PartiallyReceived/Received/Closed/Cancelled）' },
        supplierRelationId: { type: 'string', description: '按供应商 Relation ID 过滤' },
        dateFrom: { type: 'string', description: '下单日期起（YYYY-MM-DD）' },
        dateTo: { type: 'string', description: '下单日期止（YYYY-MM-DD）' },
        search: { type: 'string', description: '短文本搜索（采购单号/供应商名）' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
        offset: { type: 'number', description: '列表偏移（默认 0）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'bom.query',
    name: 'Query BOMs',
    scope: 'bom',
    risk: 'low',
    description: '查询 BOM 物料清单：按状态、产品档案、订单、报价单过滤列表，或按 BOM ID 读取单条详情（含行明细与成本估算，料/工/费汇总与利润分析）。用于回答某订单的物料构成、某款产品的成本结构等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'BOM ID（提供时返回单条详情）' },
        status: { type: 'string', description: '按状态过滤（Draft/Confirmed/Archived）' },
        productAssetId: { type: 'string', description: '按产品档案过滤' },
        orderId: { type: 'string', description: '按订单过滤' },
        quotationId: { type: 'string', description: '按报价单过滤' },
        search: { type: 'string', description: '短文本搜索（BOM 号/描述）' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
        offset: { type: 'number', description: '列表偏移（默认 0）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'customs.query_tax_refunds',
    name: 'Query Tax Refunds',
    scope: 'customs',
    risk: 'low',
    description: '查询出口退税记录：按状态、报关单、订单、客户过滤列表，或按退税记录 ID 读取单条详情（含 FOB 金额/退税率/应退金额/审核信息）。用于回答某订单退税进度、哪些退税审核滞留等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '退税记录 ID（提供时返回单条详情）' },
        status: { type: 'string', description: '按状态过滤（Draft/Submitted/Reviewing/Approved/Rejected/Refunded/Cancelled）' },
        declarationId: { type: 'string', description: '按报关单过滤' },
        orderId: { type: 'string', description: '按订单过滤' },
        relationId: { type: 'string', description: '按客户 Relation ID 过滤' },
        search: { type: 'string', description: '短文本搜索（退税申报编号）' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
        offset: { type: 'number', description: '列表偏移（默认 0）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'customs.query_declarations',
    name: 'Query Customs Declarations',
    scope: 'customs',
    risk: 'low',
    description: '查询报关单：按类型、状态、运单、订单、客户过滤列表，或按报关单 ID 读取单条详情（含行明细）。用于回答某票出运的报关状态、某订单的报关单号等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '报关单 ID（提供时返回单条详情）' },
        type: { type: 'string', description: '按类型过滤（export/import 等）' },
        status: { type: 'string', description: '按状态过滤（Draft/Submitted/Released/Cleared 等）' },
        shipmentId: { type: 'string', description: '按运单过滤' },
        orderId: { type: 'string', description: '按订单过滤' },
        relationId: { type: 'string', description: '按客户 Relation ID 过滤' },
        search: { type: 'string', description: '短文本搜索（报关单号/收发货人/申报单位）' },
        limit: { type: 'number', description: '列表条数上限（默认 100，最大 500）' },
        offset: { type: 'number', description: '列表偏移（默认 0）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        item: { type: ['object', 'null'] },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'finance.query_allocations',
    name: 'Query Invoice Allocations',
    scope: 'finance',
    risk: 'low',
    description: '查询收付款核销明细（InvoiceAllocation）：按发票或收款凭证过滤，返回每笔核销的 appliedAmount/appliedDate。用于回答某发票已核销多少、某笔收款分配到哪些发票等问题。只读，无副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: '按发票 ID 过滤' },
        voucherId: { type: 'string', description: '按收/付款凭证 ID 过滤' },
        limit: { type: 'number', description: '列表条数上限（默认 200，最大 500）' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        total: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    approvalPolicy: 'never',
  },
];

// ───────────────────────────────────────────────────────────────────
// Handlers（直接调用各域 service 层函数，与路由同一真源）
// ───────────────────────────────────────────────────────────────────

async function handleMoqQueryConfig(prisma: PrismaClient, input: Record<string, unknown>) {
  const { createMoqConfigService, MOQ_FALLBACK_CONSTANTS } = await import('../moq/moqConfigService');
  const svc = createMoqConfigService({ prisma });
  const config = await svc.getActiveConfig();
  const source = config ? 'moq_config' : 'fallback_constant';
  const effective = config ?? MOQ_FALLBACK_CONSTANTS;
  const includeHistory = input.includeHistory === true;
  const history = includeHistory
    ? await svc.listHistory({ limit: numberInput(input.historyLimit, 50) })
    : undefined;
  const summary = config
    ? `当前生效 MOQ 阈值：面料 ${effective.fabricDefaultMoq} / 成衣 ${effective.garmentDefaultMoq} / Capsule ${effective.capsuleMoq}（${localDateKey(new Date(config.effectiveFrom))} 起生效，由 ${config.changedBy} 调整）`
    : `MOQ 配置未初始化或读取失败，当前使用兜底常量：面料 ${effective.fabricDefaultMoq} / 成衣 ${effective.garmentDefaultMoq} / Capsule ${effective.capsuleMoq}`;
  return serializeValue({
    ok: true,
    config,
    effectiveValues: {
      fabricDefaultMoq: effective.fabricDefaultMoq,
      garmentDefaultMoq: effective.garmentDefaultMoq,
      capsuleMoq: effective.capsuleMoq,
    },
    source,
    ...(history ? { history } : {}),
    summary,
  });
}

async function handleOrderChangesQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const { createOrderChangeRequestService } = await import('../orderChanges/orderChangeRequestService');
  const svc = createOrderChangeRequestService({ prisma, approvalCreateService: await makeApprovalCreateService(prisma) });
  const id = strInput(input.id);
  if (id) {
    const { item } = await readQuery(() => svc.getChangeRequest(id, context?.actor ? toolActorToken(context.actor) : undefined));
    if (!item) return failResult('NOT_FOUND', `变更申请 ${id} 不存在或已删除`);
    return serializeValue({
      ok: true,
      item,
      summary: `变更申请 ${item.requestNumber}：类型 ${(item.changeTypes ?? []).join('/') || 'other'}，状态 ${item.status}，订单 ${item.order?.poNumber ?? item.orderId}`,
    });
  }
  const { items } = await readQuery(() => svc.listChangeRequests({
    orderId: strInput(input.orderId),
    status: strInput(input.status),
    requesterId: strInput(input.requesterId),
    limit: numberInput(input.limit, 100),
    trustedActor: context?.actor ? toolActorToken(context.actor) : undefined,
  }));
  return serializeValue({
    ok: true,
    items,
    total: items.length,
    summary: `共 ${items.length} 条变更申请${items.length > 0 ? `（最新：${items[0].requestNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

async function handleSamplesQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const mode = strInput(input.mode) ?? 'fabric_shipment';

  if (mode === 'garment_rounds') {
    const caseId = strInput(input.caseId);
    if (!caseId) return failResult('MISSING_CASE_ID', 'garment_rounds 模式必须提供 caseId（开发案 ID）');
    const { createGarmentSampleGateService } = await import('../samples/garmentSampleGateService');
    const svc = createGarmentSampleGateService({ prisma });
    const r = await readQuery(() => svc.listRounds({ caseId, trustedActor:context?.actor?toolActorToken(context.actor):undefined }));
    if (!r.ok) return failResult(r.error.code, r.error.message);
    return serializeValue({
      ok: true,
      items: r.data.items,
      sealedRoundId: r.data.sealedRoundId,
      summary: `开发案 ${caseId} 共 ${r.data.items.length} 轮服装样品${r.data.sealedRoundId ? '，已封样' : '，尚未封样'}`,
    });
  }

  const orderId = strInput(input.orderId);
  if (!orderId) return failResult('MISSING_ORDER_ID', `${mode} 模式必须提供 orderId（订单 ID）`);

  if (mode === 'early_production') {
    // DR-054 阶段 G：先锋样（早产样）统一为 Sample(type='pioneer') 挂 sourceOrderId
    const items = await readQuery<any[]>(() => (prisma as any).sample.findMany({ where: { sourceOrderId: orderId, type: 'pioneer', deletedAt: null }, orderBy: { createdAt: 'desc' } }));
    return serializeValue({
      ok: true,
      items,
      summary: `订单 ${orderId} 共 ${items.length} 条先锋样（早产样）记录`,
    });
  }

  // 默认 fabric_shipment：面料寄船样/匹头样（Roll Cut）——统一为 Sample(type=ship/head) 挂 sourceOrderId
  const items = await readQuery<any[]>(() => (prisma as any).sample.findMany({ where: { sourceOrderId: orderId, type: { in: ['ship', 'head'] }, deletedAt: null }, orderBy: { createdAt: 'desc' } }));
  let eligibility: unknown;
  if (input.includeEligibility === true) {
    const { createQcService } = await import('../qc/qcService');
    const svc = createQcService(prisma);
    const e = await readQuery(() => svc.checkShipmentEligibility(orderId));
    eligibility = e.eligible;
  }
  return serializeValue({
    ok: true,
    items,
    ...(eligibility ? { eligibility } : {}),
    summary: `订单 ${orderId} 共 ${items.length} 条面料大货样品记录（船样/匹头样）${eligibility ? `，发货资格：${eligibility === true ? '具备' : '不具备'}` : ''}`,
  });
}

async function handleQcQueryReports(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const orderId = strInput(input.orderId);
  if (!orderId) return failResult('MISSING_ORDER_ID', '必须提供 orderId（订单 ID）');
  const { createQcService } = await import('../qc/qcService');
  const svc = createQcService(prisma);
  const actor = context?.actor ? toolActorToken(context.actor) : null;
  const { items, total } = await svc.listReportsByOrder(orderId, actor);
  let eligibility: unknown;
  if (input.includeEligibility === true) {
    const { qcReportOrderAccess } = await import('../qc/qcReportAuthority');
    await qcReportOrderAccess(prisma, actor, orderId);
    eligibility = await svc.checkShipmentEligibility(orderId);
  }
  return serializeValue({
    ok: true,
    items,
    total,
    ...(eligibility ? { eligibility } : {}),
    summary: `订单 ${orderId} 共 ${total} 份 QC 报告${eligibility ? `，QC 出运资格：${(eligibility as any).eligible === true ? '具备' : '不具备'}` : ''}`,
  });
}

async function handleExceptionsQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const { createExceptionService } = await import('../exceptions/exceptionService');
  const svc = createExceptionService({ prisma, approvalCreateService: await makeApprovalCreateService(prisma) });
  const id = strInput(input.id);
  if (id) {
    const r = context?.actor ? await svc.getExceptionReadonly(id) : await svc.getExceptionById(id);
    if (!r.ok) return failResult(r.error.code, r.error.message);
    return serializeValue({
      ok: true,
      item: r.data.exception,
      summary: `例外申请 ${r.data.exception.requestNumber ?? id}：类别 ${r.data.exception.exceptionCategory}，状态 ${r.data.exception.status}`,
    });
  }
  const list = context?.actor ? svc.listExceptionsReadonly : svc.listExceptions;
  const r = await list({
    status: strInput(input.status),
    exceptionCategory: strInput(input.exceptionCategory),
    requesterId: strInput(input.requesterId),
    limit: numberInput(input.limit, 100),
  });
  if (!r.ok) return failResult(r.error.code, r.error.message);
  return serializeValue({
    ok: true,
    items: r.data.items,
    total: r.data.items.length,
    summary: `共 ${r.data.items.length} 条例外申请`,
  });
}

async function handleCreditQueryStatus(prisma: PrismaClient, input: Record<string, unknown>) {
  const relationId = strInput(input.relationId);
  if (!relationId) return failResult('MISSING_RELATION_ID', '必须提供 relationId（客户 Relation ID）');
  const { createCreditService } = await import('../credit/creditService');
  const svc = createCreditService({ prisma });
  const status = await svc.getCreditStatus(relationId);
  if (!status) return failResult('NOT_FOUND', `客户 ${relationId} 不存在`);
  let history: unknown;
  let historyTotal: number | undefined;
  if (input.includeHistory === true) {
    const h = await svc.getCreditHistory({ relationId, limit: numberInput(input.historyLimit, 100) });
    if (h.ok) {
      history = h.data.items;
      historyTotal = h.data.total;
    }
  }
  const summary = !status.hasCreditLimit
    ? `客户 ${relationId} 未设置信用额度（最大逾期 ${status.maxOverdueDays} 天）`
    : `客户 ${relationId} 信用状态 ${status.status}：额度 ${status.totalLimit} ${status.currency ?? ''}，已占用 ${status.usedAmount}，剩余 ${status.remaining}${status.creditFrozen ? '（已冻结，禁止新订单）' : ''}，最大逾期 ${status.maxOverdueDays} 天`;
  return serializeValue({
    ok: true,
    status,
    ...(history ? { history, historyTotal } : {}),
    summary,
  });
}

async function handleInternalTradeQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const { createInternalTransferService } = await import('../internalTrade/internalTransferService');
  const svc = createInternalTransferService({ prisma, approvalCreateService: await makeApprovalCreateService(prisma) });
  const id = strInput(input.id);
  if (id) {
    const r = await svc.getInternalTransferById(id, context?.actor ? toolActorToken(context.actor) : undefined);
    if (!r) return failResult('NOT_FOUND', `内部供料单 ${id} 不存在或已删除`);
    return serializeValue({
      ok: true,
      item: r,
      summary: `内部供料单 ${id}：状态 ${r.payload?.status ?? '未知'}，物料 ${r.payload?.materialCode ?? '-'}`,
    });
  }
  const statusRaw = strInput(input.status);
  const status = statusRaw && (INTERNAL_TRANSFER_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as (typeof INTERNAL_TRANSFER_STATUSES)[number])
    : undefined;
  const { items, total } = await svc.listInternalTransfers({
    departmentId: strInput(input.departmentId),
    status,
    garmentOrderId: strInput(input.garmentOrderId),
    fabricOrderId: strInput(input.fabricOrderId),
    limit: numberInput(input.limit, 100),
    offset: Math.max(0, Number(input.offset) || 0),
    trustedActor: context?.actor ? toolActorToken(context.actor) : undefined,
  });
  return serializeValue({
    ok: true,
    items,
    total,
    summary: `共 ${total} 条内部供料单（本页 ${items.length} 条）`,
  });
}

async function handlePaymentRequestsQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const { createPaymentRequestService } = await import('../paymentRequests/paymentRequestService');
  const svc = createPaymentRequestService({ prisma, approvalCreateService: await makeApprovalCreateService(prisma) });
  // Formal Agent paths always carry server context; raw executeTool remains an
  // internal legacy helper. User-supplied input.actor is never consulted.
  const scope = context?.actor ? await (async () => {
    const { createPermissionService } = await import('../auth/permissionService');
    const { buildPaymentRequestScope } = await import('../paymentRequests/paymentRequestScope');
    return buildPaymentRequestScope(
      await createPermissionService({ prisma }).getDataScopeResolver(toolActorToken(context.actor!), 'paymentRequests'),
      context.actor!.userId,
    );
  })() : undefined;
  const id = strInput(input.id);
  if (id) {
    const { item } = await svc.getPaymentRequest(id, scope, context?.actor ? toolActorToken(context.actor) : undefined);
    if (!item) return failResult('NOT_FOUND', `付款申请 ${id} 不存在或已删除`);
    return serializeValue({
      ok: true,
      item,
      summary: `付款申请 ${item.requestNumber}：${item.totalAmount} ${item.currency}，状态 ${item.status}${item.paymentVoucher ? `，已生成凭证 ${item.paymentVoucher.voucherNumber}` : ''}`,
    });
  }
  const { items } = await svc.listPaymentRequests({
    actor: context?.actor ? toolActorToken(context.actor) : undefined,
    status: strInput(input.status),
    paymentCategory: strInput(input.paymentCategory),
    applicantId: strInput(input.applicantId),
    limit: numberInput(input.limit, 100),
    ...(scope ? { scopeWhere: scope.where } : {}),
  });
  return serializeValue({
    ok: true,
    items,
    total: items.length,
    summary: `共 ${items.length} 条付款申请${items.length > 0 ? `（最新：${items[0].requestNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

// ── W4 收尾：Agent 工具缺口 5 类 handlers ──


/** Formal query authority is the server dispatch context. Refresh actual DB
 * grants and personnel roles, preserving the initiating credential ceiling;
 * neither tool input nor an old owner label can reconstruct revoked scopes. */
async function currentOrderLinkedQueryActor(prisma: PrismaClient, context: ToolExecutionContext | undefined, scope: 'procurement:read' | 'bom:read' | 'customs:read') {
  const { businessError, isBusinessError, lookupErrorCode } = await import('../shared/errorCodes');
  const prior = context?.actor ? toolActorToken(context.actor) : null;
  if (!prior?.userId) throw businessError('UNAUTHORIZED', lookupErrorCode('UNAUTHORIZED')!.message);
  const { loadUserWithRoles, buildLoadedAuthTokenPayload } = await import('../auth/tokenHelpers');
  let current;
  try {
    const user = await loadUserWithRoles(prisma, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', lookupErrorCode('ACCOUNT_DISABLED')!.message);
    current = await buildLoadedAuthTokenPayload(prisma, user);
  } catch (error) {
    if (isBusinessError(error) && error.code === 'ACCOUNT_DISABLED') throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', lookupErrorCode('AUTHORIZATION_UNAVAILABLE')!.message);
  }
  if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
  const { hasScope } = await import('../auth/permissionService');
  if (!hasScope({ ...current, roles: [] }, scope)) throw businessError('FORBIDDEN', lookupErrorCode('FORBIDDEN')!.message);
  return current;
}

async function handlePurchaseOrdersQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const actor = await currentOrderLinkedQueryActor(prisma, context, 'procurement:read');
  const { resolveVisibleOrderIds, isOrderLinkedVisible } = await import('../auth/orderVisibility');
  const visibleOrderIds = await resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true });
  const { createProcurementService } = await import('../procurement/procurementService');
  const svc = createProcurementService(prisma);
  const id = strInput(input.id);
  if (id) {
    const item = await svc.getPurchaseOrder(id);
    if (!item || !isOrderLinkedVisible(visibleOrderIds, item.orderId)) return failResult('NOT_FOUND', `采购单 ${id} 不存在或已删除`);
    return serializeValue({
      ok: true,
      item,
      summary: `采购单 ${item.poNumber}：供应商 ${item.supplierName ?? '-'}，金额 ${item.totalAmount} ${item.currency}，状态 ${item.status}，${item.lines?.length ?? 0} 行明细 / ${item.receipts?.length ?? 0} 条到货记录`,
    });
  }
  const { items, total } = await svc.listPurchaseOrders({
    visibleOrderIds,
    status: strInput(input.status),
    supplierRelationId: strInput(input.supplierRelationId),
    dateFrom: strInput(input.dateFrom),
    dateTo: strInput(input.dateTo),
    search: strInput(input.search),
    limit: numberInput(input.limit, 100),
    offset: Math.max(0, Number(input.offset) || 0),
  });
  return serializeValue({
    ok: true,
    items,
    total,
    summary: `共 ${total} 张采购单（本页 ${items.length} 张）${items.length > 0 ? `（最新：${items[0].poNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

async function handleBomQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const actor = await currentOrderLinkedQueryActor(prisma, context, 'bom:read');
  const { resolveVisibleOrderIds, isOrderLinkedVisible } = await import('../auth/orderVisibility');
  const { hasScope } = await import('../auth/permissionService');
  const { maskBomDetail, maskBomListItem } = await import('../bom/sensitiveMask');
  const visibleOrderIds = await resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true });
  const visibility = { cost: hasScope({ ...actor, roles: [] }, 'sensitive:cost') };
  const { createBOMService } = await import('../bom/bomService');
  const svc = createBOMService(prisma);
  const id = strInput(input.id);
  if (id) {
    const source = await svc.getBOM(id);
    if (!source || (source.orderId && !isOrderLinkedVisible(visibleOrderIds, source.orderId))) return failResult('NOT_FOUND', `BOM ${id} 不存在或已删除`);
    const item = maskBomDetail(source, visibility);
    return serializeValue({
      ok: true,
      item,
      summary: `BOM ${item.bomNumber}（v${item.version}）：${item.description}，状态 ${item.status}${visibility.cost ? `，总成本 ${item.totalCost} ${item.currency}` : ''}，${item.lines?.length ?? 0} 行物料`,
    });
  }
  const { items, total } = await svc.listBOMs({
    visibleOrderIds,
    status: strInput(input.status),
    productAssetId: strInput(input.productAssetId),
    orderId: strInput(input.orderId),
    quotationId: strInput(input.quotationId),
    search: strInput(input.search),
    limit: numberInput(input.limit, 100),
    offset: Math.max(0, Number(input.offset) || 0),
  });
  return serializeValue({
    ok: true,
    items: items.map(item => maskBomListItem(item, visibility)),
    total,
    summary: `共 ${total} 份 BOM（本页 ${items.length} 份）${items.length > 0 ? `（最新：${items[0].bomNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

async function handleTaxRefundsQuery(prisma: PrismaClient, input: Record<string, unknown>) {
  const { isBusinessError } = await import('../shared/errorCodes');
  const { createCustomsService } = await import('../customs/customsService');
  const svc = createCustomsService(prisma);
  const id = strInput(input.id);
  if (id) {
    try {
      const item = await readQuery(() => svc.getTaxRefund(id));
      return serializeValue({
        ok: true,
        item,
        summary: `退税记录 ${item.refundNumber}：状态 ${item.status}，应退 ${item.refundAmount ?? '-'} CNY（FOB ${item.exportAmountFob ?? '-'} ${item.exportAmountFobCurrency ?? ''}，退税率 ${item.refundableRate ?? '-'}%）`,
      });
    } catch (error) {
      if (isBusinessError(error) && error.code === 'TAX_REFUND_NOT_FOUND') return failResult('NOT_FOUND', `退税记录 ${id} 不存在或已删除`);
      throw error;
    }
  }
  const { items, total } = await readQuery(() => svc.listTaxRefunds({
    status: strInput(input.status),
    declarationId: strInput(input.declarationId),
    orderId: strInput(input.orderId),
    relationId: strInput(input.relationId),
    search: strInput(input.search),
    limit: numberInput(input.limit, 100),
    offset: Math.max(0, Number(input.offset) || 0),
  }));
  return serializeValue({
    ok: true,
    items,
    total,
    summary: `共 ${total} 条退税记录（本页 ${items.length} 条）${items.length > 0 ? `（最新：${items[0].refundNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

async function handleCustomsDeclarationsQuery(prisma: PrismaClient, input: Record<string, unknown>, context?: ToolExecutionContext) {
  const actor = await currentOrderLinkedQueryActor(prisma, context, 'customs:read');
  const { resolveVisibleOrderIds, resolveVisibleShipmentIds } = await import('../auth/orderVisibility');
  const { businessError, isBusinessError, lookupErrorCode } = await import('../shared/errorCodes');
  const visibleOrderIds = await resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true });
  const visibleShipmentIds = visibleOrderIds ? await resolveVisibleShipmentIds(prisma, visibleOrderIds, { strict: true }) : undefined;
  const { createCustomsService } = await import('../customs/customsService');
  const svc = createCustomsService(prisma);
  const id = strInput(input.id);
  if (id) {
    try {
      const item = await svc.getDeclaration(id);
      if (visibleOrderIds && !((item.orderId && visibleOrderIds.includes(item.orderId))
        || (item.shipmentId && visibleShipmentIds!.includes(item.shipmentId)))) return failResult('NOT_FOUND', `报关单 ${id} 不存在或已删除`);
      return serializeValue({
        ok: true,
        item,
        summary: `报关单 ${item.declarationNumber}：类型 ${item.type}，状态 ${item.status}，${item.lines?.length ?? 0} 行明细`,
      });
    } catch (error) {
      if (isBusinessError(error) && error.code === 'DECLARATION_NOT_FOUND') return failResult('NOT_FOUND', `报关单 ${id} 不存在或已删除`);
      throw businessError('INTERNAL_ERROR', lookupErrorCode('INTERNAL_ERROR')!.message);
    }
  }
  const { items, total } = await svc.listDeclarations({
    visibleOrderIds,
    visibleShipmentIds,
    type: strInput(input.type),
    status: strInput(input.status),
    shipmentId: strInput(input.shipmentId),
    orderId: strInput(input.orderId),
    relationId: strInput(input.relationId),
    search: strInput(input.search),
    limit: numberInput(input.limit, 100),
    offset: Math.max(0, Number(input.offset) || 0),
  }).catch(() => { throw businessError('INTERNAL_ERROR', lookupErrorCode('INTERNAL_ERROR')!.message); });
  return serializeValue({
    ok: true,
    items,
    total,
    summary: `共 ${total} 份报关单（本页 ${items.length} 份）${items.length > 0 ? `（最新：${items[0].declarationNumber}，状态 ${items[0].status}）` : ''}`,
  });
}

async function handleFinanceAllocationsQuery(prisma: PrismaClient, input: Record<string, unknown>) {
  const { listInvoiceAllocations } = await import('../finance/allocationService');
  const { items, total } = await listInvoiceAllocations(prisma, {
    invoiceId: strInput(input.invoiceId),
    voucherId: strInput(input.voucherId),
    limit: numberInput(input.limit, 200),
  });
  const sum = items.reduce((acc: number, a: any) => acc + Number(a.appliedAmount ?? 0), 0);
  return serializeValue({
    ok: true,
    items,
    total,
    summary: `共 ${total} 笔核销明细，核销金额合计 ${sum.toFixed(4)}${items.length > 0 ? `（最新：发票 ${items[0].invoiceId} ↔ 凭证 ${items[0].voucherId}，金额 ${items[0].appliedAmount}）` : ''}`,
  });
}

// ───────────────────────────────────────────────────────────────────
// 注册入口（toolRuntime 一次性接线）
// ───────────────────────────────────────────────────────────────────

export function registerNewDomainQueryTools(): void {
  registerTool('moq.query_config', (prisma, input) => handleMoqQueryConfig(prisma, input));
  registerTool('order_changes.query', (prisma, input, _call, context) => handleOrderChangesQuery(prisma, input, context));
  registerTool('samples.query', (prisma, input, _call, context) => handleSamplesQuery(prisma, input, context));
  registerTool('qc.query_reports', (prisma, input, _call, context) => handleQcQueryReports(prisma, input, context));
  registerTool('exceptions.query', (prisma, input, _call, context) => handleExceptionsQuery(prisma, input, context));
  registerTool('credit.query_status', (prisma, input) => handleCreditQueryStatus(prisma, input));
  registerTool('internal_trade.query', (prisma, input, _call, context) => handleInternalTradeQuery(prisma, input, context));
  registerTool('payment_requests.query', (prisma, input, _call, context) => handlePaymentRequestsQuery(prisma, input, context));
  registerTool('purchase_orders.query', (prisma, input, _call, context) => handlePurchaseOrdersQuery(prisma, input, context));
  registerTool('bom.query', (prisma, input, _call, context) => handleBomQuery(prisma, input, context));
  registerTool('customs.query_tax_refunds', (prisma, input) => handleTaxRefundsQuery(prisma, input));
  registerTool('customs.query_declarations', (prisma, input, _call, context) => handleCustomsDeclarationsQuery(prisma, input, context));
  registerTool('finance.query_allocations', (prisma, input) => handleFinanceAllocationsQuery(prisma, input));
}
