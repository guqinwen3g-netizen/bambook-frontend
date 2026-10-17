import {describe,expect,it} from 'vitest';
import {applyMistCommand,createMistState,mistCommandPermission,type MistContext,type MistState} from './mistWorkspace';
import {accountOwnedObjects,buildMemberDirectory,ownerChangeText,resolveMember,type MistMemberDirectoryEntry} from './mistAccounts';
import {getDefaultScopeListForRole,SYSTEM_ROLE_IDS} from '../_shared/rolePermissionMatrix';
/** 包 A：负责人 / 经手人按账号 ID 引用（领域层）。 */
const members:MistMemberDirectoryEntry[]=[
 {id:'u-gu',name:'顾言',active:true,groups:['garment']},
 {id:'u-gu-2',name:'顾言',active:true,groups:['fabric']},
 {id:'u-shen',name:'沈禾',active:true,groups:['fabric','garment']},
 {id:'u-left',name:'离职同事',active:false,groups:['fabric','garment']},
];
const context=(actorId='u-gu',actorName='顾言'):MistContext=>{let n=0;return{id:()=>`acc-${++n}`,now:'2026-10-17T02:00:00.000Z',actorId,actorName,members,authority:{supplier:{},orderReviewerIds:{garment:['u-shen'],fabric:['u-shen']}}};};
function fixture(){
 const ctx=context();let state=createMistState(ctx,'empty');
 state.customers.push({id:'customer',name:'客户公司',code:'C1',country:'CN',city:'',industry:'',owner:'顾言',ownerId:'u-gu',grade:'',currency:'USD',terms:'',incoterm:'',categories:'',creditLimit:0,since:''});
 state=applyMistCommand(state,{type:'order.create',payload:{type:'garment',customerId:'customer',season:'AW',currency:'USD',due:'2026-12-01',ownerId:'u-gu',lines:[{name:'衬衫',style:'S1',img:'coat',qty:10,unit:'件',price:10}]}},ctx).state;
 state=applyMistCommand(state,{type:'fabric.create',payload:{name:'棉府绸',request:'寻样',ownerId:'u-gu-2',due:'2026-11-01'}},ctx).state;
 return{ctx,state,orderId:state.orders[0].id};
}
describe('成员目录与账号解析',()=>{
 it('非成员 / 已停用 / 不在业务组 / 未提供目录一律拒绝；成功时返回账号与当前显示名',()=>{
  const c={members};
  expect(resolveMember(c,'u-shen','经手人','fabric')).toEqual({id:'u-shen',name:'沈禾'});
  expect(()=>resolveMember(c,'u-outsider','负责人')).toThrow(/本工作区的成员/);
  expect(()=>resolveMember(c,'u-left','负责人')).toThrow(/已停用/);
  expect(()=>resolveMember(c,'u-gu','面料经手人','fabric')).toThrow(/不属于面料业务组/);
  expect(()=>resolveMember(c,'顾言','负责人')).toThrow(/本工作区的成员/);
  expect(()=>resolveMember({},'u-gu','负责人')).toThrow(/无法核对/);
  // 未带目录时只接受执行人本人（不限业务组以外的场景）；指定他人或按业务组指定仍拒绝
  expect(resolveMember({actorId:'u-gu',actorName:'顾言'},'u-gu','负责人')).toEqual({id:'u-gu',name:'顾言'});
  expect(()=>resolveMember({actorId:'u-gu',actorName:'顾言'},'u-shen','负责人')).toThrow(/无法核对/);
  expect(()=>resolveMember({actorId:'u-gu',actorName:'顾言'},'u-gu','经手人','garment')).toThrow(/无法核对/);
  expect(ownerChangeText('负责人','顾言','沈禾')).toBe('负责人：顾言→沈禾');
 });
 it('目录只含所有者与被授权成员；缺失或停用的账号标为不可用',()=>{
  const dir=buildMemberDirectory({ownerId:'u-gu',state:{memberIds:['u-shen','u-left'],members:[],memberGroups:[{userId:'u-shen',name:'沈禾',groups:['fabric'],updatedAt:'',updatedBy:''}]} as any,accounts:new Map([['u-gu',{name:'顾言',active:true}],['u-shen',{name:'沈禾',active:true}],['u-left',{name:'离职同事',active:false}]])});
  expect(dir.map(d=>[d.id,d.active,d.groups.join()])).toEqual([['u-gu',true,''],['u-shen',true,'fabric'],['u-left',false,'']]);
 });
});
describe('负责人按账号写入',()=>{
 it('同名账号按 ID 区分；换负责人留下“负责人：A→B”；非成员 / 停用被拒且数据不变',()=>{
  const f=fixture();
  expect(f.state.orders[0]).toMatchObject({ownerId:'u-gu',owner:'顾言'});
  expect(f.state.fabrics[0]).toMatchObject({ownerId:'u-gu-2',owner:'顾言'});
  const before=JSON.stringify(f.state);
  for(const ownerId of ['u-outsider','u-left'])expect(()=>applyMistCommand(f.state,{type:'order.update',payload:{orderId:f.orderId,ownerId}},f.ctx)).toThrow();
  expect(()=>applyMistCommand(f.state,{type:'order.update',payload:{orderId:f.orderId,owner:'沈禾'} as any},f.ctx)).toThrow(/按账号选择/);
  expect(JSON.stringify(f.state)).toBe(before);
  const next=applyMistCommand(f.state,{type:'order.update',payload:{orderId:f.orderId,ownerId:'u-shen'}},f.ctx).state;
  expect(next.orders[0]).toMatchObject({ownerId:'u-shen',owner:'沈禾'});
  expect(next.events.some(e=>e.entityId===f.orderId&&e.text.includes('负责人：顾言→沈禾'))).toBe(true);
 });
 it('能列出某账号名下的全部业务对象（同名账号互不混淆）',()=>{
  const f=fixture();
  const gu=accountOwnedObjects(f.state,'u-gu'),gu2=accountOwnedObjects(f.state,'u-gu-2');
  expect(gu.map(o=>o.kind).sort()).toEqual(['customer','order']);
  expect(gu2.map(o=>o.kind)).toEqual(['fabric']);
  expect(accountOwnedObjects(f.state,'u-shen')).toEqual([]);
 });
 it('供应商经手人按业务组写入；只改其中一组时另一组保持不变',()=>{
  const f=fixture();let s:MistState=f.state;
  s=applyMistCommand(s,{type:'market.supplier.save',payload:{input:{code:'SUP-T1',name:'测试工厂',type:'成衣加工',country:'CN',address:'上海',capabilities:'缝制',capacity:100,capacityUnit:'件',leadDays:0,status:'active',fileIds:[],note:'',handlerIds:{garment:'u-gu',fabric:'u-shen'}} as any}},f.ctx).state;
  const id=s.market.suppliers.find(x=>x.code==='SUP-T1')!.id;
  expect(s.market.suppliers.find(x=>x.id===id)!.handlers).toEqual({garment:{id:'u-gu',name:'顾言'},fabric:{id:'u-shen',name:'沈禾'}});
  const sup=s.market.suppliers.find(x=>x.id===id)!;
  const before=JSON.stringify(s);
  expect(()=>applyMistCommand(s,{type:'market.supplier.save',payload:{id,input:{...sup,handlerIds:{fabric:'u-gu'}} as any}},f.ctx)).toThrow(/不属于面料业务组/);
  expect(JSON.stringify(s)).toBe(before);
  s=applyMistCommand(s,{type:'market.supplier.save',payload:{id,input:{...sup,handlerIds:{fabric:'u-gu-2'}} as any}},f.ctx).state;
  expect(s.market.suppliers.find(x=>x.id===id)!.handlers).toEqual({garment:{id:'u-gu',name:'顾言'},fabric:{id:'u-gu-2',name:'顾言'}});
  expect(accountOwnedObjects(s,'u-gu-2').map(o=>o.role)).toContain('面料经手人');
 });
});
describe('P6 供应商权限',()=>{
 it('档案 / 认证 / 联系人走 suppliers:write；评级与状态走 suppliers:admin',()=>{
  expect(mistCommandPermission({type:'market.supplier.save',payload:{} } as any)).toBe('suppliers:write');
  expect(mistCommandPermission({type:'market.supplier.certificate.save',payload:{}} as any)).toBe('suppliers:write');
  expect(mistCommandPermission({type:'market.contact.save',payload:{kind:'supplier'}} as any)).toBe('suppliers:write');
  expect(mistCommandPermission({type:'market.supplier.rate',payload:{}} as any)).toBe('suppliers:admin');
  expect(mistCommandPermission({type:'market.supplier.status',payload:{}} as any)).toBe('suppliers:admin');
  const sales=getDefaultScopeListForRole(SYSTEM_ROLE_IDS.SALES),manager=getDefaultScopeListForRole(SYSTEM_ROLE_IDS.SALES_MANAGER);
  expect(sales).toContain('suppliers:write');expect(sales).not.toContain('suppliers:admin');
  expect(manager).toContain('suppliers:write');expect(manager).toContain('suppliers:admin');
 });
});
