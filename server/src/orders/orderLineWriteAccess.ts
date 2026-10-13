import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from './orderService';
import { businessError, lookupErrorCode, readBusinessErrorMint, type BusinessErrorMint } from '../shared/errorCodes';

/** Current shared Orders actions authorize business work, including Sales.
 * Only a verified server caller supplies prior identity/credential ceiling;
 * actorId, body metadata and the approval's reviewer are never authority. */
export type OrderLineWriteAction = 'create' | 'update' | 'delete' | 'version';
export type OrderLineWriteErrorCode = 'UNAUTHORIZED' | 'ACCOUNT_DISABLED' | 'FORBIDDEN'
  | 'AUTHORIZATION_UNAVAILABLE' | 'CONFLICT' | 'ORDER_NOT_FOUND' | 'ORDER_LINE_NOT_FOUND';

const orderLineWriteErrorMints = new WeakMap<object, BusinessErrorMint>();
export function readOrderLineWriteErrorMint(error: unknown): BusinessErrorMint | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null;
  return orderLineWriteErrorMints.get(error as object) ?? null;
}

export class OrderLineWriteError extends Error {
  public readonly statusCode: number;
  constructor(public readonly code: OrderLineWriteErrorCode, message: string) {
    const canonical = businessError(code, message);
    super(canonical.message); this.name = 'OrderLineWriteError'; this.statusCode = canonical.statusCode;
    orderLineWriteErrorMints.set(this, readBusinessErrorMint(canonical)!);
  }
}

export function requireOrderLineWriteIdentity(actor: TokenPayload | null | undefined): TokenPayload {
  if (!actor?.userId) throw new OrderLineWriteError('UNAUTHORIZED', '订单行写操作需要有效的用户主体。');
  return actor;
}

/** Strict use of the existing L2 policy, without changing compatibility reads.
 * The permission resolver catches team reads for legacy readers. A write must
 * distinguish that failure from a legitimately empty visible customer set. */
export async function freshOrderLineScope(tx: any, actor: TokenPayload): Promise<Record<string, unknown>> {
  try {
    let resolverFault = false;
    const strict = new Proxy(tx, { get(target, key) {
      if (key !== 'teamMember') return Reflect.get(target, key);
      if (!target.teamMember) { resolverFault = true; throw Error('ORDER_SCOPE_LOADING_FAILED'); }
      return new Proxy(target.teamMember, { get(delegate, method) {
        if (method !== 'findMany') return Reflect.get(delegate, method);
        return async (...args: any[]) => {
          try { return await delegate.findMany(...args); }
          catch (error) { resolverFault = true; throw error; }
        };
      } });
    } });
    const scope = await buildOrderListScopeWhere(strict, actor, { fresh: true });
    if (resolverFault) throw Error('ORDER_SCOPE_LOADING_FAILED');
    return scope;
  } catch {
    throw new OrderLineWriteError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单可操作范围，请稍后重试。');
  }
}

export async function currentOrderLineWriteActor(tx: any, prior: TokenPayload | null | undefined, action: OrderLineWriteAction): Promise<TokenPayload> {
  requireOrderLineWriteIdentity(prior);
  let current: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior!.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) {
      throw new OrderLineWriteError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
    }
    current = await buildLoadedAuthTokenPayload(tx, user);
    if (prior!.permissionCeiling !== undefined) current.permissionCeiling = [...prior!.permissionCeiling];
  } catch (error) {
    if (error instanceof OrderLineWriteError) throw error;
    throw new OrderLineWriteError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验写入权限，请稍后重试。');
  }
  const scope = action === 'delete' ? 'orders:delete' : 'orders:write';
  if (!hasScope(current, scope)) {
    throw new OrderLineWriteError('FORBIDDEN', '当前账号没有该订单行写入权限。');
  }
  return current;
}

/** Must run in the caller's business transaction. Order is locked before Line;
 * after locking the parent, reload scope AND parent before any business write.
 * No absent-method fallback is permitted for storage substitutes. */
export async function authorizeOrderLineWrite(tx: any, orderId: string, prior: TokenPayload | null | undefined, action: OrderLineWriteAction) {
  let actor = await currentOrderLineWriteActor(tx, prior, action);
  let scope = await freshOrderLineScope(tx, actor);
  const visible = await scopedOrder(tx, orderId, scope);
  if (!visible) throw new OrderLineWriteError('ORDER_NOT_FOUND', '订单不存在或不在当前可操作范围。');
  const locked = await lockRow(() => tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`));
  if (!locked.length) throw new OrderLineWriteError('ORDER_NOT_FOUND', '订单不存在或不在当前可操作范围。');
  actor = await currentOrderLineWriteActor(tx, prior, action);
  scope = await freshOrderLineScope(tx, actor);
  const order = await scopedOrder(tx, orderId, scope);
  if (!order) throw new OrderLineWriteError('ORDER_NOT_FOUND', '订单不存在或不在当前可操作范围。');
  const family = String(order.businessLine || order.type || '').toLowerCase();
  if (!actor.globalBusinessScope && (family === 'fabric' || family === 'garment') && !actor.businessAttributes?.includes(`${family}_business`))
    throw new OrderLineWriteError('FORBIDDEN', '所属部门不具备此订单的业务属性。');
  await assertOrderMainApprovalNotPending(tx, orderId);
  return { actor, order, scope };
}

/** All order-line and fulfillment writers share the main-approval freeze.
 * Call only after locking and rechecking the Order in the business transaction. */
export async function assertOrderMainApprovalNotPending(tx: any, orderId: string): Promise<void> {
  let pending: unknown;
  try {
    pending = await tx.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: orderId, status: 'pending' }, select: { id: true } });
  } catch {
    throw new OrderLineWriteError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单主单审批状态，请稍后重试。');
  }
  if (pending) throw new OrderLineWriteError('CONFLICT', '订单主单审批处理中，订单条目及履约操作已冻结；请等待审批结果。');
}

async function scopedOrder(tx: any, orderId: string, scope: Record<string, unknown>) {
  try { return await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } }); }
  catch { throw new OrderLineWriteError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单可操作范围，请稍后重试。'); }
}

export async function lockedOrderLine(tx: any, lineId: string, expectedOrderId: string) {
  const locked = await lockRow(() => tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id" = ${lineId} FOR UPDATE`));
  if (!locked.length) throw new OrderLineWriteError('ORDER_LINE_NOT_FOUND', '订单行不存在。');
  const line = await tx.orderLine.findUnique({ where: { id: lineId } });
  if (!line) throw new OrderLineWriteError('ORDER_LINE_NOT_FOUND', '订单行不存在。');
  if (line.orderId !== expectedOrderId) throw new OrderLineWriteError('CONFLICT', '订单行归属已变化，请刷新后重新核对。');
  return line;
}

/** Only actual storage metadata identifies SQL serialization/deadlock, never
 * a message substring. Raw-query row locks surface these as P2010, whereas
 * Prisma's normal mutation/commit path uses P2034. */
export function isOrderLineStorageConflict(error: unknown): boolean {
  if ((error as { code?: string })?.code === 'P2034') return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return false;
  return error.meta?.code === '40001' || error.meta?.code === '40P01';
}

async function lockRow(work: () => Promise<any[]>): Promise<any[]> {
  try { return await work(); }
  catch (error) {
    if (isOrderLineStorageConflict(error)) throw new OrderLineWriteError('CONFLICT', lookupErrorCode('CONFLICT')!.message);
    throw error;
  }
}

export function orderLineWriteFailure(error: unknown): { code: OrderLineWriteErrorCode; message: string } | null {
  if (error instanceof OrderLineWriteError) return { code: error.code, message: lookupErrorCode(error.code)!.message };
  if (isOrderLineStorageConflict(error)) return { code: 'CONFLICT', message: lookupErrorCode('CONFLICT')!.message };
  return null;
}
