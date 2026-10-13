import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { createProductsRouter } from '../route';

const scope = vi.hoisted(() => ({ resolve: vi.fn(), visible: vi.fn() }));
// Keep the production permission checks and order where builder. Only their
// backing identity/customer services are substituted; no DB or env setup.
vi.mock('../../auth/permissionService', async importOriginal => ({
  ...await importOriginal<typeof import('../../auth/permissionService')>(),
  createPermissionService: () => ({ getDataScopeResolver: scope.resolve }),
}));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ resolveVisibleRelationIds: scope.visible }) }));
const secret = 'change-me-in-production-at-least-32-chars';
const token = (permissions = ['products:read', 'orders:read'], extra = {}) => jwt.sign({ userId: 'sales-a', roles: [], permissions, authorizationLoaded: true, ...extra }, secret);
beforeEach(() => {
  scope.resolve.mockReset().mockResolvedValue({ rule: { kind: 'self' }, allowedUserIds: ['sales-a'] });
  scope.visible.mockReset().mockResolvedValue(['customer-a']);
});
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') return Array.isArray(value.in) ? value.in.includes(row[key]) : matches(row[key], value);
    return row?.[key] === value;
  });
}
function project(row: any, select: any): any {
  return Object.fromEntries(Object.entries(select).map(([key, value]: any) => [key, value === true ? row[key] : project(row[key], value.select)]));
}
/** Validate storage substitutes against the actual generated client model
 * metadata before evaluating them; fake fields must never mask invalid SQL. */
function validateFields(modelName: string, value: Record<string, any>, kind: 'where' | 'select' | 'fixture') {
  const model = Prisma.dmmf.datamodel.models.find(model => model.name === modelName);
  if (!model) throw new Error(`Missing generated Prisma model ${modelName}`);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (kind === 'where' && ['AND', 'OR', 'NOT'].includes(key)) {
      for (const child of Array.isArray(fieldValue) ? fieldValue : [fieldValue]) validateFields(modelName, child, kind);
      continue;
    }
    const field = model.fields.find(field => field.name === key);
    if (!field) throw new Error(`Unknown generated Prisma field ${modelName}.${key}`);
    if (field.kind === 'object' && fieldValue && typeof fieldValue === 'object') {
      validateFields(field.type, kind === 'select' ? fieldValue.select : fieldValue, kind);
    }
  }
}
function fixture(sku = 'SKU-1') {
  const makeLine = (id: string, customerRelationId: string | null, ownerId = 'sales-b') => ({ id, orderId: `order-${id}`, lineNumber: 1, itemNo: '001', description: 'Wool', cloth: 'woven', quantity: '12.5000', unit: 'M', materialCode: 'SKU-1', millQuality: 'MQ-1',
    unitPrice: '199', netValue: '2487.5', fabricCommissionRate: '0.05', order: { id: `order-${id}`, poNumber: `PO-${id}`, customer: customerRelationId ?? 'Legacy', customerRelationId, ownerId, orderPurpose: 'customer_order', dueDate: '2026-10-30', status: 'Confirmed', deletedAt: null, contractAmount: '2487.5' } });
  const lines = [makeLine('allowed', 'customer-a'), makeLine('foreign', 'customer-b'), makeLine('legacy-own', null, 'sales-a'), makeLine('legacy-foreign', null)];
  for (const line of lines) validateFields('OrderLine', line, 'fixture');
  const prisma: any = { productAsset: { findFirst: vi.fn(async () => ({ id: 'asset', sku, name: 'Wool', mainCategory: 'Fabric', deletedAt: null, fabricProfile: { millQuality: 'MQ-1' }, fabricPrices: [] })) },
    orderLine: { findMany: vi.fn(async ({ where, select }: any) => {
      validateFields('OrderLine', where, 'where');
      if (select) validateFields('OrderLine', select, 'select');
      return lines.filter(row => matches(row, where)).map(row => select ? project(row, select) : row);
    }) } };
  const app = express(); app.use(express.json()); app.use('/api/v1/products', createProductsRouter({ prisma, requireAuth: true, apiKeys: new Set(), uploadDir: '/tmp' }));
  return { app, prisma };
}
const get = (f: ReturnType<typeof fixture>, bearer = token()) => request(f.app).get('/api/v1/products/assets/asset').set('Authorization', `Bearer ${bearer}`);
it('products read alone returns product without querying any order', async () => {
  const f = fixture(), res = await get(f, token(['products:read']));
  expect(res.status).toBe(200); expect(res.body.asset.id).toBe('asset'); expect(res.body.relatedOrderLines).toEqual([]); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled();
});
it('orders read with no visible customers cannot expose customer orders', async () => {
  scope.visible.mockResolvedValue([]); const f = fixture(), res = await get(f);
  expect(res.status).toBe(200); expect(res.body.relatedOrderLines.map((row: any) => row.id)).toEqual(['legacy-own']);
});
it('SKU links respect current customer scope and expose only display fields', async () => {
  const f = fixture(), res = await get(f);
  expect(res.body.relatedOrderLines.map((row: any) => row.id)).toEqual(['allowed', 'legacy-own']);
  expect(Object.keys(res.body.relatedOrderLines[0]).sort()).toEqual(['id', 'orderId', 'lineNumber', 'itemNo', 'description', 'cloth', 'quantity', 'unit', 'order'].sort());
  expect(Object.keys(res.body.relatedOrderLines[0].order).sort()).toEqual(['id', 'poNumber', 'customer', 'dueDate', 'status'].sort());
  expect(scope.visible).toHaveBeenCalledWith(expect.objectContaining({ userId: 'sales-a' }), { fresh: true });
});
it('quality fallback applies the same customer and legacy ownership scope', async () => {
  const f = fixture('SKU-NO-MATCH'), res = await get(f);
  expect(res.body.relatedOrderLines.map((row: any) => row.id)).toEqual(['allowed', 'legacy-own']);
  expect(f.prisma.orderLine.findMany).toHaveBeenCalledTimes(2);
  expect(f.prisma.orderLine.findMany.mock.calls[1][0].where.millQuality).toBe('MQ-1');
});
it('legacy owner token follows the existing all-scope authority', async () => {
  scope.resolve.mockResolvedValue({ rule: { kind: 'all' } }); const f = fixture(), res = await get(f, jwt.sign({ userId: 'owner', roles: ['owner'] }, secret));
  expect(res.status).toBe(200); expect(res.body.relatedOrderLines).toHaveLength(4); expect(scope.visible).not.toHaveBeenCalled();
});
it('a signed permission ceiling blocks order reads despite scope claims', async () => {
  const f = fixture(), res = await get(f, token(['products:read', 'orders:read'], { permissionCeiling: ['products:read'] }));
  expect(res.body.relatedOrderLines).toEqual([]); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled();
});
it.each(['resolve', 'visible'] as const)('scope service %s failure returns an HTTP error and makes no order query', async service => {
  scope[service].mockRejectedValue(new Error('scope unavailable')); const f = fixture(), res = await get(f);
  expect(res.status).toBeGreaterThanOrEqual(400); expect(res.body.relatedOrderLines).toBeUndefined(); expect(f.prisma.orderLine.findMany).not.toHaveBeenCalled();
});
it('generated Prisma metadata rejects nonexistent OrderLine fields in where, select and fixtures', () => {
  expect(() => validateFields('OrderLine', { deletedAt: null }, 'where')).toThrow('OrderLine.deletedAt');
  expect(() => validateFields('OrderLine', { deletedAt: true }, 'select')).toThrow('OrderLine.deletedAt');
  expect(() => validateFields('OrderLine', { deletedAt: null }, 'fixture')).toThrow('OrderLine.deletedAt');
  expect(() => validateFields('OrderLine', { order: { deletedAt: null } }, 'where')).not.toThrow();
});
it('missing generated orderLine delegate reports an HTTP error instead of fake zero associations', async () => {
  const f = fixture(); delete f.prisma.orderLine;
  const res = await get(f);
  expect(res.status).toBeGreaterThanOrEqual(400); expect(res.body.relatedOrderLines).toBeUndefined();
});
