CREATE TABLE "GarmentTrimTask" (
 "id" TEXT NOT NULL, "developmentCaseId" TEXT NOT NULL, "requirements" TEXT NOT NULL,
 "supplierRelationId" TEXT NOT NULL, "supplierName" TEXT, "quantity" DECIMAL(18,4) NOT NULL,
 "unit" TEXT NOT NULL, "dueDate" TEXT, "attachments" JSONB, "confirmedAt" BIGINT,
 "confirmedBy" TEXT, "finalDetails" JSONB, "productAssetId" TEXT,
 "revision" INTEGER NOT NULL DEFAULT 1, "requestKey" TEXT NOT NULL, "createdBy" TEXT NOT NULL,
 "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "deletedAt" BIGINT,
 CONSTRAINT "GarmentTrimTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GarmentTrimTask_developmentCaseId_requestKey_key" ON "GarmentTrimTask" ("developmentCaseId", "requestKey");
CREATE INDEX "GarmentTrimTask_developmentCaseId_deletedAt_idx" ON "GarmentTrimTask" ("developmentCaseId", "deletedAt");
CREATE TABLE "GarmentMaterialUse" (
 "id" TEXT NOT NULL, "developmentCaseId" TEXT NOT NULL, "sampleVersionId" TEXT,
 "productAssetId" TEXT NOT NULL, "trimTaskId" TEXT, "position" TEXT NOT NULL,
 "specification" TEXT, "color" TEXT, "perPiece" DECIMAL(18,4), "unit" TEXT,
 "provider" TEXT NOT NULL, "colorMode" TEXT NOT NULL, "colorReference" TEXT,
 "sourceNature" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "requestKey" TEXT NOT NULL, "createdBy" TEXT NOT NULL,
 "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "deletedAt" BIGINT,
 CONSTRAINT "GarmentMaterialUse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GarmentMaterialUse_developmentCaseId_requestKey_key" ON "GarmentMaterialUse" ("developmentCaseId", "requestKey");
CREATE INDEX "GarmentMaterialUse_developmentCaseId_sampleVersionId_deletedAt_idx" ON "GarmentMaterialUse" ("developmentCaseId", "sampleVersionId", "deletedAt");
CREATE INDEX "GarmentMaterialUse_productAssetId_idx" ON "GarmentMaterialUse" ("productAssetId");
CREATE INDEX "GarmentMaterialUse_trimTaskId_idx" ON "GarmentMaterialUse" ("trimTaskId");
