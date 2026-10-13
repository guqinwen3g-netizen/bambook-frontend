-- Record only new, explicitly inspected production-size facts. Historical
-- reports are left unknown rather than inferring coverage from planned sizes.
ALTER TABLE "InspectionReport" ADD COLUMN "productionSizeChecks" JSONB;
