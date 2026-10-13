import { describe, expect, it } from 'vitest';
import { shouldRestoreNavigationSession } from './navigationStartup';

describe('navigation startup policy', () => {
  it('restores only an authenticated page reload', () => {
    expect(shouldRestoreNavigationSession('reload', true)).toBe(true);
    for (const type of ['navigate', 'back_forward', undefined]) {
      expect(shouldRestoreNavigationSession(type, true)).toBe(false);
    }
    expect(shouldRestoreNavigationSession('reload', false)).toBe(false);
  });
});
