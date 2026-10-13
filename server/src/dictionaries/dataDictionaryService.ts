/**
 * dataDictionaryService.ts — Phase 0-07 统一数据字典真源服务
 *
 * 21 类系统字典枚举（SEED_ 常量在 seed-datadict.ts 里定义，与 TS 类型保持对齐）：
 *   01 bom_material_type        BOM 物料类型
 *   02 bom_cost_type            成本分类
 *   03 bom_status               BOM 状态
 *   04 order_status             订单状态
 *   05 order_type               订单类型（面料/成衣/家纺/其他…）
 *   06 payment_terms            付款条款（T/T, L/C, OA30…）
 *   07 incoterms                贸易术语（FOB/CIF/EXW…）
 *   08 currency                 币种
 *   09 tax_code                 税码（VAT 13% / 9% / 6% / 免税 / 0%）
 *   10 relation_type            实体类型（Customer / Supplier / Agent / Bank…）
 *   11 relation_stage           客户阶段（Lead / Opportunity / Customer / Churned…）
 *   12 relation_tier            客户等级（A / B / C / D / 战略）
 *   13 product_category         产品大类（面料 / 成衣 / 家纺 / 辅料…）
 *   14 department_category      部门类别（业务 / 生产 / 财务 / 技术 / 管理…）
 *   15 employee_level           职级（P1-P8 / M1-M5 / Owner）
 *   16 leave_type               请假类型（年假 / 事假 / 病假 / 调休 / 产假 / 婚假…）
 *   17 approval_status          审批状态（Draft / Pending / Approved / Rejected / Withdrawn）
 *   18 shipment_status          发货状态
 *   19 invoice_status           发票状态（草稿 / 已开 / 红冲 / 已收…）
 *   20 customs_decl_status      报关状态
 *   21 vat_invoice_type         增值税发票类型（专票 / 普票 / 电子专票 / 电子普票…）
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────────
// 通用 Entry 类型（服务输出）
// ────────────────────────────────────────────────────────────────────
export interface DictEntry {
  key: string;
  label: string;
  value?: unknown;
  order: number;
  color?: string;
  tags?: string[];
  disabled?: boolean;
  description?: string;
  [k: string]: unknown;
}

export interface DictSnapshot {
  id: string;
  code: string;
  name: string;
  category: string;
  scope: string;
  isSystem: boolean;
  version: number;
  entries: DictEntry[];
  labels?: Record<string, unknown> | null;
  description?: string | null;
  updatedAt: bigint | number;
}

export type DictCategory =
  | 'bom' | 'order' | 'finance' | 'crm' | 'product'
  | 'hr' | 'logistics' | 'customs' | 'system' | 'custom';

// 21 类系统字典 code 常量（避免魔法字符串）
export const DICT_CODES = Object.freeze({
  BOM_MATERIAL_TYPE: 'bom_material_type',
  BOM_COST_TYPE: 'bom_cost_type',
  BOM_STATUS: 'bom_status',
  ORDER_STATUS: 'order_status',
  ORDER_TYPE: 'order_type',
  PAYMENT_TERMS: 'payment_terms',
  INCOTERMS: 'incoterms',
  CURRENCY: 'currency',
  TAX_CODE: 'tax_code',
  RELATION_TYPE: 'relation_type',
  RELATION_STAGE: 'relation_stage',
  RELATION_TIER: 'relation_tier',
  PRODUCT_CATEGORY: 'product_category',
  DEPARTMENT_CATEGORY: 'department_category',
  EMPLOYEE_LEVEL: 'employee_level',
  LEAVE_TYPE: 'leave_type',
  APPROVAL_STATUS: 'approval_status',
  SHIPMENT_STATUS: 'shipment_status',
  INVOICE_STATUS: 'invoice_status',
  CUSTOMS_DECL_STATUS: 'customs_decl_status',
  VAT_INVOICE_TYPE: 'vat_invoice_type',
} as const);
export type DictCode = (typeof DICT_CODES)[keyof typeof DICT_CODES] | (string & {});

// 全部系统字典 code 列表（seed 与服务可用）
export const ALL_SYSTEM_DICT_CODES: DictCode[] = Object.values(DICT_CODES) as DictCode[];

// ────────────────────────────────────────────────────────────────────
// 内部：DbLike + 类型转换
// ────────────────────────────────────────────────────────────────────
interface DbLike {
  dataDictionary?: {
    upsert(args: any): Promise<any>;
    findUnique(args: any): Promise<any>;
    findMany(args?: any): Promise<any[]>;
    update(args: any): Promise<any>;
  };
  dataDictionaryHistory?: {
    create(args: any): Promise<any>;
    findMany?(args?: any): Promise<any[]>;
  };
}

function toEntries(raw: unknown): DictEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      key: String(e?.key ?? ''),
      label: String(e?.label ?? e?.key ?? ''),
      value: e?.value ?? undefined,
      order: Number(e?.order ?? 0),
      color: typeof e?.color === 'string' ? e.color : undefined,
      tags: Array.isArray(e?.tags) ? e.tags : undefined,
      disabled: !!e?.disabled,
      description: typeof e?.description === 'string' ? e.description : undefined,
      ...(typeof e === 'object' && e ? (e as object) : {}),
    }))
    .sort((a, b) => a.order - b.order)
    .filter((e) => e.key && e.label);
}

interface CacheNode {
  snapshot: DictSnapshot;
  expiresAt: number; // epoch ms
}
const DEFAULT_CACHE_TTL_MS = 60_000; // 60 秒 TTL（修改后调用 refreshCache 立即失效）

// ────────────────────────────────────────────────────────────────────
// createDataDictionaryService 工厂
// ────────────────────────────────────────────────────────────────────
export interface UpsertDictInput {
  code: string;
  name: string;
  category: DictCategory | (string & {});
  scope?: string;
  isSystem?: boolean;
  entries: DictEntry[];
  labels?: Record<string, unknown> | null;
  description?: string | null;
  /** 变更人，写入 DataDictionaryHistory */
  actorId?: string | null;
  /** 变更原因，写入 DataDictionaryHistory */
  reason?: string;
}

export interface QueryDictFilter {
  category?: string;
  scope?: string;
  isSystem?: boolean;
  /** true 时只返回 entries 中 enabled 项（剔除 disabled）*/
  enabledOnly?: boolean;
}

export function createDataDictionaryService(prisma: PrismaClient) {
  const cache = new Map<string, CacheNode>();

  function pickDb(db?: DbLike) {
    return (db?.dataDictionary ? db : prisma) as any;
  }
  function pickDbHistory(db?: DbLike) {
    return (db?.dataDictionaryHistory ? db : prisma) as any;
  }

  function snapshotFromRow(row: any): DictSnapshot {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      scope: row.scope,
      isSystem: !!row.isSystem,
      version: Number(row.version || 1),
      entries: toEntries(row.entries),
      labels: (row.labels as any) ?? null,
      description: row.description ?? null,
      updatedAt: row.updatedAt ?? BigInt(0),
    };
  }

  async function getByCode(
    code: string,
    db?: DbLike,
    opts?: { skipCache?: boolean; scope?: string },
  ): Promise<DictSnapshot | null> {
    const cacheKey = `${code}::${opts?.scope || 'global'}`;
    if (!opts?.skipCache) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
    }
    const d = pickDb(db);
    const row = await d.dataDictionary.findUnique?.({
      where: { code: opts?.scope && opts.scope !== 'global' ? undefined : code }, // 非 global scope 先查精确 code，再 scope filter
      // scope 过滤通过下面 findMany 做
    });
    let target = row;
    if (opts?.scope && opts.scope !== 'global') {
      const rows = await d.dataDictionary.findMany({ where: { code, scope: opts.scope }, take: 1 });
      target = rows?.[0] || row;
    }
    if (!target) return null;
    const snap = snapshotFromRow(target);
    cache.set(cacheKey, { snapshot: snap, expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS });
    return snap;
  }

  /**
   * 最常用方法：获取某个字典的条目（已按 order 升序排，默认剔除 disabled=true 项）
   */
  async function getEntries(code: string, opts?: { enabledOnly?: boolean; scope?: string; db?: DbLike }): Promise<DictEntry[]> {
    const snap = await getByCode(code, opts?.db, { scope: opts?.scope });
    if (!snap) return [];
    if (opts?.enabledOnly === false) return snap.entries;
    return snap.entries.filter((e) => !e.disabled);
  }

  /**
   * 取单个 key → label（常用：status key 变展示中文）
   */
  async function getLabel(code: string, key: string, fallback?: string, opts?: { scope?: string; db?: DbLike }): Promise<string> {
    const entries = await getEntries(code, { enabledOnly: false, ...opts });
    const found = entries.find((e) => e.key === key);
    return found?.label ?? (fallback != null ? fallback : key);
  }

  /**
   * 列出所有字典（含 meta，不展开 entries）
   */
  async function listDictionaries(filter: QueryDictFilter = {}, db?: DbLike): Promise<DictSnapshot[]> {
    const d = pickDb(db);
    const where: any = {};
    if (filter.category) where.category = filter.category;
    if (filter.scope) where.scope = filter.scope;
    if (filter.isSystem !== undefined) where.isSystem = filter.isSystem;
    const rows = await d.dataDictionary.findMany({ where, orderBy: [{ category: 'asc' }, { code: 'asc' }] }) || [];
    return rows.map(snapshotFromRow);
  }

  /**
   * Upsert 字典（幂等，用于 seed 或 OPS Panel 更新）
   *   · version 自增 + 写入 DataDictionaryHistory diff
   *   · 系统字典（isSystem=true）仅允许改 entries 的 label/color/order，不允许删 key（fail closed）
   */
  async function upsert(input: UpsertDictInput, db?: DbLike): Promise<{ dict: DictSnapshot; versionChanged: boolean; historyId?: string | null }> {
    if (!input.code) throw new Error('DataDictionary.upsert: code 必填');
    if (!input.name) throw new Error('DataDictionary.upsert: name 必填');
    if (!Array.isArray(input.entries)) throw new Error('DataDictionary.upsert: entries 必须是数组');
    const d = pickDb(db);
    const scope = input.scope || 'global';
    const id = `DICT_${scope}_${input.code}`;
    const entriesSorted = [...input.entries]
      .map((e, i) => ({ ...e, order: e.order ?? i } as DictEntry & { order: number }))
      .sort((a, b) => a.order - b.order);

    const existing = await d.dataDictionary.findUnique?.({ where: { id } })
      || await d.dataDictionary.findFirst?.({ where: { code: input.code, scope } });

    // 保护：isSystem=true 时，删除/新增 key 必须显式声明 allowSystemKeyMutation=true（通过 input.extra 传入避免 TS 签名扩散）
    const existingEntries = existing ? toEntries(existing.entries) : [];
    const nextKeys = new Set(entriesSorted.map((e) => e.key));
    const prevKeys = new Set(existingEntries.map((e) => e.key));
    const deletedKeys = prevKeys ? [...prevKeys].filter((k) => !nextKeys.has(k)) : [];
    const isSystem = (existing?.isSystem) || (input.isSystem === true);
    const allowSystemKeyMutation = !!(input as any).allowSystemKeyMutation;
    if (isSystem && !allowSystemKeyMutation && deletedKeys.length > 0) {
      throw new Error(`DataDictionary[${input.code}] 是系统字典，不允许删除 keys=${deletedKeys.join(',')}（老数据有引用风险）。如需强制请传 allowSystemKeyMutation=true`);
    }

    const newVersion = (existing?.version ?? 0) + 1;
    const row = await d.dataDictionary.upsert({
      where: { id },
      create: {
        id,
        code: input.code,
        name: input.name,
        category: input.category,
        scope,
        isSystem: input.isSystem ?? false,
        version: 1,
        entries: entriesSorted as any,
        labels: input.labels ?? null,
        description: input.description ?? null,
        updatedAt: BigInt(Date.now()),
      },
      update: {
        name: input.name,
        category: input.category,
        isSystem: input.isSystem ?? existing?.isSystem ?? false,
        version: newVersion,
        entries: entriesSorted as any,
        labels: input.labels !== undefined ? input.labels : undefined,
        description: input.description !== undefined ? input.description : undefined,
        updatedAt: BigInt(Date.now()),
      },
    });

    const historyDb = pickDbHistory(db);
    let historyId: string | null = null;
    if (existing && historyDb?.dataDictionaryHistory?.create) {
      historyId = `DDH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        await historyDb.dataDictionaryHistory.create({
          data: {
            id: historyId,
            dictCode: input.code,
            versionFrom: existing.version ?? 1,
            versionTo: newVersion,
            diffEntries: {
              previousEntries: existing.entries,
              newEntries: entriesSorted as any,
              deletedKeys,
              addedKeys: [...nextKeys].filter((k) => !prevKeys.has(k)),
            },
            actorId: input.actorId ?? null,
            reason: input.reason ?? null,
          },
        });
      } catch (e: any) {
        logger?.error?.('[DataDictionary] history create failed', { message: e?.message, code: input.code });
      }
    }

    const dict = snapshotFromRow(row);
    // 刷掉所有相关缓存
    for (const k of [`${input.code}::${scope}`, `${input.code}::global`]) cache.delete(k);
    return { dict, versionChanged: !!existing, historyId };
  }

  /** 主动刷新缓存（管理后台编辑后调用）*/
  function invalidateCache(code?: string, scope?: string) {
    if (code) {
      for (const s of [scope || 'global']) cache.delete(`${code}::${s}`);
    } else {
      cache.clear();
    }
  }

  return {
    DICT_CODES,
    ALL_SYSTEM_DICT_CODES,

    // 基础查询
    getByCode,
    getEntries,
    getLabel,
    listDictionaries,

    // 写
    upsert,

    // 缓存管理
    invalidateCache,

    /** 给 tests / internal 用：缓存条目数（调试用）*/
    __cacheSize() { return cache.size; },
  };
}

let _defaultService: ReturnType<typeof createDataDictionaryService> | null = null;
export function getDataDictionaryService(prisma: PrismaClient): ReturnType<typeof createDataDictionaryService> {
  if (!_defaultService) _defaultService = createDataDictionaryService(prisma);
  return _defaultService;
}
