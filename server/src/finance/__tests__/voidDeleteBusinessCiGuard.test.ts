import { describe, expect, it, vi } from 'vitest';
vi.mock('../financeSourceAccess', () => ({createFinanceSourceAccess: async () => ({actor:{userId:'finance-user'},invoice:async()=>true,finish:async()=>undefined})}));
import { cancelInvoice, deleteInvoice } from '../voidDeleteService';

function makeDb() {
  const invoice = { id: 'AR-CI-1', invoiceNumber: 'CI-1', type: 'Receivable', status: 'Issued',
    sourceType: 'BusinessShipmentCI', sourceId: 'DV-CI-1', amount: '100', deletedAt: null };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
    invoice: { findUnique: vi.fn(async () => invoice), update: vi.fn() },
  };
  return { invoice, tx, prisma: { ...tx, $transaction: vi.fn(async (work: (db: any) => Promise<unknown>) => work(tx)) } as any };
}

describe('source-issued CI receivable cannot be detached from its source', () => {
  it.each(['BusinessShipmentCI', 'BusinessDevelopmentCI'])('rejects %s cancel without changing the ledger or producing an audit', async sourceType => {
    const { prisma, tx, invoice } = makeDb(); invoice.sourceType = sourceType;
    const result = await cancelInvoice({ prisma, invoiceId: 'AR-CI-1', actorId: 'finance-user', actor: {userId:'finance-user',roles:[]}, reason: 'wrong amount' });
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
    expect(result.ok ? '' : result.error.message).not.toContain('后勤');
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it.each(['BusinessShipmentCI', 'BusinessDevelopmentCI'])('rejects %s soft-delete without changing the ledger or producing an audit', async sourceType => {
    const { prisma, tx, invoice } = makeDb(); invoice.sourceType = sourceType;
    const result = await deleteInvoice({ prisma, invoiceId: 'AR-CI-1', actorId: 'finance-user', actor: {userId:'finance-user',roles:[]} });
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});
