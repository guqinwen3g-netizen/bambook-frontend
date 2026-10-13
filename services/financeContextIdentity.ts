import { apiService } from './apiService';
import { getAuthState, subscribe } from './authService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';

let observed: string | undefined, generation = 0, observing = false;
function observe() {
  const auth = getAuthState(), user = auth.user;
  const value = JSON.stringify([apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders(), auth.isAuthenticated,
    user?.id, user?.roles, user?.roleIds, user?.permissions, user?.permissionCeiling, user?.departmentIds, user?.department]);
  if (value !== observed) { observed = value; generation++; }
}
/** A slow financial response remains stale after A -> B -> A. The generation
 * contains no business facts and is never a substitute for server authority. */
export function financeContextIdentity() {
  if (!observing) {
    observing = true;
    if (typeof subscribe === 'function') subscribe(observe);
    if (typeof window !== 'undefined') { window.addEventListener('storage', observe); window.addEventListener('focus', observe);
      window.addEventListener(EMAIL_CONTEXT_EVENT, observe); }
  }
  observe(); return JSON.stringify([observed, generation]);
}
