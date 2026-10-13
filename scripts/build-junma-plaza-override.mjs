#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT_PATH = resolve(process.cwd(), 'public/data/zhangjiagang-building-overrides.geojson');
const ORIGIN_LAT = 31.86805;
const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const JUNMA_WEST_SHIFT_DEGREES = 0;

function roundCoord(value) {
  return Number(value.toFixed(7));
}

function offsetPoint([lon, lat], eastMeters, northMeters) {
  return [
    roundCoord(lon + eastMeters / METERS_PER_DEGREE_LON),
    roundCoord(lat + northMeters / METERS_PER_DEGREE_LAT),
  ];
}

function orientedRect(center, widthMeters, depthMeters, angleDegrees) {
  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [
    [-widthMeters / 2, -depthMeters / 2],
    [widthMeters / 2, -depthMeters / 2],
    [widthMeters / 2, depthMeters / 2],
    [-widthMeters / 2, depthMeters / 2],
  ].map(([x, y]) => {
    const east = x * cos - y * sin;
    const north = x * sin + y * cos;
    return offsetPoint(center, east, north);
  });
  return [...corners, corners[0]];
}

function rotateLocalPoint([x, y], angleDegrees) {
  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - y * sin, x * sin + y * cos];
}

function chamferedRect(center, widthMeters, depthMeters, angleDegrees, chamferCorners = []) {
  const w = widthMeters / 2;
  const d = depthMeters / 2;
  const c = Math.min(widthMeters, depthMeters) * 0.18;
  const points = [];
  const corners = [
    { key: 'sw', a: [-w + c, -d], b: [-w, -d + c], p: [-w, -d] },
    { key: 'nw', a: [-w, d - c], b: [-w + c, d], p: [-w, d] },
    { key: 'ne', a: [w - c, d], b: [w, d - c], p: [w, d] },
    { key: 'se', a: [w, -d + c], b: [w - c, -d], p: [w, -d] },
  ];
  for (const corner of corners) {
    if (chamferCorners.includes(corner.key)) {
      points.push(corner.a, corner.b);
    } else {
      points.push(corner.p);
    }
  }
  const ring = points.map(point => {
    const [east, north] = rotateLocalPoint(point, angleDegrees);
    return offsetPoint(center, east, north);
  });
  return [...ring, ring[0]];
}

function feature(id, name, center, width, depth, angle, height, options = {}) {
  const shiftedCenter = [center[0] - JUNMA_WEST_SHIFT_DEGREES, center[1]];
  const ring = options.chamferCorners
    ? chamferedRect(shiftedCenter, width, depth, angle, options.chamferCorners)
    : orientedRect(shiftedCenter, width, depth, angle);
  return {
    type: 'Feature',
    properties: {
      id,
      override_id: id,
      name,
      source: 'BambookManualOverride',
      replacement_for: 'junma-plaza-gba',
      real_height: height,
      render_height: options.renderHeight ?? height,
      height,
      min_height: options.minHeight ?? 0,
      part: options.part ?? 'tower',
      note: 'Manual white-massing override based on user-provided Baidu Maps visual reference; not a copied Baidu model asset.',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}

const angle = -21;
const features = [
  feature('junma-plaza-tower-a', '骏马置地广场 A Tower', [120.50812, 31.86961], 18, 76, angle, 105, {
    part: 'tower',
    renderHeight: 110,
    chamferCorners: ['nw'],
  }),
  feature('junma-plaza-tower-b', '骏马置地广场 B Tower', [120.50853, 31.86957], 20, 78, angle, 112, {
    part: 'tower',
    renderHeight: 118,
    chamferCorners: ['ne'],
  }),
  feature('junma-plaza-connector', '骏马置地广场 Connector', [120.50833, 31.86928], 58, 14, angle, 8, {
    part: 'connector',
    renderHeight: 8,
  }),
];

const geojson = {
  type: 'FeatureCollection',
  name: 'zhangjiagang-building-overrides',
  features,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(geojson, null, 2)}\n`);
console.log(`Wrote ${features.length} Junma Plaza override features to ${OUT_PATH}`);
