-- Backfill NULL itemNo on existing OrderLine rows so the unique index
-- (orderId, itemNo) can match them during upsert.
-- Uses lineNumber * 10 → 4-digit string (0010, 0020, …) to match the
-- display convention used by the front-end.

UPDATE "OrderLine"
SET "itemNo" = LPAD(CAST("lineNumber" * 10 AS TEXT), 4, '0')
WHERE "itemNo" IS NULL;
