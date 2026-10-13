/** Actual router/service controls over explicit storage seams. This is not PG,
 * browser or cross-process lock proof. No authorization/source helper is mocked. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { businessError, lookupErrorCode } from '../../shared/errorCodes';
import { createShippingRouter } from '../route';
import { updateShipment } from '../shipmentMutationService';
import { replaceShipmentLines, replaceShipmentLinesTx } from '../shipmentPackingService';
import { actor as documentActor, storage as documentStorage } from '../../customs/__tests__/documentSourceStorage';
import { storageReader, storageRowLocks, storageWhere } from './shippingSourceStorageFixture';

const privateFault = 'PRIVATE_SQL shipment.secret_column /private/db';
const header = (actor: TokenPayload) => ({ Authorization: `Bearer ${createAuthService().signToken(actor)}` });
function appFor(prisma: any) {
  const app = express(), onDataChange = vi.fn();
  // index.ts:438-450 installs bigint/Decimal -> Number at the real HTTP root.
  // Reproduce that legacy wire projection locally, without changing global prototypes.
  app.set('json replacer', function (this: any, key: string, value: any) {
    const original = this[key];
    return typeof original === 'bigint' || original instanceof Prisma.Decimal ? Number(original) : value;
  });
  app.use(express.json());
  app.use('/api/v1/shipping', createShippingRouter({ prisma, requireAuth: true, apiKeys: new Set(), onDataChange }));
  return { app, onDataChange };
}
// CI selection is readable by Finance; registration eligibility needs a live logistics attribute.
function ciStorage() {
  const s = documentStorage();
  s.tables.userAccount[0].primaryDeptId = 'trade-documents-dept';
  s.tables.userAccount[0].primaryDepartment = { id: 'trade-documents-dept', parentId: 'company', status: 'active', metadata: { businessAttributes: ['finance', 'logistics'] } };
  s.tables.department = [s.tables.userAccount[0].primaryDepartment];
  s.db.department = storageReader(() => s.tables.department);
  return s;
}
const ciHeader = () => header({ ...documentActor, departmentIds: [] });
const ciWrites = (s: ReturnType<typeof documentStorage>) => s.calls.filter(call => /\.(create|update)$/.test(call));
const details = { blockingReasons: [{ orderId: 'O', code: 'SOURCE_CHANGED', message: '请核对原来源' }], orders: [{ orderId: 'O', eligible: false }] };

describe('CI choice HTTP preserves only the central safe error carrier', () => {
  it.each(['details', 'gateDetails'] as const)('preserves typed %s via public error.details without changing code, message or 409', async carrier => {
    const s = ciStorage(), { app, onDataChange } = appFor(s.db);
    s.setHook((model, operation) => { if (model === 'invoiceOrderAllocation' && operation === 'findMany')
      throw Object.assign(businessError('CONFLICT', '原商业发票来源须核对。'), { [carrier]: details }); });
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: '原商业发票来源须核对。', details } });
    expect(res.body.error).not.toHaveProperty('gateDetails');
    expect(ciWrites(s)).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('honours central null-carrier normalization and cannot copy raw error.details', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    s.setHook((model, operation) => { if (model === 'invoiceOrderAllocation' && operation === 'findMany')
      throw Object.assign(businessError('CONFLICT', '请核对。'), { details: null }); });
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(409); expect(res.body.error).toEqual({ code: 'CONFLICT', message: '请核对。' });
    expect(res.body.error).not.toHaveProperty('details');
    expect(ciWrites(s)).toEqual([]);
  });
  it('does not manufacture details for a typed refusal without a carrier', async () => {
    const s = ciStorage(), { app } = appFor(s.db); s.tables.shipment[0].status = 'Cancelled';
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(409); expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error).not.toHaveProperty('details'); expect(ciWrites(s)).toEqual([]);
  });
  it('unknown storage faults keep safe 500 and cannot expose raw message, details or gateDetails', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    s.setHook((model, operation) => { if (model === 'invoiceOrderAllocation' && operation === 'findMany')
      throw Object.assign(new Error(privateFault), { code: 'P2010', details: { sql: privateFault }, gateDetails: details }); });
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'ASSEMBLE_FAILED', message: lookupErrorCode('ASSEMBLE_FAILED')!.message } });
    expect(JSON.stringify(res.body)).not.toContain(privateFault); expect(ciWrites(s)).toEqual([]);
  });
  it('real authorized exact CI choices remain read only', async () => {
    const s = ciStorage(), { app, onDataChange } = appFor(s.db);
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemaVersion: 1, shipmentId: 'S', orderIds: ['O'], candidates: [
      { sourceInvoiceId: 'INV', invoiceNumber: 'FIN-001', amount: '200', canRegister: true } ] });
    expect(res.body.candidates[0].expectedSourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ciWrites(s)).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('Finance can read exact CI choices but cannot register without logistics eligibility', async () => {
    const s = ciStorage(), { app, onDataChange } = appFor(s.db);
    s.tables.userAccount[0].primaryDepartment.metadata.businessAttributes = ['finance'];
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(200); expect(res.body.candidates[0]).toMatchObject({ sourceInvoiceId: 'INV', canRegister: false });
    expect(ciWrites(s)).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('real signed empty ceiling denies before any shipment source read', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(header({ ...documentActor, departmentIds: [], permissionCeiling: [] }));
    expect(res.status).toBe(403); expect(res.body.error.code).toBe('FORBIDDEN');
    expect(s.calls).not.toContain('shipment.findUnique'); expect(ciWrites(s)).toEqual([]);
  });
  it('current invoices:read withdrawal during selection cannot publish earlier choices', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    s.setHook((model, operation) => { if (model === 'invoiceOrderAllocation' && operation === 'findMany') s.revoke('invoices:read'); });
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(403); expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body).not.toHaveProperty('candidates'); expect(ciWrites(s)).toEqual([]);
  });
  it('changed actual shipment source is rejected on final reread', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    s.setHook((model, operation) => { if (model === 'invoiceOrderAllocation' && operation === 'findMany') s.tables.shipment[0].status = 'Cancelled'; });
    const res = await request(app).get('/api/v1/shipping/S/ci-sources').set(ciHeader());
    expect(res.status).toBe(409); expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body).not.toHaveProperty('candidates'); expect(ciWrites(s)).toEqual([]);
  });
  it('missing actual source keeps typed 404, rather than exposing another invoice', async () => {
    const s = ciStorage(), { app } = appFor(s.db);
    const res = await request(app).get('/api/v1/shipping/MISSING/ci-sources').set(ciHeader());
    expect(res.status).toBe(404); expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body).not.toHaveProperty('candidates'); expect(ciWrites(s)).toEqual([]);
  });
});

function clone(value: any): any {
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
const shippingScopes = ['shipments:read', 'shipments:write', 'orders:read'];
const shippingActor: TokenPayload = { userId: 'packing-user', roles: ['logistics'], roleIds: ['role-logistics'], permissions: shippingScopes,
  authorizationLoaded: true, departmentIds: [] };
type Fault = 'missing-after-lock' | 'missing-totals' | 'unknown-totals' | 'unknown-source' | 'late-withdrawal' | 'late-department-withdrawal';
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
        working[model].push(clone(data));
        if (model === 'shipmentLine' && fault === 'missing-totals') working.shipment = [];
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
const packingInput = [{ productName: 'Original shipment goods', quantity: '2.0001', unit: 'm' }];
const update = (s: ReturnType<typeof shippingStorage>, shipmentId = 'S') => updateShipment({ prisma: s.db, shipmentId,
  patch: { vesselOrFlight: 'MV-1' }, hasStatus: false, actorId: shippingActor.userId, actor: shippingActor });
const originalPacking = (s: ReturnType<typeof shippingStorage>) => clone({ shipment: s.tables.shipment, lines: s.tables.shipmentLine,
  cartons: s.tables.shipmentCarton, items: s.tables.shipmentCartonItem, audits: s.tables.auditLog });
const persistedPacking = originalPacking;

describe('PATCH missing target keeps the public contract without remapping source errors', () => {
  it.each(['before-lock', 'after-lock'] as const)('returns 404 NOT_FOUND for actual missing shipment %s and no success notification', async phase => {
    const s = shippingStorage(phase === 'after-lock' ? 'missing-after-lock' : undefined), { app, onDataChange } = appFor(s.db);
    const before = originalPacking(s), id = phase === 'before-lock' ? 'MISSING' : 'S';
    const res = await request(app).patch('/api/v1/shipping/' + id).set(header(shippingActor)).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(404); expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: '运单不存在或不可查看。', statusCode: 404 });
    expect(s.attempts).toEqual([]); expect(onDataChange).not.toHaveBeenCalled(); expect(persistedPacking(s)).toEqual(before);
    expect(s.state()).toEqual({ commits: 0, aborts: 1 });
    if (phase === 'after-lock') expect(s.locks).toEqual([{ table: 'Shipment', ids: ['S'], rows: ['S'] }]);
  });
  it('the direct canonical service retains SHIPMENT_NOT_FOUND, rather than globally renaming it', async () => {
    const s = shippingStorage(), result = await update(s, 'MISSING');
    expect(result).toEqual({ ok: false, error: { code: 'SHIPMENT_NOT_FOUND', message: '运单不存在或不可查看。', statusCode: 404 } });
    expect(s.attempts).toEqual([]); expect(s.state()).toEqual({ commits: 0, aborts: 1 });
  });
  it('a missing parent remains ORDER_NOT_FOUND and never becomes a missing shipment', async () => {
    const s = shippingStorage(), { app, onDataChange } = appFor(s.db); s.tables.shipment[0].orderId = 'MISSING-ORDER';
    const res = await request(app).patch('/api/v1/shipping/S').set(header(shippingActor)).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(404); expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(s.calls.some(call => call.model === 'order' && call.operation === 'findFirst' && call.args.where.id === 'MISSING-ORDER')).toBe(true);
    expect(s.attempts).toEqual([]); expect(s.locks).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
  it.each(['late-withdrawal', 'late-department-withdrawal'] as const)('%s is still forbidden with zero mutation and no successful notification', async fault => {
    const s = shippingStorage(fault), { app, onDataChange } = appFor(s.db);
    const res = await request(app).patch('/api/v1/shipping/S').set(header(shippingActor)).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(403); expect(res.body.error.code).toBe('FORBIDDEN');
    expect(s.attempts).toEqual([]); expect(onDataChange).not.toHaveBeenCalled(); expect(s.state()).toEqual({ commits: 0, aborts: 1 });
  });
  it('signed empty ceiling remains denied at the actual permission middleware, before a transaction', async () => {
    const s = shippingStorage(), { app, onDataChange } = appFor(s.db);
    const res = await request(app).patch('/api/v1/shipping/S').set(header({ ...shippingActor, permissionCeiling: [] })).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(403); expect(res.body.error).toBe('FORBIDDEN');
    expect(s.calls).toEqual([]); expect(s.state()).toEqual({ commits: 0, aborts: 0 }); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('unknown source fault remains safe UPDATE_FAILED 500, not a guessed NOT_FOUND', async () => {
    const s = shippingStorage('unknown-source'), { app, onDataChange } = appFor(s.db);
    const res = await request(app).patch('/api/v1/shipping/S').set(header(shippingActor)).send({ vesselOrFlight: 'MV-1' });
    expect(res.status).toBe(500); expect(res.body.error.code).toBe('UPDATE_FAILED');
    expect(JSON.stringify(res.body)).not.toContain(privateFault); expect(res.body.error).not.toHaveProperty('details');
    expect(s.attempts).toEqual([]); expect(onDataChange).not.toHaveBeenCalled();
  });
});

describe('real packing totals disappearance is a typed 404 and rolls back every staged write', () => {
  it('throws the original NOT_FOUND message with registered 404 from the actual transaction-bound producer', async () => {
    const s = shippingStorage('missing-totals'), before = originalPacking(s);
    await expect(s.db.$transaction((tx: any) => replaceShipmentLinesTx(tx, 'S', packingInput, shippingActor.userId, null, { actor: shippingActor })))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404, message: '运单 S 不存在' });
    expect(s.attempts).toEqual(['shipmentCartonItem.deleteMany', 'shipmentLine.deleteMany', 'shipmentLine.create']);
    expect(persistedPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 });
  });
  it('the real service result retains typed 404, exact message and no committed packing or audit changes', async () => {
    const s = shippingStorage('missing-totals'), before = originalPacking(s);
    const result = await replaceShipmentLines(s.db, 'S', packingInput, shippingActor.userId, null, { actor: shippingActor });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', statusCode: 404, message: '运单 S 不存在' } });
    expect(persistedPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 });
    expect(s.attempts).toContain('shipmentLine.create'); expect(s.attempts).not.toContain('auditLog.create');
  });
  it('the real HTTP result retains typed 404 and cannot send a success change event', async () => {
    const s = shippingStorage('missing-totals'), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/lines').set(header(shippingActor)).send({ lines: packingInput });
    expect(res.status).toBe(404); expect(res.body).toEqual({ error: { code: 'NOT_FOUND', statusCode: 404, message: '运单 S 不存在' } });
    expect(persistedPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 }); expect(onDataChange).not.toHaveBeenCalled();
  });
  it('an unknown totals reread fault stays safe SAVE_FAILED 500 and atomically retains the original packing', async () => {
    const s = shippingStorage('unknown-totals'), before = originalPacking(s), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/lines').set(header(shippingActor)).send({ lines: packingInput });
    expect(res.status).toBe(500); expect(res.body.error.code).toBe('SAVE_FAILED'); expect(res.body.error.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(privateFault); expect(res.body.error).not.toHaveProperty('details');
    expect(persistedPacking(s)).toEqual(before); expect(s.state()).toEqual({ commits: 0, aborts: 1 }); expect(onDataChange).not.toHaveBeenCalled();
    expect(s.attempts).toContain('shipmentLine.create'); expect(s.attempts).not.toContain('auditLog.create');
  });
  it('a real positive replacement advances stored version, preserves exact quantity and writes its mandatory audit', async () => {
    const s = shippingStorage(), { app, onDataChange } = appFor(s.db);
    const res = await request(app).put('/api/v1/shipping/S/lines').set(header(shippingActor)).send({ lines: packingInput });
    expect(res.status).toBe(200); expect(res.body.lines).toHaveLength(1); expect(res.body.lines[0].quantity).toBe(2.0001);
    expect(s.tables.shipmentLine).toHaveLength(1); expect(s.tables.shipmentLine[0].quantity.toString()).toBe('2.0001');
    expect(s.tables.shipment[0].updatedAt > BigInt(1)).toBe(true);
    expect(s.tables.auditLog).toHaveLength(1); expect(s.tables.auditLog[0]).toMatchObject({ action: 'PACKING_LINES_REPLACE', actorId: shippingActor.userId, targetId: 'S' });
    expect(s.state()).toEqual({ commits: 1, aborts: 0 }); expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(s.locks).toEqual([{ table: 'Shipment', ids: ['S'], rows: ['S'] }]);
  });
});
