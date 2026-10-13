import React from 'react';
import { useNav } from '../../nav';

/** A page target may change without remounting its list or filters. */
export function useRouteScope() {
  const { route } = useNav();
  const key = JSON.stringify(route);
  const version = React.useMemo(() => Symbol(key), [key]);
  const current = React.useRef(version);
  const mounted = React.useRef(false);
  React.useLayoutEffect(() => { current.current = version; mounted.current = true; return () => { mounted.current = false; }; }, [version]);
  const isCurrent = React.useCallback(() => mounted.current && current.current === version, [version]);
  return { version, isCurrent };
}

/** Keep drafts through data refreshes, but never carry them to another route target. */
export function useRouteDraft<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
  const scope = useRouteScope();
  const initialRef = React.useRef(initial);
  initialRef.current = initial;
  const fresh = () => typeof initialRef.current === 'function' ? (initialRef.current as () => T)() : initialRef.current;
  const [draft, setDraft] = React.useState(() => ({ version: scope.version, value: fresh() }));
  React.useLayoutEffect(() => {
    setDraft(previous => previous.version === scope.version ? previous : { version: scope.version, value: fresh() });
  }, [scope.version]);
  const setValue = React.useCallback<React.Dispatch<React.SetStateAction<T>>>(update => {
    if (!scope.isCurrent()) return;
    setDraft(previous => {
      if (!scope.isCurrent()) return previous;
      const value = previous.version === scope.version ? previous.value : fresh();
      return { version: scope.version, value: typeof update === 'function' ? (update as (value: T) => T)(value) : update };
    });
  }, [scope.version, scope.isCurrent]);
  return [draft.version === scope.version ? draft.value : fresh(), setValue];
}
