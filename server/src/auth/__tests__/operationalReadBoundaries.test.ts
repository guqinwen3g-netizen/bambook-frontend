import express from 'express';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../service';
import { setDefaultAgentApiKeyActors } from '../agentPrincipal';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';
import { createInventoryRouter } from '../../inventory/inventoryRoute';
import { createMesRouter } from '../../mes/mesRoute';
import { createOperationalReadAccess, maskOperationalRead } from '../operationalReadAccess';
import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// Actual JWT/module/scope guards, order/L2 resolver, route, services, JSON/XLSX.
// Only persistence is replaced. Independent rules: View.Inventory orders:read,
// View.MES production:read; §10.4.2 linked rows follow the order; C4 general
// stock remains readable; permission matrix §5.2 salary uses both scopes.
// This is behavior at HTTP/service boundaries, not PG/index-freshness/UAT proof.
const USER = 'operations-read-fixture';
const KEY = 'operations-boundary-synthetic-key';
const auth = createAuthService();
const readScopes = ['orders:read', 'production:read', 'inventory:read', 'procurement:read', 'shipments:read', 'products:read'];
const payScopes = ['hr:salary:read', 'sensitive:salary'];
const actor = (permissions = readScopes, extra: Partial<TokenPayload> = {}): TokenPayload => ({
  userId: USER, roles: ['sales'], departmentIds: [], permissions, authorizationLoaded: true, ...extra,
});

function storage() {
  const state: Record<string, any[]> = {
    order: [
      { id: 'order-own', ownerId: USER, customerRelationId: null, deletedAt: null },
      { id: 'order-hidden', ownerId: 'other', customerRelationId: null, deletedAt: null },
      { id: 'order-deleted', ownerId: USER, customerRelationId: null, deletedAt: BigInt(1) },
    ],
    relation: [
      { id: 'customer-own', ownerId: USER, salesRepIds: [], deletedAt: null },
      { id: 'customer-hidden', ownerId: 'other', salesRepIds: [], deletedAt: null },
    ],
    warehouse: [{ id: 'warehouse', code: 'WH-PUBLIC', name: 'Warehouse', type: 'Own', isActive: true, sortOrder: 0, deletedAt: null, createdAt: BigInt(0) }],
    inventoryItem: [
      { id: 'item-hidden', warehouseId: 'warehouse', materialCode: 'M-HIDDEN', orderId: 'order-hidden', quantity: new Prisma.Decimal(1000), lockedQuantity: 0, unit: 'YD', unitCost: 1000, currency: 'CNY', ownership: 'Owned', minStock: 2000, deletedAt: null, updatedAt: BigInt(90) },
      { id: 'item-own', warehouseId: 'warehouse', materialCode: 'M-OWN', description: 'Own stock', batchNumber: 'LOT-BULK', orderId: 'order-own', quantity: new Prisma.Decimal(10), lockedQuantity: 2, unit: 'YD', unitCost: new Prisma.Decimal(7), currency: 'CNY', ownership: 'Owned', minStock: 20, deletedAt: null, updatedAt: BigInt(80) },
      { id: 'item-general', warehouseId: 'warehouse', materialCode: 'M-GENERAL', description: 'General stock', batchNumber: 'LOT-LAB', orderId: null, quantity: 5, lockedQuantity: 0, unit: 'PC', unitCost: 3, currency: 'USD', ownership: 'Consignment', minStock: 10, deletedAt: null, updatedAt: BigInt(70) },
      { id: 'item-orphan', warehouseId: 'warehouse', orderId: 'missing-order', quantity: 900, unit: 'YD', ownership: 'Owned', unitCost: 999, deletedAt: null, updatedAt: BigInt(100) },
      { id: 'item-deleted-parent', warehouseId: 'warehouse', orderId: 'order-deleted', quantity: 900, unit: 'YD', ownership: 'Owned', unitCost: 999, deletedAt: null, updatedAt: BigInt(101) },
    ],
    stockMovement: [
      { id: 'movement-own', movementNumber: 'SM-OWN', itemId: 'item-own', warehouseId: 'warehouse', referenceType: 'Order', referenceId: 'order-own', unitCost: 7, quantity: 2, unit: 'YD', createdAt: BigInt(3) },
      { id: 'movement-hidden-ref', movementNumber: 'SM-HIDDEN', itemId: 'item-own', warehouseId: 'warehouse', referenceType: 'Order', referenceId: 'order-hidden', unitCost: 999, quantity: 3, unit: 'YD', createdAt: BigInt(9) },
      { id: 'movement-hidden-item', movementNumber: 'SM-HIDDEN-ITEM', itemId: 'item-hidden', warehouseId: 'warehouse', referenceType: 'Manual', referenceId: null, quantity: 3, createdAt: BigInt(10) },
      { id: 'movement-unknown', movementNumber: 'SM-UNKNOWN', itemId: 'item-own', warehouseId: 'warehouse', referenceType: 'NewUnmappedReference', referenceId: 'unknown-secret-id', unitCost: 7, quantity: 2, createdAt: BigInt(2) },
    ],
    inventoryOwnershipChange: [
      { id: 'history-hidden', itemId: 'item-own', fromOrderId: 'order-hidden', toOrderId: 'order-own', reason: 'private old order reason', createdAt: BigInt(5) },
      { id: 'history-own', itemId: 'item-own', fromOrderId: null, toOrderId: 'order-own', reason: 'attribute general stock', createdAt: BigInt(4) },
    ],
    purchaseOrder: [{ id: 'po-own', orderId: 'order-own', deletedAt: null }, { id: 'po-hidden', orderId: 'order-hidden', deletedAt: null }],
    purchaseLine: [{ id: 'purchase-line-own', purchaseOrderId: 'po-own' }, { id: 'purchase-line-hidden', purchaseOrderId: 'po-hidden' }],
    materialReceipt: [{ id: 'receipt-own', purchaseOrderId: 'po-own' }, { id: 'receipt-hidden', purchaseOrderId: 'po-hidden' }],
    shipment: [{ id: 'shipment-own', orderId: null, deletedAt: null }, { id: 'shipment-hidden', orderId: 'order-hidden', deletedAt: null }],
    shipmentOrderAllocation: [{ shipmentId: 'shipment-own', orderId: 'order-own' }],
    productionStage: [{ id: 'stage-own', orderId: 'order-own' }, { id: 'stage-hidden', orderId: 'order-hidden' }],
    developmentCase: [
      { id: 'case-own', customerRelationId: 'customer-own', owner: 'free text person', deletedAt: null },
      { id: 'case-hidden', customerRelationId: 'customer-hidden', owner: USER, deletedAt: null },
      { id: 'case-general', customerRelationId: null, owner: USER, deletedAt: null },
    ],
    sampleColorBatch: [
      { id: 'color-bulk-hidden', stage: 'bulk', orderId: 'order-hidden', developmentCaseId: null, dyeLotNo: 'LOT-BULK', colorRating: 1, sideDiff: 1, endDiff: 1, defectCauses: ['secret'], deletedAt: null, createdAt: BigInt(8) },
      { id: 'color-bulk-own', stage: 'bulk', orderId: 'order-own', developmentCaseId: null, dyeLotNo: 'LOT-BULK', colorRating: 4, sideDiff: 4, endDiff: 4, defectCauses: [], deletedAt: null, createdAt: BigInt(2) },
      { id: 'color-lab-hidden', stage: 'lab_dip', orderId: null, developmentCaseId: 'case-hidden', dyeLotNo: 'LOT-LAB', colorRating: 1, sideDiff: 1, endDiff: 1, defectCauses: ['secret'], deletedAt: null, createdAt: BigInt(8) },
      { id: 'color-lab-own', stage: 'lab_dip', orderId: null, developmentCaseId: 'case-own', dyeLotNo: 'LOT-LAB', colorRating: 4, sideDiff: 4, endDiff: 4, defectCauses: [], deletedAt: null, createdAt: BigInt(2) },
    ],
    workStation: [{ id: 'station', code: 'WS-PUBLIC', name: 'Station', type: 'Cutting', capacityPerDay: 100, deletedAt: null, sortOrder: 0 }],
    productionPlan: [
      { id: 'plan-hidden', orderId: 'order-hidden', workStationId: 'station', planNumber: 'PP-HIDDEN', status: 'Confirmed', processType: 'Cutting', plannedQuantity: 1000, unit: 'PC', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-01', deletedAt: null, createdAt: BigInt(90) },
      { id: 'plan-own', orderId: 'order-own', workStationId: 'station', planNumber: 'PP-OWN', status: 'Confirmed', processType: 'Cutting', plannedQuantity: 20, unit: 'PC', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-01', deletedAt: null, createdAt: BigInt(80) },
      { id: 'plan-general', orderId: null, workStationId: 'station', planNumber: 'PP-GENERAL', status: 'Confirmed', processType: 'Cutting', plannedQuantity: 10, unit: 'PC', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-01', deletedAt: null, createdAt: BigInt(70) },
      { id: 'plan-deleted', orderId: 'order-own', workStationId: 'station', deletedAt: BigInt(1), createdAt: BigInt(95) },
      { id: 'plan-orphan', orderId: 'missing-order', workStationId: 'station', deletedAt: null, createdAt: BigInt(95) },
    ],
    workHour: [
      { id: 'hour-own', productionPlanId: 'plan-own', employeeId: 'worker-own', employeeName: 'Worker', hours: 8, overtimeHours: 1, workDate: '2026-10-01' },
      { id: 'hour-hidden', productionPlanId: 'plan-hidden', employeeId: 'worker-secret', employeeName: 'Secret person', hours: 900, overtimeHours: 900, workDate: '2026-10-01' },
      { id: 'hour-deleted', productionPlanId: 'plan-deleted', employeeId: 'worker-secret', hours: 900, workDate: '2026-10-01' },
    ],
    pieceRateRule: [{ id: 'rule', code: 'RULE', name: 'Cutting rule', processType: 'Cutting', ratePerUnit: new Prisma.Decimal(3), unit: 'PC', isActive: true, deletedAt: null }],
    pieceRateRecord: [
      { id: 'pay-own', productionPlanId: 'plan-own', pieceRateRuleId: 'rule', employeeId: 'worker-own', employeeName: 'Worker', amount: 12, ratePerUnit: 3, quantity: 4, status: 'Pending', workDate: '2026-10-01' },
      { id: 'pay-hidden', productionPlanId: 'plan-hidden', pieceRateRuleId: 'rule', employeeId: 'worker-secret', employeeName: 'Secret person', amount: 900, ratePerUnit: 3, quantity: 300, status: 'Pending', workDate: '2026-10-01' },
    ],
    outsourcingOrder: [
      { id: 'outsourcing-hidden', orderId: 'order-hidden', orderNumber: 'OSO-HIDDEN', unitPrice: 900, totalAmount: 900, deletedAt: null, createdAt: BigInt(90) },
      { id: 'outsourcing-own', orderId: 'order-own', orderNumber: 'OSO-OWN', unitPrice: 7, quantity: 4, totalAmount: 28, deletedAt: null, createdAt: BigInt(80) },
      { id: 'outsourcing-general', orderId: null, orderNumber: 'OSO-GENERAL', unitPrice: 5, quantity: 1, totalAmount: 5, deletedAt: null, createdAt: BigInt(70) },
    ],
    outsourcingLine: [{ id: 'line', outsourcingOrderId: 'outsourcing-own', quantity: 4, unitPrice: 7, amount: 28 }],
    orderProcessNode: [{ id: 'process-own', orderId: 'order-own', seq: 1, processType: 'gray_fabric', status: 'done', inputQty: 20, outputQty: 19, unitPrice: 3, amount: 57, deletedAt: null }],
    // The MES write boundary reloads current persisted grants before denying
    // this read-only subject. No write authority comes from the JWT fixture.
    userAccount: [{ id: USER, status: 'active', deletedAt: null, primaryDeptId: null, roles: [{ roleId: 'role-sales', departmentId: null,
      role: { id: 'role-sales', permissions: readScopes.map(scope => ({ permission: { scope } })) } }] }],
    userPermissionOverrides: [],
    teamMember: [], teamDataGrant: [], team: [],
  };
  const relationFor = (model: string, row: any, field: string) => {
    if (model === 'stockMovement' && field === 'item') return state.inventoryItem.find(item => item.id === row.itemId);
    if ((model === 'teamMember' || model === 'teamDataGrant') && field === 'team') return state.team.find(team => team.id === row.teamId);
    return undefined;
  };
  const matchValue = (actual: any, filter: any): boolean => {
    if (filter === null || typeof filter !== 'object' || filter instanceof Prisma.Decimal) return actual === filter;
    return Object.entries(filter).every(([op, value]: any) => {
      if (op === 'in') return value.includes(actual);
      if (op === 'notIn') return !value.includes(actual);
      if (op === 'not') return !matchValue(actual, value);
      if (op === 'equals') return actual === value;
      if (op === 'contains') return String(actual ?? '').includes(value);
      if (op === 'has') return actual?.includes(value) ?? false;
      if (op === 'lte') return typeof actual === 'string' ? actual <= value : Number(actual) <= Number(value);
      if (op === 'gte') return typeof actual === 'string' ? actual >= value : Number(actual) >= Number(value);
      if (op === 'mode') return true;
      throw new Error(`unimplemented storage filter ${op}`);
    });
  };
  const matches = (model: string, row: any, where: any): boolean => !!row && Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(model, row, part));
    if (key === 'OR') return value.some((part: any) => matches(model, row, part));
    if (key === 'NOT') return !(Array.isArray(value) ? value : [value]).some(part => matches(model, row, part));
    const related = relationFor(model, row, key);
    if (related !== undefined) return matches(key === 'item' ? 'inventoryItem' : key, related, value.is ?? value);
    if (value?.lte?.field === 'minStock') return Number(row[key]) <= Number(row.minStock);
    return matchValue(row[key], value);
  });
  const queried = (model: string, args: any = {}): any[] => {
    let rows = state[model].filter(row => matches(model, row, args.where));
    for (const order of (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).filter(Boolean).reverse()) {
      const [field, direction] = Object.entries(order)[0] as [string, string];
      rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
    }
    return rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take).map(row => projection(model, row, args));
  };
  // Stored current-account selections include nested roles/role permissions.
  // This projects persisted fixture values only; token claims are not inputs.
  const selectStoredAccount = (value: any, select: Record<string, any>): any => {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(row => selectStoredAccount(row, select));
    return Object.fromEntries(Object.entries(select).filter(([, selected]) => selected !== false).map(([field, selected]) => {
      if (selected === true) return [field, value[field]];
      if (!selected?.select) throw new Error(`unimplemented current-account selection ${field}`);
      return [field, selectStoredAccount(value[field], selected.select)];
    }));
  };
  const projection = (model: string, row: any, args: any): any => {
    if (!row) return null;
    const copy = model === 'userAccount' && args.select ? selectStoredAccount(row, args.select)
      : args.select ? Object.fromEntries(Object.entries(args.select).filter(([, include]) => include === true).map(([field]) => [field, row[field]])) : { ...row };
    for (const [field, options] of Object.entries(args.include ?? {})) {
      const config = options === true ? {} : options as any;
      if (field === 'warehouse') copy[field] = projection('warehouse', state.warehouse.find(warehouse => warehouse.id === row.warehouseId), config);
      if (field === 'movements') copy[field] = queried('stockMovement', { ...config, where: { AND: [{ itemId: row.id }, config.where ?? {}] } });
      if (field === 'productionPlans') copy[field] = queried('productionPlan', { ...config, where: { AND: [{ workStationId: row.id }, config.where ?? {}] } });
      if (field === 'workStation') copy[field] = projection('workStation', state.workStation.find(station => station.id === row.workStationId), config);
      if (field === 'workHours') copy[field] = queried('workHour', { ...config, where: { productionPlanId: row.id } });
      if (field === 'lines') copy[field] = queried('outsourcingLine', { ...config, where: { outsourcingOrderId: row.id } });
      if (field === 'pieceRateRule') copy[field] = projection('pieceRateRule', state.pieceRateRule.find(rule => rule.id === row.pieceRateRuleId), config);
    }
    return copy;
  };
  const prisma: any = { $transaction: vi.fn(() => { throw new Error('read unexpectedly opened a write transaction'); }) };
  for (const model of Object.keys(state)) {
    prisma[model] = {
      findMany: vi.fn(async (args: any = {}) => queried(model, args)),
      findUnique: vi.fn(async (args: any) => queried(model, { ...args, take: 1 })[0] ?? null),
      findFirst: vi.fn(async (args: any) => queried(model, { ...args, take: 1 })[0] ?? null),
      count: vi.fn(async (args: any = {}) => state[model].filter(row => matches(model, row, args.where)).length),
      ...Object.fromEntries(['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].map(method => [method, vi.fn(() => { throw new Error(`read attempted ${model}.${method}`); })])),
    };
  }
  prisma.inventoryItem.fields = { minStock: { field: 'minStock' } };
  return { prisma, state };
}
function application(db: ReturnType<typeof storage>, opts: { keyActor?: TokenPayload; requireAuth?: boolean } = {}) {
  setDefaultAgentApiKeyActors(opts.keyActor ? new Map([[KEY, opts.keyActor]]) : new Map());
  const app = express();
  app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  const options = { prisma: db.prisma, apiKeys: new Set([KEY]), requireAuth: opts.requireAuth ?? true };
  app.use('/inventory', createInventoryRouter(options));
  app.use('/mes', createMesRouter(options));
  return app;
}
const jwtGet = (app: express.Express, path: string, subject = actor()) => request(app).get(path).set('Authorization', `Bearer ${auth.signToken(subject)}`);
function noWrites(db: ReturnType<typeof storage>) {
  expect(db.prisma.$transaction).not.toHaveBeenCalled();
  for (const model of Object.keys(db.state)) for (const method of ['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert']) expect(db.prisma[model][method], `${model}.${method}`).not.toHaveBeenCalled();
}
const inventoryReads = ['/warehouses', '/items', '/items/item-own', '/movements', '/alerts/low-stock', '/items/item-own/ownership-history', '/by-order/order-own', '/dye-lot-stock', '/summary-by-ownership'];
const mesReads = ['/work-stations', '/work-stations/station', '/work-stations/station/utilization?startDate=2026-10-01&endDate=2026-10-01', '/plans', '/plans/plan-own', '/work-hours', '/work-hours/summary', '/piece-rate-rules', '/piece-rate-records', '/piece-rate-records/summary', '/outsourcing', '/outsourcing/outsourcing-own', '/order-processes?orderId=order-own'];

beforeEach(() => { __clearTeamShareCacheForTests(); setDefaultAgentApiKeyActors(new Map()); });
afterEach(() => { __clearTeamShareCacheForTests(); setDefaultAgentApiKeyActors(new Map()); });

describe('Human operational read module gates: real middleware, before persistence', () => {
  it.each(inventoryReads)('Inventory %s rejects inventory:read without actual View scope', async path => {
    const db = storage();
    const response = await jwtGet(application(db), `/inventory${path}`, actor(['inventory:read']));
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('orders:read');
    for (const model of Object.keys(db.state)) expect(db.prisma[model].findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
  it.each(mesReads)('MES %s rejects cost/HR scope without production:read', async path => {
    const db = storage();
    const response = await jwtGet(application(db), `/mes${path}`, actor(['sensitive:cost', ...payScopes]));
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('production:read');
    for (const model of Object.keys(db.state)) expect(db.prisma[model].findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
  it('body actor cannot authorize an unauthenticated GET', async () => {
    const db = storage();
    expect((await request(application(db)).get('/inventory/items').send({ actor: actor([], { roles: ['owner'] }) })).status).toBe(401);
    expect(db.prisma.inventoryItem.findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
  it.each([['/inventory/items', ['inventory:write']], ['/mes/plans', ['production:write']]])('write-only snapshot cannot read %s', async (path, scopes) => {
    const db = storage();
    expect((await jwtGet(application(db), path as string, actor(scopes as string[]))).status).toBe(403);
    noWrites(db);
  });
  it.each(['/inventory/items', '/mes/plans'])('marked empty snapshot cannot recover role defaults for %s', async path => {
    const db = storage();
    expect((await jwtGet(application(db), path, actor([]))).status).toBe(403);
    noWrites(db);
  });
  it.each(['/inventory/items', '/mes/plans'])('read scope does not authorize writes at %s', async path => {
    const db = storage();
    expect((await request(application(db)).post(path).set('Authorization', `Bearer ${auth.signToken(actor())}`).send({})).status).toBe(403);
    noWrites(db);
  });
});

describe('Inventory legal reads retain quantities, row scope, and independent costs', () => {
  it('filters before pagination/count and does not overwrite search OR', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/items?limit=1&offset=1&search=stock');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((row: any) => row.id)).toEqual(['item-general']);
    expect(response.body.items[0]).toMatchObject({ quantity: 5, unitCost: null, currency: 'USD' });
    noWrites(db);
  });
  it('detail nested movements requires both actual item and actual known parent visibility', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/items/item-own');
    expect(response.status).toBe(200);
    expect(response.body.item).toMatchObject({ id: 'item-own', unitCost: null, quantity: '10' });
    expect(response.body.item.movements.map((row: any) => row.id)).toEqual(['movement-own', 'movement-unknown']);
    expect(response.body.item.movements[0].unitCost).toBeNull();
    expect(response.body.item.movements[1].referenceId).toBeNull();
    expect(db.state.inventoryItem.find(row => row.id === 'item-own').unitCost.toString()).toBe('7');
    noWrites(db);
  });
  it.each(['item-hidden', 'item-orphan', 'item-deleted-parent'])('guessing detail id %s cannot read an inaccessible parent', async id => {
    const db = storage();
    expect((await jwtGet(application(db), `/inventory/items/${id}`)).status).toBe(404);
    noWrites(db);
  });
  it('unassigned stock and warehouse masters remain legal without warehouse contents', async () => {
    const db = storage();
    const app = application(db);
    const detail = await jwtGet(app, '/inventory/items/item-general');
    expect(detail.status).toBe(200);
    expect(detail.body.item).toMatchObject({ orderId: null, quantity: 5, unitCost: null });
    const master = await jwtGet(app, '/inventory/warehouses');
    expect(master.status).toBe(200);
    expect(master.body.warehouses[0]).toMatchObject({ code: 'WH-PUBLIC' });
    expect(master.body.warehouses[0]).not.toHaveProperty('items');
    expect(master.body.warehouses[0]).not.toHaveProperty('inventoryItems');
    noWrites(db);
  });
  it('includeInactive exposes inactive warehouse metadata without resurrecting deleted warehouses', async () => {
    const db = storage();
    db.state.warehouse.push(
      { id: 'warehouse-inactive', code: 'WH-INACTIVE', isActive: false, deletedAt: null, createdAt: BigInt(1), sortOrder: 1 },
      { id: 'warehouse-deleted', code: 'WH-DELETED', isActive: false, deletedAt: BigInt(1), createdAt: BigInt(2), sortOrder: 2 },
    );
    const app = application(db);
    const normal = await jwtGet(app, '/inventory/warehouses');
    expect(normal.status).toBe(200);
    expect(normal.body.warehouses.map((row: any) => row.id)).toEqual(['warehouse']);
    const all = await jwtGet(app, '/inventory/warehouses?includeInactive=true');
    expect(all.status).toBe(200);
    expect(all.body.warehouses.map((row: any) => row.id)).toEqual(['warehouse', 'warehouse-inactive']);
    noWrites(db);
  });
  it('movement filter/count excludes a hidden item or a hidden known reference and masks unknown ids', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/movements?itemId=item-own&limit=1&offset=1');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items[0]).toMatchObject({ id: 'movement-unknown', referenceId: null, unitCost: null });
    noWrites(db);
  });
  it.each([
    ['PurchaseOrder', 'po-own', 'po-hidden', 'procurement:read'],
    ['MaterialReceipt', 'receipt-own', 'receipt-hidden', 'procurement:read'],
    ['Order', 'order-own', 'order-hidden', 'orders:read'],
    ['Shipment', 'shipment-own', 'shipment-hidden', 'shipments:read'],
    ['ProductionStage', 'stage-own', 'stage-hidden', 'production:read'],
  ])('known %s reference checks actual parent and module scope', async (type, own, hidden, scope) => {
    const db = storage();
    db.state.stockMovement = [
      { id: 'visible', itemId: 'item-own', referenceType: type, referenceId: own, createdAt: BigInt(1) },
      { id: 'invisible', itemId: 'item-own', referenceType: type, referenceId: hidden, createdAt: BigInt(2) },
    ];
    const app = application(db);
    const allowed = await jwtGet(app, '/inventory/movements');
    expect(allowed.status).toBe(200);
    expect(allowed.body.items.map((row: any) => row.id)).toEqual(['visible']);
    if (scope !== 'orders:read') {
      const forbidden = await jwtGet(app, '/inventory/movements', actor(readScopes.filter(value => value !== scope)));
      expect(forbidden.status).toBe(200);
      expect(forbidden.body).toMatchObject({ items: [], total: 0 });
    }
    noWrites(db);
  });
  it('historical L8 receipt IDs use the exact real receipt/line/PO parent before page and count', async () => {
    const db = storage();
    const movement = (id: string, receiptId: string, lineId: string) => ({
      id, itemId: 'item-general', warehouseId: 'warehouse', referenceType: 'PurchaseOrder', referenceId: receiptId,
      notes: `L8-source:${JSON.stringify({ receiptId, lineId, warehouseId: 'warehouse', quantity: 2, unit: 'YD' })}`,
      quantity: 2, unit: 'YD', createdAt: BigInt(id === 'legacy-own' ? 1 : 2),
    });
    db.state.stockMovement = [movement('legacy-own', 'receipt-own', 'purchase-line-own'), movement('legacy-hidden', 'receipt-hidden', 'purchase-line-hidden')];
    const response = await jwtGet(application(db), '/inventory/movements?limit=1');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((row: any) => row.id)).toEqual(['legacy-own']);
    const noProcurement = await jwtGet(application(db), '/inventory/movements', actor(readScopes.filter(scope => scope !== 'procurement:read')));
    expect(noProcurement.status).toBe(200); expect(noProcurement.body).toMatchObject({ items: [], total: 0 });
    noWrites(db);
  });
  it.each(['malformed', 'foreign-receipt', 'foreign-warehouse', 'foreign-line', 'missing-receipt', 'collision', 'deleted-collision', 'deleted-parent'] as const)(
    'historical L8 %s cannot reinterpret a source or obtain a new read grant', async variant => {
      const db = storage();
      const marker: any = { receiptId: 'receipt-own', lineId: 'purchase-line-own', warehouseId: 'warehouse', quantity: 2, unit: 'YD' };
      if (variant === 'foreign-receipt') marker.receiptId = 'receipt-hidden';
      if (variant === 'foreign-warehouse') marker.warehouseId = 'other-warehouse';
      if (variant === 'foreign-line') marker.lineId = 'purchase-line-hidden';
      if (variant === 'missing-receipt') db.state.materialReceipt = [];
      if (variant === 'collision' || variant === 'deleted-collision') db.state.purchaseOrder.push({
        id: 'receipt-own', orderId: 'order-own', deletedAt: variant === 'deleted-collision' ? BigInt(1) : null,
      });
      if (variant === 'deleted-parent') db.state.purchaseOrder[0].deletedAt = BigInt(1);
      db.state.stockMovement = [{ id: 'legacy-probe', itemId: 'item-general', warehouseId: 'warehouse', referenceType: 'PurchaseOrder',
        referenceId: 'receipt-own', notes: variant === 'malformed' ? 'L8-source:{invalid' : `L8-source:${JSON.stringify(marker)}`,
        quantity: 2, unit: 'YD', createdAt: BigInt(1) }];
      const response = await jwtGet(application(db), '/inventory/movements');
      expect(response.status).toBe(200); expect(response.body).toMatchObject({ items: [], total: 0 });
      noWrites(db);
    });
  it('Transfer follows real origin and refuses self/cycle/missing origin', async () => {
    const db = storage();
    db.state.stockMovement.push(
      { id: 'transfer-valid', itemId: 'item-general', referenceType: 'Transfer', referenceId: 'movement-own', createdAt: BigInt(1) },
      { id: 'transfer-self', itemId: 'item-own', referenceType: 'Transfer', referenceId: 'transfer-self', createdAt: BigInt(2) },
      { id: 'transfer-cycle-a', itemId: 'item-own', referenceType: 'Transfer', referenceId: 'transfer-cycle-b', createdAt: BigInt(3) },
      { id: 'transfer-cycle-b', itemId: 'item-own', referenceType: 'Transfer', referenceId: 'transfer-cycle-a', createdAt: BigInt(4) },
      { id: 'transfer-missing', itemId: 'item-own', referenceType: 'Transfer', referenceId: 'missing', createdAt: BigInt(5) },
    );
    const response = await jwtGet(application(db), '/inventory/movements');
    expect(response.status).toBe(200);
    expect(response.body.items.map((row: any) => row.id).sort()).toEqual(['movement-own', 'movement-unknown', 'transfer-valid']);
    noWrites(db);
  });
  it('ownership history filters from/to old document boundaries before its limit', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/items/item-own/ownership-history?limit=1');
    expect(response.status).toBe(200);
    expect(response.body.items.map((row: any) => row.id)).toEqual(['history-own']);
    expect(JSON.stringify(response.body)).not.toContain('private old order reason');
    noWrites(db);
  });
  it('by-order id gate rejects hidden order before fetching contents', async () => {
    const db = storage();
    const app = application(db);
    const denied = await jwtGet(app, '/inventory/by-order/order-hidden');
    expect(denied.status).toBe(404);
    expect(db.prisma.inventoryItem.findMany).not.toHaveBeenCalled();
    const legal = await jwtGet(app, '/inventory/by-order/order-own');
    expect(legal.status).toBe(200);
    expect(legal.body.items).toHaveLength(1);
    expect(legal.body.items[0].unitCost).toBeNull();
    noWrites(db);
  });
  it('low-stock alert excludes hidden anchors and retains business quantity', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/alerts/low-stock');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((row: any) => row.id).sort()).toEqual(['item-general', 'item-own']);
    expect(response.body.items.every((row: any) => row.unitCost === null)).toBe(true);
    noWrites(db);
  });
  it('ownership amount summary keeps currencies/units and masks amounts without inventing zero', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/summary-by-ownership');
    expect(response.status).toBe(200);
    expect(response.body.ourStock.itemCount).toBe(2);
    expect(response.body.ourStock.quantityByUnit).toEqual([{ unit: 'PC', quantity: 5 }, { unit: 'YD', quantity: 10 }]);
    expect(response.body.ourStock.valueByCurrency).toEqual([{ currency: 'CNY', value: null }, { currency: 'USD', value: null }]);
    noWrites(db);
  });
  it.each(['/summary-by-ownership', '/dye-lot-stock', '/by-order/order-own', '/items/item-own/ownership-history'])('retains existing inventory:read report gate %s', async path => {
    const db = storage();
    const response = await jwtGet(application(db), `/inventory${path}`, actor(['orders:read']));
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('inventory:read');
    noWrites(db);
  });
  it('XLSX export filters full data first and masks cost before workbook creation', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/items?format=xlsx&limit=1').buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    const workbook = XLSX.read(response.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
    expect(rows.slice(1).map(row => row[0]).sort()).toEqual(['M-GENERAL', 'M-OWN']);
    expect(rows.slice(1).every(row => row[11] === null)).toBe(true);
    noWrites(db);
  });
  it('legitimate cost grant exposes actual amounts while current row scope still applies', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/summary-by-ownership', actor([...readScopes, 'sensitive:cost']));
    expect(response.status).toBe(200);
    expect(response.body.ourStock.itemCount).toBe(2);
    expect(response.body.ourStock.valueByCurrency).toEqual([{ currency: 'CNY', value: 70 }, { currency: 'USD', value: 15 }]);
    noWrites(db);
  });
  it('bound owner API key cannot bypass its sensitive-cost ceiling', async () => {
    const db = storage();
    db.state.userAccount[0].roles[0].roleId = SYSTEM_ROLE_IDS.SUPER_ADMIN;
    db.state.userAccount[0].roles[0].role.id = SYSTEM_ROLE_IDS.SUPER_ADMIN;
    const principal = actor([], { roles: ['owner'], permissionCeiling: ['orders:read', 'inventory:read'] });
    const app = application(db, { keyActor: principal });
    const response = await request(app).get('/inventory/items').set('X-Bambook-API-Key', KEY);
    expect(response.status).toBe(200);
    expect(response.body.items.some((row: any) => row.id === 'item-hidden')).toBe(true); // actual all-role row contract
    expect(response.body.items.every((row: any) => row.unitCost === null)).toBe(true);
    expect(response.body.items.some((row: any) => row.id === 'item-orphan')).toBe(false);
    noWrites(db);
  });
  it('dye-lot risk cannot be sourced from a hidden order or hidden customer lab dip', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/dye-lot-stock');
    expect(response.status).toBe(200);
    expect(response.body.lots).toHaveLength(2);
    expect(response.body.lots.every((row: any) => row.colorRating === 4 && row.risk === 'low')).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    noWrites(db);
  });
  it('orders/inventory read does not grant development lab-dip capability', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/inventory/dye-lot-stock', actor(['orders:read', 'inventory:read']));
    expect(response.status).toBe(200);
    expect(response.body.lots.find((row: any) => row.lot === 'LOT-BULK')).toMatchObject({ registered: true, colorRating: 4 });
    expect(response.body.lots.find((row: any) => row.lot === 'LOT-LAB')).toMatchObject({ registered: false, risk: 'unknown', colorRating: null });
    noWrites(db);
  });
  it('unassigned case uses true all-scope access rather than its free-text owner', async () => {
    const db = storage();
    db.state.sampleColorBatch = [{ id: 'general-lab', stage: 'lab_dip', developmentCaseId: 'case-general', orderId: null, dyeLotNo: 'LOT-LAB', colorRating: 4, deletedAt: null, createdAt: BigInt(1) }];
    const app = application(db);
    const limited = await jwtGet(app, '/inventory/dye-lot-stock');
    expect(limited.body.lots.find((row: any) => row.lot === 'LOT-LAB').registered).toBe(false);
    db.state.userAccount[0].roles[0].roleId = SYSTEM_ROLE_IDS.FINANCE;
    db.state.userAccount[0].roles[0].role.id = SYSTEM_ROLE_IDS.FINANCE;
    const all = await jwtGet(app, '/inventory/dye-lot-stock', actor(readScopes, { roles: ['finance'] }));
    expect(all.status).toBe(200);
    expect(all.body.lots.find((row: any) => row.lot === 'LOT-LAB').registered).toBe(true);
    noWrites(db);
  });
});

describe('MES read rows and aggregates follow order anchors', () => {
  it('dateTo alone and both date bounds retain range meaning and current row scope', async () => {
    const db = storage();
    const app = application(db);
    for (const query of ['dateTo=2026-10-01', 'dateFrom=2026-10-01&dateTo=2026-10-01']) {
      const response = await jwtGet(app, `/mes/plans?${query}`);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      expect(response.body.items.map((row: any) => row.id)).toEqual(['plan-own', 'plan-general']);
    }
    const before = await jwtGet(app, '/mes/plans?dateTo=2026-09-30');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ items: [], total: 0 });
    const after = await jwtGet(app, '/mes/plans?dateFrom=2026-10-02&dateTo=2026-10-02');
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ items: [], total: 0 });
    noWrites(db);
  });
  it('plan list scopes before count/page and direct hidden id is refused', async () => {
    const db = storage();
    const app = application(db);
    const list = await jwtGet(app, '/mes/plans?limit=1&offset=1');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((row: any) => row.id)).toEqual(['plan-general']);
    expect((await jwtGet(app, '/mes/plans/plan-hidden')).status).toBe(404);
    const own = await jwtGet(app, '/mes/plans/plan-own');
    expect(own.status).toBe(200);
    expect(own.body.item.workHours.map((row: any) => row.id)).toEqual(['hour-own']);
    noWrites(db);
  });
  it('station detail and utilization cannot include inaccessible production-plan quantities', async () => {
    const db = storage();
    const app = application(db);
    const detail = await jwtGet(app, '/mes/work-stations/station');
    expect(detail.status).toBe(200);
    expect(detail.body.item.productionPlans.map((row: any) => row.id)).toEqual(['plan-own', 'plan-general']);
    const utilization = await jwtGet(app, '/mes/work-stations/station/utilization?startDate=2026-10-01&endDate=2026-10-01');
    expect(utilization.status).toBe(200);
    expect(utilization.body.utilization).toMatchObject({ plannedQty: 30, capacity: 100, utilization: 0.3 });
    noWrites(db);
  });
  it('work-hour list and summary exclude hidden and deleted parent plans', async () => {
    const db = storage();
    const app = application(db);
    const list = await jwtGet(app, '/mes/work-hours');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1 });
    expect(list.body.items.map((row: any) => row.id)).toEqual(['hour-own']);
    const summary = await jwtGet(app, '/mes/work-hours/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toEqual([{ employeeId: 'worker-own', employeeName: 'Worker', totalHours: 8, totalOvertime: 1 }]);
    noWrites(db);
  });
  it('plan XLSX export cannot bypass list row scope', async () => {
    const db = storage();
    const response = await jwtGet(application(db), '/mes/plans?format=xlsx').buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    const workbook = XLSX.read(response.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
    expect(rows.slice(1).map(row => row[0])).toEqual(['PP-OWN', 'PP-GENERAL']);
    noWrites(db);
  });
  it('outsourcing list/detail masks nested price/amount and preserves general business quantities', async () => {
    const db = storage();
    const app = application(db);
    const list = await jwtGet(app, '/mes/outsourcing');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((row: any) => row.id)).toEqual(['outsourcing-own', 'outsourcing-general']);
    expect(list.body.items[0]).toMatchObject({ quantity: 4, unitPrice: null, totalAmount: null, lines: [{ quantity: 4, unitPrice: null, amount: null }] });
    expect((await jwtGet(app, '/mes/outsourcing/outsourcing-hidden')).status).toBe(404);
    const general = await jwtGet(app, '/mes/outsourcing/outsourcing-general');
    expect(general.status).toBe(200);
    expect(general.body.item).toMatchObject({ orderId: null, quantity: 1, totalAmount: null });
    const cost = await jwtGet(app, '/mes/outsourcing/outsourcing-own', actor([...readScopes, 'sensitive:cost']));
    expect(cost.body.item).toMatchObject({ unitPrice: 7, totalAmount: 28, lines: [{ unitPrice: 7, amount: 28 }] });
    noWrites(db);
  });
  it('process-chain id gate and summary mask cannot be bypassed with guessed order query', async () => {
    const db = storage();
    const app = application(db);
    const hidden = await jwtGet(app, '/mes/order-processes?orderId=order-hidden');
    expect(hidden.status).toBe(404);
    expect(db.prisma.orderProcessNode.findMany).not.toHaveBeenCalled();
    const own = await jwtGet(app, '/mes/order-processes?orderId=order-own');
    expect(own.status).toBe(200);
    expect(own.body.nodes[0]).toMatchObject({ inputQty: 20, outputQty: 19, unitPrice: null, amount: null });
    expect(own.body.summary).toMatchObject({ total: 1, cumulativeLossPct: 5, totalAmount: null, byType: [{ type: 'gray_fabric', amount: null }] });
    noWrites(db);
  });
  it.each([['production:read'], ['production:read', 'sensitive:salary'], ['production:read', 'hr:salary:read'], ['production:read', 'hr:read', 'sensitive:cost']].map(scopes => ({ scopes })))('salary records and summaries require both salary scopes: $scopes', async ({ scopes }) => {
    const db = storage();
    const app = application(db);
    for (const path of ['/mes/piece-rate-records', '/mes/piece-rate-records/summary']) {
      const response = await jwtGet(app, path, actor(scopes));
      expect(response.status).toBe(403);
      expect(response.body.message).toContain('hr:salary:read');
      expect(response.body.message).toContain('sensitive:salary');
    }
    expect(db.prisma.pieceRateRecord.findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
  it('salary dual-key positive still applies actual parent rows before wage summaries', async () => {
    const db = storage();
    const app = application(db);
    const subject = actor([...readScopes, ...payScopes]);
    const list = await jwtGet(app, '/mes/piece-rate-records', subject);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items).toMatchObject([{ id: 'pay-own', amount: 12, employeeName: 'Worker' }]);
    const summary = await jwtGet(app, '/mes/piece-rate-records/summary', subject);
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toEqual([{ employeeId: 'worker-own', employeeName: 'Worker', totalAmount: 12, pendingAmount: 12, confirmedAmount: 0, paidAmount: 0 }]);
    noWrites(db);
  });
  it('piece-rate rule metadata stays readable but payroll rate needs dual-key', async () => {
    const db = storage();
    const app = application(db);
    const masked = await jwtGet(app, '/mes/piece-rate-rules');
    expect(masked.status).toBe(200);
    expect(masked.body.items[0]).toMatchObject({ code: 'RULE', processType: 'Cutting', ratePerUnit: null });
    const allowed = await jwtGet(app, '/mes/piece-rate-rules', actor([...readScopes, ...payScopes]));
    expect(allowed.body.items[0].ratePerUnit).toBe('3');
    noWrites(db);
  });
  it('limited owner API key cannot recover cost or salary through technical owner shortcut', async () => {
    const db = storage();
    const app = application(db, { keyActor: actor([], { roles: ['owner'], permissionCeiling: ['production:read'] }) });
    const cost = await request(app).get('/mes/outsourcing/outsourcing-own').set('X-Bambook-API-Key', KEY);
    expect(cost.status).toBe(200);
    expect(cost.body.item).toMatchObject({ unitPrice: null, totalAmount: null });
    const pay = await request(app).get('/mes/piece-rate-records').set('X-Bambook-API-Key', KEY);
    expect(pay.status).toBe(403);
    const rules = await request(app).get('/mes/piece-rate-rules').set('X-Bambook-API-Key', KEY);
    expect(rules.status).toBe(200);
    expect(rules.body.items[0].ratePerUnit).toBeNull();
    expect(db.prisma.pieceRateRecord.findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
  it('source query failure returns failure without recovering default/all-role rows', async () => {
    const db = storage();
    db.prisma.order.findMany.mockRejectedValueOnce(new Error('synthetic scope storage fault'));
    const response = await jwtGet(application(db), '/mes/plans');
    expect(response.status).toBe(500);
    expect(db.prisma.productionPlan.findMany).not.toHaveBeenCalled();
    noWrites(db);
  });
});

describe('Operational reader helpers keep absent actors and source objects bounded', () => {
  it('absent actor is not a general stock grant unless server explicitly permits development reads', async () => {
    const db = storage();
    const absent = createOperationalReadAccess(db.prisma, null);
    expect(await absent.orderWhere(true)).toEqual({ id: { in: [] } });
    expect(await absent.canReadInventoryItem('item-general')).toBe(false);
    const development = createOperationalReadAccess(db.prisma, null, true);
    expect(await development.canReadInventoryItem('item-general')).toBe(true);
    expect(await development.canReadOrder('order-hidden')).toBe(true);
    noWrites(db);
  });
  it('cost mask keeps Decimal/BigInt and original nested records intact, missing value stays null', () => {
    const source = { id: 'row', quantity: new Prisma.Decimal(12), unitCost: new Prisma.Decimal(7), nested: { amount: null, at: BigInt(1) } };
    const output = maskOperationalRead(source, actor());
    expect(output.unitCost).toBeNull();
    expect(output.quantity).toBe(source.quantity);
    expect(output.nested).toEqual({ amount: null, at: BigInt(1) });
    expect(source.unitCost.toString()).toBe('7');
    expect(maskOperationalRead(source, actor([], { roles: ['owner'], permissionCeiling: ['orders:read'] })).unitCost).toBeNull();
  });
});
