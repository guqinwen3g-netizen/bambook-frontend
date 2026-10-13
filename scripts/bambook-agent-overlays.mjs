// Keep OpenBitFun's focus/portal lifecycle intact; only one mounted modal paints
// the scrim. DOM order is portal order: the top modal also dims lower surfaces.
export function installBambookOverlayStack(doc = document) {
  const selector = '[data-openbitfun-part="overlay"]';
  const view = doc.defaultView;
  const parentOrigins = new Set([
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:4173', 'http://127.0.0.1:4173',
  ]);
  let hostOverlayActive = false;
  const sync = () => {
    const overlays = [...doc.querySelectorAll(selector)];
    const owner = [...overlays].reverse().find(node => !['exiting', 'closed'].includes(node.dataset.state)) || overlays.at(-1);
    for (const node of overlays) {
      const value = !hostOverlayActive && node === owner ? 'active' : 'suppressed';
      if (node.dataset.bambookScrim !== value) node.dataset.bambookScrim = value;
    }
  };
  const receiveHostOverlay = event => {
    if (!view || event.source !== view.parent) return;
    if (!parentOrigins.has(event.origin)
      && !(event.origin === 'null' && doc.documentElement.dataset.bambookHost === 'true')) return;
    const message = event.data;
    if (!message || message.type !== 'bambook:host-overlay' || message.version !== 1
      || typeof message.active !== 'boolean') return;
    hostOverlayActive = message.active;
    sync();
  };
  const observer = new MutationObserver(sync);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
  view?.addEventListener('message', receiveHostOverlay);
  sync();
  return () => {
    observer.disconnect();
    view?.removeEventListener('message', receiveHostOverlay);
    for (const node of doc.querySelectorAll(selector)) delete node.dataset.bambookScrim;
  };
}
