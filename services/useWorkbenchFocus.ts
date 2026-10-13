import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from './authService';
import { readWorkbenchTarget, workbenchFocusIsCurrent, type WorkbenchFocusRequest } from './workbenchNavigation';

/** Ephemeral exact native reads. It never writes or supplies a fallback entity. */
export function useWorkbenchFocus(focus: WorkbenchFocusRequest | undefined) {
  const [record, setRecord] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false), invalid = useRef(false), generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    if (!focus || !live.current || invalid.current || !workbenchFocusIsCurrent(focus)) return null;
    const run = ++generation.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setRecord(null); setError('');
    try {
      const next = await readWorkbenchTarget(focus, { signal: controller.signal });
      if (!live.current || invalid.current || generation.current !== run || !workbenchFocusIsCurrent(focus)) return null;
      setRecord(next); return next;
    } catch (failure) {
      if (live.current && !invalid.current && generation.current === run) setError(failure instanceof Error ? failure.message : '原事项读取失败，请重试。');
      return null;
    } finally {
      if (live.current && generation.current === run) setLoading(false);
    }
  }, [focus]);
  useEffect(() => {
    live.current = true; invalid.current = false; generation.current++;
    setRecord(null); setError(''); setLoading(false);
    if (!focus) return () => { live.current = false; generation.current++; };
    const watch = () => {
      if (!workbenchFocusIsCurrent(focus)) {
        invalid.current = true; generation.current++; request.current?.abort();
        setRecord(null); setLoading(false); setError('账号、权限或服务地址已变化，请重新打开原事项。');
      }
    };
    const stop = subscribe(watch);
    window.addEventListener('storage', watch); window.addEventListener('focus', watch);
    watch(); void reload();
    return () => { live.current = false; generation.current++; request.current?.abort(); stop(); window.removeEventListener('storage', watch); window.removeEventListener('focus', watch); };
  }, [focus, reload]);
  return { record, loading, error, reload, valid: !!focus && !!record && !invalid.current && workbenchFocusIsCurrent(focus) };
}
