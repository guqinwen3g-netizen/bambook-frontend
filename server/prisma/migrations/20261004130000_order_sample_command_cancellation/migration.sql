-- CreateTable
CREATE TABLE "OrderSampleCommandCancellation" (
    "id" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceId" TEXT,
    "commandHash" TEXT NOT NULL,
    "requestInput" JSONB NOT NULL,
    "receipt" JSONB NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "OrderSampleCommandCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderSampleCommandCancellation_auditId_key" ON "OrderSampleCommandCancellation"("auditId");

-- CreateIndex
CREATE INDEX "OrderSampleCommandCancellation_orderId_createdAt_idx" ON "OrderSampleCommandCancellation"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSampleCommandCancellation_actorId_requestKey_key" ON "OrderSampleCommandCancellation"("actorId", "requestKey");

-- AddForeignKey
ALTER TABLE "OrderSampleCommandCancellation" ADD CONSTRAINT "OrderSampleCommandCancellation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderSampleCommandCancellation" ADD CONSTRAINT "OrderSampleCommandCancellation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderSampleCommandCancellation" ADD CONSTRAINT "OrderSampleCommandCancellation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "OrderSampleSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderSampleCommandCancellation" ADD CONSTRAINT "OrderSampleCommandCancellation_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- This migration follows the three-table native sample migration. A tombstone
-- records an explicit employee command cancellation, never a business decision.
ALTER TABLE "OrderSampleCommandCancellation" ADD CONSTRAINT "OrderSampleCommandCancellation_protocol_check" CHECK (
  "protocolVersion"=1 AND "createdAt">0 AND length("id")>0 AND
  "requestKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND
  "operation" IN ('register','append') AND
  (("operation"='register' AND "sourceId" IS NULL) OR ("operation"='append' AND "sourceId" IS NOT NULL)) AND
  "commandHash" ~ '^[a-f0-9]{64}$' AND "receiptHash" ~ '^[a-f0-9]{64}$' AND
  jsonb_typeof("requestInput")='object' AND jsonb_typeof("receipt")='object');
CREATE FUNCTION bambook_order_sample_cancel_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE audit_row "AuditLog"%ROWTYPE; fact JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('order-sample-v1:' || NEW."actorId" || ':' || NEW."requestKey",0));
  IF EXISTS(SELECT 1 FROM "OrderSampleEvent" WHERE "actorId"=NEW."actorId" AND "requestKey"=NEW."requestKey" AND "protocolVersion"=1) THEN
    RAISE EXCEPTION 'Committed order sample event cannot acquire a cancellation tombstone' USING ERRCODE='23514';
  END IF;
  IF NEW."sourceId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "OrderSampleSource" WHERE "id"=NEW."sourceId" AND "orderId"=NEW."orderId") THEN
    RAISE EXCEPTION 'Cancellation source belongs to another order' USING ERRCODE='23514';
  END IF;
  IF NEW."requestInput"->>'operation' IS DISTINCT FROM NEW."operation" OR
     NEW."requestInput"->'input'->>'requestKey' IS DISTINCT FROM NEW."requestKey" OR
     (NEW."operation"='register' AND NEW."requestInput"->'input'->>'orderId' IS DISTINCT FROM NEW."orderId") OR
     (NEW."operation"='append' AND NEW."requestInput"->'input'->>'sourceId' IS DISTINCT FROM NEW."sourceId") THEN
    RAISE EXCEPTION 'Cancellation request identity differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO audit_row FROM "AuditLog" WHERE "id"=NEW."auditId";
  fact := (to_jsonb(NEW)-ARRAY['receipt','receiptHash','createdAt']) || jsonb_build_object('createdAt',NEW."createdAt"::TEXT);
  IF NOT FOUND OR audit_row."actorId" IS DISTINCT FROM NEW."actorId" OR
     audit_row."action" IS DISTINCT FROM 'cancel_order_sample_command' OR
     audit_row."targetType" IS DISTINCT FROM 'OrderSampleCommandCancellation' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id" OR audit_row."transactionId" IS DISTINCT FROM NEW."id" OR
     (extract(epoch from audit_row."createdAt")*1000)::BIGINT IS DISTINCT FROM NEW."createdAt" OR
     audit_row."detail"->>'protocol' IS DISTINCT FROM 'order_sample_command_cancel_v1' OR
     audit_row."detail"->>'source' IS DISTINCT FROM 'route:samples:order-native:cancel' OR
     audit_row."detail"->'after' IS DISTINCT FROM jsonb_build_object('fact',fact,'receipt',NEW."receipt") THEN
    RAISE EXCEPTION 'Cancellation requires its actual exact audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION bambook_order_sample_event_cancel_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('order-sample-v1:' || NEW."actorId" || ':' || NEW."requestKey",0));
  IF EXISTS(SELECT 1 FROM "OrderSampleCommandCancellation" WHERE "actorId"=NEW."actorId" AND "requestKey"=NEW."requestKey") THEN
    RAISE EXCEPTION 'Explicitly cancelled order sample command cannot commit a late event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderSampleCommandCancellation_guard" BEFORE INSERT ON "OrderSampleCommandCancellation" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_cancel_guard();
CREATE TRIGGER "OrderSampleCommandCancellation_immutable" BEFORE UPDATE OR DELETE ON "OrderSampleCommandCancellation" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleCommandCancellation_no_truncate" BEFORE TRUNCATE ON "OrderSampleCommandCancellation" FOR EACH STATEMENT EXECUTE FUNCTION bambook_order_sample_immutable();
-- The c-name sorts before the existing event g-guard: request lock precedes Source.
CREATE TRIGGER "OrderSampleEvent_cancelled_command_guard" BEFORE INSERT ON "OrderSampleEvent" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_event_cancel_guard();
