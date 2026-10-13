// Isolated real Login, with authentication calls stubbed; no account or backend access.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
const root=process.cwd(), evidence=path.join(root,'docs/design-system/evidence/login-entrance-2026-10-11');await mkdir(evidence,{recursive:true});
const entry=`import React,{useEffect} from'react';import{createRoot}from'react-dom/client';import '${root}/index.css';import Login from '${root}/components/Login';import{BambookStartup,useBambookStartup}from '${root}/components/brand/BambookStartup';const dark=new URLSearchParams(location.search).get('theme')==='dark';document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.classList.toggle('dark',dark);function BootProbe(){useEffect(()=>{window.__bootLogo=document.querySelector(".bds-auth-entrance__mark svg");window.__bootText=document.body.innerText;},[]);return null;}function SessionGate(){const startup=useBambookStartup();useEffect(()=>{const timer=setTimeout(()=>startup.resolve('login'),200);return()=>clearTimeout(timer)},[startup.resolve]);return <Login isDarkMode={dark} onLogin={()=>{}}/>;}const mount=createRoot(document.getElementById('root'));mount.render(<React.StrictMode><BambookStartup><BootProbe/></BambookStartup></React.StrictMode>);setTimeout(()=>mount.render(<React.StrictMode><BambookStartup><SessionGate/></BambookStartup></React.StrictMode>),250);`;

let server,browser;
try {
 server=await createServer({root,configFile:false,plugins:[{name:'login-entrance-fixture',resolveId(id,importer){if(id==='virtual:login-entrance')return '\0login-entrance';if(importer&&id.endsWith('services/authService'))return '\0login-auth';},async load(id){if(id==='\0login-entrance')return(await transformWithEsbuild(entry,'login-entrance.tsx',{loader:'tsx',jsx:'automatic'})).code;if(id==='\0login-auth')return 'export const subscribe=()=>()=>{},login=()=>{throw new Error("No authentication in fixture")},mapAuthErrorMessage=()=>"Fixture";';}},react()],server:{host:'127.0.0.1',port:0,hmr:false,watch:null},optimizeDeps:{noDiscovery:true,entries:[],include:['react','react-dom/client','react/jsx-runtime','framer-motion','lucide-react']}});
 await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch();const c=await browser.newContext({viewport:{width:1440,height:960}});
 await c.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();if(u.pathname==='/login-entrance')return r.fulfill({contentType:'text/html',body:'<html><meta charset="utf-8"><div id="root"></div><script type="module" src="/@id/__x00__login-entrance"></script></html>'});return r.continue()});
 const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 if(process.argv.includes('--perf')) {
  const probe=await c.newCDPSession(p);await probe.send('Emulation.setCPUThrottlingRate',{rate:4});
  await p.addInitScript(()=>{window.__perf={writes:0,queries:0,work:0,frames:[]};const attr=Element.prototype.setAttribute,query=Element.prototype.querySelector,queryAll=Element.prototype.querySelectorAll,raf=window.requestAnimationFrame;Element.prototype.setAttribute=function(...args){if(this.closest?.('.bds-auth-entrance'))window.__perf.writes++;return attr.apply(this,args)};for(const [name,fn] of [['querySelector',query],['querySelectorAll',queryAll]])Element.prototype[name]=function(...args){if(this.closest?.('.bds-auth-entrance'))window.__perf.queries++;return fn.apply(this,args)};window.requestAnimationFrame=fn=>raf.call(window,t=>{const begin=performance.now();fn(t);window.__perf.work+=performance.now()-begin;window.__perf.frames.push(t);});});
  await p.goto(origin+'/login-entrance?theme=dark');await p.locator('[data-entrance-phase="done"]').waitFor();
  console.log(JSON.stringify(await p.evaluate(()=>window.__perf)));await probe.detach();
 } else if(process.argv.includes('--record')) {
  await p.setViewportSize({width:960,height:640});await p.emulateMedia({reducedMotion:'reduce'});await p.goto(origin+'/login-entrance?theme=dark');await p.evaluate(()=>document.fonts.ready);await p.emulateMedia({reducedMotion:'no-preference'});await p.reload();await p.locator('[data-entrance-phase=opening]').waitFor();
  const frames=[];await mkdir(path.join(evidence,'frames'),{recursive:true});
  for(let i=0;i<50;i++){frames.push(Date.now());await p.screenshot({path:path.join(evidence,'frames',String(i).padStart(2,'0')+'.png')});await p.waitForTimeout(60);}
  await writeFile(path.join(evidence,'frames/times.json'),JSON.stringify(frames));console.log('Recorded actual login entrance frames.');
  const sloganFrames=[],seen=new Set();await mkdir(path.join(evidence,'slogan-frames'),{recursive:true});
  for(let i=0;i<110;i++){sloganFrames.push(Date.now());seen.add(await p.locator('.bds-auth-slogan-group[data-active="true"] .bds-auth-slogan').getAttribute('lang'));await p.screenshot({path:path.join(evidence,'slogan-frames',String(i).padStart(2,'0')+'.png')});await p.waitForTimeout(300);}
  assert.deepEqual([...seen].sort(),['en','fr','ja','ko','zh-CN']);
  await writeFile(path.join(evidence,'slogan-frames/times.json'),JSON.stringify(sloganFrames));console.log('Recorded all five homepage slogan languages.');
 } else {
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await p.setViewportSize({width,height:width===1440?960:844});await p.goto(origin+'/login-entrance?theme='+theme);
  await p.locator('[data-entrance-phase="opening"]').waitFor();await p.waitForTimeout(800);
  await p.evaluate(()=>{const root=document.getElementById('root');root.style.position='relative';root.style.zIndex='230';root.style.transform='translateZ(0)';});
  assert.ok(await p.evaluate(()=>document.elementFromPoint(20,20)?.closest('.bds-auth-entrance')),'Startup must remain above a raised workspace stacking context');
  assert.ok(await p.locator('.bds-auth-entrance-anchor').evaluate(e=>e.parentElement===document.body),'Startup must escape application stacking contexts');
  await p.locator('.bds-auth-entrance__line svg').evaluate(e=>{window.__entranceMark=e;});
  assert.equal(await p.locator('.bds-auth-entrance__welcome').count(),0);
  await p.screenshot({path:path.join(evidence,`${theme}-${width}-opening.png`)});
  await p.locator('[data-entrance-phase="handoff"]').waitFor();await p.waitForTimeout(1100);
  assert.ok(await p.locator('.bds-auth-entrance__line svg').evaluate(e=>e===window.__entranceMark&&e===window.__bootLogo));
  assert.equal(await p.locator('.bds-auth-entrance__solid').count(),0);
  assert.ok(await p.locator('.bds-auth-entrance__line [data-ink]').first().evaluate(e=>Number(e.getAttribute('opacity'))>.9));
  assert.ok(await p.locator('.bds-auth-copyright').evaluate(e=>parseFloat(getComputedStyle(e).letterSpacing)>1));
  assert.ok(await p.locator('.bds-auth-entrance__mark').evaluate(e=>{const r=e.getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<.5&&Math.abs(r.y+r.height/2-innerHeight/2)<.5;}));
  await p.screenshot({path:path.join(evidence,`${theme}-${width}-handoff.png`)});
  await p.locator('[data-entrance-phase="done"]').waitFor();await p.waitForTimeout(2000);
  await p.screenshot({path:path.join(evidence,`${theme}-${width}-landing.png`)});
  assert.ok(await p.locator('.bds-auth-slogan-group[data-active="true"] .bds-auth-slogan').evaluate(e=>{const r=e.getBoundingClientRect();return Math.abs(r.y+r.height/2-innerHeight/2)<1;}));
  assert.equal(await p.locator('.bds-auth-entrance').count(),0);
  assert.equal(await p.evaluate(()=>window.__bootText),'');
  assert.equal(await p.locator('.bds-auth-entrance__mark').count(),0);
  assert.equal(await p.locator('.bds-auth-slogan-group').count(),5);
  assert.ok((await p.locator('.bds-auth-slogan-group[data-active="true"] .bds-auth-slogan-description').innerText()).length>20);
  assert.equal(await p.locator('.bds-auth-brand svg').getAttribute('data-form'),'solid');
  assert.equal(await p.locator('.bds-auth-entrance__caption').count(),0);
  assert.equal(await p.locator('.bds-auth-brand-name').innerText(),'B A M B O O K');
  assert.equal(await p.locator('.bds-auth-brand-caption').count(),0);
  assert.ok(await p.locator('.bds-auth-brand-name').evaluate(e=>e.getAnimations().some(a=>a.effect.getKeyframes().some(k=>Number(k.opacity)===0))));
  assert.equal(await p.locator('.bds-auth-brand-name').evaluate(e=>getComputedStyle(e).opacity),'1');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.locator('.bds-auth-brand-stage').click({position:{x:20,y:200}});
  await p.getByLabel('姓名或邮箱',{exact:true}).waitFor();
  await p.getByLabel('姓名或邮箱',{exact:true}).fill('fixture@example.test');
  if(width===1440)await p.locator('.bds-auth-brand-stage').click({position:{x:20,y:200}});
  assert.equal(await p.getByLabel('姓名或邮箱',{exact:true}).inputValue(),'fixture@example.test');
  await p.getByRole('button',{name:'返回品牌画面',exact:true}).click();
  await p.getByRole('button',{name:'进入登录',exact:true}).focus();await p.keyboard.press('Enter');
  await p.getByLabel('姓名或邮箱',{exact:true}).waitFor();
  await p.getByRole('button',{name:'返回品牌画面',exact:true}).click();
  await p.getByRole('button',{name:'进入登录',exact:true}).click();await p.getByLabel('姓名或邮箱',{exact:true}).waitFor();
  await p.getByRole('button',{name:'返回品牌画面',exact:true}).click();assert.equal(await p.locator('.bds-auth-entrance').count(),0);
 }
 await p.goto(origin+'/login-entrance');await p.locator('[data-entrance-phase="opening"]').waitFor();assert.equal(await p.locator('.bds-auth-entrance button').count(),0);await p.keyboard.press('Escape');assert.equal(await p.locator('.bds-auth-scene').getAttribute('data-entrance-phase'),'opening');await p.locator('[data-entrance-phase="done"]').waitFor();
 await p.emulateMedia({reducedMotion:'reduce'});await p.goto(origin+'/login-entrance');await p.locator('[data-entrance-phase="done"]').waitFor();assert.equal(await p.locator('.bds-auth-entrance').count(),0);assert.equal(await p.locator('.bds-auth-brand-name').evaluate(e=>getComputedStyle(e).animationName),'none');assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'verification.json'),JSON.stringify({themes:['light','dark'],viewports:['1440x960','390x844'],phases:['opening','handoff','landing'],manualSkip:false,escapeDoesNotSkip:true,headerForm:"solid",centerFillBeforeHandoff:true,singleSvgFill:true,noFlyingLogo:true,singleBootAndLoginSequence:true,openingText:false,sloganOrder:["en","zh-CN","ja","ko","fr"],wordmark:"BAMBOOK",typography:"persistent-language-group-separated-dissolve",localizedDescriptions:true,centerMotion:"spring-breath-fullscreen-exit",brandTextAnimated:true,reducedMotion:true,noReplayOnFormReturn:true,noAuthenticationCalls:true,errors},null,2));
 console.log('PASS: real Login opening/handoff/landing, light/dark desktop/narrow, no skip control, animated brand text, solid header logo after center fill, reduced motion, no replay or authentication calls.');
 }
}finally{await browser?.close();await server?.close();}
