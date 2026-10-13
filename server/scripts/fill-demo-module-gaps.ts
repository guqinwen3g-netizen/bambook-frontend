import dotenv from 'dotenv';dotenv.config({path:'.env.local',override:true});
import {PrismaClient} from '@prisma/client';import fs from 'node:fs/promises';
import {planScenarioMasterData} from './full-business-sim/masterData';import {buildBusinessScenarios} from './full-business-sim/scenarios';
import {createAuthService} from '../src/auth/service';import {buildLoadedAuthTokenPayload,loadUserWithRoles} from '../src/auth/tokenHelpers';
import {createPrivateScenarioJournal} from './full-business-sim/privateJournal';import {scenarioCommand} from './full-business-sim/driverContract';import {createScenarioCashResolver} from './full-business-sim/fullSimulation';
const db=new PrismaClient(),auth=createAuthService(),root='../scratch/demo-module-gaps';
async function main(){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='localhost'||u.pathname!=='/panda_hub_dev')throw Error('WRONG_TARGET');
 const master=planScenarioMasterData({namespace:'dev-oct08',nowMs:Date.parse('2026-10-08T00:18:00Z')});master.namespace='audit-oct08';
 const tokens=new Map<string,string>();const verifyActor=async(key:any)=>{const user=await loadUserWithRoles(db,master.cast[key].id);if(!user)throw Error('MISSING_ACTOR');tokens.set(key,auth.signToken(await buildLoadedAuthTokenPayload(db,user)));};
 const deps:any={runtimeId:'demo-module-audit-20261008',journal:await createPrivateScenarioJournal(`${root}/journal`),actorIds:Object.fromEntries(Object.entries(master.cast).map(([k,a])=>[k,a.id])),verifyActor,
 invoke:async(actor:any,method:string,url:string,body:any)=>{await verifyActor(actor);const r=await fetch(`http://localhost:8081${url}`,{method:method.toUpperCase(),headers:{Authorization:`Bearer ${tokens.get(actor)}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}};
 const results:any[]=[];const write=async(key:string,actor:any,url:string,body:any)=>{try{const result=await scenarioCommand(deps,{key,actor,method:'post',url,body});results.push({key,status:'created',ids:Object.fromEntries(Object.entries(result).filter(([k,v]:any)=>v&&typeof v==='object'&&v.id).map(([k,v]:any)=>[k,v.id]))});}catch(e){results.push({key,status:'blocked',reason:String(e)});}};
 for(const [index,team] of master.businessTeams.entries()){
  const actor=Object.values(master.cast).find(a=>a.id===team.salespersonId)!.key,customer=master.catalog.customers.find(c=>c.id===team.customerIds[0])!,supplier=master.catalog.suppliers.find(s=>s.id===team.supplierIds[0])!;
  const asset=(team.businessFamily==='fabric'?master.catalog.fabricAssets:master.catalog.garmentAssets).find(a=>a.customerRelationId===customer.id)!;
  const qty=team.businessFamily==='fabric'?1500:300,unit=team.businessFamily==='fabric'?'M':'PC',price=team.businessFamily==='fabric'?9.8:32;
  await write(`quotation:${team.key}`,actor,'/api/v1/quotations',{quotationNumber:`QT-2026-A${index+1}`,currency:customer.currency,customerRelationId:customer.id,customerName:customer.name,issueDate:'2026-10-08',validUntil:'2026-10-22',deliveryTerms:'FOB Shanghai',paymentInstrument:'T/T',paymentTerms:'T/T 30% deposit, balance within 30 days of shipment',salesperson:master.cast[actor].name,notes:'本地演示报价草稿，未发送给客户。',lines:[{fabricCode:asset.sku,description:asset.name,quantity:qty,unit,unitPrice:price}]});
  const sourcePlan=buildBusinessScenarios(master).orders.find(s=>s.teamKey===team.key)!;
  const file=JSON.parse(await fs.readFile(`../scratch/demo-audit-${team.businessFamily==='fabric'?'fabric':'garment'}/results.json`,'utf8'));
  const orderId=file.find((r:any)=>r.key===sourcePlan.key)?.ids.orderId;
  if(!orderId)throw Error('ORDER_SOURCE_MISSING');
  await write(`inquiry:${team.key}`,actor,'/api/v1/procurement/inquiries',{description:asset.name,materialCode:asset.sku,quantity:qty,unit,currency:'CNY',orderId,buyer:master.cast[actor].name,expectedDeliveryDate:'2026-10-25',notes:'面料/款式规格询价，尚未选供应商或承诺采购。'});
  const lineId=file.find((r:any)=>r.key===sourcePlan.key)?.ids.lineId;
  const kind=team.businessFamily==='fabric'?'purchase':'processing';
  await write(`contract:${team.key}`,actor,`/api/v1/procurement/contracts/${kind}`,{requestKey:`b00b0000-0000-4000-8000-00000000000${index+1}`,contractNumber:`${kind==='purchase'?'PC':'CMT'}-2026-A${index+1}`,supplierRelationId:supplier.id,currency:'CNY',orderDate:'2026-10-08',paymentTerms:'验收及收到原票后30天付款',mainDeliveryLocation:{kind:'supplier',relationId:supplier.id,address:supplier.address},deliveryTerms:'EXW',notes:'演示采购/加工草稿，未批准或付款。',lines:[{orderLineId:lineId,description:asset.name,quantity:String(qty),unit,unitPrice:team.businessFamily==='fabric'?'35':'120',requestedDeliveryDate:'2026-10-25',...(kind==='purchase'?{kind:'FinishedGoods'}:{processType:'CMT',cmtIncludedItemsReviewed:[],inputSource:{kind:'customer_supplied',relationId:customer.id}})}]});
  // Independent general stock, never claim receipt against an unapproved order.
  const warehouse=master.catalog.warehouses[0];
  await write(`stock:${team.key}`,actor,'/api/v1/inventory/items',{warehouseId:warehouse.id,productAssetId:asset.id,materialCode:asset.sku,description:asset.name,category:team.businessFamily==='fabric'?'Fabric':'Garment',specification:asset.colorDescription,batchNumber:`ST-261008-${index+1}`,quantity:team.businessFamily==='fabric'?300:60,unit,unitCost:team.businessFamily==='fabric'?35:120,currency:'CNY',receiptDate:'2026-10-08',notes:'演示环境的通用历史库存登记；不代表订单生产收货或采购验收。',details:team.businessFamily==='fabric'?{color:asset.colorDescription,rolls:[{number:`R-${index+1}-01`,quantity:300}]}:{color:asset.colorDescription,sizes:[{size:'S',quantity:30},{size:'M',quantity:30}]}});
 }
 for(const family of ['fabric','garment'] as const){
  const plan=buildBusinessScenarios(master).orders.find(s=>s.family===family&&s.stopAfter==='draft')!;
  const data=JSON.parse(await fs.readFile(`../scratch/demo-audit-${family}/results.json`,'utf8')),orderId=data.find((r:any)=>r.key===plan.key).ids.orderId;
  const asset=(family==='fabric'?master.catalog.fabricAssets:master.catalog.garmentAssets).find(a=>a.customerRelationId===plan.customerId&&a.id!==plan.catalogAssetId)||[...master.catalog.fabricAssets,...master.catalog.garmentAssets].find(a=>a.id===plan.catalogAssetId)!;
  await write(`multi-line:${family}`,plan.owner,'/api/v1/order-lines',{orderId,itemNo:'0020',materialCode:asset.sku,millQuality:`${asset.colorCode} ${asset.colorDescription}`,description:asset.name,quantity:family==='fabric'?'800':'120',unit:plan.unit,unitPrice:plan.unitPrice,requiredSampleFamilies:family==='fabric'?['fabric_eps','fabric_ss']:['garment_pp','garment_ship'],partialShipmentAllowed:true,tolerancePercent:'5',toleranceSource:'line_override',...(family==='garment'?{sizeBreakdown:{S:30,M:60,L:30},fulfillmentMode:'cmt',cmtIncludedItems:[]}:{}),manualSpecification:{factoryRelationId:plan.supplierId,specification:`${asset.name}；合同规格及颜色`,agreementBasis:'演示订单逐条录入规格；未审批草稿。',evidence:[`simulation:${plan.key}:line-0020`]}});
 }
 const cash=createScenarioCashResolver(master,deps);for(const currency of ['USD','CNY','EUR'])try{results.push({key:`cash:${currency}`,status:'created',id:(await cash(currency)).id});}catch(e){results.push({key:`cash:${currency}`,status:'blocked',reason:String(e)});}
 await fs.mkdir(root,{recursive:true});await fs.writeFile(`${root}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}
main().finally(()=>db.$disconnect());
