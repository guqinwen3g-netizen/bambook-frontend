-- New facts only: no historical approval, supplier confirmation, handoff or stock is inferred.
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "businessOwnerId" TEXT,
  ADD COLUMN "approvedCommitmentRevisionId" TEXT,
  ADD COLUMN "mainDeliveryLocationKey" TEXT,
  ADD COLUMN "mainDeliveryLocation" JSONB;
ALTER TABLE "PurchaseLine"
  ADD COLUMN "requestedDeliveryDate" TEXT,
  ADD COLUMN "supplierCommittedDeliveryDate" TEXT,
  ADD COLUMN "retiredAt" BIGINT;
ALTER TABLE "OutsourcingOrder"
  ADD COLUMN "businessOwnerId" TEXT,
  ADD COLUMN "approvedCommitmentRevisionId" TEXT,
  ADD COLUMN "paymentTerms" TEXT,
  ADD COLUMN "mainDeliveryLocationKey" TEXT,
  ADD COLUMN "mainDeliveryLocation" JSONB;
ALTER TABLE "OutsourcingLine"
  ADD COLUMN "orderLineId" TEXT,
  ADD COLUMN "requestedDeliveryDate" TEXT,
  ADD COLUMN "supplierCommittedDeliveryDate" TEXT,
  ADD COLUMN "specification" TEXT,
  ADD COLUMN "retiredAt" BIGINT;
ALTER TABLE "PurchaseDemandAllocation"
  ALTER COLUMN "purchaseOrderId" DROP NOT NULL,
  ALTER COLUMN "purchaseLineId" DROP NOT NULL,
  ADD COLUMN "outsourcingOrderId" TEXT,
  ADD COLUMN "outsourcingLineId" TEXT;
ALTER TABLE "PurchaseDemandAllocation" ADD CONSTRAINT "PurchaseDemandAllocation_one_contract_check" CHECK (
  ("purchaseOrderId" IS NOT NULL AND "purchaseLineId" IS NOT NULL AND "outsourcingOrderId" IS NULL AND "outsourcingLineId" IS NULL)
  OR ("purchaseOrderId" IS NULL AND "purchaseLineId" IS NULL AND "outsourcingOrderId" IS NOT NULL AND "outsourcingLineId" IS NOT NULL)
);
CREATE UNIQUE INDEX "PurchaseDemandAllocation_outsourcingLineId_key" ON "PurchaseDemandAllocation"("outsourcingLineId");
CREATE INDEX "PurchaseDemandAllocation_outsourcingOrderId_status_idx" ON "PurchaseDemandAllocation"("outsourcingOrderId", "status");

CREATE TABLE "SupplierCommitmentRevision" (
  "id" TEXT NOT NULL,
  "purchaseOrderId" TEXT,
  "outsourcingOrderId" TEXT,
  "revision" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "basedOnRevisionId" TEXT,
  "approvalRequestId" TEXT,
  "snapshot" JSONB NOT NULL,
  "contentFingerprint" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "submittedAt" BIGINT,
  "decidedAt" BIGINT,
  CONSTRAINT "SupplierCommitmentRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierCommitmentRevision_one_contract_check" CHECK (num_nonnulls("purchaseOrderId", "outsourcingOrderId") = 1),
  CONSTRAINT "SupplierCommitmentRevision_state_check" CHECK ("status" IN ('draft','pending','approved','rejected','superseded') AND "revision" > 0)
);
CREATE UNIQUE INDEX "SupplierCommitmentRevision_approvalRequestId_key" ON "SupplierCommitmentRevision"("approvalRequestId");
CREATE UNIQUE INDEX "SupplierCommitmentRevision_purchaseOrderId_revision_key" ON "SupplierCommitmentRevision"("purchaseOrderId", "revision");
CREATE UNIQUE INDEX "SupplierCommitmentRevision_outsourcingOrderId_revision_key" ON "SupplierCommitmentRevision"("outsourcingOrderId", "revision");
CREATE INDEX "SupplierCommitmentRevision_purchaseOrderId_status_idx" ON "SupplierCommitmentRevision"("purchaseOrderId", "status");
CREATE INDEX "SupplierCommitmentRevision_outsourcingOrderId_status_idx" ON "SupplierCommitmentRevision"("outsourcingOrderId", "status");
CREATE UNIQUE INDEX "SupplierCommitmentRevision_one_pending_purchase" ON "SupplierCommitmentRevision"("purchaseOrderId") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "SupplierCommitmentRevision_one_pending_processing" ON "SupplierCommitmentRevision"("outsourcingOrderId") WHERE "status" = 'pending';
ALTER TABLE "SupplierCommitmentRevision" ADD CONSTRAINT "SupplierCommitmentRevision_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierCommitmentRevision" ADD CONSTRAINT "SupplierCommitmentRevision_outsourcingOrderId_fkey" FOREIGN KEY ("outsourcingOrderId") REFERENCES "OutsourcingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approvedCommitmentRevisionId_fkey" FOREIGN KEY ("approvedCommitmentRevisionId") REFERENCES "SupplierCommitmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutsourcingOrder" ADD CONSTRAINT "OutsourcingOrder_approvedCommitmentRevisionId_fkey" FOREIGN KEY ("approvedCommitmentRevisionId") REFERENCES "SupplierCommitmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupplierContractCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "contractKind" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "requestSnapshot" JSONB NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "SupplierContractCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierContractCommandReceipt_kind_check" CHECK ("contractKind" IN ('purchase','processing'))
);
CREATE UNIQUE INDEX "SupplierContractCommandReceipt_actorId_requestKey_key" ON "SupplierContractCommandReceipt"("actorId", "requestKey");
CREATE INDEX "SupplierContractCommandReceipt_contract_created_idx" ON "SupplierContractCommandReceipt"("contractKind", "contractId", "createdAt");

CREATE TABLE "SupplierFulfillmentFact" (
  "id" TEXT NOT NULL,
  "commandReceiptId" TEXT NOT NULL,
  "lineSequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "commitmentRevisionId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "purchaseLineId" TEXT,
  "outsourcingLineId" TEXT,
  "sourceFactId" TEXT,
  "sourceStockMovementId" TEXT,
  "materialReceiptId" TEXT,
  "occurredAt" TEXT NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "unit" TEXT NOT NULL,
  "materialCode" TEXT,
  "specSnapshot" JSONB NOT NULL,
  "fromKind" TEXT NOT NULL,
  "fromRelationId" TEXT,
  "fromWarehouseId" TEXT,
  "toKind" TEXT NOT NULL,
  "toRelationId" TEXT,
  "toWarehouseId" TEXT,
  "partySnapshot" JSONB NOT NULL,
  "evidence" JSONB,
  "notes" TEXT,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  CONSTRAINT "SupplierFulfillmentFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierFulfillmentFact_quantity_check" CHECK ("quantity" > 0 AND "lineSequence" >= 0),
  CONSTRAINT "SupplierFulfillmentFact_kind_check" CHECK (
    ("kind" = 'purchase_delivery' AND "purchaseLineId" IS NOT NULL AND "outsourcingLineId" IS NULL)
    OR ("kind" = 'processing_input' AND "outsourcingLineId" IS NOT NULL)
    OR ("kind" = 'processing_return' AND "outsourcingLineId" IS NOT NULL AND "purchaseLineId" IS NULL)
  )
);
CREATE UNIQUE INDEX "SupplierFulfillmentFact_commandReceiptId_lineSequence_kind_key" ON "SupplierFulfillmentFact"("commandReceiptId", "lineSequence", "kind");
CREATE INDEX "SupplierFulfillmentFact_orderLineId_occurredAt_idx" ON "SupplierFulfillmentFact"("orderLineId", "occurredAt");
CREATE INDEX "SupplierFulfillmentFact_purchaseLineId_occurredAt_idx" ON "SupplierFulfillmentFact"("purchaseLineId", "occurredAt");
CREATE INDEX "SupplierFulfillmentFact_outsourcingLineId_occurredAt_idx" ON "SupplierFulfillmentFact"("outsourcingLineId", "occurredAt");
CREATE INDEX "SupplierFulfillmentFact_sourceFactId_idx" ON "SupplierFulfillmentFact"("sourceFactId");
CREATE INDEX "SupplierFulfillmentFact_commitmentRevisionId_idx" ON "SupplierFulfillmentFact"("commitmentRevisionId");
ALTER TABLE "SupplierFulfillmentFact" ADD CONSTRAINT "SupplierFulfillmentFact_commandReceiptId_fkey" FOREIGN KEY ("commandReceiptId") REFERENCES "SupplierContractCommandReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentFact" ADD CONSTRAINT "SupplierFulfillmentFact_commitmentRevisionId_fkey" FOREIGN KEY ("commitmentRevisionId") REFERENCES "SupplierCommitmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentFact" ADD CONSTRAINT "SupplierFulfillmentFact_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "PurchaseLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentFact" ADD CONSTRAINT "SupplierFulfillmentFact_outsourcingLineId_fkey" FOREIGN KEY ("outsourcingLineId") REFERENCES "OutsourcingLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierFulfillmentFact" ADD CONSTRAINT "SupplierFulfillmentFact_sourceFactId_fkey" FOREIGN KEY ("sourceFactId") REFERENCES "SupplierFulfillmentFact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "supplier_commitment_snapshot_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
    OR NEW."contentFingerprint" IS DISTINCT FROM OLD."contentFingerprint"
    OR NEW."purchaseOrderId" IS DISTINCT FROM OLD."purchaseOrderId"
    OR NEW."outsourcingOrderId" IS DISTINCT FROM OLD."outsourcingOrderId"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."basedOnRevisionId" IS DISTINCT FROM OLD."basedOnRevisionId"
    OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Supplier commitment snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SupplierCommitmentRevision_immutable" BEFORE UPDATE OR DELETE ON "SupplierCommitmentRevision" FOR EACH ROW EXECUTE FUNCTION "supplier_commitment_snapshot_immutable"();
CREATE FUNCTION "supplier_contract_fact_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Supplier contract facts and successful receipts are immutable';
END $$;
CREATE TRIGGER "SupplierFulfillmentFact_immutable" BEFORE UPDATE OR DELETE ON "SupplierFulfillmentFact" FOR EACH ROW EXECUTE FUNCTION "supplier_contract_fact_immutable"();
CREATE TRIGGER "SupplierContractCommandReceipt_immutable" BEFORE UPDATE OR DELETE ON "SupplierContractCommandReceipt" FOR EACH ROW EXECUTE FUNCTION "supplier_contract_fact_immutable"();
