/**
 * dirtyCacheService.ts — Phase 0-05 DirtyCacheMarker 服务
 *
 * 面向两类调用方：
 *   1. 事件侧（DomainEventBus emitEntityChanged）：写脏 → markDirty()
 *   2. 调度器侧（scheduler tasks / refresh-cache）：取脏清单 → 重算 → resolveDirty()/markFail()
 *
 * 真源：DirtyCacheMarker 表，key=cacheKey 全局唯一；每次 markDirty 幂等 upsert
 * （已脏行 dirtyCount+1，dirtyAt=now，dirty=true，失败计数清零）
 */
import { PrismaClient } from '@prisma/client';

export type CacheScope =
  | 'dashboard'    // 首页经营总览
  | 'report'       // ReportCenter 报表中心
  | 'accounting'   // 财务/成本域（AR/AP、毛利、账龄）
  | 'crm'          // 客户与市场域（客户画像、风险、信用）
  | 'forecast'     // 交期/产能/排产预测
  | 'custom';      // 其他扩展

export interface MarkDirtyInput {
  scope: CacheScope | (string & {}); // 兼容 string 扩展
  entityType?: string;
  entityId?: string;
  /** 额外自定义后缀（极少数 scope 需要对同一 entity 再细分颗粒度），如 ':vat_quarter:2026Q3' */
  extraKey?: string;
  reason?: string;
  actorId?: string;
}

export interface ResolveDirtyInput {
  cacheKey: string;
  /** 重算耗时 ms（监控） */
  resolvedMs?: number;
  /** 可选：输出日志用 */
  resolverName?: string;
}

export interface MarkFailInput {
  cacheKey: string;
  error: Error | string;
}

export interface QueryFilter {
  dirtyOnly?: boolean;
  scope?: CacheScope | string;
  entityType?: string;
  entityId?: string;
  reason?: string;
  actorId?: string;
  /** 只查失败次数≥该值（告警用）*/
  minFailCount?: number;
  limit?: number;
  offset?: number;
  /** dirtyAt 排序：'desc' 默认最新在前 / 'asc' 最早在前（先进先出队列用）*/
  order?: 'desc' | 'asc';
}

export function normalizeCacheKey(input: {
  scope: string; entityType?: string; entityId?: string; extraKey?: string;
}): string {
  const parts: string[] = [
    String(input.scope || 'custom').toLowerCase(),
  ];
  if (input.entityType) parts.push(String(input.entityType));
  if (input.entityId) parts.push(String(input.entityId));
  if (input.extraKey) parts.push(String(input.extraKey));
  // 拼接时统一用 ":"，任何内部 ":" 转 "_" 避免混淆
  return parts.map((s) => s.replace(/[:\s]+/g, '_')).join(':');
}

interface DbLike {
  dirtyCacheMarker?: {
    upsert(args: any): Promise<any>;
    findMany(args: any): Promise<any[]>;
    findUnique(args: any): Promise<any>;
    update(args: any): Promise<any>;
    count?(args: any): Promise<number>;
  };
}

export function createDirtyCacheService(prisma: PrismaClient) {
  function pickDb(db?: DbLike): Required<DbLike>['dirtyCacheMarker'] & any {
    return ((db?.dirtyCacheMarker ? db : prisma) as any).dirtyCacheMarker;
  }

  async function markDirty(input: MarkDirtyInput, db?: DbLike): Promise<{
    cacheKey: string;
    wasDirty: boolean;   // 原行是否已经处于 dirty=true（便于调用方决定是否需要 push websocket 提醒重复标记）
  }> {
    const cacheKey = normalizeCacheKey(input);
    const id = `DCM_${cacheKey}`;
    const t = pickDb(db);
    const existing = await t.findUnique?.({ where: { id }, select: { dirty: true } });
    const wasDirty = !!existing?.dirty;

    await t.upsert({
      where: { id },
      create: {
        id,
        cacheKey,
        scope: String(input.scope),
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        dirty: true,
        reason: input.reason ?? null,
        actorId: input.actorId ?? null,
        dirtyAt: new Date(),
        dirtyCount: 1,
        failCount: 0,
        lastError: null,
        updatedAt: BigInt(Date.now()),
      },
      update: {
        dirty: true,
        reason: input.reason ?? undefined,
        actorId: input.actorId ?? undefined,
        dirtyAt: new Date(),
        dirtyCount: { increment: 1 },
        failCount: 0,    // 重新变脏，失败计数归零
        lastError: null, // 错误也清空
        updatedAt: BigInt(Date.now()),
      },
    });
    return { cacheKey, wasDirty };
  }

  async function resolveDirty(input: ResolveDirtyInput, db?: DbLike): Promise<boolean> {
    const t = pickDb(db);
    const id = `DCM_${input.cacheKey}`;
    try {
      await t.update({
        where: { id },
        data: {
          dirty: false,
          resolvedAt: new Date(),
          resolvedMs: input.resolvedMs ?? null,
          failCount: 0,
          lastError: null,
          updatedAt: BigInt(Date.now()),
        },
      });
      return true;
    } catch {
      // DirtyCacheMarker 行不存在（可能从未脏过），静默返回 false
      return false;
    }
  }

  async function markFail(input: MarkFailInput, db?: DbLike): Promise<boolean> {
    const t = pickDb(db);
    const id = `DCM_${input.cacheKey}`;
    const errMsg = input.error instanceof Error
      ? `${input.error.name}: ${input.error.message}`
      : String(input.error);
    try {
      await t.update({
        where: { id },
        data: {
          // 失败时 dirty 保持 true（下次调度器继续重试），但 failCount+1、lastError=msg
          failCount: { increment: 1 },
          lastError: errMsg.slice(0, 1024),
          updatedAt: BigInt(Date.now()),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 根据实体/scope 获取所有脏项（或未解析项）。
   *   dirtyOnly=true (default)：仅返回 dirty=true
   */
  async function queryDirty(filter: QueryFilter = {}, db?: DbLike): Promise<{ total: number; items: any[] }> {
    const t = pickDb(db);
    const where: any = {};
    if (filter.dirtyOnly !== false) where.dirty = true;
    if (filter.scope) where.scope = filter.scope;
    if (filter.entityType) where.entityType = filter.entityType;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.reason) where.reason = { contains: filter.reason };
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.minFailCount != null) where.failCount = { gte: filter.minFailCount };

    const take = filter.limit ?? 200;
    const skip = filter.offset ?? 0;
    const orderBy: any = { dirtyAt: filter.order === 'asc' ? 'asc' : 'desc' };

    const [all, items] = await Promise.all([
      t.findMany?.({ where, select: { id: true } }) || [],
      t.findMany({
        where,
        orderBy,
        take,
        skip,
      }),
    ]);
    return { total: all.length, items };
  }

  /** 聚合视图：按 scope/entityType/dirty 汇总，用于调度器仪表盘 */
  async function summary(db?: DbLike): Promise<{
    byScope: Array<{ scope: string; dirty: number; clean: number; failedN3: number }>;
    totalDirty: number;
    totalClean: number;
    totalFailed: number; // failCount>=3
  }> {
    const t = pickDb(db);
    const all = await t.findMany({ select: { scope: true, dirty: true, failCount: true } }) || [];
    const map = new Map<string, { dirty: number; clean: number; failedN3: number }>();
    let totalDirty = 0;
    let totalClean = 0;
    let totalFailed = 0;
    for (const row of all) {
      const s = row.scope || 'custom';
      if (!map.has(s)) map.set(s, { dirty: 0, clean: 0, failedN3: 0 });
      const bucket = map.get(s)!;
      if (row.dirty) { bucket.dirty++; totalDirty++; }
      else { bucket.clean++; totalClean++; }
      if ((row.failCount ?? 0) >= 3) { bucket.failedN3++; totalFailed++; }
    }
    const byScope = Array.from(map.entries()).map(([scope, v]) => ({ scope, ...v }));
    return { byScope, totalDirty, totalClean, totalFailed };
  }

  return {
    normalizeCacheKey,
    markDirty,
    resolveDirty,
    markFail,
    queryDirty,
    summary,
  };
}
