// @vitest-environment jsdom
import { randomUUID, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { devLoginAs } from './authService';
import { submitQcHandoff, pendingQcProfessionalCommands, uploadQcEvidence, type QcHandoffCommand } from './qcProfessionalService';
import { listBusinessRequests } from './businessRequestRecovery';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: 'http://professional-qc.invalid/api' }),
  buildApiUrl: (route: string, endpoint = 'http://professional-qc.invalid/api') => endpoint + route,
  getAuthHeaders: () => ({ Authorization: 'Bearer actual-inspector-session', 'Content-Type': 'application/json' }),
} }));
const fingerprint = 'a'.repeat(64);
const command: QcHandoffCommand = { assignmentId: 'A1', operation: 'claim', input: { expectedQcUserId: null,
  expectedUpdatedAt: '100', expectedScopeFingerprint: fingerprint, reason: '由我实际检验此工厂批次' } };
function handoffAck(body: Record<string, unknown>) {
  return { ok: true, item: { id: 'A1', qcUserId: 'QC1' }, receipt: { assignmentId: 'A1', operation: 'claim', actorId: 'QC1', requestKey: body.requestKey,
    fromQcUserId: null, toQcUserId: 'QC1', reason: command.input.reason, scopeFingerprint: fingerprint, commandHash: 'b'.repeat(64) } };
}
function file(bytes = [1, 2, 3]) {
  const value = new File([Uint8Array.from(bytes)], 'actual.pdf', { type: 'application/pdf' });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer }); return value;
}
beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle });
  await devLoginAs('professional-session', { id: 'QC1', displayName: '实际专业QC', email: '', roles: [], permissions: ['qc:read', 'qc:inspect'], departmentIds: [], department: null });
});
afterEach(() => vi.unstubAllGlobals());

it('recovers the exact original claim with an inspect-only account after an unknown response', async () => {
  mocks.fetch.mockRejectedValueOnce(Error('ack disconnected'));
  await expect(submitQcHandoff(command)).rejects.toThrow('ack disconnected');
  const original = JSON.parse(mocks.fetch.mock.calls[0][1].body); expect(pendingQcProfessionalCommands()).toHaveLength(1);
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => handoffAck(JSON.parse(String(options.body))) }));
  await submitQcHandoff(structuredClone(command));
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual(original); expect(pendingQcProfessionalCommands()).toEqual([]);
});
it('retains the original command on a different inspector receipt and never silently replaces its reason', async () => {
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => ({ ...handoffAck(JSON.parse(String(options.body))), item: { id: 'A1', qcUserId: 'OTHER' } }) }));
  await expect(submitQcHandoff(command)).rejects.toThrow('回执不完整');
  await expect(submitQcHandoff({ ...command, input: { ...command.input, reason: '不同交接内容' } })).rejects.toThrow('恢复原内容');
  expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(pendingQcProfessionalCommands()).toHaveLength(1);
});
it('refuses a current credential ceiling that does not allow professional execution before dispatching a request', async () => {
  await devLoginAs('bounded-session', { id: 'QC1', displayName: '实际QC', email: '', roles: [], permissions: ['qc:read', 'qc:inspect'], permissionCeiling: ['qc:read'], departmentIds: [], department: null });
  await expect(submitQcHandoff(command)).rejects.toThrow('专业 QC'); expect(mocks.fetch).not.toHaveBeenCalled();
});
it('reuses the same actual upload key and bytes after lost ACK, with multipart content headers managed by the browser', async () => {
  mocks.fetch.mockRejectedValueOnce(Error('file ack disconnected'));
  await expect(uploadQcEvidence('A1', fingerprint, file())).rejects.toThrow();
  const original = mocks.fetch.mock.calls[0][1].body as FormData, originalKey = original.get('requestKey');
  const record = listBusinessRequests<{ sha256: string }>('qc:professional:file:')[0].record;
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => ({ ok: true,
    requestKey: (options.body as FormData).get('requestKey'), file: { id: 'qef_123', sourceKind: 'assignment', sourceId: 'A1',
      sourceFingerprint: fingerprint, uploadedBy: 'QC1', sha256: record.payload.sha256, size: 3 } }) }));
  const uploaded = await uploadQcEvidence('A1', fingerprint, file());
  expect(uploaded.id).toBe('qef_123'); expect((mocks.fetch.mock.calls[1][1].body as FormData).get('requestKey')).toBe(originalKey);
  expect(mocks.fetch.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer actual-inspector-session' });
  expect(listBusinessRequests('qc:professional:file:')).toEqual([]);
});
it('does not replace an unresolved upload with new bytes or accept an unrelated source fingerprint', async () => {
  mocks.fetch.mockRejectedValueOnce(Error('unknown upload'));
  await expect(uploadQcEvidence('A1', fingerprint, file())).rejects.toThrow();
  await expect(uploadQcEvidence('A1', fingerprint, file([3, 2, 1]))).rejects.toThrow('恢复原内容');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => ({ ok: true,
    requestKey: (options.body as FormData).get('requestKey'), file: { id: 'qef_123', sourceKind: 'assignment', sourceId: 'OTHER', sourceFingerprint: 'b'.repeat(64), uploadedBy: 'QC1', sha256: 'c'.repeat(64), size: 3 } }) }));
  await expect(uploadQcEvidence('A1', fingerprint, file())).rejects.toThrow('回执待核'); expect(listBusinessRequests('qc:professional:file:')).toHaveLength(1);
});
