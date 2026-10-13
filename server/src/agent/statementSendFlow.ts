/**
 * Agent-E3-statement-send-flow-contract
 *
 * statement.send draft→approval→commit 流程契约（E3 NL 高频业务操作：生成对账单并投递客户）。
 * draft 阶段由 toolRuntime 调用 getCustomerStatement 生成完整快照并嵌入 subOperations.after，
 * commit 零重算（what-you-approve-is-what-you-commit）：仅写 outbound/Outbox Email + AuditLog。
 * contract 边界与 invoice.issue 一致：不 SMTP 发送，sentAt/messageId 保持 null，显式发送走 email.send flow。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）。
 */

import { PrismaClient } from '@prisma/client';
import { writeRouteAuditLog, auditActorFrom } from '../audit/routeAudit';
import type { CustomerStatement, StatementSection } from '../finance/reportService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type StatementSendFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'EMAIL_REQUIRED'
  | 'STATEMENT_EMPTY'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface StatementSendFlowError {
  code: StatementSendFlowErrorCode;
  message: string;
  userAction: string;
}

export interface StatementSendFlowCommitted {
  status: 'committed';
  emailId: string;
  customerRelationId: string;
  auditId: string;
  idempotencyKey: string;
}

export type StatementSendFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | StatementSendFlowCommitted
  | { status: 'failed'; error: StatementSendFlowError; approvalId?: string };

export function buildStatementSendError(code: StatementSendFlowErrorCode, message: string): StatementSendFlowError {
  const userActionMap: Record<StatementSendFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起对账单流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '对账单 draft 语义校验失败，请检查 customerRelationId',
    EMAIL_REQUIRED: '对账单投递必须提供收件邮箱 email.to 与主题 email.subject',
    STATEMENT_EMPTY: '该客户在指定期间无任何应收往来，无需生成对账单',
    COMMIT_TRANSACTION_FAILED: '事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

export interface StatementSendDraftInput {
  customerRelationId: string;
  customerName?: string | null;
  from?: string;
  to?: string;
  email: { to: string[]; subject: string };
  statementSnapshot: CustomerStatement;
}

/** 对账单快照是否含实际往来（draft 前置判断 + commit 语义兜底共用口径） */
export function statementHasActivity(snapshot: CustomerStatement): boolean {
  return snapshot.sections.some(
    (s: StatementSection) => s.transactions.length > 0 || s.openingBalance !== 0,
  );
}

/** 从 draft 快照渲染对账单纯文本（commit 唯一渲染入口，零 DB 重算） */
export function renderStatementBody(input: {
  customerName: string | null;
  from: string | null;
  to: string | null;
  snapshot: CustomerStatement;
}): string {
  const { customerName, from, to, snapshot } = input;
  const period = `${from ?? '期初'} ~ ${to ?? '至今'}`;
  const lines: string[] = [
    `对账单 / Statement of Account`,
    // B269：取不到名字时宁缺格，也不把内部 relation id 印进发出去的信
    `客户：${customerName ?? snapshot.customerCode ?? '—'}`,
    `期间：${period}`,
    '',
  ];
  const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const section of snapshot.sections) {
    lines.push(`【${section.currency}】期初余额 ${fmt(section.openingBalance)}`);
    lines.push('日期 | 类型 | 单号 | 借方(开票) | 贷方(收款) | 余额');
    for (const t of section.transactions) {
      const kind = t.kind === 'invoice' ? '发票' : '收款';
      lines.push(`${t.date} | ${kind} | ${t.number} | ${t.debit ? fmt(t.debit) : '-'} | ${t.credit ? fmt(t.credit) : '-'} | ${fmt(t.balance)}`);
    }
    lines.push(`【${section.currency}】期末余额 ${fmt(section.closingBalance)}`);
    lines.push('');
  }
  lines.push('请核对以上往来明细，如有异议请及时联系。本邮件由 Bambook 生成。');
  return lines.join('\n');
}

export function buildStatementSendDraft(input: StatementSendDraftInput): ProcessDraft {
  const afterPayload: Record<string, any> = {
    customerRelationId: input.customerRelationId,
    customerName: input.customerName ?? input.statementSnapshot.customerName ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    email: { to: input.email.to, subject: input.email.subject },
    statementSnapshot: input.statementSnapshot,
  };

  const entityKey = `statement:${input.customerRelationId}:${input.from ?? 'all'}:${input.to ?? 'all'}`;

  const subOperations: SubOperation[] = [{
    toolId: 'statement.send',
    entityId: entityKey,
    action: 'create_statement_outbox_email',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'emails',
    entityId: entityKey,
    field: 'outbox',
    before: 'none' as any,
    after: 'outbound:Outbox' as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['finance', 'emails'],
    irreversible: false, // Outbox 邮件未 SMTP 发送前可删除回退
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `statement.send:${input.customerRelationId}:${input.from ?? 'all'}:${input.to ?? 'all'}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateStatementSendDraftSemantics(draft: any): { ok: boolean; error?: StatementSendFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildStatementSendError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.customerRelationId) {
    return { ok: false, error: buildStatementSendError('SEMANTIC_VALIDATION_FAILED', 'draft must contain customerRelationId in subOperations.after') };
  }
  if (!Array.isArray(after?.email?.to) || after.email.to.length === 0 || !after?.email?.subject) {
    return { ok: false, error: buildStatementSendError('EMAIL_REQUIRED', 'email.to (non-empty array) and email.subject are required') };
  }
  const snapshot = after?.statementSnapshot as CustomerStatement | undefined;
  if (!snapshot || !Array.isArray(snapshot.sections) || !statementHasActivity(snapshot)) {
    return { ok: false, error: buildStatementSendError('STATEMENT_EMPTY', 'statement snapshot has no activity in the given period') };
  }
  return { ok: true };
}

export function verifyStatementSendDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface StatementSendCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitStatementSend(
  params: StatementSendCommitParams,
): Promise<{ ok: true; feedback: StatementSendFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: StatementSendFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildStatementSendError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyStatementSendDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildStatementSendError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateStatementSendDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const after = draft.subOperations[0].after as any;
  const snapshot = after.statementSnapshot as CustomerStatement;

  // 零重算：邮件正文仅从审批过的 draft 快照渲染
  const bodyText = renderStatementBody({
    customerName: after.customerName ?? snapshot.customerName ?? null,
    from: after.from ?? null,
    to: after.to ?? null,
    snapshot,
  });

  try {
    let emailId = '';
    let auditId = '';
    await prisma.$transaction(async (tx: any) => {
      const now = BigInt(Date.now());
      emailId = `EML__${Date.now().toString(36)}`;
      await tx.email.create({
        data: {
          id: emailId,
          direction: 'outbound',
          status: 'read',
          fromAddress: 'agent@bambook.local',
          fromName: 'Bambook Agent',
          toAddresses: JSON.stringify(after.email.to),
          subject: after.email.subject,
          bodyText,
          mailbox: 'Outbox',
          mailboxOwnerUserId: auditActorFrom(params),
          threadId: null,
          messageId: null,
          sentAt: null,
          orderId: null,
          relationId: after.customerRelationId,
          createdAt: now,
          updatedAt: now,
        },
      });

      auditId = await writeRouteAuditLog({
        prisma: tx, actorId: auditActorFrom(params), source: 'agent:statement.send:commit',
        operation: 'statement_send_committed', targetType: 'Email', targetId: emailId,
        after: {
          emailId,
          customerRelationId: after.customerRelationId,
          from: after.from ?? null,
          to: after.to ?? null,
          currencies: snapshot.sections.map(s => s.currency),
          closingBalances: snapshot.sections.map(s => ({ currency: s.currency, closingBalance: s.closingBalance })),
        },
      });
    });

    return {
      ok: true,
      feedback: {
        status: 'committed',
        emailId,
        customerRelationId: after.customerRelationId,
        auditId,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    return {
      ok: false,
      feedback: { status: 'failed', error: buildStatementSendError('COMMIT_TRANSACTION_FAILED', String(e?.message ?? e)), approvalId },
    };
  }
}
