/** In-memory unit fixture only. It never constructs a Prisma client or opens a database. */
import { Prisma } from '@prisma/client';
type Row = Record<string, any>;
export function supplierContractMemoryFixture() {
  const tables = new Map<string, Map<string, Row>>();
  const names = ['order', 'orderLine', 'purchaseOrder', 'purchaseLine', 'outsourcingOrder', 'outsourcingLine', 'supplierCommitmentRevision',
    'supplierContractCommandReceipt', 'supplierFulfillmentFact', 'approvalRequest', 'teamMember', 'systemConfig', 'systemConfigHistory',
    'relation', 'factoryProfile', 'warehouse', 'auditLog', 'procurementDemand', 'purchaseDemandAllocation', 'inventoryItem', 'stockMovement', 'materialReceipt', 'businessSequence'];
  for (const name of names) tables.set(name, new Map());
  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(clause => matches(row, clause));
      if (key === 'OR') return expected.some((clause: Row) => matches(row, clause));
      if (key === 'actorId_requestKey') return matches(row, expected);
      if (expected === null) return row[key] == null;
      if (typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Prisma.Decimal)) {
        if ('in' in expected) return expected.in.includes(row[key]);
        if ('notIn' in expected) return !expected.notIn.includes(row[key]);
        if ('not' in expected) return row[key] !== expected.not;
      }
      return row[key] === expected;
    });
  }
  const db: Row = { $queryRaw: async () => { db.onLock?.(); return [{ id: 'locked' }]; } };
  function include(name: string, row: Row | null, args: Row) {
    if (!row) return null;
    const copy = { ...row };
    if (args.include?.lines && (name === 'purchaseOrder' || name === 'outsourcingOrder')) copy.lines = [...tables.get(name === 'purchaseOrder' ? 'purchaseLine' : 'outsourcingLine')!.values()].filter(line => line[name === 'purchaseOrder' ? 'purchaseOrderId' : 'outsourcingOrderId'] === row.id);
    return copy;
  }
  for (const name of names) {
    const store = () => tables.get(name)!;
    const find = (args: Row = {}) => {
      const result = [...store().values()].filter(row => matches(row, args.where));
      const orderBy = args.orderBy ? Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy] : [];
      for (const order of [...orderBy].reverse()) {
        const [key, direction] = Object.entries(order)[0];
        result.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
      }
      return result.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
    };
    const apply = (row: Row, data: Row) => {
      for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
        ? row[key] instanceof Prisma.Decimal ? row[key].plus(value.increment) : (row[key] ?? 0) + value.increment : value;
    };
    db[name] = {
      findUnique: async (args: Row) => include(name, find(args)[0] ?? null, args),
      findFirst: async (args: Row) => include(name, find(args)[0] ?? null, args),
      findMany: async (args: Row = {}) => find(args).map(row => include(name, row, args)),
      count: async (args: Row = {}) => find(args).length,
      create: async ({ data }: Row) => {
        if (store().has(data.id)) throw new Error('Duplicate in-memory id');
        const row = name === 'inventoryItem' ? { deletedAt: null, ownership: 'Owned', ownerRelationId: null, ...data,
          quantity: new Prisma.Decimal(data.quantity), lockedQuantity: new Prisma.Decimal(data.lockedQuantity ?? 0) } : { ...data };
        store().set(data.id, row); return { ...row };
      },
      update: async ({ where, data }: Row) => {
        const row = find({ where })[0]; if (!row) throw new Error(`Missing in-memory ${name}`); apply(row, data); return { ...row };
      },
      updateMany: async ({ where, data }: Row) => { const rows = find({ where }); for (const row of rows) apply(row, data); return { count: rows.length }; },
      upsert: async ({ where, create, update }: Row) => {
        const row = find({ where })[0]; if (row) { apply(row, update); return { ...row }; }
        store().set(create.id, { ...create }); return { ...create };
      },
      aggregate: async (args: Row) => ({ _sum: Object.fromEntries(Object.keys(args._sum).map(key => [key, find(args).reduce((sum, row) => sum.plus(row[key] ?? 0), new Prisma.Decimal(0))])) }),
    };
  }
  db.$transaction = async (work: (tx: Row) => unknown) => {
    const clone = (value: any): any => value instanceof Prisma.Decimal ? new Prisma.Decimal(value) : value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) : value;
    const before = new Map([...tables.entries()].map(([name, rows]) => [name, new Map([...rows.entries()].map(([id, row]) => [id, clone(row)]))]));
    try { return await work(db); } catch (error) { tables.clear(); for (const [name, rows] of before) tables.set(name, rows); throw error; }
  };
  const put = (table: string, row: Row) => tables.get(table)!.set(row.id, row);
  put('order', { id: 'order-1', ownerId: 'business', status: 'Confirmed', businessLine: 'fabric', deletedAt: null, orderPurpose: 'external', quantity: new Prisma.Decimal(100), unit: 'M' });
  put('orderLine', { id: 'line-1', orderId: 'order-1', quantity: new Prisma.Decimal(100), unit: 'M', unitPrice: new Prisma.Decimal(10) });
  put('approvalRequest', { id: 'main-approved', actionType: 'order:main_approval', targetType: 'Order', targetId: 'order-1', status: 'approved', payload: { contentFingerprint: 'a'.repeat(64) }, createdAt: new Date() });
  put('relation', { id: 'supplier-1', name: 'Actual raw material supplier', category: 'Supplier', isOrganization: true, deletedAt: null });
  put('relation', { id: 'processor-1', name: 'Actual processing supplier', category: 'Supplier', isOrganization: true, deletedAt: null });
  put('teamMember', { id: 'business-fabric', userId: 'business', leftAt: null, team: { id: 'fabric-team', status: 'active', deletedAt: null, metadata: { businessFamily: 'fabric' } } });
  return { db, tables, put, all: (name: string) => [...tables.get(name)!.values()] };
}
