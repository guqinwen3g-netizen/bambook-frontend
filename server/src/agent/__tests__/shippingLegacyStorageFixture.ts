/** Storage-only fixture, not a test or an eligibility/authorization stub.
 * It reads actual fixture rows, records supported native row-lock requests and
 * rejects unsupported query operators/SQL. No absent row manufactures a fact. */
export function storageWhere(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, expected]: any) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((part: any) => storageWhere(row, part));
    if (key === 'OR') return expected.some((part: any) => storageWhere(row, part));
    if (key === 'NOT') return !storageWhere(row, expected);
    const value = row[key];
    if (expected === null) return value == null;
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, operand]: any) => {
        if (operator === 'in') return operand.includes(value);
        if (operator === 'not') return operand === null ? value != null : value !== operand;
        if (operator === 'equals') return value === operand;
        throw new Error(`Unsupported fixture where operator: ${operator}`);
      });
    }
    return value === expected;
  });
}
export function storageReader(rows: () => any[]) {
  const findMany = async ({ where = {}, select, orderBy, take }: any = {}) => {
    let result = rows().filter(row => storageWhere(row, where));
    if (orderBy) for (const [key, direction] of Object.entries(orderBy).reverse()) {
      result = [...result].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
    }
    if (take !== undefined) result = result.slice(0, take);
    return result.map(row => select ? Object.fromEntries(Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => [key, row[key]])) : { ...row });
  };
  return { findMany, findUnique: async (args: any) => (await findMany(args))[0] ?? null,
    findFirst: async (args: any) => (await findMany(args))[0] ?? null,
    count: async (args: any) => (await findMany(args)).length };
}
export function storageRowLocks(tables: Record<string, () => any[] | Promise<any[]>>, journal: any[]) {
  return async (query: any) => {
    const sql = query?.sql;
    const table = typeof sql === 'string' ? /SELECT "id" FROM "([A-Za-z]+)"/.exec(sql)?.[1] : undefined;
    if (!table || !tables[table] || !/FOR UPDATE/.test(sql)) throw new Error('Unsupported fixture SQL');
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (!/^SELECT "id" FROM "[A-Za-z]+" WHERE "id"\s*=\s*\? FOR UPDATE$/.test(normalized)
      && !/^SELECT "id" FROM "[A-Za-z]+" WHERE "id" IN \(\?(?:,\s*\?)*\) ORDER BY "id" FOR UPDATE$/.test(normalized))
      throw new Error('Unsupported fixture SQL shape');
    const ids = query.values as unknown[];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Unsupported fixture SQL values');
    const rows = (await tables[table]()).filter((row: any) => ids.includes(row.id));
    journal.push({ table, ids: [...ids], rows: rows.map(row => row.id) });
    return rows.map(row => ({ id: row.id }));
  };
}

/** Explicit empty tables for the original legacy shipping stores. Each reader
 * operates on its own persisted-row array. Nothing certifies an approval. */
export function legacySourceStorage() {
  const rows = { releaseScopes: [] as any[], productionBatches: [] as any[], physicalAllocations: [] as any[],
    orderLines: [] as any[], samples: [] as any[], productAssets: [] as any[], fabricProfiles: [] as any[],
    fabricCustomerCodes: [] as any[], locks: [] as any[] };
  const models = {
    releaseScope: storageReader(() => rows.releaseScopes), productionBatch: storageReader(() => rows.productionBatches),
    shipmentProductionAllocation: storageReader(() => rows.physicalAllocations), orderLine: storageReader(() => rows.orderLines),
    sample: storageReader(() => rows.samples), productAsset: storageReader(() => rows.productAssets),
    fabricProfile: storageReader(() => rows.fabricProfiles), fabricCustomerCode: storageReader(() => rows.fabricCustomerCodes),
  };
  return { rows, models };
}
export function wholeFinalInspection(report: any, orderId = 'O1') {
  return report ? { id: `INR__${orderId}`, orderId, inspectionType: 'final', scopeType: 'whole_order',
    scopeKey: 'whole_order', revision: 1, scopeFingerprint: null, ...report } : null;
}

/** Real stored role tree consumed by the actual current-account/grant loader.
 * This is fixture data, never an authorization-helper replacement. */
export function storedShippingOperator(userId = 'agent') {
  const account = { id: userId, displayName: userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin', permissions: [
      { permission: { scope: 'orders:read' } }, { permission: { scope: 'shipments:write' } },
    ] } }] };
  const accounts = [account], overrides: any[] = [];
  return { account, overrides, models: { userAccount: storageReader(() => accounts),
    userPermissionOverrides: storageReader(() => overrides), teamMember: storageReader(() => []) } };
}
