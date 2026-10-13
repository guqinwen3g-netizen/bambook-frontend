import { Response } from 'express';
import { normalizeTextForTts } from './ttsTextNormalizer';
import { logger } from '../lib/logger';

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const DEFAULT_TTS_PROVIDER = 'melo';
const MAX_TTS_CHARS = Number(process.env.BAMBOOK_TTS_MAX_CHARS || 2000);

// Melo defaults — runtime-overridable via env so we don't need a redeploy to tune
function getDefaultMeloLanguage() {
  return String(process.env.BAMBOOK_MELO_DEFAULT_LANGUAGE || 'ZH').trim().toUpperCase();
}
function getDefaultMeloSpeed() {
  const raw = Number(process.env.BAMBOOK_MELO_DEFAULT_SPEED);
  if (Number.isFinite(raw) && raw >= 0.5 && raw <= 2.0) return raw;
  return 1.0;
}
// Melo 推理参数（对应 MeloTTS.tts_to_file 的 sdp_ratio / noise_scale / noise_scale_w）
// sdp_ratio: 语调随机度（0=极平稳/播报；0.4=讲故事；上游默认 0.2）
// noise_scale: 音色随机度（上游默认 0.6）
// noise_scale_w: 时长/节奏随机度（上游默认 0.8）
function getMeloInferenceTuning() {
  const sdp = Number(process.env.BAMBOOK_MELO_SDP_RATIO);
  const noise = Number(process.env.BAMBOOK_MELO_NOISE_SCALE);
  const noiseW = Number(process.env.BAMBOOK_MELO_NOISE_SCALE_W);
  return {
    sdp_ratio: Number.isFinite(sdp) && sdp >= 0 && sdp <= 1 ? sdp : 0.2,
    noise_scale: Number.isFinite(noise) && noise >= 0 && noise <= 1.5 ? noise : 0.6,
    noise_scale_w: Number.isFinite(noiseW) && noiseW >= 0 && noiseW <= 1.5 ? noiseW : 0.8,
  };
}
// Melo speed clamp: 0.5x ~ 2.0x (服务端 melo_tts_service.py 的有效范围)
const MELO_SPEED_MIN = 0.5;
const MELO_SPEED_MAX = 2.0;

// ════════════════════════════════════════════════════════════════════
// 批次 2c「TTS 降级路径」：进程级熔断器
//
// 问题：melo 服务不可达时，每个 TTS 分片都要等满请求超时
// （BAMBOOK_MELO_REQUEST_TIMEOUT_MS 默认 240s）才失败，
// chat 流的 finish() 会被长时间阻塞，且每段失败都 emit step 提示刷屏。
//
// 方案：首次失败（网络错误/超时/非 2xx）后打开熔断（冷却窗口内直接快速失败
// MELO_CIRCUIT_OPEN），冷却结束自动半开重试；成功则关闭熔断。
// 正文文本流不受影响——TTS 分片失败在 route 层被捕获并降级为纯文本。
// ════════════════════════════════════════════════════════════════════

export type MeloCircuitState = {
  open: boolean;
  openUntil: number;
  lastError?: string;
  lastFailedAt?: string;
};

let meloCircuit: MeloCircuitState = { open: false, openUntil: 0 };

const DEFAULT_MELO_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

function meloCircuitCooldownMs(): number {
  const raw = Number(process.env.BAMBOOK_MELO_CIRCUIT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_MELO_CIRCUIT_COOLDOWN_MS;
}

export function getMeloCircuitState(): MeloCircuitState {
  const now = Date.now();
  if (meloCircuit.open && now >= meloCircuit.openUntil) {
    // 冷却结束：半开——允许下一次真实请求（探测恢复）
    meloCircuit = { open: false, openUntil: 0 };
  }
  return { ...meloCircuit };
}

/** 仅供测试重置模块级熔断状态 */
export function resetMeloCircuitForTesting(): void {
  meloCircuit = { open: false, openUntil: 0 };
}

function tripMeloCircuit(error: string): void {
  meloCircuit = {
    open: true,
    openUntil: Date.now() + meloCircuitCooldownMs(),
    lastError: error,
    lastFailedAt: new Date().toISOString(),
  };
  logger.warn(`[melo-tts] circuit open for ${meloCircuitCooldownMs()}ms: ${error}`);
}

function closeMeloCircuit(): void {
  if (meloCircuit.open) {
    meloCircuit = { open: false, openUntil: 0 };
    logger.info('[melo-tts] circuit closed (service recovered)');
  }
}

/** 熔断打开时抛出的快速失败错误（不等请求超时） */
export const MELO_CIRCUIT_OPEN_ERROR = 'MELO_CIRCUIT_OPEN';

export type TtsSpeechRequest = {
  input: string;
  voice?: string;
  rate?: string;
};

type TtsSpeechResult = {
  audio: Buffer;
  engine: string;
  serviceElapsedMs?: string;
  language?: string;
};

type MeloSpeechRequest = TtsSpeechRequest & {
  language: string;
};

export function normalizeTtsRequest(body: any): TtsSpeechRequest {
  const input = String(body?.input || body?.text || '').trim();
  const voice = String(body?.voice || DEFAULT_VOICE).trim();
  const rate = normalizeRate(body?.rate);
  return {
    input: input.length > MAX_TTS_CHARS ? input.slice(0, MAX_TTS_CHARS) : input,
    voice: voice === 'default' ? DEFAULT_VOICE : voice,
    rate,
  };
}

export function validateTtsRequest(input: TtsSpeechRequest) {
  if (!input.input) return 'input is required';
  return '';
}

export async function streamTtsSpeech(input: TtsSpeechRequest, res: Response, signal?: AbortSignal) {
  const result = await synthesizeTtsSpeech(input, signal);
  if (signal?.aborted || res.destroyed) return;
  res.status(200);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Bambook-TTS-Engine', result.engine);
  if (result.serviceElapsedMs) {
    res.setHeader('X-Bambook-TTS-Elapsed-Ms', result.serviceElapsedMs);
  }
  if (result.language) {
    res.setHeader('X-Bambook-TTS-Language', result.language);
  }
  res.setHeader('Content-Length', String(result.audio.length));
  res.write(result.audio);
}

export async function synthesizeTtsSpeech(input: TtsSpeechRequest, signal?: AbortSignal) {
  const provider = String(process.env.BAMBOOK_TTS_PROVIDER || DEFAULT_TTS_PROVIDER).trim().toLowerCase();
  if (provider === 'melo') {
    const result = await synthesizeMeloSpeech(input, signal);
    return { ...result, contentType: 'audio/wav' };
  }
  throw new Error('Backend chat TTS streaming currently requires Melo provider');
}

export async function streamMeloSpeech(input: TtsSpeechRequest, res: Response, signal?: AbortSignal) {
  const result = await synthesizeMeloSpeech(input, signal);
  if (signal?.aborted || res.destroyed) return;
  res.status(200);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Bambook-TTS-Engine', result.engine);
  if (result.serviceElapsedMs) {
    res.setHeader('X-Bambook-TTS-Elapsed-Ms', result.serviceElapsedMs);
  }
  if (result.language) {
    res.setHeader('X-Bambook-TTS-Language', result.language);
  }
  res.setHeader('Content-Length', String(result.audio.length));
  res.write(result.audio);
}

export async function synthesizeMeloSpeech(input: TtsSpeechRequest, signal?: AbortSignal) {
  return synthesizeMeloWithService(input, signal);
}

// 进程级预热结果，供 /api/health 暴露
let lastPrewarmResult: {
  ok: boolean;
  skipped: boolean;
  provider: string;
  elapsedMs?: number;
  error?: string;
  at?: string;
} | null = null;

export function getMeloPrewarmStatus() {
  return lastPrewarmResult;
}

export async function prewarmMeloTts() {
  const provider = String(process.env.BAMBOOK_TTS_PROVIDER || DEFAULT_TTS_PROVIDER).trim().toLowerCase();
  if (provider !== 'melo') {
    lastPrewarmResult = { ok: true, skipped: true, provider, at: new Date().toISOString() };
    return lastPrewarmResult;
  }

  const startedAt = Date.now();
  try {
    await synthesizeMeloWithService({
      input: '预热完成。',
      rate: '+0%',
    });
    const elapsedMs = Date.now() - startedAt;
    lastPrewarmResult = {
      ok: true,
      skipped: false,
      provider,
      elapsedMs,
      at: new Date().toISOString(),
    };
    logger.info(`[melo-tts] prewarm ok in ${elapsedMs}ms`);
    return lastPrewarmResult;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    lastPrewarmResult = {
      ok: false,
      skipped: false,
      provider,
      elapsedMs,
      error: message,
      at: new Date().toISOString(),
    };
    logger.warn(`[melo-tts] prewarm failed after ${elapsedMs}ms: ${message}`);
    return lastPrewarmResult;
  }
}

function normalizeRate(value: unknown) {
  const raw = String(value || '+0%').trim();
  if (/^[+-]\d{1,3}%$/.test(raw)) return raw;
  if (/^\d{1,3}%$/.test(raw)) return `+${raw}`;
  return '+0%';
}

async function synthesizeMeloWithService(input: TtsSpeechRequest, signal?: AbortSignal): Promise<TtsSpeechResult> {
  // 熔断打开时快速失败（冷却窗口内不再等满请求超时）
  const circuit = getMeloCircuitState();
  if (circuit.open) {
    throw new Error(`${MELO_CIRCUIT_OPEN_ERROR}: Melo TTS 暂不可用（上次失败：${circuit.lastError || 'unknown'}），将在冷却结束后自动重试`);
  }

  const meloInput = toChineseMeloRequest(input);
  const serviceUrl = getMeloServiceUrl();
  const timeoutMs = Number(process.env.BAMBOOK_MELO_REQUEST_TIMEOUT_MS || 240_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const tuning = getMeloInferenceTuning();
    const response = await fetch(`${serviceUrl}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: meloInput.input,
        speed: meloInput.speed,
        language: meloInput.language,
        sdp_ratio: tuning.sdp_ratio,
        noise_scale: tuning.noise_scale,
        noise_scale_w: tuning.noise_scale_w,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = `Melo service failed: ${response.status} ${await response.text()}`;
      tripMeloCircuit(detail);
      throw new Error(detail);
    }

    const result: TtsSpeechResult = {
      audio: Buffer.from(await response.arrayBuffer()),
      engine: response.headers.get('X-Bambook-TTS-Engine') || 'melo',
      serviceElapsedMs: response.headers.get('X-Bambook-TTS-Elapsed-Ms') || '',
      language: response.headers.get('X-Bambook-TTS-Language') || meloInput.language,
    };
    closeMeloCircuit();
    return result;
  } catch (error: any) {
    // 用户主动取消不算服务故障，不触发熔断
    if (signal?.aborted) throw error;
    const message = String(error?.message || error);
    if (!message.startsWith('Melo service failed:')) {
      tripMeloCircuit(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function getMeloServiceUrl() {
  const configuredUrl = process.env.BAMBOOK_MELO_URL?.trim().replace(/\/$/, '');
  if (!configuredUrl) {
    throw new Error('BAMBOOK_MELO_URL environment variable is not configured');
  }
  return configuredUrl;
}

// 把前端 rate（如 "+20%" / "-10%"）转换成 Melo speed（0.5~2.0）
// "+0%" → DEFAULT_SPEED（不丢前端的"使用默认"语义）
// "+20%" → DEFAULT_SPEED * 1.2，再夹紧到 [0.5, 2.0]
function speedFromRate(rate: string | undefined): number {
  const baseline = getDefaultMeloSpeed();
  if (!rate) return baseline;
  const m = /^([+-]?)(\d{1,3})%$/.exec(rate.trim());
  if (!m) return baseline;
  const sign = m[1] === '-' ? -1 : 1;
  const pct = Number(m[2]);
  if (!Number.isFinite(pct)) return baseline;
  const speed = baseline * (1 + (sign * pct) / 100);
  return Math.max(MELO_SPEED_MIN, Math.min(MELO_SPEED_MAX, Number(speed.toFixed(3))));
}

type MeloSpeechRequestInternal = MeloSpeechRequest & { speed: number };

function toChineseMeloRequest(input: TtsSpeechRequest): MeloSpeechRequestInternal {
  return {
    ...input,
    input: normalizeTextForTts(input.input),
    rate: input.rate || '+0%',
    speed: speedFromRate(input.rate),
    language: getDefaultMeloLanguage(),
  };
}
