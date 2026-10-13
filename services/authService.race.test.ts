// @vitest-environment jsdom
// Actual auth service, controlled HTTP timing. No backend account/auth/PG proof.
import { beforeEach, expect, it, vi } from 'vitest';
const user = (id: string) => ({ id, displayName: id, email: id + '@example.test', roles: ['viewer'] as const, permissions: ['orders:read'], departmentIds: [], department: null });
const response = (id: string, token?: string) => ({ ok: true, status: 200, text: async () => JSON.stringify({ user: user(id), token }) }) as Response;
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
for (const outcome of ['success', '401', 'fault', 'parse-late'] as const) it(`old /me ${outcome} cannot overwrite a later successful login`, async () => {
  const old = deferred<Response>(); const parse = deferred<string>();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/login') ? Promise.resolve(response('new', 'new-credential')) : old.promise));
  const auth = await import('./authService'); const refresh = auth.checkAuth();
  if (outcome === 'parse-late') { old.resolve({ ok: true, status: 200, text: () => parse.promise } as Response); await Promise.resolve(); await Promise.resolve(); }
  await auth.login('new', 'credential');
  if (outcome === 'success') old.resolve(response('old'));
  if (outcome === '401') old.resolve({ ok: false, status: 401 } as Response);
  if (outcome === 'fault') old.reject(new Error('network failed'));
  if (outcome === 'parse-late') parse.resolve(JSON.stringify({ user: user('old') }));
  await refresh;
  expect(auth.getAuthState()).toMatchObject({ isAuthenticated: true, user: { id: 'new' }, isLoading: false });
  expect(localStorage.getItem('bambook_auth_token')).toBe('new-credential');
  expect(JSON.parse(localStorage.getItem('bambook_auth_user')!).id).toBe('new');
});
it('logout clears state immediately, and its late acknowledgement cannot clear a newer login', async () => {
  const ack = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/logout') ? ack.promise : Promise.resolve(response('new', 'new-credential'))));
  const auth = await import('./authService'); await auth.devLoginAs('old-credential', user('old') as any);
  const loggingOut = auth.logout();
  expect(auth.getAuthState().user).toBeNull(); expect(localStorage.getItem('bambook_auth_token')).toBeNull();
  await auth.login('new', 'credential'); ack.resolve({ ok: true } as Response); await loggingOut;
  expect(auth.getAuthState().user?.id).toBe('new'); expect(localStorage.getItem('bambook_auth_token')).toBe('new-credential');
});
it('a login success arriving after logout is rejected rather than resurrecting a session', async () => {
  const login = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/login') ? login.promise : Promise.resolve({ ok: true } as Response)));
  const auth = await import('./authService'); const pending = auth.login('old', 'credential');
  const rejection = expect(pending).rejects.toThrow('替代'); await auth.logout(); login.resolve(response('old', 'old-credential'));
  await rejection; expect(auth.getAuthState().user).toBeNull(); expect(localStorage.getItem('bambook_auth_token')).toBeNull();
});
it('concurrent logins commit only the newest operation', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const auth = await import('./authService'); const old = auth.login('old', 'credential'); const current = auth.login('new', 'credential');
  const rejected = expect(old).rejects.toThrow('替代'); second.resolve(response('new', 'new-credential')); await current;
  first.resolve(response('old', 'old-credential')); await rejected;
  expect(auth.getAuthState().user?.id).toBe('new'); expect(sessionStorage.getItem('bambook_auth_token')).toBe('new-credential');
});
it('an old refresh cannot restore a logged-out session, including dev role switching', async () => {
  const old = deferred<Response>(); vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/auth/logout') ? Promise.resolve({ ok: true } as Response) : old.promise));
  const auth = await import('./authService'); const refresh = auth.checkAuth(); await auth.logout(); old.resolve(response('old')); await refresh;
  expect(auth.getAuthState().user).toBeNull();
  const late = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => late.promise)); const refresh2 = auth.checkAuth();
  await auth.devLoginAs('qc-credential', user('qc') as any); late.resolve(response('old')); await refresh2;
  expect(auth.getAuthState().user?.id).toBe('qc');
});
it('older refresh cannot restore revoked permissions after the newer refresh', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const auth = await import('./authService'); const old = auth.checkAuth(); const newest = auth.checkAuth();
  second.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ user: { ...user('same'), permissions: [] } }) } as Response); await newest;
  first.resolve(response('same')); await old; expect(auth.getAuthState().user?.permissions).toEqual([]);
});
it('an old profile update cannot reinstall the previous user after role switching', async () => {
  const old = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => old.promise));
  const auth = await import('./authService'); await auth.devLoginAs('owner-credential', user('owner') as any);
  const pending = auth.updateMyProfile({ displayName: 'Changed Owner' }); const rejected = expect(pending).rejects.toThrow('先前');
  await auth.devLoginAs('qc-credential', user('qc') as any); old.resolve(response('owner')); await rejected;
  expect(auth.getAuthState().user?.id).toBe('qc'); expect(JSON.parse(localStorage.getItem('bambook_auth_user')!).id).toBe('qc');
});
it('a late profile response cannot restore permissions revoked by a newer same-account refresh', async () => {
  const old = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => options?.method === 'PATCH' ? old.promise
    : Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ user: { ...user('same'), permissions: [] } }) } as Response)));
  const auth = await import('./authService'); await auth.devLoginAs('same-credential', user('same') as any);
  const pending = auth.updateMyProfile({ displayName: 'Changed Name' }); const rejected = expect(pending).rejects.toThrow('先前');
  await auth.checkAuth(); expect(auth.getAuthState().user?.permissions).toEqual([]);
  old.resolve(response('same')); await rejected;
  expect(auth.getAuthState().user?.permissions).toEqual([]);
  expect(JSON.parse(localStorage.getItem('bambook_auth_user')!).permissions).toEqual([]);
});
