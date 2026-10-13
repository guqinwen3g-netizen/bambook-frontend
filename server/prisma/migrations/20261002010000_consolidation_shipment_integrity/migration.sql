-- Existing local test databases may be missing this model-declared constraint.
-- Validate retained rows; never delete or invent a parent to satisfy the relation.
DO $migration$
DECLARE
  existing_constraint pg_constraint%ROWTYPE;
  child_column smallint;
  parent_column smallint;
BEGIN
  SELECT attnum INTO STRICT child_column FROM pg_attribute
    WHERE attrelid = 'public."ConsolidationShipment"'::regclass
      AND attname = 'consolidationId' AND NOT attisdropped;
  SELECT attnum INTO STRICT parent_column FROM pg_attribute
    WHERE attrelid = 'public."ContainerConsolidation"'::regclass
      AND attname = 'id' AND NOT attisdropped;
  SELECT * INTO existing_constraint FROM pg_constraint
    WHERE conrelid = 'public."ConsolidationShipment"'::regclass
      AND conname = 'ConsolidationShipment_consolidationId_fkey';
  IF FOUND THEN
    IF existing_constraint.contype <> 'f'
      OR existing_constraint.confrelid <> 'public."ContainerConsolidation"'::regclass
      OR existing_constraint.conkey IS DISTINCT FROM ARRAY[child_column]::smallint[]
      OR existing_constraint.confkey IS DISTINCT FROM ARRAY[parent_column]::smallint[]
      OR existing_constraint.confdeltype <> 'c'
      OR existing_constraint.confupdtype <> 'c'
      OR existing_constraint.confmatchtype <> 's'
      OR existing_constraint.condeferrable
      OR existing_constraint.condeferred THEN
      RAISE EXCEPTION 'Existing ConsolidationShipment foreign key differs from the declared model';
    END IF;
    IF NOT existing_constraint.convalidated THEN
      ALTER TABLE public."ConsolidationShipment"
        VALIDATE CONSTRAINT "ConsolidationShipment_consolidationId_fkey";
    END IF;
  ELSE
    ALTER TABLE public."ConsolidationShipment"
      ADD CONSTRAINT "ConsolidationShipment_consolidationId_fkey"
      FOREIGN KEY ("consolidationId") REFERENCES public."ContainerConsolidation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;
