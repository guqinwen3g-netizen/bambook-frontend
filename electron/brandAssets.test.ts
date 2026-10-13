import {describe,it,expect} from 'vitest';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {resolveBambookIconPath} from './brandAssets';

describe('V3 installed and development identity',()=>{
  it('resolves source assets in dev and explicitly bundled resources in an install',()=>{
    const base={mainDirectory:'/project/out/main',resourcesPath:'/app/Contents/Resources'};
    expect(resolveBambookIconPath({...base,packaged:false})).toBe('/project/build/bambook-v3.png');
    expect(resolveBambookIconPath({...base,packaged:true})).toBe('/app/Contents/Resources/brand/bambook-v3.png');
  });
  it('wires the real Dock and BrowserWindow to the same generated icon',()=>{
    const source=readFileSync('electron/main.ts','utf8');
    expect(source).toContain('app.dock?.setIcon(iconPath)');
    expect(source).toContain('iconExists ? { icon: iconPath }');
    expect(source).not.toContain('app.dock?.setIcon(BAMBOOK_UI_LAB_ICON_PATH)');
    const config=JSON.parse(readFileSync('package.json','utf8')).build;
    expect(config.mac.icon).toBe('build/bambook-v3.icns');
    expect(config.win.icon).toBe('build/bambook-v3.ico');
    expect(config.linux.icon).toBe('build/bambook-v3.png');
    expect(config.extraResources).toContainEqual({from:'build/bambook-v3.png',to:'brand/bambook-v3.png'});
  });
  it('has real 1024px PNG, multi-size ICO and ICNS assets, not renamed SVGs',()=>{
    const png=readFileSync('build/bambook-v3.png');
    expect(png.subarray(1,4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1024);expect(png.readUInt32BE(20)).toBe(1024);
    const ico=readFileSync('build/bambook-v3.ico');expect(ico.readUInt16LE(2)).toBe(1);expect(ico.readUInt16LE(4)).toBe(4);
    const icns=readFileSync('build/bambook-v3.icns');expect(icns.subarray(0,4).toString()).toBe('icns');expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(readFileSync('public/brand/bambook-v3-app-32.png').readUInt32BE(16)).toBe(32);
  });
  it('keeps native safe-area padding and makes favicon geometry background-free',()=>{
    const app=readFileSync('public/brand/bambook-v3-app.svg','utf8');
    expect(app).toContain('transform="translate(20 20) scale(.8)"');
    const favicon=readFileSync('public/brand/bambook-v3-favicon.svg','utf8');
    const visible=favicon.replace(/<defs>[\s\S]*?<\/defs>/g,'');
    expect(visible).not.toContain('<rect');
    expect(favicon).toContain('prefers-color-scheme: dark');
    expect(readFileSync('public/brand/bambook-v3-favicon-32.png').readUInt32BE(16)).toBe(32);
  });
  it('uses the same favicon in the application and embedded Agent',()=>{
    for(const file of ['index.html','tmp/upstream/OpenBitFun/src/web-ui/index.html']) {
      const html=readFileSync(file,'utf8');
      expect(html).toContain('/brand/bambook-v3-favicon.svg?v=4');
      expect(html).toContain('/brand/bambook-v3-favicon-32.png?v=4');
      expect(html.indexOf('bambook-v3-favicon-32.png')).toBeLessThan(html.indexOf('bambook-v3-favicon.svg'));
    }
  });
});
