-- User decision: legacy Order.dueDate means Ex-mill, not contract delivery.
-- Preserve explicit item dates and independent delivery/arrival commitments.
UPDATE "Order" SET "clientDate" = "dueDate"
WHERE ("clientDate" IS NULL OR "clientDate" = '') AND "dueDate" ~ '^\d{4}-\d{2}-\d{2}$';
UPDATE "OrderLine" AS line SET "exMillDate" = header."clientDate"
FROM "Order" AS header WHERE line."orderId" = header.id
AND (line."exMillDate" IS NULL OR line."exMillDate" = '')
AND header."clientDate" IS NOT NULL AND header."clientDate" <> '';
UPDATE "Order" SET "dueDate" = "clientDate"
WHERE "clientDate" IS NOT NULL AND "clientDate" <> '' AND "dueDate" IS DISTINCT FROM "clientDate";
