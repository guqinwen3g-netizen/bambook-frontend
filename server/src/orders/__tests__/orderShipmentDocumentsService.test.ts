import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordOrderShipmentDocumentSent, listOrderShipmentDocuments } from '../orderShipmentDocumentsService';
import { businessError } from '../../shared/errorCodes';

const fixtureState = vi.hoisted(() => ({
  orders: [] as any[], shipments: [] as any[], allocations: [] as any[], documents: [] as any[], versions: [] as any[], audits: [] as any[],
  archiveIds: new Set<string>(), deniedScope: '' as string,
}));

vi.mock('../../shipping/shipmentDocumentSource', () => ({
  currentDocumentActor: vi.fn(async (_tx: any, prior: any, scopes: string[]) => {
    if (!prior?.userId) throw businessError('UNAUTHORIZED', 'login required');
    if (fixtureState.deniedScope && scopes.includes(fixtureState.deniedScope)) throw businessError('FORBIDDEN', 'permission denied');
    return { userId: prior.userId, permissions: ['orders:read', 'orders:write', 'shipments:read', 'customs:read'] };
  }),
  authorizedDocumentOrders: vi.fn(async (_tx: any, _actor: any, ids: string[]) => {
    const rows = fixtureState.orders.filter(row => ids.includes(row.id) && row.deletedAt == null);
    if (rows.length !== ids.length) throw businessError('NOT_FOUND', 'order not visible');
    return rows;
  }),
  documentSourceFingerprint: (value: unknown) => JSON.stringify(value),
}));

vi.mock('../../customs/businessShipmentCiSnapshot', () => ({
  isBusinessShipmentCi: (doc: any) => doc?.type === 'CommercialInvoice' && doc?.sourceRef?.startsWith('business-ci:v1:shipment:') === true,
  readBusinessShipmentCiVersionInTx: async (_tx: any, documentId: string, _actor: any, options: any = {}) => {
    const document = fixtureState.documents.find(row => row.id === documentId);
    const rows = fixtureState.versions.filter(row => row.documentId === documentId).sort((a, b) => a.version - b.version);
    const latestVersion = rows.at(-1);
    const version = options.version === undefined ? latestVersion : rows.find(row => row.version === options.version);
    if (!document || !version || !latestVersion) throw businessError('NOT_FOUND', 'CI version absent');
    return { document, version, latestVersion, snapshot: version.content.commercialInvoiceSnapshot,
      fingerprint: `${document.id}:${version.id}` };
  },
}));

vi.mock('../../customs/shipmentPackingListCommand', () => ({
  readPackingListVersionInTx: async (_tx: any, options: any) => {
    const document = fixtureState.documents.find(row => row.id === options.documentId);
    const rows = fixtureState.versions.filter(row => row.documentId === options.documentId).sort((a, b) => a.version - b.version);
    const version = options.version === undefined ? rows.at(-1) : rows.find(row => row.version === options.version);
    if (!document || !version) throw businessError('NOT_FOUND', 'PL version absent');
    const snapshot = version.content.packingList;
    return { document, version, item: version, orderIds: snapshot.orderIds, envelope: snapshot, fingerprint: `${document.id}:${version.id}` };
  },
}));

vi.mock('../../customs/packingListArchiveService', () => ({
  readPackingListArchive: async (_db: any, options: any) => {
    const version = fixtureState.versions.find(row => row.documentId === options.documentId && row.version === options.version);
    if (!version || !fixtureState.archiveIds.has(version.id)) return null;
    return { version: version.version, proof: { auditId: `ARCHIVE_${version.id}`, documentId: options.documentId, versionId: version.id, version: version.version } };
  },
}));

vi.mock('../../customs/tradeDocumentLifecycleService', () => ({
  assertCiTradeDocumentArchive: async (_db: any, document: any) => {
    const latest = fixtureState.versions.filter(row => row.documentId === document.id).sort((a, b) => a.version - b.version).at(-1);
    if (!latest || !fixtureState.archiveIds.has(latest.id)) throw businessError('CONFLICT', 'not archived');
  },
}));

function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('path' in value) return value.path.reduce((current: any, part: string) => current?.[part], row[key]) === value.equals;
    }
    return row[key] === value;
  });
}

function db() {
  const tx: any = {
    order: { findFirst: async ({ where }: any) => fixtureState.orders.find(row => matches(row, where)) ?? null },
    shipment: {
      findFirst: async ({ where }: any) => fixtureState.shipments.find(row => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => fixtureState.shipments.filter(row => matches(row, where)),
    },
    shipmentOrderAllocation: {
      findFirst: async ({ where }: any) => fixtureState.allocations.find(row => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => fixtureState.allocations.filter(row => matches(row, where)),
    },
    tradeDocument: {
      findFirst: async ({ where }: any) => fixtureState.documents.find(row => matches(row, where)) ?? null,
      findMany: async ({ where }: any) => fixtureState.documents.filter(row => matches(row, where)),
    },
    documentVersion: {
      findFirst: async ({ where, orderBy }: any) => {
        const rows = fixtureState.versions.filter(row => matches(row, where)).sort((a, b) => orderBy?.version === 'desc' ? b.version - a.version : a.version - b.version);
        return rows[0] ?? null;
      },
      findUnique: async ({ where }: any) => fixtureState.versions.find(row => where.id ? row.id === where.id
        : row.documentId === where.documentId_version.documentId && row.version === where.documentId_version.version) ?? null,
    },
    auditLog: {
      findUnique: async ({ where }: any) => fixtureState.audits.find(row => row.id === where.id) ?? null,
      findMany: async ({ where }: any) => fixtureState.audits.filter(row => matches(row, where)),
      create: async ({ data }: any) => { if (fixtureState.audits.some(row => row.id === data.id)) throw Object.assign(new Error('unique'), { code: 'P2002' }); fixtureState.audits.push(data); return data; },
    },
    $queryRaw: async () => [],
  };
  const client = { ...tx, $transaction: async (run: any) => run(tx) };
  return client as any;
}

const actor = { userId: 'BUSINESS_USER', roles: [], permissions: ['*'], departmentIds: [] } as any;
const input = (patch: Record<string, unknown> = {}) => ({ requestKey: '01e83f59-2f16-4b37-9230-b3e32281d004', shipmentId: 'SHIP_1', documentId: 'TD_CI_1',
  versionId: 'VER_CI_1', version: 1, recipient: 'Purchasing contact <buyer@example.test>', ...patch });

function setup(type: 'CommercialInvoice' | 'PackingList' = 'CommercialInvoice') {
  fixtureState.orders = [{ id: 'ORDER_1', deletedAt: null }, { id: 'ORDER_2', deletedAt: null }];
  fixtureState.shipments = [{ id: 'SHIP_1', shipmentNumber: 'SHP-1', status: 'Booked', orderId: null, deletedAt: null }];
  fixtureState.allocations = [{ id: 'ALLOC_1', shipmentId: 'SHIP_1', orderId: 'ORDER_1', status: 'Planned' }];
  const ci = type === 'CommercialInvoice';
  fixtureState.documents = [{ id: ci ? 'TD_CI_1' : 'TD_PL_1', documentNumber: ci ? 'CI-1' : 'PL-1', domain: 'customs', type,
    status: ci ? 'Issued' : 'Draft', sourceInvoiceId: null, sourceRef: ci ? 'business-ci:v1:shipment:SHIP_1:package' : null,
    shipmentId: 'SHIP_1', filePath: ci ? 'trade-documents/ci-business-1.pdf' : null, deletedAt: null }];
  const documentId = fixtureState.documents[0].id;
  const versionId = ci ? 'VER_CI_1' : 'VER_PL_1';
  fixtureState.versions = [{ id: versionId, documentId, version: 1, content: ci
    ? { commercialInvoiceSnapshot: { protocolVersion: 1, shipmentId: 'SHIP_1', orderIds: ['ORDER_1'], lines: [], issuedAt: '2026-10-07T02:00:00.000Z' } }
    : { packingList: { shipmentId: 'SHIP_1', orderIds: ['ORDER_1'], lines: [] } } }];
  fixtureState.archiveIds = new Set([versionId]);
  fixtureState.audits = [ci ? { id: `CI_ARCHIVE_${versionId}`, actorId: 'LOGISTICS_USER', action: 'TRADE_DOCUMENT_FILE_GENERATED',
    targetType: 'TradeDocument', targetId: documentId, detail: { filePath: fixtureState.documents[0].filePath,
      businessCiVersionId: versionId, businessCiVersion: 1, fileName: 'ci.pdf', fileSize: 100, sha: 'a'.repeat(64) } }
    : { id: `ARCHIVE_${versionId}`, actorId: 'LOGISTICS_USER', action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: documentId,
      transactionId: `PL-ARCHIVE:${versionId}`, detail: { packingListArchive: { documentId, versionId, version: 1 } } }];
  fixtureState.deniedScope = '';
  return db();
}

describe('business order shipment document send record', () => {
  beforeEach(() => { setup(); });

  it('records the exact current issued and archived CI version with server time and customer recipient', async () => {
    const result = await recordOrderShipmentDocumentSent(db(), 'ORDER_1', actor, input());
    expect(result.replayed).toBe(false);
    expect(result.event).toMatchObject({ eventId: expect.any(String), shipmentId: 'SHIP_1', documentId: 'TD_CI_1',
      versionId: 'VER_CI_1', version: 1, recipient: 'Purchasing contact <buyer@example.test>', actorId: 'BUSINESS_USER' });
    expect(result.event).not.toHaveProperty('orderId');
    expect(result.event).not.toHaveProperty('requestKey');
    expect(result.event).not.toHaveProperty('payloadHash');
    expect(new Date(result.event.sentAt).toISOString()).toBe(result.event.sentAt);
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(1);
  });

  it('records the exact current archived PL version from the same order-bound business flow', async () => {
    const dbClient = setup('PackingList');
    const result = await recordOrderShipmentDocumentSent(dbClient, 'ORDER_1', actor,
      input({ documentId: 'TD_PL_1', versionId: 'VER_PL_1' }));
    expect(result.event).toMatchObject({ documentType: 'PackingList', versionId: 'VER_PL_1', shipmentId: 'SHIP_1' });
    expect(result.event).not.toHaveProperty('orderId');
  });

  it('treats an archived final Packing List as sendable without a separate Issued status', async () => {
    setup('PackingList');
    const result = await listOrderShipmentDocuments(db(), 'ORDER_1', actor);
    expect(result.documents[0].latestVersion).toMatchObject({ issued: false, archived: true, eligible: true });
    await expect(recordOrderShipmentDocumentSent(db(), 'ORDER_1', actor,
      input({ documentId: 'TD_PL_1', versionId: 'VER_PL_1' }))).resolves.toMatchObject({ replayed: false });
  });

  it('rejects a prior version even when that prior version had been archived', async () => {
    fixtureState.versions.push({ id: 'VER_CI_2', documentId: 'TD_CI_1', version: 2, content: { commercialInvoiceSnapshot: {
      protocolVersion: 1, shipmentId: 'SHIP_1', orderIds: ['ORDER_1'], lines: [], issuedAt: '2026-10-07T03:00:00.000Z' } } });
    fixtureState.archiveIds.add('VER_CI_2');
    await expect(recordOrderShipmentDocumentSent(db(), 'ORDER_1', actor, input())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(0);
  });

  it('new latest version makes prior send history non-current without inheriting sent status', async () => {
    const client = db();
    const first = await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input());
    fixtureState.versions.push({ id: 'VER_CI_2', documentId: 'TD_CI_1', version: 2, content: { commercialInvoiceSnapshot: {
      protocolVersion: 1, shipmentId: 'SHIP_1', orderIds: ['ORDER_1'], lines: [], issuedAt: null } } });
    fixtureState.documents[0].status = 'Draft';
    fixtureState.documents[0].filePath = null;
    const result = await listOrderShipmentDocuments(client, 'ORDER_1', actor);
    expect(result.documents[0]).toMatchObject({ currentSent: false, latestVersion: { id: 'VER_CI_2', version: 2, archived: false, eligible: false } });
    expect(result.documents[0].sendHistory).toHaveLength(1);
    expect(result.documents[0].sendHistory[0].eventId).toBe(first.event.eventId);
  });

  it('returns one shared document-level send state and history from each source order', async () => {
    const client = db();
    fixtureState.allocations.push({ id: 'ALLOC_2', shipmentId: 'SHIP_1', orderId: 'ORDER_2', status: 'Planned' });
    fixtureState.versions[0].content.commercialInvoiceSnapshot.orderIds = ['ORDER_1', 'ORDER_2'];
    const sent = await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input());
    const fromOrderOne = await listOrderShipmentDocuments(client, 'ORDER_1', actor);
    const fromOrderTwo = await listOrderShipmentDocuments(client, 'ORDER_2', actor);
    expect(fromOrderOne.documents[0].currentSent).toBe(true);
    expect(fromOrderTwo.documents[0].currentSent).toBe(true);
    expect(fromOrderTwo.documents[0].sendHistory).toEqual(fromOrderOne.documents[0].sendHistory);
    expect(fromOrderTwo.documents[0].sendHistory[0]).not.toHaveProperty('orderId');
    expect(fromOrderTwo.documents[0].sendHistory[0]).not.toHaveProperty('requestKey');
    expect(fromOrderTwo.documents[0].sendHistory[0].eventId).toBe(sent.event.eventId);
  });

  it('same key and payload replay the immutable event; a new key appends a deliberate resend', async () => {
    const client = db(), first = await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input());
    const replay = await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input());
    expect(replay).toMatchObject({ replayed: true, event: first.event });
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(1);
    const resend = await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input({ requestKey: 'a36fd647-64f9-4fba-b767-66a3396b3f0f' }));
    expect(resend.replayed).toBe(false);
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(2);
    expect((await listOrderShipmentDocuments(client, 'ORDER_1', actor)).documents[0].sendHistory).toHaveLength(2);
  });

  it('same request key with different payload conflicts and cannot replace the first record', async () => {
    const client = db();
    await recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input());
    await expect(recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input({ recipient: 'Different contact' })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(1);
  });

  it('prevents cross-order document use and missing current scopes', async () => {
    const client = db();
    const snapshot = fixtureState.versions[0].content.commercialInvoiceSnapshot;
    snapshot.orderIds = ['ORDER_2'];
    await expect(recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    fixtureState.versions[0].content.commercialInvoiceSnapshot = snapshot;
    fixtureState.deniedScope = 'customs:read';
    await expect(recordOrderShipmentDocumentSent(client, 'ORDER_1', actor, input({ requestKey: 'f237d2cb-6382-4632-8ff4-c6114dfb8b8b' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(0);
  });

  it('validates required fields before reading or writing business facts', async () => {
    await expect(recordOrderShipmentDocumentSent(db(), 'ORDER_1', actor, { ...input(), recipient: '  ' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixtureState.audits.filter(row => row.action === 'BUSINESS_SHIPMENT_DOCUMENT_SENT')).toHaveLength(0);
  });
});
