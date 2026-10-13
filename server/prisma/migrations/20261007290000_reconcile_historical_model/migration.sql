-- Reconcile actual historical migration output with the current model.
-- No business facts, statuses, ownership or history rows are rewritten.
-- The same factory may participate again; uniqueness belongs to the exact
-- round/factory/version identity rather than the historical supplier directory.
BEGIN;
-- DropForeignKey
ALTER TABLE "FabricSearchResult" DROP CONSTRAINT IF EXISTS "FabricSearchResult_assetId_fkey";

-- DropForeignKey
ALTER TABLE "FabricSearchResult" DROP CONSTRAINT IF EXISTS "FabricSearchResult_taskId_fkey";

-- DropForeignKey
ALTER TABLE "FabricSearchTask" DROP CONSTRAINT IF EXISTS "FabricSearchTask_assigneeId_fkey";

-- DropForeignKey
ALTER TABLE "FabricSearchTask" DROP CONSTRAINT IF EXISTS "FabricSearchTask_requestTeamId_fkey";

-- DropForeignKey
ALTER TABLE "FabricSearchTask" DROP CONSTRAINT IF EXISTS "FabricSearchTask_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryTransfer" DROP CONSTRAINT IF EXISTS "InventoryTransfer_sourceItemId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryTransfer" DROP CONSTRAINT IF EXISTS "InventoryTransfer_targetWarehouseId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "DevelopmentSupplier_developmentCaseId_supplierRelationId_key";

-- AddForeignKey
ALTER TABLE "FabricSearchTask" ADD CONSTRAINT "FabricSearchTask_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricSearchTask" ADD CONSTRAINT "FabricSearchTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricSearchTask" ADD CONSTRAINT "FabricSearchTask_requestTeamId_fkey" FOREIGN KEY ("requestTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricSearchResult" ADD CONSTRAINT "FabricSearchResult_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FabricSearchTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricSearchResult" ADD CONSTRAINT "FabricSearchResult_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ProductAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_targetWarehouseId_fkey" FOREIGN KEY ("targetWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$ BEGIN
  IF to_regclass('"DevelopmentSampleQualityReview_developmentCaseId_requestedAt_id"') IS NOT NULL
     AND to_regclass('"DevelopmentSampleQualityReview_developmentCaseId_requestedA_idx"') IS NULL THEN
    ALTER INDEX "DevelopmentSampleQualityReview_developmentCaseId_requestedAt_id" RENAME TO "DevelopmentSampleQualityReview_developmentCaseId_requestedA_idx";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"DevelopmentSampleVersion_roundId_supplierRelationId_minorVersio"') IS NOT NULL
     AND to_regclass('"DevelopmentSampleVersion_roundId_supplierRelationId_minorVe_key"') IS NULL THEN
    ALTER INDEX "DevelopmentSampleVersion_roundId_supplierRelationId_minorVersio" RENAME TO "DevelopmentSampleVersion_roundId_supplierRelationId_minorVe_key";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionBatchCompletion_batch_revision_idx"') IS NOT NULL
     AND to_regclass('"ProductionBatchCompletion_productionBatchId_productionBatch_idx"') IS NULL THEN
    ALTER INDEX "ProductionBatchCompletion_batch_revision_idx" RENAME TO "ProductionBatchCompletion_productionBatchId_productionBatch_idx";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionBatchCompletion_batch_revision_key"') IS NOT NULL
     AND to_regclass('"ProductionBatchCompletion_productionBatchId_productionBatch_key"') IS NULL THEN
    ALTER INDEX "ProductionBatchCompletion_batch_revision_key" RENAME TO "ProductionBatchCompletion_productionBatchId_productionBatch_key";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionBatchCompletion_order_line_recorded_idx"') IS NOT NULL
     AND to_regclass('"ProductionBatchCompletion_orderId_orderLineId_recordedAt_idx"') IS NULL THEN
    ALTER INDEX "ProductionBatchCompletion_order_line_recorded_idx" RENAME TO "ProductionBatchCompletion_orderId_orderLineId_recordedAt_idx";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionBatchCompletion_recorder_request_key"') IS NOT NULL
     AND to_regclass('"ProductionBatchCompletion_recordedBy_requestKey_key"') IS NULL THEN
    ALTER INDEX "ProductionBatchCompletion_recorder_request_key" RENAME TO "ProductionBatchCompletion_recordedBy_requestKey_key";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionQcIssue_productionBatchId_productionBatchRevision_cre"') IS NOT NULL
     AND to_regclass('"ProductionQcIssue_productionBatchId_productionBatchRevision_idx"') IS NULL THEN
    ALTER INDEX "ProductionQcIssue_productionBatchId_productionBatchRevision_cre" RENAME TO "ProductionQcIssue_productionBatchId_productionBatchRevision_idx";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ProductionQcIssueEvent_productionBatchId_productionBatchRevisio"') IS NOT NULL
     AND to_regclass('"ProductionQcIssueEvent_productionBatchId_productionBatchRev_idx"') IS NULL THEN
    ALTER INDEX "ProductionQcIssueEvent_productionBatchId_productionBatchRevisio" RENAME TO "ProductionQcIssueEvent_productionBatchId_productionBatchRev_idx";
  END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('"ShipmentHandoffLine_productionBatchId_productionBatchRevision_i"') IS NOT NULL
     AND to_regclass('"ShipmentHandoffLine_productionBatchId_productionBatchRevisi_idx"') IS NULL THEN
    ALTER INDEX "ShipmentHandoffLine_productionBatchId_productionBatchRevision_i" RENAME TO "ShipmentHandoffLine_productionBatchId_productionBatchRevisi_idx";
  END IF;
END $$;
-- Preserve indexes introduced by earlier migrations, including when
-- upgrading a model-created acceptance baseline that did not declare them.
CREATE INDEX IF NOT EXISTS "InventoryItem_ownerRelationId_idx" ON "InventoryItem"("ownerRelationId");
CREATE INDEX IF NOT EXISTS "ProductAsset_sourceDevelopmentCaseId_idx" ON "ProductAsset"("sourceDevelopmentCaseId");
CREATE INDEX IF NOT EXISTS "Shipment_exportDeclarationEvidenceDocumentId_idx" ON "Shipment"("exportDeclarationEvidenceDocumentId");
COMMIT;
