import { STT_CORRECTION_RULES } from '../data/sttCustomTerms';

type LocalSttStatus = 'idle' | 'preparing' | 'recording' | 'stopping' | 'error';

type LocalSttCallbacks = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus?: (status: LocalSttStatus, detail?: string) => void;
};

type ActiveLocalSttSession = {
  sessionId: string;
  audioContext: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  inputSampleRate: number;
  pendingSamples: Float32Array[];
  pendingLength: number;
  pushQueue: Promise<void>;
  stopped: boolean;
  cancelled: boolean;
  lastText: string;
};

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 0.48;
const CHUNK_SAMPLE_COUNT = Math.floor(TARGET_SAMPLE_RATE * CHUNK_SECONDS);

const normalizeSpaces = (text: string) => text
  .replace(/\s+/g, ' ')
  .replace(/\s+([，。！？；：、])/g, '$1')
  .trim();

export const applySttCorrections = (text: string) => {
  let next = normalizeSpaces(text);
  for (const rule of STT_CORRECTION_RULES) {
    next = next.replace(new RegExp(rule.pattern, 'gi'), rule.replacement);
  }
  return next;
};

const concatFloat32 = (chunks: Float32Array[], totalLength: number) => {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

const downsampleTo16k = (input: Float32Array, inputSampleRate: number) => {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    output[i] = count > 0 ? sum / count : input[start] || 0;
  }
  return output;
};

class LocalSttService {
  private active: ActiveLocalSttSession | null = null;

  get isRecording() {
    return Boolean(this.active && !this.active.stopped);
  }

  async start(callbacks: LocalSttCallbacks) {
    if (this.active) await this.stop(callbacks);
    if (!window.bambookLocalSTT) {
      callbacks.onStatus?.('error', '当前环境不支持本地语音识别');
      throw new Error('Local STT bridge is not available');
    }

    callbacks.onStatus?.('preparing', '准备本地语音识别');
    const prepared = await window.bambookLocalSTT.prepare();
    if (!prepared.ok) {
      callbacks.onStatus?.('error', prepared.error || '本地 STT 初始化失败');
      throw new Error(prepared.error || 'Local STT prepare failed');
    }

    const started = await window.bambookLocalSTT.start();
    if (!started.ok || !started.sessionId) {
      callbacks.onStatus?.('error', started.error || '本地 STT 会话启动失败');
      throw new Error(started.error || 'Local STT session failed');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    const session: ActiveLocalSttSession = {
      sessionId: started.sessionId,
      audioContext,
      stream,
      source,
      processor,
      inputSampleRate: audioContext.sampleRate,
      pendingSamples: [],
      pendingLength: 0,
      pushQueue: Promise.resolve(),
      stopped: false,
      cancelled: false,
      lastText: '',
    };

    const pushChunk = (chunk: Float32Array) => {
      session.pushQueue = session.pushQueue
        .then(async () => {
          if (session.cancelled || !window.bambookLocalSTT) return;
          const pcmBuffer = new Uint8Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          ).slice().buffer;
          const result = await window.bambookLocalSTT.pushPcm(
            session.sessionId,
            pcmBuffer,
            TARGET_SAMPLE_RATE,
          );
          if (!result.ok) throw new Error(result.error || '本地 STT 识别失败');
          const corrected = applySttCorrections(result.text || '');
          if (corrected && corrected !== session.lastText) {
            session.lastText = corrected;
            callbacks.onPartial(corrected);
          }
        })
        .catch((error) => {
          callbacks.onStatus?.('error', error?.message || '本地 STT 识别失败');
        });
    };

    const drainPending = () => {
      while (session.pendingLength >= CHUNK_SAMPLE_COUNT) {
        const merged = concatFloat32(session.pendingSamples, session.pendingLength);
        const chunk = merged.slice(0, CHUNK_SAMPLE_COUNT);
        const rest = merged.slice(CHUNK_SAMPLE_COUNT);
        session.pendingSamples = rest.length ? [rest] : [];
        session.pendingLength = rest.length;
        pushChunk(chunk);
      }
    };

    processor.onaudioprocess = (event) => {
      if (session.stopped) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleTo16k(input, session.inputSampleRate);
      session.pendingSamples.push(downsampled);
      session.pendingLength += downsampled.length;
      drainPending();
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    this.active = session;
    callbacks.onStatus?.('recording', '正在听写');
  }

  async stop(callbacks?: Partial<LocalSttCallbacks>) {
    const session = this.active;
    if (!session) return '';
    this.active = null;
    session.stopped = true;
    callbacks?.onStatus?.('stopping', '正在收尾');

    try {
      session.processor.disconnect();
      session.source.disconnect();
    } catch {
      // Audio nodes can already be disconnected during page teardown.
    }
    session.stream.getTracks().forEach(track => track.stop());

    const rest = concatFloat32(session.pendingSamples, session.pendingLength);
    if (rest.length && window.bambookLocalSTT) {
      session.pushQueue = session.pushQueue.then(async () => {
        await window.bambookLocalSTT?.pushPcm(
          session.sessionId,
          rest.buffer.slice(rest.byteOffset, rest.byteOffset + rest.byteLength),
          TARGET_SAMPLE_RATE,
        );
      });
    }

    await session.pushQueue;
    const finalResult = await window.bambookLocalSTT?.finish(session.sessionId);
    await session.audioContext.close().catch(() => undefined);
    const finalText = applySttCorrections(finalResult?.text || session.lastText || '');
    callbacks?.onFinal?.(finalText);
    callbacks?.onStatus?.('idle');
    return finalText;
  }

  async cancel() {
    const session = this.active;
    if (!session) return;
    this.active = null;
    session.stopped = true;
    session.cancelled = true;
    try {
      session.processor.disconnect();
      session.source.disconnect();
    } catch {
      // Best effort shutdown.
    }
    session.stream.getTracks().forEach(track => track.stop());
    await session.audioContext.close().catch(() => undefined);
    await window.bambookLocalSTT?.stop(session.sessionId).catch(() => undefined);
  }
}

export const localSttService = new LocalSttService();
