/**
 * A5 报表引擎 — 定义 CRUD + 运行执行服务
 *
 * 失败契约（与 finance 模块一致）：
 *   - 所有校验 fail closed，错误返回 { ok: false, error: { code, message } }
 *   - 审计日志随业务写入同事务（写定义 = 低风险配置变更，仍落审计保证可追溯）
 *   - 调度幂等：ReportRun.idempotencyKey unique 约束兜底，同周期重复触发返回
 *     DUPLICATE_RUN（不重复执行聚合）
 *   - 运行快照上限 RUN_SNAPSHOT_LIMIT 行；预览上限 PREVIEW_LIMIT 行
 */

import { PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import {
  ReportQuerySpec,
  REPORT_SCHEDULES,
  ReportSchedule,
  executeReportDrill,
  executeReportQuery,
  validateDrillGroup,
  validateReportQuery,
} from './reportEngine';

export const PREVIEW_LIMIT = 500;
export const RUN_SNAPSHOT_LIMIT = 5000;
/** A5d 下钻明细行数上限 */
export const DRILL_LIMIT = 200;

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

function generateId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ────────────────────────────────────────────────────────────────
// 1. 定义 CRUD
// ────────────────────────────────────────────────────────────────

export interface ReportDefinitionInput {
  name: string;
  description?: string;
  datasetKey: string;
  dimensions: string[];
  metrics: Array<{ field: string; agg: string }>;
  filters?: Array<{ field: string; op: string; value: unknown }>;
  schedule?: string | null;
  enabled?: boolean;
}

function validateSchedule(schedule: unknown): { ok: true; value: ReportSchedule | null } | { ok: false; message: string } {
  if (schedule === undefined || schedule === null || schedule === '') return { ok: true, value: null };
  if (typeof schedule === 'string' && REPORT_SCHEDULES.includes(schedule as ReportSchedule)) {
    return { ok: true, value: schedule as ReportSchedule };
  }
  return { ok: false, message: `schedule must be one of ${REPORT_SCHEDULES.join('|')} or null` };
}

export async function createReportDefinition(params: {
  prisma: PrismaClient;
  input: ReportDefinitionInput;
  actorId?: string;
  ip?: string | null;
}): Promise<Result<{ definition: any; auditId: string }>> {
  const { prisma, input, actorId, ip } = params;

  if (!input || typeof input.name !== 'string' || !input.name.trim()) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'name is required' } };
  }
  if (input.name.trim().length > 100) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'name must be ≤100 chars' } };
  }
  const scheduleCheck = validateSchedule(input.schedule);
  if (!scheduleCheck.ok) {
    return { ok: false, error: { code: 'INVALID_SCHEDULE', message: scheduleCheck.message } };
  }
  const queryCheck = validateReportQuery(input);
  if (!queryCheck.ok) return { ok: false, error: queryCheck.error };
  const { spec } = queryCheck;

  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const now = BigInt(Date.now());
      const definition = await tx.reportDefinition.create({
        data: {
          id: generateId('RPD'),
          name: input.name.trim(),
          description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null,
          datasetKey: spec.datasetKey,
          dimensions: spec.dimensions as any,
          metrics: spec.metrics as any,
          filters: spec.filters.length > 0 ? (spec.filters as any) : null,
          schedule: scheduleCheck.value,
          enabled: input.enabled !== false,
          createdBy: actorId ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'system',
        source: 'reporting.create',
        operation: 'CREATE_REPORT_DEFINITION',
        targetType: 'ReportDefinition',
        targetId: definition.id,
        after: { name: definition.name, datasetKey: spec.datasetKey, schedule: scheduleCheck.value },
        ip,
        operationType: 'create',
      });
      return { definition, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    logger.error('[Reporting] create definition failed', { error: e?.message });
    return { ok: false, error: { code: 'CREATE_FAILED', message: e?.message ?? 'create failed' } };
  }
}

export async function updateReportDefinition(params: {
  prisma: PrismaClient;
  definitionId: string;
  input: Partial<ReportDefinitionInput>;
  actorId?: string;
  ip?: string | null;
}): Promise<Result<{ definition: any; auditId: string }>> {
  const { prisma, definitionId, input, actorId, ip } = params;
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'input is required' } };
  }

  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.reportDefinition.findUnique({ where: { id: definitionId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error('report definition not found'), { code: 'NOT_FOUND' });
      }

      // 查询字段任一变更 → 以合并后的完整定义重新校验白名单
      const merged = {
        datasetKey: input.datasetKey ?? existing.datasetKey,
        dimensions: (input.dimensions ?? existing.dimensions) as unknown,
        metrics: (input.metrics ?? existing.metrics) as unknown,
        filters: (input.filters ?? existing.filters ?? []) as unknown,
      };
      const queryCheck = validateReportQuery(merged);
      if (!queryCheck.ok) {
        throw Object.assign(new Error(queryCheck.error.message), { code: queryCheck.error.code });
      }

      const data: any = { updatedAt: BigInt(Date.now()) };
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) {
          throw Object.assign(new Error('name must be 1-100 chars'), { code: 'INVALID_INPUT' });
        }
        data.name = input.name.trim();
      }
      if (input.description !== undefined) {
        data.description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null;
      }
      data.datasetKey = queryCheck.spec.datasetKey;
      data.dimensions = queryCheck.spec.dimensions as any;
      data.metrics = queryCheck.spec.metrics as any;
      data.filters = queryCheck.spec.filters.length > 0 ? (queryCheck.spec.filters as any) : null;

      if (input.schedule !== undefined) {
        const scheduleCheck = validateSchedule(input.schedule);
        if (!scheduleCheck.ok) {
          throw Object.assign(new Error(scheduleCheck.message), { code: 'INVALID_SCHEDULE' });
        }
        data.schedule = scheduleCheck.value;
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') {
          throw Object.assign(new Error('enabled must be boolean'), { code: 'INVALID_INPUT' });
        }
        data.enabled = input.enabled;
      }

      const definition = await tx.reportDefinition.update({ where: { id: definitionId }, data });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'system',
        source: 'reporting.update',
        operation: 'UPDATE_REPORT_DEFINITION',
        targetType: 'ReportDefinition',
        targetId: definitionId,
        before: { name: existing.name, datasetKey: existing.datasetKey, schedule: existing.schedule, enabled: existing.enabled },
        after: { name: definition.name, datasetKey: definition.datasetKey, schedule: definition.schedule, enabled: definition.enabled },
        ip,
        operationType: 'update',
      });
      return { definition, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    const code = e?.code ?? 'UPDATE_FAILED';
    return { ok: false, error: { code, message: e?.message ?? 'update failed' } };
  }
}

export async function deleteReportDefinition(params: {
  prisma: PrismaClient;
  definitionId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<Result<{ auditId: string }>> {
  const { prisma, definitionId, actorId, ip } = params;
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.reportDefinition.findUnique({ where: { id: definitionId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error('report definition not found'), { code: 'NOT_FOUND' });
      }
      await tx.reportDefinition.update({
        where: { id: definitionId },
        data: { deletedAt: BigInt(Date.now()), enabled: false, updatedAt: BigInt(Date.now()) },
      });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId: actorId || 'system',
        source: 'reporting.delete',
        operation: 'DELETE_REPORT_DEFINITION',
        targetType: 'ReportDefinition',
        targetId: definitionId,
        before: { name: existing.name },
        ip,
        operationType: 'delete',
      });
      return { auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    const code = e?.code ?? 'DELETE_FAILED';
    return { ok: false, error: { code, message: e?.message ?? 'delete failed' } };
  }
}

// ────────────────────────────────────────────────────────────────
// 2. 预览（不落库）
// ────────────────────────────────────────────────────────────────

export async function previewReportQuery(params: {
  prisma: PrismaClient;
  input: unknown;
}): Promise<Result<{ columns: string[]; columnLabels: string[]; rows: any[]; truncated: boolean }>> {
  const check = validateReportQuery(params.input);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const result = await executeReportQuery(params.prisma, check.dataset, check.spec, PREVIEW_LIMIT + 1);
    const truncated = result.rows.length > PREVIEW_LIMIT;
    if (truncated) result.rows = result.rows.slice(0, PREVIEW_LIMIT);
    return { ok: true, data: { ...result, truncated } };
  } catch (e: any) {
    logger.error('[Reporting] preview failed', { error: e?.message });
    return { ok: false, error: { code: 'PREVIEW_FAILED', message: e?.message ?? 'preview failed' } };
  }
}

// ────────────────────────────────────────────────────────────────
// 2.5 下钻（A5d：聚合组 → 组成员实体明细，不落库）
// ────────────────────────────────────────────────────────────────

export async function drillReportQuery(params: {
  prisma: PrismaClient;
  input: unknown;
}): Promise<Result<Awaited<ReturnType<typeof executeReportDrill>>>> {
  const body = (params.input ?? {}) as Record<string, unknown>;
  const check = validateReportQuery(params.input);
  if (!check.ok) return { ok: false, error: check.error };
  const groupCheck = validateDrillGroup(check.spec, body.group);
  if (!groupCheck.ok) return { ok: false, error: groupCheck.error };
  try {
    const result = await executeReportDrill(params.prisma, check.dataset, check.spec, groupCheck.group, DRILL_LIMIT);
    return { ok: true, data: result };
  } catch (e: any) {
    logger.error('[Reporting] drill failed', { error: e?.message });
    return { ok: false, error: { code: 'DRILL_FAILED', message: e?.message ?? 'drill failed' } };
  }
}

// ────────────────────────────────────────────────────────────────
// 3. 运行（落快照）
// ────────────────────────────────────────────────────────────────

export async function runReportDefinition(params: {
  prisma: PrismaClient;
  definitionId: string;
  trigger: 'manual' | 'schedule';
  /** 调度场景必传：definitionId:periodKey */
  idempotencyKey?: string;
  actorId?: string;
}): Promise<Result<{ run: any; skipped?: boolean }>> {
  const { prisma, definitionId, trigger, idempotencyKey, actorId } = params;

  const definition = await (prisma as any).reportDefinition.findUnique({ where: { id: definitionId } });
  if (!definition || definition.deletedAt) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'report definition not found' } };
  }
  if (trigger === 'schedule' && !definition.enabled) {
    return { ok: false, error: { code: 'DISABLED', message: 'report definition is disabled' } };
  }

  // 调度幂等：同周期已有运行记录 → 直接返回（不重复执行）
  if (idempotencyKey) {
    const existing = await (prisma as any).reportRun.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return { ok: true, data: { run: existing, skipped: true } };
    }
  }

  // 定义字段在创建/更新时已校验；此处以存储值复核（fail closed，防手工改库）
  const check = validateReportQuery({
    datasetKey: definition.datasetKey,
    dimensions: definition.dimensions,
    metrics: definition.metrics,
    filters: definition.filters ?? [],
  });
  if (!check.ok) {
    return { ok: false, error: { code: 'DEFINITION_INVALID', message: `stored definition failed validation: ${check.error.message}` } };
  }

  let run: any;
  try {
    run = await (prisma as any).reportRun.create({
      data: {
        id: generateId('RPR'),
        definitionId: definition.id,
        definitionName: definition.name,
        status: 'Running',
        trigger,
        idempotencyKey: idempotencyKey ?? null,
        startedAt: BigInt(Date.now()),
        createdAt: BigInt(Date.now()),
      },
    });
  } catch (e: any) {
    // unique 冲突 = 并发重复触发，按已运行处理（fail closed）
    if (e?.code === 'P2002' && idempotencyKey) {
      const existing = await (prisma as any).reportRun.findUnique({ where: { idempotencyKey } });
      if (existing) return { ok: true, data: { run: existing, skipped: true } };
    }
    logger.error('[Reporting] run create failed', { error: e?.message });
    return { ok: false, error: { code: 'RUN_CREATE_FAILED', message: e?.message ?? 'run create failed' } };
  }

  try {
    const result = await executeReportQuery(prisma, check.dataset, check.spec, RUN_SNAPSHOT_LIMIT);
    run = await (prisma as any).reportRun.update({
      where: { id: run.id },
      data: {
        status: 'Success',
        rowCount: result.rows.length,
        columns: result.columns as any,
        columnLabels: result.columnLabels as any,
        rows: result.rows as any,
        finishedAt: BigInt(Date.now()),
      },
    });
    await (prisma as any).reportDefinition.update({
      where: { id: definition.id },
      data: { lastRunAt: BigInt(Date.now()) },
    });
    logger.info('[Reporting] run success', {
      runId: run.id, definitionId: definition.id, trigger, rowCount: result.rows.length, actorId,
    });
    return { ok: true, data: { run } };
  } catch (e: any) {
    run = await (prisma as any).reportRun.update({
      where: { id: run.id },
      data: { status: 'Failed', error: String(e?.message ?? 'execute failed').slice(0, 500), finishedAt: BigInt(Date.now()) },
    });
    logger.error('[Reporting] run failed', { runId: run.id, definitionId: definition.id, error: e?.message });
    return { ok: false, error: { code: 'RUN_FAILED', message: e?.message ?? 'run failed' } };
  }
}
