// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseShipmentCiSources, parseSourceDocumentSet, formatSourceAmount } from './documentSourceContracts';
import { apiService } from './apiService';

// Actual strict contracts and actual API clients; fetch/local browser config
// are transport storage seams, with no network, DB or producer facts created.
const BASE = 'http://native-document.invalid:8081/api';
const candidate = (id = 'INV-1') => ({ sourceInvoiceId: id, invoiceNumber: 'ORIGINAL-' + id, status: 'Issued', amount: '99999999999999.9999', currency: 'USD', canRegister: true,
  expectedSourceFingerprint: id + '-FP', orderIds: ['O1'], shipmentIds: ['S/1'] });
const sources = () => ({ schemaVersion: 1, shipmentId: 'S/1', expectedShipmentSourceFingerprint: 'SHIP-FP', orderIds: ['O1'], candidates: [candidate()] });
const documentSet = () => ({ shipment: { id: 'S/1', grossWeight: '1.001', netWeight: null, volume: '0.0001' }, source: { schemaVersion: 1, fingerprint: 'SHIP-FP', orderIds: ['O1'], kind: 'physical', cartonCoverageComplete: true },
  lines: [{ shipmentLineId: 'SL1', orderId: 'O1', orderLineId: 'OL1', productionBatchIds: ['PB1'], cartonItems: [], quantity: '3.2501', unitPrice: null, amount: null, grossWeight: '1.001', netWeight: null, volume: '0.001' }],
  totals: { quantity: '3.2501', amount: '99999999999999.9999', grossWeight: '1.001', netWeight: null, volume: '0.0001' }, orders: [], cartons: [], missing: [], customs: null,
  extras: { insurance: { insuredAmount: null, premium: null }, letterOfCredit: null } });
const response = (data: any, status = 200, html = '<html>original exact native version</html>') => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => html });
let transport: ReturnType<typeof vi.fn>;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('bambook_auth_token', 'synthetic-native-doc-token');
  transport = vi.fn(async () => response({ ok: true })); vi.stubGlobal('fetch', transport); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('native CI source contracts preserve the exact high amount and original ids without coercion or cloning', () => {
  const data = sources(); expect(parseShipmentCiSources(data, 'S/1')).toBe(data); expect(data.candidates[0].amount).toBe('99999999999999.9999');
});
it.each(['shipment', 'duplicate', 'amount', 'fingerprint', 'unrelated'])('invalid CI %s source is rejected instead of an empty candidate list', kind => {
  const data: any = sources(); if (kind === 'shipment') data.shipmentId = 'OTHER'; if (kind === 'duplicate') data.candidates.push(candidate());
  if (kind === 'amount') data.candidates[0].amount = 4.2501; if (kind === 'fingerprint') delete data.candidates[0].expectedSourceFingerprint; if (kind === 'unrelated') data.candidates[0].shipmentIds = ['OTHER'];
  expect(() => parseShipmentCiSources(data, 'S/1')).toThrow('原运单发票来源响应不完整');
});
it('source aggregate preserves null unknown values and real line/production identities without deriving commercial amounts', () => {
  const data = documentSet(); data.totals.amount = null as any; const result = parseSourceDocumentSet(data, 'S/1'); expect(result).toBe(data); expect(result.totals.amount).toBeNull();
  expect(result.lines[0]).toMatchObject({ orderLineId: 'OL1', productionBatchIds: ['PB1'], quantity: '3.2501', unitPrice: null, amount: null });
});
it.each(['shipment', 'number-total', 'number-line', 'scale', 'line-id'])('invalid native aggregate %s fails closed', kind => {
  const data: any = documentSet(); if (kind === 'shipment') data.shipment.id = 'OTHER'; if (kind === 'number-total') data.totals.amount = 4.2501;
  if (kind === 'number-line') data.lines[0].quantity = 3.2501; if (kind === 'scale') data.lines[0].quantity = '3.25001'; if (kind === 'line-id') delete data.lines[0].shipmentLineId;
  expect(() => parseSourceDocumentSet(data, 'S/1')).toThrow('原运单制单来源响应不完整');
});
it('source amount display retains all 18,4 precision and treats missing/invalid values as unknown', () => {
  expect(formatSourceAmount('99999999999999.9999')).toBe('99,999,999,999,999.9999'); expect(formatSourceAmount('0.0001')).toBe('0.0001');
  expect(formatSourceAmount('80.1000')).toBe('80.10'); expect(formatSourceAmount(null)).toBeNull(); expect(formatSourceAmount(undefined)).toBeNull(); expect(formatSourceAmount('1e20')).toBeNull();
  expect(String(Number('99999999999999.9999'))).not.toBe('99999999999999.9999');
});
it('actual document-set API uses the exact escaped native shipment path and runs the strict parser', async () => {
  const data = documentSet(); transport.mockResolvedValue(response(data)); expect(await apiService.getShipmentDocumentSet('S/1', BASE)).toEqual(data);
  expect(transport).toHaveBeenCalledWith(BASE + '/v1/shipping/S%2F1/document-set', expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-native-doc-token' }) }));
});
it('actual source API refuses malformed data and denied native reads rather than returning zero candidates', async () => {
  transport.mockResolvedValue(response({ ...sources(), candidates: [candidate(), candidate()] })); await expect(apiService.getShipmentCiSources('S/1', BASE)).rejects.toThrow('原运单发票来源响应不完整');
  transport.mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: '原来源当前不可见' } }, 403)); await expect(apiService.getShipmentCiSources('S/1', BASE)).rejects.toThrow('原来源当前不可见');
});
it.each([1, 9])('actual immutable preview API reads concrete v%s and never current Invoice rendering', async version => {
  transport.mockResolvedValue(response({}, 200, '<html>native-v' + version + '</html>'));
  expect(await apiService.getTradeDocumentVersionPreviewHtml('DOC/1', version, BASE)).toBe('<html>native-v' + version + '</html>');
  expect(transport).toHaveBeenCalledExactlyOnceWith(BASE + '/v1/customs/trade-documents/DOC%2F1/preview.html?version=' + version, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-native-doc-token' }) }));
});
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid immutable version %s does not issue an HTTP read', async version => {
  await expect(apiService.getTradeDocumentVersionPreviewHtml('DOC1', version, BASE)).rejects.toThrow('单据版本无效'); expect(transport).not.toHaveBeenCalled();
});
it('actual native CI registration passes source ids/fingerprints unchanged with no fabricated financial payload', async () => {
  const input = { shipmentId: 'S/1', types: ['CommercialInvoice' as const], sourceInvoiceId: 'INV-1', expectedSourceFingerprint: 'INV-FP', expectedShipmentSourceFingerprint: 'SHIP-FP' };
  transport.mockResolvedValue(response({ created: [], skipped: [], missing: [] })); await apiService.generateTradeDocumentsFromShipment(input, BASE);
  expect(transport).toHaveBeenCalledExactlyOnceWith(BASE + '/v1/customs/trade-documents/generate-from-shipment', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  expect(JSON.parse(transport.mock.calls[0][1].body)).not.toHaveProperty('amount'); expect(JSON.parse(transport.mock.calls[0][1].body)).not.toHaveProperty('currency');
});
it('actual raw CI render carries the same selected native source with no client reconstructed customer or amount', async () => {
  const binding = { sourceInvoiceId: 'INV-2', expectedSourceFingerprint: 'INV-FP', expectedShipmentSourceFingerprint: 'SHIP-FP' };
  transport.mockResolvedValue(response({}, 200, '<html>native-CI</html>')); expect(await apiService.renderShipmentDocument('S/1', 'CI', BASE, binding)).toBe('<html>native-CI</html>');
  expect(transport).toHaveBeenCalledExactlyOnceWith(BASE + '/v1/customs/trade-documents/render-by-shipment', expect.objectContaining({ method: 'POST', body: JSON.stringify({ shipmentId: 'S/1', kind: 'CI', ...binding }) }));
});
it('non-CI raw API passes only the original shipment source version and no Invoice requirement', async () => {
  transport.mockResolvedValue(response({}, 200, '<html>native-PL</html>')); await apiService.renderShipmentDocument('S/1', 'PL', BASE, { expectedShipmentSourceFingerprint: 'SHIP-FP' });
  expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ shipmentId: 'S/1', kind: 'PL', expectedShipmentSourceFingerprint: 'SHIP-FP' });
});
it('registered render conflict retains its actionable native error message instead of raw object text', async () => {
  transport.mockResolvedValue(response({ error: { code: 'CONFLICT', message: '原来源版本已变化，请重新读取' } }, 409));
  await expect(apiService.renderShipmentDocument('S/1', 'CI', BASE, { sourceInvoiceId: 'INV-1', expectedSourceFingerprint: 'INV-FP', expectedShipmentSourceFingerprint: 'SHIP-FP' })).rejects.toThrow('原来源版本已变化，请重新读取');
});
