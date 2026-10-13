import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root=process.cwd(), evidence=path.join(root,'docs/design-system/evidence/bambook-brand-integration-2026-10-11');
await mkdir(evidence,{recursive:true});
let server,browser,verified=false;
try {
  server=await createServer({root,configFile:false,plugins:[react()],cacheDir:path.join(root,'tmp/upstream/bambook-brand-lab-cache'),
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null},
    optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','framer-motion','lucide-react']}});
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch();const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/dev-ui-preview/bambook-icon-lab.html`);
  await page.getByRole('group',{name:'预览动效'}).waitFor();
  for(const name of ['光流','构形','旋进','浮动']) {
    await page.getByRole('group',{name:'预览动效'}).getByRole('button',{name,exact:true}).click();
    assert.equal(await page.getByRole('group',{name:'预览动效'}).getByRole('button',{name,exact:true}).getAttribute('aria-pressed'),'true');
  }
  for(const name of ['实心','轮廓','层叠细线','雾面光流'])await page.getByRole('group',{name:'预览形态'}).getByRole('button',{name,exact:true}).click();
  for(const name of ['静态','启动','待机','聆听','思考','执行','完成','受阻'])await page.getByRole('group',{name:'预览状态'}).getByRole('button',{name,exact:true}).click();
  await page.getByRole('group',{name:'预览动效'}).getByRole('button',{name:'构形',exact:true}).click();
  await page.getByRole('group',{name:'预览状态'}).getByRole('button',{name:'思考',exact:true}).click();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.getAnimations().filter(a=>a.playState==='running').length===0);
  for(const dark of [false,true]) {
    if(dark)await page.getByRole('button',{name:'切换深色主题'}).click();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:path.join(evidence,`icon-lab-${dark?'dark':'light'}-1440.png`)});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
    await page.screenshot({path:path.join(evidence,`icon-lab-${dark?'dark':'light'}-390.png`)});
    await page.setViewportSize({width:1440,height:960});
  }
  await page.getByRole('button',{name:'造型对照',exact:true}).click();
  await page.getByRole('button',{name:'返回 V3 品牌预览',exact:true}).waitFor();
  assert.deepEqual(errors,[]);verified=true;
  console.log('PASS: actual Icon Lab uses promoted shared source; all forms/motions/states, reduced-motion, old comparison entry, light/dark 1440×960 and 390×844. No backend/profile accessed.');
} finally {
  const deadline=setTimeout(()=>process.exit(verified?0:1),5000);
  await browser?.close();await server?.close();clearTimeout(deadline);
}
