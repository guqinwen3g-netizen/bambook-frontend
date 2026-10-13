/**
 * domainEventBus.ts — Phase 0-05 轻量级 in-memory 领域事件总线
 *
 * 与既有 businessEventBus（重量级 / 持久化 / 跨模块联动 / 失败重试 / 幂等重放）的定位区别：
 *   DomainEventBus：进程内同步/异步钩子，低延迟，不持久化，不重放。
 *     典型订阅者：
 *       · DirtyCacheMarker（实体变更 → 写脏标记）
 *       · WebSocket 推送（前端实时刷新）
 *       · 运行时 in-memory cache 失效（TTL map.delete）
 *       · 指标埋点 hooks（increment counters）
 *     语义：发布者成功返回不代表订阅者成功；订阅者失败不反噬业务（fail open）。
 *
 *   BusinessEventBus：已由 events/businessEventBus.ts 提供，解决跨模块"强联动"
 *     （订单确认→自动开PI→自动建PO→自动建BOM…），带持久化+失败恢复。
 *
 * 两类 API：
 *   1. 事件总线（泛型）：createDomainEventBus<EventMap>() → { on, emit, off, once }
 *      适合精细 typed：{ EntityChanged: {entityType,entityId,before,after}; CacheBust: {...}; }
 *   2. 通用单例（弱类型但开箱即用）：getDefaultDomainBus() → 返回 domainEventBusDefault
 *      emit('entity:changed', payload) / on('entity:changed', fn)
 *
 * DirtyCache 绑定：
 *   emitEntityChanged(prisma, payload) 便捷函数：emit('entity:changed') 的同时
 *   调 dirtyCacheService.markDirty 标记 dashboard / report / accounting 等 scope 脏。
 */
import { EventEmitter } from 'events';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createDirtyCacheService, type CacheScope } from './dirtyCacheService';

// ────────────────────────────────────────────────────────────────────
// 1. Typed EventBus：类型安全的 createDomainEventBus<T>()
//    设计：T 是 { eventName: payloadShape }，键值对一一对应
// ────────────────────────────────────────────────────────────────────
export interface DomainEventBusOptions {
  /** 订阅者失败是否继续执行其他订阅者（默认 true — fail open）*/
  failOpen?: boolean;
  /** 所有订阅者执行超时（单个订阅者 ms），默认 5000；防止某订阅者卡死 */
  subscriberTimeoutMs?: number;
  /** 组件标识（用于日志归类） */
  name?: string;
}

type Listener<P = unknown> = (payload: P, ctx: { eventId: string; emittedAt: number }) => void | Promise<void>;

export interface DomainEventBus<EventMap extends Record<string, unknown>> {
  /** 订阅 — 返回 unsubscribe 函数 */
  on<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): () => void;
  /** 一次性订阅 */
  once<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): () => void;
  /** 取消订阅 */
  off<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): void;
  /**
   * 发布（fire + forget 风格，默认同步串行执行订阅者）
   *   - 所有订阅者抛出的错误都会被 catch + logger.error（除非 failOpen=false）
   *   - 返回 Promise<{ eventId, listenersCalled, failedCount }> 方便调用方判断
   */
  emit<K extends keyof EventMap & string>(
    event: K,
    payload: EventMap[K],
    emitOpts?: { sync?: boolean /** true=同步串行；false=setTimeout异步（default）*/ },
  ): Promise<{ eventId: string; listenersCalled: number; failedCount: number; errors: Error[] }>;
  /** 事件名清单（调试用） */
  eventNames(): (string | symbol)[];
  /** 订阅者数（调试/监控用）*/
  listenerCount<K extends keyof EventMap & string>(event: K): number;
}

export function createDomainEventBus<EventMap extends Record<string, unknown>>(
  opts: DomainEventBusOptions = {},
): DomainEventBus<EventMap> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // 不限制（订阅者多属正常）
  const failOpen = opts.failOpen ?? true;
  const timeoutMs = opts.subscriberTimeoutMs ?? 5000;
  const name = opts.name || 'DomainEventBus';

  function wrapListener<P>(listener: Listener<P>): (p: P, ctx: { eventId: string; emittedAt: number }) => Promise<void> {
    return async (p, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`DomainEventBus[${name}] listener timeout (${timeoutMs}ms)`)), timeoutMs);
        try {
          const r = listener(p, ctx);
          if (r && typeof (r as any).then === 'function') {
            (r as Promise<void>).then(
              () => { clearTimeout(t); resolve(); },
              (e) => { clearTimeout(t); reject(e); },
            );
          } else {
            clearTimeout(t);
            resolve();
          }
        } catch (e) {
          clearTimeout(t);
          reject(e);
        }
      });
    };
  }

  function on<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): () => void {
    const wrapped: any = wrapListener(listener as Listener<EventMap[K]>);
    emitter.on(event as string, wrapped);
    return () => emitter.off(event as string, wrapped);
  }

  function once<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): () => void {
    const wrapped: any = wrapListener(listener as Listener<EventMap[K]>);
    emitter.once(event as string, wrapped);
    return () => emitter.off(event as string, wrapped);
  }

  function off<K extends keyof EventMap & string>(event: K, listener: Listener<EventMap[K]>): void {
    // 取消订阅不强制要求是 wrapped 实例：我们没有保存映射，这里保持 EventEmitter 直接 off 语义
    emitter.off(event as string, listener as any);
  }

  async function emit<K extends keyof EventMap & string>(
    event: K,
    payload: EventMap[K],
    emitOpts?: { sync?: boolean },
  ): Promise<{ eventId: string; listenersCalled: number; failedCount: number; errors: Error[] }> {
    const eventId = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const emittedAt = Date.now();
    const listeners = emitter.listeners(event as string) as Array<(p: EventMap[K], ctx: any) => Promise<void>>;
    const errors: Error[] = [];
    let failedCount = 0;
    let listenersCalled = 0;

    const runOne = async (l: typeof listeners[number]) => {
      try {
        listenersCalled++;
        await l(payload, { eventId, emittedAt });
      } catch (e: any) {
        failedCount++;
        errors.push(e instanceof Error ? e : new Error(String(e)));
        logger.error(`[${name}] emit listener failed`, {
          event, eventId, listenerIndex: listenersCalled - 1,
          message: e?.message, failOpen,
        });
        if (!failOpen) throw e;
      }
    };

    const runAll = async () => {
      // 串行执行（便于前一个订阅者副作用被后续订阅者看见；保持简单可预测）
      for (const l of listeners) await runOne(l);
    };

    if (emitOpts?.sync) {
      await runAll();
    } else {
      // 异步：setImmediate/nextTick 立即脱离当前事件循环，避免 publish 阻塞主业务
      await new Promise<void>((resolve) => {
        setImmediate(async () => {
          try { await runAll(); } finally { resolve(); }
        });
      });
    }

    return { eventId, listenersCalled, failedCount, errors };
  }

  return {
    on, once, off, emit,
    eventNames: () => emitter.eventNames(),
    listenerCount: (e) => emitter.listenerCount(e as string),
  };
}

// ────────────────────────────────────────────────────────────────────
// 2. 默认单例（弱类型 — 与 Typed Bus 并列，供简单场景）
// ────────────────────────────────────────────────────────────────────
export type DomainEventMap = {
  /** 通用"任意实体变更"，业务服务在成功 C/U/D 后 emit */
  'entity:changed': {
    entityType: string;
    entityId: string;
    operation: 'create' | 'update' | 'delete';
    /** 可选的 before/after 快照（敏感字段调用方自行 mask）*/
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    actorId?: string;
    reason?: string;
    /** 触发的关联业务 ID（OrderStatusTransition.id 等）*/
    transactionId?: string;
  };
  /** 缓存失效事件 — in-memory cache 订阅者可批量清理 */
  'cache:bust': {
    keys?: string[];        // 精确 key
    patterns?: string[];    // glob 模式（cache 实现自行解析）
    scope?: string;         // 'dashboard' | 'report' | …
    entityType?: string;
    entityId?: string;
    actorId?: string;
  };
  /** 敏感查看（配合 audit logSensitiveView 使用）*/
  'view:senstive': {
    targetType: string;
    targetId: string;
    viewedFields: string[];
    via?: string;
    actorId: string;
  };
  /** 登录/登出（方便 websocket session 服务订阅）*/
  'auth:login': { userId: string; method: string; success: boolean; ip?: string };
  'auth:logout': { userId: string; ip?: string };

  /** 自定义扩展事件 —— payload 任意对象 */
  [k: `custom:${string}`]: Record<string, unknown>;
};

let _defaultBus: DomainEventBus<DomainEventMap> | null = null;
export function getDefaultDomainBus(): DomainEventBus<DomainEventMap> {
  if (!_defaultBus) _defaultBus = createDomainEventBus<DomainEventMap>({ name: 'DomainBus.Default' });
  return _defaultBus;
}

// ────────────────────────────────────────────────────────────────────
// 3. 便捷函数：emitEntityChanged — 发事件 + 同步 DirtyCache 标记
//    典型调用点：各业务 mutation service 在 $transaction 提交后调用一次
// ────────────────────────────────────────────────────────────────────
export interface EmitEntityChangedOptions {
  prisma: PrismaClient;
  entityType: string;
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string;
  reason?: string;
  transactionId?: string;
  /**
   * 变脏的缓存 scope 集合：默认标记 dashboard + report + accounting（三个高频聚合域）
   * 对非聚合实体（如 Contact）可传空数组，只发事件不落脏标记
   */
  dirtyScopes?: CacheScope[];
  /**
   * 事件总线实例：默认 getDefaultDomainBus()
   */
  bus?: DomainEventBus<DomainEventMap>;
}

export async function emitEntityChanged(opts: EmitEntityChangedOptions): Promise<{
  busResult: Awaited<ReturnType<DomainEventBus<DomainEventMap>['emit']>>;
  dirtyMarkers: string[]; // cacheKeys
}> {
  const bus = opts.bus || getDefaultDomainBus();
  const busResult = await bus.emit('entity:changed', {
    entityType: opts.entityType,
    entityId: opts.entityId,
    operation: opts.operation,
    before: opts.before ?? null,
    after: opts.after ?? null,
    actorId: opts.actorId,
    reason: opts.reason,
    transactionId: opts.transactionId,
  }, { sync: true });

  const dirtyScopes = opts.dirtyScopes ?? defaultScopesForEntity(opts.entityType);
  const dirtySvc = createDirtyCacheService(opts.prisma);
  const dirtyMarkers: string[] = [];

  for (const scope of dirtyScopes) {
    const { cacheKey } = await dirtySvc.markDirty({
      scope,
      entityType: opts.entityType,
      // 对 create/delete：只精确到 scope:entityType（聚合类脏）；对 update：再加单条实体（粒度更细）
      entityId: opts.operation === 'update' ? opts.entityId : undefined,
      reason: opts.reason || `${opts.entityType}.${opts.operation}`,
      actorId: opts.actorId,
    });
    dirtyMarkers.push(cacheKey);
  }

  return { busResult, dirtyMarkers };
}

/** 实体类型 → 默认脏 scope 映射；轻量启发式，业务方仍可通过 dirtyScopes 精确覆盖 */
function defaultScopesForEntity(entityType: string): CacheScope[] {
  const et = entityType.toLowerCase();
  const scopes: CacheScope[] = ['dashboard', 'report'];
  if (/^invoice|payment|allocation|voucher|vat|settlement|remittance|refund/.test(et)) {
    scopes.push('accounting');
  }
  if (/relation|customer|supplier|opportunity|crm|brand/.test(et)) {
    scopes.push('crm');
  }
  if (/forecast|plan|production|stage|schedule/.test(et)) {
    scopes.push('forecast');
  }
  // 去重
  return Array.from(new Set(scopes));
}
