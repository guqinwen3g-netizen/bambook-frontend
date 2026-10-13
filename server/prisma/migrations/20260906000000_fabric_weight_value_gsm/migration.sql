-- 面料档案克重归一化字段 weightValueGsm（统一 g/m² 口径）
-- 录入/导入时按单位换算为 g/m² 存储，推荐/筛选/比较统一消费该归一化值，
-- 避免「180 g/m²」与「12 oz/yd²」混用（设计真源：unitConversion.weightToGsm）。
-- 幂等：ADD COLUMN IF NOT EXISTS + UPDATE 可重复执行（回填按单位 CASE 换算）。

-- AlterTable
ALTER TABLE "FabricProfile" ADD COLUMN IF NOT EXISTS "weightValueGsm" DOUBLE PRECISION;

-- 回填历史数据：gsm 系原样；oz/yd² ×33.9057；g/yd² ×1.196；无法识别按 gsm 原值（历史全库 gsm 口径）
UPDATE "FabricProfile"
SET "weightValueGsm" = ROUND(CAST(
  CASE
    WHEN LOWER(TRIM("weightUnit")) IN ('gsm','g/m2','g/m²','g/㎡','g/m','g/sqm','grams') THEN "weightValue"
    WHEN LOWER(TRIM("weightUnit")) IN ('ozyd','oz/yd2','oz/yd²','oz/sqyd','oz','ounce') THEN "weightValue" * 33.9057
    WHEN LOWER(TRIM("weightUnit")) IN ('g/yd2','g/yd²','g/sqyd') THEN "weightValue" * 1.196
    ELSE "weightValue"
  END AS numeric), 1)
WHERE "weightValue" IS NOT NULL AND "weightValueGsm" IS NULL;
