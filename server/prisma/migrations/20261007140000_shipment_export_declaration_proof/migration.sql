ALTER TABLE "Shipment"
  ADD COLUMN "exportDeclarationCompletedAt" TEXT,
  ADD COLUMN "exportDeclarationReference" TEXT,
  ADD COLUMN "exportDeclarationEvidenceDocumentId" TEXT;

CREATE INDEX "Shipment_exportDeclarationEvidenceDocumentId_idx"
  ON "Shipment"("exportDeclarationEvidenceDocumentId");
