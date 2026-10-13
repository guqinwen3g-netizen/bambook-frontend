import { describe, expect, it, vi } from 'vitest';
import { addExistingTeamMember, listTeamMemberCandidates } from '../teamMembershipService';
function fixture() {
  const user = { id: 'user', displayName: 'User', email: 'user@example.com', status: 'active', deletedAt: null, primaryDeptId: 'dept', passwordHash: 'hashed', metadata: {} };
  const team = { id: 'team', departmentId: 'dept', status: 'active', deletedAt: null, department: { parentId: 'company', status: 'active' } };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([]), team: { findUnique: vi.fn().mockResolvedValue(team) }, userAccount: { findUnique: vi.fn().mockResolvedValue(user), findMany: vi.fn().mockResolvedValue([user]) }, teamMember: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockImplementation(async ({ create }) => create) } };
  const db = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
  return { user, team, tx, db };
}
describe('existing account membership', () => {
  it('adds existing active identity without creating account or granting a role', async () => {
    const { db, tx } = fixture(); const audit = vi.fn();
    const member = await addExistingTeamMember(db, 'team', 'user', audit);
    expect(member).toMatchObject({ teamId: 'team', userId: 'user', role: 'member' });
    expect(tx.$queryRaw).toHaveBeenCalled(); expect(audit).toHaveBeenCalledOnce();
  });
  it.each([{ status: 'pending' }, { status: 'disabled' }, { passwordHash: '' }, { metadata: { personnelOnly: true } }, { deletedAt: 1n }])('rejects non-login/inactive identity %#', async invalid => {
    const { db, user, tx } = fixture(); Object.assign(user, invalid);
    await expect(addExistingTeamMember(db, 'team', 'user')).rejects.toThrow('登录账号'); expect(tx.teamMember.upsert).not.toHaveBeenCalled();
  });
  it('rejects a different employment department', async () => {
    const { db, user } = fixture(); user.primaryDeptId = 'other';
    await expect(addExistingTeamMember(db, 'team', 'user')).rejects.toThrow('所属部门');
  });
  it('rejects another active group, preserving old membership', async () => {
    const { db, tx } = fixture(); tx.teamMember.findMany.mockResolvedValue([{ teamId: 'other' }] as any);
    await expect(addExistingTeamMember(db, 'team', 'user')).rejects.toThrow('已分配小组'); expect(tx.teamMember.upsert).not.toHaveBeenCalled();
  });
  it('is idempotent for same group', async () => {
    const { db, tx } = fixture(); tx.teamMember.findMany.mockResolvedValue([{ id: 'old', teamId: 'team' }] as any);
    expect(await addExistingTeamMember(db, 'team', 'user')).toMatchObject({ id: 'old' }); expect(tx.teamMember.upsert).not.toHaveBeenCalled();
  });
  it('reactivates a departed membership using unique pair', async () => {
    const { db, tx } = fixture(); await addExistingTeamMember(db, 'team', 'user');
    expect(tx.teamMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId_userId: { teamId: 'team', userId: 'user' } }, update: expect.objectContaining({ leftAt: null }) }));
  });
  it('candidates exclude assigned users and never expose password hashes', async () => {
    const { db, user, tx } = fixture();
    const result = await listTeamMemberCandidates(db, 'team'); expect(result).toEqual([{ id: 'user', displayName: 'User', email: user.email }]);
    tx.teamMember.findMany.mockResolvedValue([{ userId: 'user' }] as any);
    expect(await listTeamMemberCandidates(db, 'team')).toEqual([]);
  });
});
