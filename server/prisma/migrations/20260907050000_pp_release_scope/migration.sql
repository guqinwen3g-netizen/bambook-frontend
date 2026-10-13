-- DR-053 阶段 2：生产放行范围化（ReleaseScope / PpSampleRelease / ReleaseEvent）
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §14
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS 可重复执行

-- ReleaseScope：按订单行/实际批次确定放行范围（scopeRevision 递增=范围变化，旧批准不再匹配）
CREATE TABLE IF NOT EXISTS "ReleaseScope" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "factoryRelationId" TEXT,
    "productionBatchId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT,
    "scopeRevision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'no_release',
    "confirmedSourceType" TEXT,
    "confirmedSourceId" TEXT,
    "specSnapshot" JSONB,
    "currentReleaseId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "ReleaseScope_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseScope_orderId_orderLineId_productionBatchId_key" ON "ReleaseScope"("orderId", "orderLineId", "productionBatchId");
CREATE INDEX IF NOT EXISTS "ReleaseScope_orderId_idx" ON "ReleaseScope"("orderId");
CREATE INDEX IF NOT EXISTS "ReleaseScope_orderLineId_idx" ON "ReleaseScope"("orderLineId");
CREATE INDEX IF NOT EXISTS "ReleaseScope_factoryRelationId_idx" ON "ReleaseScope"("factoryRelationId");

-- PpSampleRelease：产前样批准（批准事实禁止覆盖/删除；requestId 唯一；证据快照冻结）
CREATE TABLE IF NOT EXISTS "PpSampleRelease" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "scopeRevision" INTEGER NOT NULL,
    "signedByProduction" TEXT,
    "signedByBusiness" TEXT,
    "signedAtProduction" BIGINT,
    "signedAtBusiness" BIGINT,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" BIGINT NOT NULL,
    "sampleId" TEXT,
    "sampleRound" INTEGER,
    "evidenceSnapshot" JSONB,
    "ruleVersion" TEXT NOT NULL DEFAULT 'pp-release-v1',
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "PpSampleRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PpSampleRelease_requestId_key" ON "PpSampleRelease"("requestId");
CREATE INDEX IF NOT EXISTS "PpSampleRelease_scopeId_idx" ON "PpSampleRelease"("scopeId");
CREATE INDEX IF NOT EXISTS "PpSampleRelease_sampleId_idx" ON "PpSampleRelease"("sampleId");

-- ReleaseRequest：固定本次审批输入（scope 规格依据 + 样品证据修订；requestRevision 防并发漂移）
CREATE TABLE IF NOT EXISTS "ReleaseRequest" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "scopeRevision" INTEGER NOT NULL,
    "evidenceSnapshot" JSONB,
    "specSnapshot" JSONB,
    "ruleVersion" TEXT NOT NULL DEFAULT 'pp-release-v1',
    "requestRevision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    CONSTRAINT "ReleaseRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReleaseRequest_scopeId_idx" ON "ReleaseRequest"("scopeId");

-- ReleaseSignature：签署追加；同请求同角色唯一；两角色由不同人员承担
CREATE TABLE IF NOT EXISTS "ReleaseSignature" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "signedAt" BIGINT NOT NULL,
    "inputDigest" TEXT,
    CONSTRAINT "ReleaseSignature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseSignature_requestId_role_key" ON "ReleaseSignature"("requestId", "role");
CREATE INDEX IF NOT EXISTS "ReleaseSignature_requestId_idx" ON "ReleaseSignature"("requestId");

-- ReleaseEvent：放行事件 append-only（scope 内 sequence 唯一；sourceKey=触发源幂等键）
CREATE TABLE IF NOT EXISTS "ReleaseEvent" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "releaseId" TEXT,
    "reason" TEXT,
    "actorId" TEXT,
    "sourceKey" TEXT,
    "occurredAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "ReleaseEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseEvent_scopeId_sequence_key" ON "ReleaseEvent"("scopeId", "sequence");
CREATE INDEX IF NOT EXISTS "ReleaseEvent_scopeId_idx" ON "ReleaseEvent"("scopeId");
CREATE INDEX IF NOT EXISTS "ReleaseEvent_releaseId_idx" ON "ReleaseEvent"("releaseId");
