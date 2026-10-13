-- New company cash facts only. Existing approvals, paid history and vouchers
-- remain unchanged and unassigned; no balance or Opening is backfilled.
CREATE TABLE "CompanyCashAccount" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "companyName" TEXT NOT NULL,
  "companyRelationId" TEXT, "currency" TEXT NOT NULL, "bankName" TEXT NOT NULL,
  "accountName" TEXT NOT NULL, "accountNumberMasked" TEXT NOT NULL, "branch" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Active', "ownerId" TEXT, "teamId" TEXT, "departmentId" TEXT,
  "allowedUserIds" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL,
  CONSTRAINT "CompanyCashAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompanyCashAccount_values" CHECK ("currency" ~ '^[A-Z]{3}$' AND "status" IN ('Active','Archived') AND "revision">0 AND jsonb_typeof("allowedUserIds")='array')
);
CREATE TABLE "CashAccountEntry" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL, "amount" DECIMAL(18,4) NOT NULL, "signedAmount" DECIMAL(18,4) NOT NULL,
  "currency" TEXT NOT NULL, "occurredDate" TEXT NOT NULL, "sourceVoucherId" TEXT,
  "correctsEntryId" TEXT, "evidence" JSONB NOT NULL, "reason" TEXT, "postedBy" TEXT NOT NULL, "postedAt" BIGINT NOT NULL,
  CONSTRAINT "CashAccountEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashAccountEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CompanyCashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAccountEntry_correctsEntryId_fkey" FOREIGN KEY ("correctsEntryId") REFERENCES "CashAccountEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAccountEntry_sourceVoucherId_fkey" FOREIGN KEY ("sourceVoucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAccountEntry_values" CHECK ("sequence">0 AND "occurredDate" ~ '^\d{4}-\d{2}-\d{2}$' AND jsonb_typeof("evidence")='object' AND (
    ("kind"='Opening' AND "signedAmount"="amount" AND "sourceVoucherId" IS NULL AND "correctsEntryId" IS NULL) OR
    ("kind"='Receipt' AND "amount">=0 AND "signedAmount"="amount" AND "sourceVoucherId" IS NOT NULL AND "correctsEntryId" IS NULL) OR
    ("kind"='Payment' AND "amount">=0 AND "signedAmount"=-"amount" AND "sourceVoucherId" IS NOT NULL AND "correctsEntryId" IS NULL) OR
    ("kind"='CorrectionIn' AND ("amount">0 OR "amount"=0 AND "sourceVoucherId" IS NOT NULL) AND "signedAmount"="amount" AND "correctsEntryId" IS NOT NULL) OR
    ("kind"='CorrectionOut' AND ("amount">0 OR "amount"=0 AND "sourceVoucherId" IS NOT NULL) AND "signedAmount"=-"amount" AND "correctsEntryId" IS NOT NULL)))
);
CREATE UNIQUE INDEX "CashAccountEntry_sourceVoucherId_key" ON "CashAccountEntry"("sourceVoucherId");
CREATE UNIQUE INDEX "CashAccountEntry_accountId_sequence_key" ON "CashAccountEntry"("accountId","sequence");
CREATE UNIQUE INDEX "CashAccountEntry_one_opening" ON "CashAccountEntry"("accountId") WHERE "kind"='Opening';
CREATE INDEX "CashAccountEntry_accountId_occurredDate_idx" ON "CashAccountEntry"("accountId","occurredDate");
CREATE INDEX "CashAccountEntry_correctsEntryId_idx" ON "CashAccountEntry"("correctsEntryId");
CREATE TABLE "CashAccountCommandReceipt" (
  "id" TEXT NOT NULL, "actorId" TEXT NOT NULL, "operation" TEXT NOT NULL,
  "requestKey" VARCHAR(36) NOT NULL, "commandHash" VARCHAR(64) NOT NULL, "accountId" TEXT,
  "receipt" JSONB NOT NULL, "createdAt" BIGINT NOT NULL,
  CONSTRAINT "CashAccountCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CashAccountCommandReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CompanyCashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashAccountCommand_actor_operation_key" ON "CashAccountCommandReceipt"("actorId","operation","requestKey");
CREATE INDEX "CashAccountCommandReceipt_accountId_createdAt_idx" ON "CashAccountCommandReceipt"("accountId","createdAt");
CREATE INDEX "CompanyCashAccount_status_currency_idx" ON "CompanyCashAccount"("status","currency");
CREATE INDEX "CompanyCashAccount_ownerId_idx" ON "CompanyCashAccount"("ownerId");
CREATE INDEX "CompanyCashAccount_teamId_idx" ON "CompanyCashAccount"("teamId");
ALTER TABLE "PaymentVoucher" ADD COLUMN "companyAccountId" TEXT, ADD COLUMN "cashEntryId" TEXT;
CREATE UNIQUE INDEX "PaymentVoucher_cashEntryId_key" ON "PaymentVoucher"("cashEntryId");
CREATE INDEX "PaymentVoucher_companyAccountId_idx" ON "PaymentVoucher"("companyAccountId");
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_companyAccountId_fkey" FOREIGN KEY ("companyAccountId") REFERENCES "CompanyCashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashAccountEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_cash_pair" CHECK (("companyAccountId" IS NULL)=("cashEntryId" IS NULL));

CREATE FUNCTION bambook_cash_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cash facts and original receipts are append-only'; END $$;
CREATE TRIGGER "CashAccountEntry_immutable" BEFORE UPDATE OR DELETE ON "CashAccountEntry" FOR EACH ROW EXECUTE FUNCTION bambook_cash_immutable();
CREATE TRIGGER "CashAccountCommandReceipt_immutable" BEFORE UPDATE OR DELETE ON "CashAccountCommandReceipt" FOR EACH ROW EXECUTE FUNCTION bambook_cash_immutable();
CREATE FUNCTION bambook_cash_account_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW."currency" IS DISTINCT FROM OLD."currency" THEN RAISE EXCEPTION 'Cash account currency is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "CompanyCashAccount_fixed_currency" BEFORE UPDATE ON "CompanyCashAccount" FOR EACH ROW EXECUTE FUNCTION bambook_cash_account_currency();

CREATE FUNCTION bambook_cash_insert_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_currency TEXT; next_sequence INTEGER; first_date TEXT; opening_date TEXT; original "CashAccountEntry"%ROWTYPE; already_corrected NUMERIC;
BEGIN
  SELECT "currency" INTO account_currency FROM "CompanyCashAccount" WHERE "id"=NEW."accountId" FOR UPDATE;
  IF account_currency IS DISTINCT FROM NEW."currency" THEN RAISE EXCEPTION 'Cash account currency mismatch'; END IF;
  SELECT COALESCE(MAX("sequence"),0)+1, MIN("occurredDate") FILTER (WHERE "kind"<>'Opening'), MIN("occurredDate") FILTER (WHERE "kind"='Opening')
    INTO next_sequence,first_date,opening_date FROM "CashAccountEntry" WHERE "accountId"=NEW."accountId";
  IF NEW."sequence"<>next_sequence THEN RAISE EXCEPTION 'Cash entry sequence mismatch'; END IF;
  IF NEW."kind"='Opening' AND first_date IS NOT NULL AND NEW."occurredDate">first_date THEN RAISE EXCEPTION 'Opening is later than actual cash'; END IF;
  IF NEW."kind"<>'Opening' AND opening_date IS NOT NULL AND NEW."occurredDate"<opening_date THEN RAISE EXCEPTION 'Actual cash predates verified Opening'; END IF;
  IF NEW."correctsEntryId" IS NOT NULL THEN
    SELECT * INTO original FROM "CashAccountEntry" WHERE "id"=NEW."correctsEntryId";
    IF original."id" IS NULL OR original."accountId"<>NEW."accountId" OR original."currency"<>NEW."currency" OR NEW."occurredDate"<original."occurredDate"
      OR NOT ((NEW."kind"='CorrectionIn' AND original."kind"='Payment') OR (NEW."kind"='CorrectionOut' AND original."kind"='Receipt'))
      THEN RAISE EXCEPTION 'Cash correction original scope mismatch'; END IF;
    SELECT COALESCE(SUM("amount"),0) INTO already_corrected FROM "CashAccountEntry" WHERE "correctsEntryId"=original."id";
    IF original."kind"='Payment' AND original."sourceVoucherId" IS NOT NULL THEN
      SELECT already_corrected+COALESCE(SUM(r."receivedNet"),0) INTO already_corrected
        FROM "CreditNoteRefundReturn" r JOIN "PaymentVoucher" v ON v."id"=r."receiptVoucherId"
        JOIN "CashAccountEntry" e ON e."id"=v."cashEntryId"
        WHERE r."sourcePaymentVoucherId"=original."sourceVoucherId" AND e."kind"='Receipt' AND e."accountId"=NEW."accountId";
    END IF;
    IF already_corrected+NEW."amount">original."amount" THEN RAISE EXCEPTION 'Cash correction exceeds original amount'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CashAccountEntry_insert_scope" BEFORE INSERT ON "CashAccountEntry" FOR EACH ROW EXECUTE FUNCTION bambook_cash_insert_scope();

CREATE FUNCTION bambook_cash_voucher_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."cashEntryId" IS NOT NULL AND (NEW."cashEntryId" IS DISTINCT FROM OLD."cashEntryId" OR NEW."companyAccountId" IS DISTINCT FROM OLD."companyAccountId"
    OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."paymentDate" IS DISTINCT FROM OLD."paymentDate" OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
    OR NEW."bankFee" IS DISTINCT FROM OLD."bankFee" OR NEW."feeBearer" IS DISTINCT FROM OLD."feeBearer")
    THEN RAISE EXCEPTION 'Cash-linked voucher bank facts are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaymentVoucher_cash_immutable" BEFORE UPDATE ON "PaymentVoucher" FOR EACH ROW EXECUTE FUNCTION bambook_cash_voucher_immutable();
CREATE FUNCTION bambook_cash_voucher_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE voucher "PaymentVoucher"%ROWTYPE; entry "CashAccountEntry"%ROWTYPE; voucher_id TEXT;
BEGIN
  IF TG_TABLE_NAME='PaymentVoucher' THEN voucher_id=NEW."id"; ELSE voucher_id=NEW."sourceVoucherId"; END IF;
  IF voucher_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO voucher FROM "PaymentVoucher" WHERE "id"=voucher_id;
  IF voucher."cashEntryId" IS NULL THEN
    IF EXISTS(SELECT 1 FROM "CashAccountEntry" WHERE "sourceVoucherId"=voucher_id) THEN RAISE EXCEPTION 'Cash source is missing its voucher pointer'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO entry FROM "CashAccountEntry" WHERE "id"=voucher."cashEntryId";
  IF entry."sourceVoucherId" IS DISTINCT FROM voucher."id" OR entry."accountId" IS DISTINCT FROM voucher."companyAccountId" OR entry."currency" IS DISTINCT FROM voucher."currency"
    OR entry."occurredDate" IS DISTINCT FROM voucher."paymentDate"
    OR NOT ((voucher."type"='Receipt' AND entry."kind" IN ('Receipt','CorrectionIn')) OR (voucher."type"='Disbursement' AND entry."kind" IN ('Payment','CorrectionOut')))
    OR entry."evidence"->'sourceSnapshot'->>'voucherAmount' IS DISTINCT FROM voucher."amount"::text
    OR entry."evidence"->'sourceSnapshot'->>'bankFee' IS DISTINCT FROM voucher."bankFee"::text
    OR entry."evidence"->'sourceSnapshot'->>'paymentMethod' IS DISTINCT FROM voucher."paymentMethod"
    OR entry."evidence"->'sourceSnapshot'->>'accountAmount' IS DISTINCT FROM entry."amount"::text
    THEN RAISE EXCEPTION 'Cash voucher/source double pointer mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PaymentVoucher_cash_pair_fact" AFTER INSERT OR UPDATE ON "PaymentVoucher" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_cash_voucher_pair();
CREATE CONSTRAINT TRIGGER "CashAccountEntry_cash_pair_fact" AFTER INSERT ON "CashAccountEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bambook_cash_voucher_pair();
