import { describe, expect, it } from 'vitest';
import { synthesizeMeloSpeech, normalizeTtsRequest } from './tts';

describe('TTS request normalization', () => {
  it('keeps Melo requests on the single Chinese default path', () => {
    expect(normalizeTtsRequest({
      input: '请打开 Bambook dashboard。',
      mode: 'auto',
      language: 'EN',
      speaker: 'EN-US',
      voice: 'default',
    })).toEqual({
      input: '请打开 Bambook dashboard。',
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: '+0%',
    });
  });

  it('ignores non-default Melo voice tuning while preserving text normalization', async () => {
    const fetchCalls: any[] = [];
    const originalFetch = global.fetch;
    process.env.BAMBOOK_MELO_URL = 'http://127.0.0.1:8765';
    global.fetch = (async (_url: any, init?: any) => {
      fetchCalls.push(JSON.parse(String(init?.body || '{}')));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'X-Bambook-TTS-Engine': 'melo',
          'X-Bambook-TTS-Language': 'ZH',
        },
      });
    }) as any;

    try {
      await synthesizeMeloSpeech({
        input: 'USD 和 SKU 测试。',
        rate: '+35%',
        language: 'EN' as any,
        speaker: 'EN-US' as any,
      } as any);
    } finally {
      global.fetch = originalFetch;
      delete process.env.BAMBOOK_MELO_URL;
    }

    expect(fetchCalls[0]).toEqual({
      input: 'U S D 和 S K U 测试。',
      speed: 1.35,
      language: 'ZH',
      sdp_ratio: 0.2,
      noise_scale: 0.6,
      noise_scale_w: 0.8,
    });
  });
});
