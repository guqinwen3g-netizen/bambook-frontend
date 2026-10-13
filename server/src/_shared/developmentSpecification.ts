export type FabricSpecification = {
  categoryId?: string; compositionStatus: 'known' | 'factory_analysis'; composition: Array<{ fiber: string; percentage: number }>;
  weight?: { value: number; unit: 'gsm' | 'g/m' | 'g/yd' | 'oz/yd2' }; width?: { value: number; unit: 'cm' | 'mm' | 'm' | 'in'; kind: 'full' | 'usable' };
  weightStatus: 'known' | 'factory_analysis'; widthStatus: 'known' | 'factory_analysis';
  yarnStatus: 'known' | 'factory_analysis'; warpYarn?: string; weftYarn?: string; yarnSystem?: string; ply?: string;
  constructionStatus: 'known' | 'factory_analysis'; construction?: string;
  purpose?: string; colorReference?: string; handfeel?: string; finish?: string; performance?: string;
  gsm?: number | null; widthCm?: number | null;
};
export type GarmentSpecification = { styleName: string; styleNo?: string; block?: string; garmentCategory?: string };
const text = (v: unknown, label: string): string | undefined => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string' || v.trim().length > 4000) throw new Error(`${label}格式无效。`);
  return v.trim() || undefined;
};
const positive = (v: unknown, label: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${label}须为正数。`); return v; };
const status = (v: unknown, label: string) => { if (v !== 'known' && v !== 'factory_analysis') throw new Error(`请选择${label}是否待工厂分析。`); return v; };
/** Both client and server consume this pure contract. Never infer measurements from classification. */
export function normalizeFabricSpecification(value: unknown): FabricSpecification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('面料规格格式无效。');
  const v = value as Record<string, any>;
  const out: FabricSpecification = { compositionStatus: status(v.compositionStatus,'成分'), composition: [],
    weightStatus: status(v.weightStatus,'克重'), widthStatus: status(v.widthStatus,'幅宽'),
    yarnStatus: status(v.yarnStatus,'纱支'), constructionStatus: status(v.constructionStatus,'组织/花型') };
  if (!Array.isArray(v.composition) || v.composition.length > 30) throw new Error('成分明细格式无效。');
  out.composition = v.composition.map((row: any) => {
    const fiber = text(row?.fiber,'纤维名称');
    if (!fiber || typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage <= 0 || row.percentage > 100) throw new Error('每项成分须有纤维名称和有效比例。');
    return { fiber, percentage: row.percentage };
  });
  if (out.compositionStatus === 'known' && (!out.composition.length || Math.abs(out.composition.reduce((n,r)=>n+r.percentage,0)-100)>0.0001)) throw new Error('完整成分比例须合计100%。');
  if (v.width) {
    if (!['cm','mm','m','in'].includes(v.width.unit) || !['full','usable'].includes(v.width.kind)) throw new Error('幅宽须有单位及全幅/有效幅宽。');
    out.width = {value:positive(v.width.value,'幅宽'),unit:v.width.unit,kind:v.width.kind};
    out.widthCm = out.width.value * ({cm:1,mm:0.1,m:100,in:2.54}[out.width.unit]);
  } else { out.widthCm=null; if(out.widthStatus==='known') throw new Error('已知幅宽须填写数值和单位。'); }
  if(v.weight) {
    if(!['gsm','g/m','g/yd','oz/yd2'].includes(v.weight.unit)) throw new Error('克重须选择原始单位。');
    out.weight={value:positive(v.weight.value,'克重'),unit:v.weight.unit};
    out.gsm=out.weight.unit==='gsm'?out.weight.value:out.weight.unit==='oz/yd2'?out.weight.value*33.90574744:
      out.widthCm ? out.weight.value / (out.widthCm/100) / (out.weight.unit==='g/yd'?0.9144:1) : null;
  } else { out.gsm=null; if(out.weightStatus==='known') throw new Error('已知克重须填写数值和单位。'); }
  for(const [key,label] of Object.entries({categoryId:'面料分类',warpYarn:'经纱纱支',weftYarn:'纬纱纱支',yarnSystem:'纱支制式',ply:'股数',construction:'组织/花型',purpose:'用途',colorReference:'颜色参考',handfeel:'手感',finish:'后整理',performance:'性能'})) {
    const val=text(v[key],label); if(val) (out as any)[key]=val;
  }
  if(out.yarnStatus==='known' && (!out.warpYarn && !out.weftYarn || !out.yarnSystem)) throw new Error('已知纱支须填写纱支及计数制式。');
  if(out.constructionStatus==='known' && !out.construction) throw new Error('已知组织/花型须填写内容。');
  return out;
}
export function normalizeGarmentSpecification(value: unknown): GarmentSpecification {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('成衣标识格式无效。');
  const v=value as Record<string,unknown>;const styleName=text(v.styleName,'款式名称/标识');
  if(!styleName)throw new Error('请填写客户真实款式名称/标识。');
  return {styleName,styleNo:text(v.styleNo,'Style No'),block:text(v.block,'Block'),garmentCategory:text(v.garmentCategory,'服装品类')};
}
