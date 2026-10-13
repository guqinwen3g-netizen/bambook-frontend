import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createLookbookRouter } from '../../products/lookbookRoute';

/**
 * P2b 电子画册测试。Mock Prisma 内存存储 LookbookCatalog + ProductAsset（含 images），
 * 语义对齐真实 client 的本测试用到的子集。
 */
function makeMockPrisma() {
  let seq = 0;
  const lookbooks: any[] = [];
  const products: any[] = [
    {
      id: 'PA__WOOL1', sku: 'WV-24001', name: '羊毛精纺斜纹 240g', deletedAt: null, imageUrl: null,
      images: [
        { id: 'IMG__1', productAssetId: 'PA__WOOL1', filePath: '/uploads/wv24001-1.jpg', sortOrder: 0, isPrimary: false, deletedAt: null },
        { id: 'IMG__2', productAssetId: 'PA__WOOL1', filePath: '/uploads/wv24001-main.jpg', sortOrder: 1, isPrimary: true, deletedAt: null },
      ],
    },
    {
      id: 'PA__WOOL2', sku: 'WV-24002', name: '羊毛精纺平纹 260g', deletedAt: null,
      imageUrl: 'https://cdn.example.com/wv24002.png', images: [],
    },
    {
      id: 'PA__DELETED', sku: 'WV-DELETED', name: '已删产品', deletedAt: 1n, imageUrl: null, images: [],
    },
  ];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders_ = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders_) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const lookbookCatalog = {
    findUnique: async ({ where }: any) => lookbooks.find(r => r.id === where.id) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      const rows = applyOrderBy(lookbooks.filter(r => matchWhere(r, where)), orderBy);
      return rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));
    },
    count: async ({ where }: any = {}) => lookbooks.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { status: 'Draft', items: [], publishedAt: null, deletedAt: null, ...data, id: data.id || `LB__T${++seq}` };
      lookbooks.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = lookbooks.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  // findUnique + include.images：按 include 条件过滤/排序/take
  const productAsset = {
    findUnique: async ({ where, include }: any) => {
      const asset = products.find(p => p.id === where.id);
      if (!asset) return null;
      if (include?.images) {
        const ic = include.images;
        let imgs = asset.images.filter((img: any) => !ic.where || matchWhere(img, ic.where));
        imgs = applyOrderBy(imgs, ic.orderBy);
        if (ic.take) imgs = imgs.slice(0, ic.take);
        return { ...asset, images: imgs };
      }
      return asset;
    },
  };

  return { lookbookCatalog, productAsset, _stores: { lookbooks, products } };
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/lookbooks', createLookbookRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

describe('P2b · lookbook 守卫', () => {
  it('POST / API-Key → 401（写必须 JWT）；GET / API-Key → 401（W-C：读端点挂 products:read scope 门，无 actor 拒）', async () => {
    const app = makeApp(makeMockPrisma());
    const write = await request(app)
      .post('/api/v1/lookbooks')
      .set('x-bambook-api-key', validApiKey)
      .send({ title: '2026 秋冬画册' });
    expect(write.status).toBe(401);

    const read = await request(app)
      .get('/api/v1/lookbooks')
      .set('x-bambook-api-key', validApiKey);
    expect(read.status).toBe(401);
  });
});

describe('P2b · Lookbook CRUD + 状态机', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createLookbook = (app: any, body: Record<string, any> = { title: '2026 秋冬画册' }) =>
    request(app).post('/api/v1/lookbooks').set(auth()).send(body);

  it('创建：标题必填；默认 Draft + 空条目', async () => {
    const app = makeApp(prisma);
    expect((await createLookbook(app, { title: ' ' })).status).toBe(400);
    const ok = await createLookbook(app);
    expect(ok.status).toBe(201);
    expect(ok.body.item.status).toBe('Draft');
    expect(ok.body.item.items).toEqual([]);
  });

  it('setItems：服务端从档案重取快照（主图优先），客户端不可伪造 sku/name/imageUrl', async () => {
    const app = makeApp(prisma);
    const lb = await createLookbook(app);
    const id = lb.body.item.id;

    const res = await request(app)
      .put(`/api/v1/lookbooks/${id}/items`)
      .set(auth())
      .send({
        items: [
          { productAssetId: 'PA__WOOL1', price: 13.5, currency: 'USD', description: '主推', sortOrder: 2 },
          { productAssetId: 'PA__WOOL2', sortOrder: 1 },
        ],
      });
    expect(res.status).toBe(200);
    const items = res.body.item.items;
    // sortOrder 排序：WOOL2 在前
    expect(items[0].productAssetId).toBe('PA__WOOL2');
    expect(items[1].productAssetId).toBe('PA__WOOL1');
    // 快照字段来自档案真源
    expect(items[1].sku).toBe('WV-24001');
    expect(items[1].name).toBe('羊毛精纺斜纹 240g');
    // 主图优先（isPrimary=true 的 IMG__2）
    expect(items[1].imageUrl).toBe('/uploads/wv24001-main.jpg');
    // 无 images 时回退 asset.imageUrl
    expect(items[0].imageUrl).toBe('https://cdn.example.com/wv24002.png');
    expect(items[1].price).toBe(13.5);
  });

  it('setItems 校验：产品不存在 → 404；重复条目 / 价格非法 → 400', async () => {
    const app = makeApp(prisma);
    const lb = await createLookbook(app);
    const id = lb.body.item.id;
    const put = (items: any[]) =>
      request(app).put(`/api/v1/lookbooks/${id}/items`).set(auth()).send({ items });

    expect((await put([{ productAssetId: 'PA__GHOST' }])).status).toBe(404);
    expect((await put([{ productAssetId: 'PA__DELETED' }])).status).toBe(404);
    const dup = await put([{ productAssetId: 'PA__WOOL1' }, { productAssetId: 'PA__WOOL1' }]);
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('重复');
    expect((await put([{ productAssetId: 'PA__WOOL1', price: -1 }])).status).toBe(400);
  });

  it('状态机：空画册不可发布；Draft→Published 记录 publishedAt；publish 幂等；Published→Draft 回退', async () => {
    const app = makeApp(prisma);
    const lb = await createLookbook(app);
    const id = lb.body.item.id;

    const empty = await request(app).post(`/api/v1/lookbooks/${id}/publish`).set(auth());
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('无条目');

    await request(app).put(`/api/v1/lookbooks/${id}/items`).set(auth()).send({ items: [{ productAssetId: 'PA__WOOL1' }] });

    const pub = await request(app).post(`/api/v1/lookbooks/${id}/publish`).set(auth());
    expect(pub.status).toBe(200);
    expect(pub.body.item.status).toBe('Published');
    expect(pub.body.item.publishedAt).not.toBeNull();

    // 幂等：重复 publish 不改变 publishedAt
    const again = await request(app).post(`/api/v1/lookbooks/${id}/publish`).set(auth());
    expect(again.body.item.publishedAt).toBe(pub.body.item.publishedAt);

    // 未发布画册 unpublish → 400；发布后回退成功
    const unpub = await request(app).post(`/api/v1/lookbooks/${id}/unpublish`).set(auth());
    expect(unpub.status).toBe(200);
    expect(unpub.body.item.status).toBe('Draft');
    expect(unpub.body.item.publishedAt).toBeNull();
  });

  it('归档后不可修改/发布；软删后 GET 404、列表不可见', async () => {
    const app = makeApp(prisma);
    const lb = await createLookbook(app);
    const id = lb.body.item.id;
    await request(app).put(`/api/v1/lookbooks/${id}/items`).set(auth()).send({ items: [{ productAssetId: 'PA__WOOL1' }] });

    await request(app).post(`/api/v1/lookbooks/${id}/archive`).set(auth());
    expect((await request(app).patch(`/api/v1/lookbooks/${id}`).set(auth()).send({ title: 'X' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/lookbooks/${id}/publish`).set(auth())).status).toBe(400);
    // 归档幂等
    const again = await request(app).post(`/api/v1/lookbooks/${id}/archive`).set(auth());
    expect(again.status).toBe(200);

    await request(app).delete(`/api/v1/lookbooks/${id}`).set(auth());
    expect((await request(app).get(`/api/v1/lookbooks/${id}`).set(auth())).status).toBe(404);
    const list = await request(app).get('/api/v1/lookbooks').set(auth());
    expect(list.body.total).toBe(0);
  });

  it('列表按 status 过滤；非法 status → 400', async () => {
    const app = makeApp(prisma);
    const lb = await createLookbook(app);
    await request(app).put(`/api/v1/lookbooks/${lb.body.item.id}/items`).set(auth()).send({ items: [{ productAssetId: 'PA__WOOL1' }] });
    await request(app).post(`/api/v1/lookbooks/${lb.body.item.id}/publish`).set(auth());
    await createLookbook(app, { title: '草稿画册' });

    const published = await request(app).get('/api/v1/lookbooks?status=Published').set(auth());
    expect(published.body.total).toBe(1);
    const draft = await request(app).get('/api/v1/lookbooks?status=Draft').set(auth());
    expect(draft.body.total).toBe(1);
    expect((await request(app).get('/api/v1/lookbooks?status=Nope').set(auth())).status).toBe(400);
  });
});
