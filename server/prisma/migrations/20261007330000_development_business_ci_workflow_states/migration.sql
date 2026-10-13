-- Preserve the historical billing workflow and admit the two business-CI
-- states already produced by the canonical development services. No rows are
-- rewritten. db-push databases have no historical custom CHECK, so absence is
-- handled explicitly; an unrelated/altered definition is never overwritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  old_definition CONSTANT text := $old$CHECK ("developmentWorkflowState" IS NULL OR ("developmentWorkflowState" = ANY (ARRAY['draft'::text, 'submitted'::text, 'returned'::text, 'approval_pending'::text, 'ready'::text, 'cancelled'::text])))$old$;
  new_definition CONSTANT text := $new$CHECK ("developmentWorkflowState" IS NULL OR ("developmentWorkflowState" = ANY (ARRAY['draft'::text, 'submitted'::text, 'returned'::text, 'approval_pending'::text, 'ready'::text, 'cancelled'::text, 'business_ci_draft'::text, 'business_ci_issued'::text])))$new$;
  constraint_count bigint;
  constraint_type "char";
  definition text;
  validated boolean;
BEGIN
  LOCK TABLE public."BillingItem" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO constraint_count FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public."BillingItem"'::regclass
      AND conname = 'BillingItem_development_workflow_state_check';
  IF constraint_count > 1 THEN
    RAISE EXCEPTION 'DEVELOPMENT_BILLING_WORKFLOW_CHECK_AMBIGUOUS' USING ERRCODE = '55000';
  END IF;
  IF constraint_count = 1 THEN
    SELECT contype, pg_get_constraintdef(oid, true), convalidated
    INTO constraint_type, definition, validated FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public."BillingItem"'::regclass
      AND conname = 'BillingItem_development_workflow_state_check';
    IF constraint_type <> 'c' OR definition NOT IN (
      old_definition, old_definition || ' NOT VALID',
      new_definition, new_definition || ' NOT VALID') THEN
      RAISE EXCEPTION 'DEVELOPMENT_BILLING_WORKFLOW_CHECK_DEFINITION_CHANGED' USING ERRCODE = '55000';
    END IF;
    IF definition IN (old_definition, old_definition || ' NOT VALID') THEN
      ALTER TABLE public."BillingItem" DROP CONSTRAINT "BillingItem_development_workflow_state_check";
      constraint_count := 0;
    END IF;
  END IF;
  IF constraint_count = 0 THEN
    ALTER TABLE public."BillingItem" ADD CONSTRAINT "BillingItem_development_workflow_state_check"
      CHECK ("developmentWorkflowState" IS NULL OR "developmentWorkflowState" IN (
        'draft', 'submitted', 'returned', 'approval_pending', 'ready', 'cancelled',
        'business_ci_draft', 'business_ci_issued')) NOT VALID;
  END IF;
  -- Validation also applies when an exact eight-state CHECK already exists.
  -- Invalid historical values abort the entire transaction; none are repaired
  -- or relabelled. An already-valid exact CHECK keeps its original identity.
  ALTER TABLE public."BillingItem" VALIDATE CONSTRAINT "BillingItem_development_workflow_state_check";
  SELECT pg_get_constraintdef(oid, true), convalidated INTO definition, validated
  FROM pg_catalog.pg_constraint WHERE conrelid = 'public."BillingItem"'::regclass
    AND conname = 'BillingItem_development_workflow_state_check' AND contype = 'c';
  IF definition IS DISTINCT FROM new_definition OR validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'DEVELOPMENT_BILLING_WORKFLOW_CHECK_VALIDATION_FAILED' USING ERRCODE = '55000';
  END IF;
END;
$migration$;
COMMIT;
