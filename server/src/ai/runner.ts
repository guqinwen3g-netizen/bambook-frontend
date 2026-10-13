import { PrismaClient } from '@prisma/client';
import { AiChatRequest, AiChatResult, AiEmit } from './runtime';
import { isReceiptGuardedCommitTool } from '../agent/toolDispatchRegistry';
import { createIdentityService } from '../agent/identity';
import { AgentRole } from '../agent/types';
import { extractPdfText } from '../import/extractText';
import { emitAgentWorkEvent } from '../agent/events';
import { createAgentLoop } from '../agent/agentLoop';
import { ToolDescriptor } from '../agent/agentLoopTypes';
import { createCheckpointConversationId, PrismaCheckpointManager } from '../agent/checkpoint';
import { executeAgentTool } from '../agent/toolRuntime';
import { createMemoryService } from '../agent/memory';
import { createTtsAnnotationStripper, stripTtsAnnotationsForDisplay } from './ttsTextNormalizer';
import { createLlmCompleter } from './llmProviders';
import { refreshToolActor } from './refreshToolActor';

type RunnerOptions = {
  prisma: PrismaClient;
  runSearch: <T>(task: () => Promise<T>) => Promise<T>;
};

const createBlockId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const emitMarkdownBlockStart = (emit: AiEmit | undefined, blockId: string, title = '回答') => {
  emit?.('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'markdown',
      title,
      content: '',
      status: 'streaming',
    },
  });
};

const emitMarkdownBlockPatch = (emit: AiEmit | undefined, blockId: string, value: string) => {
  if (!value) return;
  emit?.('block_patch', {
    messageId: '',
    blockId,
    patch: {
      op: 'append_text',
      value,
    },
  });
};

const emitBlockEnd = (emit: AiEmit | undefined, blockId: string) => {
  emit?.('block_end', {
    messageId: '',
    blockId,
  });
};

// ---------- Mermaid block helpers ----------
type MermaidKind = 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'pie' | 'journey' | 'timeline' | 'mindmap' | 'gitgraph';

const detectMermaidKind = (code: string): MermaidKind => {
  const head = code.trim().split(/\s+/, 2)[0]?.toLowerCase() ?? '';
  if (head.startsWith('sequencediagram')) return 'sequence';
  if (head.startsWith('classdiagram')) return 'class';
  if (head.startsWith('statediagram')) return 'state';
  if (head.startsWith('erdiagram')) return 'er';
  if (head.startsWith('gantt')) return 'gantt';
  if (head.startsWith('pie')) return 'pie';
  if (head.startsWith('journey')) return 'journey';
  if (head.startsWith('timeline')) return 'timeline';
  if (head.startsWith('mindmap')) return 'mindmap';
  if (head.startsWith('gitgraph')) return 'gitgraph';
  return 'flowchart';
};

const emitMermaidBlock = (emit: AiEmit | undefined, code: string, kind: MermaidKind, caption?: string) => {
  const blockId = createBlockId('block_mermaid');
  emit?.('block_start', {
    messageId: '',
    block: {
      id: blockId,
      type: 'mermaid',
      title: caption ?? '可视化',
      kind,
      code,
      caption,
      status: 'complete',
    },
  });
  emit?.('block_end', { messageId: '', blockId });
  return blockId;
};

const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)\n```/g;

/**
 * 扫描 LLM 完整输出，把每个 ```mermaid ... ``` 围栏 emit 成独立 mermaid block。
 * 返回扫描到的图数量。LLM 原文的 markdown 块中保留围栏代码（保持原样），避免破坏文本流。
 */
const flushMermaidBlocksFromText = (emit: AiEmit | undefined, text: string): number => {
  if (!text || !text.includes('```mermaid')) return 0;
  let count = 0;
  let match: RegExpExecArray | null;
  MERMAID_FENCE_RE.lastIndex = 0;
  while ((match = MERMAID_FENCE_RE.exec(text)) !== null) {
    const code = match[1].trim();
    if (!code) continue;
    emitMermaidBlock(emit, code, detectMermaidKind(code));
    count += 1;
  }
  return count;
};

type ContextHit = {
  title: string;
  category: string;
  content: string;
  source: string;
  scopes?: string[];
};

type AttachmentInput = {
  name: string;
  mimeType?: string;
  data?: string;
};

const MAX_ATTACHMENT_CONTEXT_CHARS = 18_000;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_VISION_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_VISION_PAGES = 3;
const PDF_VISION_RENDER_SCALE = 1.5;
const DEFAULT_VISION_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * agentLoop 暴露给 LLM 的工具白名单（risk='low' 且已接入真实 handler 的只读工具）。
 * S2 不暴露 email.send / knowledge.ingest 等需审批的工具。
 */
/**
 * 入参合约设计原则（重要）：
 *   - `query` 是**字面文本子串匹配**（不是语义检索、不是 SQL where）。
 *     只在用户输入里**有具体的实体名/编号/型号**时填，且只填该实体短文本本身（例如客户名、SKU、PO 号），
 *     绝不要把用户的整句中文问句塞到 query 里。
 *   - 维度筛选（客户、供应商、状态、日期、缺失字段等）一律走 `filters`，每个字段的形状写在 inputHint 里。
 *   - 既能用 filters 又能用 query 时，**优先 filters**——它是结构化精确匹配，全句 query 等同于全文检索失败。
 */
export const AGENT_LOOP_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  { id: 'memory.recall', name: 'Recall Memories', scope: 'memory', risk: 'low',
    description: '检索当前用户的跨会话记忆（偏好/惯例/业务规则）。用户问"我之前说过什么/记住的规则"或需要个性化上下文时调用。',
    inputHint: '{ scope?: string, query?: string, limit?: number }' },
  { id: 'memory.write', name: 'Write Memory', scope: 'memory', risk: 'low',
    description: '把用户明确要求记住的信息（偏好/惯例/规则）写入跨会话记忆。仅当用户明确说"记住这个"或语义等价时调用；scope 只能写当前用户可访问范围。',
    inputHint: '{ scope: string /* personal:{userId} 默认 */, memoryType: string /* preference|process|rule|fact */, content: string, summary?: string }' },
  { id: 'products.query', name: 'Query Product Assets', scope: 'products', risk: 'low',
    description: '按条件检索数字档案候选或返回统计；不唯一时只返回候选不要猜测。query 用于实体名/SKU 等短字面匹配，维度筛选走 filters。',
    inputHint: '{ query?: string /* 短实体文本，例如 SKU/品名；不要塞整句话 */, mainCategory?: string, filters?: { certifications?: string[], composition?: string, supplier?: string }, sort?: { field: string, direction: "asc"|"desc" }, limit?: number, offset?: number }' },
  { id: 'products.describe_schema', name: 'Describe Product Asset Schema', scope: 'products', risk: 'low',
    description: '读取 Product Asset 数据结构 / 字段含义。', inputHint: '{}' },
  { id: 'products.get', name: 'Get Product Asset', scope: 'products', risk: 'low',
    description: '按 SKU/Article No./id 读取唯一档案；不唯一时不会返回。',
    inputHint: '{ sku?: string, articleNo?: string, id?: string }' },
  { id: 'products.expand', name: 'Expand Product Asset Context', scope: 'products', risk: 'low',
    description: '展开档案的价格、成分、认证、图片、客户编码、关联关系等。',
    inputHint: '{ id: string, sections?: string[] }' },
  { id: 'orders.query', name: 'Query Orders', scope: 'orders', risk: 'low',
    description: '按客户/供应商/PO/状态/交期等条件检索订单。客户名 ⇒ filters.customer；供应商/工厂 ⇒ filters.supplier；不要把整句问题塞 query。',
    inputHint: '{ query?: string /* 短字面文本，例如 SKU/PO/品名；查客户请用 filters.customer */, filters?: { customer?: string /* 客户名 */, supplier?: string, poNumber?: string, statuses?: string[], dueDateFrom?: string /* YYYY-MM-DD */, dueDateTo?: string, missingFields?: string[] /* e.g. ["supplierInvoiceNumber"] */ }, sort?: { field: "dueDate"|"updatedAt"|"createdAt", direction: "asc"|"desc" }, aggregate?: "count"|"list"|"detail", limit?: number, offset?: number }' },
  { id: 'orders.get', name: 'Get Order', scope: 'orders', risk: 'low',
    description: '按 PO 号或订单 id 读取单条订单。',
    inputHint: '{ poNumber?: string, id?: string }' },
  { id: 'orders.expand', name: 'Expand Order Context', scope: 'orders', risk: 'low',
    description: '展开订单行、客户/供应商、发票、样品、生产节点等。',
    inputHint: '{ id?: string, poNumber?: string, sections?: Array<"summary"|"lines"|"parties"|"dates"|"invoices"|"samples"|"production"|"missingFields"|"currencies"> }' },
  { id: 'relations.query', name: 'Query Relations', scope: 'relations', risk: 'low',
    description: '检索公司/客户/供应商/联系人档案候选。query 填实体名短文本，类别走 filters.categories。',
    inputHint: '{ query?: string /* 实体名短文本；不要塞整句 */, filters?: { categories?: Array<"Customer"|"Supplier"|"Contact">, address?: string, paymentTerms?: string }, sort?: { field: "lastInteraction"|"updatedAt", direction: "asc"|"desc" }, limit?: number }' },
  { id: 'relations.get', name: 'Get Relation', scope: 'relations', risk: 'low',
    description: '按 id/名称读取唯一关系档案。',
    inputHint: '{ id?: string, name?: string }' },
  { id: 'relations.expand', name: 'Expand Relation Context', scope: 'relations', risk: 'low',
    description: '展开主联系人/备用联系人/通讯录人物 people/上下文。',
    inputHint: '{ id?: string, name?: string, include?: Array<"profile"|"contacts"|"people">, limit?: number }' },
  // ── 写操作工具（high risk，LLM 可规划但执行需 approval）──
  { id: 'relations.create', name: 'Create Relation', scope: 'relations', risk: 'high',
    description: '新建公司/客户/供应商/联系人档案。写操作，必须走审批。创建前应先 relations.query 确认无重名。同一个工具既能创建"组织档案"（isOrganization:true）也能创建"联系人个人档案"（isOrganization:false + parentId 指向所属组织）——当用户提到某组织的联系人/负责人/业务员时，你可以先建组织档案、再为该联系人建一条 isOrganization:false 的子档案并 parentId 关联。组织的 category 必须是 7 个业务分类之一：Customer(客户)/Supplier(供应商)/Agent(代理商)/Partner(合作伙伴)/Government(政府机构)/Internal(内部)/Other(其他)——用户没明确指定时你必须先确认是哪一类，不能擅自假设。',
    inputHint: '{ id: string /* 必填唯一 id，组织用 ORG-XXX，联系人用 CT-XXX */, name: string /* 必填：组织名或联系人姓名 */, category: "Customer"|"Supplier"|"Agent"|"Partner"|"Government"|"Internal"|"Other" /* 组织必填：7 个业务分类之一 */, type?: string /* 可选细分类，如 Supplier 下的 Fabric Mill；不填默认同 category */, isOrganization?: boolean /* 默认 true；建联系人个人档案时传 false */, parentId?: string /* 仅当 isOrganization:false：所属组织的 relation id */, /* ——组织专属字段—— */ primaryContactName?: string, primaryContactEmail?: string, primaryContactPhone?: string, paymentTerms?: string, creditLevel?: string, currency?: string, taxId?: string, website?: string, officialAddress?: string, factoryAddresses?: string[], billingAddress?: string, shippingAddress?: string, summary?: string /* 概况/备注 */, tags?: string[], /* ——联系人个人档案专属字段（isOrganization:false 时）—— */ role?: string /* 职位 */, department?: string, email?: string, phone?: string, mobile?: string, wechat?: string, whatsapp?: string, contactInfo?: string /* 通用联系方式文本 */ }' },
  { id: 'finance.list_invoices', name: 'List Invoices', scope: 'finance', risk: 'low',
    description: '检索发票列表。',
    inputHint: '{ limit?: number, offset?: number, filters?: { status?: string[] } }' },
  { id: 'finance.list_vouchers', name: 'List Payment Vouchers', scope: 'finance', risk: 'low',
    description: '检索付款凭证列表。',
    inputHint: '{ limit?: number, offset?: number, filters?: { status?: string[] } }' },
  { id: 'shipping.list_shipments', name: 'List Shipments', scope: 'shipping', risk: 'low',
    description: '检索发货记录列表。',
    inputHint: '{ limit?: number, offset?: number, filters?: { status?: string[] } }' },
  { id: 'development.query', name: 'Query Development Cases', scope: 'development', risk: 'low',
    description: '检索开发管理（样品/打样）案例列表。',
    inputHint: '{ limit?: number, offset?: number, filters?: { type?: string[], stage?: string[] } }' },
  { id: 'email.list', name: 'List Emails', scope: 'email', risk: 'low',
    description: '检索邮件列表。',
    inputHint: '{ limit?: number, offset?: number, filters?: { unread?: boolean } }' },
  { id: 'knowledge.search', name: 'Search Knowledge Base', scope: 'knowledge', risk: 'low',
    description: '检索 KnowledgeDocument / KnowledgeChunk；用于公司知识、政策、流程类问题。query 用关键词组合，不要塞整句。',
    inputHint: '{ query: string /* 关键词，如 "样品发票规则"；不要塞整句 */, limit?: number }' },
  { id: 'entities.search', name: 'Search Business Entities', scope: 'relations', risk: 'low',
    description: '跨模块解析候选实体（公司/产品/订单/通讯录人物等）；常作为后续工具的 typedRef 入口。query 用空格分隔的实体短文本。',
    inputHint: '{ query: string /* 空格分隔的实体名/编号短文本 */, limit?: number }' },
  { id: 'entities.hydrate', name: 'Hydrate Business Entities', scope: 'relations', risk: 'low',
    description: '按 typedRef (entityType:id) 批量获取实体的简要档案。',
    inputHint: '{ refs: Array<{ entityType: string /* e.g. "relation.organization" */, id: string }> }' },
  { id: 'template.list', name: 'List Templates', scope: 'templates', risk: 'low',
    description: '列出可用模板（报价单/合同/发票模板等）。',
    inputHint: '{}' },
  { id: 'template.render', name: 'Render Template (HTML)', scope: 'templates', risk: 'low',
    description: '按模板名 + 参数渲染 HTML 输出。',
    inputHint: '{ templateName: string, params?: object }' },
  { id: 'template.render_pdf', name: 'Render Template to PDF', scope: 'templates', risk: 'low',
    description: '按模板名 + 参数渲染 PDF 输出。',
    inputHint: '{ templateName: string, params?: object }' },
  // ── C3 高频外贸场景只读工具 ──
  { id: 'quotations.query', name: 'Query Quotations', scope: 'quotations', risk: 'low',
    description: '检索报价单列表（智能报价的历史报价回溯）。状态/客户/日期过滤走 filters，报价单号/品名/客户名短文本走 query。',
    inputHint: '{ filters?: { status?: string, customerRelationId?: string, dateFrom?: string, dateTo?: string }, query?: string /* 短文本，不塞整句 */, limit?: number, offset?: number }' },
  { id: 'quotations.get', name: 'Get Quotation', scope: 'quotations', risk: 'low',
    description: '按 id 或报价单号读取报价单详情（含行明细与价格条款）。',
    inputHint: '{ id?: string, quotationNumber?: string }' },
  { id: 'finance.get_aging', name: 'Get AR/AP Aging Report', scope: 'finance', risk: 'low',
    description: '应收/应付账龄报告：分币种合计 + 按客户五档账龄，行按逾期金额降序。客户风险预警的核心数据。',
    inputHint: '{ type?: "Receivable"|"Payable" /* 默认 Receivable */, asOf?: string /* YYYY-MM-DD */, rowLimit?: number }' },
  { id: 'customs.query_lc', name: 'Query Letters of Credit', scope: 'customs', risk: 'low',
    description: '检索信用证列表。状态/客户/开证行过滤走 filters；expiringBefore 查将到期；信用证号/申请人短文本走 query。LC 审单的数据入口。',
    inputHint: '{ filters?: { status?: string, customerRelationId?: string, issuingBank?: string, expiringBefore?: string /* YYYY-MM-DD */ }, query?: string, limit?: number }' },
  { id: 'customs.get_lc', name: 'Get Letter of Credit', scope: 'customs', risk: 'low',
    description: '按 id 或信用证号读取信用证详情（金额/效期/最迟装运日/单证条款），供逐条审单核对。',
    inputHint: '{ id?: string, lcNumber?: string }' },
  { id: 'shipping.scan_delays', name: 'Scan Delayed Shipments', scope: 'shipping', risk: 'low',
    description: '实时扫描出运延误：ETD 已过未离港 / ETA 已过未到港，返回延误天数与 warning/critical 分级。跟单提醒场景首选。',
    inputHint: '{ asOf?: string /* YYYY-MM-DD，默认今天 */, limit?: number }' },
  // ── Phase 4 Track G：Phase 2 八域只读查询工具 ──
  { id: 'moq.query_config', name: 'Query MOQ Config', scope: 'settings', risk: 'low',
    description: '查询当前生效的 MOQ 最小起订量阈值配置（面料/成衣/Capsule 三档），配置缺失时回落兜底常量并标记来源；可选阈值变更历史。',
    inputHint: '{ includeHistory?: boolean, historyLimit?: number }' },
  { id: 'order_changes.query', name: 'Query Order Change Requests', scope: 'orders', risk: 'low',
    description: '查询订单变更/取消/暂停申请（DR-010）：按订单/状态/申请人过滤列表，或按申请 ID 读详情（含关联订单与审批单快照）。回答"某订单有哪些变更记录/某变更审批进度"类问题。',
    inputHint: '{ id?: string, orderId?: string, status?: string, requesterId?: string, limit?: number }' },
  { id: 'samples.query', name: 'Query Samples', scope: 'samples', risk: 'low',
    description: '查询样品记录：fabric_shipment 模式按订单列面料寄船样/头缸样（可选发货资格判定）；early_production 模式按订单列早期生产样轮次；garment_rounds 模式按开发案列服装多轮样品及封样状态。',
    inputHint: '{ mode?: "fabric_shipment"|"early_production"|"garment_rounds" /* 默认 fabric_shipment */, orderId?: string /* fabric_shipment/early_production 必填 */, caseId?: string /* garment_rounds 必填 */, includeEligibility?: boolean }' },
  { id: 'qc.query_reports', name: 'Query QC Reports', scope: 'qc', risk: 'low',
    description: '按订单查询 QC 验货报告列表（报告状态/结论/缺陷统计），可选附带 QC 侧出运资格判定。回答"某订单验货结果/能否出货"类问题。',
    inputHint: '{ orderId: string /* 必填 */, includeEligibility?: boolean }' },
  { id: 'exceptions.query', name: 'Query Controlled Exceptions', scope: 'exceptions', risk: 'low',
    description: '查询受控例外申请（DR-013）：按状态/类别/申请人过滤列表，或按申请 ID 读详情。回答"某订单是否有生效中的例外放行/某例外审批进度"类问题。',
    inputHint: '{ id?: string, status?: string, exceptionCategory?: string, requesterId?: string, limit?: number }' },
  { id: 'credit.query_status', name: 'Query Customer Credit Status', scope: 'credit', risk: 'low',
    description: '查询客户信用状态：额度总额/已占用/剩余、冻结门禁标记、最大逾期天数；可选信用事件历史时间线。回答"某客户额度还剩多少/是否被冻结/为何冻结"类问题。',
    inputHint: '{ relationId: string /* 必填；只有客户名时先 relations.query 解析 */, includeHistory?: boolean, historyLimit?: number }' },
  { id: 'internal_trade.query', name: 'Query Internal Transfers', scope: 'internal_trade', risk: 'low',
    description: '查询内部供料单（服装部向面料部的内部交易，DR-005/033）：按部门/状态/服装订单/面料订单过滤列表，或按供料单 ID 读详情。',
    inputHint: '{ id?: string, departmentId?: string, status?: string, garmentOrderId?: string, fabricOrderId?: string, limit?: number, offset?: number }' },
  { id: 'payment_requests.query', name: 'Query Payment Requests', scope: 'finance', risk: 'low',
    description: '查询付款申请（DR-017 先申请后付款）：按状态/付款性质/申请人过滤列表，或按申请 ID 读详情（含关联审批单与付款凭证快照）。回答"某付款申请进度/是否已生成付款凭证"类问题。',
    inputHint: '{ id?: string, status?: string, paymentCategory?: string, applicantId?: string, limit?: number }' },
  // ── W4 收尾：Agent 工具缺口 5 类只读查询工具 ──
  { id: 'purchase_orders.query', name: 'Query Purchase Orders', scope: 'procurement', risk: 'low',
    description: '查询采购单：按状态/供应商/下单日期窗/单号搜索过滤列表，或按采购单 ID 读详情（含行明细与到货记录）。回答"某订单采购执行情况/某供应商在途采购单"类问题。',
    inputHint: '{ id?: string, status?: string, supplierRelationId?: string, dateFrom?: string /* YYYY-MM-DD */, dateTo?: string, search?: string, limit?: number, offset?: number }' },
  { id: 'bom.query', name: 'Query BOMs', scope: 'bom', risk: 'low',
    description: '查询 BOM 物料清单：按状态/产品/订单/报价过滤列表，或按 BOM ID 读详情（含行明细与料/工/费成本汇总）。回答"某订单物料构成/某款产品成本结构"类问题。',
    inputHint: '{ id?: string, status?: string, productAssetId?: string, orderId?: string, quotationId?: string, search?: string, limit?: number, offset?: number }' },
  { id: 'customs.query_tax_refunds', name: 'Query Tax Refunds', scope: 'customs', risk: 'low',
    description: '查询出口退税记录：按状态/报关单/订单/客户过滤列表，或按退税记录 ID 读详情（FOB/退税率/应退金额/审核信息）。回答"某订单退税进度/哪些退税审核滞留"类问题。',
    inputHint: '{ id?: string, status?: string, declarationId?: string, orderId?: string, relationId?: string, search?: string, limit?: number, offset?: number }' },
  { id: 'customs.query_declarations', name: 'Query Customs Declarations', scope: 'customs', risk: 'low',
    description: '查询报关单：按类型/状态/运单/订单/客户过滤列表，或按报关单 ID 读详情（含行明细）。回答"某票出运报关状态/某订单报关单号"类问题。',
    inputHint: '{ id?: string, type?: string, status?: string, shipmentId?: string, orderId?: string, relationId?: string, search?: string, limit?: number, offset?: number }' },
  { id: 'finance.query_allocations', name: 'Query Invoice Allocations', scope: 'finance', risk: 'low',
    description: '查询收付款核销明细：按发票或收款凭证过滤，返回每笔核销金额与日期。回答"某发票已核销多少/某笔收款分配到哪些发票"类问题。',
    inputHint: '{ invoiceId?: string, voucherId?: string, limit?: number }' },
  // ── Phase 2 S3a：六新域写工具（draft→approval→commit，LLM 可规划但执行需 approval）──
  { id: 'order_changes.create', name: 'Create Order Change Request', scope: 'orders', risk: 'high',
    description: '创建订单变更/取消/暂停申请（DR-010），需提供订单ID、变更类型、前后快照、变更理由和影响说明。写操作，必须走审批。',
    inputHint: '{ orderId: string, changeType: "price"|"quantity"|"delivery"|"customer"|"product"|"cancel"|"pause", beforeSnapshot: object, afterDelta: object, changeReason: string, impactSummary: string, requesterId: string }' },
  { id: 'order_changes.withdraw', name: 'Withdraw Order Change Request', scope: 'orders', risk: 'medium',
    description: '撤回订单变更申请（仅 Pending 状态且仅申请人本人可撤回）。写操作，必须走审批。',
    inputHint: '{ changeRequestId: string, actorId: string }' },
  { id: 'payment_requests.create', name: 'Create Payment Request', scope: 'finance', risk: 'high',
    description: '创建付款申请（DR-017 先申请后付款），需提供收款方、金额、币种、付款性质、申请人。写操作，必须走审批。',
    inputHint: '{ supplierId?: string, supplierName?: string, totalAmount: number, currency: string, paymentCategory?: string, applicantId: string, reason?: string }' },
  { id: 'payment_requests.cancel', name: 'Cancel Payment Request', scope: 'finance', risk: 'medium',
    description: '作废付款申请（仅 Draft/Pending 且仅申请人本人可作废）。写操作，必须走审批。',
    inputHint: '{ paymentRequestId: string, actorId: string }' },
  { id: 'credit.freeze', name: 'Freeze Customer Credit', scope: 'credit', risk: 'high',
    description: '人工冻结客户信用额度（冻结即新单门禁），理由必填（审计强制）。写操作，必须走审批。',
    inputHint: '{ relationId: string, reason: string, actorId: string }' },
  { id: 'credit.thaw', name: 'Thaw Customer Credit', scope: 'credit', risk: 'high',
    description: '人工解冻客户信用额度，理由必填（审计强制）。写操作，必须走审批。',
    inputHint: '{ relationId: string, reason: string, actorId: string }' },
  { id: 'samples.create_round', name: 'Create Garment Sample Round', scope: 'samples', risk: 'high',
    description: '创建服装样品轮次（DR-008/DR-029 双门禁），需提供开发案ID、目的、版本、材料配置。写操作，必须走审批。',
    inputHint: '{ caseId: string, input: { purpose: string, version: string, materialConfig: object }, actorId: string }' },
  { id: 'samples.submit_to_customer', name: 'Submit Sample To Customer', scope: 'samples', risk: 'medium',
    description: '提交样品给客户（内部门禁：QC 通过后方可提交），需提供轮次ID和寄送信息。写操作，必须走审批。',
    inputHint: '{ roundId: string, input: { courier?: string, trackingNo?: string, sentDate?: string }, actorId: string }' },
  { id: 'samples.register_customer_confirmation', name: 'Register Sample Customer Confirmation', scope: 'samples', risk: 'medium',
    description: '登记客户样品确认结论（approved/rejected/needs_revision），需提供轮次ID和确认结果。写操作，必须走审批。',
    inputHint: '{ roundId: string, input: { result: "approved"|"rejected"|"needs_revision", comment?: string }, actorId: string }' },
  { id: 'qc.review_garment_sample', name: 'QC Review Garment Sample', scope: 'qc', risk: 'high',
    description: 'QC 成衣链样品评审（DR-029），每轮报告独立不可覆盖，需提供订单ID、轮次、结论。写操作，必须走审批。',
    inputHint: '{ orderId: string, input: { level: "pp"|"top", round: number, conclusion: "pass"|"conditional"|"fail", opinion: string }, actorId: string }' },
  { id: 'qc.review_fabric_sample', name: 'QC Review Fabric Sample', scope: 'qc', risk: 'high',
    description: 'QC 面料链样品评审（DR-029），非 pass 必须提工厂技术调整要求，需提供订单ID、样品类型、结论。写操作，必须走审批。',
    inputHint: '{ orderId: string, input: { sampleKind: "SS"|"RC"|"EARLY_PRODUCTION", conclusion: "pass"|"conditional"|"fail", opinion: string, factoryAdjustment?: object }, actorId: string }' },
  { id: 'qc.sign_report', name: 'Sign QC Report', scope: 'qc', risk: 'high',
    description: 'QC 报告双签（产前样双签唯一入口），角色限 qc/business，签署留痕不可改写。写操作，必须走审批。',
    inputHint: '{ reportId: string, role: "qc"|"business", actorId: string }' },
  { id: 'internal_trade.create', name: 'Create Internal Transfer', scope: 'internal_trade', risk: 'high',
    description: '创建内部供料单（DR-005/033），需提供服装/面料订单、物料、数量、结算价、交期（结算价需 DR-006 审批）。写操作，必须走审批。',
    inputHint: '{ garmentOrderId: string, fabricOrderId: string, materialCode: string, quantity: number, settlementPrice: number, dueDate: string }' },
  { id: 'internal_trade.confirm', name: 'Confirm Internal Transfer', scope: 'internal_trade', risk: 'high',
    description: '确认内部供料单生效（生效门槛：结算价审批通过），需提供供料单ID和确认数量/交期。写操作，必须走审批。',
    inputHint: '{ transferId: string, actorId: string, confirmedQuantity?: number, confirmedDueDate?: string }' },
  // ── Phase 2 S3b：四存量域写工具（draft→approval→commit，LLM 可规划但执行需 approval）──
  { id: 'procurement.create', name: 'Create Purchase Order', scope: 'procurement', risk: 'high',
    description: '创建采购订单（PO），需提供币种、下单日期、行明细（供应商黑名单校验）。写操作，必须走审批。',
    inputHint: '{ poNumber?: string, supplierId: string, currency: string, orderDate: string, lines: Array<{ description: string, unit: string, quantity: number, unitPrice: number }> }' },
  { id: 'procurement.update_status', name: 'Update Purchase Order Status', scope: 'procurement', risk: 'medium',
    description: '采购订单状态流转（Draft→Sent→Confirmed→PartiallyReceived/Received→Closed），目标状态不可手动设置 PartiallyReceived/Received。写操作，必须走审批。',
    inputHint: '{ purchaseOrderId: string, toStatus: string, reason?: string }' },
  { id: 'inventory.adjust_stock', name: 'Adjust Inventory Stock', scope: 'inventory', risk: 'high',
    description: '库存变动登记（入库/出库/调拨/调整/锁定/解锁），需提供库存项、类型、数量（调拨需目标仓库）。写操作，必须走审批。',
    inputHint: '{ movement: { itemId: string, type: "Inbound"|"Outbound"|"Transfer"|"Adjustment"|"Lock"|"Unlock", quantity: number, targetWarehouseId?: string, reason?: string } }' },
  { id: 'quotation.create', name: 'Create Quotation', scope: 'quotations', risk: 'high',
    description: '创建报价单（MOQ writeOnce 快照+双轨偏差审批），需提供币种、报价日期、行明细。写操作，必须走审批。',
    inputHint: '{ quotationNumber?: string, customerRelationId: string, currency: string, issueDate: string, lines: Array<{ description: string, unit: string, quantity: number, unitPrice: number }> }' },
  { id: 'quotation.update', name: 'Update Quotation', scope: 'quotations', risk: 'high',
    description: '更新报价单（仅 Draft 状态可编辑），双轨快照与 MOQ 快照为 writeOnce 不可 patch。写操作，必须走审批。',
    inputHint: '{ quotationId: string, patch: { currency?: string, issueDate?: string, lines?: Array<...> } }' },
  { id: 'customs.register_lc', name: 'Register Letter of Credit', scope: 'customs', risk: 'high',
    description: '登记信用证（首节点事件 Issued+EntityLink 同步），需提供证号、类型、金额、开证/效期。写操作，必须走审批。',
    inputHint: '{ lcNumber?: string, type: "Irrevocable"|"Revocable"|"Standby"|"Transferable", amount: number, currency: string, issueDate: string, expiryDate: string, applicant?: string, issuingBank?: string }' },
  { id: 'customs.update_declaration', name: 'Update Customs Declaration', scope: 'customs', risk: 'high',
    description: '更新报关单（仅 Draft 状态可编辑），需提供报关单ID和 patch。写操作，必须走审批。',
    inputHint: '{ declarationId: string, patch: { customsType?: "Export"|"Import", declarationDate?: string, ... } }' },
];

export function createMacMiniChatRunner(options: RunnerOptions) {
  const identity = createIdentityService();
  // Checkpoints are durable only when the production runtime owns a Prisma manager.
  // This keeps crash recovery on the same database boundary as sessions and tool runs.
  const checkpointManager = new PrismaCheckpointManager(options.prisma);

  return async function runMacMiniChat(request: AiChatRequest & { signal: AbortSignal; emit: AiEmit }): Promise<AiChatResult & { stopReason?: string }> {
    emitAgentWorkEvent(request.emit, {
      phase: 'start',
      status: 'running',
      title: '启动 Agent Runtime',
      message: '正在启动 Bambook Enterprise Agent OS',
      summary: 'Bambook 后端 Agent Runtime',
    });
    const attachmentContext = await buildAttachmentContextFromAttachments(request.attachments || [], {
      emit: request.emit,
      signal: request.signal,
    });

    // ── agentLoop 路径（唯一路径）──
    const actor = await identity.resolveActorContext({
      userId: request.userId,
      displayName: request.displayName,
      roles: normalizeRoles(request.roles),
      departmentIds: request.departmentIds,
      roleIds: request.roleIds,
      permissions: request.permissions,
      authorizationLoaded: request.authorizationLoaded,
    });
    const loop = createAgentLoop({
      llm: createLlmCompleter(),
      toolExecutor: async ({ toolId, input, actor: callActor, signal, skipApprovalCheck, approvalId }) => {
        if (signal?.aborted) throw new Error('AGENT_EXECUTION_ABORTED');
        const currentActor = await refreshToolActor(options.prisma, callActor, {
          userId: request.userId, requestSource: request.requestSource,
          permissionCeiling: actor.permissionScopes,
        });
        if (signal?.aborted) throw new Error('AGENT_EXECUTION_ABORTED');
        return executeAgentTool({
        prisma: options.prisma,
        actor: currentActor,
        toolId,
        toolInput: input,
        sessionId: request.sessionId,
        actorUserId: request.actorUserId,
        requestSource: request.requestSource,
        skipApprovalCheck,
        approvalId,
        });
      },
      availableTools: AGENT_LOOP_TOOL_DESCRIPTORS,
      checkpointManager,
      canResumeApprovalTool: isReceiptGuardedCommitTool,
      // 批次 2b：审批决议查询器——resume 挂起审批时查 ApprovalRequest（决议真源）。
      // status='pending' → 重新挂起等待；approved/rejected/modified → 补执行或记失败。
      approvalResolver: async approvalId => {
        const row = await options.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
        if (!row) return null;
        const payload = (row.payload as Record<string, unknown> | null) || {};
        const resolution = (payload as any).resolution || {};
        return {
          status: row.status,
          decisionNote: row.decisionNote,
          modifiedInput: resolution.modifiedInput as Record<string, unknown> | undefined,
        };
      },
      // 跨会话记忆注入：run 开始时 recall 该用户可访问 scope 的最近记忆进系统提示词
      //（memoryLoader 异常不阻断对话，降级为无记忆上下文）
      memoryLoader: async memoryActor => {
        const memoryService = createMemoryService(options.prisma);
        const records = await memoryService.recall({ actor: memoryActor, limit: 20 });
        return records.map(record => ({
          scope: record.scope,
          memoryType: record.memoryType,
          content: record.content,
        }));
      },
    });
    // 真流式正文：拦截 answer_delta 实时推 block_patch
    let streamingBlockId: string | null = null;
    let streamingText = '';

    const loopResult = await loop.run({
      actor,
      conversationId: createCheckpointConversationId({ sessionId: request.sessionId, actor }),
      message: request.message,
      history: (request.history || []).map(item => ({
        role: item.role === 'model' ? 'assistant' : item.role,
        content: item.content || item.text || '',
      })),
      attachmentContext,
      model: request.model,
      temperature: request.temperature,
      signal: request.signal,
      emit: (type, payload) => {
        // 先转发所有事件（保留 agent_event 给 timeline）
        request.emit(type as any, payload);
        // answer_delta 额外驱动正文 block 增量（单一链路）
        const phase = (payload as any)?.phase;
        if (type === 'agent_event' && phase === 'answer_delta') {
          const delta = String((payload as any)?.metadata?.delta || (payload as any)?.message || '');
          if (delta) {
            if (!streamingBlockId) {
              streamingBlockId = createBlockId('block_markdown');
              emitMarkdownBlockStart(request.emit, streamingBlockId);
            }
            streamingText += delta;
            const displayDelta = stripTtsAnnotationsForDisplay(delta);
            if (displayDelta) emitMarkdownBlockPatch(request.emit, streamingBlockId, displayDelta);
          }
        }
      },
    });
    // 最终回答：流式已推则只关闭 block；否则回退一次性，前端文本气泡才有内容；保留 TTS 注释剥离。
    const displayText = stripTtsAnnotationsForDisplay(loopResult.text).trim() || loopResult.text;
    if (streamingBlockId) {
      // 真流式路径：block_patch 已增量推送完整内容，只收尾关闭 block。
      // 不再追加 displayText（append_text 会重复，且增量已全部推送）。
      emitBlockEnd(request.emit, streamingBlockId);
      flushMermaidBlocksFromText(request.emit, displayText);
    } else if (displayText) {
      // 回退路径：流式未触发，一次性推送
      const blockId = createBlockId('block_markdown');
      emitMarkdownBlockStart(request.emit, blockId);
      emitMarkdownBlockPatch(request.emit, blockId, displayText);
      emitBlockEnd(request.emit, blockId);
      flushMermaidBlocksFromText(request.emit, displayText);
      request.emit('delta', { text: displayText, ttsText: loopResult.text });
    }
    return {
      text: displayText,
      sources: loopResult.sources,
      thoughtProcess: loopResult.thoughtProcess,
      stopReason: loopResult.stopReason,
    };
  };
}

// LLM completer 已迁移至 llmProviders.ts（批次 2a：provider 链 + 失败转移）。
// createArkLLMCompleter 单 provider 实现删除，主 chat 路径统一走 createLlmCompleter()。

export async function buildAttachmentContextFromAttachments(
  attachments: AttachmentInput[],
  options: { emit?: AiEmit; signal?: AbortSignal } = {},
): Promise<ContextHit[]> {
  const hits: ContextHit[] = [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
    if (options.signal?.aborted) break;
    const name = String(attachment.name || '未命名文件');
    const mimeType = String(attachment.mimeType || '');
    const data = String(attachment.data || '');
    if (!data) continue;

    if (mimeType.includes('pdf') || /\.pdf$/i.test(name)) {
      options.emit?.('step', { message: `正在读取工作区 PDF：${name}` });
      const pdfContext = await buildPdfAttachmentContext({
        name,
        data,
        emit: options.emit,
        signal: options.signal,
      });
      hits.push({
        title: name,
        category: 'WorkspacePDF',
        content: pdfContext.content,
        source: pdfContext.source,
        scopes: ['company'],
      });
      continue;
    }

    if (mimeType.startsWith('text/') || /\.(txt|md|csv|json)$/i.test(name)) {
      options.emit?.('step', { message: `正在读取工作区文件：${name}` });
      hits.push({
        title: name,
        category: 'WorkspaceFile',
        content: `文件名: ${name}\n正文:\n${limitAttachmentText(Buffer.from(normalizeBase64Payload(data), 'base64').toString('utf8'))}`,
        source: 'workspace-attachment/file',
        scopes: ['company'],
      });
      continue;
    }

    if (mimeType.startsWith('image/')) {
      options.emit?.('step', { message: `正在读取工作区图片：${name}` });
      const analysis = await analyzeWorkspaceImageAttachment({
        name,
        mimeType,
        data,
        signal: options.signal,
      });
      hits.push({
        title: name,
        category: 'WorkspaceImage',
        content: analysis.ok
          ? `文件名: ${name}\n类型: ${mimeType}\n视觉模型: ${analysis.model}\n识别结果:\n${limitAttachmentText(analysis.text)}`
          : `文件名: ${name}\n类型: ${mimeType}\n${analysis.text}`,
        source: analysis.ok ? 'workspace-attachment/vision' : 'workspace-attachment/image',
        scopes: ['company'],
      });
    }
  }
  return hits;
}

async function buildPdfAttachmentContext(input: {
  name: string;
  data: string;
  emit?: AiEmit;
  signal?: AbortSignal;
}): Promise<{ content: string; source: string }> {
  const buffer = Buffer.from(normalizeBase64Payload(input.data), 'base64');
  const parsed = await extractPdfText(buffer)
    .catch(error => ({ text: '', pages: 0, error: String(error?.message || error) }));

  if ('error' in parsed) {
    return {
      content: `文件名: ${input.name}\nPDF 解析失败: ${parsed.error}`,
      source: 'workspace-attachment/pdf',
    };
  }

  const meaningfulText = cleanPdfExtractedText(parsed.text);
  if (meaningfulText) {
    return {
      content: `文件名: ${input.name}\n页数: ${parsed.pages || '未知'}\n正文:\n${limitAttachmentText(meaningfulText)}`,
      source: 'workspace-attachment/pdf',
    };
  }

  const visionConfig = getVisionRuntimeConfig();
  if ('text' in visionConfig) {
    return {
      content: [
        `文件名: ${input.name}`,
        `页数: ${parsed.pages || '未知'}`,
        'PDF 未提取到可读文本，可能是扫描件或图片型 PDF。',
        visionConfig.text,
      ].join('\n'),
      source: 'workspace-attachment/pdf',
    };
  }

  input.emit?.('step', { message: `PDF 没有可提取文本，正在渲染前 ${MAX_PDF_VISION_PAGES} 页做视觉读取：${input.name}` });
  const renderedPages = await renderPdfPagesForVision(buffer, {
    maxPages: MAX_PDF_VISION_PAGES,
    scale: PDF_VISION_RENDER_SCALE,
    signal: input.signal,
  });

  if ('error' in renderedPages) {
    return {
      content: [
        `文件名: ${input.name}`,
        `页数: ${parsed.pages || '未知'}`,
        'PDF 未提取到可读文本，可能是扫描件或图片型 PDF。',
        `页面渲染失败: ${renderedPages.error}`,
      ].join('\n'),
      source: 'workspace-attachment/pdf',
    };
  }

  if (!renderedPages.pages.length) {
    return {
      content: [
        `文件名: ${input.name}`,
        `页数: ${parsed.pages || '未知'}`,
        'PDF 未提取到可读文本，也没有可渲染页面。',
      ].join('\n'),
      source: 'workspace-attachment/pdf',
    };
  }

  const pageResults: string[] = [];
  for (const page of renderedPages.pages) {
    if (input.signal?.aborted) break;
    input.emit?.('step', { message: `正在视觉读取 PDF 第 ${page.pageNumber} 页：${input.name}` });
    const analysis = await analyzeWorkspaceImageAttachment({
      name: `${input.name} 第 ${page.pageNumber} 页`,
      mimeType: 'image/png',
      data: page.data,
      signal: input.signal,
    });
    pageResults.push(analysis.ok
      ? `第 ${page.pageNumber} 页:\n${analysis.text}`
      : `第 ${page.pageNumber} 页:\n${analysis.text}`);
  }

  return {
    content: [
      `文件名: ${input.name}`,
      `页数: ${parsed.pages || renderedPages.totalPages || '未知'}`,
      `PDF 文本层为空，已渲染前 ${renderedPages.pages.length} 页并调用视觉模型: ${visionConfig.model}`,
      '识别结果:',
      limitAttachmentText(pageResults.join('\n\n')),
    ].join('\n'),
    source: 'workspace-attachment/pdf-vision',
  };
}

type WorkspaceImageAnalysis = {
  ok: boolean;
  text: string;
  model?: string;
  reason?: string;
};

export async function analyzeWorkspaceImageAttachment(input: {
  name: string;
  mimeType: string;
  data: string;
  signal?: AbortSignal;
}): Promise<WorkspaceImageAnalysis> {
  const config = getVisionRuntimeConfig();

  if ('text' in config) {
    return {
      ok: false,
      reason: config.reason,
      text: config.text,
    };
  }

  const payload = normalizeBase64Payload(input.data);
  const approximateBytes = Math.floor(payload.length * 0.75);
  if (approximateBytes > MAX_VISION_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: 'VISION_ATTACHMENT_TOO_LARGE',
      text: `图片超过当前视觉读取上限 ${Math.round(MAX_VISION_ATTACHMENT_BYTES / 1024 / 1024)}MB，需要先压缩或抽取关键页。`,
      model: config.model,
    };
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              '你是 Bambook Agent 工作区的视觉/OCR读取器。',
              '读取图片、技术图、面料照片、表格和截图里的可见信息。',
              '只输出你能确认的内容；不确定时明确写“不确定”。',
            ].join(''),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `文件名：${input.name}`,
                  '请提取可见文字、款号、规格、颜色、材料、尺寸、表格、异常点和生产/开发相关风险。',
                  '如果是服装技术图、面料照片、辅料图片或产品标准截图，请按 Bambook 业务语境整理。',
                ].join('\n'),
              },
              {
                type: 'image_url',
                image_url: {
                  url: input.data.startsWith('data:')
                    ? input.data
                    : `data:${input.mimeType};base64,${payload}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'VISION_REQUEST_FAILED',
        text: `视觉模型读取失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`,
        model: config.model,
      };
    }

    const json = await response.json() as any;
    const text = extractVisionText(json).trim();
    if (!text) {
      return {
        ok: false,
        reason: 'VISION_EMPTY_RESULT',
        text: '视觉模型没有返回可用识别内容。',
        model: config.model,
      };
    }

    return { ok: true, text, model: config.model };
  } catch (error: any) {
    if (input.signal?.aborted) {
      return {
        ok: false,
        reason: 'VISION_ABORTED',
        text: '视觉模型读取已取消。',
        model: config.model,
      };
    }
    return {
      ok: false,
      reason: 'VISION_REQUEST_ERROR',
      text: `视觉模型读取异常：${String(error?.message || error)}`,
      model: config.model,
    };
  }
}

type VisionRuntimeConfig = {
  ok: true;
  model: string;
  apiKey: string;
  baseUrl: string;
} | {
  ok: false;
  reason: string;
  text: string;
};

function getVisionRuntimeConfig(): VisionRuntimeConfig {
  const model = process.env.BAMBOOK_VISION_MODEL_NAME?.trim();
  const apiKey = (
    process.env.BAMBOOK_VISION_API_KEY ||
    process.env.ARK_API_KEY ||
    process.env.VOLCENGINE_API_KEY ||
    ''
  ).trim();
  const baseUrl = (process.env.BAMBOOK_VISION_BASE_URL || DEFAULT_VISION_BASE_URL).replace(/\/+$/, '');

  if (!model) {
    return {
      ok: false,
      reason: 'VISION_MODEL_NOT_CONFIGURED',
      text: '视觉模型未配置。当前运行时已收到图片/扫描件，但不会让文本模型假装已经看过内容。请配置 BAMBOOK_VISION_MODEL_NAME 后再执行图片/OCR 读取。',
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      reason: 'VISION_API_KEY_NOT_CONFIGURED',
      text: '视觉模型 API Key 未配置。当前运行时已收到图片/扫描件，但不能执行图片/OCR 读取。',
    };
  }

  return { ok: true, model, apiKey, baseUrl };
}

type RenderedPdfPage = {
  pageNumber: number;
  data: string;
};

async function renderPdfPagesForVision(
  buffer: Buffer,
  options: { maxPages: number; scale: number; signal?: AbortSignal },
): Promise<{ ok: true; totalPages: number; pages: RenderedPdfPage[] } | { ok: false; error: string }> {
  try {
    const [{ getDocument }, { createCanvas }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<any>,
      import('@napi-rs/canvas') as Promise<any>,
    ]);
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    const totalPages = Number(pdf.numPages || 0);
    const pageCount = Math.min(totalPages, options.maxPages);
    const pages: RenderedPdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (options.signal?.aborted) break;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: options.scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport }).promise;
      const png = canvas.toBuffer('image/png');
      pages.push({
        pageNumber,
        data: png.toString('base64'),
      });
    }

    await pdf.destroy?.();
    return { ok: true, totalPages, pages };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function normalizeBase64Payload(value: string) {
  return value.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
}

function extractVisionText(json: any) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function cleanPdfExtractedText(value: string) {
  return String(value || '')
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '')
    .trim();
}

function limitAttachmentText(value: string) {
  const text = value.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_ATTACHMENT_CONTEXT_CHARS
    ? `${text.slice(0, MAX_ATTACHMENT_CONTEXT_CHARS)}\n\n[工作区文件内容过长，已截断]`
    : text;
}

function normalizeRoles(roles: string[] | undefined): AgentRole[] | undefined {
  if (!roles?.length) return undefined;
  const allowed = new Set<AgentRole>(['owner', 'admin', 'manager', 'merchandiser', 'finance', 'sales', 'logistics', 'production_manager', 'factory', 'viewer', 'agent_operator']);
  return roles.filter((role): role is AgentRole => allowed.has(role as AgentRole));
}
