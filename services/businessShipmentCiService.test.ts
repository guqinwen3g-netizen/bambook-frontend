import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildApiUrl: vi.fn((path: string, endpoint?: string) => `${endpoint || 'https://api.test'}${path}`),
  getAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
  listTradeDocuments: vi.fn(),
  listTradeDocumentVersions: vi.fn(),
  generateTradeDocumentFile: vi.fn(),
}));
vi.mock('./apiService', () => ({ apiService: mocks }));

import {
  archiveBusinessShipmentCiVersion,
  createBusinessShipmentCiDraft,
  createBusinessShipmentCiRequestKey,
  issueBusinessShipmentCi,
  listBusinessShipmentCiDocuments,
  readBusinessShipmentCiSource,
  reviseBusinessShipmentCiDraft,
} from './businessShipmentCiService';

const line = (shipmentLineId = 'SL1') => ({ shipmentLineId, itemNo: '10', orderId: 'O1', orderLineId: 'OL1', productionBatchIds: ['PB1'],
  description: 'Jacket', materialCode: 'JKT', specification: { size: 'M' }, quantity: '2', unit: 'PCS', unitPrice: '12.5', amount: '25' });
const snapshot = (shipmentId = 'S1') => ({ protocolVersion: 1, sourceKind: 'shipment', shipmentId, packageKey: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
  orderIds: ['O1'], lines: [line()], totalAmount: '25', currency: 'USD', customerRelationId: 'C1', contractNumber: 'SC-01', letterOfCredit: null,
  parties: { billTo: { name: 'Buyer' }, shipTo: { name: 'Consignee' } }, paymentInstrument: 'TT', paymentTerms: '30 days', deliveryTerms: 'FOB', confirmedOrderSnapshot: [{ id: 'O1' }] });
const item = (status: 'Draft' | 'Issued' = 'Draft') => ({ id: 'TD1', documentNumber: 'CI-01', type: 'CommercialInvoice', domain: 'customs', status,
  sourceInvoiceId: null, shipmentId: 'S1', sourceRef: `business-ci:v1:shipment:S1:${'a'.repeat(64)}` });
const command = { lineIds: ['SL1'], requestKey: 'c'.repeat(64), expectedSourceFingerprint: 'b'.repeat(64) };
const response = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => ok ? { ok: true, data } : { ok: false, error: { message: 'server conflict' } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

it('reads only selected shipment line IDs and returns the server-verified CI snapshot', async () => {
  vi.mocked(fetch).mockResolvedValue(response(snapshot('S/1')) as any);
  const result = await readBusinessShipmentCiSource('S/1', ['SL2', 'SL1']);
  expect(result.shipmentId).toBe('S/1');
  expect(mocks.buildApiUrl).toHaveBeenCalledWith('/v1/shipping/S%2F1/business-ci/source', undefined);
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://api.test/v1/shipping/S%2F1/business-ci/source', expect.objectContaining({
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ lineIds: ['SL1', 'SL2'] }),
  }));
  expect(result).toMatchObject({ contractNumber: 'SC-01', currency: 'USD', totalAmount: '25', lines: [line()] });
});

it.each([
  ['draft', createBusinessShipmentCiDraft, '/v1/shipping/S1/business-ci/draft', 'Draft'],
  ['revise', (shipmentId: string, cmd: typeof command) => reviseBusinessShipmentCiDraft(shipmentId, 'TD/1', cmd), '/v1/shipping/S1/business-ci/TD%2F1/revise', 'Draft'],
  ['issue', (shipmentId: string, cmd: typeof command) => issueBusinessShipmentCi(shipmentId, 'TD/1', cmd), '/v1/shipping/S1/business-ci/TD%2F1/issue', 'Issued'],
] as const)('%s writes carry request key and source fingerprint and validate the returned document', async (_name, write, path, status) => {
  vi.mocked(fetch).mockResolvedValue(response({ item: { ...item(status), sourceRef: `business-ci:v1:shipment:S1:${'a'.repeat(64)}` }, versionId: 'DV1', replayed: false }) as any);
  const result = await write('S1', command as any);
  expect(vi.mocked(fetch)).toHaveBeenCalledWith(`https://api.test${path}`, expect.objectContaining({
    body: JSON.stringify(command), method: 'POST',
  }));
  expect(result).toMatchObject({ item: { id: 'TD1', status }, versionId: 'DV1', replayed: false });
});

it('rejects a malformed source or write command before it can be used as authority', async () => {
  vi.mocked(fetch).mockResolvedValue(response({ ...snapshot(), currency: null }) as any);
  await expect(readBusinessShipmentCiSource('S1', ['SL1'])).rejects.toThrow('业务 CI 原始出运快照响应不完整');
  await expect(createBusinessShipmentCiDraft('S1', { ...command, requestKey: 'uuid' })).rejects.toThrow('请求编号或来源指纹无效');
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

it('surfaces native service errors and never treats a failed response as a snapshot', async () => {
  vi.mocked(fetch).mockResolvedValue(response(null, false, 409) as any);
  await expect(readBusinessShipmentCiSource('S1', ['SL1'])).rejects.toThrow('server conflict');
});

it('lists only logistics-owned business CI records and filters financial or unrelated documents', async () => {
  mocks.listTradeDocuments.mockResolvedValue({ total: 2, items: [
    { ...item(), id: 'BUSINESS' },
    { ...item(), id: 'FINANCIAL', sourceInvoiceId: 'INV1' },
  ] });
  const result = await listBusinessShipmentCiDocuments('S1');
  expect(mocks.listTradeDocuments).toHaveBeenCalledWith({ type: 'CommercialInvoice', domain: 'customs', shipmentId: 'S1', limit: 200, offset: 0 }, undefined);
  expect(result.map(row => row.id)).toEqual(['BUSINESS']);
});

it('archives the exact latest issued version identified by version ID', async () => {
  const doc = item('Issued') as any;
  mocks.listTradeDocumentVersions.mockResolvedValue({ total: 2, items: [
    { id: 'DV1', documentId: 'TD1', version: 1, content: { commercialInvoiceSnapshot: snapshot() } },
    { id: 'DV2', documentId: 'TD1', version: 2, content: { commercialInvoiceSnapshot: { ...snapshot(), issuedAt: '2026-10-07T00:00:00Z' } } },
  ] });
  mocks.generateTradeDocumentFile.mockResolvedValue({ filePath: 'trade-documents/CI-01-v2.pdf', fileName: 'CI-01-v2.pdf', fileSize: 100 });
  const result = await archiveBusinessShipmentCiVersion(doc, 'DV2');
  expect(mocks.generateTradeDocumentFile).toHaveBeenCalledWith('TD1', { version: 2 }, undefined);
  expect(result).toMatchObject({ fileName: 'CI-01-v2.pdf', version: 2 });
});

it('creates a 64-character lowercase-hex idempotency key', () => {
  expect(createBusinessShipmentCiRequestKey()).toMatch(/^[a-f0-9]{64}$/);
});
