import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import express from 'express';
import request from 'supertest';
import assert from 'node:assert/strict';
import {createFabricSearchRouter} from '../src/development/fabricSearchRoute';
const db=new PrismaClient();
async function main(){
 const [{name}]=await db.$queryRawUnsafe<any[]>('select current_database() as name');assert.equal(name,'panda_hub_dev');
 const task=await db.fabricSearchTask.findFirst({where:{code:'FS-97519A12'}});assert(task);
 const forActor=(id:string)=>{const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.authSource='user-session';req.actor={userId:id};next();});app.use(createFabricSearchRouter({prisma:db}));return request(app);};
 const requester=forActor(task.requesterId),assignee=forActor(task.assigneeId),other=forActor('devsim-fabric2-b');
 if(task.status==='completed'){assert.equal((await assignee.get(`/fabric-search/${task.id}`)).body.data.status,'completed');assert.equal((await other.get(`/fabric-search/${task.id}`)).status,404);console.log('PASS: completed fixture retained with correct assignee visibility; no mutation needed.');return;}
 assert.equal((await requester.get(`/fabric-search/${task.id}`)).status,200);
 assert.equal((await assignee.get(`/fabric-search/${task.id}`)).status,200);
 assert.equal((await other.get(`/fabric-search/${task.id}`)).status,404);
 assert.equal((await assignee.post(`/fabric-search/${task.id}/complete`).send({expectedRevision:task.revision})).body.error.code,'NO_RESULTS');
 const stamp=BigInt(Date.now());
 await db.productSubCategory.upsert({where:{id:'devsim-wool-coating'},create:{id:'devsim-wool-coating',mainCategory:'Fabric',name:'模拟羊毛大衣面料',updatedAt:stamp},update:{}});
 await db.productAsset.upsert({where:{id:'devsim-fs-wool-navy'},create:{id:'devsim-fs-wool-navy',sku:'DEVSIM-WOOL-NAVY-400',name:'模拟档案 · 深海军蓝羊毛大衣面料',mainCategory:'Fabric',subCategoryId:'devsim-wool-coating',season:'AW27',status:'active',updatedAt:stamp,fabricProfile:{create:{id:'devsim-fs-wool-navy-profile',colorDescription:'深海军蓝',construction:'半精纺斜纹',weightValue:400,weightUnit:'gsm',weightValueGsm:400,widthValue:150,widthUnit:'cm',widthText:'150 cm',specialNote:'开发库流程验证档案，假想90%羊毛 / 10%尼龙；非供应商真实报价或实物确认。',updatedAt:stamp}}},update:{}});
 const saved=await assignee.patch(`/fabric-search/${task.id}`).send({expectedRevision:task.revision,assetIds:['devsim-fs-wool-navy']});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const read=await requester.get(`/fabric-search/${task.id}`);assert.equal(read.body.data.results[0].assetId,'devsim-fs-wool-navy');
 assert.equal((await assignee.patch(`/fabric-search/${task.id}`).send({expectedRevision:task.revision,name:'陈旧修改'})).status,409);
 console.log('PASS: requester and assignee shared read; unrelated employee denied; no-result closure blocked; fabric archive persisted and read back; stale revision rejected.');
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e);process.exitCode=1;});
