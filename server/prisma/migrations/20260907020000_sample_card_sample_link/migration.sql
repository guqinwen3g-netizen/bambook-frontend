-- DR-052 §10#3 样品库存迁入对齐：实物样卡（SampleCardItem）↔ 统一样品对象（Sample）软关联
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §7/§10#3
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 可重复执行

-- AddColumn: SampleCardItem.sampleId（软关联 Sample.id，无 FK 约束，与 devCaseId/orderId 风格一致）
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "sampleId" TEXT;

-- 查询加速索引（样品详情反查实物样卡 / 样品间按样品过滤）
CREATE INDEX IF NOT EXISTS "SampleCardItem_sampleId_idx" ON "SampleCardItem"("sampleId");
