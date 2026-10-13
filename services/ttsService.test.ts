import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttsService } from './ttsService';

class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number) {
    return this.channels[channel];
  }

  copyToChannel(source: Float32Array, channel: number, startInChannel = 0) {
    this.channels[channel].set(source, startInChannel);
  }
}

const fakeAudioContext = {
  currentTime: 0,
  createBuffer: (channels: number, length: number, sampleRate: number) => new FakeAudioBuffer(channels, length, sampleRate),
  createBufferSource: () => ({
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  }),
  createGain: () => ({
    gain: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
  }),
  destination: {},
} as unknown as AudioContext;

describe('ttsService playback preparation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ttsService.stop();
  });

  it('trims low-level silence from synthesized chunk boundaries', () => {
    const buffer = new FakeAudioBuffer(1, 500, 1000);
    const data = buffer.getChannelData(0);
    data.fill(0.02, 150, 351);

    const trimmed = ttsService._trimTtsBoundarySilence(buffer as unknown as AudioBuffer, fakeAudioContext);

    expect(trimmed.length).toBeLessThan(buffer.length);
    // 200 个有效样本 + 边界 padding（_ttsBoundaryPaddingSeconds=0.020s @ 1000Hz → 20 帧/侧）+ 1（end exclusive 修正）= 241
    expect(trimmed.length).toBe(241);
    expect(trimmed.getChannelData(0)[20]).toBeCloseTo(0.02);
  });

  it('keeps very short buffers unchanged to avoid cutting speech artifacts', () => {
    const buffer = new FakeAudioBuffer(1, 170, 1000);
    const data = buffer.getChannelData(0);
    data.fill(0.02, 80, 91);

    const trimmed = ttsService._trimTtsBoundarySilence(buffer as unknown as AudioBuffer, fakeAudioContext);

    expect(trimmed).toBe(buffer);
  });

  it('trims the model-generated head ramp so each chunk starts at steady loudness', () => {
    // 模拟 1 秒音频 @ 8000Hz：开头 100ms 是淡入坡道，后面 900ms 是稳态
    const sampleRate = 8000;
    const totalLen = sampleRate; // 1s
    const rampLen = Math.floor(sampleRate * 0.1); // 100ms 坡道
    const buffer = new FakeAudioBuffer(1, totalLen, sampleRate);
    const data = buffer.getChannelData(0);
    // 稳态部分填 0.3
    for (let i = rampLen; i < totalLen; i += 1) data[i] = 0.3;
    // 坡道部分线性从 0 → 0.3
    for (let i = 0; i < rampLen; i += 1) data[i] = 0.3 * (i / rampLen);

    const trimmed = ttsService._trimTtsHeadRamp(buffer as unknown as AudioBuffer, fakeAudioContext);

    // 当前 _ttsHeadRampThresholdRatio=0.35，100ms 线性坡道大约裁掉中间 40ms（320 frame）
    expect(totalLen - trimmed.length).toBeGreaterThanOrEqual(Math.floor(sampleRate * 0.03));
    // 裁完后第一个样本的振幅应该已经接近稳态
    expect(trimmed.getChannelData(0)[20]).toBeGreaterThan(0.3 * 0.3);
  });

  it('keeps short buffers untouched even when head ramp trim is enabled', () => {
    const buffer = new FakeAudioBuffer(1, 100, 8000); // 12.5ms 远小于 minLength
    const data = buffer.getChannelData(0);
    for (let i = 0; i < 100; i += 1) data[i] = 0.3 * (i / 100);

    const trimmed = ttsService._trimTtsHeadRamp(buffer as unknown as AudioBuffer, fakeAudioContext);
    // 太短的 buffer 不裁，原样返回
    expect(trimmed).toBe(buffer);
  });

  it('keeps synthesized chunks long enough to avoid repeated soft starts', () => {
    const chunks = ttsService._segmentText('这是一个比较长的测试回复，用来确认语音播放不会在每一句开头反复变轻。后面还有第二句话，用来凑出更接近自然朗读的一整段。');

    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBeGreaterThan(50);
  });

  it('starts fetching streaming chunks immediately while preserving ordered scheduling', async () => {
    const fetchOrder: string[] = [];
    const scheduleOrder: string[] = [];
    const resolvers = new Map<string, (buffer: AudioBuffer) => void>();
    const buffer = new FakeAudioBuffer(1, 1000, 1000) as unknown as AudioBuffer;

    vi.spyOn(ttsService, '_initAudioContext').mockReturnValue(fakeAudioContext);
    vi.spyOn(ttsService, 'resume').mockResolvedValue(undefined);
    vi.spyOn(ttsService, '_fetchTtsAudio').mockImplementation((segment: string) => {
      fetchOrder.push(segment);
      return new Promise<AudioBuffer>(resolve => resolvers.set(segment, resolve));
    });
    vi.spyOn(ttsService, '_scheduleAudioBuffer').mockImplementation((audioBuffer: AudioBuffer, _ctx: AudioContext, isLast: boolean) => {
      scheduleOrder.push(isLast ? 'last' : 'next');
      return 0;
    });

    ttsService.beginStreaming();
    ttsService._enqueueStreamingSegment('第一段。');
    ttsService._enqueueStreamingSegment('第二段。');

    expect(fetchOrder).toEqual(['第一段。', '第二段。']);
    expect(scheduleOrder).toEqual([]);

    resolvers.get('第二段。')?.(buffer);
    await Promise.resolve();
    expect(scheduleOrder).toEqual([]);

    resolvers.get('第一段。')?.(buffer);
    await ttsService._streamingQueue;

    expect(scheduleOrder).toEqual(['next', 'next']);
  });

  it('keeps streamed text complete and ordered across incremental deltas', () => {
    const requestedSegments: string[] = [];

    vi.spyOn(ttsService, '_initAudioContext').mockReturnValue(fakeAudioContext);
    vi.spyOn(ttsService, '_fetchTtsAudio').mockImplementation((segment: string) => {
      requestedSegments.push(segment);
      return Promise.resolve(new FakeAudioBuffer(1, 1000, 1000) as unknown as AudioBuffer);
    });
    vi.spyOn(ttsService, 'resume').mockResolvedValue(undefined);
    vi.spyOn(ttsService, '_scheduleAudioBuffer').mockImplementation(() => 0);

    const fullText = '我来跟你说一下。整个流程需要先查询数字档案，再查询关系智库。第二句不能跳过去。最后再整理结论。';

    ttsService.beginStreaming();
    for (const delta of ['我来跟你说', '一下。整个流程需要先查询', '数字档案，再查询关系智库。', '第二句不能跳过去。最后再整理结论。']) {
      ttsService.appendStreamingText(delta);
    }
    ttsService.endStreaming();

    expect(requestedSegments.join('')).toBe(ttsService._cleanTextForTTS(fullText));
  });

  it('does not flush tiny streaming fragments after the latency delay', async () => {
    vi.useFakeTimers();
    const requestedSegments: string[] = [];

    vi.spyOn(ttsService, '_initAudioContext').mockReturnValue(fakeAudioContext);
    vi.spyOn(ttsService, '_fetchTtsAudio').mockImplementation((segment: string) => {
      requestedSegments.push(segment);
      return Promise.resolve(new FakeAudioBuffer(1, 1000, 1000) as unknown as AudioBuffer);
    });
    vi.spyOn(ttsService, 'resume').mockResolvedValue(undefined);
    vi.spyOn(ttsService, '_scheduleAudioBuffer').mockImplementation(() => 0);

    ttsService.beginStreaming();
    ttsService.appendStreamingText('我先说明当前');

    expect(requestedSegments).toEqual([]);

    await vi.advanceTimersByTimeAsync(ttsService._streamingFlushDelayMs);

    expect(requestedSegments).toEqual([]);
    vi.useRealTimers();
  });

  it('flushes a usable streaming segment after the latency delay', async () => {
    vi.useFakeTimers();
    const requestedSegments: string[] = [];

    vi.spyOn(ttsService, '_initAudioContext').mockReturnValue(fakeAudioContext);
    vi.spyOn(ttsService, '_fetchTtsAudio').mockImplementation((segment: string) => {
      requestedSegments.push(segment);
      return Promise.resolve(new FakeAudioBuffer(1, 1000, 1000) as unknown as AudioBuffer);
    });
    vi.spyOn(ttsService, 'resume').mockResolvedValue(undefined);
    vi.spyOn(ttsService, '_scheduleAudioBuffer').mockImplementation(() => 0);

    ttsService.beginStreaming();
    const longText = '我先说明当前的订单和客户关系状态，然后继续整理下一步建议，并补充说明生产进度和风险提醒，最后一并给出执行清单。';
    ttsService.appendStreamingText(longText);

    expect(requestedSegments).toEqual([]);

    await vi.advanceTimersByTimeAsync(ttsService._streamingFlushDelayMs);

    expect(requestedSegments).toEqual([longText]);
    vi.useRealTimers();
  });

  it('plays backend audio chunks by segment id even when they arrive out of order', async () => {
    const decodeOrder: string[] = [];
    const scheduleOrder: string[] = [];
    const buffer = new FakeAudioBuffer(1, 1000, 1000) as unknown as AudioBuffer;

    vi.spyOn(ttsService, '_initAudioContext').mockReturnValue(fakeAudioContext);
    vi.spyOn(ttsService, 'resume').mockResolvedValue(undefined);
    vi.spyOn(ttsService, '_decodeTtsAudioBase64').mockImplementation(async (audioBase64: string) => {
      decodeOrder.push(audioBase64);
      return buffer;
    });
    vi.spyOn(ttsService, '_scheduleAudioBuffer').mockImplementation(() => {
      scheduleOrder.push('schedule');
      return 0;
    });

    ttsService.beginBackendStreaming();
    ttsService.enqueueBackendAudioChunk({ segmentId: 1, audioBase64: 'one' });
    await Promise.resolve();
    expect(decodeOrder).toEqual(['one']);
    expect(scheduleOrder).toEqual([]);

    ttsService.enqueueBackendAudioChunk({ segmentId: 0, audioBase64: 'zero' });
    await ttsService._streamingQueue;

    expect(decodeOrder).toEqual(['one', 'zero']);
    expect(scheduleOrder).toEqual(['schedule', 'schedule']);
  });
});
