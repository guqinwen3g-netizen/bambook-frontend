import { describe, expect, it } from 'vitest';
import { buildConfirmedDevelopmentSpec, type ConfirmedDevelopmentSpecInput } from '../confirmedDevelopmentSpec';
import { sampleOriginFingerprint } from '../../samples/sampleOriginService';

function fixture(family: 'fabric' | 'garment' = 'fabric'): ConfirmedDevelopmentSpecInput {
  const snapshot: any = { schemaVersion: 1,
    batch: { id: 'actual-batch', code: 'SB-1', caseId: 'actual-case', factoryId: 'actual-factory', sourceRound: 1,
      sampleType: family === 'fabric' ? 'yardage' : 'garment-round' },
    content: { caseContent: family === 'fabric'
      ? { type: 'fabric', customerRelationId: 'customer', specComposition: '60% cotton / 40% polyester', specWeight: '200 g/m²', specWidth: '60 inch', specWeave: 'TWILL', specFinish: 'PEACHED' }
      : { type: 'garment', customerRelationId: 'customer', styleSpec: 'STYLE-ACCEPTED', sizeSpec: 'SIZE-ACCEPTED', fabricSpec: 'FABRIC-ACCEPTED', processSpec: 'PROCESS-ACCEPTED' },
    specNote: 'Actual accepted sample detail' },
    version: { updatedAt: '1000', historyRevision: null, eventId: null } };
  return { sourceType: 'Sample', sourceId: 'actual-sample', caseId: 'actual-case', factoryRelationId: 'actual-factory',
    asset: { id: 'asset', sku: 'SKU-CURRENT', name: 'Catalog label', mainCategory: family === 'fabric' ? 'Fabric' : 'Garment' },
    origins: [{ snapshot, sourceFingerprint: sampleOriginFingerprint(snapshot), evidenceAuditIds: ['actual-native-approval', 'actual-origin-binding'] }] };
}
describe('confirmed specification projection from immutable evidence', () => {
  it('retains accepted fabric composition/finish and original units without converting inches to cm', () => {
    const result = buildConfirmedDevelopmentSpec(fixture());
    expect(result.specSnapshot.fabric).toMatchObject({ composition: '60% cotton / 40% polyester', finish: 'PEACHED',
      construction: 'TWILL', weightText: '200 g/m²', weightValue: 200, weightUnit: 'gsm', weightValueGsm: 200,
      widthText: '60 inch', widthValue: 60, widthUnit: 'inch', yarnCount: null, millColorCode: null });
  });
  it('does not invent units from bare accepted numbers or parse unknown unit text into a different unit', () => {
    const input = fixture(); const content: any = input.origins[0].snapshot.content.caseContent;
    content.specWeight = '200'; content.specWidth = 'full width / not recorded';
    input.origins[0].sourceFingerprint = sampleOriginFingerprint(input.origins[0].snapshot);
    expect(buildConfirmedDevelopmentSpec(input).specSnapshot.fabric).toMatchObject({ weightText: '200', weightValue: 200,
      weightUnit: null, weightValueGsm: null, widthText: 'full width / not recorded', widthValue: null, widthUnit: null });
  });
  it('retains accepted garment process and leaves unconfirmed profile extensions unknown', () => {
    expect(buildConfirmedDevelopmentSpec(fixture('garment')).specSnapshot.garment).toMatchObject({ styleNo: 'STYLE-ACCEPTED',
      sizeSpec: 'SIZE-ACCEPTED', mainFabric: 'FABRIC-ACCEPTED', processSpec: 'PROCESS-ACCEPTED', constructionNote: 'PROCESS-ACCEPTED',
      fit: null, silhouette: null, liningFabric: null, baseSize: null });
  });
  it('current catalog relabeling changes display identity but never the confirmed content fingerprint', () => {
    const input = fixture(); const first = buildConfirmedDevelopmentSpec(input);
    input.asset.name = 'Relabeled catalog'; input.asset.sku = 'SKU-RELABEL';
    const second = buildConfirmedDevelopmentSpec(input);
    expect(second.confirmedSpecification).toEqual(first.confirmedSpecification);
    expect(second.specSnapshot.fabric).toEqual(first.specSnapshot.fabric);
    expect(second.specSnapshot.catalogIdentity).not.toEqual(first.specSnapshot.catalogIdentity);
  });
  it.each(['fingerprint', 'case', 'factory', 'family', 'approval', 'duplicate', 'missing', 'version'])('rejects %s evidence rather than substituting current profile', attack => {
    const input = fixture(); const origin = input.origins[0];
    if (attack === 'fingerprint') origin.sourceFingerprint = 'foreign';
    if (attack === 'case') input.caseId = 'foreign';
    if (attack === 'factory') input.factoryRelationId = 'foreign';
    if (attack === 'family') input.asset.mainCategory = 'Garment';
    if (attack === 'approval') origin.evidenceAuditIds = [];
    if (attack === 'duplicate') input.origins.push(structuredClone(origin));
    if (attack === 'missing') input.origins = [];
    if (attack === 'version') origin.snapshot.version.updatedAt = 'unknown';
    expect(() => buildConfirmedDevelopmentSpec(input)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED', statusCode: 409 }));
  });
  it('retains all same-case seal components rather than selecting an arbitrary first component', () => {
    const input = fixture(); input.sourceType = 'SealSample'; const second = structuredClone(input.origins[0]);
    second.snapshot.batch.id = 'second-batch'; second.snapshot.content.specNote = 'Second accepted component';
    second.sourceFingerprint = sampleOriginFingerprint(second.snapshot); input.origins.push(second);
    expect((buildConfirmedDevelopmentSpec(input).confirmedSpecification.origins as any[])).toHaveLength(2);
    (second.snapshot.content.caseContent as any).specWeight = '999 gsm'; second.sourceFingerprint = sampleOriginFingerprint(second.snapshot);
    expect(() => buildConfirmedDevelopmentSpec(input)).toThrow(expect.objectContaining({ code: 'DEVELOPMENT_SOURCE_CHANGED' }));
  });
});
