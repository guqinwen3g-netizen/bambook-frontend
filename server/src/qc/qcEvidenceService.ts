import fs from 'node:fs/promises';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { qcAssignmentAccess, QcAssignmentError } from './qcAssignmentAccess';
import { lockQcCoverage } from './qcPhysicalCoverage';
import { qcReportAccess } from './qcReportAuthority';
import { stageQcEvidenceInTx, readQcEvidenceInTx, verifyQcEvidenceBytes, type QcEvidenceUpload, type QcEvidenceFile } from './qcEvidenceStorage';

export function createQcEvidenceService(db: PrismaClient, root: string) {
  async function upload(assignmentId: string, input: { requestKey: string; expectedScopeFingerprint: string; file: QcEvidenceUpload }, actor: TokenPayload) {
    let created: string | undefined;
    try { return await db.$transaction(async (tx: any) => {
      // The upload key is global to the actual actor, shared with development
      // review uploads. Acquire it before either source lock.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qc-evidence:${actor.userId}:${input.requestKey}`}, 0))`);
      const hint = await tx.qCAssignment.findUnique({ where: { id: assignmentId } });
      if (!hint || hint.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在。');
      await lockQcCoverage(tx, hint.orderId, hint.productionBatchId);
      const { assignment, actor: current } = await qcAssignmentAccess(tx, actor, { orderId: hint.orderId, assignmentId, mode: 'claim', lock: true });
      if (!assignment.scopeFingerprint || assignment.scopeFingerprint !== input.expectedScopeFingerprint) throw new QcAssignmentError('CONFLICT', '附件须绑定当前准确检验来源。');
      const original = await tx.auditLog.findFirst({ where: { actorId: current.userId, action: 'upload_qc_evidence',
        detail: { path: ['after', 'requestKey'], equals: input.requestKey } } });
      // A transferred task must not erase a successful upload whose ACK was
      // lost. Replaying it still requires current professional/source access;
      // creating any new evidence requires the actual current assignee.
      if (!original) await qcAssignmentAccess(tx, current, { orderId: hint.orderId, assignmentId, mode: 'inspect' });
      const result = await stageQcEvidenceInTx(tx, { root, actorId: current.userId, sourceKind: 'assignment', sourceId: assignmentId,
        sourceFingerprint: assignment.scopeFingerprint, requestKey: input.requestKey, file: input.file }, absolute => { created = absolute; });
      if (!result.replayed && !['Assigned', 'InProgress'].includes(assignment.status)) throw new QcAssignmentError('CONFLICT', '已完成报告不能追加或覆盖附件，请发起复验。');
      return result;
    }, { isolationLevel: 'Serializable' }); }
    catch (error) { if (created) await fs.unlink(created).catch(() => {}); throw error; }
  }
  async function list(assignmentId: string, actor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const hint = await tx.qCAssignment.findUnique({ where: { id: assignmentId } });
      if (!hint) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在。');
      const { assignment } = await qcAssignmentAccess(tx, actor, { orderId: hint.orderId, assignmentId, mode: 'read' });
      const uploads = await tx.auditLog.findMany({ where: { targetType: 'QCAssignment', targetId: assignmentId, action: 'upload_qc_evidence' }, orderBy: { createdAt: 'asc' } });
      const files = uploads.map((row: any) => row.detail?.after?.file).filter((file: QcEvidenceFile | undefined) =>
        file?.sourceKind === 'assignment' && file.sourceId === assignmentId && file.sourceFingerprint === assignment.scopeFingerprint);
      return { ok: true, files };
    });
  }
  async function downloadReport(reportId: string, fileId: string, actor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const { report } = await qcReportAccess(tx, actor, reportId, { scope: 'qc:read' });
      const file = (Array.isArray(report.evidenceFiles) ? report.evidenceFiles : []).find((candidate: QcEvidenceFile) => candidate.id === fileId) as QcEvidenceFile | undefined;
      if (!file || file.sourceKind !== 'assignment' || file.sourceFingerprint !== report.scopeFingerprint) throw new QcAssignmentError('NOT_FOUND', '该准确报告没有此附件。');
      const [original] = await readQcEvidenceInTx(tx, { root, sourceKind: 'assignment', sourceId: file.sourceId,
        sourceFingerprint: report.scopeFingerprint, ids: [file.id] });
      if (JSON.stringify(original) !== JSON.stringify(file)) {
        // JSONB key order is not a file identity; compare all public values.
        const keys = Object.keys(original) as Array<keyof QcEvidenceFile>;
        if (keys.some(key => original[key] !== file[key]) || Object.keys(file).length !== keys.length) throw new QcAssignmentError('CONFLICT', '报告附件与原上传回执不一致。');
      }
      const audit = await tx.auditLog.findFirst({ where: { action: 'upload_qc_evidence', targetId: file.sourceId,
        detail: { path: ['after', 'file', 'id'], equals: file.id } } });
      return { file, ...(await verifyQcEvidenceBytes(root, original, audit.detail.after.relativePath)) };
    });
  }
  return { upload, list, downloadReport };
}
