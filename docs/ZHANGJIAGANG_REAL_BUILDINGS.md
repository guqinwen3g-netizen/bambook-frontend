# Zhangjiagang Real Building Footprints

This note records the building-data experiments used by the Bambook route map around Zhangjiagang.

## Current Decision

- Product default: load the local GlobalBuildingAtlas PMTiles layer.
- Preferred next source: GlobalBuildingAtlas LoD1, because its own web viewer gives a cleaner Zhangjiagang LoD1 preview than the CMAB-derived block conversion.
- Runtime switch: `VITE_BAMBOOK_GLOBE_REAL_BUILDINGS_URL=gba-local` uses `public/data/zhangjiagang-gba-buildings.pmtiles`. This is also the default when the env var is absent.
- External URL switch: set `VITE_BAMBOOK_GLOBE_REAL_BUILDINGS_URL` to a `.pmtiles`, `.geojson`, TileJSON, or `{z}/{x}/{y}` vector tile URL.
- Disable switch: set `VITE_BAMBOOK_GLOBE_REAL_BUILDINGS_URL=off`.

Do not use the GlobalBuildingAtlas web viewer WFS as a production data stream. The viewer is for interactive inspection; production integration should use the official released data package, crop the Zhangjiagang area, and build a local PMTiles artifact.

## Failed Experiment: CMAB

- Dataset: CMAB, "The World's First National-Scale Multi-Attribute Building Dataset"
- Article: https://figshare.com/articles/dataset/CMAB-The_World_s_First_National-Scale_Multi-Attribute_Building_Dataset/27992417
- License: CC BY 4.0
- Download used for extraction: `jiangsu.zip` from Figshare file id `53778023`
- Local raw probe path: `tmp/building-source-probe/cmab/jiangsu.zip`

The raw probe zip is about 1.3GB and must not be committed.

## Extracted Files

- Source extraction file: `public/data/zhangjiagang-cmab-buildings-core.geojson`
- Source extraction size: about 8.1MB
- Feature count: 4652
- Extraction window: core Zhangjiagang area around Junma Land Plaza

## CMAB Runtime Tiles

- Runtime tile file: `public/data/zhangjiagang-cmab-buildings.pmtiles`
- Runtime tile size: about 1.0MB
- Source layer: `buildings`
- Zoom range: 12-16
- Runtime use: retained only as an experiment artifact. It is no longer loaded by default.

## Validation Point

The dataset includes the building around Junma Land Plaza B Tower:

- AMap lookup target: `骏马置地广场 B座`
- Coordinate used during validation: `120.512394,31.867566`
- CMAB feature id: `19650`
- Height: `43.68`

This is the first tested open data source in this project that includes the target local building. The previous Google/Microsoft/OSM PMTiles source worked technically but did not include this building.

## Why CMAB Is Not Product-Ready

- The rendered blocks look like a conversion from broad 3D/visual massing to cuboids, not precise building bodies.
- Height fidelity is not acceptable for the Zhangjiagang use case; many buildings look too high or generally wrong.
- Some features become long wall-like artifacts after extrusion.
- The current PMTiles file is a failed product-visible proof, not the final full-city delivery.
- The source GeoJSON is kept for reproducibility and regression checks; the map should not load the CMAB PMTiles source by default.
- CMAB appears aligned with the AMap validation point in this area. If the base map changes or visible offset appears, add an explicit coordinate alignment pass before broad extraction.
- Do not add fake handcrafted buildings to fill gaps. Missing buildings should be solved by source data, extraction coverage, or a documented data provider.

## GlobalBuildingAtlas Path

Use the official GlobalBuildingAtlas release to export/crop a Zhangjiagang LoD1 GeoJSON, then build local tiles:

```bash
mkdir -p tmp/gba
curl -L --fail \
  -o tmp/gba/e120_n35_e125_n30.parquet \
  https://data.source.coop/tge-labs/globalbuildingatlas-lod1/e120_n35_e125_n30.parquet

node scripts/extract-global-building-atlas-zhangjiagang.mjs
node scripts/build-global-building-atlas-tiles.mjs
```

The generated runtime artifact is:

- `public/data/zhangjiagang-gba-buildings.pmtiles`

The large intermediate files stay in `tmp/gba/`:

- `e120_n35_e125_n30.parquet`
- `zhangjiagang-gba-buildings-source.geojson`
- `zhangjiagang-gba-buildings-render.geojson`

The GBA build script intentionally avoids the CMAB exaggeration/regularization pass. It preserves the source LoD1 geometry and uses source height fields directly.
