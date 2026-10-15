import type { FetchLike, SecretStore } from '../types';

export const memorySecrets = (): SecretStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async k => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); }, delete: async k => { data.delete(k); } };
};

export const sse = (events: unknown[], status = 200) =>
  new Response(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status, headers: { 'Content-Type': 'text/event-stream' } });

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export type Call = { url: string; init: RequestInit & { dispatcher?: unknown } };
export const scriptedFetch = (handler: (call: Call, index: number) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => { const call = { url: String(url), init }; calls.push(call); return handler(call, calls.length - 1); };
  return { fetch, calls, body: (i: number) => JSON.parse(String(calls[i].init.body)) };
};

export const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
