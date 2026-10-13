/** Fetch SSE keeps session credentials in headers, never in an event URL. */
export function authenticatedEventStream(options: {
  snapshot: () => { url: string; headers: Record<string, string>; identity: string };
  observe: (changed: () => void) => () => void;
  onEvent: (event: string, data: string) => void;
  onOpen?: () => void;
}): () => void {
  let disposed = false, generation = 0, identity = '', controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined, delay = 1000;
  const cancel = () => { controller?.abort(); if (retry) clearTimeout(retry); retry = undefined; };
  const connect = async () => {
    const snapshot = options.snapshot();
    identity = snapshot.identity;
    const currentGeneration = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    const current = () => !disposed && !signal.aborted && generation === currentGeneration && options.snapshot().identity === identity;
    let terminal = false;
    try {
      const response = await fetch(snapshot.url, { headers: { ...snapshot.headers, Accept: 'text/event-stream' },
        credentials: snapshot.headers.Authorization ? 'omit' : 'include', signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { terminal = true; return; }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Event stream unavailable');
      delay = 1000;
      options.onOpen?.();
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', event = 'message', data: string[] = [];
      const line = (value: string) => {
        if (!value) { if (data.length && current()) options.onEvent(event, data.join('\n')); event = 'message'; data = []; return; }
        if (value.startsWith(':')) return;
        const separator = value.indexOf(':');
        const field = separator < 0 ? value : value.slice(0, separator);
        const content = separator < 0 ? '' : value.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') event = content;
        if (field === 'data') data.push(content);
        // Server has no replay cursor contract; do not invent Last-Event-ID replay.
      };
      try {
        while (current()) {
          const chunk = await reader.read();
          if (!current() || chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, newline).replace(/\r$/, '')); buffer = buffer.slice(newline + 1);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { /* Transient stream failures reconnect without logging credentials. */ }
    finally {
      if (current() && !terminal) { retry = setTimeout(() => { retry = undefined; void connect(); }, delay); delay = Math.min(delay * 2, 30000); }
    }
  };
  const changed = () => {
    if (disposed || options.snapshot().identity === identity) return;
    cancel(); ++generation; delay = 1000; void connect();
  };
  void connect();
  const stopObserving = options.observe(changed);
  return () => { disposed = true; ++generation; cancel(); stopObserving(); };
}
