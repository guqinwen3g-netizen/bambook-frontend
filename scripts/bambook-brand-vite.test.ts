import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { brandAssetNames, createBambookBrandPlugin } from './bambook-brand-vite.mjs';

const root=process.cwd();
const designSystemSource=path.join(root,'tmp/upstream/OpenBitFun/design-system/packages/ui/src');
const plugin=()=>createBambookBrandPlugin({root,designSystemSource});
describe('explicit Bambook brand host adapter',()=>{
  it('overrides brand exports and internal processing indicators, not arbitrary imports',()=>{
    const p=plugin(), adapter=path.join(root,'components/brand/agentBrand.tsx');
    expect(p.resolveId('./brand/OpenBitFunMark',path.join(designSystemSource,'brand.ts'))).toBe(adapter);
    expect(p.resolveId('../../brand/OpenBitFunBrandMotion',path.join(designSystemSource,'flow-chat/tool-cards/ToolProcessingDots.tsx'))).toBe(adapter);
    expect(p.resolveId('./brand/OpenBitFunMark','/unrelated/brand.ts')).toBeUndefined();
    expect(p.resolveId('react',path.join(designSystemSource,'brand.ts'))).toBeUndefined();
  });
  it('emits every static asset for a build, with the 12 final kit exports unchanged',()=>{
    const p=plugin(), emitted:any[]=[];
    p.configResolved({command:'build'});
    p.buildStart.call({emitFile:(asset:any)=>emitted.push(asset)});
    expect(emitted).toHaveLength(18);
    for(const name of brandAssetNames.slice(0,12)){
      expect(readFileSync(path.join(root,'public/brand',name))).toEqual(readFileSync(path.join(root,'dev-ui-preview/brand/final',name)));
    }
    expect(emitted.every(asset=>asset.fileName.startsWith('brand/')&&(asset.fileName.endsWith('.png') ? asset.source.subarray(1,4).toString()==='PNG' : asset.source.toString().includes('<svg')))).toBe(true);
  });
  it('serves only registered assets and only GET/HEAD, without arbitrary filesystem access',()=>{
    const p=plugin();let handle:any;
    p.configureServer({middlewares:{use:(fn:any)=>handle=fn}});
    const headers:any={};let status:number|undefined,body:any,next=0;
    const res={setHeader:(k:string,v:string)=>headers[k]=v,writeHead:(n:number)=>{status=n;return res;},end:(value:any)=>body=value};
    handle({url:'/brand/bambook-v3-deep-solid.svg?cache=1',method:'GET'},res,()=>next++);
    expect(headers['Content-Type']).toBe('image/svg+xml');expect(body.toString()).toContain('<svg');
    handle({url:'/brand/bambook-v3-deep-solid.svg',method:'HEAD'},res,()=>next++);expect(body).toBeUndefined();
    handle({url:'/brand/bambook-v3-deep-solid.svg',method:'POST'},res,()=>next++);expect(status).toBe(405);
    handle({url:'/brand/../../package.json',method:'GET'},res,()=>next++);expect(next).toBe(1);
  });
});
