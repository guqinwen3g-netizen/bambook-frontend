import { describe, expect, it } from 'vitest';
import {
  createTtsAnnotationStripper,
  normalizeTextForTts,
  stripTtsAnnotationsForDisplay,
} from './ttsTextNormalizer';

describe('TTS text normalizer', () => {
  it('strips internal TTS annotations from display text', () => {
    expect(stripTtsAnnotationsForDisplay('PO <tts type="po">208401</tts> 的交期已更新。'))
      .toBe('PO 208401 的交期已更新。');
  });

  it('turns annotated business values into speakable text', () => {
    const text = normalizeTextForTts('PO <tts type="po">208401</tts> 的交期是 <tts type="date">2026-06-11</tts>。');

    expect(text).toContain('P O 二 零 八 四 零 一');
    expect(text).toContain('二零二六年六月十一日');
  });

  it('uses fallback rules for labeled business numbers and dates', () => {
    const text = normalizeTextForTts('PO 208401 的交期是 2026-06-11。数量是 208401 码。');

    expect(text).toContain('P O 二 零 八 四 零 一');
    expect(text).toContain('二零二六年六月十一日');
    expect(text).toContain('数量是 208401 码');
  });

  it('spells standalone uppercase business acronyms without breaking codes', () => {
    const text = normalizeTextForTts('USD 单价已更新，SKU 信息同步完成，客户码 ABC-123 保持可识别。');

    expect(text).toContain('U S D 单价');
    expect(text).toContain('S K U 信息');
    expect(text).toContain('客户码A B C，一 二 三');
  });

  it('does not leak split TTS tags while streaming display deltas', () => {
    const stripper = createTtsAnnotationStripper();

    const visible = [
      stripper.push('PO <tt'),
      stripper.push('s type="po">208'),
      stripper.push('401</tts> 完成'),
      stripper.flush(),
    ].join('');

    expect(visible).toBe('PO 208401 完成');
  });
});
