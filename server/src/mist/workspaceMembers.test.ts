import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMistLocalRuntime} from './local';
import {createMistServer} from './server';
import {platformBusinessDate} from '../shared/mistPlatform';
/**
 * 跨账号、跨岗位办理同一笔采购合同：每个身份都用现有岗位矩阵的权限（不是全权限账号），
 * 所有限制都在服务端接口上断言，不依赖前端按钮。
 */
let directory:string;
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'mist-members-'));vi.stubEnv('MIST_LOCAL_WORKSPACE','1');vi.stubEnv('NODE_ENV','test');});
afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(directory,{recursive:true,force:true});});
const W='/api/mist/workspaces/';
async function agent(app:any,profileId:string){const client=request.agent(app);await client.get('/api/mist/session').expect(200);const session=await client.post('/api/mist/session').send({profileId}).expect(200);expect(session.body.user.id).toBe(profileId);return client;}
let n=0;
const command=(client:any,id:string,revision:number,type:string,payload:unknown)=>client.post(W+id+'/commands').send({requestId:'req-'+(++n),expectedRevision:revision,command:{type,payload}});
const member=(client:any,id:string,revision:number,action:'add'|'remove',account:string)=>client.post(W+id+'/members').send({requestId:'member-'+(++n),expectedRevision:revision,action,account});
describe('工作空间成员与岗位权限（服务端）',()=>{
 it('业务经办、审批人、财务各用自己的岗位权限办理同一笔合同；未授权账号进不来',async()=>{
  const local=createMistLocalRuntime({directory}),app=createMistServer(undefined,{local});
  const sales=await agent(app,'local-sales'),manager=await agent(app,'local-manager'),finance=await agent(app,'local-finance'),qc=await agent(app,'local-qc');
  // 本地测试身份不是全权限账号：权限来自现有岗位矩阵
  const who=async(c:any)=>(await c.get('/api/mist/session').expect(200)).body.user;
  const finScopes=['vouchers:write','invoices:reconcile','invoices:write'];
  const sp=(await who(sales)).permissions,mp=(await who(manager)).permissions,fp=(await who(finance)).permissions,qp=(await who(qc)).permissions;
  for(const p of [sp,mp,fp,qp])expect(p).not.toContain('*');
  for(const s of finScopes){expect(sp).not.toContain(s);expect(mp).not.toContain(s);expect(fp).toContain(s);}
  expect(sp).not.toContain('procurement:approve');expect(mp).toContain('procurement:approve');expect(fp).not.toContain('procurement:approve');
  expect(qp).not.toContain('invoices:read');expect(qp).not.toContain('vouchers:read');
  let ws=(await sales.get(W+'default').expect(200)).body.workspace;const id=ws.id;
  expect(ws.ownerId).toBe('local-sales');expect(ws.access).toMatchObject({role:'owner',canManageMembers:true});
  const draft=ws.state.fulfillment.purchases.find((p:any)=>p.state==='draft');expect(draft).toBeTruthy();
  // 未被授权的账号：读、写、附件、成员管理全部 404
  for(const c of [manager,finance,qc]){await c.get(W+id).expect(404);expect((await c.get('/api/mist/workspaces').expect(200)).body.workspaces.map((w:any)=>w.id)).not.toContain(id);}
  await command(finance,id,ws.revision,'payable.payment.register',{supplierId:draft.supplierId,date:'2026-01-01',amount:1,currency:'CNY',reference:'x'}).expect(404);
  await finance.get(W+id+'/files/'+ws.state.files[0].id).expect(404);
  await member(finance,id,ws.revision,'add','local-finance').expect(404);
  // 业务不能执行财务动作、不能批准合同
  await command(sales,id,ws.revision,'payable.payment.register',{supplierId:draft.supplierId,date:'2026-01-01',amount:1,currency:'CNY',reference:'x'}).expect(403);
  await command(sales,id,ws.revision,'fulfillment.procurement.decide',{id:draft.id,decision:'approved',note:'自批'}).expect(403);
  // 业务提交审批
  let r=await command(sales,id,ws.revision,'fulfillment.procurement.submit',{id:draft.id}).expect(200);ws=r.body.workspace;
  expect(ws.state.fulfillment.purchases.find((p:any)=>p.id===draft.id).reviewerIds).toEqual(['local-reviewer','local-manager']);
  // 财务不在审批名单：审批入口看不到也处理不了
  expect((await finance.get('/api/mist/reviews').expect(200)).body.reviews.some((t:any)=>t.workspaceId===id)).toBe(false);
  // 审批人只通过审批入口看到被指派的这一项，打不开工作空间其他数据
  const reviews=(await manager.get('/api/mist/reviews').expect(200)).body.reviews.filter((t:any)=>t.workspaceId===id);
  expect(reviews).toHaveLength(1);expect(reviews[0]).toMatchObject({canDecide:true,kind:'procurement',entityId:draft.id});expect(reviews[0].state).toBeUndefined();
  await manager.get(W+id).expect(404);
  await finance.post('/api/mist/reviews/'+id+'/'+reviews[0].id).send({requestId:'fin-decide',expectedRevision:ws.revision,decision:'approved',note:'财务越权'}).expect(404);
  await manager.post('/api/mist/reviews/'+id+'/'+reviews[0].id).send({requestId:'mgr-decide',expectedRevision:ws.revision,decision:'approved',note:'价格交期核对无误'}).expect(200);
  ws=(await sales.get(W+id).expect(200)).body.workspace;
  const po=ws.state.fulfillment.purchases.find((p:any)=>p.id===draft.id);expect(po.state).toBe('approved');
  // 业务登记发出与供应商确认
  const at=new Date(Date.now()-3600_000).toISOString();
  ws=(await command(sales,id,ws.revision,'fulfillment.procurement.send',{id:po.id,at,evidence:'邮件发出',fileIds:[]}).expect(200)).body.workspace;
  ws=(await command(sales,id,ws.revision,'fulfillment.procurement.confirm',{id:po.id,at,evidence:'供应商回签',confirmedDue:po.due,fileIds:[]}).expect(200)).body.workspace;
  // 所有者明确授权财务进入；授权不授予任何新权限
  ws=(await member(sales,id,ws.revision,'add','local-finance').expect(200)).body.workspace;
  expect(ws.state.memberIds).toEqual(['local-finance']);
  const fv=(await finance.get(W+id).expect(200)).body.workspace;expect(fv.access).toMatchObject({role:'member',canManageMembers:false});
  expect((await finance.get('/api/mist/workspaces').expect(200)).body.workspaces.map((w:any)=>w.id)).toContain(id);
  // 财务成员仍不能批准合同、不能改空间设置、不能管理成员、不能移入回收站
  await command(finance,id,fv.revision,'fulfillment.procurement.decide',{id:po.id,decision:'approved',note:'x'}).expect(403);
  await command(finance,id,fv.revision,'settings.update',{workspaceName:'改名'}).expect(403);
  const deniedProfile=await command(finance,id,fv.revision,'settings.update',{companyProfile:{legalName:'越权写入'}}).expect(403);expect(JSON.stringify(deniedProfile.body)).toContain('所有者');
  await member(finance,id,fv.revision,'add','local-qc').expect(404);
  await finance.post(W+id+'/archive').send({requestId:'fin-archive',expectedRevision:fv.revision}).expect(404);
  // 财务登记供应商票据与付款
  const yesterday=new Date(Date.now()-86400_000).toISOString().slice(0,10),later=new Date(Date.now()+30*86400_000).toISOString().slice(0,10);
  const uploaded=await sales.post(W+id+'/files').field('requestId','member-private-file').field('expectedRevision',String(fv.revision)).attach('file',Buffer.from('%PDF-1.4 financial attachment'),{filename:'finance-only.pdf',contentType:'application/pdf'}).expect(201);
  const financialFileId=uploaded.body.receipt.result.fileId||uploaded.body.receipt.result.id;
  expect(financialFileId).toBeTruthy();
  r=await command(finance,id,uploaded.body.workspace.revision,'payable.bill.register',{supplierId:po.supplierId,invoiceNo:'VAT-MEMBER-1',invoiceDate:yesterday,currency:po.currency,amount:1000,taxAmount:0,taxRate:'13%',lines:[{purchaseId:po.id,amount:1000}],due:later,dueBasis:'合同付款条件',fileIds:[financialFileId]}).expect(200);
  await finance.get(W+id+'/files/'+financialFileId).expect(200);
  const billId=r.body.receipt.result.id;
  // 所有付款先申请、主管审批，再由财务按已批准申请付款
  const today=platformBusinessDate(new Date().toISOString());
  const direct=await command(finance,id,r.body.workspace.revision,'payable.payment.register',{supplierId:po.supplierId,date:today,amount:600,currency:po.currency,reference:'BANK-MEMBER-0',allocations:[{billId,amount:600}]});
  expect(direct.status).toBeGreaterThanOrEqual(400);expect(direct.body.error.message).toContain('须先提交付款申请');
  await command(qc,id,r.body.workspace.revision,'payable.request.submit',{purpose:'bill',supplierId:po.supplierId,currency:po.currency,lines:[{billId,amount:600}],reason:'x'}).expect(403);
  r=await command(sales,id,r.body.workspace.revision,'payable.request.submit',{purpose:'bill',supplierId:po.supplierId,currency:po.currency,lines:[{billId,amount:600}],reason:'票据已到期，按合同付款'}).expect(200);
  const payReq=r.body.receipt.result.id;
  await command(finance,id,r.body.workspace.revision,'payable.payment.register',{requestId:payReq,date:today,amount:600,reference:'BANK-MEMBER-1',allocations:[{billId,amount:600}]}).expect(422);
  // 业务主管不是空间成员：只从审批收件箱读冻结快照并决定，仍不能读取整个空间
  const inbox=(await manager.get('/api/mist/reviews').expect(200)).body.reviews.find((t:any)=>t.id==='payment:'+payReq);
  expect(inbox).toMatchObject({kind:'payment',canDecide:true,status:'pending'});expect(inbox.details.find((d:any)=>d.label==='本次申请金额').value).toContain('600.00');
  expect((await finance.get('/api/mist/reviews').expect(200)).body.reviews.some((t:any)=>t.id==='payment:'+payReq)).toBe(false);
  await sales.post('/api/mist/reviews/'+id+'/payment:'+payReq).send({requestId:'self-approve',expectedRevision:r.body.workspace.revision,decision:'approved',note:'自批'}).expect(404);
  await manager.post('/api/mist/reviews/'+id+'/payment:'+payReq).send({requestId:'pay-approve',expectedRevision:r.body.workspace.revision,decision:'approved',note:'核对票据与合同，同意付款'}).expect(200);
  await manager.get(W+id).expect(404);
  const approvedRev=(await finance.get(W+id).expect(200)).body.workspace.revision;
  r=await command(finance,id,approvedRev,'payable.payment.register',{requestId:payReq,date:today,amount:600,reference:'BANK-MEMBER-1',allocations:[{billId,amount:600}]}).expect(200);
  expect(r.body.workspace.state.payables.requests.find((q:any)=>q.id===payReq)).toMatchObject({state:'paid'});
  expect(r.body.workspace.state.payables.bills.some((b:any)=>b.id===billId)).toBe(true);
  // 无发票/凭证查看权限的成员（质检岗位）进入后看不到财务数据，也不能执行财务动作
  ws=(await member(sales,id,r.body.workspace.revision,'add','local-qc').expect(200)).body.workspace;
  const qv=(await qc.get(W+id).expect(200)).body.workspace;
  expect(qv.access.hidden.map((h:any)=>h.key)).toEqual(expect.arrayContaining(['receivables','payments','payables']));
  expect(qv.state.payables.bills).toHaveLength(0);expect(qv.state.payables.payments).toHaveLength(0);expect(qv.state.payments).toHaveLength(0);expect(qv.state.invoices).toHaveLength(0);expect(qv.state.receipts).toHaveLength(0);
  expect(qv.state.events.some((e:any)=>['payable','payment','invoice','finance'].includes(e.entityType))).toBe(false);
  expect(JSON.stringify(qv.state)).not.toContain('BANK-MEMBER-1');
  expect(JSON.stringify(qv.state.files)).not.toContain(financialFileId);
  await qc.get(W+id+'/files/'+financialFileId).expect(404);
  expect(qv.state.fulfillment.purchases.find((p:any)=>p.id===po.id).state).toBe('approved');
  await command(qc,id,qv.revision,'payable.payment.register',{supplierId:po.supplierId,date:yesterday,amount:1,currency:po.currency,reference:'x'}).expect(403);
  const visibleIds=new Set(qv.state.files.map((f:any)=>f.id)),hiddenFile=ws.state.files.find((f:any)=>!visibleIds.has(f.id));
  if(hiddenFile)await qc.get(W+id+'/files/'+hiddenFile.id).expect(404);
  // 撤销后立即失去访问；授权历史保留
  ws=(await member(sales,id,qv.revision,'remove','local-qc').expect(200)).body.workspace;
  await qc.get(W+id).expect(404);
  expect(ws.state.memberLog.map((l:any)=>[l.action,l.userId])).toEqual([['remove','local-qc'],['add','local-qc'],['add','local-finance']]);
  await member(sales,id,ws.revision,'add','local-sales').expect(400);
  await member(sales,id,ws.revision,'add','someone-else').expect(404);
 });
 it('授权请求可原样重放，旧版本及请求号串用被拒；撤销后列表与回执入口都不可访问',async()=>{
  const local=createMistLocalRuntime({directory}),app=createMistServer(undefined,{local});
  const sales=await agent(app,'local-sales'),qc=await agent(app,'local-qc');
  const original=(await sales.get(W+'default').expect(200)).body.workspace,id=original.id;
  const input={requestId:'exact-grant',expectedRevision:original.revision,action:'add',account:'local-qc'};
  const first=(await sales.post(W+id+'/members').send(input).expect(200)).body;
  const replay=(await sales.post(W+id+'/members').send(input).expect(200)).body;
  expect(replay.replayed).toBe(true);expect(replay.workspace.revision).toBe(first.workspace.revision);
  expect(replay.workspace.state.memberLog).toHaveLength(1);
  await sales.post(W+id+'/members').send({...input,action:'remove'}).expect(409);
  await sales.post(W+id+'/members').send({...input,requestId:'stale-remove',action:'remove'}).expect(409);
  expect((await qc.get('/api/mist/workspaces').expect(200)).body.workspaces.some((w:any)=>w.id===id&&w.access.role==='member')).toBe(true);
  await qc.get(W+id+'/receipts/exact-grant').expect(404);
  const removed=(await member(sales,id,first.workspace.revision,'remove','local-qc').expect(200)).body.workspace;
  expect(removed.state.memberLog).toHaveLength(2);
  await qc.get(W+id).expect(404);
  expect((await qc.get('/api/mist/workspaces').expect(200)).body.workspaces.some((w:any)=>w.id===id)).toBe(false);
  await qc.get(W+id+'/receipts/exact-grant').expect(404);
 });
});