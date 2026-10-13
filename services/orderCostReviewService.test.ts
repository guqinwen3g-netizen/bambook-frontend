// @vitest-environment jsdom
// Real client and acknowledgement validators; only HTTP and the current session
// provider are substituted. This is not live HTTP/PG or a company-user UAT.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
const fixture = vi.hoisted(() => ({ endpoint: 'https://dc-a/api', token: 'Bearer alice', user: { id: 'alice', roles: ['owner'], permissions: ['pricing:read', 'sensitive:cost', 'invoices:write', 'invoices:reconcile'] as string[], permissionCeiling: undefined as string[] | undefined } }));
vi.mock('./apiService', () => ({ apiService: {
  buildApiUrl: (path: string) => fixture.endpoint + path, getStoredConfig: () => ({}), getAuthHeaders: () => ({ Authorization: fixture.token, 'Content-Type': 'application/json' }),
} }));
vi.mock('./authService', () => ({ getAuthState: () => ({ user: fixture.user, isAuthenticated: true }) }));
import { orderCostReviewService as service, captureReviewSession, inspectReviewFile, validateConfirmAck, validateUploadAck, reviewPermission, REVIEW_CATEGORIES, canonicalReview, type ConfirmCostReviewInput, type ReviewEvidence } from './orderCostReviewService';
const hash = (value: unknown) => createHash('sha256').update(canonicalReview(value)).digest('hex');
const fetchMock = vi.fn();
const input: ConfirmCostReviewInput = {
  sourceFingerprint: 'a'.repeat(64), bills: [{ invoiceId: 'AP1', purchaseOrderId: 'PO1', purchaseLineIds: ['PL1'], serviceDeliveryIds: ['PSD1'], treatment: 'cost', evidenceIds: ['E1'] }],
  supply: [{ movementId: 'M1', valuationInvoiceId: 'AP2', orderLineId: 'OL1', inputQuantity: '10', usedQuantity: '8', lossQuantity: '1', unusedQuantity: '1', unit: 'M', evidenceIds: ['E1'] }],
  expenses: [{ costRecordId: 'CR1', category: 'logistics', treatment: 'cost', note: '实际承担', exchangeRate: '7.2', evidenceIds: ['E1'], fxEvidenceIds: ['E1'] }],
  coverage: Object.fromEntries(REVIEW_CATEGORIES.map(key => [key, { status: 'verified', note: '已核实', evidenceIds: ['E1'] }])) as any,
  expectedRevision: 0, requestId: 'req-original', note: '整单来源已核实',
};
const confirmation = (command = input): any => {
  const { expectedRevision, requestId, note, ...body } = command;
  return { replayed: false, item: { id: 'R1', orderId: 'O/1', revision: expectedRevision + 1, auditId: 'A1', confirmedBy: 'alice', confirmedAt: '1790850000000', sourceFingerprint: command.sourceFingerprint, requestKey: hash({orderId:'O/1',actorId:'alice',requestId}), requestFingerprint: hash(command),
    linesSnapshot: { input: body, request: { expectedRevision, requestId, note } }, coverageSnapshot: body.coverage, actualCostCny: 0, actualRevenueCny: 0 } };
};
const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
function file(bytes = '%PDF-original', name = 'evidence.pdf') {
  const result = new File([bytes], name, { type: 'application/pdf' });
  const buffer = new TextEncoder().encode(bytes).buffer;
  Object.defineProperty(result, 'arrayBuffer', { value: async () => buffer }); return result;
}
beforeEach(() => {
  fixture.endpoint = 'https://dc-a/api'; fixture.token = 'Bearer alice'; fixture.user.id = 'alice'; fixture.user.permissions = ['pricing:read', 'sensitive:cost', 'invoices:write', 'invoices:reconcile']; fixture.user.permissionCeiling = undefined;
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset();
});
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('encodes the actual order path, sends complete original confirm input, and accepts explicit measured zero', async () => {
  fetchMock.mockResolvedValue(response(confirmation(), 201));
  const result = await service.confirm('O/1', input);
  const [url, init] = fetchMock.mock.calls[0]; expect(url).toBe('https://dc-a/api/v1/pricing/order-cost-reviews/O%2F1/confirm');
  expect(JSON.parse(init.body)).toEqual(input); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer alice'); expect(init.credentials).toBe('include'); expect(result.item.actualCostCny).toBe(0);
});
it.each(['request', 'input', 'actor', 'order', 'revision', 'coverage'])('rejects a mismatching immutable confirmation %s fact', async field => {
  const value = confirmation();
  if (field === 'request') value.item.linesSnapshot.request.requestId = 'other-request';
  if (field === 'input') value.item.linesSnapshot.input = { ...value.item.linesSnapshot.input, expenses: [] };
  if (field === 'actor') value.item.confirmedBy = 'bob';
  if (field === 'order') value.item.orderId = 'other-order';
  if (field === 'revision') value.item.revision = 2;
  if (field === 'coverage') value.item.coverageSnapshot = { ...value.item.coverageSnapshot, logistics: { status: 'not_applicable', note: '不同', evidenceIds: ['E1'] } };
  expect(() => validateConfirmAck(value, 'O/1', captureReviewSession(), input)).toThrow('完整原请求');
});
it('keeps 503 and malformed success acknowledgements explicit as unknown rather than a confirmed result', async () => {
  fetchMock.mockResolvedValueOnce(response({ error: { code: 'ORDER_COST_REVIEW_FAILED', message: '事务结果待核' } }, 503));
  await expect(service.confirm('O/1', input)).rejects.toMatchObject({ status: 503, code: 'ORDER_COST_REVIEW_FAILED' });
  fetchMock.mockResolvedValueOnce(response({ current: { status: 'complete' }, currentRevision: 99 }));
  await expect(service.confirm('O/1', input)).rejects.toMatchObject({ code: 'ACK_UNKNOWN' });
});
it('a real abort at the client deadline remains unknown and preserves the original command for retry',async()=>{
  vi.useFakeTimers();fetchMock.mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  const pending=service.confirm('O/1',input);const assertion=expect(pending).rejects.toMatchObject({code:'ACK_UNKNOWN',message:'请求超时，结果尚未确认，请重试原请求'});await vi.advanceTimersByTimeAsync(30000);await assertion;expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
});
it('declared PDF extension cannot disguise non-PDF evidence bytes',async()=>{
  await expect(inspectReviewFile(file('not a PDF'),'说明')).rejects.toThrow('内容与扩展名相符');expect(fetchMock).not.toHaveBeenCalled();
});
it('uploads one multipart original file/note/requestId and validates the exact audited file receipt', async () => {
  const original = file(), metadata = await inspectReviewFile(original, ' 文件说明 ');
  const evidence: ReviewEvidence = { id: 'E1', orderId: 'O/1', createdBy: 'alice', createdAt: '1790850000000', auditId: 'AE1', requestId: 'upload-original', requestKey: hash({orderId:'O/1',actorId:'alice',requestId:'upload-original'}), requestFingerprint:hash(metadata), ...metadata };
  fetchMock.mockResolvedValue(response({ evidence, replayed: true }, 200));
  const result = await service.upload('O/1', original, 'upload-original', metadata);
  const [, init] = fetchMock.mock.calls[0]; expect(init.body).toBeInstanceOf(FormData); expect([...init.body.keys()].sort()).toEqual(['file', 'note', 'requestId']);
  expect(init.body.get('requestId')).toBe('upload-original'); expect(init.body.get('note')).toBe('文件说明'); expect(new Headers(init.headers).has('Content-Type')).toBe(false); expect(result.evidence.sha256).toBe(metadata.sha256);
});
it.each(['requestId', 'sha256', 'note', 'createdBy', 'orderId', 'auditId'])('upload %s cannot acknowledge a different or incomplete original command', async field => {
  const metadata = await inspectReviewFile(file(), '文件说明');
  const evidence: any = { id: 'E1', orderId: 'O/1', createdBy: 'alice', createdAt: '1', auditId: 'AE1', requestId: 'upload-original', ...metadata };
  evidence[field] = field === 'auditId' ? '' : 'different';
  expect(() => validateUploadAck({ evidence, replayed: false }, 'O/1', captureReviewSession(), 'upload-original', metadata)).toThrow('完整原文件');
});
it('a re-selected different original file is blocked before any HTTP mutation', async () => {
  const metadata = await inspectReviewFile(file(), '文件说明');
  await expect(service.upload('O/1', file('%PDF-other'), 'upload-original', metadata)).rejects.toThrow('原上传命令不同'); expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['actor', 'token', 'endpoint', 'permissions'])('drops late HTTP data after current %s changes', async field => {
  let resolve!: (value: any) => void; fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = service.preview('O/1', (({ expectedRevision, requestId, note, ...rest }) => rest)(input));
  if (field === 'actor') fixture.user.id = 'bob';
  if (field === 'token') fixture.token = 'Bearer replaced';
  if (field === 'endpoint') fixture.endpoint = 'https://dc-b/api';
  if (field === 'permissions') fixture.user.permissions = [];
  resolve(response({ status: 'complete', pendingReasons: [] }));
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
});
it('explicit empty permissions and a bounded owner credential cannot restore the two write grants', () => {
  fixture.user.permissions = []; expect(reviewPermission('invoices:write')).toBe(false);
  fixture.user.permissions = ['*']; fixture.user.permissionCeiling = ['pricing:read']; expect(reviewPermission('invoices:write')).toBe(false); expect(reviewPermission('pricing:read')).toBe(true);
});
it.each(['requestKey','requestFingerprint'])('confirm rejects incorrect original-command %s even if all readable fields match', async field => {
  const value=confirmation(); value.item[field]='f'.repeat(64); fetchMock.mockResolvedValue(response(value));
  await expect(service.confirm('O/1',input)).rejects.toMatchObject({code:'ACK_UNKNOWN'});
});
const retired = () => ({kind:'Retired',orderId:'O/1',actorId:'alice',requestId:input.requestId,command:input,auditId:'retire-audit',createdAt:'1',replayed:false,requestKey:hash({orderId:'O/1',actorId:'alice',requestId:input.requestId}),requestFingerprint:hash(input)});
it('retires only an exact audited original command and preserves an already-confirmed result', async () => {
  fetchMock.mockResolvedValueOnce(response(retired())); expect((await service.retire('O/1',input)).kind).toBe('Retired');
  expect(fetchMock.mock.calls[0][0]).toBe('https://dc-a/api/v1/pricing/order-cost-reviews/O%2F1/requests/retire'); expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
  const confirmed=confirmation();fetchMock.mockResolvedValueOnce(response({kind:'Confirmed',...confirmed,requestId:input.requestId,requestKey:confirmed.item.requestKey,requestFingerprint:confirmed.item.requestFingerprint,replayed:true})); expect((await service.retire('O/1',input)).kind).toBe('Confirmed');
});
it('a confirmed retirement response must bind its outer command identity to the original confirmed fact',async()=>{
  const confirmed=confirmation();fetchMock.mockResolvedValue(response({kind:'Confirmed',...confirmed,requestId:'other',requestKey:confirmed.item.requestKey,requestFingerprint:confirmed.item.requestFingerprint}));await expect(service.retire('O/1',input)).rejects.toMatchObject({code:'ACK_UNKNOWN'});
});
it.each(['command','actorId','orderId','auditId','requestId','requestKey','requestFingerprint','kind'])('retire rejects mismatching or incomplete %s acknowledgement', async field => {
  const value:any=retired(); value[field]=field==='command'?{...input,note:'changed'}:field==='auditId'?'':'different'; fetchMock.mockResolvedValue(response(value));
  await expect(service.retire('O/1',input)).rejects.toMatchObject({code:'ACK_UNKNOWN'});
});
it('authenticated private download verifies original bytes and creates only a local blob download', async () => {
  const original = file(), metadata = await inspectReviewFile(original, '凭据');
  const blob = { arrayBuffer: () => original.arrayBuffer() } as Blob;
  fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
  const create = vi.fn(() => 'blob:private-file'), revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  await service.download('O/1', { id: 'E/1', orderId: 'O/1', auditId: 'AE1', createdBy: 'alice', createdAt: '1', ...metadata });
  expect(fetchMock.mock.calls[0][0]).toBe('https://dc-a/api/v1/pricing/order-cost-reviews/O%2F1/evidence/E%2F1/download');
  expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer alice'); expect(create).toHaveBeenCalledWith(blob); expect(click).toHaveBeenCalledTimes(1); expect(document.querySelector('a')).toBeNull(); click.mockRestore();
});
it('private download with different content cannot create a browser download even when HTTP succeeds',async()=>{
  const metadata=await inspectReviewFile(file(),'凭据'),create=vi.fn();Object.defineProperty(URL,'createObjectURL',{configurable:true,value:create});fetchMock.mockResolvedValue({ok:true,status:200,blob:async()=>({arrayBuffer:()=>file('%PDF-other').arrayBuffer()})});
  await expect(service.download('O/1',{id:'E1',orderId:'O/1',auditId:'AE1',createdBy:'alice',createdAt:'1',...metadata})).rejects.toThrow('原文件不一致');expect(create).not.toHaveBeenCalled();
});
