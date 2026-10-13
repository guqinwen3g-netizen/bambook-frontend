// Isolated acceptance of real shared components; no business writes or live sessions.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'bambook-overlays-'));
const evidence = path.join(root, 'docs/design-system/evidence/overlay-unification-2026-10-12');
await mkdir(evidence, {recursive:true});
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AnimatePresence} from 'framer-motion';
import {BdsDialog} from '/components/ui/BdsDialog.tsx';
import BottomSheet from '/components/ui/BottomSheet.tsx';
import CustomSelect from '/components/ui/CustomSelect.tsx';
import {NotificationCenter,NotificationCenterTrigger} from '/components/NotificationCenter.tsx';
import {apiService} from '/services/apiService.ts';
import {installOverlayMaskCoordinator} from '/components/ui/overlayStack.ts';
import '/index.css';
import '/styles/flat-experimental.css';
import '/styles/bds/overlays.css';
const h=React.createElement;
apiService.getNotificationStats=async()=>({unread:2,total:2,critical:0});
apiService.listNotifications=async()=>({items:window.__emptyNotifications?[]:[{id:'one',type:'order_confirmed',title:'订单已确认',body:'PO-2026-108 · 面料采购订单已确认，交期为 2026-11-03。',createdAt:new Date().toISOString(),read:false},{id:'two',type:'shipment_created',title:'出运计划已更新',body:'上海仓库 · 40 箱货物等待装运。',createdAt:new Date().toISOString(),read:false}],total:window.__emptyNotifications?0:2});
apiService.subscribeToNotifications=()=>()=>{};
apiService.getNotificationTypeCatalog=async()=>[];
installOverlayMaskCoordinator();
function App(){const[theme,T]=React.useState('light'),[dialog,D]=React.useState(''),[sheet,S]=React.useState(false),[nested,N]=React.useState(false),[value,V]=React.useState('one');
window.__theme=t=>{T(t);document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');};
return h('main',{className:'bambook-os-root',style:{minHeight:'100vh',padding:40,background:'var(--bg-page)',color:'var(--text-primary)'}},
h('div',{style:{display:'flex',gap:20,alignItems:'center'}},h('h1',null,'Bambook 浮层验收'),h('button',{onClick:()=>D('default')},'普通弹窗'),h('button',{onClick:()=>D('editorial')},'编辑式弹窗'),h('button',{onClick:()=>S(true)},'抽屉')),
h('p',null,'订单 PO-2026-108　江苏熊猫进出口有限公司　USD 24,600.00'),
h('div',{className:'bds-card',id:'stationary-glass',style:{padding:24,marginTop:32}},'常驻玻璃表面保持原材质'),
h(NotificationCenter,{isDarkMode:theme==='dark'},h(NotificationCenterTrigger,{variant:'header'})),
h(AnimatePresence,null,dialog&&h(BdsDialog,{key:'main',title:'产品与交易约定',variant:dialog,onCancel:()=>D(''),onConfirm:()=>D('')},h('p',null,'面料编号 FAB-2026-021，交期 2026-11-03。'),h(CustomSelect,{ariaLabel:'交付方式',surface:'form',appearance:'line',value,onChange:V,options:[{value:'one',label:'工厂直送'},{value:'two',label:'仓库交付'}]}),h('button',{onClick:()=>N(true)},'打开确认'))),
h(BottomSheet,{isOpen:sheet,onClose:()=>S(false),title:'出运计划',isDarkMode:theme==='dark'},h('p',null,'上海仓库 · 40 箱'),h('button',{onClick:()=>N(true)},'打开确认')),
h(AnimatePresence,null,nested&&h(BdsDialog,{title:'确认当前约定',onCancel:()=>N(false),onConfirm:()=>N(false)},'确认后继续当前流程。')));
}
createRoot(document.getElementById('fixture')).render(h(App));`;
let server,browser;
try {
 server=await createServer({root,configFile:false,cacheDir:path.join(temp,'cache'),plugins:[{name:'overlay-acceptance',resolveId(id){if(id==='virtual:overlay-fixture')return '\0overlay-fixture';},load(id){if(id==='\0overlay-fixture')return entry;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body style="margin:0"><div id="fixture"></div><script type="module" src="/@id/__x00__overlay-fixture"></script></body></html>');});}}],server:{host:'127.0.0.1',port:0,hmr:false,watch:null,fs:{allow:[root,realpathSync(path.join(root,'node_modules'))]}},resolve:{dedupe:['react','react-dom']},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','react-dom','framer-motion','lucide-react']}});
 await server.listen();
 browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 const base=server.resolvedUrls.local[0];
 await page.route('**/*',route=>route.request().url().startsWith(base)||route.request().url().startsWith('data:')?route.continue():route.abort());
 await page.goto(base);await page.getByText('普通弹窗',{exact:true}).waitFor();
 const readings=[];
 const notificationReadings=[];
 for(const theme of ['light','dark']){
  await page.evaluate(t=>window.__theme(t),theme);
  await page.getByText('编辑式弹窗',{exact:true}).click();
  await page.getByRole('dialog',{name:'产品与交易约定'}).waitFor();await page.waitForTimeout(550);await page.evaluate(()=>document.fonts.ready);
  readings.push(await page.evaluate(()=>{const panel=document.querySelector('.bds-modal');const mask=panel.parentElement;const s=getComputedStyle(panel);const probe=document.createElement('div');probe.style.background='var(--bg-card)';document.body.append(probe);const themeSurface=getComputedStyle(probe).backgroundColor;probe.remove();return {themeSurface,theme:document.documentElement.dataset.theme,surface:s.backgroundColor,border:s.border,shadow:s.boxShadow,blur:s.backdropFilter,mask:getComputedStyle(mask).backgroundColor,maskBlur:getComputedStyle(mask).backdropFilter,stationaryBlur:getComputedStyle(document.querySelector('#stationary-glass')).backdropFilter};}));
  await page.screenshot({path:path.join(evidence,'host-dialog-'+theme+'-1440.png')});
  await page.getByRole('button',{name:'交付方式'}).click();await page.waitForTimeout(350);
  const menu=page.locator('.bds-cselect-menu');await menu.waitFor();
  assert.equal(await menu.evaluate(n=>getComputedStyle(n).backdropFilter),'none');
  await page.screenshot({path:path.join(evidence,'host-menu-'+theme+'-1440.png')});
  await page.keyboard.press('Escape');
  await page.getByText('打开确认',{exact:true}).click();await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-bds-backdrop-state="active"]').count(),1);
  assert.equal(await page.locator('[data-bds-backdrop-state="suppressed"]').count(),1);
  assert.deepEqual(await page.locator('[data-bds-backdrop-state="active"]').evaluate(n=>({background:getComputedStyle(n).backgroundColor,blur:getComputedStyle(n).backdropFilter})),{background:'rgba(0, 0, 0, 0)',blur:'blur(4px)'});
  assert.deepEqual(await page.locator('[data-bds-backdrop-state="suppressed"]').evaluate(n=>({background:getComputedStyle(n).backgroundColor,blur:getComputedStyle(n).backdropFilter})),{background:'rgba(0, 0, 0, 0)',blur:'none'});
  await page.screenshot({path:path.join(evidence,'host-nested-'+theme+'-1440.png')});
  await page.keyboard.press('Escape');await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog').count(),1);
  await page.keyboard.press('Escape');await page.waitForTimeout(550);
  await page.getByText('抽屉',{exact:true}).click();await page.waitForTimeout(400);
  await page.getByText('打开确认',{exact:true}).click();await page.waitForTimeout(150);
  await page.keyboard.press('Escape');await page.waitForTimeout(150);
  assert.equal(await page.getByRole('dialog',{name:'出运计划'}).count(),1);
  await page.screenshot({path:path.join(evidence,'host-sheet-'+theme+'-1440.png')});
  await page.keyboard.press('Escape');await page.waitForTimeout(400);
  await page.getByRole('button',{name:/通知/}).click();await page.locator('.bds-notice-row').first().waitFor();await page.waitForTimeout(500);
  assert.equal(await page.locator('.bds-notice-row').first().evaluate(n=>getComputedStyle(n).backdropFilter),'none');
  const notice=await page.locator('.bds-notice-row').first().evaluate(n=>{
   const s=getComputedStyle(n),probe=document.createElement('div');probe.style.boxShadow='var(--bds-shadow-xs)';probe.style.borderRadius='var(--r-card)';document.body.append(probe);const expected=getComputedStyle(probe);const value={theme:document.documentElement.dataset.theme,shadow:s.boxShadow,expectedShadow:expected.boxShadow,radius:s.borderRadius,expectedRadius:expected.borderRadius,surface:s.backgroundColor,transform:s.transform};probe.remove();return value;
  });
  assert.equal(notice.shadow,notice.expectedShadow);assert.equal(notice.radius,notice.expectedRadius);
  notificationReadings.push(notice);
  await page.screenshot({path:path.join(evidence,'host-notifications-'+theme+'-1440.png')});
  await page.locator('.bds-mist-veil').click({position:{x:20,y:200}});await page.waitForTimeout(450);
  await page.evaluate(()=>{window.__emptyNotifications=true;});
  await page.getByRole('button',{name:/通知/}).click();
  await page.getByText('暂无通知',{exact:true}).waitFor();await page.waitForTimeout(450);
  await page.screenshot({path:path.join(evidence,'host-notifications-empty-'+theme+'-1440.png')});
  await page.locator('.bds-mist-veil').click({position:{x:20,y:200}});await page.waitForTimeout(450);
  await page.evaluate(()=>{window.__emptyNotifications=false;});
 }
 await page.setViewportSize({width:800,height:900});
 await page.getByText('普通弹窗',{exact:true}).click();await page.waitForTimeout(200);
 await page.screenshot({path:path.join(evidence,'host-dialog-dark-800.png')});
 assert.ok(readings.every(r=>r.themeSurface!=='rgba(0, 0, 0, 0)'),'Host must expose a solid bg-card theme token');
 assert.ok(readings.every(r=>r.surface===r.themeSurface),'Host overlay surface must follow the active theme bg-card');
 assert.ok(readings.every(r=>r.blur==='none'&&r.mask==='rgba(0, 0, 0, 0)'&&r.maskBlur==='blur(4px)'&&r.stationaryBlur!=='none'));
 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'host-readings.json'),JSON.stringify(readings,null,2));
 await writeFile(path.join(evidence,'notification-readings.json'),JSON.stringify(notificationReadings,null,2));
 console.log('PASS: real Dialog, CustomSelect, BottomSheet and NotificationCenter; light/dark, single transparent 4px background blur, unblurred foreground and suppressed layers, Escape and 800px viewport; stationary glass retained.');
} finally {await browser?.close();await server?.close();await rm(temp,{recursive:true,force:true});}
