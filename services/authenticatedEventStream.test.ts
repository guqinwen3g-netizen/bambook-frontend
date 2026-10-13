import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedEventStream } from './authenticatedEventStream';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(headers: Record<string, string> = { Authorization: 'Bearer session', 'X-Bambook-API-Key': 'configured-key' }) {
  let identity = 'actor-a', changed = () => {}, stream: ReadableStreamDefaultController<Uint8Array>;
  const request = vi.fn(async (_url: string, _options: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', request);
  const event = vi.fn(), open = vi.fn(), unwatch = vi.fn();
  const stop = authenticatedEventStream({ snapshot: () => ({ url: 'https://example.test/api/v1/events', headers, identity }),
    observe: listener => { changed = listener; return unwatch; }, onEvent: event, onOpen: open });
  return { request, event, open, stop, unwatch, send: (text: string) => stream!.enqueue(new TextEncoder().encode(text)), close: () => stream!.close(), change: () => { identity = 'actor-b'; changed(); } };
}
describe('authenticated event stream', () => {
  it('sends bearer and API key only in headers and parses split CRLF/multiline events', async () => {
    const f = fixture(); await flush();
    expect(f.request.mock.calls[0][0]).toBe('https://example.test/api/v1/events');
    expect(f.request.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer session', 'X-Bambook-API-Key': 'configured-key', Accept: 'text/event-stream' }, credentials: 'omit' });
    f.send(': heartbeat\r\nevent: notification\r'); await flush(); f.send('\ndata: 中文\r\ndata: second\r\n\r\n'); await flush();
    expect(f.event).toHaveBeenCalledWith('notification', '中文\nsecond'); expect(f.open).toHaveBeenCalledTimes(1); f.stop();
  });
  it('uses existing cookie session when bearer absent', async () => {
    const f = fixture({}); await flush(); expect(f.request.mock.calls[0][1]).toMatchObject({ credentials: 'include' }); f.stop();
  });
  it('aborts old account stream and suppresses late events, disposing observers and new connection', async () => {
    const f = fixture(); await flush(); const signal = f.request.mock.calls[0][1].signal!;
    f.change(); expect(signal.aborted).toBe(true); await flush(); expect(f.request).toHaveBeenCalledTimes(2);
    f.stop(); f.send('event: notification\ndata: late\n\n'); await flush(); expect(f.event).not.toHaveBeenCalled(); expect(f.unwatch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403])('does not retry terminal auth status %s until identity changes', async status => {
    vi.useFakeTimers(); const request = vi.fn(async () => new Response('', { status })); vi.stubGlobal('fetch', request);
    let identity = 'a', changed = () => {};
    const stop = authenticatedEventStream({ snapshot: () => ({ url: '/events', headers: {}, identity }), observe: cb => { changed = cb; return () => {}; }, onEvent: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(60000); expect(request).toHaveBeenCalledTimes(1);
    identity = 'b'; changed(); await flush(); expect(request).toHaveBeenCalledTimes(2); stop();
  });
  it('reconnects on EOF, reports open again and cancels pending retry on dispose', async () => {
    vi.useFakeTimers(); const f = fixture(); await flush(); f.close(); await flush();
    await vi.advanceTimersByTimeAsync(1000); await flush(); expect(f.open).toHaveBeenCalledTimes(2);
    f.close(); await flush(); f.stop(); await vi.advanceTimersByTimeAsync(60000); expect(f.request).toHaveBeenCalledTimes(2);
  });
});
