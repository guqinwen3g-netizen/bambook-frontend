import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { saveShipmentPacking, readShipmentPacking, parsePackingCommand } from '../shipmentPackingCommand';
import { replaceShipmentLines, replaceShipmentCartons } from '../shipmentPackingService';
import { storageReader, storageWhere } from './shippingSourceStorageFixture';
import { physicalShipmentAllocationFingerprint } from '../shipmentPhysicalConsumerService';
import { qcReportSourceFingerprint as hash } from '../../qc/qcReportAuthority';

// Actual authority, source-lock, packing producers and audit helpers execute.
// This storage substitute serializes transactions and restores business tables
// on throw. It proves composition, not native PG locks/SQL/FK or rendered UX.
function clone(v: any): any {
  if (Prisma.Decimal.isDecimal(v)) return new Prisma.Decimal(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}
const scopes = ['orders:read', 'shipments:read', 'shipments:write'];
const actor: any = { userId: 'U1', roles: ['owner'], permissions: scopes, permissionCeiling: scopes };
function storedAuditWhere(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, expected]: any) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(part => storedAuditWhere(row, part));
    if (key === 'OR') return expected.some((part: any) => storedAuditWhere(row, part));
    if (key === 'detail' && Array.isArray(expected?.path)) {
      if (Object.keys(expected).some(key => !['path', 'equals'].includes(key))) throw Error('unsupported audit JSON storage query');
      return expected.path.reduce((value: any, part: string) => value?.[part], row.detail) === expected.equals;
    }
    return storageWhere(row, { [key]: expected });
  });
}
function nativeDecimalColumns(table: string, data: any) {
  const schema: Record<string, Record<string, [number, number]>> = {
    ShipmentLine: { quantity: [18, 4], grossWeight: [12, 3], netWeight: [12, 3], volume: [12, 3] },
    ShipmentCarton: { length: [10, 2], width: [10, 2], height: [10, 2], grossWeight: [12, 3], netWeight: [12, 3], volume: [12, 4] },
    ShipmentCartonItem: { quantity: [18, 4] }, Shipment: { grossWeight: [12, 3], netWeight: [12, 3], volume: [12, 3] },
  };
  const stored = { ...data };
  for (const [field, [precision, scale]] of Object.entries(schema[table] ?? {})) if (stored[field] != null) {
    stored[field] = new Prisma.Decimal(stored[field]).toDecimalPlaces(scale);
    if (stored[field].abs().gte(new Prisma.Decimal(10).pow(precision - scale))) throw Error('native decimal column precision overflow');
  }
  return stored;
}
function fixture() {
  const state: any = { Shipment: [{ id: 'SH1', orderId: 'O1', status: 'Booked', deletedAt: null, updatedAt: 10n, customerRelationId: null, customerName: 'Synthetic' }],
    Order: [{ id: 'O1', deletedAt: null }], OrderLine: [], ShipmentHandoff: [], ShipmentOrderAllocation: [], ShipmentProductionAllocation: [], ProductionBatch: [], ReleaseScope: [], Sample: [],
    ShipmentLine: [{ id: 'OLD_LINE', shipmentId: 'SH1', lineNumber: 1, productName: 'old', quantity: new Prisma.Decimal('4.0001') }],
    ShipmentCarton: [{ id: 'OLD_BOX', shipmentId: 'SH1', cartonNo: 'old' }], ShipmentCartonItem: [{ id: 'OLD_ITEM', cartonId: 'OLD_BOX', shipmentLineId: 'OLD_LINE', quantity: new Prisma.Decimal('4.0001') }], AuditLog: [] };
  const user: any = { id: 'U1', status: 'active', deletedAt: null, primaryDeptId: null, roles: [{ roleId: 'role-super-admin', departmentId: null, role: { id: 'role-super-admin', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const fault = { audit: '', carton: false, unavailable: false, afterAudit: undefined as undefined | (() => void) };
  const locks: any[] = [];
  const currentIdentitySelect = { id: true, primaryDeptId: true, primaryDepartment: true, status: true, roles: { select: { departmentId: true, role: { select: { id: true, permissions: { select: { permission: { select: { scope: true } } } } } } } } };
  const sameSelection = (received: any, expected: any): boolean => expected === true ? received === true
    : !!received && typeof received === 'object' && !Array.isArray(received)
      && Object.keys(received).length === Object.keys(expected).length
      && Object.entries(expected).every(([field, selected]) => Object.prototype.hasOwnProperty.call(received, field) && sameSelection(received[field], selected));
  const findCurrentIdentity = async (args: any) => {
    if (fault.unavailable) throw Error('stored identity unavailable');
    if (!args || Object.keys(args).length !== 2 || !Object.prototype.hasOwnProperty.call(args, 'where') || !Object.prototype.hasOwnProperty.call(args, 'select')
      || !args.where || Object.keys(args.where).length !== 2 || typeof args.where.id !== 'string' || args.where.deletedAt !== null
      || !Object.prototype.hasOwnProperty.call(args.where, 'id') || !Object.prototype.hasOwnProperty.call(args.where, 'deletedAt')
      || !sameSelection(args.select, currentIdentitySelect)) throw Error('unsupported current identity storage query');
    if (args.where.id !== user.id || user.deletedAt != null) return null;
    const row = clone(user);
    return { id: row.id, primaryDeptId: row.primaryDeptId, primaryDepartment: row.primaryDepartment ?? null, status: row.status, roles: row.roles.map((ur: any) => ({ departmentId: ur.departmentId,
      role: { id: ur.role.id, permissions: ur.role.permissions.map((rp: any) => ({ permission: { scope: rp.permission.scope } })) } })) };
  };
  const tx: any = { userAccount: { findFirst: async ({ where }: any) => { if (fault.unavailable) throw Error('stored identity unavailable'); return where.id === user.id && user.deletedAt == null ? clone(user) : null; }, findUnique: findCurrentIdentity },
    userPermissionOverride: storageReader(() => []), userPermissionOverrides: storageReader(() => []), teamMember: storageReader(() => []) };
  const delegates: Record<string, string> = { shipment: 'Shipment', shipmentHandoff: 'ShipmentHandoff', order: 'Order', orderLine: 'OrderLine', shipmentOrderAllocation: 'ShipmentOrderAllocation', shipmentProductionAllocation: 'ShipmentProductionAllocation', productionBatch: 'ProductionBatch', releaseScope: 'ReleaseScope', sample: 'Sample', shipmentLine: 'ShipmentLine', shipmentCarton: 'ShipmentCarton', shipmentCartonItem: 'ShipmentCartonItem', auditLog: 'AuditLog' };
  for (const [delegate, table] of Object.entries(delegates)) {
    const reader = storageReader(() => state[table]);
    tx[delegate] = { ...reader,
      findMany: async (args: any = {}) => { const rows = table === 'AuditLog' ? await storageReader(() => state[table].filter((row: any) => storedAuditWhere(row, args.where))).findMany({ ...args, where: {} }) : await reader.findMany(args); return args.include?.items ? rows.map(row => ({ ...row, items: state.ShipmentCartonItem.filter((item: any) => item.cartonId === row.id).map(clone) })) : rows; },
      create: async ({ data }: any) => { if (table === 'ShipmentCarton' && fault.carton || table === 'AuditLog' && data.action === fault.audit) throw Error('mandatory storage fault'); data = nativeDecimalColumns(table, data); state[table].push(clone(data)); if (table === 'AuditLog') fault.afterAudit?.(); return clone(data); },
      update: async ({ where, data }: any) => { const row = state[table].find((r: any) => r.id === where.id); if (!row) throw Error('missing native row'); Object.assign(row, clone(nativeDecimalColumns(table, data))); return clone(row); },
      deleteMany: async ({ where }: any) => { const removed = (await reader.findMany({ where })).map(row => row.id); state[table] = state[table].filter((row: any) => !removed.includes(row.id)); if (table === 'ShipmentCarton') state.ShipmentCartonItem = state.ShipmentCartonItem.filter((row: any) => !removed.includes(row.cartonId)); return { count: removed.length }; },
    };
  }
  for (const delegate of ['claimDisposition', 'repairWorkOrder', 'ppSampleRelease', 'fabricCustomerCode', 'fabricProfile', 'productAsset']) tx[delegate] = storageReader(() => []);
  tx.$queryRaw = async (query: any) => {
    const table = /SELECT "id" FROM "([A-Za-z]+)"/.exec(query.sql)?.[1];
    if (!table || !state[table] || !/FOR UPDATE/.test(query.sql)) throw Error('unsupported fixture SQL');
    const field = /WHERE "shipmentId"/.test(query.sql) ? 'shipmentId' : 'id';
    const result = state[table].filter((row: any) => query.values.includes(row[field])).map((row: any) => ({ id: row.id }));
    locks.push({ table, field, values: [...query.values], result }); return result;
  };
  let queue: Promise<any> = Promise.resolve();
  const prisma: any = { ...tx, $transaction: (work: any) => {
    const result = queue.then(async () => { const before = clone(state); try { return await work(tx); } catch (error) { Object.keys(state).forEach(key => { state[key] = before[key]; }); throw error; } });
    queue = result.catch(() => undefined); return result;
  } };
  const fingerprint = () => physicalShipmentAllocationFingerprint({ shipment: state.Shipment[0], orderIds: ['O1'], allocations: state.ShipmentOrderAllocation, physical: state.ShipmentProductionAllocation });
  const input = (key = 'K1'): any => ({ requestKey: key, expectedShipmentUpdatedAt: String(state.Shipment[0].updatedAt), expectedPhysicalAllocationFingerprint: fingerprint(),
    lines: [{ clientLineKey: 'original-line', orderLineId: null, productCode: null, productName: 'cloth', colorCode: 'RED', quantity: '90071992547409.1234', unit: 'M', cartons: 1, grossWeight: null, netWeight: null, volume: null, hsCode: 'HS', countryOfOrigin: 'CN' }],
    cartons: [{ cartonNo: 'C1', description: 'original box', length: '10.01', width: '20', height: '30', grossWeight: '2.123', netWeight: null, volume: null, items: [{ lineKey: 'original-line', quantity: '90071992547409.1234' }] }] });
  const save = (command = input(), prior = actor) => saveShipmentPacking({ prisma, shipmentId: 'SH1', actor: prior, input: command });
  const facts = () => clone(Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'AuditLog')));
  return { state, user, fault, prisma, locks, input, save, facts };
}
describe('atomic packing command over actual storage contracts', () => {
  it.each(['PendingLogistics', 'NeedsBusinessDecision', 'ReturnedToBusiness'])('refuses new packing in handoff stage %s without changing packing facts', async status => {
    const f = fixture(); f.state.ShipmentHandoff.push({ id: 'H1', shipmentId: 'SH1', status });
    const before = f.facts(), saved = await f.save();
    expect(saved.rejection).toMatchObject({ outcome: 'not_committed', code: 'INVALID_STATE' });
    expect(f.facts()).toEqual(before);
  });
  it('allows logistics Processing packing but replays its original receipt after return to business', async () => {
    const f = fixture(); f.state.ShipmentHandoff.push({ id: 'H1', shipmentId: 'SH1', status: 'Processing' });
    const command = f.input(), first = await f.save(command);
    f.state.ShipmentHandoff[0].status = 'ReturnedToBusiness';
    const replay = await f.save(command);
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect(f.state.AuditLog).toHaveLength(3);
  });
  it('saves both collections, exact quantities, original source fields and two mandatory audits in one transaction', async () => {
    const f = fixture(), saved = await f.save();
    expect(saved.lines[0]).toMatchObject({ quantity: '90071992547409.1234', colorCode: 'RED', countryOfOrigin: 'CN' });
    expect(saved.cartons[0].items[0]).toMatchObject({ shipmentLineId: saved.lines[0].id, quantity: '90071992547409.1234' });
    expect(saved.cartons[0].volume).toBe('0.006');
    expect(f.state.ShipmentLine).toHaveLength(1); expect(f.state.ShipmentCarton).toHaveLength(1); expect(f.state.ShipmentCartonItem).toHaveLength(1);
    expect(f.state.AuditLog.map((row: any) => row.action)).toEqual(['PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE', 'replace_shipment_packing']);
    expect(f.locks.map(row => row.table)).toContain('Order'); expect(f.locks.map(row => row.table)).toContain('Shipment');
    expect(saved.acknowledgement.commandHash).toBe(hash({ schemaVersion: 1, command: saved.acknowledgement.command }));
  });
  it.each(['PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE', 'replace_shipment_packing'])('mandatory %s failure restores every original line/box/item/header and leaves no ACK', async audit => {
    const f = fixture(), original = f.facts(); f.fault.audit = audit;
    await expect(f.save()).rejects.toThrow('mandatory storage fault'); expect(f.facts()).toEqual(original); expect(f.state.AuditLog).toEqual([]);
  });
  it('a carton write failure rolls back the already replaced lines and their original audit', async () => {
    const f = fixture(), original = f.facts(); f.fault.carton = true;
    await expect(f.save()).rejects.toThrow('mandatory storage fault'); expect(f.facts()).toEqual(original); expect(f.state.AuditLog).toEqual([]);
  });
  it('same-key concurrent calls yield one producer fact/ACK and a validated original replay', async () => {
    const f = fixture(), input = f.input(), results = await Promise.all([f.save(input), f.save(input)]);
    expect(results.map(row => row.replayed)).toEqual([false, true]); expect(results[0].lines).toEqual(results[1].lines);
    expect(f.state.AuditLog).toHaveLength(3); expect(f.state.ShipmentLine).toHaveLength(1); expect(f.state.ShipmentCartonItem).toHaveLength(1);
  });
  it('different-key stale concurrent call is durably not_committed only after rollback and locked absence of any original ACK', async () => {
    const f = fixture(), a = f.input('A'), b = f.input('B'), [saved, refused] = await Promise.all([f.save(a), f.save(b)]);
    expect(saved.replayed).toBe(false); expect(refused.rejection).toMatchObject({ outcome: 'not_committed', code: 'CONFLICT', command: { requestKey: 'B', actorId: 'U1', shipmentId: 'SH1' } });
    expect(f.state.ShipmentLine).toHaveLength(1); expect(f.state.AuditLog.filter((row: any) => row.action === 'replace_shipment_packing')).toHaveLength(1);
    expect(await f.save(b)).toEqual(refused); expect(f.state.AuditLog).toHaveLength(4);
  });
  it('changed parameters on a committed key fail without a false not_committed certificate or new facts', async () => {
    const f = fixture(), input = f.input(); await f.save(input); const before = clone(f.state);
    await expect(f.save({ ...input, lines: [{ ...input.lines[0], quantity: '90071992547409.1235' }] })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.state).toEqual(before);
  });
  it.each(['PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE'])('missing %s original audit refuses replay rather than inventing a receipt', async action => {
    const f = fixture(), input = f.input(); await f.save(input); f.state.AuditLog = f.state.AuditLog.filter((row: any) => row.action !== action);
    const before = clone(f.state); await expect(f.save(input)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.state).toEqual(before);
  });
  it('changed saved quantity with recomputed public hashes still cannot match the original command', async () => {
    const f = fixture(), input = f.input(); await f.save(input); const proof = f.state.AuditLog[2].detail.after;
    proof.result.lines[0].quantity = '90071992547409.1235'; proof.acknowledgement.resultHash = hash(proof.result);
    await expect(f.save(input)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.state.AuditLog).toHaveLength(3);
  });
  it('current fact damage at the ACK version blocks replay with no attempted repair', async () => {
    const f = fixture(), input = f.input(); await f.save(input); f.state.ShipmentCartonItem[0].shipmentLineId = 'UNKNOWN';
    const before = clone(f.state); await expect(f.save(input)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.state).toEqual(before);
  });
  it.each(['revoked', 'disabled', 'signed-empty', 'unavailable'])('actual %s current authority refuses original write/replay without certified absence', async mode => {
    const f = fixture(), input = f.input(); await f.save(input); const before = clone(f.state);
    if (mode === 'revoked') f.user.roles[0].role.permissions = [];
    if (mode === 'disabled') f.user.status = 'disabled';
    if (mode === 'unavailable') f.fault.unavailable = true;
    await expect(f.save(input, mode === 'signed-empty' ? { ...actor, permissionCeiling: [] } : actor)).rejects.toMatchObject({ code: mode === 'disabled' ? 'ACCOUNT_DISABLED' : mode === 'unavailable' ? 'AUTHORIZATION_UNAVAILABLE' : 'FORBIDDEN' });
    expect(f.state).toEqual(before);
  });
  it('a current grant revoked during the aggregate mandatory audit aborts all writes', async () => {
    const f = fixture(), original = f.facts(); f.fault.afterAudit = () => { if (f.state.AuditLog.some((row: any) => row.action === 'replace_shipment_packing')) f.user.roles[0].role.permissions = []; };
    await expect(f.save()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.facts()).toEqual(original); expect(f.state.AuditLog).toEqual([]);
  });
  it('modern source detection cannot fall back to legacy packing when real PB lacks native allocation facts', async () => {
    const f = fixture(); f.state.ProductionBatch.push({ id: 'PB1', orderId: 'O1', orderLineId: 'L1' }); const original = f.facts();
    expect((await f.save()).rejection).toMatchObject({ code: 'CONFLICT', outcome: 'not_committed' }); expect(f.facts()).toEqual(original); expect(f.state.AuditLog.filter((row: any) => row.action === 'replace_shipment_packing')).toEqual([]);
  });
  it('one repeatable-read snapshot retains exact stored fields and derives explicit modern sources only from positive actual SOA', async () => {
    const f = fixture(); f.state.OrderLine.push({ id: 'L1', orderId: 'O1', itemNo: 'SKU' }); f.state.ProductionBatch.push({ id: 'PB1', orderId: 'O1' });
    f.state.ShipmentOrderAllocation.push({ id: 'SOA1', shipmentId: 'SH1', orderId: 'O1', orderLineId: 'L1', status: 'Planned', actualQty: new Prisma.Decimal('1.2345'), unit: 'M' });
    const read = await readShipmentPacking(f.prisma, 'SH1', actor);
    expect(read.context.kind).toBe('physical'); expect(read.lines[0].quantity).toBe('4.0001'); expect(read.cartons[0].items[0].shipmentLineId).toBe('OLD_LINE');
    expect(read.sources).toEqual([{ orderLineId: 'L1', orderId: 'O1', productCode: 'SKU', productName: null, unit: 'M', actualQty: '1.2345' }]);
    f.state.ShipmentOrderAllocation[0].actualQty = null; expect((await readShipmentPacking(f.prisma, 'SH1', actor)).sources).toEqual([]);
  });
  it('standalone no-order packing needs current shipment grants without inventing orders:read or an order source', async () => {
    const f = fixture(); f.state.Shipment[0].orderId = null;
    f.user.roles[0].role.permissions = ['shipments:read', 'shipments:write'].map(scope => ({ permission: { scope } }));
    const original = f.input(); original.expectedPhysicalAllocationFingerprint = physicalShipmentAllocationFingerprint({ shipment: f.state.Shipment[0], orderIds: [], allocations: [], physical: [] });
    expect((await f.save(original)).lines[0].quantity).toBe('90071992547409.1234');
    expect((await readShipmentPacking(f.prisma, 'SH1', actor)).context.kind).toBe('legacy');
    expect(f.locks.filter(row => row.table === 'Order')).toEqual([]);
  });
  it('a linked order still requires actual current orders:read and cannot borrow the standalone exception', async () => {
    const f = fixture(), before = f.facts(); f.user.roles[0].role.permissions = ['shipments:read', 'shipments:write'].map(scope => ({ permission: { scope } }));
    await expect(f.save()).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(readShipmentPacking(f.prisma, 'SH1', actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.facts()).toEqual(before); expect(f.state.AuditLog).toEqual([]);
  });
  it('unknown legacy body orderLineId cannot establish a source relation or save partial packing', async () => {
    const f = fixture(), input = f.input(), before = f.facts(); input.lines[0].orderLineId = 'FOREIGN_LINE';
    expect((await f.save(input)).rejection).toMatchObject({ outcome: 'not_committed', code: 'CONFLICT' }); expect(f.facts()).toEqual(before);
  });
  it('command parser rejects rounded numeric quantity, hidden fields and duplicate/foreign line keys', () => {
    const f = fixture(), input = f.input();
    expect(() => parsePackingCommand({ ...input, lines: [{ ...input.lines[0], quantity: Number(input.lines[0].quantity) }] })).toThrow();
    expect(() => parsePackingCommand({ ...input, actorId: 'U2' })).toThrow();
    expect(() => parsePackingCommand({ ...input, lines: [...input.lines, input.lines[0]] })).toThrow();
    expect(() => parsePackingCommand({ ...input, cartons: [{ ...input.cartons[0], items: [{ lineKey: 'UNKNOWN', quantity: '1' }] }] })).toThrow();
  });
  it('same-millisecond consecutive actual primitive writes advance the stored shipment version', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10);
    try {
      const f = fixture(), line = f.input().lines[0], { clientLineKey, ...input } = line;
      const first = await replaceShipmentLines(f.prisma, 'SH1', [input], actor.userId, null, { actor });
      expect(first.ok).toBe(true); expect(f.state.Shipment[0].updatedAt).toBe(11n);
      const second = await replaceShipmentCartons(f.prisma, 'SH1', [{ cartonNo: 'C1', items: [{ shipmentLineId: first.data!.lines[0].id, quantity: '1.0001' }] }], actor.userId, null, { actor });
      expect(second.ok).toBe(true); expect(f.state.Shipment[0].updatedAt).toBe(12n);
      const third = await replaceShipmentLines(f.prisma, 'SH1', [{ ...input, productName: 'changed' }], actor.userId, null, { actor });
      expect(third.ok).toBe(true); expect(f.state.Shipment[0].updatedAt).toBe(13n);
      expect((await replaceShipmentLines(f.prisma, 'SH1', [], actor.userId, null, { actor })).ok).toBe(true);
      expect(f.state.Shipment[0].updatedAt).toBe(14n);
      const manualTotals = { totalPackages: f.state.Shipment[0].totalPackages, grossWeight: f.state.Shipment[0].grossWeight, netWeight: f.state.Shipment[0].netWeight, volume: f.state.Shipment[0].volume };
      expect((await replaceShipmentCartons(f.prisma, 'SH1', [], actor.userId, null, { actor })).ok).toBe(true);
      expect(f.state.Shipment[0].updatedAt).toBe(15n); expect(f.state.Shipment[0]).toMatchObject(manualTotals);
      expect(f.state.AuditLog.map((row: any) => row.action)).toEqual(['PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE', 'PACKING_LINES_REPLACE', 'PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE']);
    } finally { clock.mockRestore(); }
  });
  it('aggregate final write never lowers versions advanced by its two actual primitives', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10);
    try {
      const f = fixture(), versions: bigint[] = [], update = f.prisma.shipment.update;
      f.prisma.shipment.update = async (args: any) => { const result = await update(args); versions.push(result.updatedAt); return result; };
      const original = f.input(), saved = await f.save(original);
      expect(versions).toEqual([11n, 12n, 13n]); expect(saved.shipment.updatedAt).toBe('13');
      expect(f.state.Shipment[0].updatedAt).toBe(13n); expect(f.state.AuditLog).toHaveLength(3);
      expect((await f.save(original)).replayed).toBe(true);
      expect(versions).toEqual([11n, 12n, 13n]);
    } finally { clock.mockRestore(); }
  });
  it('line volume follows exact Decimal12,3 while carton volume independently preserves four places', async () => {
    const f = fixture(), input = f.input();
    for (const invalid of ['0.0001', '0.0010']) expect(() => parsePackingCommand({ ...input, lines: [{ ...input.lines[0], volume: invalid }] })).toThrow();
    input.lines[0].volume = '999999999.999'; input.cartons[0].volume = '0.0001';
    const saved = await f.save(input);
    expect(saved.lines[0].volume).toBe('999999999.999'); expect(saved.cartons[0].volume).toBe('0.0001');
    expect((await f.save(input)).replayed).toBe(true); expect(f.state.AuditLog).toHaveLength(3);
  });
  it.each(['lines', 'cartons', 'both', 'moved-main', 'moved-main-only', 'changed-parameters', 'damaged-ownership'])('orphan %s original audit evidence keeps the request unknown with no new fact or refusal', async mode => {
    const f = fixture(), input = f.input(); await f.save(input);
    const main = f.state.AuditLog.find((row: any) => row.action === 'replace_shipment_packing');
    if (mode === 'moved-main' || mode === 'moved-main-only') main.transactionId = 'damaged-main-storage-key';
    else f.state.AuditLog = f.state.AuditLog.filter((row: any) => row !== main);
    if (mode === 'moved-main-only') { f.state.AuditLog = [main]; main.actorId = 'WRONG'; main.targetId = 'OTHER'; }
    if (mode === 'lines') f.state.AuditLog = f.state.AuditLog.filter((row: any) => row.action === 'PACKING_LINES_REPLACE');
    if (mode === 'cartons') f.state.AuditLog = f.state.AuditLog.filter((row: any) => row.action === 'PACKING_CARTONS_REPLACE');
    if (mode === 'changed-parameters') input.lines[0].productName = 'changed original command';
    if (mode === 'damaged-ownership') { f.state.AuditLog[0].actorId = 'WRONG'; f.state.AuditLog[0].targetId = 'OTHER'; }
    const before = clone(f.state);
    await expect(f.save(input)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.state).toEqual(before);
    expect(f.state.AuditLog.some((row: any) => row.action === 'reject_shipment_packing')).toBe(false);
  });
});
