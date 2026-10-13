/** Only a reload of an existing authenticated page restores its navigation snapshot. */
export function shouldRestoreNavigationSession(navigationType: string | undefined, hasSavedSession: boolean): boolean {
  return navigationType === 'reload' && hasSavedSession;
}
