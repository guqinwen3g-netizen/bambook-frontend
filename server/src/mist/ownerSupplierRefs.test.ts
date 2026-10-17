import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMistLocalRuntime} from './local';
import {createMistServer} from './server';
import {accountOwnedObjects} from '../shared/mistAccounts';
/**
 * 包 A：负责人 / 供应商经手人按账号稳定引用、业务员维护供应商档案（P5、P6）。
 * 全部经服务端接口断言：真实岗位权限（业务员 / 业务主管），不依赖前端按钮。
 */
let directory:string;
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'mist-owner-refs-'));vi.stubEnv('MIST_LOCAL_WORKSPACE','1');vi.stubEnv('NODE_ENV','test');});
afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(directory,{recursive:true,force:true});});
const W='/api/mist/workspaces/';
async function agent(app:any,profileId:string){const client=request.agent(app);await client.get('/api/mist/session').expect(200);const session=await client.post('/api/mist/session').send({profileId}).expect(200);expect(session.body.user.id).toBe(profileId);return client;}
let n=0;
const command=(client:any,id:string,revision:number,type:string,payload:unknown,requestId='req-'+(++n))=>client.post(W+id+'/commands').send({requestId,expectedRevision:revision,command:{type,payload}});
const member=(client:any,id:string,revision:number,action:'add'|'remove',account:string)=>client.post(W+id+'/members').send({requestId:'member-'+(++n),expectedRevision:revision,action,account});
const supplierInput=(s:any,patch:Record<string,unknown>={})=>{const {id:_id,createdAt:_c,updatedAt:_u,contacts:_ct,blockReason:_b,statusFrom:_sf,statusHistory:_sh,certificates:_ce,ratings:_r,handlers:_h,...input}=s;return{...input,...patch};};
async function setup(){
 const local=createMistLocalRuntime({directory}),app=createMistServer(undefined,{local});
 const sales=await agent(app,'local-sales'),manager=await agent(app,'local-manager'),qc=await agent(app,'local-qc');
 let ws=(await sales.get(W+'default').expect(200)).body.workspace;const id=ws.id;
 ws=(await member(sales,id,ws.revision,'add','local-manager').expect(200)).body.workspace;
 return{sales,manager,qc,id,get ws(){return ws;},set ws(v:any){ws=v;}};
}
describe('包 A：负责人与供应商稳定引用（服务端）',()=>{
 it('业务组只由所有者设置；经手人须为本空间在册成员且属于对应业务组，否则拒绝且数据不变',async()=>{
  const f=await setup();let ws=f.ws;
  // 成员不能改业务组
  await command(f.manager,f.id,ws.revision,'member.groups.set',{userId:'local-manager',groups:['garment']}).expect(403);
  ws=(await command(f.sales,f.id,ws.revision,'member.groups.set',{userId:'local-manager',groups:['garment']}).expect(200)).body.workspace;
  expect(ws.state.memberGroups.find((g:any)=>g.userId==='local-manager').groups).toEqual(['garment']);
  expect(ws.state.events.some((e:any)=>e.text.includes('业务组')&&e.text.includes('成衣'))).toBe(true);
  const supplier=ws.state.market.suppliers[0];
  const reject=async(handlerIds:Record<string,string>,pattern:RegExp)=>{
   const res=await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{handlerIds})});
   expect(res.status).toBe(422);expect(JSON.stringify(res.body)).toMatch(pattern);
   const now=(await f.sales.get(W+f.id).expect(200)).body.workspace;expect(now.revision).toBe(ws.revision);
   expect(now.state.market.suppliers.find((s:any)=>s.id===supplier.id)).toEqual(supplier);
  };
  await reject({garment:'local-qc'},/本工作区的成员/); // 不是本空间成员
  await reject({fabric:'local-manager'},/不属于面料业务组/); // 在册但不在该组
  await reject({garment:'业务主管（测试审批人）'},/本工作区的成员/); // 按姓名而不是账号
  ws=(await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{handlerIds:{garment:'local-manager'}})}).expect(200)).body.workspace;
  const saved=ws.state.market.suppliers.find((s:any)=>s.id===supplier.id);
  expect(saved.handlers.garment).toEqual({id:'local-manager',name:'业务主管（测试审批人）'});
  expect(ws.state.events.some((e:any)=>e.entityId===supplier.id&&e.text.includes('成衣经手人：'))).toBe(true);
  expect(accountOwnedObjects(ws.state,'local-manager').some(o=>o.kind==='supplier'&&o.id===supplier.id)).toBe(true);
  // 移出成员后不能再被指定
  ws=(await member(f.sales,f.id,ws.revision,'remove','local-manager').expect(200)).body.workspace;
  expect(ws.state.memberGroups.some((g:any)=>g.userId==='local-manager')).toBe(false);
  const other=ws.state.market.suppliers[1];
  const res=await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:other.id,input:supplierInput(other,{handlerIds:{garment:'local-manager'}})}).expect(422);
  expect(JSON.stringify(res.body)).toMatch(/本工作区的成员/);
 });
 it('业务员可维护档案 / 认证 / 联系人，但评级与暂停 / 拉黑 / 恢复需要主管权限且必须写原因',async()=>{
  const f=await setup();let ws=f.ws;
  const supplier=ws.state.market.suppliers[0];
  ws=(await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{note:'业务员补充档案'})}).expect(200)).body.workspace;
  ws=(await command(f.sales,f.id,ws.revision,'market.supplier.certificate.save',{supplierId:supplier.id,name:'BSCI',number:'B-1',issuer:'amfori',validUntil:'2027-12-31',fileIds:[]}).expect(200)).body.workspace;
  ws=(await command(f.sales,f.id,ws.revision,'market.contact.save',{kind:'supplier',parentId:supplier.id,name:'王厂长',role:'厂长',email:'wang@example.com',phone:'',primary:false}).expect(200)).body.workspace;
  const after=ws.state.market.suppliers.find((s:any)=>s.id===supplier.id);
  expect(after.note).toBe('业务员补充档案');expect(after.certificates.some((c:any)=>c.name==='BSCI')).toBe(true);expect(after.contacts.some((c:any)=>c.name==='王厂长')).toBe(true);
  // 业务员：评级、状态 403，数据不变
  await command(f.sales,f.id,ws.revision,'market.supplier.rate',{supplierId:supplier.id,grade:'A',period:'2026Q3',note:'交期稳定'}).expect(403);
  await command(f.sales,f.id,ws.revision,'market.supplier.status',{id:supplier.id,status:'paused',reason:'质量整改'}).expect(403);
  const unchanged=(await f.sales.get(W+f.id).expect(200)).body.workspace;expect(unchanged.revision).toBe(ws.revision);
  expect(unchanged.state.market.suppliers.find((s:any)=>s.id===supplier.id).status).toBe(supplier.status);
  // 主管：可评级、暂停、恢复；原因必填（含恢复）
  const mws=(await f.manager.get(W+f.id).expect(200)).body.workspace;let rev=mws.revision;
  rev=(await command(f.manager,f.id,rev,'market.supplier.rate',{supplierId:supplier.id,grade:'A',period:'2026Q3',note:'交期稳定'}).expect(200)).body.workspace.revision;
  await command(f.manager,f.id,rev,'market.supplier.status',{id:supplier.id,status:'paused',reason:''}).expect(422);
  rev=(await command(f.manager,f.id,rev,'market.supplier.status',{id:supplier.id,status:'paused',reason:'质量整改'}).expect(200)).body.workspace.revision;
  await command(f.manager,f.id,rev,'market.supplier.status',{id:supplier.id,status:'active',reason:''}).expect(422);
  const done=(await command(f.manager,f.id,rev,'market.supplier.status',{id:supplier.id,status:'active',reason:'整改验收通过'}).expect(200)).body.workspace;
  expect(done.state.market.suppliers.find((s:any)=>s.id===supplier.id)).toMatchObject({status:'active'});
 });
 it('并发修改同一供应商：后到的旧版本请求按版本冲突拒绝；同一请求重试不重复记事件',async()=>{
  const f=await setup();const ws=f.ws;const supplier=ws.state.market.suppliers[0];
  const first=await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{note:'甲的修改'})},'concurrent-a').expect(200);
  const second=await command(f.manager,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{note:'乙的修改'})},'concurrent-b').expect(409);
  expect(JSON.stringify(second.body)).toContain('REVISION_CONFLICT');
  let now=(await f.sales.get(W+f.id).expect(200)).body.workspace;expect(now.state.market.suppliers.find((s:any)=>s.id===supplier.id).note).toBe('甲的修改');
  // 同一请求重放：返回原结果，不新增版本和事件
  const events=now.state.events.length;
  const replay=await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:supplier.id,input:supplierInput(supplier,{note:'甲的修改'})},'concurrent-a').expect(200);
  expect(replay.body.replayed).toBe(true);expect(replay.body.receipt).toEqual(first.body.receipt);
  now=(await f.sales.get(W+f.id).expect(200)).body.workspace;expect(now.revision).toBe(first.body.workspace.revision);expect(now.state.events.length).toBe(events);
 });
 it('供应商改名后：开发工厂与采购合同仍按供应商 ID 关联，显示名同步',async()=>{
  const f=await setup();let ws=f.ws;
  const version=ws.state.versions.find((v:any)=>v.factoryId);expect(version).toBeTruthy();
  const factoryId=version.factoryId,refs=ws.state.versions.filter((v:any)=>v.factoryId===factoryId).map((v:any)=>v.id);
  const purchase=ws.state.fulfillment.purchases.find((p:any)=>p.supplierId);expect(purchase).toBeTruthy();
  for(const supplierId of [...new Set([factoryId,purchase.supplierId])]){
   const s=ws.state.market.suppliers.find((x:any)=>x.id===supplierId);
   ws=(await command(f.sales,f.id,ws.revision,'market.supplier.save',{id:s.id,input:supplierInput(s,{name:s.name+'（新名）'})}).expect(200)).body.workspace;
  }
  const renamed=ws.state.market.suppliers.find((x:any)=>x.id===factoryId);
  const after=ws.state.versions.filter((v:any)=>v.factoryId===factoryId);
  expect(after.map((v:any)=>v.id)).toEqual(refs);for(const v of after)expect(v.factory).toBe(renamed.name);
  const po=ws.state.fulfillment.purchases.find((p:any)=>p.id===purchase.id);expect(po.supplierId).toBe(purchase.supplierId);
  expect(ws.state.market.suppliers.find((x:any)=>x.id===po.supplierId).name).toMatch(/（新名）$/);
 });
});
