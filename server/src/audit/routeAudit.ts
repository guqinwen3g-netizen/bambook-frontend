// routeAudit 接收 prisma 或 tx（any 类型，支持事务内审计）
/**
 * task_mqxv9giu (finance-route-audit-contract): finance route 审计日志契约。
 *
 * 失败契约（高风险财务写入）：
 *   - AuditLog 写入失败必须抛出/传播，不能静默吞（fail closed）。
 *   - 高风险财务写入若审计无法落盘，必须让请求失败，不得伪成功。
 *
 * 原则：
 *   1. 仅在业务变更成功后写入（validation 失败/业务错误不写，避免误导审计）
 *   2. AuditLog 失败 → 抛出（由 route catch 转成 500，不伪成功）
 *   3. 必含 actor/source/entityType/entityId/operation + before/after 或 payload
 *
 * Phase 0 Sprint 1 扩展：字段级审计
 *   - operationType: create / update / delete / transition / link / unlink
 *   - fieldPath: 如 "status" 或 "lines[0].quantity"
 *   - beforeValue / afterValue: 单字段前值/后值（与 detail.before/after 互补，
 *     detail 存全量快照，beforeValue/afterValue 存单字段精确追踪）
 *   - transactionId: 关联 OrderStatusTransition / BusinessEvent id，串联同一业务操作
 */

export interface RouteAuditInput {
  prisma: any;  // PrismaClient 或 $transaction tx（支持事务内审计）
  actorId: string;
  source: string;
  operation: string;
  targetType: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  // ── Phase 0 Sprint 1: 字段级审计 ──
  operationType?: string | null;  // create / update / delete / transition / link / unlink
  fieldPath?: string | null;       // 如 "status" 或 "lines[0].quantity"
  beforeValue?: unknown;    // 单字段前值
  afterValue?: unknown;     // 单字段后值
  transactionId?: string | null;  // 关联 OrderStatusTransition / BusinessEvent id
  /** 写进 detail.note 的一句话（界面上的「详情」列看得到）—— 用于降级/异常这类"必须让人看见"的说明 */
  note?: string | null;
}

/**
 * 写入 route 审计日志。
 * - 成功：写入 AuditLog，detail 含 source/before/after
 * - 失败：抛出（不静默吞），由 route catch 转成 500（高风险财务写入不得伪成功）
 *
 * Phase 0 Sprint 1: 支持字段级审计（operationType/fieldPath/beforeValue/afterValue/transactionId）
 * 向后兼容：新字段全部 optional，已有调用方无需修改。
 */
export async function writeRouteAuditLog(input: RouteAuditInput): Promise<string> {
  const id = `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const detail: Record<string, unknown> = { source: input.source };
  if (input.before != null) detail.before = input.before;
  if (input.after != null) detail.after = input.after;
  if (input.note) detail.note = input.note;

  await input.prisma.auditLog.create({
    data: {
      id,
      actorId: input.actorId || SYSTEM_AUDIT_ACTOR,
      action: input.operation,
      targetType: input.targetType,
      targetId: input.targetId,
      detail: detail as any,
      ip: input.ip ?? null,
      // 字段级审计（Phase 0 Sprint 1）
      operationType: input.operationType ?? null,
      fieldPath: input.fieldPath ?? null,
      beforeValue: input.beforeValue != null ? (input.beforeValue as any) : null,
      afterValue: input.afterValue != null ? (input.afterValue as any) : null,
      transactionId: input.transactionId ?? null,
    },
  });
  return id;
}

// ────────────────────────────────────────────────────────────────
// 字段级审计便捷 helper
// ────────────────────────────────────────────────────────────────

export interface FieldAuditInput {
  prisma: any;
  actorId: string;
  source: string;
  operation: string;
  targetType: string;
  targetId: string;
  /** 变更字段路径，如 "status" / "amount" / "lines[0].quantity" */
  fieldPath: string;
  /** 变更前值 */
  beforeValue: unknown;
  /** 变更后值 */
  afterValue: unknown;
  /** 操作类型：create / update / delete / transition / link / unlink（默认 update）*/
  operationType?: string | null;
  /** 关联业务事务 ID（OrderStatusTransition.id / BusinessEvent.id）*/
  transactionId?: string | null;
  ip?: string | null;
  /** 见 RouteAuditInput.note：一句话说明，落进 detail，界面「详情」列可见 */
  note?: string | null;
}

/**
 * 字段级审计日志 — 追踪单个字段的 before→after 变更。
 *
 * 适用场景：
 *   - 状态机转移（status: Draft → Issued）
 *   - 金额变更（amount: 1000 → 1500）
 *   - 关联建立/解除（orderId: null → "ord_xxx"）
 *
 * 与 writeRouteAuditLog 的关系：
 *   - writeRouteAuditLog: 全量快照（before/after 存整个记录）
 *   - writeFieldAuditLog: 单字段精确追踪（beforeValue/afterValue 存一个字段的值）
 *   - 两者可同时调用：全量快照 + 关键字段精确追踪
 */
export async function writeFieldAuditLog(input: FieldAuditInput): Promise<string> {
  return writeRouteAuditLog({
    prisma: input.prisma,
    actorId: input.actorId,
    source: input.source,
    operation: input.operation,
    targetType: input.targetType,
    targetId: input.targetId,
    operationType: input.operationType || 'update',
    fieldPath: input.fieldPath,
    beforeValue: input.beforeValue,
    afterValue: input.afterValue,
    transactionId: input.transactionId,
    ip: input.ip,
    note: input.note,
  });
}

/**
 * 批量字段级审计 — 对比 before/after 快照，自动 diff 出变更字段并逐条记录。
 *
 * 适用场景：一次 PATCH 请求修改了多个字段，需要为每个变更字段单独写审计日志。
 *
 * @returns 写入的审计日志 ID 数组（每个变更字段一条）
 */
export async function writeFieldAuditDiff(params: {
  prisma: any;
  actorId: string;
  source: string;
  operation: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** 仅追踪这些字段（不传则追踪所有变更字段）*/
  trackedFields?: string[];
  operationType?: string;
  transactionId?: string;
  ip?: string | null;
  /** 见 RouteAuditInput.note：一句话说明，随每条字段级记录落进 detail */
  note?: string | null;
}): Promise<string[]> {
  const { prisma, actorId, source, operation, targetType, targetId, before, after, trackedFields, operationType = 'update', transactionId, ip, note } = params;
  const ids: string[] = [];

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (trackedFields && !trackedFields.includes(key)) continue;
    const b = before[key];
    const a = after[key];
    // 跳过未变更字段（浅比较）
    if (JSON.stringify(b) === JSON.stringify(a)) continue;

    const id = await writeFieldAuditLog({
      prisma,
      actorId,
      source,
      operation,
      targetType,
      targetId,
      fieldPath: key,
      beforeValue: b ?? null,
      afterValue: a ?? null,
      operationType,
      transactionId,
      ip,
      note,
    });
    ids.push(id);
  }

  return ids;
}

/**
 * ★ B58：无认证主体时写进"身份列"的唯一哨兵。
 * `AuditLog.actorId` 有外键 → `UserAccount(id)`（真库 pg_constraint 实测），而 `'api'` / `'agent'` / `'unknown'`
 * 在 `UserAccount` 里**都没有行** ⇒ 拿它们当 actorId 会让整笔业务写入 P2003 回滚（表现是"数据库错误"，真相是身份写错）。
 * `'system'`（系统服务）是 seed 里真存在的行 —— 本仓既有收敛（见下方 actorIdFromRequest 的注释），
 * 现在把这份"哪个字面量才是合法身份"收成一个导出常量，别再让每个调用点各自抄一遍（历史上已重犯 3 次）。
 */
export const SYSTEM_AUDIT_ACTOR = 'system';

/**
 * ★ B58：agent/审批提交类入口统一用它取审计身份。
 * 取值来源应是**审批请求人**（由 `toolDispatchRegistry` 注入 `ctx.actorId`）；
 * 拿不到才落 `SYSTEM_AUDIT_ACTOR`。绝不再允许 `'agent'` 这类库里不存在的字面量出现在身份位上。
 */
export function auditActorFrom(params: { actorId?: string | null } | undefined | null): string {
  return String(params?.actorId || '').trim() || SYSTEM_AUDIT_ACTOR;
}

/**
 * ★ B218：审计身份的**存在性**闸门（`auditActorFrom` 的补集，不是它的替代）。
 *
 * 为什么需要：`AuditLog.actorId` 有外键 → `UserAccount(id)`，而
 * `auth/accountStatusGuard.ts` 对「token 验签有效但**库里没有这个账号**」是**明文 fail-open 放行**
 * （注释原话："遗留 token / 测试造数 → 放行，交由下游 scope 校验"）⇒ 一个已被删掉的用户，
 * 手里的 7 天 TTL token 还能一路打到业务层，拿它的 userId 当 actorId 就是 P2003，
 * 整笔业务写入连带回滚（B58 那一族的表现：界面上是"数据库错误"，真相是身份位写了库里不存在的值）。
 *
 * 与"静默吞掉审计"的区别（本仓 fail-closed 契约不许改）：这里**不**放弃写审计 ——
 * 换成一个库里真有的身份（'system'），并把"它声称是谁"原样留在 detail 里，
 * 于是变更史看得见这笔降级，而不是少了一行。
 *
 * @returns `actorId` 落库用的身份；`unknownClaim` 非空＝发生了降级（原值不在 UserAccount）
 */
export async function resolveAuditActorId(
  prismaOrTx: any,
  claimedId?: string | null,
): Promise<{ actorId: string; unknownClaim: string | null }> {
  const claimed = String(claimedId || '').trim();
  if (!claimed) return { actorId: SYSTEM_AUDIT_ACTOR, unknownClaim: null };
  const hit = await prismaOrTx.userAccount.count({ where: { id: claimed } });
  if (hit > 0) return { actorId: claimed, unknownClaim: null };
  return { actorId: SYSTEM_AUDIT_ACTOR, unknownClaim: claimed };
}

export function actorIdFromRequest(req: any): string {
  // 'system' 哨兵与 seed 系统账号对齐（AuditLog.actorId 外键要求 UserAccount 行存在；
  // 历史哨兵 'api' 无对应账号 → API-Key 审计写 FK 违约，已统一收敛为 'system'）
  return req?.actor?.userId || req?.actor?.id || SYSTEM_AUDIT_ACTOR;
}
