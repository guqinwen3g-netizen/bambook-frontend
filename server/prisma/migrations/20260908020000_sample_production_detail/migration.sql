-- DR-054 阶段 G：Sample 模型扩展——大货生产样明细（ship/head/pioneer 统一承载）
-- 手写幂等 SQL（对齐 DR-054 惯例：ADD COLUMN IF NOT EXISTS）

ALTER TABLE "Sample" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
