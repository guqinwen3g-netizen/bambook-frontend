// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { OpenBitFunRuntime, OPENBITFUN_REVISION, WORKBENCH_URL, readSharedWorkbench } from './openbitfun-runtime.mjs';

const identity = { state: 'ready', url: WORKBENCH_URL, revision: OPENBITFUN_REVISION };
function fixture({ body = identity, healthy = true, dev = true, ok = true } = {}) {
  return vi.fn(async (input: any) => {
    if (String(input).endsWith('/health')) return new Response(JSON.stringify({ status: healthy ? 'healthy' : 'stopped', version: '1.0.5' }));
    if (String(input).endsWith('/bambook/status')) return new Response(JSON.stringify(body), { status: ok ? 200 : 503 });
    return new Response(dev ? '<script src="/@vite/client"></script>' : '<script src="/assets/built.js"></script>');
  });
}
const options = { bundleRoot: '/fixture/bundle', workspace: '/fixture/workspace' };

describe('shared Bambook Agent observation', () => {
  it('checks identity, owner and backend health, returning only safe status fields', async () => {
    const fetchImpl = fixture({ body: { ...identity, untrusted: 'not-forwarded' } as typeof identity });
    const inspectOwner = vi.fn(async () => true);
    expect(await readSharedWorkbench({ ...options, fetchImpl, inspectOwner, requireDev: true })).toEqual(identity);
    expect(inspectOwner).toHaveBeenCalledWith(options);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/health'))).toBe(true);
  });
  it.each([
    { ...identity, revision: 'other' }, { ...identity, url: 'http://untrusted.invalid' },
    { ...identity, state: 'stopped' }, { ...identity, state: 'unknown' },
  ])('rejects nonmatching workbench identity: %j', async body => {
    const inspectOwner = vi.fn(async () => true);
    expect(await readSharedWorkbench({ ...options, fetchImpl: fixture({ body }), inspectOwner })).toBeNull();
    expect(inspectOwner).not.toHaveBeenCalled();
  });
  it('fails closed when listener ownership differs or cannot be checked', async () => {
    for (const inspectOwner of [async () => false, async () => { throw new Error('diagnostics unavailable'); }]) {
      expect(await readSharedWorkbench({ ...options, fetchImpl: fixture(), inspectOwner })).toBeNull();
    }
  });
  it('rejects unhealthy backends, HTTP errors and static hosts for development clients', async () => {
    for (const config of [{ healthy: false }, { ok: false }, { dev: false }]) {
      expect(await readSharedWorkbench({ ...options, fetchImpl: fixture(config), inspectOwner: async () => true, requireDev: true })).toBeNull();
    }
  });
  it('does not connect or spawn a second service when a matching owner already runs', async () => {
    const runtime = new OpenBitFunRuntime({ bundleRoot: '/nonexistent/artifacts', workspace: '/nonexistent/workspace' });
    const peer = vi.spyOn(runtime, 'sharedStatus').mockResolvedValue(identity as any);
    const signal = vi.spyOn(process, 'kill');
    try {
      expect(await runtime.start()).toEqual(identity);
      runtime.stop();
      expect(await runtime.status()).toEqual(identity);
      expect(signal).not.toHaveBeenCalled();
      expect(peer).toHaveBeenCalledTimes(2);
    } finally { signal.mockRestore(); }
  });
  it('does not resume startup when stop interrupts shared-owner discovery', async () => {
    const runtime = new OpenBitFunRuntime({ bundleRoot: '/nonexistent', workspace: '/nonexistent' });
    let complete!: (value: any) => void;
    vi.spyOn(runtime, 'sharedStatus').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const starting = runtime.start();
    runtime.stop(); complete(identity);
    const status = await starting;
    expect(status.state).toBe('stopped');
    expect(status.error).toContain('启动已取消');
  });
  it('shares development workspace/HMR wiring while preserving packaged persistence', async () => {
    const main = await readFile('electron/main.ts', 'utf8');
    const block = main.slice(main.indexOf('function getOpenBitFunRuntime()'), main.indexOf("for (const operation of ['start', 'status']"));
    expect(block).toContain("path.join(app.getAppPath(), 'tmp/openbitfun-workspace')");
    expect(block).toContain("path.join(app.getPath('userData'), 'agent-workspace')");
    expect(block).toContain("webDevRoot: app.isPackaged ? undefined");
    expect(block).toContain("path.join(app.getAppPath(), 'scripts/openbitfun-web-dev.mjs')");
  });
});
