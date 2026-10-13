// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { devLoginAs } from './authService';
import { pendingQcCommands, submitQcCommand, type QcPendingCommand } from './qcService';
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'http://qc-size.invalid/api' }),
  buildApiUrl: (path: string, endpoint?: string) => `${endpoint ?? 'http://qc-size.invalid/api'}${path}`,
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-token' }) } }));
const fingerprint = 'a'.repeat(64);
const facts = { schemaVersion: 1, actualSizes: ['M'], scopeComplete: true, basis: '实际生产核对',
  checks: [{ size: 'M', inspectedUnits: 2, result: 'pass', evidence: ['file:M-retest.pdf'] }] };
const command: QcPendingCommand = { kind: 'complete', assignmentId: 'A1', context: { poNumber: 'PO1', coverageLabel: '工厂A', scopeType: 'production_batch' },
  input: { expectedScopeFingerprint: fingerprint, report: { result: 'pass', totalUnits: 10, passedUnits: 10,
    criticalDefects: 0, majorDefects: 0, minorDefects: 0, productionSizeChecks: facts, resolvesProductionQcIssueIds: ['ISSUE-M'] } } };
function ack(body: any) { const { requestKey, ...input } = body; return { ok: true, replayed: false,
  item: { id: 'A1', scopeType: 'production_batch', productionBatchId: 'PB1', productionBatchRevision: 3, status: 'InProgress', reportId: 'R1' },
  report: { id: 'R1', ...input.report, scopeType: 'production_batch', productionBatchId: 'PB1', productionBatchRevision: 3,
    scopeFingerprint: input.expectedScopeFingerprint, inspectedBy: 'QC1', requestKey },
  receipt: { operation: 'complete', actorId: 'QC1', targetId: 'A1', requestKey, commandHash: 'b'.repeat(64), commandSnapshot: input } }; }
beforeEach(async () => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', m.fetch);
  await devLoginAs('synthetic-token', { id: 'QC1', displayName: 'QC人员', email: '', roles: [], permissions: ['qc:read', 'qc:write'], departmentIds: [], department: null }); });
afterEach(() => vi.unstubAllGlobals());
it('preserves an unknown original command and deeply verifies the exact size evidence and named issue receipt on retry', async () => {
  m.fetch.mockRejectedValueOnce(new Error('回复丢失'));
  await expect(submitQcCommand(command)).rejects.toThrow();
  const first = JSON.parse(m.fetch.mock.calls[0][1].body); expect(pendingQcCommands()).toHaveLength(1);
  m.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => ack(JSON.parse(String(options.body))) }));
  const response = await submitQcCommand(structuredClone(command));
  expect(JSON.parse(m.fetch.mock.calls[1][1].body)).toEqual(first);
  expect(response.report?.productionSizeChecks).toEqual(facts);
  expect(response.report?.resolvesProductionQcIssueIds).toEqual(['ISSUE-M']); expect(pendingQcCommands()).toEqual([]);
});
it.each(['evidence', 'issue', 'batch'] as const)('retains unresolved intent when exact %s readback differs despite an apparent successful POST', async field => {
  m.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    const response = ack(JSON.parse(String(options.body)));
    if (field === 'evidence') response.report.productionSizeChecks = { ...facts, checks: [{ ...facts.checks[0], evidence: ['file:other.pdf'] }] };
    if (field === 'issue') response.report.resolvesProductionQcIssueIds = ['ISSUE-OTHER'];
    if (field === 'batch') response.report.productionBatchId = 'PB2';
    return { ok: true, json: async () => response };
  });
  await expect(submitQcCommand(command)).rejects.toThrow(/回执/); expect(pendingQcCommands()).toHaveLength(1);
});
