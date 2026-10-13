import { currentDevelopmentActor, developmentAssignee } from './developmentPersonnelService';
import type { TokenPayload } from '../auth/service';
import { todayLocalKey } from '../shared/localDate';
import { assertDevelopmentOperationalWrite } from './developmentOperationalGuard';
import { normalizeFabricSpecification, normalizeGarmentSpecification } from '../_shared/developmentSpecification';
/**
 * task ERP-P1-development-mutation-route-foundation:
 * DevelopmentCase mutation service — route + Agent 共用契约。
 * 每个 mutation 内部 $transaction，业务写入 + syncDevelopmentCaseReferences /
 * deactivateEntityLinks + writeRouteAuditLog 在同一事务闭环，fail closed。
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { syncDevelopmentCaseReferences, deactivateEntityLinks } from '../entities/sync';
import { assertFabricDevelopmentReady } from './readiness';

export type DevelopmentCaseMutationErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'INVALID_TRANSITION'
  | 'REVIEW_REQUIRED'
  | 'DEVELOPMENT_NOT_READY'
  | 'DEVELOPMENT_PAUSED'
  | 'DEVELOPMENT_CLOSED'
  | 'LIFECYCLE_HISTORY_EXISTS'
  | 'INVALID_LIFECYCLE_STATE'
  | 'INVALID_STAGE'
  | 'INVALID_TYPE'
  | 'DUPLICATE_CODE'
  | 'NOT_FOUND'
  | 'ALREADY_DELETED'
  | 'CONVERTED_TO_ORDER'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'STAGE_UPDATE_FAILED'
  | 'DELETE_FAILED';

export interface DevelopmentCaseMutationError {
  code: DevelopmentCaseMutationErrorCode;
  message: string;
}

export interface DevelopmentCaseMutationResult {
  ok: boolean;
  data?: { case?: any; auditId: string };
  error?: DevelopmentCaseMutationError;
}

// 常量：合法 stage / type 集合（route + service 共用）
export const VALID_STAGES = ['developing', 'shipping', 'feedback', 'revision', 'approved', 'cancelled'] as const;

// DevCase 合法 stage 转换矩阵
const DEV_STAGE_TRANSITIONS: Record<string, Set<string>> = {
  developing: new Set(['shipping', 'cancelled']),
  shipping: new Set(['feedback', 'cancelled']),
  feedback: new Set(['revision', 'approved', 'cancelled']),
  revision: new Set(['shipping', 'cancelled']),
  approved: new Set(), // 终态
  cancelled: new Set(), // 终态
};

// 5A 样衣审批门禁：shipping 阶段需要 reviewStatus = passed
const STAGES_REQUIRING_REVIEW: Set<string> = new Set(['shipping']);
export const VALID_TYPES = ['fabric', 'garment', 'pp', 'trim'] as const;
export function isValidStage(s: string): s is typeof VALID_STAGES[number] {
  return (VALID_STAGES as readonly string[]).includes(s);
}
export function isValidType(t: string): t is typeof VALID_TYPES[number] {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export interface DevelopmentCaseCreateInput {
  fabricSpecification?: unknown;
  garmentSpecification?: unknown;
  code: string;
  name: string;
  type: string;
  stage?: string;
  priority?: string;
  owner?: string;
  ownerId?: string;
  customerRelationId?: string;
  customerName?: string;
  supplierRelationId?: string;
  supplierName?: string;
  productAssetId?: string;
  productName?: string;
  currentRound?: number;
  nextAction?: string;
  targetDate?: string;
  sampleType?: string;
  sampleCategory?: string;
  sampleQuantity?: number;
  sampleUnit?: string;
  notes?: string;
  tags?: string[];
  styleSpec?: string;
  sizeSpec?: string;
  fabricSpec?: string;
  processSpec?: string;
  // 面料链（DR-050，type=fabric 专用）
  source?: string;
  // ── ★ 立项三层分类 + 开发方向（2026-10-05 Kevin 拍板）──────────────────────
  // ① 开发什么 = type（fabric/garment/pp/trim）
  // ② 谁发起  = initiator（internal 我方内部 / customer 客户要求）
  // ③ 客户给了什么 = customerInput（physical-sample 有样复刻 / spec-direction仅给方向 / none 无）
  // ⚠️ source 是历史遗留混合列（大类与发起方混在一列），新代码请读写 initiator / customerInput。
  initiator?: string;
  customerInput?: string;
  /** 客户给的实物样/色卡/参考物在关系智库里的指向 */
  referenceRelationId?: string;
  /** 开发方向（一句话总纲）。业务原话：开发本质 = 方向 + 参数 + 需求 */
  developmentDirection?: string;
  dyeMethod?: string;
  departmentId?: string;
  departmentName?: string;
  specComposition?: string;
  specWeight?: string;
  specWidth?: string;
  specWeave?: string;
  specFinish?: string;
  targetPrice?: number | string;
  moqEstimate?: number;
  techReviewStatus?: string;
  techReviewNote?: string;
  techReviewAt?: string;
  techReviewBy?: string;
}

export type DevelopmentCaseUpdateInput = Partial<DevelopmentCaseCreateInput> & {
  stage?: string;
  sampleSentDate?: string;
  sampleTrackingNumber?: string;
  sampleCourier?: string;
  sampleShippingFee?: number;
  sampleRecipientName?: string;
  sampleRecipientCompany?: string;
  sampleRecipientAddress?: string;
  sampleRecipientPhone?: string;
  sampleFeedback?: string;
  sampleFeedbackDate?: string;
  sampleInvoiceId?: string;
  linkedOrderId?: string;
  linkedOrderPo?: string;
  convertedAt?: number;
  completedDate?: string;
  attachments?: any;
};

function throwCoded(code: DevelopmentCaseMutationErrorCode, message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { code, statusCode });
}

/** Legacy text stays intact; explicit new facts are validated without inferring measurements. */
async function specificationData(db: any, input: DevelopmentCaseUpdateInput, type: string) {
  const result: Record<string, Prisma.InputJsonValue> = {};
  try {
    if (input.fabricSpecification !== undefined) {
      if (type !== 'fabric') throw new Error('面料规格只能用于面料开发。');
      const spec = normalizeFabricSpecification(input.fabricSpecification);
      if (spec.categoryId) {
        const category = await db.productSubCategory.findFirst({ where: { id: spec.categoryId, mainCategory: 'Fabric', deletedAt: null } });
        if (!category) throw new Error('所选面料分类不存在或已删除。');
      }
      result.fabricSpecification = JSON.parse(JSON.stringify(spec));
    }
    if (input.garmentSpecification !== undefined) {
      if (type !== 'garment') throw new Error('成衣标识只能用于成衣开发。');
      result.garmentSpecification = JSON.parse(JSON.stringify(normalizeGarmentSpecification(input.garmentSpecification)));
    }
  } catch (error: any) { throwCoded('INVALID_INPUT', error.message); }
  return result;
}

/** Legacy case-level sample facts remain readable; they are neither batch plans
 * nor inventory. Validate explicit edits without inventing a unit or conversion. */
function invalidLegacySampleFact(input: DevelopmentCaseUpdateInput): string | null {
  if (input.sampleQuantity !== undefined && input.sampleQuantity !== null
    && (typeof input.sampleQuantity !== 'number' || !Number.isFinite(input.sampleQuantity) || input.sampleQuantity < 0)) {
    return '历史样品登记量须为有限非负数值或 null，不可换算为订货量。';
  }
  if (input.sampleUnit !== undefined && input.sampleUnit !== null && typeof input.sampleUnit !== 'string') {
    return '历史样品单位须为原记录字符串或 null，不能根据开发类型推算。';
  }
  return null;
}

// ─── CREATE ────────────────────────────────────────────────────────
export async function createDevelopmentCase(params: {
  prisma: PrismaClient;
  input: DevelopmentCaseCreateInput;
  actorId?: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<DevelopmentCaseMutationResult> {
  const { prisma, input, actorId, ip } = params;
  if (!input?.code || !input?.name || !input?.type) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'code, name, and type are required' } };
  }
  if (!isValidType(input.type)) {
    return { ok: false, error: { code: 'INVALID_TYPE', message: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` } };
  }
  if (input.stage && !isValidStage(input.stage)) {
    return { ok: false, error: { code: 'INVALID_STAGE', message: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` } };
  }
  const invalidFact = invalidLegacySampleFact(input);
  if (invalidFact) return { ok: false, error: { code: 'INVALID_INPUT', message: invalidFact } };
  if (input.type === 'garment' && input.garmentSpecification === undefined)
    return { ok: false, error: { code: 'INVALID_INPUT', message: '请填写客户真实款式名称/标识。' } };
  const now = BigInt(Date.now());
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const creator = await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      if (!creator.isOwner && !creator.permissions.businessAttributes.includes(`${input.type === 'fabric' ? 'fabric' : 'garment'}_business`)) throwCoded('FORBIDDEN', '所属部门不具备本次开发业务属性。', 403);
      const assignee = input.ownerId ? await developmentAssignee(tx, actorId || '', input.ownerId, input.type === 'fabric' ? 'fabric' : 'garment', params.trustedActor) : null;
      const specifications = await specificationData(tx, input, input.type);
      const created = await tx.developmentCase.create({
        data: {
          ...specifications,
          id: `DEV-${input.code}-${Date.now()}`,
          code: input.code,
          name: input.name,
          type: input.type,
          stage: input.stage || 'developing',
          priority: input.priority || 'normal',
          owner: assignee?.displayName || input.owner || null,
          ownerId: assignee?.id || null,
          customerRelationId: input.customerRelationId || null,
          customerName: input.customerName || null,
          supplierRelationId: input.supplierRelationId || null,
          supplierName: input.supplierName || null,
          productAssetId: input.productAssetId || null,
          productName: input.productName || null,
          currentRound: input.currentRound || 1,
          nextAction: input.nextAction || null,
          targetDate: input.targetDate || null,
          sampleType: input.sampleType || null,
          sampleCategory: input.sampleCategory || null,
          sampleQuantity: input.sampleQuantity ?? null,
          // Explicit null overrides the schema's legacy meter default.
          sampleUnit: input.sampleUnit ?? null,
          sampleShippingFee: (input as DevelopmentCaseUpdateInput).sampleShippingFee ?? null,
          sampleRecipientName: (input as DevelopmentCaseUpdateInput).sampleRecipientName || null,
          sampleRecipientCompany: (input as DevelopmentCaseUpdateInput).sampleRecipientCompany || null,
          sampleRecipientAddress: (input as DevelopmentCaseUpdateInput).sampleRecipientAddress || null,
          sampleRecipientPhone: (input as DevelopmentCaseUpdateInput).sampleRecipientPhone || null,
          sampleInvoiceId: (input as DevelopmentCaseUpdateInput).sampleInvoiceId || null,
          notes: input.notes || null,
          tags: input.tags || [],
          styleSpec: input.styleSpec || null,
          sizeSpec: input.sizeSpec || null,
          fabricSpec: input.fabricSpec || null,
          processSpec: input.processSpec || null,
          // 面料链（DR-050）
          source: input.source || null,
          // ── ★ 立项三层分类 + 开发方向（2026-10-05 Kevin 拍板）──────────────
          // source 是历史遗留混合列；initiator/customerInput 才是新读写口径。
          initiator: input.initiator || null,
          customerInput: input.customerInput || null,
          referenceRelationId: input.referenceRelationId || null,
          developmentDirection: input.developmentDirection || null,
          dyeMethod: input.dyeMethod || null,
          departmentId: input.departmentId || null,
          departmentName: input.departmentName || null,
          specComposition: input.specComposition || null,
          specWeight: input.specWeight || null,
          specWidth: input.specWidth || null,
          specWeave: input.specWeave || null,
          specFinish: input.specFinish || null,
          targetPrice: input.targetPrice != null ? new Prisma.Decimal(String(input.targetPrice)) : null,
          moqEstimate: input.moqEstimate ?? null,
          techReviewStatus: input.techReviewStatus || null,
          techReviewNote: input.techReviewNote || null,
          techReviewAt: input.techReviewAt || null,
          techReviewBy: input.techReviewBy || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      await syncDevelopmentCaseReferences(prisma, created as any, { source: 'route:dev-case:create' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'api',
        source: 'route:dev-case:create',
        operation: 'create_development_case',
        targetType: 'DevelopmentCase',
        targetId: created.id,
        after: { id: created.id, code: created.code, name: created.name, type: created.type, stage: created.stage,
          sampleQuantity: created.sampleQuantity ?? null, sampleUnit: created.sampleUnit ?? null },
        ip: ip || null,
      });
      await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      return { case: created, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return { ok: false, error: { code: 'DUPLICATE_CODE', message: 'Development code already exists' } };
    }
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'CREATE_FAILED', message: `Create transaction failed: ${String(e?.message ?? e)}` } };
  }
}

// ─── UPDATE ────────────────────────────────────────────────────────
export async function updateDevelopmentCase(params: {
  prisma: PrismaClient;
  caseId: string;
  input: DevelopmentCaseUpdateInput;
  actorId?: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<DevelopmentCaseMutationResult> {
  const { prisma, caseId, input, actorId, ip } = params;
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'update payload is required' } };
  }
  if (input.stage && !isValidStage(input.stage)) {
    return { ok: false, error: { code: 'INVALID_STAGE', message: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` } };
  }
  if (input.type && !isValidType(input.type)) {
    return { ok: false, error: { code: 'INVALID_TYPE', message: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` } };
  }
  const invalidFact = invalidLegacySampleFact(input);
  if (invalidFact) return { ok: false, error: { code: 'INVALID_INPUT', message: invalidFact } };
  const now = BigInt(Date.now());
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      let existing = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!existing) {
        throwCoded('NOT_FOUND', `Development case ${caseId} not found`, 404);
      }
      await assertDevelopmentOperationalWrite(tx, caseId, 'update');
      existing = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!existing) throwCoded('NOT_FOUND', '开发案不存在', 404);
      const domainActor = await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      const requestedFamily = ('type' in input && input.type) || existing.type;
      if (!domainActor.isOwner && [existing.type, requestedFamily].some(family => !domainActor.permissions.businessAttributes.includes(`${family === 'fabric' ? 'fabric' : 'garment'}_business`))) throwCoded('FORBIDDEN', '所属部门不具备本次开发业务属性。', 403);
      // B1: 编辑接口不允许直接改 stage —— 阶段流转必须走 PATCH /:id/stage
      // （updateDevelopmentStage：转换矩阵 + 5A 评审门禁 + revision 轮次自动 +1），
      // 防止编辑表单下拉从「开发中」直改「已确认」绕过全部校验。
      if (input.stage !== undefined && input.stage !== existing.stage) {
        throwCoded('INVALID_TRANSITION', `编辑接口不可直接修改阶段（${existing.stage} -> ${input.stage}），请使用阶段推进接口`, 409);
      }
      const { fabricSpecification: _fabric, garmentSpecification: _garment, ...legacyInput } = input;
      const updateData: Prisma.DevelopmentCaseUncheckedUpdateInput = {
        ...legacyInput,
        ...await specificationData(tx, input, requestedFamily),
        updatedAt: now,
      };
      if (input.ownerId) {
        const assignee = await developmentAssignee(tx, actorId || '', input.ownerId, existing.type === 'fabric' ? 'fabric' : 'garment', params.trustedActor);
        updateData.owner = assignee.displayName;
      } else if (input.owner !== undefined && input.owner !== existing.owner) {
        throwCoded('INVALID_INPUT', '负责人必须从真实员工账号中选择', 400);
      }
      if (input.stage === 'approved' && !existing.completedDate) {
        (updateData as any).completedDate = todayLocalKey();
      }
      const updated = await tx.developmentCase.update({
        where: { id: caseId },
        data: updateData,
      });
      await syncDevelopmentCaseReferences(prisma, updated as any, { source: 'route:dev-case:update' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'api',
        source: 'route:dev-case:update',
        operation: 'update_development_case',
        targetType: 'DevelopmentCase',
        targetId: caseId,
        before: { id: caseId, name: existing.name, stage: existing.stage,
          ...(input.sampleQuantity !== undefined || input.sampleUnit !== undefined
            ? { sampleQuantity: existing.sampleQuantity ?? null, sampleUnit: existing.sampleUnit ?? null } : {}) },
        after: { id: caseId, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.sampleQuantity !== undefined || input.sampleUnit !== undefined
            ? { sampleQuantity: updated.sampleQuantity ?? null, sampleUnit: updated.sampleUnit ?? null } : {}) },
        ip: ip || null,
      });
      await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      return { case: updated, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'UPDATE_FAILED', message: `Update transaction failed: ${String(e?.message ?? e)}` } };
  }
}

// ─── UPDATE STAGE ──────────────────────────────────────────────────
export async function updateDevelopmentStage(params: {
  prisma: PrismaClient;
  caseId: string;
  stage: string;
  nextAction?: string;
  actorId?: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<DevelopmentCaseMutationResult> {
  const { prisma, caseId, stage, nextAction, actorId, ip } = params;
  if (!stage || !isValidStage(stage)) {
    return { ok: false, error: { code: 'INVALID_STAGE', message: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` } };
  }
  const now = BigInt(Date.now());
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!existing) {
        throwCoded('NOT_FOUND', `Development case ${caseId} not found`, 404);
      }
      await assertDevelopmentOperationalWrite(tx, caseId, 'stage');
      existing = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!existing) throwCoded('NOT_FOUND', '开发案不存在', 404);
      const domainActor = await currentDevelopmentActor(tx, actorId || '', true, params.trustedActor);
      if (!domainActor.isOwner && !domainActor.permissions.businessAttributes.includes(`${existing.type === 'fabric' ? 'fabric' : 'garment'}_business`)) throwCoded('FORBIDDEN', '所属部门不具备本次开发业务属性。', 403);
      // stage 转换合法性校验
      if (existing.stage !== stage) {
        const allowed = DEV_STAGE_TRANSITIONS[existing.stage];
        // DR-050 面料链 case 阶段简化：面料开发案并行批次/封样承载打样与寄样进度，
        // 单线 shipping/feedback/revision 不适配——面料案允许 developing → approved（确认开发完成）
        const fabricApprove = existing.type === 'fabric' && existing.stage === 'developing' && stage === 'approved';
        if ((!allowed || !allowed.has(stage)) && !fabricApprove) {
          throwCoded('INVALID_TRANSITION', `Invalid stage transition: ${existing.stage} -> ${stage}`, 400);
        }
        // 5A 样衣审批门禁：进入 shipping 前必须评审通过
        if (STAGES_REQUIRING_REVIEW.has(stage) && existing.sampleCategory === '5a' && existing.reviewStatus !== 'passed') {
          throwCoded('REVIEW_REQUIRED', `5A 样衣进入寄出阶段前需生产部评审通过（当前评审状态: ${existing.reviewStatus || '未评审'}）`, 400);
        }
      }
      const updateData: Prisma.DevelopmentCaseUncheckedUpdateInput = { stage, updatedAt: now };
      if (stage === 'approved' && existing.stage !== 'approved') {
        await assertFabricDevelopmentReady(tx, existing);
      }
      if (nextAction !== undefined) updateData.nextAction = nextAction;
      if (stage === 'revision') {
        updateData.currentRound = (existing.currentRound || 1) + 1;
      }
      if (stage === 'approved' && !existing.completedDate) {
        (updateData as any).completedDate = todayLocalKey();
      }
      const updated = await tx.developmentCase.update({
        where: { id: caseId },
        data: updateData,
      });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'api',
        source: 'route:dev-case:stage',
        operation: 'update_development_case_stage',
        targetType: 'DevelopmentCase',
        targetId: caseId,
        before: { id: caseId, stage: existing.stage, currentRound: existing.currentRound },
        after: { id: caseId, stage, currentRound: (updateData as any).currentRound ?? existing.currentRound },
        ip: ip || null,
      });
      return { case: updated, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'STAGE_UPDATE_FAILED', message: `Stage transaction failed: ${String(e?.message ?? e)}` } };
  }
}

// ─── DELETE (soft) ─────────────────────────────────────────────────
export async function deleteDevelopmentCase(params: {
  prisma: PrismaClient;
  caseId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<DevelopmentCaseMutationResult> {
  const { prisma, caseId, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await tx.developmentCase.findFirst({ where: { id: caseId } });
      if (!existing) {
        throwCoded('NOT_FOUND', `Development case ${caseId} not found`, 404);
      }
      if (existing.deletedAt) {
        throwCoded('ALREADY_DELETED', `Development case ${caseId} is already deleted`, 409);
      }
      // A4: 已转订单的开发单不可删除。linkedOrderId 非空即已转订单锚点，
      // 覆盖两种形态：convert 流程转单（stage=approved + linkedOrderId）与
      // 存量 stage='已确认' && linkedOrderId 数据（二者均以 linkedOrderId 为锚）。
      // B1: 专用错误码 CONVERTED_TO_ORDER（不再复用 ALREADY_DELETED 表达 409 语义）。
      if (existing.linkedOrderId) {
        throwCoded('CONVERTED_TO_ORDER', '已转订单的开发单不可删除', 409);
      }
      await assertDevelopmentOperationalWrite(tx, caseId, 'delete');
      existing = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!existing) throwCoded('NOT_FOUND', '开发案不存在', 404);
      if (existing.linkedOrderId) throwCoded('CONVERTED_TO_ORDER', '已转订单的开发单不可删除', 409);
      await tx.developmentCase.update({
        where: { id: caseId },
        data: { deletedAt: now, updatedAt: now },
      });
      await deactivateEntityLinks(tx, 'development-case', caseId, now);
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'api',
        source: 'route:dev-case:delete',
        operation: 'delete_development_case',
        targetType: 'DevelopmentCase',
        targetId: caseId,
        before: { id: caseId, deletedAt: null },
        after: { id: caseId, deletedAt: Number(now) },
        ip: ip || null,
      });
      return { case: { id: caseId }, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e?.code && typeof e.code === 'string' && !e.code.startsWith('P')) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'DELETE_FAILED', message: `Delete transaction failed: ${String(e?.message ?? e)}` } };
  }
}
