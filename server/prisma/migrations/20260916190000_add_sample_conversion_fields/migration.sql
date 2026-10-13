-- D7-① 转化通道：SampleLengthMovement 增加「目标对象」字段（全部可空，零破坏）
ALTER TABLE "SampleLengthMovement" ADD COLUMN IF NOT EXISTS "targetInventoryItemId" TEXT;
ALTER TABLE "SampleLengthMovement" ADD COLUMN IF NOT EXISTS "targetRelationId" TEXT;
ALTER TABLE "SampleLengthMovement" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(18,4);
