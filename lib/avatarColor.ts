/** Eight distinct muted schemes, ordered around the color wheel. */
export const mistSchemeHues = [22, 45, 100, 155, 205, 240, 275, 335] as const;
/** The aura shares the avatar hue, with more chroma so it remains visible on frost. */
export function avatarAuraColor(hue: number) {
  return `hsl(${hue} 38% 60%)`;
}
export function closestMistScheme(hue: number) {
  return mistSchemeHues.reduce<number>((best, candidate, index) => {
    const distance = (value: number) => Math.abs(((value - hue + 540) % 360) - 180);
    return distance(candidate) < distance(mistSchemeHues[best]) ? index : best;
  }, 0);
}

/** Saved avatars retain continuous hue support and fixed mist saturation/lightness. */
export function mistPalette(hue: number): string[] {
  return [[15,96],[20,86],[18,73],[17,56],[16,35]].map(([saturation, lightness]) => {
    const s = saturation / 100, l = lightness / 100;
    const a = s * Math.min(l, 1 - l);
    const channel = (n: number) => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
  });
}
