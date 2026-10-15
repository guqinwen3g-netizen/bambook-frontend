/**
 * assistant-host 入口：在 Electron utilityProcess 中运行工作助手服务。
 * 与主进程通过 parentPort 通信；凭据读写转给主进程（系统钥匙串加密），本进程不落明文。
 */
import { fetch as undiciFetch } from 'undici';
import { AssistantService } from './service';
import { AssistantError, type FetchLike, type SecretStore } from './types';
import type { HostInbound, HostOutbound } from './protocol';

type ParentPort = { on(event: 'message', listener: (e: { data: HostInbound }) => void): void; postMessage(message: HostOutbound): void };
const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('assistant-host must run inside an Electron utility process');

const dataDir = process.argv.find(a => a.startsWith('--data-dir='))?.slice('--data-dir='.length);
if (!dataDir) throw new Error('assistant-host requires --data-dir');

let seq = 0;
const secretWaiters = new Map<number, { resolve: (v: string | null) => void; reject: (e: Error) => void }>();
const secretCall = (op: 'get' | 'set' | 'delete', key: string, value?: string) => new Promise<string | null>((resolve, reject) => {
  const id = ++seq;
  secretWaiters.set(id, { resolve, reject });
  port.postMessage({ kind: 'secret', id, op, key, value });
});
const secrets: SecretStore = {
  get: key => secretCall('get', key),
  set: async (key, value) => { await secretCall('set', key, value); },
  delete: async key => { await secretCall('delete', key); },
};

// skip_ssl_verify 的请求带自定义 dispatcher，必须交给同一版本的 undici fetch。
const fetchImpl: FetchLike = (input, init) => (init?.dispatcher ? (undiciFetch as unknown as FetchLike)(input, init) : fetch(input, init));

const service = new AssistantService({ rootDir: dataDir, secrets, fetch: fetchImpl, emit: event => port.postMessage({ kind: 'event', event }) });

port.on('message', ({ data }) => {
  if (data?.kind === 'secret_result') {
    const waiter = secretWaiters.get(data.id);
    if (!waiter) return;
    secretWaiters.delete(data.id);
    if (data.error) waiter.reject(new AssistantError('SECRET_STORE_UNAVAILABLE', data.error));
    else waiter.resolve(data.value ?? null);
    return;
  }
  if (data?.kind !== 'request') return;
  service.handle(data.method, data.params).then(
    result => port.postMessage({ kind: 'response', id: data.id, ok: true, result }),
    error => port.postMessage({
      kind: 'response', id: data.id, ok: false,
      error: error instanceof AssistantError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '工作助手内部错误，请重试' },
    }),
  );
});
