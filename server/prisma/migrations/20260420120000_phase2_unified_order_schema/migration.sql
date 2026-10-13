-- Phase 2: Unified order schema migration.
--
-- Goals:
--   1. Persist the rich detail-card fields that until now lived only in the
--      browser's localStorage (sample/invoice/payment/purchase tracking).
--   2. Introduce role-aware fields: Mill (面料工厂/supplier), Consignee
--      (服装厂/ship-to), Bill-to (结款方) — each with a name snapshot and an
--      optional Relation FK reference.
--   3. Add per-field provenance (`fieldSources`) so PDF re-imports never
--      overwrite a field a user has manually edited.
--   4. Split currency: purchase amounts default to CNY, sales amounts to USD.
--   5. Migrate existing `factoryName` data to the correct new column based on
--      `source` (manual rows → `millName`, PDF rows → `consigneeName`). The
--      old `factoryName` column is kept for one release as a compat shim and
--      will be dropped in Phase 6.
--
-- This migration is intentionally additive — no destructive DROP COLUMN runs
-- in this release. Phase 6 follows up with the cleanup migration.

-- =============================================================================
-- 1. Per-field provenance + currency split
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "fieldSources" JSONB,
  ADD COLUMN IF NOT EXISTS "purchaseCurrency" TEXT,
  ADD COLUMN IF NOT EXISTS "salesCurrency" TEXT;

-- =============================================================================
-- 2. Role snapshots + Relation FK references (no FK constraints — snapshots)
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "customerRelationId" TEXT;

-- Mill / 面料工厂
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "millName" TEXT,
  ADD COLUMN IF NOT EXISTS "millAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "millContact" TEXT,
  ADD COLUMN IF NOT EXISTS "millPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "millRelationId" TEXT;

-- Consignee / 服装厂收货方
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "consigneeName" TEXT,
  ADD COLUMN IF NOT EXISTS "consigneeAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "consigneeContact" TEXT,
  ADD COLUMN IF NOT EXISTS "consigneeRelationId" TEXT;

-- Bill-to / 结款方
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "billToName" TEXT,
  ADD COLUMN IF NOT EXISTS "billToAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "billToContact" TEXT,
  ADD COLUMN IF NOT EXISTS "billToIsAgent" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "billToRelationId" TEXT;

-- =============================================================================
-- 3. Contracts
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "salesContractNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "finalContractNumber" TEXT;

-- =============================================================================
-- 4. Production / OTS / fabric specs (sticky overlay on top of firstLine)
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "productionBatch" TEXT,
  ADD COLUMN IF NOT EXISTS "productColorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "clientCode" TEXT,
  ADD COLUMN IF NOT EXISTS "referenceBatch" TEXT,
  ADD COLUMN IF NOT EXISTS "productionDate" TEXT,
  ADD COLUMN IF NOT EXISTS "clientDate" TEXT,
  ADD COLUMN IF NOT EXISTS "fabricCode" TEXT,
  ADD COLUMN IF NOT EXISTS "fabricContent" TEXT,
  ADD COLUMN IF NOT EXISTS "width" TEXT,
  ADD COLUMN IF NOT EXISTS "gsm" TEXT,
  ADD COLUMN IF NOT EXISTS "asPerson" TEXT;

-- =============================================================================
-- 5. Sales / collection
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "salesPrice" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "contractAmount" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "paymentInstrument" TEXT,
  ADD COLUMN IF NOT EXISTS "expectedPaymentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "actualPaymentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "actualPaymentAmount" DOUBLE PRECISION;

-- =============================================================================
-- 6. Shipment & invoice (我方开给 Bill-to)
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "invoiceDate" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentQuantity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "shipmentAmount" DOUBLE PRECISION;

-- =============================================================================
-- 7. Sample tracking
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "sampleSentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "sampleConfirmedDate" TEXT,
  ADD COLUMN IF NOT EXISTS "sampleTrackingNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "shipmentSampleComments" TEXT,
  ADD COLUMN IF NOT EXISTS "fabricSampleSentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "fabricSampleConfirmedDate" TEXT,
  ADD COLUMN IF NOT EXISTS "fabricSampleTrackingNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "paidSampleQuantity" DOUBLE PRECISION;

-- =============================================================================
-- 8. Purchase / supplier invoice (我方付给 Mill)
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "purchasePrice" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchasePaymentDate" TEXT,
  ADD COLUMN IF NOT EXISTS "supplierInvoiceNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "supplierInvoiceDate" TEXT,
  ADD COLUMN IF NOT EXISTS "supplierInvoiceAmount" DOUBLE PRECISION;

-- =============================================================================
-- 9. Misc
-- =============================================================================
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "specialInstructions" TEXT,
  ADD COLUMN IF NOT EXISTS "ocDays" INTEGER;

-- =============================================================================
-- 10. Indexes for the new role columns
-- =============================================================================
CREATE INDEX IF NOT EXISTS "Order_millName_idx"      ON "Order"("millName");
CREATE INDEX IF NOT EXISTS "Order_consigneeName_idx" ON "Order"("consigneeName");
CREATE INDEX IF NOT EXISTS "Order_billToName_idx"    ON "Order"("billToName");

-- =============================================================================
-- 11. Data migration: split the legacy `factoryName` column based on `source`.
--
-- Pre-Phase-2 semantics:
--   - source = 'pdf-import'  →  factoryName was set to ship-to company
--                                (i.e. it really meant *consignee*)
--   - source = 'manual'      →  factoryName was the actual mill/supplier name
--   - source IS NULL         →  legacy fabric demo data; treat as manual
--
-- We backfill the new columns with the existing values but leave `factoryName`
-- untouched so any code still reading the old column keeps working through one
-- release of the cutover. Phase 6 drops `factoryName` once nothing reads it.
-- =============================================================================
UPDATE "Order"
   SET "millName" = "factoryName"
 WHERE "millName" IS NULL
   AND "factoryName" IS NOT NULL
   AND "factoryName" <> ''
   AND ("source" = 'manual' OR "source" IS NULL);

UPDATE "Order"
   SET "consigneeName" = "factoryName",
       "consigneeAddress" = NULLIF(
         TRIM(BOTH FROM
           COALESCE("shipToAddress1", '') ||
           CASE
             WHEN COALESCE("shipToAddress1", '') <> '' AND COALESCE("shipToAddress2", '') <> ''
             THEN ' '
             ELSE ''
           END ||
           COALESCE("shipToAddress2", '')
         ),
         ''
       )
 WHERE "consigneeName" IS NULL
   AND "factoryName" IS NOT NULL
   AND "factoryName" <> ''
   AND "source" = 'pdf-import';

-- Default currencies for already-existing orders: imported orders inherit the
-- per-PO `currency` (or USD); manual orders default to USD sales / CNY purchase.
UPDATE "Order"
   SET "salesCurrency" = COALESCE("currency", 'USD')
 WHERE "salesCurrency" IS NULL;

UPDATE "Order"
   SET "purchaseCurrency" = 'CNY'
 WHERE "purchaseCurrency" IS NULL;
