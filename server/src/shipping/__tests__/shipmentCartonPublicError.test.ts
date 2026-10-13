/** Actual shipping router and carton transaction, with recorded storage delegates.
 * Storage seam derived from shipmentPublicErrorBoundary.test.ts; not native PG proof.
 * No authorization, error provider, transaction callback or route is mocked. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createShippingRouter } from '../route';
import { replaceShipmentCartons } from '../shipmentPackingService';
import { storageReader, storageRowLocks, storageWhere } from './shippingSourceStorageFixture';
const privateFault = 'PRIVATE_SQL shipment.secret_column /private/db';
const header = (actor: TokenPayload) => ({ Authorization: `Bearer ${createAuthService().signToken(actor)}` });
function appFor(prisma: any) {
  const app = express(), onDataChange = vi.fn();
  app.set('json replacer', function(this: any, key: string, value: any) {
    const original = this[key];
    return typeof original === 'bigint' || original instanceof Prisma.Decimal ? Number(original) : value;
  });
  app.use(express.json());
  app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: true, apiKeys: new Set(), onDataChange }));
  return { app, onDataChange };
}
function clone(value: any): any {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
const shippingScopes = ['shipments:read', 'shipments:write', 'orders:read'];
const shippingActor: TokenPayload = { userId: 'packing-user', roles: ['logistics'], roleIds: ['role-logistics'], permissions: shippingScopes,
  authorizationLoaded: true, departmentIds: [] };
type Fault = 'missing-after-lock' | 'missing-totals' | 'unknown-totals' | 'unknown-source' | 'late-withdrawal' | 'late-department-withdrawal' | 'unknown-audit';
/** Native-row filters and recorded supported SQL only. The TX stages writes and
 * commits only after the real callback returns; faults do not patch consumers. */
function shippingStorage(fault?: Fault) {
  const tables: Record<string, any[]> = {
    userAccount: [{ id: shippingActor.userId, status: 'active', deletedAt: null, primaryDeptId: 'logistics-dept',
      primaryDepartment: { id: 'logistics-dept', parentId: 'company', status: 'active', metadata: { businessAttributes: ['logistics'] } },
      roles: [{ roleId: 'role-logistics', role: { id: 'role-logistics', isSystem: true,
        permissions: shippingScopes.map(scope => ({ permission: { scope } })) } }] }],
    userPermissionOverrides: [], teamMember: [], teamDataGrant: [], relation: [], department: [],
    shipment: [{ id: 'S', shipmentNumber: 'SH-ORIGINAL', status: 'Booked', type: 'Export', shippingMethod: 'Sea',
      orderId: null, customerRelationId: null, customerName: 'Buyer', createdAt: BigInt(1), updatedAt: BigInt(1), deletedAt: null }],
    shipmentLine: [{ id: 'OLD-LINE', shipmentId: 'S', lineNumber: 1, orderLineId: null, productCode: null, quantity: new Prisma.Decimal('1') }],
    shipmentCarton: [], shipmentCartonItem: [], shipmentOrderAllocation: [], shipmentProductionAllocation: [],
    productionBatch: [], releaseScope: [], sample: [], claimDisposition: [], repairWorkOrder: [], order: [], orderLine: [],
    auditLog: [], shipmentEvent: [], stockMovement: [], orderShipmentBatch: [], invoiceOrderAllocation: [],
  };
  const authTables = new Set(['userAccount', 'userPermissionOverrides', 'teamMember', 'teamDataGrant', 'relation', 'department']);
  const calls: Array<{ model: string; operation: string; args: any }> = [], locks: any[] = [], attempts: string[] = [];
  let commits = 0, aborts = 0;
  const database = (working: Record<string, any[]>) => {
    const db: any = {}, rows = (model: string) => authTables.has(model) ? tables[model] : working[model];
    for (const model of Object.keys(tables)) {
      const reader = storageReader(() => rows(model));
      db[model] = Object.fromEntries(Object.entries(reader).map(([operation, fn]) => [operation, async (args: any) => {
        calls.push({ model, operation, args });
        if (model === 'shipment' && operation === 'findUnique' && fault === 'unknown-source')
          throw Object.assign(new Error(privateFault), { code: 'P2010', details: { sql: privateFault } });
        if (model === 'shipment' && operation === 'findUnique' && args?.select?.updatedAt && fault === 'unknown-totals')
          throw Object.assign(new Error(privateFault), { details: { sql: privateFault } });
        return (fn as any)(args);
      }]));
      db[model].deleteMany = async (args: any) => {
        calls.push({ model, operation: 'deleteMany', args }); attempts.push(model + '.deleteMany');
        working[model] = rows(model).filter(row => !storageWhere(row, args.where)); return { count: 1 };
      };
      db[model].create = async ({ data }: any) => {
        calls.push({ model, operation: 'create', args: { data } }); attempts.push(model + '.create');
        if (model === 'auditLog' && fault === 'unknown-audit') throw Object.assign(new Error(privateFault), { code: 'P2003' });
        working[model].push(clone(data));
        if (model === 'shipmentCarton' && fault === 'missing-totals') working.shipment = [];
        return clone(data);
      };
      db[model].update = async ({ where, data }: any) => {
        calls.push({ model, operation: 'update', args: { where, data } }); attempts.push(model + '.update');
        const row = rows(model).find(row => storageWhere(row, where)); if (!row) throw new Error('STORAGE_ROW_MISSING');
        Object.assign(row, clone(data)); return clone(row);
      };
    }
    const rowLocks = storageRowLocks({ Shipment: () => rows('shipment'), Order: () => rows('order'),
      ProductionBatch: () => rows('productionBatch'), ShipmentOrderAllocation: () => rows('shipmentOrderAllocation'),
      ShipmentProductionAllocation: () => rows('shipmentProductionAllocation') }, locks);
    db.$queryRaw = async (query: any) => {
      const result = await rowLocks(query);
      if (/FROM "Shipment"/.test(query.sql) && fault === 'missing-after-lock') working.shipment = [];
      if (/FROM "Shipment"/.test(query.sql) && fault === 'late-withdrawal') tables.userAccount[0].roles[0].role.permissions = [];
      if (/FROM "Shipment"/.test(query.sql) && fault === 'late-department-withdrawal') tables.userAccount[0].primaryDepartment.metadata.businessAttributes = [];
      return result;
    };
    return db;
  };
  const db: any = database(tables);
  db.$transaction = async (work: any) => {
    const working = clone(tables);
    try {
      const result = await work(database(working));
      for (const model of Object.keys(tables)) if (!authTables.has(model)) tables[model] = working[model];
      commits++; return result;
    } catch (error) { aborts++; throw error; }
  };
  return { db, tables, calls, locks, attempts, state: () => ({ commits, aborts }) };
}
const originalPacking = (s: ReturnType<typeof shippingStorage>) => clone({ shipment: s.tables.shipment, lines: s.tables.shipmentLine, cartons: s.tables.shipmentCarton, items: s.tables.shipmentCartonItem, audits: s.tables.auditLog });

const input = [{ cartonNo: 'C-1', grossWeight: '1.25', items: [{ shipmentLineId: 'OLD-LINE', quantity: '0.5001' }] }];
describe('carton replacement retains the canonical public error and atomic writes', () => {
  it.each(['before-lock', 'after-lock'] as const)('retains typed missing-target 404 %s', async phase => {
    const s = shippingStorage(phase === 'after-lock' ? 'missing-after-lock' : undefined), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/' + (phase === 'before-lock' ? 'MISSING' : 'S') + '/cartons').set(header(shippingActor)).send({ cartons: input });
    expect(res.status).toBe(404); expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: '运单不存在或不可查看。', statusCode: 404 });
    expect(originalPacking(s)).toEqual(before); expect(s.attempts).toEqual([]); expect(s.state()).toEqual({ commits: 0, aborts: 1 }); expect(onDataChange).not.toHaveBeenCalled();
  });
  it.each(['late-withdrawal', 'late-department-withdrawal'] as const)('retains %s denial after the source lock, before any carton writes', async fault => {
    const s = shippingStorage(fault), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header(shippingActor)).send({ cartons: input });
    expect(res.status).toBe(403); expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(originalPacking(s)).toEqual(before); expect(s.attempts).toEqual([]); expect(s.state()).toEqual({ commits: 0, aborts: 1 }); expect(onDataChange).not.toHaveBeenCalled();
  });
  it.each(['missing', 'inactive', 'wrong-family'] as const)('a live scope cannot authorize carton writes from a %s logistics department', async kind => {
    const s = shippingStorage(), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const user = s.tables.userAccount[0];
    if (kind === 'missing') user.primaryDepartment = null;
    else if (kind === 'inactive') user.primaryDepartment.status = 'inactive';
    else user.primaryDepartment.metadata.businessAttributes = ['fabric_business'];
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header(shippingActor)).send({ cartons: input });
    expect(res.status).toBe(403); expect(JSON.stringify(res.body)).not.toContain(privateFault);
    expect(originalPacking(s)).toEqual(before); expect(s.attempts).toEqual([]); expect(s.locks).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('a signed empty ceiling cannot be overwritten by a forged request actor', async () => {
    const s = shippingStorage(), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header({ ...shippingActor, permissionCeiling: [] })).send({ cartons: input, actor: shippingActor });
    expect(res.status).toBe(403); expect(res.body.error).toBe('FORBIDDEN');
    expect(originalPacking(s)).toEqual(before); expect(s.calls).toEqual([]); expect(s.state()).toEqual({ commits: 0, aborts: 0 }); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('the service retains a typed totals 404 and rolls back already staged cartons/items', async () => {
    const s = shippingStorage('missing-totals'), before = originalPacking(s);
    const result = await replaceShipmentCartons(s.db, 'S', input, shippingActor.userId, null, { actor: shippingActor });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '运单 S 不存在', statusCode: 404 } });
    expect(s.attempts).toContain('shipmentCarton.create'); expect(s.attempts).toContain('shipmentCartonItem.create'); expect(s.attempts).not.toContain('auditLog.create');
    expect(originalPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 });
  });
  it.each(['unknown-source', 'unknown-totals', 'unknown-audit'] as const)('retains safe 500 and the original shipment on %s', async fault => {
    const s = shippingStorage(fault), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header(shippingActor)).send({ cartons: input });
    expect(res.status).toBe(500); expect(res.body.error).toEqual({ code: 'SAVE_FAILED', message: '装箱明细保存结果暂不可确认，请刷新核对原运单。', statusCode: 500 });
    expect(JSON.stringify(res.body)).not.toContain(privateFault); expect(res.body.error).not.toHaveProperty('details');
    expect(originalPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 }); expect(onDataChange).not.toHaveBeenCalled();
    if (fault !== 'unknown-source') expect(s.attempts).toContain('shipmentCartonItem.create');
    if (fault === 'unknown-audit') expect(s.attempts).toContain('shipment.update');
  });
  it('foreign-line validation retains its established 400 and never deletes original cartons', async () => {
    const s = shippingStorage(), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header(shippingActor)).send({ cartons: [{ cartonNo: 'C', items: [{ shipmentLineId: 'FOREIGN', quantity: '1' }] }] });
    expect(res.status).toBe(400); expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(originalPacking(s)).toEqual(before); expect(s.attempts).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('a valid replacement retains exact stored quantity, advances the version and emits its mandatory audit once', async () => {
    const s = shippingStorage(), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/cartons').set(header(shippingActor)).send({ cartons: input });
    expect(res.status).toBe(200); expect(res.body.cartons).toHaveLength(1);
    expect(s.tables.shipmentCarton).toHaveLength(1); expect(s.tables.shipmentCartonItem[0].quantity.toString()).toBe('0.5001');
    expect(s.tables.shipment[0].updatedAt > BigInt(1)).toBe(true); expect(s.tables.shipment[0].totalPackages).toBe(1);
    expect(s.tables.auditLog).toHaveLength(1); expect(s.tables.auditLog[0]).toMatchObject({ action: 'PACKING_CARTONS_REPLACE', actorId: shippingActor.userId, targetId: 'S' });
    expect(s.state()).toEqual({ commits: 1, aborts: 0 }); expect(onDataChange).toHaveBeenCalledTimes(1);
  });
});
