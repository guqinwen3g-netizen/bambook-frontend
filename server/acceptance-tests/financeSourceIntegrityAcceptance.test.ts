import {createAcceptanceCashAccount,acceptanceCashInput} from './companyCashAcceptanceHelpers';
/** Opt-in isolated PG/HTTP evidence. Fixtures contain accounts/master data;
 * actual expenses, billing decisions, issued CI, AR and allocations are only
 * created through their canonical HTTP producers. No financial fact is seeded. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevelopmentBusinessCiRouter } from '../src/development/developmentBusinessCiRoute';
import { createDevelopmentCiFinanceRouter } from '../src/finance/developmentCiFinanceRoute';
import { createFinanceRouter } from '../src/finance/route';
import { createFinanceV2Router } from '../src/finance/routeV2';
import { createReconciliationRouter } from '../src/finance/reconciliationRoute';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, type GlobalBusinessHttpFixture, type BusinessFixtureActorName, type HttpMethod } from './globalBusinessFixtures';

let prisma: PrismaClient, f: GlobalBusinessHttpFixture;
let loseCashAcknowledgement = false;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
const http = (actor: BusinessFixtureActorName, method: HttpMethod, path: string, body?: unknown) => f.request(actor, method, path, body);
function status(response: any, expected = 200, context = 'development CI HTTP') {
  expect(response.status, `${context}: ${diagnostic(response.body)}`).toBe(expected);
  expect(diagnostic(response.body)).not.toMatch(/P2003|P2010|23503|42703|PRIVATE committed cash acknowledgement/i);
  return response.body;
}
beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL } } });
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy(prisma, { get(target, key) {
    if (key === '$transaction') return async (...args: any[]) => {
      const result = await (target.$transaction as any)(...args);
      if (loseCashAcknowledgement && result?.voucher?.type === 'Receipt' && result?.replayed === false) {
        loseCashAcknowledgement = false; throw new Error('PRIVATE committed cash acknowledgement disconnected');
      }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: `finance-f1-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/development', createDevelopmentBusinessCiRouter(options));
    app.use('/api/v1/finance', createDevelopmentCiFinanceRouter(options));
    app.use('/api/v1/finance', createFinanceRouter(options));
    app.use('/api/v2/finance', createFinanceV2Router(options));
    app.use('/api/v1/reconciliation', createReconciliationRouter(options));
  } });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma?.$disconnect(); });

async function draft(label: string, amount = '100') {
  const created = status(await http('salesOwner', 'post', '/api/v1/development', {
    code: `${f.prefix}-${label}`, name: `开发收费 ${label}`, type: 'fabric', ownerId: f.actors.salesOwner.id,
    initiator: 'customer', customerInput: 'spec-direction', customerRelationId: f.customer.id, customerName: f.customer.name,
    developmentDirection: '独立真实开发费用及客户收费', source: 'customer-request',
  }), 201, 'create development');
  const caseId = created.case.id, path = `/api/v1/development/${encodeURIComponent(caseId)}`;
  const expense = status(await http('salesOwner', 'post', `${path}/costs`, { requestKey: randomUUID(), sourceType: 'DevelopmentCase',
    sourceId: caseId, costType: 'development', amount: '20', currency: 'CNY', incurredAt: '2026-10-07',
    bearerType: 'customer', bearerRelationId: f.customer.id, notes: '实际开发服务账单，原币成本' }), 200, 'register actual expense').costRecord;
  expect(expense).toMatchObject({ sourceType: 'DevelopmentCase', sourceId: caseId, costType: 'development', currency: 'CNY' });
  const billed = status(await http('salesOwner', 'post', `${path}/billing-drafts`, { requestKey: randomUUID(), amount,
    waivedAmount: '0', currency: 'USD', note: '业务与客户确定开发服务收费，独立于原币成本' }), 200, 'business billing decision');
  const billingId = billed.billingItem.id;
  const source = status(await http('salesOwner', 'get', `${path}/ci-source/${encodeURIComponent(billingId)}`));
  const save = { action: 'save', requestKey: randomUUID(), billingItemId: billingId, expectedVersion: 0,
    expectedSourceFingerprint: source.sourceFingerprint, fields: { issueDate: '2026-10-07', dueDate: '2026-11-07',
      paymentTerms: 'TT 30 days', note: 'Development services', billTo: { name: f.customer.name, address: 'Synthetic buyer address' },
      exporter: { nameEn: 'Synthetic seller', addressEn: 'Synthetic seller address', beneficiary: 'Synthetic seller', bankName: 'Synthetic bank', usdAccountNumber: 'ACCEPTANCE-ONLY' } } };
  const saved = status(await http('salesOwner', 'post', `${path}/ci-commands`, save), 200, 'business saves CI');
  const issue = { action: 'issue', requestKey: randomUUID(), billingItemId: billingId, documentId: saved.receipt.documentId,
    expectedVersion: 1, expectedSourceFingerprint: source.sourceFingerprint };
  const businessState = await prisma.developmentCase.findUniqueOrThrow({ where: { id: caseId }, select: { stage: true } });
  const lifecycleEvents = await prisma.developmentLifecycleEvent.findMany({ where: { developmentCaseId: caseId }, orderBy: { revision: 'asc' } });
  return { caseId, path, expense, billingId, source, save, saved, issue, businessState, lifecycleEvents };
}
async function issueAndRegister(label: string, amount = '100') {
  const d = await draft(label, amount);
  const issued = status(await http('salesOwner', 'post', `${d.path}/ci-commands`, d.issue));
  const registration = { requestKey: randomUUID(), expectedVersionId: issued.receipt.versionId };
  const registered = status(await http('finance', 'post', `/api/v1/finance/development-ci/${issued.receipt.documentId}/register`, registration));
  return { ...d, issued, registration, registered, invoice: registered.invoice };
}

describe('F1 native current financial source, V1/V2 cash commands and original paper protection', () => {
  it('real cost → business CI → finance registration → V2 actual cash, lost ACK/retry → allocation → native readback', async () => {
    const baseline = status(await http('finance', 'get', '/api/v2/finance/summary'));
    const usdBefore = baseline.byCurrency.find((row: any) => row.currency === 'USD')?.receivable.outstanding ?? '0';
    const a = await issueAndRegister('original', '100');
    const companyAccount=await createAcceptanceCashAccount(f);
    const input = {...await acceptanceCashInput(f,companyAccount.id),requestKey: randomUUID(), type: 'Receipt', amount: '60', currency: 'USD', paymentDate: '2026-10-07',
      paymentMethod: 'TT', customerRelationId: f.customer.id, customerName: f.customer.name,
      ownerId: f.actors.salesOutsider.id, notes: '实际银行到账，不以凭证创建人替代当前客户来源权限。'};
    loseCashAcknowledgement = true;
    status(await http('finance', 'post', '/api/v2/finance/payments', input), 500, 'unknown committed bank acknowledgement');
    const original = status(await http('finance', 'post', '/api/v2/finance/payments', input)).payment;
    expect(original.ownerId).toBe(f.actors.finance.id);
    const replay = status(await http('finance', 'post', '/api/v2/finance/payments', input)).payment;
    expect(replay).toEqual(original);
    expect(await prisma.paymentVoucher.count({where:{id: original.id}})).toBe(1);
    status(await http('finance', 'post', '/api/v2/finance/payments', {...input, amount:'61'}), 409, 'same key cannot change actual cash');
    status(await http('finance', 'post', '/api/v1/finance/allocations', {invoiceId:a.invoice.id,voucherId:original.id,appliedAmount:'40',appliedDate:'2026-10-07'}), 201);
    const cash = status(await http('finance', 'get', `/api/v2/finance/payments/${original.id}`)).payment;
    status(await http('finance','delete',`/api/v2/finance/payments/${cash.id}`,{requestKey:randomUUID(),expectedUpdatedAt:String(cash.updatedAt)}),409,'V2 cannot delete allocated bank proof');
    status(await http('finance','put',`/api/v2/finance/payments/${cash.id}`,{requestKey:randomUUID(),expectedUpdatedAt:'1',notes:'stale change'}),409,'stale exact financial revision');
    const readback = status(await http('salesOwner','get',`${a.path}/ci-finance`));
    expect(readback.items[0].invoice).toMatchObject({id:a.invoice.id,appliedAmount:'40.0000',openAmount:'60.0000'});
    const summary = status(await http('finance','get','/api/v2/finance/summary'));
    expect(new Prisma.Decimal(summary.byCurrency.find((row:any)=>row.currency==='USD').receivable.outstanding)
      .minus(usdBefore).toString()).toBe('60');
    status(await http('finance','delete',`/api/v2/finance/invoices/${a.invoice.id}`),409,'original CI cannot be deleted via V2');
    status(await http('finance','post','/api/v2/finance/vat-invoices',{requestKey:randomUUID(),vatNumber:`${f.prefix}-VAT`,direction:'Input',invoiceType:'Special',
      sellerName:'Outside supplier',buyerName:'Our company',issueDate:'2026-10-07',netAmount:'100',taxRate:'13',taxAmount:'13',totalAmount:'113',currency:'USD',
      relationId:f.customer.id,invoiceId:a.invoice.id}),409,'supplier VAT cannot use our business CI');
    status(await http('salesOutsider','get',`/api/v2/finance/invoices/${a.invoice.id}`),404,'current financial scope and actual source L2');
    status(await http('salesOutsider','get',`/api/v1/finance/reports/statement?customerRelationId=${encodeURIComponent(f.customer.id)}`),404,'report source L2');
    status(await http('salesOutsider','get',`/api/v1/reconciliation/customers/${encodeURIComponent(f.customer.id)}`),404,'reconciliation source L2');
    const originalVersion = await prisma.documentVersion.findUniqueOrThrow({where:{id:a.issued.receipt.versionId}});
    expect((originalVersion.content as any).developmentCommercialInvoiceSnapshot.issuedAt).toBeTruthy();
    const role = await prisma.userRole.findFirstOrThrow({where:{userId:f.actors.finance.id,roleId:f.actors.finance.roleId}});
    await prisma.userRole.delete({where:{id:role.id}});
    status(await http('finance','post','/api/v2/finance/payments',input),403,'revoked old token cannot replay');
    expect(await prisma.paymentVoucher.count({where:{id:original.id}})).toBe(1);
  });
});
