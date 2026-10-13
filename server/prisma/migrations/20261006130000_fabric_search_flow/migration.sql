ALTER TABLE "FabricSearchTask" ADD COLUMN "feedbackNote" TEXT;
ALTER TABLE "FabricSearchTask" ADD COLUMN "flowHistory" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "FabricSearchResult" ADD COLUMN "recommendation" TEXT;
ALTER TABLE "FabricSearchTask" ALTER COLUMN "status" SET DEFAULT 'pending';
UPDATE "FabricSearchTask" SET "status"='pending' WHERE "status"='open';
