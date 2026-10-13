import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, realpath, stat, mkdir, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export const OPENBITFUN_REVISION = '0f1f1708a7eaf1974708578655d93525a38b74a6';
export const WORKBENCH_URL = 'http://127.0.0.1:1422';
// Controlled resumption authorized after the incident; every spawned workload
// must retain the resource guard below. This switch remains an emergency stop.
export const OPENBITFUN_SUSPENDED = false;
const SUSPENSION_ERROR = 'Agent 集成已暂停：内存异常正在排查。';
const ALLOWED_PARENTS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:4173', 'http://127.0.0.1:4173']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

const execFileAsync = promisify(execFile);

export function processFamily(rows, rootPid) {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && (selected.has(row.ppid) || row.pgid === rootPid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => selected.has(row.pid));
}
async function processTable() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,comm='], { timeout: 1500, maxBuffer: 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], rss: +match[4], comm: match[5] }] : [];
  });
}
async function swapMiB() {
  if (process.platform !== 'darwin') return 0;
  const { stdout } = await execFileAsync('sysctl', ['-n', 'vm.swapusage'], { timeout: 1500 });
  const match = stdout.match(/used\s*=\s*([\d.]+)([MG])/);
  if (!match) throw new Error('Cannot read system swap pressure');
  return +match[1] * (match[2] === 'G' ? 1024 : 1);
}
function harnessRssMiB(rows) {
  const roots = rows.filter(row => /\/OpenBitFun\.app\/.*\/openbitfun-desktop$/.test(row.comm));
  const pids = new Set(roots.flatMap(root => processFamily(rows, root.pid).map(row => row.pid)));
  return rows.reduce((sum, row) => sum + (pids.has(row.pid) ? row.rss / 1024 : 0), 0);
}

// Guard only processes we launch. Never terminate the user's harness or other apps.
// RSS sampling is not a hard OS memory quota; the swap and harness checks provide
// additional early-stop signals. Detached descendants that escape between samples
// remain a limitation; trusted plugin processes must keep their inherited group.
export async function spawnGuarded(command, args, options = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Resource guard is unavailable on this platform');
  const { maxRssMiB = 2048, timeoutMs = 900000, onLimit, gracefulRootOnly = false, ...spawnOptions } = options;
  if (!Number.isFinite(maxRssMiB) || !(maxRssMiB > 0 && maxRssMiB <= 6144) || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid resource budget');
  const initial = await processTable();
  const initialSwap = await swapMiB();
  if (harnessRssMiB(initial) > 8192 || initialSwap > 2048) throw new Error('Resource pressure too high to start another task');
  const child = spawn(command, args, { ...spawnOptions, detached: true, shell: false });
  let timer, escalation, finished = false, checking = false, stopping = false, limitError;
  let peakMiB = 0, samples = 0;
  const started = Date.now();
  function signalGroup(signal) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  }
  function stop(forceGroup = false) {
    if (stopping || finished) return;
    stopping = true;
    // Vite must close esbuild itself during normal shutdown. Resource-limit
    // failures still signal the entire family immediately, without this grace.
    if (gracefulRootOnly && !forceGroup) child.kill('SIGINT');
    else signalGroup('SIGINT');
    escalation = setTimeout(() => signalGroup('SIGKILL'), 1000);
  }
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { finished = true; clearInterval(timer); clearTimeout(escalation); reject(error); });
    child.once('exit', (code, signal) => {
      finished = true;
      clearInterval(timer);
      // The root may exit before its children: finish cleaning the owned group.
      signalGroup('SIGKILL');
      clearTimeout(escalation);
      console.error(`[openbitfun:guard] ${path.basename(command)} peakRSS=${samples ? `${Math.ceil(peakMiB)}MiB` : 'unobserved'} exit=${code ?? signal}`);
      if (limitError) reject(limitError);
      else if (code !== 0 && !stopping) reject(new Error(`${path.basename(command)} exited with ${code ?? signal}`));
      else resolve({ peakMiB, code });
    });
  });
  // Attach a rejection observer immediately; callers still receive the rejection.
  void done.catch(() => {});
  timer = setInterval(async () => {
    if (finished || checking || stopping) return;
    checking = true;
    try {
      const rows = await processTable();
      const memory = processFamily(rows, child.pid).reduce((sum, row) => sum + row.rss / 1024, 0);
      peakMiB = Math.max(peakMiB, memory);
      samples += 1;
      const swap = await swapMiB();
      const reason = memory > maxRssMiB ? 'task_memory_limit' : harnessRssMiB(rows) > 8192 ? 'harness_memory_limit'
        : swap > 2048 || swap - initialSwap > 1024 ? 'system_swap_pressure'
        : timeoutMs && Date.now() - started > timeoutMs ? 'task_timeout' : null;
      if (reason) {
        const owners = processFamily(rows, child.pid).sort((a, b) => b.rss - a.rss).slice(0, 4)
          .map(row => `${path.basename(row.comm)}:${Math.ceil(row.rss / 1024)}MiB`).join(',');
        console.error(`[openbitfun:guard] ${reason} ownedProcesses=${owners}`);
        throw new Error(`Resource guard stopped task: ${reason}`);
      }
    } catch (error) {
      if (!finished) { limitError = error; stop(true); onLimit?.(error); }
    } finally { checking = false; }
  }, 500);
  return { child, done, stop };
}

export async function runGuarded(command, args, options = {}) {
  const managed = await spawnGuarded(command, args, options);
  const interrupted = () => managed.stop();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try { return await managed.done; }
  finally { process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
}

// This host exposes upstream assets, not Bambook data or a privileged IPC bridge.
export async function resolveAsset(root, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, WORKBENCH_URL).pathname);
  if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid asset path');
  const candidate = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid asset path');
  const resolved = await realpath(candidate);
  const inside = path.relative(await realpath(root), resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Invalid asset path');
  if (!(await stat(resolved)).isFile()) throw new Error('Not an asset');
  return resolved;
}

export async function runtimeHealth(fetchImpl = fetch) {
  try {
    const response = await fetchImpl('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && body.status === 'healthy' && body.version === '1.0.5';
  } catch { return false; }
}

export async function createWorkbenchHost({ webRoot, getStatus, port = 1422 }) {
  await access(path.join(webRoot, 'index.html'));
  const server = createServer(async (req, res) => {
    // Host validation prevents DNS rebinding against the local asset host.
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host)) {
      res.writeHead(403).end(); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:3000 http://127.0.0.1:3000 http://localhost:4173 http://127.0.0.1:4173 file:");
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/bambook/status') {
      const origin = req.headers.origin;
      if (origin && origin !== WORKBENCH_URL && !ALLOWED_PARENTS.has(origin)) { res.writeHead(403).end(); return; }
      if (origin && ALLOWED_PARENTS.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await getStatus())); return;
    }
    try {
      const asset = await resolveAsset(webRoot, req.url || '/');
      res.setHeader('Content-Type', MIME[path.extname(asset)] || 'application/octet-stream');
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(asset);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function inspectSharedOwner({ bundleRoot, workspace }) {
  // Verify socket owners, not merely a version-shaped response on localhost.
  // Only the two known listener PIDs are inspected; never scan account data.
  const options = { timeout: 1500, maxBuffer: 16384, windowsHide: true };
  const listener = async port => {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], options);
    const pids = [...new Set(stdout.trim().split(/\s+/))];
    return pids.length === 1 && /^[1-9]\d*$/.test(pids[0]) ? pids[0] : null;
  };
  const backendPid = await listener(8080), frontendPid = await listener(1422);
  if (!backendPid || !frontendPid) return false;
  const { stdout } = await execFileAsync('ps', ['-p', backendPid, '-o', 'ppid=,command='], options);
  const row = stdout.trim().match(/^(\d+)\s+(.+)$/);
  const binary = path.join(path.resolve(bundleRoot), 'openbitfun-server');
  const expected = `${binary} --workspace ${path.resolve(workspace)} --allowed-origin ${WORKBENCH_URL}`;
  if (!row || row[2] !== expected) return false;
  if (row[1] === frontendPid) return true; // static host in its manager
  const { stdout: parent } = await execFileAsync('ps', ['-p', frontendPid, '-o', 'ppid='], options);
  return parent.trim() === row[1]; // Vite and native sidecar share a manager
}

export async function readSharedWorkbench({ bundleRoot, workspace, requireDev = false, fetchImpl = fetch, inspectOwner = inspectSharedOwner }) {
  try {
    const response = await fetchImpl(`${WORKBENCH_URL}/bambook/status`, { signal: AbortSignal.timeout(1500), credentials: 'omit' });
    const body = await response.json();
    if (!response.ok || body.url !== WORKBENCH_URL || body.revision !== OPENBITFUN_REVISION
        || !['ready', 'starting'].includes(body.state)) return null;
    if (!await inspectOwner({ bundleRoot, workspace })) return null;
    if (body.state === 'ready' && !await runtimeHealth(fetchImpl)) return null;
    if (requireDev) {
      const page = await fetchImpl(WORKBENCH_URL, { signal: AbortSignal.timeout(1500), credentials: 'omit' });
      if (!page.ok || !(await page.text()).includes('/@vite/client')) return null;
    }
    // Observing is not adopting: no external PID/child is stored or signalled.
    return { state: body.state, url: WORKBENCH_URL, revision: OPENBITFUN_REVISION };
  } catch { return null; } // unavailable ownership diagnostics fail closed
}

export class OpenBitFunRuntime {
  constructor({ bundleRoot, workspace, webDevRoot, webDevEntry, env = process.env }) {
    this.bundleRoot = bundleRoot;
    this.workspace = workspace;
    this.env = env;
    this.webDevRoot = webDevRoot;
    this.webDevEntry = webDevEntry;
    this.webManaged = null;
    this.managed = null;
    this.child = null;
    this.host = null;
    this.starting = null;
    this.generation = 0;
    this.error = undefined;
  }
  async frontendReady() {
    if (!this.webDevRoot) return Boolean(this.host);
    if (!this.webManaged) return false;
    try {
      const response = await fetch(`${WORKBENCH_URL}/bambook/status`, { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      return response.ok && body.state === 'ready' && body.revision === OPENBITFUN_REVISION;
    } catch { return false; }
  }
  async sharedStatus() {
    return readSharedWorkbench({ bundleRoot: this.bundleRoot, workspace: this.workspace, requireDev: Boolean(this.webDevRoot) });
  }
  async status() {
    if (!OPENBITFUN_SUSPENDED && !this.child) {
      const shared = await this.sharedStatus();
      if (shared) return shared;
    }
    const ready = Boolean(this.child) && await this.frontendReady() && await runtimeHealth();
    return { state: ready ? 'ready' : this.starting ? 'starting' : 'stopped', url: WORKBENCH_URL, revision: OPENBITFUN_REVISION, error: this.error };
  }
  async start() {
    if (OPENBITFUN_SUSPENDED) {
      this.stop();
      this.error = SUSPENSION_ERROR;
      return this.status();
    }
    if (this.starting) return this.starting;
    if (this.child && await this.frontendReady() && await runtimeHealth()) return this.status();
    this.starting = this.startOwned();
    try { return await this.starting; }
    finally { this.starting = null; }
  }
  async startOwned() {
    this.stop();
    const generation = this.generation;
    const assertActive = () => { if (generation !== this.generation) throw new Error('Agent 启动已取消。'); };
    if (OPENBITFUN_SUSPENDED) {
      this.error = SUSPENSION_ERROR;
      return this.status();
    }
    this.error = undefined;
    try {
      const shared = await this.sharedStatus();
      assertActive();
      if (shared) return shared;
      const binary = path.join(this.bundleRoot, process.platform === 'win32' ? 'openbitfun-server.exe' : 'openbitfun-server');
      await access(binary);
      const manifest = JSON.parse(await readFile(path.join(this.bundleRoot, 'manifest.json'), 'utf8'));
      if (manifest.revision !== OPENBITFUN_REVISION || manifest.platform !== process.platform || manifest.arch !== process.arch) {
        throw new Error('Agent 构建版本或平台不匹配，请重新构建。');
      }
      if (this.webDevRoot) {
        await access(path.join(this.webDevRoot, 'index.html'));
        await access(path.join(this.webDevRoot, 'node_modules/vite/package.json'));
      } else await access(path.join(this.bundleRoot, 'web', 'index.html'));
      // Never adopt or stop a pre-existing runtime belonging to another application.
      if (await runtimeHealth()) throw new Error('8080 端口已有 Agent 服务，请先关闭冲突实例。');
      await mkdir(this.workspace, { recursive: true });
      assertActive();
      const managed = await spawnGuarded(binary, ['--workspace', this.workspace, '--allowed-origin', WORKBENCH_URL], {
        cwd: this.workspace,
        env: { ...this.env, PATH: `${path.join(this.bundleRoot, 'bin')}${path.delimiter}${this.env.PATH || ''}` },
        stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
        maxRssMiB: 2048, timeoutMs: 0,
        onLimit: () => { this.error = 'Agent 资源异常，已自动停止。'; this.stop(); },
      });
      if (generation !== this.generation) { managed.stop(); assertActive(); }
      this.managed = managed;
      this.child = managed.child;
      void managed.done.catch(() => { if (this.child === managed.child) this.error = 'Agent 运行服务已停止。'; });
      const ownedChild = this.child;
      ownedChild.once('error', () => { if (this.child === ownedChild) this.error = 'Agent 运行服务启动失败。'; });
      ownedChild.once('exit', () => {
        if (this.child !== ownedChild) return;
        this.error = 'Agent 运行服务已退出。';
        this.stop();
      });
      if (this.webDevRoot) {
        const webManaged = await spawnGuarded(process.execPath,
          ['--max-old-space-size=1536', this.webDevEntry || path.join(import.meta.dirname, 'openbitfun-web-dev.mjs'), this.webDevRoot], {
            cwd: this.webDevRoot,
            env: { ...this.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=1536', OPENBITFUN_DEV_PORT: '1422', OPENBITFUN_DEV_HMR_PORT: '1421' },
            stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
            maxRssMiB: 3072, timeoutMs: 0, gracefulRootOnly: true,
            onLimit: () => { this.error = 'Agent 开发前端资源异常，已自动停止。'; this.stop(); },
          });
        if (generation !== this.generation) { webManaged.stop(); assertActive(); }
        this.webManaged = webManaged;
        void webManaged.done.catch(() => {});
        const onWebExit = () => {
          if (this.webManaged !== webManaged) return;
          this.error = 'Agent 开发前端已停止，请检查 logs/dev-openbitfun.log。';
          this.stop();
        };
        webManaged.child.once('exit', onWebExit);
        webManaged.child.once('error', onWebExit);
      } else {
        const host = await createWorkbenchHost({ webRoot: path.join(this.bundleRoot, 'web'), getStatus: () => this.status() });
        if (generation !== this.generation) { host.closeAllConnections(); host.close(); assertActive(); }
        this.host = host;
      }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (this.error || !this.child) throw new Error(this.error || 'Agent 运行服务已退出。');
        assertActive();
        if (await this.frontendReady() && await runtimeHealth()) {
          assertActive();
          return { state: 'ready', url: WORKBENCH_URL, revision: OPENBITFUN_REVISION };
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error('Agent 运行服务启动超时。');
    } catch (error) {
      this.stop();
      this.error = error.code === 'ENOENT' ? '本机 Agent 尚未构建，请先运行 npm run openbitfun:prepare。' : error.code === 'EADDRINUSE' ? '1422 端口被占用，请先关闭冲突实例。' : error.message;
      return { state: 'stopped', url: WORKBENCH_URL, revision: OPENBITFUN_REVISION, error: this.error };
    }
  }
  stop() {
    this.generation += 1;
    const child = this.child;
    const managed = this.managed;
    this.child = null;
    this.managed = null;
    const webManaged = this.webManaged;
    this.webManaged = null;
    webManaged?.stop();
    // Stop the owned process group, with forced cleanup if graceful shutdown hangs.
    if (managed) managed.stop();
    else child?.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    this.host?.closeAllConnections();
    this.host?.close();
    this.host = null;
  }
}

