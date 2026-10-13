import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import type { TokenPayload } from '../auth/service';
import { currentQcAssignmentActor, QcAssignmentError } from './qcAssignmentAccess';
import { freshOrderLineScope, isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';

export type QcReportReason = 'report_id_required' | 'report_not_found' | 'invalid_role'
  | 'already_signed' | 'business_role' | 'qc_inspector' | 'actor_mismatch' | 'source_changed';
/** Finite native producer: public text does not classify SQL or confer authority. */
export class QcReportError extends QcAssignmentError {
  constructor(code: ConstructorParameters<typeof QcAssignmentError>[0], message: string,
    public readonly reason?: QcReportReason) {
    super(code, message); this.name = 'QcReportError';
  }
}

export async function currentQcReportActor(db: any, prior: TokenPayload | null | undefined,
  scope: 'qc:read' | 'qc:write' | 'qc:inspect') {
  try { return await currentQcAssignmentActor(db, prior, scope); }
  catch (error) {
    if (error instanceof QcAssignmentError) throw new QcReportError(error.code,
      error.code === 'AUTHORIZATION_UNAVAILABLE' ? '暂时无法核验验货报告权限，请稍后重试。' : error.message);
    throw error;
  }
}

/** Live Order L2, or a particular actual inspector/current assignment report.
 * An assignment to final never opens PP, midline, or another inspector's report.
 * Completed assignments must carry their native reportId; cancelled/deleted
 * assignments and deleted parents provide no authority. Query AND/count share it. */
export async function qcReportReadWhere(db: any, prior: TokenPayload | null | undefined) {
  const actor = await currentQcReportActor(db, prior, 'qc:read');
  try {
    const scope = await freshOrderLineScope(db, actor);
    const [visible, ownReports, assigned] = await Promise.all([
      db.order.findMany({ where: { deletedAt: null, AND: [scope] }, select: { id: true } }),
      db.inspectionReport.findMany({ where: { inspectedBy: actor.userId }, select: { orderId: true } }),
      db.qCAssignment.findMany({ where: { qcUserId: actor.userId, deletedAt: null,
        status: { in: ['Assigned', 'InProgress', 'Completed'] } },
        select: { orderId: true, inspectionType: true, reportId: true, status: true, scopeKey: true, scopeFingerprint: true } }),
    ]);
    const ownIds = [...new Set<string>([...ownReports, ...assigned].map((r: any) => r.orderId))];
    const live = ownIds.length ? await db.order.findMany({ where: { deletedAt: null, id: { in: ownIds } }, select: { id: true } }) : [];
    const liveIds = live.map((r: any) => r.id);
    const liveSet = new Set(liveIds);
    const clauses: any[] = [
      { orderId: { in: visible.map((r: any) => r.id) } },
      { orderId: { in: liveIds }, inspectedBy: actor.userId },
    ];
    for (const task of assigned) {
      if (!liveSet.has(task.orderId)) continue;
      if (task.reportId) clauses.push({ id: task.reportId, orderId: task.orderId, inspectionType: task.inspectionType });
      else if (task.status !== 'Completed') clauses.push({ orderId: task.orderId, inspectionType: task.inspectionType,
        scopeKey: task.scopeKey ?? 'whole_order' });
    }
    return { actor, where: { OR: clauses } };
  } catch (error) {
    if (error instanceof QcReportError) throw error;
    throw new QcReportError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验验货报告可见范围，请稍后重试。');
  }
}

export async function qcReportOrderAccess(db: any, prior: TokenPayload | null | undefined,
  orderId: string, scope: 'qc:read' | 'qc:write' | 'qc:inspect' = 'qc:read') {
  const actor = await currentQcReportActor(db, prior, scope);
  let order;
  try {
    const where = await freshOrderLineScope(db, actor);
    order = await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [where] } });
  } catch {
    throw new QcReportError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验验货报告可见范围，请稍后重试。');
  }
  if (!order) throw new QcReportError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
  return { actor, order };
}

/** Common write lock order: Order -> InspectionReport. Reload current account,
 * grants, signed ceiling and the actual parent/report AFTER both locks. */
export async function qcReportAccess(db: any, prior: TokenPayload | null | undefined,
  reportId: string, options: { scope?: 'qc:read' | 'qc:write' | 'qc:inspect'; lock?: boolean;
    signRole?: 'qc' | 'business'; delegationReason?: string } = {}) {
  if (!reportId?.trim()) throw new QcReportError('VALIDATION_FAILED', 'reportId 必填', 'report_id_required');
  // A caller cannot downgrade the signing side to a generic read/write grant.
  const scope = options.signRole === 'qc' ? 'qc:inspect'
    : options.signRole === 'business' ? 'qc:write' : options.scope ?? 'qc:read';
  let actor = await currentQcReportActor(db, prior, scope);
  const hint = await db.inspectionReport.findUnique({ where: { id: reportId } });
  if (!hint) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
  if (options.lock) {
    const parent = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${hint.orderId} FOR UPDATE`);
    const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "InspectionReport" WHERE "id" = ${reportId} FOR UPDATE`);
    if (!parent.length || !rows.length) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
    actor = await currentQcReportActor(db, prior, scope);
  }
  const report = await db.inspectionReport.findUnique({ where: { id: reportId } });
  if (!report) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
  if (report.orderId !== hint.orderId) throw new QcReportError('CONFLICT', '报告关联订单已变化，请刷新后重试。', 'source_changed');
  const order = await db.order.findUnique({ where: { id: report.orderId } });
  if (!order || order.deletedAt != null) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
  const assertProfessionalFamily = (current: TokenPayload) => {
    const family = qcOrderInspectionScope(order);
    if (!family || !hasActualQcScope(current, family)) {
      throw new QcReportError('FORBIDDEN', '当前账号没有该订单业务线的专业 QC 签署权限。', 'qc_inspector');
    }
  };
  if (options.signRole === 'qc') {
    assertProfessionalFamily(actor);
    if (report.inspectedBy === actor.userId) return { actor, report, order, delegated: false };
  }
  if (options.signRole) {
    const visible = await qcReportOrderAccess(db, actor, order.id, scope);
    if (options.signRole === 'qc') {
      assertProfessionalFamily(visible.actor);
      if (!visible.actor.roles.some(role => role === 'owner' || role === 'admin') || !options.delegationReason?.trim()) {
        throw new QcReportError('FORBIDDEN', '仅实际检验人或明确说明代签原因且有订单权限的管理员可签署 QC 侧。', 'qc_inspector');
      }
      return { actor: visible.actor, report, order, delegated: true };
    }
    let isHead = false;
    if (order.departmentId && order.ownerId !== actor.userId) {
      try {
        const department = await db.department.findUnique({ where: { id: order.departmentId } });
        isHead = department?.status === 'active' && department.headId === actor.userId;
      } catch { throw new QcReportError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验业务签字职责，请稍后重试。'); }
    }
    if (order.ownerId !== actor.userId && !isHead) {
      throw new QcReportError('FORBIDDEN', '业务签字仅限订单负责人或部门主管（PP_SIGN_BUSINESS_ROLE_REQUIRED）', 'business_role');
    }
    return { actor: visible.actor, report, order, delegated: false };
  }
  // The read predicate requires qc:read. For document writes qc:write does not
  // implicitly grant report read: rendering private report data requires both.
  const readable = await qcReportReadWhere(db, actor);
  const found = await db.inspectionReport.findFirst({ where: { id: reportId, AND: [readable.where] }, select: { id: true } });
  if (!found) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
  return { actor: readable.actor, report, order, delegated: false };
}

export function qcReportFailure(error: unknown): unknown {
  if (error instanceof QcReportError) return error;
  if (isOrderLineStorageConflict(error)) return new QcReportError('CONFLICT', '报告正在被修改，请刷新后重试。');
  const failure = new Error('QC_REPORT_OPERATION_UNCONFIRMED');
  Object.defineProperty(failure, 'cause', { value: error });
  return failure;
}

/** Hash immutable-in-this-attempt native source data; never serialize its
 * private fields to the caller. BigInt and Decimal remain exact in the hash. */
export function qcReportSourceFingerprint(value: unknown): string {
  const stable = (input: any): any => {
    if (typeof input === 'bigint') return input.toString();
    if (Prisma.Decimal.isDecimal(input)) return input.toString();
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      if (typeof input.toJSON === 'function') return stable(input.toJSON());
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Call inside an existing transaction for a locked write/finalization, or use
 * the standalone wrapper for a consistent preview. Template loading happens
 * only AFTER actual native source authority, never via an input snapshot. */
export async function qcReportDocumentSource(tx: any, prior: TokenPayload | null | undefined,
  reportId: string, scope: 'qc:read' | 'qc:write', lock = false) {
  const access = await qcReportAccess(tx, prior, reportId, { scope, lock });
  const { loadInspectionReportDocData } = await import('../templates/docTemplates/inspectionReport');
  const data = await loadInspectionReportDocData(tx, reportId);
  if (!data) throw new QcReportError('NOT_FOUND', '验货报告不存在', 'report_not_found');
  return { ...access, data, fingerprint: qcReportSourceFingerprint({ report: access.report, data }) };
}

export async function loadAuthorizedQcReportSource(db: any, prior: TokenPayload | null | undefined,
  reportId: string, scope: 'qc:read' | 'qc:write' = 'qc:read') {
  try {
    return await db.$transaction((tx: any) => qcReportDocumentSource(tx, prior, reportId, scope, scope === 'qc:write'),
      { isolationLevel: scope === 'qc:write' ? Prisma.TransactionIsolationLevel.ReadCommitted : Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) { throw qcReportFailure(error); }
}
