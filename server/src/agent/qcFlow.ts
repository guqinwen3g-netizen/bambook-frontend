/**
 * Agent-Phase2-qc-flow-contract
 * qc.review_garment_sample / qc.review_fabric_sample / qc.sign_report
 * draft→approval→commit 流程契约。
 *
 * commit 复用 qcChainService（DR-029 双链 QC 评审=报告创建唯一入口）与 qcService.signReport
 * （质量门禁 §9.3-② 产前样双签唯一入口），均与路由同一真源；
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层守卫
 * （ROUND_ALREADY_REVIEWED 每轮报告独立不可覆盖 REL-14-A1 / 重复签署 fail-closed REL-14-A2）。
 *
 * 双链语义：
 *   - 成衣链（garment/capsule 订单）：pp/top 样品按轮次评审，reportId=INR__{orderId}__smp__{level}__r{round}；
 *   - 面料链（fabric 订单）：SS/RC/EARLY_PRODUCTION 样品按样品记录评审，非 pass 必须提工厂技术调整要求；
 *   - 双签：role=qc（QC 签）/ role=business（仅订单负责人或部门主管可签，PP_SIGN_BUSINESS_ROLE_REQUIRED）。
 *
 * 注意：qcService.signReport 为异常式接口（throw Error），commit 内做消息→错误码映射，保持
 * Agent 侧结构化错误契约一致。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';
import type { ActorContext } from './types';
import { toolActorToken } from './toolActorContext';
import { safeRouteError } from '../shared/routeError';

export type QcFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  // qcChainService 链评审错误码
  | 'INVALID_INPUT'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_CHAIN_SCOPE'
  | 'DEV_SAMPLE_EXCLUDED'
  | 'REJECT_REASON_REQUIRED'
  | 'ROUND_ALREADY_REVIEWED'
  | 'FACTORY_ADJUSTMENT_REQUIRED'
  | 'SAMPLE_NOT_FOUND'
  | 'SAMPLE_ORDER_MISMATCH'
  | 'CREATE_FAILED'
  // qcService.signReport 异常映射错误码
  | 'REPORT_ID_REQUIRED'
  | 'REPORT_NOT_FOUND'
  | 'INVALID_SIGN_ROLE'
  | 'ALREADY_SIGNED'
  | 'PP_SIGN_BUSINESS_ROLE_REQUIRED'
  | 'SIGN_FAILED';

export interface QcFlowError {
  code: QcFlowErrorCode;
  message: string;
  userAction: string;
}

export interface QcFlowCommitted {
  status: 'committed';
  reportId: string;
  orderId?: string;
  conclusion?: string;
  signRole?: string;
  idempotencyKey: string;
}

/** 链枚举（与 qcChainService/qcService 同一真源；本地固化避免运行时耦合） */
const GARMENT_QC_SAMPLE_LEVELS_LOCAL = ['pp', 'top'] as const;
const FABRIC_QC_SAMPLE_KINDS_LOCAL = ['SS', 'RC', 'EARLY_PRODUCTION'] as const;
const SAMPLE_CONCLUSIONS_LOCAL = ['pass', 'conditional', 'fail'] as const;
const REPORT_SIGN_ROLES_LOCAL = ['qc', 'business'] as const;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const USER_ACTIONS: Record<QcFlowErrorCode, string> = {
  APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
  APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
  APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
  PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
  PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
  SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查 QC 评审/签署输入（结论/意见/轮次/角色等必填项）',
  INVALID_INPUT: '输入非法，请检查必填字段与枚举值',
  ORDER_NOT_FOUND: '订单不存在或已删除，请确认 orderId',
  INVALID_CHAIN_SCOPE: '订单不属于对应 QC 链（成衣链评审仅适用 garment/capsule 订单，面料链仅适用 fabric 订单）',
  DEV_SAMPLE_EXCLUDED: '开发样不进入 QC 门禁（DR-027），由业务员自行登记寄送与客户确认',
  REJECT_REASON_REQUIRED: '直接打回工厂重做必须填写 rejectReason（QC-29-A4 可追溯）',
  ROUND_ALREADY_REVIEWED: '该轮样品已有 QC 评审报告，每轮报告独立不可覆盖（REL-14-A1），如需复验请提交新一轮',
  FACTORY_ADJUSTMENT_REQUIRED: '评审结论非 pass 时 factoryAdjustment.requirement（对工厂的技术调整要求）必填（DR-029 面料链）',
  SAMPLE_NOT_FOUND: '样品记录不存在，请确认 sampleId',
  SAMPLE_ORDER_MISMATCH: '样品不属于该订单，请确认 sampleId 与 orderId 匹配',
  CREATE_FAILED: 'QC 评审报告保存失败已回滚，请重试',
  REPORT_ID_REQUIRED: 'reportId 必填',
  REPORT_NOT_FOUND: '验货报告不存在，请确认 reportId',
  INVALID_SIGN_ROLE: '签署角色非法，仅允许 qc | business',
  ALREADY_SIGNED: '该侧已签署，签署留痕不可改写（REL-14-A2），不可重复签署',
  PP_SIGN_BUSINESS_ROLE_REQUIRED: '业务签字仅限订单负责人或部门主管（双签职责分离，fail-closed）',
  SIGN_FAILED: '签署失败已回滚，请重试',
};

export function buildQcFlowError(code: QcFlowErrorCode, message: string): QcFlowError {
  return { code, message, userAction: USER_ACTIONS[code] ?? '操作失败，请检查输入后重试或联系管理员' };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

/** service 工厂（与路由/newDomainQueryTools 同一线路；惰性加载） */
async function makeQcChainService(prisma: PrismaClient) {
  const { createQcChainService } = await import('../qc/qcChainService');
  return createQcChainService(prisma);
}
async function makeQcService(prisma: PrismaClient) {
  const { createQcService } = await import('../qc/qcService');
  return createQcService(prisma);
}

/** Native finite reasons preserve Agent codes; unknown storage text is private. */
async function mapSignError(error: unknown): Promise<{ code: QcFlowErrorCode; message: string }> {
  const { QcReportError, qcReportFailure } = await import('../qc/qcReportAuthority');
  const failure = qcReportFailure(error);
  const native: Partial<Record<import('../qc/qcReportAuthority').QcReportReason, QcFlowErrorCode>> = {
    report_id_required: 'REPORT_ID_REQUIRED', report_not_found: 'REPORT_NOT_FOUND', invalid_role: 'INVALID_SIGN_ROLE',
    already_signed: 'ALREADY_SIGNED', business_role: 'PP_SIGN_BUSINESS_ROLE_REQUIRED',
  };
  const result = safeRouteError(failure, { fallbackCode: 'SIGN_FAILED', fallbackMessage: '验货报告签核结果暂不可确认，请刷新记录后重试。' });
  return { code: failure instanceof QcReportError && failure.reason ? native[failure.reason] ?? 'SIGN_FAILED' : 'SIGN_FAILED', message: result.message };
}

function isNonNegInt(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true; // 缺省交由 service 归一化为 0
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

// ─── GARMENT REVIEW（成衣链报告创建）────────────────────────────────
export function buildQcGarmentReviewDraft(input: { orderId: string; input: Record<string, unknown>; actorId: string }): ProcessDraft {
  const { orderId, actorId } = input;
  const body = input.input || {};
  const level = String((body as any).sampleLevel ?? 'pp').trim().toLowerCase() || 'pp';
  const round = Number((body as any).round);
  const reportKey = `INR__${orderId}__smp__${level}__r${Number.isInteger(round) ? round : '?'}`;
  const subOperations: SubOperation[] = [{
    toolId: 'qc.review_garment_sample',
    entityId: reportKey,
    action: 'review_garment_sample',
    before: {},
    after: { orderId, ...body, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'inspectionReport', entityId: reportKey, field: 'orderId', before: null, after: orderId },
    { entity: 'inspectionReport', entityId: reportKey, field: 'sampleLevel', before: null, after: level },
    { entity: 'inspectionReport', entityId: reportKey, field: 'round', before: null, after: Number.isInteger(round) ? round : null },
    { entity: 'inspectionReport', entityId: reportKey, field: 'result', before: null, after: (body as any).conclusion ?? null },
    { entity: 'inspectionReport', entityId: reportKey, field: 'disposition', before: null, after: (body as any).directReject === true ? 'DIRECT_REJECT' : 'STANDARD' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['qc', 'orders', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `qc.review_garment_sample:${reportKey}:${hash}` };
}

export function validateQcGarmentReviewDraftSemantics(draft: any): { ok: boolean; error?: QcFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.orderId || !String(after.orderId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId') };
  const level = String(after?.sampleLevel ?? 'pp').trim().toLowerCase();
  if (!(GARMENT_QC_SAMPLE_LEVELS_LOCAL as readonly string[]).includes(level)) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', `draft sampleLevel must be ${GARMENT_QC_SAMPLE_LEVELS_LOCAL.join('|')}`) };
  }
  const round = Number(after?.round);
  if (!Number.isInteger(round) || round < 1) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft round must be integer >= 1') };
  if (!(SAMPLE_CONCLUSIONS_LOCAL as readonly string[]).includes(String(after?.conclusion ?? '').trim().toLowerCase())) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', `draft conclusion must be ${SAMPLE_CONCLUSIONS_LOCAL.join('|')}`) };
  }
  if (!after?.opinion || !String(after.opinion).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain opinion（QC 文本评审意见，DR-029）') };
  if (!isNonNegInt(after?.criticalDefects) || !isNonNegInt(after?.majorDefects) || !isNonNegInt(after?.minorDefects)) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft defect counts must be integers >= 0') };
  }
  if (after?.inspectionDate !== undefined && after?.inspectionDate !== '' && !YMD_RE.test(String(after.inspectionDate))) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft inspectionDate must be YYYY-MM-DD') };
  }
  if (after?.directReject === true && (!after?.rejectReason || !String(after.rejectReason).trim())) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft directReject=true requires rejectReason（QC-29-A4）') };
  }
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyQcGarmentReviewDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitQcGarmentReview(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: QcFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: QcFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateQcGarmentReviewDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeQcChainService(prisma);
  const result = await svc.reviewGarmentSample({
    orderId: after.orderId,
    input: {
      sampleLevel: after.sampleLevel, round: after.round, conclusion: after.conclusion, opinion: after.opinion,
      criticalDefects: after.criticalDefects, majorDefects: after.majorDefects, minorDefects: after.minorDefects,
      defectSummary: after.defectSummary, evidence: after.evidence, inspectionDate: after.inspectionDate,
      directReject: after.directReject, rejectReason: after.rejectReason,
    },
    actorId: after.actorId,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', reportId: result.data!.report.id, orderId: after.orderId, conclusion: result.data!.report.result, idempotencyKey: draft.idempotencyKey } };
}

// ─── FABRIC REVIEW（面料链报告创建）─────────────────────────────────
export function buildQcFabricReviewDraft(input: { orderId: string; input: Record<string, unknown>; actorId: string }): ProcessDraft {
  const { orderId, actorId } = input;
  const body = input.input || {};
  const sampleId = String((body as any).sampleId || 'unknown');
  const entityKey = `${orderId}:${sampleId}`;
  const subOperations: SubOperation[] = [{
    toolId: 'qc.review_fabric_sample',
    entityId: entityKey,
    action: 'review_fabric_sample',
    before: {},
    after: { orderId, ...body, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'inspectionReport', entityId: entityKey, field: 'orderId', before: null, after: orderId },
    { entity: 'inspectionReport', entityId: entityKey, field: 'sampleKind', before: null, after: (body as any).sampleKind ?? null },
    { entity: 'inspectionReport', entityId: entityKey, field: 'sampleId', before: null, after: (body as any).sampleId ?? null },
    { entity: 'inspectionReport', entityId: entityKey, field: 'result', before: null, after: (body as any).conclusion ?? null },
    { entity: 'inspectionReport', entityId: entityKey, field: 'disposition', before: null, after: String((body as any).conclusion ?? '') === 'pass' ? 'STANDARD' : 'REQUIRES_FACTORY_TECH_ADJUST' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['qc', 'orders', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `qc.review_fabric_sample:${entityKey}:${hash}` };
}

export function validateQcFabricReviewDraftSemantics(draft: any): { ok: boolean; error?: QcFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.orderId || !String(after.orderId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain orderId') };
  const kind = String(after?.sampleKind ?? '').trim().toUpperCase();
  if (!(FABRIC_QC_SAMPLE_KINDS_LOCAL as readonly string[]).includes(kind)) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', `draft sampleKind must be ${FABRIC_QC_SAMPLE_KINDS_LOCAL.join('|')}`) };
  }
  if (!after?.sampleId || !String(after.sampleId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain sampleId') };
  const conclusion = String(after?.conclusion ?? '').trim().toLowerCase();
  if (!(SAMPLE_CONCLUSIONS_LOCAL as readonly string[]).includes(conclusion)) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', `draft conclusion must be ${SAMPLE_CONCLUSIONS_LOCAL.join('|')}`) };
  }
  if (!after?.opinion || !String(after.opinion).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain opinion（QC 专业意见，DR-029）') };
  if (!isNonNegInt(after?.criticalDefects) || !isNonNegInt(after?.majorDefects) || !isNonNegInt(after?.minorDefects)) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft defect counts must be integers >= 0') };
  }
  if (after?.inspectionDate !== undefined && after?.inspectionDate !== '' && !YMD_RE.test(String(after.inspectionDate))) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft inspectionDate must be YYYY-MM-DD') };
  }
  if (conclusion !== 'pass' && (!after?.factoryAdjustment || !String((after.factoryAdjustment as any).requirement ?? '').trim())) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft conclusion≠pass requires factoryAdjustment.requirement（DR-029 面料链）') };
  }
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyQcFabricReviewDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitQcFabricReview(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: QcFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: QcFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateQcFabricReviewDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeQcChainService(prisma);
  const result = await svc.reviewFabricSample({
    orderId: after.orderId,
    input: {
      sampleKind: after.sampleKind, sampleId: after.sampleId, conclusion: after.conclusion, opinion: after.opinion,
      criticalDefects: after.criticalDefects, majorDefects: after.majorDefects, minorDefects: after.minorDefects,
      defectSummary: after.defectSummary, evidence: after.evidence, inspectionDate: after.inspectionDate,
      factoryAdjustment: after.factoryAdjustment,
    },
    actorId: after.actorId,
  });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError((result as any).error!.code, (result as any).error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', reportId: result.data!.report.id, orderId: after.orderId, conclusion: result.data!.report.result, idempotencyKey: draft.idempotencyKey } };
}

// ─── SIGN REPORT（双签）─────────────────────────────────────────────
export function buildQcSignReportDraft(input: { reportId: string; role: string; actorId: string; delegationReason?: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { reportId, role, actorId, currentSnapshot = {} } = input;
  const atField = role === 'business' ? 'businessSignedAt' : 'qcSignedAt';
  const subOperations: SubOperation[] = [{
    toolId: 'qc.sign_report',
    entityId: reportId,
    action: `sign_report_${role}`,
    before: currentSnapshot,
    after: { reportId, role, actorId, ...(input.delegationReason !== undefined ? { delegationReason: input.delegationReason } : {}) },
  }];
  const beforeAfterDiff = [
    { entity: 'inspectionReport', entityId: reportId, field: `signatures.${atField}`, before: (currentSnapshot as any)[atField] ?? null, after: '<signed>' },
    { entity: 'inspectionReport', entityId: reportId, field: `signatures.${role === 'business' ? 'businessSignerId' : 'qcSignerId'}`, before: null, after: actorId },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['qc', 'orders', 'audit'], irreversible: true, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `qc.sign_report:${reportId}:${role}:${hash}` };
}

export function validateQcSignReportDraftSemantics(draft: any): { ok: boolean; error?: QcFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.reportId || !String(after.reportId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain reportId') };
  if (!(REPORT_SIGN_ROLES_LOCAL as readonly string[]).includes(String(after?.role))) {
    return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', `draft role must be ${REPORT_SIGN_ROLES_LOCAL.join('|')}`) };
  }
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildQcFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifyQcSignReportDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitQcSignReport(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actor?: ActorContext }): Promise<{ ok: true; feedback: QcFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: QcFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildQcFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateQcSignReportDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeQcService(prisma);
  try {
    const { QcReportError } = await import('../qc/qcReportAuthority');
    if (!params.actor?.userId || after.actorId !== params.actor.userId) {
      throw new QcReportError('UNAUTHORIZED', '审批签署人须与当前可信执行身份一致。', 'actor_mismatch');
    }
    const report = await svc.signReport(after.reportId, after.role, after.actorId, null, toolActorToken(params.actor),
      { delegationReason: typeof after.delegationReason === 'string' ? after.delegationReason : undefined });
    return { ok: true, feedback: { status: 'committed', reportId: report.id, orderId: report.orderId, signRole: after.role, idempotencyKey: draft.idempotencyKey } };
  } catch (e: any) {
    const mapped = await mapSignError(e);
    return { ok: false, feedback: { status: 'failed', error: buildQcFlowError(mapped.code, mapped.message), approvalId } };
  }
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerQcFlowTools(): void {
  registerCommitTool('qc.review_garment_sample', async (ctx) => {
    const result = await commitQcGarmentReview({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('qc.review_fabric_sample', async (ctx) => {
    const result = await commitQcFabricReview({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('qc.sign_report', async (ctx) => {
    const result = await commitQcSignReport({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actor: ctx.actor });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
