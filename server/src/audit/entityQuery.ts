/**
 * 阶段 D / D6：审计日志共享查询构造 + 实体级读权限映射
 *
 * 两个消费方：
 *   1. admin/route.ts  GET /api/admin/audit-logs（owner/admin 全局查询）
 *   2. audit/route.ts  GET /api/v1/audit/entity（普通用户按实体查询，模块读权限门禁）
 *
 * 权限模型：targetType → 允许读该模块审计的角色集合（与 agent/defaults.ts
 * DEFAULT_AGENT_TOOLS 的 allowedRoles 语义对齐）。未映射的 targetType
 * fail closed 到 owner/admin/manager。
 */

import type { AgentRole } from '../agent/types';

// ────────────────────────────────────────────────────────────────
// where 构造（admin 全局端点与实体端点共享）
// ────────────────────────────────────────────────────────────────

export interface AuditLogQueryParams {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: string;
  offset?: string;
}

export type AuditLogQueryBuild =
  | { ok: true; where: Record<string, any>; limit: number; offset: number }
  | { ok: false; status: 400; error: string; message: string };

const strictNonNegInt = (v: any) => typeof v === 'string' && /^\d+$/.test(v);

export function buildAuditLogQuery(q: AuditLogQueryParams): AuditLogQueryBuild {
  const { action, actorId, targetType, targetId, createdFrom, createdTo, limit = '100', offset = '0' } = q;

  // pagination（严格整数字符串校验，不宽松吞掉 10abc/1.5）
  const safeLimit = strictNonNegInt(limit) ? Math.min(parseInt(limit, 10), 500) : (limit === undefined ? 100 : NaN);
  const safeOffset = strictNonNegInt(offset) ? parseInt(offset, 10) : (offset === undefined ? 0 : NaN);
  if (isNaN(safeLimit) || isNaN(safeOffset)) {
    return { ok: false, status: 400, error: 'INVALID_PAGINATION', message: 'limit and offset must be non-negative integer strings' };
  }

  // date range（AuditLog.createdAt 是 DateTime，转 Date 对象）
  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  if (createdFrom !== undefined) {
    const f = Number(createdFrom);
    if (!Number.isFinite(f) || f < 0) {
      return { ok: false, status: 400, error: 'INVALID_DATE_RANGE', message: 'createdFrom must be a valid timestamp (ms)' };
    }
    fromDate = new Date(f);
  }
  if (createdTo !== undefined) {
    const t = Number(createdTo);
    if (!Number.isFinite(t) || t < 0) {
      return { ok: false, status: 400, error: 'INVALID_DATE_RANGE', message: 'createdTo must be a valid timestamp (ms)' };
    }
    toDate = new Date(t);
  }
  if (fromDate && toDate && fromDate > toDate) {
    return { ok: false, status: 400, error: 'INVALID_DATE_RANGE', message: 'createdFrom must be <= createdTo' };
  }

  const where: any = {};
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (targetType) where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = fromDate;
    if (toDate) where.createdAt.lte = toDate;
  }

  return { ok: true, where, limit: safeLimit, offset: safeOffset };
}

// ────────────────────────────────────────────────────────────────
// 实体级读权限映射（targetType → allowedRoles）
// 与 DEFAULT_AGENT_TOOLS 各 scope 的只读工具 allowedRoles 对齐。
// ────────────────────────────────────────────────────────────────

const ORDERS_READ: AgentRole[] = ['owner', 'admin', 'manager', 'merchandiser', 'finance', 'sales'];
const RELATIONS_READ: AgentRole[] = ['owner', 'admin', 'manager', 'merchandiser', 'sales'];
const FINANCE_READ: AgentRole[] = ['owner', 'admin', 'manager', 'finance', 'sales', 'merchandiser'];
const SHIPPING_READ: AgentRole[] = ['owner', 'admin', 'manager', 'finance', 'sales', 'merchandiser', 'logistics'];
const QUOTATIONS_READ: AgentRole[] = ['owner', 'admin', 'manager', 'sales', 'merchandiser'];
const CUSTOMS_READ: AgentRole[] = ['owner', 'admin', 'manager', 'finance', 'sales', 'merchandiser'];
const EMAIL_READ: AgentRole[] = ['owner', 'admin', 'manager', 'merchandiser', 'finance', 'sales', 'logistics'];
const PRODUCTS_READ: AgentRole[] = ['owner', 'admin', 'manager', 'merchandiser', 'finance', 'sales', 'viewer', 'agent_operator'];
const DEVELOPMENT_READ: AgentRole[] = ['owner', 'admin', 'manager', 'merchandiser', 'finance', 'sales', 'viewer', 'agent_operator'];
const PRODUCTION_READ: AgentRole[] = ['owner', 'admin', 'manager', 'production_manager', 'factory', 'merchandiser', 'logistics'];

/** 未映射 targetType 的兜底（fail closed：仅管理层可见） */
const FALLBACK_READ: AgentRole[] = ['owner', 'admin', 'manager'];

export const AUDIT_ENTITY_READ_ROLES: Record<string, AgentRole[]> = {
  Order: ORDERS_READ,
  OrderLine: ORDERS_READ,
  Relation: RELATIONS_READ,
  Contact: RELATIONS_READ,
  Invoice: FINANCE_READ,
  PaymentVoucher: FINANCE_READ,
  PaymentAllocation: FINANCE_READ,
  PurchaseOrder: ['owner', 'admin', 'manager', 'merchandiser', 'finance'],
  Shipment: SHIPPING_READ,
  ShipmentLine: SHIPPING_READ,
  Quotation: QUOTATIONS_READ,
  LetterOfCredit: CUSTOMS_READ,
  CustomsDeclaration: CUSTOMS_READ,
  Email: EMAIL_READ,
  EmailMessage: EMAIL_READ,
  ProductAsset: PRODUCTS_READ,
  DevelopmentCase: DEVELOPMENT_READ,
  ProductionStage: PRODUCTION_READ,
};

/**
 * 判定 actor 是否可读指定 targetType 的实体审计。
 * owner/admin 恒可（全局审计权与 /api/admin/audit-logs 一致）。
 */
export function canReadEntityAudit(actorRoles: string[], targetType: string): boolean {
  const roles = actorRoles as AgentRole[];
  if (roles.includes('owner') || roles.includes('admin')) return true;
  const allowed = AUDIT_ENTITY_READ_ROLES[targetType] ?? FALLBACK_READ;
  return roles.some(r => allowed.includes(r));
}
