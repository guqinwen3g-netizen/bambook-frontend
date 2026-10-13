import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { OPENBITFUN_REVISION, OpenBitFunRuntime, createWorkbenchHost, resolveAsset, runtimeHealth, processFamily, spawnGuarded } from './openbitfun-runtime.mjs';

let temp: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (temp) { await rm(temp, { recursive: true, force: true }); temp = undefined; }
});
async function fixture() {
  temp = await mkdtemp(path.join(os.tmpdir(), 'bambook-openbitfun-test-'));
  const web = path.join(temp, 'web');
  await mkdir(web);
  await writeFile(path.join(web, 'index.html'), '<h1>asset fixture</h1>');
  return web;
}
function get(port: number, url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; body: string; headers: any }>((resolve, reject) => {
    request({ hostname: '127.0.0.1', port, path: url, headers, method }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    }).on('error', reject).end();
  });
}
describe('OpenBitFun resource safety', () => {
  it('counts nested descendants and the inherited process group, not unrelated apps', () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10, rss: 10 },
      { pid: 12, ppid: 11, pgid: 12, rss: 30 },
      { pid: 11, ppid: 10, pgid: 11, rss: 20 },
      { pid: 13, ppid: 1, pgid: 10, rss: 40 },
      { pid: 99, ppid: 1, pgid: 99, rss: 900 },
    ];
    expect(processFamily(rows, 10).map(row => row.pid)).toEqual([10, 12, 11, 13]);
  });
  it('rejects unbounded or invalid budgets before launching a process', async () => {
    for (const options of [{ maxRssMiB: 0 }, { maxRssMiB: 6145 }, { timeoutMs: Infinity }, { timeoutMs: NaN }]) {
      await expect(spawnGuarded(process.execPath, ['-e', 'process.exit(0)'], options)).rejects.toThrow('Invalid resource budget');
    }
  });
  it('terminates a small real child at a deliberately low RSS threshold', async () => {
    const onLimit = vi.fn();
    const managed = await spawnGuarded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { maxRssMiB: 1, timeoutMs: 4000, onLimit, gracefulRootOnly: true, stdio: 'ignore' });
    const signal = vi.spyOn(process, 'kill');
    try {
      await expect(managed.done).rejects.toThrow('task_memory_limit');
      expect(onLimit).toHaveBeenCalledOnce();
      // Resource pressure bypasses the frontend's normal parent-only grace.
      expect(signal).toHaveBeenCalledWith(-managed.child.pid!, 'SIGINT');
      expect(() => process.kill(managed.child.pid!, 0)).toThrow();
    } finally { signal.mockRestore(); }
  }, 8000);
  it('does not signal a completed child again when stop is called later', async () => {
    const managed = await spawnGuarded(process.execPath, ['-e', 'process.exit(0)'], { maxRssMiB: 256, timeoutMs: 4000, stdio: 'ignore' });
    await managed.done;
    const signal = vi.spyOn(process, 'kill');
    try { managed.stop(); expect(signal).not.toHaveBeenCalled(); }
    finally { signal.mockRestore(); }
  }, 8000);
  it('stops an idle child at its deadline without allocating large amounts of memory', async () => {
    const managed = await spawnGuarded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { maxRssMiB: 256, timeoutMs: 100, stdio: 'ignore' });
    await expect(managed.done).rejects.toThrow('task_timeout');
  }, 8000);
});

describe('OpenBitFun local host', () => {
  it('resolves assets without allowing encoded traversal or symlink escape', async () => {
    const web = await fixture();
    expect(await resolveAsset(web, '/')).toBe(await realpath(path.join(web, 'index.html')));
    await writeFile(path.join(temp!, 'outside.txt'), 'not served');
    await symlink(path.join(temp!, 'outside.txt'), path.join(web, 'escape.txt'));
    await expect(resolveAsset(web, '/escape.txt')).rejects.toThrow();
    await expect(resolveAsset(web, '/%2e%2e%2foutside.txt')).rejects.toThrow();
    await expect(resolveAsset(web, '/%00')).rejects.toThrow();
    await expect(resolveAsset(web, '/%5c..%5coutside.txt')).rejects.toThrow();
  });
  it('binds only loopback, serves assets and rejects foreign origins/hosts and mutation requests', async () => {
    const web = await fixture();
    server = await createWorkbenchHost({ webRoot: web, port: 0, getStatus: async () => ({ state: 'stopped', url: 'http://127.0.0.1:1422' }) });
    const address = server.address() as { port: number; address: string };
    expect(address.address).toBe('127.0.0.1');
    // The host header is checked against the configured port, not a guessed peer.
    const headers = { Host: '127.0.0.1:0' };
    expect((await get(address.port, '/', headers)).status).toBe(200);
    const status = await get(address.port, '/bambook/status', { ...headers, Origin: 'http://localhost:3000' });
    expect(status.status).toBe(200);
    expect(status.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect((await get(address.port, '/bambook/status', { ...headers, Origin: 'https://evil.test' })).status).toBe(403);
    expect((await get(address.port, '/', { Host: 'evil.test' })).status).toBe(403);
    expect((await get(address.port, '/', headers, 'POST')).status).toBe(405);
    expect((await get(address.port, '/missing.js', headers)).status).toBe(404);
  });
  it('does not report readiness from an HTTP error or a different backend', async () => {
    expect(await runtimeHealth(async () => new Response(JSON.stringify({ status: 'healthy', version: '1.0.5' })))).toBe(true);
    expect(await runtimeHealth(async () => new Response(JSON.stringify({ status: 'healthy', version: '1.0.5' }), { status: 503 }))).toBe(false);
    expect(await runtimeHealth(async () => new Response(JSON.stringify({ status: 'healthy', version: 'other' })))).toBe(false);
  });
  it('lets a frontend close its workers before forced group cleanup', async () => {
    await fixture();
    const ready = path.join(temp!, 'worker-ready'), interrupted = path.join(temp!, 'worker-interrupted');
    const worker = `const fs=require('node:fs'); process.on('SIGINT',()=>fs.writeFileSync(${JSON.stringify(interrupted)},'bad')); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'}); process.on('SIGINT',()=>setTimeout(()=>process.exit(0),100)); setInterval(()=>{},1000);`;
    const managed = await spawnGuarded(process.execPath, ['-e', parent], { maxRssMiB: 256, timeoutMs: 4000, gracefulRootOnly: true, stdio: 'ignore' });
    try {
      let started = false;
      for (let i = 0; i < 100; i++) {
        try { await stat(ready); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(started).toBe(true);
      managed.stop();
      expect((await managed.done).code).toBe(0);
      await expect(stat(interrupted)).rejects.toThrow();
    } finally { managed.stop(); }
  }, 8000);
  it('signals only its owned child and releases its asset host on shutdown', () => {
    const runtime = new OpenBitFunRuntime({ bundleRoot: '.', workspace: '.' });
    const kill = vi.fn();
    const close = vi.fn();
    const closeAllConnections = vi.fn();
    Object.assign(runtime, { child: { kill }, host: { close, closeAllConnections } });
    runtime.stop();
    expect(kill).toHaveBeenCalledWith(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    expect(close).toHaveBeenCalledOnce();
    expect(closeAllConnections).toHaveBeenCalledOnce();
    runtime.stop();
    expect(kill).toHaveBeenCalledOnce();
  });
  it('stops both owned guarded families in development mode, only once', () => {
    const runtime = new OpenBitFunRuntime({ bundleRoot: '.', workspace: '.', webDevRoot: '.' });
    const nativeStop = vi.fn(), webStop = vi.fn();
    Object.assign(runtime, { child: {}, managed: { stop: nativeStop }, webManaged: { stop: webStop } });
    runtime.stop();
    runtime.stop();
    expect(nativeStop).toHaveBeenCalledOnce();
    expect(webStop).toHaveBeenCalledOnce();
  });
  it('requires frontend readiness and the pinned revision in development mode', async () => {
    const runtime = new OpenBitFunRuntime({ bundleRoot: '.', workspace: '.', webDevRoot: '.' });
    Object.assign(runtime, { webManaged: {} });
    try {
      for (const body of [{ state: 'starting', revision: OPENBITFUN_REVISION }, { state: 'ready', revision: 'other' }]) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
        expect(await runtime.frontendReady()).toBe(false);
      }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'ready', revision: OPENBITFUN_REVISION }))));
      expect(await runtime.frontendReady()).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('does not resume startup after stop interrupts its filesystem preflight', async () => {
    await fixture();
    await writeFile(path.join(temp!, 'openbitfun-server'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await writeFile(path.join(temp!, 'manifest.json'), JSON.stringify({ revision: OPENBITFUN_REVISION, platform: process.platform, arch: process.arch }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'stopped' }))));
    const runtime = new OpenBitFunRuntime({ bundleRoot: temp!, workspace: path.join(temp!, 'workspace') });
    try {
      const starting = runtime.start();
      runtime.stop();
      const result = await starting;
      expect(result.state).toBe('stopped');
      expect(result.error).toContain('启动已取消');
      expect((await runtime.status()).state).toBe('stopped');
    } finally { runtime.stop(); vi.unstubAllGlobals(); }
  });
  it('does not spawn when runtime artifacts are missing', async () => {
    const web = await fixture();
    const runtime = new OpenBitFunRuntime({ bundleRoot: web, workspace: path.join(temp!, 'workspace') });
    const result = await runtime.start();
    expect(result.state).toBe('stopped');
    expect(result.error).toContain('openbitfun:prepare');
    expect((await runtime.status()).state).toBe('stopped');
    runtime.stop();
  });
});
