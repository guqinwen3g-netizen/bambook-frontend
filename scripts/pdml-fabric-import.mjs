#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { enforceNonProdTarget } from './lib/prodTargetGuard.mjs';

const DEFAULT_PDML_ENDPOINT = 'https://pdml.jiangsupanda.com/api/myapi/apidoing';
const DEFAULT_BAMBOOK_ENDPOINT = 'https://jiangsupanda.com/bambook';
const DEFAULT_GSID = '6';

const args = new Set(process.argv.slice(2));
const argValue = (name, fallback = undefined) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const pageSize = Number(argValue('--page-size', '500'));
const limitArg = argValue('--limit');
const limit = limitArg ? Number(limitArg) : args.has('--all') ? Infinity : 25;
const gsid = argValue('--gsid', DEFAULT_GSID);
const pdmlEndpoint = argValue('--pdml-endpoint', process.env.PDML_ENDPOINT || DEFAULT_PDML_ENDPOINT);
// 两条腿默认都在外部（PDML 读、bambook 写）⇒ 任一条都要显式授权，见 §9 B281/B282
enforceNonProdTarget(pdmlEndpoint, { what: 'pdml-fabric-import 读取的 PDML 端点' });
const pdmlBridgeKey = String(argValue('--pdml-bridge-key', process.env.PDML_BRIDGE_KEY || '')).trim();
const outDir = path.resolve(argValue('--out-dir', 'data/pdml-fabric-import'));
const shouldImport = args.has('--api-import');
const shouldMapBambook = args.has('--map-bambook');
const endpoint = (argValue('--endpoint', process.env.VITE_CLOUD_ENDPOINT || process.env.BAMBOOK_ENDPOINT || DEFAULT_BAMBOOK_ENDPOINT)).replace(/\/$/, '');
enforceNonProdTarget(endpoint, { what: 'pdml-fabric-import 写入的 bambook 端点' });
const apiKey = process.env.BAMBOOK_SDK_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';

if (!Number.isFinite(pageSize) || pageSize <= 0) {
  throw new Error('--page-size must be a positive number');
}

if (!Number.isFinite(limit) && !args.has('--all')) {
  throw new Error('--limit must be a positive number, or pass --all');
}

if (shouldImport && !apiKey) {
  throw new Error('API key required for --api-import. Set BAMBOOK_SDK_KEY, BAMBOOK_API_KEY, or VITE_BAMBOOK_API_KEY.');
}

if (shouldImport && !shouldMapBambook) {
  throw new Error('Pass --map-bambook with --api-import. Raw PDML export is the default; Bambook mapping is explicit.');
}

const sqlLiteral = (value) => String(value ?? '').replaceAll("'", "''");
const sqlWhere = () => `AND GSID = '${sqlLiteral(gsid)}'`;

async function pdmlSelect(sql) {
  const res = await fetch(pdmlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...(pdmlBridgeKey ? { 'X-PDML-Bridge-Key': pdmlBridgeKey } : {}),
    },
    body: JSON.stringify({
      Doing: 'select',
      SQL: sql,
      ZTCode: 'PDML',
      ModuleParams: {},
      Token: '111111',
    }),
  });
  const data = await res.json();
  if (!res.ok || data.ResultCode !== 'SUCCESS') {
    throw new Error(`PDML query failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data.ResultData?.SQL?.data || [];
}

async function fetchPdmlRows() {
  const countRows = await pdmlSelect(`select count(*) as CNT from V_MLXX D where 1=1 ${sqlWhere()}`);
  const total = Number(countRows[0]?.CNT || 0);
  const target = Math.min(total, limit);
  const rows = [];

  for (let skip = 0; skip < target; skip += pageSize) {
    const first = Math.min(pageSize, target - skip);
    const sql = `select first ${first} skip ${skip} D.* from V_MLXX D where 1=1 ${sqlWhere()} ORDER BY DJRQ DESC`;
    const page = await pdmlSelect(sql);
    rows.push(...page);
    process.stdout.write(`Fetched ${rows.length}/${target} PDML rows\r`);
    if (page.length < first) break;
  }
  process.stdout.write('\n');
  return { total, rows };
}

const clean = (value) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

const safeKey = (value, fallback = 'UNKNOWN') => {
  const text = clean(value) || fallback;
  const ascii = text
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  if (ascii && ascii !== '-') return ascii.slice(0, 48);
  return createHash('sha1').update(text).digest('hex').slice(0, 12).toUpperCase();
};

const parseNumber = (value) => {
  const text = clean(value);
  if (!text) return undefined;
  const parsed = Number(text.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const firstText = (...values) => values.map(clean).find(Boolean);

function parseCompositionLines(row, productId) {
  const text = clean(row.CF);
  if (!text) return [];
  return text
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const match = part.match(/^([A-Za-z]+)([0-9.]+)?$/);
      const abbreviation = match?.[1] || part;
      const percentage = Number(match?.[2] || 0);
      return {
        id: `PDML-COMP-${clean(row.ID) || productId}-${index}`,
        termId: `PDML-TERM-${abbreviation.toUpperCase()}`,
        percentage: Number.isFinite(percentage) ? percentage : 0,
        sortOrder: index,
        term: {
          id: `PDML-TERM-${abbreviation.toUpperCase()}`,
          abbreviation,
          chineseName: abbreviation,
          englishName: null,
        },
      };
    });
}

function priceRows(row, productId) {
  const rows = [];
  const pdmlId = clean(row.ID) || productId;
  const addPrice = (sourceKey, priceType, currency, unit, label) => {
    const amount = parseNumber(row[sourceKey]);
    if (!amount) return;
    rows.push({
      id: `PDML-PRICE-${pdmlId}-${priceType}-${sourceKey}`,
      priceType,
      amount,
      currency,
      unit: unit || null,
      sourceType: 'pdml',
      sourceId: pdmlId,
      effectiveDate: clean(row.DJRQ) || null,
      note: [label, clean(row.GCFKTJ) ? `付款条件=${clean(row.GCFKTJ)}` : '', clean(row.JGYXQ) ? `价格有效期=${clean(row.JGYXQ)}` : '']
        .filter(Boolean)
        .join(' | '),
    });
  };
  addPrice('GCCGDJ', 'factory', clean(row.GCBZ) || 'RMB', null, '工厂采购价');
  addPrice('RMB', 'factory', 'RMB', null, '人民币报价');
  addPrice('USD', 'factory', 'USD', null, '美金报价');
  addPrice('SYCGDJ', 'sample', clean(row.GCBZ) || 'RMB', null, '样衣/试样采购价');
  return rows;
}

function detailNotes(row) {
  const measure = (value, unit) => {
    const cleanValue = clean(value);
    if (!cleanValue) return undefined;
    return [cleanValue, clean(unit)].filter(Boolean).join('');
  };
  const priceWithCurrency = (amount, currency) => {
    const cleanAmount = clean(amount);
    if (!cleanAmount) return undefined;
    return [cleanAmount, clean(currency)].filter(Boolean).join(' ');
  };
  const detailFields = [
    ['条码', row.ID],
    ['公司品号', row.GSPH],
    ['工厂品号', row.GCPH],
    ['公司色号', row.GSSH],
    ['工厂色号', row.GCSH],
    ['颜色描述', firstText(row.YS, row.GCSH)],
    ['供应商', row.GYS],
    ['产品系列', row.CPXL],
    ['成份', row.CF],
    ['主成份', row.ZCFMC || row.ZCF],
    ['花型', row.HX],
    ['组织', row.MLZZ],
    ['纱支', row.SZ],
    ['克重', measure(row.KZ, row.KZDW)],
    ['幅宽', measure(row.FK, row.FKDW)],
    ['货位', row.YKHW],
    ['批次', firstText(row.PCH, row.GCPCH)],
    ['后整理', row.HZL],
    ['采购价', priceWithCurrency(row.GCCGDJ, row.GCBZ)],
    ['工厂起订量', row.GCQDL],
    ['人民币', row.RMB],
    ['美金', row.USD],
    ['起订量', row.QDL],
    ['价格有效期', row.JGYXQ],
    ['库存数', row.KCSL],
    ['登记日期', row.DJRQ],
    ['状态', row.ZT],
    ['制单人', row.ZDR],
    ['备注', row.NOTE],
    ['质量备注', row.ZLBZ],
    ['图片', row.TPDZ],
  ];
  return detailFields
    .map(([label, value]) => [label, clean(value)])
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}=${value}`)
    .join(' | ');
}

function toBambookPayload(row) {
  const pdmlId = clean(row.ID) || `${clean(row.GSPH) || 'UNKNOWN'}-${clean(row.GSSH) || 'NO-COLOR'}`;
  const articleNo = firstText(row.GSPH, row.GCPH, pdmlId);
  const millQuality = firstText(row.GCPH, row.GSPH, pdmlId);
  const colorCode = firstText(row.GSSH, row.GCSH);
  const colorDescription = firstText(row.YS, row.GCSH);
  const nameParts = [row.CPXL, row.GSPH, row.GSSH, row.CF].map(clean).filter(Boolean);
  const name = nameParts.length ? nameParts.join(' / ') : `PDML Fabric ${pdmlId}`;
  const stockQuantity = parseNumber(row.KCSL);

  const productId = `PDML-FAB-${pdmlId}`;
  return {
    id: productId,
    sku: pdmlId,
    name,
    mainCategory: 'Fabric',
    subCategoryId: clean(row.CPXL) ? `PDML-FAB-CAT-${safeKey(row.CPXL)}` : 'uncategorized',
    season: '',
    imageUrl: clean(row.TPDZ) || null,
    cost: parseNumber(row.RMB) || parseNumber(row.USD) || parseNumber(row.GCCGDJ) || 0,
    status: clean(row.ZT) === '通过' ? 'Active' : 'Development',
    fabricProfile: {
      id: `PDML-FP-${pdmlId}`,
      articleNo,
      millOrganizationId: clean(row.GYS) || null,
      millQuality,
      millColorCode: colorCode || null,
      colorDescription: colorDescription || null,
      construction: clean(row.MLZZ) || null,
      yarnCount: clean(row.SZ) || null,
      pattern: clean(row.HX) || null,
      weightValue: parseNumber(row.KZ) ?? null,
      weightUnit: clean(row.KZDW) || null,
      widthValue: parseNumber(row.FK) ?? null,
      widthUnit: clean(row.FKDW) || null,
      widthText: clean(row.FK) || null,
      referenceBatch: firstText(row.PCH, row.GCPCH) || null,
      stockStatus: stockQuantity && stockQuantity > 0 ? '现货' : clean(row.ZT) || null,
      stockQuantity: stockQuantity ?? null,
      stockUnit: null,
      moqValue: parseNumber(row.QDL) ?? null,
      factoryMoqValue: parseNumber(row.GCQDL) ?? null,
      sampleMoqValue: parseNumber(row.SYQDL) ?? null,
      riskNote: clean(row.ZLBZ) || null,
      specialNote: detailNotes(row),
    },
    fabricPrices: priceRows(row, productId),
    compositionLines: parseCompositionLines(row, productId),
  };
}

function toCsv(rows) {
  const headers = ['ID', 'GSPH', 'GCPH', 'GSSH', 'GCSH', 'GYS', 'CPXL', 'CF', 'ZCFMC', 'KZ', 'KZDW', 'FK', 'FKDW', 'KCSL', 'DJRQ', 'TPDZ', 'NOTE'];
  const escapeCell = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => escapeCell(row[key])).join(','))].join('\n');
}

function metadataForRows(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return {
    source: 'PDML V_MLXX raw export',
    gsid,
    rowCount: rows.length,
    columnCount: columns.length,
    generatedAt: new Date().toISOString(),
    columns: columns.map((field) => {
      const values = rows.map((row) => row[field]).filter((value) => clean(value));
      const sampleValues = [...new Set(values.map((value) => String(value)))].slice(0, 8);
      const numberLike =
        values.length > 0 && values.every((value) => Number.isFinite(Number(String(value).replaceAll(',', ''))));
      return {
        field,
        total: rows.length,
        nonEmpty: values.length,
        empty: rows.length - values.length,
        unique: new Set(values.map((value) => String(value))).size,
        typeGuess: numberLike ? 'number-like' : 'text',
        samples: sampleValues,
      };
    }),
  };
}

function apiUrl(pathName) {
  const cleanPath = pathName.startsWith('/') ? pathName : `/${pathName}`;
  return `${endpoint}${cleanPath.startsWith('/api/') ? cleanPath : `/api${cleanPath}`}`;
}

async function bambookRequest(pathName, init = {}) {
  const res = await fetch(apiUrl(pathName), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Bambook-API-Key': apiKey,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${pathName} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

async function upsertBambookPayloads(payloads) {
  await bambookRequest('/health');
  let created = 0;
  let updated = 0;
  for (const payload of payloads) {
    const existing = await fetch(apiUrl(`/v1/products/assets/${encodeURIComponent(payload.id)}`), {
      headers: { 'X-Bambook-API-Key': apiKey },
    });
    if (existing.status === 404) {
      await bambookRequest('/v1/products/assets', { method: 'POST', body: JSON.stringify(payload) });
      created += 1;
    } else if (existing.ok) {
      await bambookRequest(`/v1/products/assets/${encodeURIComponent(payload.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      updated += 1;
    } else {
      const text = await existing.text();
      throw new Error(`GET ${payload.id} failed: HTTP ${existing.status} ${text.slice(0, 500)}`);
    }
    process.stdout.write(`Imported ${created + updated}/${payloads.length} (created ${created}, updated ${updated})\r`);
  }
  process.stdout.write('\n');
  return { created, updated };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const { total, rows } = await fetchPdmlRows();
  const summary = {
    source: 'PDML V_MLXX',
    gsid,
    totalAvailable: total,
    exported: rows.length,
    generatedAt: new Date().toISOString(),
    mode: shouldMapBambook ? 'raw-plus-bambook-map' : 'raw-only',
    importReady: shouldMapBambook,
    files: {
      raw: path.join(outDir, 'pdml-raw.json'),
      metadata: path.join(outDir, 'pdml-raw-metadata.json'),
      csv: path.join(outDir, 'pdml-fabrics.csv'),
    },
  };

  await fs.writeFile(summary.files.raw, JSON.stringify(rows, null, 2));
  await fs.writeFile(summary.files.metadata, JSON.stringify(metadataForRows(rows), null, 2));
  await fs.writeFile(summary.files.csv, toCsv(rows));

  let payloads = [];
  if (shouldMapBambook) {
    payloads = rows.map(toBambookPayload);
    summary.files.payloads = path.join(outDir, 'bambook-product-payloads.json');
    await fs.writeFile(summary.files.payloads, JSON.stringify(payloads, null, 2));
  }

  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));

  if (shouldImport) {
    const result = await upsertBambookPayloads(payloads);
    console.log(`Bambook import completed: ${JSON.stringify(result)}`);
  } else {
    console.log(
      shouldMapBambook
        ? 'Mapped export only. Pass --api-import to write these payloads into Bambook.'
        : 'Raw export only. Pass --map-bambook only after the field mapping is approved.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
