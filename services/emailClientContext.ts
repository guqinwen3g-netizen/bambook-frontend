import { getAuthState, subscribe } from './authService';
import { getApiBaseUrl } from './apiBase';

export const EMAIL_CONTEXT_EVENT = 'bambook:email-context-changed';
export function emailConfigStorageKey(actorId?: string | null): string {
  return actorId ? `aliyun_mail_config:${encodeURIComponent(actorId)}` : 'aliyun_mail_config:unbound';
}
/** Ephemeral namespaces contain no JWT, API key or mailbox credentials. */
function nonce() { return globalThis.crypto.randomUUID(); }
function identity(mailbox: () => unknown): string {
  const a = getAuthState(), u = a.user;
  let token = '', key = '';
  try { token = localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token') || '';
    key = JSON.parse(localStorage.getItem('panda_system_config') || '{}').sdkApiKey || ''; } catch { /* unavailable storage is unbound */ }
  return JSON.stringify([getApiBaseUrl(), token, key, a.isLoading, a.isAuthenticated, u?.id, u?.roles, u?.roleIds,
    u?.permissions, u?.permissionCeiling, u?.departmentIds, u?.department, mailbox()]);
}
export function createEmailClientContext(mailbox: () => unknown, invalidated: () => void) {
  let bound = identity(mailbox), namespace = nonce(), epoch = 0, active = true;
  const serial = new Map<string, number>(), controllers = new Set<AbortController>();
  const advance = () => { epoch++; namespace = nonce(); controllers.forEach(c => c.abort()); controllers.clear(); serial.clear(); invalidated(); };
  const observe = () => { const now = identity(mailbox); if (now !== bound) { bound = now; advance(); } };
  const force = () => { bound = identity(mailbox); advance(); };
  let stop: (() => void) | undefined;
  const key = () => `${namespace}:${epoch}`;
  const ready = () => { const auth = getAuthState(); return !auth.isLoading && auth.isAuthenticated && Boolean(auth.user?.id); };
  return {
    key,
    currentIdentity: () => active && ready() && identity(mailbox) === bound,
    invalidate: force,
    start() { if (!active) { active = true; bound = identity(mailbox); advance(); } stop = subscribe(observe); window.addEventListener('storage', observe); window.addEventListener('focus', observe); window.addEventListener(EMAIL_CONTEXT_EVENT, force); },
    dispose() { active = false; epoch++; controllers.forEach(c => c.abort()); controllers.clear(); stop?.(); window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); window.removeEventListener(EMAIL_CONTEXT_EVENT, force); },
    take(lane: string) {
      observe(); const version = epoch, fingerprint = bound, sequence = (serial.get(lane) || 0) + 1; serial.set(lane, sequence);
      const controller = new AbortController(); controllers.add(controller);
      return { key: key(), signal: controller.signal,
        current: () => { observe(); return active && ready() && version === epoch && fingerprint === bound && serial.get(lane) === sequence && !controller.signal.aborted; },
        release: () => { controllers.delete(controller); },
      };
    },
    /** Unknown UIDVALIDITY never produces a reusable body-cache key. */
    bodyKey(folder: string, uid: string, validity: unknown): string | null {
      observe(); if (!active || !folder || !/^[1-9]\d*$/.test(uid) || !/^[1-9]\d*$/.test(String(validity ?? ''))) return null;
      return `mailbody-v3:${namespace}:${encodeURIComponent(folder)}:${validity}:${uid}`;
    },
    listKey(folder: string) { observe(); return `nexus_emails_v3_${namespace}_${encodeURIComponent(folder)}`; },
  };
}
