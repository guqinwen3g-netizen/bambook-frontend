ALTER TABLE "DevelopmentCase" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "DevelopmentCase" ADD CONSTRAINT "DevelopmentCase_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "FabricSearchTask" (
 "id" TEXT PRIMARY KEY, "code" TEXT NOT NULL UNIQUE, "requestKey" TEXT NOT NULL, "creationInput" JSONB NOT NULL,
 "name" TEXT NOT NULL, "initiator" TEXT NOT NULL, "requesterId" TEXT NOT NULL REFERENCES "UserAccount"("id"),
 "requestTeamId" TEXT REFERENCES "Team"("id"), "assigneeId" TEXT NOT NULL REFERENCES "UserAccount"("id"),
 "customerRelationId" TEXT, "customerName" TEXT, "requestText" TEXT NOT NULL, "targetDate" TEXT,
 "status" TEXT NOT NULL DEFAULT 'open', "revision" INTEGER NOT NULL DEFAULT 0, "completionNote" TEXT,
 "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("requesterId", "requestKey")
);
CREATE INDEX "FabricSearchTask_assigneeId_status_idx" ON "FabricSearchTask"("assigneeId","status");
CREATE INDEX "FabricSearchTask_requesterId_status_idx" ON "FabricSearchTask"("requesterId","status");
CREATE TABLE "FabricSearchResult" (
 "id" TEXT PRIMARY KEY, "taskId" TEXT NOT NULL REFERENCES "FabricSearchTask"("id") ON DELETE CASCADE,
 "assetId" TEXT NOT NULL REFERENCES "ProductAsset"("id"), "addedBy" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("taskId","assetId")
);
CREATE INDEX "FabricSearchResult_assetId_idx" ON "FabricSearchResult"("assetId");
