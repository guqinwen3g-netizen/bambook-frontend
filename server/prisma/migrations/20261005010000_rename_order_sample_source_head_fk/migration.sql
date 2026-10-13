-- Keep the composite event-head foreign key name aligned with Prisma's
-- current relation fields (id, headSequence, headEventId).
ALTER TABLE "OrderSampleSource"
  RENAME CONSTRAINT "OrderSampleSource_headEvent_fkey"
  TO "OrderSampleSource_id_headSequence_headEventId_fkey";
