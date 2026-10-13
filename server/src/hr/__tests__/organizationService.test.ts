import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOrganizationDepartment } from '../organizationService';
import { createHRRouter } from '../route';
function database() {
  const tx = {
    department: { findUnique: vi.fn().mockResolvedValue({ id: 'department', parentId: 'company', status: 'active' }), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async ({ data }) => data) },
    team: { findUnique: vi.fn().mockResolvedValue({ id: 'team', departmentId: 'department', status: 'active', deletedAt: null }) },
    userAccount: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async ({ data }) => data) },
    employeeProfile: { create: vi.fn().mockResolvedValue({}) }, teamMember: { create: vi.fn().mockResolvedValue({}) },
  };
  return { tx, prisma: { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any };
}
const person = { displayName: 'New Person', departmentId: 'department', teamId: 'team', hireDate: '2026-10-08' };
describe('organization operations', () => {
  it('rejects second company/root creation', async () => {
    const { prisma } = database();
    await expect(createOrganizationDepartment(prisma, { name: 'Second company' })).rejects.toThrow('仅支持一个公司');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('creates department under company', async () => {
    const { prisma, tx } = database();
    tx.department.findUnique.mockResolvedValue({ id: 'company', parentId: null, status: 'active' });
    expect((await createOrganizationDepartment(prisma, { name: 'Marketing', parentId: 'company' })).parentId).toBe('company');
  });
  it('rejects department beneath noncompany', async () => {
    const { prisma, tx } = database();
    await expect(createOrganizationDepartment(prisma, { name: 'Invalid', parentId: 'department' })).rejects.toThrow('公司节点');
    expect(tx.department.create).not.toHaveBeenCalled();
  });
  it('rejects HR account creation without writing identity', async () => {
    const app = express(); app.use(express.json()); app.use('/hr', createHRRouter({ prisma: {} as any, requireAuth: false }));
    expect((await request(app).post('/hr/personnel').send(person)).status).toBe(410);
  });
  for (const path of ['/projects', '/projects/old', '/assignments', '/assignments/old']) {
    it(`retires ${path}`, async () => {
      const app = express(); app.use('/hr', createHRRouter({ prisma: {} as any, requireAuth: false }));
      expect((await request(app).get(`/hr${path}`)).status).toBe(410);
    });
  }
});
