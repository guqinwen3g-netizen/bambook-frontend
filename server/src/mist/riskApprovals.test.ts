import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MistRepository} from './repository';
import {MistPrivateFiles} from './files';
import {MemoryMistDatabase,testActor,testAuthority} from './__tests__/support';
import * as contract from '../shared/mistWorkspace';

/** 真实 mistApprovalAuthority：只替换部门主管路由与账号读取，审批人资格与处理权都按此刻账号权限重建。 */
const env=vi.hoisted(()=>({routes:new Map<string,string>(),users:null as null|Map<string,{active:boolean;permissions:string[]}>}));
vi.mock('../approvals/approvalRoutingService',()=>({createApprovalRoutingService:()=>({
 resolveReviewerByDepartment:async(userId:string)=>{const reviewerId=env.routes.get(userId);if(!reviewerId)throw Object.assign(new Error('none'),{code:'NO_REVIEWER_RESOLVED'});return{reviewerId};},
 resolveClaimLeader:async()=>{throw Object.assign(new Error('none'),{code:'NO_REVIEWER_RESOLVED'});},
})}));
vi.mock('../auth/tokenHelpers',()=>({
 loadUserWithRoles:async(_db:unknown,id:string)=>{const u=env.users?.get(id);return u?{id,status:u.active?'active':'disabled',deletedAt:null}:null;},
 buildLoadedAuthTokenPayload:async(_db:unknown,user:{id:string})=>({userId:user.id,displayName:user.id,permissions:[...(env.users?.get(user.id)?.permissions||[])],roles:[],departmentIds:[],authorizationLoaded:true}),
}));
let directory:string,db:MemoryMistDatabase,repo:MistRepository,auth:ReturnType<typeof testAuthority>;
beforeEach(async()=>{
 directory=await mkdtemp(path.join(tmpdir(),'mist-risk-approvals-'));db=new MemoryMistDatabase();auth=testAuthority();env.users=auth.users;env.routes.clear();
 // 业务员：有风险读、订单写、客户档案写，没有风险写 / 风险审批权。
 auth.users.get('owner')!.permissions.push('risk:read','orders:write','relations:write');
 auth.users.set('manager',{active:true,permissions:['risk:read','risk:write']});auth.users.set('manager2',{active:true,permissions:['risk:read','risk:write']});
 env.routes.set('owner','manager');
 repo=new MistRepository(db,contract,new MistPrivateFiles(directory),auth.authorize,()=>new Date('2026-10-13T08:00:00Z'));
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});

/** 业务员会话：不带技术超管角色（testActor 默认的 owner 角色会命中超管捷径）。 */
const seller=()=>({...testActor(),roles:[]});
async function fixture(){
 const workspace=await repo.create(testActor(),{name:'Risk approvals',seed:'empty'});let revision=0,sequence=0;
 const run=async(command:any)=>{const next=await repo.execute(seller(),workspace.id,{requestId:'risk-command-'+(++sequence),expectedRevision:revision,command});revision=next.workspace.revision;return next;};
 const upload=async()=>{const next=await repo.upload(seller(),workspace.id,{requestId:'risk-upload-'+(++sequence),expectedRevision:revision},{name:'PO.pdf',mimeType:'application/pdf',bytes:Buffer.from('%PDF-1.4\nwritten purchase order\n%%EOF')});revision=next.workspace.revision;return next.workspace.state.files.at(-1)!;};
 const customerId=(await run({type:'market.customer.create',payload:{input:{name:'风险测试客户',country:'CN',city:'',industry:'服装',ownerId:'owner',grade:'A',currency:'USD',terms:'OA',incoterm:'FOB',categories:'成衣',creditLimit:0,since:'2026-10-13'}}})).receipt.result.customerId as string;
 const order=async(owner:string,po:string)=>{const file=await upload();return (await run({type:'order.create',payload:{type:'garment',customerId,season:'AW26',currency:'USD',due:'2026-12-01',ownerId:owner,governance:{kind:'external',poNumber:po,confirmationFileIds:[file.id],internalPurpose:'',receiver:'',paymentMethod:'OA',depositPercent:null,paymentNote:'发票日起30天',incoterm:'FOB',deliveryPlace:'上海'},lines:[{name:'外套',style:'A',img:'coat',qty:4,unit:'件',price:15}]}})).receipt.result.orderId as string;};
 return {workspace,run,order,customerId,revision:()=>revision,setRevision:(r:number)=>{revision=r;}};
}
const risk=(orderId:string,owner='owner',level='critical')=>({type:'platform.risk.save',payload:{orderId,title:'尾款逾期 45 天',level,basis:'CI 到期未收',owner,type:'credit'}});

describe('风险分级权限经仓储与统一审批全链路',()=>{
 it('业务员处理本人订单高风险：不能直接关闭，申请进入部门主管统一审批，批准结果回到原风险',async()=>{
  const f=await fixture(),orderId=await f.order('owner','RISK-PO-1');
  const id=(await f.run(risk(orderId))).receipt.result.id as string;
  await f.run({type:'platform.risk.transition',payload:{id,state:'Acknowledged',resolution:'我来跟'}});
  await f.run({type:'platform.risk.plan',payload:{id,plan:'本周与客户确认付款计划',planDue:'2026-10-20'}});
  await expect(f.run({type:'platform.risk.transition',payload:{id,state:'Resolved',resolution:'已催款'}})).rejects.toMatchObject({code:'PRECONDITION'});
  // 请求体不能指定审批人；也不能直接以 decide 命令绕过统一审批（缺 risk:admin）。
  await expect(f.run({type:'platform.risk.escalate',payload:{id,action:'close',reason:'x',approver:'owner'}})).rejects.toMatchObject({code:'FORBIDDEN'});
  await f.run({type:'platform.risk.escalate',payload:{id,action:'close',reason:'客户已付清，银行水单已核对'}});
  const review=(await repo.listReviews(testActor('manager'))).find((t:any)=>t.kind==='risk')!;
  expect(review).toMatchObject({kind:'risk',requesterId:'owner',reviewerIds:['manager'],status:'pending',requiredPermission:'risk:write',target:{view:'risks',id}});
  expect(await repo.listReviews(testActor('manager2'))).toEqual([]);
  const escalationId=review.entityId;
  await expect(f.run({type:'platform.risk.decide',payload:{id,escalationId,decision:'approved',note:'自批'}})).rejects.toMatchObject({status:403});
  const input=(requestId:string)=>({requestId,expectedRevision:f.revision(),decision:'approved' as const,note:'核对水单无误'});
  // 未分配的主管看不到；分配的主管失去风险处理权后不能答复。
  await expect(repo.decideReview(testActor('manager2'),f.workspace.id,review.id,input('wrong-reviewer'))).rejects.toMatchObject({status:404});
  auth.users.get('manager')!.permissions=['risk:read'];
  await expect(repo.decideReview(testActor('manager'),f.workspace.id,review.id,input('revoked'))).rejects.toMatchObject({status:403});
  auth.users.get('manager')!.permissions=['risk:read','risk:write'];
  // 申请人的部门主管已改为他人：原审批人此刻不再有效。
  env.routes.set('owner','manager2');
  await expect(repo.decideReview(testActor('manager'),f.workspace.id,review.id,input('rerouted'))).rejects.toMatchObject({code:'FORBIDDEN'});
  env.routes.set('owner','manager');
  const decided=await repo.decideReview(testActor('manager'),f.workspace.id,review.id,input('approve-close'));
  expect(decided.replayed).toBe(false);
  const state=(await repo.get(testActor(),f.workspace.id)).state,row=state.platform.risks.find(r=>r.id===id)!;
  expect(row).toMatchObject({state:'Resolved',disposition:'closed',resolution:'客户已付清，银行水单已核对',closedBy:'owner'});
  expect(row.escalations![0]).toMatchObject({decision:'approved',decidedById:'manager'});
  expect(state.notifications.find(n=>n.target?.id===id)!.title).toContain('关闭申请已批准');
  expect((await repo.decideReview(testActor('manager'),f.workspace.id,review.id,{...input('approve-close'),expectedRevision:decided.receipt.revision-1})).replayed).toBe(true);
 });
 it('他人订单的风险、无主管路由与自审路由都在服务端拒绝',async()=>{
  const f=await fixture(),mine=await f.order('owner','RISK-PO-2'),theirs=await f.order('owner','RISK-PO-3');
  // 订单负责人由订单流程按创建人写入；这里直接把一张单改成他人负责，模拟同组同事的订单。
  Object.assign(db.workspaces.get(f.workspace.id).state.orders.find((o:any)=>o.id===theirs),{owner:'别人',ownerId:'colleague'});
  expect(db.workspaces.get(f.workspace.id).state.orders.find((o:any)=>o.id===mine).owner).toBe('owner');
  await expect(f.run(risk(theirs))).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(f.run(risk(mine,'别人'))).rejects.toMatchObject({code:'FORBIDDEN'});
  const id=(await f.run(risk(mine))).receipt.result.id as string;
  await f.run({type:'platform.risk.transition',payload:{id,state:'Acknowledged',resolution:''}});
  await f.run({type:'platform.risk.plan',payload:{id,plan:'分期回款'}});
  env.routes.set('owner','owner');
  await expect(f.run({type:'platform.risk.escalate',payload:{id,action:'waive',reason:'长期客户'}})).rejects.toMatchObject({code:'PRECONDITION'});
  env.routes.delete('owner');
  await expect(f.run({type:'platform.risk.escalate',payload:{id,action:'waive',reason:'长期客户'}})).rejects.toMatchObject({code:'PRECONDITION'});
  // 没有订单写权限的账号即使是负责人也不能处理。
  auth.users.get('owner')!.permissions=auth.users.get('owner')!.permissions.filter(p=>p!=='orders:write');
  await expect(f.run({type:'platform.risk.plan',payload:{id,plan:'改方案'}})).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('同名不同账号：合法成员把显示名改成来源负责人姓名，仍不能登记或处理其订单风险；负责人本人照常办理',async()=>{
  const f=await fixture(),orderId=await f.order('owner','RISK-PO-TWIN');
  // other 是合法空间成员，只有风险读、订单写、客户档案写，没有风险写。
  auth.users.set('other',{active:true,permissions:['risk:read','orders:write','relations:write']});
  const row=db.workspaces.get(f.workspace.id)!;row.state.memberIds=['other'];row.state.members=[{userId:'other',name:'other',addedBy:'owner',addedByName:'owner',addedAt:'2026-10-13T08:00:00Z'}];
  const as=(displayName:string)=>({...testActor('other'),displayName,roles:[]});
  let n=0;const exec=(actor:any,command:any)=>repo.execute(actor,f.workspace.id,{requestId:'twin-'+(++n),expectedRevision:f.revision(),command}).then(next=>{f.setRevision(next.workspace.revision);return next;});
  const before=f.revision();
  await expect(exec(as('other'),risk(orderId,'other','warning'))).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(exec(as('owner'),risk(orderId,'owner','warning'))).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(f.revision()).toBe(before);
  // 负责人本人登记后，同名账号也不能接手或推进。
  const id=(await f.run(risk(orderId,'owner','warning'))).receipt.result.id as string;
  await expect(exec(as('owner'),{type:'platform.risk.transition',payload:{id,state:'Acknowledged',resolution:''}})).rejects.toMatchObject({code:'FORBIDDEN'});
  await f.run({type:'platform.risk.transition',payload:{id,state:'Acknowledged',resolution:'我来跟'}});
  await expect(exec(as('owner'),{type:'platform.risk.plan',payload:{id,plan:'冒名方案'}})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(exec(as('owner'),{type:'platform.risk.transition',payload:{id,state:'Resolved',resolution:'冒名关闭'}})).rejects.toMatchObject({code:'FORBIDDEN'});
  await f.run({type:'platform.risk.plan',payload:{id,plan:'本周与客户确认'}});
  await f.run({type:'platform.risk.transition',payload:{id,state:'Resolved',resolution:'客户已确认'}});
  const saved=db.workspaces.get(f.workspace.id)!.state;
  expect(saved.orders.find((o:any)=>o.id===orderId)).toMatchObject({owner:'owner',ownerId:'owner'});
  expect(saved.platform.risks.find((r:any)=>r.id===id)).toMatchObject({state:'Resolved',closedBy:'owner'});
 });
});
