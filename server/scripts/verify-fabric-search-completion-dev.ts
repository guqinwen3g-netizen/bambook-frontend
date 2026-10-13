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
 const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.authSource='user-session';req.actor={userId:task.assigneeId};next();});app.use(createFabricSearchRouter({prisma:db}));
 if(task.status==='open'){const closed=await request(app).post(`/fabric-search/${task.id}/complete`).send({expectedRevision:task.revision,completionNote:'开发库寻样流程验证：已关联模拟羊毛档案。'});assert.equal(closed.status,200,JSON.stringify(closed.body));}
 const read=await request(app).get(`/fabric-search/${task.id}`);assert.equal(read.body.data.status,'completed');assert.equal(read.body.data.results[0].assetId,'devsim-fs-wool-navy');
 const note=await db.notification.findFirst({where:{userId:task.requesterId,type:'fabric_search_completed',link:`/development?id=${task.id}&tab=fabric-search`}});assert(note);
 console.log('PASS: actual fabric assignee completed the persisted task; archive readback and requester notification verified.');
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e);process.exitCode=1;});
