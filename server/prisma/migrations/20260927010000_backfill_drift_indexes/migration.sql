-- B243（v3.161）：把"只活在库里、没进主线"的两个索引补进迁移历史
--
-- 成因（2026-09-27 在克隆库 `panda_hub_fresh_0927` 上实测）：
--   用现成的 `prisma db push` 从空库建出来的 schema 与现库逐项对撞 ⇒
--   表 225 vs 226（差的 `_prisma_migrations` 是簿记表，不计），但**索引差 2 条**，
--   而且这 2 条**没有任何一条迁移创建过**（其中一条连 schema.prisma 都没声明）：
--     · `SampleNode_supplierRelationId_idx` —— 由迁移 `20260907000000_sample_node_supplier` 建，
--       但 schema 没声明 ⇒ 走 `db push` 建新库会静默丢掉它（现库靠它撑"按打样工厂查样品节点"）。
--       ★ 本批同时把它补进 `schema.prisma`（SampleNode 的 `@@index([supplierRelationId])`），两条路一致。
--     · `moq_threshold_config_only_one_active` —— **部分唯一索引**，业务含义是
--       "全库只允许一条 `isActive=true` 的 MOQ 阈值配置"。schema 里只在注释中提到它（第 6 级取阈值链路的唯一性来源），
--       **迁移历史与 schema 都不产出它** ⇒ 新库建出来之后，两条"生效配置"能同时写进去，取哪一条变成不确定。
--       ★ Prisma schema 表达不了 partial unique ⇒ 只能靠本迁移（或部署 SOP 里一步手工 DDL）。
--
-- ★ 幂等：全部 `IF NOT EXISTS` ⇒ 对现库执行是无操作（现库两个索引都在），不会锁表也不会重建。
-- ★ 本批**没有在业务库上执行**：这是结构变更面，按 §8.2 走正常发布路径（部署时随 `migrate deploy` 生效）。

CREATE INDEX IF NOT EXISTS "SampleNode_supplierRelationId_idx" ON "SampleNode"("supplierRelationId");

CREATE UNIQUE INDEX IF NOT EXISTS "moq_threshold_config_only_one_active"
  ON "MoqThresholdConfig" USING btree ((1))
  WHERE "isActive" = true;
