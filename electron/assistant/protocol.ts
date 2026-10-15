/** 主进程 ⇄ assistant-host 的消息格式。 */
import type { AssistantEvent } from './service';

export type HostInbound =
  | { kind: 'request'; id: number; method: string; params?: unknown }
  | { kind: 'secret_result'; id: number; value?: string | null; error?: string };

export type HostOutbound =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: { code: string; message: string } }
  | { kind: 'event'; event: AssistantEvent }
  | { kind: 'secret'; id: number; op: 'get' | 'set' | 'delete'; key: string; value?: string };

/** 渲染进程可调用的方法白名单（主进程在转发前校验）。 */
export const RENDERER_METHODS = new Set([
  'ping', 'status', 'account.select',
  'providers.list', 'providers.save', 'providers.delete', 'providers.models',
  'chatgpt.status', 'chatgpt.login.start', 'chatgpt.login.get', 'chatgpt.logout',
  'sessions.list', 'sessions.get', 'sessions.delete',
  'run.start', 'run.cancel', 'confirm.resolve',
]);

/** 资源守护参数。 */
export const HOST_LIMITS = {
  heapMb: 1024,
  memoryKillMb: 1536,
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
  maxRestarts: 5,
  restartWindowMs: 10 * 60_000,
};

/** 崩溃重启退避：窗口内超过上限则停止自动重启（返回 null）。 */
export function nextRestartDelay(history: number[], now: number, limits = HOST_LIMITS): number | null {
  const recent = history.filter(t => now - t < limits.restartWindowMs);
  if (recent.length >= limits.maxRestarts) return null;
  return Math.min(30_000, 1000 * 2 ** recent.length);
}
