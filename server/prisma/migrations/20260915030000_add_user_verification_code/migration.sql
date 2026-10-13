-- CreateTable
CREATE TABLE "UserVerificationCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "UserVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserVerificationCode_expiresAt_idx" ON "UserVerificationCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserVerificationCode_email_purpose_key" ON "UserVerificationCode"("email", "purpose");
