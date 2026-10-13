/**
 * moqConfigService.ts — MOQ 阈值配置读写服务（MoqThresholdConfig / MoqThresholdConfigHistory）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/MOQ最小起订量.md §2.1-§2.3（配置可调 + 版本治理 + 不追溯）
 *   - docs/design/02-数据模型/Prisma缺口清单与迁移方案.md §2 P0-1/P0-2（模型 DSL + isActive 唯一索引）
 *
 * 铁律（fail-closed）：
 *   1. updateConfig 必须持 scope `settings:moq:write`（DR-041：仅系统管理员/超级管理员容器）
 *   2. changeReason trim 后 ≥5 字（A2 验收：不足即拒）
 *   3. MoqThresholdConfigHistory append-only，绝不更新/删除
 *   4. 并发兜底依赖 DB 部分唯一索引 moq_threshold_config_only_one_active（P2002 → MOQ_UPDATE_FAILED）
 *   5. getActiveConfig 无 active 或 DB 故障 → 返回 null，由调用方走兜底常量（A5 last resort）
 */

import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import { hasPermission, SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';

// ───────────────────────────────────────────────────────────────────
// 常量与错误码
// ───────────────────────────────────────────────────────────────────

/** 取数优先级第 6 层：兜底代码常量（仅当 MoqThresholdConfig 未初始化或 DB 故障时的 last resort） */
export const MOQ_FALLBACK_CONSTANTS = {
  fabricDefaultMoq: 800,
  garmentDefaultMoq: 200,
  capsuleMoq: 20,
} as const;

export const MOQ_SCOPE_DENIED = 'SCOPE_DENIED';
export const MOQ_INVALID_REASON = 'MOQ_INVALID_REASON';
export const MOQ_INVALID_VALUE = 'MOQ_INVALID_VALUE';
export const MOQ_UPDATE_FAILED = 'MOQ_UPDATE_FAILED';

export const MOQ_CONFIG_WRITE_SCOPE = 'settings:moq:write' as const;
const CHANGE_REASON_MIN = 5;

// ───────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────

export interface MoqActor {
  userId: string;
  roles?: string[];
  roleIds?: string[];
  permissions?: string[];
}

export interface MoqConfigRecord {
  id: string;
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  changedBy: string;
  changeReason: string;
}

/** Order.moqSnapshot / Quotation.moqSnapshot 的 JSON 契约（writeOnce，创建时写入） */
export interface MoqSnapshot {
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  snapshotAt: string; // ISO 时间
  configId: string | null; // fallback 时 null
  source: 'moq_config' | 'fallback_constant';
}

export interface UpdateMoqConfigInput {
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  changeReason: string;
}

export interface MoqConfigServiceOptions {
  prisma: PrismaClient;
}

// legacy 角色 → 新 RBAC roleId 映射（与 permissionGuard 内联映射保持同一子集；最小权限原则）
const LEGACY_TO_ROLE_ID: Record<string, string[]> = {
  owner: [SYSTEM_ROLE_IDS.SUPER_ADMIN],
  admin: [SYSTEM_ROLE_IDS.ADMIN],
  manager: [SYSTEM_ROLE_IDS.SALES_MANAGER],
  finance: [SYSTEM_ROLE_IDS.FINANCE],
  sales: [SYSTEM_ROLE_IDS.SALES],
  merchandiser: [SYSTEM_ROLE_IDS.SALES],
  logistics: [SYSTEM_ROLE_IDS.LOGISTICS],
};

/** scope 判定：JWT.permissions 直查 → SUPER_ADMIN 全通 → legacy 角色映射走默认矩阵 */
export function moqActorHasScope(actor: MoqActor, scope: typeof MOQ_CONFIG_WRITE_SCOPE | string): boolean {
  if (!actor) return false;
  if (actor.permissions?.includes(scope)) return true;
  const roles = actor.roles ?? [];
  if (roles.includes('owner') || roles.includes('role-super-admin')) return true;
  const roleIds: string[] = [...(actor.roleIds ?? [])];
  for (const r of roles) {
    const mapped = LEGACY_TO_ROLE_ID[r];
    if (mapped) roleIds.push(...mapped);
  }
  return hasPermission(roleIds, scope as any, null);
}

function moqError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

const shortId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
// Releasing an earlier PG savepoint also removes later savepoints. Keep optional
// SQL sections on the same transaction sequential, including across factories.
const optionalSqlTurns = new WeakMap<object, Promise<void>>();

export function createMoqConfigService(opts: MoqConfigServiceOptions) {
  const { prisma } = opts;
  const db = prisma as any;

  /**
   * A caught PostgreSQL SQL error still aborts the enclosing transaction.
   * Isolate only the existing best-effort reads/alerts, not config/history writes.
   * A normal PrismaClient also has raw SQL; only a transaction client lacks
   * $transaction. Storage substitutes without raw SQL retain their old seam.
   */
  async function optionalSql<T>(operation: () => Promise<T>, onFailure: (error: any) => T): Promise<T> {
    const inTransaction = typeof db.$executeRawUnsafe === 'function' && typeof db.$transaction !== 'function';
    const run = async () => {
      // Internal identifier only: no request/config input is interpolated into SQL.
      const savepoint = inTransaction ? `moq_optional_${randomUUID().replace(/-/g, '')}` : null;
      if (savepoint) await db.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);

      let result: T;
      try {
        result = await operation();
      } catch (error: any) {
        const fallback = onFailure(error); // Keep the original failure in server logs.
        if (savepoint) {
          try {
            await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (recoveryError: any) {
            logger.error('[MoqConfig] 可选 SQL 保存点恢复失败（不能继续调用方事务）', { error: recoveryError?.message });
            throw recoveryError;
          }
        }
        return fallback;
      }
      // Failure to release is not an optional operation failure; propagate it.
      if (savepoint) await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    };
    if (!inTransaction) return run();

    const previous = optionalSqlTurns.get(db);
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    optionalSqlTurns.set(db, turn);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (optionalSqlTurns.get(db) === turn) optionalSqlTurns.delete(db);
    }
  }

  // ── 读当前生效配置：无 active / DB 故障 → null（调用方走兜底常量，A5） ──
  async function getActiveConfig(): Promise<MoqConfigRecord | null> {
    return optionalSql(async () => {
      const row = await db.moqThresholdConfig.findFirst({
        where: { isActive: true },
        orderBy: { effectiveFrom: 'desc' },
      });
      return row ?? null;
    }, (e: any) => {
      logger.error('[MoqConfig] 查询 active 配置失败（返回 null 走兜底常量）', { error: e?.message });
      return null;
    });
  }

  /**
   * 构造 writeOnce 快照（Order/Quotation 创建路径调用）。
   * 无 active 配置时回落兜底常量：source='fallback_constant' + configId=null + error 级告警日志
   * + best-effort 审计（A5：兜底触发必须审计且可观测；审计失败不阻断业务保存）。
   */
  async function buildSnapshot(): Promise<MoqSnapshot> {
    const cfg = await getActiveConfig();
    if (cfg) {
      return {
        fabricDefaultMoq: cfg.fabricDefaultMoq,
        garmentDefaultMoq: cfg.garmentDefaultMoq,
        capsuleMoq: cfg.capsuleMoq,
        snapshotAt: new Date().toISOString(),
        configId: cfg.id,
        source: 'moq_config',
      };
    }
    logger.error('[MoqConfig] MOQ 配置缺失/加载失败，使用兜底常量 800/200/20（last resort，需管理员介入）');
    await optionalSql(async () => {
      await db.auditLog?.create?.({
        data: {
          id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: 'system',
          action: 'MOQ_FALLBACK_CONSTANT_USED',
          targetType: 'MoqThresholdConfig',
          targetId: null,
          detail: { source: 'moqConfigService.buildSnapshot', fallback: MOQ_FALLBACK_CONSTANTS } as any,
          operationType: 'create',
          fieldPath: null,
          transactionId: null,
        },
      });
    }, (e: any) => {
      logger.warn('[MoqConfig] 兜底常量告警审计写入失败（可选审计）', { error: e?.message });
    });
    return {
      ...MOQ_FALLBACK_CONSTANTS,
      snapshotAt: new Date().toISOString(),
      configId: null,
      source: 'fallback_constant',
    };
  }

  /**
   * 管理员调整 MOQ 阈值（A2）：
   *   旧 isActive=true → isActive=false + effectiveTo=now；
   *   新增 1 条 isActive=true 配置 + append 1 条 MoqThresholdConfigHistory（before/after 对比）。
   * 并发由 DB 唯一索引兜底（P2002 → MOQ_UPDATE_FAILED）。
   */
  async function updateConfig(actor: MoqActor, input: UpdateMoqConfigInput): Promise<MoqConfigRecord> {
    if (!actor?.userId) throw moqError(MOQ_SCOPE_DENIED, '变更 MOQ 阈值需登录');
    if (!moqActorHasScope(actor, MOQ_CONFIG_WRITE_SCOPE)) {
      logger.warn('[MoqConfig] 越权写 MOQ 配置被拒绝', { actorId: actor.userId, roles: actor.roles });
      throw moqError(MOQ_SCOPE_DENIED, `INSUFFICIENT_SCOPE ${MOQ_CONFIG_WRITE_SCOPE}（仅系统管理员/超级管理员可调 MOQ 阈值）`);
    }
    const reason = typeof input.changeReason === 'string' ? input.changeReason.trim() : '';
    if (reason.length < CHANGE_REASON_MIN) {
      throw moqError(MOQ_INVALID_REASON, `changeReason 至少 ${CHANGE_REASON_MIN} 字（审计强制，fail-closed）`);
    }
    const values: Array<[string, number]> = [
      ['fabricDefaultMoq', input.fabricDefaultMoq],
      ['garmentDefaultMoq', input.garmentDefaultMoq],
      ['capsuleMoq', input.capsuleMoq],
    ];
    for (const [name, v] of values) {
      if (!Number.isInteger(v) || v <= 0) {
        throw moqError(MOQ_INVALID_VALUE, `${name} 必须为正整数（当前: ${String(v)}）`);
      }
    }

    const current = await getActiveConfig();
    const now = new Date();
    const newId = `MOQCFG__${shortId()}`;
    const histId = `MOQHIST__${shortId()}`;
    const before = current ?? { ...MOQ_FALLBACK_CONSTANTS };

    try {
      const ops: any[] = [];
      if (current) {
        ops.push(db.moqThresholdConfig.update({
          where: { id: current.id },
          data: { isActive: false, effectiveTo: now },
        }));
      }
      ops.push(db.moqThresholdConfig.create({
        data: {
          id: newId,
          fabricDefaultMoq: input.fabricDefaultMoq,
          garmentDefaultMoq: input.garmentDefaultMoq,
          capsuleMoq: input.capsuleMoq,
          isActive: true,
          effectiveFrom: now,
          changedBy: actor.userId,
          changeReason: reason,
        },
      }));
      ops.push(db.moqThresholdConfigHistory.create({
        data: {
          id: histId,
          configId: newId,
          beforeFabricDefaultMoq: before.fabricDefaultMoq,
          beforeGarmentDefaultMoq: before.garmentDefaultMoq,
          beforeCapsuleMoq: before.capsuleMoq,
          afterFabricDefaultMoq: input.fabricDefaultMoq,
          afterGarmentDefaultMoq: input.garmentDefaultMoq,
          afterCapsuleMoq: input.capsuleMoq,
          changedBy: actor.userId,
          changeReason: reason,
          changedAt: now,
        },
      }));
      const results = await db.$transaction(ops);
      const created = results[current ? 1 : 0] as MoqConfigRecord;
      logger.info('[MoqConfig] MOQ 阈值已更新（不追溯已 Confirmed 单据）', {
        newId, changedBy: actor.userId,
        before: { fabric: before.fabricDefaultMoq, garment: before.garmentDefaultMoq, capsule: before.capsuleMoq },
        after: { fabric: input.fabricDefaultMoq, garment: input.garmentDefaultMoq, capsule: input.capsuleMoq },
      });
      return created;
    } catch (e: any) {
      logger.error('[MoqConfig] updateConfig 失败（并发由 DB 唯一索引兜底）', { error: e?.message, code: e?.code });
      throw moqError(MOQ_UPDATE_FAILED, e?.message ?? String(e));
    }
  }

  // ── 变更历史（append-only 只读视图，按 changedAt 倒序） ──
  async function listHistory(opts2: { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts2.limit ?? 50, 1), 200);
    return db.moqThresholdConfigHistory.findMany({
      orderBy: { changedAt: 'desc' },
      take: limit,
    });
  }

  return { getActiveConfig, buildSnapshot, updateConfig, listHistory };
}

export type MoqConfigService = ReturnType<typeof createMoqConfigService>;
