CREATE TABLE IF NOT EXISTS "SystemAsset" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "filePath" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "SystemAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SystemAsset_kind_idx" ON "SystemAsset"("kind");
CREATE INDEX IF NOT EXISTS "SystemAsset_hidden_idx" ON "SystemAsset"("hidden");
CREATE INDEX IF NOT EXISTS "SystemAsset_sortOrder_idx" ON "SystemAsset"("sortOrder");
