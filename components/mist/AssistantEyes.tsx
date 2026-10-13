/* Adapted from Bencho Watcher, https://bencho.dev/blocks/eye-tracker.
 * Copyright (c) 2026 Lorenzo Cabra
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * Adaptation: compact SVG, shared spherical turn, deterministic video clock,
 * pointer tracking without React frame updates, no Bencho CSS dependency.
 */
import React from 'react';
import type { LucideProps } from 'lucide-react';

type Gaze = { x: number; y: number };
type Motion = { frame: number; fps: number; gaze?: Gaze; cursorSelector?: string };
const MotionContext = React.createContext<Motion | null>(null);
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/** Optional deterministic clock. interactive enables pointer tracking in preview only. */
export function AssistantEyesMotionProvider({ frame, fps = 30, gaze, cursorSelector, interactive = false, children }: {
  frame: number; fps?: number; gaze?: Gaze; cursorSelector?: string; interactive?: boolean; children: React.ReactNode;
}) {
  const value = React.useMemo(() => interactive ? null : ({ frame, fps, gaze, cursorSelector }), [frame, fps, gaze, cursorSelector, interactive]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

function pose(x: number, y: number, lid: number, side: number) {
  x *= 0.8;
  y *= 0.8;
  const yaw = Math.asin(clamp(x, -0.55, 0.55));
  const pitch = -Math.asin(clamp(y, -0.36, 0.36));
  const x0 = side * 0.375, z0 = Math.sqrt(1 - x0 * x0);
  const x1 = x0 * Math.cos(yaw) + z0 * Math.sin(yaw);
  const z1 = -x0 * Math.sin(yaw) + z0 * Math.cos(yaw);
  const depth = clamp(z1 * Math.cos(pitch), 0, 1);
  const k = 0.45 + 0.55 * depth;
  const w = 3.3 * k * (0.85 + 0.15 * depth);
  const h = Math.max(0.55, 5.8 * k * lid);
  return {
    x: -w / 2, y: -h / 2, width: w, height: h, rx: Math.min(w, h) / 2,
    transform: `translate(${12 + x1 * 8} ${12.6 - z1 * Math.sin(pitch) * 6}) rotate(${8 * x * y})`,
  };
}

function bodyPose(x: number, y: number, lid: number, idleSeconds?: number) {
  const sway = idleSeconds === undefined ? 0 : Math.sin(idleSeconds * Math.PI * 2 / 4.8) * 2.1;
  const bob = idleSeconds === undefined ? 0 : Math.sin(idleSeconds * Math.PI * 2 / 3.8) * 0.32;
  return `translate(12 ${12 + bob}) rotate(${x * 3.2 + sway}) scale(${1 + (1 - lid) * 0.008} ${1 - (1 - lid) * 0.018}) translate(-12 -12)`;
}

function clockPose(motion: Motion) {
  const seconds = Math.max(0, motion.frame) / (motion.fps > 0 ? motion.fps : 30);
  const gaze = motion.gaze ?? { x: Math.sin(seconds * 0.72) * 0.22, y: Math.sin(seconds * 0.43) * 0.10 };
  const phase = seconds % 4.6;
  const lid = phase >= 3.8 && phase < 3.96 ? 1 - 0.92 * Math.sin((phase - 3.8) / 0.16 * Math.PI) : 1;
  return { x: clamp(gaze.x, -1, 1) * 0.55, y: clamp(gaze.y, -1, 1) * 0.36, lid };
}

/** 小竹: a round jelly bot with shared body and gentle rounded eye motion. */
export const AssistantEyes = React.forwardRef<SVGSVGElement, LucideProps>(function AssistantEyes(
  { size = 24, color = 'currentColor', strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, children, ...props }, ref,
) {
  const motion = React.useContext(MotionContext);
  const svg = React.useRef<SVGSVGElement | null>(null);
  const body = React.useRef<SVGGElement | null>(null);
  const left = React.useRef<SVGGElement | null>(null);
  const right = React.useRef<SVGGElement | null>(null);
  const gradientId = `xiaozhu-${React.useId().replace(/:/g, '')}`;
  const initial = motion ? clockPose(motion) : { x: 0, y: 0, lid: 1 };
  React.useLayoutEffect(() => {
    if (!motion?.cursorSelector || !svg.current) return;
    const paintDemoCursor = () => {
      const element = svg.current;
      if (!element) return;
      const host = element.closest('.vid-mist') ?? element.ownerDocument;
      const cursor = host.querySelector<HTMLElement>(motion.cursorSelector!);
      const state = clockPose(motion);
      let x = state.x, y = state.y;
      if (cursor) {
        const point = cursor.getBoundingClientRect();
        const own = element.getBoundingClientRect();
        const canvas = element.closest<HTMLElement>('.vid-mist');
        const scale = canvas ? canvas.getBoundingClientRect().width / (canvas.offsetWidth || 1440) : 1;
        x = Math.tanh((point.left - own.left - own.width / 2) / (240 * Math.max(0.01, scale))) * 0.5;
        y = Math.tanh((point.top - own.top - own.height / 2) / (240 * Math.max(0.01, scale))) * 0.3;
      }
      body.current?.setAttribute('transform', bodyPose(x, y, state.lid, cursor ? undefined : Math.max(0, motion.frame) / motion.fps));
      [left.current, right.current].forEach((group, i) => {
        if (!group) return;
        const { transform, ...geometry } = pose(x, y, state.lid, i ? 1 : -1);
        group.setAttribute('transform', transform);
        if (group.firstElementChild) Object.entries(geometry).forEach(([key, value]) => group.firstElementChild!.setAttribute(key, String(value)));
      });
    };
    paintDemoCursor();
    // Cursor publishes after its own layout/selector positions have settled.
    window.addEventListener('bambook:demo-cursor', paintDemoCursor);
    return () => window.removeEventListener('bambook:demo-cursor', paintDemoCursor);
  }, [motion]);
  React.useEffect(() => {
    if (motion || !svg.current) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, timer = 0, blinkStart = 0, previous = 0;
    const current = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    const paint = (lid = 1) => {
      body.current?.setAttribute('transform', bodyPose(current.x, current.y, lid));
      [left.current, right.current].forEach((group, i) => {
        if (!group) return;
        const geometry = pose(current.x, current.y, lid, i ? 1 : -1);
        const { transform, ...rect } = geometry;
        group.setAttribute('transform', transform);
        const eye = group.firstElementChild;
        if (eye) Object.entries(rect).forEach(([key, value]) => eye.setAttribute(key, String(value)));
      });
    };
    const tick = (now: number) => {
      raf = 0;
      const factor = 1 - Math.exp(-Math.min(64, previous ? now - previous : 16) / 85);
      previous = now;
      current.x += (target.x - current.x) * factor;
      current.y += (target.y - current.y) * factor;
      const progress = blinkStart ? (now - blinkStart) / 160 : 1;
      paint(progress < 1 ? 1 - 0.92 * Math.sin(Math.max(0, progress) * Math.PI) : 1);
      if (progress >= 1) blinkStart = 0;
      if (blinkStart || Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > 0.001) raf = requestAnimationFrame(tick);
      else previous = 0;
    };
    const wake = () => { if (!raf && !preference.matches) raf = requestAnimationFrame(tick); };
    const aim = (event: PointerEvent) => {
      if (preference.matches || !svg.current) return;
      const box = svg.current.getBoundingClientRect();
      target.x = Math.tanh((event.clientX - box.left - box.width / 2) / 240) * 0.50;
      target.y = Math.tanh((event.clientY - box.top - box.height / 2) / 240) * 0.30;
      wake();
    };
    const rest = () => { target.x = 0; target.y = 0; wake(); };
    const blink = () => {
      if (!preference.matches) { blinkStart = performance.now(); wake(); }
      timer = window.setTimeout(blink, 4600);
    };
    const preferenceChanged = () => {
      if (preference.matches) {
        cancelAnimationFrame(raf); raf = 0; blinkStart = 0; previous = 0;
        current.x = current.y = target.x = target.y = 0; paint();
      }
    };
    window.addEventListener('pointermove', aim, { passive: true });
    document.documentElement.addEventListener('pointerleave', rest);
    preference.addEventListener('change', preferenceChanged);
    timer = window.setTimeout(blink, 3800);
    return () => {
      cancelAnimationFrame(raf); window.clearTimeout(timer);
      window.removeEventListener('pointermove', aim);
      document.documentElement.removeEventListener('pointerleave', rest);
      preference.removeEventListener('change', preferenceChanged);
    };
  }, [Boolean(motion)]);
  return <svg ref={node => { svg.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; }}
    width={size} height={size} viewBox="0 0 24 24" fill="none" color={color} {...props} data-assistant-eyes="true" data-xiaozhu-mode={motion ? 'timeline' : 'pointer'}>
    <defs>
      <linearGradient id={gradientId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="var(--mist-ai-refract-ice, var(--mist-ai))" stopOpacity="0.34" />
        <stop offset="0.25" stopColor="var(--mist-on-media)" stopOpacity="0.12" />
        <stop offset="0.46" stopColor="var(--mist-ai-pearl, var(--mist-on-media))" stopOpacity="0.16" />
        <stop offset="0.67" stopColor="var(--mist-ai-refract-coral, var(--mist-ai-blush))" stopOpacity="0.30" />
        <stop offset="0.84" stopColor="var(--mist-ai-lilac, var(--mist-brand-wisteria))" stopOpacity="0.18" />
        <stop offset="1" stopColor="var(--mist-ai-refract-ice, var(--mist-ai))" stopOpacity="0.40" />
      </linearGradient>
      <linearGradient id={`${gradientId}-rim`} x1="4" y1="2" x2="19" y2="23" gradientUnits="userSpaceOnUse">
        <stop stopColor="var(--mist-on-media)" stopOpacity="0.86" />
        <stop offset="0.32" stopColor="var(--mist-ai-refract-ice, var(--mist-ai))" stopOpacity="0.40" />
        <stop offset="0.66" stopColor="var(--mist-ai-refract-coral, var(--mist-ai-blush))" stopOpacity="0.40" />
        <stop offset="1" stopColor="var(--mist-ai-refract-coral, var(--mist-ai-blush))" stopOpacity="0.44" />
      </linearGradient>
    </defs>
    <g ref={body} transform={bodyPose(initial.x, initial.y, initial.lid)}>
    <path d="M12 1C18.075 1 23 5.925 23 12S18.075 23 12 23 1 18.075 1 12 5.925 1 12 1Z" fill={`url(#${gradientId})`} stroke={`url(#${gradientId}-rim)`} strokeWidth="0.65" />
    <path d="M4.3 8.1C5.1 5.45 7.2 3.7 9.7 3.3" stroke="var(--mist-on-media)" strokeOpacity="0.72" strokeWidth="0.8" strokeLinecap="round" />
    <path d="M17.6 20C20 18.7 21.1 16.9 21.3 14.9" stroke="var(--mist-ai-refract-ice, var(--mist-ai))" strokeOpacity="0.4" strokeWidth="0.5" strokeLinecap="round" />
    {[-1, 1].map((side, index) => {
      const { transform, ...geometry } = pose(initial.x, initial.y, initial.lid, side);
      return <g key={side} ref={index ? right : left} transform={transform}>
        <rect {...geometry} fill="var(--mist-on-media)" fillOpacity="0.96" stroke="var(--mist-ai-ink, currentColor)" strokeOpacity="0.16" strokeWidth="0.32" />
      </g>;
    })}
    </g>
    {children}
  </svg>;
});
