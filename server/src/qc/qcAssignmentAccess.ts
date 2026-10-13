import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';
import { freshOrderLineScope, isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { businessError, isBusinessError } from '../shared/errorCodes';

/** Assignment errors have a finite producer boundary. Text never classifies a
 * database error, and the HTTP adapter does not trust arbitrary status fields. */
export class QcAssignmentError extends Error {
  readonly statusCode: number;
  constructor(public readonly code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'FORBIDDEN'
    | 'UNAUTHORIZED' | 'ACCOUNT_DISABLED' | 'AUTHORIZATION_UNAVAILABLE' | 'CONFLICT', message: string) {
    const error = businessError(code, message);
    super(message); this.name = 'QcAssignmentError'; this.statusCode = error.statusCode;
  }
}

export async function currentQcAssignmentActor(db: any, prior: TokenPayload | null | undefined,
  scope: 'qc:read' | 'qc:write' | 'qc:inspect'): Promise<TokenPayload> {
  if (!prior?.userId) throw new QcAssignmentError('UNAUTHORIZED', '请登录后操作验货任务。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(db, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) {
      throw new QcAssignmentError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
    }
    actor = await buildLoadedAuthTokenPayload(db, user);
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  } catch (error) {
    if (error instanceof QcAssignmentError) throw error;
    throw new QcAssignmentError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验验货任务权限，请稍后重试。');
  }
  // Actual QC grants are necessary even for a canonical management account.
  if (!hasActualQcScope(actor, scope)) {
    throw new QcAssignmentError('FORBIDDEN', '当前账号没有该验货任务操作权限。');
  }
  return actor;
}

async function visibleParent(db: any, actor: TokenPayload, orderId: string) {
  const scope = await freshOrderLineScope(db, actor);
  return db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
}

/** Order -> Assignment is the common write lock order. Reload current account,
 * grants/cap, parent and assignee after both locks, including reassignment races. */
export async function qcAssignmentAccess(db: any, prior: TokenPayload | null | undefined,
  input: { orderId: string; assignmentId?: string; mode: 'manage' | 'inspect' | 'claim' | 'read'; lock?: boolean }) {
  const requiredScope = input.mode === 'read' ? 'qc:read' : input.mode === 'inspect' || input.mode === 'claim' ? 'qc:inspect' : 'qc:write';
  let actor = await currentQcAssignmentActor(db, prior, requiredScope);
  if (input.lock) {
    try {
      const parent = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE`);
      if (!parent.length) throw new QcAssignmentError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
      if (input.assignmentId) {
        const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "QCAssignment" WHERE "id" = ${input.assignmentId} FOR UPDATE`);
        if (!rows.length) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在');
      }
    } catch (error) {
      if (isOrderLineStorageConflict(error)) throw new QcAssignmentError('CONFLICT', '任务正在被修改，请刷新后重试。');
      throw error;
    }
    actor = await currentQcAssignmentActor(db, prior, requiredScope);
  }
  const assignment = input.assignmentId ? await db.qCAssignment.findUnique({ where: { id: input.assignmentId } }) : null;
  if (input.assignmentId && (!assignment || assignment.deletedAt != null)) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在');
  if (assignment && assignment.orderId !== input.orderId) throw new QcAssignmentError('CONFLICT', '任务关联订单已变化，请刷新后重试。');
  const parent = await db.order.findUnique({ where: { id: input.orderId } });
  if (!parent || parent.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
  if (input.mode === 'inspect' || input.mode === 'claim') {
    const chainScope = qcOrderInspectionScope(parent);
    if (!chainScope || !hasActualQcScope(actor, chainScope)) {
      throw new QcAssignmentError('FORBIDDEN', '当前账号没有该订单业务线的专业 QC 检验权限。');
    }
  }
  const assigned = assignment?.qcUserId === actor.userId;
  if (input.mode !== 'manage' && assigned) return { actor, assignment, order: parent, delegated: false };
  const visible = await visibleParent(db, actor, input.orderId);
  if (!visible) throw new QcAssignmentError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
  if (input.mode === 'inspect' && assignment?.qcUserId == null) throw new QcAssignmentError('FORBIDDEN', '请先认领该任务，再开始或提交实际检验。');
  if (input.mode === 'inspect' && !actor.roles.some(role => role === 'owner' || role === 'admin')) {
    throw new QcAssignmentError('FORBIDDEN', '仅当前指派的 QC 或有订单权限的管理员可执行检验。');
  }
  return { actor, assignment, order: visible, delegated: input.mode === 'inspect' && !assigned };
}

/** Current Orders L2 OR the actual current assignee, restricted to live parents.
 * No query/body role or qcUserId can widen this server-generated predicate. */
export async function qcAssignmentReadWhere(db: any, prior: TokenPayload | null | undefined) {
  const actor = await currentQcAssignmentActor(db, prior, 'qc:read');
  const scope = await freshOrderLineScope(db, actor);
  const visible = await db.order.findMany({ where: { deletedAt: null, AND: [scope] }, select: { id: true } });
  const own = await db.qCAssignment.findMany({ where: { qcUserId: actor.userId, deletedAt: null }, select: { orderId: true } });
  const ownParents = own.length ? await db.order.findMany({ where: { deletedAt: null,
    id: { in: [...new Set(own.map((item: any) => item.orderId))] } }, select: { id: true } }) : [];
  return { actor, where: { deletedAt: null, OR: [
    { orderId: { in: visible.map((order: any) => order.id) } },
    { qcUserId: actor.userId, orderId: { in: ownParents.map((order: any) => order.id) } },
  ] } };
}

export function qcAssignmentFailure(error: unknown): unknown {
  if (error instanceof QcAssignmentError || isBusinessError(error)) return error;
  if (isOrderLineStorageConflict(error)) return new QcAssignmentError('CONFLICT', '任务正在被修改，请刷新后重试。');
  return error;
}
