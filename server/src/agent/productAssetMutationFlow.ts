/**
 * Agent-P1: product_asset.create / update / delete draft→approval→commit 流程契约。
 * 复用 productAssetMutationService，不在 Agent path 手写 DB mutation。
 */

import { PrismaClient } from '@prisma/client';
import { auditActorFrom } from '../audit/routeAudit';
import {
  createProductAsset,
  updateProductAsset,
  deleteProductAsset,
  type ProductAssetMutationErrorCode,
} from '../products/productAssetMutationService';
import {
  computeProcessDraftHash,
  type ProcessDraft,
  type SubOperation,
} from './toolRegistry';

export type ProductAssetFlowErrorCode =
  | 'APPROVAL_ID_MISSING'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_MODIFIED_UNSUPPORTED'
  | 'PROCESS_DRAFT_MISSING'
  | 'PROCESS_DRAFT_HASH_MISMATCH'
  | 'SEMANTIC_VALIDATION_FAILED'
  | ProductAssetMutationErrorCode;

export interface ProductAssetFlowError {
  code: ProductAssetFlowErrorCode;
  message: string;
  userAction: string;
}

export interface ProductAssetFlowCommitted {
  status: 'committed';
  assetId: string;
  auditId: string;
  idempotencyKey: string;
}

export type ProductAssetFlowFeedback =
  | { status: 'approval_required'; approvalId: string; processDraft: ProcessDraft; message: string }
  | ProductAssetFlowCommitted
  | { status: 'failed'; error: ProductAssetFlowError; approvalId?: string };

export function buildProductAssetFlowError(code: ProductAssetFlowErrorCode, message: string): ProductAssetFlowError {
  const userActionMap: Record<ProductAssetFlowErrorCode, string> = {
    APPROVAL_ID_MISSING: '审批恢复执行必须携带 approvalId，请重新发起审批流程',
    APPROVAL_NOT_FOUND: '审批记录不存在或未通过，请重新审批',
    APPROVAL_MODIFIED_UNSUPPORTED: '审批内容被修改，不支持直接 commit，请重新生成 draft 并重新审批',
    PROCESS_DRAFT_MISSING: '请重新发起流程，确保 draft payload 完整',
    PROCESS_DRAFT_HASH_MISMATCH: '审批内容与 draft 不一致，请重新发起',
    SEMANTIC_VALIDATION_FAILED: 'draft 语义校验失败，请检查输入',
    INVALID_INPUT: '输入校验失败，请检查必填字段',
    INVALID_AMOUNT: '金额格式非法，请检查 cost 字段',
    NOT_FOUND: '目标 ProductAsset 不存在或已删除',
    ALREADY_DELETED: '目标 ProductAsset 已删除',
    CREATE_FAILED: '创建事务失败已回滚，请重试',
    UPDATE_FAILED: '更新事务失败已回滚，请重试',
    DELETE_FAILED: '删除事务失败已回滚，请重试',
  };
  return { code, message, userAction: userActionMap[code] };
}

function verifyHash(draft: ProcessDraft): { ok: boolean; expected: string; actual: string } {
  const { idempotencyKey, ...content } = draft;
  const recomputed = computeProcessDraftHash(content);
  const actualPart = idempotencyKey.includes(':pd:') ? 'pd:' + idempotencyKey.split(':pd:')[1] : idempotencyKey.split(':').slice(-1)[0];
  return { ok: recomputed === actualPart, expected: recomputed, actual: actualPart };
}

// ─── CREATE ────────────────────────────────────────────────────────
export function buildProductAssetCreateDraft(input: { body: any }): ProcessDraft {
  const body = { ...(input.body || {}), cost: input.body?.cost ?? null };
  const sku = String(body.sku || '');
  const subOperations: SubOperation[] = [{
    toolId: 'product_asset.create',
    entityId: sku || 'new',
    action: 'create_product_asset',
    before: {},
    after: { sku, name: body.name, mainCategory: body.mainCategory, cost: body.cost, status: body.status },
  }];
  const beforeAfterDiff = [
    { entity: 'productAsset', entityId: sku || 'new', field: 'id', before: null, after: sku || 'auto-generated' },
  ];
  const content = { subOperations, beforeAfterDiff, impactScope: ['products', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `product_asset.create:${sku || 'new'}:${hash}` };
}

function validateCreateDraft(draft: any): { ok: boolean; error?: ProductAssetFlowError } {
  if (!draft.subOperations?.length) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'no subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.sku) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain sku') };
  return { ok: true };
}

export async function commitProductAssetCreate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;}): Promise<{ ok: true; feedback: ProductAssetFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: ProductAssetFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hc = verifyHash(draft);
  if (!hc.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch`), approvalId } };
  const sc = validateCreateDraft(draft);
  if (!sc.ok) return { ok: false, feedback: { status: 'failed', error: sc.error!, approvalId } };
  const result = await createProductAsset({ prisma, body: draft.subOperations[0].after, actorId: auditActorFrom(params) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError(result.error!.code, result.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', assetId: result.data!.asset.id, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

// ─── UPDATE ────────────────────────────────────────────────────────
export function buildProductAssetUpdateDraft(input: { assetId: string; patch: Record<string, unknown>; currentSnapshot?: Record<string, unknown> }): ProcessDraft {
  const { assetId, patch, currentSnapshot = {} } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'product_asset.update',
    entityId: assetId,
    action: 'update_product_asset',
    before: currentSnapshot,
    after: { assetId, patch },
  }];
  const patchKeys = Object.keys(patch);
  const beforeAfterDiff = patchKeys.map((k) => ({ entity: 'productAsset', entityId: assetId, field: k, before: (currentSnapshot as any)[k] ?? null, after: (patch as any)[k] }));
  const content = { subOperations, beforeAfterDiff, impactScope: ['products', 'audit'], irreversible: false, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `product_asset.update:${assetId}:${hash}` };
}

function validateUpdateDraft(draft: any): { ok: boolean; error?: ProductAssetFlowError } {
  if (!draft.subOperations?.length) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'no subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.assetId) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain assetId') };
  if (!after?.patch || typeof after.patch !== 'object') return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain patch object') };
  return { ok: true };
}

export async function commitProductAssetUpdate(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;}): Promise<{ ok: true; feedback: ProductAssetFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: ProductAssetFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hc = verifyHash(draft);
  if (!hc.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch`), approvalId } };
  const sc = validateUpdateDraft(draft);
  if (!sc.ok) return { ok: false, feedback: { status: 'failed', error: sc.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const result = await updateProductAsset({ prisma, assetId: after.assetId, patch: after.patch, actorId: auditActorFrom(params) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError(result.error!.code, result.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', assetId: after.assetId, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}

// ─── DELETE ────────────────────────────────────────────────────────
export function buildProductAssetDeleteDraft(input: { assetId: string }): ProcessDraft {
  const { assetId } = input;
  const subOperations: SubOperation[] = [{
    toolId: 'product_asset.delete',
    entityId: assetId,
    action: 'delete_product_asset',
    before: {},
    after: { assetId },
  }];
  const beforeAfterDiff = [{ entity: 'productAsset', entityId: assetId, field: 'deletedAt', before: null, after: true as any }];
  const content = { subOperations, beforeAfterDiff, impactScope: ['products', 'audit'], irreversible: true, postCommitHooks: [] as any[] };
  const hash = computeProcessDraftHash(content);
  return { ...content, idempotencyKey: `product_asset.delete:${assetId}:${hash}` };
}

function validateDeleteDraft(draft: any): { ok: boolean; error?: ProductAssetFlowError } {
  if (!draft.subOperations?.length) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'no subOperations') };
  const after = draft.subOperations[0].after as any;
  if (!after?.assetId) return { ok: false, error: buildProductAssetFlowError('SEMANTIC_VALIDATION_FAILED', 'draft must contain assetId') };
  return { ok: true };
}

export async function commitProductAssetDelete(params: { prisma: PrismaClient; approvalId: string; approvalPayload: any; actorId?: string;}): Promise<{ ok: true; feedback: ProductAssetFlowCommitted } | { ok: false; feedback: { status: 'failed'; error: ProductAssetFlowError; approvalId?: string } }> {
  const { prisma, approvalId, approvalPayload } = params;
  const draft: any = approvalPayload?.processDraft;
  if (!draft) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_MISSING', 'processDraft not found'), approvalId } };
  const hc = verifyHash(draft);
  if (!hc.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError('PROCESS_DRAFT_HASH_MISMATCH', `hash mismatch`), approvalId } };
  const sc = validateDeleteDraft(draft);
  if (!sc.ok) return { ok: false, feedback: { status: 'failed', error: sc.error!, approvalId } };
  const after = draft.subOperations[0].after as any;
  const result = await deleteProductAsset({ prisma, assetId: after.assetId, actorId: auditActorFrom(params) });
  if (!result.ok) return { ok: false, feedback: { status: 'failed', error: buildProductAssetFlowError(result.error!.code, result.error!.message), approvalId } };
  return { ok: true, feedback: { status: 'committed', assetId: after.assetId, auditId: result.data!.auditId, idempotencyKey: draft.idempotencyKey } };
}
