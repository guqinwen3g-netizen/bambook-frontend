/*
  Warnings:

  - You are about to drop the column `color` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `materialName` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `pricePerUnit` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `referencePoNumber` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `season` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `shippingMark` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `styleNo` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `totalPrice` on the `OrderLine` table. All the data in the column will be lost.
  - You are about to drop the column `variantSize` on the `OrderLine` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "OrderLine" DROP COLUMN IF EXISTS "color",
DROP COLUMN IF EXISTS "materialName",
DROP COLUMN IF EXISTS "pricePerUnit",
DROP COLUMN IF EXISTS "referencePoNumber",
DROP COLUMN IF EXISTS "season",
DROP COLUMN IF EXISTS "shippingMark",
DROP COLUMN IF EXISTS "styleNo",
DROP COLUMN IF EXISTS "totalPrice",
DROP COLUMN IF EXISTS "variantSize",
ADD COLUMN IF NOT EXISTS     "category" TEXT,
ADD COLUMN IF NOT EXISTS     "cloth" TEXT,
ADD COLUMN IF NOT EXISTS     "description" TEXT,
ADD COLUMN IF NOT EXISTS     "exMillDate" TEXT,
ADD COLUMN IF NOT EXISTS     "itemNo" TEXT,
ADD COLUMN IF NOT EXISTS     "millQuality" TEXT,
ADD COLUMN IF NOT EXISTS     "netValue" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS     "notes" TEXT,
ADD COLUMN IF NOT EXISTS     "unitPrice" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS     "via" TEXT,
ADD COLUMN IF NOT EXISTS     "weight" TEXT,
ADD COLUMN IF NOT EXISTS     "width" TEXT;
