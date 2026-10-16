import {describe,it,expect} from 'vitest';
import {applyMistCommand,createMistState,type MistContext,type MistState,type MistCommand} from './mistWorkspace';
import type {OrderGovernanceInput} from './mistOrderGovernance';

function fixture(){
 let n=0;const c:MistContext={id:()=>`src-${++n}`,now:'2026-10-16T08:00:00Z',actorName:'业务员',actorId:'sales',authority:{supplier:{},orderReviewerIds:{garment:['leader'],fabric:['leader']}}};
 let state=createMistState(c,'empty');
 const customer=(id:string)=>({id,name:'客户'+id,code:id,country:'CN',city:'',industry:'',owner:'业务员',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state.customers.push(customer('A'),customer('B'));
 state.files.push({id:'contract-file',name:'confirmed.pdf',mimeType:'application/pdf',size:10,storageKey:'workspace/contract-file',createdAt:c.now});
 const dev=(id:string,domain:'garment'|'fabric',customerId:string)=>({id,code:'DEV-'+id,name:'开发'+id,style:'ST-'+id,customerId,customer:customerId,values:{domain},versionIds:[]}) as never;
 const version=(id:string,devId:string,result?:'approved'|'needs_adjustment'|'rejected',archivedAt:string|null=null)=>({id,devId,label:'V-'+id,confirmations:result?[{id:id+'-c',result}]:[],archivedAt}) as never;
 state.devs.push(dev('g','garment','A'),dev('gb','garment','B'),dev('f','fabric','A'),dev('open','garment',''));
 state.versions.push(version('ok','g','approved'),version('none','g'),version('adjust','g','needs_adjustment'),version('arch','g','approved','2026-10-01'),version('other','gb','approved'),version('fab','f','approved'),version('open','open','approved'),version('revoked','g','approved'));
 const product=(id:string,category:'garment'|'fabric',status:'active'|'archived',sourceDevId='',sourceVersionId='')=>({id,sku:'SKU-'+id,name:'产品'+id,category,status,sourceDevId,sourceVersionId}) as never;
 state.market.products.push(product('p','garment','active','g','ok'),product('parch','garment','archived'),product('pfab','fabric','active'));
 const contract:OrderGovernanceInput={kind:'external',poNumber:'PO-1',confirmationFileIds:['contract-file'],internalPurpose:'',receiver:'',paymentMethod:'TT',depositPercent:30,paymentNote:'30%定金',incoterm:'FOB',deliveryPlace:'上海'};
 const run=(command:MistCommand,actor=c)=>{const out=applyMistCommand(state,command,actor);state=out.state;return out.result;};
 const create=(source:Record<string,string>,o:{type?:'garment'|'fabric';customerId?:string;governance?:OrderGovernanceInput}={})=>run({type:'order.create',payload:{type:o.type||'garment',customerId:o.customerId??'A',season:'AW27',currency:'USD',due:'2026-12-01',owner:'业务员',governance:o.governance||contract,lines:[{name:'大衣',style:'C1',img:'coat',qty:10,unit:'件',price:10,...source}]}} as MistCommand);
 return {get state(){return state;},set state(v:MistState){state=v;},c,contract,run,create};
}
const lineOf=(f:ReturnType<typeof fixture>,orderId:string)=>f.state.orderLines.find(l=>l.orderId===orderId) as Record<string,unknown>;

describe('BB-ORD-2 order line source is written once and validated on the server',()=>{
 it('writes an approved version source in the same order.create command and reads it back',()=>{
  const f=fixture(),r=f.create({sourceDevId:'g',sourceVersionId:'ok'});
  expect(lineOf(f,r.orderId!)).toMatchObject({sourceDevId:'g',sourceVersionId:'ok',name:'大衣',qty:10});
  expect(lineOf(f,r.orderId!).sourceProductId).toBeUndefined();
  const p=f.create({sourceProductId:'p',sourceDevId:'g',sourceVersionId:'ok'});
  expect(lineOf(f,p.orderId!)).toMatchObject({sourceProductId:'p',sourceDevId:'g',sourceVersionId:'ok'});
  const empty=f.create({sourceDevId:'',sourceVersionId:'',sourceProductId:''});
  expect(Object.keys(lineOf(f,empty.orderId!)).filter(k=>k.startsWith('source'))).toEqual([]);
 });
 it.each([
  ['未认可版本（尚无确认）',{sourceDevId:'g',sourceVersionId:'none'},/尚未获得客户认可（尚无需求方确认）/],
  ['需求方要求调整的版本',{sourceDevId:'g',sourceVersionId:'adjust'},/尚未获得客户认可（需求方要求调整）/],
  ['其他客户的版本',{sourceDevId:'gb',sourceVersionId:'other'},/属于其他客户/],
  ['归档产品',{sourceProductId:'parch'},/产品档案已归档/],
  ['不存在的产品',{sourceProductId:'nope'},/产品档案不存在/],
  ['归档版本',{sourceDevId:'g',sourceVersionId:'arch'},/已归档/],
  ['版本不属于所写开发案',{sourceDevId:'gb',sourceVersionId:'ok'},/不属于开发案 DEV-gb/],
  ['不存在的版本',{sourceDevId:'g',sourceVersionId:'nope'},/开发版本不存在/],
  ['只写开发案不写版本',{sourceDevId:'g'},/请同时选择已认可的来源版本/],
  ['面料开发案建成衣单',{sourceDevId:'f',sourceVersionId:'fab'},/面料，与成衣订单不一致/],
  ['面料产品建成衣单',{sourceProductId:'pfab'},/不是成衣/],
  ['产品档案改写成其他版本',{sourceProductId:'p',sourceDevId:'g',sourceVersionId:'none'},/来源版本与产品档案记录不一致/],
 ])('rejects %s on order.create and writes nothing',(_label,source,message)=>{
  const f=fixture(),orders=f.state.orders.length,lines=f.state.orderLines.length;
  expect(()=>f.create(source as Record<string,string>)).toThrow(message);
  expect(f.state.orders.length).toBe(orders);expect(f.state.orderLines.length).toBe(lines);
 });
 it('allows another customer\'s development only for internal orders and accepts customer-less developments',()=>{
  const f=fixture();
  const internal={...f.contract,kind:'internal' as const,internalPurpose:'展厅',receiver:'样品团队'};
  expect(lineOf(f,f.create({sourceDevId:'gb',sourceVersionId:'other'},{governance:internal}).orderId!)).toMatchObject({sourceVersionId:'other'});
  expect(lineOf(f,f.create({sourceDevId:'open',sourceVersionId:'open'},{customerId:'B'}).orderId!)).toMatchObject({sourceVersionId:'open'});
  expect(lineOf(f,f.create({sourceDevId:'f',sourceVersionId:'fab'},{type:'fabric'}).orderId!)).toMatchObject({sourceVersionId:'fab'});
 });
 it('validates new or changed sources on order.governance.saveDraft but keeps untouched history',()=>{
  const f=fixture(),id=f.create({}).orderId!,line=lineOf(f,id) as {id:string};
  const base={id:line.id,name:'大衣',style:'C1',img:'coat' as const,qty:10,unit:'件',price:10};
  const save=(extra:Record<string,string>)=>f.run({type:'order.governance.saveDraft',payload:{orderId:id,input:f.contract,lines:[{...base,...extra}]}} as MistCommand);
  expect(()=>save({sourceDevId:'g',sourceVersionId:'none'})).toThrow(/尚未获得客户认可/);
  expect(()=>save({sourceProductId:'parch'})).toThrow(/已归档/);
  expect(()=>save({sourceDevId:'gb',sourceVersionId:'other'})).toThrow(/其他客户/);
  save({sourceDevId:'g',sourceVersionId:'ok'});expect(lineOf(f,id)).toMatchObject({sourceDevId:'g',sourceVersionId:'ok'});
  // 历史订单：已保存的来源后来失效，只改其他字段的草稿仍可保存
  (f.state.versions.find(v=>v.id==='ok') as {confirmations:Array<{result:string}>}).confirmations.push({result:'rejected'});
  f.run({type:'order.governance.saveDraft',payload:{orderId:id,input:f.contract,orderPatch:{season:'SS28'}}} as MistCommand);
  expect(f.state.orders.find(o=>o.id===id)!.season).toBe('SS28');
 });
 it('re-checks every source when the order is submitted for main approval',()=>{
  const f=fixture(),id=f.create({sourceDevId:'g',sourceVersionId:'revoked'}).orderId!;
  (f.state.versions.find(v=>v.id==='revoked') as {confirmations:Array<{result:string}>}).confirmations.push({result:'needs_adjustment'});
  expect(()=>f.run({type:'order.governance.submit',payload:{orderId:id}} as MistCommand)).toThrow(/V-revoked 尚未获得客户认可（需求方要求调整）/);
  (f.state.versions.find(v=>v.id==='revoked') as {confirmations:Array<{result:string}>}).confirmations.push({result:'approved'});
  (f.state.versions.find(v=>v.id==='revoked') as {archivedAt:string|null}).archivedAt='2026-10-16';
  expect(()=>f.run({type:'order.governance.submit',payload:{orderId:id}} as MistCommand)).toThrow(/已归档/);
  (f.state.versions.find(v=>v.id==='revoked') as {archivedAt:string|null}).archivedAt=null;
  expect(f.run({type:'order.governance.submit',payload:{orderId:id}} as MistCommand)).toMatchObject({orderId:id});
  const pid=f.create({sourceProductId:'p'}).orderId!;
  (f.state.market.products.find(p=>p.id==='p') as {status:string}).status='archived';
  expect(()=>f.run({type:'order.governance.submit',payload:{orderId:pid}} as MistCommand)).toThrow(/产品档案已归档/);
 });
});
