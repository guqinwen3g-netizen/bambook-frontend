// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createScrollSoundTracker, getUiSoundPreferences, setUiSoundPreferences, subscribeUiSoundPreferences, playNotificationSound } from './uiSoundService';
describe('scroll sound travel', () => {
  it('stays silent at rest and on sub-tooth motion, follows both directions', () => {
    const emit = vi.fn(), track = createScrollSoundTracker(0, emit);
    track(0, 0); track(12, 16); track(24, 32);
    expect(emit).not.toHaveBeenCalled();
    track(36, 48); expect(emit).toHaveBeenCalledTimes(1);
    track(4, 100); expect(emit).toHaveBeenCalledTimes(2);
    track(4, 120); expect(emit).toHaveBeenCalledTimes(2);
  });
  it('caps rapid and huge movements without queuing a sound burst', () => {
    const emit = vi.fn(), track = createScrollSoundTracker(0, emit);
    for (let i = 1; i <= 100; i++) track(i * 500, i * 4);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(12);
    const count = emit.mock.calls.length;
    track(50000, 900); expect(emit).toHaveBeenCalledTimes(count);
  });
  it('does not carry a partial tooth across a pause or reversal', () => {
    const emit = vi.fn(), track = createScrollSoundTracker(0, emit);
    track(20, 20); track(10, 40); track(0, 60);
    expect(emit).not.toHaveBeenCalled();
    track(-10, 400); expect(emit).not.toHaveBeenCalled();
  });
});
describe('device sound preferences', () => {
  it('persists independent toggles and clamped volume, notifies settings', () => {
    const listener = vi.fn(), unsubscribe = subscribeUiSoundPreferences(listener);
    setUiSoundPreferences({ scroll: false, notifications: true, volume: 8 });
    expect(getUiSoundPreferences()).toEqual({ scroll: false, notifications: true, volume: 1 });
    expect(JSON.parse(localStorage.getItem('bambook.ui-sound.v1')!)).toEqual(getUiSoundPreferences());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setUiSoundPreferences({ volume: 0.4, scroll: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('does not require an audio device or autoplay permission to receive a notification', () => {
    expect(() => playNotificationSound('event-1')).not.toThrow();
    expect(() => playNotificationSound('event-1')).not.toThrow();
  });
});

describe('synthesized audio', () => {
  it('unlocks on gesture, keeps a rolling voice and deduplicates notification chimes', async () => {
    vi.resetModules();
    const param = () => ({ value: 0, cancelScheduledValues:vi.fn(), cancelAndHoldAtTime:vi.fn(), setTargetAtTime:vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const nodes: any[] = [];
    const node = () => { const n: any = { connect: vi.fn(() => n), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), gain: param(), frequency: param(), Q: param() }; nodes.push(n); return n; };
    const fake: any = { state: 'running', currentTime: 1, sampleRate: 48000,
      createOscillator: vi.fn(node), createGain: vi.fn(node), createBufferSource: vi.fn(node), createBiquadFilter: vi.fn(node),
      createDelay: vi.fn(() => ({ ...node(), delayTime: param() })),
      createBuffer: vi.fn((_channels, length) => ({ getChannelData: () => new Float32Array(length) })),
      close: vi.fn(async () => {}), resume: vi.fn(async () => {}), destination: {} };
    const Constructor = vi.fn(function () { return fake; });
    vi.stubGlobal('AudioContext', Constructor);
    const sound = await import('./uiSoundService');
    sound.setUiSoundPreferences({ scroll: true, notifications: true, volume: 0.4 });
    const cleanup = sound.installUiSoundActivation();
    sound.playScrollTick(); expect(Constructor).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    sound.playScrollTick(1);
    expect(fake.createBufferSource).toHaveBeenCalledTimes(1);
    expect(nodes.filter(n => n.start.mock.calls.length).every(n => !n.stop.mock.calls.length)).toBe(true);
    expect(fake.createBufferSource.mock.results[0].value.loop).toBe(true);
    expect(fake.createDelay).toHaveBeenCalledTimes(2);
    const count = fake.createOscillator.mock.calls.length;
    sound.playNotificationSound('unique'); sound.playNotificationSound('unique'); sound.playNotificationSound('burst');
    expect(fake.createOscillator).toHaveBeenCalledTimes(count + 2);
    sound.setUiSoundPreferences({ scroll: false, notifications: false });
    sound.playScrollTick(); sound.playNotificationSound('muted', true);
    expect(fake.createBufferSource).toHaveBeenCalledTimes(1);
    expect(fake.createOscillator).toHaveBeenCalledTimes(count + 2);
    cleanup(); expect(fake.close).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

async function audioFixture() {
  vi.resetModules();
  const param = () => ({ value:0, setValueAtTime:vi.fn(), setTargetAtTime:vi.fn(), cancelScheduledValues:vi.fn(), cancelAndHoldAtTime:vi.fn(), linearRampToValueAtTime:vi.fn(), exponentialRampToValueAtTime:vi.fn() });
  const nodes:any[]=[];
  const node=()=>{const n:any={connect:vi.fn(()=>n),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),gain:param(),frequency:param(),Q:param(),delayTime:param()};nodes.push(n);return n;};
  const fake:any={state:'running',currentTime:1,sampleRate:48000,destination:{},
    createOscillator:vi.fn(node),createGain:vi.fn(node),createBufferSource:vi.fn(node),createBiquadFilter:vi.fn(node),createDelay:vi.fn(node),
    createBuffer:vi.fn((_c,length)=>({getChannelData:()=>new Float32Array(length)})),
    close:vi.fn(async()=>{}),resume:vi.fn(async()=>{fake.state='running';})};
  const Constructor=vi.fn(function(){return fake;});vi.stubGlobal('AudioContext',Constructor);
  const sound=await import('./uiSoundService');sound.setUiSoundPreferences({scroll:true,notifications:true,volume:.4});
  const cleanup=sound.installUiSoundActivation();
  return {sound,fake,Constructor,nodes,cleanup};
}

it('activates before a page consumes the gesture and recovers suspended scroll audio without opening notifications',async()=>{
  const f=await audioFixture();
  const target=document.createElement('button');document.body.append(target);
  target.addEventListener('pointerdown',e=>e.stopPropagation());
  try {
    target.dispatchEvent(new Event('pointerdown',{bubbles:true}));
    expect(f.Constructor).toHaveBeenCalledTimes(1);
    f.fake.state='suspended';
    f.sound.playScrollTick(1); await Promise.resolve(); await Promise.resolve();
    expect(f.fake.resume).toHaveBeenCalledTimes(1);
    expect(f.fake.createBufferSource).toHaveBeenCalledTimes(1);
  } finally {target.remove();f.cleanup();vi.unstubAllGlobals();}
});

it('keeps one rolling audio graph through a continuous gesture and releases it only after a soft stop',async()=>{
  vi.useFakeTimers();const f=await audioFixture();
  try {
    window.dispatchEvent(new Event('pointerdown'));
    for(let i=0;i<15;i++){f.fake.currentTime=1+i*.06;f.sound.playScrollTick(.8);await vi.advanceTimersByTimeAsync(60);}
    expect(f.fake.createBufferSource).toHaveBeenCalledTimes(1);
    expect(f.fake.createOscillator).toHaveBeenCalledTimes(2);
    expect(f.nodes.filter(n=>n.start.mock.calls.length).every(n=>!n.stop.mock.calls.length)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.nodes.filter(n=>n.start.mock.calls.length).every(n=>n.stop.mock.calls.length===1)).toBe(true);
  } finally {f.cleanup();vi.useRealTimers();vi.unstubAllGlobals();}
});

it('bridges slow continuous sub-tooth motion without restarting the voice',async()=>{
  vi.useFakeTimers();const f=await audioFixture();
  try {
    window.dispatchEvent(new Event('pointerdown'));f.sound.playScrollTick(.2);
    const track=f.sound.createScrollSoundTracker(0);
    for(let i=1;i<=20;i++){f.fake.currentTime=1+i*.05;track(i,i*50);await vi.advanceTimersByTimeAsync(50);}
    expect(f.fake.createBufferSource).toHaveBeenCalledTimes(1);
    expect(f.nodes.filter(n=>n.start.mock.calls.length).every(n=>!n.stop.mock.calls.length)).toBe(true);
    f.sound.setUiSoundPreferences({scroll:false});
    await vi.advanceTimersByTimeAsync(200);
    expect(f.nodes.filter(n=>n.start.mock.calls.length).every(n=>n.stop.mock.calls.length===1)).toBe(true);
  } finally {f.cleanup();vi.useRealTimers();vi.unstubAllGlobals();}
});
