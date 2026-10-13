-- CreateTable: §10.3-9 电子签·印章库 Seal（签章管理，渲染进 PDF）
CREATE TABLE "Seal" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'company_seal',
  "imageDataUrl" TEXT NOT NULL,
  "ownerRoleId" TEXT,
  "ownerUserId" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,

  CONSTRAINT "Seal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Seal_type_idx" ON "Seal"("type");
CREATE INDEX "Seal_isDefault_idx" ON "Seal"("isDefault");
CREATE INDEX "Seal_isActive_idx" ON "Seal"("isActive");
CREATE INDEX "Seal_ownerRoleId_idx" ON "Seal"("ownerRoleId");
CREATE INDEX "Seal_ownerUserId_idx" ON "Seal"("ownerUserId");
