import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { qcService } from './qcService';

vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: '' }), buildApiUrl: (path: string) => path,
  getAuthHeaders: () => ({ 'X-Current-Session': 'synthetic-session' }),
} }));
const context = () => ({ ok: true, assignment: { id: 'A/1', orderId: 'O1', qcUserId: 'QC1',
  status: 'Assigned', inspectionType: 'final', updatedAt: 1790980000000, assignedAt: 1790873426000,
  dueDate: null, notes: null, completedAt: null, reportId: null, locationId: null, location: null },
  order: { id: 'O1', poNumber: 'PO1', type: 'fabric', product: '原任务面料', customer: '原客户' },
  lines: [{ id: 'L1', quantity: 100, unit: 'M' }] });
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => context() })));
afterEach(() => vi.unstubAllGlobals());

it('按当前任务读取检验资料，保留真实行及当前会话请求头', async () => {
  expect((await qcService.getAssignmentInspectionContext('A/1')).lines).toEqual(context().lines);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/qc/assignments/A%2F1/inspection-context', {
    headers: { 'X-Current-Session': 'synthetic-session' },
  });
});
it('无权限时保留明确拒绝，不把失败伪装成空行', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN', message: '当前账号无权检验此任务' } }) } as Response);
  await expect(qcService.getAssignmentInspectionContext('A/1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
});
it.each([
  { ...context(), assignment: { id: 'A2', orderId: 'O1' } },
  { ...context(), order: { id: 'O2' } },
  { ...context(), lines: undefined },
  { ...context(), lines: [{ id: '' }] },
  { ...context(), lines: [{ id: 'L1' }, { id: 'L1' }] },
])('错任务、错订单或损坏行明细必须失败', async body => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
  await expect(qcService.getAssignmentInspectionContext('A/1')).rejects.toThrow('验货资料返回不完整');
});
it('真实空行列表与读取故障分开', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ...context(), lines: [] }) } as Response);
  expect((await qcService.getAssignmentInspectionContext('A/1')).lines).toEqual([]);
});
