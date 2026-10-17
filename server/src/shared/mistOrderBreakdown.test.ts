import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type MistContext,type MistState,type MistCommand} from './mistWorkspace';
import {getOrderGovernanceReviews,type OrderGovernanceInput} from './mistOrderGovernance';
import {breakdownDiff,breakdownFromSource,breakdownSizeTotals,breakdownSummary,normalizeOrderBreakdown,parseSizeRange,type OrderLineBreakdown} from './mistOrderBreakdown';

const garment=(rows:Array<[string,number[]]>,sizes=['S','M','L','XL']):OrderLineBreakdown=>({kind:'garment',sizes,rows:rows.map(([color,quantities])=>({color,quantities}))});
const fabric:OrderLineBreakdown={kind:'fabric',composition:'100% 羊毛',width:150,weight:320,rows:[{color:'藏青 NV-01',quantity:300.5},{color:'黑 BK-02',quantity:200}]};
function fixture(){
 let n=0;const c:MistContext={id:()=>`bd-${++n}`,now:'2026-10-16T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader'],fabric:['leader']}}};
 let state=createMistState(c,'empty');
 state.customers.push({id:'A',name:'客户A',code:'A',country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.files.push({id:'f',name:'po.pdf',mimeType:'application/pdf',size:1,storageKey:'w/f',createdAt:c.now});
 const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-1',confirmationFileIds:['f'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金',incoterm:'FOB',deliveryPlace:'上海'};
 const run=(command:MistCommand,actor=c)=>{const out=applyMistCommand(state,command,actor);state=out.state;return out.result;};
 const create=(type:'garment'|'fabric',line:Record<string,unknown>)=>run({type:'order.create',payload:{type,customerId:'A',season:'AW27',currency:'USD',due:'2026-12-01',ownerId:'sales',governance:contract,lines:[{name:type==='fabric'?'双面呢':'大衣',style:'C1',img:'coat',unit:type==='fabric'?'米':'件',price:10,...line}]}} as MistCommand);
 return {get state():MistState{return state;},c,contract,run,create};
}
const lineOf=(f:ReturnType<typeof fixture>,orderId:string)=>f.state.orderLines.find(l=>l.orderId===orderId) as unknown as {id:string;qty:number;breakdown?:OrderLineBreakdown};

describe('BB-ORD-3 colour × size and fabric spec breakdown',()=>{
 it('creates a 2 colour × 4 size garment line and a 2 colour fabric line; quantity is the server-computed sum and reads back',()=>{
  const f=fixture(),bd=garment([['藏青',[10,20,30,40]],['黑',[5,0,15,0]]]);
  const g=f.create('garment',{qty:120,breakdown:bd});
  expect(lineOf(f,g.orderId!)).toMatchObject({qty:120,breakdown:bd});
  expect(f.state.orders.find(o=>o.id===g.orderId)).toBeTruthy();
  const fb=f.create('fabric',{qty:500.5,breakdown:fabric});
  expect(lineOf(f,fb.orderId!)).toMatchObject({qty:500.5,breakdown:fabric});
  // 不送数量时以明细合计为准
  const auto=f.create('garment',{breakdown:bd});expect(lineOf(f,auto.orderId!).qty).toBe(120);
  // 旧式条目不受影响
  const plain=f.create('garment',{qty:7});expect(lineOf(f,plain.orderId!)).toMatchObject({qty:7});expect(lineOf(f,plain.orderId!).breakdown).toBeUndefined();
 });
 it.each([
  ['伪造合计',{qty:999,breakdown:garment([['藏青',[10,20,30,40]]])},/数量 999 与分色分码合计 100 不一致/],
  ['全为 0',{breakdown:garment([['藏青',[0,0,0,0]]])},/至少一格大于 0/],
  ['负数格',{breakdown:garment([['藏青',[-1,2,0,0]]])},/藏青 · S 须为非负整数/],
  ['小数格',{breakdown:garment([['藏青',[1.5,2,0,0]]])},/须为非负整数/],
  ['重复颜色',{breakdown:garment([['藏青',[1,0,0,0]],['藏青',[1,0,0,0]]])},/颜色「藏青」重复/],
  ['重复尺码',{breakdown:garment([['藏青',[1,1]]],['M','m'])},/尺码「m」重复/],
  ['空颜色',{breakdown:garment([['',[1,0,0,0]]])},/颜色未填写/],
  ['格数与尺码列不一致',{breakdown:{kind:'garment',sizes:['S','M'],rows:[{color:'藏青',quantities:[1]}]}},/与尺码列不一致/],
  ['面料明细放进成衣单',{breakdown:fabric},/规格明细与订单类型不一致/],
 ])('rejects garment %s and writes nothing',(_l,line,message)=>{
  const f=fixture(),before=f.state.orders.length;expect(()=>f.create('garment',line as Record<string,unknown>)).toThrow(message);expect(f.state.orders.length).toBe(before);
 });
 it('rejects a forged fabric total and invalid width / weight',()=>{
  const f=fixture();
  expect(()=>f.create('fabric',{qty:600,breakdown:fabric})).toThrow(/与分色分码合计 500.5 不一致/);
  expect(()=>f.create('fabric',{breakdown:{...fabric,width:-1}})).toThrow(/门幅须为正数/);
  expect(()=>f.create('fabric',{breakdown:{...fabric,rows:[{color:'藏青',quantity:0}]}})).toThrow(/至少一个颜色数量大于 0/);
 });
 it('saveDraft recomputes quantity, rejects forged totals, and the approval page shows the breakdown',()=>{
  const f=fixture(),id=f.create('garment',{qty:10}).orderId!,line=lineOf(f,id);
  const base={id:line.id,name:'大衣',style:'C1',img:'coat' as const,unit:'件',price:10};
  const save=(extra:Record<string,unknown>,reason?:string)=>f.run({type:'order.governance.saveDraft',payload:{orderId:id,input:f.contract,lines:[{...base,...extra}],...(reason?{reason}:{})}} as MistCommand);
  expect(()=>save({qty:1,breakdown:garment([['藏青',[1,1,1,1]]])})).toThrow(/不一致/);
  save({qty:100,breakdown:garment([['藏青',[10,20,30,40]]])});
  expect(lineOf(f,id)).toMatchObject({qty:100,breakdown:{sizes:['S','M','L','XL']}});
  f.run({type:'order.governance.submit',payload:{orderId:id}} as MistCommand);
  const detail=getOrderGovernanceReviews(f.state)[0].details.find(d=>d.label==='C1 · 大衣')!;
  expect(detail.value).toContain('藏青：S 10 / M 20 / L 30 / XL 40（合计 100 件）');
  f.run({type:'order.governance.decide',payload:{id,decision:'approved',note:'ok'}},{...f.c,actorId:'leader'});
  // 批准后改分色分码走变更草稿，原批准内容继续生效
  save({qty:110,breakdown:garment([['藏青',[10,25,30,40]],['黑',[5,0,0,0]]])},'客户追加');
  expect(lineOf(f,id).qty).toBe(100);
  const g=(f.state.orders.find(o=>o.id===id) as unknown as {governance:{changeDraft:{lines:Array<{breakdown:OrderLineBreakdown}>};approvedSnapshot:{lines:Array<{breakdown:OrderLineBreakdown}>}}}).governance;
  expect(breakdownDiff(g.approvedSnapshot.lines[0].breakdown,g.changeDraft.lines[0].breakdown).map(r=>[r.label,r.before,r.after])).toEqual([['藏青 · M','20','25'],['黑 · S','—','5'],['黑 · M','—','0'],['黑 · L','—','0'],['黑 · XL','—','0']]);
 });
 it('summaries, diffs and defaults are readable for legacy, fabric and source data',()=>{
  expect(breakdownSummary(undefined)).toBe('未分色分码');
  expect(breakdownSummary(fabric,'米')).toBe('门幅 150 cm · 克重 320 g/m² · 成分 100% 羊毛；藏青 NV-01 300.5 / 黑 BK-02 200（合计 500.5 米）');
  expect(breakdownDiff(fabric,{...fabric,width:145,rows:[{color:'藏青 NV-01',quantity:280}]}).map(r=>[r.label,r.before,r.after])).toEqual([['门幅','150 cm','145 cm'],['颜色 藏青 NV-01','300.5','280'],['颜色 黑 BK-02','200','—']]);
  expect(breakdownDiff(undefined,fabric)[0]).toMatchObject({label:'分色分码',before:'未分色分码'});
  expect(parseSizeRange('S-XL')).toEqual(['S','M','L','XL']);expect(parseSizeRange('36-42')).toEqual(['36','38','40','42']);expect(parseSizeRange('M, L / 均码')).toEqual(['M','L','均码']);
  expect(breakdownFromSource('garment',{sizes:'S-L',colors:'藏青，黑'})).toEqual({kind:'garment',sizes:['S','M','L'],rows:[{color:'藏青',quantities:[0,0,0]},{color:'黑',quantities:[0,0,0]}]});
  expect(breakdownFromSource('fabric',{width:'150',weight:'320 g/m²',composition:'待工厂分析',colors:'藏青'})).toEqual({kind:'fabric',composition:'',width:150,weight:320,rows:[{color:'藏青',quantity:0}]});
  expect(breakdownSizeTotals(garment([['藏青',[10,20,30,40]],['黑',[5,0,15,0]]]))).toEqual([{size:'S',quantity:15},{size:'M',quantity:20},{size:'L',quantity:45},{size:'XL',quantity:40}]);
  expect(()=>normalizeOrderBreakdown('fabric',{kind:'fabric',rows:[]})).toThrow(/至少需要一个颜色/);
 });
});
