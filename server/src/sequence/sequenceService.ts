/**
 * sequenceService.ts — Phase 0-03 统一编号发号器（11 类单据独立序列，作废不复用）
 *
 * 权威真源：SequenceRegister 模型（按 seqType+periodKey 行锁原子递增）+ VoidedNumber 作废占坑
 *
 * 对比旧 shared/businessNumberService.ts (21 种 QT/ORD/PO... BusinessPrefix):
 *   - 旧服务保留（向后兼容，已接 10+ 业务调用点，且已有完整单元测试）
 *   - 新服务增强：支持年/月/永不重置 3 种周期；formatTemplate 模板化渲染；显式作废追踪；11 类 seqType 强类型
 *   - 以后 Phase 1/2 新业务路由优先用此服务；老代码可逐步迁移
 *
 * 11 类业务序列 (SequenceType) 及默认规则：
 *   单据类（按年或按月重置）
 *     order      销售订单          prefix=SO   | 按月 | 格式 SO-YYYYMM-NNN
 *     pi         形式发票 PI       prefix=PI   | 按年 | 格式 PI-YYYY-NNNN
 *     quotation  报价单            prefix=QT   | 按年 | 格式 QT-YYYY-NNNN      (兼容旧 QT prefix)
 *     purchase   采购订单(PO)      prefix=PO   | 按年 | 格式 PO-YYYY-NNNN      (兼容旧 PO)
 *     invoice    业务发票          prefix=INV  | 按年 | 格式 INV-YYYY-NNNN     (兼容旧 INV)
 *     voucher    付款凭证 PAY      prefix=PAY  | 按年 | 格式 PAY-YYYY-NNNN     (旧 PV 改为 PAY，语义更直白)
 *     shipment   发货单            prefix=SHP  | 按月 | 格式 SHP-YYYYMM-NNN
 *     customs    报关单            prefix=CD   | 按月 | 格式 CD-YYYYMM-NNN
 *   主数据类（永不重置，全局累加）
 *     customer   客户编码          prefix=CUS  | 永久 | 格式 CUS-NNNNN (5位)
 *     supplier   供应商编码        prefix=SUP  | 永久 | 格式 SUP-NNNNN (5位)
 *     material   物料编码(兜底用)  prefix=MAT  | 永久 | 格式 MAT-NNNNN (5位，SKU缺失时自动生成)
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { businessNowDate } from '../shared/businessClock';


// ───────────────────────────────────────────────────────────────────
// 强类型：11 类 SequenceType + 配置常量（真源，不允许业务代码硬编码前缀/格式）
// ───────────────────────────────────────────────────────────────────
export type SequenceType =
  | 'order' | 'pi' | 'quotation' | 'purchase' | 'invoice'
  | 'voucher' | 'shipment' | 'customs'
  | 'customer' | 'supplier' | 'material' | 'marketing'
  // ★ 2026-09-19 新增：付款申请（PAYR-YYYYMMDD-NNN，按**日**重置 3 位流水）
  //   动因：原实现用 `count+1` 先读后写取号，真库 5 路并发实测**必然撞号**
  //   （有界重试治标不治本：重试者又读到同一 count ⇒ 3 次重试耗尽仍失败）。
  //   改为走本发号真源（SequenceRegister 行 + 数据库级原子 increment）后并发无冲突。
  | 'paymentRequest'
  // ★ 2026-09-28 B274（评审 I-19）：异常处置单 / 改单申请单
  //   原实现同样是 `count+1` 先读后写（与 PAYR 修复前同形，且取号发生在创建事务之外），
  //   现收进本真源；**号的面格式一个字符都没变**。
  | 'exceptionRequest'
  | 'orderChangeRequest';

export type SequencePeriod = 'year' | 'month' | 'day' | 'none';

export interface SequenceTypeConfig {
  seqType: SequenceType;
  prefix: string;
  period: SequencePeriod;
  /** 默认补零位数：3 或 4 或 5，按业务规则 */
  defaultPadding: number;
  /** 格式模板：支持变量 {prefix} {year} {month} {day} {seq} / {seq:04} / {seq:pad=3} */
  defaultFormatTemplate: string;
  /** 与旧 BusinessPrefix 的映射（便于迁移时交叉引用） */
  legacyBusinessPrefix?: string;
  description: string;
}

export const SEQUENCE_TYPE_CONFIGS: Record<SequenceType, SequenceTypeConfig> = {
  order:    { seqType: 'order',    prefix: 'SO',  period: 'month', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}-{seq:03}',
              legacyBusinessPrefix: 'ORD',
              description: '销售订单 Sales Order，按月重置 3 位流水' },
  pi:       { seqType: 'pi',       prefix: 'PI',  period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              description: '形式发票 Proforma Invoice，按年重置 4 位流水' },
  quotation:{ seqType: 'quotation',prefix: 'QT',  period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              legacyBusinessPrefix: 'QT',
              description: '报价单 Quotation，按年重置 4 位流水' },
  purchase: { seqType: 'purchase', prefix: 'PO',  period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              legacyBusinessPrefix: 'PO',
              description: '采购订单 PurchaseOrder，按年重置 4 位流水' },
  invoice:  { seqType: 'invoice',  prefix: 'INV', period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              legacyBusinessPrefix: 'INV',
              description: '业务发票 Invoice，按年重置 4 位流水' },
  voucher:  { seqType: 'voucher',  prefix: 'PAY', period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              legacyBusinessPrefix: 'PV',
              description: '付款凭证 PaymentVoucher，按年重置 4 位流水' },
  shipment: { seqType: 'shipment', prefix: 'SHP', period: 'month', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}-{seq:03}',
              legacyBusinessPrefix: 'SH',
              description: '发货单 Shipment，按月重置 3 位流水' },
  customs:  { seqType: 'customs',  prefix: 'CD',  period: 'month', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}-{seq:03}',
              legacyBusinessPrefix: 'CD',
              description: '报关单 CustomsDeclaration，按月重置 3 位流水' },
  customer: { seqType: 'customer', prefix: 'CUS', period: 'none',  defaultPadding: 5,
              defaultFormatTemplate: '{prefix}-{seq:05}',
              description: '客户编码 Relation.code（客户类），永不重置 5 位流水' },
  supplier: { seqType: 'supplier', prefix: 'SUP', period: 'none',  defaultPadding: 5,
              defaultFormatTemplate: '{prefix}-{seq:05}',
              description: '供应商编码 Relation.code（供应商类），永不重置 5 位流水' },
  material: { seqType: 'material', prefix: 'MAT', period: 'none',  defaultPadding: 5,
              defaultFormatTemplate: '{prefix}-{seq:05}',
              description: '物料编码兜底（SKU/款式号未手工编码时使用），永不重置 5 位流水' },
  marketing:{ seqType: 'marketing', prefix: 'MKT', period: 'year',  defaultPadding: 4,
              defaultFormatTemplate: '{prefix}-{year}-{seq:04}',
              description: '营销活动编号 MarketingCampaign.code，按年重置 4 位流水' },
  // ★ 按**日**重置、3 位流水 —— 与 schema 注释钉死的 `PAYR-YYYYMMDD-001` 逐字符一致
  //   （迁移前用户看到的号必须不变，故 padding=3、日期段连写无分隔符）
  paymentRequest: { seqType: 'paymentRequest', prefix: 'PAYR', period: 'day', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}{day}-{seq:03}',
              description: '付款申请 PaymentRequest，按日重置 3 位流水' },
  exceptionRequest: { seqType: 'exceptionRequest', prefix: 'EXC', period: 'day', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}{day}-{seq:03}',
              description: '例外审批（DR-013）ExceptionRequest，按日重置 3 位流水' },
  orderChangeRequest: { seqType: 'orderChangeRequest', prefix: 'OCR', period: 'day', defaultPadding: 3,
              defaultFormatTemplate: '{prefix}-{year}{month}{day}-{seq:03}',
              description: '订单变更申请 OrderChangeRequest，按日重置 3 位流水' },
};

export const ALL_SEQUENCE_TYPES: SequenceType[] = Object.keys(SEQUENCE_TYPE_CONFIGS) as SequenceType[];
export function isSequenceType(v: unknown): v is SequenceType {
  return typeof v === 'string' && (ALL_SEQUENCE_TYPES as string[]).includes(v);
}

// ───────────────────────────────────────────────────────────────────
// 周期键计算：year → 2026, month → 2026-08, day → 2026-08-15, none → __global__
// ───────────────────────────────────────────────────────────────────
export function periodKeyForDate(period: SequencePeriod, date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  switch (period) {
    case 'year':  return String(y);
    case 'month': return `${y}-${m}`;
    case 'day':   return `${y}-${m}-${d}`;
    case 'none':
    default:      return '__global__';
  }
}

// ───────────────────────────────────────────────────────────────────
// 格式模板渲染：支持
//   {prefix}       → 前缀（SO/QT/PO...）
//   {year}         → 4 位年
//   {month}        → 2 位月
//   {day}          → 2 位日
//   {seq}          → 纯序号（不补零）
//   {seq:03}       → 补零到 3 位
//   {seq:pad=4}    → 补零到 4 位
// ───────────────────────────────────────────────────────────────────
export interface FormatContext {
  prefix: string;
  seq: number;
  /** 可选，periodKey 解析后若有具体日期则传入；缺失则按当前系统日期推断 */
  date?: Date;
  /** 可选，覆盖默认 padding；若模板里有 :03/:pad=4 则优先模板 */
  defaultPadding?: number;
}

export function renderFormatTemplate(template: string, ctx: FormatContext): string {
  const dt = ctx.date || businessNowDate();
  const defaultPad = ctx.defaultPadding || 4;
  return template
    .replace(/\{prefix\}/g, ctx.prefix)
    .replace(/\{year\}/g, String(dt.getFullYear()))
    .replace(/\{month\}/g, String(dt.getMonth() + 1).padStart(2, '0'))
    .replace(/\{day\}/g, String(dt.getDate()).padStart(2, '0'))
    .replace(/\{seq:pad=(\d+)\}/g, (_m, pad) => String(ctx.seq).padStart(parseInt(pad, 10) || defaultPad, '0'))
    .replace(/\{seq:(\d+)\}/g, (_m, pad) => String(ctx.seq).padStart(parseInt(pad, 10) || defaultPad, '0'))
    .replace(/\{seq\}/g, String(ctx.seq).padStart(defaultPad, '0'));
}

// ───────────────────────────────────────────────────────────────────
// DbLike 宽松接口（Prisma 或 事务句柄）
// ───────────────────────────────────────────────────────────────────
interface DbLike {
  sequenceRegister?: {
    upsert(args: any): Promise<any>;
    update(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    findFirst(args?: any): Promise<any>;
    findMany(args?: any): Promise<any>;
  };
  voidedNumber?: {
    upsert(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    findFirst(args?: any): Promise<any>;
    findMany(args?: any): Promise<any>;
  };
}

// ───────────────────────────────────────────────────────────────────
// 服务工厂（依赖注入 Prisma）
// ───────────────────────────────────────────────────────────────────
export interface NextNumberOptions {
  /** 使用此日期计算周期键；缺省为今天 */
  date?: Date;
  /** 覆盖 DB 中 formatTemplate（罕见，一般用 DB 默认即可） */
  overrideFormatTemplate?: string;
  /** 覆盖 DB 中 startSeq（仅在 upsert 创建新行时生效） */
  overrideStartSeq?: number;
  /** 覆盖补零位数 */
  overridePadding?: number;
  /** 业务表占用校验（查目标业务表含软删行；返回 true=已占用需继续递增）。由调用方提供表映射。 */
  occupied?: (number: string) => Promise<boolean>;
}

export interface PeekNextNumberOptions {
  date?: Date;
}

export interface MarkVoidedOptions {
  seqType: SequenceType;
  number: string;
  reason?: string;
  voidedBy?: string;
  sourceDocId?: string;
  sourceDocType?: string;
  periodKey?: string;
  metadata?: Record<string, any>;
}

export interface ListVoidedFilter {
  seqType?: SequenceType;
  periodKey?: string;
  sourceDocType?: string;
  sourceDocId?: string;
  voidedBy?: string;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
  limit?: number;
  offset?: number;
}

export function createSequenceService(prisma: PrismaClient) {
  // ================================================
  // 0. 内部：确保 SequenceRegister 行存在 + 原子递增 + 格式化
  // ================================================
  function getConfig(seqType: SequenceType): SequenceTypeConfig {
    const cfg = SEQUENCE_TYPE_CONFIGS[seqType];
    if (!cfg) throw new Error(`未知 seqType: ${seqType}`);
    return cfg;
  }

  async function upsertRowIfNeeded(
    db: DbLike,
    seqType: SequenceType,
    periodKey: string,
    opts?: NextNumberOptions,
  ): Promise<void> {
    if (!db.sequenceRegister) return; // fallback 模式，不依赖 DB
    const cfg = getConfig(seqType);
    const id = `SEQREG_${seqType}_${periodKey}`;
    await db.sequenceRegister.upsert({
      where: { id },
      create: {
        id,
        seqType,
        period: cfg.period,
        periodKey,
        prefix: cfg.prefix,
        formatTemplate: opts?.overrideFormatTemplate || cfg.defaultFormatTemplate,
        padding: opts?.overridePadding ?? cfg.defaultPadding,
        startSeq: opts?.overrideStartSeq ?? 1,
        currentSeq: 0,
        updatedAt: BigInt(Date.now()),
        description: cfg.description,
      },
      update: {},
    });
  }

  // ================================================
  // 1. nextNumber：分配下一个编号（必须在事务内调用，原子+行锁）
  // ================================================
  async function nextNumber(
    db: DbLike,
    seqType: SequenceType,
    opts?: NextNumberOptions,
  ): Promise<string> {
    const cfg = getConfig(seqType);
    const date = opts?.date || businessNowDate();
    const periodKey = periodKeyForDate(cfg.period, date);
    const id = `SEQREG_${seqType}_${periodKey}`;

    // Fallback：无 sequenceRegister 模型（如 mock/测试） → 时间戳+随机
    if (!db.sequenceRegister) {
      const padding = opts?.overridePadding ?? cfg.defaultPadding;
      const nextSeqFallback = Math.floor(Math.random() * 900000) + 100000;
      const fmt = opts?.overrideFormatTemplate || cfg.defaultFormatTemplate;
      return renderFormatTemplate(fmt, { prefix: cfg.prefix, seq: nextSeqFallback, date, defaultPadding: padding });
    }

    // 1a. upsert 确保行存在（并发安全：PG 唯一约束 + upsert 语义）
    await upsertRowIfNeeded(db, seqType, periodKey, opts);

    // 1b. 原子 increment currentSeq
    const updated = await db.sequenceRegister.update({
      where: { id },
      data: {
        currentSeq: { increment: 1 },
        updatedAt: BigInt(Date.now()),
      },
      select: { currentSeq: true, formatTemplate: true, padding: true, prefix: true },
    });

    const padding = opts?.overridePadding ?? updated.padding ?? cfg.defaultPadding;
    const template = opts?.overrideFormatTemplate || updated.formatTemplate || cfg.defaultFormatTemplate;

    // 1c. 生成最终编号
    const number = renderFormatTemplate(template, {
      prefix: (updated.prefix || cfg.prefix) as string,
      seq: updated.currentSeq as number,
      date,
      defaultPadding: padding,
    });

    // 1d. 极端安全网：若本号已在 VoidedNumber，则再次 +1（理论上单调递增不会撞 VOID，因为 VOID 号均为已分配的历史号，
    //      但极端场景如手工回填未来号时可确保安全）
    const alreadyVoided = db.voidedNumber
      ? await db.voidedNumber.findUnique({ where: { seqType_number: { seqType, number } }, select: { id: true } })
      : null;
    if (alreadyVoided) {
      logger.warn('[Sequence] nextNumber collided with voided, retrying once', { seqType, number, periodKey });
      return nextNumber(db, seqType, opts);
    }

    // 1e. 业务表唯一约束自愈：若调用方提供 occupied 回调且返回 true，则递归重试（与 nextBusinessNumber 同口径）
    if (opts?.occupied) {
      let isOccupied = false;
      try {
        isOccupied = await opts.occupied(number);
      } catch (e: any) {
        throw new Error(`SEQUENCE_OCCUPIED_CHECK_FAILED: seqType=${seqType} number=${number} error=${e?.message ?? e}`);
      }
      if (isOccupied) {
        logger.warn('[Sequence] nextNumber collided with business table, retrying', { seqType, number, periodKey });
        return nextNumber(db, seqType, opts);
      }
    }

    if (typeof logger.debug === 'function') {
      logger.debug('[Sequence] nextNumber generated', { seqType, number, periodKey, seq: updated.currentSeq });
    }
    return number;
  }

  // ================================================
  // 2. peekNextNumber：预览下一编号（不消费，不加锁，非事务）
  // ================================================
  async function peekNextNumber(
    db: DbLike,
    seqType: SequenceType,
    opts?: PeekNextNumberOptions,
  ): Promise<string> {
    const cfg = getConfig(seqType);
    const date = opts?.date || businessNowDate();
    const periodKey = periodKeyForDate(cfg.period, date);
    if (!db.sequenceRegister) {
      return renderFormatTemplate(cfg.defaultFormatTemplate, {
        prefix: cfg.prefix, seq: 1, date, defaultPadding: cfg.defaultPadding,
      });
    }
    const row = await db.sequenceRegister.findUnique({
      where: { id: `SEQREG_${seqType}_${periodKey}` },
      select: { currentSeq: true, formatTemplate: true, padding: true, prefix: true },
    });
    const nextSeq = (row?.currentSeq ?? 0) + 1;
    const padding = row?.padding ?? cfg.defaultPadding;
    const template = row?.formatTemplate || cfg.defaultFormatTemplate;
    return renderFormatTemplate(template, {
      prefix: (row?.prefix || cfg.prefix) as string,
      seq: nextSeq,
      date,
      defaultPadding: padding,
    });
  }

  // ================================================
  // 3. 当前序列状态（供 OPS Panel / 管理员查询）
  // ================================================
  async function getSequenceStatus(
    db: DbLike,
    seqType: SequenceType,
    opts?: PeekNextNumberOptions,
  ): Promise<{
    seqType: SequenceType;
    period: SequencePeriod;
    periodKey: string;
    prefix: string;
    formatTemplate: string;
    padding: number;
    currentSeq: number;
    nextSeqPreview: string;
    description?: string | null;
  }> {
    const cfg = getConfig(seqType);
    const date = opts?.date || businessNowDate();
    const periodKey = periodKeyForDate(cfg.period, date);
    let row: any = null;
    if (db.sequenceRegister) {
      row = await db.sequenceRegister.findUnique({
        where: { id: `SEQREG_${seqType}_${periodKey}` },
        select: { currentSeq: true, formatTemplate: true, padding: true, prefix: true, description: true, period: true },
      });
    }
    const nextSeqPreview = await peekNextNumber(db, seqType, opts);
    return {
      seqType,
      period: (row?.period || cfg.period) as SequencePeriod,
      periodKey,
      prefix: row?.prefix || cfg.prefix,
      formatTemplate: row?.formatTemplate || cfg.defaultFormatTemplate,
      padding: row?.padding ?? cfg.defaultPadding,
      currentSeq: row?.currentSeq ?? 0,
      nextSeqPreview,
      description: row?.description ?? cfg.description,
    };
  }

  async function listSequenceStatuses(db: DbLike): Promise<Array<{
    seqType: SequenceType;
    description: string;
    period: SequencePeriod;
    prefix: string;
    latestStatus: Awaited<ReturnType<typeof getSequenceStatus>>;
  }>> {
    const result = [] as any[];
    for (const st of ALL_SEQUENCE_TYPES) {
      const cfg = SEQUENCE_TYPE_CONFIGS[st];
      const latest = await getSequenceStatus(db, st);
      result.push({
        seqType: st,
        description: cfg.description,
        period: cfg.period,
        prefix: cfg.prefix,
        latestStatus: latest,
      });
    }
    return result;
  }

  // ================================================
  // 4. 作废追踪：markVoided / isVoided / listVoided
  // ================================================
  async function markVoided(db: DbLike, opts: MarkVoidedOptions): Promise<{ id: string; number: string; seqType: SequenceType }> {
    if (!isSequenceType(opts.seqType)) throw new Error(`未知 seqType: ${opts.seqType}`);
    if (!opts.number?.trim()) throw new Error('作废编号不能为空');
    const id = `VOID_${opts.seqType}_${opts.number}`;
    const cfg = getConfig(opts.seqType);
    if (!db.voidedNumber) {
      logger.warn('[Sequence] markVoided called without voidedNumber model; ignored', opts as any);
      return { id, number: opts.number, seqType: opts.seqType };
    }
    const row = await db.voidedNumber.upsert({
      where: { id },
      create: {
        id,
        seqType: opts.seqType,
        number: opts.number,
        periodKey: opts.periodKey ?? null,
        reason: opts.reason ?? null,
        voidedBy: opts.voidedBy ?? null,
        sourceDocId: opts.sourceDocId ?? null,
        sourceDocType: opts.sourceDocType ?? null,
        metadata: opts.metadata ?? {},
      },
      update: {
        reason: opts.reason !== undefined ? opts.reason : undefined,
        voidedBy: opts.voidedBy ?? undefined,
        sourceDocId: opts.sourceDocId ?? undefined,
        sourceDocType: opts.sourceDocType ?? undefined,
        metadata: opts.metadata ?? undefined,
      },
    });
    logger.info('[Sequence] markVoided', { seqType: opts.seqType, number: opts.number, by: opts.voidedBy ?? 'system' });
    return { id: row.id as string, number: row.number as string, seqType: opts.seqType };
  }

  async function isVoided(db: DbLike, seqType: SequenceType, number: string): Promise<boolean> {
    if (!db.voidedNumber) return false;
    const hit = await db.voidedNumber.findUnique({
      where: { seqType_number: { seqType, number } },
      select: { id: true },
    });
    return !!hit;
  }

  async function listVoided(db: DbLike, filter: ListVoidedFilter = {}): Promise<{
    total: number;
    items: Array<{ id: string; seqType: string; number: string; periodKey: string | null; reason: string | null; voidedAt: Date; voidedBy: string | null; sourceDocType: string | null; sourceDocId: string | null }>;
  }> {
    if (!db.voidedNumber) return { total: 0, items: [] };
    const where: any = {};
    if (filter.seqType) where.seqType = filter.seqType;
    if (filter.periodKey) where.periodKey = filter.periodKey;
    if (filter.sourceDocType) where.sourceDocType = filter.sourceDocType;
    if (filter.sourceDocId) where.sourceDocId = filter.sourceDocId;
    if (filter.voidedBy) where.voidedBy = filter.voidedBy;
    if (filter.fromDate || filter.toDate) {
      where.voidedAt = {} as any;
      if (filter.fromDate) where.voidedAt.gte = new Date(`${filter.fromDate}T00:00:00Z`);
      if (filter.toDate) where.voidedAt.lte = new Date(`${filter.toDate}T23:59:59Z`);
    }
    // 两次 findMany：一次拿总数（不带 take/skip），一次拿当前页
    const [allItems, items] = await Promise.all([
      db.voidedNumber.findMany({ where } as any),
      db.voidedNumber.findMany({
        where,
        orderBy: { voidedAt: 'desc' } as any,
        take: filter.limit ?? 50,
        skip: filter.offset ?? 0,
      } as any),
    ]);
    return { total: (allItems || []).length, items: items || [] };
  }

  return {
    // 常量 & 配置
    SEQUENCE_TYPE_CONFIGS,
    ALL_SEQUENCE_TYPES,
    isSequenceType,
    periodKeyForDate,
    renderFormatTemplate,

    // 核心取号
    nextNumber,
    peekNextNumber,

    // 状态查询
    getSequenceStatus,
    listSequenceStatuses,

    // 作废追踪
    markVoided,
    isVoided,
    listVoided,
  };
}
