// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import repositoryWire from '../test-fixtures/qc-native-scoped-ack-wire.json';
import { beforeEach, afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { devLoginAs, type AuthUser } from './authService';
import { pendingQcCommands, submitQcCommand, type QcPendingCommand, type QcCommandAssignmentSnapshot, type QcCommandReportSnapshot, type QcInspectionReport } from './qcService';
const m = vi.hoisted(() => ({ endpoint: 'http://native.invalid/api', fetch: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: m.endpoint }), getAuthHeaders: () => ({ Authorization: 'Bearer private-dom-token' }), buildApiUrl: (p: string, endpoint?: string) => (endpoint ?? m.endpoint) + p } }));
const wire = process.env.BAMBOOK_QC_NATIVE_WIRE
  ? JSON.parse(readFileSync(process.env.BAMBOOK_QC_NATIVE_WIRE, 'utf8'))
  : repositoryWire;
const principal = (actor: any): AuthUser => ({ id: actor.userId, displayName: actor.displayName, email: '', roles: actor.roles,
  roleIds: actor.roleIds, permissions: actor.permissions, departmentIds: actor.departmentIds, department: null });
function original(kind: 'create' | 'complete' | 'decision') {
  const row = wire[kind], { requestKey, ...input } = row.input;
  const command: QcPendingCommand = kind === 'create' ? { kind, input } : kind === 'complete' ? { kind, assignmentId: row.assignmentId, input } : { kind, reportId: row.reportId, input };
  const operation = kind === 'create' ? `qc:scoped:create:${input.orderId}:${input.inspectionType}:${input.productionBatchId ?? 'whole_order'}` : `qc:scoped:${kind}:${kind === 'complete' ? row.assignmentId : row.reportId}`;
  const key = `bambook:business-request:v1:${encodeURIComponent(m.endpoint + '/v1')}:${encodeURIComponent(row.actor.userId)}:${encodeURIComponent(operation)}`;
  return { row, command, requestKey, key };
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', m.fetch); });
afterEach(() => vi.unstubAllGlobals());
it('modern exact ACK-only types preserve numeric|string milliseconds while the existing report GET DTO remains numeric', () => {
  expectTypeOf<QcCommandAssignmentSnapshot['assignedAt']>().toEqualTypeOf<number | string>();
  expectTypeOf<QcCommandReportSnapshot['createdAt']>().toEqualTypeOf<number | string>();
  expectTypeOf<QcInspectionReport['createdAt']>().toEqualTypeOf<number>();
});
it.each(['create', 'complete', 'decision'] as const)('actual native %s exact string ACK is consumed with the original durable key and payload without numeric conversion', async kind => {
  const { row, command, requestKey, key } = original(kind); await devLoginAs('private-dom-token', principal(row.actor));
  localStorage.setItem(key, JSON.stringify({ version: 1, requestId: requestKey, payload: command }));
  m.fetch.mockResolvedValue({ ok: true, status: kind === 'create' ? 201 : 200, json: async () => structuredClone(row.first) });
  const result = await submitQcCommand(command);
  expect(result).toEqual(row.first); expect(result.receipt.requestKey).toBe(requestKey); expect(pendingQcCommands()).toEqual([]);
  expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual(row.input); expect(localStorage.getItem(key)).toBeNull();
  if (kind === 'complete') expect(typeof result.report!.createdAt).toBe('string');
  else expect(typeof result.item.updatedAt).toBe('string');
});
