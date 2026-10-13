/**
 * Real Chromium regression for the order detail's cqh / exit-space feedback loop.
 * Run with the existing Vite dev server: node scripts/acceptance-order-detail-layout-stability.mjs
 * No app login, API requests, order writes, user browser, or copied motion algorithm.
 * Optional: --legacy-padding reinstates only the old detail padding in this isolated
 * fixture, for a RED comparison after the production CSS has been repaired.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BAMBOOK_LAYOUT_BASE_URL || 'http://localhost:3000';
const legacyPadding = process.argv.includes('--legacy-padding');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 900 }, reducedMotion: 'no-preference' });
const page = await context.newPage();
const errors = [];
const businessRequests = [];
page.on('pageerror', error => errors.push(error.message));
// The harness owns a fresh context and fails if an imported component tries to
// access the business backend. The application itself is never mounted.
await page.route('**/api/**', route => {
  businessRequests.push(route.request().url());
  return route.abort();
});
await page.route(`${base}/__order-detail-layout-stability`, route => route.fulfill({
  contentType: 'text/html',
  body: '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div></body></html>',
}));

// All fields are measured from real browser layout; no simulated scrollHeight or RO.
async function sample(frames = 160) {
  return page.evaluate(async frames => {
    const root = document.querySelector('.bds-object-scroll');
    const records = [];
    const rounded = value => Math.round(value * 100) / 100;
    for (let i = 0; i < frames; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const style = getComputedStyle(root);
      const contentHeight = root.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      records.push({
        exitExtra: parseFloat(style.getPropertyValue('--order-exit-extra')) || 0,
        contentHeight: rounded(contentHeight),
        cardHeights: [...root.querySelectorAll('.bds-order-stage')].map(card => rounded(card.offsetHeight)),
        scrollRange: root.scrollHeight - root.clientHeight,
        scrollTop: rounded(root.scrollTop),
      });
    }
    return records;
  }, frames);
}

function checkStable(label, records) {
  // Allow fonts, initial RO and any preceding wheel spring to settle first.
  const tail = records.slice(-80);
  const unique = key => [...new Set(tail.map(row => JSON.stringify(row[key])))].map(value => JSON.parse(value));
  const changes = tail.slice(1).filter((row, i) => JSON.stringify(row) !== JSON.stringify(tail[i])).length;
  const signal = {
    exitExtra: unique('exitExtra'), contentHeight: unique('contentHeight'),
    cardHeights: unique('cardHeights'), scrollRange: unique('scrollRange'),
    scrollTop: unique('scrollTop'), changingFrames: changes,
  };
  console.log(`${label}: ${JSON.stringify(signal)}`);
  // Exact integral card/range/extra readings expose the alternating state; cqh
  // content pixels have a small tolerance only for fractional pixel rounding.
  for (const field of ['exitExtra', 'cardHeights', 'scrollRange', 'scrollTop']) {
    assert.equal(signal[field].length, 1, `${label}: ${field} did not settle without input`);
  }
  assert.ok(Math.max(...signal.contentHeight) - Math.min(...signal.contentHeight) < 0.1,
    `${label}: container content box did not settle without input`);
  return tail.at(-1);
}

try {
  await page.goto(`${base}/__order-detail-layout-stability`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async legacy => {
    // Use Vite's actual resolved React module URLs (including cache keys), so the
    // fixture and production components share one hook dispatcher.
    const entry = await (await fetch('/index.tsx')).text();
    const reactUrl = entry.match(/from "([^"\n]*\/react\.js[^"\n]*)"/)?.[1];
    const domUrl = entry.match(/from "([^"\n]*\/react-dom_client\.js[^"\n]*)"/)?.[1];
    if (!reactUrl || !domUrl) throw new Error('Vite React imports could not be resolved');
    const refresh = (await import('/@react-refresh')).default;
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/index.css');
    await import('/styles/flat-experimental.css');
    const React = (await import(reactUrl)).default;
    const { createRoot } = (await import(domUrl)).default;
    const { OrderDetailFlow, OrderDetailPanel, OrderTimelineRail, OrderDetailFooter,
      OrderDetailHeaderFrost, OrderDetailFooterFrost, getOrderDetailScrollStops } =
      await import('/components/order/OrderDetailWorkspace.tsx');
    const renderer = await import('/components/order/orderStageRenderer.ts');
    window.orderLayoutRenderer = renderer; // real renderer available for diagnostic readback
    const h = React.createElement;
    const areas = ['overview', 'agreement', 'fulfillment', 'shipment', 'finance'];
    // Two final short chapters stay governed by the production 64cqh minimum.
    // Giving these a fixed pixel height would conceal the original RO cycle.
    const bodyHeights = [150, 520, 430, 0, 0];
    if (legacy) {
      const probe = document.createElement('style');
      probe.dataset.legacyPaddingProbe = 'true';
      probe.textContent = '.bds-order-content-viewport > .bds-object-scroll{padding-bottom:calc(var(--space-10) + 48px + var(--order-tail-space) + var(--order-exit-extra,0px)) !important}.bds-order-content-viewport > .bds-object-scroll::after{display:none !important}';
      document.head.append(probe);
    }
    function Fixture() {
      const scrollRef = React.useRef(null);
      const [active, setActive] = React.useState('overview');
      const navigate = React.useCallback(area => {
        setActive(area);
        const root = scrollRef.current;
        const stop = getOrderDetailScrollStops(root, areas).find(stop => stop.id === area);
        if (stop) root.scrollTo({ top: stop.top, behavior: 'auto' });
      }, []);
      return h('div', { className: 'bds-object-workspace bds-order-stage-workspace' },
        // Fixed header/footer slots reproduce the real reading viewport budget.
        h('header', { className: 'bds-order-stage-header', style: { height: 68 } }, '订单详情布局回归'),
        h('div', { className: 'bds-order-content-viewport' },
          h('div', { ref: scrollRef, className: 'bds-object-scroll' },
            h('div', { className: 'bds-object-grid' },
              h('div', { className: 'bds-object-main bambook-panel-shadow-viewport' },
                h('div', { className: 'bds-order-stage bds-order-hero-stage' },
                  h('div', { className: 'bds-order-hero-surface' },
                    h('div', { className: 'bds-order-hero-identity' },
                      h('span', { className: 'bds-order-hero-primary' }, 'SO-LAYOUT-044 / 0010')))),
                h(OrderDetailFlow, null, ...areas.map((area, index) =>
                  h(OrderDetailPanel, { key: area, area },
                    h('div', { className: 'bds-order-stage-body' },
                      h('div', { 'data-fixture-body': area, style: { height: bodyHeights[index], flexShrink: 0 } },
                        index === 4 ? null : `${area}：自然内容块`)))))),
              h('aside', null, h(OrderTimelineRail, { active, onChange: navigate, scrollRef,
                allowedAreas: areas, contentKey: 'layout-six-cards' })))),
          h(OrderDetailHeaderFrost), h(OrderDetailFooterFrost)),
        h(OrderDetailFooter, { links: null }));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
    await document.fonts.ready;
  }, legacyPadding);
  await page.waitForSelector('.bds-object-scroll .bds-order-stage');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('.bds-order-stage').count(), 6, 'Fixture must mount all six real card shells');
  const baseline = checkStable(legacyPadding ? 'legacy-padding idle' : 'source CSS idle', await sample());
  const shortCard = await page.evaluate(() => {
    const surface = document.querySelector('#order-area-finance .bds-order-stage-surface');
    return { height: surface.offsetHeight, minimum: parseFloat(getComputedStyle(surface).minHeight) };
  });
  assert.ok(shortCard.minimum > 200 && Math.abs(shortCard.height - shortCard.minimum) < 1,
    'The short final card must depend on the real cqh minimum, not fixed fixture height');

  // Change actual content height asynchronously, exercising the real stage RO.
  await page.evaluate(() => new Promise(resolve => setTimeout(() => {
    document.querySelector('[data-fixture-body="agreement"]').style.height = '940px';
    resolve();
  }, 30)));
  const grown = checkStable('after async content growth', await sample());
  assert.ok(grown.cardHeights[2] > baseline.cardHeights[2] + 300, 'Async content must really increase the agreement card');
  assert.ok(grown.scrollRange > baseline.scrollRange + 300, 'Scroll range must absorb actual content growth');

  // Send real browser wheel input inside the detail scroller, then leave it alone.
  const root = page.locator('.bds-object-scroll');
  const box = await root.boundingBox();
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  await page.mouse.wheel(0, 420);
  const afterWheel = checkStable('after wheel settles', await sample(200));
  assert.ok(afterWheel.scrollTop > grown.scrollTop + 100, 'Shared wheel scroll must still advance');
  await page.locator('#order-tab-finance').click();
  const atFinance = checkStable('last chapter navigation', await sample());
  assert.ok(atFinance.scrollTop > afterWheel.scrollTop, 'Shared timeline must reach the last chapter');
  assert.equal(await page.locator('#order-tab-finance').getAttribute('aria-current'), 'location');
  assert.deepEqual(businessRequests, [], 'Fixture must never request business data');
  assert.deepEqual(errors, [], 'Fixture must run without page exceptions');
  console.log(`PASS: real Chromium + production CSS, renderer and OrderTimelineRail (${legacyPadding ? 'legacy override' : 'source CSS'}); six cards, async growth, wheel, final chapter.`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
