/** Actual native transaction error boundary with an injected transaction fault.
 * No DB is contacted; this does not prove concurrent PG execution or rollback. */
import { describe, expect, it } from 'vitest';
import { makePrisma, makeService, VALID_INPUT } from './nativeInternalTransferFixture';

describe('native internal transfer error status has one authority', () => {
  it.each([
    { code: 'P2034' }, { code: 'P2002' }, { code: 'P2010', meta: { code: '40001' } },
  ])('existing storage conflict $code preserves SOURCE_CHANGED, exact public copy and 409', async details => {
    const f = makePrisma(), { service } = makeService(f.prisma);
    f.prisma.$transaction.mockRejectedValue(Object.assign(Error('private SQL conflict /private/table'), details));
    const result = await service.createInternalTransfer(VALID_INPUT);
    expect(result).toEqual({ ok: false, error: { code: 'SOURCE_CHANGED', statusCode: 409,
      message: '内部供料来源并发变化，请保留原请求并重新加载' } });
    expect(f.transfers).toHaveLength(0); expect(f.approvals).toHaveLength(0); expect(f.auditLogs).toHaveLength(0);
  });
  it.each([
    { code: 'P2022' }, { code: 'P2010', meta: { code: '42P01' } },
  ])('unknown $code SQL fault remains safe INTERNAL_ERROR/500 without a fake source conflict', async details => {
    const f = makePrisma(), { service } = makeService(f.prisma);
    f.prisma.$transaction.mockRejectedValue(Object.assign(Error('币种必填，不存在 SQL SELECT private_table /private/path'), details));
    const result = await service.createInternalTransfer(VALID_INPUT);
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', statusCode: 500,
      message: '内部供料单创建未能完成，本次未确认任何改动，请稍后重试' } });
    expect(f.transfers).toHaveLength(0); expect(f.approvals).toHaveLength(0); expect(f.auditLogs).toHaveLength(0);
  });
});
