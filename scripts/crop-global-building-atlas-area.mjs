#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const sourcePath = args.get('--source') || 'tmp/gba/zhangjiagang-gba-buildings-source.geojson';
const outName = args.get('--name') || 'junma-plaza';
const outputDir = args.get('--out-dir') || 'public/data';
const centerArg = args.get('--center') || '120.513226,31.867706';
const radiusMeters = Number(args.get('--radius') || 800);
const bboxArg = args.get('--bbox');

const METERS_PER_DEGREE_LAT = 111_320;

function usage() {
  console.error(`Usage:
  node scripts/crop-global-building-atlas-area.mjs --name junma-plaza --center 120.513226,31.867706 --radius 800
  node scripts/crop-global-building-atlas-area.mjs --name custom --bbox 120.50,31.86,120.53,31.88

Options:
  --source   Source GBA GeoJSON. Default tmp/gba/zhangjiagang-gba-buildings-source.geojson
  --out-dir  Output directory. Default public/data
`);
}

function parsePair(value) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function parseBbox(value) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

function resolveBbox() {
  if (bboxArg) return parseBbox(bboxArg);
  const center = parsePair(centerArg);
  if (!center || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return null;
  const [lon, lat] = center;
  const lonDelta = radiusMeters / (METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  const latDelta = radiusMeters / METERS_PER_DEGREE_LAT;
  return {
    west: lon - lonDelta,
    south: lat - latDelta,
    east: lon + lonDelta,
    north: lat + latDelta,
  };
}

function featureBbox(feature) {
  const coords = [];
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      coords.push(value);
      return;
    }
    value.forEach(collect);
  };
  collect(feature.geometry?.coordinates);
  if (!coords.length) return null;
  const xs = coords.map((coord) => coord[0]);
  const ys = coords.map((coord) => coord[1]);
  return {
    west: Math.min(...xs),
    south: Math.min(...ys),
    east: Math.max(...xs),
    north: Math.max(...ys),
  };
}

function intersects(a, b) {
  return a.east >= b.west && a.west <= b.east && a.north >= b.south && a.south <= b.north;
}

const bbox = resolveBbox();
if (!bbox) {
  usage();
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`Missing source GeoJSON: ${sourcePath}`);
  process.exit(2);
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const features = (source.features || []).filter((feature) => {
  const fb = featureBbox(feature);
  return fb && intersects(fb, bbox);
});

fs.mkdirSync(outputDir, { recursive: true });
const sourceOut = path.join(outputDir, `${outName}-gba-buildings.geojson`);
const renderOut = path.join(outputDir, `${outName}-gba-buildings-render.geojson`);
const pmtilesOut = path.join(outputDir, `${outName}-gba-buildings.pmtiles`);

fs.writeFileSync(sourceOut, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`);

const result = spawnSync('node', [
  'scripts/build-global-building-atlas-tiles.mjs',
  sourceOut,
  renderOut,
  pmtilesOut,
], { stdio: 'inherit' });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify({
  name: outName,
  bbox,
  features: features.length,
  source: sourceOut,
  render: renderOut,
  pmtiles: pmtilesOut,
}, null, 2));
