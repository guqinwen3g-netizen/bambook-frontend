import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRelationsRouter } from '../route';

// JWT mock for requireRole on write ops (POST/PUT/DELETE). Signed with the
// same default secret as auth/service.ts. requireAuth=false bypasses the
// module guard, but requireRole always requires a verified JWT payload.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/relations', createRelationsRouter({ prisma, requireAuth: false, apiKeys: new Set<string>() }));
  return app;
}

describe('relations route', () => {
  it('lists relations with deterministic tie-breakers after recent interaction sorting', async () => {
    const prisma = {
      relation: {
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        upsert: vi.fn().mockImplementation(async ({ create }) => create),
        updateMany: vi.fn(),
      },
      // 联系人计数徽标聚合（GET / 列表 contactCount）
      contact: {
        groupBy: vi.fn().mockResolvedValue([]),
      },
    };

    const res = await request(makeApp(prisma)).get('/api/v1/relations');

    expect(res.status).toBe(200);
    expect(prisma.relation.findMany).toHaveBeenLastCalledWith({
      where: { deletedAt: null },
      orderBy: [
        { isOrganization: 'desc' },
        { lastInteraction: 'desc' },
        { name: 'asc' },
        { id: 'asc' },
      ],
    });
  });

  it('preserves structured organization fields on upsert', async () => {
    // task: relations-audit-entitylink-contract: upsert 现在在 $transaction 内，mock tx
    const upsertSpy = vi.fn().mockImplementation(async ({ create }: any) => create);
    const prisma = {
      relation: {
        upsert: upsertSpy,
        findUnique: vi.fn().mockResolvedValue({ id: 'REL-ORG-1', name: 'old', category: 'Customer', type: 'Customer' }),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        relation: { upsert: upsertSpy, findUnique: vi.fn().mockResolvedValue(null) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      })),
    };

    const payload = {
      id: 'REL-ORG-1',
      name: 'Peerless Clothing',
      chineseName: 'Peerless 服装',
      englishName: 'Peerless Clothing',
      category: 'Customer',
      type: 'Customer',
      isOrganization: true,
      rating: 5,
      summary: 'Strategic customer.',
      primaryContactName: 'Kevin',
      primaryContactEmail: 'kevin@example.com',
      primaryContactPhone: '+1 111 222',
      backupContacts: [{ name: 'Backup', email: 'backup@example.com', phone: '+1 333' }],
      shipToAddresses: [{ contactName: 'Warehouse', city: 'Montreal', address: '8888 PIE IX' }],
      financialNotes: 'Prefer USD wire transfer.',
    };

    const res = await request(makeApp(prisma)).post('/api/v1/relations').set(auth()).send(payload);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.relation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          chineseName: 'Peerless 服装',
          englishName: 'Peerless Clothing',
          rating: 5,
          creditLevel: null,
          summary: 'Strategic customer.',
          primaryContactName: 'Kevin',
          primaryContactEmail: 'kevin@example.com',
          primaryContactPhone: '+1 111 222',
          backupContacts: [{ name: 'Backup', email: 'backup@example.com', phone: '+1 333' }],
          shipToAddresses: [{ contactName: 'Warehouse', city: 'Montreal', address: '8888 PIE IX' }],
          financialNotes: 'Prefer USD wire transfer.',
        }),
      }),
    );
  });

  it('expands an organization into profile contacts and related people', async () => {
    const organization = {
      id: 'panda001',
      name: 'Jiangsu Panda Clothing Co., Ltd.',
      chineseName: '江苏庞大纺织服饰有限公司',
      englishName: 'Jiangsu Panda Clothing Co., Ltd.',
      category: 'Supplier',
      type: 'Supplier',
      isOrganization: true,
      website: 'pandaclothing.cn',
      contactInfo: 'contact@pandaclothing.cn',
      primaryContactName: '王经理',
      primaryContactEmail: 'wang@pandaclothing.cn',
      primaryContactPhone: '+86 25 1000 0000',
      backupContacts: [{ name: '李助理', email: 'li@pandaclothing.cn' }],
      otherContacts: [],
      deletedAt: null,
    };
    const person = {
      id: 'panda-person-1',
      name: 'Merchandiser Zhang',
      category: 'Contact',
      type: 'Contact',
      isOrganization: false,
      parentId: 'panda001',
      role: 'Merchandiser',
      department: 'Merchandising',
      email: 'zhang@pandaclothing.cn',
      mobile: '+86 13800000000',
      lastInteraction: BigInt(1780000000000),
      deletedAt: null,
    };
    const prisma = {
      relation: {
        findFirst: vi.fn().mockResolvedValue(organization),
        findMany: vi.fn().mockResolvedValue([person]),
      },
      // 联系人体系统一：profileContacts 优先读 Contact 表；零行时回退文本解析（本用例验证兜底路径）
      contact: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const res = await request(makeApp(prisma))
      .get('/api/v1/relations/panda001/expand?include=profile,contacts,people&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.found).toBe(true);
    expect(res.body.profileContacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'primaryContact', name: '王经理' }),
      expect.objectContaining({ source: 'backupContacts', name: '李助理' }),
    ]));
    expect(res.body.people).toEqual([
      expect.objectContaining({ id: 'panda-person-1', role: 'Merchandiser' }),
    ]);
  });
});
