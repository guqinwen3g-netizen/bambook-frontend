import { QcReportError } from './qcReportAuthority';

/** Report identity deduplicates delivery even if its HTTP ACK is lost. */
export async function persistQcReportSourceReturn(tx: any, input: { assignment: any; report: any; actorId: string }) {
  const { assignment, report } = input;
  const order = await tx.order.findUnique({ where: { id: report.orderId }, select: { id: true, ownerId: true, departmentId: true, code: true, poNumber: true } });
  if (!order) throw new QcReportError('CONFLICT', 'QC 报告缺少准确来源订单，不能完成业务回程。');
  let recipientId: string | null = null;
  if (order.ownerId) {
    const owner = await tx.userAccount.findUnique({ where: { id: order.ownerId }, select: { id: true, status: true, deletedAt: true } });
    if (owner?.status === 'active' && owner.deletedAt == null) recipientId = owner.id;
  }
  if (!recipientId && order.departmentId) {
    const department = await tx.department.findUnique({ where: { id: order.departmentId }, select: { status: true, headId: true } });
    if (department?.status === 'active' && department.headId) {
      const head = await tx.userAccount.findUnique({ where: { id: department.headId }, select: { id: true, status: true, deletedAt: true } });
      if (head?.status === 'active' && head.deletedAt == null) recipientId = head.id;
    }
  }
  if (!recipientId) throw new QcReportError('CONFLICT', 'QC 来源尚无可用业务负责人，请先明确责任人后提交报告。');
  const orderLineIds: string[] = [...new Set<string>((report.scopeSnapshot?.lines ?? []).map((line: any) => line.orderLineId).filter((id: unknown): id is string => typeof id === 'string'))];
  const orderLineId = orderLineIds.length === 1 ? orderLineIds[0] : null;
  const type = 'production_qc_report_returned';
  const title = report.result === 'pass' ? '生产 QC 报告已回到来源，待业务处理' : '生产 QC NOK 报告已回到来源';
  const body = `${order.code || order.poNumber || order.id} · ${orderLineId || '整单范围'}${report.productionBatchId ? ` · ${report.productionBatchId}` : ''} · ${report.result === 'pass' ? 'OK' : 'NOK'} · ${report.notes || report.defectSummary || '请核对原报告与实际证据。'}`;
  const link = `/orders?id=${encodeURIComponent(order.id)}&tab=production${orderLineId ? `&lineId=${encodeURIComponent(orderLineId)}` : ''}`;
  const eventId = `qc_return_${report.id}`;
  const metadata = { eventId, eventType: type, orderId: order.id, orderLineId, orderLineIds, productionBatchId: report.productionBatchId ?? null,
    productionBatchRevision: report.productionBatchRevision ?? null, scopeFingerprint: report.scopeFingerprint,
    assignmentId: assignment.id, reportId: report.id, reportRevision: report.revision, actualInspectorId: input.actorId,
    target: { kind: 'order', orderId: order.id, ...(orderLineId ? { lineId: orderLineId } : {}) } };
  const level = report.result === 'pass' ? 'info' as const : 'warning' as const;
  await tx.notification.createMany({ data: [{ id: `ntf_${eventId}_${recipientId}`, userId: recipientId, type, title, body, level, link, metadata }], skipDuplicates: true });
  return [{ type, title, body, level, link, eventId, eventType: type, orderId: order.id, recipientIds: [recipientId], metadata }];
}
