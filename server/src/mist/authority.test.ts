import { beforeEach, expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({ load: vi.fn(), build: vi.fn() }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: source.load, buildLoadedAuthTokenPayload: source.build }));
import { freshMistAuthority } from './authority';
import { testActor } from './__tests__/support';
beforeEach(() => { vi.clearAllMocks(); source.load.mockResolvedValue({ id: 'owner', status: 'active', deletedAt: null }); source.build.mockResolvedValue({ ...testActor(), authorizationLoaded: true }); });
it('loads current account grants rather than trusting the signed snapshot and retains its ceiling', async () => {
  const db = {}, token = { ...testActor(), permissions: ['*'], permissionCeiling: ['products:write'] };
  await expect(freshMistAuthority(db, token, 'finance:write')).rejects.toMatchObject({ status: 403 });
  const current = await freshMistAuthority(db, token, 'products:write'); expect(current.permissionCeiling).toEqual(['products:write']); expect(source.load).toHaveBeenCalledWith(db, 'owner');
});
it('rejects deleted or disabled accounts even when the credential had wildcard permissions', async () => {
  source.load.mockResolvedValue({ id: 'owner', status: 'disabled', deletedAt: null });
  await expect(freshMistAuthority({}, { ...testActor(), permissions: ['*'] })).rejects.toMatchObject({ status: 401 }); expect(source.build).not.toHaveBeenCalled();
});
