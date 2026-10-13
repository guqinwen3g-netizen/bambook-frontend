-- Bind persisted email facts to the employee mailbox that synchronized or created them.
-- Historical rows remain unassigned and are hidden from employee inboxes until explicitly reconciled.
ALTER TABLE "Email" ADD COLUMN IF NOT EXISTS "mailboxOwnerUserId" TEXT;

-- Preserve deterministic legacy ownership where the stored message has exactly one
-- matching employee recipient (inbound) or sender (outbound). Ambiguous/shared mail stays unassigned.
UPDATE "Email" e
SET "mailboxOwnerUserId" = u.id
FROM "UserAccount" u
WHERE e."mailboxOwnerUserId" IS NULL
  AND u.email IS NOT NULL
  AND u."deletedAt" IS NULL
  AND (
    (e.direction = 'inbound' AND POSITION(('"' || LOWER(u.email) || '"') IN LOWER(e."toAddresses")) > 0
      AND (SELECT COUNT(*) FROM "UserAccount" u2 WHERE u2.email IS NOT NULL AND u2."deletedAt" IS NULL
        AND POSITION(('"' || LOWER(u2.email) || '"') IN LOWER(e."toAddresses")) > 0) = 1)
    OR (e.direction = 'outbound' AND LOWER(e."fromAddress") = LOWER(u.email))
  );

CREATE INDEX IF NOT EXISTS "Email_mailboxOwnerUserId_mailbox_createdAt_idx"
  ON "Email"("mailboxOwnerUserId", "mailbox", "createdAt");
