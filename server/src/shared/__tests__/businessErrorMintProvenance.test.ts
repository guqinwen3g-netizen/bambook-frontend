import { describe, expect, it } from 'vitest';
import * as errors from '../errorCodes';
import { safeRouteError } from '../routeError';
import * as line from '../../orders/orderLineWriteAccess';
import * as development from '../../development/developmentOperationalGuard';
import { saveShipmentCartonMetadata, shipmentCartonMetadataError } from '../../shipping/shipmentCartonMetadataCommand';

const readers = () => [errors.readBusinessErrorMint, line.readOrderLineWriteErrorMint, development.readDevelopmentDomainErrorMint];
const sql = 'PRIVATE_MINT_NEGATIVE SELECT password FROM UserAccount';
describe('private error mint identity; no public shape or object registration authority', () => {
  it('MINT01 real factory tuple remains immutable after public mutation, deletion and throwing getters', () => {
    const error = errors.businessError('FORBIDDEN', '实际原始细粒度拒绝。');
    expect(error).toBeInstanceOf(Error); expect(error.code).toBe('FORBIDDEN'); expect(error.statusCode).toBe(403);
    const snapshot = errors.readBusinessErrorMint(error);
    expect(snapshot).toEqual({ code: 'FORBIDDEN', statusCode: 403, message: '实际原始细粒度拒绝。' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    Object.assign(error, { code: 'CONFLICT', statusCode: 409, message: sql, details: { sql } });
    delete (error as any).code; let reads = 0;
    for (const key of ['code', 'statusCode', 'message', 'details', 'name']) Object.defineProperty(error, key, { configurable: true, get() { reads++; throw Error(sql); } });
    expect(errors.readBusinessErrorMint(error)).toBe(snapshot); expect(reads).toBe(0);
    expect(() => { (snapshot as any).message = sql; }).toThrow();
    expect(() => errors.businessError('UNREGISTERED_PRIVATE_MINT_NEGATIVE', 'unregistered')).toThrow();
  });
  it('MINT02 cloned shape, borrowed prototypes and Proxy of a minted object cannot obtain a private mint', () => {
    const actual = errors.businessError('CONFLICT', '实际原始冲突。');
    const impostors = [null, undefined, 7, 'CONFLICT', { code: 'CONFLICT', statusCode: 409, message: sql },
      Object.assign(new Error(sql), { code: 'CONFLICT', statusCode: 409 }), Object.create(Object.getPrototypeOf(actual)),
      Object.assign(Object.create(line.OrderLineWriteError.prototype), { code: 'FORBIDDEN', statusCode: 403, message: sql }),
      Object.assign(Object.create(development.DevelopmentDomainError.prototype), { code: 'CONFLICT', statusCode: 409, message: sql }),
      new Proxy(actual, { get() { throw Error(sql); } })];
    for (const read of readers()) for (const error of impostors) expect(read(error)).toBeNull();
  });
  it('MINT03 actual OrderLineWriteError constructor binds its distinct this and retains the actual source tuple', () => {
    const error = new line.OrderLineWriteError('AUTHORIZATION_UNAVAILABLE', '实际当前范围无法核验。');
    expect(error.name).toBe('OrderLineWriteError'); expect(error.statusCode).toBe(503);
    const snapshot = line.readOrderLineWriteErrorMint(error);
    expect(snapshot).toEqual({ code: 'AUTHORIZATION_UNAVAILABLE', statusCode: 503, message: '实际当前范围无法核验。' });
    expect(errors.readBusinessErrorMint(error)).toBeNull(); expect(development.readDevelopmentDomainErrorMint(error)).toBeNull();
    Object.assign(error, { code: 'CONFLICT', statusCode: 409, message: sql });
    expect(line.readOrderLineWriteErrorMint(error)).toBe(snapshot); expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('MINT04 actual DevelopmentDomainError constructor binds its distinct this without classname or prototype approval', () => {
    const error = new development.DevelopmentDomainError('CONFLICT', '真实确认来源锁定变化。');
    expect(error.statusCode).toBe(409); expect(error.status).toBe(409); expect(error.httpStatus).toBe(409);
    const snapshot = development.readDevelopmentDomainErrorMint(error);
    expect(snapshot).toEqual({ code: 'CONFLICT', statusCode: 409, message: '真实确认来源锁定变化。' });
    expect(errors.readBusinessErrorMint(error)).toBeNull(); expect(line.readOrderLineWriteErrorMint(error)).toBeNull();
    Object.assign(error, { code: 'FORBIDDEN', statusCode: 403, status: 403, httpStatus: 403, message: sql });
    expect(development.readDevelopmentDomainErrorMint(error)).toBe(snapshot); expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('MINT05 existing broad classifier, resolver and safeRouteError retain all old public shape behavior', () => {
    const shaped = { code: 'CONFLICT', statusCode: 418, message: sql, details: { sql } };
    expect(errors.isBusinessError(shaped)).toBe(true);
    expect(errors.resolveError(shaped, 'SAVE_FAILED')).toEqual({ status: 418, code: 'CONFLICT', message: sql, details: { sql } });
    expect(safeRouteError(shaped, { fallbackCode: 'SAVE_FAILED' })).toEqual({ status: 418, code: 'CONFLICT', message: sql, details: { sql }, passthrough: true });
    const actual = errors.businessError('FORBIDDEN', 'original'); Object.assign(actual, shaped);
    expect(errors.resolveError(actual, 'SAVE_FAILED')).toEqual({ status: 418, code: 'CONFLICT', message: sql, details: { sql } });
    expect(errors.readBusinessErrorMint(actual)).toEqual({ code: 'FORBIDDEN', statusCode: 403, message: 'original' });
  });
  const validInput = () => ({ requestKey: 'private-unit-key', expectedShipmentUpdatedAt: '1', expectedPhysicalAllocationFingerprint: 'a'.repeat(64),
    expectedSourceFingerprint: 'b'.repeat(64), expectedDispatchHash: 'c'.repeat(64), reason: 'Private callback outcome control', cartons: [{ cartonNo: 'ONE',
      length: null, width: null, height: null, grossWeight: null, netWeight: null, volume: null, items: [{ shipmentLineId: 'private-line', quantity: '1' }] }] });
  const safeUnknown = { status: 500, code: 'SAVE_FAILED', message: '包装资料结果暂时无法确认，请保留原请求重试。', passthrough: false };
  it('MINT06 a transaction driver refusal before actual main callback entry remains unknown even with a genuine mint', async () => {
    let attempts = 0;
    const prisma = { $transaction: async () => { attempts++; throw errors.businessError('CONFLICT', sql); } };
    let caught: unknown;
    try { await saveShipmentCartonMetadata({ prisma: prisma as any, shipmentId: 'private-target', actor: null, input: validInput() }); } catch (error) { caught = error; }
    expect(shipmentCartonMetadataError(caught)).toEqual(safeUnknown); expect(attempts).toBe(1);
  });
  it('MINT07 an outer replacement error cannot reuse the actual main callbacks different rejected error identity', async () => {
    const original = errors.businessError('FORBIDDEN', 'Actual callback delegate refusal.'); let attempts = 0, callbackFaults = 0;
    const prisma = { $transaction: async (work: (tx: any) => Promise<unknown>) => {
      attempts++; const tx = { shipment: { findUnique: async () => { callbackFaults++; throw original; } } };
      try { await work(tx); } catch (error) { expect(error).toBe(original); throw errors.businessError('CONFLICT', sql); }
      throw Error('Actual callback must reach its first storage delegate');
    } };
    let caught: unknown;
    try { await saveShipmentCartonMetadata({ prisma: prisma as any, shipmentId: 'private-target', actor: null, input: validInput() }); } catch (error) { caught = error; }
    expect(shipmentCartonMetadataError(caught)).toEqual(safeUnknown); expect(attempts).toBe(1); expect(callbackFaults).toBe(1);
  });
});
