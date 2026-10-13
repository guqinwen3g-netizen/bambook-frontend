/**
 * Agent-P1-invoice-issue-flow-contract
 *
 * invoice.issue draft→approval→commit 最小闭环契约。
 * commit 事务内创建 Invoice(status=Issued) + syncInvoiceReferences + writeRouteAuditLog。
 * 复用 validateStatusTransition(Draft→Issued) + syncInvoiceReferences + writeRouteAuditLog。
 * 不 SMTP 发送；Outbox email 待发作为 postCommitHooks 排除（空），留给后续任务。
 * what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { exactJsonValue } from '../lib/exactJsonValue';
import { syncInvoiceReferences } from '../entities/sync';
import { validateStatusTransition } from '../statusTransition';
import { writeRouteAuditLog } from '../audit/routeAudit';
import type { TokenPayload } from '../auth/service';
import { currentProformaActor, ProformaAccessError } from '../finance/proformaInvoiceAccess';
import { lockInvoiceFinancialSources, visibleFinancialOrder } from '../shipping/shipmentFinancialAuthority';
import { OrderLineWriteError } from '../orders/orderLineWriteAccess';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { decideLcGate, LC_INVOICE_ISSUE_ACTION } from '../customs/lcGate';
import { businessError, isBusinessError, lookupErrorCode } from '../shared/errorCodes';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';
import { todayLocalKey } from '../shared/localDate';


export type InvoiceIssueErrorCode =
  | 'UNAUTHORIZED'
  | 'ACCOUNT_DISABLED'
  | 'FORBIDDEN'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'COMMIT_REPLAY_BLOCKED'
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_TRANSITION'
  | 'INVALID_AMOUNT'
  // ★ B50-1b：开票腿的 L/C 门禁。两枚码与 `invoiceMutationService`（HTTP 开票主路径）**完全同名**，
  //   不另造 "AGENT_LC_BLOCKED" 之类：同一道门在同名动作上必须同名，否则前端按码分支要写两份。
  | 'LC_GATE_BLOCKED'
  | 'LC_EXCEPTION_CHECK_FAILED'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface InvoiceIssueError {
  code: InvoiceIssueErrorCode;
  message: string;
  userAction: string;
  details?: string[];
}

export interface InvoiceIssueCommitted {
  status: 'committed';
  invoiceId: string;
  invoiceStatus: string;
  transactionId: string;
  auditId: string;
  idempotencyKey: string;
  replayed?: boolean;
}

export type InvoiceIssueFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | InvoiceIssueCommitted
  | { status: 'failed'; error: InvoiceIssueError; approvalId?: string };

export function buildInvoiceIssueError(code: InvoiceIssueErrorCode, message: string, details?: string[]): InvoiceIssueError {
  const userActionMap: Record<InvoiceIssueErrorCode, string> = {
    UNAUTHORIZED: '请使用有效用户会话重新执行原开票请求',
    ACCOUNT_DISABLED: '当前账号不可用，请重新登录或联系管理员',
    FORBIDDEN: '当前账号没有本次开票或来源查看权限',
    AUTHORIZATION_UNAVAILABLE: '当前权限或来源暂时无法核验，请稍后用原请求重试',
    ORDER_NOT_FOUND: '来源订单不存在或不在当前可操作范围，请核对原单',
    NOT_FOUND: '来源不存在或不可操作，请核对原单',
    CONFLICT: '实际来源已变化，请刷新后重新核对',
    COMMIT_REPLAY_BLOCKED: '原操作结果仍未知，请核对原发票及审计，不要重新开票',
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起开票流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '开票 draft 语义校验失败，请检查发票字段',
    INVALID_TRANSITION: '发票状态转移不合法（issue 要求 Draft→Issued）',
    INVALID_AMOUNT: '发票金额必须为正数',
    LC_GATE_BLOCKED: '该订单以信用证结算，但 L/C 条款不满足开票要求：请先在「信用证」登记/核对有效期与装运期限，确需例外按 DR-013 申请豁免后重试。',
    LC_EXCEPTION_CHECK_FAILED: '信用证条款不满足，且系统查不到是否已有 DR-013 例外 ⇒ 保持阻断。这一步是服务端故障，请排查例外/审批服务后重试。',
    COMMIT_TRANSACTION_FAILED: '请保留原开票请求并核对结果，不要重复新开票',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code], details };
}

export interface InvoiceIssueDraftInput {
  invoiceId?: string;
  invoiceNumber: string;
  type?: string;
  amount: number;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  customerRelationId?: string;
  customerName?: string;
  orderId?: string;
  notes?: string;
  // Outbox email 待发（contract 边界：不 SMTP，写 mailbox=Outbox + sentAt=null + messageId=null）
  email?: {
    to: string[];
    subject: string;
    bodyText: string;
  };
}

export function buildInvoiceIssueDraft(input: InvoiceIssueDraftInput): ProcessDraft {
  const afterPayload: Record<string, any> = {
    invoiceNumber: input.invoiceNumber,
    type: input.type || 'Receivable',
    status: 'Issued',
    amount: input.amount,
    currency: input.currency || 'CNY',
    issueDate: input.issueDate || todayLocalKey(),
    dueDate: input.dueDate || null,
    customerRelationId: input.customerRelationId || null,
    customerName: input.customerName || null,
    orderId: input.orderId || null,
    notes: input.notes || null,
  };
  if (input.invoiceId) afterPayload.id = input.invoiceId;

  const subOperations: SubOperation[] = [{
    toolId: 'finance.create_invoice',
    entityId: input.invoiceId || input.invoiceNumber,
    action: 'create_and_issue_invoice',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'invoices',
    entityId: input.invoiceId || input.invoiceNumber,
    field: 'status',
    before: 'Draft',
    after: 'Issued',
  }];

  // 双 subOperation：invoice + Outbox email 待发（contract 边界：不 SMTP）
  if (input.email) {
    const emailAfter = {
      to: input.email.to,
      subject: input.email.subject,
      bodyText: input.email.bodyText,
      direction: 'outbound',
      mailbox: 'Outbox',
    };
    subOperations.push({
      toolId: 'email.reply_and_send',
      entityId: `${input.invoiceId || input.invoiceNumber}:outbox`,
      action: 'create_outbox_email',
      before: {},
      after: emailAfter,
    });
    beforeAfterDiff.push({
      entity: 'emails',
      entityId: `${input.invoiceId || input.invoiceNumber}:outbox`,
      field: 'outbox',
      before: 'none' as any,
      after: 'outbound:Outbox' as any,
    });
  }

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: input.email ? ['invoices', 'emails'] : ['invoices'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `invoice.issue:${input.invoiceId || input.invoiceNumber}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateInvoiceIssueDraftSemantics(draft: any): { ok: boolean; error?: InvoiceIssueError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildInvoiceIssueError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.invoiceNumber) {
    return { ok: false, error: buildInvoiceIssueError('SEMANTIC_VALIDATION_FAILED', 'draft must contain invoiceNumber in subOperations.after') };
  }
  if (!after?.amount || Number(after.amount) <= 0) {
    return { ok: false, error: buildInvoiceIssueError('INVALID_AMOUNT', 'invoice amount must be a positive number') };
  }
  // 复用 validateStatusTransition 校验 Draft→Issued 合法转移
  const t = validateStatusTransition('Invoice', 'Draft', after.status || 'Issued');
  if (!t.ok) {
    return { ok: false, error: buildInvoiceIssueError('INVALID_TRANSITION', t.message!) };
  }
  return { ok: true };
}

export function verifyInvoiceIssueDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface InvoiceIssueCommitParams {
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
  /** Actual executor; a scalar audit identity alone cannot authorize a write. */
  actorId?: string;
  trustedActor?: TokenPayload | null;
  /** Server-injected approval requester provenance, never execution authority. */
  requesterId?: string;
}

const ISSUE_ACCESS_CODES = ['UNAUTHORIZED', 'ACCOUNT_DISABLED', 'FORBIDDEN', 'AUTHORIZATION_UNAVAILABLE',
  'ORDER_NOT_FOUND', 'NOT_FOUND', 'CONFLICT', 'COMMIT_REPLAY_BLOCKED'] as const;
type IssueAccessCode = typeof ISSUE_ACCESS_CODES[number];
function issueAccessCode(code: unknown): code is IssueAccessCode {
  return typeof code === 'string' && (ISSUE_ACCESS_CODES as readonly string[]).includes(code);
}

/** The same current Finance capability and fresh Order/source contract as
 * native invoice writes. No batch is invented for a lawful whole-order invoice.
 * All checks use the caller's transaction and the original signed ceiling. */
async function assertIssueAuthority(tx: any, prior: TokenPayload, orderId: string | null, lockSource: boolean) {
  try {
    const actor = await currentProformaActor(tx, prior.userId, prior);
    if (orderId) {
      if (lockSource) await lockInvoiceFinancialSources(tx, [{ orderId }], prior);
      else await visibleFinancialOrder(tx, orderId, actor);
    }
    return await currentProformaActor(tx, prior.userId, prior);
  } catch (error) {
    if (error instanceof ProformaAccessError && issueAccessCode(error.code)) throw businessError(error.code, error.message);
    if (isBusinessError(error) && issueAccessCode(error.code)) throw error;
    if (error instanceof OrderLineWriteError && issueAccessCode(error.code)) throw businessError(error.code, error.message);
    if (error instanceof DevelopmentDomainError && error.code === 'CONFLICT') throw businessError('CONFLICT', error.message);
    // A missing storage delegate or SQL failure cannot become a source absence
    // or expose driver text as a new authorization error.
    throw businessError('AUTHORIZATION_UNAVAILABLE', '当前开票权限或来源暂时无法核验，请稍后用原请求重试。');
  }
}

function issueSourceMoney(value: unknown): string {
  try {
    if (value == null) throw new Error('unknown money');
    const amount = new Prisma.Decimal(value as any);
    if (!amount.isFinite()) throw new Error('unknown money');
    return amount.toString();
  } catch {
    throw businessError('CONFLICT', '原发票金额事实无法核对，请核对原开票结果。');
  }
}

function assertIssueReceiptSource(invoice: any, after: any, allocations: any[]) {
  if (!invoice || invoice.deletedAt != null) throw businessError('NOT_FOUND', '原开票记录不存在或不可查看，请核对原请求。');
  if (invoice.invoiceNumber !== after.invoiceNumber || invoice.type !== (after.type || 'Receivable')
    || (invoice.orderId ?? null) !== (after.orderId || null)
    || (invoice.customerRelationId ?? null) !== (after.customerRelationId || null)
    || invoice.currency !== (after.currency || 'CNY')
    || issueSourceMoney(invoice.amount) !== issueSourceMoney(after.amount)
    || (after.id != null && invoice.id !== after.id)
    || invoice.sourceType != null || invoice.sourceId != null
    || allocations.some(row => row.orderId !== (after.orderId || null))) {
    throw businessError('CONFLICT', '原发票的实际来源与审批开票内容不一致，请核对原开票结果。');
  }
}

function issueAllocationSource(rows: any[]): string {
  return JSON.stringify(rows.map(row => [row.id, row.orderId, row.batchId ?? null, issueSourceMoney(row.allocatedAmount)]));
}

/** A cached issue result is historical acknowledgement, not current Invoice
 * eligibility. Keep later Paid/Cancelled states and notes unchanged, but do
 * not expose a result whose original Order is now hidden or whose actual
 * Invoice/source was changed. No receipt or business row is written here. */
export async function checkInvoiceIssueReplayAuthority(params: {
  prisma: PrismaClient; approvalPayload: any; receiptResult: any; trustedActor?: TokenPayload | null;
  tx?: any; sourceLocked?: boolean;
}): Promise<{ ok: true } | { ok: false; error: InvoiceIssueError }> {
  const prior = params.trustedActor, draft = params.approvalPayload?.processDraft, receipt = params.receiptResult;
  if (!prior?.userId) return { ok: false, error: buildInvoiceIssueError('UNAUTHORIZED', '开票结果核对需要当前有效的用户主体。') };
  try {
    if (!draft || !verifyInvoiceIssueDraftHash(draft).ok || !validateInvoiceIssueDraftSemantics(draft).ok
      || receipt?.ok !== true || receipt.status !== 'committed' || typeof receipt.invoiceId !== 'string' || !receipt.invoiceId
      || receipt.idempotencyKey !== draft.idempotencyKey) {
      throw businessError('CONFLICT', '原开票回执与审批内容无法准确对应，请保留原请求并核对。');
    }
    const after = draft.subOperations[0].after, orderId = after.orderId ? String(after.orderId) : null;
    const check = async (tx: any) => {
      await assertIssueAuthority(tx, prior, orderId, false);
      const loadInvoice = () => tx.invoice.findUnique({ where: { id: receipt.invoiceId } });
      const loadAllocations = () => tx.invoiceOrderAllocation.findMany({ where: { invoiceId: receipt.invoiceId, deletedAt: null }, orderBy: { id: 'asc' } });
      const hint = await loadInvoice(), hintedAllocations = await loadAllocations();
      assertIssueReceiptSource(hint, after, hintedAllocations);
      const allocationSource = issueAllocationSource(hintedAllocations);
      // The original issue only created a whole-order header; current native
      // IOA parents must still belong to that same actual Order. Source/Order
      // locks precede Invoice and its children, matching native financial writes.
      if (!params.sourceLocked) await assertIssueAuthority(tx, prior, orderId, true);
      const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice"
        WHERE "id"=${receipt.invoiceId} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!locked.length) throw businessError('NOT_FOUND', '原开票记录不存在或不可查看，请核对原请求。');
      for (const allocation of hintedAllocations) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InvoiceOrderAllocation"
        WHERE "id"=${allocation.id} AND "deletedAt" IS NULL FOR UPDATE`);
      const invoice = await loadInvoice(), allocations = await loadAllocations();
      assertIssueReceiptSource(invoice, after, allocations);
      if (issueAllocationSource(allocations) !== allocationSource)
        throw businessError('CONFLICT', '原发票来源关联在核对时变化，请保留原请求并重试。');
      await assertIssueAuthority(tx, prior, orderId, false);
    };
    if (params.tx) await check(params.tx); else await params.prisma.$transaction(check);
    return { ok: true };
  } catch (error) {
    const safe = isBusinessError(error) && issueAccessCode(error.code)
      ? buildInvoiceIssueError(error.code, typeof error.message === 'string' ? error.message
        : lookupErrorCode(error.code)?.message ?? '当前开票结果无法核对，请保留原请求。')
      : buildInvoiceIssueError('AUTHORIZATION_UNAVAILABLE', '当前开票结果或来源暂时无法核验，请保留原请求并稍后核对。');
    return { ok: false, error: safe };
  }
}

function issueJson(value: any): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(exactJsonValue(value)));
}
function issueDigest(value: any): string { return createHash('sha256').update(issueJson(value)).digest('hex'); }
function issueInvoiceFact(row: any) {
  return exactJsonValue({ id: row.id, invoiceNumber: row.invoiceNumber, type: row.type,
    orderId: row.orderId ?? null, customerRelationId: row.customerRelationId ?? null,
    amount: issueSourceMoney(row.amount), currency: row.currency, issueDate: row.issueDate,
    dueDate: row.dueDate ?? null, createdAt: row.createdAt,
    sourceType: row.sourceType ?? null, sourceId: row.sourceId ?? null });
}
function issueOutboxFact(row: any) {
  return exactJsonValue({ id: row.id, direction: row.direction, fromAddress: row.fromAddress, fromName: row.fromName,
    toAddresses: row.toAddresses, subject: row.subject, bodyText: row.bodyText,
    orderId: row.orderId ?? null, relationId: row.relationId ?? null, createdAt: row.createdAt });
}
interface IssueReceiptEnvelope {
  schemaVersion: 1; command: any; commandHash: string; acknowledgement: any; ackHash: string;
  facts: { invoice: any; outbox: any | null };
}
async function issueApprovedRequester(tx: any, approvalId: string, draft: any, suppliedRequester?: string) {
  const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalRequest" WHERE "id"=${approvalId} FOR UPDATE`);
  const approval = locked.length ? await tx.approvalRequest.findUnique({ where: { id: approvalId } }) : null;
  if (!approval || approval.status !== 'approved' || approval.actionType !== 'tool:invoice.issue')
    throw businessError('CONFLICT', '原开票审批已不可执行，请核对原审批。');
  if (typeof approval.requesterId !== 'string' || !approval.requesterId
    || suppliedRequester !== undefined && suppliedRequester !== approval.requesterId
    || issueJson(approval.payload?.processDraft) !== issueJson(draft))
    throw businessError('CONFLICT', '原开票审批内容或请求人已变化，请核对原请求。');
  return approval.requesterId as string;
}
async function claimIssueReceipt(tx: any, receiptKey: string, approvalId: string) {
  const id = `acr_iis_${createHash('sha256').update(receiptKey).digest('hex')}`;
  // A real PostgreSQL unique key arbitrates concurrent claims without leaving
  // an aborted transaction after a caught P2002. A losing claim never reissues.
  const inserted = await tx.$queryRaw(Prisma.sql`INSERT INTO "AgentCommitReceipt"
    ("id", "idempotencyKey", "toolId", "approvalId", "status")
    VALUES (${id}, ${receiptKey}, 'invoice.issue', ${approvalId}, 'committing')
    ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING "id"`);
  const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AgentCommitReceipt" WHERE "idempotencyKey"=${receiptKey} FOR UPDATE`);
  const receipt = locked.length ? await tx.agentCommitReceipt.findUnique({ where: { idempotencyKey: receiptKey } }) : null;
  if (!receipt || receipt.toolId !== 'invoice.issue' || receipt.approvalId !== approvalId || receipt.idempotencyKey !== receiptKey)
    throw businessError('CONFLICT', '原开票回执标识无法准确对应，请核对原请求。');
  return { receipt, acquired: inserted.length === 1 && inserted[0].id === receipt.id };
}
async function validateIssueReceipt(tx: any, params: InvoiceIssueCommitParams, draft: any, command: any, receiptKey: string, stored: any) {
  if (stored.status !== 'committed')
    throw businessError('COMMIT_REPLAY_BLOCKED', '原开票请求存在尚未确认的回执，请核对原结果，不会重新开票。');
  const value = stored.result;
  if (!value || typeof value !== 'object') throw businessError('CONFLICT', '原开票回执缺少准确结果，请核对原请求。');
  const modern = value.schemaVersion !== undefined;
  const ack = modern ? value.acknowledgement : value;
  if (modern && (!ack || typeof ack !== 'object' || Array.isArray(ack) || !value.facts?.invoice
    || value.facts.outbox === undefined || value.schemaVersion !== 1 || issueJson(value.command) !== issueJson(command)
    || value.commandHash !== issueDigest({ schemaVersion: 1, command }) || value.ackHash !== issueDigest(ack)))
    throw businessError('CONFLICT', '原开票命令、执行者或回执内容不一致，请保留原请求并核对。');
  const checked = await checkInvoiceIssueReplayAuthority({ prisma: params.prisma, tx, sourceLocked: true,
    approvalPayload: { processDraft: draft }, receiptResult: ack, trustedActor: params.trustedActor });
  if (!checked.ok) throw businessError(checked.error.code, checked.error.message);
  if (modern) {
    const audit = await tx.auditLog.findUnique({ where: { id: ack.auditId } });
    const after = audit?.detail?.after;
    const { auditId: ignoredAuditId, ...ackCore } = ack;
    if (!audit || audit.actorId !== command.executorId || audit.action !== 'invoice_issue_committed'
      || audit.targetType !== 'Invoice' || audit.targetId !== ack.invoiceId || audit.detail?.source !== 'agent:invoice.issue:commit'
      || after?.invoiceId !== ack.invoiceId || after?.status !== ack.invoiceStatus || after?.transactionId !== ack.transactionId
      || after?.approvalId !== command.approvalId || after?.approvalRequesterId !== command.requesterId || after?.executionActorId !== command.executorId
      || after?.outboxEmailId !== (value.facts.outbox?.id ?? null) || issueSourceMoney(after?.amount) !== command.source.amount
      || after?.receiptKey !== receiptKey || after?.receiptSchemaVersion !== 1 || after?.commandHash !== value.commandHash
      || issueJson(after?.commandSnapshot) !== issueJson(command) || issueJson(after?.acknowledgementCore) !== issueJson(ackCore)
      || issueJson(after?.invoiceFact) !== issueJson(value.facts?.invoice) || issueJson(after?.outboxFact) !== issueJson(value.facts?.outbox))
      throw businessError('CONFLICT', '原开票回执没有准确的必需审计事实，请核对原结果。');
    const invoice = await tx.invoice.findUnique({ where: { id: ack.invoiceId } });
    if (!invoice || issueJson(issueInvoiceFact(invoice)) !== issueJson(value.facts.invoice))
      throw businessError('CONFLICT', '原发票实际来源与冻结回执不一致，请核对原结果。');
    if (value.facts.outbox != null) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Email" WHERE "id"=${value.facts.outbox.id} FOR UPDATE`);
      const email = await tx.email.findUnique({ where: { id: value.facts.outbox.id } });
      if (!email || email.deletedAt != null || issueJson(issueOutboxFact(email)) !== issueJson(value.facts.outbox))
        throw businessError('CONFLICT', '原 Outbox 的实际内容与冻结回执不一致，请核对原结果。');
    }
    await assertIssueAuthority(tx, params.trustedActor!, command.source.orderId, false);
  }
  // Legacy committed receipts retain their existing read verification only;
  // they are never rewritten or presented as having this new versioned proof.
  const { ok: ignoredOk, ...feedback } = ack;
  return { ...feedback, replayed: true } as InvoiceIssueCommitted;
}

export async function commitInvoiceIssue(
  params: InvoiceIssueCommitParams,
): Promise<{ ok: true; feedback: InvoiceIssueCommitted } | { ok: false; feedback: { status: 'failed'; error: InvoiceIssueError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceIssueError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyInvoiceIssueDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceIssueError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateInvoiceIssueDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const prior = params.trustedActor;
  if (!prior?.userId || params.actorId !== undefined && params.actorId !== prior.userId) {
    return { ok: false, feedback: { status: 'failed', error: buildInvoiceIssueError('UNAUTHORIZED', '开票操作需要当前有效的用户主体。'), approvalId } };
  }

  const transactionId = `iis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let auditId = '';
  let committed: InvoiceIssueCommitted | undefined;

  const auditActorId = prior.userId;
  const commandDraft = JSON.parse(issueJson(draft));
  const receiptKey = `commit:invoice.issue:${approvalId}`;

  try {
    await prisma.$transaction(async (tx: any) => {
      const now = BigInt(Date.now());
      const after = commandDraft.subOperations[0].after as any;
      const invoiceId = after.id || `INV__${Date.now().toString(36)}`;
      const status = after.status || 'Issued';

      // 复用 validateStatusTransition（事务内再次校验 Draft→Issued）
      const t = validateStatusTransition('Invoice', 'Draft', status);
      if (!t.ok) throw Object.assign(new Error(t.message!), { code: 'INVALID_TRANSITION' });

      // ★ B50-1b：这条是 agent 面**第二**条开票出口（`finance.create_invoice` 审批 → 提交），
      //   它自己 `tx.invoice.create`，**不经过** `invoiceMutationService.createInvoice` ⇒ 那道
      //   L/C 开票门禁对它零作用（同 §9 B50 的形状：代码在、另一条路上没人调）。
      //   同一个 `decideLcGate`、同一个 stage/action、抛出即整笔回滚 ⇒ 被挡时这张票不落地。
      //   条件与主路径一致：只卡**有订单锚点**的应收票（付供应商的款与客户信用证无关；
      //   无 orderId 的票在门禁语义里"不适用"，本批不扩大范围）。
      const invoiceType = String(after.type || 'Receivable');
      const anchorOrderId = after.orderId ? String(after.orderId) : null;
      await assertIssueAuthority(tx, prior, anchorOrderId, true);
      const requesterId = await issueApprovedRequester(tx, approvalId, commandDraft, params.requesterId);
      const command = { operation: 'invoice.issue', approvalId, executorId: auditActorId, requesterId, processDraft: commandDraft,
        source: { orderId: anchorOrderId, customerRelationId: after.customerRelationId || null,
          invoiceNumber: after.invoiceNumber, type: invoiceType, currency: after.currency || 'CNY', amount: issueSourceMoney(after.amount) } };
      const claim = await claimIssueReceipt(tx, receiptKey, approvalId);
      // A claim/row lock may wait. Re-read the actual identity and parent scope
      // afterwards, even for an old successful acknowledgement.
      await assertIssueAuthority(tx, prior, anchorOrderId, false);
      if (!claim.acquired) {
        committed = await validateIssueReceipt(tx, params, commandDraft, command, receiptKey, claim.receipt);
        return;
      }
      if (claim.receipt.status !== 'committing' || claim.receipt.result != null)
        throw businessError('CONFLICT', '本次开票回执占用状态无法确认，请核对原请求。');
      if (anchorOrderId && invoiceType === 'Receivable') {
        const lcDecision = await decideLcGate({
          prisma: tx,
          orderId: anchorOrderId,
          // ⚠️ `order` 必须**不传**（由门禁自己按 orderId 查）：传 `null` 在它的契约里表示
          //   "调用方已确认订单不存在 ⇒ 本门禁不适用"，那会变成放行 —— 一个字母的 fail-open。
          stage: 'invoice:issue',
          exceptionAction: LC_INVOICE_ISSUE_ACTION,
        });
        if (!lcDecision.allowed) {
          throw Object.assign(
            new Error(
              lcDecision.code === 'LC_EXCEPTION_CHECK_FAILED'
                ? `信用证门禁未通过（${lcDecision.reasons.join(', ')}${lcDecision.lcLabel ? `；信用证 ${lcDecision.lcLabel}` : ''}），且无法确认是否已有 DR-013 例外 ⇒ 保持阻断，请先排查例外/审批服务`
                : `该订单以信用证结算，但${lcDecision.lcLabel ? `信用证 ${lcDecision.lcLabel} 不满足条款` : '尚未登记信用证'}（${lcDecision.reasons.join(', ')}）；请先登记/核对 L/C，确需例外按 DR-013 申请（action='${LC_INVOICE_ISSUE_ACTION}'）`,
            ),
            // 同 `invoiceMutationService.ts:408`：档位查注册表真源，不在这里手写三元（B32/B34 两条判据都咬这里）
            { code: lcDecision.code, statusCode: lookupErrorCode(lcDecision.code)?.status ?? 500 },
          );
        }
      }

      const invoice = await tx.invoice.create({
        data: {
          id: invoiceId,
          invoiceNumber: after.invoiceNumber,
          type: after.type || 'Receivable',
          status,
          amount: Number(after.amount),
          currency: after.currency || 'CNY',
          issueDate: after.issueDate,
          dueDate: after.dueDate || null,
          customerRelationId: after.customerRelationId || null,
          customerName: after.customerName || null,
          orderId: after.orderId || null,
          notes: after.notes || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      // A successful receipt must already match the actual stored commercial
      // facts. Do not commit a rounded or redirected Invoice and discover the
      // mismatch only when the caller replays its original request.
      assertIssueReceiptSource(invoice, after, []);

      // 复用 syncInvoiceReferences（EntityLink aboutOrder + billTo，传 tx 同事务）
      await syncInvoiceReferences(prisma, invoice, { source: 'agent:invoice.issue' }, tx);

      // 同事务写 Outbox email 待发（contract 边界：不 SMTP，不写 sentAt/messageId）
      let emailId: string | null = null;
      let outbox: any = null;
      if (commandDraft.subOperations.length > 1) {
        const emailAfter = commandDraft.subOperations[1].after as any;
        emailId = `EML__${Date.now().toString(36)}`;
        outbox = await tx.email.create({
          data: {
            id: emailId,
            direction: 'outbound',
            status: 'read',
            fromAddress: 'agent@bambook.local',
            fromName: 'Bambook Agent',
            toAddresses: JSON.stringify(emailAfter.to),
            subject: emailAfter.subject,
            bodyText: emailAfter.bodyText,
            mailbox: 'Outbox',
            mailboxOwnerUserId: auditActorId,
            threadId: null,
            messageId: null,
            sentAt: null,
            orderId: after.orderId || null,
            relationId: after.customerRelationId || null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // audit（事务内闭环，用 writeRouteAuditLog 返回的真实 id）
      await assertIssueAuthority(tx, prior, anchorOrderId, false);
      const commandHash = issueDigest({ schemaVersion: 1, command });
      const facts = { invoice: issueInvoiceFact(invoice), outbox: outbox ? issueOutboxFact(outbox) : null };
      const acknowledgementCore = { ok: true, status: 'committed' as const, invoiceId: invoice.id, invoiceStatus: invoice.status,
        transactionId, idempotencyKey: commandDraft.idempotencyKey };
      auditId = await writeRouteAuditLog({
        prisma: tx, actorId: auditActorId, source: 'agent:invoice.issue:commit',
        operation: 'invoice_issue_committed', targetType: 'Invoice', targetId: invoice.id,
        after: { invoiceId: invoice.id, status: invoice.status, amount: issueSourceMoney(invoice.amount), outboxEmailId: emailId, transactionId,
          approvalId, approvalRequesterId: requesterId, executionActorId: auditActorId,
          receiptSchemaVersion: 1, receiptKey, commandSnapshot: command, commandHash, acknowledgementCore,
          invoiceFact: facts.invoice, outboxFact: facts.outbox },
      });
      const acknowledgement = { ...acknowledgementCore, auditId };
      const envelope: IssueReceiptEnvelope = { schemaVersion: 1, command, commandHash, acknowledgement,
        ackHash: issueDigest(acknowledgement), facts };
      const saved = await tx.agentCommitReceipt.update({ where: { idempotencyKey: receiptKey },
        data: { status: 'committed', result: envelope, completedAt: new Date() } });
      if (!saved || saved.idempotencyKey !== receiptKey || saved.status !== 'committed' || issueJson(saved.result) !== issueJson(envelope))
        throw businessError('CONFLICT', '开票回执未能准确保存，本次事务不能提交。');
      const { ok: ignoredOk, ...feedback } = acknowledgement;
      committed = feedback;
    });
    if (!committed) throw new Error('missing transaction acknowledgement');
    return { ok: true, feedback: committed };
  } catch (e: any) {
    if (isBusinessError(e) && issueAccessCode(e.code)) {
      return { ok: false, feedback: { status: 'failed', error: buildInvoiceIssueError(e.code,
        typeof e.message === 'string' ? e.message : lookupErrorCode(e.code)?.message ?? '当前开票结果无法核对，请保留原请求。'), approvalId } };
    }
    // L/C 门禁的两种码原样透出（不许塌成 COMMIT_TRANSACTION_FAILED：那是一句"数据库错误，请重试"，
    //   而真相是"这张票被信用证条款挡着，重试一万次也一样"⇒ 下一步完全不同）。
    const gateCode = e?.code === 'LC_GATE_BLOCKED' || e?.code === 'LC_EXCEPTION_CHECK_FAILED'
      ? e.code as InvoiceIssueErrorCode
      : null;
    const code = e?.code === 'INVALID_TRANSITION' ? 'INVALID_TRANSITION' : gateCode ?? 'COMMIT_TRANSACTION_FAILED';
    const message = code === 'COMMIT_TRANSACTION_FAILED'
      ? '开票操作未能确认，请保留原请求并核对后重试。'
      : String(e?.message ?? e);
    return {
      ok: false,
      feedback: { status: 'failed', error: buildInvoiceIssueError(code as InvoiceIssueErrorCode, message), approvalId },
    };
  }
}
