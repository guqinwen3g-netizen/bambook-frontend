import { describe, expect, it, vi } from 'vitest';
import { assertSampleBusinessContext, lockSampleBusinessSources, resolveSampleBusinessContext, resolveSampleBusinessContexts } from '../sampleBusinessContext';

const source = { sourceCaseId: 'C1', sourceOrderId: 'O1', productAssetId: 'A1' };
function database(input: { cases?: any[]; orders?: any[]; assets?: any[] } = {}) {
  const model = (rows: any[]) => ({ findMany: vi.fn(async ({ where }: any) => rows.filter(row => where.id.in.includes(row.id))) });
  return {
    $queryRaw: vi.fn(async (_query: any) => []),
    developmentCase: model(input.cases ?? [{ id: 'C1', type: 'fabric', deletedAt: null }]),
    order: model(input.orders ?? [{ id: 'O1', businessLine: 'fabric', type: 'Fabric', deletedAt: null }]),
    productAsset: model(input.assets ?? [{ id: 'A1', mainCategory: 'Fabric', deletedAt: null, fabricProfile: { id: 'FP1', deletedAt: null }, garmentProfile: null }]),
  };
}

describe('样品业务来源只由有效真实记录确定', () => {
  it('面料案/订单/档案一致，subType不能改变来源', async () => {
    expect(await resolveSampleBusinessContext(database(), { ...source, subType: 'fit-sample' } as any))
      .toEqual({ status: 'resolved', businessLine: 'fabric', reasons: [] });
  });
  it('成衣案/订单/档案一致，大小写正常归一', async () => {
    const db = database({ cases: [{ id: 'C1', type: 'garment' }], orders: [{ id: 'O1', businessLine: 'garment', type: 'Garment' }], assets: [{ id: 'A1', mainCategory: 'Garment', garmentProfile: { id: 'GP1' } }] });
    expect(await resolveSampleBusinessContext(db, source)).toEqual({ status: 'resolved', businessLine: 'garment', reasons: [] });
  });
  it('无来源保留待核对，不从type或subType猜分类', async () => {
    const db = database();
    expect(await resolveSampleBusinessContext(db, { type: 'ship', subType: 'yardage' } as any))
      .toEqual({ status: 'unresolved', businessLine: null, reasons: ['NO_AUTHORITATIVE_SOURCE'] });
    expect(db.developmentCase.findMany).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.productAsset.findMany).not.toHaveBeenCalled();
  });
  it.each(['pp', 'trim', 'other'])('开发案类型 %s 不猜为成衣', async type => {
    expect(await resolveSampleBusinessContext(database({ cases: [{ id: 'C1', type }] }), { sourceCaseId: 'C1' }))
      .toEqual({ status: 'unresolved', businessLine: null, reasons: ['CASE_LINE_UNSUPPORTED'] });
  });
  it.each([
    ['case', { cases: [] }, 'CASE_MISSING_OR_DELETED'],
    ['deleted case', { cases: [{ id: 'C1', type: 'fabric', deletedAt: 1n }] }, 'CASE_MISSING_OR_DELETED'],
    ['order', { orders: [] }, 'ORDER_MISSING_OR_DELETED'],
    ['deleted order', { orders: [{ id: 'O1', type: 'Fabric', deletedAt: 1n }] }, 'ORDER_MISSING_OR_DELETED'],
    ['asset', { assets: [] }, 'ASSET_MISSING_OR_DELETED'],
    ['deleted asset', { assets: [{ id: 'A1', mainCategory: 'Fabric', deletedAt: 1n }] }, 'ASSET_MISSING_OR_DELETED'],
  ])('%s 缺失或软删，其他来源即使已知也不能掩盖', async (_label, patch, reason) => {
    expect(await resolveSampleBusinessContext(database(patch as any), source))
      .toEqual({ status: 'unresolved', businessLine: null, reasons: [reason] });
  });
  it('订单自身 businessLine/type矛盾和跨源矛盾明确冲突', async () => {
    const context = await resolveSampleBusinessContext(database({ orders: [{ id: 'O1', businessLine: 'garment', type: 'Fabric' }] }), source);
    expect(context).toEqual({ status: 'conflict', businessLine: null, reasons: ['ORDER_LINE_CONFLICT', 'SOURCE_LINE_CONFLICT'] });
    expect(() => assertSampleBusinessContext(context, true)).toThrow(/冲突/);
  });
  it('开发案和订单各自合法但业务线不同仍冲突', async () => {
    expect(await resolveSampleBusinessContext(database({ orders: [{ id: 'O1', businessLine: 'garment', type: 'Garment' }] }), source))
      .toMatchObject({ status: 'conflict', businessLine: null, reasons: ['SOURCE_LINE_CONFLICT'] });
  });
  it('未知订单分类不能被其他已知来源覆盖', async () => {
    expect(await resolveSampleBusinessContext(database({ orders: [{ id: 'O1', businessLine: 'capsule', type: 'Other' }] }), source))
      .toMatchObject({ status: 'unresolved', businessLine: null, reasons: ['ORDER_LINE_UNSUPPORTED', 'ORDER_TYPE_UNSUPPORTED'] });
  });
  it('订单没有businessLine但真实旧type为Garment可以解析', async () => {
    expect(await resolveSampleBusinessContext(database({ orders: [{ id: 'O1', type: 'Garment' }] }), { sourceOrderId: 'O1' }))
      .toEqual({ status: 'resolved', businessLine: 'garment', reasons: [] });
  });
  it('未知订单不能使用样品名猜线', async () => {
    expect(await resolveSampleBusinessContext(database({ orders: [{ id: 'O1' }] }), { sourceOrderId: 'O1' }))
      .toEqual({ status: 'unresolved', businessLine: null, reasons: ['ORDER_LINE_UNKNOWN'] });
  });
  it('档案分类和active profile冲突拒绝；删除的profile不作为证据', async () => {
    const conflict = await resolveSampleBusinessContext(database({ assets: [{ id: 'A1', mainCategory: 'Fabric', garmentProfile: { id: 'GP1', deletedAt: null } }] }), { productAssetId: 'A1' });
    expect(conflict.status).toBe('conflict');
    expect(conflict.reasons).toContain('ASSET_PROFILE_CONFLICT');
    const old = await resolveSampleBusinessContext(database({ assets: [{ id: 'A1', mainCategory: 'Fabric', garmentProfile: { id: 'GP1', deletedAt: 1n } }] }), { productAssetId: 'A1' });
    expect(old).toEqual({ status: 'resolved', businessLine: 'fabric', reasons: [] });
  });
  it('同档案两个active profile不能默认为其中一类', async () => {
    const context = await resolveSampleBusinessContext(database({ assets: [{ id: 'A1', mainCategory: 'Garment', fabricProfile: { id: 'FP1' }, garmentProfile: { id: 'GP1' } }] }), { productAssetId: 'A1' });
    expect(context.status).toBe('conflict');
    expect(context.reasons).toContain('ASSET_PROFILE_CONFLICT');
  });
  it('whole page去重批查，结果保留输入顺序', async () => {
    const db = database();
    const contexts = await resolveSampleBusinessContexts(db, [source, {}, source, { sourceOrderId: 'MISSING' }]);
    expect(contexts.map(context => context.status)).toEqual(['resolved', 'unresolved', 'resolved', 'unresolved']);
    expect(db.developmentCase.findMany).toHaveBeenCalledOnce();
    expect(db.order.findMany).toHaveBeenCalledOnce();
    expect(db.productAsset.findMany).toHaveBeenCalledOnce();
    expect(db.order.findMany.mock.calls[0][0].where.id.in).toEqual(['MISSING', 'O1']);
  });
  it('sources统一Case→Order→Asset顺序，ID参数化排序并去重', async () => {
    const db = database();
    await lockSampleBusinessSources(db, [source, { sourceCaseId: 'C0', sourceOrderId: 'O1', productAssetId: 'A0' }]);
    const queries = db.$queryRaw.mock.calls.map(call => call[0] as any);
    expect(queries.map(query => query.values[0])).toEqual(['C0', 'C1', 'O1', 'A0', 'A1']);
    expect(queries.map(query => query.strings.join('?'))).toEqual([
      expect.stringContaining('"DevelopmentCase"'), expect.stringContaining('"DevelopmentCase"'),
      expect.stringContaining('"Order"'), expect.stringContaining('"ProductAsset"'), expect.stringContaining('"ProductAsset"'),
    ]);
  });
  it('来源读取失败向上抛出，不能降级为resolved/空列表', async () => {
    const db = database(); db.order.findMany.mockRejectedValueOnce(new Error('offline'));
    await expect(resolveSampleBusinessContext(db, source)).rejects.toThrow('offline');
  });
});
