-- 客户门户 (Customer Portal)：外部客户账号表
-- 幂等手写 SQL（对齐 DR-054 惯例：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）
-- 登录后只能读取 relationId 对应客户公司名下数据（数据作用域真源）。

CREATE TABLE IF NOT EXISTS "CustomerUser" (
  "id"           TEXT        NOT NULL,
  "email"        TEXT        NOT NULL,
  "passwordHash" TEXT        NOT NULL,
  "displayName"  TEXT        NOT NULL,
  "relationId"   TEXT        NOT NULL,
  "relationName" TEXT,
  "contactPhone" TEXT,
  "status"       TEXT        NOT NULL DEFAULT 'active',
  "lastLoginAt"  TIMESTAMP(3),
  "lastLoginIp"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "deletedAt"    BIGINT,

  CONSTRAINT "CustomerUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerUser_email_key" ON "CustomerUser"("email");
CREATE INDEX IF NOT EXISTS "CustomerUser_relationId_idx" ON "CustomerUser"("relationId");
CREATE INDEX IF NOT EXISTS "CustomerUser_status_idx" ON "CustomerUser"("status");