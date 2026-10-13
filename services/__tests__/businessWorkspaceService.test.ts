import { webcrypto, createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readBusinessWorkspace, continueBusinessWorkspace, type BusinessWorkspaceContext, type BusinessWorkspaceContinueCommand } from '../businessWorkspaceService';
const m = vi.hoisted(() => ({ actor: 'sales', department: 'A', scopes: ['products:read', 'products:write'] }));
vi.mock('../authService', () => ({ getAuthState: () => ({ isAuthenticated: true, user: { id: m.actor, department: m.department, permissions: m.scopes } }) }));
vi.mock('../apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'https://synthetic.invalid' }), getAuthHeaders: () => ({ Authorization: 'synthetic' }), buildApiUrl: (path: string) => `https://synthetic.invalid/api${path}` } }));
const scope = { kind: 'development_version' as const, caseId: 'case', sampleVersionId: 'minor' };
const context = (): BusinessWorkspaceContext => ({ schemaVersion: 1, scope, scopeFingerprint: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), overview: {}, childSummaries: [], currentNodeIds: ['tasks'],
  nodes: [{ id: 'tasks', label: '任务', precedingIds: [], status: 'current', hasHistory: false, canOpen: true, canContinue: false, blockedReasons: [], evidenceRefs: [] }] });
const command = (): BusinessWorkspaceContinueCommand => ({ scope, targetNodeId: 'qc', expectedContextFingerprint: 'b'.repeat(64), requestKey: 'original-key' });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const acknowledgement = (input = command()) => ({ context: context(), replayed: false, commandAck: { schemaVersion: 1, ...input, contextFingerprint: input.expectedContextFingerprint,
  scopeFingerprint: 'a'.repeat(64), commandFingerprint: digest(input), auditId: 'audit', actorId: m.actor } });
function response(data: unknown) { return { ok: true, status: 200, json: async () => ({ ok: true, data }) } as Response; }
beforeEach(() => { m.actor = 'sales'; m.department = 'A'; m.scopes = ['products:read', 'products:write']; vi.stubGlobal('fetch', vi.fn()); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());

it('reads only the explicitly selected version and validates the source identity', async () => {
  vi.mocked(fetch).mockResolvedValue(response(context())); const value = await readBusinessWorkspace(scope);
  expect(value.scope).toEqual(scope); expect(vi.mocked(fetch).mock.calls[0][0]).toContain('sampleVersionId=minor');
  vi.mocked(fetch).mockResolvedValue(response({ ...context(), scope: { ...scope, sampleVersionId: 'parent' } }));
  await expect(readBusinessWorkspace(scope)).rejects.toThrow('来源读回');
});
it('rejects stale responses after the current department or account changes', async () => {
  vi.mocked(fetch).mockImplementation(async () => { m.department = 'B'; return response(context()); });
  await expect(readBusinessWorkspace(scope)).rejects.toThrow('身份或数据端已变化');
});
it('does not accept a successful status without the business data envelope', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: context() }) } as Response);
  await expect(readBusinessWorkspace(scope)).rejects.toThrow('结果暂不可确认');
});
it('keeps an original command intact and validates its actor, version, key and complete fingerprint', async () => {
  const input = command(); vi.mocked(fetch).mockResolvedValue(response(acknowledgement(input)));
  expect((await continueBusinessWorkspace(input)).commandAck.auditId).toBe('audit');
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(input);
  for (const wrong of [{ requestKey: 'other' }, { actorId: 'other' }, { scope: { ...scope, sampleVersionId: 'parent' } }, { commandFingerprint: 'c'.repeat(64) }]) {
    vi.mocked(fetch).mockResolvedValue(response({ ...acknowledgement(input), commandAck: { ...acknowledgement(input).commandAck, ...wrong } }));
    await expect(continueBusinessWorkspace(input)).rejects.toThrow('原继续回执');
  }
});
it('accepts original success with a fresh blocked context without inventing current eligibility', async () => {
  const value = acknowledgement(); value.replayed = true; value.context.nodes[0] = { ...value.context.nodes[0], status: 'blocked', blockedReasons: [{ code: 'SOURCE_CHANGED', message: '实际来源已变更' }] };
  vi.mocked(fetch).mockResolvedValue(response(value)); const read = await continueBusinessWorkspace(command());
  expect(read.replayed).toBe(true); expect(read.context.nodes[0].blockedReasons[0].code).toBe('SOURCE_CHANGED');
});
