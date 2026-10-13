import type { TokenPayload } from '../auth/service';

export type CustomerConfirmationOutcome = 'accepted' | 'rejected' | 'partial';
export type CustomerConfirmationChannel = 'email' | 'screenshot' | 'phone' | 'meeting' | 'other';
export type CustomerEvidenceSourceKind = 'email_selection' | 'screenshot';

export interface CustomerConfirmationTargetSnapshot {
  eligible: boolean;
  /** Human-readable native identifiers; optional and never derived from internal IDs/hashes. */
  businessLabel?: string;
  businessReference?: string | null;
  versionLabel?: string | null;
  scopeLabel?: string | null;
  finalContentFingerprint: string;
  internalApprovalId: string | null;
  scopeFingerprint: string;
  scope: unknown;
  /** Native business readback, supplied by the target's own service. */
  nativeStatus: unknown;
  recommendation?: { orderId?: string; relationId?: string; subject?: string; fromAddress?: string };
}

export interface CustomerConfirmationTargetAdapter {
  targetType: string;
  /** Discover a bounded set of native target IDs from an exact linked source or an exact business reference. */
  searchTargetIds?(
    tx: any,
    actor: TokenPayload,
    input: { sourceEmail: { orderId?: string | null; relationId?: string | null }; businessReference?: string },
  ): Promise<string[]>;
  /** Must enforce the target's current native read/write scope and re-read its facts in this transaction. */
  inspect(
    tx: any,
    targetId: string,
    actor: TokenPayload,
    mode: 'read' | 'confirm',
  ): Promise<CustomerConfirmationTargetSnapshot>;
  /** Refresh the native domain's current write ACL and read its current receipt only; an already-applied target must not require repeating its business action. */
  inspectReplay?(
    tx: any,
    targetId: string,
    actor: TokenPayload,
  ): Promise<CustomerConfirmationTargetSnapshot>;
  /** Persist the target's native customer-confirmation fact/todo in this exact transaction. */
  onRecordedInTx(
    tx: any,
    input: { targetId: string; actor: TokenPayload; command: CustomerConfirmationCommand; confirmation: any },
  ): Promise<{ nativeStatus: unknown; effect?: unknown }>;
  /** Optional retry-safe continuation after the confirmation transaction commits. */
  continueAfterRecord?(
    input: { targetId: string; actor: TokenPayload; command: CustomerConfirmationCommand; confirmation: any },
  ): Promise<{ nativeStatus: unknown; effect?: unknown }>;
  /** Partial confirmations are fail-closed unless the domain validates every selected item/version. */
  validateDecisionScope?(
    tx: any,
    input: { targetId: string; actor: TokenPayload; command: CustomerConfirmationCommand; snapshot: CustomerConfirmationTargetSnapshot },
  ): Promise<void>;
}

export interface CustomerConfirmationTargetRegistry {
  get(targetType: string): CustomerConfirmationTargetAdapter | undefined;
  list(): CustomerConfirmationTargetAdapter[];
}

export interface EmailSelectionSource {
  kind: 'email_selection';
  emailId: string;
  selectedText: string;
  selectionStart: number;
  selectionEnd: number;
  attachmentIds?: string[];
}

export interface ScreenshotSource {
  kind: 'screenshot';
}

export type CustomerConfirmationEvidenceSource = EmailSelectionSource | ScreenshotSource;

export interface CustomerConfirmationCommand {
  targetType: string;
  targetId: string;
  finalContentFingerprint: string;
  internalApprovalId: string | null;
  scopeFingerprint: string;
  scope: unknown;
  /** Domain-validated item-level customer decision for partial acceptance. */
  decisionScope?: unknown;
  outcome: CustomerConfirmationOutcome;
  customerName: string;
  customerAddress?: string | null;
  confirmedAt: string;
  channel: CustomerConfirmationChannel;
  idempotencyKey: string;
  supersedesConfirmationId?: string | null;
  correctionReason?: string | null;
}

export interface PreparedEvidenceBlob {
  /** Kept in memory until the same transaction creates the confirmation and links. */
  bytes: Buffer;
  sha256: string;
  storageKey: string;
  byteSize: number;
  purpose: 'screenshot' | 'email_attachment';
  sourceAttachmentId?: string | null;
  fileName: string;
  mimeType: string;
  metadataSnapshot: unknown;
}

export interface PreparedCustomerEvidence {
  sourceType: CustomerEvidenceSourceKind;
  sourceFingerprint: string;
  sourceSnapshot: unknown;
  selectionSnapshot: unknown;
  blobs: PreparedEvidenceBlob[];
}
