// Stateful storage seam: source resolver is production code. Transaction reads
// use a frozen copy; this proves its use, not PostgreSQL MVCC/locking itself.
export function storage(seed: any = {}) {
  const state = { users: [{id:'u_owner',status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'role-super-admin',permissions:['products:read','sample:room:write'].map(scope=>({permission:{scope}}))}}]}], overrides: [], relations: [], memberships: [], grants: [], departments: [], audits: [], items: [], samples: [], batches: [], cases: [], orders: [], assets: [], loans: [], warehouses: [], ...seed };
  state.items=state.items.map((row:any)=>({sampleId:null,devCaseId:null,orderId:null,batchId:null,productAssetId:null,warehouseId:null,receiptSnapshot:null,unit:'PC',status:'in_stock',createdAt:0,updatedAt:0,...row}));
  const options: any[] = []; let onRead: (() => void) | undefined; let failure: string | undefined;
  const match = (row: any, where: any): boolean => Object.entries(where || {}).every(([key, value]: any) => {
    if (key === 'AND') return value.every((w: any) => match(row, w));
    if (key === 'OR') return value.some((w: any) => match(row, w));
    if (value === null) return row[key] == null;
    if (value && typeof value === 'object') return Object.entries(value).every(([op, v]: any) => {
      const actual = v?.field ? row[v.field] : v;
      if (op === 'in') return v.includes(row[key]);
      if (op === 'not') return row[key] !== v;
      if (op === 'contains') return String(row[key] ?? '').includes(v);
      if (op === 'lt') return row[key] < actual;
      if (op === 'lte') return row[key] <= actual;
      if (op === 'gt') return row[key] > actual;
      return true;
    });
    return row[key] === value;
  });
  const client = (data: any) => {
    const db: any = {};
    for (const [delegate, table] of Object.entries({ userAccount:'users',userPermissionOverrides:'overrides',relation:'relations',teamMember:'memberships',teamDataGrant:'grants',department:'departments',auditLog:'audits',sampleCardItem: 'items', sample: 'samples', sampleBatch: 'batches', developmentCase: 'cases', order: 'orders', productAsset: 'assets', sampleCardLoan: 'loans', warehouse: 'warehouses' })) {
      const rows = async (args: any = {}) => {
        if (failure === delegate) throw Error('source SQL failed');
        let found = data[table].filter((r: any) => match(r, args.where));
        const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
        found = [...found].sort((a, b) => { for (const part of order) { const [key, direction] = Object.entries(part)[0]; if (a[key] === b[key]) continue; return (a[key] > b[key] ? 1 : -1) * (direction === 'desc' ? -1 : 1); } return 0; });
        let start = args.skip || 0;
        if (args.cursor) start += found.findIndex((r: any) => r.id === args.cursor.id);
        const selected = found.slice(start, args.take === undefined ? undefined : start + args.take).map((r: any) => args.select ? Object.fromEntries(Object.keys(args.select).map(k => [k, r[k]])) : { ...r });
        if (delegate === 'sampleCardItem' && onRead) { const effect = onRead; onRead = undefined; effect(); }
        return selected;
      };
      db[delegate] = { fields: { minStock: { field: 'minStock' } }, findMany: rows, findFirst:async(args:any)=>(await rows(args))[0]??null,findUnique:async(args:any)=>(await rows(args))[0]??null, count: async ({ where }: any) => data[table].filter((r: any) => match(r, where)).length };
    }
    return db;
  };
  const db = client(state);
  db.$transaction = async (work: any, opt: any) => { options.push(opt); return work(client(structuredClone(state))); };
  return { db, state, options, afterFirstCardRead: (fn: () => void) => { onRead = fn; }, fail: (table: string) => { failure = table; } };
}
