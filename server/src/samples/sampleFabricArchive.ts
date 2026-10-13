import { SAMPLE_KINDS } from '../shared/sampleLibraryMetadata';

export type FabricArchiveSource = {
  card: any;
  metadata?: any;
  context?: any;
  visibility: 'full' | 'catalog';
  productAsset?: any;
  version?: any;
  batch?: any;
  sample?: any;
  devCase?: any;
};

export type FabricArchiveMember = {
  id: string;
  code: string;
  name: string;
  cardType: string;
  status: string;
  location: string | null;
  unit: string;
  total: string | null;
  available: string | null;
  businessContext: any;
};

export type FabricArchiveForm = {
  kind: string;
  unit: string;
  total: string | null;
  available: string | null;
  locations: Array<{
    location: string | null;
    total: string | null;
    available: string | null;
    memberIds: string[];
  }>;
};

export type FabricArchiveGroup = {
  visibility: 'full' | 'catalog';
  id: string;
  identityKind: 'product' | 'development-version' | 'sample' | 'batch' | 'physical-item' | 'catalog-item';
  name: string;
  code: string;
  productAssetId: string | null;
  developmentSampleVersionId: string | null;
  sourceLabel: string | null;
  members: FabricArchiveMember[];
  forms: FabricArchiveForm[];
  businessContext: any;
  createdAt: unknown;
};

type ArchiveIdentity = {
  key: string;
  kind: 'product' | 'development-version' | 'sample' | 'batch' | 'physical-item' | 'catalog-item';
  name: string;
  code: string;
  productAssetId: string | null;
  versionId: string | null;
  sourceLabel: string | null;
};

function isFabricProduct(asset: any) {
  const category = String(asset?.mainCategory ?? '').trim().toLowerCase();
  return category === 'fabric' || category === '面料';
}

function exactScaled(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(4, '0');
  const result = BigInt(match[2]) * BigInt(10000) + BigInt(fraction || '0');
  return match[1] === '-' ? -result : result;
}

function amount(value: unknown, unit: string): string | null {
  if (unit === '米' || unit.toUpperCase() === 'M') {
    const scaled = exactScaled(value);
    return scaled === null ? null : printScaled(scaled);
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
  return String(value);
}

function printScaled(value: bigint) {
  const sign = value < 0 ? '-' : '';
  const absolute = value < 0 ? -value : value;
  const whole = absolute / BigInt(10000);
  const fraction = (absolute % BigInt(10000)).toString().padStart(4, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function sumKnown(values: Array<string | null>, unit: string): string | null {
  if (!values.length || values.some(value => value === null)) return null;
  if (unit === '米' || unit.toUpperCase() === 'M') {
    return printScaled(values.reduce((sum, value) => sum + (exactScaled(value) ?? BigInt(0)), BigInt(0)));
  }
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return Number.isSafeInteger(total) ? String(total) : null;
}

function identity(row: FabricArchiveSource): ArchiveIdentity {
  const card = row.card;
  const asset = row.productAsset;
  const productAssetId = card.productAssetId || row.sample?.productAssetId;
  if (typeof productAssetId === 'string' && productAssetId && isFabricProduct(asset)) {
    return { key: `product:${productAssetId}`, kind: 'product' as const, name: String(asset.name || card.name), code: String(asset.sku || card.code), productAssetId, versionId: null, sourceLabel: '产品档案' };
  }
  if (row.batch?.sampleVersionId) {
    const version = row.version;
    const label = String(version?.versionLabel || row.batch?.versionLabel || row.batch?.batchCode || card.code);
    return { key: `development-version:${row.batch.sampleVersionId}`, kind: 'development-version' as const, name: String(row.devCase?.name || row.devCase?.code || card.name), code: label, productAssetId: null, versionId: String(row.batch.sampleVersionId), sourceLabel: '开发版本' };
  }
  if (typeof card.batchId === 'string' && card.batchId) {
    return { key: `batch:${card.batchId}`, kind: 'batch' as const, name: String(card.name), code: String(row.batch?.batchCode || card.code), productAssetId: null, versionId: null, sourceLabel: '开发批次' };
  }
  if (typeof card.sampleId === 'string' && card.sampleId) {
    return { key: `sample:${card.sampleId}`, kind: 'sample' as const, name: String(row.sample?.name || card.name), code: String(row.sample?.code || card.code), productAssetId: null, versionId: null, sourceLabel: '业务样品' };
  }
  return { key: `physical-item:${card.id}`, kind: 'physical-item' as const, name: String(card.name || card.code), code: String(card.code), productAssetId: null, versionId: null, sourceLabel: null };
}

function formKind(row: FabricArchiveSource) {
  const kind = SAMPLE_KINDS.find(candidate => candidate.value === row.metadata?.sampleKind);
  if (kind) return kind.label;
  const native = String(row.batch?.sampleType || '').trim();
  const nativeLabels: Record<string, string> = {
    'lab-dip': '色样', handloom: '手织样', yardage: '米样', 'garment-round': '成衣样',
    pioneer: '先锋样', ship: '船样', head: '匹头样', pp: '产前样',
  };
  return nativeLabels[native] || String(row.metadata?.category || row.card.cardType || '其他形态').trim() || '其他形态';
}

function member(row: FabricArchiveSource): FabricArchiveMember {
  const card = row.card;
  const unit = String(card.unit || '单位待核');
  const isLength = unit === '米' || unit.toUpperCase() === 'M';
  return {
    id: String(card.id), code: String(card.code), name: String(card.name || card.code), cardType: String(card.cardType), status: String(card.status || '状态待核'),
    location: (typeof card.location === 'string' && card.location.trim() ? card.location.trim() : null) || [card.locationDetail?.zone && `区 ${card.locationDetail.zone}`, card.locationDetail?.shelf && `架 ${card.locationDetail.shelf}`, card.locationDetail?.level && `层 ${card.locationDetail.level}`, card.locationDetail?.bin && `格 ${card.locationDetail.bin}`].filter(Boolean).join(' · ') || null,
    unit,
    total: amount(isLength ? card.physicalLengthQty : card.quantity, unit),
    available: amount(isLength ? card.availableLengthQty : card.availableQty, unit),
    businessContext: row.context ?? { status: 'unresolved', businessLine: null, reasons: ['OWNERSHIP_NOT_RECORDED'] },
  };
}

/** Read-only archive projection. It never writes, merges or copies SampleCardItem inventory. */
export function groupFabricArchiveRows(rows: FabricArchiveSource[]): FabricArchiveGroup[] {
  const grouped = new Map<string, { identity: ReturnType<typeof identity>; rows: FabricArchiveSource[] }>();
  for (const row of rows) {
    if (row.visibility === 'catalog') {
      grouped.set(`catalog:${row.card.id}`, {
        identity: { key: `catalog:${row.card.id}`, kind: 'catalog-item', name: '受限实物记录', code: String(row.card.code), productAssetId: null, versionId: null, sourceLabel: null },
        rows: [row],
      });
      continue;
    }
    const selected = identity(row), current = grouped.get(selected.key);
    if (current) current.rows.push(row);
    else grouped.set(selected.key, { identity: selected, rows: [row] });
  }

  return [...grouped.values()].map(({ identity: selected, rows: archiveRows }) => {
    if (archiveRows[0].visibility === 'catalog') {
      const context = archiveRows[0].context ?? { status: 'unresolved', businessLine: null, reasons: ['OWNERSHIP_NOT_RECORDED'] };
      return {
        visibility: 'catalog' as const, id: selected.key, identityKind: selected.kind, name: selected.name, code: selected.code,
        productAssetId: null, developmentSampleVersionId: null, sourceLabel: null, members: [], forms: [],
        businessContext: context, createdAt: archiveRows[0].card.createdAt,
      };
    }
    const members = archiveRows.map(member);
    const forms = new Map<string, { kind: string; unit: string; members: FabricArchiveMember[] }>();
    for (let index = 0; index < archiveRows.length; index++) {
      const source = archiveRows[index], row = members[index], kind = formKind(source);
      const key = `${kind}\u0000${row.unit}`;
      const group = forms.get(key) ?? { kind, unit: row.unit, members: [] };
      group.members.push(row);
      forms.set(key, group);
    }
    const formRows: FabricArchiveForm[] = [...forms.values()].map(group => {
      const locations = new Map<string, FabricArchiveMember[]>();
      for (const item of group.members) {
        const key = item.location ?? '\u0000';
        const rowsAtLocation = locations.get(key) ?? [];
        rowsAtLocation.push(item);
        locations.set(key, rowsAtLocation);
      }
      const sums = (items: FabricArchiveMember[]) => ({
        total: sumKnown(items.map(item => item.total), group.unit),
        available: sumKnown(items.map(item => item.available), group.unit),
      });
      const overall = sums(group.members);
      return {
        kind: group.kind, unit: group.unit, total: overall.total, available: overall.available,
        locations: [...locations].map(([key, items]) => ({
          location: key === '\u0000' ? null : key, ...sums(items), memberIds: items.map(item => item.id),
        })).sort((a, b) => String(a.location ?? '').localeCompare(String(b.location ?? ''), 'zh-CN')),
      };
    }).sort((a, b) => a.kind.localeCompare(b.kind, 'zh-CN') || a.unit.localeCompare(b.unit, 'zh-CN'));
    const contextRows = members.map(item => item.businessContext).filter(Boolean);
    const lines = [...new Set(contextRows.map(context => context.businessLine).filter(Boolean))];
    const allResolved = contextRows.length === members.length && contextRows.every(context => context.status === 'resolved');
    const allUnresolved = contextRows.every(context => context.status === 'unresolved');
    const businessContext = {
      status: allResolved && lines.length === 1 ? 'resolved' : allUnresolved ? 'unresolved' : 'conflict',
      businessLine: allResolved && lines.length === 1 ? lines[0] : null,
      reasons: [...new Set(contextRows.flatMap(context => context.reasons ?? []))],
    };
    const representative = archiveRows[0];
    const createdAt = archiveRows.reduce((latest, row) => Number(row.card.createdAt ?? 0) > Number(latest ?? 0) ? row.card.createdAt : latest, representative.card.createdAt);
    return {
      visibility: archiveRows[0].visibility,
      id: selected.key,
      identityKind: selected.kind,
      name: selected.name,
      code: selected.code,
      productAssetId: selected.productAssetId,
      developmentSampleVersionId: selected.versionId,
      sourceLabel: selected.sourceLabel,
      members,
      forms: formRows,
      businessContext,
      createdAt,
    };
  });
}
