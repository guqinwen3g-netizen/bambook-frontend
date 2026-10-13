/**
 * Agent-P1-relation-onboard-flow-contract
 *
 * relation.onboard draft→approval→commit 最小闭环契约。
 * commit 事务内创建 organization relation + primary contact relation + EntityLink sync + AuditLog。
 * 不自动发送邮件（welcome email 排除，postCommitHooks 为空）。
 * what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复。
 */

import { PrismaClient } from '@prisma/client';
import { syncOrganizationPrimaryContact } from '../relations/contactSync';
import { writeRouteAuditLog, auditActorFrom } from '../audit/routeAudit';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

const VALID_CATEGORIES = new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']);

export type RelationOnboardErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'INVALID_CATEGORY'
  | 'COMMIT_TRANSACTION_FAILED'
  | 'UNKNOWN_ERROR';

export interface RelationOnboardError {
  code: RelationOnboardErrorCode;
  message: string;
  userAction: string;
  details?: string[];
}

export interface RelationOnboardCommitted {
  status: 'committed';
  organizationId: string;
  contactId: string | null;
  transactionId: string;
  auditId: string;
  idempotencyKey: string;
}

export type RelationOnboardFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | RelationOnboardCommitted
  | { status: 'failed'; error: RelationOnboardError; approvalId?: string };

export function buildRelationOnboardError(code: RelationOnboardErrorCode, message: string, details?: string[]): RelationOnboardError {
  const userActionMap: Record<RelationOnboardErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起建档流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '建档 draft 语义校验失败，请检查组织名称/category',
    INVALID_CATEGORY: 'category 必须是 7 个业务分类之一：Customer/Supplier/Agent/Partner/Government/Internal/Other',
    COMMIT_TRANSACTION_FAILED: '事务失败已回滚，请重试',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code], details };
}

export interface RelationOnboardDraftInput {
  organization: {
    id: string;
    name: string;
    category: string;
    type?: string;
    [key: string]: any;
  };
  contact?: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    [key: string]: any;
  };
}

export function buildRelationOnboardDraft(input: RelationOnboardDraftInput): ProcessDraft {
  const { organization, contact } = input;

  const orgAfter = { ...organization, category: organization.category || 'Other' };
  const subOperations: SubOperation[] = [{
    toolId: 'relations.create',
    entityId: organization.id,
    action: 'create_organization',
    before: {},
    after: orgAfter,
  }];

  if (contact) {
    const contactAfter = { ...contact, parentId: organization.id, isOrganization: false };
    subOperations.push({
      toolId: 'relations.create',
      entityId: contact.id,
      action: 'create_primary_contact',
      before: {},
      after: contactAfter,
    });
  }

  const beforeAfterDiff = subOperations.map((s) => ({
    entity: 'relations',
    entityId: s.entityId,
    field: s.action,
    before: null,
    after: { name: (s.after as any).name },
  }));

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['relations'],
    irreversible: true,
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `relation.onboard:${organization.id}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateRelationOnboardDraftSemantics(draft: any): { ok: boolean; error?: RelationOnboardError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildRelationOnboardError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const orgSub = draft.subOperations[0];
  const orgAfter = orgSub.after as any;
  if (!orgAfter?.id || !orgAfter?.name) {
    return { ok: false, error: buildRelationOnboardError('SEMANTIC_VALIDATION_FAILED', 'organization subOperation must contain id and name') };
  }
  if (orgAfter.category && !VALID_CATEGORIES.has(orgAfter.category)) {
    return { ok: false, error: buildRelationOnboardError('INVALID_CATEGORY', `category "${orgAfter.category}" is not valid. Must be one of: ${[...VALID_CATEGORIES].join('/')}`) };
  }
  // 如果有 contact subOperation，校验 id + name
  if (draft.subOperations.length > 1) {
    const contactAfter = draft.subOperations[1].after as any;
    if (!contactAfter?.id || !contactAfter?.name) {
      return { ok: false, error: buildRelationOnboardError('SEMANTIC_VALIDATION_FAILED', 'contact subOperation must contain id and name') };
    }
  }
  return { ok: true };
}

export function verifyRelationOnboardDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface RelationOnboardCommitParams {
  /** ★ B58：审批请求人，由 `toolDispatchRegistry` 注入；缺省落 'system'（AuditLog.actorId 有外键） */
  actorId?: string;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitRelationOnboard(
  params: RelationOnboardCommitParams,
): Promise<{ ok: true; feedback: RelationOnboardCommitted } | { ok: false; feedback: { status: 'failed'; error: RelationOnboardError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildRelationOnboardError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyRelationOnboardDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildRelationOnboardError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateRelationOnboardDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  const transactionId = `rob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let auditId = '';
  let committed: Partial<RelationOnboardCommitted> = {};

  try {
    await prisma.$transaction(async (tx: any) => {
      const now = BigInt(Date.now());

      // 1. upsert organization relation（复用 handleRelationCreate 同款逻辑）
      const orgData = draft.subOperations[0].after as any;
      const orgRelation = await tx.relation.upsert({
        where: { id: orgData.id },
        update: { name: orgData.name, category: orgData.category, type: orgData.type || orgData.category },
        create: {
          id: orgData.id, name: orgData.name, category: orgData.category, type: orgData.type || orgData.category,
          isOrganization: true, contactInfo: orgData.notes || '', lastInteraction: now,
          primaryContactName: orgData.primaryContactName || null,
          primaryContactEmail: orgData.primaryContactEmail || null,
          primaryContactPhone: orgData.primaryContactPhone || null,
          website: orgData.website || null, paymentTerms: orgData.paymentTerms || null,
          summary: orgData.notes || null,
        },
      });

      // 2. 联系人（如有）——2026-08-31 真源收敛：Contact 表为唯一写真源，
      //    不再创建 Relation 人物轨（isOrganization=false 人物行即旧轨写入口）。
      //    主联系人冗余回写（Relation.primaryContact*/contactInfo）同事务刷新，
      //    邮箱匹配/单据模板/订单预填等旧轨消费点即时保鲜。
      let contactRecord: any = null;
      if (draft.subOperations.length > 1) {
        const contactData = draft.subOperations[1].after as any;
        const contactNow = BigInt(Date.now());
        // 幂等：同人（同组织+同名）重放走更新，不重复建卡
        contactRecord = await tx.contact.findFirst({
          where: { relationId: orgRelation.id, name: contactData.name, deletedAt: null },
        });
        if (contactRecord) {
          contactRecord = await tx.contact.update({
            where: { id: contactRecord.id },
            data: {
              email: contactData.email || null,
              phone: contactData.phone || null,
              mobile: contactData.mobile || null,
              personalNote: contactData.notes || null,
              isPrimary: true,
              updatedAt: contactNow,
            },
          });
        } else {
          contactRecord = await tx.contact.create({
            data: {
              id: `CTC_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              relationId: orgRelation.id,
              name: contactData.name,
              email: contactData.email || null,
              phone: contactData.phone || null,
              mobile: contactData.mobile || null,
              personalNote: contactData.notes || null,
              isPrimary: true,
              isDecisionMaker: false,
              tags: [],
              status: 'Active',
              createdAt: contactNow,
              updatedAt: contactNow,
            },
          });
        }
        // 主联系人冗余回写（Contact → Relation.primaryContact*/contactInfo）
        await syncOrganizationPrimaryContact(tx, orgRelation.id);
      }

      // 3. audit（事务内闭环）——用 writeRouteAuditLog 返回的真实 audit id
      auditId = await writeRouteAuditLog({
        prisma: tx, actorId: auditActorFrom(params), source: 'agent:relation.onboard:commit',
        operation: 'relation_onboard_committed', targetType: 'Relation', targetId: orgRelation.id,
        after: { organizationId: orgRelation.id, contactId: contactRecord?.id || null, transactionId },
      });
      committed = { organizationId: orgRelation.id, contactId: contactRecord?.id || null };
    });

    return {
      ok: true,
      feedback: {
        status: 'committed',
        organizationId: committed.organizationId!,
        contactId: committed.contactId || null,
        transactionId,
        auditId,
        idempotencyKey: draft.idempotencyKey,
      },
    };
  } catch (e: any) {
    return {
      ok: false,
      feedback: { status: 'failed', error: buildRelationOnboardError('COMMIT_TRANSACTION_FAILED', String(e?.message ?? e)), approvalId },
    };
  }
}
