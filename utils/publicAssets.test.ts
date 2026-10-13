import { describe, expect, it } from 'vitest';
import { resolvePublicAssetUrl } from './publicAssets';

describe('resolvePublicAssetUrl', () => {
  it('keeps logical public paths compatible with the active Vite base', () => {
    expect(resolvePublicAssetUrl('/wallpapers/wallhaven-yqxzqx.jpg')).toBe('/wallpapers/wallhaven-yqxzqx.jpg');
    expect(resolvePublicAssetUrl('wallpapers/wallhaven-yqxzqx.jpg')).toBe('/wallpapers/wallhaven-yqxzqx.jpg');
  });

  it('does not rewrite already resolved or user-supplied image URLs', () => {
    expect(resolvePublicAssetUrl('./wallpapers/wallhaven-yqxzqx.jpg')).toBe('./wallpapers/wallhaven-yqxzqx.jpg');
    expect(resolvePublicAssetUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(resolvePublicAssetUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  it('maps migrated system wallpaper file URLs back to packaged assets', () => {
    expect(resolvePublicAssetUrl('https://jiangsupanda.com/bambook/api/v1/system-assets/scifi/file')).toBe('/wallpapers/wallhaven-4dqgvj.jpg');
    expect(resolvePublicAssetUrl('/api/v1/system-assets/image-5/file')).toBe('/wallpapers/5.jpg');
  });
});
