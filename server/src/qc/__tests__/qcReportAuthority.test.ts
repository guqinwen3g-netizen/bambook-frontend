import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { QcReportError, qcReportFailure, qcReportSourceFingerprint } from '../qcReportAuthority';
import { safeRouteError } from '../../shared/routeError';

// Independent HTTP semantics; do not derive expected statuses from the producer.
describe('finite native QC report error boundary', () => {
  for (const [code, status] of [
    ['VALIDATION_FAILED', 400], ['NOT_FOUND', 404], ['FORBIDDEN', 403], ['UNAUTHORIZED', 401],
    ['ACCOUNT_DISABLED', 401], ['AUTHORIZATION_UNAVAILABLE', 503], ['CONFLICT', 409],
  ] as const) {
    it(`${code} preserves its declared HTTP status and public explanation`, () => {
      const failure = new QcReportError(code, '独立业务说明', 'actor_mismatch');
      expect(failure.statusCode).toBe(status);
      expect(safeRouteError(failure, { fallbackCode: 'QC_REPORT_FAILED' })).toMatchObject({ code, status,
        message: '独立业务说明', passthrough: status < 500 });
    });
  }
  it('unknown SQL and status-shaped text cannot masquerade as a report business error', () => {
    for (const error of [new Error('验货报告不存在 必填 ROLE_REQUIRED SQL private'),
      Object.assign(new Error('SQL private'), { code: 'P2003', statusCode: 404 }),
      new Prisma.PrismaClientKnownRequestError('SQL 不存在', { clientVersion: 'test', code: 'P2010', meta: { code: '42703' } })]) {
      expect(safeRouteError(qcReportFailure(error), { fallbackCode: 'QC_REPORT_FAILED', fallbackMessage: '安全未知失败' }))
        .toMatchObject({ status: 500, message: '安全未知失败', passthrough: false });
    }
  });
  it('only structured actual serialization/deadlock metadata maps to conflict', () => {
    for (const code of ['40001', '40P01']) {
      const error = new Prisma.PrismaClientKnownRequestError('private SQL', { clientVersion: 'test', code: 'P2010', meta: { code } });
      expect(safeRouteError(qcReportFailure(error), { fallbackCode: 'QC_REPORT_FAILED' })).toMatchObject({ status: 409, code: 'CONFLICT' });
    }
    expect(safeRouteError(qcReportFailure(new Error('P2034 40001 40P01')), { fallbackCode: 'QC_REPORT_FAILED' }).status).toBe(500);
  });
  it('source fingerprint retains exact BigInt/Decimal facts and is independent of key order', () => {
    const exact = { amount: new Prisma.Decimal('2.7500'), updatedAt: 9007199254740993n, signature: { qcSignedAt: 1 } };
    expect(qcReportSourceFingerprint(exact)).toBe(qcReportSourceFingerprint({ signature: { qcSignedAt: 1 }, updatedAt: exact.updatedAt, amount: exact.amount }));
    expect(qcReportSourceFingerprint(exact)).not.toBe(qcReportSourceFingerprint({ ...exact, updatedAt: 9007199254740992n }));
  });
});
