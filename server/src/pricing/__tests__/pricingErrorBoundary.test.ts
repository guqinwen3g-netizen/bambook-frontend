import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { businessError } from '../../shared/errorCodes';
import { createPricingRouter } from '../pricingRoute';
import { createProfitSheetService } from '../profitSheetService';
import { createCostRingsService } from '../costRingsService';
import { PricingDomainError } from '../pricingError';

// Error-boundary contract only: real router, JWT and domain services; in-memory
// storage seams do not prove current DB authorization, financial writes or PG rollback.
const actor: TokenPayload = { userId: 'pricing-error-operator', roles: [], roleIds: ['pricing-error-custom'],
  permissions: ['pricing:read', 'pricing:write', 'sensitive:cost', 'sensitive:profit', 'sensitive:commission'],
  departmentIds: [], authorizationLoaded: true };

function storage() {
  const delegate = () => ({
    findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
    create: vi.fn(async ({ data }: any) => data), update: vi.fn(async ({ data }: any) => data),
  });
  return { taxRefundRate: delegate(), exchangeRate: delegate(), pricingCalculation: delegate(),
    materialPriceHistory: delegate(), commissionRule: delegate(), relation: delegate(),
    order: delegate(), orderProfitSheet: delegate() };
}

function appFor(db: unknown, onDataChange = vi.fn()) {
  const app = express();
  app.use(express.json());
  app.use('/pricing', createPricingRouter({ prisma: db as PrismaClient, requireAuth: true,
    apiKeys: new Set(), onDataChange }));
  return { app, token: createAuthService().signToken(actor), onDataChange };
}

describe('pricing explicit business errors and safe unknown exceptions', () => {
  it.each([
    { path: '/tax-refund-rates', input: { hsCode: '511', rate: 13 }, code: 'TRR_CREATE_FAILED', message: '非法 HS Code（须为 2/4/6/8/10 位数字）' },
    { path: '/tax-refund-rates', input: { hsCode: '5112', rate: 17 }, code: 'TRR_CREATE_FAILED', message: '退税率必须在 0-16% 之间' },
    { path: '/track-b-preview', input: { purchaseCostCny: 0, refundRate: 13, exchangeRate: 7, profitMargin: 25 }, code: 'TRACK_B_PREVIEW_FAILED', message: '采购价必须大于 0' },
    { path: '/track-a-preview', input: { category: 'cotton' }, code: 'TRACK_A_PREVIEW_FAILED', message: '非法品类：cotton（允许 garment | fabric）' },
    { path: '/material-prices', input: { materialType: 'cotton' }, code: 'MP_CREATE_FAILED', message: '非法物料类型：cotton（允许 yarn | fabric | trimming）' },
    { path: '/commission-rules', input: { name: 'X', rate: 0 }, code: 'CR_CREATE_FAILED', message: '佣金率必须大于 0 且不超过 100%' },
  ])('keeps the original 400, operation code and public copy for $path / $message', async ({ path, input, code, message }) => {
    const db = storage(), { app, token, onDataChange } = appFor(db);
    const res = await request(app).post(`/pricing${path}`).set('Authorization', `Bearer ${token}`).send(input);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code, message } });
    expect(onDataChange).not.toHaveBeenCalled();
    expect(db.taxRefundRate.create).not.toHaveBeenCalled();
    expect(db.pricingCalculation.create).not.toHaveBeenCalled();
    expect(db.materialPriceHistory.create).not.toHaveBeenCalled();
    expect(db.commissionRule.create).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/tax-refund-rates/missing', code: 'TRR_UPDATE_FAILED', message: '退税率记录不存在' },
    { path: '/calculations/missing', code: 'CALC_UPDATE_FAILED', message: '定价计算不存在' },
    { path: '/material-prices/missing', code: 'MP_UPDATE_FAILED', message: '价格记录不存在' },
    { path: '/commission-rules/missing', code: 'CR_UPDATE_FAILED', message: '佣金规则不存在' },
  ])('keeps explicitly missing records 404 with the original $code', async ({ path, code, message }) => {
    const { app, token, onDataChange } = appFor(storage());
    const res = await request(app).patch(`/pricing${path}`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code, message } });
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('keeps missing intermediary 404 and active-rule duplicate 400 as different domain facts', async () => {
    const db = storage(), { app, token } = appFor(db);
    const missing = await request(app).post('/pricing/commission-rules').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Agent', rate: 5, intermediaryRelationId: 'missing' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'CR_CREATE_FAILED', message: '中间人不存在' } });
    db.commissionRule.findFirst.mockResolvedValue({ id: 'active-default' } as never);
    const duplicate = await request(app).post('/pricing/commission-rules').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Default', rate: 5 });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toEqual({ error: { code: 'CR_CREATE_FAILED', message: '已存在启用中的默认佣金规则' } });
    expect(db.commissionRule.create).not.toHaveBeenCalled();
  });

  it('keeps lookup/FX absence and archived calculations 400 without changing their public text', async () => {
    const db = storage(), { app, token } = appFor(db);
    const noMap = await request(app).post('/pricing/calculations').set('Authorization', `Bearer ${token}`)
      .send({ purchaseCostCny: 80, profitMargin: 25, hsCode: '9999' });
    expect(noMap.status).toBe(400);
    expect(noMap.body).toEqual({ error: { code: 'CALC_CREATE_FAILED', message: 'HS Code 9999 无退税率映射，请人工指定退税率' } });
    const noFx = await request(app).post('/pricing/calculations').set('Authorization', `Bearer ${token}`)
      .send({ purchaseCostCny: 80, profitMargin: 25, refundRate: 13 });
    expect(noFx.status).toBe(400);
    expect(noFx.body).toEqual({ error: { code: 'CALC_CREATE_FAILED', message: '汇率缺失且无最新 USD 汇率记录' } });
    db.pricingCalculation.findUnique.mockResolvedValue({ id: 'archived', deletedAt: null, status: 'Archived' } as never);
    const archived = await request(app).patch('/pricing/calculations/archived').set('Authorization', `Bearer ${token}`).send({ profitMargin: 30 });
    expect(archived.status).toBe(400);
    expect(archived.body).toEqual({ error: { code: 'CALC_UPDATE_FAILED', message: '已归档计算不可修改' } });
    expect(db.pricingCalculation.create).not.toHaveBeenCalled();
    expect(db.pricingCalculation.update).not.toHaveBeenCalled();
  });

  it.each(['必填', '不存在', '已归档', '非法', '已存在', '必须'])('never classifies unknown SQL text containing %s as a business refusal', async keyword => {
    const db = storage();
    db.taxRefundRate.findMany.mockRejectedValue(Object.assign(new Error(`SQL secret_table.secret_column ${keyword} /private/storage`), { code: 'P2010' }));
    const { app, token } = appFor(db);
    const res = await request(app).get('/pricing/tax-refund-rates').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'TRR_LIST_FAILED', message: '读取退税率表失败，请稍后重试。' } });
    expect(JSON.stringify(res.body)).not.toMatch(/SQL|secret_table|secret_column|private|P2010/);
  });

  it.each([
    { path: '/material-prices', delegate: 'materialPriceHistory', code: 'MP_LIST_FAILED', message: '读取原材料价格失败，请稍后重试。' },
    { path: '/commission-rules', delegate: 'commissionRule', code: 'CR_LIST_FAILED', message: '读取佣金规则失败，请稍后重试。' },
  ] as const)('protects the actual $delegate read boundary', async ({ path, delegate, code, message }) => {
    const db = storage();
    db[delegate].findMany.mockRejectedValue(new Error('secret SQL 不存在'));
    const { app, token } = appFor(db);
    const res = await request(app).get(`/pricing${path}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code, message } });
  });

  it('protects a genuinely absent storage delegate instead of emitting its TypeError', async () => {
    const { app, token } = appFor({});
    const res = await request(app).get('/pricing/tax-refund-rates').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'TRR_LIST_FAILED', message: '读取退税率表失败，请稍后重试。' } });
  });

  it.each([
    { code: 'FORBIDDEN', status: 403 }, { code: 'SOURCE_CHANGED', status: 409 },
    { code: 'AUTHORIZATION_UNAVAILABLE', status: 503 },
  ])('retains other domains typed $code status, public message and details', async ({ code, status }) => {
    const db = storage(), details = { sourceId: 'original-source', currentRevision: 2 };
    db.taxRefundRate.findMany.mockRejectedValue(Object.assign(businessError(code, '明确的业务拒绝'), { details }));
    const { app, token } = appFor(db);
    const res = await request(app).get('/pricing/tax-refund-rates').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { code, message: '明确的业务拒绝', details } });
  });

  it('uses safe action-specific text for an unknown write failure without pretending it is bad input or confirmed rollback', async () => {
    const db = storage(), { app, token, onDataChange } = appFor(db);
    db.pricingCalculation.create.mockRejectedValue(new Error('INSERT secret_price 已归档 /private/price'));
    const res = await request(app).post('/pricing/calculations').set('Authorization', `Bearer ${token}`)
      .send({ purchaseCostCny: 80, profitMargin: 25, refundRate: 13, exchangeRate: 7.2 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'CALC_CREATE_FAILED', message: '定价记录新增结果暂不可确认，请先刷新列表核对。' } });
    expect(db.pricingCalculation.create).toHaveBeenCalledTimes(1);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('keeps the existing multiplier service code and HTTP compatibility code with explicit 400', async () => {
    const db = storage(), service = createProfitSheetService(db as unknown as PrismaClient);
    await expect(service.reestimateFreightImpact({ multiplier: 0 })).rejects.toMatchObject({ code: 'INVALID_MULTIPLIER', statusCode: 400 });
    const { app, token } = appFor(db);
    const res = await request(app).get('/pricing/freight-impact?multiplier=0').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'FREIGHT_IMPACT_FAILED', message: 'multiplier 必须为 (0, 100] 区间数值（如 3 = 运费涨 3 倍）' } });
  });

  it('classifies cost/profit missing-source facts explicitly without treating query failures as missing records', async () => {
    const db = storage();
    await expect(createCostRingsService(db as unknown as PrismaClient).getOrderCostRings('missing'))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404, message: '订单 missing 不存在' });
    const profit = createProfitSheetService(db as unknown as PrismaClient);
    await expect(profit.generateOrderProfitSheet('missing', actor.userId)).rejects.toBeInstanceOf(PricingDomainError);
    await expect(profit.deleteProfitSheet('missing', actor.userId)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404, message: '利润表不存在' });
    db.order.findFirst.mockRejectedValue(new Error('secret query 不存在'));
    await expect(createCostRingsService(db as unknown as PrismaClient).getOrderCostRings('missing')).rejects.toThrow('secret query 不存在');
    db.order.findUnique.mockRejectedValue(new Error('secret profit query 必填'));
    await expect(profit.generateOrderProfitSheet('missing', actor.userId)).rejects.toThrow('secret profit query 必填');
  });
});
