-- Additive three-model delta over the installed company schema255 baseline.
-- Creates three order-domain models only. No email DDL, historical backfill,
-- inferred source/approval, inventory mutation, or change to existing columns.
-- Payload/audit JSON hashes and current parent compatibility remain producer /
-- record-reader responsibilities; these constraints enforce stored identity,
-- immutable facts, non-overlapping coverage, and a complete committed chain.

CREATE FUNCTION bambook_order_sample_valid_date(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE actual DATE;
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(value, 4) = '0000' THEN RETURN FALSE; END IF;
  BEGIN actual := value::DATE;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN FALSE;
  END;
  RETURN to_char(actual, 'YYYY-MM-DD') = value;
END;
$$;

CREATE TABLE "OrderSampleSource" (
  "id" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "businessLine" TEXT NOT NULL,
  "family" TEXT NOT NULL,
  "factoryRelationId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "previousSourceId" TEXT,
  "provenance" TEXT NOT NULL,
  "specSnapshot" JSONB NOT NULL,
  "sampleQuantity" DECIMAL(18,4) NOT NULL,
  "sampleUnit" TEXT NOT NULL,
  "cuttingDate" TEXT NOT NULL,
  "contentFingerprint" TEXT NOT NULL,
  "coverageFingerprint" TEXT NOT NULL,
  "creationAuditId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "headSequence" INTEGER NOT NULL DEFAULT 0,
  "headEventId" TEXT,
  CONSTRAINT "OrderSampleSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderSampleSource_identity_check" CHECK (
    length(btrim("id")) > 0 AND length(btrim("sampleId")) > 0 AND
    length(btrim("chainId")) > 0 AND "createdAt" > 0),
  CONSTRAINT "OrderSampleSource_family_check" CHECK (
    ("businessLine" = 'fabric' AND "family" IN ('fabric_ss','fabric_rc','fabric_eps')) OR
    ("businessLine" = 'garment' AND "family" IN ('garment_pp','garment_top','garment_ship'))),
  CONSTRAINT "OrderSampleSource_round_check" CHECK (
    "round" >= 1 AND (("round" = 1 AND "previousSourceId" IS NULL) OR
    ("round" > 1 AND "previousSourceId" IS NOT NULL))),
  CONSTRAINT "OrderSampleSource_provenance_check" CHECK (
    "provenance" IN ('native_new','current_link_recorded','legacy_recorded')),
  CONSTRAINT "OrderSampleSource_measure_check" CHECK (
    "sampleQuantity" > 0 AND "sampleQuantity" <> 'NaN'::NUMERIC AND
    "sampleUnit" IN ('M','YD','PC','KG') AND bambook_order_sample_valid_date("cuttingDate")),
  CONSTRAINT "OrderSampleSource_fingerprints_check" CHECK (
    "contentFingerprint" ~ '^[a-f0-9]{64}$' AND "coverageFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "OrderSampleSource_head_check" CHECK (
    ("headSequence" = 0 AND "headEventId" IS NULL) OR
    ("headSequence" >= 1 AND "headEventId" IS NOT NULL))
);

CREATE TABLE "OrderSampleCoverage" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "scopeKind" TEXT NOT NULL,
  "productionBatchId" TEXT,
  "productionBatchRevision" INTEGER,
  "rangeStart" DECIMAL(18,4) NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "unit" TEXT NOT NULL,
  "lineQuantity" DECIMAL(18,4) NOT NULL,
  "lineFingerprint" TEXT NOT NULL,
  "batchRangeStart" DECIMAL(18,4),
  "batchQuantity" DECIMAL(18,4),
  "specFingerprint" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  CONSTRAINT "OrderSampleCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderSampleCoverage_scope_key_check" CHECK (length(btrim("scopeKey")) > 0),
  CONSTRAINT "OrderSampleCoverage_range_check" CHECK (
    "rangeStart" >= 0 AND "rangeStart" <> 'NaN'::NUMERIC AND
    "quantity" > 0 AND "quantity" <> 'NaN'::NUMERIC AND
    "lineQuantity" > 0 AND "lineQuantity" <> 'NaN'::NUMERIC AND
    "rangeStart" + "quantity" <= "lineQuantity" AND "unit" IN ('M','YD','PC','KG')),
  CONSTRAINT "OrderSampleCoverage_batch_check" CHECK (
    ("scopeKind" = 'order_line' AND "productionBatchId" IS NULL AND
      "productionBatchRevision" IS NULL AND "batchRangeStart" IS NULL AND "batchQuantity" IS NULL) OR
    ("scopeKind" = 'production_batch' AND "productionBatchId" IS NOT NULL AND
      "productionBatchRevision" IS NOT NULL AND "productionBatchRevision" >= 1 AND
      "batchRangeStart" IS NOT NULL AND "batchRangeStart" >= 0 AND "batchRangeStart" <> 'NaN'::NUMERIC AND
      "batchQuantity" IS NOT NULL AND "batchQuantity" > 0 AND "batchQuantity" <> 'NaN'::NUMERIC AND
      "rangeStart" >= "batchRangeStart" AND
      "rangeStart" + "quantity" <= "batchRangeStart" + "batchQuantity" AND
      "batchRangeStart" + "batchQuantity" <= "lineQuantity")),
  CONSTRAINT "OrderSampleCoverage_fingerprints_check" CHECK (
    "lineFingerprint" ~ '^[a-f0-9]{64}$' AND "specFingerprint" ~ '^[a-f0-9]{64}$' AND
    "sourceFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "OrderSampleEvent" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "previousEventId" TEXT,
  "eventType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  "occurredAt" TEXT NOT NULL,
  "contentFingerprint" TEXT NOT NULL,
  "coverageFingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "auditId" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "commandHash" TEXT NOT NULL,
  "commandSnapshot" JSONB NOT NULL,
  "acknowledgement" JSONB NOT NULL,
  "ackHash" TEXT NOT NULL,
  "qcReportId" TEXT,
  "qcReportRevision" INTEGER,
  "qcReportAuditId" TEXT,
  CONSTRAINT "OrderSampleEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderSampleEvent_sequence_check" CHECK (
    "sequence" >= 1 AND (("sequence" = 1 AND "previousEventId" IS NULL) OR
      ("sequence" > 1 AND "previousEventId" IS NOT NULL))),
  CONSTRAINT "OrderSampleEvent_type_check" CHECK (
    "eventType" IN ('registered','shipped','customer_feedback','qc_requested','qc_reviewed','retained','invalidated','legacy_linked')),
  CONSTRAINT "OrderSampleEvent_time_check" CHECK (
    "recordedAt" > 0 AND bambook_order_sample_valid_date("occurredAt")),
  CONSTRAINT "OrderSampleEvent_command_check" CHECK (
    "protocolVersion" = 1 AND length("requestKey") BETWEEN 8 AND 128 AND
    "requestKey" ~ '^[A-Za-z0-9._:-]+$' AND
    jsonb_typeof("payload") = 'object' AND jsonb_typeof("commandSnapshot") = 'object' AND
    jsonb_typeof("acknowledgement") = 'object'),
  CONSTRAINT "OrderSampleEvent_fingerprints_check" CHECK (
    "contentFingerprint" ~ '^[a-f0-9]{64}$' AND "coverageFingerprint" ~ '^[a-f0-9]{64}$' AND
    "commandHash" ~ '^[a-f0-9]{64}$' AND "ackHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "OrderSampleEvent_qc_check" CHECK (
    ("eventType" = 'qc_reviewed' AND "qcReportId" IS NOT NULL AND "qcReportRevision" IS NOT NULL AND
      "qcReportRevision" >= 1 AND "qcReportAuditId" IS NOT NULL AND "qcReportAuditId" <> "auditId") OR
    ("eventType" <> 'qc_reviewed' AND "qcReportId" IS NULL AND "qcReportRevision" IS NULL AND "qcReportAuditId" IS NULL))
);

CREATE UNIQUE INDEX "OrderSampleSource_sampleId_key" ON "OrderSampleSource"("sampleId");
CREATE UNIQUE INDEX "OrderSampleSource_creationAuditId_key" ON "OrderSampleSource"("creationAuditId");
CREATE UNIQUE INDEX "OrderSampleSource_chainId_round_key" ON "OrderSampleSource"("chainId","round");
CREATE UNIQUE INDEX "OrderSampleSource_previousSourceId_key" ON "OrderSampleSource"("previousSourceId") WHERE "previousSourceId" IS NOT NULL;
CREATE INDEX "OrderSampleSource_orderId_family_factoryRelationId_idx" ON "OrderSampleSource"("orderId","family","factoryRelationId");
CREATE UNIQUE INDEX "OrderSampleCoverage_sourceId_scopeKey_key" ON "OrderSampleCoverage"("sourceId","scopeKey");
CREATE INDEX "OrderSampleCoverage_orderLineId_idx" ON "OrderSampleCoverage"("orderLineId");
CREATE INDEX "OrderSampleCoverage_batch_revision_source_idx" ON "OrderSampleCoverage"("productionBatchId","productionBatchRevision","sourceId");
CREATE UNIQUE INDEX "OrderSampleEvent_auditId_key" ON "OrderSampleEvent"("auditId");
CREATE UNIQUE INDEX "OrderSampleEvent_sourceId_sequence_key" ON "OrderSampleEvent"("sourceId","sequence");
CREATE UNIQUE INDEX "OrderSampleEvent_protocolVersion_actorId_requestKey_key" ON "OrderSampleEvent"("protocolVersion","actorId","requestKey");
CREATE UNIQUE INDEX "OrderSampleEvent_sourceId_id_key" ON "OrderSampleEvent"("sourceId","id");
CREATE UNIQUE INDEX "OrderSampleEvent_sourceId_sequence_id_key" ON "OrderSampleEvent"("sourceId","sequence","id");
CREATE INDEX "OrderSampleEvent_qcReportId_qcReportRevision_idx" ON "OrderSampleEvent"("qcReportId","qcReportRevision");
CREATE INDEX "OrderSampleEvent_qcReportAuditId_idx" ON "OrderSampleEvent"("qcReportAuditId");

ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "Sample"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_factoryRelationId_fkey" FOREIGN KEY ("factoryRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_creationAuditId_fkey" FOREIGN KEY ("creationAuditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_previousSourceId_fkey" FOREIGN KEY ("previousSourceId") REFERENCES "OrderSampleSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleCoverage" ADD CONSTRAINT "OrderSampleCoverage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "OrderSampleSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleCoverage" ADD CONSTRAINT "OrderSampleCoverage_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleCoverage" ADD CONSTRAINT "OrderSampleCoverage_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "ProductionBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "OrderSampleSource"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_sourceId_previousEventId_fkey" FOREIGN KEY ("sourceId","previousEventId") REFERENCES "OrderSampleEvent"("sourceId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_qcReportId_fkey" FOREIGN KEY ("qcReportId") REFERENCES "InspectionReport"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleEvent" ADD CONSTRAINT "OrderSampleEvent_qcReportAuditId_fkey" FOREIGN KEY ("qcReportAuditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderSampleSource" ADD CONSTRAINT "OrderSampleSource_headEvent_fkey" FOREIGN KEY ("id","headSequence","headEventId") REFERENCES "OrderSampleEvent"("sourceId","sequence","id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bambook_order_sample_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION bambook_order_sample_source_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE sample_projection TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Birth locks Sample before the not-yet-existing Source. Event/head paths
    -- lock Source only, never discover/late-lock a Sample behind Source.
    SELECT "projectionKey" INTO sample_projection FROM "Sample" WHERE "id" = NEW."sampleId" FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order sample parent is missing' USING ERRCODE = '23503'; END IF;
    IF sample_projection IS NOT NULL OR EXISTS (SELECT 1 FROM "SampleSource" WHERE "sampleId" = NEW."sampleId") THEN
      RAISE EXCEPTION 'Case/canonical sample cannot acquire order-domain source' USING ERRCODE = '23514';
    END IF;
    IF NEW."headSequence" <> 0 OR NEW."headEventId" IS NOT NULL THEN
      RAISE EXCEPTION 'Order sample birth must begin with empty transactional head' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['headSequence','headEventId']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['headSequence','headEventId']) THEN
      RAISE EXCEPTION 'Order sample source facts are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."headSequence" <> OLD."headSequence" + 1 OR NEW."headEventId" IS NULL OR
       NEW."headEventId" IS NOT DISTINCT FROM OLD."headEventId" THEN
      RAISE EXCEPTION 'Order sample head must advance exactly one event' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bambook_order_sample_coverage_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE source_row "OrderSampleSource"%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM "OrderSampleSource" WHERE "id" = NEW."sourceId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Coverage source is missing' USING ERRCODE = '23503'; END IF;
  IF source_row."headSequence" <> 0 THEN
    RAISE EXCEPTION 'Coverage is frozen once the source is registered' USING ERRCODE = '23514';
  END IF;
  IF NEW."scopeKind" = 'order_line' AND source_row."family" <> 'garment_pp' THEN
    RAISE EXCEPTION 'This order sample family requires a production batch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderSampleCoverage" c WHERE c."sourceId" = NEW."sourceId" AND c."orderLineId" = NEW."orderLineId" AND
    (c."unit" IS DISTINCT FROM NEW."unit" OR c."lineQuantity" IS DISTINCT FROM NEW."lineQuantity" OR
     c."lineFingerprint" IS DISTINCT FROM NEW."lineFingerprint" OR c."sourceFingerprint" IS DISTINCT FROM NEW."sourceFingerprint")) THEN
    RAISE EXCEPTION 'Coverage mixes actual versions of one order line' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderSampleCoverage" c WHERE c."sourceId" = NEW."sourceId" AND c."orderLineId" = NEW."orderLineId" AND
    c."rangeStart" < NEW."rangeStart" + NEW."quantity" AND NEW."rangeStart" < c."rangeStart" + c."quantity") THEN
    RAISE EXCEPTION 'Order sample represented ranges overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bambook_order_sample_event_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE source_row "OrderSampleSource"%ROWTYPE; previous_row "OrderSampleEvent"%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM "OrderSampleSource" WHERE "id" = NEW."sourceId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event source is missing' USING ERRCODE = '23503'; END IF;
  IF NEW."sequence" <> source_row."headSequence" + 1 OR NEW."previousEventId" IS DISTINCT FROM source_row."headEventId" THEN
    RAISE EXCEPTION 'Order sample event must append to the current exact head' USING ERRCODE = '23514';
  END IF;
  IF NEW."contentFingerprint" <> source_row."contentFingerprint" OR NEW."coverageFingerprint" <> source_row."coverageFingerprint" OR
     NEW."auditId" = source_row."creationAuditId" OR NEW."qcReportAuditId" = source_row."creationAuditId" THEN
    RAISE EXCEPTION 'Event source fingerprints or independent audit identity differ' USING ERRCODE = '23514';
  END IF;
  IF source_row."provenance" = 'native_new' THEN
    IF (NEW."sequence" = 1 AND NEW."eventType" <> 'registered') OR
       (NEW."sequence" > 1 AND NEW."eventType" IN ('registered','legacy_linked')) THEN
      RAISE EXCEPTION 'Native event chain must begin only with registration' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."eventType" <> 'legacy_linked' THEN
    RAISE EXCEPTION 'Historical source can record observations only' USING ERRCODE = '23514';
  END IF;
  IF source_row."headSequence" > 0 THEN
    SELECT * INTO previous_row FROM "OrderSampleEvent" WHERE "sourceId" = NEW."sourceId" AND "id" = source_row."headEventId";
    IF NOT FOUND OR previous_row."eventType" = 'invalidated' OR NEW."recordedAt" < previous_row."recordedAt" THEN
      RAISE EXCEPTION 'Event predecessor is absent, invalidated, or recorded later' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bambook_order_sample_complete_chain() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE source_id TEXT; source_row "OrderSampleSource"%ROWTYPE; prior_source "OrderSampleSource"%ROWTYPE;
        event_count BIGINT; last_sequence INTEGER; last_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'OrderSampleSource' THEN source_id := NEW."id";
  ELSE source_id := NEW."sourceId"; END IF;
  SELECT * INTO source_row FROM "OrderSampleSource" WHERE "id" = source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Committed order sample source is missing' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "OrderSampleCoverage" WHERE "sourceId" = source_id) THEN
    RAISE EXCEPTION 'Committed order sample source requires nonempty coverage' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), max("sequence") INTO event_count, last_sequence FROM "OrderSampleEvent" WHERE "sourceId" = source_id;
  SELECT "id" INTO last_id FROM "OrderSampleEvent" WHERE "sourceId" = source_id AND "sequence" = last_sequence;
  IF event_count = 0 OR event_count <> last_sequence OR source_row."headSequence" <> last_sequence OR source_row."headEventId" IS DISTINCT FROM last_id THEN
    RAISE EXCEPTION 'Committed order sample event chain or exact head is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderSampleEvent" e LEFT JOIN "OrderSampleEvent" p
      ON p."sourceId" = e."sourceId" AND p."id" = e."previousEventId"
      WHERE e."sourceId" = source_id AND ((e."sequence" = 1 AND e."previousEventId" IS NOT NULL) OR
      (e."sequence" > 1 AND (p."id" IS NULL OR p."sequence" <> e."sequence" - 1 OR p."recordedAt" > e."recordedAt" OR p."eventType" = 'invalidated')))) THEN
    RAISE EXCEPTION 'Committed order sample predecessor chain is not continuous' USING ERRCODE = '23514';
  END IF;
  IF source_row."previousSourceId" IS NOT NULL THEN
    SELECT * INTO prior_source FROM "OrderSampleSource" WHERE "id" = source_row."previousSourceId";
    IF NOT FOUND OR prior_source."chainId" <> source_row."chainId" OR prior_source."orderId" <> source_row."orderId" OR
       prior_source."family" <> source_row."family" OR prior_source."businessLine" <> source_row."businessLine" OR
       prior_source."factoryRelationId" <> source_row."factoryRelationId" OR prior_source."round" <> source_row."round" - 1 THEN
      RAISE EXCEPTION 'Order sample rounds must continue the same owner/family/factory chain' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION bambook_order_sample_case_binding_lock() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Match order-domain birth's Sample-first lock; the existing Case producer
  -- still owns its earlier parent locks. This never locks an OrderSampleSource.
  PERFORM 1 FROM "Sample" WHERE "id" = NEW."sampleId" FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bambook_order_sample_exclusive_domain() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE sample_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Sample' THEN sample_id := NEW."id";
  ELSE sample_id := NEW."sampleId"; END IF;
  IF EXISTS (SELECT 1 FROM "OrderSampleSource" s JOIN "Sample" sample ON sample."id" = s."sampleId"
      WHERE s."sampleId" = sample_id AND (sample."projectionKey" IS NOT NULL OR
      sample."sourceOrderId" IS DISTINCT FROM s."orderId" OR
      (s."provenance" = 'native_new' AND sample."sourceCaseId" IS NOT NULL) OR
      (s."provenance" = 'native_new' AND NOT (
        (s."family" IN ('fabric_ss','garment_ship') AND sample."type" = 'ship') OR
        (s."family" = 'fabric_rc' AND sample."type" = 'head') OR
        (s."family" = 'fabric_eps' AND sample."type" IN ('head','pioneer')) OR
        (s."family" = 'garment_pp' AND sample."type" = 'pp') OR
        (s."family" = 'garment_top' AND sample."type" = 'top'))) OR
      EXISTS (SELECT 1 FROM "SampleSource" cs WHERE cs."sampleId" = sample_id))) THEN
    RAISE EXCEPTION 'Case/canonical and order-domain source identities are mutually exclusive' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "OrderSampleSource_guard" BEFORE INSERT OR UPDATE ON "OrderSampleSource" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_source_guard();
CREATE TRIGGER "OrderSampleSource_no_delete" BEFORE DELETE ON "OrderSampleSource" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleSource_no_truncate" BEFORE TRUNCATE ON "OrderSampleSource" FOR EACH STATEMENT EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleCoverage_guard" BEFORE INSERT ON "OrderSampleCoverage" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_coverage_guard();
CREATE TRIGGER "OrderSampleCoverage_no_update_delete" BEFORE UPDATE OR DELETE ON "OrderSampleCoverage" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleCoverage_no_truncate" BEFORE TRUNCATE ON "OrderSampleCoverage" FOR EACH STATEMENT EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleEvent_guard" BEFORE INSERT ON "OrderSampleEvent" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_event_guard();
CREATE TRIGGER "OrderSampleEvent_no_update_delete" BEFORE UPDATE OR DELETE ON "OrderSampleEvent" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_immutable();
CREATE TRIGGER "OrderSampleEvent_no_truncate" BEFORE TRUNCATE ON "OrderSampleEvent" FOR EACH STATEMENT EXECUTE FUNCTION bambook_order_sample_immutable();

CREATE CONSTRAINT TRIGGER "OrderSampleSource_complete" AFTER INSERT OR UPDATE ON "OrderSampleSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_complete_chain();
CREATE CONSTRAINT TRIGGER "OrderSampleCoverage_complete" AFTER INSERT ON "OrderSampleCoverage" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_complete_chain();
CREATE CONSTRAINT TRIGGER "OrderSampleEvent_complete" AFTER INSERT ON "OrderSampleEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_complete_chain();
CREATE TRIGGER "SampleSource_order_domain_lock" BEFORE INSERT OR UPDATE OF "sampleId" ON "SampleSource" FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_case_binding_lock();
CREATE CONSTRAINT TRIGGER "OrderSampleSource_exclusive_domain" AFTER INSERT ON "OrderSampleSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_exclusive_domain();
CREATE CONSTRAINT TRIGGER "SampleSource_exclusive_domain" AFTER INSERT OR UPDATE ON "SampleSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_exclusive_domain();
CREATE CONSTRAINT TRIGGER "Sample_exclusive_order_domain" AFTER INSERT OR UPDATE ON "Sample" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_order_sample_exclusive_domain();
