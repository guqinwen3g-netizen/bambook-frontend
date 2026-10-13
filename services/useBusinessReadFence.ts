import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';

/** Ephemeral read ownership only. Observed identity changes stay invalid even
 * when the prior account, token or endpoint subsequently returns. */
export function useBusinessReadFence() {
  const identity = useRef(dashboardReadIdentity()), mounted = useRef(true), invalidated = useRef(false);
  const generations = useRef(new Map<string, number>()), lifecycle = useRef(0);
  const [invalid, setInvalid] = useState(false);
  const checkIdentity = useCallback(() => {
    if (dashboardReadIdentity() !== identity.current && !invalidated.current) {
      invalidated.current = true;
      if (mounted.current) setInvalid(true);
    }
    return mounted.current && !invalidated.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    checkIdentity();
    const stop = subscribe(checkIdentity);
    window.addEventListener('storage', checkIdentity);
    window.addEventListener('focus', checkIdentity);
    return () => { mounted.current = false; lifecycle.current += 1; generations.current.clear(); stop(); window.removeEventListener('storage', checkIdentity); window.removeEventListener('focus', checkIdentity); };
  }, [checkIdentity]);
  const begin = useCallback((key: string) => {
    if (!checkIdentity()) throw new Error('账号、权限或服务地址已变化，请重新进入本页面。');
    const mount = lifecycle.current;
    const generation = (generations.current.get(key) ?? 0) + 1;
    generations.current.set(key, generation);
    return () => checkIdentity() && lifecycle.current === mount && generations.current.get(key) === generation;
  }, [checkIdentity]);
  const cancel = useCallback((key: string) => { generations.current.set(key, (generations.current.get(key) ?? 0) + 1); }, []);
  return { invalid, begin, cancel };
}
