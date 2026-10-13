/** Read-only actual production facts; no production conclusion follows from a
 * visual workspace being opened, financial settlement or a legacy stage. */
export type ProductionProgressBranch = {
  productionBatchId: string; productionBatchRevision: number; factoryRelationId: string; factoryName: string | null;
  plannedQty: string; actualQty: string | null; unit: string; completionId: string | null; completedAt: string | null;
  qcState: 'unknown' | 'incomplete' | 'paused' | 'waiting_business_resume' | 'clear';
  qcReportId: string | null; businessDecision: 'unknown' | 'pending' | 'accepted' | 'rejected';
  qcReasons: string[]; qualityCoverage: { applicable: boolean; actualSizes: string[]; missingSizes: string[]; failedSizes: string[] } | null;
};
export type ProductionProgressLine = {
  orderLineId: string; description: string; contractQty: string; unit: string | null;
  status: 'not_started' | 'incomplete' | 'complete' | 'out_of_tolerance' | 'unresolved';
  productionComplete: boolean; actualQty: string | null; quantityDecisionState: string;
  blockers: Array<{ code: string; message: string }>; branches: ProductionProgressBranch[];
};
export type ProductionProgressItem = {
  order: { id: string; code: string | null; poNumber: string | null; customer: string; businessLine: string | null; dueDate: string | null; productionDeadline?: string | null; exMillDate?: string | null };
  state: 'no_items' | 'not_started' | 'in_progress' | 'production_complete' | 'source_unknown';
  lines: ProductionProgressLine[]; blockedBranchCount: number; unknownBranchCount: number;
};
export type ProductionProgressBoard = { schemaVersion: 1; items: ProductionProgressItem[];
  stats: { totalActive: number; fullyCompleted: number; overdueCount: number; stageDistribution: Record<ProductionProgressItem['state'], number>;
    actualBranchCount: number; completedBranchCount: number; pausedBranchCount: number; unknownBranchCount: number } };
