import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelationsRouter } from '../route';

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>() }));
  return app;
}

describe('POST /api/v1/relations/query', () => {
  it('supports relation filters for category, address, contact email, payment terms, and recent sorting', async () => {
    const prisma = {
      relation: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'REL-PEERLESS-CLOTHING',
            name: 'Peerless Clothing',
            category: 'Customer',
            type: 'Customer',
            tags: ['canada'],
            summary: 'Canadian customer',
            primaryContactEmail: 'buyer@peerless.test',
            billingAddress: 'Montreal Canada',
            paymentTerms: 'AS PER AGREEMENT',
            currency: 'USD',
            lastInteraction: BigInt(1780000000000),
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
        upsert: vi.fn().mockImplementation(async ({ create }) => create),
        updateMany: vi.fn(),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/api/v1/relations/query')
      .send({
        filters: {
          categories: ['Customer'],
          address: 'Canada',
          primaryContactEmail: 'peerless',
          paymentTerms: 'agreement',
        },
        sort: { field: 'lastInteraction', direction: 'desc' },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe('REL-PEERLESS-CLOTHING');
    expect(prisma.relation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { deletedAt: null },
          expect.objectContaining({ OR: expect.arrayContaining([{ category: { contains: 'Customer', mode: 'insensitive' } }]) }),
          expect.objectContaining({ OR: expect.arrayContaining([{ billingAddress: { contains: 'Canada', mode: 'insensitive' } }]) }),
          { paymentTerms: { contains: 'agreement', mode: 'insensitive' } },
        ]),
      }),
      orderBy: [{ lastInteraction: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    }));
  });
});
