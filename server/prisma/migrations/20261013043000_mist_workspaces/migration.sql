-- Isolated Mist aggregates; existing business tables are untouched.
CREATE TABLE "MistWorkspace" (
  "id" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "state" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MistWorkspace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MistWorkspace_revision_check" CHECK ("revision" >= 0)
);
CREATE TABLE "MistCommandReceipt" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MistCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MistCommandReceipt_revision_check" CHECK ("expectedRevision" >= 0),
  CONSTRAINT "MistCommandReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "MistWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MistWorkspace_ownerId_slug_key" ON "MistWorkspace"("ownerId", "slug");
CREATE INDEX "MistWorkspace_ownerId_updatedAt_idx" ON "MistWorkspace"("ownerId", "updatedAt");
CREATE UNIQUE INDEX "MistCommandReceipt_workspaceId_requestId_key" ON "MistCommandReceipt"("workspaceId", "requestId");
CREATE INDEX "MistCommandReceipt_actorId_createdAt_idx" ON "MistCommandReceipt"("actorId", "createdAt");
