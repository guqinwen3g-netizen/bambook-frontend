import { describe, expect, it } from 'vitest';
import { serializeAuthUser } from '../tokenHelpers';

const user = (metadata: unknown) => ({ id: 'u1', displayName: 'A', email: 'a@x.test', roles: [], primaryDeptId: 'd1', primaryDepartment: { name: '部' }, metadata });
describe('serializeAuthUser · mustChangePassword', () => {
  it('flags accounts whose password was reset by an administrator', () => {
    expect(serializeAuthUser(user({ forceChangePassword: true }), [], [], []).mustChangePassword).toBe(true);
  });
  it('omits the flag once the user changed the password or was never reset', () => {
    expect('mustChangePassword' in serializeAuthUser(user({ forceChangePassword: false }), [], [], [])).toBe(false);
    expect('mustChangePassword' in serializeAuthUser(user(null), [], [], [])).toBe(false);
  });
});
