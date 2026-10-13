/**
 * uploadsGuard 回归测试
 *
 * 背景（2026-09-15 实测）：`/api/uploads` 由 express.static 无鉴权直读，
 * 原来用 5 条 `app.use('/api/uploads/xxx', 404)` 字面量挂载拦截敏感子树。
 * 但 app.use 按**原始 URL** 前缀匹配，而 static 会先**解码并折叠重复斜杠**，
 * 视角不一致导致三种写法绕过：
 *   //trade-documents/、trade%2Ddocuments/、trade-documents%2F
 * 实测匿名取到 248,896 字节的商业发票 PDF（含客户与价格数据）。
 *
 * 本文件锁死「任何等价写法都不得绕过」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createUploadsGuard, isSensitiveUploadPath, normalizeUploadSubpath } from '../uploadsGuard';

let root: string;
let app: express.Express;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-uploads-'));
  fs.mkdirSync(path.join(root, 'trade-documents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'products'), { recursive: true });
  fs.writeFileSync(path.join(root, 'trade-documents', 'secret.pdf'), '%PDF-1.4 sensitive');
  fs.writeFileSync(path.join(root, 'products', 'ok.txt'), 'public image');

  app = express();
  app.use('/api/uploads', createUploadsGuard());
  app.use('/api/uploads', express.static(root));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('敏感子树拒绝直读', () => {
  const SECRET = 'trade-documents/secret.pdf';

  it('常规路径 → 404', async () => {
    const res = await request(app).get(`/api/uploads/${SECRET}`);
    expect(res.status).toBe(404);
  });

  it('核心：重复斜杠 // 不得绕过', async () => {
    const res = await request(app).get(`/api/uploads//${SECRET}`);
    expect(res.status).toBe(404);
  });

  it('核心：URL 编码的连字符 %2D 不得绕过', async () => {
    const res = await request(app).get('/api/uploads/trade%2Ddocuments/secret.pdf');
    expect(res.status).toBe(404);
  });

  it('核心：编码的斜杠 %2F 不得绕过', async () => {
    const res = await request(app).get('/api/uploads/trade-documents%2Fsecret.pdf');
    expect(res.status).toBe(404);
  });

  it('大小写变形 → 404', async () => {
    const res = await request(app).get('/api/uploads/Trade-Documents/secret.pdf');
    expect(res.status).toBe(404);
  });

  it('路径穿越 → 404（合法 URL 不含 ..，一律拒绝）', async () => {
    const res = await request(app).get(`/api/uploads/../${path.basename(root)}/trade-documents/secret.pdf`);
    expect(res.status).toBe(404);
  });

  it('其余敏感子树同样拒绝（quotations / test-reports / email-attachments / knowledge-documents）', async () => {
    for (const sub of ['quotations', 'test-reports', 'email-attachments', 'knowledge-documents']) {
      const res = await request(app).get(`/api/uploads/${sub}/whatever.pdf`);
      expect(res.status, sub).toBe(404);
    }
  });
});

describe('对照：不得误伤公开文件', () => {
  it('products 下文件仍可直读', async () => {
    const res = await request(app).get('/api/uploads/products/ok.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('public image');
  });
});

describe('纯函数', () => {
  it('normalizeUploadSubpath 折叠重复斜杠', () => {
    expect(normalizeUploadSubpath('//trade-documents/a.pdf')).toBe('/trade-documents/a.pdf');
  });

  it('isSensitiveUploadPath 对三种等价写法一致判定', () => {
    expect(isSensitiveUploadPath('/trade-documents/a.pdf')).toBe(true);
    expect(isSensitiveUploadPath('//trade-documents/a.pdf')).toBe(true);
    expect(isSensitiveUploadPath('/trade%2Ddocuments/a.pdf')).toBe(true);
    expect(isSensitiveUploadPath('/trade-documents%2Fa.pdf')).toBe(true);
    expect(isSensitiveUploadPath('/products/a.png')).toBe(false);
  });

  it('非法百分号编码不抛错（保持原样判定）', () => {
    expect(() => isSensitiveUploadPath('/%/bad')).not.toThrow();
  });
});
