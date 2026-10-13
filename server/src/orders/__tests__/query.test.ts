import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOrdersRouter } from '../route';

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set<string>() }));
  return app;
}

describe('POST /api/v1/orders/query', () => {
  it('supports structured filters for missing supplier invoice and due-date sorting', async () => {
    const prisma = {
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'ORD-1',
            poNumber: '4500159423',
            customer: 'Peerless Clothing',
            product: 'Wool fabric',
            type: 'Fabric',
            quantity: 100,
            status: 'Pending',
            dueDate: '2026-06-18',
            supplierInvoiceNumber: '',
            millName: 'Panda Mill',
            lines: [],
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/orders/query')
      .send({
        filters: {
          customer: 'Peerless',
          missingFields: ['supplierInvoiceNumber'],
          dueDateTo: '2026-06-20',
        },
        sort: { field: 'dueDate', direction: 'asc' },
        limit: 20,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dataSource).toBe('bambook-data-center');
    expect(res.body.total).toBe(1);
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { deletedAt: null },
          expect.objectContaining({ OR: expect.arrayContaining([{ supplierInvoiceNumber: null }, { supplierInvoiceNumber: '' }]) }),
          { dueDate: { lte: '2026-06-20' } },
        ]),
      }),
      orderBy: { dueDate: 'asc' },
      take: 20,
      skip: 0,
    }));
  });

  it('supports count aggregate without fetching rows', async () => {
    const prisma = {
      order: {
        findMany: vi.fn(),
        count: vi.fn().mockResolvedValue(7),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/orders/query')
      .send({ aggregate: 'count', filters: { statuses: ['Pending'] } });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
