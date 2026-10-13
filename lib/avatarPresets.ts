import { mistPalette } from './avatarColor';
import { avatarVariantPreferences } from './avatarVariantPreferences';
import { Avatar, Style } from '@dicebear/core';
import definition0 from '@dicebear/styles/blobs.json';
import definition1 from '@dicebear/styles/disco.json';
import definition2 from '@dicebear/styles/glass.json';
import definition3 from '@dicebear/styles/glyphs.json';
import definition4 from '@dicebear/styles/squircles.json';
import definition5 from '@dicebear/styles/slice.json';
import definition6 from '@dicebear/styles/waves.json';
import definition7 from '@dicebear/styles/weave.json';
import definition8 from '@dicebear/styles/critters.json';
import definition9 from '@dicebear/styles/cameo.json';
import definition10 from '@dicebear/styles/line-face.json';
import definition11 from '@dicebear/styles/thumbs.json';
import definition12 from '@dicebear/styles/landscape.json';

import additional0 from '@dicebear/styles/croodles-neutral.json';
import additional1 from '@dicebear/styles/dylan.json';
import additional2 from '@dicebear/styles/fun-emoji.json';
import additional3 from '@dicebear/styles/gaze.json';
import additional4 from '@dicebear/styles/pixelbot.json';
import additional5 from '@dicebear/styles/rings.json';
import additional6 from '@dicebear/styles/stripes.json';
import additional7 from '@dicebear/styles/planets.json';

// Avatar artwork palette: user-approved muted colors, independent of UI theme.
// Each avatar uses one coherent tonal family, selected deterministically by seed.
const palettes = [
  ['#ECF1F5', '#C6DAE3', '#A2B9C8', '#71869B', '#465668'], // mist blue
  ['#EFF2EE', '#D3DFD1', '#ADBFA9', '#80927C', '#4D5F4B'], // sage
  ['#F4EEEF', '#E5D2D7', '#C9A9B3', '#A07E89', '#68505A'], // dusty rose
  ['#F1EFF5', '#DCD5E7', '#BBB0CE', '#9385A8', '#5D526E'], // lavender gray
  ['#F4F1EB', '#E5DCCB', '#C9BBA1', '#A2947B', '#655B49'], // warm sand
  ['#F4EFEB', '#E5D5CA', '#CCB1A0', '#A88A79', '#6A554A'], // clay
] as const;

const paletteIndexFor = (seed: string) => {
  const explicit = seed.match(/^p([0-5])_/);
  if (explicit) return Number(explicit[1]);
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % palettes.length;
};
const definitions = {
  'blobs': definition0,
  'disco': definition1,
  'glass': definition2,
  'glyphs': definition3,
  'squircles': definition4,
  'slice': definition5,
  'waves': definition6,
  'weave': definition7,
  'critters': definition8,
  'cameo': definition9,
  'line-face': definition10,
  'thumbs': definition11,
  'landscape': definition12,
  'croodles-neutral': additional0,
  'dylan': additional1,
  'fun-emoji': additional2,
  'gaze': additional3,
  'pixelbot': additional4,
  'rings': additional5,
  'stripes': additional6,
  'planets': additional7
};

const styles = new Map<string, Style>();

export function generateAvatar(family: string, seed: string, animated = false): string {
  const paletteIndex = paletteIndexFor(seed);
  // v2 adds bounded tonal variety, while old saved seeds retain their exact artwork.
  let tone = 0;
  if (/^p[0-5]_v[23]_/.test(seed)) {
    let hash = 0;
    for (const character of seed.replace(/^p[0-5]_v3_\d+_\d+_/, "")) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    tone = ((hash >>> 0) % 7) - 3;
  }
  const hue = seed.match(/^c(\d{1,3})_v[56]_/);
  const basePalette = hue ? mistPalette(Number(hue[1]) % 360) : palettes[paletteIndex];
  const adjusted = basePalette.map((hex, index) => {
    if (!tone) return hex;
    const delta = tone * (index === 0 ? 1 : 3);
    return '#' + [1, 3, 5].map(offset => Math.max(0, Math.min(255, parseInt(hex.slice(offset, offset + 2), 16) + delta)).toString(16).padStart(2, '0')).join('');
  });
  const [frost, mist, middle, gray, ink] = adjusted;
  const colors = [gray, middle, mist];
  const cacheKey = `${family}:${hue ? `h${hue[1]}` : paletteIndex}:${tone}`;
  let style = styles.get(cacheKey);
  if (!style) {
    const definition = definitions[family as keyof typeof definitions];
    if (!definition) throw new Error('未知头像系列');
    const themedColors = Object.fromEntries(Object.entries(definition.colors).map(([name, color]) => {
      let values: string[] = colors;
      if (name === 'background') values = family === 'glass' ? [gray, middle] : [frost];
      // Line Face draws every facial feature with ink. A background-colored
      // ink choice makes the entire face disappear, so ink must stay dark.
      else if (name === 'ink') values = [ink];
      else if (['eyes', 'mouth'].includes(name)) values = [ink, frost];
      else if (name === 'shade') values = [ink + '57', frost + '8f'];
      else if (name === 'orb' || name === 'hill1') values = [mist];
      else if (name === 'hill2') values = [middle];
      else if (name === 'hill3') values = [gray];
      else if (name === 'hill4') values = [ink];
      else if (['blob', 'wave'].includes(name)) values = [gray];
      return [name, { ...color, values }];
    }));
    style = new Style({ ...definition, colors: themedColors });
    styles.set(cacheKey, style);
    if (styles.size > 96) styles.delete(styles.keys().next().value!);
  }
  const definition = definitions[family as keyof typeof definitions];
  // v6 uses the unmodified DiceBear component distribution. Legacy avatars retain their appearance.
  const variants = /^c\d{1,3}_v6_/.test(seed) ? {} : avatarVariantPreferences(family, seed, definition.components);
  const shapeSeed = seed.replace(/^p[0-5]_v4_/, 'v4_').replace(/^c\d{1,3}_v([56])_/, 'v$1_');
  const svg = new Avatar(style, { seed: shapeSeed, size: 256, animationVariant: animated ? 'slow' : 'none', ...variants }).toString();
  // This rule lives inside the SVG so it also applies when rendered as an img.
  const mutedSvg = ['croodles-neutral','dylan','fun-emoji','gaze','pixelbot','rings','stripes','planets','disco'].includes(family)
    ? svg.replace(/#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi, (match, raw: string) => {
      const hex = raw.length === 3 ? raw.split('').map((v: string) => v + v).join('') : raw;
      const channels = [0,2,4].map(offset => parseInt(hex.slice(offset, offset + 2),16));
      const lightness = (Math.max(...channels) + Math.min(...channels)) / 510;
      return adjusted[Math.min(4, Math.round((1 - lightness) * 4))];
    }) : svg;
  const accessibleSvg = mutedSvg.replace('</svg>', '<style>@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style></svg>');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(accessibleSvg)}`;
}

export function avatarCredit(family: string) {
  const meta = definitions[family as keyof typeof definitions]?.meta;
  return meta?.license.name === 'CC BY 4.0' ? { family, creator: meta.creator.name, url: `https://www.dicebear.com/styles/${family}/` } : null;
}
