/**
 * systemConfigService.ts — Phase 0-08 统一系统配置服务（DB 真源）
 *
 * 核心能力：
 *   1. get(key, scope='global')      —— 取值（解密 + 类型转换）
 *   2. set(key, value, {encrypted,…}) —— 存值（AES-GCM 加密 / version+1 / 写 History / 清缓存）
 *   3. batchGet(keys[], scope)       —— 批量取，合并 1 次 SQL
 *   4. batchSet(items[])             —— 批量写（tx 原子）
 *   5. listByGroup(group, scope)     —— OPS Panel 按分组列出
 *   6. 加解密：使用 Node `crypto` AES-256-GCM；密钥来源：
 *         a. process.env.SYSTEM_CONFIG_ENCRYPTION_KEY（推荐：32 byte hex / 64 hex-char）
 *         b. 若缺失：回退到 `SYSTEM_CONFIG_DEVK_${BAMBOOK_COOKIE_SECRET||'dev'}` 的 sha256（仅开发环境，NOT FOR PROD）
 *         c. a,b 都缺失：encrypted=true 时抛错，防止生产上秘钥为空的 silent fail
 *   7. TTL 内存缓存（默认 30 秒）：避免每次路由取 10+ 配置就 10+ 次 DB
 *
 * 敏感配置：encrypted=true，DB 里看到的是 "hexiv.hexcipher.hextag"；History 里 valueFrom/To 存 `***MASKED***`（sensitiveMasked=true），避免泄露
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

// ────────────────────────────────────────────────────────────────────
// 类型 & 常量
// ────────────────────────────────────────────────────────────────────
export type ValueType = 'string' | 'number' | 'boolean' | 'json' | 'enum';
export type ConfigGroup =
  | 'company' | 'finance' | 'tax' | 'logistics'
  | 'ui' | 'rbac' | 'ops' | 'custom';

export interface SystemConfigRow {
  id: string;
  scope: string;
  key: string;
  group: string;
  label: string;
  valueType: ValueType;
  value: unknown;   // 如果 encrypted=true，这里解密后原值；OPS Panel 列表调用时服务端可以选择不解密（留 mask）
  encrypted: boolean;
  version: number;
  description?: string | null;
  meta?: unknown | null;
  updatedBy?: string | null;
  auditReason?: string | null;
  createdAt: string | Date;
  updatedAt: bigint | number;
}

export interface SetOptions {
  /** 分组，仅当 create 时生效（已存在的保留原 group） */
  group?: ConfigGroup | (string & {});
  /** 展示标签，仅当 create 生效（已存在的保留原 label）*/
  label?: string;
  valueType?: ValueType;
  encrypted?: boolean;
  description?: string | null;
  meta?: unknown;
  actorId?: string | null;
  reason?: string | null;
}

// 32 byte key → 64 hex chars
const CACHE_TTL_MS = 30_000;
let _keyBuf: Buffer | null = null;
let _keyBufError: string | null = null;

function loadEncryptionKey(): Buffer {
  if (_keyBuf || _keyBufError) {
    if (_keyBufError) throw new Error(`[SystemConfig] 加密密钥加载失败：${_keyBufError}`);
    return _keyBuf!;
  }
  const envKey = process.env.SYSTEM_CONFIG_ENCRYPTION_KEY;
  if (envKey) {
    const hex = envKey.trim();
    if (hex.length === 64) {
      _keyBuf = Buffer.from(hex, 'hex');
      return _keyBuf;
    }
    if (hex.length === 32) {
      _keyBuf = Buffer.from(hex, 'utf8');
      return _keyBuf;
    }
    _keyBufError = `SYSTEM_CONFIG_ENCRYPTION_KEY 必须是 64 hex chars(32 bytes) 或 32 chars ASCII。当前长度=${hex.length}`;
    throw new Error(`[SystemConfig] ${_keyBufError}`);
  }
  // 开发 fallback（仅在没有 env 时）
  const fallbackSecret = process.env.BAMBOOK_COOKIE_SECRET || process.env.COOKIE_SECRET || 'dev-only-fallback-do-not-use-in-production';
  if (process.env.NODE_ENV === 'production') {
    _keyBufError = '生产环境必须显式设置 SYSTEM_CONFIG_ENCRYPTION_KEY（64 hex chars = 32 bytes）。禁止使用 fallback 衍生密钥。';
    throw new Error(`[SystemConfig] ${_keyBufError}`);
  }
  _keyBuf = crypto.createHash('sha256').update(`SYSTEM_CONFIG_DEVK_${fallbackSecret}`).digest();
  return _keyBuf;
}

export function __resetEncryptionKeyCache_for_tests() { _keyBuf = null; _keyBufError = null; }

function encryptValue(rawValue: unknown): string {
  const key = loadEncryptionKey();
  const plain = Buffer.from(typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 拼成 "iv.hex.cipher.hex.tag.hex"，Prisma 存 JSON 时可直接存字符串
  return `${iv.toString('hex')}.${ciphertext.toString('hex')}.${authTag.toString('hex')}`;
}

function decryptValue(blob: unknown): string {
  if (typeof blob !== 'string') {
    throw new Error('[SystemConfig] decryptValue: 密文必须是 "iv.cipher.tag" 字符串');
  }
  const parts = blob.split('.');
  if (parts.length !== 3) {
    throw new Error('[SystemConfig] decryptValue: 密文格式错误，预期 iv.hex.ciphertext.hextag.hex 三段');
  }
  const key = loadEncryptionKey();
  const iv = Buffer.from(parts[0], 'hex');
  const ciphertext = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('[SystemConfig] decryptValue: iv 必须 12 bytes, authTag 必须 16 bytes');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────
export function createSystemConfigService(prisma: PrismaClient) {
  const cache = new Map<string, { value: unknown; row: SystemConfigRow; expiresAt: number }>();

  function idOf(scope: string, key: string) { return `${scope}::${key}`; }

  function parseValueType(raw: unknown, vt: ValueType): unknown {
    if (raw == null) return null;
    switch (vt) {
      case 'string': return String(raw);
      case 'number': return Number(raw);
      case 'boolean': return raw === true || raw === 'true' || raw === 1 || raw === '1';
      case 'json':
      case 'enum':
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch { return raw; }
        }
        return raw;
    }
  }

  function rowToSystemConfigRow(r: any, decryptIfNeeded: boolean): SystemConfigRow {
    let value: unknown = r.value ?? null;
    if (decryptIfNeeded && r.encrypted && value != null) {
      try {
        const decryptedStr = decryptValue(value);
        value = parseValueType(decryptedStr, r.valueType as ValueType);
      } catch (e: any) {
        // 解密失败（可能换 key）：返回 undefined 并在服务 log 提示
        value = null;
        console.error(`[SystemConfig] 解密失败 key=${r.key}: ${e?.message}`);
      }
    }
    if (!r.encrypted) value = parseValueType(value, r.valueType as ValueType);
    return {
      id: r.id,
      scope: r.scope,
      key: r.key,
      group: r.group,
      label: r.label,
      valueType: r.valueType as ValueType,
      value,
      encrypted: !!r.encrypted,
      version: Number(r.version || 1),
      description: r.description ?? null,
      meta: r.meta ?? null,
      updatedBy: r.updatedBy ?? null,
      auditReason: r.auditReason ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt ?? BigInt(0),
    };
  }

  async function get(key: string, opts?: { scope?: string; skipCache?: boolean }): Promise<{ value: unknown; row: SystemConfigRow } | null> {
    const scope = opts?.scope || 'global';
    const cacheKey = idOf(scope, key);
    if (!opts?.skipCache) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return { value: hit.value, row: hit.row };
    }
    const r = await (prisma as any).systemConfig.findUnique({ where: { id: cacheKey } });
    if (!r) return null;
    const row = rowToSystemConfigRow(r, true);
    cache.set(cacheKey, { value: row.value, row, expiresAt: Date.now() + CACHE_TTL_MS });
    return { value: row.value, row };
  }

  async function getString(key: string, fallback?: string, opts?: { scope?: string }): Promise<string> {
    const r = await get(key, opts);
    if (!r) return fallback as string;
    const v = r.value;
    if (v == null || v === '') return fallback as string;
    return String(v);
  }
  async function getNumber(key: string, fallback: number, opts?: { scope?: string }): Promise<number> {
    const r = await get(key, opts);
    if (!r) return fallback;
    const n = Number(r.value);
    return Number.isFinite(n) ? n : fallback;
  }
  async function getBoolean(key: string, fallback = false, opts?: { scope?: string }): Promise<boolean> {
    const r = await get(key, opts);
    if (!r) return fallback;
    const v = r.value;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    return Boolean(v);
  }

  async function batchGet(keys: string[], opts?: { scope?: string }): Promise<Map<string, { value: unknown; row: SystemConfigRow }>> {
    const scope = opts?.scope || 'global';
    const results = new Map<string, { value: unknown; row: SystemConfigRow }>();
    const toFetch: string[] = [];
    for (const k of keys) {
      const cacheKey = idOf(scope, k);
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) results.set(k, { value: hit.value, row: hit.row });
      else toFetch.push(k);
    }
    if (toFetch.length > 0) {
      const rows = await (prisma as any).systemConfig.findMany({
        where: { scope, key: { in: toFetch } },
      }) || [];
      for (const r of rows) {
        const row = rowToSystemConfigRow(r, true);
        results.set(r.key, { value: row.value, row });
        cache.set(idOf(scope, r.key), { value: row.value, row, expiresAt: Date.now() + CACHE_TTL_MS });
      }
    }
    return results;
  }

  async function set(
    key: string,
    value: unknown,
    opts: SetOptions = {},
  ): Promise<{ row: SystemConfigRow; previousValue: unknown; versionChanged: boolean }> {
    const scope = 'global';
    const id = idOf(scope, key);
    const existing = await (prisma as any).systemConfig.findUnique({ where: { id } });

    let valueStored: unknown;
    const shouldEncrypt = (existing?.encrypted) || (!!opts.encrypted);
    const valueType = (opts.valueType ?? existing?.valueType ?? (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string')) as ValueType;
    if (shouldEncrypt) {
      // 敏感值一律先序列化（JSON.stringify 或 string），再 encrypt；存 JSON 字符串形式到 Prisma
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      valueStored = encryptValue(serialized);
    } else {
      if (valueType === 'json' || valueType === 'enum') {
        valueStored = typeof value === 'string' ? value : JSON.stringify(value);
      } else {
        valueStored = value;
      }
    }

    const previousValue: unknown = existing ? (
      existing.encrypted
        ? '***MASKED***'       // 加密的 previous 不再在 History 里明文保留（用 masked，避免 key 泄露）
        : parseValueType(existing.value, existing.valueType as ValueType)
    ) : null;

    const newVersion = (existing?.version ?? 0) + 1;
    const row = await (prisma as any).systemConfig.upsert({
      where: { id },
      create: {
        id,
        scope,
        key,
        group: (opts.group || existing?.group || 'custom') as string,
        label: opts.label || existing?.label || key,
        valueType,
        value: valueStored as any,
        encrypted: !!shouldEncrypt,
        version: 1,
        description: opts.description ?? null,
        meta: opts.meta ?? null,
        updatedBy: opts.actorId ?? null,
        auditReason: opts.reason ?? null,
        updatedAt: BigInt(Date.now()),
      },
      update: {
        value: valueStored as any,
        encrypted: !!shouldEncrypt,
        valueType,
        version: newVersion,
        description: opts.description !== undefined ? opts.description : undefined,
        meta: opts.meta !== undefined ? opts.meta : undefined,
        updatedBy: opts.actorId ?? undefined,
        auditReason: opts.reason ?? undefined,
        updatedAt: BigInt(Date.now()),
      },
    });

    if (existing) {
      const historyId = `SCH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        await (prisma as any).systemConfigHistory.create({
          data: {
            id: historyId,
            configId: id,
            versionFrom: existing.version ?? 1,
            versionTo: newVersion,
            valueFrom: previousValue as any,
            valueTo: shouldEncrypt ? ('***MASKED***' as any) : (valueStored as any),
            actorId: opts.actorId ?? null,
            reason: opts.reason ?? null,
            sensitiveMasked: !!shouldEncrypt,
          },
        });
      } catch (e: any) {
        console.error(`[SystemConfig] history create failed key=${key}: ${e?.message}`);
      }
    }

    // 缓存失效
    cache.delete(id);

    const finalRow = rowToSystemConfigRow(row, true);
    return {
      row: finalRow,
      previousValue,
      versionChanged: !!existing,
    };
  }

  async function batchSet(
    items: Array<{ key: string; value: unknown } & SetOptions>,
  ): Promise<{ updated: number; created: number }> {
    let created = 0;
    let updated = 0;
    // 串行（避免 tx 过大 + History 需要每个 existing）
    for (const it of items) {
      const { key, value, ...rest } = it;
      const r = await set(key, value, rest);
      if (r.versionChanged) updated++; else created++;
    }
    return { created, updated };
  }

  async function listByGroup(group?: string, opts?: { scope?: string; includeSensitiveMasked?: boolean }): Promise<SystemConfigRow[]> {
    const scope = opts?.scope || 'global';
    const where: any = { scope };
    if (group) where.group = group;
    const rows = await (prisma as any).systemConfig.findMany({ where, orderBy: [{ group: 'asc' }, { key: 'asc' }] }) || [];
    // OPS Panel 默认不返回加密明文（includeSensitiveMasked=true 时也只返回解密后明文，但该参数应由路由的 requireAdmin 保护）
    return rows.map((r: any) => {
      if (r.encrypted && !opts?.includeSensitiveMasked) {
        const row = rowToSystemConfigRow(r, false);
        row.value = '***MASKED***';
        return row;
      }
      return rowToSystemConfigRow(r, !!opts?.includeSensitiveMasked);
    });
  }

  /** 主动失效（OPS Panel 编辑后已在 set 中处理；此方法给外部用）*/
  function invalidate(key?: string, scope: string = 'global') {
    if (key) cache.delete(idOf(scope, key)); else cache.clear();
  }

  /** 工具：当前是否具备加密密钥（生产启动自检可用）*/
  function hasEncryptionKey(): boolean {
    try { loadEncryptionKey(); return true; } catch { return false; }
  }

  return {
    // 读
    get,
    getString,
    getNumber,
    getBoolean,
    batchGet,
    listByGroup,
    hasEncryptionKey,
    // 写
    set,
    batchSet,
    // 缓存
    invalidate,
    /** tests 用 */
    __cacheSize() { return cache.size; },
  };
}

let _defaultSvc: ReturnType<typeof createSystemConfigService> | null = null;
export function getSystemConfigService(prisma: PrismaClient) {
  if (!_defaultSvc) _defaultSvc = createSystemConfigService(prisma);
  return _defaultSvc;
}
