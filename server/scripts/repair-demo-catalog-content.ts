import dotenv from 'dotenv';dotenv.config({path:'.env.local',override:true});import {PrismaClient} from '@prisma/client';import {randomUUID} from 'node:crypto';import {planScenarioMasterData} from './full-business-sim/masterData';
const db=new PrismaClient();const master=planScenarioMasterData({namespace:'dev-oct08',nowMs:Date.parse('2026-10-08T00:18:00Z')});
async function main(){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='localhost'||u.pathname!=='/panda_hub_dev')throw Error('WRONG_TARGET');const report:any[]=[];
 await db.$transaction(async tx=>{
 for(const a of [...master.catalog.fabricAssets,...master.catalog.garmentAssets]){const old=await tx.productAsset.findUnique({where:{id:a.id}});if(!old)continue;
 await tx.productAsset.update({where:{id:a.id},data:{sku:a.sku,name:a.name}});
 if(a.businessFamily==='fabric')await tx.fabricProfile.update({where:{productAssetId:a.id},data:{articleNo:a.sku,millQuality:`Q-${a.sku.slice(2)}`,millColorCode:a.colorCode,colorDescription:a.colorDescription}});
 else await tx.garmentProfile.update({where:{productAssetId:a.id},data:{styleNo:a.sku,productName:a.name,colorways:a.colorDescription}});report.push({kind:'catalog',id:a.id,before:{sku:old.sku,name:old.name},after:{sku:a.sku,name:a.name}});}
 const cases=await tx.developmentCase.findMany({where:{deletedAt:null,code:{startsWith:'dev-oct08-dev-'}}});
 for(const c of cases){const i=Number(c.code.match(/-(\d+)$/)?.[1]||1)-1;const a=(c.type==='fabric'?master.catalog.fabricAssets:master.catalog.garmentAssets)[i];const productName=c.type==='fabric'?'羊毛斜纹 · 280gsm':'羊毛单排扣西装';const name=`${productName} · AW26开发`;const old=c.name;
 await tx.developmentCase.update({where:{id:c.id},data:{name,productName:c.productName?productName:null,nextAction:c.nextAction||old.split(' · ').slice(1).join(' · ')}});
 const assets=await tx.productAsset.findMany({where:{sourceDevelopmentCaseId:c.id,deletedAt:null}});for(const asset of assets){await tx.productAsset.update({where:{id:asset.id},data:{name:productName}});if(c.type!=='fabric') await tx.garmentProfile.updateMany({where:{productAssetId:asset.id},data:{productName}});}
 report.push({kind:'development',id:c.id,before:old,after:name});}
 await tx.auditLog.create({data:{id:randomUUID(),actorId:master.cast.owner.id,action:'repair_simulation_catalog_content',targetType:'SimulationDataset',targetId:'dev-oct08',detail:{source:'script:repair-demo-catalog-content',reason:'产品字段误填流程剧本，修正可编辑名称及商业品号；不改来源/QC/审批历史',changes:report}}});
 },{timeout:30000});console.log(JSON.stringify({changes:report.length}));}
main().finally(()=>db.$disconnect());
