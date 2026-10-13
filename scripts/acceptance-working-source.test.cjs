const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { captureWorkingSource } = require('./acceptance-working-source.cjs');
test('captures actual uncommitted source and isolates it from later edits while excluding local data/env/cache', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bambook-source-test-'));
  try {
    const repo=path.join(root,'repo'),workspace=path.join(root,'snapshot');
    fs.mkdirSync(repo); const inputs={ 'App.tsx':'current uncommitted source', 'server/src/index.ts':'server source',
      'server/.env.local':'DO NOT COPY', 'server/data/customer.json':'DO NOT COPY', 'server/prisma/dev.db':'DO NOT COPY',
      'components/node_modules/.cache/generated.js':'DO NOT COPY',
      'pwa/pageZoomGuard.ts':'required frontend runtime', 'test-fixtures/qc-native-scoped-ack-wire.json':'static typed test input' };
    for(const [relative,bytes] of Object.entries(inputs)){fs.mkdirSync(path.dirname(path.join(repo,relative)),{recursive:true});fs.writeFileSync(path.join(repo,relative),bytes);}
    const captured=captureWorkingSource({repo,workspace,relativeFiles:Object.keys(inputs)});
    assert.equal(fs.readFileSync(path.join(workspace,'App.tsx'),'utf8'),inputs['App.tsx']);
    assert.deepEqual(Object.keys(captured.files),['App.tsx','pwa/pageZoomGuard.ts','server/src/index.ts','test-fixtures/qc-native-scoped-ack-wire.json']);
    fs.writeFileSync(path.join(repo,'App.tsx'),'later work');
    assert.equal(fs.readFileSync(path.join(workspace,'App.tsx'),'utf8'),'current uncommitted source');
    assert.equal(captured.sha256.length,64);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('rejects symlinked source and reused destination rather than following a shared checkout', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bambook-source-test-'));
  try {
    const repo=path.join(root,'repo'),workspace=path.join(root,'snapshot');fs.mkdirSync(repo);
    fs.writeFileSync(path.join(root,'external.ts'),'external');fs.symlinkSync(path.join(root,'external.ts'),path.join(repo,'App.tsx'));
    assert.throws(()=>captureWorkingSource({repo,workspace,relativeFiles:['App.tsx']}),/regular repository files/);
    fs.mkdirSync(workspace);assert.throws(()=>captureWorkingSource({repo,workspace,relativeFiles:[]}),/fresh/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
