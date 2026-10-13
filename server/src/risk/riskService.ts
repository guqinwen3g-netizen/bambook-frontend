import { businessNowDate } from '../shared/businessClock';
/**
 * H3 风险管理与合规服务 — Risk Management & Compliance（PRD 15）
 *
 * 职责：
 *   1. 统一风险预警（RiskAlert）：所有维度预警的唯一入口 raiseAlert，
 *      dedupKey @unique 为幂等真源（同键重复在 DB 层拒绝）。
 *   2. 汇率（PRD 15.1）：汇率档案 + 波动预警 + 大额订单汇率锁定。
 *   3. 信用（PRD 15.2）：客户信用评级（append-only）+ 逾期冻结/坏账扫描。
 *      逾期口径沿用 receivableOverdueDetector：effectiveDue = dueDate ?? issueDate + 30 天。
 *   4. 合规（PRD 15.3）：HS Code 校验 / 出口管制（禁运国）/ 原产地规则（人工通道）。
 *   5. 质量（PRD 15.4）：疵点趋势聚合 + 重复疵点预警。
 *
 * 设计原则（与 suppliers/seasons 模块一致）：
 *   - 服务工厂模式 createRiskService(prisma)
 *   - 软删除（deletedAt BigInt，仅 FxRateLock 有该字段；ExchangeRate/CreditRating/
 *     ComplianceCheck/RiskAlert 为 append-only 档案，无软删）
 *   - 中文校验错误消息 = **给用户看的业务文案**，抛出方必须自带 `code` + `statusCode`
 *     （见文件级 `badRequest()` / `bizNotFound()`）；路由层不再按消息关键字猜状态码
 */

import { PrismaClient, RiskAlert } from '@prisma/client';
import { logger } from '../lib/logger';
import { createCreditService } from '../credit/creditService';
import { createSystemConfigService } from '../config/systemConfigService';
// ★ 「未结清应收」判据唯一真源（含 amount>0 守卫）—— 0 元/负额票不算逾期、不算坏账
import { openReceivableWhere, hasOpenAmount, RECEIVABLE_OPEN_STATUSES } from '../shared/openReceivable';
// ★ 业务错误状态码真源：抛出方只声明码名，状态码从注册表取（不在本文件抄第二份 code→status）
import { businessError } from '../shared/errorCodes';
import crypto from 'crypto';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

/**
 * 预警类型**唯一真源**（D6 真源化）。
 *
 * ⚠️ 此前是**两份**：这里一个 `readonly string[]`（运行期白名单，`raiseAlert` 用它做校验）
 *   + 上面一个 TS 联合类型（编译期）。两份必然漂移 ——
 *   我加 `forward_fx_maturity` 时只改了联合类型，真库演练立刻报「非法预警类型」。
 *   ⇒ 现在由**一份常量数组**同时派生出运行期白名单与编译期类型（改一处两侧生效）。
 */
export const ALERT_TYPES = [
  'fx_volatility', 'credit_frozen', 'bad_debt', 'compliance_fail', 'quality_repeat', 'sample_deadline',
  'hr_lifecycle', 'crm_follow_up_overdue', 'lc_maturity', 'tax_refund_stall', 'factory_visit', 'dunning_stage',
  'forward_fx_maturity', // D6：远期结汇合约到期预警
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertLevel = 'info' | 'warning' | 'critical';
export type AlertStatus = 'Open' | 'Acknowledged' | 'Resolved';

export interface RaiseAlertInput {
  type: AlertType;
  level: AlertLevel;
  title: string;
  content: string;
  relatedType?: string;
  relatedId?: string;
  dedupKey: string;
}

export interface ExchangeRateInput {
  currency: string;
  rate: number;
  effectiveDate?: string; // YYYY-MM-DD，默认今日
  source?: string; // manual | api（默认 manual）
  note?: string | null;
}

export interface FxLockInput {
  orderId: string;
  currency: string;
  rate?: number; // 缺省取该币种最新汇率
  note?: string | null;
}

export interface ManualComplianceCheckInput {
  type: string; // hs_code | export_control | origin_rule
  targetType: string;
  targetId: string;
  result: string; // pass | warn | fail
  summary: string;
  details?: unknown;
}

// 运行期白名单已由上面的 ALERT_TYPES 真源提供（不再另写一份）
const ALERT_LEVELS: readonly string[] = ['info', 'warning', 'critical'];
const ALERT_STATUSES: readonly string[] = ['Open', 'Acknowledged', 'Resolved'];
const COMPLIANCE_TYPES: readonly string[] = ['hs_code', 'export_control', 'origin_rule'];
const COMPLIANCE_RESULTS: readonly string[] = ['pass', 'warn', 'fail'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Net 30 推定：dueDate 缺失时以开票日 +30 天为有效到期日（与 receivableOverdueDetector 同口径） */
const NET30_DAYS = 30;
/** 汇率波动预警阈值：|Δ%| ≥ 2 预警，≥ 5 升 critical */
const FX_WARN_PCT = 2;
const FX_CRITICAL_PCT = 5;
/** 信用冻结阈值：最大逾期 > 60 天冻结额度；> 180 天记坏账预警 */
const CREDIT_FREEZE_DAYS = 60;
const BAD_DEBT_DAYS = 180;
/** 重复疵点扫描窗口：近 90 天 */
const QUALITY_REPEAT_WINDOW_DAYS = 90;

/**
 * 出口管制禁运清单（M7：数据库配置真源）。
 *   - SystemConfig `global::risk.sanctionedCountries`（json 字符串数组）为生效清单；
 *     未配置/读取失败时回退内置默认清单（fail-safe，不失效放行）。
 *   - 匹配口径：ISO 两位码 或 常见英文国名，大小写不敏感精确匹配（trim 后比对）。
 */
export const SANCTIONED_COUNTRIES_CONFIG_KEY = 'risk.sanctionedCountries';
const DEFAULT_SANCTIONED_COUNTRIES = ['KP', 'IR', 'CU', 'SY', 'North Korea', 'Iran', 'Cuba', 'Syria'];
/** 清单条目上限（防误粘贴超大配置拖慢匹配） */
const SANCTIONED_LIST_MAX_ITEMS = 200;
const SANCTIONED_ITEM_MAX_LEN = 100;

/** HS 编码可接受格式：纯数字 4-10 位，或 4 位 + 1-3 组 ".xx" 点分扩展 */
const HS_PLAIN_RE = /^\d{4,10}$/;
const HS_DOTTED_RE = /^\d{4}(\.\d{2}){1,3}$/;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

/** 解析 YYYY-MM-DD 为本地零点毫秒；非法返回 null */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 本地零点毫秒 → YYYY-MM-DD */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 有效到期日（本地零点毫秒）：dueDate 优先，缺失按 Net 30 推定；均无法解析返回 null */
function effectiveDueMs(dueDate: string | null | undefined, issueDate: string | null | undefined): number | null {
  const due = parseDate(dueDate);
  if (due !== null) return due;
  const issue = parseDate(issueDate);
  if (issue === null) return null;
  return issue + NET30_DAYS * DAY_MS;
}

/** YYYY-MM-DD → YYYY-Q（如 2026-Q3）；非法返回 null */
function quarterOf(dateStr: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr ?? '');
  if (!m) return null;
  const q = Math.floor((Number(m[2]) - 1) / 3) + 1;
  return `${m[1]}-Q${q}`;
}

/**
 * 疵点描述分词：先全局去掉 xN / x N / ×N 数量缀（如 "跳线x3"→"跳线"、
 * "色花 x 2"→"色花"），再按空白/中英文逗号/顿号/分号切分，空串忽略。
 */
function parseDefectKeywords(summary: string | null | undefined): string[] {
  if (!summary) return [];
  return summary
    .replace(/[xX×]\s*\d+/g, ' ')
    .split(/[\s，、,;；]+/)
    .map(w => w.trim())
    .filter(w => w.length > 0);
}

function matchesSanctionedCountry(destination: string, sanctionedItems: string[]): boolean {
  const set = new Set(sanctionedItems.map(i => i.toLowerCase()));
  return set.has(destination.trim().toLowerCase());
}

/**
 * 业务错误工厂（S0-A Task 5 · risk 试点）。
 *
 * 为什么状态码必须在这里声明，而不是让路由层去猜：
 * `riskRoute` 的 `handleError` 以前靠**中文子串**反推状态码
 * （`msg.includes('必填') → 400`、`includes('不存在') → 404`、其余 500），
 * 于是 ① 同一句话换域就换状态码（2026-09-20 取样的一版**启发式计数**：窗口 ±6 行、判定 = 中文
 *    `.includes()` 参与状态码判定、先剥注释 —— **不是**精确普查，估出全仓另有 **约 21 个文件、跨 18 个模块**
 *    在用同款写法且关键词清单互不相同；它只支撑「不是孤例」，**不等于「剩余工作量 = 21 个文件」**），
 * ② 任何**不含**这些中文词的真异常（Prisma 原文、`TypeError`…）统统掉进 500，
 *    并且**原文被直接吐进响应体** —— 业务员屏幕上出现 `Unknown argument \`deletedAts\``。
 * 猜码已废除 ⇒ 「这是不是给用户看的业务拒绝」必须由抛出方用形状说明：
 * `code:string` + `statusCode:number` 同时存在就是业务错误（判据 `isBusinessError`），
 * 路由会原样透传它的状态码与文案；不带这个形状的异常一律按注册表兜底文案回 500，原文只进日志。
 *
 * 状态码取自 `shared/errorCodes` 注册表里那个码 —— 本文件不抄第二份 code→status 映射。
 */
function badRequest(message: string): Error & { code: string; statusCode: number } {
  // v2.46：构造器上收到 `shared/errorCodes.businessError`（第二个域也要用 ⇒ 不留两份实现），
  // 本文件只保留"这是 400 还是 404"的语义命名。
  return businessError('VALIDATION_FAILED', message);
}

/** 404：目标记录不存在或已软删（产品语义，不是服务端故障） */
function bizNotFound(message: string): Error & { code: string; statusCode: number } {
  return businessError('NOT_FOUND', message);
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createRiskService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();
  const todayStr = () => formatDate(new Date(businessNowDate().setHours(0, 0, 0, 0)).getTime());

  // ══════════════════════════════════════════════════════════════
  // 1. 统一风险预警 RiskAlert
  // ══════════════════════════════════════════════════════════════

  /**
   * 所有维度预警的唯一入口。dedupKey 命中（先查或 P2002）返回既有记录，
   * 不产生重复告警。
   */
  async function raiseAlert(input: RaiseAlertInput): Promise<{ created: boolean; alert: RiskAlert }> {
    if (!ALERT_TYPES.includes(input.type)) throw badRequest(`非法预警类型：${input.type}`);
    if (!ALERT_LEVELS.includes(input.level)) throw badRequest(`非法预警级别：${input.level}`);
    if (!input.title?.trim()) throw badRequest('预警标题必填');
    if (!input.dedupKey?.trim()) throw badRequest('dedupKey 必填');

    const existing = await db.riskAlert.findUnique({ where: { dedupKey: input.dedupKey } });
    if (existing) return { created: false, alert: existing };

    const ts = now();
    try {
      const alert = await db.riskAlert.create({
        data: {
          id: generateId('RSKA'),
          type: input.type,
          level: input.level,
          title: input.title.trim(),
          content: input.content ?? '',
          relatedType: input.relatedType ?? null,
          relatedId: input.relatedId ?? null,
          dedupKey: input.dedupKey,
          status: 'Open',
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
          resolvedAt: null,
        },
      });
      logger.info('[RiskService] alert raised', { id: alert.id, type: input.type, level: input.level, dedupKey: input.dedupKey });
      return { created: true, alert };
    } catch (e: any) {
      // 并发兜底：唯一约束冲突 → 返回既有记录
      if (e?.code === 'P2002') {
        const again = await db.riskAlert.findUnique({ where: { dedupKey: input.dedupKey } });
        if (again) return { created: false, alert: again };
      }
      throw e;
    }
  }

  async function listAlerts(query: { type?: string; level?: string; status?: string; limit?: number; offset?: number }) {
    const where: any = {};
    if (query.type) where.type = query.type;
    if (query.level) where.level = query.level;
    if (query.status) where.status = query.status;
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.riskAlert.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
      db.riskAlert.count({ where }),
    ]);
    return { items, total };
  }

  async function updateAlertStatus(id: string, status: string, actorId: string): Promise<RiskAlert> {
    if (!ALERT_STATUSES.includes(status)) {
      throw badRequest(`非法预警状态：${status}（允许 Open | Acknowledged | Resolved）`);
    }
    const alert = await db.riskAlert.findUnique({ where: { id } });
    if (!alert) throw bizNotFound('预警不存在');
    const ts = now();
    const data: Record<string, unknown> = { status, updatedAt: BigInt(ts) };
    if (status === 'Resolved') data.resolvedAt = BigInt(ts);
    const updated = await db.riskAlert.update({ where: { id }, data });
    logger.info('[RiskService] alert status updated', { id, status, actorId });
    return updated;
  }

  async function getRiskOverview() {
    // ★ 计数用 groupBy 在 DB 侧聚合（权威），**不能**从截断窗口里数：
    //   旧实现 `findMany({ take: 500 })` 后在内存累加 → Open 预警超过 500 条时
    //   `openByType` / `openByLevel` 会**静默少计**（用户看到的总数偏小且无从察觉）。
    //   `take` 现在只用于 `recent`（最近 10 条）—— 那里截断是**预期语义**。
    const [byType, byLevel, recent] = await Promise.all([
      db.riskAlert.groupBy({ by: ['type'], where: { status: 'Open' }, _count: { _all: true } }),
      db.riskAlert.groupBy({ by: ['level'], where: { status: 'Open' }, _count: { _all: true } }),
      db.riskAlert.findMany({
        where: { status: 'Open' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const openByType: Record<string, number> = {};
    for (const row of byType) openByType[row.type] = row._count._all;
    const openByLevel: Record<string, number> = {};
    for (const row of byLevel) openByLevel[row.level] = row._count._all;
    return { openByType, openByLevel, recent };
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 汇率（PRD 15.1）
  // ══════════════════════════════════════════════════════════════

  async function addExchangeRate(input: ExchangeRateInput, actorId: string) {
    if (!input.currency?.trim()) throw badRequest('币种必填');
    const currency = input.currency.trim().toUpperCase();
    const rate = Number(input.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw badRequest('汇率必须大于 0');
    const effectiveDate = input.effectiveDate ?? todayStr();
    if (!DATE_RE.test(effectiveDate)) throw badRequest('effectiveDate 必须是 YYYY-MM-DD');

    // 波动检查基准：同币种上一条（按 effectiveDate + createdAt 最新）
    const prev = await db.exchangeRate.findFirst({
      where: { currency },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });

    const row = await db.exchangeRate.create({
      data: {
        id: generateId('FXR'),
        currency,
        rate,
        effectiveDate,
        source: input.source ?? 'manual',
        note: input.note ?? null,
        createdAt: BigInt(now()),
      },
    });
    logger.info('[RiskService] exchange rate added', { id: row.id, currency, rate, effectiveDate, actorId });

    if (prev) {
      const prevRate = Number(prev.rate);
      if (prevRate > 0) {
        const deltaPct = ((rate - prevRate) / prevRate) * 100;
        const absPct = Math.abs(deltaPct);
        if (absPct >= FX_WARN_PCT) {
          const level: AlertLevel = absPct >= FX_CRITICAL_PCT ? 'critical' : 'warning';
          await raiseAlert({
            type: 'fx_volatility',
            level,
            title: `${currency} 汇率波动 ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`,
            content: `${currency} 汇率由 ${prevRate}（${prev.effectiveDate}）变动至 ${rate}（${effectiveDate}），幅度 ${deltaPct.toFixed(2)}%，请关注在手订单结汇成本。`,
            relatedType: 'ExchangeRate',
            relatedId: row.id,
            dedupKey: `fx_volatility:${currency}:${effectiveDate}`,
          });
        }
      }
    }
    return row;
  }

  async function listExchangeRates(query: { currency?: string; limit?: number }) {
    const where: any = {};
    if (query.currency) where.currency = query.currency.trim().toUpperCase();
    const take = Math.min(query.limit || 50, 200);
    const [items, total] = await Promise.all([
      db.exchangeRate.findMany({ where, orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }], take }),
      db.exchangeRate.count({ where }),
    ]);
    return { items, total };
  }

  /** 全部出现过的币种各取最新一条（按 effectiveDate + createdAt 最新） */
  async function getLatestRates() {
    const rows = await db.exchangeRate.findMany({
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    const seen = new Set<string>();
    const latest: Array<{ currency: string; rate: number; effectiveDate: string; source: string }> = [];
    for (const r of rows) {
      if (seen.has(r.currency)) continue;
      seen.add(r.currency);
      latest.push({ currency: r.currency, rate: Number(r.rate), effectiveDate: r.effectiveDate, source: r.source });
    }
    return latest.sort((a, b) => a.currency.localeCompare(b.currency));
  }

  async function lockFxRate(input: FxLockInput, actorId: string) {
    if (!input.orderId?.trim()) throw badRequest('orderId 必填');
    if (!input.currency?.trim()) throw badRequest('币种必填');
    const currency = input.currency.trim().toUpperCase();

    const order = await db.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.deletedAt !== null) throw bizNotFound('订单不存在');

    let rate: number;
    if (input.rate !== undefined && input.rate !== null) {
      rate = Number(input.rate);
      if (!Number.isFinite(rate) || rate <= 0) throw badRequest('汇率必须大于 0');
    } else {
      const latest = await db.exchangeRate.findFirst({
        where: { currency },
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      });
      if (!latest) throw badRequest('无可用汇率，请先录入');
      rate = Number(latest.rate);
    }

    const dup = await db.fxRateLock.findFirst({
      where: { orderId: input.orderId, currency, deletedAt: null },
    });
    if (dup) throw badRequest('该订单此币种已锁定汇率');

    const ts = now();
    const lock = await db.fxRateLock.create({
      data: {
        id: generateId('FXL'),
        orderId: input.orderId,
        currency,
        rate,
        lockedAt: BigInt(ts),
        lockedById: actorId,
        note: input.note ?? null,
        createdAt: BigInt(ts),
        deletedAt: null,
      },
    });
    logger.info('[RiskService] fx rate locked', { id: lock.id, orderId: input.orderId, currency, rate, actorId });
    return lock;
  }

  async function listFxLocks(query: { orderId?: string }) {
    const where: any = { deletedAt: null };
    if (query.orderId) where.orderId = query.orderId;
    const [items, total] = await Promise.all([
      db.fxRateLock.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }),
      db.fxRateLock.count({ where }),
    ]);
    return { items, total };
  }

  async function deleteFxLock(id: string, actorId: string): Promise<void> {
    const lock = await db.fxRateLock.findUnique({ where: { id } });
    if (!lock || lock.deletedAt !== null) throw bizNotFound('汇率锁定不存在');
    await db.fxRateLock.update({ where: { id }, data: { deletedAt: BigInt(now()) } });
    logger.info('[RiskService] fx lock soft-deleted', { id, actorId });
  }

  // ══════════════════════════════════════════════════════════════
  // 3. 信用（PRD 15.2）
  // ══════════════════════════════════════════════════════════════

  /**
   * 客户信用评级：基于应收发票实时计算因子并 append 一条 CreditRating。
   * actorId 传 null 表示系统自动评估。
   */
  async function evaluateCreditRating(relationId: string, actorId?: string | null) {
    if (!relationId?.trim()) throw badRequest('relationId 必填');
    const relation = await db.relation.findUnique({ where: { id: relationId } });
    if (!relation || relation.deletedAt !== null) throw bizNotFound('客户关系不存在');
    if (relation.category !== 'Customer') {
      throw badRequest('仅 category=Customer 的 Relation 可评估信用评级');
    }

    const invoices = await db.invoice.findMany({
      where: { type: 'Receivable', deletedAt: null, customerRelationId: relationId },
    });

    const todayMs = new Date(businessNowDate().setHours(0, 0, 0, 0)).getTime();

    // 已结清且结算日可解析 → 准时率样本
    const settled = invoices.filter((i: any) => i.status === 'Paid' && parseDate(i.settlementDate) !== null);
    let onTimeRate: number | null = null;
    if (settled.length > 0) {
      const onTime = settled.filter((i: any) => {
        const dueMs = effectiveDueMs(i.dueDate, i.issueDate);
        if (dueMs === null) return false; // 到期日不可判定，保守计为不准时
        return parseDate(i.settlementDate)! <= dueMs;
      }).length;
      onTimeRate = onTime / settled.length;
    }

    // 当前逾期：未结清且今日 > 有效到期日
    let overdueCount = 0;
    let maxDaysOverdue = 0;
    for (const inv of invoices) {
      if (!(RECEIVABLE_OPEN_STATUSES as readonly string[]).includes(inv.status)) continue;
      if (!hasOpenAmount(inv.amount)) continue; // ★ 不欠钱 ⇒ 不存在逾期（0 元/负额票）
      const dueMs = effectiveDueMs(inv.dueDate, inv.issueDate);
      if (dueMs === null) continue;
      const days = Math.floor((todayMs - dueMs) / DAY_MS);
      if (days >= 1) {
        overdueCount += 1;
        if (days > maxDaysOverdue) maxDaysOverdue = days;
      }
    }

    // 合作年限：最早开票日至今
    let cooperationYears = 0;
    const issueDates = invoices
      .map((i: any) => parseDate(i.issueDate))
      .filter((t: number | null): t is number => t !== null);
    if (issueDates.length > 0) {
      const earliest = Math.min(...issueDates);
      cooperationYears = Math.max(0, (todayMs - earliest) / (365.25 * DAY_MS));
    }

    // 评分：100 起扣
    let score = 100;
    score -= Math.min(overdueCount * 10, 30); // 当前逾期每张 -10，封顶 -30
    if (maxDaysOverdue > CREDIT_FREEZE_DAYS) score -= 20;
    if (maxDaysOverdue > BAD_DEBT_DAYS) score -= 20;
    if (onTimeRate !== null) score -= (1 - onTimeRate) * 40;
    if (cooperationYears < 1) score -= 5;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';

    const factors = {
      onTimeRate,
      overdueCount,
      maxDaysOverdue,
      cooperationYears: Number(cooperationYears.toFixed(2)),
      settledCount: settled.length,
      invoiceCount: invoices.length,
      evaluatedBy: actorId ?? null,
    };

    const ts = now();
    const rating = await db.creditRating.create({
      data: {
        id: generateId('CDR'),
        relationId,
        grade,
        score,
        factors,
        evaluatedAt: BigInt(ts),
        evaluatedBy: actorId ?? null,
        createdAt: BigInt(ts),
      },
    });
    logger.info('[RiskService] credit rating evaluated', { id: rating.id, relationId, grade, score, actorId: actorId ?? 'system' });
    return rating;
  }

  async function listCreditRatings(query: { relationId?: string; latestOnly?: boolean; limit?: number }) {
    const where: any = {};
    if (query.relationId) where.relationId = query.relationId;
    // ★ latestOnly：去重放到 **DB 侧**（Prisma `distinct`），`take` 的语义随之变成「客户数」。
    //   旧实现「先 take 200 行、再在内存按 relationId 去重」→ 某客户的**最新**评级若落在
    //   200 行窗口之外，该客户会**整条缺失**（静默漏数据），且 total 只是窗口内的数。
    //   已用真库实测：Prisma 的 `distinct` 在 **orderBy 之后、take 之前** 生效
    //   （`distinct:['relationId'] + take:3` 返回 3 个不同客户），故每客户保留的正是最新一条。
    const rows = await db.creditRating.findMany({
      where,
      orderBy: { evaluatedAt: 'desc' },
      take: Math.min(query.limit || 200, 500),
      ...(query.latestOnly ? { distinct: ['relationId' as const] } : {}),
    });
    return { items: rows, total: rows.length };
  }

  /**
   * 信用风险扫描（watchdog 与手动触发共用）：
   *   - 客户最大逾期 > 60 天 → 冻结其 Active 信用额度 + credit_frozen 预警（按日去重）
   *   - 单张发票逾期 > 180 天 → bad_debt 预警（dedupKey 保证只报一次）
   *
   * M1（2026-08-28）：冻结动作改走信用模块正规冻结通道 creditService.runAutoFreezeScan ——
   *   Active→Frozen 同事务写 frozenBy=system_credit_scan + CreditLimitHistory + AuditLog
   *   （审计理由：「60 天逾期规则自动冻结…」），与信用模块自动解冻（仅认 system_credit_scan
   *   冻结的额度）形成闭环；信用例外白名单由 creditExceptionGate 在下单门禁消费点生效
   *   （DR-013，冻结事实不受例外影响）。本函数只保留风险预警职责（credit_frozen / bad_debt）。
   */
  async function runCreditRiskScan(today: Date = businessNowDate()): Promise<{ frozenCount: number; badDebtCount: number }> {
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const todayKey = formatDate(todayMs);

    const invoices = await db.invoice.findMany({
      where: openReceivableWhere(), // ★ 含 amount>0 守卫：0 元/负额票不报坏账
    });

    // 坏账扫描：风险模块自有职责（credit 正规通道不含 bad_debt 预警）
    const badDebtInvoices: any[] = [];
    for (const inv of invoices) {
      if (!hasOpenAmount(inv.amount)) continue; // 兜底：mock / 内存行也要挡住
      const dueMs = effectiveDueMs(inv.dueDate, inv.issueDate);
      if (dueMs === null) continue;
      const days = Math.floor((todayMs - dueMs) / DAY_MS);
      if (days > BAD_DEBT_DAYS) badDebtInvoices.push({ inv, days });
    }

    // 正规冻结通道：幂等（仅 Active→Frozen，已 Frozen 不重复写历史）
    const creditService = createCreditService({ prisma });
    const freeze = await creditService.runAutoFreezeScan({ today });

    for (const f of freeze.frozen) {
      const cl = await db.creditLimit.findUnique({ where: { id: f.creditLimitId } });
      const limitDesc = cl ? `（总额 ${cl.totalLimit} ${cl.currency}）` : '';
      await raiseAlert({
        type: 'credit_frozen',
        level: 'critical',
        title: `客户信用额度已冻结（逾期 ${f.maxOverdueDays} 天）`,
        content: `客户 ${f.relationId} 应收发票最大逾期 ${f.maxOverdueDays} 天，超过 ${CREDIT_FREEZE_DAYS} 天阈值，信用额度 ${f.creditLimitId}${limitDesc} 已经信用模块正规通道自动冻结（审计留痕；解冻路径：逾期款全额核销后自动解冻 / 主管手动解冻）。`,
        relatedType: 'CreditLimit',
        relatedId: f.creditLimitId,
        dedupKey: `credit_frozen:${f.creditLimitId}:${todayKey}`,
      });
    }
    const frozenCount = freeze.frozenCount;

    let badDebtCount = 0;
    for (const { inv, days } of badDebtInvoices) {
      const { created } = await raiseAlert({
        type: 'bad_debt',
        level: 'critical',
        title: `发票 ${inv.invoiceNumber} 逾期 ${days} 天，疑似坏账`,
        content: `应收发票 ${inv.invoiceNumber}（金额 ${inv.amount} ${inv.currency}）已逾期 ${days} 天，超过 ${BAD_DEBT_DAYS} 天阈值，请评估坏账计提及法律追讨。`,
        relatedType: 'Invoice',
        relatedId: inv.id,
        dedupKey: `bad_debt:${inv.id}`,
      });
      if (created) badDebtCount += 1;
    }

    if (frozenCount > 0 || badDebtCount > 0) {
      logger.info('[RiskService] credit risk scan', { frozenCount, badDebtCount });
    }
    return { frozenCount, badDebtCount };
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 合规（PRD 15.3）
  // ══════════════════════════════════════════════════════════════

  /**
   * 读取生效禁运国清单：SystemConfig 配置优先，未配置/读取异常回退内置默认清单。
   * 配置值为字符串数组（ISO 两位码或国名），trim + 去空 + 去重（大小写不敏感）。
   */
  async function getSanctionedCountries(): Promise<{ items: string[]; source: 'config' | 'default' }> {
    try {
      const cfg = createSystemConfigService(prisma);
      const found = await cfg.get(SANCTIONED_COUNTRIES_CONFIG_KEY);
      if (found && Array.isArray(found.value)) {
        const seen = new Set<string>();
        const items: string[] = [];
        for (const raw of found.value) {
          const v = String(raw ?? '').trim();
          if (!v) continue;
          const k = v.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          items.push(v);
        }
        if (items.length > 0) return { items, source: 'config' };
      }
    } catch (e: any) {
      logger.warn('[RiskService] 禁运国清单配置读取失败，回退内置默认清单', { error: e?.message });
    }
    return { items: [...DEFAULT_SANCTIONED_COUNTRIES], source: 'default' };
  }

  /**
   * 更新禁运国清单（M7 配置界面写入口）。
   * 校验：非空字符串数组、单条 ≤100 字符、总数 ≤200；大小写不敏感去重（保留首个写法）。
   * 审计：SystemConfigHistory 由 systemConfigService.set 落（version + actorId + reason）。
   */
  async function updateSanctionedCountries(input: { items: unknown; reason?: string | null }, actorId: string) {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw badRequest('禁运国清单必填且必须为非空字符串数组');
    }
    if (input.items.length > SANCTIONED_LIST_MAX_ITEMS) {
      throw badRequest(`禁运国清单条目数必须不超过 ${SANCTIONED_LIST_MAX_ITEMS}`);
    }
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of input.items) {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw badRequest('非法禁运国条目：必须为非空字符串（ISO 两位码或国名）');
      }
      const v = raw.trim();
      if (v.length > SANCTIONED_ITEM_MAX_LEN) {
        throw badRequest(`非法禁运国条目：长度必须不超过 ${SANCTIONED_ITEM_MAX_LEN} 字符`);
      }
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(v);
    }
    const cfg = createSystemConfigService(prisma);
    await cfg.set(SANCTIONED_COUNTRIES_CONFIG_KEY, items, {
      group: 'ops',
      label: '出口管制禁运国清单',
      valueType: 'json',
      description: '出口管制检查命中的禁运国清单（ISO 两位码或国名，大小写不敏感精确匹配）；风险模块合规检查唯一真源',
      actorId,
      reason: input.reason ?? null,
    });
    logger.info('[RiskService] 禁运国清单已更新', { count: items.length, actorId });
    return getSanctionedCountries();
  }

  async function getDeclarationOrThrow(declarationId: string) {
    const decl = await db.customsDeclaration.findUnique({ where: { id: declarationId } });
    if (!decl || decl.deletedAt !== null) throw bizNotFound('报关单不存在');
    return decl;
  }

  async function writeComplianceCheck(data: {
    type: string;
    targetType: string;
    targetId: string;
    result: string;
    summary: string;
    details?: unknown;
    checkedById: string | null;
  }) {
    const ts = now();
    const check = await db.complianceCheck.create({
      data: {
        id: generateId('CPC'),
        type: data.type,
        targetType: data.targetType,
        targetId: data.targetId,
        result: data.result,
        summary: data.summary,
        details: data.details ?? null,
        checkedById: data.checkedById,
        checkedAt: BigInt(ts),
        createdAt: BigInt(ts),
      },
    });
    logger.info('[RiskService] compliance check written', { id: check.id, type: data.type, targetId: data.targetId, result: data.result });
    return check;
  }

  /**
   * HS Code 校验：
   *   - 缺失 hsCode 或格式非法 → fail
   *   - 注册表非空且编码未注册 → warn（未注册不代表非法）
   *   - 全部通过 → pass
   */
  async function runHsCodeCheck(declarationId: string, actorId?: string | null) {
    if (!declarationId?.trim()) throw badRequest('declarationId 必填');
    await getDeclarationOrThrow(declarationId);

    const lines = await db.customsDeclarationLine.findMany({ where: { declarationId } });
    const registrySize = await db.hsCode.count();

    const lineResults: Array<Record<string, unknown>> = [];
    let missingCount = 0;
    let invalidCount = 0;
    let unregisteredCount = 0;

    for (const line of lines) {
      const hs = line.hsCode?.trim();
      if (!hs) {
        missingCount += 1;
        lineResults.push({ lineId: line.id, lineNumber: line.lineNumber, productName: line.productName, hsCode: null, status: 'fail', reason: '缺失 HS 编码' });
        continue;
      }
      if (!HS_PLAIN_RE.test(hs) && !HS_DOTTED_RE.test(hs)) {
        invalidCount += 1;
        lineResults.push({ lineId: line.id, lineNumber: line.lineNumber, productName: line.productName, hsCode: hs, status: 'fail', reason: 'HS 编码格式非法' });
        continue;
      }
      if (registrySize > 0) {
        const registered = await db.hsCode.findUnique({ where: { code: hs } });
        if (!registered) {
          unregisteredCount += 1;
          lineResults.push({ lineId: line.id, lineNumber: line.lineNumber, productName: line.productName, hsCode: hs, status: 'warn', reason: 'HS 编码未在注册表中' });
          continue;
        }
      }
      lineResults.push({ lineId: line.id, lineNumber: line.lineNumber, productName: line.productName, hsCode: hs, status: 'pass' });
    }

    const failCount = missingCount + invalidCount;
    const result = failCount > 0 ? 'fail' : unregisteredCount > 0 ? 'warn' : 'pass';
    const parts: string[] = [];
    if (missingCount > 0) parts.push(`${missingCount} 行缺失 HS 编码`);
    if (invalidCount > 0) parts.push(`${invalidCount} 行 HS 编码格式非法`);
    if (unregisteredCount > 0) parts.push(`${unregisteredCount} 行 HS 编码未注册`);
    const summary = parts.length > 0 ? parts.join('，') : `${lines.length} 行全部通过`;

    const check = await writeComplianceCheck({
      type: 'hs_code',
      targetType: 'CustomsDeclaration',
      targetId: declarationId,
      result,
      summary,
      details: { lines: lineResults },
      checkedById: actorId ?? null,
    });

    if (result === 'fail') {
      await raiseAlert({
        type: 'compliance_fail',
        level: 'warning',
        title: `报关单 HS 编码校验未通过`,
        content: `报关单 ${declarationId} HS 编码校验失败：${summary}，请修正后重新申报。`,
        relatedType: 'CustomsDeclaration',
        relatedId: declarationId,
        dedupKey: `compliance:hs_code:${declarationId}:${todayStr()}`,
      });
    }
    return check;
  }

  /**
   * 出口管制校验：目的国命中禁运清单 → fail + 预警；目的国为空 → warn（无法判定）；否则 pass。
   * 禁运清单为 SystemConfig 数据库配置（M7），未配置时回退内置默认清单。
   */
  async function runExportControlCheck(declarationId: string, actorId?: string | null) {
    if (!declarationId?.trim()) throw badRequest('declarationId 必填');
    const decl = await getDeclarationOrThrow(declarationId);
    const sanctioned = await getSanctionedCountries();

    const dest = decl.destinationCountry?.trim();
    let result: string;
    let summary: string;
    let hit = false;

    if (!dest) {
      result = 'warn';
      summary = '目的国为空，无法判定出口管制风险';
    } else if (matchesSanctionedCountry(dest, sanctioned.items)) {
      result = 'fail';
      hit = true;
      summary = `目的国 ${dest} 命中出口管制禁运清单`;
    } else {
      result = 'pass';
      summary = `目的国 ${dest} 未命中禁运清单`;
    }

    const check = await writeComplianceCheck({
      type: 'export_control',
      targetType: 'CustomsDeclaration',
      targetId: declarationId,
      result,
      summary,
      details: { destinationCountry: dest ?? null, sanctioned: hit, sanctionedList: sanctioned.items, sanctionedSource: sanctioned.source },
      checkedById: actorId ?? null,
    });

    if (result === 'fail') {
      await raiseAlert({
        type: 'compliance_fail',
        level: 'critical',
        title: `报关单命中出口管制禁运国`,
        content: `报关单 ${declarationId} 目的国 ${dest} 命中出口管制禁运清单（${sanctioned.items.join('/')}），出运前必须完成合规审批。`,
        relatedType: 'CustomsDeclaration',
        relatedId: declarationId,
        dedupKey: `compliance:export_control:${declarationId}:${todayStr()}`,
      });
    }
    return check;
  }

  /** 人工录入合规检查（origin_rule 等无自动检查通道的类型） */
  async function addManualComplianceCheck(input: ManualComplianceCheckInput, actorId: string) {
    if (!COMPLIANCE_TYPES.includes(input.type)) {
      throw badRequest(`非法合规检查类型：${input.type}（允许 hs_code | export_control | origin_rule）`);
    }
    if (!COMPLIANCE_RESULTS.includes(input.result)) {
      throw badRequest(`非法检查结果：${input.result}（允许 pass | warn | fail）`);
    }
    if (!input.targetType?.trim()) throw badRequest('targetType 必填');
    if (!input.targetId?.trim()) throw badRequest('targetId 必填');
    if (!input.summary?.trim()) throw badRequest('summary 必填');
    return writeComplianceCheck({
      type: input.type,
      targetType: input.targetType.trim(),
      targetId: input.targetId.trim(),
      result: input.result,
      summary: input.summary.trim(),
      details: input.details,
      checkedById: actorId,
    });
  }

  async function listComplianceChecks(query: { type?: string; result?: string; targetType?: string; targetId?: string; limit?: number; offset?: number }) {
    const where: any = {};
    if (query.type) where.type = query.type;
    if (query.result) where.result = query.result;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    const [items, total] = await Promise.all([
      db.complianceCheck.findMany({ where, orderBy: { checkedAt: 'desc' }, take, skip }),
      db.complianceCheck.count({ where }),
    ]);
    return { items, total };
  }

  // ══════════════════════════════════════════════════════════════
  // 5. 质量（PRD 15.4）
  // ══════════════════════════════════════════════════════════════

  /** 加载 orderId → millRelationId 映射（软删订单视同未关联） */
  async function loadOrderMillMap(orderIds: string[]): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (orderIds.length === 0) return map;
    const orders = await db.order.findMany({ where: { id: { in: orderIds }, deletedAt: null } });
    for (const o of orders) map.set(o.id, o.millRelationId ?? null);
    return map;
  }

  function aggregateDefectGroup(rows: any[]) {
    let failCount = 0;
    let criticalDefects = 0;
    let majorDefects = 0;
    let minorDefects = 0;
    const keywordCounts = new Map<string, number>();
    for (const r of rows) {
      if (r.result === 'fail') failCount += 1;
      criticalDefects += Number(r.criticalDefects ?? 0);
      majorDefects += Number(r.majorDefects ?? 0);
      minorDefects += Number(r.minorDefects ?? 0);
      for (const kw of parseDefectKeywords(r.defectSummary)) {
        keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
      }
    }
    const defectKeywords = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([keyword, count]) => ({ keyword, count }));
    return {
      reports: rows.length,
      failCount,
      criticalDefects,
      majorDefects,
      minorDefects,
      defectKeywords,
    };
  }

  /**
   * 疵点趋势聚合：
   *   - groupBy=factory：按 Order.millRelationId（null 归入「未关联工厂」）
   *   - groupBy=quarter：按 inspectionDate 的 YYYY-Q（inspectionDate 缺失的行跳过）
   * InspectionReport 无 deletedAt 字段，全量扫描。
   */
  async function getDefectTrends(query: { groupBy: 'factory' | 'quarter' }) {
    const reports = await db.inspectionReport.findMany({ take: 2000 });
    const millMap = await loadOrderMillMap([...new Set<string>(reports.map((r: any) => r.orderId as string))]);

    if (query.groupBy === 'factory') {
      const groups = new Map<string, any[]>();
      for (const r of reports) {
        const mill = millMap.get(r.orderId) ?? null;
        const key = mill ?? 'unlinked';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      const items = [...groups.entries()].map(([key, rows]) => ({
        factoryId: key === 'unlinked' ? null : key,
        factoryLabel: key === 'unlinked' ? '未关联工厂' : key,
        ...aggregateDefectGroup(rows),
      }));
      items.sort((a, b) => b.reports - a.reports);
      return { groupBy: 'factory', items };
    }

    // quarter
    const groups = new Map<string, any[]>();
    for (const r of reports) {
      const quarter = quarterOf(r.inspectionDate);
      if (!quarter) continue; // inspectionDate 缺失/非法的行跳过
      if (!groups.has(quarter)) groups.set(quarter, []);
      groups.get(quarter)!.push(r);
    }
    const items = [...groups.entries()]
      .map(([quarter, rows]) => ({ quarter, ...aggregateDefectGroup(rows) }))
      .sort((a, b) => a.quarter.localeCompare(b.quarter));
    return { groupBy: 'quarter', items };
  }

  /**
   * 重复疵点扫描：近 90 天内同工厂同疵点词出现在 ≥2 张报告 → quality_repeat 预警。
   * dedupKey 含当前季度，季度内幂等。
   */
  async function runQualityRepeatScan(today: Date = businessNowDate()): Promise<{ alerted: number }> {
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const sinceStr = formatDate(todayMs - QUALITY_REPEAT_WINDOW_DAYS * DAY_MS);
    const currentQuarter = quarterOf(formatDate(todayMs))!;

    const reports = await db.inspectionReport.findMany({
      where: { inspectionDate: { gte: sinceStr } },
      take: 2000,
    });
    const millMap = await loadOrderMillMap([...new Set<string>(reports.map((r: any) => r.orderId as string))]);

    // (millRelationId, 疵点词) → 报告 id 集合
    const groups = new Map<string, { mill: string | null; keyword: string; reportIds: Set<string> }>();
    for (const r of reports) {
      const mill = millMap.get(r.orderId) ?? null;
      for (const kw of parseDefectKeywords(r.defectSummary)) {
        const key = `${mill ?? 'unlinked'}::${kw}`;
        if (!groups.has(key)) groups.set(key, { mill, keyword: kw, reportIds: new Set() });
        groups.get(key)!.reportIds.add(r.id);
      }
    }

    let alerted = 0;
    for (const g of groups.values()) {
      if (g.reportIds.size < 2) continue;
      const { created } = await raiseAlert({
        type: 'quality_repeat',
        level: 'warning',
        title: `重复疵点预警：${g.keyword}（近 ${QUALITY_REPEAT_WINDOW_DAYS} 天 ${g.reportIds.size} 张报告）`,
        content: `工厂 ${g.mill ?? '未关联工厂'} 近 ${QUALITY_REPEAT_WINDOW_DAYS} 天内「${g.keyword}」疵点出现在 ${g.reportIds.size} 张验货报告中，建议启动工厂质量整改。`,
        relatedType: g.mill ? 'Relation' : undefined,
        relatedId: g.mill ?? undefined,
        dedupKey: `quality_repeat:${g.mill ?? 'unlinked'}:${g.keyword}:${currentQuarter}`,
      });
      if (created) alerted += 1;
    }

    if (alerted > 0) {
      logger.info('[RiskService] quality repeat scan', { alerted });
    }
    return { alerted };
  }

  return {
    // 预警
    raiseAlert,
    listAlerts,
    updateAlertStatus,
    getRiskOverview,
    // 汇率
    addExchangeRate,
    listExchangeRates,
    getLatestRates,
    lockFxRate,
    listFxLocks,
    deleteFxLock,
    // 信用
    evaluateCreditRating,
    listCreditRatings,
    runCreditRiskScan,
    // 合规
    runHsCodeCheck,
    runExportControlCheck,
    addManualComplianceCheck,
    listComplianceChecks,
    getSanctionedCountries,
    updateSanctionedCountries,
    // 质量
    getDefectTrends,
    runQualityRepeatScan,
  };
}

export type RiskService = ReturnType<typeof createRiskService>;
