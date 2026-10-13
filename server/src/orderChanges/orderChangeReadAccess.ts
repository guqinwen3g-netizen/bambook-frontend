import type { OrderQueryReadAccess } from '../orders/orderQueryReadAccess';
import { andOrderScope, assertOrderReadAccessUnchanged, loadOrderQueryReadAccess } from '../orders/orderQueryReadAccess';
import type { TokenPayload } from '../auth/service';
import type { ApprovalRequest } from '@prisma/client';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { businessError } from '../shared/errorCodes';

export function isOrderChangeApprovalAction(value: unknown): value is 'order:change' | 'order:cancel' | 'order:pause' {
  return value === 'order:change' || value === 'order:cancel' || value === 'order:pause';
}

const object = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const orderKeys = new Set(['orderId', 'sourceOrderId', 'garmentOrderId', 'fabricOrderId']);
const orderLists = new Set(['orderIds', 'sourceOrderIds']);
const lineKeys = new Set(['lineId', 'orderLineId', 'sourceOrderLineId', 'garmentOrderLineId', 'fabricOrderLineId']);
const lineLists = new Set(['lineIds', 'orderLineIds']);

/** Native frozen JSON can carry more than the CR's selected line. Collect all
 * explicit order/line references, including nested source proofs; text fields
 * are never parsed or used to manufacture authority. */
function sourceReferences(values: unknown[]) {
  const orders = new Set<string>(), lines = new Set<string>(), frozenLineParents = new Map<string, string>();
  let valid = true, count = 0;
  const add = (set: Set<string>, value: unknown) => { if (!identity(value)) valid = false; else set.add(value); };
  const visit = (value: unknown, key = '', parentId?: string, depth = 0) => {
    if (++count > 20_000 || depth > 40) { valid = false; return; }
    if (Array.isArray(value)) { for (const child of value) visit(child, key, parentId, depth + 1); return; }
    const row = object(value); if (!row) return;
    const parent = identity(row.orderId) ? row.orderId : parentId;
    if (key === 'order') add(orders, row.id);
    if (key === 'orderLines') {
      add(lines, row.id);
      if (identity(row.id) && parent) frozenLineParents.set(row.id, parent);
    }
    for (const [field, child] of Object.entries(row)) {
      if (child == null) continue;
      if (orderKeys.has(field)) add(orders, child);
      else if (orderLists.has(field)) {
        if (!Array.isArray(child)) valid = false; else for (const item of child) add(orders, item);
      } else if (lineKeys.has(field)) {
        add(lines, child);
        if (identity(child) && parent) frozenLineParents.set(child, parent);
      } else if (lineLists.has(field)) {
        if (!Array.isArray(child)) valid = false; else for (const item of child) add(lines, item);
      }
      visit(child, field, parent, depth + 1);
    }
  };
  for (const value of values) visit(value);
  return { orders, lines, frozenLineParents, valid };
}

/** The caller must load fresh Orders authority before this pure read sequence.
 * Null deliberately covers unavailable/invisible sources without disclosing
 * which hidden parent, line, or approval exists. Storage faults still throw. */
export async function readCompleteOrderChangeSource(tx: any, change: any, access: OrderQueryReadAccess): Promise<{
  order: any; approval: any | null; parentIds: string[];
} | null> {
  if (!change || change.deletedAt != null || !identity(change.orderId)) return null;
  const order = await tx.order.findFirst({ where: andOrderScope({ id: change.orderId, deletedAt: null }, access.orderWhere),
    select: { id: true, status: true, poNumber: true, customer: true, customerRelationId: true } });
  if (!order) return null;
  const approval = change.approvalRequestId ? await tx.approvalRequest.findUnique({ where: { id: change.approvalRequestId } }) : null;
  if (change.approvalRequestId && (!approval || approval.id !== change.approvalRequestId
    || approval.targetType !== 'OrderChangeRequest' || approval.targetId !== change.orderId
    || !isOrderChangeApprovalAction(approval.actionType)
    || approval.requesterId !== change.requesterId)) return null;
  const basis = object(object(approval?.payload)?.orderChangeReviewBasis);
  if (basis && (basis.order?.id !== change.orderId || !Array.isArray(basis.orderLines)
    || basis.orderLines.some((line: any) => line?.orderId !== change.orderId))) return null;
  const references = sourceReferences([change.beforeSnapshot, change.afterDelta, change.attachments, approval?.payload]);
  if (!references.valid) return null;
  references.orders.add(change.orderId);
  if (references.lines.size) {
    const actual = await tx.orderLine.findMany({ where: { id: { in: [...references.lines] } }, select: { id: true, orderId: true } });
    for (const lineId of references.lines) {
      const line = actual.find((item: any) => item.id === lineId);
      const parentId = line?.orderId ?? references.frozenLineParents.get(lineId);
      if (!identity(parentId)) return null;
      references.orders.add(parentId);
    }
  }
  for (const parentId of references.orders) {
    if (!await tx.order.findFirst({ where: andOrderScope({ id: parentId, deletedAt: null }, access.orderWhere), select: { id: true } })) return null;
  }
  return { order, approval, parentIds: [...references.orders] };
}

/** A late child read must not revive authority withdrawn earlier in this read.
 * Parent rows are rechecked as well as grants: moving an Order to a different
 * customer does not necessarily change the actor's scope predicate. */
export async function finishOrderChangeRead(tx: any, before: OrderQueryReadAccess,
  prior: TokenPayload | null | undefined, changes: any[]) {
  const after = await loadOrderQueryReadAccess(tx, { actor: prior });
  assertOrderReadAccessUnchanged(before, after);
  for (const change of changes) {
    if (!await readCompleteOrderChangeSource(tx, change, after))
      throw businessError('FORBIDDEN', '变更申请来源或当前可读范围已变化，请重新读取。');
  }
}

/** Optional HTTP enrichments run after the core service read. Both the facts
 * about to be emitted and the current native CR must still share authority. */
export async function assertOrderChangeReadResponse(tx: any, change: any, actor: TokenPayload | null): Promise<void> {
  const access = await loadOrderQueryReadAccess(tx, { actor });
  const current = await tx.orderChangeRequest.findUnique({ where: { id: change.id } });
  if (!current || current.deletedAt != null)
    throw businessError('FORBIDDEN', '变更申请来源或当前可读范围已变化，请重新读取。');
  await finishOrderChangeRead(tx, access, actor, [change, current]);
}

/** Shared approval detail/cards must use the same complete frozen sources as
 * HTTP and Agent CR reads. This helper never calls the approval source router. */
export async function assertOrderChangeApprovalRead(tx: any, approval: Pick<ApprovalRequest,
  'id' | 'requesterId' | 'reviewerId' | 'actionType' | 'targetType' | 'targetId' | 'payload'>,
  actor: TokenPayload): Promise<void> {
  const access = await loadOrderQueryReadAccess(tx, { actor });
  const change = await tx.orderChangeRequest.findFirst({ where: { approvalRequestId: approval.id, deletedAt: null } });
  const source = change && await readCompleteOrderChangeSource(tx, change, access);
  if (!source?.approval || approvalReviewContentVersion(approval) !== approvalReviewContentVersion(source.approval))
    throw businessError('FORBIDDEN', '原业务不存在或当前用户无读取权限。');
  await finishOrderChangeRead(tx, access, actor, [change]);
}
