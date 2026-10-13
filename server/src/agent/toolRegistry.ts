/**
 * P0-B Tool Registry Schema —— 工具注册表权威源。
 *
 * 演进现有 ToolDescriptor/ToolManifest，不新增第三套平行体系。
 * 文档基线：docs/P0B-TOOL-REGISTRY-SCHEMA.md
 *
 * 核心增量：
 * - approvalPolicy: 'never' | 'auto' | 'always'（替代 safety.approval 的 never/risk_based/always）
 * - inputSchema/outputSchema: JSON Schema（替代 inputHint 字符串）
 * - processSpec: 流程动作专用（draftPhase 输出 ProcessDraft）
 */

import { NEW_DOMAIN_QUERY_TOOL_DEFINITIONS } from './newDomainQueryTools';
import { computeProcessDraftHash } from './processDraftHash';
import { resolveOrderId } from '../orders/orderIdentity';
export { computeProcessDraftHash } from './processDraftHash';

/** 工具审批策略三值（P0-B 锁定） */
export type ApprovalPolicy = 'never' | 'auto' | 'always';

/** 工具风险等级 */
export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * P0-B ToolDefinition：现有 ToolDescriptor 的超集。
 * 字段覆盖文档基线 §2：id/name/scope/risk/description/inputSchema/outputSchema/approvalPolicy/processSpec
 */
export interface ToolDefinition {
  id: string;
  name: string;
  scope: string;
  risk: ToolRisk;
  description: string;
  /** JSON Schema，替代 inputHint 字符串 */
  inputSchema: Record<string, unknown>;
  /** JSON Schema（NEW） */
  outputSchema: Record<string, unknown>;
  /** 审批策略三值（NEW） */
  approvalPolicy: ApprovalPolicy;
  /** 流程动作专用（可选，flow API only） */
  processSpec?: ProcessSpec;
}

// ── ProcessDraft 结构（文档基线 §4，六字段全部必填）──

export interface SubOperation {
  toolId: string;
  entityId: string;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface FieldDiff {
  entity: string;
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface PostCommitHook {
  type: 'email' | 'sms' | 'webhook' | 'notification';
  payload: Record<string, unknown>;
}

/**
 * ProcessDraft：审批卡内容 + commit 事务输入的唯一真源。
 * 硬性验收：六字段全部必填，不接受半成品。
 */
export interface ProcessDraft {
  subOperations: SubOperation[];
  beforeAfterDiff: FieldDiff[];
  impactScope: string[];
  irreversible: boolean;
  postCommitHooks: PostCommitHook[];
  idempotencyKey: string;
}

// ── ProcessSpec（文档基线 §5，flow API only）──

export interface ProcessSpec {
  composedOf: string[];
  draftPhase: { produces: 'ProcessDraft' };
  approvalPhase: {
    consumes: 'ProcessDraft';
    approvalCard: {
      changeList: boolean;
      irreversibleMarkers: boolean;
      impactScope: boolean;
    };
  };
  commitTransaction: {
    consumes: 'ProcessDraft';
    wrapper: 'prisma_transaction';
  };
  postCommitHooks: Array<{
    type: 'email' | 'sms' | 'webhook' | 'notification';
    failurePolicy: 'queue_retry';
    rollbackOnFailure: false;
  }>;
  partialFailurePolicy: {
    draftFail: 'abort_no_approval';
    transactionFail: 'rollback';
    postCommitFail: 'queue_retry';
  };
  rollbackPolicy?: {
    strategy: 'none' | 'compensation';
    appliesTo: string[];
  };
}

// ── P0-B 四切片注册表 ──
// 文档基线 §3：四切片映射 approvalPolicy 三值

/** products.search: never 只读 */
const productsSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '短实体文本（SKU/品名）' },
    mainCategory: { type: 'string' },
    filters: { type: 'object' },
    limit: { type: 'number' },
  },
};

const knowledgeIngestSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    text: { type: 'string' },
    sourceType: { type: 'string' },
    sourceUri: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object' },
    scopes: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'text'],
};

const ordersUpdateStatusSchema = {
  type: 'object',
  properties: {
    poNumber: { type: 'string' },
    newStatus: { type: 'string', description: '目标状态' },
    reason: { type: 'string' },
  },
  required: ['poNumber', 'newStatus'],
};

const orderConfirmSchema = {
  type: 'object',
  properties: {
    poNumber: { type: 'string' },
    confirmNote: { type: 'string' },
  },
  required: ['poNumber'],
};

/** P0-B 四切片定义 */
export const P0B_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'products.search',
    name: 'Search Products',
    scope: 'products',
    risk: 'low',
    description: '按条件检索数字档案候选或返回统计；只读，无副作用。',
    inputSchema: productsSearchSchema,
    outputSchema: {
      type: 'object',
      properties: {
        candidates: { type: 'array' },
        total: { type: 'number' },
      },
    },
    approvalPolicy: 'never',
  },
  {
    id: 'knowledge.ingest',
    name: 'Ingest Knowledge',
    scope: 'knowledge',
    risk: 'medium',
    description: '知识文档写入 draft→approval→commit flow。commit 复用 ingestKnowledgeDocument shared service，不在 Agent path 手写 KnowledgeDocument/KnowledgeChunk/ACL/audit。',
    inputSchema: knowledgeIngestSchema,
    outputSchema: { type: 'object', properties: { documentId: { type: 'string' }, checksum: { type: 'string' }, chunkCount: { type: 'number' }, auditId: { type: 'string' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['knowledge.ingest'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },

  {
    id: 'email.sync',
    name: 'Sync Emails from IMAP',
    scope: 'email',
    risk: 'high',
    description: 'IMAP→DB 邮件同步 draft→approval→commit flow。commit 复用 syncEmailsFromImap shared service，不在 Agent path 手写 IMAP/DB/audit。credentialRef 模式确保 approval payload 不含明文 password。',
    inputSchema: { type: 'object', properties: { credentials: { type: 'object', properties: { user: { type: 'string' }, pass: { type: 'string' }, host: { type: 'string' }, port: { type: 'number' }, credentialRef: { type: 'string' } } }, box: { type: 'string' }, limit: { type: 'number' } }, required: ['credentials'] },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, synced: { type: 'number' }, skipped: { type: 'number' }, accountMasked: { type: 'string' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['email.sync'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },

  {
    id: 'orders.update_status',
    name: 'Update Order Status',
    scope: 'orders',
    risk: 'high',
    description: '更新订单状态；high-risk 状态流转，强制审批。',
    inputSchema: ordersUpdateStatusSchema,
    outputSchema: {
      type: 'object',
      properties: {
        poNumber: { type: 'string' },
        previousStatus: { type: 'string' },
        newStatus: { type: 'string' },
        updated: { type: 'boolean' },
      },
    },
    approvalPolicy: 'always',
  },
  {
    id: 'order.confirm',
    name: 'Confirm Order (Flow API)',
    scope: 'orders',
    risk: 'high',
    description: '订单确认流程动作：update_status(Confirmed) + finance.create_invoice(Issued)。P1-A scope 排除 email/postCommitHooks，status+invoice+AuditLog 全部在 $transaction 内收口。',
    inputSchema: orderConfirmSchema,
    outputSchema: {
      type: 'object',
      properties: {
        processDraft: { type: 'object', description: 'ProcessDraft 六字段' },
      },
    },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['orders.update_status', 'finance.create_invoice'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: {
        consumes: 'ProcessDraft',
        approvalCard: {
          changeList: true,
          irreversibleMarkers: true,
          impactScope: true,
        },
      },
      commitTransaction: {
        consumes: 'ProcessDraft',
        wrapper: 'prisma_transaction',
      },
      postCommitHooks: [], // P1-A scope 排除 email/EmailQueue
      partialFailurePolicy: {
        draftFail: 'abort_no_approval',
        transactionFail: 'rollback',
        postCommitFail: 'queue_retry',
      },
    },
  },
  {
    // task Agent-P1: payment.receive_and_reconcile draft→approval→commit flow
    id: 'payment.receive_and_reconcile',
    name: 'Receive Payment And Reconcile (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '收款核销复合流程：create_voucher + N 笔 allocation，审批后事务内复用 allocationService 完成 status 重算 + EntityLink + audit。支持 split voucher。',
    inputSchema: { type: 'object', properties: { voucherId: { type: 'string' }, voucherAmount: { type: 'number' }, currency: { type: 'string' }, allocations: { type: 'array', items: { type: 'object', properties: { invoiceId: { type: 'string' }, appliedAmount: { type: ['string', 'number'], description: 'Decimal string recommended (e.g. "123456789012345.1234") to avoid IEEE754 truncation; number accepted for backward compat' } } } } }, required: ['voucherId', 'voucherAmount', 'allocations'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['finance.apply_voucher_to_invoice'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task ERP-P1: order.ship draft→approval→commit flow
    id: 'order.ship',
    name: 'Ship Order (Flow API)',
    scope: 'shipping',
    risk: 'high',
    description: '订单发货复合流程：create_shipment + linkOrderStatusFromShipment(order→Shipping/Delivered)。审批后事务内复用已 merged shipping-order link + status transition 规则完成发货 + order 状态联动 + audit。',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, shipment: { type: 'object' } }, required: ['orderId', 'shipment'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['shipping.create_shipment'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task ERP-P1: email.reply_and_send draft→approval→commit flow
    id: 'email.reply_and_send',
    name: 'Reply And Send Email (Flow API)',
    scope: 'automation',
    risk: 'high',
    description: '邮件回复发送复合流程：审批后事务内写 Email(direction=outbound) + AuditLog。不自动 SMTP 发送（contract 边界）。支持 reply（threading）+ 关联 order/relation。',
    inputSchema: { type: 'object', properties: { replyToEmailId: { type: 'string' }, to: { type: 'array' }, subject: { type: 'string' }, bodyText: { type: 'string' } }, required: ['to', 'subject', 'bodyText'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['email.send'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: relation.update draft→approval→commit
    id: 'relation.update',
    name: 'Relation Update (Flow API)',
    scope: 'relations', risk: 'high',
    description: 'Relation 更新复合流程：draft 引用 relationId + patch，审批后 commit 调用共用 updateRelation service。',
    inputSchema: { type: 'object', properties: { relationId: { type: 'string' }, patch: { type: 'object' } }, required: ['relationId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['relation.update'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: relation.delete draft→approval→commit
    id: 'relation.delete',
    name: 'Relation Delete (Flow API)',
    scope: 'relations', risk: 'high',
    description: 'Relation 软删复合流程：draft 引用 relationId，审批后 commit 调用共用 deleteRelation service。',
    inputSchema: { type: 'object', properties: { relationId: { type: 'string' } }, required: ['relationId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['relation.delete'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: relation.onboard draft→approval→commit flow
    id: 'relation.onboard',
    name: 'Onboard Relation (Flow API)',
    scope: 'relations',
    risk: 'high',
    description: '关系建档复合流程：创建 organization relation + primary contact relation，事务内 EntityLink sync + AuditLog。不自动发送邮件（welcome email 排除）。',
    inputSchema: { type: 'object', properties: { organization: { type: 'object' }, contact: { type: 'object' } }, required: ['organization'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['relations.create'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  { id: 'invoice.create', name: 'Invoice Create (Flow API)', scope: 'finance', risk: 'high', description: 'Invoice 创建流程：draft→approval→commit，复用 createInvoice service。', inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] }, outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } }, approvalPolicy: 'always', processSpec: { composedOf: ['invoice.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } } },
  { id: 'invoice.update', name: 'Invoice Update (Flow API)', scope: 'finance', risk: 'high', description: 'Invoice 更新流程：draft→approval→commit，复用 updateInvoice service。', inputSchema: { type: 'object', properties: { invoiceId: { type: 'string' }, patch: { type: 'object' } }, required: ['invoiceId', 'patch'] }, outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } }, approvalPolicy: 'always', processSpec: { composedOf: ['invoice.update'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } } },
  {
    // task Agent-P1: invoice.issue draft→approval→commit flow
    id: 'invoice.issue',
    name: 'Issue Invoice (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '发票开具复合流程：create_invoice(status=Issued) Draft→Issued + Outbox Email 待发。审批后事务内写 Invoice(Issued) + Email(direction=outbound, mailbox=Outbox) + syncInvoiceReferences + writeRouteAuditLog。不 SMTP 发送，不写 Sent/sentAt/messageId。',
    inputSchema: { type: 'object', properties: { invoiceNumber: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, customerRelationId: { type: 'string' }, orderId: { type: 'string' }, email: { type: 'object' } }, required: ['invoiceNumber', 'amount'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['finance.create_invoice', 'email.reply_and_send'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: email.send draft→approval→commit flow（消费 Outbox send service）
    id: 'email.send',
    name: 'Send Email',
    scope: 'automation',
    risk: 'high',
    description: 'Outbox 邮件显式发送复合流程：draft 引用已有 outbound Outbox Email(emailId)，审批后 commit 调用共用 Outbox send service（sendOutboxEmail），不绕过 DB 事实源，不直接 nodemailer。SMTP 成功更新 Sent + sentAt + messageId，失败保持 Outbox。',
    inputSchema: { type: 'object', properties: { emailId: { type: 'string' }, credentials: { type: 'object' } }, required: ['emailId', 'credentials'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['email.outbox_send'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: development.convert_to_order draft→approval→commit flow
    id: 'development.convert_to_order',
    name: 'Convert Development Case to Order',
    scope: 'development',
    risk: 'high',
    description: '开发单转大货订单复合流程：draft 引用 devCaseId + mode(link/autoCreate)，审批后 commit 调用共用 convertDevCaseToOrder service（事务闭环 sync+audit），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { caseId: { type: 'string' }, mode: { type: 'string' }, orderId: { type: 'string' }, orderPo: { type: 'string' }, customer: { type: 'string' }, millName: { type: 'string' }, productName: { type: 'string' }, quantity: { type: 'number' }, dueDate: { type: 'string' }, quoteAmount: { type: 'number' } }, required: ['caseId', 'mode'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['development.convert_to_order'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: invoice.cancel draft→approval→commit flow
    id: 'invoice.cancel',
    name: 'Cancel Invoice (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '发票作废复合流程：draft 引用 invoiceId + reason，审批后 commit 调用共用 cancelInvoice service（status→Cancelled + EntityLink inactive + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { invoiceId: { type: 'string' }, reason: { type: 'string' } }, required: ['invoiceId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['invoice.cancel'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: order.status_transition draft→approval→commit flow
    id: 'order.status_transition',
    name: 'Order Status Transition (Flow API)',
    scope: 'orders',
    risk: 'high',
    description: '订单状态流转复合流程：draft 引用 orderId + toStatus（从真实 order 读 currentStatus），审批后 commit 调用共用 transitionOrderStatus service（OrderStatusTransition + sync + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, toStatus: { type: 'string' }, note: { type: 'string' }, lineId: { type: 'string' } }, required: ['orderId', 'toStatus'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['order.status_transition'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: order.delete draft→approval→commit flow
    id: 'order.delete',
    name: 'Order Delete (Flow API)',
    scope: 'orders',
    risk: 'high',
    description: '订单软删复合流程：draft 引用 orderId，审批后 commit 调用共用 deleteOrder service（deletedAt + EntityLink inactive + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['order.delete'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: order.line_update draft→approval→commit flow
    id: 'order.line_update',
    name: 'Order Line Update (Flow API)',
    scope: 'orders',
    risk: 'high',
    description: '订单行更新复合流程：draft 引用 lineId + patch（从真实 orderLine 读 before），审批后 commit 调用共用 updateOrderLine service（sync + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { lineId: { type: 'string' }, patch: { type: 'object' } }, required: ['lineId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['order.line_update'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: invoice.delete draft→approval→commit flow
    id: 'invoice.delete',
    name: 'Invoice Delete (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '发票软删复合流程：draft 引用 invoiceId，审批后 commit 调用共用 deleteInvoice service（deletedAt + EntityLink inactive + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['invoice.delete'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: payment_voucher.create draft→approval→commit flow
    id: 'payment_voucher.create',
    name: 'Payment Voucher Create (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '收/付款凭证创建复合流程：draft 引用 input，审批后 commit 调用共用 createPaymentVoucher service，不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['payment_voucher.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: payment_voucher.update draft→approval→commit flow
    id: 'payment_voucher.update',
    name: 'Payment Voucher Update (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '收/付款凭证更新复合流程：draft 引用 voucherId + patch，审批后 commit 调用共用 updatePaymentVoucher service，不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { voucherId: { type: 'string' }, patch: { type: 'object' } }, required: ['voucherId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['payment_voucher.update'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: payment_voucher.delete draft→approval→commit flow
    id: 'payment_voucher.delete',
    name: 'Payment Voucher Delete (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '付款凭证软删复合流程：draft 引用 voucherId，审批后 commit 调用共用 deleteVoucher service（deletedAt + EntityLink inactive + AuditLog），不绕 route，不手写 DB mutation。',
    inputSchema: { type: 'object', properties: { voucherId: { type: 'string' } }, required: ['voucherId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: {
      composedOf: ['payment_voucher.delete'],
      draftPhase: { produces: 'ProcessDraft' },
      approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } },
      commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' },
      postCommitHooks: [],
      partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' },
    },
  },
  {
    // task Agent-P1: product_asset.create draft→approval→commit
    id: 'product_asset.create',
    name: 'Product Asset Create (Flow API)',
    scope: 'products', risk: 'high',
    description: 'ProductAsset 创建复合流程：draft 引用 sku/name/mainCategory，审批后 commit 调用共用 createProductAsset service。',
    inputSchema: { type: 'object', properties: { body: { type: 'object' } }, required: ['body'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['product_asset.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: product_asset.update draft→approval→commit
    id: 'product_asset.update',
    name: 'Product Asset Update (Flow API)',
    scope: 'products', risk: 'high',
    description: 'ProductAsset 更新复合流程：draft 引用 assetId + patch，审批后 commit 调用共用 updateProductAsset service。',
    inputSchema: { type: 'object', properties: { assetId: { type: 'string' }, patch: { type: 'object' } }, required: ['assetId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['product_asset.update'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task Agent-P1: product_asset.delete draft→approval→commit
    id: 'product_asset.delete',
    name: 'Product Asset Delete (Flow API)',
    scope: 'products', risk: 'high',
    description: 'ProductAsset 软删复合流程：draft 引用 assetId，审批后 commit 调用共用 deleteProductAsset service。',
    inputSchema: { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['product_asset.delete'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task E3: development.create draft→approval→commit flow（给 XX 客户下样品单）
    id: 'development.create',
    name: 'Development Case Create (Flow API)',
    scope: 'development',
    risk: 'high',
    description: '开发单/样品单创建复合流程：draft 引用 code/name/type + 客户归属，审批后 commit 调用共用 createDevelopmentCase service（$transaction + EntityLink sync + AuditLog 闭环），不绕 route，不手写 DB mutation。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['fabric', 'garment', 'pp', 'trim'] },
        customerRelationId: { type: 'string' },
        customerName: { type: 'string' },
        supplierName: { type: 'string' },
        sampleType: { type: 'string' },
        sampleQuantity: { type: 'number' },
        sampleUnit: { type: 'string' },
        targetDate: { type: 'string' },
        nextAction: { type: 'string' },
        priority: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['code', 'name', 'type'],
    },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['development.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    // task E3: statement.send draft→approval→commit flow（生成对账单并投递客户）
    id: 'statement.send',
    name: 'Statement Send (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '客户对账单生成投递复合流程：draft 内含 getCustomerStatement 完整快照（审批即所得），审批后 commit 事务内写 outbound Outbox Email（正文=对账单明细）+ AuditLog。不 SMTP 发送，不手写 DB mutation。',
    inputSchema: {
      type: 'object',
      properties: {
        customerRelationId: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        email: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' } }, required: ['to', 'subject'] },
      },
      required: ['customerRelationId', 'email'],
    },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['statement.send'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  // ── Phase 4 Track G：Phase 2 八域只读查询工具（risk=low + approvalPolicy=never）──
  ...NEW_DOMAIN_QUERY_TOOL_DEFINITIONS,
  // ── Phase 2 S3a 六新域写工具（draft→approval→commit，approvalPolicy='always'）──
  {
    id: 'order_changes.create',
    name: 'Order Change Create (Flow API)',
    scope: 'orders',
    risk: 'high',
    description: '订单变更/取消/暂停申请创建复合流程（DR-010）：draft 引用 input（orderId/changeType/beforeSnapshot/afterDelta/changeReason/impactSummary/requesterId），审批后 commit 调用共用 createChangeRequest service。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['order_changes.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'order_changes.withdraw',
    name: 'Order Change Withdraw (Flow API)',
    scope: 'orders',
    risk: 'medium',
    description: '订单变更申请撤回复合流程（DR-010）：draft 引用 changeRequestId + actorId，审批后 commit 调用共用 withdrawChangeRequest service（仅 Pending 状态且仅申请人本人可撤回）。',
    inputSchema: { type: 'object', properties: { changeRequestId: { type: 'string' }, actorId: { type: 'string' } }, required: ['changeRequestId', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['order_changes.withdraw'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'payment_requests.create',
    name: 'Payment Request Create (Flow API)',
    scope: 'finance',
    risk: 'high',
    description: '付款申请创建复合流程（DR-017 先申请后付款）：draft 引用 input（supplierId/supplierName/totalAmount/currency/paymentCategory/applicantId 等），审批后 commit 调用共用 createPaymentRequest service。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['payment_requests.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'payment_requests.cancel',
    name: 'Payment Request Cancel (Flow API)',
    scope: 'finance',
    risk: 'medium',
    description: '付款申请作废复合流程（DR-017）：draft 引用 paymentRequestId + actorId，审批后 commit 调用共用 cancelPaymentRequest service（仅 Draft/Pending 且仅申请人本人可作废）。',
    inputSchema: { type: 'object', properties: { paymentRequestId: { type: 'string' }, actorId: { type: 'string' } }, required: ['paymentRequestId', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['payment_requests.cancel'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'credit.freeze',
    name: 'Credit Freeze (Flow API)',
    scope: 'credit',
    risk: 'high',
    description: '客户信用冻结复合流程：draft 引用 relationId + reason + actorId（人工冻结理由必填，审计强制），审批后 commit 调用共用 freezeCredit service（冻结即新单门禁）。',
    inputSchema: { type: 'object', properties: { relationId: { type: 'string' }, reason: { type: 'string' }, actorId: { type: 'string' } }, required: ['relationId', 'reason', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['credit.freeze'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'credit.thaw',
    name: 'Credit Thaw (Flow API)',
    scope: 'credit',
    risk: 'high',
    description: '客户信用解冻复合流程：draft 引用 relationId + reason + actorId（人工解冻理由必填，审计强制），审批后 commit 调用共用 thawCredit service。',
    inputSchema: { type: 'object', properties: { relationId: { type: 'string' }, reason: { type: 'string' }, actorId: { type: 'string' } }, required: ['relationId', 'reason', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['credit.thaw'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'samples.create_round',
    name: 'Sample Round Create (Flow API)',
    scope: 'samples',
    risk: 'high',
    description: '服装样品轮次创建复合流程（DR-008/DR-029 双门禁）：draft 引用 caseId + input（purpose/version/materialConfig 等），审批后 commit 调用共用 createRound service。',
    inputSchema: { type: 'object', properties: { caseId: { type: 'string' }, input: { type: 'object' }, actorId: { type: 'string' } }, required: ['caseId', 'input', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['samples.create_round'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'samples.submit_to_customer',
    name: 'Sample Submit To Customer (Flow API)',
    scope: 'samples',
    risk: 'medium',
    description: '样品提交客户复合流程（DR-008 内部门禁：QC 通过后方可提交）：draft 引用 roundId + input（寄送信息等），审批后 commit 调用共用 submitToCustomer service。',
    inputSchema: { type: 'object', properties: { roundId: { type: 'string' }, input: { type: 'object' }, actorId: { type: 'string' } }, required: ['roundId', 'input', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['samples.submit_to_customer'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'samples.register_customer_confirmation',
    name: 'Sample Register Customer Confirmation (Flow API)',
    scope: 'samples',
    risk: 'medium',
    description: '样品客户确认登记复合流程：draft 引用 roundId + input（confirmed/rejected/needs_revision 结论），审批后 commit 调用共用 registerCustomerConfirmation service。',
    inputSchema: { type: 'object', properties: { roundId: { type: 'string' }, input: { type: 'object' }, actorId: { type: 'string' } }, required: ['roundId', 'input', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['samples.register_customer_confirmation'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'qc.review_garment_sample',
    name: 'QC Review Garment Sample (Flow API)',
    scope: 'qc',
    risk: 'high',
    description: 'QC 成衣链样品评审复合流程（DR-029）：draft 引用 orderId + input（level/round/conclusion/opinion 等），审批后 commit 调用共用 qcChainService.reviewGarmentSample（每轮报告独立不可覆盖）。',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, input: { type: 'object' }, actorId: { type: 'string' } }, required: ['orderId', 'input', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['qc.review_garment_sample'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'qc.review_fabric_sample',
    name: 'QC Review Fabric Sample (Flow API)',
    scope: 'qc',
    risk: 'high',
    description: 'QC 面料链样品评审复合流程（DR-029）：draft 引用 orderId + input（sampleKind/conclusion/opinion/factoryAdjustment 等），审批后 commit 调用共用 qcChainService.reviewFabricSample（非 pass 必须提工厂技术调整要求）。',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, input: { type: 'object' }, actorId: { type: 'string' } }, required: ['orderId', 'input', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['qc.review_fabric_sample'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'qc.sign_report',
    name: 'QC Sign Report (Flow API)',
    scope: 'qc',
    risk: 'high',
    description: 'QC 报告双签复合流程（产前样双签唯一入口）：draft 引用 reportId + role（qc/business）+ actorId，审批后 commit 调用共用 qcService.signReport（签署留痕不可改写）。',
    inputSchema: { type: 'object', properties: { reportId: { type: 'string' }, role: { type: 'string' }, actorId: { type: 'string' } }, required: ['reportId', 'role', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['qc.sign_report'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'internal_trade.create',
    name: 'Internal Trade Create (Flow API)',
    scope: 'internal_trade',
    risk: 'high',
    description: '内部供料单创建复合流程（DR-005/033）：draft 引用 input（garmentOrderId/fabricOrderId/materialCode/quantity/settlementPrice/dueDate 等），审批后 commit 调用共用 createInternalTransfer service（内部结算价需 DR-006 审批）。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['internal_trade.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'internal_trade.confirm',
    name: 'Internal Trade Confirm (Flow API)',
    scope: 'internal_trade',
    risk: 'high',
    description: '内部供料单确认生效复合流程（DR-033）：draft 引用 transferId + actorId + confirmedQuantity/confirmedDueDate，审批后 commit 调用共用 confirmInternalTransfer service（生效门槛：结算价审批通过）。',
    inputSchema: { type: 'object', properties: { transferId: { type: 'string' }, actorId: { type: 'string' }, confirmedQuantity: { type: 'number' }, confirmedDueDate: { type: 'string' } }, required: ['transferId', 'actorId'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['internal_trade.confirm'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  // ── Phase 2 S3b 四存量域写工具（draft→approval→commit，approvalPolicy='always'）──
  {
    id: 'procurement.create',
    name: 'Procurement Create (Flow API)',
    scope: 'procurement',
    risk: 'high',
    description: '采购订单创建复合流程：draft 引用 input（poNumber/currency/orderDate/lines 等），审批后 commit 调用共用 createPurchaseOrder service。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['procurement.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'procurement.update_status',
    name: 'Procurement Update Status (Flow API)',
    scope: 'procurement',
    risk: 'medium',
    description: '采购订单状态流转复合流程：draft 引用 purchaseOrderId + toStatus（状态机 Draft→Sent→Confirmed→PartiallyReceived/Received→Closed），审批后 commit 调用共用 transitionPurchaseOrderStatus service。',
    inputSchema: { type: 'object', properties: { purchaseOrderId: { type: 'string' }, toStatus: { type: 'string' }, reason: { type: 'string' } }, required: ['purchaseOrderId', 'toStatus'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['procurement.update_status'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'inventory.adjust_stock',
    name: 'Inventory Adjust Stock (Flow API)',
    scope: 'inventory',
    risk: 'high',
    description: '库存变动复合流程：draft 引用 movement（itemId/type/quantity/targetWarehouseId 等），审批后 commit 调用共用 createStockMovement service（事务内更新余额+写流水+审计日志）。',
    inputSchema: { type: 'object', properties: { movement: { type: 'object' } }, required: ['movement'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['inventory.adjust_stock'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'quotation.create',
    name: 'Quotation Create (Flow API)',
    scope: 'quotations',
    risk: 'high',
    description: '报价单创建复合流程：draft 引用 input（quotationNumber/currency/issueDate/lines 等），审批后 commit 调用共用 createQuotation service（MOQ writeOnce 快照+双轨偏差审批）。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['quotation.create'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'quotation.update',
    name: 'Quotation Update (Flow API)',
    scope: 'quotations',
    risk: 'high',
    description: '报价单更新复合流程：draft 引用 quotationId + patch（仅 Draft 状态可编辑），审批后 commit 调用共用 updateQuotation service。',
    inputSchema: { type: 'object', properties: { quotationId: { type: 'string' }, patch: { type: 'object' } }, required: ['quotationId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['quotation.update'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'customs.register_lc',
    name: 'Customs Register LC (Flow API)',
    scope: 'customs',
    risk: 'high',
    description: '信用证登记复合流程：draft 引用 input（lcNumber/type/amount/issueDate/expiryDate 等），审批后 commit 调用共用 createLetterOfCredit service（首节点事件 Issued+EntityLink 同步）。',
    inputSchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['customs.register_lc'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
  {
    id: 'customs.update_declaration',
    name: 'Customs Update Declaration (Flow API)',
    scope: 'customs',
    risk: 'high',
    description: '报关单更新复合流程：draft 引用 declarationId + patch（仅 Draft 状态可编辑），审批后 commit 调用共用 updateDeclaration service。',
    inputSchema: { type: 'object', properties: { declarationId: { type: 'string' }, patch: { type: 'object' } }, required: ['declarationId', 'patch'] },
    outputSchema: { type: 'object', properties: { processDraft: { type: 'object' }, committed: { type: 'boolean' } } },
    approvalPolicy: 'always',
    processSpec: { composedOf: ['customs.update_declaration'], draftPhase: { produces: 'ProcessDraft' }, approvalPhase: { consumes: 'ProcessDraft', approvalCard: { changeList: true, irreversibleMarkers: true, impactScope: true } }, commitTransaction: { consumes: 'ProcessDraft', wrapper: 'prisma_transaction' }, postCommitHooks: [], partialFailurePolicy: { draftFail: 'abort_no_approval', transactionFail: 'rollback', postCommitFail: 'queue_retry' } },
  },
];

/** ToolDefinition 查找索引 */
const DEFINITION_INDEX = new Map(P0B_TOOL_DEFINITIONS.map(d => [d.id, d]));

/** 按 id 查找 P0-B ToolDefinition */
export function getToolDefinition(id: string): ToolDefinition | undefined {
  return DEFINITION_INDEX.get(id);
}


/**
 * 适配器：ToolDefinition -> ToolDescriptor（agentLoopTypes 现有类型）。
 * 让现有 agentLoop/llmPlanner 能直接消费 P0-B 定义的工具。
 */
export function toToolDescriptor(def: ToolDefinition): {
  id: string;
  name: string;
  scope: string;
  risk: ToolRisk;
  description: string;
  inputHint?: string;
} {
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    risk: def.risk,
    description: def.description,
    inputHint: schemaToHint(def.inputSchema),
  };
}

/**
 * 适配器：ToolDefinition -> DefaultToolDefinition（defaults.ts 现有类型）。
 * allowedRoles 默认所有角色（P0-B 不改 RBAC，74 工具迁移时细化）。
 */
export function toDefaultToolDefinition(def: ToolDefinition, allowedRoles: string[] = ['owner', 'manager', 'staff']): {
  id: string;
  name: string;
  scope: string;
  risk: ToolRisk;
  allowedRoles: string[];
} {
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    risk: def.risk,
    allowedRoles,
  };
}

/**
 * inputSchema (JSON Schema) -> inputHint (string)，兼容现有 ToolDescriptor。
 */
function schemaToHint(schema: Record<string, unknown>): string {
  const props = (schema.properties || {}) as Record<string, unknown>;
  const required = (schema.required || []) as string[];
  const parts = Object.entries(props).map(([k, v]) => {
    const desc = (v as any)?.description ? ` /* ${(v as any).description} */` : '';
    return required.includes(k) ? `${k}: ...${desc}` : `${k}?${desc}`;
  });
  return `{ ${parts.join(', ')} }`;
}

/**
 * approvalPolicy 评估（文档基线 §3 Evaluation rule）：
 * - always -> 无条件审批
 * - auto -> 按 risk：low 跳过，medium 记 audit 不审批，high 升级审批
 * - never -> 完全跳过审批
 *
 * 返回 { needsApproval, recordAudit }。
 */
export function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  risk: ToolRisk,
): { needsApproval: boolean; recordAudit: boolean } {
  switch (policy) {
    case 'never':
      return { needsApproval: false, recordAudit: false };
    case 'auto':
      if (risk === 'low') return { needsApproval: false, recordAudit: false };
      if (risk === 'medium') return { needsApproval: false, recordAudit: true };
      return { needsApproval: true, recordAudit: true }; // high -> escalate
    case 'always':
      return { needsApproval: true, recordAudit: true };
  }
}
/**
 * P0-B 审批决策仲裁（toolRuntime 消费入口）。
 *
 * 优先级：
 * 1) 若工具在 toolRegistry 注册 -> 用 approvalPolicy 三值评估（权威）
 * 2) 未注册 -> 回退 manifest safety（fail-closed always）
 *
 * 这保证四切片语义成立：products.search(never) 不审批、knowledge.ingest(auto/medium) 不审批但审计、
 * orders.update_status/order.confirm(always) 审批；未注册工具继续 fail-closed。
 */
export function resolveApprovalDecision(params: {
  toolId: string;
  riskLevel: string;
  manifestRequiresApproval: boolean;
}): { requiresApproval: boolean; recordAudit: boolean; source: 'p0b' | 'manifest' } {
  const p0bDef = getToolDefinition(params.toolId);
  if (p0bDef) {
    const evalResult = evaluateApprovalPolicy(p0bDef.approvalPolicy, p0bDef.risk);
    return {
      requiresApproval: evalResult.needsApproval,
      recordAudit: evalResult.recordAudit,
      source: 'p0b',
    };
  }
  // 未注册工具走 manifest（fail-closed）
  return {
    requiresApproval: params.manifestRequiresApproval,
    recordAudit: params.manifestRequiresApproval,
    source: 'manifest',
  };
}



/**
 * 从 Prisma 读取订单快照，解析字段优先级。
 * 失败返回 null（caller fail-closed）。
 *
 * 字段优先级（codex review 要求）：
 * - amount: totalActual > totalNet > quoteAmount
 * - currency: salesCurrency > currency > 'USD'（出口 ERP 默认）
 * - customerRelationId: billToRelationId > customerRelationId
 * - customerName: billToName > customer
 * - lineCount: OrderLine count
 */
export async function loadOrderSnapshot(
  prisma: any,
  poNumber: string,
): Promise<OrderSnapshotForDraft | null> {
  const orderId = await resolveOrderId(prisma, poNumber);
  if (!orderId) return null;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, poNumber: true, status: true, deletedAt: true,
      quoteAmount: true, totalNet: true, totalActual: true,
      currency: true, salesCurrency: true,
      customer: true, customerRelationId: true,
      billToName: true, billToRelationId: true,
    },
  }).catch(() => null);
  if (!order || order.deletedAt) return null;

  // amount 优先级：totalActual > totalNet > quoteAmount（first non-null, non-zero wins）
  const amountCandidates = [order.totalActual, order.totalNet, order.quoteAmount];
  const amount = amountCandidates
    .map(v => Number(v))
    .find(n => !isNaN(n) && n > 0) ?? 0;
  // currency 优先级：salesCurrency > currency > USD（出口 ERP 默认 USD，总设计师 Section 7.5）
  const currency = order.salesCurrency || order.currency || 'USD';
  // customerRelationId 优先级：billToRelationId > customerRelationId
  const customerRelationId = order.billToRelationId || order.customerRelationId || '';
  // customerName 优先级：billToName > customer
  const customerName = order.billToName || order.customer || '';

  const lineCount = await prisma.orderLine.count({ where: { orderId: order.id } }).catch(() => 0);

  return {
    orderId: order.id,
    poNumber: order.poNumber || poNumber,
    status: order.status,
    amount,
    currency,
    customerRelationId,
    customerName,
    lineCount,
  };
}

/**
 * 订单快照 preconditions 校验（P1-A 文档要求）：
 * - customer relation 存在（customerRelationId 非空）
 * - line count > 0
 * - amount 有效且 > 0
 * 失败返回错误列表（caller fail-closed）。
 */
export function validateOrderSnapshot(snapshot: OrderSnapshotForDraft | null): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!snapshot) {
    errors.push('ORDER_NOT_FOUND');
    return { ok: false, errors };
  }
  if (!snapshot.customerRelationId) errors.push('MISSING_CUSTOMER_RELATION');
  if (snapshot.lineCount <= 0) errors.push('NO_ORDER_LINES');
  if (!(snapshot.amount > 0)) errors.push('INVALID_AMOUNT');
  if (snapshot.status !== 'Pending') errors.push(`STATUS_NOT_PENDING(actual=${snapshot.status})`);
  return { ok: errors.length === 0, errors };
}

/**
 * ProcessDraft 生成器（order.confirm draftPhase）。
 * 输出完整六字段，硬性验收。
 */
/**
 * 订单快照：draftPhase 从 DB 读取订单后传入，避免硬编码金额/币种。
 * 字段优先级规则（codex review 要求）：
 * - amount: totalActual > totalNet > quoteAmount（取第一个有效值）
 * - currency: salesCurrency > currency > USD（出口 ERP 默认）
 * - customerRelationId: billToRelationId > customerRelationId
 * - customerName: billToName > customer
 */
export interface OrderSnapshotForDraft {
  orderId: string;
  poNumber: string;
  status: string;          // 订单当前状态（draftPhase 用作 previousStatus）
  amount: number;          // 已按优先级解析，>0
  currency: string;        // 已按优先级解析（salesCurrency > currency > USD，出口 ERP 默认）
  customerRelationId: string; // billToRelationId > customerRelationId
  customerName: string;    // billToName > customer
  lineCount: number;       // OrderLine 数量，>0
}

export function buildOrderConfirmProcessDraft(params: {
  poNumber: string;
  previousStatus: string;
  newStatus: string;
  snapshot: OrderSnapshotForDraft;
}): ProcessDraft {
  const { poNumber, previousStatus, newStatus, snapshot } = params;

  // P1-A 真实口径：status + invoice(Issued) + AuditLog 全部在 $transaction 内收口
  // invoice 金额/币种/customer 来自订单快照（不硬编码）
  const subOperations: SubOperation[] = [
    {
      toolId: 'orders.update_status',
      entityId: snapshot.orderId,
      action: 'update_status',
      before: { status: previousStatus, orderId: snapshot.orderId, poNumber: snapshot.poNumber },
      after: { status: newStatus },
    },
    {
      toolId: 'finance.create_invoice',
      entityId: snapshot.orderId,
      action: 'create_invoice',
      before: {},
      after: {
        poNumber,
        orderId: snapshot.orderId,
        status: 'Issued',
        type: 'Receivable',
        amount: snapshot.amount,
        currency: snapshot.currency,
        customerRelationId: snapshot.customerRelationId,
        customerName: snapshot.customerName,
        lineCount: snapshot.lineCount,
      },
    },
  ];

  const beforeAfterDiff: FieldDiff[] = [
    {
      entity: 'Order',
      entityId: snapshot.orderId,
      field: 'status',
      before: previousStatus,
      after: newStatus,
    },
    {
      entity: 'Invoice',
      entityId: snapshot.orderId,
      field: 'status',
      before: null,
      after: 'Issued',
    },
    {
      entity: 'Invoice',
      entityId: snapshot.orderId,
      field: 'amount',
      before: null,
      after: snapshot.amount,
    },
  ];

  const impactScope = ['orders', 'invoices'];

  const irreversible = true;

  // P1-A scope：postCommitHooks 为空（email/EmailQueue 排除在外）
  const postCommitHooks: PostCommitHook[] = [];

  const draftContent = {
    subOperations,
    beforeAfterDiff,
    impactScope,
    irreversible,
    postCommitHooks,
  };
  const idempotencyKey = `order.confirm:${poNumber}:${computeProcessDraftHash(draftContent)}`;

  return {
    ...draftContent,
    idempotencyKey,
  };
}

/**
 * ProcessDraft 完整性校验（六字段全部必填）。
 */
export function validateProcessDraft(draft: ProcessDraft): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!Array.isArray(draft.subOperations)) missing.push('subOperations');
  if (!Array.isArray(draft.beforeAfterDiff)) missing.push('beforeAfterDiff');
  if (!Array.isArray(draft.impactScope)) missing.push('impactScope');
  if (typeof draft.irreversible !== 'boolean') missing.push('irreversible');
  if (!Array.isArray(draft.postCommitHooks)) missing.push('postCommitHooks');
  if (typeof draft.idempotencyKey !== 'string' || !draft.idempotencyKey) missing.push('idempotencyKey');
  return { ok: missing.length === 0, missing };
}
