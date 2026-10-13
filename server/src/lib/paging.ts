/**
 * 分页参数收敛（权限矩阵全组合审计 P1-4，2026-09-03）
 *
 * 背景：多处列表端点 `Number(req.query.limit)` 直透 → limit=-5 / 999999 退化为
 * 全量 dump 或 Prisma take 负值报错。统一收敛：
 *   - limit：非有限/非正 → fallback；上限 max（默认 200，台账类可放宽到 500）
 *   - offset：非有限/负 → 0
 */

export function clampLimit(limit: number | undefined | null, fallback = 50, max = 200): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

export function clampOffset(offset: number | undefined | null): number {
  if (offset === undefined || offset === null || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}
