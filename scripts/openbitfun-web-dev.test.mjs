// Offline source/HMR acceptance; never connect to the user's backend or accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createWebDevHost } from './openbitfun-web-dev.mjs';

async function unusedPort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function get(port, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    request({ hostname: '127.0.0.1', port, path: '/bambook/status', headers, method }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject).end();
  });
}
const fixtureRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bambook-obf-hmr-')));
const root = path.join(fixtureRoot, 'apps', 'workbench');
await mkdir(root, { recursive: true });
let host, browser;
try {
  const port = await unusedPort(), hmrPort = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await symlink(path.resolve('tmp/upstream/OpenBitFun/src/web-ui/node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'index.html'), '<button id="count">0</button><span id="label"></span><script type="module" src="/main.js"></script>');
  await writeFile(path.join(root, 'label.js'), 'export const label = "before";');
  await writeFile(path.join(root, 'main.js'), `
import { label } from './label.js';
window.__boots = (window.__boots || 0) + 1;
window.__mode = import.meta.env.MODE;
document.querySelector('#label').textContent = label;
document.querySelector('#count').onclick = event => event.target.textContent = String(Number(event.target.textContent) + 1);
if (import.meta.hot) import.meta.hot.accept('./label.js', module => { document.querySelector('#label').textContent = module.label; });
`);
  await writeFile(path.join(root, 'vite.config.mjs'), 'export default { server: { watch: { ignored: ["**/apps/**"] } } };');
  host = await createWebDevHost({ webRoot: root, port, hmrPort, configFile: path.join(root, 'vite.config.mjs'),
    getStatus: async () => ({ state: 'ready', url }),
  });
  const status = await get(port, { Origin: 'http://localhost:3000' });
  assert.equal(status.status, 200);
  assert.equal(status.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(JSON.parse(status.body).state, 'ready');
  assert.equal((await get(port, { Host: 'untrusted.invalid' })).status, 403);
  assert.equal((await get(port, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await get(port, {}, 'POST')).status, 405);
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  // Only Vite's isolated HMR websocket is permitted, no native RPCs.
  await context.routeWebSocket('**/*', socket => {
    if (new URL(socket.url()).port === String(hmrPort)) socket.connectToServer();
    else socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('console', message => { if (message.type() === 'error') console.error('FIXTURE_ERROR', message.text()); });
  page.on('pageerror', error => console.error('FIXTURE_EXCEPTION', error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#label').textContent === 'before');
  await page.locator('#count').click();
  assert.equal(await page.evaluate(() => window.__mode), 'web');
  await writeFile(path.join(root, 'label.js'), 'export const label = "after";');
  await page.waitForFunction(() => document.querySelector('#label').textContent === 'after', { timeout: 10000 });
  assert.equal(await page.locator('#count').textContent(), '1');
  assert.equal(await page.evaluate(() => window.__boots), 1, 'Source update unexpectedly reloaded the page');
  console.log('PASS: loopback/CORS/host/method boundaries, web mode, live source HMR and retained interaction state.');
} finally {
  await browser?.close();
  await host?.close();
  // Only this test's uniquely created fixture directory is removed.
  await rm(fixtureRoot, { recursive: true, force: true });
}
