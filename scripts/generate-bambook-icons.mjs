// Rasterize the approved V3 solid master once; installed icons are never animated.
import {readFile,writeFile,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'build');
const source=await readFile(path.join(root,'public/brand/bambook-v3-mist-solid.svg'),'utf8');
const start=source.indexOf('>'),end=source.lastIndexOf('</svg>');
const svg=source.slice(0,start+1).replace(/width="200"/,'width="1024"').replace(/height="200"/,'height="1024"')
  +'<defs><clipPath id="bambook-app-boundary"><rect width="200" height="200" rx="44"/></clipPath></defs>'
  // Keep the visible app surface at 80% of its canvas, with transparent Dock margins.
  +'<g data-app-safe-area="true" transform="translate(20 20) scale(.8)"><g clip-path="url(#bambook-app-boundary)">'+source.slice(start+1,end)+'</g></g></svg>';
const mark=await readFile(path.join(root,'public/brand/bambook-v3-mark.svg'),'utf8');
const favicon=mark.replace('><title>','><style>@media (prefers-color-scheme: dark) { :root { fill: #FFFFFF; } }</style><title>');
const previousApp=await readFile(path.join(root,'public/brand/bambook-v3-app.svg'),'utf8');
const imageUrl=value=>`data:image/svg+xml;base64,${Buffer.from(value).toString('base64')}`;
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(os.tmpdir(),'bambook-v3-icons-'));
let browser;
try {
  browser=await chromium.launch();
  const page=await browser.newPage();
  await page.setContent(`<html style="background:transparent"><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="display:block;width:100vw;height:100vh"></body></html>`);
  await page.locator('img').evaluate(image=>image.decode());
  const pngs=new Map();
  for(const size of [16,32,48,64,128,256,512,1024]) {
    await page.setViewportSize({width:size,height:size});
    pngs.set(size,await page.screenshot({omitBackground:true}));
  }
  const rasterMetrics=async size=>page.locator('img').evaluate((image,size)=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,size,size);
    const pixels=ctx.getImageData(0,0,size,size).data;let left=size,top=size,right=-1,bottom=-1;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(pixels[(y*size+x)*4+3]>8){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    return {left,top,right,bottom,corner:pixels[3],center:pixels[(Math.floor(size/2)*size+Math.floor(size/2))*4+3]};
  },size);
  const appBounds=await rasterMetrics(1024);
  assert.ok(appBounds.left>=102&&appBounds.top>=102&&appBounds.right<=922&&appBounds.bottom<=922,JSON.stringify(appBounds));
  await writeFile(path.join(root,'public/brand/bambook-v3-app.svg'),svg);
  await writeFile(path.join(root,'public/brand/bambook-v3-app-32.png'),pngs.get(32));
  await writeFile(path.join(output,'bambook-v3.png'),pngs.get(1024));
  const sizes=[16,32,48,256], header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
  let offset=header.length;
  sizes.forEach((size,index)=>{const entry=6+16*index,png=pngs.get(size);header[entry]=size===256?0:size;header[entry+1]=header[entry];header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(png.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=png.length;});
  await writeFile(path.join(output,'bambook-v3.ico'),Buffer.concat([header,...sizes.map(size=>pngs.get(size))]));
  if(process.platform==='darwin') {
    const iconset=path.join(temporary,'bambook.iconset');await mkdir(iconset);
    for(const [name,size] of [['16x16',16],['16x16@2x',32],['32x32',32],['32x32@2x',64],['128x128',128],['128x128@2x',256],['256x256',256],['256x256@2x',512],['512x512',512],['512x512@2x',1024]])
      await writeFile(path.join(iconset,`icon_${name}.png`),pngs.get(size));
    const icns=path.join(temporary,'bambook.icns');
    execFileSync('iconutil',['-c','icns',iconset,'-o',icns],{windowsHide:true,stdio:'pipe'});
    await copyFile(icns,path.join(output,'bambook-v3.icns'));
  }
  await page.locator('img').evaluate((image,url)=>{image.src=url;return image.decode();},imageUrl(favicon));
  await page.setViewportSize({width:32,height:32});
  const faviconBounds=await rasterMetrics(32);assert.equal(faviconBounds.corner,0);assert.equal(faviconBounds.center,0);assert.ok(faviconBounds.right>faviconBounds.left);
  await writeFile(path.join(root,'public/brand/bambook-v3-favicon.svg'),favicon);
  await writeFile(path.join(root,'public/brand/bambook-v3-favicon-32.png'),await page.screenshot({omitBackground:true}));
  const evidence=path.join(root,'docs/design-system/evidence/bambook-brand-integration-2026-10-11');await mkdir(evidence,{recursive:true});
  await page.setViewportSize({width:720,height:360});
  const tokens=await readFile(path.join(root,'styles/bds/tokens.css'),'utf8');
  await page.setContent(`<html data-theme="light"><head><style>${tokens}body{margin:0;padding:var(--space-8);background:var(--bg-page);color:var(--text-primary);font:var(--font-base)}main{display:flex;gap:var(--space-8);align-items:center}section{display:grid;gap:var(--space-4)}.icons{display:flex;align-items:center;gap:var(--space-4)}</style></head><body><main><section>Dock 原版 · 64px<img width="64" height="64" src="${imageUrl(previousApp)}"></section><section>Dock 留白修正 · 64px<img width="64" height="64" src="${imageUrl(svg)}"></section><section>透明标签图标<div class="icons">${[16,24,32].map(size=>`<img width="${size}" height="${size}" src="${imageUrl(favicon)}">`).join('')}</div></section></main></body></html>`);
  for(const dark of [false,true]){await page.emulateMedia({colorScheme:dark?'dark':'light'});await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));await page.screenshot({path:path.join(evidence,`native-favicon-size-${dark?'dark':'light'}.png`)});}
  await writeFile(path.join(evidence,'native-favicon-size-metrics.json'),JSON.stringify({appBounds,faviconBounds,appSurfaceRatio:.8,viewport:{width:720,height:360},scope:'Isolated real assets, not actual OS Dock or browser chrome'},null,2));
  console.log('PASS: app surface has 10% transparent margins; favicon is ring-only with transparent corner/center; generated PNG/ICO'+(process.platform==='darwin'?'/ICNS':'')+' and light/dark asset evidence.');
} finally {await browser?.close();await rm(temporary,{recursive:true,force:true});}
