/**
 * 主进程侧的工作助手守护：拉起 assistant-host（utilityProcess），心跳、内存上限与崩溃退避重启；
 * 用系统钥匙串（safeStorage）加密保存凭据；只向主窗口转发事件。
 */
import { app, safeStorage, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOST_LIMITS, RENDERER_METHODS, nextRestartDelay, type HostInbound, type HostOutbound } from './assistant/protocol';

export type HostStatus = { state: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'; reason?: string };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class AssistantRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AssistantRequestError'; }
}

/** safeStorage 加密的本机凭据文件；钥匙串不可用（含 Linux basic_text）时拒绝保存。 */
class KeychainSecrets {
  constructor(private readonly file: string) {}
  private available() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  }
  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  private write(data: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  get(key: string): string | null {
    const value = this.read()[key];
    if (!value || !this.available()) return null;
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return null; }
  }
  set(key: string, value: string) {
    if (!this.available()) throw new Error('系统钥匙串不可用，无法安全保存凭据');
    this.write({ ...this.read(), [key]: safeStorage.encryptString(value).toString('base64') });
  }
  delete(key: string) {
    const data = this.read();
    if (!(key in data)) return;
    delete data[key];
    this.write(data);
  }
}

export class AssistantSupervisor {
  private child: UtilityProcess | null = null;
  private status: HostStatus = { state: 'stopped' };
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly restarts: number[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private readonly secrets: KeychainSecrets;
  private lastAccount: { accountKey: unknown; displayName: unknown } | null = null;

  constructor(private readonly options: { hostPath: string; dataDir: string; send: (channel: string, payload: unknown) => void }) {
    this.secrets = new KeychainSecrets(path.join(options.dataDir, 'secrets.json'));
  }

  hostStatus() { return this.status; }

  private setStatus(status: HostStatus) {
    this.status = status;
    this.options.send('assistant:event', { type: 'host_status', status });
  }

  private start() {
    if (this.child || this.stopping) return;
    this.setStatus({ state: 'starting' });
    const child = utilityProcess.fork(this.options.hostPath, [`--data-dir=${this.options.dataDir}`], {
      serviceName: 'Bambook Assistant',
      execArgv: [`--max-old-space-size=${HOST_LIMITS.heapMb}`],
      stdio: 'ignore',
    });
    this.child = child;
    child.on('spawn', () => {
      this.setStatus({ state: 'running' });
      // 重启后恢复账号上下文，页面无需感知。
      if (this.lastAccount) void this.call('account.select', this.lastAccount).catch(() => undefined);
    });
    child.on('message', (message: HostOutbound) => this.onMessage(message));
    child.on('exit', code => this.onExit(child, code));
    this.heartbeat = setInterval(() => this.checkHealth(child), HOST_LIMITS.heartbeatMs);
  }

  private checkHealth(child: UtilityProcess) {
    if (child !== this.child) return;
    const metric = app.getAppMetrics().find(m => m.pid === child.pid);
    const workingMb = metric ? metric.memory.workingSetSize / 1024 : 0;
    if (workingMb > HOST_LIMITS.memoryKillMb) { this.kill(child, `内存超过 ${HOST_LIMITS.memoryKillMb}MB`); return; }
    const timer = setTimeout(() => this.kill(child, '心跳超时'), HOST_LIMITS.heartbeatTimeoutMs);
    this.call('ping', {}).then(() => clearTimeout(timer), () => clearTimeout(timer));
  }

  private kill(child: UtilityProcess, reason: string) {
    if (child !== this.child) return;
    this.exitReason = reason;
    child.kill();
  }

  private exitReason: string | null = null;

  private onExit(child: UtilityProcess, code: number) {
    if (child !== this.child) return;
    this.child = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const reason = this.exitReason ?? `进程退出（${code}）`;
    this.exitReason = null;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new AssistantRequestError('HOST_RESTARTED', `工作助手已重启（${reason}），请重试`)); this.pending.delete(id); }
    if (this.stopping) { this.setStatus({ state: 'stopped' }); return; }
    const now = Date.now();
    const delay = nextRestartDelay(this.restarts, now);
    if (delay === null) { this.setStatus({ state: 'failed', reason }); return; }
    this.restarts.push(now);
    this.setStatus({ state: 'restarting', reason });
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, delay);
  }

  private onMessage(message: HostOutbound) {
    if (message?.kind === 'response') {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.ok) p.resolve(message.result);
      else p.reject(new AssistantRequestError(message.error.code, message.error.message));
    } else if (message?.kind === 'event') {
      this.options.send('assistant:event', message.event);
    } else if (message?.kind === 'secret') {
      const reply = (r: Omit<Extract<HostInbound, { kind: 'secret_result' }>, 'kind' | 'id'>) => this.child?.postMessage({ kind: 'secret_result', id: message.id, ...r } satisfies HostInbound);
      try {
        if (message.op === 'get') reply({ value: this.secrets.get(message.key) });
        else if (message.op === 'set') { this.secrets.set(message.key, String(message.value ?? '')); reply({ value: null }); }
        else { this.secrets.delete(message.key); reply({ value: null }); }
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : '凭据存储不可用' });
      }
    }
  }

  private call(method: string, params: unknown): Promise<unknown> {
    this.start();
    const child = this.child;
    if (!child) return Promise.reject(new AssistantRequestError('HOST_UNAVAILABLE', '工作助手未运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AssistantRequestError('HOST_TIMEOUT', '工作助手响应超时，请重试')); }, HOST_LIMITS.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.postMessage({ kind: 'request', id, method, params } satisfies HostInbound);
    });
  }

  /** 渲染进程入口：方法白名单 + 可手动重启已停止的守护。 */
  async request(method: unknown, params: unknown): Promise<unknown> {
    if (method === 'host.status') return this.status;
    if (method === 'host.restart') {
      this.restarts.length = 0;
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.start();
      return this.status;
    }
    if (typeof method !== 'string' || !RENDERER_METHODS.has(method)) throw new AssistantRequestError('UNKNOWN_METHOD', '不支持的请求');
    if (method === 'account.select' && params && typeof params === 'object') {
      const p = params as Record<string, unknown>;
      this.lastAccount = { accountKey: p.accountKey, displayName: p.displayName };
    }
    if (this.status.state === 'failed') throw new AssistantRequestError('HOST_FAILED', `工作助手多次异常退出（${this.status.reason ?? '未知原因'}），请在页面上重新启动`);
    return this.call(method, params);
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.kill();
  }
}
