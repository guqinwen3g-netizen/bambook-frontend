/**
 * Agent-E3-development-create-flow-contract
 *
 * development.create draft→approval→commit 流程契约（E3 NL 高频业务操作：给 XX 客户下样品单）。
 * 复用 createDevelopmentCase shared service（route + Agent 共用契约），不在 Agent path 手写 DB mutation。
 * ProcessDraft what-you-approve-is-what-you-commit：commit 从 subOperations.after 恢复输入。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ code 唯一约束（P2002→DUPLICATE_CODE）。
 */

import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import {
  createDevelopmentCase,
  isValidStage,
  isValidType,
  type DevelopmentCaseMutationErrorCode,
} from '../development/developmentCaseMutationService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type DevCreateFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | 'CUSTOMER_REQUIRED'
  | DevelopmentCaseMutationErrorCode
  | 'UNKNOWN_ERROR';

export interface DevCreateFlowError {
  code: DevCreateFlowErrorCode;
  message: string;
  userAction: string;
}

export interface DevCreateFlowCommitted {
  status: 'committed';
  caseId: string;
  code: string;
  auditId: string;
  idempotencyKey: string;
}

export type DevCreateFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | DevCreateFlowCommitted
  | { status: 'failed'; error: DevCreateFlowError; approvalId?: string };

export function buildDevCreateError(code: DevCreateFlowErrorCode, message: string): DevCreateFlowError {
  const userActionMap: Record<DevCreateFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起创建流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: '创建 draft 语义校验失败，请检查必填字段（code/name/type）',
    CUSTOMER_REQUIRED: '样品单必须归属客户：请提供 customerRelationId 或 customerName',
    INVALID_INPUT: '输入参数无效',
    UNAUTHORIZED: '请使用真实员工账号重新登录后执行',
    FORBIDDEN: '当前账号或凭据没有开发写入权限，请核对授权后重试',
    AUTHORIZATION_UNAVAILABLE: '当前权限未能完整核对，请稍后重试',
    INVALID_TRANSITION: '阶段转移不合法',
    REVIEW_REQUIRED: '该阶段需要先通过样衣审批',
    INVALID_STAGE: '阶段取值不合法',
    INVALID_TYPE: '类型取值不合法（fabric/garment/pp/trim）',
    DUPLICATE_CODE: '开发单编号已存在，请更换 code',
    NOT_FOUND: '开发单不存在',
    ALREADY_DELETED: '开发单已删除',
    CONVERTED_TO_ORDER: '开发单已转订单，不可删除',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新失败',
    STAGE_UPDATE_FAILED: '阶段更新失败',
    DELETE_FAILED: '删除失败',
    DEVELOPMENT_NOT_READY: '请先完成样品认可及转档，再确认开发或转换订单',
    DEVELOPMENT_PAUSED: '开发案已暂停，请恢复后再继续开发操作',
    DEVELOPMENT_CLOSED: '开发案已结案，不能继续修改开发内容',
    LIFECYCLE_HISTORY_EXISTS: '开发案已有生命周期记录，请保留历史，不可删除',
    INVALID_LIFECYCLE_STATE: '开发案状态异常，请联系管理员核查后再操作',
    UNKNOWN_ERROR: '未知错误，请联系管理员',
  };
  return { code, message, userAction: userActionMap[code] };
}

export interface DevCreateDraftInput {
  code: string;
  name: string;
  type: string;
  stage?: string;
  priority?: string;
  owner?: string;
  customerRelationId?: string;
  customerName?: string;
  supplierRelationId?: string;
  supplierName?: string;
  productAssetId?: string;
  productName?: string;
  nextAction?: string;
  targetDate?: string;
  sampleType?: string;
  sampleQuantity?: number;
  sampleUnit?: string;
  notes?: string;
  tags?: string[];
}

export function buildDevCreateDraft(input: DevCreateDraftInput): ProcessDraft {
  const afterPayload: Record<string, any> = {
    code: input.code,
    name: input.name,
    type: input.type,
  };
  // 只携带显式传入的可选字段（审批所见即 commit 所写，不隐式补默认值）
  if (input.stage !== undefined) afterPayload.stage = input.stage;
  if (input.priority !== undefined) afterPayload.priority = input.priority;
  if (input.owner !== undefined) afterPayload.owner = input.owner;
  if (input.customerRelationId !== undefined) afterPayload.customerRelationId = input.customerRelationId;
  if (input.customerName !== undefined) afterPayload.customerName = input.customerName;
  if (input.supplierRelationId !== undefined) afterPayload.supplierRelationId = input.supplierRelationId;
  if (input.supplierName !== undefined) afterPayload.supplierName = input.supplierName;
  if (input.productAssetId !== undefined) afterPayload.productAssetId = input.productAssetId;
  if (input.productName !== undefined) afterPayload.productName = input.productName;
  if (input.nextAction !== undefined) afterPayload.nextAction = input.nextAction;
  if (input.targetDate !== undefined) afterPayload.targetDate = input.targetDate;
  if (input.sampleType !== undefined) afterPayload.sampleType = input.sampleType;
  if (input.sampleQuantity !== undefined) afterPayload.sampleQuantity = input.sampleQuantity;
  if (input.sampleUnit !== undefined) afterPayload.sampleUnit = input.sampleUnit;
  if (input.notes !== undefined) afterPayload.notes = input.notes;
  if (input.tags !== undefined) afterPayload.tags = input.tags;

  const subOperations: SubOperation[] = [{
    toolId: 'development.create',
    entityId: input.code,
    action: 'create_development_case',
    before: {},
    after: afterPayload,
  }];

  const beforeAfterDiff = [{
    entity: 'developmentCase',
    entityId: input.code,
    field: 'stage',
    before: 'none' as any,
    after: (input.stage || 'developing') as any,
  }];

  const content = {
    subOperations,
    beforeAfterDiff,
    impactScope: ['development'],
    irreversible: false, // create 产物可经 update_stage(cancelled)/软删回退，不标不可逆
    postCommitHooks: [] as any[],
  };
  const hash = computeProcessDraftHash(content);
  const idempotencyKey = `development.create:${input.code}:${hash}`;

  return { ...content, idempotencyKey };
}

export function validateDevCreateDraftSemantics(draft: any): { ok: boolean; error?: DevCreateFlowError } {
  if (!draft.subOperations || draft.subOperations.length === 0) {
    return { ok: false, error: buildDevCreateError('SEMANTIC_VALIDATION_FAILED', 'draft must contain at least one subOperation') };
  }
  const after = draft.subOperations[0].after as any;
  if (!after?.code || !after?.name || !after?.type) {
    return { ok: false, error: buildDevCreateError('SEMANTIC_VALIDATION_FAILED', 'draft must contain code/name/type in subOperations.after') };
  }
  if (!isValidType(after.type)) {
    return { ok: false, error: buildDevCreateError('INVALID_TYPE', `invalid type: ${after.type}`) };
  }
  if (after.stage !== undefined && !isValidStage(after.stage)) {
    return { ok: false, error: buildDevCreateError('INVALID_STAGE', `invalid stage: ${after.stage}`) };
  }
  if (!after.customerRelationId && !after.customerName) {
    return { ok: false, error: buildDevCreateError('CUSTOMER_REQUIRED', 'customerRelationId or customerName is required') };
  }
  return { ok: true };
}

export function verifyDevCreateDraftHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputedHash = computeProcessDraftHash(content);
  const actualHashPart = idempotencyKey.includes(':pd:')
    ? 'pd:' + idempotencyKey.split(':pd:')[1]
    : idempotencyKey;
  return { ok: recomputedHash === actualHashPart, expected: recomputedHash, actual: actualHashPart };
}

export interface DevCreateCommitParams {
  /** Approval requester metadata never substitutes for the real executor. */
  actorId?: string;
  trustedActor?: TokenPayload;
  prisma: PrismaClient;
  approvalId: string;
  approvalPayload: any;
}

export async function commitDevCreate(
  params: DevCreateCommitParams,
): Promise<{ ok: true; feedback: DevCreateFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: DevCreateFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;

  const draft: any = approvalPayload?.processDraft;
  if (!draft) {
    return { ok: false, feedback: { status: 'failed', error: buildDevCreateError('PROCESS_DRAFT_MISSING', 'processDraft not found in approval payload'), approvalId } };
  }

  const hashCheck = verifyDevCreateDraftHash(draft);
  if (!hashCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildDevCreateError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hashCheck.expected} actual=${hashCheck.actual}`), approvalId } };
  }

  const semCheck = validateDevCreateDraftSemantics(draft);
  if (!semCheck.ok) {
    return { ok: false, feedback: { status: 'failed', error: semCheck.error!, approvalId } };
  }

  if (!params.trustedActor?.userId) {
    return { ok: false, feedback: { status: 'failed', error: buildDevCreateError('UNAUTHORIZED', '开发建案执行缺少已核验的实际员工凭据。'), approvalId } };
  }

  const after = draft.subOperations[0].after as any;

  // 复用 createDevelopmentCase shared service（内部 $transaction + syncDevelopmentCaseReferences + writeRouteAuditLog 闭环）
  const result = await createDevelopmentCase({
    prisma,
    input: {
      code: after.code,
      name: after.name,
      type: after.type,
      stage: after.stage,
      priority: after.priority,
      owner: after.owner,
      customerRelationId: after.customerRelationId,
      customerName: after.customerName,
      supplierRelationId: after.supplierRelationId,
      supplierName: after.supplierName,
      productAssetId: after.productAssetId,
      productName: after.productName,
      nextAction: after.nextAction,
      targetDate: after.targetDate,
      sampleType: after.sampleType,
      sampleQuantity: after.sampleQuantity,
      sampleUnit: after.sampleUnit,
      notes: after.notes,
      tags: after.tags,
    },
    actorId: params.trustedActor.userId,
    trustedActor: params.trustedActor,
  });

  if (!result.ok) {
    return { ok: false, feedback: { status: 'failed', error: buildDevCreateError(result.error!.code as DevCreateFlowErrorCode, result.error!.message), approvalId } };
  }

  return {
    ok: true,
    feedback: {
      status: 'committed',
      caseId: result.data!.case!.id,
      code: result.data!.case!.code,
      auditId: result.data!.auditId,
      idempotencyKey: draft.idempotencyKey,
    },
  };
}
