// Candidate vector geometry, shared by the live preview and the SVG exports.
// Each leaf has two smooth sides balanced about a straight or gently curved
// spine. The bamboo profile retains its rounded base and acuminate tip.
const bambooArcLeaf = {
  length: 80, breadth: 16, angle: -90, tilt: 90, kind: 'orbit', profile: 'bamboo',
  shoulder: .1, baseCurve: .3, tipCurve: .9, arcRadius: 47.5, bend: .3, fit: 'radial',
};
export const markCandidates = [
  { id: 'four-spark', code: 'A', name: '四叶 · 星核', family: '4 / 放射', count: 4, length: 80, breadth: 27, radius: 5, angle: -45, kind: 'radial' },
  { id: 'four-weave', code: 'B', name: '四叶 · 回旋', family: '4 / 交织', count: 4, length: 66, breadth: 28, radius: 35, angle: -45, tilt: 65, kind: 'orbit' },
  { id: 'six-spark', code: 'C', name: '六叶 · 竹光', family: '6 / 放射', count: 6, length: 75, breadth: 23, radius: 6, angle: -90, kind: 'radial' },
  { id: 'six-orbit', code: 'D', name: '六叶 · 聚环', family: '6 / 环形', count: 6, length: 56, breadth: 23, radius: 49, angle: -90, tilt: 76, kind: 'orbit' },
  { id: 'six-leaf-airy', code: 'R1', name: '六叶 · 轻旋', family: '完整细叶 / 舒朗回旋', count: 6, length: 50, breadth: 18, radius: 49, angle: -90, tilt: 82, kind: 'orbit' },
  { id: 'six-leaf-near', code: 'R2', name: '六叶 · 缓接', family: '完整细叶 / 叶尖靠近', count: 6, length: 54, breadth: 18, radius: 49, angle: -90, tilt: 84, kind: 'orbit' },
  { id: 'three-bamboo-orbit', code: 'T1', name: '三叶 · 回旋', family: '三向回旋 / 中心留白', count: 3, length: 80, breadth: 16, radius: 25, angle: -90, tilt: 88, kind: 'orbit', profile: 'bamboo' },
  { id: 'three-bamboo-balanced', code: 'U1', name: '三叶 · 匀衡', family: '直叶合围 / 宽峰向中部移动', count: 3, length: 80, breadth: 16, radius: 25, angle: -90, tilt: 90, kind: 'orbit', profile: 'bamboo', shoulder: .15, fit: 'radial' },
  { ...bambooArcLeaf, id: 'three-bamboo-bowed', code: 'U2', name: '三叶 · 微弧', family: '微弧竹叶 / 三向合围', count: 3, radius: Math.sqrt(47.5 ** 2 - 40 ** 2) },
  { ...bambooArcLeaf, id: 'six-bamboo-bowed', code: 'U6', name: '六叶 · 微弧', family: '微弧竹叶 / 六向合围', count: 6, radius: 77 },
  { ...bambooArcLeaf, id: 'six-bamboo-close', code: 'V1', name: '六叶 · 合围', family: '微弧竹叶 / 近接合围', count: 6, radius: 70, tilt: 88, bend: .36 },
  { ...bambooArcLeaf, id: 'six-bamboo-flow', code: 'V2', name: '六叶 · 流环', family: '微弧竹叶 / 顺势衔接', count: 6, radius: 70, tilt: 89, bend: .55 },
  { ...bambooArcLeaf, id: 'six-bamboo-link', code: 'V3', name: '六叶 · 轻扣', family: '微弧竹叶 / 交错轻扣', count: 6, radius: 64, tilt: 84, bend: .46, kind: 'knot', seam: 1.2 },
  { ...bambooArcLeaf, id: 'six-bamboo-prism', code: 'P1', name: '双三角 · 棱结', family: '两个三叶单元 / 六叶嵌合', count: 6, symmetry: 3, radius: Math.sqrt(47.5 ** 2 - 40 ** 2), kind: 'compound', groups: [{ scale: 1, rotation: 0 }, { scale: .66, rotation: 60 }] },
  { ...bambooArcLeaf, id: 'nine-bamboo-prism', code: 'P2', name: '三重 · 棱心', family: '三个三叶单元 / 逐层嵌合', count: 9, symmetry: 3, radius: Math.sqrt(47.5 ** 2 - 40 ** 2), kind: 'compound', groups: [{ scale: 1, rotation: 0 }, { scale: .66, rotation: 60 }, { scale: .42, rotation: 0 }] },
  { ...bambooArcLeaf, id: 'nine-bamboo-cluster', code: 'P3', name: '三角簇 · 环结', family: '三个三叶单元 / 环向互扣', count: 9, symmetry: 3, radius: Math.sqrt(47.5 ** 2 - 40 ** 2), kind: 'compound', groups: [{ scale: .58, rotation: 0, x: 0, y: -17 }, { scale: .58, rotation: 120, x: 14.722, y: 8.5 }, { scale: .58, rotation: 240, x: -14.722, y: 8.5 }] },
  { id: 'three-bamboo-circular', code: 'U3', name: '三叶 · 环抱', family: '环向竹叶 / 近圆留白', count: 3, length: 80, breadth: 16, radius: Math.sqrt(47.5 ** 2 - 40 ** 2), angle: -90, tilt: 90, kind: 'orbit', profile: 'bamboo', shoulder: .1, baseCurve: .3, tipCurve: .9, arcRadius: 47.5, bend: 1, fit: 'radial' },
  { id: 'three-bamboo-core', code: 'T2', name: '三叶 · 聚心', family: '三向展开 / 叶根相聚', count: 3, length: 82, breadth: 16, radius: 3, angle: -90, kind: 'radial', profile: 'bamboo' },
  { id: 'three-bamboo-fan', code: 'T3', name: '三叶 · 舒展', family: '左右平衡 / 竹叶舒展', count: 3, length: 84, breadth: 16, angles: [-128, -90, -52], kind: 'fan', profile: 'bamboo' },
  { id: 'five-orbit', code: 'D5', name: '聚环 · 五叶', family: 'D 原叶形 / 五叶环形', count: 5, length: 56, breadth: 23, radius: 49, angle: -90, tilt: 76, kind: 'orbit' },
  { id: 'eight-orbit', code: 'E', name: '八叶 · 竹环', family: '8 / 环形', count: 8, length: 44, breadth: 19, radius: 55, angle: -90, tilt: 77, kind: 'orbit' },
  { id: 'four-book', code: 'F', name: '四叶 · 书简', family: '4 / 对开', count: 4, length: 80, breadth: 23, kind: 'book' },
  { id: 'four-knot', code: 'G', name: '四叶 · 竹结', family: '4 / 穿插', count: 4, length: 104, breadth: 34, radius: 38, angle: -135, tilt: 90, kind: 'knot' },
  { id: 'four-linked', code: 'H', name: '四叶 · 连结', family: '4 / 叶尖穿织', count: 4, length: 94, breadth: 36, radius: 39, angle: -135, tilt: 90, kind: 'knot', seam: 2.4 },
  { id: 'four-weave-compact', code: 'B1', name: '回旋 · 细竹', family: '细长叶片 / 轻盈回旋', count: 4, length: 78, breadth: 20, radius: 35, angle: -45, tilt: 68, kind: 'orbit' },
  { id: 'four-weave-open', code: 'B2', name: '回旋 · 轻扣', family: '细长叶片 / 叶尖靠拢', count: 4, length: 82, breadth: 22, radius: 36, angle: -45, tilt: 78, kind: 'orbit' },
  { id: 'six-orbit-linked', code: 'D1', name: '聚环 · 疏竹', family: '叶片纤细 / 六向回旋', count: 6, length: 64, breadth: 18, radius: 46, angle: -90, tilt: 78, kind: 'orbit' },
  { id: 'six-orbit-full', code: 'D2', name: '聚环 · 细环', family: '细叶连接 / 中心留白', count: 6, length: 58, breadth: 18, radius: 44, angle: -90, tilt: 90, kind: 'knot', seam: 1.4 },
  { id: 'four-linked-slender', code: 'H1', name: '连结 · 竹环', family: '叶片纤细 / 轻盈穿织', count: 4, length: 100, breadth: 24, radius: 40, angle: -135, tilt: 90, kind: 'knot', seam: 1.8 },
  { id: 'four-linked-square', code: 'H2', name: '连结 · 细方结', family: '细叶四向 / 圆弧方结', count: 4, length: 94, breadth: 24, radius: 39, angle: -90, tilt: 90, kind: 'knot', seam: 1.8 },
];

const round = value => Math.round(value * 1000) / 1000;
export function getLeafUnitGeometry(candidate, scale = 1) {
  const half = candidate.length * scale / 2, breadth = candidate.breadth * scale;
  const bamboo = candidate.profile === 'bamboo';
  const shoulder = (candidate.shoulder ?? -.25) * half;
  const baseCurve = (candidate.baseCurve ?? .418) * breadth;
  const tipCurve = (candidate.tipCurve ?? .874) * breadth;
  const h = round(half), b = round(breadth);
  let d = bamboo
    ? `M ${-h} 0 C ${-h} ${-round(baseCurve)} ${round(shoulder)} ${-round(tipCurve)} ${h} 0 C ${round(shoulder)} ${round(tipCurve)} ${-h} ${round(baseCurve)} ${-h} 0 Z`
    : `M ${-h} 0 Q 0 ${b} ${h} 0 Q 0 ${-b} ${-h} 0 Z`;
  const point = (t, side) => {
    const u = 1 - t;
    const x = bamboo ? -half * u * u * u - 3 * half * u * u * t + 3 * shoulder * u * t * t + half * t * t * t : (t - .5) * 2 * half;
    const y = side * (bamboo ? 3 * baseCurve * u * u * t + 3 * tipCurve * u * t * t : 2 * u * t * breadth);
    if (!candidate.arcRadius) return { x, y };
    // Bend the complete leaf along a circular spine. Both sides keep the
    // same distance from that spine; the rounded root and sharp tip survive.
    const radius = candidate.arcRadius * scale, bend = candidate.bend ?? 1;
    const rootHeight = Math.sqrt(radius * radius - half * half);
    const arcHeight = Math.sqrt(radius * radius - x * x);
    const slope = bend * x / arcHeight, normalLength = Math.hypot(1, slope);
    return { x: x - y * slope / normalLength, y: bend * (rootHeight - arcHeight) + y / normalLength };
  };
  const points = Array.from({ length: 81 }, (_, i) => [point(i / 80, 1), point(i / 80, -1)]).flat();
  if (candidate.arcRadius) {
    // Smooth cubic segments approximate the bent mother leaf, with shared
    // tangents at every join. The preview and export use this exact path.
    const tangent = (t, side) => {
      const low = Math.max(0, t - .00001), high = Math.min(1, t + .00001);
      const a = point(low, side), z = point(high, side);
      return { x: (z.x - a.x) / (high - low), y: (z.y - a.y) / (high - low) };
    };
    const start = point(0, -1);
    d = `M ${round(start.x)} ${round(start.y)}`;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const t0 = side === -1 ? i / 6 : 1 - i / 6;
        const t1 = side === -1 ? (i + 1) / 6 : 1 - (i + 1) / 6;
        const a = point(t0, side), z = point(t1, side), da = tangent(t0, side), dz = tangent(t1, side);
        const step = (t1 - t0) / 3;
        d += ` C ${round(a.x + da.x * step)} ${round(a.y + da.y * step)} ${round(z.x - dz.x * step)} ${round(z.y - dz.y * step)} ${round(z.x)} ${round(z.y)}`;
      }
    }
    d += ' Z';
  }
  return { d, points, half: h, curve: b };
}

export function getLeafGeometry(candidate) {
  const { length, count } = candidate;
  const unit = getLeafUnitGeometry(candidate), d = unit.d;
  const leaves = candidate.kind === 'compound' ? candidate.groups.flatMap((group, groupIndex) =>
    Array.from({ length: 3 }, (_, index) => {
      const angle = candidate.angle + group.rotation + index * 120, rad = angle * Math.PI / 180;
      return { d, x: round(100 + (group.x ?? 0) + Math.cos(rad) * candidate.radius * group.scale),
        y: round(100 + (group.y ?? 0) + Math.sin(rad) * candidate.radius * group.scale),
        rotation: angle + candidate.tilt, index: groupIndex * 3 + index, unitScale: group.scale };
    })) : Array.from({ length: count }, (_, index) => {
    if (candidate.kind === 'fan') {
      const angle = candidate.angles[index], rad = angle * Math.PI / 180;
      const baseX = (index - 1) * 8;
      return { d, x: round(100 + baseX + Math.cos(rad) * length / 2), y: round(145 + Math.sin(rad) * length / 2), rotation: angle, index };
    }
    if (candidate.kind === 'book') {
      // Bilateral pairing: the lower tips form an open-book spine.
      const angles = [-154, -112, -68, -26];
      const angle = angles[index];
      const baseX = index < 2 ? -7 : 7;
      const baseY = index === 0 || index === 3 ? 29 : 33;
      const rad = angle * Math.PI / 180;
      return { d, x: round(100 + baseX + Math.cos(rad) * length / 2), y: round(100 + baseY + Math.sin(rad) * length / 2), rotation: angle, index };
    }
    const angle = candidate.angle + index * 360 / count;
    const rad = angle * Math.PI / 180;
    const radius = candidate.kind === 'radial' ? candidate.radius + length / 2 : candidate.radius;
    return { d, x: round(100 + Math.cos(rad) * radius), y: round(100 + Math.sin(rad) * radius), rotation: angle + (candidate.tilt || 0), index };
  });
  // Equal optical canvas: center the actual ink bounds and fit their longer
  // dimension to 156 units. The same authored curves are sampled for this fit.
  const points = leaves.flatMap(leaf => {
    const angle = leaf.rotation * Math.PI / 180;
    const unitScale = leaf.unitScale ?? 1;
    return unit.points.map(({ x, y }) => ({
      x: leaf.x + unitScale * (x * Math.cos(angle) - y * Math.sin(angle)),
      y: leaf.y + unitScale * (x * Math.sin(angle) + y * Math.cos(angle)),
    }));
  });
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  // A cyclic mark stays on its shared center, rather than shifting with its
  // asymmetric bounding box. It then has one stable axis for future motion.
  const radialFit = candidate.fit === 'radial';
  const scale = radialFit ? 78 / Math.max(...points.map(point => Math.hypot(point.x - 100, point.y - 100))) : 156 / Math.max(maxX - minX, maxY - minY);
  const centerX = radialFit ? 100 : (minX + maxX) / 2;
  const centerY = radialFit ? 100 : (minY + maxY) / 2;
  return leaves.map(leaf => {
    const normalizedUnit = getLeafUnitGeometry(candidate, scale * (leaf.unitScale ?? 1));
    return { ...leaf, half: normalizedUnit.half, curve: normalizedUnit.curve,
      x: round(100 + (leaf.x - centerX) * scale), y: round(100 + (leaf.y - centerY) * scale),
      d: normalizedUnit.d };
  });
}

// The underpassing tip ends inside the next leaf rather than reappearing as
// a detached sliver after the crossing. The original two-arc leaf stays intact.
export function getKnotUnderCut(leaf, over) {
  const angle = leaf.rotation * Math.PI / 180;
  return round((over.x - leaf.x) * Math.cos(angle) + (over.y - leaf.y) * Math.sin(angle));
}

export function exportMarkSvg(candidate, color = '#34768D') {
  const leaves = getLeafGeometry(candidate);
  const path = leaf => `<path d="${leaf.d}" transform="translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})"/>`;
  // Cyclic over/under: each leaf passes below the next and above the previous.
  // Luminance masks keep every crossing gap transparent on any background.
  const defs = candidate.kind === 'knot' ? `<defs>${leaves.map((leaf, i) => {
    const over = leaves[(i + 1) % leaves.length];
    return `<mask id="bb-knot-${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200" style="mask-type:luminance"><rect width="200" height="200" fill="white"/><rect x="${getKnotUnderCut(leaf, over)}" y="-200" width="400" height="400" transform="translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})" fill="black"/><path d="${over.d}" transform="translate(${over.x} ${over.y}) rotate(${over.rotation})" fill="black" stroke="black" stroke-width="${candidate.seam ?? 3}" stroke-linejoin="round"/></mask>`;
  }).join('')}</defs>` : '';
  const paths = leaves.map((leaf, i) => candidate.kind === 'knot' ? `<g mask="url(#bb-knot-${i})">${path(leaf)}</g>` : path(leaf)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="${color}" role="img" aria-label="Bambook ${candidate.name}"><title>Bambook — ${candidate.name}（候选）</title>${defs}${paths}</svg>\n`;
}
