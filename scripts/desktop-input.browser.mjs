// Platform input regression, not a business-page or authenticated UI acceptance.
// Uses the actual global CSS and WindowControls; all other controls are fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import { chromium, _electron as electron } from 'playwright';

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'bambook-desktop-input-'));
const evidence = path.join(root, 'docs/design-system/evidence/desktop-input-2026-10-11');
await mkdir(evidence, { recursive: true });
const baseline = process.argv.includes('--baseline');
const hotspotBaseline = process.argv.includes('--hotspot-baseline');
let host, browser, desktop, context, verified = false;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import WindowControls from '/components/WindowControls.tsx';
import '/index.css';
function App(){
 const [selected,setSelected]=React.useState(''),[width,setWidth]=React.useState(220),[open,setOpen]=React.useState(false),[dropped,setDropped]=React.useState(false);
 const start=React.useRef(null);
 return <><WindowControls/><aside className="bds-sidebar" style={{position:'fixed',top:0,left:0,width:64,height:64,zIndex:10}}><button id="toggle" className="bds-sidebar-toggle" aria-label="Fixture sidebar toggle" onClick={()=>setSelected('toggle')}>Toggle</button></aside><main id="surface" style={{padding:'64px 32px 32px',height:'100%',boxSizing:'border-box'}}>
 <h1 style={{fontSize:'var(--text-xl)',fontWeight:300}}>Platform input fixture</h1>
 <label htmlFor="query">Query</label><input id="query" className="bds-input" style={{maxWidth:320}}/>
 <div id="trigger" onClick={()=>setOpen(true)} style={{margin:'16px 0',cursor:'pointer'}}>Custom pointer target</div>
 <output id="selection">{selected}</output>
 <div id="scroll" className="overflow-auto" style={{width:640,height:150,overflow:'auto'}}>
 <table className="bds-table" style={{width:1200}}><thead><tr><th>Reference</th><th>Status</th></tr></thead><tbody>
 {Array.from({length:24},(_,i)=><tr key={i} id={'row-'+i} onClick={()=>setSelected('row-'+i)}><td>Fixture {i+1}</td><td>Ready</td></tr>)}
 </tbody></table></div>
 <div id="resize" style={{width,height:44,background:'var(--bg-panel)',marginTop:16,cursor:'ew-resize'}}
 onPointerDown={e=>{start.current={x:e.clientX,width};e.currentTarget.setPointerCapture(e.pointerId);}}
 onPointerMove={e=>{if(start.current)setWidth(start.current.width+e.clientX-start.current.x);}}
 onPointerUp={e=>{start.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}}
 onPointerCancel={()=>{start.current=null;}}>Pointer-capture resize</div>
 <div id="drag-source" draggable onDragStart={e=>e.dataTransfer.setData('text/plain','fixture')} style={{marginTop:16}}>Drag fixture</div>
 <div id="drop-target" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();setDropped(e.dataTransfer.getData('text/plain')==='fixture');}} style={{padding:16,background:'var(--bg-panel)'}}>{dropped?'Dropped':'Drop target'}</div>
 <iframe id="embedded" title="Offline embedded input" src={location.origin.replace('127.0.0.1','localhost')+'/embedded'} style={{width:400,height:90,marginTop:16}} sandbox="allow-scripts allow-same-origin"/>
 {open&&createPortal(<div id="overlay" role="dialog" aria-label="Fixture dialog" className="fixed inset-0" style={{background:'var(--bg-page)',padding:100,zIndex:100}}><button id="close" onClick={()=>setOpen(false)}>Close</button></div>,document.body)}
 </main></>;
}
createRoot(document.querySelector('#root')).render(<App/>);`;
try {
  host = await createServer({root,configFile:false,cacheDir:path.join(root,'tmp/upstream/desktop-input-vite-cache'),
    plugins:[{name:'offline-input-fixture',resolveId(id){if(id==='virtual:input-fixture')return '\0input-fixture';},async load(id){if(id==='\0input-fixture')return (await transformWithEsbuild(entry,'input-fixture.tsx',{loader:'tsx',jsx:'automatic'})).code;},
      configureServer(server){server.middlewares.use((req,res,next)=>{
        if(req.url==='/embedded'){res.setHeader('Content-Type','text/html');res.end('<button onclick="document.querySelector(\'output\').textContent=\'clicked\'">Embedded button</button><output>ready</output>');return;}
        if(req.url?.startsWith('/fixture')){res.setHeader('Content-Type','text/html');res.end('<html data-theme="light"><head><style>html,body,#root{height:100%;margin:0;}</style></head><body><div id="root"></div><script type="module" src="/@id/__x00__input-fixture"></script></body></html>');return;}
        next();
      });}}],
    esbuild:{loader:'tsx',include:/\0input-fixture|\.[jt]sx?$/,jsx:'automatic'},
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null},
    optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},
  });
  await host.listen();
  const port=host.httpServer.address().port, url=`http://127.0.0.1:${port}`;
  for(const mode of baseline||hotspotBaseline?['electron']:['browser','electron']){
    if(mode==='electron'){
      const mainFile=path.join(temporary,'main.cjs');
      await writeFile(mainFile,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,...(process.platform==='darwin'?{titleBarStyle:'hiddenInset'}:{frame:false}),webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true}});if(process.platform==='darwin')w.setWindowButtonVisibility(false);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.loadURL('about:blank');});`);
      const {ELECTRON_RUN_AS_NODE:_ignored,...env}=process.env;
      desktop=await electron.launch({args:[mainFile],env,timeout:30000});
      context=desktop.context();
      await desktop.firstWindow();
      await context.addInitScript(()=>{
        window.bambook={platform:'darwin',versions:{}};
        window.__windowCalls=[];
        window.bambookWindow={setTrafficLights:async value=>{window.__windowCalls.push(value);},minimize:async()=>{},toggleMaximize:async()=>{},close:async()=>{},isFullScreen:async()=>false,onFullScreenChange:()=>()=>{}};
      });
    }else{
      browser=await chromium.launch();context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
    }
    await context.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!==String(port))return route.abort();
      // Fulfil from the isolated server, as in the appearance fixture; Electron
      // can fail continued optimizer requests under its local-network boundary.
      return route.fulfill({response:await route.fetch()});
    });
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page=mode==='electron'?await desktop.firstWindow():await context.newPage();page.setDefaultTimeout(15000);
    let errors=0;
    page.on('pageerror',error=>console.log('FIXTURE_PAGE_ERROR',error.message.slice(0,240)));
    page.on('console',message=>{if(message.type()==='error'&&errors++<5)console.log('FIXTURE_CONSOLE',message.text().slice(0,240));});
    page.on('requestfailed',request=>{if(errors++<10)console.log('FIXTURE_REQUEST_FAILED',new URL(request.url()).pathname,request.failure()?.errorText);});
    await page.goto(`${url}/fixture`);
    await page.waitForSelector('#row-0');
    const bodyRegion=await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('-webkit-app-region'));
    if(baseline)await page.screenshot({path:path.join(evidence,'electron-before.png')});
    assert.equal(bodyRegion,'no-drag','Business content must not be a native window drag region');
    if(mode==='electron'){
      assert.equal(await page.locator('.electron-top-drag-strip').evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')),'drag');
      assert.equal(await page.getByLabel('Window controls').evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region')),'no-drag');
    }else assert.equal(await page.locator('.electron-top-drag-strip').count(),0);
    if(hotspotBaseline)await page.screenshot({path:path.join(evidence,'electron-hotspot-before.png')});
    assert.ok(await page.evaluate(()=>!!document.elementFromPoint(32,40)?.closest('#toggle')),'Transparent window hot zone covers the collapsed sidebar toggle');
    await page.locator('#toggle').click();assert.equal(await page.locator('#selection').textContent(),'toggle');
    if(mode==='electron'){
      assert.equal(await page.evaluate(()=>window.__windowCalls.at(-1)),false,'Business button hover must not reveal native controls');
      await page.mouse.move(100,8);await page.waitForFunction(()=>window.__windowCalls.at(-1)===true);
      await page.mouse.move(32,40);await page.waitForFunction(()=>window.__windowCalls.at(-1)===false);
    }
    await page.locator('#row-0').click();assert.equal(await page.locator('#selection').textContent(),'row-0');
    await page.locator('#query').fill('Input retained');assert.equal(await page.locator('#query').inputValue(),'Input retained');
    const box=await page.locator('#resize').boundingBox();
    await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+100,box.y+20,{steps:8});await page.mouse.up();
    assert.ok((await page.locator('#resize').boundingBox()).width>290,'Pointer-capture gesture did not resize');
    await page.locator('#drag-source').dragTo(page.locator('#drop-target'));
    assert.equal(await page.locator('#drop-target').textContent(),'Dropped');
    await page.locator('#scroll').hover();await page.mouse.wheel(200,180);
    await page.waitForFunction(()=>{const el=document.querySelector('#scroll');return el.scrollTop>0&&el.scrollLeft>0;});
    await page.locator('#trigger').click();await page.getByRole('dialog').waitFor();await page.locator('#close').click();assert.equal(await page.getByRole('dialog').count(),0);
    const frame=await (await page.waitForSelector('#embedded')).contentFrame();await frame.getByRole('button').click();assert.equal(await frame.locator('output').textContent(),'clicked');
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.screenshot({path:path.join(evidence,`${mode}-${theme}-1440.png`)});
    }
    console.log(`PASS ${mode}: default no-drag, explicit title strip, row click, input, pointer capture, HTML drag/drop, two-axis wheel, portal and cross-origin iframe. CDP input, not OS-native mouse acceptance.`);
    await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await desktop?.close();browser=desktop=context=undefined;
  }
  verified=true;
}finally{
  const deadline=setTimeout(()=>process.exit(verified?0:1),5000);
  await context?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await desktop?.close();await host?.close();
  await rm(temporary,{recursive:true,force:true});clearTimeout(deadline);
}
