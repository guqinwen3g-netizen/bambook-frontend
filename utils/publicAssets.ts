const ABSOLUTE_URL_PATTERN = /^(?:https?:|data:|blob:|file:)/i;
const PACKAGED_SYSTEM_WALLPAPERS: Record<string, string> = {
  scifi: '/wallpapers/wallhaven-4dqgvj.jpg',
  'wallhaven-e8ejjw': '/wallpapers/wallhaven-e8ejjw.jpg',
  cyber: '/wallpapers/wallhaven-1kqvwg.jpg',
  aurora: '/wallpapers/wallhaven-yqxzqx.jpg',
  'wallhaven-48pwv2': '/wallpapers/wallhaven-48pwv2.jpg',
  'wallhaven-6lw5ll': '/wallpapers/wallhaven-6lw5ll.jpg',
  'wallhaven-mdmrly': '/wallpapers/wallhaven-mdmrly.jpg',
  'wallhaven-rqjrzq': '/wallpapers/wallhaven-rqjrzq.jpg',
  'wallhaven-966ev1': '/wallpapers/wallhaven-966ev1.jpg',
  'image-5': '/wallpapers/5.jpg',
  'wallhaven-gw2zpq': '/wallpapers/wallhaven-gw2zpq.jpg',
  'test-solid-black': '/wallpapers/test-solid-black.svg',
  'test-solid-white': '/wallpapers/test-solid-white.svg',
  'test-solid-brand-blue': '/wallpapers/test-solid-brand-blue.svg',
  'solid-mist-blue': '/wallpapers/solid-mist-blue.svg',
  'solid-lagoon': '/wallpapers/solid-lagoon.svg',
  'solid-dusk-violet': '/wallpapers/solid-dusk-violet.svg',
  'solid-graphite': '/wallpapers/solid-graphite.svg',
  'solid-warm-gray': '/wallpapers/solid-warm-gray.svg',
  'solid-sage': '/wallpapers/solid-sage.svg',
  'solid-midnight-blue': '/wallpapers/solid-midnight-blue.svg',
  'solid-burgundy': '/wallpapers/solid-burgundy.svg',
  'solid-forest-green': '/wallpapers/solid-forest-green.svg',
  'solid-sunset': '/wallpapers/solid-sunset.svg',
  'solid-mint': '/wallpapers/solid-mint.svg',
  'solid-sakura-pink': '/wallpapers/solid-sakura-pink.svg',
  'solid-mustard': '/wallpapers/solid-mustard.svg',
};

export function resolvePublicAssetUrl(url: string | undefined | null): string {
  if (!url) return '';
  const packagedWallpaper = resolvePackagedSystemWallpaper(url);
  if (packagedWallpaper) return resolvePublicAssetUrl(packagedWallpaper);
  if (ABSOLUTE_URL_PATTERN.test(url)) return url;
  if (url.startsWith('./') || url.startsWith('../')) return url;

  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  if (url.startsWith(normalizedBase)) return url;

  const normalizedUrl = url.startsWith('/') ? url.slice(1) : url;

  return `${normalizedBase}${normalizedUrl}`;
}

function resolvePackagedSystemWallpaper(url: string): string | null {
  const match = url.match(/\/api\/v1\/system-assets\/([^/?#]+)\/file(?:[?#].*)?$/);
  if (!match) return null;
  return PACKAGED_SYSTEM_WALLPAPERS[decodeURIComponent(match[1])] || null;
}
