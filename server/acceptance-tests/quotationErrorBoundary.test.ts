// Independent HTTP error-boundary test; service exceptions are deliberately
// injected, so a missing storage mock cannot explain the observed response.
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const injected = vi.hoisted(() => ({ convertToOrder: vi.fn() }));
vi.mock('../src/quotations/quotationService', async importOriginal => ({ ...(await importOriginal<any>()), createQuotationService: () => ({ convertToOrder: injected.convertToOrder }) }));
import { createQuotationRouter } from '../src/quotations/quotationRoute';
const token = jwt.sign({ userId: 'acceptance-sales', roles: ['sales'], permissions: ['quotations:write'] }, process.env.JWT_SECRET!);
function app() {
  const app = express();
  app.use(express.json());
  app.use('/quotations', createQuotationRouter({ prisma: {} as any, requireAuth: true, apiKeys: new Set(), uploadDir: process.env.BAMBOOK_UPLOAD_DIR }));
  return app;
}
describe('acceptance: quotation conversion error boundary', () => {
  it('positive control: an intentional credit refusal remains 409 with its business code', async () => {
    injected.convertToOrder.mockRejectedValueOnce(Object.assign(new Error('信用额度不足'), { code: 'CREDIT_BLOCKED', statusCode: 409 }));
    const response = await request(app()).post('/quotations/Q-acceptance/convert-to-order').set('Authorization', 'Bearer ' + token).send({});
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'CREDIT_BLOCKED', error: '信用额度不足' });
  });
  it('an internal TypeError is a server failure, not a client validation error', async () => {
    const internal = 'INTERNAL_ONLY: Cannot read properties of undefined (pricingCalculation.updateMany)';
    injected.convertToOrder.mockRejectedValueOnce(new TypeError(internal));
    const response = await request(app()).post('/quotations/Q-acceptance/convert-to-order').set('Authorization', 'Bearer ' + token).send({});
    console.log(JSON.stringify({ probe: 'quotation-internal-error', status: response.status, body: response.body }));
    expect(response.status).toBe(500);
  });
  it('unexpected internal details must stay out of the HTTP body', async () => {
    const internal = 'INTERNAL_ONLY: private/table/path/column';
    injected.convertToOrder.mockRejectedValueOnce(new TypeError(internal));
    const response = await request(app()).post('/quotations/Q-acceptance/convert-to-order').set('Authorization', 'Bearer ' + token).send({});
    expect(JSON.stringify(response.body)).not.toContain(internal);
  });
});
