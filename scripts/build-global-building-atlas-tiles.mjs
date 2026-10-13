#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const inputPath = process.argv[2] || 'tmp/gba/zhangjiagang-gba-buildings-source.geojson';
const renderInputPath = process.argv[3] || 'tmp/gba/zhangjiagang-gba-buildings-render.geojson';
const outputPath = process.argv[4] || 'public/data/zhangjiagang-gba-buildings.pmtiles';

const MIN_HEIGHT_METERS = 2.4;
const MAX_HEIGHT_METERS = 220;
const REPLACED_GBA_FEATURES = [
  {
    id: '51458',
    bbox: {
      west: 120.50770,
      south: 31.86910,
      east: 120.50895,
      north: 31.87008,
    },
    reason: 'Replaced by user-drawn Junma Plaza twin-tower override.',
  },
];

function pickHeight(properties = {}) {
  const candidates = [
    properties.height,
    properties.Height,
    properties.real_height,
    properties.predicted_height,
    properties.height_mean,
    properties.measured_height,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function normalizeHeight(height) {
  if (!Number.isFinite(height)) return null;
  return Math.min(MAX_HEIGHT_METERS, Math.max(MIN_HEIGHT_METERS, height));
}

function hasRenderablePolygon(geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return Array.isArray(geometry.coordinates?.[0]) && geometry.coordinates[0].length >= 4;
  if (geometry.type === 'MultiPolygon') return Array.isArray(geometry.coordinates?.[0]?.[0]) && geometry.coordinates[0][0].length >= 4;
  return false;
}

function geometryCenter(geometry) {
  if (!geometry) return null;
  const coordinates = geometry.type === 'Polygon'
    ? geometry.coordinates?.flat(1)
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates?.flat(2)
      : null;
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const coordinate of coordinates) {
    const [lon, lat] = coordinate;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }
  return {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2,
  };
}

function isReplacedGbaFeature(feature) {
  const id = String(feature.properties?.id ?? '');
  const center = geometryCenter(feature.geometry);
  if (!center) return false;
  return REPLACED_GBA_FEATURES.some((replacement) => (
    id === replacement.id
    && center.lon >= replacement.bbox.west
    && center.lon <= replacement.bbox.east
    && center.lat >= replacement.bbox.south
    && center.lat <= replacement.bbox.north
  ));
}

if (!fs.existsSync(inputPath)) {
  console.error(`Missing GBA source GeoJSON: ${inputPath}`);
  console.error('Export/crop a Zhangjiagang GlobalBuildingAtlas LoD1 GeoJSON first, then rerun this script.');
  process.exit(2);
}

const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const allFeatures = Array.isArray(source.features) ? source.features : [];
const features = allFeatures.filter((feature) => !isReplacedGbaFeature(feature));
const removedFeatureCount = allFeatures.length - features.length;

const renderSource = {
  type: 'FeatureCollection',
  features: features
    .filter((feature) => hasRenderablePolygon(feature.geometry))
    .map((feature) => {
      const realHeight = pickHeight(feature.properties);
      const renderHeight = normalizeHeight(realHeight);
      return {
        ...feature,
        properties: {
          ...feature.properties,
          source: feature.properties?.source || 'GlobalBuildingAtlas',
          real_height: realHeight,
          render_height: renderHeight,
        },
      };
    })
    .filter((feature) => Number.isFinite(feature.properties.render_height)),
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
  '--simplification=4',
  '--simplification-at-maximum-zoom=1',
  '--no-tiny-polygon-reduction-at-maximum-zoom',
  '--force',
  '--no-feature-limit',
  '--no-tile-size-limit',
  renderInputPath,
], { stdio: 'inherit' });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${renderSource.features.length} GBA building features to ${outputPath}`);
if (removedFeatureCount > 0) {
  console.log(`Removed ${removedFeatureCount} replaced GBA building feature(s) before tiling.`);
}
