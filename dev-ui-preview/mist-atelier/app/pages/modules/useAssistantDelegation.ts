/** 页面用本人会话续签，短期委托仅交给本机 host；不写入 storage / 会话 / 日志。 */
import React from 'react';
import { apiService } from '../../../../../services/apiService';
import type { AssistantBridge } from './WorkAssistantPage';

type Readable = { type: string; label: string };
type View = { scope: string; phase: 'idle' | 'connecting' | 'connected' | 'error'; readable: Readable[]; expiresAt: string | null; error: string };
const empty = (scope: string): View => ({ scope, phase: 'idle', readable: [], expiresAt: null, error: '' });
const RENEW_BEFORE_MS = 10 * 60_000;

export function useAssistantDelegation(input: { bridge: AssistantBridge | null; accountKey: string; scope: string; workspaceId?: string; enabled: boolean }) {
  const { bridge, accountKey, scope, workspaceId, enabled } = input;
  const current = React.useRef(scope); current.current = scope;
  const renewRef = React.useRef<(() => Promise<void>) | null>(null);
  const [view, setView] = React.useState<View>(() => empty(scope));
  const renew = React.useCallback(async () => { await renewRef.current?.(); }, []);
  React.useEffect(() => {
    if (!bridge || !accountKey) return;
    let stopped = false, pending: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null;
    const isCurrent = () => !stopped && current.current === scope;
    const request = async (params: unknown) => {
      const result = await bridge.request('session.delegation', params);
      if (!result.ok) throw new Error(result.error?.message ?? '业务授权没有连接到本机助手');
      return result.result as { connected: boolean; workspaceId: string | null };
    };
    // 撤下旧空间/旧授权上下文，host 同时中止旧运行；异步续签不能串入下一个上下文。
    const cleared = request({ accountKey, clear: true });
    void cleared.catch(() => undefined);
    const connect = (): Promise<void> => {
      if (pending) return pending;
      if (!enabled || !workspaceId || !isCurrent()) return Promise.resolve();
      clearTimeout(timer);
      setView(previous => ({ ...(previous.scope === scope ? previous : empty(scope)), phase: 'connecting', error: '' }));
      pending = (async () => {
        try {
          await cleared;
          if (!isCurrent()) return;
          controller = new AbortController();
          const response = await fetch('/api/mist/agent/delegations', {
            method: 'POST', headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
            credentials: 'include', cache: 'no-store', body: '{}', signal: controller.signal,
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body?.error?.message ?? '业务授权签发失败，请稍后重试');
          const d = body?.delegation;
          if (!d || typeof d.token !== 'string' || !d.token || typeof d.expiresAt !== 'string' || !Number.isFinite(Date.parse(d.expiresAt))
            || Date.parse(d.expiresAt) <= Date.now() || !Array.isArray(body.readable)
            || body.readable.some((r: any) => !r || typeof r.type !== 'string' || typeof r.label !== 'string')) throw new Error('业务授权响应无效，请重试');
          if (!isCurrent()) return;
          const bound = await request({ accountKey, token: d.token, expiresAt: d.expiresAt, workspaceId, apiBase: location.origin });
          if (!isCurrent()) return;
          if (!bound?.connected || bound.workspaceId !== workspaceId) throw new Error('业务授权的工作区不一致，请重新连接');
          setView({ scope, phase: 'connected', readable: body.readable.map((r: Readable) => ({ type: r.type, label: r.label.slice(0, 40) })), expiresAt: d.expiresAt, error: '' });
          timer = setTimeout(() => { void connect(); }, Math.max(30_000, Date.parse(d.expiresAt) - Date.now() - RENEW_BEFORE_MS));
        } catch (error) {
          if (!isCurrent()) return;
          setView({ ...empty(scope), phase: 'error', error: error instanceof Error ? error.message : '业务授权没有连接' });
          timer = setTimeout(() => { void connect(); }, 60_000);
        } finally { pending = null; controller = null; }
      })();
      return pending;
    };
    renewRef.current = connect;
    setView(empty(scope));
    void connect();
    return () => {
      stopped = true; controller?.abort(); clearTimeout(timer);
      if (renewRef.current === connect) renewRef.current = null;
      void request({ accountKey, clear: true }).catch(() => undefined);
    };
  }, [bridge, accountKey, scope, workspaceId, enabled]);
  return { ...(view.scope === scope ? view : empty(scope)), renew };
}
