/**
 * auditService.ts — Phase 0-04 统一审计服务工厂
 *
 * 目标：为 Phase 1/2 业务路由提供"不手写 AuditLog.create"即可得到高质量审计的能力。
 *
 * 与既有 routeAudit.ts（财务写入强约束契约）的关系：
 *   - routeAudit.ts 继续作为财务等高风险路由的"fail closed 审计写底函数"（调用方必须 try/catch，失败让请求 fail）。
 *   - auditService.ts 是面向业务的上层便捷封装：deep diff 嵌套对象 → 自动写多条单字段 before/after + 一条全量快照 + 敏感字段掩码 + 登录/敏感查看装饰器
 *   - 两者写入同一张 AuditLog 表，字段完全兼容。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { writeRouteAuditLog, writeFieldAuditLog } from '../audit/routeAudit';

export type AuditOperationType = 'create' | 'update' | 'delete' | 'transition' | 'link' | 'unlink' | 'login' | 'logout' | 'view_sensitive' | 'export' | 'import' | 'void';

// ────────────────────────────────────────────────────────────────────
// Deep JSON Diff：输出 [{ path: 'a.b[0].c', before, after }]
//   - 对象：逐 key 递归
//   - 数组：递归 element 级比较（element 是对象则 deep，基本类型 idx 级比较）
//   - 基础类型：JSON.stringify 判同（BigInt → string 处理）
//   - 最大深度 32（防循环 / 巨型嵌套结构爆栈）
//   - 可选 excludePaths: string[]（glob 模式支持 "*.password" / "**/bankAccount"）
// ────────────────────────────────────────────────────────────────────
export interface FieldDiff {
  path: string;
  before: unknown;
  after: unknown;
}

const MAX_DEPTH = 32;

function toJsonSafe(v: unknown): unknown {
  // BigInt → string（Prisma DB 读出来的 id/金额/updatedAt 常有 BigInt/Date，转 string 保证 JSON 安全）
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);
}

function pathMatchesGlob(path: string, pattern: string): boolean {
  // 仅支持两种 glob：**/xxx 任意后缀匹配；xxx 整段精确匹配；*.fieldName 段匹配
  const pathSegs = path.split('.');
  const patSegs = pattern.split('.');
  const matchSeg = (ps: string, seg: string) => {
    if (ps === '**') return '__ANY__';
    if (ps.startsWith('*')) return seg.endsWith(ps.slice(1));
    return ps === seg;
  };
  // 暴力双指针：支持 **/xxx 尾部 glob
  if (pattern.startsWith('**/')) {
    const tail = pattern.slice(3);
    return path.endsWith(tail) || path.endsWith(`.${tail}`) || path === tail;
  }
  if (pattern.endsWith('/**')) {
    const head = pattern.slice(0, -3);
    return path === head || path.startsWith(`${head}.`);
  }
  if (pathSegs.length !== patSegs.length) return false;
  for (let i = 0; i < pathSegs.length; i++) {
    if (!matchSeg(patSegs[i], pathSegs[i])) return false;
  }
  return true;
}

function isExcluded(path: string, excludePaths?: string[]): boolean {
  if (!excludePaths?.length) return false;
  return excludePaths.some((p) => pathMatchesGlob(path, p));
}

/**
 * Deep JSON 差异提取。
 *   - 对 create：before=空对象 → 全部字段视为"新增"，可通过 opts.skipCreateFullDiff=true 跳过
 *   - 对 delete：after=空对象 → 全部字段视为"删除"
 */
export function deepJsonDiff(before: unknown, after: unknown, opts?: {
  basePath?: string;
  excludePaths?: string[];
  maxDepth?: number;
  depth?: number;
  sensitiveMaskPlaceholder?: string;
}): FieldDiff[] {
  const base = opts?.basePath || '';
  const maxDepth = opts?.maxDepth ?? MAX_DEPTH;
  const depth = opts?.depth ?? 0;
  const results: FieldDiff[] = [];
  if (depth > maxDepth) return results;

  const bSafe = toJsonSafe(before);
  const aSafe = toJsonSafe(after);

  // 基础类型（含 null/undefined/string/number/bool/BigInt→string/Date→string）
  if (bSafe === aSafe) return results;
  if (
    bSafe == null || aSafe == null ||
    typeof bSafe !== 'object' || typeof aSafe !== 'object'
  ) {
    if (!isExcluded(base, opts?.excludePaths)) {
      results.push({ path: base, before: bSafe, after: aSafe });
    }
    return results;
  }

  // Arrays
  if (Array.isArray(bSafe) && Array.isArray(aSafe)) {
    const len = Math.max(bSafe.length, aSafe.length);
    for (let i = 0; i < len; i++) {
      const childPath = base ? `${base}[${i}]` : `[${i}]`;
      if (isExcluded(childPath, opts?.excludePaths)) continue;
      results.push(...deepJsonDiff(bSafe[i], aSafe[i], {
        basePath: childPath, excludePaths: opts?.excludePaths,
        maxDepth, depth: depth + 1,
      }));
    }
    return results;
  }

  // 一边是数组一边不是 → 直接标不同
  if (Array.isArray(bSafe) !== Array.isArray(aSafe)) {
    if (!isExcluded(base, opts?.excludePaths)) {
      results.push({ path: base, before: bSafe, after: aSafe });
    }
    return results;
  }

  // Plain objects
  if (isPlainObject(bSafe) && isPlainObject(aSafe)) {
    const allKeys = new Set([...Object.keys(bSafe), ...Object.keys(aSafe)]);
    for (const k of allKeys) {
      const childPath = base ? `${base}.${k}` : k;
      if (isExcluded(childPath, opts?.excludePaths)) continue;
      results.push(...deepJsonDiff((bSafe as any)[k], (aSafe as any)[k], {
        basePath: childPath, excludePaths: opts?.excludePaths,
        maxDepth, depth: depth + 1,
      }));
    }
    return results;
  }

  // 其他类型（Map/Set/RegExp…）兜底 JSON.stringify 判同
  if (JSON.stringify(bSafe) !== JSON.stringify(aSafe) && !isExcluded(base, opts?.excludePaths)) {
    results.push({ path: base, before: bSafe, after: aSafe });
  }
  return results;
}

// ────────────────────────────────────────────────────────────────────
// 敏感字段掩码（用于 before/after 全量快照 + 单字段 beforeValue/afterValue）
//   - mask: 把敏感值替换为 "***" 或自定义占位符
//   - 不删除字段（避免审计时产生"字段被移除"的误读）
// ────────────────────────────────────────────────────────────────────
const DEFAULT_SENSITIVE_PATTERNS: string[] = [
  '**/password', '**/passwordHash', '**/secret', '**/token', '**/apiKey',
  '**/bankAccount', '**/bankCardNo', '**/idCardNo', '**/idNumber',
  '**/mobile', '**/phone', '**/privateKey', '**/cvv',
];

export function maskSensitive(obj: unknown, patterns: string[] = DEFAULT_SENSITIVE_PATTERNS, placeholder = '***'): unknown {
  if (obj == null) return obj;
  if (typeof obj !== 'object') return obj;
  // 先 clone 顶层，再递归 mask
  const clone = JSON.parse(JSON.stringify(toJsonSafe(obj), (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  function walk(node: any, path: string): any {
    if (node == null) return node;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((el, i) => walk(el, `${path}[${i}]`));
    const out: Record<string, any> = {};
    for (const k of Object.keys(node)) {
      const childPath = path ? `${path}.${k}` : k;
      const isSensitive = patterns.some((p) => pathMatchesGlob(childPath, p));
      const val = node[k];
      if (isSensitive && val != null && typeof val !== 'object') {
        out[k] = placeholder;
      } else if (val && typeof val === 'object') {
        out[k] = walk(val, childPath);
        if (isSensitive) {
          // 对对象类型敏感字段，全部降级为 placeholder（防止嵌套泄露）
          out[k] = placeholder;
        }
      } else {
        out[k] = val;
      }
    }
    return out;
  }
  return walk(clone, '');
}

// ────────────────────────────────────────────────────────────────────
// createAuditService 工厂
// ────────────────────────────────────────────────────────────────────
export interface DbLike {
  auditLog?: {
    create(args: any): Promise<any>;
    findMany?(args: any): Promise<any[]>;
    findUnique?(args: any): Promise<any>;
  };
}

export interface WriteLogOptions {
  actorId: string;
  source: string;              // 'order.route' / 'finance.invoiceMutation' / 'auth.login' …
  operation: string;           // 语义动作：'create_order' / 'update_invoice_amount'
  operationType: AuditOperationType;
  targetType: string;          // 'Order' / 'Invoice' / 'UserAccount'
  targetId?: string | null;    // 对于 create 可能没 id，写后回填
  /** 是否写全量快照（before/after 入 detail），默认 true */
  snapshot?: boolean;
  /** before 快照（未 mask，service 内部自动 mask）*/
  before?: Record<string, unknown> | null;
  /** after 快照 */
  after?: Record<string, unknown> | null;
  /** 要追踪 deep diff 字段级审计；false 则只写全量快照 */
  fieldAudit?: boolean;
  /** 仅追踪这些顶层字段（不传=全部） */
  trackedFields?: string[];
  /** 排除 diff 路径（glob 模式） */
  excludePaths?: string[];
  transactionId?: string | null;
  ip?: string | null;
  ua?: string | null;
  /** 附加 metadata 入 detail */
  metadata?: Record<string, unknown>;
  /** 敏感字段掩码 patterns；不传=用 DEFAULT_SENSITIVE_PATTERNS；传空数组=不 mask（仅限业务确认无敏感） */
  sensitivePatterns?: string[];
}

export interface QueryLogsFilter {
  actorId?: string;
  action?: string;
  operationType?: AuditOperationType;
  targetType?: string;
  targetId?: string;
  transactionId?: string;
  fieldPath?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export function createAuditService(prisma: PrismaClient) {
  // ============== 统一写入口 ==============
  async function writeLog(db: DbLike, opts: WriteLogOptions): Promise<{
    snapshotLogId: string | null;
    fieldLogIds: string[];
  }> {
    const sensitivePatterns = opts.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
    const beforeMasked = opts.before ? maskSensitive(opts.before, sensitivePatterns) as Record<string, unknown> : null;
    const afterMasked = opts.after ? maskSensitive(opts.after, sensitivePatterns) as Record<string, unknown> : null;

    const detailBase: Record<string, unknown> = { source: opts.source };
    if (opts.metadata) detailBase.metadata = opts.metadata;
    if (opts.ua) detailBase.ua = opts.ua;

    const actorId = opts.actorId || 'system';
    const dbOrPrisma = (db.auditLog ? db : prisma) as any;

    const fieldLogIds: string[] = [];
    let snapshotLogId: string | null = null;

    // 1. 全量快照（默认开启，与旧 routeAudit.writeRouteAuditLog 一致）
    if (opts.snapshot !== false) {
      snapshotLogId = await writeRouteAuditLog({
        prisma: dbOrPrisma,
        actorId,
        source: opts.source,
        operation: opts.operation,
        targetType: opts.targetType,
        targetId: opts.targetId ?? '',
        before: beforeMasked,
        after: afterMasked,
        ip: opts.ip ?? null,
        operationType: opts.operationType,
        transactionId: opts.transactionId ?? null,
      });
      if (opts.metadata || opts.ua) {
        // 回填 metadata/ua（writeRouteAuditLog 没接收，这里 lazy update 一行）
        try {
          await (dbOrPrisma as any).auditLog.update?.({
            where: { id: snapshotLogId },
            data: { detail: { ...(detailBase as any), before: beforeMasked, after: afterMasked } as any },
          });
        } catch {
          // 回填失败不影响主流程
        }
      }
    }

    // 2. 字段级 deep diff
    if (opts.fieldAudit !== false && beforeMasked && afterMasked) {
      let diffs = deepJsonDiff(beforeMasked, afterMasked, {
        excludePaths: opts.excludePaths,
      });
      if (opts.trackedFields?.length) {
        diffs = diffs.filter((d) => {
          const topKey = d.path.split(/[.\[]/)[0];
          return opts.trackedFields!.includes(topKey);
        });
      }
      for (const d of diffs) {
        const fid = await writeFieldAuditLog({
          prisma: dbOrPrisma,
          actorId,
          source: opts.source,
          operation: opts.operation,
          targetType: opts.targetType,
          targetId: opts.targetId ?? '',
          fieldPath: d.path,
          beforeValue: d.before,
          afterValue: d.after,
          operationType: opts.operationType,
          transactionId: opts.transactionId ?? null,
          ip: opts.ip ?? null,
        });
        fieldLogIds.push(fid);
      }
    } else if (opts.fieldAudit !== false) {
      // create/delete：没有 before 或 没有 after → 跳过字段级（仅保留全量快照即可）
    }

    if (typeof logger.debug === 'function') {
      logger.debug('[Audit] writeLog', {
        actorId, operation: opts.operation, targetType: opts.targetType, targetId: opts.targetId ?? '',
        snapshotLogId, fieldLogs: fieldLogIds.length,
      });
    }

    return { snapshotLogId, fieldLogIds };
  }

  // ============== 便捷写入：create/update/delete/transition/link/unlink ==============
  function writeCreate(db: DbLike, opts: Omit<WriteLogOptions, 'operationType' | 'before'> & { before?: null }) {
    return writeLog(db, { ...opts, operationType: 'create', before: null });
  }
  function writeUpdate(db: DbLike, opts: Omit<WriteLogOptions, 'operationType'>) {
    return writeLog(db, { ...opts, operationType: 'update' });
  }
  function writeDelete(db: DbLike, opts: Omit<WriteLogOptions, 'operationType' | 'after'> & { after?: null }) {
    return writeLog(db, { ...opts, operationType: 'delete', after: null });
  }
  function writeTransition(db: DbLike, opts: Omit<WriteLogOptions, 'operationType' | 'fieldAudit'> & {
    fromStatus: string; toStatus: string;
  }) {
    const before: Record<string, unknown> = opts.before as any || { status: opts.fromStatus };
    const after: Record<string, unknown> = opts.after as any || { status: opts.toStatus };
    return writeLog(db, {
      ...opts, operationType: 'transition', fieldAudit: true,
      before, after,
      trackedFields: opts.trackedFields ?? ['status'],
    });
  }
  function writeLink(db: DbLike, opts: Omit<WriteLogOptions, 'operationType'> & {
    linkTargetType: string; linkTargetId: string;
  }) {
    const before: Record<string, unknown> = (opts.before as any) || {};
    const after: Record<string, unknown> = (opts.after as any) || {
      [`linked.${opts.linkTargetType}`]: opts.linkTargetId,
    };
    return writeLog(db, { ...opts, operationType: 'link', before, after, fieldAudit: true });
  }
  function writeUnlink(db: DbLike, opts: Omit<WriteLogOptions, 'operationType'> & {
    linkTargetType: string; linkTargetId: string;
  }) {
    const before: Record<string, unknown> = (opts.before as any) || {
      [`linked.${opts.linkTargetType}`]: opts.linkTargetId,
    };
    const after: Record<string, unknown> = (opts.after as any) || {};
    return writeLog(db, { ...opts, operationType: 'unlink', before, after, fieldAudit: true });
  }

  // ============== 登录/敏感查看（装饰器风格便捷函数，业务代码一行接入）==============
  /**
   * 登录/登出审计。直接调用即可：`await audit.logLogin(prisma, { actorId, success, method, ip, ua })`
   */
  async function logLogin(db: DbLike, opts: {
    actorId?: string;  // success=true 必填；fail 时可空（未知用户）
    targetId?: string; // account id，actorId 一致
    success: boolean;
    method: 'password' | 'refresh_token' | 'sso' | 'api_key' | 'otp' | string;
    failReason?: string;
    ip?: string | null;
    ua?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const operation = opts.success ? 'auth.login' : 'auth.login.fail';
    const detail: Record<string, unknown> = {
      source: 'auth',
      success: opts.success,
      method: opts.method,
      ...(opts.failReason ? { failReason: opts.failReason } : null),
      ...(opts.metadata || {}),
    };
    return writeRouteAuditLog({
      prisma: (db.auditLog ? db : prisma) as any,
      actorId: opts.actorId || `__unauth__`,
      source: 'auth',
      operation,
      targetType: 'UserAccount',
      targetId: opts.targetId || opts.actorId || '__unauth__',
      before: null,
      after: detail,
      ip: opts.ip ?? null,
      operationType: opts.success ? 'login' : 'login',
      // 登录失败场景：ua 写入 detail 更合适（不在 actorId 上暴露）
      transactionId: null,
    });
  }

  async function logLogout(db: DbLike, opts: { actorId: string; ip?: string | null; ua?: string | null; }) {
    return writeRouteAuditLog({
      prisma: (db.auditLog ? db : prisma) as any,
      actorId: opts.actorId,
      source: 'auth',
      operation: 'auth.logout',
      targetType: 'UserAccount',
      targetId: opts.actorId,
      ip: opts.ip ?? null,
      operationType: 'logout',
      before: { session: 'active' } as any,
      after: { session: 'inactive' } as any,
    });
  }

  /**
   * 敏感查看审计：对银行账户、身份证号、发票含税金额成本价等敏感资源的"读取操作"也留痕。
   * 设计：view_sensitive operationType，before=空，after 里只记录"看了哪些字段路径"（不记录字段真实值！）
   */
  async function logSensitiveView(db: DbLike, opts: {
    actorId: string;
    targetType: string;
    targetId: string;
    /** 查看了哪些敏感字段（例：['bankAccount', 'taxId']），只传路径名，不传值 */
    viewedFields: string[];
    /** 查看通道：'ui.detail' / 'api.export' / 'agent.tool' / … */
    via?: string;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return writeRouteAuditLog({
      prisma: (db.auditLog ? db : prisma) as any,
      actorId: opts.actorId,
      source: opts.via || 'api',
      operation: 'audit.view_sensitive',
      targetType: opts.targetType,
      targetId: opts.targetId,
      before: null,
      after: {
        viewedFields: opts.viewedFields,
        via: opts.via || 'api',
        ...(opts.metadata || {}),
      } as any,
      ip: opts.ip ?? null,
      operationType: 'view_sensitive',
      // fieldPath 存第一个字段（便于索引命中），完整列表在 detail.after.viewedFields
      fieldPath: opts.viewedFields[0] || null,
      transactionId: null,
    });
  }

  // ============== 查询：admin 全局分页（按创建时间倒序）==============
  async function queryLogs(db: DbLike, filter: QueryLogsFilter = {}): Promise<{ total: number; items: any[] }> {
    const where: any = {};
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.action) where.action = filter.action;
    if (filter.operationType) where.operationType = filter.operationType;
    if (filter.targetType) where.targetType = filter.targetType;
    if (filter.targetId) where.targetId = filter.targetId;
    if (filter.transactionId) where.transactionId = filter.transactionId;
    if (filter.fieldPath) where.fieldPath = { contains: filter.fieldPath };
    if (filter.fromDate || filter.toDate) {
      where.createdAt = {} as any;
      if (filter.fromDate) where.createdAt.gte = new Date(`${filter.fromDate}T00:00:00Z`);
      if (filter.toDate) where.createdAt.lte = new Date(`${filter.toDate}T23:59:59Z`);
    }
    const dbx = (db.auditLog ? db : prisma) as any;
    const [all, items] = await Promise.all([
      dbx.auditLog.findMany({ where, select: { id: true } } as any),
      dbx.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filter.limit ?? 50,
        skip: filter.offset ?? 0,
        include: { actor: { select: { id: true, displayName: true, email: true } } },
      } as any),
    ]);
    return { total: all.length, items };
  }

  return {
    // 工具函数（业务可直接引用，也可走服务方法）
    deepJsonDiff,
    maskSensitive,
    DEFAULT_SENSITIVE_PATTERNS,

    // 统一写入口
    writeLog,

    // 操作类型便捷写入
    writeCreate,
    writeUpdate,
    writeDelete,
    writeTransition,
    writeLink,
    writeUnlink,

    // 登录/登出/敏感查看装饰器风格
    logLogin,
    logLogout,
    logSensitiveView,

    // 查询
    queryLogs,
  };
}

/** 单例实例（方便路由直接 import 调用；避免每个路由都 new） */
export let __auditServiceSingleton: ReturnType<typeof createAuditService> | null = null;
export function getAuditService(prisma: PrismaClient): ReturnType<typeof createAuditService> {
  if (!__auditServiceSingleton) __auditServiceSingleton = createAuditService(prisma);
  return __auditServiceSingleton;
}
