-- Preserve existing plans and immutable production facts. Historical rows
-- remain NULL because their per-size quantities cannot be reconstructed.
ALTER TABLE "ProductionBatch"
  ADD COLUMN "sizeBreakdown" JSONB;

ALTER TABLE "ProductionBatchCompletion"
  ADD COLUMN "actualSizeBreakdown" JSONB;
