import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { validateDepartmentBusinessAttributes } from './departmentBusinessAttributes';

export class OrganizationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function createOrganizationDepartment(prisma: PrismaClient, input: { name?: string; parentId?: string; businessAttributes?: unknown }) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new OrganizationError('请输入部门名称。');
  if (!input.parentId) throw new OrganizationError('当前版本仅支持一个公司，请选择公司新增部门。');
  return prisma.$transaction(async tx => {
    const company = await tx.department.findUnique({ where: { id: input.parentId } });
    if (!company || company.parentId || company.status !== 'active') throw new OrganizationError('请选择有效的公司节点。');
    const duplicate = await tx.department.findFirst({ where: { parentId: company.id, name, status: 'active' } });
    if (duplicate) throw new OrganizationError('该公司已有同名部门。', 409);
    const attributes = checkedAttributes(input.businessAttributes ?? []);
    return tx.department.create({ data: { id: randomUUID(), name, parentId: company.id, status: 'active', metadata: { businessAttributes: attributes } } });
  });
}

function checkedAttributes(value: unknown) {
  try { return validateDepartmentBusinessAttributes(value); }
  catch { throw new OrganizationError('请选择有效的部门业务属性。'); }
}
export async function updateOrganizationDepartment(prisma: PrismaClient, id: string, input: { name?: string; businessAttributes?: unknown }) {
  return prisma.$transaction(async tx => {
    const current = await tx.department.findUnique({ where: { id } });
    if (!current?.parentId || current.status !== 'active') throw new OrganizationError('请选择有效部门。');
    const name = typeof input.name === 'string' ? input.name.trim() : current.name;
    if (!name) throw new OrganizationError('请输入部门名称。');
    if (await tx.department.findFirst({ where: { parentId: current.parentId, name, status: 'active', id: { not: id } } })) throw new OrganizationError('该公司已有同名部门。', 409);
    const metadata = current.metadata && typeof current.metadata === 'object' && !Array.isArray(current.metadata) ? current.metadata : {};
    return tx.department.update({ where: { id }, data: { name, metadata: { ...metadata, businessAttributes: checkedAttributes(input.businessAttributes ?? (metadata as any).businessAttributes ?? []) } } });
  });
}
export async function retireOrganizationDepartment(prisma: PrismaClient, id: string, input: { targetDepartmentId?: string }) {
  return prisma.$transaction(async tx => {
    const current = await tx.department.findUnique({ where: { id } });
    if (!current?.parentId || current.status !== 'active') throw new OrganizationError('请选择有效部门。');
    const [teams, people, positions] = await Promise.all([
      tx.team.count({ where: { departmentId: id, deletedAt: null } }),
      tx.userAccount.count({ where: { primaryDeptId: id, deletedAt: null } }),
      tx.jobPosition.count({ where: { departmentId: id, deletedAt: null } }),
    ]);
    if (teams || people || positions) {
      const target = input.targetDepartmentId ? await tx.department.findUnique({ where: { id: input.targetDepartmentId } }) : null;
      if (!target || target.id === id || target.parentId !== current.parentId || target.status !== 'active') throw new OrganizationError(`该部门有 ${teams} 个小组、${people} 名人员、${positions} 个岗位，请选择承接部门。`, 409);
      await tx.team.updateMany({ where: { departmentId: id, deletedAt: null }, data: { departmentId: target.id } });
      await tx.userAccount.updateMany({ where: { primaryDeptId: id, deletedAt: null }, data: { primaryDeptId: target.id } });
      await tx.jobPosition.updateMany({ where: { departmentId: id, deletedAt: null }, data: { departmentId: target.id } });
    }
    await tx.department.update({ where: { id }, data: { status: 'inactive' } });
    return { retired: true, transferred: { teams, people, positions }, targetDepartmentId: input.targetDepartmentId || null };
  });
}
