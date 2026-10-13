import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../apiService', () => ({ apiService: { buildApiUrl: (path: string) => path, getAuthHeaders: () => ({}) } }));
import { allocateInternalFabric } from '../internalFabricService';
const command = { requestKey: 'same-original-key', fabricOrderLineId: 'F/L', metres: '600.0000', expectedRevision: 0 };
const result = () => ({ allocation: { id: 'A', garmentOrderId: 'G', garmentOrderLineId: 'G/L', fabricOrderLineId: 'F/L', metres: '600', revision: 1, status: 'active', auditId: 'AUD' },
  commandAck: { protocolVersion: 1, actorId: 'actual', requestKey: command.requestKey, allocationId: 'A', garmentOrderLineId: 'G/L', fabricOrderLineId: 'F/L', metres: '600', revision: 1, status: 'active', auditId: 'AUD' } });
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
function answer(data: unknown) { fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data }) }); }
describe('exact internal material acknowledgements', () => {
  it('accepts an accurate original command and canonical decimal readback', async () => {
    answer(result()); expect((await allocateInternalFabric('G', 'G/L', command)).allocation.metres).toBe('600');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(command);
  });
  it.each(['key', 'source', 'metres', 'audit', 'revision'])('rejects mismatched %s instead of reporting saved', async kind => {
    const data = result();
    if (kind === 'key') data.commandAck.requestKey = 'different';
    if (kind === 'source') { data.commandAck.fabricOrderLineId = 'wrong'; data.allocation.fabricOrderLineId = 'wrong'; }
    if (kind === 'metres') { data.commandAck.metres = '601'; data.allocation.metres = '601'; }
    if (kind === 'audit') data.commandAck.auditId = 'wrong';
    if (kind === 'revision') { data.commandAck.revision = 2; data.allocation.revision = 2; }
    answer(data); await expect(allocateInternalFabric('G', 'G/L', command)).rejects.toThrow('核对');
  });
});
