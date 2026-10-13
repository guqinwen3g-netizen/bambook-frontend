/**
 * 批次 2c「TTS 降级路径」测试
 *
 * 覆盖：
 *   A. melo 熔断器核心（触发 / 快速失败 / 半开恢复 / 成功关闭 / 用户取消不触发）
 *   B. /tts/speech 路由错误语义化（503 TTS_UNAVAILABLE / 503 TTS_NOT_CONFIGURED）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  synthesizeMeloSpeech,
  getMeloCircuitState,
  resetMeloCircuitForTesting,
  MELO_CIRCUIT_OPEN_ERROR,
} from '../tts';
import { createAiRouter } from '../route';
import { createAiRuntime } from '../runtime';
import jwt from 'jsonwebtoken';

// W-C 权限收口：/tts/speech 挂 ai:chat scope 门（requirePermission 需 req.actor）——
// B 段路由用例统一以有效 owner JWT 通过 scope 门。
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);

const ENV_KEYS = ['BAMBOOK_MELO_URL', 'BAMBOOK_MELO_CIRCUIT_COOLDOWN_MS', 'BAMBOOK_TTS_PROVIDER'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.BAMBOOK_MELO_URL = 'http://127.0.0.1:9901';
  resetMeloCircuitForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SPEECH_INPUT = { input: '测试语音', rate: '+0%' };

function wavResponse(): Response {
  return new Response(new ArrayBuffer(8), { status: 200 });
}

describe('A. melo 熔断器核心', () => {
  it('服务失败（网络错误）→ 熔断打开', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow('ECONNREFUSED');
    const circuit = getMeloCircuitState();
    expect(circuit.open).toBe(true);
    expect(circuit.lastError).toContain('ECONNREFUSED');
  });

  it('服务失败（非 2xx）→ 熔断打开', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server error', { status: 500 })));
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow('Melo service failed: 500');
    expect(getMeloCircuitState().open).toBe(true);
  });

  it('熔断打开 → 后续调用快速失败 MELO_CIRCUIT_OPEN，不再发请求', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow(MELO_CIRCUIT_OPEN_ERROR);
    // 熔断期没有第二次网络请求（快速失败，不等 240s 超时）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('冷却结束 → 半开允许真实重试，成功后熔断关闭', async () => {
    vi.useFakeTimers();
    process.env.BAMBOOK_MELO_CIRCUIT_COOLDOWN_MS = '1000';
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow('ECONNREFUSED');
    expect(getMeloCircuitState().open).toBe(true);

    // 时间前进超过冷却窗口 → 熔断半开
    vi.setSystemTime(Date.now() + 1100);
    expect(getMeloCircuitState().open).toBe(false);

    // 半开后下一次请求成功 → 熔断保持关闭
    fetchMock.mockResolvedValueOnce(wavResponse());
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).resolves.toBeTruthy();
    expect(getMeloCircuitState().open).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('用户主动取消（signal aborted）→ 不触发熔断', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = synthesizeMeloSpeech(SPEECH_INPUT, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(getMeloCircuitState().open).toBe(false);
  });
});

describe('B. /tts/speech 路由错误语义化', () => {
  function makeTtsApp() {
    const app = express();
    app.use(express.json());
    const runtime = createAiRuntime({ chatRunner: async () => ({ text: 'ok' }) });
    app.use('/api/ai', createAiRouter({
      runtime,
      prisma: {} as any,
      requireAuth: true,
      apiKeys: new Set<string>(),
    } as any));
    return app;
  }

  it('熔断打开 → 503 TTS_UNAVAILABLE', async () => {
    // 先触发一次真实失败打开熔断
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED')));
    await expect(synthesizeMeloSpeech(SPEECH_INPUT)).rejects.toThrow('ECONNREFUSED');
    expect(getMeloCircuitState().open).toBe(true);

    const res = await request(makeTtsApp())
      .post('/api/ai/tts/speech')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ input: '测试' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TTS_UNAVAILABLE');
  });

  it('BAMBOOK_MELO_URL 未配置 → 503 TTS_NOT_CONFIGURED', async () => {
    delete process.env.BAMBOOK_MELO_URL;
    const res = await request(makeTtsApp())
      .post('/api/ai/tts/speech')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ input: '测试' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TTS_NOT_CONFIGURED');
  });
});
