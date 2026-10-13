import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import express from 'express';
import request from 'supertest';
import assert from 'node:assert/strict';
import {createFabricSearchRouter} from '../src/development/fabricSearchRoute';
import {getPersonalWorkbench} from '../src/dashboard/workbenchService';
const db=new PrismaClient();
const requesterId='devsim-apparel-a',assigneeId='devsim-outdoor-a';
function actor(id:string){const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.actor={userId:id};req.authSource='user-session';next();});app.use(createFabricSearchRouter({prisma:db}));return request(app);}
async function main(){
 const [{name}]=await db.$queryRawUnsafe<any[]>('select current_database() as name');assert.equal(name,'panda_hub_dev');
 const requester=actor(requesterId),assignee=actor(assigneeId);
 const made=await requester.post('/fabric-search').send({name:'模拟流程验收 · 男士羊毛大衣面料寻样',initiator:'internal',requestTeamId:'devsim-team-apparel',assigneeId,requestText:'海军蓝、羊毛为主、半精纺，400gsm，150cm；候选可补充规格差异。',requestKey:'flow-verification-'+Date.now()});assert.equal(made.status,200,JSON.stringify(made.body));let task=made.body.data;
 const action=async(client:any,kind:string,extra:any={})=>{const r=await client.post(`/fabric-search/${task.id}/actions/${kind}`).send({expectedRevision:task.revision,...extra});assert.equal(r.status,200,JSON.stringify(r.body));task=r.body.data;};
 const tasksFor=async(id:string)=>{const result=await getPersonalWorkbench(db,{userId:id} as any,{group:'development'});assert.equal(result.groups[0].status,'ready',JSON.stringify(result));return result.groups[0].items!.filter((r:any)=>r.target?.kind==='fabric-search'&&r.target.taskId===task.id);};
 assert.equal((await tasksFor(assigneeId)).length,1);assert.equal((await tasksFor(requesterId)).length,0);
 assert.equal((await requester.post(`/fabric-search/${task.id}/actions/accept`).send({expectedRevision:task.revision})).status,409);
 await action(assignee,'accept');
 const saved=await assignee.patch(`/fabric-search/${task.id}`).send({expectedRevision:task.revision,assetIds:['devsim-fs-wool-navy'],assetNotes:{'devsim-fs-wool-navy':'海军蓝半精纺，400gsm与150cm符合目标；成分和手感须实物确认。'}});assert.equal(saved.status,200,JSON.stringify(saved.body));task=saved.body.data;
 await action(assignee,'submit',{note:'找到一份现有档案，建议先寄实物确认。'});
 assert.equal((await tasksFor(assigneeId)).length,0);assert.equal((await tasksFor(requesterId)).length,1);
 assert.equal((await assignee.post(`/fabric-search/${task.id}/actions/confirm`).send({expectedRevision:task.revision})).status,409);
 await action(requester,'return',{note:'请确认能否达到420gsm，现候选暂保留。'});
 assert.equal((await tasksFor(assigneeId)).length,1);assert.equal((await tasksFor(requesterId)).length,0);
 await action(assignee,'submit',{note:'确认当前档案为400gsm；420gsm需要另建面料开发案。客户可先看此候选。'});
 await action(requester,'confirm',{note:'本次寻样结案，后续按客户反馈另行开发。'});
 assert.equal((await tasksFor(assigneeId)).length,0);assert.equal((await tasksFor(requesterId)).length,0);
 assert.equal(task.flowHistory.length,6);assert.equal(task.results[0].recommendation.includes('实物确认'),true);
 const notifications=await db.notification.count({where:{link:`/development?id=${task.id}&tab=fabric-search`}});assert(notifications>=4);
 console.log(JSON.stringify({result:'PASS',code:task.code,taskId:task.id,states:'pending → in_progress → awaiting_confirmation → in_progress → awaiting_confirmation → completed',history:task.flowHistory.length,notifications,personalTasks:'responsibility transferred and completed tasks removed'}));
 const demo=await requester.post('/fabric-search').send({name:'Cedar & Crown · 海军蓝羊毛面料寻样',initiator:'internal',requestTeamId:'devsim-team-apparel',assigneeId,requestText:'男士 formal 大衣用面料，羊毛为主、半精纺，380–420gsm、150cm、深海军蓝。先寻找现有档案并反馈适配程度；没有匹配时说明原因。',requestKey:'flow-demo-'+Date.now()});assert.equal(demo.status,200);console.log(JSON.stringify({demo:'pending',code:demo.body.data.code,taskId:demo.body.data.id}));
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e);process.exitCode=1;});
