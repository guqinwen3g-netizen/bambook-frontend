import path from 'path';
import type { PrismaClient } from '@prisma/client';
import { readExternalTradeDocumentArchive } from '../customs/externalTradeDocumentArchiveService';
import { businessError } from '../shared/errorCodes';

export const EXPORT_DECLARATION_PROOF_TYPE = 'ExportDeclarationProof';

export function normalizeExportDeclarationCompletedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

/**
 * The actual export filing happens outside Bambook. A shipment is complete only
 * when its external completion time and its own archived proof document exist.
 * Old local CustomsDeclaration rows are intentionally not accepted as proof.
 */
export async function assertShipmentExportDeclarationProof(
  tx: Pick<PrismaClient, 'tradeDocument' | 'documentVersion'> | any,
  shipment: Record<string, any>,
): Promise<void> {
  if (shipment?.type !== 'Export') return;

  const completedAt = normalizeExportDeclarationCompletedAt(shipment.exportDeclarationCompletedAt);
  const documentId = typeof shipment.exportDeclarationEvidenceDocumentId === 'string'
    ? shipment.exportDeclarationEvidenceDocumentId.trim() : '';
  if (!completedAt || !documentId) {
    throw businessError('GATE_BLOCKED', '出口申报须在系统外完成，并先登记完成时间和本运单的申报凭证，才能登记实际开船/起飞。');
  }

  try {
    const archived = await readExternalTradeDocumentArchive(tx as PrismaClient, {
      documentId,
      uploadRoot: process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads'),
    });
    if (archived.document.type !== EXPORT_DECLARATION_PROOF_TYPE
      || archived.document.domain !== 'customs'
      || archived.document.shipmentId !== shipment.id
      || archived.archive.version < 1) {
      throw new Error('proof document is not bound to this shipment');
    }
  } catch {
    throw businessError('GATE_BLOCKED', '出口申报完成凭证不存在、未归档或不属于本运单，请先补齐凭证后再登记实际开船/起飞。');
  }
}
