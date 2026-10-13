import { sampleOriginFingerprint, type SampleOriginSnapshot } from './sampleOriginService';

export const RECEIPT_CARD_TYPES = ['fabric', 'garment', 'colorcard', 'trim', 'other'] as const;
export type ReceiptCardType = typeof RECEIPT_CARD_TYPES[number];
/** Accurate custody is independent of native approval and Sample projection. */
export interface BatchCardReceiptSnapshot {
  version: 2;
  nativeFamily: 'fabric-batch' | 'garment-round';
  batchId: string;
  batchCode: string;
  developmentCaseId: string;
  factoryId: string;
  sourceRound: number;
  sampleType: string;
  sourceSnapshot: SampleOriginSnapshot;
  sourceFingerprint: string;
  cardType: ReceiptCardType;
  actualQuantity: string | null;
  actualUnit: string | null;
  /** The observed receipt rating is independent of later native QC metadata. */
  colorRating: number | null;
  /** Immutable outcome captured when the physical sample was received. */
  resultSnapshot?: { dyeLotNo: string | null; sideDiff: number | null; endDiff: number | null; defectCauses: string[]; notes: string | null };
  batchUpdatedAt: string;
  /** For garment rounds, each row proves one physical piece in this batch. */
  physicalItemIndex?: number;
  physicalItemCount?: number;
  initialPhysicalCardCount: number;
  physicalUnit: string;
  /** Actual business receipt time, independent of process/audit time. */
  receivedAt: string;
  /** Absent on original V2 receipts, where receivedAt also proved creation. */
  recordedAt?: string;
  receivedBy: string;
}

/** Only call after readBatchReceiptSnapshot validated the original receipt.
 * Legacy receipts retain their original evidence time without being rewritten. */
export function batchReceiptRecordedAt(receipt: BatchCardReceiptSnapshot): string {
  return receipt.recordedAt ?? receipt.receivedAt;
}

/** V2 JSON boundary: the native 1-5 range without coercing unrelated types. */
export function normalizeReceiptColorRating(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error('色差评级必须是 1-5 整数（5=与标样一致 … 1=完全不符）');
  }
  return value;
}

/** V1/null receipts lack round/factory evidence. Never upgrade them by reading
 * today's batch. Validation concerns the original immutable fact only. */
export function readBatchReceiptSnapshot(value: any): BatchCardReceiptSnapshot | null {
  if (!value || value.version !== 2
    || !['batchId', 'batchCode', 'developmentCaseId', 'factoryId', 'sampleType', 'receivedBy'].every(key => typeof value[key] === 'string' && value[key].length > 0)
    || !['batchUpdatedAt', 'receivedAt'].every(key => typeof value[key] === 'string' && /^\d+$/.test(value[key]))
    || value.recordedAt !== undefined && (typeof value.recordedAt !== 'string' || !/^\d{1,16}$/.test(value.recordedAt)
      || BigInt(value.recordedAt) <= BigInt(0) || BigInt(value.recordedAt) > BigInt(Number.MAX_SAFE_INTEGER))
    || !Number.isSafeInteger(value.sourceRound) || value.sourceRound < 1
    || !Number.isInteger(value.initialPhysicalCardCount) || value.initialPhysicalCardCount < 0 || value.initialPhysicalCardCount > 2147483647
    || (value.physicalItemIndex !== undefined || value.physicalItemCount !== undefined)
      && (!Number.isSafeInteger(value.physicalItemIndex) || value.physicalItemIndex < 1
        || !Number.isSafeInteger(value.physicalItemCount) || value.physicalItemCount < 1
        || value.physicalItemIndex > value.physicalItemCount || value.initialPhysicalCardCount !== 1)
    || typeof value.physicalUnit !== 'string' || !value.physicalUnit.trim() || value.physicalUnit.length > 30 || !RECEIPT_CARD_TYPES.includes(value.cardType)
    || !(value.colorRating === null || typeof value.colorRating === 'number' && Number.isInteger(value.colorRating) && value.colorRating >= 1 && value.colorRating <= 5)
    || !(value.actualUnit === null || typeof value.actualUnit === 'string')
    || value.resultSnapshot !== undefined && (!value.resultSnapshot || typeof value.resultSnapshot !== 'object'
      || !(value.resultSnapshot.dyeLotNo === null || typeof value.resultSnapshot.dyeLotNo === 'string')
      || ![value.resultSnapshot.sideDiff, value.resultSnapshot.endDiff].every((rating: any) => rating === null || Number.isInteger(rating) && rating >= 1 && rating <= 5)
      || !Array.isArray(value.resultSnapshot.defectCauses) || value.resultSnapshot.defectCauses.some((cause: any) => typeof cause !== 'string')
      || !(value.resultSnapshot.notes === null || typeof value.resultSnapshot.notes === 'string'))
    || !(value.actualQuantity === null || typeof value.actualQuantity === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value.actualQuantity))) return null;
  const source = value.sourceSnapshot;
  const garment = value.sampleType === 'garment-round';
  if (value.nativeFamily !== (garment ? 'garment-round' : 'fabric-batch')
    || !garment && !['lab-dip', 'handloom', 'yardage', 'trim'].includes(value.sampleType)
    || source?.schemaVersion !== 1 || !source.content || typeof source.content !== 'object'
    || source.batch?.id !== value.batchId || source.batch.code !== value.batchCode
    || source.batch.caseId !== value.developmentCaseId || source.batch.factoryId !== value.factoryId
    || source.batch.sourceRound !== value.sourceRound || source.batch.sampleType !== value.sampleType
    || source.version?.updatedAt !== value.batchUpdatedAt
    || typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) return null;
  try { if (sampleOriginFingerprint(source) !== value.sourceFingerprint) return null; }
  catch { return null; }
  return value;
}
