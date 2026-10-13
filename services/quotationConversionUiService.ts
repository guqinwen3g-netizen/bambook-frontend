import { createQuotationConversionCommandService, conversionClientCanonical, parseQuotationCreateCommand, ConversionClientError, type ConversionPrincipal, type QuotationConversionContext, type QuotationCreateCommand, type QuotationConversionAck, type QuotationConversionRecovery } from './orderConversionCommandService';
import { getAuthState, subscribe } from './authService';
import { getApiBaseUrl } from './apiBase';
import { apiService } from './apiService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
export type QuotationConversionFields = { poNumber: string; millRelationId: string; dueDate: string; type: string; paymentInstrument: string };
export type QuotationConversionSession = { original: QuotationCreateCommand | null; prepared: QuotationConversionContext | null; outcome: QuotationConversionAck | QuotationConversionRecovery | null; fields: QuotationConversionFields | null };
type Options = { principal: () => ConversionPrincipal; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; fetch?: typeof fetch; timeoutMs?: number; subscribe?: (invalidate: () => void) => () => void; uuid?: () => string };
const error = (code: string, message: string): never => { throw new ConversionClientError(code, message); };
export const quotationConversionOriginalFields = (input: QuotationCreateCommand): QuotationConversionFields => ({ poNumber: input.parameters.poNumber ?? '', millRelationId: input.parameters.millRelationId ?? '', dueDate: input.parameters.dueDate ?? '', type: input.parameters.type ?? '', paymentInstrument: input.parameters.paymentInstrument ?? '' });
export function quotationConversionOverrides(fields: QuotationConversionFields): QuotationCreateCommand['parameters'] {
  return parseQuotationCreateCommand({ conversionVersion: 1, requestKey: 'context-validate', source: { type: 'quotation', id: 'context', expected: { updatedAt: '1', quotationVersion: 1, contentFingerprint: '0'.repeat(64) } }, operation: 'quotation_create', parameters: { poNumber: fields.poNumber.trim() || null, millRelationId: fields.millRelationId || null, dueDate: fields.dueDate || null, type: fields.type || null, paymentInstrument: fields.paymentInstrument || null } }).parameters;
}
export function createQuotationConversionUiService(options: Options) {
  let generation = 0, serial = 0, active: string | null = null, disposed = false;
  const services = new Map<string, ReturnType<typeof createQuotationConversionCommandService>>(), sessions = new Map<string, QuotationConversionSession>(), watchers = new Set<() => void>();
  const invalidate = () => { generation++; serial++; active = null; sessions.clear(); watchers.forEach(fn => fn()); }, stop = options.subscribe?.(invalidate);
  const principal = () => { if (disposed) return error('STALE_CONTEXT', '当前转单窗口已失效'); const p = options.principal(); return { ...p, generation: JSON.stringify([p.generation, generation, serial, active]) }; };
  const service = (sourceId: string) => {
    if (!sourceId) return error('INVALID_INPUT', '报价来源未指定'); let instance = services.get(sourceId);
    if (!instance) { const prefix = 'quotation-source:' + encodeURIComponent(sourceId) + ':'; instance = createQuotationConversionCommandService({ principal, fetch: options.fetch, timeoutMs: options.timeoutMs, storage: { getItem: key => options.storage.getItem(prefix + key), setItem: (key, value) => options.storage.setItem(prefix + key, value), removeItem: key => options.storage.removeItem(prefix + key) }, subscribe: fn => { watchers.add(fn); return () => watchers.delete(fn); } }); services.set(sourceId, instance); }
    return instance;
  };
  const take = (sourceId: string) => { const p = principal(), boundSerial = serial, boundGeneration = generation; return { current() { if (disposed) return false; let now: ConversionPrincipal; try { now = principal(); } catch { return false; } return active === sourceId && serial === boundSerial && generation === boundGeneration && now.actorId === p.actorId && now.endpoint === p.endpoint && now.generation === p.generation && JSON.stringify(now.headers) === JSON.stringify(p.headers); }, check() { if (!this.current()) error('STALE_CONTEXT', '当前窗口已切换，原报价转单请求仍保留'); } }; };
  const pending = (sourceId: string) => { const value = service(sourceId).pending(); if (value && (value.input.source.id !== sourceId || value.input.source.type !== 'quotation' || value.input.operation !== 'quotation_create')) return error('CORRUPT_PENDING', '原请求与当前报价不一致，请保留线索核查'); return value?.input ?? null; };
  const store = (sourceId: string, prepared: QuotationConversionContext | null, outcome: QuotationConversionAck | QuotationConversionRecovery | null) => { const original = pending(sourceId), session = { original, prepared, outcome, fields: original ? quotationConversionOriginalFields(original) : null }; sessions.set(sourceId, session); return session; };
  return {
    open(sourceId: string) { serial++; active = sourceId; return { current: take(sourceId), session: store(sourceId, null, null) }; },
    close() { serial++; active = null; }, invalidate, take, pending, session: (sourceId: string) => sessions.get(sourceId) ?? null,
    async prepare(sourceId: string, fields: QuotationConversionFields) {
      if (active !== sourceId) return error('STALE_CONTEXT', '请先打开当前报价转单窗口'); serial++; const current = take(sourceId);
      if (pending(sourceId)) return error('PENDING_EXISTS', '原请求尚待核对，不能修改后创建另一个订单'); store(sourceId, null, null);
      const prepared = await service(sourceId).contextQuotation(sourceId, quotationConversionOverrides(fields)); current.check(); store(sourceId, prepared, null); return prepared;
    },
    async submit(sourceId: string, fields: QuotationConversionFields) {
      const current = take(sourceId); current.check(); let input = pending(sourceId);
      if (!input) {
        const parameters = quotationConversionOverrides(fields);
        let prepared = sessions.get(sourceId)?.prepared;
        if (!prepared || !prepared.capabilities.canExecute || conversionClientCanonical(parameters) !== conversionClientCanonical(prepared.selection.overrides)) {
          prepared = await service(sourceId).contextQuotation(sourceId, parameters); current.check(); store(sourceId, prepared, null);
        }
        if (!prepared.capabilities.canExecute) return error('CONTEXT_NOT_READY', prepared.capabilities.reason || '报价当前不可转单');
        input = parseQuotationCreateCommand({ conversionVersion: 1, requestKey: (options.uuid ?? (() => crypto.randomUUID()))(), source: prepared.source, operation: 'quotation_create', parameters }); }
      const outcome = await service(sourceId).execute(input); current.check(); store(sourceId, null, outcome); return outcome;
    },
    async recover(sourceId: string) { const current = take(sourceId); current.check(); if (!pending(sourceId)) return error('NO_PENDING', '没有原请求需要恢复'); const outcome = await service(sourceId).recover(); current.check(); store(sourceId, null, outcome); return outcome; },
    async cancelOriginal(sourceId: string) { const current = take(sourceId); current.check(); if (!pending(sourceId)) return error('NO_PENDING', '没有原请求需要核验取消'); const outcome = await service(sourceId).cancel(); current.check(); store(sourceId, null, outcome); return outcome; },
    dispose() { disposed = true; generation++; serial++; stop?.(); services.forEach(instance => instance.dispose()); services.clear(); sessions.clear(); watchers.clear(); },
  };
}
export function createLiveQuotationConversionUiService() {
  let epoch = 0; const listeners = new Set<() => void>();
  const identity = () => { const a = getAuthState(); return JSON.stringify([getApiBaseUrl(), a.isAuthenticated, a.isLoading, a.user, apiService.getAuthHeaders()]); }; let bound = identity();
  const observe = () => { const now = identity(); if (now !== bound) { bound = now; epoch++; listeners.forEach(fn => fn()); } }, force = () => { bound = identity(); epoch++; listeners.forEach(fn => fn()); };
  const stop = subscribe(observe); window.addEventListener('storage', observe); window.addEventListener('focus', observe); window.addEventListener(EMAIL_CONTEXT_EVENT, force);
  const adapter = createQuotationConversionUiService({ storage: sessionStorage, principal: () => { observe(); const a = getAuthState(); if (a.isLoading || !a.isAuthenticated || !a.user?.id) return error('UNBOUND_CONTEXT', '请登录后核对报价转单'); return { actorId: a.user.id, endpoint: getApiBaseUrl(), generation: String(epoch), headers: apiService.getAuthHeaders() }; }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } }), dispose = adapter.dispose;
  return { ...adapter, dispose() { dispose(); stop(); window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); window.removeEventListener(EMAIL_CONTEXT_EVENT, force); listeners.clear(); } };
}
