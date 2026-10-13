/** Deterministic transactional storage substitute, NOT PostgreSQL proof.
 * Production source/auth/lock helpers are never mocked. Native PG execution,
 * connection identity, SQL locks and physical producer fixtures belong to root. */
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';
export const scopes = ['shipments:read', 'orders:read', 'invoices:read', 'customs:read', 'customs:write'];
export const actor: TokenPayload = { userId: 'u', displayName: 'Finance', roles: ['finance'], permissions: scopes, authorizationLoaded: true } as TokenPayload;
export const decimal = (value: string) => new Prisma.Decimal(value);
function clone(value: any): any {
  if (value instanceof Prisma.Decimal) return decimal(value.toString());
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, clone(row)]));
  return value;
}
function match(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: any) => {
    if (value === undefined) return true;
    // The actual DocumentVersion original compound PK is not a nested JSON field.
    if (key === 'documentId_version') return match(row, value);
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((part: any) => match(row, part));
    if (key === 'OR') return value.some((part: any) => match(row, part));
    if (value == null) return row[key] == null;
    if (typeof value !== 'object' || value instanceof Date || value instanceof Prisma.Decimal) return row[key] === value;
    if ('in' in value) return value.in.includes(row[key]);
    if ('not' in value) return row[key] !== value.not;
    if ('has' in value) return (row[key] ?? []).includes(value.has);
    if ('contains' in value) return value.mode === 'insensitive' ? String(row[key] ?? '').toLowerCase().includes(String(value.contains).toLowerCase()) : String(row[key] ?? '').includes(value.contains);
    if ('startsWith' in value) return String(row[key] ?? '').startsWith(value.startsWith);
    if ('path' in value) { const actual = value.path.reduce((part: any, p: string) => part?.[p], row[key]); return actual === value.equals; }
    if ('gt' in value) return row[key] > value.gt;
    return match(row[key] ?? {}, value);
  });
}
export function storage() {
  const tables: Record<string, any[]> = {
    userAccount: [{ id: 'u', displayName: 'Finance', status: 'active', deletedAt: null, roles: [{ roleId: 'role-finance', role: { permissions: [] } }] }],
    userPermissionOverrides: scopes.map((scope, i) => ({ id: 'G' + i, userId: 'u', scope, isActive: true, deletedAt: null, expiresAt: null })),
    order: [{ id: 'O', orderNumber: 'SO-001', poNumber: 'PO-001', customer: 'Buyer', customerRelationId: 'R', ownerId: 'u', deletedAt: null,
      currency: 'USD', deliveryTerms: 'FOB SHANGHAI', paymentTerms: 'T/T' }],
    orderLine: [{ id: 'OL', orderId: 'O', lineNumber: 7, itemNo: 'FAB-1', description: 'Original fabric', unit: 'm',
      quantity: decimal('100'), unitPrice: decimal('10'), netValue: decimal('1000'), materialCode: null, confirmedSourceId: null, confirmedSourceType: null }],
    shipment: [{ id: 'S', shipmentNumber: 'SH-001', orderId: 'O', customerRelationId: 'R', status: 'Planned', deletedAt: null, type: 'Export', createdAt: BigInt(1), updatedAt: BigInt(1) }],
    shipmentOrderAllocation: [{ id: 'A', shipmentId: 'S', orderId: 'O', orderLineId: 'OL', plannedQty: decimal('20'), actualQty: decimal('20'), unit: 'm', status: 'Planned' }],
    shipmentProductionAllocation: [], productionBatch: [], shipmentLine: [{ id: 'SL', shipmentId: 'S', lineNumber: 1, orderLineId: 'OL', quantity: decimal('20'), unit: 'm', grossWeight: decimal('2.345'), netWeight: null, volume: null }],
    shipmentCarton: [{ id: 'C', shipmentId: 'S', cartonNo: 'BOX-A', grossWeight: decimal('2.345'), netWeight: null, volume: null }],
    shipmentCartonItem: [{ id: 'I', cartonId: 'C', shipmentLineId: 'SL', quantity: decimal('20') }],
    invoice: [{ id: 'INV', invoiceNumber: 'FIN-001', type: 'Receivable', status: 'Issued', amount: decimal('200'), currency: 'USD',
      customerRelationId: 'R', ownerId: 'u', orderId: 'O', dueDate: '2000-01-01', issueDate: '2026-10-03', deletedAt: null, createdAt: BigInt(1), updatedAt: BigInt(1) }],
    invoiceOrderAllocation: [{ id: 'IOA', invoiceId: 'INV', orderId: 'O', batchId: 'FB', allocatedAmount: decimal('200'), deletedAt: null }],
    orderShipmentBatch: [{ id: 'FB', orderId: 'O', shipmentId: 'S', batchNumber: 'B-1', currency: 'USD', customerRelationId: 'R', status: 'planned', deletedAt: null }],
    relation: [{ id: 'R', name: 'Buyer', englishName: 'Buyer Ltd', ownerId: 'u', salesRepIds: [], deletedAt: null }],
    tradeDocument: [], documentVersion: [], auditLog: [], sample: [], releaseScope: [], ppSampleRelease: [], productAsset: [],
    claimDisposition: [], repairWorkOrder: [], customsDeclaration: [], letterOfCredit: [], systemConfig: [], teamMember: [], teamDataGrant: [],
  };
  const lockCalls: string[] = [], calls: string[] = [], queries: { model: string; operation: string; args: any }[] = [];
  let hook: ((model: string, operation: string, result: any) => void | Promise<void>) | undefined;
  const written = ['tradeDocument', 'documentVersion', 'auditLog'];
  function database(working?: Record<string, any[]>) {
    const db: any = {};
    const table = (model: string) => working && written.includes(model) ? working[model] : tables[model];
    for (const model of Object.keys(tables)) {
      const finish = async (operation: string, result: any) => { calls.push(model + '.' + operation); await hook?.(model, operation, result); return result; };
      const find = (args: any = {}) => {
        let rows = table(model).filter(row => match(row, args.where));
        if (args.orderBy) {
          const ordering = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
          rows = [...rows].sort((a, b) => {
            for (const part of ordering) for (const [key, direction] of Object.entries(part)) {
              const comparison = (a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1) * (direction === 'desc' ? -1 : 1);
              if (comparison) return comparison;
            }
            return 0;
          });
        }
        if (args.skip !== undefined) rows = rows.slice(args.skip);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map(row => {
          let result = clone(row);
          if (model === 'order' && args.include?.lines) result.lines = tables.orderLine.filter(line => line.orderId === row.id).map(clone);
          if (model === 'shipmentCarton' && args.include?.items) result.items = tables.shipmentCartonItem.filter(item => item.cartonId === row.id).map(clone);
          if (args.select) result = Object.fromEntries(Object.entries(args.select).filter(([, value]) => value).map(([key]) => [key, result[key]]));
          return result;
        });
      };
      db[model] = {
        findMany: (args: any) => { queries.push({ model, operation: 'findMany', args: clone(args) }); return finish('findMany', find(args)); }, findFirst: (args: any) => finish('findFirst', find(args)[0] ?? null),
        findUnique: (args: any) => finish('findUnique', find(args)[0] ?? null), count: (args: any) => finish('count', find(args).length),
        create: async ({ data }: any) => { table(model).push(clone(data)); return finish('create', clone(data)); },
        update: async ({ where, data }: any) => { const row = table(model).find(row => match(row, where)); if (!row) throw Error('ROW_MISSING'); Object.assign(row, clone(data)); return finish('update', clone(row)); },
      };
    }
    db.$queryRaw = async (query: any) => { const sql = query.sql ?? String(query), tableName = /FROM "([^"]+)"/.exec(sql)?.[1] ?? '?'; lockCalls.push(tableName); return [{ id: 'locked' }]; };
    return db;
  }
  const db = database();
  db.$transaction = async (work: any) => {
    const working = Object.fromEntries(written.map(model => [model, clone(tables[model])]));
    const result = await work(database(working));
    for (const model of written) tables[model] = working[model];
    return result;
  };
  return { tables, db, lockCalls, calls, queries, setHook(value: typeof hook) { hook = value; }, revoke(scope: string) { const row = tables.userPermissionOverrides.find(row => row.scope === scope); if (row) row.isActive = false; } };
}
