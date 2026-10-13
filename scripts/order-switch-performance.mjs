// Profiles the currently open local Electron order directory; never logs in or writes orders.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const label = process.argv[2] || 'sample';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Use a simple sample label');
const output = path.resolve('docs/design-system/evidence/order-switch-performance-2026-10-11');
mkdirSync(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
try {
  const page = browser.contexts().flatMap(context => context.pages())
    .find(candidate => candidate.url().startsWith('http://localhost:3000/'));
  if (!page) throw new Error('Open the local order detail first');
  if (await page.getByRole('button', { name: '保存修改', exact: true }).count()) {
    throw new Error('Leave editing before profiling; drafts are not discarded');
  }
  if (await page.locator('.bds-fabric-directory-order > button').count() < 6) {
    throw new Error('Open a directory containing at least six orders');
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await page.evaluate(() => {
    window.__orderSwitchPerf = { frames: [], long: [], running: true };
    let previous = performance.now();
    const frame = time => {
      window.__orderSwitchPerf.frames.push(time - previous); previous = time;
      if (window.__orderSwitchPerf.running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__orderSwitchObserver = new PerformanceObserver(list => {
      window.__orderSwitchPerf.long.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })));
    });
    window.__orderSwitchObserver.observe({ type: 'longtask', buffered: false });
  });
  const before = await cdp.send('Performance.getMetrics');
  await cdp.send('Profiler.start');
  const runs = [];
  for (const index of [4, 5, 3, 4]) {
    const start = Date.now();
    await page.locator('.bds-fabric-directory-order > button').nth(index).click({ force: true });
    await page.waitForFunction(() => {
      const edit = [...document.querySelectorAll('.bds-order-stage-header button')].find(button => button.textContent === '编辑订单');
      return edit && !edit.disabled && !document.querySelector('.bds-content-handoff-visual');
    }, {}, { timeout: 20000 });
    runs.push({ index, readyMs: Date.now() - start });
    await page.waitForTimeout(700);
  }
  const { profile } = await cdp.send('Profiler.stop');
  const after = await cdp.send('Performance.getMetrics');
  const observed = await page.evaluate(() => {
    window.__orderSwitchPerf.running = false; window.__orderSwitchObserver.disconnect();
    return window.__orderSwitchPerf;
  });
  const frames = observed.frames.slice(3).sort((a, b) => a - b);
  const metric = Object.fromEntries(after.metrics.map(item => [item.name,
    item.value - (before.metrics.find(previous => previous.name === item.name)?.value || 0)]));
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme }));
  const summary = { label, viewport, runs, frames: { count: frames.length, p95: frames[Math.floor(frames.length * .95)], max: frames.at(-1) }, longTasks: observed.long, metric };
  writeFileSync(path.join(output, `${label}.cpuprofile`), JSON.stringify(profile));
  writeFileSync(path.join(output, `${label}.json`), JSON.stringify(summary, null, 2));
  await page.screenshot({ path: path.join(output, `${label}.png`) });
  console.log(JSON.stringify(summary, null, 2));
  await cdp.detach();
} finally {
  // Disconnect from CDP; leave the user's Electron application running.
  await browser.close();
}
