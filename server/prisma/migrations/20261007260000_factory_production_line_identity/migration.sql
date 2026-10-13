CREATE TABLE "FactoryProductionLine" (
  "id" TEXT NOT NULL,
  "factoryRelationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "location" TEXT,
  "state" TEXT NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "requestKey" TEXT NOT NULL,
  "parameterHash" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  CONSTRAINT "FactoryProductionLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FactoryProductionLine_factoryRelationId_name_key" ON "FactoryProductionLine"("factoryRelationId", "name");
CREATE UNIQUE INDEX "FactoryProductionLine_factory_actor_request_key" ON "FactoryProductionLine"("factoryRelationId", "createdBy", "requestKey");
CREATE INDEX "FactoryProductionLine_factoryRelationId_state_idx" ON "FactoryProductionLine"("factoryRelationId", "state");
ALTER TABLE "ProductionBatch" ADD COLUMN "productionLineId" TEXT, ADD COLUMN "productionLineSnapshot" JSONB;
CREATE INDEX "ProductionBatch_productionLineId_idx" ON "ProductionBatch"("productionLineId");
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_productionLineId_fkey" FOREIGN KEY ("productionLineId") REFERENCES "FactoryProductionLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderSampleCoverage" ADD COLUMN "productionLineIdentity" JSONB;
