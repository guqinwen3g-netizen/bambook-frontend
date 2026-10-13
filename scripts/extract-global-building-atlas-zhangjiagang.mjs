#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const inputPath = process.argv[2] || 'tmp/gba/e120_n35_e125_n30.parquet';
const outputPath = process.argv[3] || 'tmp/gba/zhangjiagang-gba-buildings-source.geojson';

const bbox = {
  west: Number(process.env.ZJG_BBOX_WEST || 120.36),
  south: Number(process.env.ZJG_BBOX_SOUTH || 31.72),
  east: Number(process.env.ZJG_BBOX_EAST || 120.78),
  north: Number(process.env.ZJG_BBOX_NORTH || 32.05),
};

const python = process.env.PYTHON || 'python3';
const worker = `
import json
import struct
import sys

import pyarrow.parquet as pq

input_path, output_path, west, south, east, north = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:])

def read_uint32(data, offset, endian):
    return struct.unpack_from(endian + 'I', data, offset)[0], offset + 4

def read_double(data, offset, endian):
    return struct.unpack_from(endian + 'd', data, offset)[0], offset + 8

def parse_point(data, offset, endian):
    x, offset = read_double(data, offset, endian)
    y, offset = read_double(data, offset, endian)
    return [round(x, 7), round(y, 7)], offset

def parse_ring(data, offset, endian):
    count, offset = read_uint32(data, offset, endian)
    points = []
    for _ in range(count):
        point, offset = parse_point(data, offset, endian)
        points.append(point)
    return points, offset

def parse_polygon_payload(data, offset, endian):
    rings_count, offset = read_uint32(data, offset, endian)
    rings = []
    for _ in range(rings_count):
        ring, offset = parse_ring(data, offset, endian)
        rings.append(ring)
    return rings, offset

def parse_wkb(data, offset=0):
    endian_flag = data[offset]
    offset += 1
    endian = '<' if endian_flag == 1 else '>'
    geom_type, offset = read_uint32(data, offset, endian)
    geom_type = geom_type % 1000
    if geom_type == 3:
        rings, offset = parse_polygon_payload(data, offset, endian)
        return {'type': 'Polygon', 'coordinates': rings}, offset
    if geom_type == 6:
        polygon_count, offset = read_uint32(data, offset, endian)
        polygons = []
        for _ in range(polygon_count):
            polygon, offset = parse_wkb(data, offset)
            if polygon['type'] == 'Polygon':
                polygons.append(polygon['coordinates'])
        return {'type': 'MultiPolygon', 'coordinates': polygons}, offset
    raise ValueError(f'Unsupported WKB geometry type: {geom_type}')

def first_ring(geometry):
    if geometry['type'] == 'Polygon':
        return geometry['coordinates'][0] if geometry['coordinates'] else []
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates'][0][0] if geometry['coordinates'] and geometry['coordinates'][0] else []
    return []

def ring_area(ring):
    if len(ring) < 4:
        return 0
    area = 0
    for a, b in zip(ring, ring[1:]):
        area += a[0] * b[1] - b[0] * a[1]
    return abs(area / 2)

table = pq.read_table(input_path, columns=['source', 'id', 'height', 'var', 'region', 'bbox', 'geometry'])
features = []
for row in table.to_pylist():
    bbox = row.get('bbox') or {}
    if bbox.get('xmax') is None or bbox.get('xmin') is None or bbox.get('ymax') is None or bbox.get('ymin') is None:
        continue
    if bbox['xmax'] < west or bbox['xmin'] > east or bbox['ymax'] < south or bbox['ymin'] > north:
        continue
    geometry_blob = row.get('geometry')
    if not geometry_blob:
        continue
    try:
        geometry, _ = parse_wkb(bytes(geometry_blob))
    except Exception:
        continue
    ring = first_ring(geometry)
    if ring_area(ring) <= 0:
        continue
    height = row.get('height')
    try:
        height = float(height)
    except Exception:
        height = None
    features.append({
        'type': 'Feature',
        'properties': {
            'source': row.get('source') or 'GlobalBuildingAtlas',
            'id': row.get('id'),
            'height': height,
            'var': row.get('var'),
            'region': row.get('region'),
        },
        'geometry': geometry,
    })

collection = {'type': 'FeatureCollection', 'features': features}
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(collection, handle, ensure_ascii=False, separators=(',', ':'))
    handle.write('\\n')
print(json.dumps({'features': len(features), 'output': output_path}, ensure_ascii=False))
`;

if (!fs.existsSync(inputPath)) {
  console.error(`Missing source parquet: ${inputPath}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const workerPath = path.join(os.tmpdir(), `extract-gba-${process.pid}.py`);
fs.writeFileSync(workerPath, worker);

const result = spawnSync(python, [
  workerPath,
  inputPath,
  outputPath,
  String(bbox.west),
  String(bbox.south),
  String(bbox.east),
  String(bbox.north),
], { stdio: 'inherit' });

fs.rmSync(workerPath, { force: true });
process.exit(result.status ?? 1);
