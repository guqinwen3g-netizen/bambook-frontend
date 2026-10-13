import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildProductAssetCreateDraft,
  commitProductAssetCreate,
  buildProductAssetUpdateDraft,
  commitProductAssetUpdate,
  buildProductAssetDeleteDraft,
  commitProductAssetDelete,
  buildProductAssetFlowError,
  type ProductAssetFlowErrorCode,
} from '../productAssetMutationFlow';

vi.mock('../../products/productAssetMutationService', () => ({
  createProductAsset: vi.fn(),
  updateProductAsset: vi.fn(),
  deleteProductAsset: vi.fn(),
}));
import { createProductAsset, updateProductAsset, deleteProductAsset } from '../../products/productAssetMutationService';

describe('task product-asset-mutation-flow: buildProductAssetCreateDraft', () => {
  it('生成含 sku 的 ProcessDraft', () => {
    const draft = buildProductAssetCreateDraft({ body: { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric' } });
    expect(draft.subOperations[0].toolId).toBe('product_asset.create');
    expect((draft.subOperations[0].after as any).sku).toBe('FAB-1');
    expect(draft.impactScope).toEqual(['products', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect((draft.subOperations[0].after as any).cost).toBeNull();
  });

  it.each([0, '25.1234'])('explicit Agent cost %j remains separate from target values', cost => {
    const body = { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric', cost, targetCost: '999' };
    const draft = buildProductAssetCreateDraft({ body });
    expect((draft.subOperations[0].after as any).cost).toBe(cost);
    expect(body.cost).toBe(cost);
  });

  it('target-only Agent draft cannot create actual cost or mutate caller input', () => {
    const body = { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric', targetCost: '25' };
    const draft = buildProductAssetCreateDraft({ body });
    expect((draft.subOperations[0].after as any).cost).toBeNull();
    expect(body).not.toHaveProperty('cost');
  });
});

describe('task product-asset-mutation-flow: create hash + commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitProductAssetCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('成功 commit → committed', async () => {
    const draft = buildProductAssetCreateDraft({ body: { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric' } });
    (createProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const r = await commitProductAssetCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(createProductAsset).toHaveBeenCalledTimes(1);
  });

  it('service 失败（INVALID_AMOUNT）→ failed', async () => {
    const draft = buildProductAssetCreateDraft({ body: { sku: 'FAB-1', name: 'Twill', mainCategory: 'Fabric' } });
    (createProductAsset as any).mockResolvedValue({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'bad cost' } });
    const r = await commitProductAssetCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_AMOUNT');
  });
});

describe('task product-asset-mutation-flow: update draft + hash + commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('生成含 assetId+patch 的 ProcessDraft', () => {
    const draft = buildProductAssetUpdateDraft({ assetId: 'PROD-1', patch: { name: 'Updated' }, currentSnapshot: { name: 'Old' } });
    expect(draft.subOperations[0].toolId).toBe('product_asset.update');
    expect((draft.subOperations[0].after as any).assetId).toBe('PROD-1');
    expect((draft.subOperations[0].before as any).name).toBe('Old');
  });

  it('tampered ProcessDraft → PROCESS_DRAFT_HASH_MISMATCH + mutation service not called', async () => {
    const draft = buildProductAssetUpdateDraft({ assetId: 'PROD-1', patch: { name: 'Updated' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { assetId: 'PROD-1', patch: { name: 'HACKED' } } }] };
    const r = await commitProductAssetUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(updateProductAsset).not.toHaveBeenCalled();
  });

  it('成功 commit', async () => {
    const draft = buildProductAssetUpdateDraft({ assetId: 'PROD-1', patch: { name: 'Updated' } });
    (updateProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const r = await commitProductAssetUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(updateProductAsset).toHaveBeenCalledTimes(1);
  });

  it('service 失败（NOT_FOUND）→ failed', async () => {
    const draft = buildProductAssetUpdateDraft({ assetId: 'PROD-1', patch: { name: 'Updated' } });
    (updateProductAsset as any).mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
    const r = await commitProductAssetUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_FOUND');
  });
});

describe('task product-asset-mutation-flow: delete draft + commit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('生成含 assetId 的 ProcessDraft（deletedAt null→true）', () => {
    const draft = buildProductAssetDeleteDraft({ assetId: 'PROD-1' });
    expect(draft.subOperations[0].toolId).toBe('product_asset.delete');
    expect(draft.beforeAfterDiff[0].field).toBe('deletedAt');
    expect(draft.beforeAfterDiff[0].before).toBeNull();
    expect(draft.beforeAfterDiff[0].after).toBe(true);
    expect(draft.irreversible).toBe(true);
  });

  it('成功 commit', async () => {
    const draft = buildProductAssetDeleteDraft({ assetId: 'PROD-1' });
    (deleteProductAsset as any).mockResolvedValue({ ok: true, data: { asset: { id: 'PROD-1' }, auditId: 'a1' } });
    const r = await commitProductAssetDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(deleteProductAsset).toHaveBeenCalledTimes(1);
  });

  it('service 失败（NOT_FOUND）→ failed', async () => {
    const draft = buildProductAssetDeleteDraft({ assetId: 'PROD-1' });
    (deleteProductAsset as any).mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: 'already deleted' } });
    const r = await commitProductAssetDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_FOUND');
  });
});

describe('task product-asset-mutation-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: ProductAssetFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'INVALID_INPUT', 'INVALID_AMOUNT', 'NOT_FOUND', 'ALREADY_DELETED', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'];
    for (const code of codes) expect(buildProductAssetFlowError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
