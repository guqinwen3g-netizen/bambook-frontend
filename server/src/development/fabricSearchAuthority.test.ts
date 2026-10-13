import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../auth/service';
import type { UserPermissionContext } from '../auth/permissionService';

const permissions = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../auth/permissionService', async original => ({
  ...await original<typeof import('../auth/permissionService')>(),
  createPermissionService: () => ({ getUserPermissionContext: permissions.load }),
}));
vi.mock('../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn() }));

import { currentDevelopmentActor, fabricSearchRouting, fabricSearchEligibleTeams } from './developmentPersonnelService';
import { createFabricSearchRouter } from './fabricSearchRoute';
import { createDevelopmentCase, updateDevelopmentCase } from './developmentCaseMutationService';

const fullScopes = ['products:read', 'products:write'];
const token = (ceiling = fullScopes, id = 'requester'): TokenPayload => ({
  userId: id, roles: [], roleIds: [], departmentIds: [], permissions: fullScopes, permissionCeiling: ceiling,
});
const context = (id: string, scopes = fullScopes): UserPermissionContext => ({
  primaryDeptId: 'dept',
  userId: id, roleIds: [], legacyRoleCodes: [], scopes, authorizationLoaded: true,
  departmentIds: [], departmentSubtreeIds: [],
});
type Task = { id: string; name: string; requesterId: string; assigneeId: string; status: string; revision: number;
  results: Array<{ assetId: string; asset: { mainCategory: string; deletedAt: null } }>;
  flowHistory: unknown[]; creationInput?: Record<string, unknown> };
function fixture(prior: TokenPayload | undefined = token()) {
  let task: Task = { id: 'task', name: '真实寻样需求', requesterId: 'requester', assigneeId: 'fabric-user',
    status: 'in_progress', revision: 2, results: [], flowHistory: [] };
  let currentScopes = [...fullScopes], accountActive = true, revokeDuringTaskRead = false;
  permissions.load.mockImplementation(async (id: string) => context(id, currentScopes));
  const users = ['requester', 'fabric-user', 'fabric-next'].map(id => ({ id, displayName: id, primaryDeptId:'dept', status: 'active', deletedAt: null }));
  const db = {
    userAccount: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => accountActive ? users.find(user => user.id === where.id) ?? null : null),
      findMany: vi.fn(async () => users) },
    team: { findFirst: vi.fn(async()=>({id:'team',name:'面料业务组',leaderId:'fabric-user'})), findMany: vi.fn(async () => [{ id: 'team', name: '面料业务组', departmentId:'dept', leaderId:'fabric-user', status: 'active', department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['fabric_business'] } },
      members: users.map(user => ({ userId: user.id })) }]) },
    fabricSearchTask: {
      findMany: vi.fn(async () => [task]),
      findFirst: vi.fn(async () => { if (revokeDuringTaskRead) currentScopes = ['products:read']; return task; }),
      findUnique: vi.fn(async () => null as Task | null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, results: [], revision: 0 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Partial<Task> }) => { task = { ...task, ...data, revision: task.revision + 1 }; return task; }),
    },
    productAsset: { findMany: vi.fn(async () => []) },
    notification: { create: vi.fn() },
  };
  const prisma = { ...db, $transaction: async <T>(work: (tx: typeof db) => Promise<T>) => work(db) };
  const router = createFabricSearchRouter({ prisma });
  type LocalResponse = { status: number; body: { error?: { code: string }; data?: unknown } };
  // Exercise the registered Express handler without opening a network listener.
  // The isolated native suite covers actual JWT middleware and HTTP transport.
  async function call(method: 'get' | 'post' | 'patch', path: string, body: unknown = {}) {
    const actual = path.split('/'), params: Record<string, string> = {};
    const layer = router.stack.find(candidate => {
      if (!candidate.route?.stack.some(handler => handler.method === method)) return false;
      const expected = String(candidate.route.path).split('/');
      if (expected.length !== actual.length) return false;
      return expected.every((part, index) => {
        if (part.startsWith(':')) { params[part.slice(1)] = actual[index]; return true; }
        return part === actual[index];
      });
    });
    if (!layer?.route) throw Error(`No actual route ${method} ${path}`);
    const result: LocalResponse = { status: 200, body: {} };
    const response = { status: (status: number) => { result.status = status; return response; },
      json: (value: LocalResponse['body']) => { result.body = value; return response; } };
    await Reflect.apply(layer.route.stack[0].handle, undefined,
      [{ actor: prior, authSource: 'user-session', params, body }, response, () => {}]);
    return result;
  }
  return { call, db, prisma, get task() { return task; }, setTask: (data: Partial<Task>) => { task = { ...task, ...data }; },
    revoke: () => { currentScopes = []; }, suspend: () => { accountActive = false; },
    revokeDuringRead: () => { revokeDuringTaskRead = true; } };
}
const createInput = { name: '深蓝羊毛寻样', initiator: 'internal', requestTeamId: 'team', assigneeId: 'fabric-user',
  requestText: '400gsm海军蓝', requestKey: 'original-create' };
beforeEach(() => { vi.clearAllMocks(); });

describe('fabric search current authority and signed credential ceiling', () => {
  it('requires a trusted matching subject rather than silently treating an omitted token as unlimited', async () => {
    const f = fixture();
    await expect(currentDevelopmentActor(f.prisma, 'requester', true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(currentDevelopmentActor(f.prisma, 'requester', true, token(fullScopes, 'other'))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(['create', 'update'] as const)('requires the credential on the shared case %s path even without an assignee edit', async operation => {
    const f = fixture();
    const params = { prisma: f.prisma as unknown as Parameters<typeof createDevelopmentCase>[0]['prisma'], actorId: 'requester' };
    const result = operation === 'create'
      ? await createDevelopmentCase({ ...params, input: { code: 'NO-CREDENTIAL', name: '不可凭空授予', type: 'fabric' } })
      : await updateDevelopmentCase({ ...params, caseId: 'case', input: { notes: '只改备注也须当前凭据' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });

  it.each(['create', 'update'] as const)('checks the signed ceiling on shared case %s before any case write', async operation => {
    const f = fixture();
    const params = { prisma: f.prisma as unknown as Parameters<typeof createDevelopmentCase>[0]['prisma'], actorId: 'requester', trustedActor: token(['products:read']) };
    const result = operation === 'create'
      ? await createDevelopmentCase({ ...params, input: { code: 'LIMITED', name: '只读凭据不可建案', type: 'fabric' } })
      : await updateDevelopmentCase({ ...params, caseId: 'case', input: { notes: '只读凭据不可编辑' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it.each(['/personnel', '/fabric-search', '/fabric-search/task'])(
    'denies read %s when current DB grants exceed the verified token ceiling', async path => {
      const f = fixture(token(['products:write']));
      const response = await f.call('get', path);
      expect(response.status).toBe(403); expect(response.body.error?.code).toBe('FORBIDDEN');
      expect(f.db.fabricSearchTask.findMany).not.toHaveBeenCalled(); expect(f.db.fabricSearchTask.findFirst).not.toHaveBeenCalled();
    });

  it.each([
    ['post', '/fabric-search', createInput],
    ['patch', '/fabric-search/task', { expectedRevision: 2, name: '修改方向' }],
    ['post', '/fabric-search/task/actions/accept', { expectedRevision: 2 }],
    ['post', '/fabric-search/task/actions/submit', { expectedRevision: 2, note: '无匹配', noMatch: true }],
    ['post', '/fabric-search/task/actions/return', { expectedRevision: 2, note: '继续找' }],
    ['post', '/fabric-search/task/actions/confirm', { expectedRevision: 2, note: '真实发起人确认' }],
    ['post', '/fabric-search/task/actions/transfer', { expectedRevision: 2, note: '换真实跟进人', assigneeId: 'fabric-next' }],
    ['post', '/fabric-search/task/complete', { expectedRevision: 2 }],
  ] as const)('denies %s %s when a read-only signed ceiling meets fresh full DB grants', async (method, path, body) => {
    const f = fixture(token(['products:read']));
    const response = await f.call(method, path, body);
    expect(response.status).toBe(403); expect(response.body.error?.code).toBe('FORBIDDEN');
    expect(f.db.fabricSearchTask.create).not.toHaveBeenCalled(); expect(f.db.fabricSearchTask.updateMany).not.toHaveBeenCalled();
    expect(f.db.fabricSearchTask.update).not.toHaveBeenCalled(); expect(f.db.notification.create).not.toHaveBeenCalled();
  });

  it('does not use a stale wildcard token after the current DB grants or account are withdrawn', async () => {
    const f = fixture(token(['*'])); f.revoke();
    expect((await f.call('get', '/fabric-search')).status).toBe(403);
    expect((await f.call('post', '/fabric-search', createInput)).status).toBe(403);
    const disabled = fixture(token(['*'])); disabled.suspend();
    expect((await disabled.call('get', '/fabric-search')).status).toBe(401);
  });

  it('rechecks write scope inside the transaction after reading the exact task', async () => {
    const f = fixture(token(fullScopes, 'fabric-user')); f.revokeDuringRead();
    const response = await f.call('patch', '/fabric-search/task', { expectedRevision: 2, name: '不能越过撤权' });
    expect(response.status).toBe(403); expect(f.db.fabricSearchTask.updateMany).not.toHaveBeenCalled();
    expect(f.db.fabricSearchTask.update).not.toHaveBeenCalled(); expect(f.db.notification.create).not.toHaveBeenCalled();
  });

  it('keeps legitimate matching read and write scopes usable without granting unrelated operations', async () => {
    const reader = fixture(token(['products:read'])); expect((await reader.call('get', '/fabric-search')).status).toBe(200);
    const writer = fixture(token(fullScopes)); expect((await writer.call('post', '/fabric-search', createInput)).status).toBe(200);
    expect(writer.db.fabricSearchTask.create).toHaveBeenCalledOnce();
  });
});


describe('fabric search configured team routing', () => {
  it('resolves omitted execution ownership to the configured business head', async () => {
    const f=fixture();
    await expect(fabricSearchRouting(f.prisma,'requester',{},token())).resolves.toEqual({routingTeamId:'team',responsibleHeadId:'fabric-user',assigneeId:null});
  });
  it('retains a directly selected eligible executor and head responsibility separately', async () => {
    const f=fixture();
    await expect(fabricSearchRouting(f.prisma,'requester',{assigneeId:'fabric-next'},token())).resolves.toEqual({routingTeamId:'team',responsibleHeadId:'fabric-user',assigneeId:'fabric-next'});
  });
  it('reports a missing head instead of creating a suspended task', async () => {
    const f=fixture();f.db.team.findFirst.mockResolvedValue({id:'team',name:'面料业务组',leaderId:null} as any);
    await expect(fabricSearchRouting(f.prisma,'requester',{},token())).rejects.toMatchObject({code:'ROUTING_HEAD_MISSING'});
  });
  it('rejects a head who is not an eligible current member', async () => {
    const f=fixture();f.db.team.findFirst.mockResolvedValue({id:'team',name:'面料业务组',leaderId:'departed'});
    await expect(fabricSearchRouting(f.prisma,'requester',{},token())).rejects.toMatchObject({code:'ROUTING_HEAD_MISSING'});
  });
  it('rejects a routing team outside the eligible directory', async () => {
    const f=fixture();await expect(fabricSearchRouting(f.prisma,'requester',{routingTeamId:'unrelated'},token())).rejects.toMatchObject({code:'ROUTING_TEAM_REQUIRED'});
  });
  it('withdrawn write permissions remove pool eligibility', async () => {
    const f=fixture();permissions.load.mockImplementation(async(id:string)=>context(id,['products:read']));
    await expect(fabricSearchEligibleTeams(f.prisma,'requester',token())).resolves.toEqual([]);
  });
});
