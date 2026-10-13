/** DTO only: safe for frontend type-only consumption. A work area is not a
 * production stage, a quality conclusion, or a permission grant. */
export type BusinessWorkspaceScope =
  | { kind: 'development_case'; caseId: string }
  | { kind: 'development_version'; caseId: string; sampleVersionId: string }
  | { kind: 'order_main'; orderId: string }
  | { kind: 'order_line'; orderId: string; orderLineId: string }
  | { kind: 'production_branch'; orderId: string; orderLineId: string; productionBatchId: string; productionBatchRevision: number };
export type BusinessWorkspaceEvidence = { kind: string; id: string; revision?: number; fingerprint?: string };
export type BusinessWorkspaceNode = {
  id: string; label: string; precedingIds: string[];
  status: 'locked' | 'current' | 'recorded' | 'blocked' | 'unknown';
  hasHistory: boolean; canOpen: boolean; canContinue: boolean;
  blockedReasons: Array<{ code: string; message: string }>;
  evidenceRefs: BusinessWorkspaceEvidence[];
};
export type BusinessWorkspaceContext = {
  schemaVersion: 1; scope: BusinessWorkspaceScope;
  scopeFingerprint: string; contextFingerprint: string;
  overview: Record<string, unknown>;
  currentNodeIds: string[]; nodes: BusinessWorkspaceNode[];
  childSummaries: Array<Record<string, unknown>>;
};
export type BusinessWorkspaceContinueCommand = {
  scope: BusinessWorkspaceScope; targetNodeId: string; expectedContextFingerprint: string; requestKey: string;
};
export type BusinessWorkspaceCommandAck = {
  schemaVersion: 1; requestKey: string; scope: BusinessWorkspaceScope; targetNodeId: string;
  auditId: string; contextFingerprint: string; scopeFingerprint: string; actorId: string; commandFingerprint: string;
};
export type BusinessWorkspaceContinueResult = {
  context: BusinessWorkspaceContext; commandAck: BusinessWorkspaceCommandAck; replayed: boolean;
};
