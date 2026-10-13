import React from 'react';
import { useMistSession } from './auth';
import { createDevelopmentRuntime, type DevelopmentPage, type DevelopmentQuery } from './development';

type Runtime = ReturnType<typeof createDevelopmentRuntime>;
export interface DevelopmentData {
  runtime: Runtime | null;
  page: DevelopmentPage | null;
  query: DevelopmentQuery;
  loading: boolean;
  error: string;
  setQuery: React.Dispatch<React.SetStateAction<DevelopmentQuery>>;
  refresh: () => void;
  ensureList: () => void;
}
const Context = React.createContext<DevelopmentData | null>(null);

/** The approved Mist pages share read state; this provider contains no UI. */
export function DevelopmentProvider({ children }: { children: React.ReactNode }) {
  const session = useMistSession();
  const [binding, setBinding] = React.useState<{ key: string; runtime: Runtime } | null>(null);
  const [snapshot, setSnapshot] = React.useState<{ key: string; page: DevelopmentPage } | null>(null);
  const [query, setQuery] = React.useState<DevelopmentQuery>({ limit: 30, offset: 0 });
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const [revision, setRevision] = React.useState(0);
  const ensureList = React.useCallback(() => setEnabled(true), []);
  const refresh = React.useCallback(() => setRevision(value => value + 1), []);
  const key = session.sessionKey;
  const runtime = session.status === 'authenticated' && binding?.key === key ? binding.runtime : null;
  const page = runtime && snapshot?.key === key ? snapshot.page : null;

  React.useEffect(() => {
    setSnapshot(null); setError(''); setBusy(false);
    setQuery({ limit: 30, offset: 0 });
    if (session.status !== 'authenticated') { setBinding(null); return; }
    const next = createDevelopmentRuntime();
    setBinding({ key, runtime: next });
    return () => next.dispose();
  }, [session.status, key]);

  React.useEffect(() => {
    if (!enabled || !runtime) return;
    const controller = new AbortController();
    let current = true;
    setBusy(true); setError(''); setSnapshot(null);
    void runtime.list(query, { signal: controller.signal }).then(result => {
      if (current) setSnapshot({ key, page: result });
    }).catch(failure => {
      if (current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '开发案暂时无法读取');
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; controller.abort(); };
  }, [runtime, enabled, query, revision, key]);

  const value: DevelopmentData = {
    runtime, page, query, loading: enabled && (!runtime || busy), error: runtime ? error : '',
    setQuery, refresh, ensureList,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDevelopment(): DevelopmentData {
  const value = React.useContext(Context);
  if (!value) throw new Error('useDevelopment must be used inside DevelopmentProvider');
  return value;
}
