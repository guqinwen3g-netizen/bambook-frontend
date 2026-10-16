/** BB-ORD-3：订单条目规格明细。成衣按颜色 × 尺码填数量，面料填颜色/色号、门幅、克重、成分并按颜色分行填数量。
 * 条目数量 = 明细合计，由服务端计算并校验，不信前端合计。旧条目没有明细时按"未分色分码"兼容。 */
import {MistCommandError,type MistOrder} from './mistWorkspace';

export type GarmentBreakdown={kind:'garment';sizes:string[];rows:Array<{color:string;quantities:number[]}>};
export type FabricBreakdown={kind:'fabric';composition:string;width:number|null;weight:number|null;rows:Array<{color:string;quantity:number}>};
export type OrderLineBreakdown=GarmentBreakdown|FabricBreakdown;
export const NO_BREAKDOWN='未分色分码';
const MAX_COLORS=30,MAX_SIZES=20;
const round=(value:number)=>Math.round(value*10000)/10000;
const n=(value:number)=>String(round(value));

function fail(message:string):never{throw new MistCommandError('VALIDATION',message,422);}
function label(value:unknown,what:string,at:string){if(typeof value!=='string'||!value.trim()||value.length>60)fail(`${at}${what}未填写或过长`);return value.trim();}
function unique(values:string[],what:string,at:string){const seen=new Set<string>();for(const value of values){const key=value.toLowerCase();if(seen.has(key))fail(`${at}${what}「${value}」重复`);seen.add(key);}}
function measure(value:unknown,what:string,at:string){if(value===null||value===undefined||value==='')return null;const v=Number(value);if(!Number.isFinite(v)||v<=0||v>100000)fail(`${at}${what}须为正数`);return round(v);}

/** 规范化并校验明细；没有明细返回 undefined。at 是错误信息前缀（如"条目「大衣」"）。 */
export function normalizeOrderBreakdown(type:MistOrder['type'],raw:unknown,at=''):OrderLineBreakdown|undefined{
  if(raw===undefined||raw===null)return undefined;
  const input=raw as {kind?:string;sizes?:unknown[];rows?:unknown[];composition?:unknown;width?:unknown;weight?:unknown};
  if(typeof raw!=='object'||input.kind!==type)fail(`${at}规格明细与订单类型不一致`);
  if(!Array.isArray(input.rows)||!input.rows.length)fail(`${at}至少需要一个颜色`);
  if(input.rows.length>MAX_COLORS)fail(`${at}颜色不能超过 ${MAX_COLORS} 个`);
  if(type==='garment'){
    if(!Array.isArray(input.sizes)||!input.sizes.length)fail(`${at}至少需要一个尺码`);
    if(input.sizes.length>MAX_SIZES)fail(`${at}尺码不能超过 ${MAX_SIZES} 个`);
    const sizes=input.sizes.map((size:unknown)=>label(size,'尺码',at));unique(sizes,'尺码',at);
    const rows=(input.rows as GarmentBreakdown['rows']).map(row=>{const color=label(row?.color,'颜色',at);if(!Array.isArray(row.quantities)||row.quantities.length!==sizes.length)fail(`${at}颜色「${color}」的尺码数量与尺码列不一致`);return {color,quantities:row.quantities.map((q,index)=>{const v=Number(q);if(!Number.isInteger(v)||v<0||v>10000000)fail(`${at}${color} · ${sizes[index]} 须为非负整数`);return v;})};});
    unique(rows.map(row=>row.color),'颜色',at);
    if(!rows.some(row=>row.quantities.some(q=>q>0)))fail(`${at}分色分码至少一格大于 0`);
    return {kind:'garment',sizes,rows};
  }
  const rows=(input.rows as FabricBreakdown['rows']).map(row=>{const color=label(row?.color,'颜色 / 色号',at),v=Number(row?.quantity);if(!Number.isFinite(v)||v<0||v>100000000)fail(`${at}颜色「${color}」数量须为非负数`);return {color,quantity:round(v)};});
  unique(rows.map(row=>row.color),'颜色',at);
  if(!rows.some(row=>row.quantity>0))fail(`${at}至少一个颜色数量大于 0`);
  const composition=typeof input.composition==='string'?input.composition.trim().slice(0,200):'';
  return {kind:'fabric',composition,width:measure(input.width,'门幅',at),weight:measure(input.weight,'克重',at),rows};
}

export function breakdownTotal(b:OrderLineBreakdown){return b.kind==='garment'?b.rows.reduce((sum,row)=>sum+row.quantities.reduce((s,q)=>s+q,0),0):round(b.rows.reduce((sum,row)=>sum+row.quantity,0));}

/** 服务端：条目数量以明细合计为准；前端送来的数量与合计不一致即拒绝。 */
export function lineQuantityFromBreakdown(type:MistOrder['type'],row:{qty?:unknown;breakdown?:unknown},at:string):{qty?:number;breakdown?:OrderLineBreakdown}{
  const breakdown=normalizeOrderBreakdown(type,row.breakdown,at);if(!breakdown)return {};
  const total=breakdownTotal(breakdown);
  if(row.qty!==undefined&&row.qty!==null&&Math.abs(Number(row.qty)-total)>1e-9)fail(`${at}数量 ${String(row.qty)} 与分色分码合计 ${n(total)} 不一致`);
  return {qty:total,breakdown};
}

export function fabricSpecText(b:FabricBreakdown){return [b.width!==null&&`门幅 ${n(b.width)} cm`,b.weight!==null&&`克重 ${n(b.weight)} g/m²`,b.composition&&`成分 ${b.composition}`].filter(Boolean).join(' · ');}
/** 一行文字摘要，用于审批快照、核对金额与条目详情。 */
export function breakdownSummary(b:OrderLineBreakdown|undefined|null,unit=''){
  if(!b)return NO_BREAKDOWN;
  if(b.kind==='garment')return b.rows.map(row=>`${row.color}：${b.sizes.map((size,index)=>`${size} ${row.quantities[index]}`).join(' / ')}`).join('；')+`（合计 ${n(breakdownTotal(b))}${unit?' '+unit:''}）`;
  const spec=fabricSpecText(b);return (spec?spec+'；':'')+b.rows.map(row=>`${row.color} ${n(row.quantity)}`).join(' / ')+`（合计 ${n(breakdownTotal(b))}${unit?' '+unit:''}）`;
}

export type BreakdownDiffRow={key:string;label:string;before:string;after:string};
/** 变更差异：成衣按格（颜色 · 尺码），面料按颜色及门幅/克重/成分，列出原值 → 新值。 */
export function breakdownDiff(before:OrderLineBreakdown|undefined|null,after:OrderLineBreakdown|undefined|null):BreakdownDiffRow[]{
  if(!before&&!after)return [];
  if(!before||!after||before.kind!==after.kind)return [{key:'breakdown',label:'分色分码',before:breakdownSummary(before),after:breakdownSummary(after)}];
  const rows:BreakdownDiffRow[]=[];const add=(key:string,label:string,a:string,b:string)=>{if(a!==b)rows.push({key,label,before:a||'—',after:b||'—'});};
  if(before.kind==='garment'&&after.kind==='garment'){
    const cell=(b:GarmentBreakdown,color:string,size:string)=>{const r=b.rows.find(row=>row.color===color),i=b.sizes.indexOf(size);return r&&i>=0?String(r.quantities[i]):'';};
    const colors=[...new Set([...before.rows,...after.rows].map(row=>row.color))],sizes=[...new Set([...before.sizes,...after.sizes])];
    for(const color of colors)for(const size of sizes)add(`${color}|${size}`,`${color} · ${size}`,cell(before,color,size),cell(after,color,size));
    return rows;
  }
  const b=before as FabricBreakdown,a=after as FabricBreakdown;
  add('width','门幅',b.width===null?'':`${n(b.width)} cm`,a.width===null?'':`${n(a.width)} cm`);
  add('weight','克重',b.weight===null?'':`${n(b.weight)} g/m²`,a.weight===null?'':`${n(a.weight)} g/m²`);
  add('composition','成分',b.composition,a.composition);
  const qty=(x:FabricBreakdown,color:string)=>{const r=x.rows.find(row=>row.color===color);return r?n(r.quantity):'';};
  for(const color of [...new Set([...b.rows,...a.rows].map(row=>row.color))])add(`color|${color}`,`颜色 ${color}`,qty(b,color),qty(a,color));
  return rows;
}

const STANDARD_SIZES=['XXS','XS','S','M','L','XL','XXL','3XL','4XL'];
/** 把开发版本 / 产品档案上的尺码段文字拆成尺码列，如 "S-XL" → S/M/L/XL，"36,38,40" → 36/38/40。 */
export function parseSizeRange(text:string|undefined|null):string[]{
  const out:string[]=[];
  for(const token of String(text||'').split(/[,，、/;；\s]+/).map(t=>t.trim()).filter(Boolean)){
    const range=token.match(/^([A-Za-z0-9]+)[-~–至]([A-Za-z0-9]+)$/);
    if(range){const a=STANDARD_SIZES.indexOf(range[1].toUpperCase()),b=STANDARD_SIZES.indexOf(range[2].toUpperCase());if(a>=0&&b>a){out.push(...STANDARD_SIZES.slice(a,b+1));continue;}const x=Number(range[1]),y=Number(range[2]);if(Number.isInteger(x)&&Number.isInteger(y)&&y>x&&y-x<=40){const step=(y-x)%2===0?2:1;for(let v=x;v<=y;v+=step)out.push(String(v));continue;}}
    out.push(token);
  }
  return [...new Set(out)].slice(0,MAX_SIZES);
}
export function parseColors(text:string|undefined|null):string[]{return [...new Set(String(text||'').split(/[,，、/;；]+/).map(t=>t.trim()).filter(t=>t&&t.length<=60))].slice(0,MAX_COLORS);}
const firstNumber=(text:string|undefined|null)=>{const m=String(text||'').match(/\d+(\.\d+)?/);return m?Number(m[0]):null;};

/** 从来源带入默认明细（数量全为 0，由业务员按 PO 填写）。 */
export function breakdownFromSource(type:MistOrder['type'],source:{sizes?:string|null;colors?:string|null;width?:string|null;weight?:string|null;composition?:string|null}):OrderLineBreakdown{
  const colors=parseColors(source.colors);const rowsColors=colors.length?colors:[''];
  if(type==='garment'){const sizes=parseSizeRange(source.sizes);const cols=sizes.length?sizes:[''];return {kind:'garment',sizes:cols,rows:rowsColors.map(color=>({color,quantities:cols.map(()=>0)}))};}
  const composition=String(source.composition||'').trim();
  return {kind:'fabric',composition:/待工厂分析/.test(composition)?'':composition,width:firstNumber(source.width),weight:firstNumber(source.weight),rows:rowsColors.map(color=>({color,quantity:0}))};
}

/** 列表用的短标签：成衣"2 色 × 4 码"，面料"2 色 · 门幅 150 cm"，旧条目"未分色分码"。 */
export function breakdownShort(b:OrderLineBreakdown|undefined|null){if(!b)return NO_BREAKDOWN;if(b.kind==='garment')return `${b.rows.length} 色 × ${b.sizes.length} 码`;return [`${b.rows.length} 色`,b.width!==null&&`门幅 ${n(b.width)} cm`,b.weight!==null&&`${n(b.weight)} g/m²`].filter(Boolean).join(' · ');}
/** 生产分支默认尺码：按尺码汇总各颜色数量（只读取，生产侧可改）。 */
export function breakdownSizeTotals(b:OrderLineBreakdown|undefined|null):Array<{size:string;quantity:number}>{if(!b||b.kind!=='garment')return [];return b.sizes.map((size,index)=>({size,quantity:b.rows.reduce((sum,row)=>sum+(row.quantities[index]||0),0)}));}
