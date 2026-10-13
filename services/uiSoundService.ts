export type UiSoundPreferences = { scroll: boolean; notifications: boolean; volume: number };
const KEY = 'bambook.ui-sound.v1';
const defaults: UiSoundPreferences = { scroll: true, notifications: true, volume: 0.4 };
let preferences: UiSoundPreferences | undefined;
const listeners = new Set<() => void>();
export function getUiSoundPreferences(): UiSoundPreferences {
  if (!preferences) {
    preferences = { ...defaults };
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (stored) preferences = {
        scroll: typeof stored.scroll === 'boolean' ? stored.scroll : defaults.scroll,
        notifications: typeof stored.notifications === 'boolean' ? stored.notifications : defaults.notifications,
        volume: typeof stored.volume === 'number' && Number.isFinite(stored.volume) ? Math.max(0, Math.min(1, stored.volume)) : defaults.volume,
      };
    } catch { /* Storage is optional. */ }
  }
  return preferences;
}
export function setUiSoundPreferences(patch: Partial<UiSoundPreferences>) {
  preferences = { ...getUiSoundPreferences(), ...patch };
  preferences.volume = Number.isFinite(preferences.volume) ? Math.max(0, Math.min(1, preferences.volume)) : defaults.volume;
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* In-memory preference still applies. */ }
  if (!preferences.scroll || !preferences.volume) releaseScrollVoice();
  listeners.forEach(listener => listener());
}
export function subscribeUiSoundPreferences(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
let context: AudioContext | undefined;
let noise: AudioBuffer | undefined;
let users = 0;
let resuming: Promise<void> | undefined;
let pendingScroll: { speed:number; time:number } | undefined;
function unlock(create = true) {
  if (!getUiSoundPreferences().volume || document.hidden) return;
  try {
    const Constructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor || (!create && !context)) return;
    if (!context || context.state === 'closed') {
      if (!create) return;
      context = new Constructor();
      noise = undefined;
    }
    const ctx = context;
    if (ctx.state !== 'running' && !resuming) {
      resuming = ctx.resume().then(() => {
        const pending = pendingScroll;
        pendingScroll = undefined;
        if (context === ctx && ctx.state === 'running' && pending && performance.now() - pending.time < 200) playScrollTick(pending.speed);
      }).catch(() => { pendingScroll = undefined; }).finally(() => { resuming = undefined; });
    }
  } catch { /* Unsupported audio must never interrupt business operations. */ }
}
const activate = () => unlock();
const recover = () => unlock(false);
const visibility = () => { if (document.hidden) { pendingScroll = undefined; releaseScrollVoice(); } else recover(); };
export function installUiSoundActivation() {
  if (++users === 1) {
    // Capture before page controls consume the gesture; wheel only resumes a context
    // already created by a legitimate click/key gesture.
    window.addEventListener('pointerdown', activate, { passive:true, capture:true });
    window.addEventListener('pointerup', activate, { passive:true, capture:true });
    window.addEventListener('click', activate, { passive:true, capture:true });
    window.addEventListener('keydown', activate, true);
    window.addEventListener('wheel', recover, { passive:true, capture:true });
    window.addEventListener('focus', recover);
    window.addEventListener('pageshow', recover);
    document.addEventListener('visibilitychange', visibility);
  }
  return () => {
    if (--users === 0) {
      window.removeEventListener('pointerdown', activate, true);
      window.removeEventListener('pointerup', activate, true);
      window.removeEventListener('click', activate, true);
      window.removeEventListener('keydown', activate, true);
      window.removeEventListener('wheel', recover, true);
      window.removeEventListener('focus', recover);
      window.removeEventListener('pageshow', recover);
      document.removeEventListener('visibilitychange', visibility);
      releaseScrollVoice(true);
      pendingScroll = undefined;
      void context?.close().catch(() => {});
      context = undefined;
      noise = undefined;
      resuming = undefined;
    }
  };
}
function tone(ctx: AudioContext, frequency: number, at: number, duration: number, amplitude: number, destination: AudioNode = ctx.destination, endFrequency?: number) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, at);
  if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(amplitude, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.00001, at + duration);
  osc.connect(gain).connect(destination);
  osc.start(at); osc.stop(at + duration + 0.01);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
type ScrollVoice = {
  ctx: AudioContext; source: AudioBufferSourceNode; oscillators: OscillatorNode[];
  nodes: AudioNode[]; master: GainNode; texture: GainNode; low: GainNode; high: GainNode;
  idle?: ReturnType<typeof setTimeout>; release?: ReturnType<typeof setTimeout>;
};
let scrollVoice: ScrollVoice | undefined;
function hold(param: AudioParam, at: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(at);
  else { param.cancelScheduledValues(at); param.setValueAtTime(param.value, at); }
}
function disposeVoice(voice: ScrollVoice) {
  clearTimeout(voice.idle); clearTimeout(voice.release);
  voice.source.stop(); voice.oscillators.forEach(node => node.stop());
  voice.nodes.forEach(node => node.disconnect());
  if (scrollVoice === voice) scrollVoice = undefined;
}
function releaseScrollVoice(immediate = false) {
  const voice = scrollVoice;
  if (!voice) return;
  clearTimeout(voice.idle); clearTimeout(voice.release);
  if (immediate || voice.ctx.state === 'closed') { disposeVoice(voice); return; }
  const at = voice.ctx.currentTime;
  hold(voice.master.gain, at);
  voice.master.gain.linearRampToValueAtTime(0, at + .08);
  // Leave room for the two dark reflections after the zero-gain endpoint.
  voice.release = setTimeout(() => disposeVoice(voice), 160);
}
function createScrollVoice(ctx: AudioContext): ScrollVoice {
  if (!noise) {
    noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * .25), ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter();
  const texture = ctx.createGain(), low = ctx.createGain(), high = ctx.createGain(), master = ctx.createGain();
  source.buffer = noise; source.loop = true;
  filter.type = 'bandpass'; filter.frequency.value = 850; filter.Q.value = .7;
  texture.gain.value = 0; low.gain.value = 0; high.gain.value = 0; master.gain.value = 0;
  source.connect(filter).connect(texture).connect(master);
  const oscillators = [ctx.createOscillator(), ctx.createOscillator()];
  oscillators.forEach((osc,index) => {
    osc.type = 'sine'; osc.frequency.value = index ? 680 : 390;
    osc.connect(index ? high : low).connect(master);
  });
  master.connect(ctx.destination);
  const reflections = [.013,.027].flatMap((delayTime,index) => {
    const delay = ctx.createDelay(.1), damp = ctx.createBiquadFilter(), wet = ctx.createGain();
    delay.delayTime.value = delayTime; damp.type = 'lowpass'; damp.frequency.value = 1100;
    wet.gain.value = index ? .07 : .18;
    master.connect(delay).connect(damp).connect(wet).connect(ctx.destination);
    return [delay,damp,wet];
  });
  const voice = {ctx,source,oscillators,master,texture,low,high,nodes:[source,filter,texture,low,high,master,...oscillators,...reflections]};
  source.start(); oscillators.forEach(osc => osc.start());
  return voice;
}
function sustainScrollVoice(speed: number) {
  const voice = scrollVoice, prefs = getUiSoundPreferences();
  if (!voice || !prefs.scroll || !prefs.volume || document.hidden || voice.ctx.state !== 'running') return;
  clearTimeout(voice.idle); clearTimeout(voice.release);
  const at = voice.ctx.currentTime;
  const strength = prefs.volume * (.025 + Math.min(2,Math.max(0,speed)) * .006);
  hold(voice.master.gain, at);
  voice.master.gain.setTargetAtTime(strength, at, .012);
  voice.idle = setTimeout(() => releaseScrollVoice(), 180);
}
export function playScrollTick(speed = .5) {
  const prefs = getUiSoundPreferences();
  if (!prefs.scroll || !prefs.volume || document.hidden || !context) return;
  if (context.state !== 'running') {
    pendingScroll = {speed,time:performance.now()}; unlock(false); return;
  }
  const ctx = context, at = ctx.currentTime;
  const voice = scrollVoice ??= createScrollVoice(ctx);
  sustainScrollVoice(speed);
  // A quiet moving body bridges teeth; accent envelopes never reset to zero.
  for (const [gain,peak,body] of [[voice.texture,.12,.02],[voice.low,.70,.06],[voice.high,.07,.006]] as const) {
    hold(gain.gain, at);
    gain.gain.linearRampToValueAtTime(peak, at + .006);
    gain.gain.setTargetAtTime(body, at + .006, .018);
  }
  const variation = .985 + Math.random() * .03;
  voice.oscillators[0].frequency.setTargetAtTime(390 * variation, at, .014);
  voice.oscillators[1].frequency.setTargetAtTime(680 * variation, at, .014);
}
let lastNotification = -Infinity;
const heard = new Set<string>();
export function playNotificationSound(eventId?: string, preview = false) {
  const prefs = getUiSoundPreferences();
  if (!prefs.notifications || !prefs.volume) return;
  if (context?.state !== 'running') { unlock(false); return; }
  if (eventId) {
    if (heard.has(eventId)) return;
    heard.add(eventId);
    if (heard.size > 256) heard.delete(heard.values().next().value!);
  }
  const now = performance.now();
  if (!preview && now - lastNotification < 2500) return;
  lastNotification = now;
  const ctx = context, at = ctx.currentTime;
  tone(ctx, 784, at, 0.30, prefs.volume * 0.10);
  tone(ctx, 1176, at + 0.095, 0.40, prefs.volume * 0.065);
}
export async function previewUiSound(kind: 'scroll' | 'notifications') {
  unlock();
  try {
    if (context?.state === 'suspended') await context.resume();
    if (kind === 'scroll') playScrollTick(0.7);
    else playNotificationSound(undefined, true);
  } catch { /* Autoplay restrictions or unavailable device. */ }
}
/** One tooth per 32px of actual travel; never queue a burst after a large jump. */
export function createScrollSoundTracker(initialPosition: number, emit = playScrollTick) {
  let position = initialPosition, accumulated = 0, lastTime = 0, lastTick = -Infinity, direction = 0;
  return (next: number, now: number) => {
    const delta = next - position, elapsed = now - lastTime;
    position = next; lastTime = now;
    if (!delta) return;
    if (emit === playScrollTick) sustainScrollVoice(Math.abs(delta) / Math.max(8, elapsed));
    if (elapsed > 180 || Math.sign(delta) !== direction) accumulated = 0;
    direction = Math.sign(delta);
    accumulated += Math.abs(delta);
    if (accumulated < 32 || now - lastTick < 36) return;
    accumulated %= 32; lastTick = now;
    emit(Math.abs(delta) / Math.max(8, elapsed));
  };
}
