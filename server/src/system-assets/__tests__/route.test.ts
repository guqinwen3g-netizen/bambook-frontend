import express from 'express';
import request from 'supertest';
// ★ v3.04：本文件原有一份三列影子（缺 status/powered/seenBy，且 res.text 无空值保护）⇒ 收成共用一份
import { httpEvidence } from '../../shared/__tests__/utils/httpEvidence';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSystemAssetsRouter } from '../route';
import { ownerToken } from '../../__tests__/authTestHelper';

/**
 * system-assets 路由契约测试（补登：本模块此前 **零测试**）。
 * 覆盖：列表（kind 校验 / hidden 与软删排除）/ 文件下载（404 两态 + 正常 + 缓存头）/
 *       上传壁纸（落盘 + 落库 + onDataChange）/ PATCH / 软删 / API-Key 限只读。
 */

const validApiKey = 'test-key';
const authHeader = { Authorization: `Bearer ${ownerToken}` };

let tmpRoot = '';

function makePrisma(seed: any[] = []) {
  const rows = [...seed];
  return {
    _rows: rows,
    systemAsset: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.filter((r) => {
          if (r.kind !== where?.kind) return false;
          if (r.deletedAt != null) return false;
          if (where?.hidden !== undefined && r.hidden !== where.hidden) return false;
          return true;
        })),
      findFirst: vi.fn(async ({ where }: any = {}) =>
        rows.find((r) => {
          if (where?.id && r.id !== where.id) return false;
          if (where?.deletedAt !== undefined && r.deletedAt !== where.deletedAt) return false;
          if (where?.hidden !== undefined && r.hidden !== where.hidden) return false;
          return true;
        }) ?? null),
      findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx >= 0) { rows[idx] = { ...rows[idx], ...update, id: where.id }; return rows[idx]; }
        const row = { ...create, id: where.id ?? create.id };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error('NOT_FOUND');
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      }),
    },
  } as any;
}

function makeApp(prisma: any, onDataChange = vi.fn(), opts: { injectJwt?: boolean } = {}) {
  const injectJwt = opts.injectJwt !== false;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (injectJwt && !req.headers.authorization && !req.headers.cookie) {
      req.headers.authorization = `Bearer ${ownerToken}`;
    }
    next();
  });
  app.use('/api/v1/system-assets', createSystemAssetsRouter({
    prisma, requireAuth: true, apiKeys: new Set([validApiKey]), uploadDir: tmpRoot, onDataChange,
  }));
  return app;
}

/**
 * §9 **B15** 取证：本文件是全量套件里**连续两轮同形**的红（PATCH/DELETE 期望 200 却收到 404），
 * 而"谁答的这个 404"至今无证据。断言消息里带上应答指纹 ⇒ 下次红就能直接分辨三件事：
 * ① `ct=text/html` + `body={}` ⇒ express 自己没匹配到路由；② `ct=application/json` 且 body 带码 ⇒ 有 handler 答了错的东西；
 * ③ `server` 头不是本仓会发的值 ⇒ 才谈得上"被本仓之外的应答者接走"。
 */
const baseAsset = (over: any = {}) => ({  id: 'W1', kind: 'wallpaper', title: '晨雾', group: '默认',
  filePath: null, fileName: null, mimeType: null, fileSize: null,
  sortOrder: 0, hidden: false, metadata: {},
  createdAt: 1n, updatedAt: 2n, deletedAt: null, ...over,
});

describe('systemAssetsRoute', () => {
  let onDataChange: any;
  beforeEach(() => {
    onDataChange = vi.fn();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysassets-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET / 列出可见壁纸（排除 hidden 与软删）；includeHidden=true 才含 hidden', async () => {
    const prisma = makePrisma([
      baseAsset({ id: 'W1' }),
      baseAsset({ id: 'W2', hidden: true }),
      baseAsset({ id: 'W3', deletedAt: 9n }),
    ]);
    const visible = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/').set(authHeader);
    expect(visible.status).toBe(200);
    expect(visible.body.assets.map((a: any) => a.id)).toEqual(['W1']);

    const all = await request(makeApp(prisma, onDataChange))
      .get('/api/v1/system-assets/?includeHidden=true').set(authHeader);
    expect(all.body.assets.map((a: any) => a.id)).toEqual(['W1', 'W2']);
  });

  it('GET / 非法 kind → 400 INVALID_KIND', async () => {
    const prisma = makePrisma();
    const res = await request(makeApp(prisma, onDataChange))
      .get('/api/v1/system-assets/?kind=avatar').set(authHeader);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_KIND');
  });

  it('序列化：createdAt/updatedAt/deletedAt 转 number，并按 filePath 生成 fileUrl', async () => {
    const prisma = makePrisma([baseAsset({ filePath: 'system/wallpapers/w1.png' })]);
    const res = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/').set(authHeader);
    const a = res.body.assets[0];
    expect(typeof a.updatedAt).toBe('number');
    expect(a.deletedAt).toBeNull();
    expect(a.fileUrl).toBe('/api/v1/system-assets/W1/file');
  });

  it('GET /:id/file 三态：无 filePath → 404 NOT_FOUND；文件缺失 → 404 FILE_MISSING；正常 → 200 + 缓存头', async () => {
    const noFile = makePrisma([baseAsset({ id: 'W1', filePath: null })]);
    const r1 = await request(makeApp(noFile, onDataChange)).get('/api/v1/system-assets/W1/file');
    expect(r1.status).toBe(404);
    expect(r1.body.error).toBe('NOT_FOUND');

    const missing = makePrisma([baseAsset({ id: 'W2', filePath: 'system/wallpapers/gone.png' })]);
    const r2 = await request(makeApp(missing, onDataChange)).get('/api/v1/system-assets/W2/file');
    expect(r2.status).toBe(404);
    expect(r2.body.error).toBe('FILE_MISSING');

    const dir = path.join(tmpRoot, 'system', 'wallpapers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'w3.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ok = makePrisma([baseAsset({ id: 'W3', filePath: 'system/wallpapers/w3.png', mimeType: 'image/png' })]);
    const r3 = await request(makeApp(ok, onDataChange)).get('/api/v1/system-assets/W3/file');
    expect(r3.status).toBe(200);
    expect(r3.headers['content-type']).toContain('image/png');
    expect(r3.headers['cache-control']).toContain('immutable');
  });

  it('POST /wallpapers 上传 → 落盘 system/wallpapers/ + 落库 201 + onDataChange', async () => {
    const prisma = makePrisma();
    const res = await request(makeApp(prisma, onDataChange))
      .post('/api/v1/system-assets/wallpapers')
      .set(authHeader)
      .field('id', 'WALL-1')
      .field('title', '晨 雾')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'sunrise.png');
    expect(res.status).toBe(201);
    expect(res.body.asset.id).toBe('WALL-1');
    // 标题空白被压缩（sanitizeFileStem）
    expect(res.body.asset.fileName).toBe('sunrise.png');
    expect(res.body.asset.filePath).toMatch(/^system[\\/]wallpapers[\\/]晨雾\.png$/);
    expect(fs.existsSync(path.join(tmpRoot, res.body.asset.filePath))).toBe(true);
    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'system-assets', action: 'upsert' }),
    );
  });

  it('PATCH /:id 更新 title/hidden/sortOrder + onDataChange', async () => {
    const prisma = makePrisma([baseAsset({ id: 'W1' })]);
    const res = await request(makeApp(prisma, onDataChange)).patch('/api/v1/system-assets/W1')
      .set(authHeader).send({ title: '夜航', hidden: true, sortOrder: 5 });
    expect(res.status, `B15 取证 PATCH：${httpEvidence(res)}`).toBe(200);
    expect(res.body.asset.title).toBe('夜航');
    expect(res.body.asset.hidden).toBe(true);
    expect(res.body.asset.sortOrder).toBe(5);
    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'system-assets', action: 'update' }),
    );
  });

  it('DELETE /:id → 软删（置 deletedAt）+ onDataChange', async () => {
    const prisma = makePrisma([baseAsset({ id: 'W1' })]);
    const res = await request(makeApp(prisma, onDataChange)).delete('/api/v1/system-assets/W1').set(authHeader);
    expect(res.status, `B15 取证 DELETE：${httpEvidence(res)}`).toBe(200);
    expect(res.body.deleted).toBe('W1');
    expect(prisma._rows[0].deletedAt).not.toBeNull();
    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'system-assets', action: 'delete' }),
    );
  });

  // —— 2026-09-15 收口：/file 路由注册在鉴权守卫之前（登录页壁纸需匿名可读），
  //    收口后必须保证「公开面」不随素材类型扩张。以下 3 例锁死这条边界。

  it('GET /:id/file 非 wallpaper 类型 → 落回鉴权守卫（匿名 401，不得公开直读）', async () => {
    const dir = path.join(tmpRoot, 'system', 'docs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret.pdf'), Buffer.from('%PDF-1.4 商业发票'));
    const prisma = makePrisma([
      baseAsset({ id: 'D1', kind: 'document', filePath: 'system/docs/secret.pdf', mimeType: 'application/pdf' }),
    ]);
    // 匿名访问：必须被守卫拦下
    const anon = await request(makeApp(prisma, onDataChange, { injectJwt: false }))
      .get('/api/v1/system-assets/D1/file');
    expect(anon.status).toBe(401);
    expect(anon.body.error).toBe('UNAUTHORIZED');
    expect(anon.text).not.toContain('%PDF');

    // 带 JWT 也不得走"公开直读"分支（此处路由无后续处理器 → 非 200）
    const authed = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/D1/file');
    expect(authed.status).not.toBe(200);
  });

  it('GET /:id/file filePath 越出 uploadDir → 404 且内容不得泄露（纵深防御）', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      const secretPath = path.join(outside, 'secret.txt');
      fs.writeFileSync(secretPath, 'TOP-SECRET-OUTSIDE-UPLOADDIR');
      const escapePath = path.relative(tmpRoot, secretPath); // ../../outside-xxx/secret.txt
      expect(escapePath.startsWith('..')).toBe(true); // 前提：确实是逃逸路径
      const prisma = makePrisma([baseAsset({ id: 'E1', filePath: escapePath, mimeType: 'text/plain' })]);
      const res = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/E1/file');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      expect(res.text).not.toContain('TOP-SECRET-OUTSIDE-UPLOADDIR');
    } finally {
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('GET /:id/file hidden 或已软删的壁纸 → 404（公开面只含未隐藏且未删除）', async () => {
    const dir = path.join(tmpRoot, 'system', 'wallpapers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'w.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const prisma = makePrisma([
      baseAsset({ id: 'H1', filePath: 'system/wallpapers/w.png', hidden: true }),
      baseAsset({ id: 'S1', filePath: 'system/wallpapers/w.png', deletedAt: 9n }),
    ]);
    const hidden = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/H1/file');
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toBe('NOT_FOUND');
    const softDeleted = await request(makeApp(prisma, onDataChange)).get('/api/v1/system-assets/S1/file');
    expect(softDeleted.status).toBe(404);
    expect(softDeleted.body.error).toBe('NOT_FOUND');
  });

  it('API-Key 仅只读：写端点全部 401，读放行', async () => {
    const prisma = makePrisma([baseAsset({ id: 'W1' })]);
    const app = makeApp(prisma, onDataChange, { injectJwt: false });
    const key = { 'X-Bambook-API-Key': validApiKey };
    expect((await request(app).post('/api/v1/system-assets/wallpapers').set(key)).status).toBe(401);
    expect((await request(app).patch('/api/v1/system-assets/W1').set(key).send({ title: 'x' })).status).toBe(401);
    expect((await request(app).delete('/api/v1/system-assets/W1').set(key)).status).toBe(401);
    expect((await request(app).get('/api/v1/system-assets/').set(key)).status).toBe(200);
  });
});
