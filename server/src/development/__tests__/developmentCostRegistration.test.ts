import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {registerDevelopmentCost,listDevelopmentShippingCostSources} from '../developmentCostRegistration';
import {createDevelopmentFactoryShipmentCost,bindDevelopmentFactoryShipmentCost} from '../developmentFactoryShipmentCost';
vi.mock('../../auth/permissionService',async original=>{const actual:any=await original();return{...actual,createPermissionService:({prisma}:any)=>({getUserPermissionContext:async()=>prisma.effectiveAuthorization})};});
vi.mock('../developmentExpenseAccess',()=>({assertDevelopmentExpenseAccess:vi.fn(async()=>{})}));
vi.mock('../../finance/billingItemService',async()=>{const {writeRouteAuditLog}=await import('../../audit/routeAudit');const {Prisma}=await import('@prisma/client');return{createCostRecordInTx:vi.fn(async(tx:any,{input,actorId}:any)=>{const row={id:`cost-${tx.rows.length+1}`,recordNo:`CR-${tx.rows.length+1}`,...input};tx.rows.push(row);await writeRouteAuditLog({prisma:tx,actorId,source:'route:billing',operation:'create_cost_record',targetType:'CostRecord',targetId:row.id,after:{recordNo:row.recordNo,sourceType:row.sourceType,sourceId:row.sourceId,costType:row.costType,amount:new Prisma.Decimal(String(row.amount)).toString(),currency:row.currency}});return row;})};});
const auditMatches=(row:any,where:any)=>Object.entries(where).every(([key,value]:any)=>key==='detail'?value.path.reduce((item:any,part:string)=>item?.[part],row.detail)===value.equals:key==='action'&&typeof value==='object'?value.in.includes(row.action):row[key]===value);
function fixture(){
 const tx:any={rows:[],audits:[],effectiveAuthorization:{scopes:['products:read','products:write'],roleIds:['custom'],departmentIds:[],legacyRoleCodes:[]},$queryRaw:vi.fn(async()=>[{id:'case'}]),
  costRecord:{findUnique:vi.fn(async({where}:any)=>tx.rows.find((r:any)=>r.registrationKey===where.registrationKey)),findFirst:vi.fn(async({where}:any)=>tx.rows.find((r:any)=>r.id===where.id&&(!Object.hasOwn(where,'deletedAt')||r.deletedAt==null))),findMany:vi.fn(async()=>tx.rows),update:vi.fn(async({where,data}:any)=>Object.assign(tx.rows.find((row:any)=>row.id===where.id),data))},
  userAccount:{findFirst:vi.fn(async()=>({id:'sales',status:'active'}))},sampleBatch:{findFirst:vi.fn(async()=>null)},
  auditLog:{create:vi.fn(async({data}:any)=>{tx.audits.push(structuredClone(data));return data;}),findMany:vi.fn(async({where}:any)=>tx.audits.filter((a:any)=>auditMatches(a,where)))} };
 return {tx,context:{prisma:{$transaction:async(fn:any)=>fn(tx)},actorId:'sales',trustedActor:{userId:'sales',roles:[],permissions:['products:read','products:write'],authorizationLoaded:true as const},authorize:vi.fn(async()=>{})}};
}
const input={requestKey:'request',sourceType:'DevelopmentCase',sourceId:'case',costType:'sample_making',amount:'12.34',currency:'CNY',incurredAt:'2026-09-30'};
describe('development cost registration',()=>{
 it('rejects cross-case sources and checks current access even on retries',async()=>{const {tx,context}=fixture();await expect(registerDevelopmentCost(context,'case',{...input,sourceId:'other'})).rejects.toMatchObject({status:400});await expect(registerDevelopmentCost(context,'case',{...input,sourceType:'SampleBatch',sourceId:'foreign'})).rejects.toMatchObject({status:400});expect(tx.rows).toHaveLength(0);await registerDevelopmentCost(context,'case',input);context.authorize.mockRejectedValue(Object.assign(Error('revoked'),{status:403}));await expect(registerDevelopmentCost(context,'case',input)).rejects.toMatchObject({status:403});expect(tx.rows).toHaveLength(1);});
 it('rejects invalid dates and currencies before writing',async()=>{const {tx,context}=fixture();await expect(registerDevelopmentCost(context,'case',{...input,incurredAt:'2026-02-30'})).rejects.toMatchObject({status:400});await expect(registerDevelopmentCost(context,'case',{...input,currency:'EUR'})).rejects.toMatchObject({status:400});expect(tx.rows).toHaveLength(0);});

 it('registers within the case and retries without creating a second cost',async()=>{const {tx,context}=fixture();const a=await registerDevelopmentCost(context,'case',input);const b=await registerDevelopmentCost(context,'case',input);expect(a.id).toBe(b.id);expect(tx.rows).toHaveLength(1);expect(a.bearerType).toBe('internal');await expect(registerDevelopmentCost(context,'case',{...input,amount:'20'})).rejects.toMatchObject({status:409});});
});

function shippingFixture(legacy=false){
 const f=fixture();const before={status:'making',round:1},after={status:'sent',round:1,sentDate:'2026-10-02',courier:'DHL',trackingNumber:'TRACK',shippingFee:45.5};
 const event={id:'send-event',kind:'send',round:1,auditId:'native-send-audit',actorId:'sales',at:'123',before,after};
 const detail={source:'route:dev:fabric-batch',before:{batchCode:'SB1',status:'making',round:1},after:{batchCode:'SB1',status:'sent',round:1,action:'send',...(legacy?{}:{roundFact:{kind:'send',before,after}})}};
 f.tx.audits.push({id:'native-send-audit',action:'advance_sample_batch',actorId:'sales',targetType:'SampleBatch',targetId:'batch',detail});
 f.tx.sampleBatch.findFirst.mockResolvedValue({id:'batch',batchCode:'SB1',developmentCaseId:'case',supplierRelationId:'supplier',round:2,status:'making',attachments:legacy?{}:{fabricHistory:{schemaVersion:1,revision:1,events:[event]}}});return f;
}
const shippingInput={...input,sourceType:'SampleBatch',sourceId:'batch',costType:'shipping',amount:'99999999999999.9999',currency:'USD'};
it('binds exact S1 send/audit despite current S2, preserves Decimal and exact original ack on replay',async()=>{
 const f=shippingFixture(),source=(await listDevelopmentShippingCostSources(f.context,'case','batch'))[0];
 const selected={kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint};
 const command={...shippingInput,shippingSource:selected};const first=await registerDevelopmentCost(f.context,'case',command);
 expect(first.amount).toBe('99999999999999.9999');expect(first.currency).toBe('USD');expect(first.developmentShippingSource.source).toMatchObject({round:1,batchId:'batch',nativeAuditId:'native-send-audit'});
 const {requestKey:_key,...original}=shippingInput;expect(first.commandAck.inputSnapshot).toEqual({...original,shippingSource:selected});
 const again=await registerDevelopmentCost(f.context,'case',command);expect(again.commandAck).toEqual(first.commandAck);expect(f.tx.rows).toHaveLength(1);expect((await listDevelopmentShippingCostSources(f.context,'case','batch'))[0].costRecordIds).toEqual([first.id]);
 const audit=f.tx.audits.find((a:any)=>a.action==='register_development_shipping_cost');expect(audit.detail.after.amount).toBe('99999999999999.9999');const {costRecordIds:_ids,...fact}=source as any;expect(audit.detail.after.shippingSource).toEqual(fact);
});
it('source hash/round mismatch and unknown source fail before cost, wrong audit cannot become a legacy shortcut',async()=>{
 const f=shippingFixture(),source=(await listDevelopmentShippingCostSources(f.context,'case','batch'))[0];
 for(const change of [{round:2},{fingerprint:'0'.repeat(64)},{kind:'legacy-send-audit',id:source.nativeAuditId}])await expect(registerDevelopmentCost(f.context,'case',{...shippingInput,shippingSource:{kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint,...change} as any})).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
 expect(f.tx.rows).toHaveLength(0);
 f.tx.sampleBatch.findFirst.mockResolvedValue({id:'batch',batchCode:'SB1',developmentCaseId:'case',supplierRelationId:'supplier',attachments:{}});
 await expect(listDevelopmentShippingCostSources(f.context,'case','batch')).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
});
it('legacy exact send audit explicitly keeps historical currency/amount unknown',async()=>{
 const f=shippingFixture(true),source=(await listDevelopmentShippingCostSources(f.context,'case','batch'))[0];expect(source).toMatchObject({kind:'legacy-send-audit',id:'native-send-audit',round:1,sourceSnapshot:{historicalAmountCurrencyUnknown:true}});
 expect(source.sourceSnapshot).not.toHaveProperty('currency');const row=await registerDevelopmentCost(f.context,'case',{...shippingInput,amount:'18.20',shippingSource:{kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint}});expect(row.amount).toBe('18.20');expect(row.currency).toBe('USD');
});
it('explicit empty ceiling or revoked current scope rejects source and replay',async()=>{
 const f=shippingFixture(),source=(await listDevelopmentShippingCostSources(f.context,'case','batch'))[0],command={...shippingInput,shippingSource:{kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint}};
 await registerDevelopmentCost(f.context,'case',command);f.context.trustedActor={...f.context.trustedActor,permissionCeiling:[]} as any;
 await expect(registerDevelopmentCost(f.context,'case',command)).rejects.toMatchObject({code:'FORBIDDEN'});f.context.trustedActor={userId:'sales',roles:[],permissions:['products:read','products:write'],authorizationLoaded:true};f.tx.effectiveAuthorization.scopes=[];
 await expect(listDevelopmentShippingCostSources(f.context,'case','batch')).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.tx.rows).toHaveLength(1);
});
it('exposes each garment shipment as its own auditable postage-cost source',async()=>{
 const f=fixture();const entry={requestKey:'garment-send-1',requestFingerprint:'f'.repeat(64),sentDate:'2026-10-06',courier:'DHL',trackingNumber:'T1',shippingFee:18.5,physicalShipment:{itemId:'card',quantity:1},shippedBy:'sales',shippedAt:123};
 f.tx.sampleBatch.findFirst.mockResolvedValue({id:'batch',batchCode:'SB-G1',developmentCaseId:'case',supplierRelationId:'supplier',round:1,sampleType:'garment-round',attachments:{shipmentHistory:[entry]}});
 f.tx.audits.push({id:'garment-audit',action:'submit_garment_sample_to_customer',actorId:'sales',targetType:'DevelopmentCase',targetId:'case',detail:{source:'route:samples:garment-gate',after:{roundId:'batch',requestKey:entry.requestKey,requestFingerprint:entry.requestFingerprint}}});
 const [source]=await listDevelopmentShippingCostSources(f.context,'case','batch');expect(source).toMatchObject({kind:'garment-send-event',id:entry.requestKey,round:1,nativeAuditId:'garment-audit',sourceSnapshot:{shippingFee:18.5,physicalShipment:entry.physicalShipment}});
 const cost=await registerDevelopmentCost(f.context,'case',{...shippingInput,shippingSource:{kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint}});expect(cost.developmentShippingSource.source.nativeAuditId).toBe('garment-audit');
});

it('free new expenses and unexplained extra expenses do not manufacture costs',async()=>{
 const f=fixture();await expect(registerDevelopmentCost(f.context,'case',{...input,amount:'0'})).rejects.toMatchObject({code:'INVALID_AMOUNT'});
 await expect(registerDevelopmentCost(f.context,'case',{...input,costType:'other',notes:'  '})).rejects.toMatchObject({code:'INVALID_INPUT'});
 expect(f.tx.rows).toHaveLength(0);
 const extra=await registerDevelopmentCost(f.context,'case',{...input,costType:'other',notes:'到付快递费'});expect(extra.notes).toBe('到付快递费');
});
it('the same exact shipping fact cannot be charged twice by another command or actor',async()=>{
 const f=shippingFixture(),source=(await listDevelopmentShippingCostSources(f.context,'case','batch'))[0];
 const command={...shippingInput,shippingSource:{kind:source.kind,id:source.id,round:source.round,fingerprint:source.fingerprint}};
 await registerDevelopmentCost(f.context,'case',command);
 await expect(registerDevelopmentCost(f.context,'case',{...command,requestKey:'other-command'})).rejects.toMatchObject({code:'COST_ALREADY_REGISTERED',status:409});
 const other={...f.context,actorId:'another',trustedActor:{...f.context.trustedActor,userId:'another'}};f.tx.userAccount.findFirst.mockResolvedValue({id:'another',status:'active'});
 await expect(registerDevelopmentCost(other,'case',{...command,requestKey:'third-command'})).rejects.toMatchObject({code:'COST_ALREADY_REGISTERED'});
 expect(f.tx.rows).toHaveLength(1);
});
it('source guard does not prohibit distinct making/partial expenses on the same task',async()=>{
 const f=shippingFixture();await registerDevelopmentCost(f.context,'case',{...input,sourceType:'SampleBatch',sourceId:'batch'});
 // A separate real payment command is not guessed to be the same expense.
 const f2=shippingFixture();await registerDevelopmentCost(f2.context,'case',{...input,requestKey:'partial-1',sourceType:'SampleBatch',sourceId:'batch'});
 await registerDevelopmentCost(f2.context,'case',{...input,requestKey:'partial-2',sourceType:'SampleBatch',sourceId:'batch'});expect(f2.tx.rows).toHaveLength(2);
});

it('an original historical successful zero-cost command remains reconcilable without a new record',async()=>{
 const f=fixture(),legacy={...input,amount:'0'};
 const data={sourceType:legacy.sourceType,sourceId:legacy.sourceId,costType:legacy.costType,amount:legacy.amount,currency:legacy.currency,incurredAt:legacy.incurredAt,bearerType:'internal',notes:undefined};
 f.tx.rows.push({id:'historical-cost',...data,registrationKey:createHash('sha256').update(JSON.stringify(['case','sales',legacy.requestKey])).digest('hex'),registrationFingerprint:createHash('sha256').update(JSON.stringify(data)).digest('hex')});
 expect((await registerDevelopmentCost(f.context,'case',legacy)).id).toBe('historical-cost');expect(f.tx.rows).toHaveLength(1);expect(f.context.authorize).toHaveBeenCalledTimes(2);
});

const canonicalFactory=(v:any):any=>Array.isArray(v)?v.map(canonicalFactory):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(key=>v[key]!==undefined).map(key=>[key,canonicalFactory(v[key])])):v;
const factoryHash=(v:any)=>createHash('sha256').update(JSON.stringify(canonicalFactory(v))).digest('hex');
async function factoryFixture({legacy=false,free=false,currency='CNY'}={}){
 const f=fixture(),fingerprint='f'.repeat(64),requestKey='physical-send';
 const raw:any={caseId:'case',itemId:'card',itemCode:'SC-1',physical:{name:'实际米样',unit:'M'},task:{sampleVersionId:'v1',factoryId:'factory'},stock:{eventId:'actual-stock-event',quantity:'1.2500'},shipping:{sentDate:'2026-10-01',shippingFee:free?'0.0000':'18.5000',shippingCurrency:currency,courier:'DHL',trackingNumber:'TRACK'}};
 const shippingCost=await createDevelopmentFactoryShipmentCost(f.tx,f.context,'case',requestKey,fingerprint,raw);
 const result={...raw,shippingCost,command:{kind:'factory',actorId:'sales',requestKey,fingerprint}};
 const saved={...result,auditId:'physical-audit',replayed:false};
 await bindDevelopmentFactoryShipmentCost(f.tx,f.context,'case',saved);
 if(legacy){delete (result as any).shippingCost;f.tx.rows.splice(0);f.tx.audits.splice(0);}
 f.tx.audits.push({id:'physical-audit',actorId:'sales',action:'development_reference_sample_ship',targetType:'DevelopmentCase',targetId:'case',detail:{source:'development:physical-sample',after:{kind:'factory',caseId:'case',actorId:'sales',requestKey,fingerprint,result,resultHash:factoryHash(result)}}});
 const shippingSource={kind:'factory-physical-command' as const,id:'physical-audit',fingerprint:shippingCost.sourceFingerprint};
 const command={...input,requestKey:'expense-registration',costType:'shipping',amount:raw.shipping.shippingFee,currency,incurredAt:raw.shipping.sentDate,shippingSource};
 return {...f,result,shippingSource,command};
}
describe('native factory postage source is the exact physical audit',()=>{
 it('does not alias another native batch source whose opaque event ID happens to match the physical audit ID',async()=>{
  const f=await factoryFixture({legacy:true});
  const batchSource={kind:'garment-send-event',id:f.shippingSource.id,caseId:'case',nativeAuditId:'separate-garment-audit',fingerprint:'0'.repeat(64)};
  f.tx.rows.push({id:'separate-batch-cost',sourceType:'SampleBatch',sourceId:'batch',costType:'shipping',developmentShippingSource:{source:batchSource}});
  f.tx.audits.push({id:'separate-registration',targetType:'CostRecord',targetId:'separate-batch-cost',actorId:'sales',action:'register_development_shipping_cost',detail:{source:'development-cost-registration',after:{caseId:'case',shippingSource:batchSource}}});
  const result=await registerDevelopmentCost(f.context,'case',f.command);expect(result.id).not.toBe('separate-batch-cost');expect(f.tx.rows).toHaveLength(2);
 });
 it.each(['missing registration','registration actor','registration source','registration amount','registration currency','registration source id','missing billing','billing id','billing actor','billing source','billing amount','billing sourceId','creation pointer'])('original %s damage fails closed for a legacy source under another actor/nonce',async field=>{
  const f=await factoryFixture({legacy:true});await registerDevelopmentCost(f.context,'case',f.command);
  const registration=f.tx.audits.find((row:any)=>row.action==='register_development_shipping_cost'),billing=f.tx.audits.find((row:any)=>row.action==='create_cost_record');
  const audit=field.includes('billing')?billing:registration;
  if(field==='creation pointer')f.tx.rows[0].developmentShippingSource.creationAuditId='changed';
  else if(field==='billing id')audit.id='changed';
  else if(field.startsWith('missing'))f.tx.audits.splice(f.tx.audits.indexOf(audit),1);
  else if(field.endsWith('actor'))audit.actorId='changed';
  else if(field.endsWith('source'))audit.detail.source='changed';
  else if(field.endsWith('source id'))audit.detail.after.shippingSource.id='changed';
  else if(field.endsWith('sourceId'))audit.detail.after.sourceId='changed';
  else audit.detail.after[field.endsWith('currency')?'currency':'amount']='changed';
  const another={...f.context,actorId:'another',trustedActor:{...f.context.trustedActor,userId:'another'}};
  await expect(registerDevelopmentCost(another,'case',{...f.command,requestKey:'another-nonce'})).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  expect(f.tx.rows).toHaveLength(1);
 });
 it.each(['id','kind','caseId','deletedAt','sourceId','sourceType','source metadata'])('legacy original registration audit prevents a new nonce after cost %s damage',async field=>{
  const f=await factoryFixture({legacy:true});const first=await registerDevelopmentCost(f.context,'case',f.command),stored=f.tx.rows.find((row:any)=>row.id===first.id);
  if(field==='source metadata')delete stored.developmentShippingSource;
  else if(['id','kind','caseId'].includes(field))stored.developmentShippingSource.source[field]='damaged';
  else stored[field]=field==='deletedAt'?1n:'damaged';
  await expect(registerDevelopmentCost(f.context,'case',{...f.command,requestKey:'new-nonce'})).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  const another={...f.context,actorId:'another',trustedActor:{...f.context.trustedActor,userId:'another'}};
  await expect(registerDevelopmentCost(another,'case',{...f.command,requestKey:'another-nonce'})).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  expect(f.tx.rows).toHaveLength(1);
 });
 it('rejects a second cost with a new nonce or actor, keeping independent closed-case extra facts available',async()=>{
  const f=await factoryFixture();
  await expect(registerDevelopmentCost(f.context,'case',f.command)).rejects.toMatchObject({code:'COST_ALREADY_REGISTERED',status:409});
  const another={...f.context,actorId:'another',trustedActor:{...f.context.trustedActor,userId:'another'}};
  await expect(registerDevelopmentCost(another,'case',{...f.command,requestKey:'another-expense'})).rejects.toMatchObject({code:'COST_ALREADY_REGISTERED'});
  // Expense authorization is current access; the closed lifecycle does not erase newly incurred real costs.
  f.tx.developmentCase={findFirst:vi.fn(async()=>({id:'case',stage:'closed'}))};
  const extra=await registerDevelopmentCost(f.context,'case',{...input,requestKey:'late-extra',costType:'other',amount:'3.50',notes:'结束后补记另一笔到付费用'});
  const postage=await registerDevelopmentCost(f.context,'case',{...input,requestKey:'separate-postage',costType:'shipping',amount:'2.50',notes:'另一笔实际邮寄支出'});
  expect(extra).toMatchObject({bearerType:'internal',notes:'结束后补记另一笔到付费用'});expect(postage).not.toHaveProperty('developmentShippingSource');expect(f.tx.rows).toHaveLength(3);
 });
 it.each([{amount:'18.5001'},{currency:'USD'},{incurredAt:'2026-10-02'}])('does not reinterpret original logistics as another amount/date/currency: %j',async patch=>{
  const f=await factoryFixture();await expect(registerDevelopmentCost(f.context,'case',{...f.command,...patch})).rejects.toMatchObject({code:'DEVELOPMENT_SHIPPING_SOURCE_INVALID'});expect(f.tx.rows).toHaveLength(1);
 });
 it('checks exact native source/hash/current authority and rejects a fabricated batch/round',async()=>{
  const f=await factoryFixture();
  for(const shippingSource of [{...f.shippingSource,id:'foreign-audit'},{...f.shippingSource,fingerprint:'0'.repeat(64)}])await expect(registerDevelopmentCost(f.context,'case',{...f.command,shippingSource})).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});
  await expect(registerDevelopmentCost(f.context,'case',{...f.command,shippingSource:{...f.shippingSource,round:1} as any})).rejects.toMatchObject({code:'DEVELOPMENT_SHIPPING_SOURCE_INVALID'});
  f.context.trustedActor={...f.context.trustedActor,permissionCeiling:[]} as any;
  await expect(registerDevelopmentCost(f.context,'case',f.command)).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.tx.rows).toHaveLength(1);
 });
 it('free source and damaged auto expense cannot become another registered payment',async()=>{
  const free=await factoryFixture({free:true});await expect(registerDevelopmentCost(free.context,'case',{...free.command,amount:'5'})).rejects.toMatchObject({code:'DEVELOPMENT_SHIPPING_SOURCE_INVALID'});expect(free.tx.rows).toHaveLength(0);
  const damaged=await factoryFixture();damaged.tx.rows[0].amount='19';await expect(registerDevelopmentCost(damaged.context,'case',damaged.command)).rejects.toMatchObject({code:'DEVELOPMENT_SOURCE_CHANGED'});expect(damaged.tx.rows).toHaveLength(1);
 });
 it('legacy original success permits an explicit exact source correction once, retaining original currency and separate generic rules',async()=>{
  const f=await factoryFixture({legacy:true,currency:'EUR'});
  expect(f.result).not.toHaveProperty('shippingCost');expect(f.tx.rows).toHaveLength(0);
  const first=await registerDevelopmentCost(f.context,'case',f.command);
  expect(first).toMatchObject({sourceType:'DevelopmentCase',sourceId:'case',bearerType:'internal',amount:'18.5000',currency:'EUR',incurredAt:'2026-10-01',developmentShippingSource:{source:{kind:'factory-physical-command',id:'physical-audit',nativeAuditId:'physical-audit',fingerprint:f.shippingSource.fingerprint}}});
  expect((await registerDevelopmentCost(f.context,'case',f.command)).commandAck).toEqual(first.commandAck);
  await expect(registerDevelopmentCost(f.context,'case',{...f.command,requestKey:'second-source-registration'})).rejects.toMatchObject({code:'COST_ALREADY_REGISTERED'});expect(f.tx.rows).toHaveLength(1);
  await expect(registerDevelopmentCost(f.context,'case',{...input,currency:'EUR'})).rejects.toMatchObject({code:'INVALID_CURRENCY'});
 });
});
