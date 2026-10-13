-- AlterTable: G3-4 订单结案（绿）留痕
ALTER TABLE "Order" ADD COLUMN "settledAt" BIGINT;
ALTER TABLE "Order" ADD COLUMN "settledBy" TEXT;