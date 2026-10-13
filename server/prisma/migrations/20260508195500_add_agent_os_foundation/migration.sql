CREATE TABLE IF NOT EXISTS "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserAccount" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "primaryDeptId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Permission" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT,
    "scope" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "risk" TEXT NOT NULL DEFAULT 'low',
    "conditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "memoryScopes" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" BIGINT,
    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,
    "scope" TEXT NOT NULL,
    "memoryType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "relatedEntity" TEXT,
    "relatedEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUri" TEXT,
    "mimeType" TEXT,
    "checksum" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "tags" TEXT[],
    "sourceRange" JSONB,
    "embedding" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeRelation" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "chunkId" TEXT,
    "relationType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeAcl" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "roleId" TEXT,
    "departmentId" TEXT,
    "scope" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    CONSTRAINT "KnowledgeAcl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentTool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL,
    "risk" TEXT NOT NULL DEFAULT 'low',
    "inputSchema" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentToolPermission" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'execute',
    "riskMode" TEXT NOT NULL DEFAULT 'direct',
    CONSTRAINT "AgentToolPermission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentToolRun" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "risk" TEXT NOT NULL DEFAULT 'low',
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "AgentToolRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentJob" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentSuggestion" (
    "id" TEXT NOT NULL,
    "suggestionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scope" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    CONSTRAINT "AgentSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "actionType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "risk" TEXT NOT NULL DEFAULT 'high',
    "payload" JSONB NOT NULL,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserAccount_email_key" ON "UserAccount"("email");
CREATE INDEX IF NOT EXISTS "UserAccount_status_idx" ON "UserAccount"("status");
CREATE INDEX IF NOT EXISTS "UserAccount_primaryDeptId_idx" ON "UserAccount"("primaryDeptId");
CREATE INDEX IF NOT EXISTS "Department_parentId_idx" ON "Department"("parentId");
CREATE INDEX IF NOT EXISTS "Department_status_idx" ON "Department"("status");
CREATE INDEX IF NOT EXISTS "Role_isSystem_idx" ON "Role"("isSystem");
CREATE UNIQUE INDEX IF NOT EXISTS "UserRole_userId_roleId_departmentId_key" ON "UserRole"("userId", "roleId", "departmentId");
CREATE INDEX IF NOT EXISTS "UserRole_roleId_idx" ON "UserRole"("roleId");
CREATE INDEX IF NOT EXISTS "UserRole_departmentId_idx" ON "UserRole"("departmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Permission_scope_key" ON "Permission"("scope");
CREATE UNIQUE INDEX IF NOT EXISTS "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");
CREATE INDEX IF NOT EXISTS "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");
CREATE INDEX IF NOT EXISTS "AgentPolicy_roleId_idx" ON "AgentPolicy"("roleId");
CREATE INDEX IF NOT EXISTS "AgentPolicy_scope_action_idx" ON "AgentPolicy"("scope", "action");
CREATE INDEX IF NOT EXISTS "AgentSession_userId_idx" ON "AgentSession"("userId");
CREATE INDEX IF NOT EXISTS "AgentSession_departmentId_idx" ON "AgentSession"("departmentId");
CREATE INDEX IF NOT EXISTS "AgentSession_status_idx" ON "AgentSession"("status");
CREATE INDEX IF NOT EXISTS "AgentMessage_sessionId_idx" ON "AgentMessage"("sessionId");
CREATE INDEX IF NOT EXISTS "AgentMessage_userId_idx" ON "AgentMessage"("userId");
CREATE INDEX IF NOT EXISTS "AgentMessage_createdAt_idx" ON "AgentMessage"("createdAt");
CREATE INDEX IF NOT EXISTS "AgentMemory_scope_idx" ON "AgentMemory"("scope");
CREATE INDEX IF NOT EXISTS "AgentMemory_memoryType_idx" ON "AgentMemory"("memoryType");
CREATE INDEX IF NOT EXISTS "AgentMemory_userId_idx" ON "AgentMemory"("userId");
CREATE INDEX IF NOT EXISTS "AgentMemory_departmentId_idx" ON "AgentMemory"("departmentId");
CREATE INDEX IF NOT EXISTS "AgentMemory_relatedEntity_relatedEntityId_idx" ON "AgentMemory"("relatedEntity", "relatedEntityId");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_sourceType_idx" ON "KnowledgeDocument"("sourceType");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_status_idx" ON "KnowledgeDocument"("status");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_checksum_idx" ON "KnowledgeDocument"("checksum");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeChunk_documentId_chunkIndex_key" ON "KnowledgeChunk"("documentId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");
CREATE INDEX IF NOT EXISTS "KnowledgeRelation_documentId_idx" ON "KnowledgeRelation"("documentId");
CREATE INDEX IF NOT EXISTS "KnowledgeRelation_chunkId_idx" ON "KnowledgeRelation"("chunkId");
CREATE INDEX IF NOT EXISTS "KnowledgeRelation_targetType_targetId_idx" ON "KnowledgeRelation"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "KnowledgeRelation_relationType_idx" ON "KnowledgeRelation"("relationType");
CREATE INDEX IF NOT EXISTS "KnowledgeAcl_documentId_idx" ON "KnowledgeAcl"("documentId");
CREATE INDEX IF NOT EXISTS "KnowledgeAcl_roleId_idx" ON "KnowledgeAcl"("roleId");
CREATE INDEX IF NOT EXISTS "KnowledgeAcl_departmentId_idx" ON "KnowledgeAcl"("departmentId");
CREATE INDEX IF NOT EXISTS "KnowledgeAcl_scope_idx" ON "KnowledgeAcl"("scope");
CREATE INDEX IF NOT EXISTS "AgentTool_scope_idx" ON "AgentTool"("scope");
CREATE INDEX IF NOT EXISTS "AgentTool_risk_idx" ON "AgentTool"("risk");
CREATE INDEX IF NOT EXISTS "AgentTool_status_idx" ON "AgentTool"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentToolPermission_toolId_roleId_key" ON "AgentToolPermission"("toolId", "roleId");
CREATE INDEX IF NOT EXISTS "AgentToolPermission_roleId_idx" ON "AgentToolPermission"("roleId");
CREATE INDEX IF NOT EXISTS "AgentToolRun_toolId_idx" ON "AgentToolRun"("toolId");
CREATE INDEX IF NOT EXISTS "AgentToolRun_userId_idx" ON "AgentToolRun"("userId");
CREATE INDEX IF NOT EXISTS "AgentToolRun_sessionId_idx" ON "AgentToolRun"("sessionId");
CREATE INDEX IF NOT EXISTS "AgentToolRun_status_idx" ON "AgentToolRun"("status");
CREATE INDEX IF NOT EXISTS "AgentToolRun_idempotencyKey_idx" ON "AgentToolRun"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AgentJob_jobType_idx" ON "AgentJob"("jobType");
CREATE INDEX IF NOT EXISTS "AgentJob_status_idx" ON "AgentJob"("status");
CREATE INDEX IF NOT EXISTS "AgentJob_priority_idx" ON "AgentJob"("priority");
CREATE INDEX IF NOT EXISTS "AgentJob_scheduledAt_idx" ON "AgentJob"("scheduledAt");
CREATE INDEX IF NOT EXISTS "AgentSuggestion_suggestionType_idx" ON "AgentSuggestion"("suggestionType");
CREATE INDEX IF NOT EXISTS "AgentSuggestion_status_idx" ON "AgentSuggestion"("status");
CREATE INDEX IF NOT EXISTS "AgentSuggestion_scope_idx" ON "AgentSuggestion"("scope");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_requesterId_idx" ON "ApprovalRequest"("requesterId");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_reviewerId_idx" ON "ApprovalRequest"("reviewerId");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");
CREATE INDEX IF NOT EXISTS "ApprovalRequest_actionType_idx" ON "ApprovalRequest"("actionType");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Department_parentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserAccount_primaryDeptId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "UserAccount" ADD CONSTRAINT "UserAccount_primaryDeptId_fkey" FOREIGN KEY ("primaryDeptId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_userId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_roleId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_departmentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RolePermission_roleId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RolePermission_permissionId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentPolicy_roleId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentPolicy" ADD CONSTRAINT "AgentPolicy_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentSession_userId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentSession_departmentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentMessage_sessionId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentMessage_userId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentMemory_userId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentMemory_departmentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeChunk_documentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeRelation_documentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeRelation" ADD CONSTRAINT "KnowledgeRelation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeRelation_chunkId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeRelation" ADD CONSTRAINT "KnowledgeRelation_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "KnowledgeChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeAcl_documentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeAcl" ADD CONSTRAINT "KnowledgeAcl_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeAcl_roleId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeAcl" ADD CONSTRAINT "KnowledgeAcl_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeAcl_departmentId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "KnowledgeAcl" ADD CONSTRAINT "KnowledgeAcl_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentToolPermission_toolId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentToolPermission" ADD CONSTRAINT "AgentToolPermission_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "AgentTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentToolPermission_roleId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentToolPermission" ADD CONSTRAINT "AgentToolPermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentToolRun_toolId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentToolRun" ADD CONSTRAINT "AgentToolRun_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "AgentTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentToolRun_userId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "AgentToolRun" ADD CONSTRAINT "AgentToolRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApprovalRequest_requesterId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApprovalRequest_reviewerId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
