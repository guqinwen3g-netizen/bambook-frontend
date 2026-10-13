-- 修复 schema 漂移（2026-09-13 发现）：panda_hub_local 缺失 ReleaseRequest / ReleaseSignature 两张表。
--
-- 背景：20260907050000_pp_release_scope 在 _prisma_migrations 里已记录为 applied
-- （finished_at = 2026-09-07 19:34），但真库里这两张表并不存在 —— 迁移记账与实际结构不一致。
-- 后果：DR-053 阶段 2 的 PP 放行链路「发起放行请求 / 领导签字」在真库上 100% 报 500
-- （The table `public.ReleaseRequest` does not exist），PP 样门禁（§10 定案硬拦截）完全不可用。
--
-- 全部语句幂等（IF NOT EXISTS），可安全重复执行；已存在的表/索引不会被重建或清数据。

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

CREATE INDEX IF NOT EXISTS "ReleaseRequest_scopeId_idx" ON "ReleaseRequest"("scopeId");

CREATE INDEX IF NOT EXISTS "ReleaseSignature_requestId_idx" ON "ReleaseSignature"("requestId");

CREATE UNIQUE INDEX IF NOT EXISTS "ReleaseSignature_requestId_role_key" ON "ReleaseSignature"("requestId", "role");
