/**
 * Agent-Phase2-samples-flow-contract
 * samples.create_round / samples.submit_to_customer / samples.register_customer_confirmation
 * draft→approval→commit 流程契约。
 *
 * commit 复用 garmentSampleGateService（DR-008/DR-029 成衣多轮双门禁唯一入口，与路由同一真源），
 * service 工厂经 await import 惰性加载（newDomainQueryTools 先例，免疫既有测试模块级 total-mock
 * 的导入链耦合），不在 Agent path 手写 DB mutation。
 * 幂等三层：ProcessDraft hash + AgentCommitReceipt（registerCommitTool 收口）+ service 层状态机守卫
 * （SEALED_IMMUTABLE / INVALID_TRANSITION / QC_GATE_NOT_PASSED 全部 fail-closed）。
 *
 * 链式语义：createRound(in_progress) → submitQcConclusion(qc_passed) → submitToCustomer(submitted)
 *   → registerCustomerConfirmation(confirmed/rejected) → sealRound(sealed 不可变)。
 *   本 Flow 覆盖建轮 + 提交客户 + 登记客户确认三个核心写；QC 结论登记与封轮保留在路由/UI 路径。
 */

import { PrismaClient } from '@prisma/client';
import { computeProcessDraftHash, type ProcessDraft, type SubOperation } from './toolRegistry';
import { registerCommitTool } from './toolDispatchRegistry';

/** garmentSampleGateService 错误码（service 层 code 为 string，本地固化已知集合避免运行时耦合） */
type SamplesServiceErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_GARMENT_CASE'
  | 'QC_REPORT_NOT_FOUND'
  | 'SEALED_IMMUTABLE'
  | 'INVALID_TRANSITION'
  | 'QC_GATE_NOT_PASSED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED';

export type SamplesFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | SamplesServiceErrorCode;

export interface SamplesFlowError {
  code: SamplesFlowErrorCode;
  message: string;
  userAction: string;
}

export interface SamplesFlowCommitted {
  status: 'committed';
  roundId: string;
  caseId?: string;
  roundStatus?: string;
  idempotencyKey: string;
}

/** 客户确认结论枚举（与 garmentSampleGateService.GARMENT_CONFIRM_RESULTS 同一真源；本地固化） */
const GARMENT_CONFIRM_RESULTS_LOCAL = ['approved', 'rejected', 'needs_revision'] as const;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const USER_ACTIONS: Record<SamplesFlowErrorCode, string> = {
  APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
  APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
  APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
  PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
  PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
  SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查样品链输入（目的/版本/材料配置、寄送信息、确认结论等必填项）',
  INVALID_INPUT: '输入非法，请检查必填字段与枚举值',
  NOT_FOUND: '开发单或样品轮次不存在，请确认 caseId/roundId',
  NOT_GARMENT_CASE: '多轮双门禁仅适用于服装（garment）开发单，请确认开发单类型',
  QC_REPORT_NOT_FOUND: '引用的 QC 检验报告不存在，请确认 qcInspectionReportId',
  SEALED_IMMUTABLE: '封存产前样为不可变生产基准，任何改动必须开新轮重走 QC→客户确认→封存链',
  INVALID_TRANSITION: '当前轮次状态不允许该操作，请按 建轮→QC→提交客户→客户确认→封存 顺序推进',
  QC_GATE_NOT_PASSED: '内部 QC 未通过，禁止提交客户（DR-008 内部门禁），请先登记 QC 通过结论',
  CREATE_FAILED: '样品轮次创建失败已回滚，请重试',
  UPDATE_FAILED: '样品轮次更新失败已回滚，请重试',
};

export function buildSamplesFlowError(code: SamplesFlowErrorCode, message: string): SamplesFlowError {
  return { code, message, userAction: USER_ACTIONS[code] ?? '操作失败，请检查输入后重试或联系管理员' };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const expected = computeProcessDraftHash(content);
  const actual = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: expected === actual, expected, actual };
}

/** garmentSampleGateService 工厂（与路由/newDomainQueryTools 同一线路；惰性加载） */
async function makeGarmentSampleGateService(prisma: PrismaClient) {
  const { createGarmentSampleGateService } = await import('../samples/garmentSampleGateService');
  return createGarmentSampleGateService({ prisma });
}

function serviceFailFeedback(result: any, approvalId: string) {
  return { ok: false as const, feedback: { status: 'failed' as const, error: buildSamplesFlowError(result.error!.code, result.error!.message), approvalId } };
}

// ─── CREATE ROUND ──────────────────────────────────────────────────
export function buildSampleRoundCreateDraft(input: { caseId: string; input: Record<string, unknown>; actorId: string }): ProcessDraft {
  const { caseId, actorId } = input;
  const body = input.input || {};
  const subOperations: SubOperation[] = [{
    toolId: 'samples.create_round',
    entityId: caseId,
    action: 'create_garment_sample_round',
    before: {},
    after: { caseId, ...body, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'garmentSampleRound', entityId: caseId, field: 'purpose', before: null, after: (body as any).purpose ?? null },
    { entity: 'garmentSampleRound', entityId: caseId, field: 'version', before: null, after: (body as any).version ?? null },
    { entity: 'garmentSampleRound', entityId: caseId, field: 'materialConfig', before: null, after: (body as any).materialConfig ?? null },
    { entity: 'garmentSampleRound', entityId: caseId, field: 'status', before: null, after: 'in_progress' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['samples', 'development', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `samples.create_round:${caseId}:${hash}` };
}

export function validateSampleRoundCreateDraftSemantics(draft: any): { ok: boolean; error?: SamplesFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.caseId || !String(after.caseId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain caseId') };
  if (!after?.purpose || !String(after.purpose).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain purpose（本轮目的）') };
  if (!after?.version || !String(after.version).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain version（客户侧版本号）') };
  if (!after?.materialConfig || !String(after.materialConfig).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain materialConfig（材料/工艺配置）') };
  if (!Number.isFinite(Number(after.plannedQuantity)) || Number(after.plannedQuantity) <= 0 || !String(after.plannedUnit || '').trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain plannedQuantity and plannedUnit') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifySampleRoundCreateDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitSampleRoundCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: SamplesFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: SamplesFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateSampleRoundCreateDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeGarmentSampleGateService(prisma);
  const result = await svc.createRound({
    caseId: after.caseId,
    input: { purpose: after.purpose, version: after.version, materialConfig: after.materialConfig, notes: after.notes, evidence: after.evidence,
      factoryRequirements: after.factoryRequirements, targetCompletionDate: after.targetCompletionDate, referenceAttachments: after.referenceAttachments,
      plannedQuantity: Number(after.plannedQuantity), plannedUnit: String(after.plannedUnit) },
    actorId: after.actorId,
  });
  if (!result.ok) return serviceFailFeedback(result, approvalId);
  return { ok: true, feedback: { status: 'committed', roundId: result.data!.round.id, caseId: result.data!.round.developmentCaseId, roundStatus: result.data!.round.status, idempotencyKey: draft.idempotencyKey } };
}

// ─── SUBMIT TO CUSTOMER ────────────────────────────────────────────
export function buildSampleSubmitToCustomerDraft(input: { roundId: string; input: Record<string, unknown>; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { roundId, actorId, currentSnapshot = {} } = input;
  const body = input.input || {};
  const subOperations: SubOperation[] = [{
    toolId: 'samples.submit_to_customer',
    entityId: roundId,
    action: 'submit_garment_sample_to_customer',
    before: currentSnapshot,
    after: { roundId, ...body, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'garmentSampleRound', entityId: roundId, field: 'status', before: (currentSnapshot as any).status ?? 'qc_passed', after: 'submitted' },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'courier', before: null, after: (body as any).courier ?? null },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'trackingNumber', before: null, after: (body as any).trackingNumber ?? null },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'recipientName', before: null, after: (body as any).recipientName ?? null },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['samples', 'development', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `samples.submit_to_customer:${roundId}:${hash}` };
}

export function validateSampleSubmitToCustomerDraftSemantics(draft: any): { ok: boolean; error?: SamplesFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.roundId || !String(after.roundId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain roundId') };
  if (!after?.courier || !String(after.courier).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain courier（快递服务商，DR-039）') };
  if (!after?.trackingNumber || !String(after.trackingNumber).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain trackingNumber（快递单号，DR-039）') };
  if (!after?.recipientName || !String(after.recipientName).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain recipientName（收件方，DR-039）') };
  if (after?.sentDate !== undefined && after?.sentDate !== '' && !YMD_RE.test(String(after.sentDate))) {
    return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft sentDate must be YYYY-MM-DD') };
  }
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifySampleSubmitToCustomerDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitSampleSubmitToCustomer(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: SamplesFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: SamplesFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateSampleSubmitToCustomerDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeGarmentSampleGateService(prisma);
  const result = await svc.submitToCustomer({
    roundId: after.roundId,
    input: { sentDate: after.sentDate, courier: after.courier, trackingNumber: after.trackingNumber, recipientName: after.recipientName, recipientContact: after.recipientContact, documents: after.documents },
    actorId: after.actorId,
  });
  if (!result.ok) return serviceFailFeedback(result, approvalId);
  return { ok: true, feedback: { status: 'committed', roundId: result.data!.round.id, caseId: result.data!.round.developmentCaseId, roundStatus: result.data!.round.status, idempotencyKey: draft.idempotencyKey } };
}

// ─── REGISTER CUSTOMER CONFIRMATION ────────────────────────────────
export function buildSampleCustomerConfirmationDraft(input: { roundId: string; input: Record<string, unknown>; actorId: string; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { roundId, actorId, currentSnapshot = {} } = input;
  const body = input.input || {};
  const result = String((body as any).result || '');
  const afterStatus = result === 'approved' ? 'confirmed' : (GARMENT_CONFIRM_RESULTS_LOCAL as readonly string[]).includes(result) ? 'rejected' : 'confirmed';
  const subOperations: SubOperation[] = [{
    toolId: 'samples.register_customer_confirmation',
    entityId: roundId,
    action: 'register_garment_customer_confirmation',
    before: currentSnapshot,
    after: { roundId, ...body, actorId },
  }];
  const beforeAfterDiff = [
    { entity: 'garmentSampleRound', entityId: roundId, field: 'status', before: (currentSnapshot as any).status ?? 'submitted', after: afterStatus },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'customerStatus', before: (currentSnapshot as any).customerStatus ?? 'pending', after: result || null },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'confirmationDate', before: null, after: (body as any).confirmationDate ?? null },
    { entity: 'garmentSampleRound', entityId: roundId, field: 'channel', before: null, after: (body as any).channel ?? null },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['samples', 'development', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `samples.register_customer_confirmation:${roundId}:${hash}` };
}

export function validateSampleCustomerConfirmationDraftSemantics(draft: any): { ok: boolean; error?: SamplesFlowError } {
  if (!draft?.subOperations?.length) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.roundId || !String(after.roundId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain roundId') };
  if (!(GARMENT_CONFIRM_RESULTS_LOCAL as readonly string[]).includes(String(after?.result))) {
    return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', `draft must contain valid result (${GARMENT_CONFIRM_RESULTS_LOCAL.join('/')})`) };
  }
  if (!after?.confirmationDate || !YMD_RE.test(String(after.confirmationDate))) {
    return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain confirmationDate (YYYY-MM-DD)') };
  }
  if (!after?.channel || !String(after.channel).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain channel（确认渠道，DR-008）') };
  if (!after?.actorId || !String(after.actorId).trim()) return { ok: false, error: buildSamplesFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain actorId') };
  return { ok: true };
}

export function verifySampleCustomerConfirmationDraftHash(draft: ProcessDraft) { return verifyHash(draft); }

export async function commitSampleCustomerConfirmation(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any }): Promise<{ ok: true; feedback: SamplesFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: SamplesFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hash = verifyHash(draft);
  if (!hash.ok) return { ok: false, feedback: { status: 'failed', error: buildSamplesFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch: expected=${hash.expected} actual=${hash.actual}`), approvalId } };
  const sem = validateSampleCustomerConfirmationDraftSemantics(draft);
  if (!sem.ok) return { ok: false, feedback: { status: 'failed', error: sem.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const svc = await makeGarmentSampleGateService(prisma);
  const result = await svc.registerCustomerConfirmation({
    roundId: after.roundId,
    input: { result: after.result, confirmationDate: after.confirmationDate, channel: after.channel, note: after.note, modifications: after.modifications, evidence: after.evidence },
    actorId: after.actorId,
  });
  if (!result.ok) return serviceFailFeedback(result, approvalId);
  return { ok: true, feedback: { status: 'committed', roundId: result.data!.round.id, caseId: result.data!.round.developmentCaseId, roundStatus: result.data!.round.status, idempotencyKey: draft.idempotencyKey } };
}

// ─── 自注册（主控在 toolRuntime 复合 commit 注册区调用一次）─────────
export function registerSamplesFlowTools(): void {
  registerCommitTool('samples.create_round', async (ctx) => {
    const result = await commitSampleRoundCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('samples.submit_to_customer', async (ctx) => {
    const result = await commitSampleSubmitToCustomer({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
  registerCommitTool('samples.register_customer_confirmation', async (ctx) => {
    const result = await commitSampleCustomerConfirmation({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload });
    const r = result as any;
    return r.ok
      ? { ok: true, ...r.feedback }
      : { ok: false, errorFeedback: { code: r.feedback?.error?.code || 'COMMIT_FAILED', message: r.feedback?.error?.message || 'commit failed', retryable: false } };
  });
}
