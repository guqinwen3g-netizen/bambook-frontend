import { departmentBusinessAttributes } from '../hr/departmentBusinessAttributes';

/** Department eligibility constrains an existing action grant; it never creates one. */
export function departmentAuthorization(user: any, roleIds: string[], grantedPermissions: string[]) {
  const businessAttributes = departmentBusinessAttributes(user.primaryDepartment);
  const globalBusinessScope = roleIds.includes('role-super-admin');
  const has = (...attributes: string[]) => globalBusinessScope || attributes.some(attribute => businessAttributes.includes(attribute as any));
  const permissions = grantedPermissions.filter(scope => {
    if (globalBusinessScope) return true;
    if (scope === 'orders:write' || scope === 'orders:delete' || scope === 'products:write') return has('fabric_business', 'garment_business');
    if (scope === 'qc:inspect') return has('fabric_qc', 'garment_qc');
    // Business staff may arrange inspections; professional signing still requires qc:inspect.
    if (scope === 'qc:write') return has('fabric_business', 'garment_business', 'fabric_qc', 'garment_qc');
    if (scope === 'qc:fabric_chain:write') return has('fabric_business', 'fabric_qc');
    if (scope === 'qc:garment_chain:write') return has('garment_business', 'garment_qc');
    if (scope === 'shipments:write' || scope === 'customs:write') return has('logistics');
    // Payment requests and business approvals belong to their original role gates.
    if (/^(invoices|vouchers):write$/.test(scope)) return has('finance');
    return true;
  });
  return { businessAttributes, globalBusinessScope, grantedPermissions, permissions };
}
