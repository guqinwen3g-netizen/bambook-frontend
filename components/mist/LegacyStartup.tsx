import React from 'react';
import AuthBrandEntrance, { type AuthEntrancePhase } from '../ui/AuthBrandEntrance';
import '../../styles/bds/startup.css';

/** Preserve the pre-Mist startup animation; session readiness only gates playback. */
export function LegacyStartup({ ready }: { ready: boolean }) {
  const [, setPhase] = React.useState<AuthEntrancePhase>('opening');
  React.useLayoutEffect(() => { document.getElementById('mist-boot-surface')?.remove(); }, []);
  return <AuthBrandEntrance ready={ready} dock={false} onPhase={setPhase} />;
}
