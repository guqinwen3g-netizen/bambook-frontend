#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const inputPath = 'public/data/zhangjiagang-cmab-buildings-core.geojson';
const renderInputPath = 'public/data/zhangjiagang-cmab-buildings-render.geojson';
const outputPath = 'public/data/zhangjiagang-cmab-buildings.pmtiles';

const ORIGIN_LON = 120.55;
const ORIGIN_LAT = 31.87;
const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const SIMPLIFY_TOLERANCE_METERS = 1.7;
const MAX_RENDER_BUILDING_ASPECT_RATIO = 12;
const MIN_RENDER_BUILDING_WIDTH_METERS = 3;
const MIN_RENDER_BUILDING_AREA_METERS = 18;
const MAX_LINEAR_MASSING_ASPECT_RATIO = 4.8;
const MAX_LINEAR_MASSING_LONG_SIDE_METERS = 120;

function toMeters([lon, lat]) {
  return [(lon - ORIGIN_LON) * METERS_PER_DEGREE_LON, (lat - ORIGIN_LAT) * METERS_PER_DEGREE_LAT];
}

function fromMeters([x, y]) {
  return [
    Number((x / METERS_PER_DEGREE_LON + ORIGIN_LON).toFixed(7)),
    Number((y / METERS_PER_DEGREE_LAT + ORIGIN_LAT).toFixed(7)),
  ];
}

function pointLineDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  const projection = [start[0] + t * dx, start[1] + t * dy];
  return Math.hypot(point[0] - projection[0], point[1] - projection[1]);
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i += 1) {
    const distance = pointLineDistance(points[i], points[0], points[end]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }

  if (maxDistance <= tolerance) return [points[0], points[end]];
  return [
    ...douglasPeucker(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...douglasPeucker(points.slice(index), tolerance),
  ];
}

function ringAreaMeters(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(area / 2);
}

function principalAngle(points) {
  const centroid = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map((value) => value / points.length);
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point[0] - centroid[0];
    const dy = point[1] - centroid[1];
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function orientedBox(points, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotate = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
  const unrotate = ([x, y]) => [x * cos - y * sin, x * sin + y * cos];
  const projected = points.map(rotate);
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  const corners = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ].map(unrotate);
  return { corners, area: width * height, width, height };
}

function axisAlignedExtent(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  return {
    width,
    height,
    minSide,
    maxSide,
    aspectRatio: maxSide / Math.max(0.1, minSide),
    extentArea: width * height,
  };
}

function isRenderableBuildingGeometry(geometry) {
  if (!geometry) return false;
  const ring = geometry.type === 'MultiPolygon'
    ? geometry.coordinates?.[0]?.[0]
    : geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const projected = ring.slice(0, -1).map(toMeters);
  const area = ringAreaMeters([...projected, projected[0]]);
  const extent = axisAlignedExtent(projected);

  if (area < MIN_RENDER_BUILDING_AREA_METERS) return false;
  if (extent.aspectRatio > MAX_RENDER_BUILDING_ASPECT_RATIO && extent.minSide < MIN_RENDER_BUILDING_WIDTH_METERS) {
    return false;
  }
  if (extent.aspectRatio > MAX_LINEAR_MASSING_ASPECT_RATIO && extent.maxSide > MAX_LINEAR_MASSING_LONG_SIDE_METERS) {
    return false;
  }
  return true;
}

function regularizedRectangularRing(projected) {
  const closed = [...projected, projected[0]];
  const area = ringAreaMeters(closed);
  if (area < 18) return null;

  const angle = principalAngle(projected);
  const candidates = [
    orientedBox(projected, angle),
    orientedBox(projected, angle + Math.PI / 2),
  ].filter((candidate) => candidate.width >= 2 && candidate.height >= 2 && candidate.area > 0);

  const best = candidates.sort((a, b) => a.area - b.area)[0];
  if (!best) return null;

  const fillRatio = area / best.area;
  const shouldRegularize = fillRatio >= 0.52 && area <= 18_000;
  if (!shouldRegularize) return null;

  return best.corners;
}

function removeTinyEdges(points, minEdgeMeters = 0.85) {
  if (points.length <= 4) return points;
  const filtered = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const previous = filtered[filtered.length - 1];
    if (Math.hypot(points[i][0] - previous[0], points[i][1] - previous[1]) >= minEdgeMeters) {
      filtered.push(points[i]);
    }
  }
  return filtered.length >= 3 ? filtered : points;
}

function simplifyRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return ring;
  const projected = ring.slice(0, -1).map(toMeters);
  const regularized = regularizedRectangularRing(projected);
  if (regularized) {
    const output = regularized.map(fromMeters);
    output.push(output[0]);
    return output;
  }
  const area = ringAreaMeters([...projected, projected[0]]);
  const tolerance = area > 2_500 ? SIMPLIFY_TOLERANCE_METERS * 1.55 : SIMPLIFY_TOLERANCE_METERS;
  const simplified = removeTinyEdges(douglasPeucker([...projected, projected[0]], tolerance).slice(0, -1));
  if (simplified.length < 3) return ring;
  const output = simplified.map(fromMeters);
  output.push(output[0]);
  return output;
}

function simplifyGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon') {
    return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((polygon) => polygon.map(simplifyRing)),
    };
  }
  return geometry;
}

function renderHeight(height) {
  const value = Number(height);
  if (!Number.isFinite(value)) return 8;
  if (value <= 6) return Math.max(5, value * 1.35);
  if (value <= 12) return value * 1.85;
  if (value <= 18) return value * 2.65;
  if (value <= 28) return value * 3.5;
  if (value <= 42) return value * 4.15;
  return value * 4.7;
}

const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const renderSource = {
  ...source,
  features: source.features
    .filter((feature) => isRenderableBuildingGeometry(feature.geometry))
    .map((feature) => {
      const height = Number(feature.properties?.height ?? feature.properties?.Height);
      return {
        ...feature,
        properties: {
          ...feature.properties,
          render_height: Number(renderHeight(height).toFixed(2)),
          real_height: Number.isFinite(height) ? height : null,
        },
        geometry: simplifyGeometry(feature.geometry),
      };
    }),
};

fs.writeFileSync(renderInputPath, `${JSON.stringify(renderSource)}\n`);

const result = spawnSync('tippecanoe', [
  '-o',
  outputPath,
  '-l',
  'buildings',
  '-Z12',
  '-z17',
  '--full-detail=14',
  '--low-detail=13',
  '--simplification=12',
  '--simplification-at-maximum-zoom=5',
  '--no-tiny-polygon-reduction-at-maximum-zoom',
  '--force',
  '--no-feature-limit',
  '--no-tile-size-limit',
  renderInputPath,
], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
