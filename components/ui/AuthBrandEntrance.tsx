import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { BambookBrandMark } from '../brand/BambookBrandMark';

export type AuthEntrancePhase = 'opening' | 'handoff' | 'done';
export const prefersQuietEntrance = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One drawing at the center; fill it before handing identity to the header. */
export default function AuthBrandEntrance({ onPhase, ready = true, dock = true }: {
  onPhase: (phase: AuthEntrancePhase) => void; ready?: boolean; dock?: boolean;
}) {
  const startedAt = useRef<number | null>(null);
  const [phase, setPhase] = useState<AuthEntrancePhase>(() => prefersQuietEntrance() ? 'done' : 'opening');
  const [quietMode] = useState(prefersQuietEntrance);
  const [playbackReady, setPlaybackReady] = useState(false);
  useLayoutEffect(() => {
    if (!ready || quietMode) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPlaybackReady(true));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [ready, quietMode]);
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      setPhase('done'); onPhase('done');
    };
    if (media.matches) { end(); return; }
    onPhase('opening');
    if (!playbackReady) return;
    if (startedAt.current === null) startedAt.current = performance.now();
    const remaining = Math.max(0, 1650 - (performance.now() - startedAt.current));
    const handoff = window.setTimeout(() => {
      if (ended) return;
      setPhase('handoff'); onPhase('handoff');
    }, remaining);
    const done = window.setTimeout(end, remaining + 2200);
    const hidden = () => { if (document.hidden) end(); };
    const quiet = () => { if (media.matches) end(); };
    window.addEventListener('resize', end);
    document.addEventListener('visibilitychange', hidden);
    media.addEventListener('change', quiet);
    return () => { ended = true; clearTimeout(handoff); clearTimeout(done); window.removeEventListener('resize', end); document.removeEventListener('visibilitychange', hidden); media.removeEventListener('change', quiet); };
  }, [onPhase, playbackReady]);
  return createPortal(<div className="bds-auth-entrance-anchor" role={phase !== 'done' ? 'status' : undefined} aria-label={phase !== 'done' ? '正在启动 Bambook' : undefined}>
    {phase !== 'done' && <div className="bds-auth-entrance" data-phase={phase}>
      <motion.div className="bds-auth-entrance__curtain" initial={{ opacity: 1 }} animate={{ opacity: phase === 'handoff' ? 0 : 1 }} transition={{ delay: phase === 'handoff' ? 1.25 : 0, duration: .9 }} />
      {!quietMode && <motion.div className="bds-auth-entrance__mark" data-destination={dock ? 'login' : 'workspace'}
        initial={{ opacity: 1 }} animate={{ opacity: phase === 'handoff' ? 0 : 1 }} transition={{ delay: 1.4, duration: .75 }}>
        <motion.div className="bds-auth-entrance__breath" initial={{ scale: .74 }} animate={{ scale: !playbackReady ? .74 : phase === 'handoff' ? Math.hypot(window.innerWidth, window.innerHeight) / 140 : 1 }} transition={phase === 'handoff' ? { delay: 1.2, duration: .95, ease: [.65, 0, .35, 1] } : { type: 'spring', stiffness: 65, damping: 12, mass: 1.2 }}>
        <div className="bds-auth-entrance__line">
          <BambookBrandMark size={220} form="strands" motion="construct" state="starting" paused={!playbackReady} settleToSolid label="Bambook 六叶轻扣" />
        </div>
        </motion.div>
      </motion.div>}
    </div>}
  </div>, document.body);
}
