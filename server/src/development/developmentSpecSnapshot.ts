import type { ExactDevelopmentVersionProof } from './developmentVersionGate';

/** Shared exact existing development asset/profile projection. No approval is inferred. */
export function buildSpecSnapshot(asset: any, exactDevelopmentVersionProof?: ExactDevelopmentVersionProof): Record<string, unknown> {
  const fp = asset?.fabricProfile ?? null;
  const gp = asset?.garmentProfile ?? null;
  const base: Record<string, unknown> = {
    sku: asset?.sku ?? null,
    name: asset?.name ?? null,
    mainCategory: asset?.mainCategory ?? null,
  };
  if (fp) {
    base.fabric = {
      articleNo: fp.articleNo, construction: fp.construction, yarnCount: fp.yarnCount,
      pattern: fp.pattern, weightValue: fp.weightValue, weightValueGsm: fp.weightValueGsm,
      weightUnit: fp.weightUnit, widthValue: fp.widthValue, widthUnit: fp.widthUnit,
      millQuality: fp.millQuality, millColorCode: fp.millColorCode,
    };
  }
  if (gp) {
    base.garment = {
      styleNo: gp.styleNo, silhouette: gp.silhouette, fit: gp.fit, mainFabric: gp.mainFabric,
      liningFabric: gp.liningFabric, sizeRange: gp.sizeRange, baseSize: gp.baseSize,
      sizeSpec: gp.sizeSpec,
    };
  }
  if (exactDevelopmentVersionProof) {
    // The catalogue identity may be reused; the accepted development version
    // and its frozen requirements are the order's actual specification basis.
    const source = exactDevelopmentVersionProof.sourceSnapshot as any;
    const requirements = source.case?.requirements ?? {};
    base.exactDevelopmentVersionProof = exactDevelopmentVersionProof;
    if (fp) base.fabric = { ...(base.fabric as object), composition: requirements.specComposition ?? null,
      construction: requirements.specWeave ?? null, finish: requirements.specFinish ?? null,
      weightText: requirements.specWeight ?? null, widthText: requirements.specWidth ?? null,
      factoryRequirements: source.version?.factoryRequirements ?? null, minorChangeNote: source.version?.minorChangeNote ?? null };
    if (gp) base.garment = { ...(base.garment as object), styleNo: requirements.styleSpec ?? null,
      sizeSpec: requirements.sizeSpec ?? null, mainFabric: requirements.fabricSpec ?? null,
      constructionNote: requirements.processSpec ?? null, factoryRequirements: source.version?.factoryRequirements ?? null,
      minorChangeNote: source.version?.minorChangeNote ?? null };
  }
  return base;
}
