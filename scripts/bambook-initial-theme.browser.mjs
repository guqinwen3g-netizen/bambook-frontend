// Offline acceptance: real Bambook wrapper + real OBF source UI; all RPCs mocked.
// Never opens the employee browser profile, live backend, or provider accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
const evidence = path.join(root, 'docs/design-system/evidence/agent-initial-theme-2026-10-12');
await mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = createSocket(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
let agent, host, browser, desktopApp, context, verified = false;
let mainGate = Promise.resolve(), releaseMain = () => {};
const configValues = {
  'ai.models': [], 'ai.default_models': {}, 'ai.proxy': { enabled: false },
  'ai.stream_idle_timeout_secs': 120, 'ai.stream_ttft_timeout_secs': 60,
};
try {
  const agentPort = await freePort(), hmrPort = await freePort(), hostPort = await freePort();
  agent = await createWebDevHost({ webRoot: path.join(root, 'tmp/upstream/OpenBitFun/src/web-ui'),
    cacheDir: path.join(root, 'tmp/upstream/openbitfun-appearance-vite-cache'), port: agentPort, hmrPort,
    getStatus: async () => ({ state: 'ready', url: 'http://127.0.0.1:1422' }),
    plugins: [{ name: 'offline-font-realpaths', async config() { return {server:{fs:{allow: await Promise.all(['harmonyos-sans-sc-webfont-splitted','@fontsource/urbanist','@fontsource/jetbrains-mono'].map(name=>realpath(path.join(root,'node_modules',name))))}}}; } }],
  });
  const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Workspace from '/components/OpenBitFunWorkspace.tsx';
import BdsDialog from '/components/ui/BdsDialog.tsx';
import {installOverlayMaskCoordinator} from '/components/ui/overlayStack.ts';
installOverlayMaskCoordinator();
import '/styles/bds/overlays.css';
import '/styles/bds/tokens.css';
import '/styles/bds/components.css';
import '/styles/bds/primary-actions.css';
${desktop ? "import '/index.css';" : ''}
window.__fixtureState='ready';
window.bambookOpenBitFun={start:async()=>({state:window.__fixtureState,url:'http://127.0.0.1:1422',error:'Offline fixture unavailable'}),status:async()=>({state:window.__fixtureState,url:'http://127.0.0.1:1422',error:'Offline fixture unavailable'})};
function App(){const[dark,setDark]=React.useState(new URLSearchParams(location.search).get('hostTheme')==='dark');const[mounted,setMounted]=React.useState(true);window.__setMounted=setMounted;const[hostOverlay,setHostOverlay]=React.useState(false);window.__setHostOverlay=setHostOverlay; window.__setTheme=value=>{document.documentElement.dataset.theme=value?'dark':'light';setDark(value);};return React.createElement(React.Fragment,null,mounted?React.createElement(Workspace,{isDarkMode:dark}):null,hostOverlay?React.createElement(BdsDialog,{title:'主系统浮层',onConfirm:()=>setHostOverlay(false)},'跨窗口遮罩验证'):null);}
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
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${url.searchParams.get('hostTheme')==='dark'?'dark':'light'}"><head><style>html,body{margin:0;height:100%;color:var(--text-primary);font:var(--font-base);}#fixture{height:100%;}</style></head><body><main id="fixture"></main><script type="module" src="http://127.0.0.1:${hostPort}/@id/__x00__workbench-fixture"></script></body></html>` });
    }
    if (url.origin === 'http://127.0.0.1:1422') {
      if (/^\/(api|rpc)(\/|$)/.test(url.pathname)) return route.abort();
      if(url.pathname==='/src/main.tsx') await mainGate;
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
  await context.addInitScript(() => {
    if (location.origin !== 'http://127.0.0.1:1422') return;
    window.__themeSamples = [];
    window.__holdAppearance = true;
    addEventListener('message', e => {
      if (window.__holdAppearance && e.data?.type === 'bambook:appearance') e.stopImmediatePropagation();
    }, true);
    let count = 0;
    const sample = () => {
      if (!document.documentElement) return requestAnimationFrame(sample);
      const root = document.documentElement;
      window.__themeSamples.push({time:performance.now(),theme:root.dataset.bambookTheme,scheme:root.dataset.colorScheme,bg:getComputedStyle(root).backgroundColor,app:!!document.querySelector('.openbitfun-app-layout')});
      if (++count < 1800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror',error=>console.error('PAGE ERROR',error.message));
  const results=[];
  for (const initial of ['light','dark']) {
    const system=initial==='light'?'dark':'light';
    await page.emulateMedia({colorScheme:system});
    mainGate=new Promise(resolve=>{releaseMain=resolve;});
    console.log('Starting',initial);
    await page.goto('http://localhost:3000/?hostTheme='+initial,{waitUntil:'commit'});
    const element=await page.waitForSelector('iframe');
    let frame=await element.contentFrame();
    console.log('Frame ready',frame.url());
    await frame.waitForFunction(t=>document.documentElement.dataset.bambookTheme===t,initial);
    console.log('Initial theme set');
    await frame.waitForFunction(()=>performance.getEntriesByType('paint').some(e=>e.name==='first-paint'));
    const early=await frame.evaluate(()=>({theme:document.documentElement.dataset.bambookTheme,bg:getComputedStyle(document.documentElement).backgroundColor,paints:performance.getEntriesByType('paint').map(e=>({name:e.name,time:e.startTime})),samples:window.__themeSamples}));
    assert.equal(early.bg,initial==='light'?'rgb(236, 241, 245)':'rgb(20, 35, 47)');
    await page.screenshot({path:path.join(evidence,'bootstrap-'+initial+'-system-'+system+'.png')});
    releaseMain();
    await frame.waitForSelector('.openbitfun-app-layout');
    await frame.waitForTimeout(700);
    const first=await frame.evaluate(()=>({theme:document.documentElement.dataset.bambookTheme,bg:getComputedStyle(document.documentElement).backgroundColor,samples:window.__themeSamples}));
    assert.equal(first.theme,initial);
    const fcp=early.paints.find(p=>p.name==='first-paint').time;
    assert.ok(first.samples.some(s=>s.time>=fcp),'Samples include painted frames');
    assert.ok(first.samples.filter(s=>s.time>=fcp).every(s=>s.theme===initial && s.bg===early.bg),'No wrong-theme painted frame during bootstrap or app mount');
    await page.screenshot({path:path.join(evidence,'first-content-'+initial+'-system-'+system+'.png')});
    await frame.evaluate(()=>{window.__holdAppearance=false;});
    await frame.evaluate(()=>{window.__documentIdentity='retained';});
    await page.evaluate(()=>{window.__originalIframe=document.querySelector('iframe');});
    const changed=system;
    await page.evaluate(t=>window.__setTheme(t==='dark'),changed);
    await frame.waitForFunction(t=>document.documentElement.dataset.bambookTheme===t,changed);
    assert.equal(await frame.evaluate(()=>new URL(location.href).searchParams.get('bambookTheme')),changed);
    assert.equal(await page.evaluate(()=>window.__originalIframe===document.querySelector('iframe')),true);
    assert.equal(await frame.evaluate(()=>window.__documentIdentity),'retained','Theme toggle retains the conversation document');
    await Promise.all([frame.waitForNavigation({waitUntil:'domcontentloaded'}),frame.evaluate(()=>location.reload())]);
    await frame.waitForFunction(t=>document.documentElement.dataset.bambookTheme===t,changed);
    await frame.waitForSelector('.openbitfun-app-layout');
    assert.equal(await frame.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),changed==='light'?'rgb(236, 241, 245)':'rgb(20, 35, 47)');
    await page.screenshot({path:path.join(evidence,'refresh-'+changed+'.png')});
    await page.evaluate(()=>window.__setMounted(false));
    await page.waitForSelector('iframe',{state:'detached'});
    await page.evaluate(()=>window.__setMounted(true));
    frame=await(await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForSelector('.openbitfun-app-layout');
    assert.equal(await frame.evaluate(()=>document.documentElement.dataset.bambookTheme),changed);
    await page.screenshot({path:path.join(evidence,'reentry-'+changed+'.png')});
    results.push({host:initial,system,early,first,changed,refresh:'pass',reentry:'pass',noRemountOnToggle:true});
  }
  await writeFile(path.join(evidence,'first-paint-measurements.json'),JSON.stringify(results,null,2));
  verified=true;
  console.log('PASS: opposite host/system themes, bootstrap before main module and with appearance messages withheld; no wrong-theme painted frame, dynamic switch without remount, child refresh and reentry.');

} finally {
  releaseMain();
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
