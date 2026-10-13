// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installBambookOverlayStack } from './bambook-agent-overlays.mjs';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); delete document.documentElement.dataset.bambookHost; });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function overlay() {
  const node = document.createElement('div');
  node.dataset.openbitfunPart = 'overlay';
  node.dataset.state = 'open';
  document.body.append(node);
  return node;
}
describe('embedded Agent single scrim lifecycle', () => {
  it('paints one scrim while nested portals open and restores the remaining owner', async () => {
    const outer = overlay();
    dispose = installBambookOverlayStack();
    const inner = overlay();
    await flush();
    expect(outer.dataset.bambookScrim).toBe('suppressed');
    expect(inner.dataset.bambookScrim).toBe('active');
    inner.remove();
    await flush();
    expect(outer.dataset.bambookScrim).toBe('active');
    const next = overlay();
    outer.dataset.state = 'exiting';
    await flush();
    expect(outer.dataset.bambookScrim).toBe('suppressed');
    expect(next.dataset.bambookScrim).toBe('active');
  });
  it('cleans up without changing the upstream portal or interaction state', () => {
    const node = overlay();
    dispose = installBambookOverlayStack();
    dispose();
    expect(node.dataset.bambookScrim).toBeUndefined();
    expect(node.dataset.state).toBe('open');
    expect(node.isConnected).toBe(true);
  });
  it('suppresses the iframe scrim for a trusted host overlay and restores it', () => {
    const node = overlay();
    dispose = installBambookOverlayStack();
    const send = (active: boolean) => window.dispatchEvent(new MessageEvent('message', {
      source: window.parent, origin: 'http://localhost:3000',
      data: { type: 'bambook:host-overlay', version: 1, active },
    }));
    send(true);
    expect(node.dataset.bambookScrim).toBe('suppressed');
    send(false);
    expect(node.dataset.bambookScrim).toBe('active');
    dispose();
    send(true);
    expect(node.dataset.bambookScrim).toBeUndefined();
  });
  it('rejects forged parents, untrusted origins and malformed messages', () => {
    const node = overlay();
    dispose = installBambookOverlayStack();
    const data = { type: 'bambook:host-overlay', version: 1, active: true };
    for (const properties of [
      { source: null, origin: 'http://localhost:3000', data },
      { source: window.parent, origin: 'https://untrusted.invalid', data },
      { source: window.parent, origin: 'null', data },
      { source: window.parent, origin: 'http://localhost:3000', data: { ...data, version: 2 } },
      { source: window.parent, origin: 'http://localhost:3000', data: { ...data, active: 'true' } },
    ]) {
      window.dispatchEvent(new MessageEvent('message', properties));
      expect(node.dataset.bambookScrim).toBe('active');
    }
    document.documentElement.dataset.bambookHost = 'true';
    window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin: 'null', data }));
    expect(node.dataset.bambookScrim).toBe('suppressed');
  });
});
