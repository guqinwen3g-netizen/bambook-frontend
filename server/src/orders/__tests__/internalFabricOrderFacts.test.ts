import { describe, expect, it, vi } from 'vitest';
import { normalizeInternalOrderInput, internalBusinessTeamFamily } from '../internalOrderFacts';
const actor = { userId: 'fabric-business' } as any;
function db() {
  const garment = { id: 'demand', departmentId: 'dept', name: '实际成衣组', status: 'active', deletedAt: null, department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['garment_business'] } } };
  return { team: { findFirst: vi.fn(async () => garment) },
    teamMember: { findMany: vi.fn(async () => [{ team: { id: 'fabric-group', departmentId: 'dept', status: 'active', deletedAt: null, department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['fabric_business'] } } } }]), findFirst: vi.fn(async () => ({ userId: 'receiver', leftAt: null })) },
    userAccount: { findFirst: vi.fn(async () => ({ id: 'receiver', primaryDeptId: 'dept', status: 'active' })) } };
}
describe('internal header persistence uses real schema facts', () => {
  it.each(['后勤单证', '财务协作', '面料QC', '成衣QC'])('excludes support team %s even if it carries a product domain', async name => {
    const team = { id: 'demand', departmentId: 'dept', name, status: 'active', deletedAt: null, metadata: { businessFamily: 'fabric' } };
    expect(internalBusinessTeamFamily(team)).toBeNull();
    const storage = db(); storage.team.findFirst.mockResolvedValue(team as any);
    await expect(normalizeInternalOrderInput(storage, actor, { type: 'Fabric', orderPurpose: 'internal_stock', internalPurpose: '备货', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' })).rejects.toThrow('业务组');
  });
  it('uses department attributes instead of team names and legacy metadata', () => {
    expect(internalBusinessTeamFamily({ name: '面料一组', metadata: { businessFamily: 'fabric', scenarioGroupKind: 'qc' } })).toBeNull();
    expect(internalBusinessTeamFamily({ name: '任意名称', status: 'active', department: { parentId: 'company', status: 'active', metadata: { businessAttributes: ['fabric_business'] } } })).toBe('fabric');
  });
  it.each(['internal_stock', 'internal_fabric_supply'])('current owner can create %s without joining a business team', async orderPurpose => {
    const storage = db(); storage.teamMember.findMany.mockResolvedValue([]);
    const owner = { ...actor, authorizationLoaded: true, roleIds: ['role-super-admin'] };
    expect(await normalizeInternalOrderInput(storage, owner, { type: 'Fabric', orderPurpose, internalPurpose: '供料', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' })).toMatchObject({ orderPurpose, internalDemandTeamId: 'demand' });
    expect(storage.teamMember.findMany).not.toHaveBeenCalled();
    storage.teamMember.findFirst.mockResolvedValue(null as never);
    await expect(normalizeInternalOrderInput(storage, owner, { type: 'Fabric', orderPurpose, internalPurpose: '供料', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' })).rejects.toThrow('已失效');
  });
  it('does not grant a global team bypass from stale role claims or ordinary administrator roles', async () => {
    const storage = db(); storage.teamMember.findMany.mockResolvedValue([]);
    const input = { type: 'Fabric', orderPurpose: 'internal_stock', internalPurpose: '备货', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' };
    for (const identity of [{ ...actor, roleIds: ['role-super-admin'] }, { ...actor, authorizationLoaded: true, roleIds: ['role-admin'], roles: ['admin'] }]) {
      await expect(normalizeInternalOrderInput(storage, identity, input)).rejects.toThrow('实际对应业务组');
    }
  });
  it('external creation never emits invented historical internal columns', async () => {
    expect(await normalizeInternalOrderInput({}, actor, { customer: '客户', type: 'Fabric' }))
      .toEqual({ orderPurpose: 'external', internalPurpose: null, internalDemandTeamId: null, internalReceiverId: null });
  });
  it('keeps untouched legacy unknown purpose unknown', async () => {
    expect(await normalizeInternalOrderInput({}, actor, { contactPhone: '123' }, { orderPurpose: null })).toEqual({});
  });
  it('uses actual organizational identities without an external customer or PO', async () => {
    const result = await normalizeInternalOrderInput(db(), actor, { type: 'Fabric', orderPurpose: 'internal_fabric_supply', internalPurpose: ' PP 与正式成衣供料 ', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' });
    expect(result).toEqual({ orderPurpose: 'internal_fabric_supply', internalPurpose: 'PP 与正式成衣供料', internalDemandTeamId: 'demand', internalReceiverId: 'receiver', customer: '实际成衣组', customerRelationId: null, poNumber: null });
  });
  it('requires actual creator domain and a current receiver member', async () => {
    const denied = db(); denied.teamMember.findMany.mockResolvedValue([]);
    const input = { type: 'Fabric', orderPurpose: 'internal_fabric_supply', internalPurpose: '供料', internalDemandTeamId: 'demand', internalReceiverId: 'receiver' };
    await expect(normalizeInternalOrderInput(denied, actor, input)).rejects.toThrow('实际对应业务组');
    const stale = db(); stale.teamMember.findFirst.mockResolvedValue(null as never);
    await expect(normalizeInternalOrderInput(stale, actor, input)).rejects.toThrow('已失效');
    await expect(normalizeInternalOrderInput(db(), actor, { ...input, poNumber: 'fake-external' })).rejects.toThrow('外部 PO');
  });
});
