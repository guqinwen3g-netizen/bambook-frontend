-- Preserve the exact native shipment and round behind development shipping costs.
-- Existing records remain unbound until explicitly reconciled from real evidence.
ALTER TABLE "CostRecord" ADD COLUMN "developmentShippingSource" JSONB;
