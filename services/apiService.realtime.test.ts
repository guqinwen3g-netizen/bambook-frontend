import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ stream: vi.fn((_options: any) => vi.fn()), subscribe: vi.fn(() => vi.fn()), auth: { isAuthenticated: true, user: { id: 'actor-a' } } }));
vi.mock('./authenticatedEventStream', () => ({ authenticatedEventStream: mocks.stream }));
vi.mock('./authService', () => ({ getAuthState: () => mocks.auth, subscribe: mocks.subscribe, hasPermission: () => true }));
import { apiService } from './apiService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>([['bambook_auth_token', 'session-token'], ['panda_system_config', JSON.stringify({ cloudEndpoint: 'https://example.test', apiKey: 'configured-key' })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null });
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  const target = new EventTarget();
  vi.stubGlobal('window', { location: { origin: 'https://ui.test' }, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) });
});
describe('api realtime subscription compatibility', () => {
  it('keeps callbacks/cleanup and data reconnect hook; ignores other and malformed events', () => {
    const change = vi.fn(), reconnect = vi.fn(); const stop = apiService.subscribeToDataChanges('https://example.test', change, reconnect);
    const options = mocks.stream.mock.calls[0][0];
    expect(options.snapshot().url).not.toContain('session-token');
    expect(options.snapshot().headers.Authorization).toBe('Bearer session-token');
    options.onOpen(); options.onOpen(); expect(reconnect).toHaveBeenCalledTimes(1);
    options.onEvent('notification', '{}'); options.onEvent('data-change', '{'); options.onEvent('data-change', '{"entity":"orders"}');
    expect(change).toHaveBeenCalledExactlyOnceWith({ entity: 'orders' }); stop(); expect(mocks.stream.mock.results[0].value).toHaveBeenCalledOnce();
  });
  it('notification retains recipient payload and observes same-tab configuration changes', () => {
    const notification = vi.fn(); apiService.subscribeToNotifications(undefined, notification);
    const options = mocks.stream.mock.calls[0][0]; const changed = vi.fn(), dispose = options.observe(changed);
    window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT)); expect(changed).toHaveBeenCalledOnce(); dispose();
    window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT)); expect(changed).toHaveBeenCalledOnce();
    const payload = { recipientIds: ['actor-a'], eventId: 'evt' }; options.onEvent('notification', JSON.stringify(payload)); expect(notification).toHaveBeenCalledExactlyOnceWith(payload);
  });
});
