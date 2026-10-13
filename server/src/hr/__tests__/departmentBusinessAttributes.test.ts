import { describe, expect, it, vi } from 'vitest';
import { teamBusinessFamilies } from '../departmentBusinessAttributes';
import { retireOrganizationDepartment, updateOrganizationDepartment } from '../organizationService';
const dept = { id: 'd', parentId: 'company', status: 'active', name: '12345', metadata: { retained: true, businessAttributes: ['fabric_business', 'garment_business'] } };
describe('department business attributes', () => {
  it('inherits both domains regardless of group names or obsolete metadata', () => {
    expect(teamBusinessFamilies({ status: 'active', name: '财务', metadata: { businessFamily: 'garment' }, department: dept })).toEqual(['fabric', 'garment']);
  });
  it('never guesses from names or legacy team metadata', () => {
    expect(teamBusinessFamilies({ status: 'active', name: '面料业务组', metadata: { businessFamily: 'fabric' } })).toEqual([]);
  });
  it('QC scope is not business scope', () => {
    expect(teamBusinessFamilies({ status: 'active', department: { ...dept, metadata: { businessAttributes: ['fabric_qc', 'garment_qc'] } } })).toEqual([]);
  });
  it('inactive departments and dissolved groups cannot create', () => {
    expect(teamBusinessFamilies({ status: 'active', department: { ...dept, status: 'inactive' } })).toEqual([]);
    expect(teamBusinessFamilies({ status: 'active', deletedAt: 1n, department: dept })).toEqual([]);
  });
  function db(count = 0) {
    const tx: any = { department: { findUnique: vi.fn(async ({ where }) => where.id === 'target' ? { ...dept, id: 'target' } : dept), findFirst: vi.fn(async () => null), update: vi.fn(async ({ data }) => ({ ...dept, ...data })) } };
    for (const key of ['team', 'userAccount', 'jobPosition']) tx[key] = { count: vi.fn(async () => count), updateMany: vi.fn(async () => ({ count })) };
    return { tx, prisma: { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any };
  }
  it('editing removes attributes and keeps unrelated metadata', async () => {
    const { prisma } = db();
    expect((await updateOrganizationDepartment(prisma, 'd', { name: 'Renamed', businessAttributes: ['fabric_qc'] })).metadata).toEqual({ retained: true, businessAttributes: ['fabric_qc'] });
  });
  it('rejects unknown business attributes', async () => {
    const { prisma, tx } = db(); await expect(updateOrganizationDepartment(prisma, 'd', { businessAttributes: ['admin'] })).rejects.toThrow('有效'); expect(tx.department.update).not.toHaveBeenCalled();
  });
  it('retiring populated department requires valid recipient', async () => {
    const { prisma, tx } = db(2); await expect(retireOrganizationDepartment(prisma, 'd', {})).rejects.toThrow('承接部门'); expect(tx.department.update).not.toHaveBeenCalled();
  });
  it('moves groups, people, positions preserving IDs and history', async () => {
    const { prisma, tx } = db(2); await retireOrganizationDepartment(prisma, 'd', { targetDepartmentId: 'target' });
    expect(tx.team.updateMany).toHaveBeenCalledWith({ where: { departmentId: 'd', deletedAt: null }, data: { departmentId: 'target' } });
    expect(tx.department.update).toHaveBeenCalledWith({ where: { id: 'd' }, data: { status: 'inactive' } });
  });
  it('allows empty department retirement without a target', async () => {
    const { prisma } = db(); expect((await retireOrganizationDepartment(prisma, 'd', {})).retired).toBe(true);
  });
});
