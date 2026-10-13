import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { createFinanceRouter } from '../route';
import { authHeader } from '../../__tests__/authTestHelper';

/**
 * S3 走查 ε 车道：财务 v1 写族从 legacy HIGH_RISK_ROLES（owner/admin/manager/finance）
 * 收编为资源 scope 门的反向断言。
 *   - SM（manager → role-sales-manager）：无任何财务写 scope → 全写族 403
 *   - ADMIN（admin → role-admin）：按文档 §6.6 业务只读 → 同样 403（预期收紧）
 *   - FINANCE（finance → role-finance）：持全部财务写 scope → 过门禁（非 401/403）
 *   - owner（超管特判）：过门禁
 * 审批链端点不在本路由文件，不受影响。
 */

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';

function tokenWithRoles(roles: string[]): string {
  return jwt.sign({ userId: `u_${roles.join('_')}`, roles }, JWT_SECRET);
}
function as(roles: string[]): Record<string, string> {
  return { Authorization: `Bearer ${tokenWithRoles(roles)}` };
}

function makeApp() {
  // 门禁通过后会进入 service 撞 prisma——提供最小 mock 即可（本套件只断言门禁行为，不断言业务结果）
  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn({})),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
  return app;
}

/** [method, path] — 财务 v1 全部写端点（HIGH_RISK legacy 组 21 个全量收编） */
const WRITE_ENDPOINTS: Array<['post' | 'patch' | 'delete', string]> = [
  ['post', '/api/v1/finance'],
  ['patch', '/api/v1/finance/INV__1'],
  ['post', '/api/v1/finance/INV__1/cancel'],
  ['delete', '/api/v1/finance/INV__1'],
  ['post', '/api/v1/finance/vouchers'],
  ['patch', '/api/v1/finance/vouchers/PAY__1'],
  ['post', '/api/v1/finance/vouchers/PAY__1/cancel'],
  ['delete', '/api/v1/finance/vouchers/PAY__1'],
  ['post', '/api/v1/finance/allocations'],
  ['post', '/api/v1/finance/receipt-claims/claim'],
  ['patch', '/api/v1/finance/allocations/ALLOC__1'],
  ['delete', '/api/v1/finance/allocations/ALLOC__1'],
  ['post', '/api/v1/finance/fx-settlements'],
  ['delete', '/api/v1/finance/fx-settlements/FXS__1'],
  ['post', '/api/v1/finance/outward-remittances'],
  ['delete', '/api/v1/finance/outward-remittances/ORM__1'],
  ['post', '/api/v1/finance/vat-invoices'],
  ['patch', '/api/v1/finance/vat-invoices/VAT__1'],
  ['post', '/api/v1/finance/vat-invoices/VAT__1/transition'],
  ['delete', '/api/v1/finance/vat-invoices/VAT__1'],
  ['post', '/api/v1/finance/dunning'],
  ['post', '/api/v1/finance/dunning/stages/manual'],
];

describe('Deny · SM（manager）无财务写 scope → 写族全量 403', () => {
  it.each(WRITE_ENDPOINTS)('%s %s → 403 FORBIDDEN', async (method, path) => {
    const res = await request(makeApp())[method](path).set(as(['manager'])).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toContain('INSUFFICIENT_SCOPE');
  });
});

describe('Deny · ADMIN 按 §6.6 业务只读 → 财务写族 403（预期收紧，原 legacy 组放行已收编）', () => {
  it.each([
    ['post', '/api/v1/finance'],
    ['post', '/api/v1/finance/vouchers'],
    ['delete', '/api/v1/finance/vouchers/PAY__1'],
    ['post', '/api/v1/finance/vat-invoices'],
    ['post', '/api/v1/finance/fx-settlements'],
  ] as Array<['post' | 'delete', string]>)('%s %s → 403 FORBIDDEN', async (method, path) => {
    const res = await request(makeApp())[method](path).set(as(['admin'])).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });
});

describe('Allow · FINANCE 持财务写 scope → 过门禁（非 401/403）', () => {
  it('POST /vouchers 空体 → 400 VALIDATION_ERROR（证明已过 scope 门进入 DTO 校验层）', async () => {
    const res = await request(makeApp()).post('/api/v1/finance/vouchers').set(as(['finance'])).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['post', '/api/v1/finance'],
    ['post', '/api/v1/finance/vat-invoices'],
    ['post', '/api/v1/finance/fx-settlements'],
    ['post', '/api/v1/finance/outward-remittances'],
    ['post', '/api/v1/finance/allocations'],
  ] as Array<['post', string]>)('%s %s → 非 401/403', async (method, path) => {
    const res = await request(makeApp())[method](path).set(as(['finance'])).send({});
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('Allow · owner 特判全通（非 401/403）', () => {
  it('POST /vouchers → 非 401/403（空体 400 = 过门后 DTO 拒绝）', async () => {
    const res = await request(makeApp()).post('/api/v1/finance/vouchers').set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

it('sales cannot confirm receipt allocations', async () => {
  const response = await request(makeApp()).post('/api/v1/finance/receipt-claims/claim').set(as(['sales'])).send({ voucherId: 'V1', invoiceId: 'I1', amount: 100 });
  expect(response.status).toBe(403);
});
