CREATE TABLE "FabricUseAuthorizationRequest" (
  "id" TEXT NOT NULL,
  "productAssetId" TEXT NOT NULL,
  "ownerRelationId" TEXT NOT NULL,
  "granteeRelationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "expectedVersionId" TEXT,
  "allowedActions" JSONB NOT NULL,
  "effectiveFrom" BIGINT,
  "effectiveUntil" BIGINT,
  "finalContentFingerprint" VARCHAR(64) NOT NULL,
  "scopeFingerprint" VARCHAR(64) NOT NULL,
  "productSnapshot" JSONB NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  CONSTRAINT "FabricUseAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FabricUseAuthorizationVersion" (
  "id" TEXT NOT NULL,
  "productAssetId" TEXT NOT NULL,
  "ownerRelationId" TEXT NOT NULL,
  "granteeRelationId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "allowedActions" JSONB NOT NULL,
  "effectiveFrom" BIGINT,
  "effectiveUntil" BIGINT,
  "requestId" TEXT NOT NULL,
  "confirmationId" TEXT NOT NULL,
  "supersedesVersionId" TEXT,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  "auditId" TEXT NOT NULL,
  CONSTRAINT "FabricUseAuthorizationVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FabricUseAuthorizationUse" (
  "id" TEXT NOT NULL,
  "useKey" VARCHAR(64) NOT NULL,
  "basisKind" TEXT NOT NULL,
  "authorizationVersionId" TEXT,
  "productAssetId" TEXT NOT NULL,
  "ownerRelationId" TEXT NOT NULL,
  "granteeRelationId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "businessTargetType" TEXT NOT NULL,
  "businessTargetId" TEXT NOT NULL,
  "businessLineId" TEXT,
  "businessVersionFingerprint" VARCHAR(64) NOT NULL,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  "auditId" TEXT NOT NULL,
  CONSTRAINT "FabricUseAuthorizationUse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FabricUseAuthRequest_actor_request_uq"
  ON "FabricUseAuthorizationRequest"("recordedBy", "requestKey");
CREATE INDEX "FabricUseAuthRequest_product_owner_grantee_time_idx"
  ON "FabricUseAuthorizationRequest"("productAssetId", "ownerRelationId", "granteeRelationId", "recordedAt");
CREATE INDEX "FabricUseAuthRequest_expected_version_idx"
  ON "FabricUseAuthorizationRequest"("expectedVersionId");

CREATE UNIQUE INDEX "FabricUseAuthVersion_request_key"
  ON "FabricUseAuthorizationVersion"("requestId");
CREATE UNIQUE INDEX "FabricUseAuthVersion_confirmation_key"
  ON "FabricUseAuthorizationVersion"("confirmationId");
CREATE UNIQUE INDEX "FabricUseAuthVersion_supersedes_key"
  ON "FabricUseAuthorizationVersion"("supersedesVersionId");
CREATE UNIQUE INDEX "FabricUseAuthVersion_identity_revision_uq"
  ON "FabricUseAuthorizationVersion"("productAssetId", "ownerRelationId", "granteeRelationId", "revision");
CREATE UNIQUE INDEX "FabricUseAuthVersion_auditId_key"
  ON "FabricUseAuthorizationVersion"("auditId");

CREATE UNIQUE INDEX "FabricUseAuthUse_use_key_key"
  ON "FabricUseAuthorizationUse"("useKey");
CREATE UNIQUE INDEX "FabricUseAuthUse_auditId_key"
  ON "FabricUseAuthorizationUse"("auditId");
CREATE INDEX "FabricUseAuthUse_target_idx"
  ON "FabricUseAuthorizationUse"("businessTargetType", "businessTargetId", "businessLineId");
CREATE INDEX "FabricUseAuthUse_version_time_idx"
  ON "FabricUseAuthorizationUse"("authorizationVersionId", "recordedAt");
CREATE INDEX "FabricUseAuthUse_product_customer_action_idx"
  ON "FabricUseAuthorizationUse"("productAssetId", "granteeRelationId", "action", "recordedAt");

ALTER TABLE "FabricUseAuthorizationRequest"
  ADD CONSTRAINT "FabricUseAuthorizationRequest_productAssetId_fkey"
    FOREIGN KEY ("productAssetId") REFERENCES "ProductAsset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationRequest_ownerRelationId_fkey"
    FOREIGN KEY ("ownerRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationRequest_granteeRelationId_fkey"
    FOREIGN KEY ("granteeRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationRequest_recordedBy_fkey"
    FOREIGN KEY ("recordedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FabricUseAuthorizationVersion"
  ADD CONSTRAINT "FabricUseAuthorizationVersion_productAssetId_fkey"
    FOREIGN KEY ("productAssetId") REFERENCES "ProductAsset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_ownerRelationId_fkey"
    FOREIGN KEY ("ownerRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_granteeRelationId_fkey"
    FOREIGN KEY ("granteeRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "FabricUseAuthorizationRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_confirmationId_fkey"
    FOREIGN KEY ("confirmationId") REFERENCES "BusinessConfirmation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_supersedesVersionId_fkey"
    FOREIGN KEY ("supersedesVersionId") REFERENCES "FabricUseAuthorizationVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_recordedBy_fkey"
    FOREIGN KEY ("recordedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationVersion_auditId_fkey"
    FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FabricUseAuthorizationRequest"
  ADD CONSTRAINT "FabricUseAuthorizationRequest_expectedVersionId_fkey"
    FOREIGN KEY ("expectedVersionId") REFERENCES "FabricUseAuthorizationVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FabricUseAuthorizationUse"
  ADD CONSTRAINT "FabricUseAuthorizationUse_authorizationVersionId_fkey"
    FOREIGN KEY ("authorizationVersionId") REFERENCES "FabricUseAuthorizationVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationUse_productAssetId_fkey"
    FOREIGN KEY ("productAssetId") REFERENCES "ProductAsset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationUse_ownerRelationId_fkey"
    FOREIGN KEY ("ownerRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationUse_granteeRelationId_fkey"
    FOREIGN KEY ("granteeRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationUse_recordedBy_fkey"
    FOREIGN KEY ("recordedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FabricUseAuthorizationUse_auditId_fkey"
    FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
