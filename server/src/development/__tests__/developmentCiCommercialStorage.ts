import { Prisma } from '@prisma/client';
import { vi } from 'vitest';

/** Explicit storage/rollback seam. It exercises production services, not PostgreSQL isolation. */
function clone(value: any): any {
  if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}
export function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object') {
      if (value.path) return value.path.reduce((target: any, part: string) => target?.[part], row[key]) === value.equals;
      if ('in' in value) return value.in.includes(row[key]);
      if ('notIn' in value) return !value.notIn.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('startsWith' in value) return row[key]?.startsWith(value.startsWith);
      if ('equals' in value) return row[key] === value.equals;
      return matches(row[key] ?? {}, value);
    }
    return value == null ? row[key] == null : row[key] === value;
  });
}
export function developmentCiCommercialStorage() {
  const state: Record<string, any[]> = {
    developmentCase: [{ id: 'case', code: 'DEV-COMMERCIAL', customerRelationId: 'customer', stage: 'Completed', updatedAt: 1n, deletedAt: null }],
    relation: [{ id: 'customer', name: 'Customer', englishName: 'Buyer Ltd', ownerId: 'sales', deletedAt: null }],
    userAccount: [{ id: 'sales', displayName: 'Sales', status: 'active', deletedAt: null }, { id: 'finance', displayName: 'Finance', status: 'active', deletedAt: null }],
    developmentSampleRound: [{ id: 'round-1', developmentCaseId: 'case', round: 1, deletedAt: null }, { id: 'round-2', developmentCaseId: 'case', round: 2, deletedAt: null }],
    developmentSampleVersion: [], sampleBatch: [], sample: [], sealSample: [], billingItem: [], developmentBillingChargeLine: [],
    developmentCiBillingClaim: [], tradeDocument: [], documentVersion: [], costRecord: [], billingItemCostCoverage: [], auditLog: [],
    invoice: [], invoiceLine: [], invoiceOrderAllocation: [], workAssignment: [], approvalRequest: [], invoiceAllocation: [], creditNoteAllocation: [], paymentVoucher: [],
    developmentLifecycleEvent: [], developmentPendingExpense: [], developmentExpenseReview: [],
  };
  const locks: string[] = [];
  const tx: any = { state, locks, auth: { active: true, scopes: ['products:read', 'products:write', 'invoices:read', 'invoices:write'] } };
  for (const table of Object.keys(state)) {
    const selected = (where: any) => state[table].filter(row => matches(row, where));
    tx[table] = {
      findFirst: vi.fn(async ({ where, orderBy }: any = {}) => (await tx[table].findMany({ where, orderBy }))[0] ?? null),
      findUnique: vi.fn(async ({ where }: any) => selected(where)[0] ?? null),
      findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
        const rows = [...selected(where)];
        const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        rows.sort((a, b) => {
          for (const order of orders) for (const [key, direction] of Object.entries(order)) {
            if (a[key] === b[key]) continue;
            return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        return take == null ? rows : rows.slice(0, take);
      }),
      create: vi.fn(async ({ data }: any) => {
        if (table === 'developmentCiBillingClaim' && data.releasedAt == null && state[table].some(row => row.billingItemId === data.billingItemId && row.releasedAt == null))
          throw Object.assign(Error('active claim unique seam'), { code: 'P2002' });
        if (table === 'invoice' && state[table].some(row => row.invoiceNumber === data.invoiceNumber || row.sourceType === data.sourceType && row.sourceId === data.sourceId))
          throw Object.assign(Error('invoice unique seam'), { code: 'P2002' });
        const row = { deletedAt: null, ...(table === 'billingItem' ? { developmentWorkflowVersion: 0 } : {}),
          ...(table === 'developmentCiBillingClaim' || table === 'billingItemCostCoverage' ? { releasedAt: null } : {}), ...data };
        state[table].push(row); return row;
      }),
      createMany: vi.fn(async ({ data }: any) => {
        if (table === 'invoiceLine' && data.some((line: any) => state[table].some(row => row.sourceType === line.sourceType && row.sourceId === line.sourceId)))
          throw Object.assign(Error('invoice line unique seam'), { code: 'P2002' });
        for (const row of data) state[table].push(row);
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: any) => { const row = selected(where)[0]; if (!row) throw Error(`Missing ${table} update target`); Object.assign(row, data); return row; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const rows = selected(where); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; }),
      deleteMany: vi.fn(async ({ where }: any) => { const rows = selected(where); state[table] = state[table].filter(row => !rows.includes(row)); return { count: rows.length }; }),
      count: vi.fn(async ({ where }: any) => selected(where).length),
    };
  }
  tx.$queryRaw = vi.fn(async (query: any) => { locks.push(`${query.strings.join('?')} :: ${query.values.join(',')}`); return [{ id: 'locked' }]; });
  tx.$queryRawUnsafe = vi.fn(async (sql: string, id: string) => {
    if (sql.startsWith('SELECT * FROM "MaterialReturn"')) return [];
    if (sql === 'SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE') return state.invoice.some(row => row.id === id) ? [{ id }] : [];
    throw Error(`Unexpected raw query ${sql}`);
  });
  tx.$transaction = vi.fn(async (work: any) => {
    const before = clone(state);
    try { return await work(tx); } catch (error) { Object.assign(state, before); throw error; }
  });
  return { tx, prisma: tx, state, locks };
}
