-- AlterTable: G1-3 报价正向关联（snapshot FK，不强制约束，均可空）
ALTER TABLE "Quotation" ADD COLUMN "developmentCaseId" TEXT;
ALTER TABLE "Quotation" ADD COLUMN "orderId" TEXT;
ALTER TABLE "Quotation" ADD COLUMN "orderLineId" TEXT;