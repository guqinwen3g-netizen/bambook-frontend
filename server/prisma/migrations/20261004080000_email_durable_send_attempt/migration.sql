CREATE TABLE "EmailSendAttempt" (
 "id" TEXT PRIMARY KEY,
 "emailId" TEXT NOT NULL UNIQUE REFERENCES "Email"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "actorId" TEXT NOT NULL REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "status" TEXT NOT NULL CHECK ("status" IN ('claimed','accepted','unknown','sent')),
 "contentHash" TEXT NOT NULL,
 "contentSnapshot" JSONB NOT NULL,
 "smtpUser" TEXT NOT NULL,
 "requestedMessageId" TEXT NOT NULL,
 "smtpMessageId" TEXT,
 "smtpReceipt" JSONB,
 "receiptSentAt" TEXT,
 "auditId" TEXT UNIQUE REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "EmailSendAttempt_receipt_shape" CHECK (
  ("status" IN ('accepted','sent') AND "smtpMessageId" IS NOT NULL AND "receiptSentAt" IS NOT NULL AND "smtpReceipt" IS NOT NULL AND length(trim("smtpMessageId")) > 0 AND length(trim("receiptSentAt")) > 0)
 OR "status" IN ('claimed','unknown')),
 CONSTRAINT "EmailSendAttempt_recipient_proof" CHECK ("status" NOT IN ('accepted','sent') OR COALESCE(
  CASE WHEN jsonb_typeof("smtpReceipt") = 'object' AND jsonb_typeof("smtpReceipt"->'accepted') = 'array'
   THEN "smtpReceipt"->'receiptVersion' = '1'::jsonb
    AND "smtpReceipt"->>'messageId' = "smtpMessageId"
    AND "smtpReceipt"->>'requestedMessageId' = "requestedMessageId"
    AND jsonb_array_length("smtpReceipt"->'accepted') > 0
    AND "smtpReceipt"->'accepted' = "smtpReceipt"->'expected'
    AND "smtpReceipt"->'rejected' = '[]'::jsonb AND "smtpReceipt"->'pending' = '[]'::jsonb
   ELSE false END, false)),
 CONSTRAINT "EmailSendAttempt_sent_audit" CHECK ("status" <> 'sent' OR "auditId" IS NOT NULL)
);
CREATE INDEX "EmailSendAttempt_status_idx" ON "EmailSendAttempt"("status");
CREATE INDEX "EmailSendAttempt_actorId_idx" ON "EmailSendAttempt"("actorId");
CREATE FUNCTION "guardEmailSendAttempt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Email send reservations must be retained'; END IF;
 IF (NEW."id",NEW."emailId",NEW."actorId",NEW."contentHash",NEW."contentSnapshot",NEW."smtpUser",NEW."requestedMessageId",NEW."createdAt")
 IS DISTINCT FROM (OLD."id",OLD."emailId",OLD."actorId",OLD."contentHash",OLD."contentSnapshot",OLD."smtpUser",OLD."requestedMessageId",OLD."createdAt") THEN
  RAISE EXCEPTION 'Email send reservation identity and payload are immutable';
 END IF;
 IF NEW."status" <> OLD."status" AND NOT ((OLD."status"='claimed' AND NEW."status" IN ('accepted','unknown')) OR (OLD."status"='accepted' AND NEW."status"='sent')) THEN
  RAISE EXCEPTION 'Invalid email send attempt transition';
 END IF;
 IF OLD."status" IN ('accepted','sent') AND (NEW."smtpMessageId",NEW."receiptSentAt",NEW."smtpReceipt") IS DISTINCT FROM (OLD."smtpMessageId",OLD."receiptSentAt",OLD."smtpReceipt") THEN
  RAISE EXCEPTION 'SMTP acceptance receipt is immutable';
 END IF;
 IF OLD."status"='sent' AND NEW."auditId" IS DISTINCT FROM OLD."auditId" THEN RAISE EXCEPTION 'Final send audit is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "EmailSendAttempt_guard" BEFORE UPDATE OR DELETE ON "EmailSendAttempt" FOR EACH ROW EXECUTE FUNCTION "guardEmailSendAttempt"();
