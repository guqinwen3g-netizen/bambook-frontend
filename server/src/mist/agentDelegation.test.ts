import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createMistLocalRuntime, mistLocalPublicUser } from './local';
import { createMistServer } from './server';
import { AGENT_DELEGATION_HEADER as HEADER, AGENT_DELEGATION_TTL_MS, WORK_ASSISTANT_CEILING, agentRouteAllowed, createAgentDelegation } from './agentDelegation';
import { AGENT_OBJECT_TYPES, agentCatalog, agentGet, agentQuery, agentRelated } from './agentRead';
import { hasScope } from '../auth/permissionService';
import { MistApiError } from './errors';
import type { TokenPayload } from '../auth/service';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mist-agent-'));
  vi.stubEnv('MIST_LOCAL_WORKSPACE', '1'); vi.stubEnv('NODE_ENV', 'test');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });
const W = '/api/mist/workspaces/';
const actor = (id = 'local-operator'): TokenPayload => ({ ...mistLocalPublicUser(id), userId: id } as TokenPayload);
async function clientFor(app: any, profileId = 'local-sales') {
  const client = request.agent(app);
  const initial = await client.get('/api/mist/session').expect(200);
  await client.post('/api/mist/session').send({ profileId }).expect(200);
  return { client, cookieName: initial.headers['set-cookie'][0].split('=')[0] };
}
async function issue(client: any) { return (await client.post('/api/mist/agent/delegations').send({}).expect(201)).body; }

describe('短期委托的签名、上限和身份隔离', () => {
  it('uses a purpose-derived key, a two-hour lifetime and read-only ceiling even for a wildcard owner', async () => {
    let now = 1_800_000_000_000;
    const d = createAgentDelegation({ rootSecret: () => 'root-secret', resolve: id => actor(id), now: () => now });
    const issued = d.issue(actor());
    const payload = d.verify(issued.token);
    expect(payload).toMatchObject({ v: 1, kind: 'mist-agent', sub: 'local-operator', sid: issued.sessionId, iat: now, exp: now + AGENT_DELEGATION_TTL_MS });
    expect(issued.ceiling).toEqual(WORK_ASSISTANT_CEILING);
    expect(issued.ceiling.every(p => p.endsWith(':read'))).toBe(true);
    expect(issued.ceiling).not.toContain('*'); expect(issued.ceiling).not.toContain('ai:chat');
    const agent = await d.authenticate(issued.token);
    expect(agent).toMatchObject({ actorKind: 'agent', agentSessionId: issued.sessionId, permissionCeiling: issued.ceiling });
    expect(hasScope(agent, 'products:read')).toBe(true); expect(hasScope(agent, 'products:write')).toBe(false);
    expect(() => d.issue(agent)).toThrow(/不能自行续签/);
    expect(d.issue({ ...actor(), permissionCeiling: ['orders:read', 'products:write'] }).ceiling).toEqual(['orders:read']);
    const [data] = issued.token.split('.');
    expect(createHmac('sha256', 'root-secret').update(data).digest('base64url')).not.toBe(issued.token.split('.')[1]);
    expect(() => d.verify(data + '.forged')).toThrow(/签名/);
    now += AGENT_DELEGATION_TTL_MS;
    expect(() => d.verify(issued.token)).toThrow(/过期/);
  });

  it('rejects malformed signed payloads, future or reversed lifetimes and another signing root', () => {
    const root = 'root', now = 1_800_000_000_000;
    const d = createAgentDelegation({ rootSecret: () => root, resolve: id => actor(id), now: () => now });
    const sign = (payload: unknown) => {
      const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const key = createHmac('sha256', root).update('bambook-mist-agent-delegation/v1').digest();
      return data + '.' + createHmac('sha256', key).update(data).digest('base64url');
    };
    const good = d.verify(d.issue(actor()).token);
    for (const bad of [null, [], {}, { ...good, sid: '' }, { ...good, ceil: ['*'] }, { ...good, ceil: ['orders:write'] }, { ...good, exp: good.iat }, { ...good, iat: now + 60_000, exp: now + 120_000 }]) expect(() => d.verify(sign(bad))).toThrow();
    const other = createAgentDelegation({ rootSecret: () => 'other-root', resolve: id => actor(id), now: () => now });
    expect(() => other.verify(d.issue(actor()).token)).toThrow(/签名/);
    for (const token of ['', 'a.b.c', 'x'.repeat(4097)]) expect(() => d.verify(token)).toThrow();
  });

  it('allows only exact read routes, not writes or normal workspace / file / subscription APIs', () => {
    expect(agentRouteAllowed('GET', '/workspaces')).toBe(true);
    expect(agentRouteAllowed('GET', '/workspaces/w/agent/objects/order/o/related')).toBe(true);
    for (const [method, route] of [['POST', '/agent/delegations'], ['POST', '/workspaces/w/commands'], ['GET', '/workspaces/w'], ['GET', '/workspaces/w/files/f'], ['GET', '/ai/subscriptions'], ['GET', '/workspaces/w/agent/query/extra']]) expect(agentRouteAllowed(method, route)).toBe(false);
  });
});

describe('工作助手读取接口（现有岗位与工作区权限）', () => {
  it('requires a personal session plus current ai:chat, and accepts no client-supplied scope or identity', async () => {
    const local = createMistLocalRuntime({ directory });
    const app = createMistServer(undefined, { local });
    await request(app).post('/api/mist/agent/delegations').send({}).expect(401);
    const { client } = await clientFor(app);
    await client.post('/api/mist/agent/delegations').send({ userId: 'local-operator', ceiling: ['*'] }).expect(400);
    const noAi = { ...local, authorize: async (db: any, prior: TokenPayload, permission?: string | null) => {
      const current = await local.authorize(db, prior);
      current.permissions = current.permissions?.filter(p => p !== 'ai:chat');
      if (permission && !hasScope(current, permission as any)) throw new MistApiError('FORBIDDEN', '无助手权限', 403);
      return current;
    } };
    const blocked = await clientFor(createMistServer(undefined, { local: noAi }));
    await blocked.client.post('/api/mist/agent/delegations').send({}).expect(403);
  });

  it('rejects tampered and expired tokens, never treating delegation as a Bearer or local cookie', async () => {
    let now = Date.now();
    const local = createMistLocalRuntime({ directory, now: () => now });
    const app = createMistServer(undefined, { local });
    const { client, cookieName } = await clientFor(app);
    const ws = (await client.get(W + 'default').expect(200)).body.workspace;
    const { delegation: d } = await issue(client);
    const endpoint = W + ws.id + '/agent/query';
    await request(app).get(endpoint).set(HEADER, d.token).expect(200);
    await request(app).get(endpoint).set(HEADER, d.token.slice(0, -1)).expect(401);
    await request(app).get(endpoint).set('Authorization', 'Bearer ' + d.token).expect(401);
    await request(app).get(endpoint).set('Cookie', `${cookieName}=${d.token}`).expect(401);
    // 即使附有有效本人 Cookie，委托头仍有更窄的优先级，不能退回本人身份。
    await client.get(endpoint).set(HEADER, 'broken').expect(401);
    now += AGENT_DELEGATION_TTL_MS;
    const expired = await request(app).get(endpoint).set(HEADER, d.token).expect(401);
    expect(expired.body.error.code).toBe('AGENT_DELEGATION_EXPIRED');
    const renewed = await issue(client);
    expect(renewed.delegation.token).not.toBe(d.token);
    await request(app).get(endpoint).set(HEADER, renewed.delegation.token).expect(200);
  });

  it('refuses every non-read surface and keeps the local cross-site guard', async () => {
    const app = createMistServer(undefined, { local: createMistLocalRuntime({ directory }) });
    const { client } = await clientFor(app);
    const ws = (await client.get(W + 'default').expect(200)).body.workspace;
    const { delegation: d } = await issue(client);
    for (const route of [W + ws.id + '/commands', W + ws.id + '/members', '/api/mist/agent/delegations', '/api/mist/ai/subscriptions/chatgpt/login']) await client.post(route).set(HEADER, d.token).send({}).expect(403);
    for (const route of [W + ws.id, W + ws.id + '/files/f', '/api/mist/ai/subscriptions', '/api/mist/ai/platform-model']) await client.get(route).set(HEADER, d.token).expect(403);
    await request(app).get(W + ws.id + '/agent/query').set(HEADER, d.token).set('Origin', 'https://untrusted.example').expect(403);
    const list = await request(app).get('/api/mist/workspaces').set(HEADER, d.token).expect(200);
    expect(list.headers['cache-control']).toBe('private, no-store');
    // 委托只拿到工作区标识与版本，不含 state / 成员等完整内容。
    expect(list.body.workspaces.length).toBeGreaterThan(0);
    for (const w of list.body.workspaces) expect(Object.keys(w).sort()).toEqual(['id', 'name', 'revision']);
    // 本地会话入口在 Mist router 之前，也不能用委托头读取、续签或切换本人会话。
    for (const call of [request(app).get('/api/mist/session'), request(app).post('/api/mist/session').send({ profileId: 'local-finance' })]) {
      const denied = await call.set(HEADER, d.token).expect(403);
      expect(denied.body.error.code).toBe('AGENT_FORBIDDEN');
      expect(denied.headers['set-cookie']).toBeUndefined();
      expect(denied.headers['cache-control']).toBe('private, no-store');
    }
    // 普通本人会话的既有行为不回归：Cookie 仍能读取完整工作区列表与本人会话。
    const own = (await client.get('/api/mist/workspaces').expect(200)).body.workspaces;
    expect(own.some((w: any) => w.state !== undefined || Object.keys(w).length > 3)).toBe(true);
    expect((await client.get('/api/mist/session').expect(200)).body.user.id).toBe('local-sales');
  });

  it.each(['local-sales', 'local-finance', 'local-qc'])('%s only reads its own allowed object types, with working get / expand references', async profileId => {
    const app = createMistServer(undefined, { local: createMistLocalRuntime({ directory }) });
    const { client } = await clientFor(app, profileId);
    const ws = (await client.get(W + 'default').expect(200)).body.workspace;
    const { delegation: d, readable } = await issue(client);
    const endpoint = W + ws.id + '/agent/';
    const allowed = agentCatalog(actor(profileId)).map(t => t.type);
    expect(readable.map((t: any) => t.type)).toEqual(allowed);
    if (profileId === 'local-qc') { expect(allowed).not.toContain('invoice'); expect(allowed).not.toContain('risk'); }
    const all = (await request(app).get(endpoint + 'query').query({ limit: 20 }).set(HEADER, d.token).expect(200)).body;
    expect(all.workspace).toEqual({ id: ws.id, name: ws.name, revision: ws.revision });
    expect(all.readableTypes).toEqual(allowed);
    expect(all.results.every((r: any) => allowed.includes(r.type))).toBe(true);
    for (const t of AGENT_OBJECT_TYPES) {
      const queried = await request(app).get(endpoint + 'query').query({ type: t.type, limit: 1 }).set(HEADER, d.token).expect(allowed.includes(t.type) ? 200 : 403);
      if (!allowed.includes(t.type)) { await request(app).get(endpoint + `objects/${t.type}/hidden`).set(HEADER, d.token).expect(403); continue; }
      const first = queried.body.results[0];
      if (!first) continue;
      expect(first).toMatchObject({ type: t.type, id: expect.any(String), label: expect.any(String) });
      const detail = (await request(app).get(endpoint + `objects/${t.type}/${encodeURIComponent(first.id)}`).set(HEADER, d.token).expect(200)).body.object;
      expect(detail).toMatchObject({ id: first.id, type: t.type, link: first.link, data: { id: first.id } });
      if (first.link) expect(new URL(first.link).searchParams.get('view')).toBe(t.view);
    }
    const firstOrder = (await request(app).get(endpoint + 'query?type=order').set(HEADER, d.token).expect(200)).body.results[0];
    expect(firstOrder.link).toContain('bambook://open?view=orders%2Fdetail&id=');
    const expanded = (await request(app).get(endpoint + `objects/order/${firstOrder.id}/related`).set(HEADER, d.token).expect(200)).body.object;
    expect(expanded.related.length).toBeGreaterThan(0);
    expect(expanded.related.every((r: any) => allowed.includes(r.type) && ['references', 'referenced_by'].includes(r.relation))).toBe(true);
    await request(app).get(endpoint + 'objects/order/missing').set(HEADER, d.token).expect(404);
    await request(app).get(endpoint + 'query?type=unsupported').set(HEADER, d.token).expect(400);
    await request(app).get(endpoint + 'query?limit=0').set(HEADER, d.token).expect(400);
  });

  it('rechecks workspace membership and account scopes on each read instead of trusting the issued snapshot', async () => {
    const local = createMistLocalRuntime({ directory });
    let denyInvoices = false;
    const runtime = { ...local, authorize: async (db: any, prior: TokenPayload, permission?: string | null) => {
      const a = await local.authorize(db, prior, permission);
      if (denyInvoices) a.permissions = a.permissions?.filter(p => p !== 'invoices:read');
      return a;
    } };
    const app = createMistServer(undefined, { local: runtime });
    const sales = (await clientFor(app)).client, qc = (await clientFor(app, 'local-qc')).client;
    let ws = (await sales.get(W + 'default').expect(200)).body.workspace;
    const salesToken = (await issue(sales)).delegation.token, qcToken = (await issue(qc)).delegation.token;
    const endpoint = W + ws.id + '/agent/query';
    await request(app).get(endpoint + '?type=invoice').set(HEADER, salesToken).expect(200);
    denyInvoices = true;
    await request(app).get(endpoint + '?type=invoice').set(HEADER, salesToken).expect(403);
    await request(app).get(endpoint).set(HEADER, qcToken).expect(404);
    const membership = (action: string, requestId: string) => sales.post(W + ws.id + '/members').send({ action, requestId, expectedRevision: ws.revision, account: 'local-qc' });
    ws = (await membership('add', 'add-qc').expect(200)).body.workspace;
    await request(app).get(endpoint + '?type=order').set(HEADER, qcToken).expect(200);
    ws = (await membership('remove', 'remove-qc').expect(200)).body.workspace;
    await request(app).get(endpoint).set(HEADER, qcToken).expect(404);
  });
});

it('bounds text, image and result sizes without losing stable object links; relation expansion uses reference fields only', () => {
  const owner = actor();
  const state = { orders: Array.from({ length: 100 }, (_, i) => ({ id: 'o-' + i, code: 'SO-' + i, customerId: 'c1', notes: 'x'.repeat(25_000), img: 'data:image/png;base64,SECRET', nested: { data: 'data:image/png;base64,SECRET' } })), customers: [{ id: 'c1', name: '客户一' }, { id: 'not-a-relation', name: 'o-0' }] } as any;
  const query = agentQuery(state, owner, { type: 'order', limit: 100 });
  expect(query.total).toBe(100); expect(query.results.length).toBeLessThanOrEqual(20); expect(query.truncated).toBe(true);
  expect(JSON.stringify(query).length).toBeLessThan(24_000);
  expect(agentQuery(state, owner, { type: 'order', q: 'SO-99' }).results[0].id).toBe('o-99');
  const got = agentGet(state, owner, 'order', 'o-0');
  expect(JSON.stringify(got)).not.toContain('SECRET'); expect(JSON.stringify(got).length).toBeLessThan(17_000);
  expect(got.link).toBe('bambook://open?view=orders%2Fdetail&id=o-0');
  const related = agentRelated(state, owner, 'order', 'o-0');
  expect(related.related.map(r => r.id)).toEqual(['c1']);
  expect(() => agentQuery(state, owner, { q: [] })).toThrow(/查询文字/);
});
