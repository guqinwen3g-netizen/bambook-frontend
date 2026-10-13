ALTER TABLE "OrderChangeRequest"
  ADD COLUMN "finalContentFingerprint" VARCHAR(64),
  ADD COLUMN "revisionOfId" TEXT;

ALTER TABLE "OrderChangeRequest"
  ADD CONSTRAINT "OrderChangeRequest_revisionOfId_fkey"
  FOREIGN KEY ("revisionOfId") REFERENCES "OrderChangeRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrderChangeRequest_revisionOfId_idx" ON "OrderChangeRequest"("revisionOfId");
CREATE INDEX "OrderChangeRequest_finalContentFingerprint_idx" ON "OrderChangeRequest"("finalContentFingerprint");

CREATE TABLE "BusinessConfirmation" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "finalContentFingerprint" VARCHAR(64) NOT NULL,
  "internalApprovalId" TEXT,
  "scopeFingerprint" VARCHAR(64) NOT NULL,
  "scope" JSONB NOT NULL,
  "decisionScope" JSONB,
  "outcome" TEXT NOT NULL,
  "customerName" TEXT,
  "customerAddress" TEXT,
  "confirmedAt" BIGINT NOT NULL,
  "channel" TEXT NOT NULL,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "supersedesId" TEXT,
  "correctionReason" TEXT,
  "auditId" TEXT NOT NULL,
  CONSTRAINT "BusinessConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerEvidence" (
  "id" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceFingerprint" VARCHAR(64) NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "originTargetType" TEXT NOT NULL,
  "originTargetId" TEXT NOT NULL,
  "originConfirmationId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "CustomerEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerEvidenceFile" (
  "id" TEXT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "storageKey" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "CustomerEvidenceFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerEvidenceFileLink" (
  "id" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "sourceAttachmentId" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "metadataSnapshot" JSONB NOT NULL,
  CONSTRAINT "CustomerEvidenceFileLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessConfirmationEvidence" (
  "id" TEXT NOT NULL,
  "confirmationId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "selectionSnapshot" JSONB NOT NULL,
  CONSTRAINT "BusinessConfirmationEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessConfirmation_recordedBy_requestKey_key" ON "BusinessConfirmation"("recordedBy", "requestKey");
CREATE UNIQUE INDEX "BusinessConfirmation_target_version_scope_revision_key" ON "BusinessConfirmation"("targetType", "targetId", "finalContentFingerprint", "scopeFingerprint", "revision");
CREATE UNIQUE INDEX "BusinessConfirmation_supersedesId_key" ON "BusinessConfirmation"("supersedesId");
CREATE UNIQUE INDEX "BusinessConfirmation_auditId_key" ON "BusinessConfirmation"("auditId");
CREATE INDEX "BusinessConfirmation_target_scope_idx" ON "BusinessConfirmation"("targetType", "targetId", "finalContentFingerprint", "scopeFingerprint");
CREATE INDEX "BusinessConfirmation_internalApprovalId_idx" ON "BusinessConfirmation"("internalApprovalId");
CREATE INDEX "BusinessConfirmation_recordedBy_recordedAt_idx" ON "BusinessConfirmation"("recordedBy", "recordedAt");

CREATE UNIQUE INDEX "CustomerEvidence_sourceFingerprint_key" ON "CustomerEvidence"("sourceFingerprint");
CREATE INDEX "CustomerEvidence_originTargetType_originTargetId_idx" ON "CustomerEvidence"("originTargetType", "originTargetId");
CREATE INDEX "CustomerEvidence_createdBy_createdAt_idx" ON "CustomerEvidence"("createdBy", "createdAt");

CREATE UNIQUE INDEX "CustomerEvidenceFile_sha256_key" ON "CustomerEvidenceFile"("sha256");
CREATE UNIQUE INDEX "CustomerEvidenceFile_storageKey_key" ON "CustomerEvidenceFile"("storageKey");
CREATE INDEX "CustomerEvidenceFile_createdBy_createdAt_idx" ON "CustomerEvidenceFile"("createdBy", "createdAt");

CREATE INDEX "CustomerEvidenceFileLink_evidenceId_idx" ON "CustomerEvidenceFileLink"("evidenceId");
CREATE INDEX "CustomerEvidenceFileLink_fileId_idx" ON "CustomerEvidenceFileLink"("fileId");

CREATE UNIQUE INDEX "BusinessConfirmationEvidence_confirmationId_evidenceId_key" ON "BusinessConfirmationEvidence"("confirmationId", "evidenceId");
CREATE INDEX "BusinessConfirmationEvidence_evidenceId_idx" ON "BusinessConfirmationEvidence"("evidenceId");

ALTER TABLE "BusinessConfirmation"
  ADD CONSTRAINT "BusinessConfirmation_recordedBy_fkey"
  FOREIGN KEY ("recordedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessConfirmation_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "BusinessConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerEvidence"
  ADD CONSTRAINT "CustomerEvidence_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerEvidence_originConfirmationId_fkey"
  FOREIGN KEY ("originConfirmationId") REFERENCES "BusinessConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerEvidenceFile"
  ADD CONSTRAINT "CustomerEvidenceFile_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerEvidenceFileLink"
  ADD CONSTRAINT "CustomerEvidenceFileLink_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "CustomerEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerEvidenceFileLink_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "CustomerEvidenceFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BusinessConfirmationEvidence"
  ADD CONSTRAINT "BusinessConfirmationEvidence_confirmationId_fkey"
  FOREIGN KEY ("confirmationId") REFERENCES "BusinessConfirmation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BusinessConfirmationEvidence_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "CustomerEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
