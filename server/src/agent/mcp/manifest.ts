import { DEFAULT_AGENT_TOOLS } from '../defaults';
import { ToolManifest, ToolManifestSafety } from './types';

/**
 * Phase 7 Runtime 2.0：Tool Manifest 协议。
 *
 * 设计目标：
 *   - 单一权威源：manifest 是工具能力清单的唯一公开协议（前端能力发现、planner、文档同源）。
 *   - 与 ToolDescriptor 对齐：name/inputHint 字段直接复用 ai/runner.ts.AGENT_LOOP_TOOL_DESCRIPTORS 的语义。
 *   - safety 元数据：明确每个工具是否走审批、是否有副作用、哪些字段允许审批侧"修改参数"覆盖。
 *
 * 注意：本协议仅声明能力与安全边界。它不会自己改动生产路径，
 *      生产 planner 仍然是 mcp/planner.ts 的规则化版本，由 BAMBOOK_AGENT_LOOP=1 控制是否切换 LLM 路径。
 */

const toolDefaults = new Map(DEFAULT_AGENT_TOOLS.map(tool => [tool.id, tool]));

const READ_ONLY_SAFETY: ToolManifestSafety = {
  approval: 'never',
  sideEffects: false,
};

type ManifestSeed = {
  id: string;
  name: string;
  domain: string;
  description: string;
  inputHint: string;
  example: ToolManifest['examples'][number];
  safety?: ToolManifestSafety;
};

const MANIFEST_SEEDS: ManifestSeed[] = [
  {
    id: 'memory.recall',
    name: 'Recall Memories',
    domain: 'memory',
    description: '检索当前用户的跨会话记忆（偏好/惯例/业务规则）。用户问"我之前说过什么/记住的规则"或需要个性化上下文时调用。',
    inputHint: '{ scope?: string, query?: string, limit?: number }',
    example: {
      user: '我之前让你记住了哪些偏好？',
      input: { query: '' },
    },
  },
  {
    id: 'memory.write',
    name: 'Write Memory',
    domain: 'memory',
    description: '把用户明确要求记住的信息（偏好/惯例/规则）写入跨会话记忆。仅当用户明确说"记住这个"或语义等价时调用；scope 只能写当前用户可访问范围。',
    inputHint: '{ scope: string /* personal:{userId} 默认 */, memoryType: string /* preference|process|rule|fact */, content: string, summary?: string }',
    example: {
      user: '记住：给 Aurora 的报价单一律用 USD。',
      input: { scope: 'personal:kevin', memoryType: 'rule', content: '给 Aurora 的报价单一律用 USD' },
    },
    // 个人范围笔记写入（用户在会话中已明确确认"记住这个"），低摩擦设计不走审批；
    // 越权 scope 由 memory 服务 memoryScopes 守卫拒绝
    safety: { approval: 'never', sideEffects: true },
  },
  {
    id: 'products.query',
    name: 'Query Product Assets',
    domain: 'products',
    description: '按条件检索数字档案候选或返回统计；不唯一时只返回候选不要猜测。query 用于实体名/SKU 等短字面匹配，维度筛选走 filters。',
    inputHint: '{ query?: string /* 短实体文本，例如 SKU/品名；不要塞整句话 */, mainCategory?: string, filters?: { certifications?: string[], composition?: string, supplier?: string }, sort?: { field: string, direction: "asc"|"desc" }, limit?: number, offset?: number }',
    example: {
      user: '找出 RWS 羊毛精纺里最近更新的 10 条，并按供应商分组。',
      input: { query: '羊毛精纺', mainCategory: 'Fabric', filters: { certifications: ['RWS'] }, sort: { field: 'updatedAt', direction: 'desc' }, limit: 10 },
    },
  },
  {
    id: 'products.get',
    name: 'Get Product Asset',
    domain: 'products',
    description: '按 SKU/Article No./id 读取唯一档案；不唯一时不会返回。',
    inputHint: '{ sku?: string, articleNo?: string, id?: string }',
    example: {
      user: '读取 SKU 10039184 的完整数字档案。',
      input: { sku: '10039184' },
    },
  },
  {
    id: 'products.expand',
    name: 'Expand Product Asset Context',
    domain: 'products',
    description: '展开档案的价格、成分、认证、图片、客户编码、关联关系等。',
    inputHint: '{ id?: string, sku?: string, articleNo?: string, include?: Array<"profile"|"pricing"|"certifications"|"composition"|"images"|"customerCodes"|"relations"> }',
    example: {
      user: '展开 SKU 10039184 的价格、成分、认证、客户码和关联关系。',
      input: { sku: '10039184', include: ['profile', 'pricing', 'certifications', 'composition', 'images', 'customerCodes', 'relations'] },
    },
  },
  {
    id: 'products.describe_schema',
    name: 'Describe Product Asset Schema',
    domain: 'products',
    description: '读取数字档案字段、筛选和排序能力清单。',
    inputHint: '{}',
    example: {
      user: '数字档案有哪些字段可以筛选？',
      input: {},
    },
  },
  {
    id: 'relations.query',
    name: 'Query Relations',
    domain: 'relations',
    description: '检索公司/客户/供应商/联系人档案候选。query 填实体名短文本，类别走 filters.categories。',
    inputHint: '{ query?: string /* 实体名短文本；不要塞整句 */, filters?: { categories?: Array<"Customer"|"Supplier"|"Contact">, address?: string, paymentTerms?: string }, sort?: { field: "lastInteraction"|"updatedAt", direction: "asc"|"desc" }, limit?: number }',
    example: {
      user: '找出加拿大客户里最近半年有互动的客户。',
      input: { filters: { categories: ['Customer'], address: 'Canada' }, sort: { field: 'lastInteraction', direction: 'desc' }, limit: 20 },
    },
  },
  {
    id: 'relations.get',
    name: 'Get Relation',
    domain: 'relations',
    description: '按 id/名称读取唯一关系档案。',
    inputHint: '{ id?: string, name?: string }',
    example: {
      user: '读取关系档案的账单地址、联系人、付款条款等基本信息。',
      input: { name: '<RELATION_NAME>' },
    },
  },
  {
    id: 'relations.expand',
    name: 'Expand Relation Context',
    domain: 'relations',
    description: '展开主联系人/备用联系人/通讯录人物 people/上下文。',
    inputHint: '{ id?: string, name?: string, include?: Array<"profile"|"contacts"|"people">, limit?: number }',
    example: {
      user: '展开关系档案的联系人和关联人物。',
      input: { id: '<RELATION_ID>', include: ['profile', 'contacts', 'people'], limit: 10 },
    },
  },
  // task Agent-P1: relation.update（draft→approval→commit，复用 updateRelation service）
  {
    id: 'relation.update',
    name: 'Update Relation',
    domain: 'relations',
    description: '关系资料更新流程（draft→approval→commit）：审批前读取真实 relation 快照，审批后复用 updateRelation service。只允许显式 patch 字段，不会默认清空未传 ERP 主数据。',
    inputHint: '{ relationId: string, patch: { name?: string, category?: "Customer"|"Supplier"|"Agent"|"Partner"|"Government"|"Internal"|"Other", type?: string, parentId?: string|null, tags?: string[], contactInfo?: string, ...explicit relation fields } }',
    example: { user: '更新关系资料名称。', input: { relationId: '<RELATION_ID>', patch: { name: 'Updated Name' } } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: relation.delete（draft→approval→commit，复用 deleteRelation service）
  {
    id: 'relation.delete',
    name: 'Delete Relation',
    domain: 'relations',
    description: '关系资料软删除流程（draft→approval→commit）：审批前确认 relation 存在且未 deletedAt，审批后复用 deleteRelation service 软删并清理 EntityReference/EntityLink。高风险，不可直接物理删除。',
    inputHint: '{ relationId: string /* 必填：要软删除的 relation id；会设置 deletedAt 并 inactive 相关 EntityReference/EntityLink */ }',
    example: { user: '删除关系资料。', input: { relationId: '<RELATION_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: relation.onboard（draft→approval→commit flow）
  {
    id: 'relation.onboard',
    name: 'Onboard Relation',
    domain: 'relations',
    description: '关系建档复合流程（draft→approval→commit）：创建 organization relation + primary contact relation，事务内 EntityLink sync + AuditLog。不自动发送邮件（welcome email 排除）。',
    inputHint: '{ organization: { id: string, name: string, category: "Customer"|"Supplier"|"Agent"|"Partner"|"Government"|"Internal"|"Other", type?: string, notes?: string, website?: string, paymentTerms?: string }, contact?: { id: string, name: string, email?: string, phone?: string } }',
    example: {
      user: '帮我新建一个客户：江苏测试纺织有限公司，联系人张三。',
      input: { organization: { id: 'ORG-JS-TEX', name: '江苏测试纺织有限公司', category: 'Customer' }, contact: { id: 'CT-ZHANG', name: '张三', email: 'zhang@test.com', phone: '13800000000' } },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'relations.create',
    name: 'Create Relation',
    domain: 'relations',
    description: '新建公司/客户/供应商/联系人档案。写操作：影响关系智库主表，必须 approval。组织的 category 必须是 7 个业务分类之一：Customer(客户)/Supplier(供应商)/Agent(代理商)/Partner(合作伙伴)/Government(政府机构)/Internal(内部)/Other(其他)。用户没明确指定时必须先确认是哪一类。',
    inputHint: '{ id: string /* 必填唯一 id 如 ORG-XXX */, name: string /* 必填 */, category: "Customer"|"Supplier"|"Agent"|"Partner"|"Government"|"Internal"|"Other" /* 组织必填：7 个业务分类之一 */, type?: string /* 可选细分类 */, isOrganization?: boolean /* 默认 true */, notes?: string /* 备注/联系人信息 */, address?: string, paymentTerms?: string, primaryContactName?: string, primaryContactEmail?: string, primaryContactPhone?: string, website?: string }',
    example: {
      user: '帮我新建一个客户：江苏测试纺织有限公司。',
      input: { id: 'ORG-DEMO-JS-TEX', name: '江苏测试纺织有限公司', category: 'Customer' },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['id', 'name', 'category', 'type', 'notes', 'address', 'paymentTerms', 'primaryContactName', 'primaryContactEmail', 'primaryContactPhone', 'website'] },
  },
  {
    id: 'orders.query',
    name: 'Query Orders',
    domain: 'orders',
    description: '按客户/供应商/PO/状态/交期等条件检索订单。客户名 ⇒ filters.customer；供应商/工厂 ⇒ filters.supplier；不要把整句问题塞 query。',
    inputHint: '{ query?: string /* 短字面文本，例如 SKU/PO/品名；查客户请用 filters.customer */, filters?: { customer?: string, supplier?: string, poNumber?: string, statuses?: string[], dueDateFrom?: string /* YYYY-MM-DD */, dueDateTo?: string, missingFields?: string[] }, sort?: { field: "dueDate"|"updatedAt"|"createdAt", direction: "asc"|"desc" }, aggregate?: "count"|"list"|"detail", limit?: number, offset?: number }',
    example: {
      user: '下周交期的订单里哪些缺供应商发票号？',
      input: { filters: { dueDateTo: '2026-06-18', missingFields: ['supplierInvoiceNumber'] }, sort: { field: 'dueDate', direction: 'asc' }, limit: 50 },
    },
  },
  {
    id: 'orders.get',
    name: 'Get Order',
    domain: 'orders',
    description: '按订单 id 或 PO 读取订单与订单行。',
    inputHint: '{ poNumber?: string, id?: string }',
    example: {
      user: '读取指定 PO 的订单详情。',
      input: { poNumber: '<PO_NUMBER>' },
    },
  },
  {
    id: 'orders.expand',
    name: 'Expand Order Context',
    domain: 'orders',
    description: '展开订单行、客户/供应商、发票、样品、生产节点等。',
    inputHint: '{ id?: string, poNumber?: string, sections?: Array<"summary"|"lines"|"parties"|"dates"|"invoices"|"samples"|"production"|"missingFields"|"currencies"> }',
    example: {
      user: '展开指定 PO 的订单行、客户供应商、发票、样品和生产节点。',
      input: { poNumber: '<PO_NUMBER>', include: ['summary', 'lines', 'parties', 'dates', 'invoices', 'samples', 'production', 'missingFields', 'currencies'] },
    },
  },
  {
    id: 'knowledge.search',
    name: 'Search Knowledge Base',
    domain: 'knowledge',
    description: '检索 KnowledgeDocument / KnowledgeChunk；用于公司知识、政策、流程类问题。query 用关键词组合，不要塞整句。',
    inputHint: '{ query: string /* 关键词，如 "样品发票规则"；不要塞整句 */, limit?: number }',
    example: {
      user: '根据公司知识库的样品发票规则，检查这张订单还缺哪些信息。',
      input: { query: '样品发票规则', limit: 8 },
    },
  },

  {
    id: 'knowledge.ingest',
    name: 'Ingest Knowledge Document',
    domain: 'knowledge',
    description: '知识文档写入 draft→approval→commit flow。commit 复用 ingestKnowledgeDocument shared service，不在 Agent path 手写 KnowledgeDocument/KnowledgeChunk/ACL/audit DB mutation。支持 title/text/sourceType/sourceUri/tags/metadata/scopes 输入契约。',
    inputHint: '{ title: string, text: string, sourceType?: string, sourceUri?: string, tags?: string[], metadata?: object, scopes?: string[] }',
    example: { user: '写入一份知识文档。', input: { title: '产品规格说明', text: '详细内容...', scopes: ['company'] } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'entities.search',
    name: 'Search Business Entities',
    domain: 'entities',
    description: '统一解析业务实体候选，例如客户、联系人、面料、订单行；常作为后续工具的 typedRef 入口。',
    inputHint: '{ query: string /* 空格分隔的实体名/编号短文本 */, limit?: number }',
    example: {
      user: '解析查询中提到的客户、面料和订单实体。',
      input: { query: '<ENTITY_NAME> <ARTICLE_NO>', limit: 10 },
    },
  },
  {
    id: 'entities.hydrate',
    name: 'Hydrate Business Entities',
    domain: 'entities',
    description: '按 typed reference 读取实体详情，用于多步计划中补全上下文。',
    inputHint: '{ refs: Array<{ entityType: string /* e.g. "relation.organization" */, id: string }> }',
    example: {
      user: '读取上一步候选实体详情。',
      input: { refs: [{ entityType: 'relation.organization', id: '<RELATION_ID>' }] },
    },
  },
  {
    id: 'development.query',
    name: 'Query Development Cases',
    domain: 'development',
    description: '检索开发单/样品单候选。query 填开发单编号/名称短文本，类型走 filters.type，阶段走 filters.stage。',
    inputHint: '{ query?: string /* 短文本；编号/名称/客户名 */, filters?: { type?: Array<"fabric"|"garment"|"pp"|"trim">, stage?: Array<"developing"|"shipping"|"feedback"|"revision"|"approved"|"cancelled">, customer?: string, supplier?: string, owner?: string, priority?: Array<"urgent"|"high"|"normal"|"low"> }, sort?: { field: "targetDate"|"createdAt"|"updatedAt", direction: "asc"|"desc" }, limit?: number, offset?: number }',
    example: {
      user: '找出所有待客户反馈的面料开发样。',
      input: { filters: { type: ['fabric'], stage: ['feedback'] }, sort: { field: 'targetDate', direction: 'asc' }, limit: 20 },
    },
  },
  {
    id: 'development.get',
    name: 'Get Development Case',
    domain: 'development',
    description: '按 id 或编号读取唯一开发单详情。',
    inputHint: '{ id?: string, code?: string }',
    example: {
      user: '读取 DEV-2601-001 的完整开发单信息。',
      input: { code: 'DEV-2601-001' },
    },
  },
  {
    id: 'development.update_stage',
    name: 'Update Development Case Stage',
    domain: 'development',
    description: '更新开发单阶段，支持自动递轮次(revision→round+1)和自动完成(approved→completedDate)。有副作用，需审批。',
    inputHint: '{ id: string, stage: "developing"|"shipping"|"feedback"|"revision"|"approved"|"cancelled", nextAction?: string }',
    example: {
      user: '将 DEV-2601-001 标记为待寄样阶段。',
      input: { id: '<DEV_CASE_ID>', stage: 'shipping', nextAction: '寄出 S2 色样' },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['stage', 'nextAction'] },
  },
  {
    id: 'development.convert_to_order',
    name: 'Convert Development Case to Order',
    domain: 'development',
    description: '将已确认的开发单转为大货订单。有副作用，需审批。',
    inputHint: '{ id: string, orderId: string, orderPo: string }',
    example: {
      user: '将 DEV-2601-003 转为大货订单。',
      input: { id: '<DEV_CASE_ID>', orderId: '<ORDER_ID>', orderPo: 'PO-2601003' },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['orderId', 'orderPo'] },
  },
  // ── Production Management Tools ─────────────────────────────────────────
  {
    id: 'orders.list_by_status',
    name: 'List Orders by Status',
    domain: 'orders',
    description: '按状态查看订单列表。支持面料/成衣筛选。返回精简摘要（id, poNumber, customer, status, dueDate, quantity）。',
    inputHint: '{ status?: Array<"Pending"|"Confirmed"|"Production"|"Shipping"|"Delivered"|"Alert">, type?: "Fabric"|"Garment", customer?: string, overdue?: boolean, limit?: number }',
    example: {
      user: '查看所有超期订单。',
      input: { status: ['Alert'], limit: 20 },
    },
  },
  {
    id: 'orders.update_status',
    name: 'Update Order Status',
    domain: 'orders',
    description: '推进订单状态（带审计追踪）。有副作用，需审批。',
    inputHint: '{ orderId: string, toStatus: "Pending"|"Confirmed"|"Production"|"Shipping"|"Delivered"|"Alert", note?: string }',
    example: {
      user: '把 PO-2601002 标记为生产中。',
      input: { orderId: '<ORDER_ID>', toStatus: 'Production', note: '面料投缸' },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['toStatus', 'note'] },
  },
  {
    id: 'orders.get_timeline',
    name: 'Get Order Status Timeline',
    domain: 'orders',
    description: '查看订单的生产进度时间线（所有状态变更记录）。',
    inputHint: '{ orderId: string }',
    example: {
      user: '查看 PO-2601001 的生产进度。',
      input: { orderId: '<ORDER_ID>' },
    },
  },
  {
    id: 'orders.batch_status',
    name: 'Batch Update Order Status',
    domain: 'orders',
    description: '批量推进多个订单的状态。有副作用，需审批。',
    inputHint: '{ orderIds: Array<string>, toStatus: "Confirmed"|"Production"|"Shipping"|"Delivered", note?: string }',
    example: {
      user: '把这3个订单都标为已确认。',
      input: { orderIds: ['<ID1>', '<ID2>', '<ID3>'], toStatus: 'Confirmed', note: '客户批量确认' },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['toStatus', 'note'] },
  },
  {
    id: 'orders.kanban',
    name: 'Get Orders Kanban Summary',
    domain: 'orders',
    description: '看板聚合：按状态分组统计订单数量和金额。',
    inputHint: '{ type?: "Fabric"|"Garment" }',
    example: {
      user: '看板视图：各状态有多少订单？',
      input: {},
    },
  },
  {
    id: 'garment.update_size_breakdown',
    name: 'Update Garment Size Breakdown',
    domain: 'orders',
    description: '更新成衣订单行的尺码分配。有副作用，需审批。',
    inputHint: '{ lineId: string, sizeBreakdown: Record<string, number> /* e.g. { S:50, M:100, L:100, XL:80 } */ }',
    example: {
      user: '更新 PO-2601007 的尺码分配。',
      input: { lineId: '<LINE_ID>', sizeBreakdown: { S: 50, M: 120, L: 120, XL: 60 } },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['sizeBreakdown'] },
  },
  {
    id: 'garment.update_production_steps',
    name: 'Update Garment Production Steps',
    domain: 'orders',
    description: '更新成衣订单行的生产工序进度。有副作用，需审批。',
    inputHint: '{ lineId: string, productionSteps: Array<{ step: "cutting"|"sewing"|"qc"|"packing"|"shipping", status: "pending"|"in_progress"|"done", date?: string }> }',
    example: {
      user: '更新 PO-2601007 裁剪已完成。',
      input: { lineId: '<LINE_ID>', productionSteps: [{ step: 'cutting', status: 'done', date: '2026-01-15' }, { step: 'sewing', status: 'in_progress', date: '2026-01-25' }] },
    },
    safety: { approval: 'always', sideEffects: true, editableFields: ['productionSteps'] },
  },
  // ---------------------------------------------------------------------------
  // Cross-module relationship graph (EntityLink)
  // ---------------------------------------------------------------------------
  {
    id: 'links.query',
    name: 'Query Entity Links',
    domain: 'entities',
    description: '查询实体关联：传 {type,id} 返回该实体所有关联（双向）；或用 {fromType,fromId} 只看出向、{toType,toId} 只看入向。用于"X 关联了哪些 Y"，例如客户的所有订单/开发单、面料被哪些订单引用。',
    inputHint: '{ type, id, linkKind?, limit? } | { fromType, fromId, toType?, linkKind?, limit? } | { toType, toId, fromType?, linkKind?, limit? }',
    example: {
      user: 'Peerless 这家客户都关联了哪些订单和开发单？',
      input: { type: 'relation.organization', id: 'ORG-PEERLESS', limit: 100 },
    },
  },
  {
    id: 'links.expand_neighbors',
    name: 'Expand Entity Neighbors',
    domain: 'entities',
    description: '一跳邻居：按 linkKind 分组返回相邻实体，便于在详情面板展示"客户的订单/开发单/联系人"。',
    inputHint: '{ type: string, id: string, limit?: number }',
    example: {
      user: '展开 SUP-001 这个供应商的所有上下文。',
      input: { type: 'relation.organization', id: 'ORG-SUP-001', limit: 200 },
    },
  },
  // ─── 财务管理 (finance) — generated by scaffold-module.ts ───
  {
    id: 'finance.list_invoices',
    name: 'List Invoices',
    domain: 'finance',
    description: '按条件检索发票（应收/应付）。filters 走 type/status/customerRelationId/orderId/dueDate 区间。',
    inputHint: '{ filters?: { type?: "Receivable"|"Payable", status?: string[], customerRelationId?: string, orderId?: string, dueDateFrom?: string, dueDateTo?: string, currency?: string }, sort?: { field: "dueDate"|"issueDate"|"createdAt", direction: "asc"|"desc" }, limit?: number }',
    example: {
      user: '本月到期未结清的应收发票有哪些？',
      input: { filters: { type: 'Receivable', status: ['Issued', 'PartiallyPaid'], dueDateTo: '2026-06-30' }, sort: { field: 'dueDate', direction: 'asc' }, limit: 50 },
    },
  },
  {
    id: 'finance.get_invoice',
    name: 'Get Invoice',
    domain: 'finance',
    description: '按 invoiceNumber / id 读取单张发票详情（含核销快照）。',
    inputHint: '{ invoiceNumber?: string, id?: string }',
    example: {
      user: '读取发票号 INV-20260615-001 的完整信息。',
      input: { invoiceNumber: 'INV-20260615-001' },
    },
  },
  {
    id: 'finance.list_vouchers',
    name: 'List Payment Vouchers',
    domain: 'finance',
    description: '按条件检索收/付款凭证。可按 invoiceId 反查"这张发票收过哪些款"。',
    inputHint: '{ filters?: { type?: "Receipt"|"Disbursement", invoiceId?: string, customerRelationId?: string, orderId?: string, paymentDateFrom?: string, paymentDateTo?: string }, sort?: { field: "paymentDate"|"createdAt", direction: "asc"|"desc" }, limit?: number }',
    example: {
      user: '发票 INV-20260615-001 收过几笔款？',
      input: { filters: { invoiceId: '<INVOICE_ID>' }, sort: { field: 'paymentDate', direction: 'asc' }, limit: 50 },
    },
  },
  {
    id: 'finance.get_voucher',
    name: 'Get Payment Voucher',
    domain: 'finance',
    description: '按 voucherNumber / id 读取单张收/付款凭证。',
    inputHint: '{ voucherNumber?: string, id?: string }',
    example: {
      user: '读取凭证 PAY-20260615-001 的完整信息。',
      input: { voucherNumber: 'PAY-20260615-001' },
    },
  },
  {
    id: 'finance.query_outstanding',
    name: 'Query Outstanding Balance',
    domain: 'finance',
    description: '聚合查询某客户/订单的未结清应收应付（合计金额 + 笔数 + 最早到期日）。',
    inputHint: '{ scope: { customerRelationId?: string, orderId?: string }, type?: "Receivable"|"Payable", asOfDate?: string }',
    example: {
      user: '客户 Peerless 还有多少应收没收回？',
      input: { scope: { customerRelationId: '<RELATION_ID>' }, type: 'Receivable' },
    },
  },
  { id: 'invoice.create', name: 'Invoice Create', domain: 'finance', description: '发票创建流程（draft→approval→commit），金额/汇率使用 Decimal 语义，审批后复用 createInvoice service。', inputHint: '{ input: { invoiceNumber, type, amount: string, currency, issueDate, status?, dueDate?, exchangeRate?: string, baseCurrency?, orderId?, customerRelationId?, customerName?, notes?, attachments? } }', example: { user: '创建一张发票。', input: { input: { invoiceNumber: '<INVOICE_NUMBER>', type: 'Receivable', amount: '1000.0000', currency: 'USD', issueDate: '2026-07-02' } } }, safety: { approval: 'always', sideEffects: true } },
  { id: 'invoice.update', name: 'Invoice Update', domain: 'finance', description: '发票更新流程（draft→approval→commit），审批前读取真实 invoice 快照，审批后复用 updateInvoice service。', inputHint: '{ invoiceId: string, patch: { amount?: string, status?: "Draft"|"Issued"|"PartiallyPaid"|"Paid"|"Cancelled", exchangeRate?: string, orderId?, customerRelationId?, notes? } }', example: { user: '更新发票金额。', input: { invoiceId: '<INVOICE_ID>', patch: { amount: '1200.0000' } } }, safety: { approval: 'always', sideEffects: true } },
  // task Agent-P1: invoice.issue（draft→approval→commit flow）
  {
    id: 'invoice.issue',
    name: 'Issue Invoice',
    domain: 'finance',
    description: '发票开具复合流程（draft→approval→commit）：创建发票并执行 Draft→Issued 状态转移，同事务写 Outbox Email(direction=outbound, mailbox=Outbox) 待发。审批后事务内写 Invoice(status=Issued) + Email + syncInvoiceReferences(EntityLink aboutOrder/billTo) + AuditLog。不 SMTP 发送，不写 Sent/sentAt/messageId。',
    inputHint: '{ invoiceNumber: string, amount: number, currency?: string, type?: "Receivable"|"Payable", issueDate?: string, dueDate?: string, customerRelationId?: string, customerName?: string, orderId?: string, notes?: string, email?: { to: string[], subject: string, bodyText: string } }',
    example: {
      user: '帮我把订单 PO-001 的发票 INV-001 开出来，金额 10000 CNY，并发邮件通知客户。',
      input: { invoiceNumber: 'INV-001', amount: 10000, currency: 'CNY', orderId: '<ORDER_ID>', customerRelationId: '<RELATION_ID>', email: { to: ['customer@example.com'], subject: '发票已开具 INV-001', bodyText: '您的发票 INV-001 已开具，金额 10000 CNY。' } },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'finance.create_invoice',
    name: 'Create Invoice',
    domain: 'finance',
    description: '创建发票（应收 Receivable / 应付 Payable）。资金动作：影响应收应付账款，必须 approval。',
    inputHint: '{ type: "Receivable"|"Payable", invoiceNumber: string, amount: number, currency: string, issueDate: string, dueDate?: string, exchangeRate?: number, baseCurrency?: string, orderId?: string, customerRelationId?: string, customerName?: string, notes?: string }',
    example: {
      user: '为订单 PO-2026-001 创建一张 50000 USD 的应收发票。',
      input: { type: 'Receivable', invoiceNumber: 'INV-20260615-001', amount: 50000, currency: 'USD', issueDate: '2026-06-15', dueDate: '2026-09-13', exchangeRate: 7.18, orderId: '<ORDER_ID>', customerRelationId: '<RELATION_ID>' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'finance.create_voucher',
    name: 'Create Payment Voucher',
    domain: 'finance',
    description: '创建收/付款凭证（资金实际入/出账）。资金动作：必须 approval。',
    inputHint: '{ type: "Receipt"|"Disbursement", voucherNumber: string, amount: number, currency: string, paymentDate: string, paymentMethod: string, exchangeRate?: number, bankFee?: number, invoiceId?: string, appliedAmount?: number, orderId?: string, customerRelationId?: string, customerName?: string, notes?: string }',
    example: {
      user: '收到客户 Peerless 一笔 30000 USD 的 TT 收款，对应发票 INV-20260615-001。',
      input: { type: 'Receipt', voucherNumber: 'PAY-20260615-001', amount: 30000, currency: 'USD', paymentDate: '2026-06-15', paymentMethod: 'TT', invoiceId: '<INVOICE_ID>', appliedAmount: 30000, customerRelationId: '<RELATION_ID>' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'finance.apply_voucher_to_invoice',
    name: 'Apply Voucher To Invoice',
    domain: 'finance',
    description: '把已挂账的凭证核销到指定发票（更新 invoiceId / appliedAmount，并按累计核销额刷新发票 status：PartiallyPaid / Paid）。资金动作：必须 approval。',
    inputHint: '{ voucherId: string, invoiceId: string, appliedAmount: number, notes?: string }',
    example: {
      user: '把凭证 PAY-20260615-001 中的 20000 USD 核销到发票 INV-20260615-001。',
      input: { voucherId: '<VOUCHER_ID>', invoiceId: '<INVOICE_ID>', appliedAmount: 20000 },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'payment.receive_and_reconcile',
    name: 'Receive Payment And Reconcile',
    domain: 'finance',
    description: '收款核销复合流程（draft→approval→commit）：生成 create_voucher + N 笔 allocation 的 ProcessDraft，审批后事务内复用 allocation route/service 完成核销 + invoice/voucher status 重算 + EntityLink sync + audit。支持 split voucher（一笔凭证核销多张发票）。',
    inputHint: '{ voucherId: string, voucherAmount: number, currency: string, allocations: Array<{ invoiceId: string, appliedAmount: string /* Decimal string recommended, e.g. "123456789012345.1234" */ }> }',
    example: {
      user: '收到凭证 PAY-001 的 1000 USD，核销 600 到发票 INV-A、400 到发票 INV-B。',
      input: { voucherId: 'PAY-001', voucherAmount: 1000, currency: 'USD', allocations: [{ invoiceId: 'INV-A', appliedAmount: '600.0000' }, { invoiceId: 'INV-B', appliedAmount: '400.0000' }] },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'order.ship',
    name: 'Ship Order',
    domain: 'shipping',
    description: '订单发货复合流程（draft→approval→commit）：创建运单并联动 Order 状态（Booked/Loading/Shipped/Arrived/Cleared→Order Shipping, Delivered→Order Delivered）。审批后事务内复用已 merged shipping-order link + status transition，写 EntityLink sync + OrderStatusTransition + audit。',
    inputHint: '{ orderId: string, shipment: { shipmentNumber: string, type: string, shippingMethod: string, status?: string } }',
    example: {
      user: '把订单 PO-20260615-001 发货，创建运单 SHIP-001。',
      input: { orderId: '<ORDER_ID>', shipment: { shipmentNumber: 'SHIP-001', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked' } },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // ── Shipping (货运管理) ──
  {
    id: 'shipping.list_shipments',
    name: 'List Shipments',
    domain: 'shipping',
    description: '按条件检索运单/装箱单。filters 走 type/status/orderId/customerRelationId/carrierRelationId/carrier。',
    inputHint: '{ filters?: { type?: "Export"|"Import", status?: string[], orderId?: string, customerRelationId?: string, carrierRelationId?: string, carrier?: string }, sort?: { field: "etd"|"eta"|"createdAt", direction: "asc"|"desc" }, limit?: number }',
    example: {
      user: '最近有哪些出口运单还没开船？',
      input: { filters: { type: 'Export', status: ['Booked', 'Loading'] }, sort: { field: 'etd', direction: 'asc' }, limit: 20 },
    },
  },
  {
    id: 'shipping.get_shipment',
    name: 'Get Shipment',
    domain: 'shipping',
    description: '按 shipmentNumber / id 读取单条运单详情（含装箱/报关信息）。',
    inputHint: '{ shipmentNumber?: string, id?: string }',
    example: {
      user: '读取运单 SHP-20260615-001 的完整信息。',
      input: { shipmentNumber: 'SHP-20260615-001' },
    },
  },
  {
    id: 'shipping.create_shipment',
    name: 'Create Shipment',
    domain: 'shipping',
    description: '创建运单/装箱单（出口 Export / 进口 Import）。物流动作：必须 approval。',
    inputHint: '{ type: "Export"|"Import", shipmentNumber: string, carrier?: string, vessel?: string, voyage?: string, blNumber?: string, etd?: string, eta?: string, portOfLoading?: string, portOfDischarge?: string, containerNumber?: string, sealNumber?: string, cartons?: number, grossWeightKg?: number, netWeightKg?: number, volumeCbm?: number, hsCode?: string, freightCharge?: number, insuranceValue?: number, customsValue?: number, currency?: string, exchangeRate?: number, orderId?: string, customerRelationId?: string, customerName?: string, carrierRelationId?: string, carrierName?: string, notes?: string }',
    example: {
      user: '为订单 PO-2026-001 创建一条出口运单，承运商 COSCO。',
      input: { type: 'Export', shipmentNumber: 'SHP-20260615-001', carrier: 'COSCO', orderId: '<ORDER_ID>', customerRelationId: '<RELATION_ID>' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'shipping.update_tracking_status',
    name: 'Update Tracking Status',
    domain: 'shipping',
    description: '更新运单物流状态（Booked → Loading → Shipped → Arrived → Cleared → Delivered）和轨迹字段。物流动作：必须 approval。',
    inputHint: '{ shipmentId: string, status: string, vessel?: string, voyage?: string, blNumber?: string, etd?: string, eta?: string, notes?: string }',
    example: {
      user: '运单 SHP-20260615-001 已开船，更新状态为 Shipped。',
      input: { shipmentId: '<SHIPMENT_ID>', status: 'Shipped', etd: '2026-06-15' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // ══════════════════════════════════════════════════════════════
  // task ERP-P1: email.reply_and_send（draft→approval→commit flow）
  {
    id: 'email.reply_and_send',
    name: 'Reply And Send Email',
    domain: 'email',
    description: '邮件回复发送复合流程（draft→approval→commit）：审批后事务内写 Email(direction=outbound) + AuditLog。不自动 SMTP 发送（contract 边界）。支持 reply threading + 关联 order/relation。',
    inputHint: '{ replyToEmailId?: string, to: string[], cc?: string[], subject: string, bodyText: string, bodyHtml?: string, relationId?: string, orderId?: string }',
    example: {
      user: '回复邮件 EML__xxx，确认订单 PO-001 已发货。',
      input: { replyToEmailId: '<EMAIL_ID>', to: ['customer@example.com'], subject: 'Re: 订单 PO-001', bodyText: '已发货，运单号 SHIP-001。' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: order.line_update（draft→approval→commit，复用 updateOrderLine service）
  {
    id: 'order.line_update',
    name: 'Order Line Update',
    domain: 'orders',
    description: '订单行更新复合流程（draft→approval→commit）：引用 lineId + patch（字段变更），审批后调用共用 updateOrderLine service（sync + AuditLog 同事务闭环）。',
    inputHint: '{ lineId: string, patch: { materialCode?, quantity?, description?, ... } }',
    example: { user: '把订单行 ORD__xxx__0010 的数量改成 200。', input: { lineId: '<LINE_ID>', patch: { quantity: 200 } } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: order.status_transition（draft→approval→commit，复用 transitionOrderStatus service）
  {
    id: 'order.status_transition',
    name: 'Order Status Transition',
    domain: 'orders',
    description: '订单状态流转复合流程（draft→approval→commit）：引用 orderId + toStatus，审批后调用共用 transitionOrderStatus service（OrderStatusTransition + sync + AuditLog 同事务闭环）。只允许 Pending/Confirmed/Production/Shipping/Delivered/Alert。',
    inputHint: '{ orderId: string, toStatus: "Pending"|"Confirmed"|"Production"|"Shipping"|"Delivered"|"Alert", note?: string, lineId?: string }',
    example: { user: '把订单 ORD__xxx 状态改为 Confirmed。', input: { orderId: '<ORDER_ID>', toStatus: 'Confirmed' } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: order.delete（draft→approval→commit，复用 deleteOrder service）
  {
    id: 'order.delete',
    name: 'Order Delete',
    domain: 'orders',
    description: '订单软删复合流程（draft→approval→commit）：引用 orderId，审批后调用共用 deleteOrder service（deletedAt + EntityLink inactive + AuditLog 同事务闭环）。',
    inputHint: '{ orderId: string }',
    example: { user: '删除订单 ORD__xxx。', input: { orderId: '<ORDER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: product_asset.create
  { id: 'product_asset.create', name: 'Product Asset Create', domain: 'products', description: 'ProductAsset 创建流程（draft→approval→commit），复用 createProductAsset service。', inputHint: '{ body: { sku, name, mainCategory, ... } }', example: { user: '创建面料资产。', input: { body: { sku: 'FAB-001', name: 'Twill', mainCategory: 'Fabric' } } }, safety: { approval: 'always', sideEffects: true } },
  // task Agent-P1: product_asset.update
  { id: 'product_asset.update', name: 'Product Asset Update', domain: 'products', description: 'ProductAsset 更新流程（draft→approval→commit），复用 updateProductAsset service。', inputHint: '{ assetId: string, patch: { ...writableFields } }', example: { user: '更新面料资产名称。', input: { assetId: '<ID>', patch: { name: 'Updated' } } }, safety: { approval: 'always', sideEffects: true } },
  // task Agent-P1: product_asset.delete
  { id: 'product_asset.delete', name: 'Product Asset Delete', domain: 'products', description: 'ProductAsset 软删流程（draft→approval→commit），复用 deleteProductAsset service。', inputHint: '{ assetId: string }', example: { user: '删除面料资产。', input: { assetId: '<ID>' } }, safety: { approval: 'always', sideEffects: true } },
  // task Agent-P1: invoice.delete（draft→approval→commit，复用 deleteInvoice service）
  {
    id: 'invoice.delete',
    name: 'Invoice Delete',
    domain: 'finance',
    description: '发票软删复合流程（draft→approval→commit）：引用 invoiceId，审批后调用共用 deleteInvoice service（deletedAt + EntityLink inactive + AuditLog 同事务闭环）。',
    inputHint: '{ invoiceId: string }',
    example: { user: '删除发票 INV__xxx。', input: { invoiceId: '<INVOICE_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: payment_voucher.create（draft→approval→commit，复用 createPaymentVoucher service）
  {
    id: 'payment_voucher.create',
    name: 'Payment Voucher Create',
    domain: 'finance',
    description: '收/付款凭证创建流程（draft→approval→commit）：金额字段使用 Decimal string，审批后复用 createPaymentVoucher service。',
    inputHint: '{ input: { voucherNumber, type, amount: string, currency, paymentDate, paymentMethod, status?, bankFee?: string, exchangeRate?: string, baseCurrency?, invoiceId?, appliedAmount?: string, orderId?, customerRelationId?, customerName?, notes?, attachments? } }',
    example: { user: '创建一张收款凭证。', input: { input: { voucherNumber: '<VOUCHER_NUMBER>', type: 'Receipt', amount: '30000.0000', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT' } } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: payment_voucher.update（draft→approval→commit，复用 updatePaymentVoucher service）
  {
    id: 'payment_voucher.update',
    name: 'Payment Voucher Update',
    domain: 'finance',
    description: '收/付款凭证更新流程（draft→approval→commit）：审批前读取真实 before snapshot，审批后复用 updatePaymentVoucher service。',
    inputHint: '{ voucherId: string, patch: { amount?: string, status?: "unreconciled"|"partially_reconciled"|"reconciled", bankFee?: string, invoiceId?, appliedAmount?: string, orderId?, customerRelationId?, customerName?, notes?, attachments? } }',
    example: { user: '更新一张收款凭证金额。', input: { voucherId: '<VOUCHER_ID>', patch: { amount: '32000.0000' } } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: payment_voucher.delete（draft→approval→commit，复用 deleteVoucher service）
  {
    id: 'payment_voucher.delete',
    name: 'Payment Voucher Delete',
    domain: 'finance',
    description: '付款凭证软删复合流程（draft→approval→commit）：引用 voucherId，审批后调用共用 deleteVoucher service（deletedAt + EntityLink inactive + AuditLog 同事务闭环）。',
    inputHint: '{ voucherId: string }',
    example: { user: '删除付款凭证 PV__xxx。', input: { voucherId: '<VOUCHER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: invoice.cancel（draft→approval→commit，复用 cancelInvoice service）
  {
    id: 'invoice.cancel',
    name: 'Cancel Invoice',
    domain: 'finance',
    description: '发票作废复合流程（draft→approval→commit）：引用 invoiceId + reason，审批后调用共用 cancelInvoice service（status→Cancelled + EntityLink inactive + AuditLog 同事务闭环）。不绕 route，不手写 DB mutation。',
    inputHint: '{ invoiceId: string /* 必填：要作废的发票 id */, reason?: string /* 作废原因 */ }',
    example: {
      user: '把发票 INV__xxx 作废。',
      input: { invoiceId: '<INVOICE_ID>', reason: '客户退货' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: development.convert_to_order（draft→approval→commit，复用 convertDevCaseToOrder service）
  {
    id: 'development.convert_to_order',
    name: 'Convert Dev Case to Order',
    domain: 'development',
    description: '开发单转大货订单复合流程（draft→approval→commit）：引用 devCaseId + mode(link/autoCreate)，审批后调用共用 convertDevCaseToOrder service（事务闭环 Order create/link + DevCase update + sync + audit）。支持 link existing order 与 autoCreate order 两种模式。',
    inputHint: '{ caseId: string, mode: "link"|"autoCreate", orderId?: string /* link 模式必填 */, orderPo?: string, customer?: string, millName?: string, productName?: string, quantity: number /* autoCreate 必填：正整数 */, dueDate: string /* autoCreate 必填：YYYY-MM-DD */, quoteAmount?: number /* 可选订单金额，默认 0 */ }',
    example: {
      user: '把开发单 DC__xxx 转成大货订单。',
      input: { caseId: '<DEV_CASE_ID>', mode: 'autoCreate', quantity: 1000, dueDate: '2026-10-15' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // task Agent-P1: email.send（draft→approval→commit，消费 Outbox send service）
  {
    id: 'email.send',
    name: 'Send Outbox Email',
    domain: 'email',
    description: 'Outbox 邮件显式发送复合流程（draft→approval→commit）：引用已有 outbound Outbox Email(emailId)，审批后调用共用 Outbox send service 显式 SMTP 发送。SMTP 成功更新 Sent + sentAt + messageId，失败保持 Outbox。不绕过 DB 事实源。',
    inputHint: '{ emailId: string /* 必填：已有 outbound Outbox Email id */, credentials: { user: string, pass: string, host?: string, port?: number } }',
    example: {
      user: '把刚才创建的 Outbox 邮件 EML__xxx 发送出去。',
      input: { emailId: '<OUTBOX_EMAIL_ID>', credentials: { user: 'sender@bambook.com', pass: '***' } },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // Email Module — Phase 4a
  // ══════════════════════════════════════════════════════════════
  {
    id: 'email.list',
    name: 'List Emails',
    domain: 'email',
    description: '查询已同步到数据库的邮件列表，支持按邮箱/方向/状态/发件人/主题/关联订单/关联联系人过滤。Phase 4a：先 sync 再 query。',
    inputHint: '{ mailbox?: string, direction?: "inbound"|"outbound", status?: string, fromAddress?: string, subject?: string, orderId?: string, relationId?: string, limit?: number, offset?: number }',
    example: {
      user: '最近 Peerless 发来的邮件',
      input: { fromAddress: 'peerless', direction: 'inbound', limit: 10 },
    },
  },
  {
    id: 'email.get',
    name: 'Get Email',
    domain: 'email',
    description: '按 ID 读取单封邮件完整内容（正文 + 附件列表）。',
    inputHint: '{ emailId: string }',
    example: {
      user: '看下这封邮件的详情',
      input: { emailId: '<EMAIL_ID>' },
    },
  },
  {
    id: 'email.search',
    name: 'Search Emails',
    domain: 'email',
    description: '全文搜索邮件主题和正文关键词，支持模糊匹配。',
    inputHint: '{ query: string, limit?: number }',
    example: {
      user: '搜索关于报价的邮件',
      input: { query: '报价', limit: 20 },
    },
  },
  {
    id: 'email.sync',
    name: 'Sync Emails from IMAP',
    domain: 'email',
    description: 'IMAP→DB 邮件同步 draft→approval→commit flow。commit 复用 syncEmailsFromImap shared service，不在 Agent path 手写 IMAP/DB/audit。credentialRef 模式确保 approval payload 不含明文 password（admin /approvals 页面安全）。',
    inputHint: '{ credentials: { user: string, pass: string, host?: string, port?: number }, box?: string, limit?: number }',
    example: {
      user: '同步最新的收件箱邮件',
      input: { credentials: { user: 'user@company.com', pass: '***' }, box: 'INBOX', limit: 50 },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'email.link_to_order',
    name: 'Link Email to Order',
    domain: 'email',
    description: '将邮件关联到订单或联系人，写入 EntityLink 图谱（aboutOrder / sentBy）以供跨模块查询。',
    inputHint: '{ emailId: string, orderRelationId?: string, contactRelationId?: string, relationName?: string }',
    example: {
      user: '把这封邮件关联到 DEMO-PO-2601001 订单',
      input: { emailId: 'EML__abc123', orderRelationId: 'DEMO-PO-2601001' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'email.ai_extract',
    name: 'AI Extract Email Fields',
    domain: 'email',
    description: '调用 LLM 从邮件正文抽取结构化字段（意图/产品/数量/价格/交期/客户信号），结果写入 Email.aiExtractedJson。属于高风险写操作（消耗 LLM 配额且写 DB），需要审批。',
    inputHint: '{ emailId: string, force?: boolean /* 强制重新抽取 */, model?: string }',
    example: {
      user: '解析这封询盘邮件的产品和数量',
      input: { emailId: 'EML__abc123' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'template.list',
    name: 'List Templates',
    domain: 'templates',
    description: '列出所有可用的编译模板（id / 标题 / 版本 / 域）。只读，无副作用。',
    inputHint: '{}',
    example: {
      user: '都有哪些发票模板可用',
      input: {},
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'template.render',
    name: 'Render Template (HTML)',
    domain: 'templates',
    description: '把指定模板与数据合成为可下载/可预览的 HTML。纯函数渲染（不写 DB、不发邮件、不出 PDF）。返回 html + sha + bytes。',
    inputHint: "{ templateId: 'invoice.sample.pdas' | 'invoice.sample.fabric', data: object }",
    example: {
      user: '给 ACME 客户出一张 PDAS 样品发票预览',
      input: {
        templateId: 'invoice.sample.pdas',
        data: {
          invoiceNumber: 'PDAS26061501',
          invoiceDate: '2026-06-15',
          customer: { label: 'ACME Trading LLC', billingAddress: '123 Market St\nNew York, NY' },
          items: [{ id: '1', zroh: 'ZR001', description: 'Cotton Sample', qty: 5, unitPrice: 12.5 }],
        },
      },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'template.render_pdf',
    name: 'Render Template to PDF',
    domain: 'templates',
    description: '把指定模板与数据先合成 HTML、再转 PDF（用 Playwright headless Chromium）。生成产物在响应中以 base64 返回。属于资源密集型只读操作（启动浏览器），无副作用但消耗 CPU/内存。',
    inputHint: "{ templateId: string, data: object, format?: 'A4'|'A5'|'Letter', landscape?: boolean }",
    example: {
      user: '把这张样品发票导出成 PDF',
      input: { templateId: 'invoice.sample.pdas', data: { invoiceNumber: 'PDAS26061501', invoiceDate: '2026-06-15', items: [] }, format: 'A4' },
    },
    safety: READ_ONLY_SAFETY,
  },
  // ── C3 高频外贸场景只读工具 ──
  {
    id: 'shipping.scan_delays',
    name: 'Scan Delayed Shipments',
    domain: 'shipping',
    description: '实时扫描出运延误运单：ETD 已过未离港（离港延误）或 ETA 已过未到港（到港延误），返回延误天数与 warning/critical 分级。与调度任务 shipment_delay_detector 同一口径。',
    inputHint: '{ asOf?: "YYYY-MM-DD", limit?: number }',
    example: {
      user: '现在有哪些运单延误了？',
      input: {},
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'quotations.query',
    name: 'Query Quotations',
    domain: 'quotations',
    description: '查询报价单列表：支持状态/客户/日期区间过滤，以及对报价单号、品名、客户名的全文搜索。用于智能报价场景的历史报价回溯。',
    inputHint: '{ filters?: { status?, customerRelationId?, dateFrom?, dateTo? }, query?: string, limit?: number, offset?: number }',
    example: {
      user: '查一下客户 ACME 最近三个月的报价记录。',
      input: { filters: { customerRelationId: '<REL_ID>', dateFrom: '2026-05-01' }, limit: 20 },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'quotations.get',
    name: 'Get Quotation',
    domain: 'quotations',
    description: '按 id 或报价单号读取单条报价单详情（含行明细）。',
    inputHint: '{ id?: string, quotationNumber?: string }',
    example: {
      user: '看一下报价单 QUO-2026-0001 的明细。',
      input: { quotationNumber: 'QUO-2026-0001' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'customs.query_lc',
    name: 'Query Letters of Credit',
    domain: 'customs',
    description: '查询信用证列表：支持状态/客户/开证行过滤，expiringBefore 用于到期预警，支持按信用证号/开证申请人搜索。LC 审单场景的数据入口。',
    inputHint: '{ filters?: { status?, customerRelationId?, issuingBank?, expiringBefore? }, query?: string, limit?: number }',
    example: {
      user: '列出 9 月 1 日前到期的所有已收信用证。',
      input: { filters: { status: 'Received', expiringBefore: '2026-09-01' } },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'customs.get_lc',
    name: 'Get Letter of Credit',
    domain: 'customs',
    description: '按 id 或信用证号读取信用证详情（金额、效期、最迟装运日、单证条款等），供 LC 审单逐条核对。',
    inputHint: '{ id?: string, lcNumber?: string }',
    example: {
      user: '读取信用证 LC2026-001 的完整条款。',
      input: { lcNumber: 'LC2026-001' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'finance.get_aging',
    name: 'Get AR/AP Aging Report',
    domain: 'finance',
    description: '生成应收/应付账龄报告：分币种合计 + 按客户五档账龄（current/1-30/31-60/61-90/90+），行按逾期金额降序。客户风险预警场景的核心数据。',
    inputHint: '{ type?: "Receivable"|"Payable", asOf?: "YYYY-MM-DD", rowLimit?: number }',
    example: {
      user: '哪些客户逾期欠款最多？',
      input: { type: 'Receivable', rowLimit: 10 },
    },
    safety: READ_ONLY_SAFETY,
  },
  // ── E3 NL 高频业务操作（下样品单 / 对账单）──
  {
    id: 'development.create',
    name: 'Create Development Case',
    domain: 'development',
    description: '创建开发单/样品单复合流程（draft→approval→commit）：给某客户下样品单（手刮样/色样/确认样等）走此工具。code/name/type 必填；客户归属必填（customerRelationId 或 customerName 至少其一，只有客户名时先 relations.query 解析）。审批后复用 createDevelopmentCase shared service（事务闭环 EntityLink sync + AuditLog）。',
    inputHint: '{ code: string /* 业务编号，唯一，如 DEV-2608-001 */, name: string /* 样品名，如 "全棉斜纹手刮样" */, type: "fabric"|"garment"|"pp"|"trim", customerRelationId?: string, customerName?: string, supplierName?: string, sampleType?: string /* 如 手刮样/色样/确认样 */, sampleQuantity?: number, sampleUnit?: string /* 默认 meter */, targetDate?: string /* YYYY-MM-DD */, nextAction?: string, priority?: "urgent"|"high"|"normal"|"low", notes?: string }',
    example: {
      user: '给客户 Peerless 下一单样品单：全棉斜纹手刮样 5 米，8 月 20 日前要。',
      input: { code: 'DEV-2608-001', name: '全棉斜纹手刮样', type: 'fabric', customerName: 'Peerless', sampleType: '手刮样', sampleQuantity: 5, sampleUnit: 'meter', targetDate: '2026-08-20' },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'finance.get_statement',
    name: 'Get Customer Statement',
    domain: 'finance',
    description: '生成客户对账单（只读）：按客户聚合应收发票（借）与收款凭证（贷），分币种给出期初余额、逐笔往来、期末余额。用于"看看某客户往来/余额"，对话中直接展示；要生成并投递给客户走 statement.send。',
    inputHint: '{ customerRelationId: string /* 必填；只有客户名时先 relations.query 解析 */, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }',
    example: {
      user: '看一下 Peerless 这个月的对账单。',
      input: { customerRelationId: '<RELATION_ID>', from: '2026-08-01', to: '2026-08-31' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'statement.send',
    name: 'Send Customer Statement',
    domain: 'finance',
    description: '生成对账单并投递给客户复合流程（draft→approval→commit）：draft 内含完整对账单快照（审批即所得），审批后事务内写 outbound Outbox 邮件（正文=对账单明细）+ AuditLog。不 SMTP 发送（contract 边界），显式发送走 email.send。customerRelationId 与 email 必填；期间无往来会被拒绝。',
    inputHint: '{ customerRelationId: string /* 必填；只有客户名时先 relations.query 解析 */, from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", email: { to: string[] /* 客户对账邮箱 */, subject: string } }',
    example: {
      user: '生成本月对账单并发到 Peerless 财务邮箱对账。',
      input: { customerRelationId: '<RELATION_ID>', from: '2026-08-01', to: '2026-08-31', email: { to: ['finance@peerless.com'], subject: 'Statement of Account 2026-08' } },
    },
    safety: { approval: 'always', sideEffects: true },
  },
  // ── Phase 4 Track G：Phase 2 八域只读查询工具 ──
  {
    id: 'moq.query_config',
    name: 'Query MOQ Config',
    domain: 'settings',
    description: '查询当前生效的 MOQ 最小起订量阈值配置（面料/成衣/Capsule 三档），配置缺失时回落兜底常量并标记来源；可选阈值变更历史。',
    inputHint: '{ includeHistory?: boolean, historyLimit?: number }',
    example: {
      user: '现在面料和成衣的最小起订量分别是多少？',
      input: {},
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'order_changes.query',
    name: 'Query Order Change Requests',
    domain: 'orders',
    description: '查询订单变更/取消/暂停申请（DR-010）：按订单/状态/申请人过滤列表，或按申请 ID 读详情（含关联订单与审批单快照）。',
    inputHint: '{ id?: string, orderId?: string, status?: string, requesterId?: string, limit?: number }',
    example: {
      user: '订单 PO-2601001 提交过哪些变更申请？审批到哪一步了？',
      input: { orderId: '<ORDER_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'samples.query',
    name: 'Query Samples',
    domain: 'samples',
    description: '查询样品记录：fabric_shipment 模式按订单列面料寄船样/头缸样（可选发货资格判定）；early_production 模式按订单列早期生产样轮次；garment_rounds 模式按开发案列服装多轮样品及封样状态（DR-008 双门禁）。',
    inputHint: '{ mode?: "fabric_shipment"|"early_production"|"garment_rounds", orderId?: string, caseId?: string, includeEligibility?: boolean }',
    example: {
      user: '这个订单的寄船样都齐了吗？现在能不能发货？',
      input: { mode: 'fabric_shipment', orderId: '<ORDER_ID>', includeEligibility: true },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'qc.query_reports',
    name: 'Query QC Reports',
    domain: 'qc',
    description: '按订单查询 QC 验货报告列表（报告状态/结论/缺陷统计），可选附带 QC 侧出运资格判定。',
    inputHint: '{ orderId: string, includeEligibility?: boolean }',
    example: {
      user: '订单 PO-2601002 的验货结果怎么样？能出货吗？',
      input: { orderId: '<ORDER_ID>', includeEligibility: true },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'exceptions.query',
    name: 'Query Controlled Exceptions',
    domain: 'exceptions',
    description: '查询受控例外申请（DR-013）：按状态/类别/申请人过滤列表，或按申请 ID 读详情（惰性对账审批结论）。',
    inputHint: '{ id?: string, status?: string, exceptionCategory?: string, requesterId?: string, limit?: number }',
    example: {
      user: '现在有哪些还在生效的例外放行？',
      input: { status: 'ReviewerApproved' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'credit.query_status',
    name: 'Query Customer Credit Status',
    domain: 'credit',
    description: '查询客户信用状态：额度总额/已占用/剩余、冻结门禁标记（creditFrozen）、最大逾期天数；可选信用事件历史时间线。',
    inputHint: '{ relationId: string /* 必填；只有客户名时先 relations.query 解析 */, includeHistory?: boolean, historyLimit?: number }',
    example: {
      user: 'Peerless 的信用额度还剩多少？有没有被冻结？',
      input: { relationId: '<RELATION_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'internal_trade.query',
    name: 'Query Internal Transfers',
    domain: 'internal_trade',
    description: '查询内部供料单（服装部向面料部的内部交易，DR-005/033）：按部门/状态/服装订单/面料订单过滤列表，或按供料单 ID 读详情。',
    inputHint: '{ id?: string, departmentId?: string, status?: string, garmentOrderId?: string, fabricOrderId?: string, limit?: number, offset?: number }',
    example: {
      user: '服装部这个月申请了哪些内部供料？',
      input: { limit: 50 },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'payment_requests.query',
    name: 'Query Payment Requests',
    domain: 'finance',
    description: '查询付款申请（DR-017 先申请后付款）：按状态/付款性质/申请人过滤列表，或按申请 ID 读详情（含关联审批单与付款凭证快照）。',
    inputHint: '{ id?: string, status?: string, paymentCategory?: string, applicantId?: string, limit?: number }',
    example: {
      user: '现在有哪些待审批的付款申请？',
      input: { status: 'Pending' },
    },
    safety: READ_ONLY_SAFETY,
  },
  // ── W4 收尾：Agent 工具缺口 5 类只读查询工具 ──
  {
    id: 'purchase_orders.query',
    name: 'Query Purchase Orders',
    domain: 'procurement',
    description: '查询采购单：按状态/供应商/下单日期窗/单号搜索过滤列表，或按采购单 ID 读详情（含行明细与到货记录）。',
    inputHint: '{ id?: string, status?: string, supplierRelationId?: string, dateFrom?: string, dateTo?: string, search?: string, limit?: number, offset?: number }',
    example: {
      user: '供应商 XX 有哪些已确认还没到货的采购单？',
      input: { status: 'Confirmed', supplierRelationId: '<RELATION_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'bom.query',
    name: 'Query BOMs',
    domain: 'bom',
    description: '查询 BOM 物料清单：按状态/产品/订单/报价过滤列表，或按 BOM ID 读详情（含行明细与料/工/费成本汇总）。',
    inputHint: '{ id?: string, status?: string, productAssetId?: string, orderId?: string, quotationId?: string, search?: string, limit?: number, offset?: number }',
    example: {
      user: '订单 <ORDER_ID> 的 BOM 有哪些物料行？总成本多少？',
      input: { orderId: '<ORDER_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'customs.query_tax_refunds',
    name: 'Query Tax Refunds',
    domain: 'customs',
    description: '查询出口退税记录：按状态/报关单/订单/客户过滤列表，或按退税记录 ID 读详情（FOB/退税率/应退金额/审核信息）。',
    inputHint: '{ id?: string, status?: string, declarationId?: string, orderId?: string, relationId?: string, search?: string, limit?: number, offset?: number }',
    example: {
      user: '哪些退税还卡在审核中？',
      input: { status: 'Reviewing' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'customs.query_declarations',
    name: 'Query Customs Declarations',
    domain: 'customs',
    description: '查询报关单：按类型/状态/运单/订单/客户过滤列表，或按报关单 ID 读详情（含行明细）。',
    inputHint: '{ id?: string, type?: string, status?: string, shipmentId?: string, orderId?: string, relationId?: string, search?: string, limit?: number, offset?: number }',
    example: {
      user: '订单 <ORDER_ID> 的报关单号是多少？放行了吗？',
      input: { orderId: '<ORDER_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  {
    id: 'finance.query_allocations',
    name: 'Query Invoice Allocations',
    domain: 'finance',
    description: '查询收付款核销明细：按发票或收款凭证过滤，返回每笔核销金额与日期。',
    inputHint: '{ invoiceId?: string, voucherId?: string, limit?: number }',
    example: {
      user: '发票 <INVOICE_ID> 已经核销了多少钱？',
      input: { invoiceId: '<INVOICE_ID>' },
    },
    safety: READ_ONLY_SAFETY,
  },
  // ── Phase 2 S3a：六新域写工具 ──
  {
    id: 'order_changes.create',
    name: 'Create Order Change Request',
    domain: 'orders',
    description: '订单变更申请创建流程（draft→approval→commit）：引用订单ID、变更类型、前后快照等，审批后调用共用 createChangeRequest service。',
    inputHint: '{ orderId: string, changeType: string, beforeSnapshot: object, afterDelta: object, changeReason: string, impactSummary: string, requesterId: string }',
    example: { user: '创建订单变更申请', input: { orderId: '<ORDER_ID>', changeType: 'price', beforeSnapshot: {}, afterDelta: {}, changeReason: '客户要求降价', impactSummary: '影响金额 1000 USD', requesterId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'order_changes.withdraw',
    name: 'Withdraw Order Change Request',
    domain: 'orders',
    description: '订单变更申请撤回流程（draft→approval→commit）：仅 Pending 状态且仅申请人本人可撤回。',
    inputHint: '{ changeRequestId: string, actorId: string }',
    example: { user: '撤回变更申请', input: { changeRequestId: '<CHANGE_REQUEST_ID>', actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'payment_requests.create',
    name: 'Create Payment Request',
    domain: 'finance',
    description: '付款申请创建流程（draft→approval→commit）：引用收款方、金额、币种、付款性质、申请人，审批后调用共用 createPaymentRequest service。',
    inputHint: '{ supplierId?: string, supplierName?: string, totalAmount: number, currency: string, paymentCategory?: string, applicantId: string, reason?: string }',
    example: { user: '创建付款申请', input: { supplierName: '某供应商', totalAmount: 50000, currency: 'CNY', applicantId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'payment_requests.cancel',
    name: 'Cancel Payment Request',
    domain: 'finance',
    description: '付款申请作废流程（draft→approval→commit）：仅 Draft/Pending 且仅申请人本人可作废。',
    inputHint: '{ paymentRequestId: string, actorId: string }',
    example: { user: '作废付款申请', input: { paymentRequestId: '<PAYMENT_REQUEST_ID>', actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'credit.freeze',
    name: 'Freeze Customer Credit',
    domain: 'credit',
    description: '客户信用冻结流程（draft→approval→commit）：人工冻结理由必填（审计强制），冻结即新单门禁。',
    inputHint: '{ relationId: string, reason: string, actorId: string }',
    example: { user: '冻结客户信用', input: { relationId: '<RELATION_ID>', reason: '逾期 60 天未付款', actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'credit.thaw',
    name: 'Thaw Customer Credit',
    domain: 'credit',
    description: '客户信用解冻流程（draft→approval→commit）：人工解冻理由必填（审计强制）。',
    inputHint: '{ relationId: string, reason: string, actorId: string }',
    example: { user: '解冻客户信用', input: { relationId: '<RELATION_ID>', reason: '逾期款项已全额核销', actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'samples.create_round',
    name: 'Create Garment Sample Round',
    domain: 'samples',
    description: '服装样品轮次创建流程（draft→approval→commit）：DR-008/DR-029 双门禁，需提供开发案ID、目的、版本、材料配置。',
    inputHint: '{ caseId: string, input: { purpose: string, version: string, materialConfig: object }, actorId: string }',
    example: { user: '创建样品轮次', input: { caseId: '<CASE_ID>', input: { purpose: '产前样', version: 'v1', materialConfig: {} }, actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'samples.submit_to_customer',
    name: 'Submit Sample To Customer',
    domain: 'samples',
    description: '样品提交客户流程（draft→approval→commit）：内部门禁 QC 通过后方可提交，需提供轮次ID和寄送信息。',
    inputHint: '{ roundId: string, input: { courier?: string, trackingNo?: string, sentDate?: string }, actorId: string }',
    example: { user: '提交样品给客户', input: { roundId: '<ROUND_ID>', input: { courier: 'DHL', trackingNo: '123456' }, actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'samples.register_customer_confirmation',
    name: 'Register Sample Customer Confirmation',
    domain: 'samples',
    description: '样品客户确认登记流程（draft→approval→commit）：登记 approved/rejected/needs_revision 结论。',
    inputHint: '{ roundId: string, input: { result: "approved"|"rejected"|"needs_revision", comment?: string }, actorId: string }',
    example: { user: '登记客户确认', input: { roundId: '<ROUND_ID>', input: { result: 'approved' }, actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'qc.review_garment_sample',
    name: 'QC Review Garment Sample',
    domain: 'qc',
    description: 'QC 成衣链样品评审流程（draft→approval→commit）：DR-029 每轮报告独立不可覆盖，需提供订单ID、轮次、结论。',
    inputHint: '{ orderId: string, input: { level: "pp"|"top", round: number, conclusion: "pass"|"conditional"|"fail", opinion: string }, actorId: string }',
    example: { user: 'QC 评审成衣样品', input: { orderId: '<ORDER_ID>', input: { level: 'pp', round: 1, conclusion: 'pass', opinion: '合格' }, actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'qc.review_fabric_sample',
    name: 'QC Review Fabric Sample',
    domain: 'qc',
    description: 'QC 面料链样品评审流程（draft→approval→commit）：DR-029 非 pass 必须提工厂技术调整要求。',
    inputHint: '{ orderId: string, input: { sampleKind: "SS"|"RC"|"EARLY_PRODUCTION", conclusion: "pass"|"conditional"|"fail", opinion: string, factoryAdjustment?: object }, actorId: string }',
    example: { user: 'QC 评审面料样品', input: { orderId: '<ORDER_ID>', input: { sampleKind: 'SS', conclusion: 'conditional', opinion: '有色差', factoryAdjustment: { requirement: '调整染色工艺' } }, actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'qc.sign_report',
    name: 'Sign QC Report',
    domain: 'qc',
    description: 'QC 报告双签流程（draft→approval→commit）：产前样双签唯一入口，角色限 qc/business，签署留痕不可改写。',
    inputHint: '{ reportId: string, role: "qc"|"business", actorId: string }',
    example: { user: '签署 QC 报告', input: { reportId: '<REPORT_ID>', role: 'qc', actorId: '<USER_ID>' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'internal_trade.create',
    name: 'Create Internal Transfer',
    domain: 'internal_trade',
    description: '内部供料单创建流程（draft→approval→commit）：DR-005/033，需提供服装/面料订单、物料、数量、结算价、交期。',
    inputHint: '{ garmentOrderId: string, fabricOrderId: string, materialCode: string, quantity: number, settlementPrice: number, dueDate: string }',
    example: { user: '创建内部供料单', input: { garmentOrderId: '<GARMENT_ORDER_ID>', fabricOrderId: '<FABRIC_ORDER_ID>', materialCode: 'MAT-001', quantity: 1000, settlementPrice: 5.5, dueDate: '2026-09-01' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'internal_trade.confirm',
    name: 'Confirm Internal Transfer',
    domain: 'internal_trade',
    description: '内部供料单确认生效流程（draft→approval→commit）：生效门槛结算价审批通过，需提供供料单ID和确认数量/交期。',
    inputHint: '{ transferId: string, actorId: string, confirmedQuantity?: number, confirmedDueDate?: string }',
    example: { user: '确认内部供料单', input: { transferId: '<TRANSFER_ID>', actorId: '<USER_ID>', confirmedQuantity: 1000 } },
    safety: { approval: 'always', sideEffects: true },
  },
  // ── Phase 2 S3b：四存量域写工具 ──
  {
    id: 'procurement.create',
    name: 'Create Purchase Order',
    domain: 'procurement',
    description: '采购订单创建流程（draft→approval→commit）：需提供币种、下单日期、行明细，供应商黑名单校验。',
    inputHint: '{ poNumber?: string, supplierId: string, currency: string, orderDate: string, lines: Array<{ description: string, unit: string, quantity: number, unitPrice: number }> }',
    example: { user: '创建采购订单', input: { supplierId: '<SUPPLIER_ID>', currency: 'CNY', orderDate: '2026-08-17', lines: [{ description: '面料', unit: '米', quantity: 1000, unitPrice: 10 }] } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'procurement.update_status',
    name: 'Update Purchase Order Status',
    domain: 'procurement',
    description: '采购订单状态流转流程（draft→approval→commit）：状态机 Draft→Sent→Confirmed→PartiallyReceived/Received→Closed。',
    inputHint: '{ purchaseOrderId: string, toStatus: string, reason?: string }',
    example: { user: '更新采购单状态', input: { purchaseOrderId: '<PO_ID>', toStatus: 'Sent' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'inventory.adjust_stock',
    name: 'Adjust Inventory Stock',
    domain: 'inventory',
    description: '库存变动登记流程（draft→approval→commit）：入库/出库/调拨/调整/锁定/解锁，调拨需目标仓库。',
    inputHint: '{ movement: { itemId: string, type: "Inbound"|"Outbound"|"Transfer"|"Adjustment"|"Lock"|"Unlock", quantity: number, targetWarehouseId?: string, reason?: string } }',
    example: { user: '登记库存入库', input: { movement: { itemId: '<ITEM_ID>', type: 'Inbound', quantity: 500, reason: '采购入库' } } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'quotation.create',
    name: 'Create Quotation',
    domain: 'quotations',
    description: '报价单创建流程（draft→approval→commit）：MOQ writeOnce 快照+双轨偏差审批，需提供币种、报价日期、行明细。',
    inputHint: '{ quotationNumber?: string, customerRelationId: string, currency: string, issueDate: string, lines: Array<{ description: string, unit: string, quantity: number, unitPrice: number }> }',
    example: { user: '创建报价单', input: { customerRelationId: '<CUSTOMER_ID>', currency: 'USD', issueDate: '2026-08-17', lines: [{ description: '面料', unit: '米', quantity: 1000, unitPrice: 5 }] } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'quotation.update',
    name: 'Update Quotation',
    domain: 'quotations',
    description: '报价单更新流程（draft→approval→commit）：仅 Draft 状态可编辑，双轨快照与 MOQ 快照 writeOnce 不可 patch。',
    inputHint: '{ quotationId: string, patch: { currency?: string, issueDate?: string, lines?: Array<...> } }',
    example: { user: '更新报价单', input: { quotationId: '<QUOTATION_ID>', patch: { currency: 'EUR' } } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'customs.register_lc',
    name: 'Register Letter of Credit',
    domain: 'customs',
    description: '信用证登记流程（draft→approval→commit）：首节点事件 Issued+EntityLink 同步，需提供证号、类型、金额、开证/效期。',
    inputHint: '{ lcNumber?: string, type: "Irrevocable"|"Revocable"|"Standby"|"Transferable", amount: number, currency: string, issueDate: string, expiryDate: string, applicant?: string, issuingBank?: string }',
    example: { user: '登记信用证', input: { type: 'Irrevocable', amount: 100000, currency: 'USD', issueDate: '2026-08-01', expiryDate: '2026-12-31' } },
    safety: { approval: 'always', sideEffects: true },
  },
  {
    id: 'customs.update_declaration',
    name: 'Update Customs Declaration',
    domain: 'customs',
    description: '报关单更新流程（draft→approval→commit）：仅 Draft 状态可编辑，需提供报关单ID和 patch。',
    inputHint: '{ declarationId: string, patch: { customsType?: "Export"|"Import", declarationDate?: string, ... } }',
    example: { user: '更新报关单', input: { declarationId: '<DECLARATION_ID>', patch: { customsType: 'Export' } } },
    safety: { approval: 'always', sideEffects: true },
  },
];

export function getMcpManifest(): ToolManifest[] {
  return MANIFEST_SEEDS.map(seed => buildManifestFromSeed(seed));
}

/**
 * 按 toolId 取 manifest 的 safety 元数据。
 *
 * Phase 7-58 工具审批落库使用：runtime 在拦截 tool call 时读取 safety 决定
 *   - 是否真的需要审批（approval !== 'never'）
 *   - 哪些字段允许"修改参数"覆盖（editableFields）
 *
 * 没有 manifest 的 tool（理论上不该出现）默认 fail-closed —— 返回 always 强制审批。
 */
export function getToolManifestSafety(toolId: string): ToolManifestSafety {
  const seed = MANIFEST_SEEDS.find(item => item.id === toolId);
  if (!seed) {
    return { approval: 'always', sideEffects: true };
  }
  return seed.safety || READ_ONLY_SAFETY;
}

function buildManifestFromSeed(seed: ManifestSeed): ToolManifest {
  const defaults = toolDefaults.get(seed.id);
  return {
    id: seed.id,
    name: seed.name,
    domain: seed.domain,
    risk: defaults?.risk || 'low',
    description: seed.description,
    inputHint: seed.inputHint,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    permissions: {
      scope: defaults?.scope || seed.domain,
      allowedRoles: defaults?.allowedRoles || [],
    },
    safety: seed.safety || READ_ONLY_SAFETY,
    examples: [seed.example],
  };
}
