import {describe,it,expect,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import {createHRRouter} from '../route';
vi.mock('../../audit/routeAudit',()=>({writeRouteAuditLog:vi.fn(),actorIdFromRequest:()=> 'actor'}));
function fixture(managed=false){const row={id:'t',metadata:managed?{managedBy:'development_cost_closure'}:null};const db:any={workAssignment:{findUnique:vi.fn(async({where})=>where.id==='t'?row:null),create:vi.fn(async({data})=>data),update:vi.fn(async({data})=>({...row,...data})),updateMany:vi.fn(async()=>({count:1}))}};const app=express();app.use(express.json());app.use(createHRRouter({prisma:db,requireAuth:false}));return {app,db};}
describe('HR不能绕过业务受管任务',()=>{
 it.each(['patch','delete'] as const)('%s受管任务返回410且不写',async method=>{const f=fixture(true);const r=await request(f.app)[method]('/assignments/t').send({status:'completed'});expect(r.status).toBe(410);expect(f.db.workAssignment.update).not.toHaveBeenCalled();expect(f.db.workAssignment.updateMany).not.toHaveBeenCalled();});
 it.each(['post','patch'] as const)('%s不能伪造受管标记',async method=>{const f=fixture();const r=await request(f.app)[method](method==='post'?'/assignments':'/assignments/t').send({title:'任务',userId:'u',metadata:{managedBy:'development_cost_closure'}});expect(r.status).toBe(410);expect(f.db.workAssignment.create).not.toHaveBeenCalled();expect(f.db.workAssignment.update).not.toHaveBeenCalled();});
 it.each(['post','patch','delete'] as const)('退版后的普通任务%s也拒绝',async method=>{const f=fixture();const r=await request(f.app)[method](method==='post'?'/assignments':'/assignments/t').send({title:'任务',userId:'u',status:'completed'});expect(r.status).toBe(410);});
});
