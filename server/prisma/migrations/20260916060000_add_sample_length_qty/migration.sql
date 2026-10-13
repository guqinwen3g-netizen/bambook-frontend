-- D6-Q1 米样长度口径：类型化 Decimal 长度字段 + append-only 台账
-- 历史数据不回填（attachments JSON 里的 sampleQuantity 语义混杂 ship/head/pioneer，非米样口径）
ALTER TABLE "Sample" ADD COLUMN "lengthQty" DECIMAL(18,4);
ALTER TABLE "Sample" ADD COLUMN "lengthUnit" TEXT;

-- CreateTable
CREATE TABLE "SampleLengthMovement" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "counterpartSampleId" TEXT,
    "balanceAfter" DECIMAL(18,4),
    "note" TEXT,
    "operator" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "SampleLengthMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SampleLengthMovement_sampleId_idx" ON "SampleLengthMovement"("sampleId");

-- CreateIndex
CREATE INDEX "SampleLengthMovement_type_idx" ON "SampleLengthMovement"("type");
