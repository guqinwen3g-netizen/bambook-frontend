const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = path.join(__dirname, '../acceptance-network-guard.cjs');
function probe(code) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-network-guard-'));
  try {
    return spawnSync(process.execPath, ['--require', guard, '-e', code], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_PORT: '55439' },
    });
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
test('allows the test process to call its own ephemeral HTTP server', () => {
  const r = probe("const http=require('node:http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{http.get('http://127.0.0.1:'+s.address().port,r=>{let t='';r.on('data',d=>t+=d);r.on('end',()=>{if(t!=='ok')process.exitCode=1;s.close();});});});");
  assert.equal(r.status, 0, r.stderr);
});
test('allows Supertest-style immediate request before the listening event', () => {
  const r = probe("const http=require('node:http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(0);http.get('http://127.0.0.1:'+s.address().port,r=>{r.resume();r.on('end',()=>s.close());});");
  assert.equal(r.status, 0, r.stderr);
});
test('allows the repository B15 direct loopback binding primitive', () => {
  const r = probe("const http=require('node:http');const s=http.createServer((q,r)=>r.end('ok'));s._listen2('127.0.0.1',0,4,511);http.get('http://127.0.0.1:'+s.address().port,r=>{r.resume();r.on('end',()=>s.close());});");
  assert.equal(r.status, 0, r.stderr);
});
test('blocks the existing development service and external SMTP before connecting', () => {
  for (const [host, port] of [['127.0.0.1', 8081], ['localhost', 5432], ['mail.example.invalid', 587]]) {
    const r = probe(`const assert=require('node:assert/strict');assert.throws(()=>require('node:net').connect({host:${JSON.stringify(host)},port:${port}}),{code:'BAMBOOK_ACCEPTANCE_NETWORK_DENIED'});`);
    assert.equal(r.status, 0, r.stderr);
  }
});
test('blocks fetch as well as raw Node sockets', () => {
  const r = probe("fetch('http://127.0.0.1:8081/').then(()=>{process.exitCode=1},e=>{if(e.cause?.code!=='BAMBOOK_ACCEPTANCE_NETWORK_DENIED')process.exitCode=1});");
  assert.equal(r.status, 0, r.stderr);
});
test('fails closed when launched without isolated environment', () => {
  const r = spawnSync(process.execPath, ['--require', guard, '-e', ''], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires an isolated sandbox/);
});
