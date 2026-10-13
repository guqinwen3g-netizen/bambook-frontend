import { createOrderConversionCommandService, parseDevelopmentConversionCommand, ConversionClientError, type ConversionContext, type ConversionPrincipal, type ConversionSelectedSource, type DevelopmentConversionCommand, type ConversionAck, type ConversionRecovery } from './orderConversionCommandService';
import { getAuthState, subscribe } from './authService';
import { getApiBaseUrl } from './apiBase';
import { apiService } from './apiService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';

export type DevelopmentConversionFields = { quantity: string; dueDate: string; quoteAmount: string; unit: string; millSupplierId: string; confirmedSourceKey: string };
export type DevelopmentConversionSession = { sourceId: string; original: DevelopmentConversionCommand | null; prepared: ConversionContext | null; outcome: ConversionAck | ConversionRecovery | null; fields: DevelopmentConversionFields | null };
type AdapterOptions = { principal: () => ConversionPrincipal; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; fetch?: typeof fetch; timeoutMs?: number; subscribe?: (invalidate: () => void) => () => void; uuid?: () => string };
const error = (code: string, message: string): never => { throw new ConversionClientError(code, message); };
const sourceKey = (source: ConversionSelectedSource) => source.type === 'primary_asset' ? '' : source.type + ':' + source.id;
export function developmentConversionOriginalFields(input: DevelopmentConversionCommand): DevelopmentConversionFields {
  return { quantity: input.operation === 'development_create' ? input.parameters.quantity : '', dueDate: input.operation === 'development_create' ? input.parameters.dueDate : '', quoteAmount: input.operation === 'development_create' ? input.parameters.quoteAmount ?? '' : '', unit: input.operation === 'development_create' ? input.parameters.unit : '', millSupplierId: input.parameters.millRelationId, confirmedSourceKey: sourceKey(input.parameters.selectedSource) };
}
/** UI tickets are separate from durable command identity: closing a modal never cancels business. */
export function createDevelopmentConversionUiService(options: AdapterOptions) {
  let generation = 0, disposed = false; const services = new Map<string, ReturnType<typeof createOrderConversionCommandService>>();
  const sessions = new Map<string, DevelopmentConversionSession>(); const watchers = new Set<() => void>();
  let modalSerial = 0, activeSource: string | null = null;
  const invalidate = () => { generation++; modalSerial++; activeSource = null; sessions.clear(); watchers.forEach(fn => fn()); };
  const stop = options.subscribe?.(invalidate);
  const principal = () => { if (disposed) return error('STALE_CONTEXT', '当前操作已失效'); const bound = options.principal(); return { ...bound, generation: JSON.stringify([bound.generation, generation, modalSerial, activeSource]) }; };
  const service = (sourceId: string) => {
    if (!sourceId) return error('INVALID_INPUT', '开发来源未指定');
    let value = services.get(sourceId);
    if (!value) {
      const prefix = 'development-source:' + encodeURIComponent(sourceId) + ':';
      value = createOrderConversionCommandService({ principal, fetch: options.fetch, timeoutMs: options.timeoutMs,
        storage: { getItem: key => options.storage.getItem(prefix + key), setItem: (key, body) => options.storage.setItem(prefix + key, body), removeItem: key => options.storage.removeItem(prefix + key) },
        subscribe: fn => { watchers.add(fn); return () => watchers.delete(fn); } });
      services.set(sourceId, value);
    }
    return value;
  };
  const ticket = (sourceId: string) => {
    const serial = modalSerial, epoch = generation, bound = principal();
    return { current() { if (disposed) return false; let p: ConversionPrincipal; try { p = principal(); } catch { return false; } return activeSource === sourceId && serial === modalSerial && epoch === generation && p.actorId === bound.actorId && p.endpoint === bound.endpoint && p.generation === bound.generation && JSON.stringify(p.headers) === JSON.stringify(bound.headers); }, check() { if (!this.current()) error('STALE_CONTEXT', '当前转单窗口已切换，原请求仍保留'); } };
  };
  const original = (sourceId: string) => { const pending = service(sourceId).pending(); if (pending && pending.input.source.id !== sourceId) return error('CORRUPT_PENDING', '缓存中的原请求与开发案不一致，请保留线索核查'); return pending?.input ?? null; };
  const store = (sourceId: string, prepared: ConversionContext | null, outcome: ConversionAck | ConversionRecovery | null): DevelopmentConversionSession => {
    const input = original(sourceId); const session = { sourceId, original: input, prepared, outcome, fields: input ? developmentConversionOriginalFields(input) : null }; sessions.set(sourceId, session); return session;
  };
  return {
    open(sourceId: string) { modalSerial++; activeSource = sourceId; const current = ticket(sourceId); const session = store(sourceId, null, null); return { current, session }; },
    close() { modalSerial++; activeSource = null; },
    invalidate,
    take: ticket,
    pending: original,
    session: (sourceId: string) => sessions.get(sourceId) ?? null,
    async prepare(sourceId: string, selectedSource: ConversionSelectedSource, orderId?: string) {
      if (activeSource !== sourceId) return error('STALE_CONTEXT', '请先打开当前开发案的转单窗口'); modalSerial++;
      const current = ticket(sourceId); if (original(sourceId)) return error('PENDING_EXISTS', '原转单请求尚待核对，请先恢复或核验取消');
      store(sourceId, null, null);
      const prepared = orderId ? await service(sourceId).contextLink(sourceId, orderId, selectedSource) : await service(sourceId).context(sourceId, selectedSource);
      current.check(); store(sourceId, prepared, null); return prepared;
    },
    async submit(sourceId: string, fields: DevelopmentConversionFields) {
      const current = ticket(sourceId); let input = original(sourceId);
      if (!input) {
        const prepared = sessions.get(sourceId)?.prepared; if (!prepared || !prepared.capabilities.canExecute) return error('CONTEXT_NOT_READY', prepared?.capabilities.reason || '请先完成确认成果与来源版本核验');
        if (fields.millSupplierId !== prepared.anchors.factory?.id || fields.confirmedSourceKey !== sourceKey(prepared.selection.selectedSource)) return error('PREPARATION_CHANGED', '当前成果或工厂与已核验来源不同，请重新读取');
        const base = { conversionVersion: 1, requestKey: (options.uuid ?? (() => crypto.randomUUID()))(), source: prepared.source };
        input = prepared.selection.operation === 'development_link'
          ? parseDevelopmentConversionCommand({ ...base, operation: 'development_link', parameters: prepared.defaults })
          : parseDevelopmentConversionCommand({ ...base, operation: 'development_create', parameters: { quantity: fields.quantity, unit: fields.unit, dueDate: fields.dueDate, quoteAmount: fields.quoteAmount.trim() === '' ? null : fields.quoteAmount, selectedSource: prepared.selection.selectedSource, millRelationId: fields.millSupplierId, orderPo: null } });
      }
      const outcome = await service(sourceId).execute(input); current.check(); store(sourceId, null, outcome); return outcome;
    },
    async recover(sourceId: string) { const current = ticket(sourceId); if (!original(sourceId)) return error('NO_PENDING', '没有需要恢复的原请求'); const outcome = await service(sourceId).recover(); current.check(); store(sourceId, null, outcome); return outcome; },
    async cancelOriginal(sourceId: string) { const current = ticket(sourceId); if (!original(sourceId)) return error('NO_PENDING', '没有需要核验取消的原请求'); const outcome = await service(sourceId).cancel(); current.check(); store(sourceId, null, outcome); return outcome; },
    dispose() { disposed = true; generation++; modalSerial++; stop?.(); services.forEach(value => value.dispose()); services.clear(); sessions.clear(); watchers.clear(); },
  };
}
/** Lazy live adapter; no network call until an existing modal explicitly acts. */
export function createLiveDevelopmentConversionUiService() {
  let epoch = 0; const listeners = new Set<() => void>();
  const identity = () => { const state = getAuthState(); return JSON.stringify([getApiBaseUrl(), state.isAuthenticated, state.isLoading, state.user, apiService.getAuthHeaders()]); };
  let bound = identity(); const observe = () => { const now = identity(); if (now !== bound) { bound = now; epoch++; listeners.forEach(fn => fn()); } };
  const force = () => { bound = identity(); epoch++; listeners.forEach(fn => fn()); };
  const authStop = subscribe(observe); window.addEventListener('storage', observe); window.addEventListener('focus', observe); window.addEventListener(EMAIL_CONTEXT_EVENT, force);
  const adapter = createDevelopmentConversionUiService({ storage: sessionStorage,
    principal: () => { observe(); const auth = getAuthState(); if (auth.isLoading || !auth.isAuthenticated || !auth.user?.id) return error('UNBOUND_CONTEXT', '请登录后核对转单'); return { actorId: auth.user.id, endpoint: getApiBaseUrl(), generation: String(epoch), headers: apiService.getAuthHeaders() }; },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  });
  const dispose = adapter.dispose;
  return { ...adapter, dispose() { dispose(); authStop(); window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); window.removeEventListener(EMAIL_CONTEXT_EVENT, force); listeners.clear(); } };
}
