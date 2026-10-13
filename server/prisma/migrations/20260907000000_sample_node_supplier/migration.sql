-- 成衣样品归属打样工厂（DR-051 方案 A：确认样节点归属工厂；面料批次已有 supplierRelationId，成衣对齐）
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/成衣开发流程.md
-- 幂等：ADD COLUMN IF NOT EXISTS 可重复执行

-- AlterTable: SampleNode 归属工厂（确认样由哪家打样工厂出品）
ALTER TABLE "SampleNode"
  ADD COLUMN IF NOT EXISTS "supplierRelationId" TEXT,
  ADD COLUMN IF NOT EXISTS "supplierName" TEXT;

-- 查询加速：按工厂反查其负责的样品节点
CREATE INDEX IF NOT EXISTS "SampleNode_supplierRelationId_idx" ON "SampleNode"("supplierRelationId");
