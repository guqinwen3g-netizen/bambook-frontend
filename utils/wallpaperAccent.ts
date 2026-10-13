export type WallpaperAccentRGB = { r: number; g: number; b: number };

// 提示：BUILTIN_WALLPAPER_ACCENT_SAMPLES 由
// scripts/generate-wallpaper-accent-samples.mjs 离线生成，
// 内置壁纸的颜色档案在编译期就已固化，运行时同步命中、零异步。
import { BUILTIN_WALLPAPER_ACCENT_SAMPLES } from './wallpaperAccentSamples.generated';

const BUILTIN_WALLPAPER_ACCENT_SAMPLE_OVERRIDES: Readonly<Record<string, WallpaperAccentRGB>> = {
  '/wallpapers/wallhaven-6lw5ll.jpg': { r: 72, g: 132, b: 214 },
};

export type WallpaperAccentPalette = {
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentRgb: string;
  accentStrongRgb: string;
  accentSoftRgb: string;
  globeAtmosphere: string;
  globeBorder: string;
  globeLand: string;
  globeLandRim: string;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const WALLPAPER_ACCENT_SAMPLE_CACHE_KEY = 'bambook_wallpaper_accent_sample_cache_v1';
const wallpaperAccentSampleCache = new Map<string, WallpaperAccentRGB>();
const wallpaperAccentSamplePromises = new Map<string, Promise<WallpaperAccentRGB | null>>();

const rgbToHsl = ({ r, g, b }: WallpaperAccentRGB): { h: number; s: number; l: number } => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0.58, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  if (max === gn) h = (bn - rn) / d + 2;
  if (max === bn) h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
};

const hslToRgb = (h: number, s: number, l: number): WallpaperAccentRGB => {
  const hueToRgb = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(clamp01(hueToRgb(p, q, h + 1 / 3)) * 255),
    g: Math.round(clamp01(hueToRgb(p, q, h)) * 255),
    b: Math.round(clamp01(hueToRgb(p, q, h - 1 / 3)) * 255),
  };
};

const rgbToHex = ({ r, g, b }: WallpaperAccentRGB): string => (
  `#${[r, g, b].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
);

const rgbToTriplet = ({ r, g, b }: WallpaperAccentRGB): string => (
  `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`
);

const normalizeWallpaperUrlKey = (wallpaperUrl: string) => wallpaperUrl.trim();

// 内置壁纸都以 `/wallpapers/<file>` 路径发布；运行时可能被加上 BASE_URL
// 前缀或被服务端代理改写成 `/api/v1/system-assets/<id>/file`。这里只取
// 路径中的 `/wallpapers/...` 段作为静态档案的查表键。
const getBuiltinWallpaperSampleKey = (wallpaperUrl: string): string | null => {
  if (!wallpaperUrl) return null;
  const idx = wallpaperUrl.indexOf('/wallpapers/');
  if (idx === -1) return null;
  const tail = wallpaperUrl.slice(idx).split(/[?#]/)[0];
  return tail || null;
};

const getBuiltinWallpaperSample = (wallpaperUrl: string): WallpaperAccentRGB | null => {
  const key = getBuiltinWallpaperSampleKey(wallpaperUrl);
  return key ? (BUILTIN_WALLPAPER_ACCENT_SAMPLE_OVERRIDES[key] ?? BUILTIN_WALLPAPER_ACCENT_SAMPLES[key] ?? null) : null;
};

const isWallpaperAccentRGB = (value: unknown): value is WallpaperAccentRGB => {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Partial<WallpaperAccentRGB>;
  return [sample.r, sample.g, sample.b].every(channel => typeof channel === 'number' && Number.isFinite(channel));
};

const readStoredWallpaperAccentSamples = (): Record<string, WallpaperAccentRGB> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(WALLPAPER_ACCENT_SAMPLE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, WallpaperAccentRGB] => isWallpaperAccentRGB(entry[1]))
    );
  } catch {
    return {};
  }
};

const writeStoredWallpaperAccentSample = (wallpaperUrl: string, sample: WallpaperAccentRGB) => {
  if (typeof window === 'undefined') return;
  try {
    const stored = readStoredWallpaperAccentSamples();
    stored[wallpaperUrl] = sample;
    window.localStorage.setItem(WALLPAPER_ACCENT_SAMPLE_CACHE_KEY, JSON.stringify(stored));
  } catch {
    // Cache persistence is best-effort; the in-memory cache still covers the current session.
  }
};

const getCachedWallpaperAccentSample = (wallpaperUrl: string): WallpaperAccentRGB | null => {
  const key = normalizeWallpaperUrlKey(wallpaperUrl);
  if (!key) return null;
  // 1) 内置壁纸：编译期固化的颜色档案，永远同步命中、零异步。
  const builtinSample = getBuiltinWallpaperSample(key);
  if (builtinSample) return builtinSample;
  // 2) 自定义壁纸：本会话内存缓存。
  const memorySample = wallpaperAccentSampleCache.get(key);
  if (memorySample) return memorySample;
  // 3) 自定义壁纸：跨会话 localStorage 缓存（异步采样成功后写入）。
  const storedSample = readStoredWallpaperAccentSamples()[key];
  if (!storedSample) return null;
  wallpaperAccentSampleCache.set(key, storedSample);
  return storedSample;
};

export const defaultWallpaperAccentPalette = (isDarkMode: boolean): WallpaperAccentPalette => {
  /* 2026-09-01 雾蓝单频道（用户实机拍板）：地图调色板由旧竹蓝（hue 217-225°）整体
     迁入 brand-mist 频道（hue 200-206°），与侧边栏/主区同频。
     accent 三元对齐 BDS --accent 族；globe 表面对齐深色阶梯（page #14232F /
     card #1E3444 / sidebar 渐变 #132A36→#243F4C）。 */
  const accent = isDarkMode ? { r: 141, g: 213, b: 222 } : { r: 52, g: 118, b: 141 };   // #8DD5DE / #34768D
  const strong = isDarkMode ? { r: 120, g: 181, b: 189 } : { r: 39, g: 87, b: 104 };    // #78B5BD / #275768
  const soft = isDarkMode ? { r: 159, g: 188, b: 203 } : { r: 198, g: 217, b: 226 };   // #9FBCCB / #C6D9E2
  return {
    accent: rgbToHex(accent),
    accentStrong: rgbToHex(strong),
    accentSoft: rgbToHex(soft),
    accentRgb: rgbToTriplet(accent),
    accentStrongRgb: rgbToTriplet(strong),
    accentSoftRgb: rgbToTriplet(soft),
    globeAtmosphere: isDarkMode ? '#122532' : '#D3E2EA',
    globeBorder: isDarkMode ? '#4E7A90' : '#34768D',
    globeLand: isDarkMode ? '#2B4D60' : '#ECF2F6',
    globeLandRim: isDarkMode ? '#79ADC2' : '#C6DAE3',
  };
};

export const deriveWallpaperAccentPalette = (sample: WallpaperAccentRGB, isDarkMode: boolean): WallpaperAccentPalette => {
  const hsl = rgbToHsl(sample);
  const saturation = hsl.s < 0.08 ? 0.16 : Math.min(0.58, Math.max(0.24, hsl.s * 0.86));
  const accent = hslToRgb(hsl.h, saturation, isDarkMode ? 0.62 : 0.48);
  const strong = hslToRgb(hsl.h, Math.min(0.66, saturation * 1.08), isDarkMode ? 0.74 : 0.40);
  const soft = hslToRgb(hsl.h, Math.min(0.70, saturation * 1.12), isDarkMode ? 0.80 : 0.58);
  return {
    accent: rgbToHex(accent),
    accentStrong: rgbToHex(strong),
    accentSoft: rgbToHex(soft),
    accentRgb: rgbToTriplet(accent),
    accentStrongRgb: rgbToTriplet(strong),
    accentSoftRgb: rgbToTriplet(soft),
    globeAtmosphere: rgbToHex(hslToRgb(hsl.h, saturation * 0.42, isDarkMode ? 0.24 : 0.70)),
    globeBorder: rgbToHex(hslToRgb(hsl.h, saturation, isDarkMode ? 0.70 : 0.46)),
    globeLand: rgbToHex(hslToRgb(hsl.h, Math.min(0.62, saturation * 1.08), isDarkMode ? 0.58 : 0.42)),
    globeLandRim: rgbToHex(hslToRgb(hsl.h, Math.min(0.72, saturation * 1.18), isDarkMode ? 0.78 : 0.58)),
  };
};

const sampleWallpaperAverageColorUncached = (wallpaperUrl: string): Promise<WallpaperAccentRGB | null> => new Promise(resolve => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !wallpaperUrl) {
    resolve(null);
    return;
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    if (!image.naturalWidth || !image.naturalHeight) {
      resolve(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 12;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      count += 1;
    }
    resolve({ r: r / count, g: g / count, b: b / count });
  };
  image.onerror = () => resolve(null);
  image.src = wallpaperUrl;
});

export const sampleWallpaperAverageColor = (wallpaperUrl: string): Promise<WallpaperAccentRGB | null> => {
  const key = normalizeWallpaperUrlKey(wallpaperUrl);
  if (!key) return Promise.resolve(null);
  const cached = getCachedWallpaperAccentSample(key);
  if (cached) return Promise.resolve(cached);
  const pending = wallpaperAccentSamplePromises.get(key);
  if (pending) return pending;

  const next = sampleWallpaperAverageColorUncached(key).then(sample => {
    wallpaperAccentSamplePromises.delete(key);
    if (sample) {
      wallpaperAccentSampleCache.set(key, sample);
      writeStoredWallpaperAccentSample(key, sample);
    }
    return sample;
  });
  wallpaperAccentSamplePromises.set(key, next);
  return next;
};
