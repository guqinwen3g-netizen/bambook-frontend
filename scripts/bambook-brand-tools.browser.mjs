// Actual production tool-card views, no live Agent, filesystem calls or account profile.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {chromium,_electron as electron} from 'playwright';
import {transformWithEsbuild} from 'vite';
import {createWebDevHost} from './openbitfun-web-dev.mjs';
const root=process.cwd(), desktop=process.argv.includes('--electron');
const evidence=path.join(root,'docs/design-system/evidence/bambook-brand-integration-2026-10-11');
await mkdir(evidence,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'bambook-tool-brand-'));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
let server,browser,desktopApp,verified=false;
try {
  const port=await freePort(), hmrPort=await freePort(), origin=`http://127.0.0.1:${port}`;
  const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DesignSystemProvider} from '@openbitfun/ui';
import {FileOperationToolCard,ReadFileToolCard} from '@openbitfun/ui/flow-chat';
import {ToolCapsulePresentationProvider} from ${JSON.stringify(path.join(root,'tmp/upstream/OpenBitFun/design-system/packages/ui/src/flow-chat/tool-cards/ToolCapsulePresentation.tsx'))};
import '@openbitfun/ui/styles.css';import '/src/design-system-theme.css';import '@bambook/agent-theme';
function App(){const[status,setStatus]=React.useState('running');window.__toolStatus=setStatus;window.__theme=dark=>{const d=document.documentElement;d.dataset.bambookTheme=dark?'dark':'light';d.dataset.openbitfunAppearanceMode=dark?'dark':'light';d.dataset.colorScheme=dark?'dark':'light';};
return <DesignSystemProvider><main style={{padding:32,maxWidth:960,margin:'auto',display:'grid',gap:24}}>
<FileOperationToolCard operation="edit" path="samples/specification.txt" pathLabel="样品说明.txt" actionLabel={status==='running'?'正在编辑':'编辑文件'} status={status}/>
<ReadFileToolCard action={status==='running'?'正在查阅':'查阅文件'} content="订单附件.csv" status={status}/>
<ToolCapsulePresentationProvider value={{label:'查阅',description:'查阅订单附件.csv',statusLabel:status==='running'?'正在查阅':'已完成',status,expanded:false,onExpandedChange:()=>{}}}><ReadFileToolCard action="查阅" content="订单附件.csv" status={status}/></ToolCapsulePresentationProvider>
</main></DesignSystemProvider>}
createRoot(document.querySelector('#tools')).render(<App/>);`;
  server=await createWebDevHost({webRoot:path.join(root,'tmp/upstream/OpenBitFun/src/web-ui'),port,hmrPort,
    cacheDir:path.join(root,'tmp/upstream/bambook-tools-vite-cache'),getStatus:async()=>({state:'ready'}),plugins:[{
      name:'offline-production-tool-brand',resolveId(id){if(id==='virtual:tool-brand')return '\0tool-brand.tsx';},
      async load(id){if(id==='\0tool-brand.tsx')return transformWithEsbuild(entry,'tool-brand.tsx',{loader:'tsx',jsx:'automatic'});},
      configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/tool-brand-fixture')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/tool-brand-fixture','<html data-bambook-host="true" data-bambook-theme="light" data-openbitfun-appearance-mode="light" data-color-scheme="light"><head><!-- OPENBITFUN_FONT_PROFILE_STYLESHEET --></head><body style="margin:0"><div id="tools"></div><script type="module" src="/@id/__x00__tool-brand.tsx"></script></body></html>'));});},
    }]});
  let context,page;
  if(desktop){const main=path.join(temporary,'main.cjs');await writeFile(main,`
const {app,BrowserWindow,nativeImage}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary,'profile'))});
app.whenReady().then(()=>{const icon=${JSON.stringify(path.join(root,'build/bambook-v3.png'))};if(nativeImage.createFromPath(icon).getSize().width!==1024)throw new Error('Invalid V3 icon');app.setName('Bambook Brand Verification');app.dock?.setIcon(icon);const w=new BrowserWindow({width:1440,height:900,icon,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.loadURL('about:blank');});`);
    const {ELECTRON_RUN_AS_NODE:_ignored,...env}=process.env;desktopApp=await electron.launch({args:[main],env});context=desktopApp.context();page=await desktopApp.firstWindow();
  }else{browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});page=await context.newPage();}
  page.setDefaultTimeout(20000);
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  page.on('console',message=>{if(message.type()==='error')console.error('FIXTURE_CONSOLE',message.text());});
  page.on('response',response=>{if(response.status()>=400)console.error('FIXTURE_HTTP',response.status(),response.url());});
  page.on('requestfailed',request=>console.error('FIXTURE_REQUEST',request.url(),request.failure()?.errorText));
  await context.route('**/*',async route=>{
    if(new URL(route.request().url()).origin===origin)return route.fulfill({response:await route.fetch()});
    console.error('FIXTURE_BLOCKED',route.request().url());return route.abort();
  });
  await context.routeWebSocket('**/*',socket=>new URL(socket.url()).port===String(hmrPort)?socket.connectToServer():socket.close());
  await page.goto(`${origin}/tool-brand-fixture`);
  await page.waitForSelector('[data-bambook-brand]').catch(async error=>{console.error('FIXTURE_BODY',await page.locator('body').innerText());throw error;});
  const marks=page.locator('[data-bambook-brand]');assert.equal(await marks.count(),3);
  for(const dark of [false,true]) {
    await page.evaluate(dark=>window.__theme(dark),dark);
    await page.waitForTimeout(250);
    for(const mark of await marks.all()){
      assert.equal(await mark.getAttribute('data-palette'),'inherit');
      assert.equal(await mark.locator('svg').getAttribute('data-motion'),'construct');
      assert.equal(await mark.locator('[data-guide]').count(),0);
    }
    const first=marks.first().locator('[data-morph-leaf] path').first(), before=await first.getAttribute('d');
    await page.waitForTimeout(240);assert.notEqual(await first.getAttribute('d'),before);
    await page.screenshot({path:path.join(evidence,`${desktop?'electron':'browser'}-executing-tools-${dark?'dark':'light'}.png`)});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(200);
  const still=await marks.first().locator('[data-morph-leaf] path').first().getAttribute('d');await page.waitForTimeout(200);
  assert.equal(await marks.first().locator('[data-morph-leaf] path').first().getAttribute('d'),still);
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const status of ['completed','error','queued','pending_confirmation']){
    await page.evaluate(s=>window.__toolStatus(s),status);await page.waitForTimeout(100);assert.equal(await marks.count(),0,`No construction animation for ${status}`);
  }
  assert.deepEqual(errors,[]);verified=true;
  console.log(`PASS: ${desktop?'Electron + native V3 icon':'Chromium'} actual edit/read/capsule tool cards; construction only while executing, no ghost paths, real frame changes, reduced-motion, completed/error/queued/approval stop. Offline views only.`);
} finally {
  const deadline=setTimeout(()=>process.exit(verified?0:1),5000);
  await browser?.close();await desktopApp?.close();await server?.close();clearTimeout(deadline);await rm(temporary,{recursive:true,force:true});
}
