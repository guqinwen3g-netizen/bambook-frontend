-- Existing garment/count loans remain unchanged: all new meter-only facts are nullable.
ALTER TABLE "SampleCardLoan"
  ADD COLUMN "returnedLengthQty" DECIMAL(18,4),
  ADD COLUMN "lengthReturnHistory" JSONB,
  ADD COLUMN "meterRequestKey" TEXT,
  ADD COLUMN "meterCommandHash" TEXT;
CREATE UNIQUE INDEX "SampleCardLoan_operatorId_meterRequestKey_key" ON "SampleCardLoan"("operatorId", "meterRequestKey");
