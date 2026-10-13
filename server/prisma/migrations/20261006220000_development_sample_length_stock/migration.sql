ALTER TABLE "SampleCardItem"
  ADD COLUMN "physicalLengthQty" DECIMAL(18,4),
  ADD COLUMN "availableLengthQty" DECIMAL(18,4);

ALTER TABLE "SampleCardLoan"
  ADD COLUMN "loanLength" DECIMAL(18,4);

-- Migrate only legacy single-card yardage receipts whose immutable receipt
-- snapshot records the exact original meters and whose current whole-card
-- custody is unambiguous. Borrowed/ambiguous records keep a NULL available
-- length and fail closed until reconciled; no custody history is rewritten.
UPDATE "SampleCardItem"
SET "physicalLengthQty" = ("receiptSnapshot"->>'actualQuantity')::DECIMAL(18,4),
    "availableLengthQty" = CASE
      WHEN "status" IN ('shipped', 'retired') THEN 0
      WHEN "status" = 'in_stock' AND "availableQty" = 1 THEN ("receiptSnapshot"->>'actualQuantity')::DECIMAL(18,4)
      ELSE NULL
    END
WHERE "unit" = '米'
  AND "quantity" = 1
  AND "receiptSnapshot"->>'version' = '2'
  AND "receiptSnapshot"->>'actualUnit' = '米'
  AND "receiptSnapshot"->>'actualQuantity' ~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,4})?$';
