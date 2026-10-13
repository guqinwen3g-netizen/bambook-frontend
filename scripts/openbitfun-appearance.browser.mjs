// Offline acceptance: real Bambook wrapper + real OBF source UI; all RPCs mocked.
// Never opens the employee browser profile, live backend, or provider accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createSocket } from 'node:net';
import { createServer } from 'vite';
import { chromium, _electron as electron } from 'playwright';
import { createWebDevHost } from './openbitfun-web-dev.mjs';

const root = process.cwd();
const desktop = process.argv.includes('--electron');
const prefix = desktop ? 'electron-' : '';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'bambook-appearance-'));
const evidence = path.join(root, 'docs/design-system/evidence/agent-appearance-2026-10-11');
await mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = createSocket(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
let agent, host, browser, desktopApp, context, verified = false;
const configValues = {
  'ai.models': [], 'ai.default_models': {}, 'ai.proxy': { enabled: false },
  'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
};
try {
  const agentPort = await freePort(), hmrPort = await freePort(), hostPort = await freePort();
  agent = await createWebDevHost({ webRoot: path.join(root, 'tmp/upstream/OpenBitFun/src/web-ui'),
    cacheDir: path.join(root, 'tmp/upstream/openbitfun-appearance-vite-cache'), port: agentPort, hmrPort,
    getStatus: async () => ({ state: 'ready', url: 'http://127.0.0.1:1422' }),
  });
  const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Workspace from '/components/OpenBitFunWorkspace.tsx';
import '/styles/bds/tokens.css';
import '/styles/bds/components.css';
import '/styles/bds/primary-actions.css';
${desktop ? "import '/index.css';" : ''}
window.__fixtureState='ready';
window.bambookOpenBitFun={start:async()=>({state:window.__fixtureState,url:'http://127.0.0.1:1422',error:'Offline fixture unavailable'}),status:async()=>({state:window.__fixtureState,url:'http://127.0.0.1:1422',error:'Offline fixture unavailable'})};
function App(){const[dark,setDark]=React.useState(false); window.__setTheme=value=>{document.documentElement.dataset.theme=value?'dark':'light';setDark(value);};return React.createElement(Workspace,{isDarkMode:dark});}
createRoot(document.querySelector('#fixture')).render(React.createElement(App));`;
  host = await createServer({ root, configFile: false, cacheDir: path.join(root, 'tmp/upstream/openbitfun-appearance-parent-cache'),
    plugins: [{ name: 'offline-workbench-fixture',
      resolveId(id) { if (id === 'virtual:workbench-fixture') return '\0workbench-fixture'; },
      load(id) { if (id === '\0workbench-fixture') return entry; },
    }],
    server: { host: '127.0.0.1', port: hostPort, strictPort: true, hmr: false, cors: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'framer-motion'] },
  });
  await host.listen();
  if (desktop) {
    // Fresh offline profile; same titlebar and renderer security as main.ts.
    // No preload, backend launcher, employee storage, or Bambook business data.
    const mainFile = path.join(temporary, 'main.cjs');
    await writeFile(mainFile, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});
app.whenReady().then(()=>{
 const win=new BrowserWindow({width:1440,height:900,
  ...(process.platform==='darwin'?{titleBarStyle:'hiddenInset'}:{frame:false}),
  webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true}});
 if(process.platform==='darwin')win.setWindowButtonVisibility(false);
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.loadURL('about:blank');
});`);
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    desktopApp = await electron.launch({ args: [mainFile], env, timeout: 30000 });
    context = desktopApp.context();
    await desktopApp.firstWindow();
  } else {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://localhost:3000') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="light"><head><style>html,body{margin:0;height:100%;}#fixture{height:100%;}</style></head><body><main id="fixture"></main><script type="module" src="http://127.0.0.1:${hostPort}/@id/__x00__workbench-fixture"></script></body></html>` });
    }
    if (url.origin === 'http://127.0.0.1:1422') {
      if (/^\/(api|rpc)(\/|$)/.test(url.pathname)) return route.abort();
      const headers = { ...route.request().headers(), host: `127.0.0.1:${agentPort}` };
      if (headers.origin === url.origin) headers.origin = `http://127.0.0.1:${agentPort}`;
      const response = await route.fetch({ url: `http://127.0.0.1:${agentPort}${url.pathname}${url.search}`, headers });
      return route.fulfill({ response });
    }
    if (url.origin === `http://127.0.0.1:${hostPort}`) return route.fulfill({ response: await route.fetch() });
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    if (new URL(socket.url()).port === String(hmrPort)) return socket.connectToServer();
    socket.onMessage(raw => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.id === undefined) return;
      const body = message.params?.request ?? message.params ?? {};
      let result;
      switch (message.method) {
        case 'config/getConfig': result = configValues[body.path] ?? (body.path ? {} : { ai: {models:[],default_models:{},proxy:{enabled:false}}, app:{} }); break;
        case 'config/getConfigs': result = { configs: configValues }; break;
        case 'model/getModels': result = { models: [] }; break;
        case 'agent/getProfiles': result = { profiles: [] }; break;
        case 'list_subscription_accounts': result = []; break;
        case 'initialize_workspace_startup_state': result = { cleanupRemovedCount:0,currentWorkspace:null,recentWorkspaces:[],openedWorkspaces:[],assistantWorkspaces:[],primaryAssistantWorkspaceId:null,legacyRemoteWorkspace:null }; break;
        case 'get_current_workspace': case 'get_primary_assistant_workspace': result = null; break;
        case 'get_recent_workspaces': case 'get_opened_workspaces': case 'get_assistant_workspaces': result = []; break;
        default: socket.send(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Not provided by offline fixture'}})); return;
      }
      socket.send(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    });
  });
  const page = desktop ? await desktopApp.firstWindow() : await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => console.log('OFFLINE_PAGE_ERROR', error.message.slice(0, 180)));
  let diagnosticCount = 0;
  page.on('console', message => { if (message.type() === 'error' && diagnosticCount++ < 12) console.log('OFFLINE_CONSOLE', message.text().slice(0, 220)); });
  page.on('response', response => { if (response.status() >= 400 && diagnosticCount++ < 12) console.log('OFFLINE_HTTP', response.status(), new URL(response.url()).pathname); });
  page.on('requestfailed', request => { if (diagnosticCount++ < 12) console.log('OFFLINE_REQUEST', new URL(request.url()).pathname, request.failure()?.errorText); });
  await page.goto('http://localhost:3000/');
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForSelector('html[data-bambook-host="true"]');
  await frame.waitForSelector('.openbitfun-app-layout');
  if (desktop) {
    const regions = await page.evaluate(() => Object.fromEntries(
      ['body', '.bds-agent-workbench', '.bds-agent-workbench__frame'].map(selector =>
        [selector, getComputedStyle(document.querySelector(selector)).getPropertyValue('-webkit-app-region')])));
    console.log('ELECTRON_APP_REGIONS', JSON.stringify(regions));
    if (process.argv.includes('--capture-baseline')) await page.screenshot({path:path.join(evidence,'electron-before.png')});
    assert.equal(regions.body, 'no-drag', 'Global desktop business content must be interactive by default');
    assert.equal(regions['.bds-agent-workbench'], 'no-drag', 'Workbench must opt out of the native window drag region');
    assert.equal(regions['.bds-agent-workbench__frame'], 'no-drag', 'Cross-origin iframe must receive input');
  }
  await frame.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--openbitfun-font-family-sans').includes('Urbanist'));
  await frame.getByRole('button', { name: /^(More|更多|更多操作)$/ }).first().click({ trial: true });
  await frame.evaluate(() => document.fonts.ready);
  for (const dark of [false, true]) {
    await page.evaluate(value => window.__setTheme(value), dark);
    await frame.waitForFunction(theme => document.documentElement.dataset.bambookTheme === theme, dark ? 'dark' : 'light');
    const geometry = await page.evaluate(() => {
      const a = document.querySelector('#fixture').getBoundingClientRect();
      const b = document.querySelector('iframe').getBoundingClientRect();
      return [Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.width-b.width), Math.abs(a.height-b.height)];
    });
    assert.ok(geometry.every(delta => delta < 1), 'Iframe must fill the host without header or padding');
    const colors = await frame.evaluate(() => {
      const css=getComputedStyle(document.documentElement);
      const surface=document.createElement('div'); surface.style.background='var(--bg-page)';document.body.append(surface);
      const expected=getComputedStyle(surface).backgroundColor;surface.remove();
      return {body:getComputedStyle(document.body).backgroundColor,expected,weight:css.getPropertyValue('--openbitfun-font-weight-regular').trim(),rootSize:css.fontSize,bdsSize:css.getPropertyValue('--text-base').trim(),mode:document.documentElement.dataset.openbitfunAppearanceMode};
    });
    assert.equal(colors.body, colors.expected); assert.equal(colors.weight, '300');
    assert.equal(colors.rootSize, colors.bdsSize); assert.equal(colors.mode, dark ? 'dark' : 'light');
    await page.screenshot({ path:path.join(evidence, `${prefix}workbench-${dark?'dark':'light'}-1440.png`) });
  }
  const before = await page.locator('iframe').evaluate(node => { node.dataset.fixtureIdentity='retained'; return true; });
  assert.equal(before,true);
  await page.evaluate(() => window.__setTheme(false));
  await frame.waitForFunction(() => document.documentElement.dataset.bambookTheme==='light'
    && document.documentElement.dataset.openbitfunAppearanceMode==='light');
  // Let the native Appearance provider commit before opening a transient menu.
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('iframe').getAttribute('data-fixture-identity'),'retained');
  // Exercise the real settings overlay, with no real account configuration.
  await frame.getByRole('button',{name:/^(More|更多|更多操作)$/}).first().click();
  await frame.getByText(/^(Open settings|打开设置|配置 OpenBitFun|设置)$/).click();
  await page.screenshot({path:path.join(evidence,`${prefix}settings-light-1440.png`)});
  await page.evaluate(() => window.__setTheme(true));
  await frame.waitForFunction(() => document.documentElement.dataset.bambookTheme==='dark');
  await page.screenshot({path:path.join(evidence,`${prefix}settings-dark-1440.png`)});
  await page.setViewportSize({width:800,height:900});
  await page.screenshot({path:path.join(evidence,`${prefix}settings-dark-800.png`)});
  verified = true;
  console.log(`PASS: ${desktop ? 'Electron/global drag CSS' : 'Chromium'}, actual wrapper/full source UI, full canvas, BDS colors/weight, theme switching without remount, settings interaction and narrow viewport. All RPCs isolated; not full-shell or OS-native mouse acceptance.`);
} finally {
  // Vite can wait indefinitely for an interrupted first-start optimizer.
  // The enclosing process-family guard cleans remaining owned workers on exit.
  const deadline = setTimeout(() => process.exit(verified ? 0 : 1), 5000);
  await context?.unrouteAll({ behavior: 'ignoreErrors' });
  await browser?.close();
  await desktopApp?.close();
  await Promise.all([host?.close(), agent?.close()]);
  clearTimeout(deadline);
  await rm(temporary,{recursive:true,force:true});
}
