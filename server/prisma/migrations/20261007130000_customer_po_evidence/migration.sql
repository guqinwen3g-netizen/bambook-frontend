CREATE TABLE "CustomerPoEvidence" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "CustomerPoEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerPoEvidence_orderId_version_key"
    ON "CustomerPoEvidence"("orderId", "version");

CREATE UNIQUE INDEX "CustomerPoEvidence_orderId_requestKey_key"
    ON "CustomerPoEvidence"("orderId", "requestKey");

CREATE INDEX "CustomerPoEvidence_orderId_createdAt_idx"
    ON "CustomerPoEvidence"("orderId", "createdAt");

ALTER TABLE "CustomerPoEvidence"
    ADD CONSTRAINT "CustomerPoEvidence_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
