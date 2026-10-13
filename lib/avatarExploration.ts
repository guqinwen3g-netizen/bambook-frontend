/** Two visible axes: x = representation, -y = visual energy. Colors remain independent. */
export const avatarDirections = [
  { label: '具象', x: 1, y: 0 }, { label: '活泼', x: 0, y: -1 },
  { label: '抽象', x: -1, y: 0 }, { label: '沉静', x: 0, y: 1 },
] as const;
// Spatial anchors: representation on x, energy on -y. One library per continuous region.
export const avatarStyleTraits: [string, number, number][] = [
  ['line-face', .65, -.15], // Sparse, recognisable facial lines.
  ['glass', -.8, -.55], // Translucent, soft geometric forms.
  ['waves', -.8, -.1], // Organic curves; motion alone is not a playful expression.
  ['weave', -.7, -.4], // Ordered interlaced structure.
  ['cameo', .95, -.35], // Composed portrait silhouette.
  ['dylan', .9, .15], // Illustrated human portrait.
  ['critters', .75, .85], // Expressive creature characters.
  ['thumbs', .45, .75], // Playful anthropomorphic forms.
  ['gaze', .55, .5], // Character conveyed primarily through expressive eyes.
  ['glyphs', -.15, .1], // Human-like silhouette reduced to symbols.
  ['slice', -.75, .4], // Angular, fragmented geometry.
  ['stripes', -.9, -.25], // Repetitive, graphic structure.
];
// Equal-area power diagram on the visible circular interaction plane, not on a hidden sphere surface.
// Calibrated by scripts/calibrate-avatar-regions.py. Recalibrate when anchors or the pool change.
// Each region is a convex cell occupying 1/12 of the disk; offsets compensate for anchor density.
export const avatarRegionOffsets: Record<string, number> = {
  'line-face': -0.318204942997,
  'glass': -0.083482887508,
  'waves': -0.088661750947,
  'weave': -0.132775223417,
  'cameo': -0.213260971103,
  'dylan': -0.092581650303,
  'critters': 0.140239168905,
  'thumbs': -0.096552495879,
  'gaze': -0.095667397761,
  'glyphs': -0.394063408586,
  'slice': -0.304014130917,
  'stripes': 0.000000000000,
};

export const avatarRegionNames: Record<string, string> = {
  'line-face': '线脸', glass: '玻璃', waves: '波纹', weave: '编织', cameo: '剪影',
  dylan: '肖像', critters: '怪兽', thumbs: '拟人', gaze: '眼眸',
  glyphs: '符号', slice: '切片', stripes: '条纹',
};

// Draw the same power cells used by hit detection. Boundaries stay in pointer space,
// while the decorative particle sphere rotates underneath them.
export const avatarRegions = avatarStyleTraits.map(([family, xi, energy]) => {
  const yi = -energy;
  let polygon = Array.from({ length: 512 }, (_, i) => {
    const angle = i * Math.PI * 2 / 512;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  for (const [other, xj, otherEnergy] of avatarStyleTraits) {
    if (other === family) continue;
    const yj = -otherEnergy;
    const nx = 2 * (xj - xi), ny = 2 * (yj - yi);
    const limit = xj*xj + yj*yj - xi*xi - yi*yi + avatarRegionOffsets[family] - avatarRegionOffsets[other];
    const clipped: typeof polygon = [];
    let previous = polygon[polygon.length - 1];
    if (!previous) break;
    let previousDistance = previous.x * nx + previous.y * ny - limit;
    for (const current of polygon) {
      const distance = current.x * nx + current.y * ny - limit;
      if ((distance <= 0) !== (previousDistance <= 0)) {
        const t = previousDistance / (previousDistance - distance);
        clipped.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
      }
      if (distance <= 0) clipped.push(current);
      previous = current; previousDistance = distance;
    }
    polygon = clipped;
  }
  let crossSum = 0, cx = 0, cy = 0;
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - a.y * b.x;
    crossSum += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross;
  });
  return {
    family, label: avatarRegionNames[family],
    path: polygon.map((p, i) => `${i ? 'L' : 'M'}${p.x * 100},${p.y * 100}`).join(' ') + 'Z',
    x: cx / (3 * crossSum) * 100, y: cy / (3 * crossSum) * 100,
  };
});

export function exploreAvatarAt(x: number, y: number) {
  const radius = Math.min(1, Math.hypot(x, y));
  const length = Math.max(1, Math.hypot(x, y));
  const px = x / length, py = y / length;
  let family = avatarStyleTraits[0][0];
  let bestScore = Infinity;
  for (const [candidate, representation, energy] of avatarStyleTraits) {
    const score = (representation - px) ** 2 + (energy + py) ** 2 - avatarRegionOffsets[candidate];
    if (score < bestScore) { family = candidate; bestScore = score; }
  }
  const labels = [Math.abs(px) >= .25 ? px > 0 ? '具象' : '抽象' : '', Math.abs(py) >= .25 ? py > 0 ? '沉静' : '活泼' : ''].filter(Boolean);
  return { family, radius, label: labels.join(' · ') || '自由探索' };
}
