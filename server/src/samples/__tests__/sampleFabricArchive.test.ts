import { describe, expect, it } from 'vitest';
import { groupFabricArchiveRows, type FabricArchiveSource } from '../sampleFabricArchive';

function row(input: Partial<FabricArchiveSource> & { id: string; unit?: string; quantity?: number; availableQty?: number; length?: string; availableLength?: string; location?: string | null; batch?: any; asset?: any; version?: any; sample?: any }): FabricArchiveSource {
  const { id, unit = '份', quantity = 1, availableQty = quantity, length, availableLength, location = '柜 A', batch = null, asset = null, version = null, sample = null, ...other } = input;
  return {
    visibility: 'full',
    card: {
      id, code: `SC-${id}`, name: '棉斜纹', cardType: 'fabric', status: 'in_stock', unit, quantity, availableQty, location,
      productAssetId: asset?.id ?? null, sampleId: null, batchId: batch?.id ?? null,
      physicalLengthQty: length ?? null, availableLengthQty: availableLength ?? null,
      createdAt: 1,
    },
    metadata: { sampleKind: 'dev_lab_dip' },
    context: { status: 'resolved', businessLine: 'fabric', reasons: [] },
    productAsset: asset,
    version,
    batch,
    sample,
    ...other,
  };
}

describe('fabric sample archive projection', () => {
  it('groups all forms for one product without combining unlike units or manual locations', () => {
    const asset = { id: 'PA-FAB', name: '斜纹布', sku: 'FAB-001', mainCategory: 'Fabric' };
    const groups = groupFabricArchiveRows([
      row({ id: 'COLOR-A', asset, quantity: 3, availableQty: 2, location: '挂杆 1' }),
      row({ id: 'COLOR-B', asset, quantity: 2, availableQty: 2, location: '柜 2' }),
      row({ id: 'YARDAGE-A', asset, batch: { id: 'B-Y', sampleType: 'yardage' }, metadata: { sampleKind: 'dev_yardage' }, unit: '米', quantity: 1, availableQty: 1, length: '12.5', availableLength: '8.25' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ identityKind: 'product', name: '斜纹布', code: 'FAB-001', productAssetId: 'PA-FAB', members: expect.arrayContaining([expect.objectContaining({ id: 'COLOR-A' }), expect.objectContaining({ id: 'YARDAGE-A', total: '12.5', available: '8.25' })]) });
    const cards = groups[0].forms.find(form => form.kind === '色样');
    expect(cards).toMatchObject({ total: '5', available: '4', unit: '份', locations: expect.arrayContaining([
      { location: '挂杆 1', total: '3', available: '2', memberIds: ['COLOR-A'] },
      { location: '柜 2', total: '2', available: '2', memberIds: ['COLOR-B'] },
    ]) });
    expect(groups[0].forms.find(form => form.kind === '米样')).toMatchObject({ total: '12.5', available: '8.25', unit: '米' });
  });

  it('groups unproductized samples by exact development version, not by development case or similar name', () => {
    const groups = groupFabricArchiveRows([
      row({ id: 'V1-COLOR', batch: { id: 'B1', sampleVersionId: 'VER-1', sampleType: 'lab-dip', versionLabel: 'R1-A' }, version: { versionLabel: 'R1-A' } }),
      row({ id: 'V1-YARDAGE', batch: { id: 'B2', sampleVersionId: 'VER-1', sampleType: 'yardage', versionLabel: 'R1-A' }, version: { versionLabel: 'R1-A' }, metadata: { sampleKind: 'dev_yardage' }, unit: '米', length: '2', availableLength: '1.5' }),
      row({ id: 'V2-COLOR', batch: { id: 'B3', sampleVersionId: 'VER-2', sampleType: 'lab-dip', versionLabel: 'R1-B' }, version: { versionLabel: 'R1-B' } }),
      row({ id: 'MANUAL-A' }), row({ id: 'MANUAL-B' }),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.find(group => group.developmentSampleVersionId === 'VER-1')?.forms.map(form => form.kind).sort()).toEqual(['米样', '色样']);
    expect(groups.find(group => group.developmentSampleVersionId === 'VER-2')?.members.map(member => member.id)).toEqual(['V2-COLOR']);
    expect(groups.filter(group => group.identityKind === 'physical-item')).toHaveLength(2);
  });

  it('does not merge distinct unresolved factory batches through a shared logical sample identity', () => {
    const groups = groupFabricArchiveRows([
      row({ id: 'BATCH-A', sample: { id: 'SAME-SAMPLE', name: '同一面料' }, batch: { id: 'BATCH-A', batchCode: 'R1-A' } }),
      row({ id: 'BATCH-B', sample: { id: 'SAME-SAMPLE', name: '同一面料' }, batch: { id: 'BATCH-B', batchCode: 'R2-A' } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.code).sort()).toEqual(['R1-A', 'R2-A']);
  });

  it('keeps catalog-only rows isolated and never copies their private sample names into archive summaries', () => {
    const groups = groupFabricArchiveRows([{
      visibility: 'catalog', card: { id: 'HIDDEN', code: 'SC-HIDDEN', name: 'PRIVATE FABRIC NAME', cardType: 'fabric', quantity: 9, availableQty: 9, unit: '份', location: 'PRIVATE LOCATION' },
      context: { status: 'unresolved', businessLine: null, reasons: ['OWNERSHIP_NOT_RECORDED'] },
    }]);
    expect(groups[0]).toMatchObject({ visibility: 'catalog', identityKind: 'catalog-item', name: '受限实物记录', members: [], forms: [] });
    expect(JSON.stringify(groups)).not.toContain('PRIVATE FABRIC NAME');
    expect(JSON.stringify(groups)).not.toContain('PRIVATE LOCATION');
  });
});

it('preserves legacy structured locations and sums decimal manual segments without per-card identities',()=>{
 const asset={id:'PA-MANUAL',name:'留样面料',sku:'F-1',mainCategory:'Fabric'};
 const first=row({id:'A',asset,unit:'米',length:'0.1',availableLength:'0.1',location:null,metadata:{sampleKind:'sales_stock_yardage'}});
 first.card.locationDetail={zone:'办公室',shelf:'历史A',level:'2',bin:'3'};
 const second=row({id:'B',asset,unit:'米',length:'0.2',availableLength:'0.2',location:'挂杆旁',metadata:{sampleKind:'sales_stock_yardage'}});
 const groups=groupFabricArchiveRows([first,second]);
 expect(groups).toHaveLength(1);expect(groups[0].forms[0]).toMatchObject({total:'0.3',available:'0.3'});
 expect(groups[0].members[0].location).toBe('区 办公室 · 架 历史A · 层 2 · 格 3');
});
