import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { brandAssetNames, createBambookBrandPlugin } from './bambook-brand-vite.mjs';

const root=process.cwd(), webRoot=path.join(root,'tmp/upstream/OpenBitFun/src/web-ui');
const require=createRequire(path.join(webRoot,'package.json'));
const {build,loadConfigFromFile}=await import(pathToFileURL(require.resolve('vite')));
const react=(await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))).default;
const {config}=await loadConfigFromFile({command:'build',mode:'web'},path.join(webRoot,'vite.config.ts'));
const ds=path.join(root,'tmp/upstream/OpenBitFun/design-system/packages/ui/src');
const result=await build({root:webRoot,configFile:false,publicDir:false,resolve:config.resolve,
  plugins:[react(),createBambookBrandPlugin({root,designSystemSource:ds}),{
    name:'isolated-brand-build-entry',
    resolveId(id){if(id==='virtual:bambook-brand-build')return '\0bambook-brand-build';},
    load(id){if(id==='\0bambook-brand-build')return `
import {OpenBitFunMark,OpenBitFunBrandMotion} from '@openbitfun/ui/brand';
import {ToolProcessingDots} from ${JSON.stringify(path.join(ds,'flow-chat/tool-cards/ToolProcessingDots.tsx'))};
export {OpenBitFunMark,OpenBitFunBrandMotion,ToolProcessingDots};`;},
  }],
  build:{write:false,minify:false,rollupOptions:{input:'virtual:bambook-brand-build',preserveEntrySignatures:'strict',external:['react','react-dom','react/jsx-runtime']}}
});
const output=Array.isArray(result)?result[0].output:result.output;
for(const name of brandAssetNames)assert.ok(output.some(item=>item.fileName===`brand/${name}`));
const code=output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n');
assert.ok(code.includes('data-bambook-brand'));
assert.ok(code.includes('ToolProcessingDots'));
assert.ok(!code.includes('createConstructionAnimations'), 'Internal tool indicator must not bundle the old OBF motion');
console.log('PASS: actual Agent build-mode aliases bundle the shared V3 mark and internal ToolProcessingDots, and emit all 18 canonical brand assets. Isolated bundle only; not full application/package build.');
