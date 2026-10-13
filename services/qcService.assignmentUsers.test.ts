// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { qcService, submitQcCommand, pendingQcCommands, type QcPendingCommand } from './qcService';
import { devLoginAs, getAuthState, type AuthUser } from './authService';
const m = vi.hoisted(() => ({ endpoint: '', fetch: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: m.endpoint }),
  getAuthHeaders: () => ({ Authorization: 'Bearer ' + localStorage.getItem('bambook_auth_token') }),
  buildApiUrl: (path: string, endpoint?: string) => (endpoint ?? m.endpoint) + path } }));
const user = (id = 'dispatch', ceiling?: string[]): AuthUser => ({ id, displayName: '当前业务员', email: 'native@private.invalid',
  roles: ['sales'], roleIds: ['role-sales'], permissions: ['qc:read', 'qc:write'], permissionCeiling: ceiling, departmentIds: [], department: null });
const response = (data: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const command: QcPendingCommand = { kind: 'create', input: { orderId: 'O1', inspectionType: 'final', qcUserId: 'E1',
  locationId: null, dueDate: null, notes: null, scopeType: 'whole_order', productionBatchId: null, expectedScopeFingerprint: 'a'.repeat(64) } };
function ack(body: any) { const { requestKey, ...input } = body; return { ok: true,
  item: { ...input, id: 'A1', status: 'Assigned', assignedById: getAuthState().user!.id, requestKey,
    scopeFingerprint: input.expectedScopeFingerprint, productionBatchRevision: null },
  receipt: { operation: 'create', targetId: 'A1', actorId: getAuthState().user!.id, requestKey, commandHash: 'b'.repeat(64), commandSnapshot: input } }; }
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { resolve, promise }; }
beforeEach(async () => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); m.endpoint = 'http://native.invalid/api';
  vi.stubGlobal('fetch', m.fetch); await devLoginAs('token-a', user()); });
afterEach(() => vi.unstubAllGlobals());
it.each([
  [{ id: '', displayName: '姓名', departmentName: null }],
  [{ id: 'E1', displayName: '姓名', departmentName: null, email: 'sensitive@private.invalid' }],
  [{ id: 'E1', displayName: '姓名', departmentName: null }, { id: 'E1', displayName: '另一个人', departmentName: null }],
  [{ id: 'E1', displayName: '姓名' }],
])('malformed or nonminimal personnel envelope %j is unavailable rather than a guessed name list', async (...rows) => {
  m.fetch.mockResolvedValue(response({ ok: true, users: rows })); await expect(qcService.listAssignmentUsers()).rejects.toThrow('名单返回不完整');
});
it('structured backend refusal preserves code/status instead of pretending an empty roster', async () => {
  m.fetch.mockResolvedValue(response({ error: { code: 'AUTHORIZATION_UNAVAILABLE', message: '暂时无法核验执行人员' } }, 503));
  await expect(qcService.listAssignmentUsers()).rejects.toMatchObject({ status: 503, code: 'AUTHORIZATION_UNAVAILABLE' });
});
it.each(['account', 'token', 'endpoint', 'ceiling'] as const)('save %s ABA retains the exact unresolved key and payload; explicit original replay uses that same key', async mode => {
  const late = deferred(), sent: any[] = []; m.fetch.mockImplementation(async (_url, init) => { sent.push(JSON.parse(init.body)); return late.promise; });
  const first = submitQcCommand(command); const rejection = expect(first).rejects.toThrow('原请求回执不完整');
  const key = pendingQcCommands()[0].record.requestId;
  if (mode === 'account') { await devLoginAs('token-b', user('other')); await devLoginAs('token-a', user()); }
  else if (mode === 'token') { await devLoginAs('token-b', user()); await devLoginAs('token-a', user()); }
  else if (mode === 'ceiling') { await devLoginAs('token-a', user('dispatch', ['qc:read'])); await devLoginAs('token-a', user()); }
  else { m.endpoint = 'http://other.invalid/api'; window.dispatchEvent(new Event('focus')); m.endpoint = 'http://native.invalid/api'; window.dispatchEvent(new Event('focus')); }
  late.resolve(response(ack(sent[0]))); await rejection;
  expect(pendingQcCommands()).toHaveLength(1); expect(pendingQcCommands()[0].record.requestId).toBe(key);
  m.fetch.mockImplementation(async (_url, init) => { sent.push(JSON.parse(init.body)); return response(ack(sent[1])); });
  await expect(submitQcCommand(command)).resolves.toMatchObject({ ok: true }); expect(sent[1]).toEqual(sent[0]); expect(pendingQcCommands()).toEqual([]);
});
it('tampered native ACK cannot clear an original request key', async () => {
  m.fetch.mockImplementation(async (_url, init) => { const body = JSON.parse(init.body), data = ack(body); data.receipt.requestKey = 'wrong-key'; return response(data); });
  await expect(submitQcCommand(command)).rejects.toThrow('原请求回执不完整'); expect(pendingQcCommands()).toHaveLength(1);
});
