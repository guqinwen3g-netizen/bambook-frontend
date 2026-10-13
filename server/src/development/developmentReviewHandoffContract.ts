/** Public, data-only contract. Unknown historical executor/version facts stay null. */
export type DevelopmentReviewHandoffOperation = 'claim' | 'transfer' | 'assign';
export interface DevelopmentReviewHandoffInput {
  requestKey: string;
  expectedStartedBy: string | null;
  expectedUpdatedAt: string;
  sourceFingerprint: string;
  reason: string;
  toUserId?: string;
}
export interface DevelopmentReviewHandoffReceipt {
  protocolVersion: 1;
  operation: DevelopmentReviewHandoffOperation;
  requestKey: string;
  parameterHash: string;
  auditId: string;
  actorId: string;
  reviewId: string;
  developmentCaseId: string;
  sampleBatchId: string;
  sampleVersionId: string;
  sourceFingerprint: string;
  fromUserId: string | null;
  toUserId: string;
  reason: string;
  occurredAt: string;
}
export interface DevelopmentReviewQcUser {
  id: string;
  displayName: string;
  departmentName: string | null;
}
export interface DevelopmentReviewHandoffHistory {
  auditId: string;
  operation: 'start' | 'claim' | 'transfer' | 'assign' | 'complete';
  actorId: string;
  fromUserId: string | null;
  toUserId: string | null;
  reason: string | null;
  occurredAt: string | null;
}
