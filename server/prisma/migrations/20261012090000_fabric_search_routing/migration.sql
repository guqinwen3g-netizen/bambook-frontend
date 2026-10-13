-- Existing directly assigned tasks retain their execution owner; nullable routing
-- columns preserve them without inventing a historical responsible team/head.
ALTER TABLE "FabricSearchTask" ALTER COLUMN "assigneeId" DROP NOT NULL;
ALTER TABLE "FabricSearchTask" ADD COLUMN "routingTeamId" TEXT;
ALTER TABLE "FabricSearchTask" ADD COLUMN "responsibleHeadId" TEXT;
ALTER TABLE "FabricSearchTask" ADD CONSTRAINT "FabricSearchTask_routingTeamId_fkey" FOREIGN KEY ("routingTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FabricSearchTask" ADD CONSTRAINT "FabricSearchTask_responsibleHeadId_fkey" FOREIGN KEY ("responsibleHeadId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "FabricSearchTask_routingTeamId_status_idx" ON "FabricSearchTask"("routingTeamId", "status");
CREATE INDEX "FabricSearchTask_responsibleHeadId_status_idx" ON "FabricSearchTask"("responsibleHeadId", "status");
