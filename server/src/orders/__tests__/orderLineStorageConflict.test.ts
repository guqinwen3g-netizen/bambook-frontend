/** Typed storage-error contract only. Actual metadata constructors are used,
 * but no DB is connected: the isolated real-PG concurrency/rollback probes
 * remain necessary. Permission loaders/guards run; only storage is substituted.
 */
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import { lookupErrorCode, GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/errorCodes';
import { authorizeOrderLineWrite, lockedOrderLine, isOrderLineStorageConflict, orderLineWriteFailure, OrderLineWriteError } from '../orderLineWriteAccess';
import { createOrderLine } from '../orderLineMutationService';

const secret = 'SQL path and driver details must never become a public message';
function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(secret, { code, clientVersion: Prisma.prismaVersion.client, meta });
}
const prior: TokenPayload = { userId: 'u_actual_order_line_storage', roles: [], permissions: [], departmentIds: [] };
function storage() {
  const order = { id: 'O_actual_storage', customer: 'Synthetic current customer', type: 'fabric', status: 'Pending', deletedAt: null };
  const user = { id: prior.userId, status: 'active', deletedAt: null,
    roles: [{ roleId: 'role-admin', role: { id: 'role-admin', permissions: [{ permission: { scope: 'orders:write' } }] } }] };
  const tx: any = {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    approvalRequest: { findFirst: vi.fn(async () => null) },
    order: { findFirst: vi.fn(async () => order) },
    fabricCustomerCode: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: order.id }]),
    orderLine: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(async ({ data }: any) => data) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})) }, auditLog: { create: vi.fn(async () => ({})) },
  };
  const client: any = { $transaction: vi.fn(async (work: any) => work(tx)) };
  return { tx, client, order };
}
describe('OrderLine structured storage conflict and public error contract', () => {
  it.each(['40001', '40P01'])('actual raw-query SQLSTATE %s is a safe existing CONFLICT', sqlState => {
    const error = known('P2010', { code: sqlState }); expect(isOrderLineStorageConflict(error)).toBe(true);
    expect(orderLineWriteFailure(error)).toEqual({ code: 'CONFLICT', message: lookupErrorCode('CONFLICT')!.message });
    expect(JSON.stringify(orderLineWriteFailure(error))).not.toContain(secret);
  });
  it('normal P2034 and the existing internal-storage mock seam retain safe CONFLICT', () => {
    expect(orderLineWriteFailure(known('P2034'))?.code).toBe('CONFLICT');
    expect(orderLineWriteFailure(Object.assign(new Error(secret), { code: 'P2034' }))?.code).toBe('CONFLICT');
  });
  it.each(['23505', '42501', '42P01'])('unrelated actual raw-query SQLSTATE %s is not reclassified as a concurrency conflict', sqlState => {
    const error = known('P2010', { code: sqlState }); expect(isOrderLineStorageConflict(error)).toBe(false); expect(orderLineWriteFailure(error)).toBeNull();
  });
  it('a message substring or arbitrary error metadata cannot create a trusted SQL conflict', () => {
    expect(isOrderLineStorageConflict(new Error('could not serialize access due to concurrent update'))).toBe(false);
    expect(isOrderLineStorageConflict(known('P2010'))).toBe(false);
    expect(isOrderLineStorageConflict({ code: 'P2010', meta: { code: '40001' }, message: secret })).toBe(false);
    expect(isOrderLineStorageConflict(known('P2002', { code: '40001', target: ['id'] }))).toBe(false);
  });
  it('typed business errors use their registered public copy, never a caught message', () => {
    expect(orderLineWriteFailure(new OrderLineWriteError('FORBIDDEN', secret))).toEqual({ code: 'FORBIDDEN', message: lookupErrorCode('FORBIDDEN')!.message });
  });
  describe.each(['Order', 'OrderLine'])('%s row-lock boundary', target => {
    it.each(['40001', '40P01'])('actual SQLSTATE %s is wrapped as a typed central 409 before subsequent row mutation', async sqlState => {
      const f = storage(); f.tx.$queryRaw.mockRejectedValue(known('P2010', { code: sqlState }));
      const work = target === 'Order' ? authorizeOrderLineWrite(f.tx, f.order.id, prior, 'create') : lockedOrderLine(f.tx, 'L_actual_storage', f.order.id);
      await expect(work).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409, message: lookupErrorCode('CONFLICT')!.message });
      expect(f.tx.orderLine.findUnique).not.toHaveBeenCalled(); expect(f.tx.orderLine.create).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    });
    it('unrelated SQL fault remains an unknown failure for the safe route/service adapter', async () => {
      const f = storage(), error = known('P2010', { code: '42501' }); f.tx.$queryRaw.mockRejectedValue(error);
      const work = target === 'Order' ? authorizeOrderLineWrite(f.tx, f.order.id, prior, 'create') : lockedOrderLine(f.tx, 'L_actual_storage', f.order.id);
      await expect(work).rejects.toBe(error); expect(orderLineWriteFailure(error)).toBeNull(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    });
  });
  it('actual OrderLine.create P2002(id) maps to existing CONFLICT409 and cannot reach sync/audit', async () => {
    const f = storage(); f.tx.orderLine.create.mockRejectedValue(known('P2002', { target: ['id'] }));
    const result = await createOrderLine({ prisma: f.client, orderId: f.order.id, quantity: 2, trustedActor: prior });
    expect(result.ok).toBe(false); expect(result.error).toEqual({ code: 'CONFLICT', message: lookupErrorCode('CONFLICT')!.message });
    expect(f.tx.entityReference.upsert).not.toHaveBeenCalled(); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['other-create-key', 'untrusted-error', 'unrelated-upsert'])('%s uniqueness failure is safe500 rather than a fabricated auto-number conflict', async variant => {
    const f = storage();
    if (variant === 'other-create-key') f.tx.orderLine.create.mockRejectedValue(known('P2002', { target: ['unrelated_field'] }));
    if (variant === 'untrusted-error') f.tx.orderLine.create.mockRejectedValue(Object.assign(new Error(secret), { code: 'P2002', meta: { target: ['id'] } }));
    if (variant === 'unrelated-upsert') f.tx.entityReference.upsert.mockRejectedValue(known('P2002', { target: ['id'] }));
    const result = await createOrderLine({ prisma: f.client, orderId: f.order.id, quantity: 2, trustedActor: prior,
      ...(variant === 'unrelated-upsert' ? { materialCode: 'actual-synthetic-link-target' } : {}) });
    expect(result.ok).toBe(false); expect(result.error).toEqual({ code: 'CREATE_LINE_FAILED', message: GENERIC_ROUTE_ERROR_MESSAGE });
    expect(JSON.stringify(result)).not.toContain(secret); expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
