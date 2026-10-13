export const DEPARTMENT_BUSINESS_ATTRIBUTES = ['fabric_business', 'garment_business', 'fabric_qc', 'garment_qc', 'finance', 'logistics', 'marketing', 'support', 'management'] as const;
export type DepartmentBusinessAttribute = typeof DEPARTMENT_BUSINESS_ATTRIBUTES[number];
export function departmentBusinessAttributes(department: any): DepartmentBusinessAttribute[] {
  if (!department || department.status !== 'active' || !department.parentId) return [];
  const values = department.metadata?.businessAttributes;
  return Array.isArray(values) ? [...new Set(values.filter((v: any): v is DepartmentBusinessAttribute => DEPARTMENT_BUSINESS_ATTRIBUTES.includes(v)))] : [];
}
export function teamBusinessFamilies(team: any): Array<'fabric' | 'garment'> {
  if (!team || team.status !== 'active' || team.deletedAt != null) return [];
  const attributes = departmentBusinessAttributes(team.department);
  return (['fabric', 'garment'] as const).filter(family => attributes.includes(`${family}_business`));
}
export function validateDepartmentBusinessAttributes(value: unknown): DepartmentBusinessAttribute[] {
  if (!Array.isArray(value) || value.some(v => !DEPARTMENT_BUSINESS_ATTRIBUTES.includes(v))) throw new Error('请选择有效的部门业务属性。');
  return [...new Set(value)];
}
