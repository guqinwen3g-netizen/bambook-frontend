-- Additive only. No historical mode, rate, supplier or status is inferred.
ALTER TABLE "OrderLine"
  ADD COLUMN "fabricSupplyMode" TEXT,
  ADD COLUMN "fabricCommissionRate" DECIMAL(8,4),
  ADD COLUMN "fabricCommissionSupplierId" TEXT;

ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_fabric_supply_terms_check" CHECK ((
  ("fabricSupplyMode" IS NULL AND "fabricCommissionRate" IS NULL AND "fabricCommissionSupplierId" IS NULL)
  OR ("fabricSupplyMode" IN ('finished_purchase','raw_material_processing') AND "fabricCommissionRate" IS NULL AND "fabricCommissionSupplierId" IS NULL)
  OR ("fabricSupplyMode" = 'commission' AND "fabricCommissionRate" > 0 AND "fabricCommissionRate" <= 100
      AND "fabricCommissionSupplierId" IS NOT NULL AND length(trim("fabricCommissionSupplierId")) > 0)
) IS TRUE);
