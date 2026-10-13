-- T6-a 订舱段（H12）：订舱号/舱位确认/SO/截关截单/三单号（全部可空，存量零影响）
ALTER TABLE "Shipment" ADD COLUMN "bookingNo" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "soNumber" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "spaceConfirmedAt" BIGINT;
ALTER TABLE "Shipment" ADD COLUMN "cutOffAt" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "docCutOffAt" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "billOfLadingNo" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "masterBillNo" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "houseBillNo" TEXT;
