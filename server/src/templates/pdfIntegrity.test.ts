import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const page = vi.hoisted(() => ({ setContent: vi.fn(), pdf: vi.fn(async () => Buffer.from('%PDF-native-renderer-integrity')), close: vi.fn(async () => {}) }));
vi.mock('playwright', () => ({ chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page, close: vi.fn(async () => {}) }), close: vi.fn(async () => {}) }) } }));
import { renderHtmlToPdf } from './pdf';
it('returns the full byte integrity hash used by protected archive consumers, not an abbreviated display tag', async () => {
  const rendered = await renderHtmlToPdf('<p>native PDF engine boundary</p>');
  expect(rendered.sha).toMatch(/^[a-f0-9]{64}$/);
  expect(rendered.sha).toBe(createHash('sha256').update(rendered.pdf).digest('hex'));
  expect(rendered.bytes).toBe(rendered.pdf.length);
});
