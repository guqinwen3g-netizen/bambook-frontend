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

 for (const [index, teamKey] of ['fabric2','garment2'].entries()) {
  const team=master.businessTeams.find(t=>t.key===teamKey)!;
  const family=team.businessFamily;
  const results=JSON.parse(await fs.readFile(`../scratch/demo-audit-${family}/results.json`,'utf8'));
  const plans=buildBusinessScenarios(master).orders.filter(s=>s.teamKey===team.key);
  let chosen:any, order:any;
  for (const plan of plans) { const r=results.find((r:any)=>r.key===plan.key); const o=await db.order.findUnique({where:{id:r.ids.orderId},include:{lines:true}}); if(o&&o.status!=='Pending'){chosen=plan;order=o;break;} }
  if(!order)throw Error('NO_APPROVED_CONTRACT_SOURCE');
  const line=order.lines[0], supplier=master.catalog.suppliers.find(s=>s.id===chosen.supplierId)!;
  const kind=family==='fabric'?'purchase':'processing';
  await write(`approved-contract:${team.key}`,chosen.owner,`/api/v1/procurement/contracts/${kind}`,{requestKey:`b00b0000-0000-4000-8000-00000000001${index+1}`,contractNumber:`${kind==='purchase'?'PC':'CMT'}-2026-B${index+1}`,supplierRelationId:supplier.id,currency:'CNY',orderDate:'2026-10-08',paymentTerms:'验收及收到原票后30天付款',mainDeliveryLocation:{kind:'supplier',relationId:supplier.id,address:supplier.address},deliveryTerms:'EXW',notes:'基于已批准销售订单的演示合同草稿；未批准或付款。',lines:[{orderLineId:line.id,description:line.description,quantity:String(line.quantity),unit:line.unit,unitPrice:family==='fabric'?'35':'120',requestedDeliveryDate:'2026-10-25',...(kind==='purchase'?{kind:'FinishedGoods'}:{processType:'CMT',cmtIncludedItemsReviewed:[],inputSource:{kind:'customer_supplied',relationId:chosen.customerId}})}]});
 }
 for(const [index,team] of master.businessTeams.filter(t=>t.businessFamily==='fabric').entries()) {
  const actor=Object.values(master.cast).find(a=>a.id===team.salespersonId)!.key;
  await write(`fabric-search:${team.key}`,actor,'/api/v1/development/fabric-search',{requestKey:`demo-audit-search-${team.key}`,name:index===0?'藏青羊毛斜纹面料寻样':'米白棉斜纹面料寻样',initiator:'internal',requestTeamId:team.id,assigneeId:team.leaderId,requestText:index===0?'100%羊毛，藏青色斜纹，240–280gsm，门幅150cm，手感柔软，用于秋冬西装。':'100%棉，米白色斜纹，220–240gsm，门幅150cm，预缩整理，用于直筒长裤。',targetDate:'2026-10-25'});
 }

 for (const [index,team] of master.businessTeams.filter(t=>t.businessFamily==='garment').entries()) {
  const actor=Object.values(master.cast).find(a=>a.id===team.salespersonId)!.key;
  const garment=master.catalog.garmentAssets.find(a=>a.customerRelationId===team.customerIds[0])!;
  const fabric=master.catalog.fabricAssets.find(a=>a.name.startsWith('粗纺羊毛')&&a.colorDescription===garment.colorDescription)!;
  await write(`bom:${team.key}`,actor,'/api/v1/bom',{bomNumber:`BOM-2026-A${index+1}`,description:garment.name,productAssetId:garment.id,currency:'CNY',notes:'按单件核算的演示BOM草稿；未关联CMT订单，不代表实采或实际发生费用。',lines:[{materialType:'Main',materialCode:fabric.sku,description:fabric.name,category:'Fabric',specification:'420gsm，门幅150cm',quantity:3.2,unit:'M',wastagePercent:5,unitCost:55},{materialType:'Lining',materialCode:'LIN-001',description:'涤纶里布 · 本色',category:'Fabric',quantity:2.5,unit:'M',wastagePercent:3,unitCost:8},{materialType:'Trimmings',materialCode:'BTN-001',description:'树脂四眼扣 · 20mm',category:'Trimmings',quantity:6,unit:'PC',wastagePercent:0,unitCost:1.5}],costEstimates:[{costType:'Labor',description:'裁剪及缝制单件工费估算',amount:120},{costType:'Overhead',description:'整烫及包装单件费用估算',amount:12}]});
 }
 await fs.writeFile(`${root}/supplement-results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}
main().finally(()=>db.$disconnect());
