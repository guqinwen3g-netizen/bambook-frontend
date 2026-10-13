-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN IF NOT EXISTS     "bossFinalBypassAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "bossFinalBypassBy" TEXT,
ADD COLUMN IF NOT EXISTS     "bossFinalBypassReason" TEXT,
ADD COLUMN IF NOT EXISTS     "bypassedApprovalId" TEXT,
ADD COLUMN IF NOT EXISTS     "clientReviewerIdSupplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "delegateReason" TEXT,
ADD COLUMN IF NOT EXISTS     "delegatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "delegatedBy" TEXT,
ADD COLUMN IF NOT EXISTS     "departmentSnapshotId" TEXT,
ADD COLUMN IF NOT EXISTS     "reviewerResolverRoute" TEXT;

-- AlterTable
ALTER TABLE "CreditLimit" ADD COLUMN IF NOT EXISTS     "frozenAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "frozenBy" TEXT,
ADD COLUMN IF NOT EXISTS     "lastAutoScanDate" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "thawedReason" TEXT;

-- AlterTable
ALTER TABLE "CustomerTier" ADD COLUMN IF NOT EXISTS     "moqOverrideRatio" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Department" ADD COLUMN IF NOT EXISTS     "headId" TEXT;

-- AlterTable
ALTER TABLE "GarmentProfile" ADD COLUMN IF NOT EXISTS     "moqUnit" TEXT NOT NULL DEFAULT 'PCS',
ADD COLUMN IF NOT EXISTS     "moqValue" INTEGER;

-- AlterTable
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS     "signatures" JSONB DEFAULT '{}';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS     "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS     "capsuleExemption" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "capsuleExemptionAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "capsuleExemptionBy" TEXT,
ADD COLUMN IF NOT EXISTS     "code" TEXT,
ADD COLUMN IF NOT EXISTS     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS     "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS     "internalCounterpartyId" TEXT,
ADD COLUMN IF NOT EXISTS     "isInternalFabricTrade" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "moqSnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS     "internalTransferPrice" DECIMAL(18,4),
ADD COLUMN IF NOT EXISTS     "moqOverride" INTEGER;

-- AlterTable
ALTER TABLE "PaymentVoucher" ADD COLUMN IF NOT EXISTS     "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS     "ownerId" TEXT,
ADD COLUMN IF NOT EXISTS     "voucherCategory" TEXT NOT NULL DEFAULT 'normal';

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN IF NOT EXISTS     "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS     "moqSnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "QuotationLine" ADD COLUMN IF NOT EXISTS     "moqOverride" INTEGER;

-- AlterTable
ALTER TABLE "Relation" ADD COLUMN IF NOT EXISTS     "code" TEXT,
ADD COLUMN IF NOT EXISTS     "customerAgreementMoq" JSONB,
ADD COLUMN IF NOT EXISTS     "departmentId" TEXT,
ADD COLUMN IF NOT EXISTS     "ownerId" TEXT,
ADD COLUMN IF NOT EXISTS     "salesRepIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS     "stage" TEXT DEFAULT 'Customer',
ADD COLUMN IF NOT EXISTS     "tier" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SequenceRegister" (
    "id" TEXT NOT NULL,
    "seqType" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "formatTemplate" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "startSeq" INTEGER NOT NULL DEFAULT 1,
    "currentSeq" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "SequenceRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VoidedNumber" (
    "id" TEXT NOT NULL,
    "seqType" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "periodKey" TEXT,
    "reason" TEXT,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceDocId" TEXT,
    "sourceDocType" TEXT,
    "metadata" JSONB,

    CONSTRAINT "VoidedNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DirtyCacheMarker" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "actorId" TEXT,
    "dirtyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dirtyCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "resolvedMs" INTEGER,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "DirtyCacheMarker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DataDictionary" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "entries" JSONB NOT NULL,
    "labels" JSONB,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "DataDictionary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DataDictionaryHistory" (
    "id" TEXT NOT NULL,
    "dictCode" TEXT NOT NULL,
    "versionFrom" INTEGER NOT NULL,
    "versionTo" INTEGER NOT NULL,
    "diffEntries" JSONB NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataDictionaryHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SystemConfig" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "key" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "value" JSONB,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "meta" JSONB,
    "updatedBy" TEXT,
    "auditReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SystemConfigHistory" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "versionFrom" INTEGER NOT NULL,
    "versionTo" INTEGER NOT NULL,
    "valueFrom" JSONB,
    "valueTo" JSONB,
    "actorId" TEXT,
    "reason" TEXT,
    "sensitiveMasked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemConfigHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "startDate" TEXT,
    "endDate" TEXT,
    "budget" DECIMAL(65,30),
    "actualCost" DECIMAL(65,30),
    "targetSegment" JSONB,
    "seasonId" TEXT,
    "tradeShowId" TEXT,
    "ownerId" TEXT,
    "departmentId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MarketingLead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "relationId" TEXT,
    "source" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'New',
    "estimatedValue" DECIMAL(65,30),
    "actualValue" DECIMAL(65,30),
    "convertedAt" BIGINT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "MarketingLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MoqThresholdConfig" (
    "id" TEXT NOT NULL,
    "fabricDefaultMoq" INTEGER NOT NULL,
    "garmentDefaultMoq" INTEGER NOT NULL,
    "capsuleMoq" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "changedBy" TEXT NOT NULL,
    "changeReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoqThresholdConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MoqThresholdConfigHistory" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "beforeFabricDefaultMoq" INTEGER NOT NULL,
    "beforeGarmentDefaultMoq" INTEGER NOT NULL,
    "beforeCapsuleMoq" INTEGER NOT NULL,
    "afterFabricDefaultMoq" INTEGER NOT NULL,
    "afterGarmentDefaultMoq" INTEGER NOT NULL,
    "afterCapsuleMoq" INTEGER NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changeReason" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoqThresholdConfigHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderChangeRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterDelta" JSONB NOT NULL,
    "changeTypes" TEXT[],
    "impactLevel" TEXT NOT NULL DEFAULT 'medium',
    "changeReason" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrderChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FabricShipmentSample" (
    "id" TEXT NOT NULL,
    "sampleCode" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fabricProfileId" TEXT,
    "sampleQuantity" DECIMAL(10,2) NOT NULL,
    "sampleUnit" TEXT NOT NULL DEFAULT 'meter',
    "batchNo" TEXT,
    "rollNos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cuttingDate" TEXT NOT NULL,
    "sentToCustomer" BOOLEAN NOT NULL DEFAULT false,
    "sentDate" TEXT,
    "courier" TEXT,
    "trackingNumber" TEXT,
    "recipientName" TEXT,
    "recipientContact" TEXT,
    "customerStatus" TEXT NOT NULL DEFAULT 'pending',
    "customerFeedbackDate" TEXT,
    "customerFeedbackNote" TEXT,
    "qcInspectionReportId" TEXT,
    "qcRequestedBy" TEXT,
    "qcRequestedAt" TIMESTAMP(3),
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FabricShipmentSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentRequest" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT,
    "requestDate" TEXT NOT NULL,
    "expectedPaymentDate" TEXT,
    "totalAmount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "applicantId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "approvalRequestId" TEXT,
    "paymentVoucherId" TEXT,
    "paymentCategory" TEXT NOT NULL DEFAULT 'normal',
    "ownerId" TEXT,
    "departmentId" TEXT,
    "remark" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CreditLimitHistory" (
    "id" TEXT NOT NULL,
    "creditLimitId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "beforeUsedAmount" DECIMAL(18,4) NOT NULL,
    "afterUsedAmount" DECIMAL(18,4) NOT NULL,
    "delta" DECIMAL(18,4) NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT,
    "triggerBy" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLimitHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderInternalTransfer" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "transferDirection" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "ourDepartmentId" TEXT,
    "transferAmount" DECIMAL(18,4) NOT NULL,
    "transferCurrency" TEXT NOT NULL DEFAULT 'CNY',
    "transferDate" TEXT NOT NULL,
    "recognizedBy" TEXT,
    "recognizedAt" TIMESTAMP(3),
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrderInternalTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserPermissionOverrides" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "UserPermissionOverrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EarlyProductionSample" (
    "id" TEXT NOT NULL,
    "sampleCode" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fabricProfileId" TEXT,
    "millName" TEXT,
    "sampleQuantity" DECIMAL(10,2) NOT NULL,
    "sampleUnit" TEXT NOT NULL DEFAULT 'meter',
    "productionStage" TEXT,
    "producedMeterage" DECIMAL(12,2),
    "cuttingDate" TEXT NOT NULL,
    "sentToCustomer" BOOLEAN NOT NULL DEFAULT false,
    "sentDate" TEXT,
    "trackingNumber" TEXT,
    "customerStatus" TEXT NOT NULL DEFAULT 'pending',
    "customerFeedbackDate" TEXT,
    "customerFeedbackNote" TEXT,
    "qcInspectionReportId" TEXT,
    "qcRequestedBy" TEXT,
    "qcRequestedAt" TIMESTAMP(3),
    "previousSampleId" TEXT,
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "EarlyProductionSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Dr013ExceptionRequest" (
    "id" TEXT NOT NULL,
    "exceptionNumber" TEXT NOT NULL,
    "exceptionCategory" TEXT NOT NULL,
    "subCategory" TEXT,
    "bypassedApprovalIds" TEXT[],
    "exceptionReason" TEXT NOT NULL,
    "customerCommitment" TEXT,
    "riskMitigationPlan" TEXT,
    "requesterId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "bossFinalBypassBy" TEXT,
    "bossFinalBypassAt" TIMESTAMP(3),
    "bossFinalBypassReason" TEXT,
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Dr013ExceptionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SequenceRegister_seqType_idx" ON "SequenceRegister"("seqType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SequenceRegister_periodKey_idx" ON "SequenceRegister"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SequenceRegister_seqType_periodKey_key" ON "SequenceRegister"("seqType", "periodKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VoidedNumber_seqType_idx" ON "VoidedNumber"("seqType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VoidedNumber_voidedAt_idx" ON "VoidedNumber"("voidedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VoidedNumber_sourceDocType_sourceDocId_idx" ON "VoidedNumber"("sourceDocType", "sourceDocId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VoidedNumber_seqType_number_key" ON "VoidedNumber"("seqType", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DirtyCacheMarker_cacheKey_key" ON "DirtyCacheMarker"("cacheKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DirtyCacheMarker_scope_idx" ON "DirtyCacheMarker"("scope");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DirtyCacheMarker_entityType_entityId_idx" ON "DirtyCacheMarker"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DirtyCacheMarker_dirty_idx" ON "DirtyCacheMarker"("dirty");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DirtyCacheMarker_dirtyAt_idx" ON "DirtyCacheMarker"("dirtyAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DataDictionary_code_key" ON "DataDictionary"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DataDictionary_category_idx" ON "DataDictionary"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DataDictionary_scope_idx" ON "DataDictionary"("scope");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DataDictionary_isSystem_idx" ON "DataDictionary"("isSystem");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DataDictionaryHistory_dictCode_createdAt_idx" ON "DataDictionaryHistory"("dictCode", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemConfig_group_idx" ON "SystemConfig"("group");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemConfig_scope_idx" ON "SystemConfig"("scope");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemConfig_encrypted_idx" ON "SystemConfig"("encrypted");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SystemConfig_scope_key_key" ON "SystemConfig"("scope", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemConfigHistory_configId_createdAt_idx" ON "SystemConfigHistory"("configId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SystemConfigHistory_actorId_idx" ON "SystemConfigHistory"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MarketingCampaign_code_key" ON "MarketingCampaign"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingCampaign_status_idx" ON "MarketingCampaign"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingCampaign_type_idx" ON "MarketingCampaign"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingCampaign_seasonId_idx" ON "MarketingCampaign"("seasonId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingCampaign_ownerId_idx" ON "MarketingCampaign"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingCampaign_departmentId_idx" ON "MarketingCampaign"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingLead_campaignId_idx" ON "MarketingLead"("campaignId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingLead_relationId_idx" ON "MarketingLead"("relationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MarketingLead_status_idx" ON "MarketingLead"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MoqThresholdConfig_isActive_idx" ON "MoqThresholdConfig"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MoqThresholdConfig_effectiveFrom_idx" ON "MoqThresholdConfig"("effectiveFrom");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MoqThresholdConfigHistory_configId_idx" ON "MoqThresholdConfigHistory"("configId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MoqThresholdConfigHistory_changedAt_idx" ON "MoqThresholdConfigHistory"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OrderChangeRequest_requestNumber_key" ON "OrderChangeRequest"("requestNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_orderId_idx" ON "OrderChangeRequest"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_status_idx" ON "OrderChangeRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_requesterId_idx" ON "OrderChangeRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_reviewerId_idx" ON "OrderChangeRequest"("reviewerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_requestNumber_idx" ON "OrderChangeRequest"("requestNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderChangeRequest_impactLevel_idx" ON "OrderChangeRequest"("impactLevel");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FabricShipmentSample_sampleCode_key" ON "FabricShipmentSample"("sampleCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FabricShipmentSample_shipmentId_idx" ON "FabricShipmentSample"("shipmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FabricShipmentSample_orderId_idx" ON "FabricShipmentSample"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FabricShipmentSample_customerStatus_idx" ON "FabricShipmentSample"("customerStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FabricShipmentSample_sampleCode_idx" ON "FabricShipmentSample"("sampleCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FabricShipmentSample_qcInspectionReportId_idx" ON "FabricShipmentSample"("qcInspectionReportId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRequest_requestNumber_key" ON "PaymentRequest"("requestNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_status_idx" ON "PaymentRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_supplierId_idx" ON "PaymentRequest"("supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_applicantId_idx" ON "PaymentRequest"("applicantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_reviewerId_idx" ON "PaymentRequest"("reviewerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_requestNumber_idx" ON "PaymentRequest"("requestNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_requestDate_idx" ON "PaymentRequest"("requestDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_ownerId_idx" ON "PaymentRequest"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentRequest_departmentId_idx" ON "PaymentRequest"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CreditLimitHistory_creditLimitId_idx" ON "CreditLimitHistory"("creditLimitId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CreditLimitHistory_relationId_idx" ON "CreditLimitHistory"("relationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CreditLimitHistory_triggerType_idx" ON "CreditLimitHistory"("triggerType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CreditLimitHistory_createdAt_idx" ON "CreditLimitHistory"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderInternalTransfer_orderId_idx" ON "OrderInternalTransfer"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderInternalTransfer_counterpartyId_idx" ON "OrderInternalTransfer"("counterpartyId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderInternalTransfer_transferDirection_idx" ON "OrderInternalTransfer"("transferDirection");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OrderInternalTransfer_orderId_transferDirection_key" ON "OrderInternalTransfer"("orderId", "transferDirection");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserPermissionOverrides_userId_idx" ON "UserPermissionOverrides"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserPermissionOverrides_scope_idx" ON "UserPermissionOverrides"("scope");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserPermissionOverrides_isActive_idx" ON "UserPermissionOverrides"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserPermissionOverrides_userId_scope_key" ON "UserPermissionOverrides"("userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EarlyProductionSample_sampleCode_key" ON "EarlyProductionSample"("sampleCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyProductionSample_orderId_idx" ON "EarlyProductionSample"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyProductionSample_customerStatus_idx" ON "EarlyProductionSample"("customerStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyProductionSample_previousSampleId_idx" ON "EarlyProductionSample"("previousSampleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EarlyProductionSample_qcInspectionReportId_idx" ON "EarlyProductionSample"("qcInspectionReportId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Dr013ExceptionRequest_exceptionNumber_key" ON "Dr013ExceptionRequest"("exceptionNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Dr013ExceptionRequest_exceptionCategory_idx" ON "Dr013ExceptionRequest"("exceptionCategory");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Dr013ExceptionRequest_status_idx" ON "Dr013ExceptionRequest"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Dr013ExceptionRequest_requesterId_idx" ON "Dr013ExceptionRequest"("requesterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Dr013ExceptionRequest_reviewerId_idx" ON "Dr013ExceptionRequest"("reviewerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Dr013ExceptionRequest_exceptionNumber_idx" ON "Dr013ExceptionRequest"("exceptionNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_reviewerResolverRoute_idx" ON "ApprovalRequest"("reviewerResolverRoute");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_departmentSnapshotId_idx" ON "ApprovalRequest"("departmentSnapshotId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_bypassedApprovalId_idx" ON "ApprovalRequest"("bypassedApprovalId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Department_headId_idx" ON "Department"("headId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invoice_ownerId_idx" ON "Invoice"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invoice_departmentId_idx" ON "Invoice"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Order_code_key" ON "Order"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_code_idx" ON "Order"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_ownerId_idx" ON "Order"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_departmentId_idx" ON "Order"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentVoucher_ownerId_idx" ON "PaymentVoucher"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentVoucher_departmentId_idx" ON "PaymentVoucher"("departmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Quotation_ownerId_idx" ON "Quotation"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Quotation_departmentId_idx" ON "Quotation"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Relation_code_key" ON "Relation"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Relation_stage_idx" ON "Relation"("stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Relation_tier_idx" ON "Relation"("tier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Relation_ownerId_idx" ON "Relation"("ownerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Relation_departmentId_idx" ON "Relation"("departmentId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingLead_campaignId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "MarketingLead" ADD CONSTRAINT "MarketingLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

