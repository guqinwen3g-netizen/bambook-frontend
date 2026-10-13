/** Actual shipping carrier controls in a fresh identity-verified private PG.
 * Business producers/HTTP/tool handlers/approval/stock are never mocked. Faults
 * are injected only at native storage delegates, while native transactions run. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createShippingRouter } from '../src/shipping/route';
import { createShipment, updateShipment, deleteShipment } from '../src/shipping/shipmentMutationService';
import { handleShippingCreateShipment } from '../src/agent/toolRuntime';
import { businessError, httpStatusOfCode } from '../src/shared/errorCodes';
import { CreditExceptionConsumptionError } from '../src/credit/creditExceptionGate';
import { InventoryStockInsufficientError } from '../src/inventory/inventoryService';
import { createApprovalDecisionService } from '../src/approvals/approvalDecisionService';
import { SHORT_SHIP_APPROVAL_ACTION, evaluateShortShipment } from '../src/shipping/shortShipmentGate';

const prefix = 'shipping-carrier-native-' + randomUUID();
const privateFault = 'SQL private table /internal/path DO_NOT_DISCLOSE_' + prefix;
const safeFailure = '出运操作未能完成，请刷新核对当前记录后重试。';
const auth = createAuthService();
let prisma: PrismaClient, actor: TokenPayload, reviewerId: string, sequence = 0;
const next = () => prefix + '-' + (++sequence);

beforeAll(async () => {
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!url || !sandbox || !name || !directory || !port) throw Error('Explicit new private PostgreSQL identity required');
  const parsed = new URL(url);
  expect(parsed.protocol).toBe('postgresql:'); expect(parsed.hostname).toBe('127.0.0.1');
  expect(parsed.pathname).toBe('/' + name); expect(parsed.port).toBe(port);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) expect(process.env[key]).toBeUndefined();
  prisma = new PrismaClient({ datasources: { db: { url } } });
  expect(await prisma.$queryRaw<any[]>`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  const departmentId = next(), userId = next(); reviewerId = next();
  await prisma.department.create({ data: { id: departmentId, name: 'Synthetic shipping private department' } });
  await prisma.userAccount.create({ data: { id: reviewerId, displayName: 'Synthetic assigned reviewer', status: 'active', primaryDeptId: departmentId } });
  await prisma.department.update({ where: { id: departmentId }, data: { headId: reviewerId } });
  await prisma.userAccount.create({ data: { id: userId, displayName: 'Synthetic shipping operator', status: 'active', primaryDeptId: departmentId } });
  await prisma.role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Synthetic technical owner', isSystem: true } });
  await prisma.userRole.create({ data: { id: next(), userId, roleId: 'role-super-admin', departmentId } });
  for (const scope of ['orders:read', 'shipments:read', 'shipments:write']) {
    await prisma.userPermissionOverrides.create({ data: { id: next(), userId, scope, grantedBy: reviewerId, reason: 'Synthetic private actual current permission' } });
  }
  actor = await buildLoadedAuthTokenPayload(prisma, await loadUserWithRoles(prisma, userId));
});
afterAll(async () => { await prisma?.$disconnect(); });

/** The actual Prisma callback transaction still supplies native locks/CAS and
 * rollback. Only a named delegate call can fail; nothing replaces a producer. */
function storageFault(model: string, operation: string, produce: () => Error) {
  const state = { hits: 0, mutationRolledBack: false, approvalsOutsideTransaction: 0 };
  const wrap = (target: any, inTransaction: boolean): any => new Proxy(target, {
    get(db, key) {
      if (key === '$transaction' && !inTransaction) return async (callback: any, options: any) => {
        try { return await prisma.$transaction(async tx => callback(wrap(tx, true)), options); }
        catch (error) { state.mutationRolledBack = true; throw error; }
      };
      const delegate = Reflect.get(db, key);
      if (typeof delegate === 'function') return delegate.bind(db);
      if (delegate && typeof delegate === 'object') return new Proxy(delegate, {
        get(value, method) {
          const native = Reflect.get(value, method);
          if (typeof native !== 'function') return native;
          return async (...args: any[]) => {
            if (key === 'approvalRequest' && method === 'create') {
              expect(inTransaction).toBe(false); expect(state.mutationRolledBack).toBe(true);
              state.approvalsOutsideTransaction += 1;
            }
            if (key === model && method === operation) { state.hits += 1; throw produce(); }
            return native.apply(value, args);
          };
        },
      });
      return delegate;
    },
  });
  return { db: wrap(prisma, false) as PrismaClient, state };
}

function http(db = prisma) {
  const application = express(); application.use(express.json());
  application.use('/api', createAuthorizationSnapshotGuard({ prisma: db }));
  application.use('/api/v1/shipping', createShippingRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), exceptionChecker: null }));
  return application;
}
const authorization = () => 'Bearer ' + auth.signToken(actor);
const toolContext = () => ({ actor: { userId: actor.userId, roles: actor.roles, departmentIds: actor.departmentIds,
  permissionCeiling: actor.permissionCeiling, permissionScopes: actor.permissions, permissionsAuthoritative: true } }) as any;
const input = () => ({ id: next(), shipmentNumber: next(), type: 'Export', status: 'Booked', shippingMethod: 'Courier', trackingNumber: 'SYNTHETIC-TRACKING' });

async function fixture(options: { type?: string; actual?: number | null; allocation?: boolean; contract?: number; status?: string; stock?: number } = {}) {
  const id = next(), now = BigInt(Date.now()), quantity = options.contract ?? 100;
  const order = await prisma.order.create({ data: { id: id + '-order', customer: 'Synthetic buyer', product: 'Synthetic private product',
    type: options.type ?? 'Other', businessLine: options.type === 'Garment' ? 'garment' : 'other', quantity,
    status: options.status ?? 'Confirmed', dueDate: '2030-01-01', quoteAmount: 100, ownerId: actor.userId } });
  const line = await prisma.orderLine.create({ data: { id: id + '-line', orderId: order.id, lineNumber: 1, itemNo: id + '-sku',
    materialCode: id + '-sku', quantity, unit: 'M', shipmentQuantity: options.actual ?? quantity, tolerancePercent: 0 } });
  const shipment = await prisma.shipment.create({ data: { ...input(), id: id + '-shipment', orderId: order.id, createdAt: now, updatedAt: now } });
  let allocation: any;
  if (options.allocation !== false) allocation = await prisma.shipmentOrderAllocation.create({ data: { id: id + '-allocation',
    shipmentId: shipment.id, orderId: order.id, orderLineId: line.id, plannedQty: quantity,
    actualQty: options.actual === null ? null : options.actual ?? quantity, unit: 'M', status: 'Planned', createdAt: now, updatedAt: now } });
  let item: any;
  if (options.stock !== undefined) {
    await prisma.shipmentLine.create({ data: { id: id + '-packing', shipmentId: shipment.id, orderLineId: line.id, lineNumber: 1,
      productCode: line.materialCode, quantity: options.actual ?? quantity, unit: 'M', createdAt: now, updatedAt: now } });
    const warehouse = await prisma.warehouse.create({ data: { id: id + '-warehouse', code: id, name: 'Synthetic private warehouse',
      type: 'Main', isActive: true, createdAt: now, updatedAt: now } });
    item = await prisma.inventoryItem.create({ data: { id: id + '-stock', warehouseId: warehouse.id, materialCode: line.materialCode,
      description: 'Synthetic exact stock', quantity: options.stock, lockedQuantity: 0, unit: 'M', createdAt: now, updatedAt: now } });
  }
  return { order, line, shipment, allocation, item };
}
async function stillBooked(item: Awaited<ReturnType<typeof fixture>>) {
  expect((await prisma.shipment.findUniqueOrThrow({ where: { id: item.shipment.id } })).status).toBe('Booked');
  expect(await prisma.shipmentEvent.count({ where: { shipmentId: item.shipment.id } })).toBe(0);
  expect(await prisma.stockMovement.count({ where: { referenceType: 'Shipment', referenceId: item.shipment.id } })).toBe(0);
}
const ship = (item: Awaited<ReturnType<typeof fixture>>, db = prisma) => updateShipment({ prisma: db, shipmentId: item.shipment.id,
  patch: { status: 'Shipped' }, hasStatus: true, actorId: actor.userId, actor, exceptionChecker: null });

describe('actual shipping public carrier and native contracts', () => {
  it.each(['ORDER_NOT_FOUND', 'GATE_BLOCKED', 'STOCK_INSUFFICIENT', 'P2010'])('ordinary storage fault %s never acquires a public business message or details through service HTTP or actual tool handler', async code => {
    const { db, state } = storageFault('shipment', 'create', () => Object.assign(new Error(privateFault), { code,
      gateDetails: { privateSQL: privateFault }, shortShipDetails: { blocked: [{ orderLineId: privateFault }] }, metadata: privateFault }));
    const first = input(), service = await createShipment({ prisma: db, input: first, actorId: actor.userId, actor });
    const response = await request(http(db)).post('/api/v1/shipping').set('Authorization', authorization()).send(input());
    const tool = await handleShippingCreateShipment(db, input(), toolContext());
    expect.soft(service).toEqual({ ok: false, error: { code: 'CREATE_FAILED', message: safeFailure } });
    expect.soft(response.status).toBe(500); expect.soft(response.body).toEqual({ error: { code: 'CREATE_FAILED', message: safeFailure } });
    expect.soft(tool).toEqual({ ok: false, error: 'CREATE_FAILED', message: safeFailure, gateDetails: null, dataSource: 'bambook-data-center' });
    expect.soft(JSON.stringify({ service, body: response.body, tool })).not.toContain(privateFault);
    expect(state.hits).toBe(3); expect(await prisma.shipment.count({ where: { id: first.id } })).toBe(0);
  });

  it.each(['update', 'delete'])('actual %s storage failure with a known code keeps its operation fallback and native record', async operation => {
    const item = await fixture(), { db, state } = storageFault('shipment', 'findUnique', () => Object.assign(new Error(privateFault), { code: 'ORDER_NOT_FOUND' }));
    const result = operation === 'update' ? await ship(item, db) : await deleteShipment({ prisma: db, shipmentId: item.shipment.id, actorId: actor.userId, actor });
    expect(result).toEqual({ ok: false, error: { code: operation === 'update' ? 'UPDATE_FAILED' : 'DELETE_FAILED', message: safeFailure } });
    expect(state.hits).toBe(1); await stillBooked(item);
  });

  it.each([
    ['businessError', () => businessError('INVALID_STATE', '真实业务拒绝，原领域文案')],
    ['CreditExceptionConsumptionError', () => new CreditExceptionConsumptionError('EXCEPTION_CONSUME_CONFLICT', '真实信用例外次数已变化')],
    ['InventoryStockInsufficientError', () => new InventoryStockInsufficientError('真实可用库存不足')],
  ] as const)('actual recognized %s constructor keeps its exact code message and registry status through the carrier', async (_name, produce) => {
    const original = produce(), { db, state } = storageFault('shipment', 'create', produce);
    const result = await createShipment({ prisma: db, input: input(), actorId: actor.userId, actor });
    expect(result).toEqual({ ok: false, error: { code: original.code, message: original.message, statusCode: original.statusCode } });
    expect(state.hits).toBe(1);
  });

  it('actual native terminal order preserves ORDER_TERMINAL and exact business message/status without committing shipment, linkage or audit', async () => {
    const item = await fixture({ status: 'Delivered' }), values = { ...input(), orderId: item.order.id };
    const result = await createShipment({ prisma, input: values, actorId: actor.userId, actor });
    expect(result.ok).toBe(false); expect(result.error).toEqual({ code: 'ORDER_TERMINAL',
      message: `order ${item.order.id} is in terminal status 'Delivered', cannot be changed by shipment link`, statusCode: 400 });
    expect(await prisma.shipment.count({ where: { id: values.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { targetType: 'Shipment', targetId: values.id } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: item.order.id } })).status).toBe('Delivered');
  });

  it('actual garment release gate keeps native per-order gateDetails in service and nested HTTP contract without creating approval or dispatch facts', async () => {
    const item = await fixture({ type: 'Garment' }), result = await ship(item);
    expect(result.error?.code).toBe('GATE_BLOCKED'); expect(result.error?.statusCode).toBe(409);
    expect(result.error?.gateDetails?.orders).toEqual([expect.objectContaining({ orderId: item.order.id, eligible: false, chain: 'garment' })]);
    expect(result.error?.gateDetails?.blockingReasons.length).toBeGreaterThan(0);
    const response = await request(http()).patch('/api/v1/shipping/' + item.shipment.id).set('Authorization', authorization()).send({ status: 'Shipped' });
    expect(response.status).toBe(409); expect(response.body.error).toEqual(result.error);
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message', 'statusCode', 'gateDetails'].sort());
    expect(await prisma.approvalRequest.count({ where: { targetId: item.line.id } })).toBe(0); await stillBooked(item);
  });

  it.each(['no allocation', 'actual quantity missing'])('actual %s constructor retains shortShipDetails and 409 but never requests a customer exception', async mode => {
    const item = await fixture(mode === 'no allocation' ? { allocation: false } : { actual: null }), result = await ship(item);
    const code = mode === 'no allocation' ? 'SHIPMENT_NO_ALLOCATION_DETAIL' : 'SHIPMENT_ACTUAL_QTY_MISSING';
    expect(result.error?.code).toBe(code); expect(result.error?.statusCode).toBe(httpStatusOfCode(code));
    expect(result.error?.shortShipDetails).toEqual(mode === 'no allocation' ? { unfilled: [], noAllocationDetail: true }
      : { unfilled: [{ orderLineId: item.line.id, orderId: item.order.id, itemNo: item.line.itemNo, unfilledCount: 1, allocationCount: 1 }] });
    expect(await prisma.approvalRequest.count({ where: { targetId: item.line.id } })).toBe(0); await stillBooked(item);
  });

  it('ordinary forged short code and blocked metadata never create a real approval or expose a fake short envelope', async () => {
    const item = await fixture(), { db, state } = storageFault('shipment', 'findUnique', () => Object.assign(new Error(privateFault), {
      code: 'ORDER_LINE_SHORT_SHIPPED', shortShipDetails: { blocked: [{ orderLineId: item.line.id, orderId: item.order.id, itemNo: item.line.itemNo,
        contractQty: 100, shippedQty: 80, allowedMin: 100, shortage: 20, tolerancePct: 0, toleranceSource: 'manual', notices: [], privateSQL: privateFault }] } }));
    const result = await ship(item, db);
    expect.soft(result).toEqual({ ok: false, error: { code: 'UPDATE_FAILED', message: safeFailure } });
    expect.soft(state.approvalsOutsideTransaction).toBe(0); expect.soft(await prisma.approvalRequest.count({ where: { targetId: item.line.id } })).toBe(0); await stillBooked(item);
  });

  it('real short-shipment helper approval storage SQL failure stays blocked with safe approvalError and the actual blocked facts', async () => {
    const item = await fixture({ actual: 80 }), { db, state } = storageFault('approvalRequest', 'create', () => new Error(privateFault));
    const originalBlocked = (await evaluateShortShipment(prisma, { shipmentId: item.shipment.id })).blocked;
    expect(originalBlocked).toEqual([expect.objectContaining({ orderLineId: item.line.id, shippedQty: 80 })]);
    expect(originalBlocked[0].shortage).toBeGreaterThan(0);
    const result = await ship(item, db);
    expect(result.error?.code).toBe('ORDER_LINE_SHORT_SHIPPED'); expect(result.error?.statusCode).toBe(409);
    expect(result.error?.shortShipDetails?.blocked).toEqual(originalBlocked);
    expect(result.error?.shortShipDetails?.approvalRequestIds).toEqual([]);
    expect(result.error?.shortShipDetails?.approvalError).toBe('短装确认单发起失败，原因已记入服务端日志；请联系管理员核对后重试。');
    expect(JSON.stringify(result)).not.toContain(privateFault); expect(state.hits).toBe(1); expect(state.approvalsOutsideTransaction).toBe(1);
    expect(await prisma.approvalRequest.count({ where: { targetId: item.line.id } })).toBe(0); await stillBooked(item);
  });

  it('real native blocked short-shipment creates one assigned approval after rollback, keeps pending retry IDs, and only dispatches after the actual assigned reviewer approves', async () => {
    const item = await fixture({ actual: 80 }), { db, state } = storageFault('__none__', '__none__', () => new Error('Unreachable injection'));
    const first = await ship(item, db), retry = await ship(item, db);
    expect(first.error?.code).toBe('ORDER_LINE_SHORT_SHIPPED'); expect(first.error?.statusCode).toBe(409);
    expect(first.error?.shortShipDetails?.blocked).toEqual([expect.objectContaining({ orderLineId: item.line.id, shippedQty: 80 })]);
    const ids = first.error?.shortShipDetails?.approvalRequestIds; expect(ids).toHaveLength(1);
    expect(retry.error?.shortShipDetails?.approvalRequestIds).toEqual(ids); expect(first.error?.shortShipDetails?.approvalError).toBeUndefined();
    expect(state.approvalsOutsideTransaction).toBe(1); await stillBooked(item);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: ids![0] } });
    expect(approval).toMatchObject({ status: 'pending', actionType: SHORT_SHIP_APPROVAL_ACTION, targetType: 'OrderLine', targetId: item.line.id,
      requesterId: actor.userId, reviewerId });
    await createApprovalDecisionService(prisma).decide({ id: approval.id, actor: { userId: reviewerId, roles: [] }, decision: 'approved',
      source: 'api:approvals-kernel', decisionNote: 'Synthetic actual customer agreed short-shipment control' });
    const committed = await ship(item); expect(committed.ok).toBe(true);
    expect((await prisma.shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.allocation.id } })).status).toBe('ShortShipped');
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: item.shipment.id } })).status).toBe('Shipped');
  });

  it('real insufficient native inventory keeps typed conflict and rolls back the dispatch with no partial stock or event facts', async () => {
    const item = await fixture({ stock: 50 }), result = await ship(item);
    expect(result.error?.code).toBe('STOCK_INSUFFICIENT'); expect(result.error?.statusCode).toBe(httpStatusOfCode('STOCK_INSUFFICIENT'));
    expect(result.error?.message).toContain('当前可用 50 M');
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.item.id } })).quantity.toString()).toBe('50'); await stillBooked(item);
  });

  it('actual stock dispatch retry and cancellation retain one original Outbound plus one Inbound and exact restored balance', async () => {
    const item = await fixture({ stock: 200 }); expect((await ship(item)).ok).toBe(true); expect((await ship(item)).ok).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.item.id } })).quantity.toString()).toBe('100');
    const cancel = () => updateShipment({ prisma, shipmentId: item.shipment.id, patch: { status: 'Cancelled' }, hasStatus: true, actorId: actor.userId, actor });
    expect((await cancel()).ok).toBe(true); expect((await cancel()).ok).toBe(true);
    const rows = await prisma.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: item.shipment.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map(row => row.type)).toEqual(['Outbound', 'Inbound']); expect(rows.map(row => row.quantity.toString())).toEqual(['100', '100']);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.item.id } })).quantity.toString()).toBe('200');
  });
});
