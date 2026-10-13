import { describe, expect, it } from 'vitest';
import { departmentAuthorization } from '../departmentAuthorization';
const user = (businessAttributes: string[], name = '任意部门') => ({ primaryDepartment: { name, parentId: 'company', status: 'active', metadata: { businessAttributes } } });
const scopes = ['orders:read','orders:write','products:write','qc:inspect','qc:fabric_chain:write','qc:garment_chain:write','shipments:write','customs:write','invoices:write'];
describe('role grants intersect department business attributes', () => {
  it('attributes never grant a missing action', () => { expect(departmentAuthorization(user(['fabric_business']), [], []).permissions).toEqual([]); });
  it('business users retain business actions but not professional QC/logistics/finance actions', () => {
    expect(departmentAuthorization(user(['fabric_business']), ['role-sales'], scopes).permissions).toEqual(['orders:read','orders:write','products:write','qc:fabric_chain:write']);
  });
  it('fabric QC cannot execute garment chain or create orders', () => {
    expect(departmentAuthorization(user(['fabric_qc']), ['role-qc'], scopes).permissions).toEqual(['orders:read','qc:inspect','qc:fabric_chain:write']);
  });
  it('dual QC scope is editable and unaffected by department names', () => {
    expect(departmentAuthorization(user(['fabric_qc','garment_qc']), ['role-qc'], scopes).permissions).toEqual(['orders:read','qc:inspect','qc:fabric_chain:write','qc:garment_chain:write']);
  });
  it('missing or retired department never falls back to names', () => {
    expect(departmentAuthorization(user([], '面料业务部'), ['role-sales'], scopes).permissions).toEqual(['orders:read']);
    const retired = user(['fabric_business']); retired.primaryDepartment.status = 'inactive';
    expect(departmentAuthorization(retired, ['role-sales'], scopes).permissions).toEqual(['orders:read']);
  });
  it('boss retains global scope without group membership', () => { expect(departmentAuthorization({}, ['role-super-admin'], scopes).permissions).toEqual(scopes); });
  it('business inspection assignment never grants professional QC inspection', () => {
    expect(departmentAuthorization(user(['garment_business']), ['role-sales'], ['qc:write','qc:inspect']).permissions).toEqual(['qc:write']);
  });
  it('finance and logistics use their own functional attributes', () => {
    expect(departmentAuthorization(user(['finance','logistics']), ['custom'], scopes).permissions).toEqual(['orders:read','shipments:write','customs:write','invoices:write']);
  });
});
