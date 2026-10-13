import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPdmlRouter } from './route';
import { createAuthService, type TokenPayload } from '../auth/service';

const actor: TokenPayload = { userId: 'pdml-current-operator', roles: [], roleIds: ['pdml-custom-role'],
  permissions: ['data:import', 'products:read', 'products:write', 'sensitive:cost'],
  departmentIds: [], authorizationLoaded: true };

/** Original business assertions use an actual configured active storage seam,
 * not anonymous dev-mode authority or an implicit owner/default grant. */
function withAuthorization(prisma: any) {
  const access = {
    userAccount: { findFirst: vi.fn().mockResolvedValue({ id: actor.userId, displayName: 'Fixture operator', status: 'active',
      deletedAt: null, roles: [{ roleId: 'pdml-custom-role', role: { permissions: actor.permissions.map(scope => ({ permission: { scope } })) } }] }) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'PDML-6-10038733' }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  Object.assign(prisma, access);
  if (prisma.$transaction) {
    const original = prisma.$transaction;
    prisma.$transaction = (work: any, options: any) => original((tx: any) => work({ ...prisma, ...tx, ...access }), options);
  }
  return prisma;
}

function makeApp(prisma: any, fetchRows?: any) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const bearer = createAuthService().signToken(actor);
  app.use((req, _res, next) => { req.headers.authorization = `Bearer ${bearer}`; next(); });
  app.use('/api/v1/pdml', createPdmlRouter({ prisma: withAuthorization(prisma), requireAuth: true, apiKeys: new Set<string>(), fetchRows }));
  return app;
}

describe('pdml route', () => {
  it('GET /raw returns cached raw fabrics without mapping them into products', async () => {
    const prisma = {
      pdmlRawFabric: {
        count: vi.fn().mockResolvedValue(17824),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'PDML-6-10038733',
            gsid: '6',
            sourceId: '10038733',
            rawData: { ID: '10038733', GSPH: 'EC27.060122', GYS: '常州丁丁' },
            sourceHash: 'hash-1',
            articleNo: 'EC27.060122',
            factoryArticleNo: '49788',
            supplierName: '常州丁丁',
            firstSeenAt: BigInt(10),
            lastSeenAt: BigInt(20),
            syncedAt: BigInt(30),
            deletedAt: null,
          },
        ]),
      },
      productAsset: { create: vi.fn() },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/pdml/raw?search=EC27');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(17824);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.fabrics[0]).toMatchObject({
      sourceId: '10038733',
      rawData: { ID: '10038733', GSPH: 'EC27.060122', GYS: '常州丁丁' },
      syncedAt: 30,
    });
    expect(prisma.pdmlRawFabric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          OR: expect.any(Array),
        }),
      }),
    );
    expect(prisma.productAsset.create).not.toHaveBeenCalled();
  });

  it('POST /sync upserts complete PDML rows into the raw cache', async () => {
    const fetchRows = vi.fn().mockResolvedValue({
      gsid: '6',
      totalAvailable: 17823,
      rows: [
        {
          ID: '10038733',
          GSPH: 'EC27.060122',
          GCPH: '49788',
          GSSH: '04',
          GCSH: '4',
          GYS: '常州丁丁',
          CPXL: '棉麻类',
          DJRQ: '2026-04-25',
          TPDZ: 'HTTP://hd.jyiba.cn:52015/firewebv/MLXX/6/10038733.JPG',
          ZT: '草稿',
          CF: 'C27/L33/P24/V14/SP2',
        },
      ],
    });
    const prisma = {
      pdmlRawFabric: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockReturnValue(Promise.resolve({ id: 'PDML-6-10038733' })),
      },
      $transaction: vi.fn(async (work: any) => work(prisma)),
    };

    const res = await request(makeApp(prisma, fetchRows))
      .post('/api/v1/pdml/sync')
      .send({ gsid: '6', limit: 1, pageSize: 1, blocking: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      source: 'PDML V_MLXX',
      totalAvailable: 17823,
      fetched: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(fetchRows).toHaveBeenCalledWith({ gsid: '6', limit: 1, pageSize: 1 });
    expect(prisma.pdmlRawFabric.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gsid_sourceId: { gsid: '6', sourceId: '10038733' } },
        create: expect.objectContaining({
          id: 'PDML-6-10038733',
          sourceId: '10038733',
          rawData: expect.objectContaining({ CF: 'C27/L33/P24/V14/SP2' }),
          articleNo: 'EC27.060122',
          factoryArticleNo: '49788',
          supplierName: '常州丁丁',
          productLine: '棉麻类',
          imageUrl: 'HTTP://hd.jyiba.cn:52015/firewebv/MLXX/6/10038733.JPG',
        }),
      }),
    );
  });

  it('POST /sync starts a background job and exposes job status', async () => {
    const fetchRows = vi.fn().mockResolvedValue({
      gsid: '6',
      totalAvailable: 1,
      rows: [{ ID: '10038733', GSPH: 'EC27.060122' }],
    });
    const prisma = {
      pdmlRawFabric: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockReturnValue(Promise.resolve({ id: 'PDML-6-10038733' })),
      },
      $transaction: vi.fn(async (work: any) => work(prisma)),
    };
    const app = makeApp(prisma, fetchRows);

    const start = await request(app)
      .post('/api/v1/pdml/sync')
      .send({ gsid: '6', limit: 1, pageSize: 1 });

    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({
      ok: true,
      status: 'queued',
      gsid: '6',
    });
    expect(start.body.jobId).toEqual(expect.any(String));

    await new Promise(resolve => setTimeout(resolve, 10));

    const status = await request(app).get(`/api/v1/pdml/sync/${start.body.jobId}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('completed');
    expect(status.body.result).toMatchObject({
      ok: true,
      fetched: 1,
      created: 1,
    });
  });

  it('POST /map-products maps cached PDML rows into Bambook fabric assets with MOQ fields', async () => {
    const tx = {
      productSubCategory: { upsert: vi.fn().mockResolvedValue({}) },
      // Existing-asset lookup now belongs to the same atomic mapping transaction.
      productAsset: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
      fabricProfile: { upsert: vi.fn().mockResolvedValue({}) },
      fabricPriceHistory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      fabricCompositionLine: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      materialCompositionTerm: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      pdmlRawFabric: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            sourceId: '10038733',
            rawData: {
              ID: '10038733',
              CPXL: '棉麻类',
              GSPH: 'EC27.060122',
              GCPH: '49788',
              GSSH: '04',
              GCSH: '4',
              GYS: '常州丁丁',
              CF: 'C27/L33/P24/V14/SP2',
              FK: '57/58',
              FKDW: 'inch',
              KZ: '180',
              KZDW: 'G/M2',
              GCCGDJ: '12.5',
              GCBZ: 'RMB',
              QDL: '1000',
              GCQDL: '2000',
              SYQDL: '10.3',
              ZT: '草稿',
              ZLBZ: '双面顺毛',
              TPDZ: 'HTTP://hd.jyiba.cn:52015/firewebv/MLXX/6/10038733.JPG',
            },
          },
        ]),
      },
      productAsset: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    const res = await request(makeApp(prisma)).post('/api/v1/pdml/map-products').send({ limit: 1, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mapped: 1,
      created: 1,
      updated: 0,
      hasMore: false,
    });
    expect(tx.productSubCategory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ mainCategory: 'Fabric', name: '棉麻类' }),
      }),
    );
    expect(tx.productAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'PDML-FAB-10038733' },
        create: expect.objectContaining({
          sku: '10038733',
          cost: null,
          season: '',
          mainCategory: 'Fabric',
          imageUrl: 'HTTP://hd.jyiba.cn:52015/firewebv/MLXX/6/10038733.JPG',
        }),
      }),
    );
    expect(tx.fabricProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productAssetId: 'PDML-FAB-10038733' },
        create: expect.objectContaining({
          articleNo: 'EC27.060122',
          millQuality: '49788',
          millOrganizationId: '常州丁丁',
          weightValue: 180,
          widthValue: null,
          widthUnit: 'inch',
          widthText: '57/58',
          moqValue: 1000,
          factoryMoqValue: 2000,
          sampleMoqValue: 10.3,
          riskNote: '双面顺毛',
        }),
      }),
    );
    expect(tx.fabricPriceHistory.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ priceType: 'factory', amount: 12.5, currency: 'RMB', sourceType: 'pdml' }),
        ]),
      }),
    );
    expect(tx.materialCompositionTerm.upsert).toHaveBeenCalled();
    expect(tx.fabricCompositionLine.create).toHaveBeenCalled();
  });
});
